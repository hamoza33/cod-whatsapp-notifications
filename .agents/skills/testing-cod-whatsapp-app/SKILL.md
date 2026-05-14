---
name: testing-cod-whatsapp-app
description: Reference knowledge for testing the COD WhatsApp Notifications app — local accounts, webhook HMAC signing pattern, known WABA-vs-PNI gotcha, Devin-tunnel basic-auth limitation, and tracking architecture test procedures. Use when verifying changes to /api/cod-network/webhook/*, /api/whatsapp/*, /api/tracking/*, or the Settings/Pipeline/Automations/Templates/Dashboard pages.
---

# Testing the COD WhatsApp Notifications app

## Local accounts

- Admin login: `admin@example.com` / `admin1234` (seeded by Prisma).
- Postgres: `postgresql://codapp:codapp@localhost:5432/cod_whatsapp` (role created by env initialize step).
- Dev server: `npm run dev` → http://localhost:3000.

## Real credentials (all stored as permanent secrets — never paste raw values)

- `COD_NETWORK_API_EMAIL`, `COD_NETWORK_API_PASSWORD` — used by `/v2/seller/login`, 1h access_token cached in `Setting` table.
- `WHATSAPP_ACCESS_TOKEN` — Meta Graph API token, 197 chars.
- `WHATSAPP_PHONE_NUMBER_ID` — `906139205908177` for the test WABA.
- `WHATSAPP_TEST_RECIPIENT` — `+212690415194` (Morocco, +212 country code).
- `COD_NETWORK_WEBHOOK_SECRET` — shared secret for HMAC-SHA256 verification of webhooks.

All of these are saved as permanent secrets in Devin's settings; they are surfaced as env vars in the shell and the app reads them via the Settings page (where they get persisted to the DB).

## Testing the Tracking Architecture (PR #18+)

### Setup: Seed test orders with various carrier names

To test carrier normalization and the tracking job flow, insert test orders with different `delivery_company` values:

```sql
INSERT INTO orders (id, cod_network_order_id, customer_name, customer_phone, tracking_number, delivery_company, status, created_at, updated_at)
VALUES
  ('test-jte-1', 'COD-JTE-001', 'Test JTE', '+212600000001', 'JT1234567890', 'J&T Express', 'SHIPPED', NOW(), NOW()),
  ('test-jte-2', 'COD-JTE-002', 'Test JTE 2', '+212600000002', 'JT9876543210', 'JTE', 'PENDING', NOW(), NOW()),
  ('test-jdw-1', 'COD-JDW-001', 'Test JDW', '+212600000004', 'JD2222222222', 'JD Logistics', 'SHIPPED', NOW(), NOW()),
  ('test-jdw-2', 'COD-JDW-002', 'Test JD', '+212600000005', 'JD3333333333', 'Jingdong', 'PROCESSING', NOW(), NOW()),
  ('test-injaz-1', 'COD-INJAZ-001', 'Test Injaz', '+212600000006', 'INJ444444444', 'Injaz Express', 'SHIPPED', NOW(), NOW()),
  ('test-imile-1', 'COD-IMILE-001', 'Test iMile', '+212600000008', 'IM666666666', 'iMile', 'SHIPPED', NOW(), NOW()),
  ('test-unknown-1', 'COD-UNK-001', 'Test Unknown', '+212600000010', 'XYZ888888888', 'SomeRandomCarrier', 'SHIPPED', NOW(), NOW());
```

### Test: Carrier reclassify endpoint

```bash
curl -s -b /tmp/cookies.txt -X POST http://localhost:3000/api/tracking/reclassify | python3 -m json.tool
```

Expected: `reclassified` count matches known carriers; `stillUnknown` count = 1 (SomeRandomCarrier); each reclassification shows `from: null → to: JTE/JDW/INJAZ/IMILE`.

### Test: Sync All Tracking (job creation + worker processing)

1. Reset carrier data: `UPDATE orders SET normalized_carrier = NULL;`
2. Clear previous jobs: `DELETE FROM tracking_job_items; DELETE FROM tracking_jobs;`
3. Call sync-all:
   ```bash
   curl -s -b /tmp/cookies.txt -X POST http://localhost:3000/api/tracking/sync-all | python3 -m json.tool
   ```
4. Expected response: `{ "jobId": "...", "totalOrders": N }` where N = number of eligible orders (status not DELIVERED/RETURNED/CANCELLED, has tracking_number).
5. Poll progress:
   ```bash
   curl -s -b /tmp/cookies.txt http://localhost:3000/api/tracking/jobs/<jobId> | python3 -m json.tool
   ```
6. Wait ~60s for the worker to finish (retries add ~2-8s backoff per batch).
7. Verify: `processedOrders == totalOrders`, no PENDING items remain.

### Known behaviors during local testing

- **Tracking providers return HTTP 404 for fake tracking numbers** — this is expected. All items will be FAILED after 3 retry attempts. The key test is that ALL items are processed, not just 1/5/20.
- **Worker retry timing**: Each failed batch retries with exponential backoff (2s, 4s, 8s). A job with 10 items across 4 carriers takes ~50-60s to fully complete locally.
- **UNKNOWN carrier items are SKIPPED** (not FAILED) with message "No tracking provider for unknown carrier".
- **Job status = FAILED when successCount=0** — this is correct behavior when all tracking providers return errors. On Fly.io with real tracking numbers, some should succeed.
- **Duplicate prevention**: Calling `POST /api/tracking/sync-all` while a job is QUEUED/RUNNING returns HTTP 409.
- **Worker starts automatically** via `instrumentation.ts` on server boot. Check dev server logs for `[tracking-worker] Worker loop started`.

### UI verification (Dashboard page)

- Purple "Sync All Tracking" button appears next to blue "Sync Orders" button.
- Clicking it shows a progress bar with: percentage, current carrier name, success/failed/skipped counts.
- Progress bar turns green on completion, red on failure.
- Expandable "Recent errors" section shows per-item error details.
- Button changes to "Tracking..." (disabled) during processing, re-enables after completion.

### Cleanup after tracking tests

```sql
DELETE FROM tracking_job_items;
DELETE FROM tracking_jobs;
DELETE FROM orders WHERE id LIKE 'test-%';
```

## Webhook HMAC-SHA256 signing pattern (synthetic test)

The COD webhook endpoints (`/api/cod-network/webhook/leads`, `/api/cod-network/webhook/orders`) verify an `X-Signature` header. When the saved `cod_network_webhook_secret` is empty, signature verification is bypassed (intentional for first-time setup). When set, signature must match `hex(hmac_sha256(secret, raw_body))`.

To test end-to-end with curl:

```bash
# Get secret from DB (or set it inline for a synthetic test)
SECRET="$(PGPASSWORD=codapp psql -h localhost -U codapp -d cod_whatsapp -t -A -c \
  \"SELECT value FROM settings WHERE key='cod_network_webhook_secret';\")"

BODY='{"id":99999999,"customer":{"name":"Webhook Test","phone":"+212690415194"},"items":[{"name":"test-cream","price":99,"quantity":1}],"status":"delivered","tracking_number":"WHK-001","lead_id":7654321}'
SIG="$(printf "%s" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')"

curl -sS -X POST http://localhost:3000/api/cod-network/webhook/orders \
  -H 'Content-Type: application/json' \
  -H "X-Signature: $SIG" \
  --data "$BODY"
```

Expected response: `{"ok":true,"orderId":"…","created":true|false,"updated":true|false,"statusChanged":true|false,"newStatus":"DELIVERED"}`

After the test, **always** clean up:
```bash
PGPASSWORD=codapp psql -h localhost -U codapp -d cod_whatsapp \
  -c "DELETE FROM orders WHERE cod_network_order_id='99999999';"
```

## Auto-status mapping (verify with synthetic webhooks)

- `tracking_number` present (and status not `delivered`/`returned`) → `OUT_FOR_DELIVERY`
- `status: "delivered"` (or COD label "delivered") → `DELIVERED`
- `status: "returned"` (or COD label "returned") → `RETURNED`

See `src/lib/order-status.ts` for the full map.

## Known gotcha: Devin `deploy expose` tunnel uses HTTP Basic Auth

When you run `deploy expose` with port 3000, the returned URL has the form `https://user:<password>@<host>.devinapps.com/...`. Browsers parse the embedded credentials, but most webhook senders (COD Network included) do **not**. So this tunnel URL **cannot** be used as a real webhook destination — the upstream Traefik proxy will return `HTTP 401 www-authenticate: Basic realm="traefik"`.

For production webhook testing, the user must deploy to a real host (Vercel / Fly.io / Railway / their own VPS) and paste *that* URL into COD Network → API Developer → Webhooks.

For synthetic webhook testing during a session, hit `http://localhost:3000/api/cod-network/webhook/*` directly via curl as shown above.

## Known gotcha: `whatsapp_business_account_id` vs Phone Number ID

The Meta Graph API endpoint for listing templates is `/{WABA_ID}/message_templates`. If `whatsapp_business_account_id` in `settings` is actually the Phone Number ID, the call fails with `(#100) Tried accessing nonexisting field (message_templates)`. The template-import cron logs this every 6h tick. The Templates page handles the error gracefully — empty list with a friendly error message.

The real WABA ID lives in **Meta Business Manager → WhatsApp Manager → API Setup → "WhatsApp Business Account ID"** (different field from the Phone Number ID).

## Sending a template message to the real test recipient

See the Fly.io-specific skill file for the full procedure using `WHATSAPP_TEST_RECIPIENT` (+212690415194).
