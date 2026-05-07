# COD WhatsApp Notifications

Automate WhatsApp delivery notifications for COD Network orders. When an order becomes shipped or out for delivery, send a WhatsApp template message to the customer — manually or automatically.

## Features

- **Admin Dashboard** — Overview of orders, messages, and sync status
- **Order Sync** — Fetch and sync orders from COD Network Seller API
- **Orders Table** — View all orders with status filters, search, pagination
- **WhatsApp Notifications** — Send template messages to customers for shipped/out-for-delivery orders
- **Message Preview** — Preview the WhatsApp message before sending
- **Automation** — Auto-send messages when orders match a configured trigger status
- **Duplicate Protection** — Prevents sending the same message twice per order
- **Message Logs** — Full audit trail of all sent/failed messages
- **Sync Logs** — History of all order sync operations
- **Test Message** — Send a test WhatsApp message to verify your configuration
- **Rate Limiting** — Built-in rate limiting on message-sending endpoints
- **Phone Normalization** — Auto-converts local phone numbers to international format
- **Secure Credentials** — API keys stored in database settings, never exposed to frontend

## Tech Stack

- [Next.js 16](https://nextjs.org/) (App Router)
- [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS](https://tailwindcss.com/)
- [PostgreSQL](https://www.postgresql.org/)
- [Prisma 7](https://www.prisma.io/) ORM
- [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api)
- [COD Network Seller API](https://cod.network/)

## Prerequisites

- Node.js 20+
- PostgreSQL 14+
- A COD Network seller account with API token
- A Meta WhatsApp Business account with Cloud API access

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd cod-whatsapp-notifications
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your database URL and credentials:

```
DATABASE_URL="postgresql://user:password@localhost:5432/cod_whatsapp"
NEXTAUTH_SECRET="generate-a-secure-random-string"
ADMIN_EMAIL="admin@example.com"
ADMIN_PASSWORD="your-secure-password"
```

### 3. Set up the database

```bash
npx prisma migrate dev
npx prisma generate
```

### 4. Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and log in with the admin email/password from your `.env`.

### 5. Configure API credentials

After logging in, go to **Settings** and enter:

- **COD Network API** — Your API base URL and bearer token
- **WhatsApp Cloud API** — Your Phone Number ID and access token
- **Automation** — Enable/disable auto-sending, set trigger statuses and delays

## Database Schema

| Table | Description |
|---|---|
| `users` | Admin user accounts |
| `settings` | Key-value configuration store (API keys, automation settings) |
| `orders` | Synced orders from COD Network |
| `whatsapp_messages` | Log of all WhatsApp messages sent/attempted |
| `sync_logs` | History of order sync operations |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Admin login |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Get current user |
| GET | `/api/dashboard` | Dashboard statistics |
| GET | `/api/orders` | List orders (paginated, filterable) |
| POST | `/api/orders/sync` | Trigger order sync from COD Network |
| GET | `/api/settings` | Get settings (sensitive values masked) |
| PUT | `/api/settings` | Update settings |
| POST | `/api/whatsapp/send` | Send WhatsApp message for an order |
| POST | `/api/whatsapp/preview` | Preview message for an order |
| POST | `/api/whatsapp/test` | Send a test message |
| GET | `/api/messages` | List message logs (paginated) |
| GET | `/api/sync-logs` | List sync logs (paginated) |
| POST | `/api/cron/sync` | Cron endpoint for automated sync (auth via CRON_SECRET) |

## Cron / Automated Sync

To automate order syncing and message sending, set up a cron job that hits the sync endpoint:

```bash
# Every 5 minutes
*/5 * * * * curl -X POST http://localhost:3000/api/cron/sync -H "Authorization: Bearer YOUR_CRON_SECRET"
```

Or use a service like [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs), [Railway Cron](https://docs.railway.app/), or any external cron service.

## WhatsApp Template

The default template used is `order_out_for_delivery`:

```
Hello {{1}}, your package for order {{2}} is out for delivery today.
Please keep your phone reachable. Thank you.
```

You must create and get this template approved in your [Meta Business Manager](https://business.facebook.com/) before messages can be sent. The template name and language are configurable in Settings.

## Deployment

### Vercel

1. Push to GitHub
2. Import in Vercel
3. Add environment variables
4. Set up a Vercel Cron Job for `/api/cron/sync`

### Docker / VPS

1. Build: `npm run build`
2. Start: `npm start`
3. Ensure PostgreSQL is accessible
4. Set up a system cron for the sync endpoint

## Security

- API keys are stored in the database `settings` table and never sent to the frontend unmasked
- Admin authentication uses JWT tokens stored in httpOnly cookies
- All API endpoints (except login and cron) require authentication
- Rate limiting on WhatsApp send endpoints (30 messages/minute per user)
- Phone numbers are normalized and validated before sending
- Full audit log of all message attempts

## License

Private — all rights reserved.
