---
name: testing-cod-whatsapp-app
description: Reference knowledge for testing the COD WhatsApp Notifications app — local accounts, webhook HMAC signing pattern, known WABA-vs-PNI gotcha, Devin-tunnel basic-auth limitation, and PR #12 feature testing patterns. Use when verifying changes to /api/cod-network/webhook/*, /api/whatsapp/*, /api/voice-agent/*, or the Settings/Pipeline/Automations/Templates/Products pages.
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

See the `testing-cod-whatsapp` skill for login + curl patterns.

## Testing Call Agent column (Pipeline)

The Call Agent column groups orders where `callAgentQueued = true`. To test:

1. Pick any order ID (e.g., from `GET /api/orders?pageSize=5`)
2. `PATCH /api/orders/:id` with `{"callAgentQueued": true}` — order moves to Call Agent column
3. Refresh `/pipeline` and verify the card appears in the purple "CALL AGENT" column
4. **Important**: After PATCH, you may need to click the Refresh button on the pipeline page to force a client-side data refetch. The page might show stale cached data.
5. Revert with `{"callAgentQueued": false}` after testing

## Testing multi-product images on pipeline cards

Orders with multiple products in `rawOrderJson.items` show multiple `<img>` elements on the card. Check the DOM for orders like "Nour Ali #807054" or "jari alharithi #767724" — they should have 2+ `<img>` tags and combined product names like "Varicose 3 vein cream, Electric Foot Massager".

Visual scrolling to find these cards might be slow — checking the DOM is more reliable.

## Testing WA Numbers CRUD

Create test numbers via API, verify they appear in Settings > WA Numbers tab, then clean up:

```bash
# Create
curl -s -b /tmp/cookies.txt -X POST $BASE_URL/api/whatsapp/numbers \
  -H 'content-type: application/json' \
  -d '{"label":"Test Number","phoneNumberId":"123456","displayPhone":"+212600000000"}'

# List
curl -s -b /tmp/cookies.txt $BASE_URL/api/whatsapp/numbers

# Delete (use the id from create response)
curl -s -b /tmp/cookies.txt -X DELETE $BASE_URL/api/whatsapp/numbers/<id>
```

## Testing Inbox WA number dropdown

The dropdown only appears when **2 or more** WA numbers are configured. Create 2+ numbers first, then navigate to `/inbox`, select a conversation, and verify the `<select>` element appears in the chat header.

## Testing Voice Agent tab

Navigate to Settings > Voice Agent tab. Verify all fields render: Enable toggle, Provider dropdown (ElevenLabs/Bland AI), Voice API Key, Voice ID, Caller ID, Language (6 options), Call Script/System Prompt, Webhook URL, LLM API Key, LLM Model.

## Testing Voice Agent API error handling

```bash
curl -s -b /tmp/cookies.txt -X POST $BASE_URL/api/voice-agent \
  -H 'content-type: application/json' \
  -d '{"orderId":"<any-valid-order-id>"}'
```

Expected: structured error JSON like `{"error":"Voice agent is not enabled..."}` — NOT a 500 crash.

## Known gotcha: Product import might fail with schema errors

The `POST /api/products/sync` endpoint might fail if the product sync code references database columns that don't exist in the current migration (e.g., `products.description`). Check for "Unexpected end of JSON input" errors on the Products page, which may indicate schema mismatches. The Products page error and the sync endpoint error are related — both stem from the product table schema.