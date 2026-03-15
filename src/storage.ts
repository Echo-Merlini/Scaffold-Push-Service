import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./db.js";
import { projects, subscriptions, notificationLog, screenshots } from "./schema.js";

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

export async function getProjectById(id: string) {
  return db.query.projects.findFirst({ where: eq(projects.id, id) });
}

export async function updateProjectPwa(id: string, pwa: {
  pwaName?: string | null;
  pwaShortName?: string | null;
  pwaThemeColor?: string | null;
  pwaBgColor?: string | null;
  pwaDisplay?: string | null;
  pwaUrl?: string | null;
  pwaDescription?: string | null;
}) {
  const [updated] = await db
    .update(projects)
    .set(pwa)
    .where(eq(projects.id, id))
    .returning();
  return updated;
}

export async function listProjects() {
  return db.query.projects.findMany();
}

export async function deleteProject(id: string) {
  await db.delete(projects).where(eq(projects.id, id));
}

export async function updateProjectWidgets(id: string, widgetsConfig: string) {
  const [updated] = await db
    .update(projects)
    .set({ widgetsConfig })
    .where(eq(projects.id, id))
    .returning();
  return updated;
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

// --- Screenshots ---

export async function addScreenshot(data: {
  projectId: string;
  data: string;
  mimeType: string;
  width: number;
  height: number;
  formFactor: string;
  label?: string;
}) {
  const [s] = await db.insert(screenshots).values({ id: nanoid(), ...data }).returning();
  return s;
}

export async function deleteScreenshot(id: string) {
  await db.delete(screenshots).where(eq(screenshots.id, id));
}

export async function getScreenshotsForProject(projectId: string) {
  return db.query.screenshots.findMany({
    where: eq(screenshots.projectId, projectId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
}

export async function getScreenshotById(id: string) {
  return db.query.screenshots.findFirst({ where: eq(screenshots.id, id) });
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

export async function removeSubscriptionById(id: string) {
  await db.delete(subscriptions).where(eq(subscriptions.id, id));
}

export async function getSubscriptionsForProject(projectId: string) {
  return db.query.subscriptions.findMany({
    where: eq(subscriptions.projectId, projectId),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
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
