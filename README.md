# Scaffold Push Service

A self-hosted web push notification service with integrated PWA hosting. Connect multiple web apps to a single push server, serve dynamic Web App Manifests, and give each app a shareable app-store-style installation page — all from one deployment with no config files to manage.

---

## Features

- **Web Push Notifications** — send to all subscribers or target a specific user by ID
- **Scheduled Notifications** — queue notifications for future delivery, cancel at any time
- **Dynamic PWA Manifests** — hosted and served per-project with icons, screenshots, language, categories
- **Installation Pages** — shareable `/install/:slug` pages with icon, description, screenshots carousel, YouTube preview, native app store redirects, and SEO meta tags
- **Drop-in Widget** — single `<script>` tag adds bell widget, subscribe banner, and install prompt to any site
- **Multi-project** — manage multiple web apps from one dashboard
- **Admin Dashboard** — full UI for projects, subscribers, notifications, scheduling, PWA config, and widget customisation
- **User Authentication** — email/password login with JWT, supports multiple admin accounts
- **iOS PWA Support** — Apple meta tags served automatically; install page handles Safari-specific instructions
- **SEO / Social Sharing** — OG image (1200×630), meta description, canonical URL, robots control per project
- **App Store Links** — configurable redirects to App Store, Google Play, Chrome Web Store, Microsoft Store with platform auto-detection
- **Automatic Migrations** — database schema evolves on startup, no manual migration step

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 20 |
| Framework | Express 4 |
| Language | TypeScript |
| Database | PostgreSQL (tested with Neon serverless) |
| ORM | Drizzle ORM |
| Push | web-push (VAPID) |
| Image processing | Sharp |
| Auth | bcryptjs + jsonwebtoken |
| Build | esbuild |
| Dev | tsx |

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                      Express Server                        │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │  routes.ts  │  │  scheduler   │  │  public/ static  │ │
│  │  (~45 routes│  │  (every 60s) │  │  index.html      │ │
│  └──────┬──────┘  └──────┬───────┘  └──────────────────┘ │
│         │                │                                │
│  ┌──────▼────────────────▼─────────────────────────────┐  │
│  │                   storage.ts                         │  │
│  │            (query abstraction layer)                 │  │
│  └─────────────────────────┬───────────────────────────┘  │
│                             │                             │
│  ┌──────────────────────────▼───────────────────────────┐ │
│  │           Drizzle ORM  ←→  Neon PostgreSQL            │ │
│  └──────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────┘

Auth layers:
  Your web app   →  x-api-key (project key)  →  /subscribe, /notify, /history
  Admin browser  →  x-admin-key (JWT)        →  /admin/*, dashboard UI
  Public users   →  no auth                  →  /install/:slug, /pwa/manifest.json
```

### Source Files

```
src/
├── index.ts            # Express setup, auto-migrations on startup, background scheduler
├── routes.ts           # All ~45 HTTP endpoints
├── schema.ts           # Drizzle table definitions (6 tables)
├── storage.ts          # Database query layer — all DB access goes through here
├── db.ts               # Drizzle + Neon connection initialisation
├── push.ts             # web-push integration — VAPID auth, send to subscription
├── image.ts            # Sharp image processing (logo resize, .ico, OG image, screenshots)
├── middleware/
│   └── auth.ts         # requireApiKey / requireAdminKey (JWT or raw ADMIN_KEY)
└── scripts/
    └── generate-vapid.ts  # One-time CLI utility to generate VAPID key pair

public/
├── index.html          # Admin dashboard — single-file SPA, vanilla JS, no bundler
└── install-sw.js       # Service worker served to install page visitors
```

---

## Database Schema

Tables are created and columns are added automatically on every startup using `ALTER TABLE IF NOT EXISTS` SQL. You never need to run a manual migration.

### `service_users`
Admin accounts for the dashboard login.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | nanoid |
| email | TEXT UNIQUE | login email |
| password_hash | TEXT | bcrypt (10 rounds) |
| name | TEXT | optional display name |
| created_at | TIMESTAMP | |

### `projects`
One row per connected web app.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | nanoid |
| name | TEXT | internal label |
| api_key | TEXT UNIQUE | nanoid(32) — your web app sends this in `x-api-key` |
| logo | TEXT | 192×192 PNG data URL — used as notification icon |
| logo_512 | TEXT | 512×512 PNG data URL — PWA app icon |
| logo_badge | TEXT | 96×96 PNG data URL — Android notification badge |
| logo_ico | TEXT | multi-res .ico (16/32/48px) — served as favicon |
| logo_svg | TEXT | original SVG — served as `purpose: any` icon |
| pwa_name | TEXT | manifest `name` and install page heading |
| pwa_short_name | TEXT | manifest `short_name` (≤12 chars) |
| pwa_theme_color | TEXT | browser toolbar color hex |
| pwa_bg_color | TEXT | splash screen background hex |
| pwa_display | TEXT | `standalone` \| `fullscreen` \| `minimal-ui` \| `browser` |
| pwa_url | TEXT | production domain — sets manifest `start_url` and `scope` |
| pwa_description | TEXT | install page description + manifest `description` |
| pwa_youtube_url | TEXT | YouTube embed URL shown on install page |
| pwa_lang | TEXT | IANA language tag (e.g. `en`, `pt`) |
| pwa_categories | TEXT | JSON array (e.g. `["productivity","utilities"]`) |
| install_slug | TEXT UNIQUE | friendly URL slug (e.g. `my-app` → `/install/my-app`) |
| seo_image | TEXT | OG social image — data URL or external URL |
| seo_indexable | TEXT | `"true"` \| `"false"` — controls `robots` meta tag |
| store_links | TEXT | JSON: `{appStore,playStore,chromeStore,windowsStore}` each `{url,enabled}` |
| widgets_config | TEXT | JSON: `{bell,banner,install,installBanner,*Color}` |
| created_at | TIMESTAMP | |

### `screenshots`
Up to 6 screenshots per project, shown on the install page and included in the PWA manifest.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | nanoid |
| project_id | TEXT FK | → projects (cascade delete) |
| data | TEXT | base64 PNG data URL |
| mime_type | TEXT | e.g. `image/png` |
| width | INTEGER | |
| height | INTEGER | |
| form_factor | TEXT | `wide` \| `narrow` |
| label | TEXT | optional alt text / manifest label |
| created_at | TIMESTAMP | |

### `subscriptions`
One row per browser/device that opted in to push for a project.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | nanoid |
| project_id | TEXT FK | → projects (cascade delete) |
| endpoint | TEXT UNIQUE | browser push service endpoint URL |
| p256dh | TEXT | browser ECDH public key |
| auth | TEXT | browser auth secret |
| user_agent | TEXT | browser UA string |
| user_id | TEXT | optional — links subscription to an app user ID |
| user_name | TEXT | optional — display name shown in dashboard |
| created_at | TIMESTAMP | |

### `notification_log`
Audit trail of every notification sent.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | nanoid |
| project_id | TEXT FK | → projects (cascade delete) |
| title | TEXT | |
| body | TEXT | |
| url | TEXT | click-through URL |
| image | TEXT | large image URL in notification body |
| sent_at | TIMESTAMP | |
| success_count | INTEGER | successful deliveries |
| failure_count | INTEGER | failed/expired deliveries |

### `scheduled_notifications`
Notifications queued for future delivery.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | nanoid |
| project_id | TEXT FK | → projects (cascade delete) |
| title | TEXT | |
| body | TEXT | |
| url | TEXT | |
| image | TEXT | |
| icon | TEXT | resolved icon URL stored at schedule time |
| actions | TEXT | JSON: `[{action, title, url}]` |
| scheduled_at | TIMESTAMP | when to deliver |
| status | TEXT | `pending` \| `sent` \| `cancelled` |
| created_at | TIMESTAMP | |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string |
| `VAPID_PUBLIC_KEY` | **Yes** | Web Push public key — generate with `npm run vapid:generate` |
| `VAPID_PRIVATE_KEY` | **Yes** | Web Push private key — never expose this |
| `VAPID_SUBJECT` | **Yes** | Contact URI for push servers, e.g. `mailto:admin@example.com` |
| `ADMIN_KEY` | **Yes** | Fallback admin secret for CLI/script access to admin routes |
| `JWT_SECRET` | No | Secret for signing JWTs — defaults to `ADMIN_KEY` if not set; recommended to set separately in production |
| `PORT` | No | HTTP port (default: `3000`) |

---

## API Reference

### Authentication

| Method | Applies to | Header |
|---|---|---|
| Project API key | `/subscribe`, `/notify`, `/history`, `/subscribers` | `x-api-key: YOUR_PROJECT_API_KEY` |
| Admin key (JWT) | All `/admin/*` routes and `/auth/me` | `x-admin-key: YOUR_JWT_TOKEN` |
| Admin key (raw) | All `/admin/*` routes — backward compat for scripts | `x-admin-key: YOUR_ADMIN_KEY` |

### Public (no auth)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{ok: true}` |
| GET | `/vapid-public-key` | VAPID public key for client subscription setup |
| GET | `/pwa/manifest.json?key=API_KEY` | Dynamic PWA Web App Manifest JSON |
| GET | `/pwa/icon/:projectId/192.png` | 192×192 icon PNG |
| GET | `/pwa/icon/:projectId/512.png` | 512×512 icon PNG |
| GET | `/pwa/icon/:projectId/96.png` | 96×96 badge PNG |
| GET | `/pwa/icon/:projectId/icon.svg` | Original SVG icon |
| GET | `/pwa/icon/:projectId/favicon.ico` | Multi-res favicon (16/32/48px) |
| GET | `/pwa/screenshot/:id.png` | Screenshot PNG |
| GET | `/pwa/seo-image/:id` | OG social image JPEG (Cache-Control: 24h) |
| GET | `/pwa/install-manifest/:slugOrId` | Same-origin manifest for install page |
| GET | `/pwa/config?key=API_KEY` | Widget enable/disable config for the widget script |
| GET | `/widgets.js?key=API_KEY` | Drop-in widget JS bundle |
| GET | `/install/:slugOrId` | App-store-style install page |

### Auth endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/auth/register` | `{email, password, name?}` | Create admin account → `{token, user}` |
| POST | `/auth/login` | `{email, password}` | Sign in → `{token, user}` |
| GET | `/auth/me` | — | Get current user info (admin key required) |
| GET | `/auth/status` | — | `{hasUsers: bool}` — used by dashboard to show Login vs Register on first visit |

### Project API (`x-api-key`)

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/subscribe` | `{endpoint, keys: {p256dh, auth}, userId?, userName?}` | Register push subscription |
| POST | `/unsubscribe` | `{endpoint}` | Remove push subscription |
| POST | `/resubscribe` | `{endpoint, keys, oldEndpoint?}` | Swap endpoints after key rotation (`pushsubscriptionchange` SW event) |
| POST | `/notify` | See below | Send or schedule a notification |
| GET | `/history` | — | Last 100 notifications sent for this project |
| GET | `/subscribers` | — | Subscriber count for this project |

**POST `/notify` body**

```json
{
  "title": "Hello!",
  "body": "You have a new message.",
  "url": "https://yourapp.com/messages",
  "icon": "https://yourapp.com/icon.png",
  "image": "https://yourapp.com/preview.jpg",
  "badge": "https://yourapp.com/badge.png",
  "actions": [
    { "action": "reply", "title": "Reply", "url": "/messages" },
    { "action": "dismiss", "title": "Dismiss" }
  ],
  "targetUserId": "user-123",
  "scheduledAt": "2025-12-01T09:00:00.000Z"
}
```

All fields except `title` and `body` are optional. Omit `targetUserId` to broadcast to all subscribers. Include `scheduledAt` to queue for future delivery instead of sending immediately.

### Admin routes (`x-admin-key`)

**Projects**

| Method | Path | Description |
|---|---|---|
| GET | `/admin/projects` | List all projects with full metadata |
| POST | `/admin/projects` | Create project `{name}` → `{id, apiKey, ...}` |
| DELETE | `/admin/projects/:id` | Delete project — cascades all subscriptions, screenshots, logs |
| PATCH | `/admin/projects/:id/pwa` | Save PWA manifest config (name, URL, theme, lang, categories, description, etc.) |
| PATCH | `/admin/projects/:id/widgets` | Save widget config (enable/disable + colors) |
| POST | `/admin/projects/:id/logo/upload` | Upload logo image (multipart `logo` field) — auto-resized |
| PATCH | `/admin/projects/:id/logo` | Set logo via external URL `{logo: "https://..."}` |
| POST | `/admin/projects/:id/seo-image` | Upload OG image (multipart `image` field) — resized to 1200×630 JPEG |

**Screenshots**

| Method | Path | Description |
|---|---|---|
| GET | `/admin/projects/:id/screenshots` | List screenshots |
| POST | `/admin/projects/:id/screenshots` | Upload screenshot (multipart `screenshot` field) — resized to 900×1600 PNG |
| DELETE | `/admin/screenshots/:id` | Delete screenshot |

**Subscribers**

| Method | Path | Description |
|---|---|---|
| GET | `/admin/projects/:id/subscribers` | List subscribers (safe: endpoint hint, userAgent, userId, userName, createdAt — full endpoint is never returned) |
| DELETE | `/admin/subscribers/:id` | Remove subscriber |

**Scheduled notifications**

| Method | Path | Description |
|---|---|---|
| GET | `/admin/projects/:id/scheduled` | List pending scheduled notifications |
| DELETE | `/admin/scheduled/:id` | Cancel a pending scheduled notification |

---

## Integration Guide

### 1. Generate VAPID keys (one time)

```bash
npm run vapid:generate
```

Copy the output `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` into your environment.

> **Important — keep your VAPID keys safe.**
> VAPID keys are cryptographically tied to every push subscription your users create.
> If you lose them and have to generate new ones, all existing subscribers will silently
> stop receiving notifications — they would need to re-subscribe from scratch.
> Back them up somewhere secure (a password manager, your hosting platform's secret store, etc.)
> and never rotate them unless you are prepared to lose all current subscriptions.

### 2. Add the widget script

The simplest integration — one tag does everything:

```html
<script src="https://your-push-service.com/widgets.js?key=YOUR_API_KEY" defer></script>
```

This registers the service worker, requests notification permission when appropriate, and renders the configured widgets (bell, subscribe banner, install prompt) based on your dashboard settings.

### 3. Link subscriptions to your users (optional)

Call this after your user signs in:

```js
window.scaffoldPush?.identify('user-123')
```

This attaches the current browser subscription to a user ID, enabling `targetUserId` in `/notify`.

### 4. Add the PWA manifest to your `<head>`

```html
<!-- Web App Manifest — makes your app installable -->
<link rel="manifest" href="https://your-push-service.com/pwa/manifest.json?key=YOUR_API_KEY">

<!-- Theme color -->
<meta name="theme-color" content="#000000">

<!-- iOS / Safari — required for standalone installation (iOS ignores manifest.json) -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Your App Name">
<link rel="apple-touch-icon" href="https://your-push-service.com/pwa/icon/PROJECT_ID/192.png">
```

### 5. Create a service worker in your project

Place `sw.js` at your domain root (`public/sw.js`):

```js
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Notification', {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      image: data.image,
      data: { url: data.url },
      actions: data.actions,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  if (url) event.waitUntil(clients.openWindow(url));
});

// Handle push subscription key rotation
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const newSub = await self.registration.pushManager.subscribe(
      event.oldSubscription.options
    );
    await fetch('/api/push-resubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: newSub.endpoint,
        keys: newSub.toJSON().keys,
        oldEndpoint: event.oldSubscription?.endpoint,
      }),
    });
  })());
});
```

### 6. Send a notification from your backend

```js
const PUSH_URL = 'https://your-push-service.com';
const API_KEY  = 'your-project-api-key';

// Broadcast to all subscribers
await fetch(`${PUSH_URL}/notify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({ title: 'New post', body: 'Check it out', url: '/posts/123' }),
});

// Target a specific user
await fetch(`${PUSH_URL}/notify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({ title: 'Hey!', body: 'You have a reply', targetUserId: 'user-123' }),
});

// Schedule for later
await fetch(`${PUSH_URL}/notify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({
    title: 'Reminder',
    body: 'Your session starts in 15 minutes',
    scheduledAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
  }),
});
```

---

## Image Processing

All uploads are processed server-side with Sharp. No files are written to disk — everything is stored as base64 data URLs in PostgreSQL.

| Upload | Output | Storage |
|---|---|---|
| Logo (any format) | 192×192 PNG, 512×512 PNG, 96×96 PNG, multi-res .ico | 4 data URLs in projects row |
| Logo (SVG input) | Stored as-is + above raster sizes | 5 values |
| Screenshot | 900×1600 PNG | data URL in screenshots row |
| OG / SEO image | 1200×630 JPEG (quality 85) | data URL in projects row |

**File size limits:** 5 MB per upload, max 6 screenshots per project.

---

## Widgets

The widget script (`/widgets.js?key=API_KEY`) is a self-contained JS bundle that handles everything client-side. Configure which widgets to show from the **UI Components** tab in the dashboard.

| Widget | Description |
|---|---|
| **Bell** | Fixed bottom-right bell icon. Shows subscription status. Panel with subscribe/unsubscribe. Shows iOS guide when in browser (not standalone). |
| **Banner** | Top drop-down card prompting notification opt-in. Auto-hides after subscription. |
| **Install Prompt** | Bottom-right card. Respects `beforeinstallprompt`. Dismissible, state saved in localStorage. |
| **Install Banner** | Bottom sticky bar. Snoozable for 7 days. Shows platform-appropriate install instructions. |

All widgets support custom accent colors set in the dashboard. Colors, enabled state, and position are fetched from `/pwa/config?key=API_KEY` on load.

---

## Background Scheduler

A `setInterval` runs every 60 seconds and checks for due scheduled notifications:

1. Query `scheduled_notifications` where `status = 'pending'` AND `scheduled_at <= NOW()`
2. Mark each as `sent`
3. Fetch all subscriptions for the project
4. Send in parallel via web-push
5. Automatically remove subscriptions that return 404/410 (browser unsubscribed)
6. Write result to `notification_log`

---

## Self-Hosting

### Railway (recommended)

1. Fork this repository
2. Create a new Railway project from the repo
3. Add a PostgreSQL database (Neon or Railway's built-in Postgres)
4. Set all required environment variables in Railway's dashboard
5. Deploy — migrations run automatically on first start

### Manual / Docker

```bash
# Install dependencies
npm install

# Generate VAPID keys (run once, save output to .env)
npm run vapid:generate

# Configure environment
cp .env.example .env
# Edit .env with your values

# Development (with hot reload)
npm run dev

# Production build
npm run build
node dist/index.js
```

### `.env.example`

```env
DATABASE_URL=postgresql://user:password@host/dbname
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com
ADMIN_KEY=replace-with-a-long-random-string
JWT_SECRET=replace-with-a-different-long-random-string
PORT=3000
```

---

## Security

- **VAPID private key** — treat like a password. If leaked, rotate immediately (existing subscribers will need to re-subscribe).
- **ADMIN_KEY** — used as fallback for script/CLI access. Set `JWT_SECRET` separately in production so rotating the admin password does not invalidate it.
- **JWT tokens** — 30-day expiry, stored in `localStorage` in the browser dashboard. No refresh token mechanism — users re-login after expiry.
- **Subscriber endpoints** — stored in full in the database but only exposed as truncated hints through the admin API (`endpoint.slice(0,40)...`). Full endpoints are never returned to the dashboard UI.
- **Image data** — stored as base64 data URLs in PostgreSQL rows. No file system access required, no external storage credentials needed.
- **CORS** — set to `*` (required so your web apps on any domain can call `/subscribe`). Admin routes are protected by auth, not CORS.
- **Password hashing** — bcrypt with 10 rounds.

---

## Contributing

Pull requests are welcome. Please open an issue first for significant changes.

The admin dashboard intentionally has no frontend build step — it is a single `public/index.html` file with vanilla JS. This keeps the project simple to self-host, audit, and modify without a Node toolchain on the client.

---

## License

MIT
