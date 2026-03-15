import { Router } from "express";
import { z } from "zod";
import { requireApiKey, requireAdminKey } from "./middleware/auth.js";
import {
  createProject, listProjects, deleteProject,
  upsertSubscription, removeSubscription, getSubscriptionsForProject,
  logNotification, getNotificationHistory,
} from "./storage.js";
import { sendToSubscription } from "./push.js";

export const router = Router();

// ── Health ────────────────────────────────────────────────────────────────────

router.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ── VAPID public key (clients need this to subscribe) ─────────────────────────

router.get("/vapid-public-key", (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ── Admin: project management ─────────────────────────────────────────────────

router.get("/admin/projects", requireAdminKey, async (_req, res) => {
  const all = await listProjects();
  res.json(all);
});

router.post("/admin/projects", requireAdminKey, async (req, res) => {
  const { name } = z.object({ name: z.string().min(1) }).parse(req.body);
  const project = await createProject(name);
  res.status(201).json(project);
});

router.delete("/admin/projects/:id", requireAdminKey, async (req, res) => {
  await deleteProject(req.params.id);
  res.json({ ok: true });
});

// ── Subscriptions (called from client-side of your web apps) ──────────────────

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});

router.post("/subscribe", requireApiKey, async (req, res) => {
  const project = (req as any).project;
  const { endpoint, keys } = subscribeSchema.parse(req.body);

  const sub = await upsertSubscription({
    projectId: project.id,
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userAgent: req.headers["user-agent"],
  });

  res.status(201).json({ id: sub.id });
});

router.post("/unsubscribe", requireApiKey, async (req, res) => {
  const { endpoint } = z.object({ endpoint: z.string().url() }).parse(req.body);
  await removeSubscription(endpoint);
  res.json({ ok: true });
});

// ── Send notification ─────────────────────────────────────────────────────────

const notifySchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  url: z.string().url().optional(),
  icon: z.string().optional(),
  badge: z.string().optional(),
});

router.post("/notify", requireApiKey, async (req, res) => {
  const project = (req as any).project;
  const payload = notifySchema.parse(req.body);

  const subs = await getSubscriptionsForProject(project.id);
  if (subs.length === 0) {
    res.json({ sent: 0, failed: 0 });
    return;
  }

  const results = await Promise.all(
    subs.map((sub) => sendToSubscription(sub, payload))
  );

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.length - successCount;

  // Remove expired subscriptions
  const expired = subs.filter((_, i) => results[i].expired);
  await Promise.all(expired.map((s) => removeSubscription(s.endpoint)));

  await logNotification({ projectId: project.id, ...payload, successCount, failureCount });

  res.json({ sent: successCount, failed: failureCount, expired: expired.length });
});

// ── Notification history ──────────────────────────────────────────────────────

router.get("/history", requireApiKey, async (req, res) => {
  const project = (req as any).project;
  const history = await getNotificationHistory(project.id);
  res.json(history);
});

// ── Subscriber count ──────────────────────────────────────────────────────────

router.get("/subscribers", requireApiKey, async (req, res) => {
  const project = (req as any).project;
  const subs = await getSubscriptionsForProject(project.id);
  res.json({ count: subs.length });
});
