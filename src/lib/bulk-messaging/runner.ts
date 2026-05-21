import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { WhatsAppClient, WhatsAppApiError, type WhatsAppTemplateHeader } from "../whatsapp";

/**
 * In-process send-worker for bulk WhatsApp campaigns.
 *
 * The model is intentionally simple: one async loop per campaign, holding a
 * single throttle (default 200 ms between sends) and processing PENDING
 * recipients in `rowIndex` order. Each send writes a `WhatsappMessage` row
 * — the same row the inbound webhook will later mutate when Meta reports
 * delivered / read / failed — and stamps the matching `BulkRecipient`
 * with `providerMessageId` so the webhook can update both tables.
 *
 * Singleton-protected via a `globalThis` set so the Next.js dev server's
 * module reloads, the auto-sync cron's parallel ticks, and any double
 * invocation from the API layer don't spawn duplicate workers for the same
 * campaign.
 */
declare global {
  var __codBulkRunners__: Set<string> | undefined;
  var __codBulkCancelRequests__: Set<string> | undefined;
}

function activeRunners(): Set<string> {
  if (!globalThis.__codBulkRunners__) globalThis.__codBulkRunners__ = new Set();
  return globalThis.__codBulkRunners__;
}

function cancelRequests(): Set<string> {
  if (!globalThis.__codBulkCancelRequests__) globalThis.__codBulkCancelRequests__ = new Set();
  return globalThis.__codBulkCancelRequests__;
}

/** Public: ask the worker for `campaignId` to stop after its current send. */
export function requestCancel(campaignId: string): void {
  cancelRequests().add(campaignId);
}

/** Public: is this campaign currently being processed in-process? */
export function isRunning(campaignId: string): boolean {
  return activeRunners().has(campaignId);
}

/**
 * Kick off (or resume) a campaign. Returns immediately — the actual sending
 * happens in a fire-and-forget async loop. Safe to call multiple times for
 * the same campaign; the singleton guard short-circuits duplicate runs.
 */
export async function startCampaign(campaignId: string): Promise<void> {
  if (activeRunners().has(campaignId)) return;
  activeRunners().add(campaignId);

  // Don't await — the API call returns immediately and the loop runs in the
  // background. Any uncaught error inside `runCampaignLoop` is logged and
  // marks the campaign as FAILED so the UI surfaces it.
  runCampaignLoop(campaignId)
    .catch((err) => {
      console.error("[bulk-messaging] runner crashed", campaignId, err);
    })
    .finally(() => {
      activeRunners().delete(campaignId);
    });
}

