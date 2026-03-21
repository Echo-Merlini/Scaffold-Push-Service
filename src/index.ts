import "dotenv/config";
import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { db } from "./db.js";
import { initWebPush } from "./push.js";
import { router } from "./routes.js";
import { getDueScheduledNotifications, markScheduledNotificationSent, getSubscriptionsForProject, removeSubscription, logNotification } from "./storage.js";
import { sendToSubscription } from "./push.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Add new columns without breaking existing deployments
async function runMigrations() {
  await db.execute(sql`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS logo_ico TEXT,
      ADD COLUMN IF NOT EXISTS logo_svg TEXT
  `);
  await db.execute(sql`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS pwa_name TEXT,
      ADD COLUMN IF NOT EXISTS pwa_short_name TEXT,
      ADD COLUMN IF NOT EXISTS pwa_theme_color TEXT,
      ADD COLUMN IF NOT EXISTS pwa_bg_color TEXT,
      ADD COLUMN IF NOT EXISTS pwa_display TEXT,
      ADD COLUMN IF NOT EXISTS pwa_url TEXT,
      ADD COLUMN IF NOT EXISTS pwa_description TEXT,
      ADD COLUMN IF NOT EXISTS pwa_youtube_url TEXT,
      ADD COLUMN IF NOT EXISTS install_slug TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS widgets_config TEXT DEFAULT '{}'
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS screenshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      form_factor TEXT NOT NULL DEFAULT 'narrow',
      label TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);
  await db.execute(sql`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS user_id TEXT
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS scheduled_notifications (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      url TEXT,
      image TEXT,
      icon TEXT,
      actions TEXT,
      scheduled_at TIMESTAMP NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);
}

await runMigrations();
initWebPush();

// Background scheduler — fires due scheduled notifications every 60 seconds
setInterval(async () => {
  try {
    const due = await getDueScheduledNotifications();
    for (const sn of due) {
      await markScheduledNotificationSent(sn.id);
      const subs = await getSubscriptionsForProject(sn.projectId);
      if (!subs.length) continue;
      const payload: any = { title: sn.title, body: sn.body };
      if (sn.url)     payload.url     = sn.url;
      if (sn.image)   payload.image   = sn.image;
      if (sn.icon)    payload.icon    = sn.icon;
      if (sn.actions) payload.actions = JSON.parse(sn.actions);
      let sent = 0, failed = 0;
      const expired: string[] = [];
      await Promise.all(subs.map(async (sub) => {
        const r = await sendToSubscription(sub, payload);
        if (r.success) { sent++; }
        else { failed++; if (r.expired) expired.push(sub.endpoint); }
      }));
      for (const ep of expired) await removeSubscription(ep);
      await logNotification({ projectId: sn.projectId, title: sn.title, body: sn.body, url: sn.url || undefined, image: sn.image || undefined, successCount: sent, failureCount: failed });
    }
  } catch (e) { console.error("[scheduler]", e); }
}, 60_000);

const app = express();
app.use(express.json());

// Allow cross-origin requests from your web projects
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, x-admin-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

app.use(express.static(join(__dirname, "../public")));
app.use("/", router);

// Global error handler — catches any unhandled error thrown in route handlers
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("[unhandled error]", err);
  const status = err?.status ?? err?.statusCode ?? 500;
  res.status(status).json({ error: err?.message ?? "Internal server error" });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Push service running on port ${port}`);
});
