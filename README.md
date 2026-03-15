# Push Service

Self-hosted web push notification service. Connect multiple web projects to one central push server.

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

### 4. Push database schema
```bash
npm run db:push
```

### 5. Start dev server
```bash
npm run dev
```

---

## API Reference

### Admin (use x-admin-key header)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/projects` | List all projects |
| POST | `/admin/projects` | Create a project → returns `{ id, apiKey }` |
| DELETE | `/admin/projects/:id` | Delete a project and all its subscriptions |

### Project (use x-api-key header)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/vapid-public-key` | Get VAPID public key for client-side subscription |
| POST | `/subscribe` | Register a push subscription |
| POST | `/unsubscribe` | Remove a push subscription |
| POST | `/notify` | Send notification to all subscribers |
| GET | `/subscribers` | Get subscriber count |
| GET | `/history` | Get last 100 notifications sent |

### POST /subscribe body
```json
{
  "endpoint": "https://fcm.googleapis.com/...",
  "keys": {
    "p256dh": "...",
    "auth": "..."
  }
}
```

### POST /notify body
```json
{
  "title": "New post",
  "body": "Someone posted in the community",
  "url": "https://yourapp.com/posts/123",
  "icon": "https://yourapp.com/icon.png"
}
```

---

## Connecting a web project (client-side snippet)

```js
const PUSH_SERVICE_URL = "https://your-push-service.com";
const PUSH_API_KEY = "your-project-api-key";

// 1. Get VAPID public key
const { publicKey } = await fetch(`${PUSH_SERVICE_URL}/vapid-public-key`).then(r => r.json());

// 2. Register service worker
const reg = await navigator.serviceWorker.register("/sw.js");

// 3. Subscribe
const sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: publicKey,
});

// 4. Send subscription to push service
await fetch(`${PUSH_SERVICE_URL}/subscribe`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": PUSH_API_KEY },
  body: JSON.stringify(sub.toJSON()),
});
```

## Service worker (public/sw.js in your web project)

```js
self.addEventListener("push", (event) => {
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
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
