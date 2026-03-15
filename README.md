# Push Service

Self-hosted web push notification service + PWA hosting. Connect multiple web projects to one central push server, generate dynamic web app manifests, and get shareable app-store-style install pages — no config files to manage.

## Features

- **Push notifications** — send to all subscribers of a project with one API call
- **Dynamic PWA manifests** — hosted at `/pwa/manifest.json?key=API_KEY`, auto-includes icons and screenshots
- **Icon hosting** — upload once in the dashboard, served as real PNG at `/pwa/icon/:projectId/:size.png`
- **Screenshots** — upload up to 6 per project; form_factor auto-detected from dimensions
- **Install page** — shareable app-store-style page at `/install/:projectId`
- **Drop-in UI widgets** — bell widget, subscribe banner, PWA install prompt, service worker

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Generate VAPID keys (one time only)
```bash
npm run vapid:generate
```
Copy the output into your `.env` file.

### 3. Configure environment
```bash
cp .env.example .env
# Fill in DATABASE_URL, VAPID keys, ADMIN_KEY
```

### 4. Start dev server
```bash
npm run dev
```

> **DB migrations run automatically on startup** — no `db:push` needed after the first deploy.

---

## API Reference

### Admin endpoints (`x-admin-key` header required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/projects` | List all projects |
| POST | `/admin/projects` | Create a project → returns `{ id, apiKey }` |
| DELETE | `/admin/projects/:id` | Delete a project and all its data |
| PATCH | `/admin/projects/:id/logo` | Set logo via URL |
| POST | `/admin/projects/:id/logo/upload` | Upload logo image (multipart) — auto-resized to 192, 512, 96px |
| PATCH | `/admin/projects/:id/pwa` | Save PWA manifest config |
| GET | `/admin/projects/:id/screenshots` | List screenshots for a project |
| POST | `/admin/projects/:id/screenshots` | Upload a screenshot (multipart) — form_factor auto-detected |
| DELETE | `/admin/screenshots/:id` | Delete a screenshot |

### Project endpoints (`x-api-key` header required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/vapid-public-key` | Get VAPID public key for client-side subscription |
| POST | `/subscribe` | Register a push subscription |
| POST | `/unsubscribe` | Remove a push subscription |
| POST | `/notify` | Send notification to all subscribers |
| GET | `/subscribers` | Get subscriber count |
| GET | `/history` | Get last 100 notifications sent |

### Public endpoints (no auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pwa/manifest.json?key=API_KEY` | Dynamic web app manifest |
| GET | `/pwa/icon/:projectId/:size.png` | App icon PNG (192, 512, or 96) |
| GET | `/pwa/screenshot/:id.png` | Screenshot PNG |
| GET | `/install/:projectId` | Shareable install page |

---

## PWA Integration

### 1. Configure in the dashboard

Open the **PWA Setup** tab, select your project, and fill in:
- App URL (your production origin — sets `start_url` and `scope` correctly)
- Name, short name, theme color, background color, display mode, description
- Upload screenshots (landscape → `form_factor: wide`, portrait → `narrow`)

### 2. Add to your site's `<head>`

```html
<!-- PWA manifest — makes your app installable -->
<link rel="manifest" href="https://your-push-service.com/pwa/manifest.json?key=YOUR_API_KEY">

<!-- Theme color for browser toolbar -->
<meta name="theme-color" content="#000000">

<!-- iOS / Safari PWA support -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Your App">
<link rel="apple-touch-icon" href="https://your-push-service.com/pwa/icon/PROJECT_ID/192.png">
```

If your site has a Content Security Policy, allow the manifest:
```
manifest-src 'self' https://your-push-service.com;
```

### 3. Share the install page

```
https://your-push-service.com/install/PROJECT_ID
```

Displays app icon, description, screenshots carousel, and an "Add to Home Screen" button. Works on Android (Chrome install prompt) and iOS (Share → Add to Home Screen tip).

---

## Push Notifications

### Client-side subscription

```js
const PUSH_URL = "https://your-push-service.com";
const API_KEY  = "your-project-api-key";

// 1. Get VAPID public key
const { publicKey } = await fetch(`${PUSH_URL}/vapid-public-key`).then(r => r.json());

// 2. Register service worker
const reg = await navigator.serviceWorker.register("/sw.js");

// 3. Subscribe
const sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: publicKey,
});

// 4. Send subscription to push service
await fetch(`${PUSH_URL}/subscribe`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
  body: JSON.stringify(sub.toJSON()),
});
```

### POST /notify body

```json
{
  "title": "New post",
  "body": "Someone posted in the community",
  "url": "https://yourapp.com/posts/123",
  "image": "https://yourapp.com/og.png"
}
```

The project logo is automatically used as the notification icon if none is provided.

### Service worker (`public/sw.js` in your web project)

```js
self.addEventListener("push", (event) => {
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      image: data.image,
      data: { url: data.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.notification.data?.url) {
    clients.openWindow(event.notification.data.url);
  }
});
```

---

## Deploy

Works on Railway, Fly.io, Render, or any Node host. Set the same env vars as `.env.example`.

On Railway, SSL is terminated at the load balancer — the service reads `x-forwarded-proto` automatically so manifest icon URLs always use `https://`.
