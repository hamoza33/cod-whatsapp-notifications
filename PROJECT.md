# COD WhatsApp Notifications — Project Reference

This document explains the final architecture of the app after Chunks 1–5. It is intended to be pasted at the start of any future Devin session as the single source of truth for the project, with edits described in plain English. Last updated for commit `2c40b55` on PR [#3](https://github.com/hamoza33/cod-whatsapp-notifications/pull/3).

## 1. What this app does

The app sits between **COD Network** (the seller's order-management platform) and **Meta WhatsApp Cloud API** (the messaging channel). Its job is to:

1. Pull (or receive via webhook) the seller's orders from COD Network into a local PostgreSQL database.
2. Surface those orders in a Kanban-style **Pipeline** view, one column per status.
3. Let the operator send WhatsApp template messages (e.g. shipping notifications) — either manually, by drag-and-drop, or automatically via configurable rules.
4. Provide a WhatsApp **Inbox** for two-way conversations with customers (free-form replies inside Meta's 24-hour customer-service window).

## 2. High-level architecture

```
+----------------+   webhook (HMAC)   +-----------------+   template msg   +---------+
| COD Network    | -----------------> |  Next.js app    | ---------------> |  Meta   |
| seller platform|   /v2/seller/...   |  (this repo)    |   Graph API      |  Cloud  |
|                | <----------------- |                 | <--------------- |   API   |
+----------------+   sync poll        |   PostgreSQL    |   inbound webhook+---------+
                                      +-----------------+
                                              ^
                                              |
                                          Operator
                                       (web UI + admin)
```

- **Sync path**: A cron tick inside the Next.js process calls COD Network's `GET /v2/seller/orders` every 5 minutes (configurable) for the last 30 days (configurable) and upserts orders into the local DB.
- **Webhook path**: COD Network is also configured to POST `lead` and `order` events to the app. Both inputs converge on the same `Order` table and run through the same auto-status logic.
- **Outbound WhatsApp**: Operator clicks Send (or an Automation fires) → app calls Meta Graph API with the configured template name + variables + optional image header → row written to `WhatsappMessage`.
- **Inbound WhatsApp**: Meta POSTs to `/api/whatsapp/webhook` → app verifies the `X-Hub-Signature-256` header → row written to `InboundMessage`. The Inbox UI groups by phone number.

## 3. Data model (Prisma)

Located in `prisma/schema.prisma`. The migrations history is in `prisma/migrations/`.

### `User`
Admin-only login. Bootstrapped via `npx prisma db seed` to `admin@example.com / admin1234`.

### `Setting`
Generic key/value table that stores **all** app configuration: COD seller email / password / API token, WhatsApp Phone Number ID / Access Token / WABA ID / App Secret / Webhook Verify Token / template defaults, auto-sync flags, COD webhook secret. Sensitive keys are masked when read back through `/api/settings` (the API returns a `sensitivePreviews` object with values like `kuwa••••••••ar`).

The keys themselves live as constants in `src/lib/settings.ts` (see `SETTING_KEYS` and `SENSITIVE_SETTING_KEYS`).

### `Order`
One row per COD Network order. Key fields:

| Field | Source | Notes |
|---|---|---|
| `codNetworkOrderId` | COD `id` | Unique. Primary join key. |
| `codNetworkLeadId` | COD `lead_id` (when available) | Unique, nullable. Set by lead webhook. |
| `customerName` / `customerPhone` / `customerCity` / `customerAddress` | COD `customer.*` | Phone normalized to international format. |
| `productName` | COD `items[].name` (with fallbacks) | See `extractProductName()` in `src/lib/cod-network.ts`. |
| `productPrice` / `productQuantity` | COD `items[].price` / `quantity` | Aggregated across items if multiple. |
| `trackingNumber` | COD `tracking_number` | Triggers auto-status to `OUT_FOR_DELIVERY`. |
| `deliveryCompany` | COD `delivery_company` | Free text. |
| `status` | Derived | One of `NEW`, `CONFIRMED`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED`, `RETURNED`, `CANCELLED`. |
| `codDeliveryStatus` | COD raw status | Stored verbatim for debugging + automation matching. |
| `codCreatedAt` / `codUpdatedAt` | COD `created_at` / `updated_at` | Used for newest-first ordering. |
| `whatsappSentAt` | App | Stamped when a template send succeeds. Re-send guard. |
| `pipelineNote` | App | Free text the operator can attach during drag-and-drop. |
| `rawOrderJson` | COD entire payload | Stored as `Json` for audit. |

### `WhatsappMessage`
One row per outbound message (template or free-form text reply). Fields: `orderId` (nullable, e.g. for ad-hoc replies), `phoneNumber`, `templateName`, `templateLanguage`, `templateVariablesJson`, `providerMessageId` (Meta's `wamid.*`), `status` (`PENDING` / `SENT` / `FAILED` / `DELIVERED` / `READ`), `errorMessage`, `sentBy`, `sentAt`.

### `InboundMessage`
One row per inbound WhatsApp message persisted from the webhook. Fields: `phoneNumber`, `metaMessageId`, `messageType` (`text`, `image`, …), `text`, `mediaId`, `receivedAt`, `rawJson`. The Inbox UI groups by `phoneNumber`.

### `WhatsappTemplate`
Cached snapshot of templates from Meta's Graph API. Refreshed by the **Sync now** button or every 6 hours by the cron. Fields: `name`, `language`, `status` (`APPROVED` / `PENDING` / `REJECTED`), `category`, `bodyParamCount` (derived from `{{N}}` placeholders), `headerType`, `bodyText`, `components` (raw JSON), `lastFetchedAt`.

### `Automation`
Rule rows. The rules engine matches `Automation` rows against an `Order` whenever its status changes. Fields:

- `name` — display only.
- `isEnabled` — toggle.
- `whenStatusEquals` — must match `Order.status` exactly.
- `andProductContains` — substring match against `Order.productName` (case-insensitive). Optional.
- `andProductDoesNotContain` — substring NOT in `Order.productName`. Optional.
- `thenMoveToStatus` — optional new status to write back to `Order.status`. May recursively trigger more automations.
- `thenSendTemplateName` / `thenSendTemplateLanguage` — optional template to send via WhatsApp.
- `thenSendOnce` — if `true`, the unique `(automation_id, order_id)` constraint on `automation_runs` blocks re-execution.

### `AutomationRun`
One row per (automation, order) execution. The unique constraint on `(automation_id, order_id)` backs the "send only once per order" guarantee.

### `SyncLog`
One row per cron tick or manual sync. Stores success/failure, error body, and counts. Surfaced in `/sync-logs`.

## 4. API endpoints

All under `src/app/api/**`. Authentication is enforced by `src/middleware.ts` based on the next-auth session cookie. Webhook endpoints are exempt (they use HMAC signature verification instead).

### COD Network sync
- `GET /api/cod-network/sync` — manual trigger. Reads settings, calls COD, upserts orders, writes a `SyncLog` row. Auto-sync is the same code path on a 5-minute timer.
- `POST /api/cod-network/webhook/leads` — HMAC-verified COD webhook for **lead** events. Upserts by `codNetworkLeadId`.
- `POST /api/cod-network/webhook/orders` — HMAC-verified COD webhook for **order** events. Upserts by `codNetworkOrderId` (or by lead id if order id missing).

### Orders
- `GET /api/orders` — list with newest-first sort. Supports `?status=` / `?sent=true|false` / `?pageSize=` / `?page=` query params.
- `GET /api/orders/[id]` — fetch single.
- `PATCH /api/orders/[id]` — update `status` and/or `pipelineNote`. On status change, fires automations.
- `POST /api/orders/[id]/send-whatsapp` — send the configured template for one order. Respects `whatsappSentAt` unless `force=true` is set.

### WhatsApp
- `POST /api/whatsapp/test` — ad-hoc test send. Accepts `phoneNumber`, `templateName`, `templateLanguage`, `templateVariables[]`, `templateHeaderImage` (URL or mediaId), `templateHeaderText`.
- `POST /api/whatsapp/media` — multipart upload to Meta's Media API. Returns `mediaId`. Used by the Pipeline send dialog so the operator can pick an image off disk.
- `GET /api/whatsapp/templates` — live fetch from Meta's `{waba}/message_templates`. Used by the **Detect Template** button.
- `GET /api/whatsapp/templates/cached` — list from the local `WhatsappTemplate` table. Accepts `?status=APPROVED`.
- `POST /api/whatsapp/templates/import` — refresh `WhatsappTemplate` from Meta. Same endpoint the 6h cron hits.
- `GET /api/whatsapp/webhook` — Meta's `hub.verify_token` / `hub.challenge` handshake.
- `POST /api/whatsapp/webhook` — verified inbound webhook. Persists `messages` to `InboundMessage` and applies `statuses` updates to `WhatsappMessage`.
- `GET /api/whatsapp/inbox` — conversation list.
- `GET /api/whatsapp/inbox/[phone]` — threaded view of one customer.
- `POST /api/whatsapp/inbox/[phone]` — free-form text reply. Falls back to template-send if the 24h window has closed.

### Automations
- `GET /api/automations` — list all with run counts.
- `POST /api/automations` — create.
- `GET /api/automations/[id]` — fetch single.
- `PATCH /api/automations/[id]` — update (toggle `isEnabled`, edit fields).
- `DELETE /api/automations/[id]` — delete.
- `POST /api/automations/[id]?action=preview` — dry-run: returns match count + sample of matching orders.
- `POST /api/automations/[id]?action=run-now` — apply to all currently-matching orders immediately.

### Settings
- `GET /api/settings` — returns the full settings map; sensitive keys return masked previews only (`kuwa••••••••ar`), with `sensitiveKeysSet` listing which ones are actually configured.
- `POST /api/settings` — save. Clears the cached COD token if any COD auth field changes.

## 5. UI surface

All pages under `src/app/(dashboard)/**`. The sidebar (`src/components/sidebar.tsx`) lists: **Dashboard**, **Orders**, **Pipeline**, **Inbox**, **Test Message**, **Templates**, **Automations**, **Sync Logs**, **Settings**.

- **/orders** — sortable, filterable table. Each row has a "Send WhatsApp" button.
- **/pipeline** — Kanban view, one column per status plus a `WhatsApp Sent` virtual column on the right. Cards show name / phone / city / product / price / qty / tracking / `cod_created_at` / last 6 chars of lead id. Drag-and-drop updates `Order.status`. Dropping on `WhatsApp Sent` opens the Send dialog (variable picker chips, image upload, send-anyway override).
- **/inbox** — two-pane Inbox. Conversation list left, threaded messages right, reply composer at the bottom. Polls every 5 s.
- **/test-message** — ad-hoc template send for QA. Includes **Detect Template** to look up the expected param count + header type before sending.
- **/templates** — admin-only list of cached templates. **Sync now** button calls `/api/whatsapp/templates/import`. Shows last sync timestamp.
- **/automations** — CRUD UI for rules. Each card shows the rule in human-readable form, an enable toggle, a **Preview** button (dry-run dialog with sample matches), and a **Run Now** button.
- **/sync-logs** — chronological log of cron + manual syncs.
- **/settings** — every config key the app uses. Sensitive fields render a masked preview chip (`kuwa••••••••ar`) when previously saved. The **COD Network Webhooks** section displays the two webhook URLs with a Copy button for pasting into COD's dashboard.

## 6. Environment & runtime

### Required env vars
The `.env` file is consumed by Next.js + Prisma:

```
DATABASE_URL=postgresql://codapp:codapp@localhost:5432/cod_whatsapp
NEXTAUTH_SECRET=...
NEXTAUTH_URL=http://localhost:3000
```

All other configuration (COD credentials, WhatsApp credentials, etc.) lives in the `Setting` table and is editable through `/settings`.

### Local dev
1. `npm install`
2. Start Postgres (the repo's `setup.sh` script handles this).
3. `npx prisma migrate deploy`
4. `npx prisma db seed` (creates the admin user).
5. `npm run dev`

### Background jobs
- **Auto-sync cron** — `src/lib/auto-sync.ts`. Started from `src/instrumentation.ts` (Next.js's instrumentation hook). Reads `auto_sync_enabled` + `auto_sync_interval_minutes` per tick, so the operator can flip it on/off from `/settings` without restarting the server. Default: every 5 minutes, last 30 days.
- **Template import cron** — same file. Runs once 60s after boot, then every 6 hours. Updates `WhatsappTemplate` from Meta.

Both crons are in-process Node timers, not external. That means they only run while the Next.js process is alive. For production on a serverless platform you'd want to replace them with an external scheduler (e.g. Vercel Cron, GitHub Actions, or a small worker dyno).

## 7. Security model

- **Admin auth** — next-auth credentials provider against the `User` table (bcrypt-hashed password). All `/api/**` routes except the webhooks require a valid session.
- **WhatsApp inbound webhook** — Meta's `X-Hub-Signature-256` is verified against the configured **App Secret**. If no App Secret is saved, verification is **skipped** (intentional for local dev — set the secret before exposing the endpoint).
- **COD Network webhook** — `X-Signature` header is verified against the configured **Webhook Secret Key**. Same skip-on-empty rule as the Meta webhook.
- **Sensitive settings** — never returned by the API in plaintext. The UI shows a masked preview only.
- **Phone normalization** — done once in `src/lib/phone.ts`. Default country code is configurable (`PHONE_DEFAULT_COUNTRY_CODE`, default `212`).

## 8. Extension points

To **add a new automation condition** (e.g. "AND tracking number is set"):
1. Add the column to `prisma/schema.prisma` → `Automation`.
2. Add the matching logic in `src/lib/automations.ts` → `matchesAutomation()`.
3. Add the UI field in `src/app/(dashboard)/automations/page.tsx`.
4. Add the API surface (POST + PATCH) in `src/app/api/automations/route.ts` + `[id]/route.ts`.

To **add a new automation action** (e.g. "AND tag the order with X"):
1. Same migration step.
2. Add the action to `src/lib/automations.ts` → `executeAutomation()`.
3. Add the UI field.
4. Add the API surface.

To **add a new WhatsApp template feature** (e.g. button payloads):
- Templates are parsed in `src/lib/template-import.ts` → `countBodyParameters()` and friends. Extend that to capture additional `components`.

To **switch order source from COD Network to another provider**:
- All COD-specific code is in `src/lib/cod-network.ts` and `src/lib/cod-webhook*.ts`. Replace those two and the rest of the app keeps working as long as the new provider's data is normalized into the same `Order` shape.

To **change auto-status logic** (e.g. "treat SHIPPED as DELIVERED"):
- Edit `src/lib/order-status.ts` → `deriveOrderStatus()`. Already called from sync, webhook, and drag-and-drop paths.

## 9. Known gotchas

- **WABA ID vs Phone Number ID**: Meta has two confusingly similar IDs. The **Phone Number ID** (`906139205908177` for this tenant) is for sending messages; the **WABA ID** is required for `message_templates` listings. The Settings UI exposes both.
- **`hello_world` template**: the default Meta test template is not approved on every WABA. The **Test Message** page now uses the configured template name instead of hard-coding `hello_world`.
- **Template body params**: Meta returns `#132000 number of localizable_params (X) does not match expected (Y)` when the count is off. The UI surfaces a friendly message + the **Detect Template** button so the operator can see the expected count up-front.
- **Template image header**: When a template defines a header of type `IMAGE`, the send call **must** include `image` with either `link` (public URL) or `id` (uploaded media). The Pipeline send dialog supports both.
- **24-hour conversation window**: free-form text replies from `/inbox` only work inside Meta's 24-hour window. The app catches the Meta error and surfaces a hint to switch to a template send.
- **Auto-status from raw COD statuses**: `deriveOrderStatus()` does substring matching on `codDeliveryStatus`. If COD adds a new status string that contains "delivered" or "returned" you may need to refine the logic.

## 10. Test mode log (latest run)

The most recent end-to-end test of Chunks 1–3 was 21 assertions: **18 passed, 1 partial, 2 untested**. See PR #3 comments for the breakdown. Chunks 4–5 are build/lint-clean and verified against synthetic webhooks; live testing requires the public webhook URL to be wired into COD Network.

## 11. How to ask for edits in a new session

Open a fresh Devin session and paste:

> Project context: see [PROJECT.md](https://github.com/hamoza33/cod-whatsapp-notifications/blob/devin/1778205290-fix-cod-auth-and-whatsapp/PROJECT.md). I want to [describe change].

Then describe what you want. Examples of safe asks:
- "Add a new automation condition `AND order is older than X days`."
- "Change the auto-status mapping so SHIPPED stays SHIPPED unless a tracking number arrives."
- "Hide the Test Message page from non-admin users."
- "Add a new template-import filter that skips templates with `category = MARKETING`."

For larger asks (new provider integrations, multi-tenant support, etc.) describe the goal in plain English and let Devin propose a plan first.