async function runCampaignLoop(campaignId: string): Promise<void> {
  const campaign = await prisma.bulkCampaign.findUnique({
    where: { id: campaignId },
  });
  if (!campaign) {
    console.warn("[bulk-messaging] campaign not found", campaignId);
    return;
  }
  if (campaign.status === "COMPLETED" || campaign.status === "CANCELLED") {
    return;
  }

  // Set up the WhatsApp client once per campaign. If credentials are missing
  // the whole campaign fails immediately — the error is surfaced on every
  // recipient row so the operator knows exactly which orders to re-queue.
  let client: WhatsAppClient;
  try {
    client = await WhatsAppClient.fromSettings({
      phoneNumberIdOverride: campaign.phoneNumberId ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "WhatsApp not configured";
    await prisma.$transaction([
      prisma.bulkRecipient.updateMany({
        where: { campaignId, status: "PENDING" },
        data: { status: "FAILED", errorMessage: message, failedAt: new Date() },
      }),
      prisma.bulkCampaign.update({
        where: { id: campaignId },
        data: {
          status: "FAILED",
          errorMessage: message,
          completedAt: new Date(),
        },
      }),
    ]);
    return;
  }

  await prisma.bulkCampaign.update({
    where: { id: campaignId },
    data: {
      status: "SENDING",
      startedAt: campaign.startedAt ?? new Date(),
      errorMessage: null,
    },
  });

  const header = buildCampaignHeader(campaign);
  const sendingPhoneNumberId = client.getPhoneNumberId();
  const throttleMs = Math.max(0, campaign.throttleMs);

  // Loop instead of grabbing all rows up front — that way recipients added
  // by Retry Failed (which flips FAILED → PENDING) get picked up too.
  for (;;) {
    if (cancelRequests().has(campaignId)) {
      cancelRequests().delete(campaignId);
      await prisma.$transaction([
        prisma.bulkRecipient.updateMany({
          where: { campaignId, status: "PENDING" },
          data: { status: "CANCELLED" },
        }),
        prisma.bulkCampaign.update({
          where: { id: campaignId },
          data: { status: "CANCELLED", completedAt: new Date() },
        }),
      ]);
      return;
    }

    const next = await prisma.bulkRecipient.findFirst({
      where: { campaignId, status: "PENDING" },
      orderBy: { rowIndex: "asc" },
    });
    if (!next) break;

    await processOne({
      recipient: next,
      campaign,
      client,
      header,
      sendingPhoneNumberId,
    });

    if (throttleMs > 0) {
      await new Promise((r) => setTimeout(r, throttleMs));
    }
  }

  // All pending rows processed — close the campaign out with COMPLETED.
  await prisma.bulkCampaign.update({
    where: { id: campaignId },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
}

interface ProcessArgs {
  recipient: Prisma.BulkRecipientGetPayload<true>;
  campaign: Prisma.BulkCampaignGetPayload<true>;
  client: WhatsAppClient;
  header: WhatsAppTemplateHeader | undefined;
  sendingPhoneNumberId: string;
}

async function processOne({
  recipient,
  campaign,
  client,
  header,
  sendingPhoneNumberId,
}: ProcessArgs): Promise<void> {
  // Per-recipient header override (e.g. tracking URL embedded into header
  // image) wins over the campaign-level header.
  const effectiveHeader: WhatsAppTemplateHeader | undefined = recipient.headerValue
    ? {
        type: header?.type ?? "text",
        value: recipient.headerValue,
        imageKind: header?.imageKind,
      }
    : header;

  const variables = Array.isArray(recipient.variablesJson)
    ? (recipient.variablesJson as unknown as string[]).map((v) =>
        typeof v === "string" ? v : v == null ? "" : String(v)
      )
    : [];

  let attempts = recipient.attemptCount;
  let lastError: Error | null = null;
  while (attempts < campaign.maxAttempts) {
    attempts++;
    try {
      const result = await client.sendTemplate(
        recipient.phoneNumber,
        campaign.templateName,
        campaign.templateLanguage,
        variables,
        effectiveHeader
      );
      const providerMessageId = result.messages?.[0]?.id ?? null;
      const storedPhone = recipient.phoneNumber.startsWith("+")
        ? recipient.phoneNumber
        : `+${recipient.phoneNumber}`;
      // Record the outbound in `whatsapp_messages` so the inbox + delivery
      // tracking stack picks it up exactly like a manual send.
      const message = await prisma.whatsappMessage.create({
        data: {
          orderId: null,
          phoneNumber: storedPhone,
          phoneNumberId: sendingPhoneNumberId,
          templateName: campaign.templateName,
          templateLanguage: campaign.templateLanguage,
          templateVariablesJson: variables,
          headerImageUrl:
            effectiveHeader?.type === "image" ? effectiveHeader.value : null,
          providerMessageId,
          status: "SENT",
          sentBy: `bulk:${campaign.id}`,
          sentAt: new Date(),
        },
      });
      await prisma.bulkRecipient.update({
        where: { id: recipient.id },
        data: {
          status: "SENT",
          providerMessageId,
          whatsappMessageId: message.id,
          sentAt: new Date(),
          attemptCount: attempts,
          errorMessage: null,
          errorCode: null,
        },
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error("send failed");
      if (!isRetryable(err) || attempts >= campaign.maxAttempts) break;
      // Exponential backoff with a small cap so a flapping Meta endpoint
      // doesn't lock the worker for too long.
      const wait = Math.min(2_000, 250 * 2 ** (attempts - 1));
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  const message = lastError?.message ?? "Send failed";
  const code = lastError instanceof WhatsAppApiError && lastError.metaCode
    ? String(lastError.metaCode)
    : null;
  await prisma.bulkRecipient.update({
    where: { id: recipient.id },
    data: {
      status: "FAILED",
      errorMessage: message.slice(0, 500),
      errorCode: code,
      attemptCount: attempts,
      failedAt: new Date(),
    },
  });
}

function isRetryable(err: unknown): boolean {
  if (err instanceof WhatsAppApiError) {
    // 5xx, 429 and generic Meta "try again later" are retryable; 4xx auth /
    // template / param errors are not (re-sending won't help).
    if (err.status >= 500) return true;
    if (err.status === 429) return true;
    if (err.metaCode === 130429) return true;
    if (err.metaCode === 131005) return true; // "App temporarily blocked"
    return false;
  }
  // fetch network errors etc.
  return true;
}

function buildCampaignHeader(
  campaign: Prisma.BulkCampaignGetPayload<true>
): WhatsAppTemplateHeader | undefined {
  if (!campaign.headerValue || !campaign.headerType) return undefined;
  const type = campaign.headerType === "image" ? "image" : "text";
  const imageKind =
    campaign.headerKind === "id" ? "id" : campaign.headerKind === "url" ? "url" : undefined;
  return {
    type,
    value: campaign.headerValue,
    imageKind,
  };
}

/**
 * On Next.js startup, walk every campaign currently in SENDING state and
 * restart its worker. Used by `instrumentation.ts` so a process restart
 * (Fly auto-stop, redeploy, crash) doesn't permanently strand a campaign
 * with PENDING recipients.
 */
export async function recoverInFlightCampaigns(): Promise<void> {
  const inFlight = await prisma.bulkCampaign.findMany({
    where: { status: "SENDING" },
    select: { id: true },
  });
  for (const c of inFlight) {
    // Fire and forget — startCampaign returns immediately.
    startCampaign(c.id).catch((err) =>
      console.error("[bulk-messaging] recover failed", c.id, err)
    );
  }
}
