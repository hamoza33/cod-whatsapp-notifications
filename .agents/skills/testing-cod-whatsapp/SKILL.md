---
name: testing-cod-whatsapp
description: Test the COD WhatsApp Notifications app end-to-end. Use when verifying UI, settings, auth, or API integration changes.
---

# Testing COD WhatsApp Notifications

## Prerequisites

- PostgreSQL running locally
- Database `cod_whatsapp` created with user `devin`
- Node.js and npm installed

## Devin Secrets Needed

- No secrets required for basic UI testing
- For full integration testing: `COD_NETWORK_API_TOKEN` and `WHATSAPP_ACCESS_TOKEN` would be needed (configure via Settings page in the app)

## Setup

```bash
cd /home/ubuntu/repos/cod-whatsapp-notifications
npm install
npx prisma migrate dev
npm run dev
```

Dev server runs at `http://localhost:3000`.

## Login Credentials

- Email: Value of `ADMIN_EMAIL` env var (default: `admin@example.com`)
- Password: Value of `ADMIN_PASSWORD` env var (default: `admin123`)
- Admin user is auto-created on first login if DB has no users and credentials match env vars

## Pages to Test

| Page | Path | Key Elements |
|------|------|--------------|
| Login | `/login` | Email/password form, error banner on invalid credentials |
| Dashboard | `/dashboard` | 7 stat cards (all 0 on fresh DB), "Sync Orders" button |
| Orders | `/orders` | Table with status filter dropdown, search, empty state message |
| Message Logs | `/messages` | Table with status filter (ALL/PENDING/SENT/DELIVERED/READ/FAILED) |
| Sync Logs | `/sync-logs` | Table showing sync history with duration and errors |
| Test Message | `/test-message` | Phone number input, "Send Test Message" button |
| Settings | `/settings` | 3 sections: COD Network API, WhatsApp Cloud API, Automation |

## Critical Test: Settings Masked Credential Protection

This is the most important test — verifies that saving settings doesn't overwrite real API tokens with masked display values.

1. Go to Settings, enter an API token value, click Save
2. Navigate away and come back — token field shows masked value (password dots)
3. Change ONLY a non-sensitive field (e.g., API Base URL), click Save
4. Verify in DB that the real token was NOT overwritten:
   ```bash
   PGPASSWORD=devin123 psql -h localhost -U devin -d cod_whatsapp -c "SELECT key, value FROM settings WHERE key = 'cod_network_api_token';"
   ```
5. The dirty-key tracking in the frontend ensures only user-modified fields are sent in the PUT request

## Masking Format

- Tokens >12 chars: `first4...last4` (e.g., `test...5678`)
- Tokens ≤12 chars: `••••••••` (fully hidden)
- Masking logic is in `src/app/api/settings/route.ts`

## Sync Without Real API Credentials

Clicking "Sync Orders" without a valid COD Network API token will:
- Show a blue result banner (not crash)
- Log a `partial_error` entry in Sync Logs with the 401 error
- This is expected behavior and confirms graceful error handling

## Automation Settings

- "Enable Automation" toggle: gray = disabled, blue = enabled
- "Send Only Once Per Order" toggle: defaults to enabled (blue)
- Settings persist across page reloads when saved
- Automation section also includes: trigger status, delay seconds, default country code

## Known Limitations

- Cannot test actual WhatsApp sending without real Meta API tokens
- Cannot test COD Network sync with real data without a valid API token
- Cron endpoint (`/api/cron/sync`) requires `CRON_SECRET` env var — test via curl with `Authorization: Bearer <CRON_SECRET>`

## Tech Notes

- Next.js 16 uses `proxy.ts` (not `middleware.ts`) for request interception
- Prisma 7 uses `@prisma/adapter-pg` driver adapter pattern
- Auth uses JWT with httpOnly cookies (cookie name: `auth-token`)
---
name: testing-cod-whatsapp
description: Test the cod-whatsapp-notifications app end-to-end on the Fly.io deploy. Use when verifying manual orders, the /pipeline Kanban, /products import, the automation editor (template preview + variable picker), or real WhatsApp template sends to +212690415194.
---

# Testing the COD WhatsApp Notifications app

Live app: https://cod-whatsapp-notifications.fly.dev
Fly app name: `cod-whatsapp-notifications`

## Devin secrets needed

