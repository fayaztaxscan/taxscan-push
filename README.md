# taxscan-push

Self-hosted web push notification service for taxscan.in (Phase 1).

## Stack

- Node.js 18+ / TypeScript / Express
- PostgreSQL via Prisma (Railway-hosted)
- `web-push` (VAPID) for delivery
- `node-cron` + `rss-parser` for the RSS poller
- Vue 3 + Vite for the admin SPA

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and VAPID keys
npm run db:migrate
npm run dev
```

The server listens on `PORT` (default `3000`). Health check: `GET /healthz`.

## VAPID keys

Web push requires a VAPID key pair. Generate one:

```bash
npm run gen:vapid
```

Copy the printed values into `.env`:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@taxscan.in
```

- `VAPID_PUBLIC_KEY` is shared with browsers when they subscribe.
- `VAPID_PRIVATE_KEY` signs each push request — keep it secret.
- `VAPID_SUBJECT` must be a valid `mailto:` (or `https:`) URL the push service can contact.

Rotating the key pair invalidates every existing subscription, so generate once per environment.

## Scripts

| Command              | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `npm run dev`        | Start the API with auto-reload (`ts-node-dev`)        |
| `npm run build`      | Compile TypeScript to `dist/`                         |
| `npm start`          | Run the compiled server                               |
| `npm run db:migrate` | Apply / create Prisma migrations against `DATABASE_URL` |
| `npm run db:studio`  | Open Prisma Studio                                    |
| `npm run gen:vapid`  | Print a fresh VAPID key pair                          |
| `npm run lint`       | ESLint over `src/`                                    |
| `npm run format`     | Prettier over `src/`                                  |
