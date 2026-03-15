import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./db.js";
import { projects, subscriptions, notificationLog } from "./schema.js";

// --- Projects ---

export async function createProject(name: string) {
  const id = nanoid();
  const apiKey = nanoid(32);
  const [project] = await db.insert(projects).values({ id, name, apiKey }).returning();
  return project;
}

export async function getProjectByApiKey(apiKey: string) {
  return db.query.projects.findFirst({ where: eq(projects.apiKey, apiKey) });
}

export async function listProjects() {
  return db.query.projects.findMany();
}

export async function deleteProject(id: string) {
  await db.delete(projects).where(eq(projects.id, id));
}

export async function updateProjectLogo(id: string, logos: {
  logo: string | null;
  logo512?: string | null;
  logoBadge?: string | null;
}) {
  const [updated] = await db
    .update(projects)
    .set(logos)
    .where(eq(projects.id, id))
    .returning();
  return updated;
}

// --- Subscriptions ---

export async function upsertSubscription(data: {
  projectId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}) {
  const existing = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.endpoint, data.endpoint),
  });

  if (existing) {
    const [updated] = await db
      .update(subscriptions)
      .set({ p256dh: data.p256dh, auth: data.auth })
      .where(eq(subscriptions.endpoint, data.endpoint))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(subscriptions)
    .values({ id: nanoid(), ...data })
    .returning();
  return created;
}

export async function removeSubscription(endpoint: string) {
  await db.delete(subscriptions).where(eq(subscriptions.endpoint, endpoint));
}

export async function getSubscriptionsForProject(projectId: string) {
  return db.query.subscriptions.findMany({
    where: eq(subscriptions.projectId, projectId),
  });
}

// --- Notification log ---

export async function logNotification(data: {
  projectId: string;
  title: string;
  body: string;
  url?: string;
  image?: string;
  successCount: number;
  failureCount: number;
}) {
  await db.insert(notificationLog).values({ id: nanoid(), ...data });
}

export async function getNotificationHistory(projectId: string) {
  return db.query.notificationLog.findMany({
    where: eq(notificationLog.projectId, projectId),
    orderBy: (t, { desc }) => [desc(t.sentAt)],
    limit: 100,
  });
}