- `COD_DASHBOARD_EMAIL` + `COD_DASHBOARD_PASSWORD` — dashboard login (saved permanent)
- `FLY_API_TOKEN` — `flyctl ssh ...` against the Fly machine (saved permanent)
- `WHATSAPP_TEST_RECIPIENT` — `+212690415194`, the recipient for real WhatsApp template sends
- `COD_NETWORK_API_EMAIL` + `COD_NETWORK_API_PASSWORD` — COD Network seller login (used by the app's product sync + order sync)
- `COD_NETWORK_WEBHOOK_SECRET` — COD Network HMAC verify token for incoming order/lead webhooks
- `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` — Meta Cloud API credentials (already in Fly secrets too)

## Login & API calls

Login sets a cookie. Save it once, re-use for all subsequent API calls:

```bash
curl -c /tmp/cookies.txt -X POST \
  https://cod-whatsapp-notifications.fly.dev/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$COD_DASHBOARD_EMAIL\",\"password\":\"$COD_DASHBOARD_PASSWORD\"}"

# All API calls below use -b /tmp/cookies.txt
curl -s -b /tmp/cookies.txt https://cod-whatsapp-notifications.fly.dev/api/orders?pageSize=5
```

## Recovery: dashboard login returns 401 on Fly

The login route checks the DB first, then falls back to `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars **only if no users exist**. Once a User row exists, the env fallback is dead. If the saved password's bcrypt hash doesn't match what's in `COD_DASHBOARD_PASSWORD`, login will keep returning 401 and there is no "forgot password" flow.

To reset:

1. Compute a bcrypt hash of the desired password (cost 12). In Node:

```js
// Run in any node REPL with bcryptjs installed
require('bcryptjs').hashSync('THE_PASSWORD', 12)
// → e.g. '$2b$12$mf5Ds5uS3WGACCNSJZWdgOB51srV2lZapVQ7pE3ENVq7XbEvVsR8u'
```

2. Write a tiny CommonJS script using the raw `pg` client (Prisma's `PrismaClient` constructor on this app's Prisma version doesn't accept `datasourceUrl` / `datasources.db.url`, so don't bother). Save as `/tmp/reset.cjs`:

```js
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query(
    `INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'admin', NOW(), NOW())
     ON CONFLICT (email)
     DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()
     RETURNING id, email`,
    [process.env.RESET_EMAIL, process.env.RESET_HASH]
  );
  console.log(JSON.stringify(r.rows[0]));
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
```

3. Upload + run on the Fly machine:

```bash
flyctl ssh console -a cod-whatsapp-notifications -C 'rm -f /app/reset.cjs'
flyctl ssh sftp shell -a cod-whatsapp-notifications <<'EOF'
put /tmp/reset.cjs /app/reset.cjs
EOF
flyctl ssh console -a cod-whatsapp-notifications \
  -C "sh -c 'cd /app && RESET_EMAIL=user@example.com RESET_HASH=\"\$2b\$12\$...hash...\" node reset.cjs && rm reset.cjs'"
```

If sftp says "file exists on VM", run `rm -f` first (sftp won't overwrite by default).

## Querying the DB raw

Prisma models use camelCase but the actual Postgres columns are snake_case via `@map` directives. When writing raw SQL on Fly, **use the snake_case names**:

| Prisma field | Postgres column |
|---|---|
| `Order.codNetworkOrderId` | `cod_network_order_id` |
| `Order.customerPhone` | `customer_phone` |
| `Order.whatsappSentAt` | `whatsapp_sent_at` |
| `WhatsappMessage.phoneNumber` | `phone_number` |
| `WhatsappMessage.providerMessageId` | `provider_message_id` |
| `WhatsappMessage.templateName` | `template_name` |
| `WhatsappMessage.sentBy` | `sent_by` |
| `WhatsappMessage.createdAt` | `created_at` |

Check `prisma/schema.prisma` for the full list (`@map("...")` shows the column name).

Table names are also snake_case (`whatsapp_messages`, `inbound_messages`, `automation_runs`, `orders`, `users`).

## Pipeline drag-and-drop: scripted-drag does NOT work

The `/pipeline` page uses **HTML5 native drag-and-drop** (`draggable=true` + `onDragStart/Over/Drop` on React elements). Chrome only fires `dragstart` for OS-level mouse events that exceed its drag threshold. Both of these have failed reliably:

- The desktop tool's `left_mouse_down` + `mouse_move` + `left_mouse_up` sequence
- `xdotool mousedown 1 ; mousemove ... ; mouseup 1` (even with many small intermediate moves)

`browser_console` (CDP-attach) doesn't work either: it returns "Chrome is not in the foreground" even when `xdotool getactivewindow getwindowname` confirms Chrome IS active.

**Workaround:** verify the persistence end-to-end via the PATCH endpoint the drop handler calls. Both `/orders` and `/pipeline` drop into `PATCH /api/orders/:id`:

```bash
curl -s -b /tmp/cookies.txt -X PATCH \
  https://cod-whatsapp-notifications.fly.dev/api/orders/$ORDER_ID \
  -H 'content-type: application/json' \
  -d '{"status":"CONFIRMED"}'
```

Then refresh `/pipeline` and screenshot the card now appearing in the target column. The card visibly moving (PENDING count -1 / CONFIRMED count +1) is sufficient proof of: (a) the drop handler's PATCH path works, (b) the server persists the change, (c) the UI re-renders with server data after a hard reload. Note this in the report as "PARTIAL — drop endpoint + UI re-render verified, gesture itself unverifiable from harness" so the user knows to drag manually once.

When testing the *next* drag-related feature, ask the user to demonstrate the drag in a recorded session of their own rather than burning time trying to script it.

## Automation engine trigger path (T8-style real WhatsApp send)

The automation engine fires from `PATCH /api/orders/:id` whenever the status actually changes (not just any update). To exercise the new variable-mapping path against the real Meta API:

1. Create an automation with `thenSendTemplateName`, `thenSendTemplateLanguage`, `thenSendTemplateVariables` (JSON array of tokens like `["{customer_name}", "{order_id}"]`), and `thenSendHeaderImageUrl` if the template has an IMAGE header.
2. PATCH the automation to `isEnabled: true` AND `whenStatusEquals: <SOME_STATUS>`. Also clear `andProductContains` if you want it to match any product.
3. Create or pick an order whose customer phone is `+212690415194` (the test recipient).
4. PATCH the order to that status. The engine fires asynchronously, creates a row in `whatsapp_messages` with the real `wamid.…` Meta returns, and creates a row in `automation_runs`.
5. Verify via:

```bash
flyctl ssh console -a cod-whatsapp-notifications -C "sh -c 'cd /app && node -e \"
const { Client } = require(\\\"pg\\\");
(async () => { const c = new Client({connectionString: process.env.DATABASE_URL}); await c.connect();
  const r = await c.query(\\\"SELECT id, phone_number, template_name, provider_message_id, status, error_message, sent_by, created_at FROM whatsapp_messages ORDER BY created_at DESC LIMIT 5\\\");
  console.log(JSON.stringify(r.rows, null, 2)); await c.end(); })();
\"'"
```

A real send has `status: "SENT"`, `provider_message_id` starts with `wamid.`, and `sent_by` is `automation:<automation-id>` (vs `manual` for the Test Message / Send dialog path).

## Templates with IMAGE headers (the `kuwait_ezihear_no_reply` family)

The template `kuwait_ezihear_no_reply (en)` (and several other Egrow-EziHear ones) needs **both**:
- 2 body params (`{{1}}` and `{{2}}`)
- An IMAGE header (Meta error `132012` if missing)

For manual testing the placeholder `https://picsum.photos/600/400.jpg` is fine. For real shipping notifications use a public product image URL on a CDN.

Missing/wrong params: Meta returns `132000` (`number of localizable_params (N) does not match expected (M)`).
Missing/wrong header: Meta returns `132012` (`header: Format mismatch, expected IMAGE, received UNKNOWN`).

## Cleanup tasks at end of every test session

Always delete test rows before reporting completion so the user's Fly DB stays clean:

- Manual orders created during the test (e.g. `MANUAL-…` IDs you generated).
- Test automations (delete via `DELETE /api/automations/:id`).
- Test `whatsapp_messages` rows (delete via raw SQL — usually filter by `sent_by LIKE 'automation:%' AND template_name = '<test-template>'` and a recent `created_at`).
- If you changed any real order's status to trigger an automation, restore it.

## Things to remember about the Fly deploy

- App name: `cod-whatsapp-notifications`. Public URL: `https://cod-whatsapp-notifications.fly.dev` (no basic-auth wrapper).
- DB: Managed Postgres cluster, Basic plan. `DATABASE_URL` is available inside Fly machines via `flyctl ssh console`.
- Auto-deploy on every `git push` to `main` (the Fly GitHub action is wired up).
- Product sync cron runs every 60 min (after a 90-sec boot delay) — see `src/lib/auto-sync.ts`.
- Order sync runs every 5 min (configurable in Settings → Order Sync).
- The Fly machine auto-stops when idle and cold-starts on the next HTTP request. First request after idle takes ~5-10s.
