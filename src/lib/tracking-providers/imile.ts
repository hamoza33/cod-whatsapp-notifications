import crypto from "node:crypto";
import type { ParsedEvent, ProviderResult } from "./types";

// ---------------------------------------------------------------------------
// iMile direct API (RSA-encrypted sign + MD5 code)
// ---------------------------------------------------------------------------
//
// This is the "working direct API" path that has been in production — kept
// as a named export so callers and a potential rollback don't break, and
// so the orchestrator can use it as a fallback when 4tracking.net doesn't
// recognize an iMile number.

const IMILE_RSA_PUB_DER_B64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3dFPiKNZwt+HoBbPAG/t" +
  "7kZC2k3pBX2eCl5LeyeW8woNuEV5bA5kB9Y9KKTOQng62ERGPLwi84CdIB8s265lj" +
  "QUib//iO3jVrZesJueO5Xu+s80s3Z/89jgJleT1XawN1GubgkGXOoT1a7tvX8+aItk" +
  "GgR//48ELqJVVUL+yGsBtXxFjNmOEWxBJNQuwAf9yWcCIl1enD60GjZjPWrsfw8QU" +
  "qam7K5e45ealcPEYGenNePwuPpCq6twdD0YYYzKdRN0dZP1uTviFpNfph90c9YgQ8" +
  "kgDkRMcpjVv6KZ+bg5JZ4sK6LkV4vwOjPijisthHBvUXhu3fyhMgvoDO/j5gwIDAQ" +
  "AB";

const IMILE_SALT = "imileTrackQuery2024";

interface ImileTrackInfo {
  content: string;
  trackStage: number | null;
  trackStageTx: string | null;
  time: string;
  operateStationName: string | null;
}

interface ImileResponse {
  status: string;
  resultObject: {
    waybillNo: string;
    trackInfos: ImileTrackInfo[];
  } | null;
}

export async function fetchImileTracking(
  waybillNo: string
): Promise<ProviderResult> {
  const code = crypto
    .createHash("md5")
    .update(waybillNo + IMILE_SALT)
    .digest("hex");

  const keyObj = crypto.createPublicKey({
    key: Buffer.from(IMILE_RSA_PUB_DER_B64, "base64"),
    format: "der",
    type: "spki",
  });

  const sign = crypto
    .publicEncrypt(
      { key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(waybillNo)
    )
    .toString("base64");

  const url = `https://www.imile.com/saastms/mobileWeb/track/query?waybillNo=${waybillNo}&code=${code}`;
  const resp = await fetch(url, {
    headers: { lang: "en", sign },
  });

  const data = (await resp.json()) as ImileResponse;

  if (
    data.status !== "success" ||
    !data.resultObject?.trackInfos?.length
  ) {
    return { events: [], rawStatus: null };
  }

  const events: ParsedEvent[] = data.resultObject.trackInfos.map((info) => ({
    status: info.trackStageTx ?? "Unknown",
    description: info.content,
    location: info.operateStationName ?? undefined,
    occurredAt: parseImileDate(info.time),
    rawData: info,
  }));

  const latest = data.resultObject.trackInfos[0];
  return { events, rawStatus: latest.trackStageTx ?? null };
}

function parseImileDate(dateStr: string): Date {
  // iMile format: "2026-05-13 02:30:07"
  return new Date(dateStr.replace(" ", "T") + "+03:00");
}
