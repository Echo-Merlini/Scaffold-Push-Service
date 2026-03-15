import { pgTable, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";

// A project = one of your web apps that uses this push service
export const projects = pgTable("projects", {
  id: text("id").primaryKey(),           // nanoid
  name: text("name").notNull(),
  apiKey: text("api_key").notNull().unique(),
  logo: text("logo"),                    // URL — auto-used as icon in notifications
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
