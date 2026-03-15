import { pgTable, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";

// A project = one of your web apps that uses this push service
export const projects = pgTable("projects", {
  id: text("id").primaryKey(),           // nanoid
  name: text("name").notNull(),
  apiKey: text("api_key").notNull().unique(),
  logo: text("logo"),                    // 192×192 data URL — auto-used as notification icon
  logo512: text("logo_512"),             // 512×512 data URL — PWA app icon
  logoBadge: text("logo_badge"),         // 96×96 data URL — Android badge
  // PWA manifest config — served at /pwa/manifest.json?key=API_KEY
  pwaName: text("pwa_name"),
  pwaShortName: text("pwa_short_name"),
  pwaThemeColor: text("pwa_theme_color"),
  pwaBgColor: text("pwa_bg_color"),
  pwaDisplay: text("pwa_display"),       // standalone | fullscreen | minimal-ui | browser
  pwaUrl: text("pwa_url"),              // production URL e.g. https://myapp.com
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// One subscription = one browser/device that opted in for a project
export const subscriptions = pgTable("subscriptions", {
  id: text("id").primaryKey(),           // nanoid
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),      // browser public key
  auth: text("auth").notNull(),          // browser auth secret
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Log of every notification sent
export const notificationLog = pgTable("notification_log", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  url: text("url"),
  image: text("image"),                  // large image in notification body
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
});
