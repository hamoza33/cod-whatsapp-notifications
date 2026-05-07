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
