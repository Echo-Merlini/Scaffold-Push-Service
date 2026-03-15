import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireApiKey, requireAdminKey } from "./middleware/auth.js";
import {
  createProject, listProjects, deleteProject, updateProjectLogo,
  getProjectByApiKey, getProjectById, updateProjectPwa,
  upsertSubscription, removeSubscription, getSubscriptionsForProject,
  logNotification, getNotificationHistory,
} from "./storage.js";
import { sendToSubscription } from "./push.js";
import { processLogo } from "./image.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

// Set logo via URL
router.patch("/admin/projects/:id/logo", requireAdminKey, async (req, res) => {
  const { logo } = z.object({ logo: z.string().url().nullable() }).parse(req.body);
  const project = await updateProjectLogo(req.params.id, { logo, logo512: logo, logoBadge: logo });
  res.json(project);
});

// Upload logo image — resized to 192, 512, 96
router.post("/admin/projects/:id/logo/upload", requireAdminKey, upload.single("logo"), async (req: any, res) => {
  if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }

  try {
    const logos = await processLogo(req.file.buffer);
    const project = await updateProjectLogo(req.params.id, logos);
    res.json({ ok: true, logo: project.logo, logo512: project.logo512, logoBadge: project.logoBadge });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/admin/projects/:id", requireAdminKey, async (req, res) => {
  await deleteProject(req.params.id);
  res.json({ ok: true });
});

// Save PWA manifest config for a project
router.patch("/admin/projects/:id/pwa", requireAdminKey, async (req, res) => {
  const schema = z.object({
    pwaName: z.string().nullable(),
    pwaShortName: z.string().nullable(),
    pwaThemeColor: z.string().nullable(),
    pwaBgColor: z.string().nullable(),
    pwaDisplay: z.enum(["standalone", "fullscreen", "minimal-ui", "browser"]).nullable(),
  });
  const pwa = schema.parse(req.body);
  const project = await updateProjectPwa(req.params.id, pwa);
  res.json(project);
});

// ── PWA manifest + icons (public — browsers fetch these directly) ─────────────

// Serve web app manifest dynamically per project
router.get("/pwa/manifest.json", async (req, res) => {
  const key = req.query.key as string;
  if (!key) { res.status(400).json({ error: "key query param required" }); return; }

  const project = await getProjectByApiKey(key);
  if (!project) { res.status(404).json({ error: "project not found" }); return; }

  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const base = `${proto}://${req.get("host")}`;
  const icons: object[] = [];
  if (project.logo)    icons.push({ src: `${base}/pwa/icon/${project.id}/192.png`, sizes: "192x192", type: "image/png" });
  if (project.logo512) icons.push({ src: `${base}/pwa/icon/${project.id}/512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" });

  const manifest = {
    name:             project.pwaName       || project.name,
    short_name:       project.pwaShortName  || project.name.slice(0, 12),
    start_url:        "/",
    display:          project.pwaDisplay    || "standalone",
    theme_color:      project.pwaThemeColor || "#000000",
    background_color: project.pwaBgColor    || "#ffffff",
    icons,
  };

  res.setHeader("Content-Type", "application/manifest+json");
  res.json(manifest);
});

// Serve icon PNG decoded from stored base64 data URL
router.get("/pwa/icon/:projectId/:size.png", async (req, res) => {
  const project = await getProjectById(req.params.projectId);
  if (!project) { res.status(404).end(); return; }

  const size = req.params.size;
  const dataUrl = size === "512" ? project.logo512 : size === "96" ? project.logoBadge : project.logo;
  if (!dataUrl) { res.status(404).end(); return; }

  const base64 = dataUrl.split(",")[1];
  if (!base64) { res.status(404).end(); return; }

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(Buffer.from(base64, "base64"));
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
  icon: z.string().optional(),   // overrides project logo if provided
  badge: z.string().optional(),
  image: z.string().url().optional(),
});

router.post("/notify", requireApiKey, async (req, res) => {
  const project = (req as any).project;
  const payload = notifySchema.parse(req.body);

  // Auto-attach project logo as icon if not overridden
  const finalPayload = {
    ...payload,
    icon: payload.icon ?? project.logo ?? undefined,
  };

  const subs = await getSubscriptionsForProject(project.id);
  if (subs.length === 0) {
    res.json({ sent: 0, failed: 0, expired: 0 });
    return;
  }

  const results = await Promise.all(
    subs.map((sub) => sendToSubscription(sub, finalPayload))
  );

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.length - successCount;

  const expired = subs.filter((_, i) => results[i].expired);
  await Promise.all(expired.map((s) => removeSubscription(s.endpoint)));

  await logNotification({
    projectId: project.id,
    title: payload.title,
    body: payload.body,
    url: payload.url,
    image: payload.image,
    successCount,
    failureCount,
  });

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
