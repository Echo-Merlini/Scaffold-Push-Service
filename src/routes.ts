import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireApiKey, requireAdminKey } from "./middleware/auth.js";
import {
  createProject, listProjects, deleteProject, updateProjectLogo,
  getProjectByApiKey, getProjectById, updateProjectPwa,
  addScreenshot, deleteScreenshot, getScreenshotsForProject, getScreenshotById,
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
    pwaUrl: z.string().url().nullable(),
    pwaDescription: z.string().nullable(),
  });
  const pwa = schema.parse(req.body);
  const project = await updateProjectPwa(req.params.id, pwa);
  res.json(project);
});

// Upload screenshot
router.post("/admin/projects/:id/screenshots", requireAdminKey,
  upload.single("screenshot"), async (req: any, res) => {
    if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }

    const project = await getProjectById(req.params.id);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }

    const existing = await getScreenshotsForProject(req.params.id);
    if (existing.length >= 6) { res.status(400).json({ error: "Max 6 screenshots per project" }); return; }

    if (req.file.size > 3 * 1024 * 1024) { res.status(400).json({ error: "Screenshot must be under 3MB" }); return; }

    // Get dimensions using sharp
    const { default: sharpLib } = await import("sharp");
    const meta = await sharpLib(req.file.buffer).metadata();
    const width  = meta.width  || 0;
    const height = meta.height || 0;
    const formFactor = width > height ? "wide" : "narrow";
    const mimeType = req.file.mimetype || "image/png";
    const dataUrl = `data:${mimeType};base64,${req.file.buffer.toString("base64")}`;

    const s = await addScreenshot({
      projectId: req.params.id,
      data: dataUrl,
      mimeType,
      width,
      height,
      formFactor,
      label: req.body.label || undefined,
    });
    res.status(201).json(s);
  }
);

// List screenshots for a project
router.get("/admin/projects/:id/screenshots", requireAdminKey, async (req, res) => {
  const shots = await getScreenshotsForProject(req.params.id);
  res.json(shots);
});

// Delete screenshot
router.delete("/admin/screenshots/:id", requireAdminKey, async (req, res) => {
  await deleteScreenshot(req.params.id);
  res.json({ ok: true });
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

  // start_url must be same-origin as the app, not the push service
  const appOrigin = (project as any).pwaUrl?.replace(/\/$/, "") || null;
  const startUrl = appOrigin ? `${appOrigin}/` : "/";
  const scope    = appOrigin ? `${appOrigin}/` : "/";

  const icons: object[] = [];
  if (project.logo) {
    icons.push({ src: `${base}/pwa/icon/${project.id}/192.png`, sizes: "192x192", type: "image/png", purpose: "any" });
  }
  if (project.logo512) {
    icons.push({ src: `${base}/pwa/icon/${project.id}/512.png`, sizes: "512x512", type: "image/png", purpose: "any" });
    icons.push({ src: `${base}/pwa/icon/${project.id}/512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" });
  }

  const appName  = project.pwaName      || project.name;
  const appShort = project.pwaShortName || project.name.slice(0, 12);

  const shots = await getScreenshotsForProject(project.id);
  const screenshotsArr = shots.map(s => ({
    src:         `${base}/pwa/screenshot/${s.id}.png`,
    sizes:       `${s.width}x${s.height}`,
    type:        s.mimeType,
    form_factor: s.formFactor,
    ...(s.label ? { label: s.label } : {}),
  }));

  const manifest: Record<string, unknown> = {
    id:               startUrl,
    name:             appName,
    short_name:       appShort,
    start_url:        startUrl,
    scope:            scope,
    display:          project.pwaDisplay    || "standalone",
    theme_color:      project.pwaThemeColor || "#000000",
    background_color: project.pwaBgColor    || "#ffffff",
    icons,
  };
  if (screenshotsArr.length) manifest.screenshots = screenshotsArr;

  res.setHeader("Content-Type", "application/manifest+json");
  res.json(manifest);
});

// Serve screenshot PNG
router.get("/pwa/screenshot/:id.png", async (req, res) => {
  const s = await getScreenshotById(req.params.id);
  if (!s) { res.status(404).end(); return; }
  const base64 = s.data.split(",")[1];
  if (!base64) { res.status(404).end(); return; }
  res.setHeader("Content-Type", s.mimeType);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(Buffer.from(base64, "base64"));
});

// Installation page — shareable app-store-style install page
router.get("/install/:projectId", async (req, res) => {
  const project = await getProjectById(req.params.projectId);
  if (!project) { res.status(404).send("App not found"); return; }

  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const base  = `${proto}://${req.get("host")}`;
  const icon  = project.logo512
    ? `${base}/pwa/icon/${project.id}/512.png`
    : project.logo ? `${base}/pwa/icon/${project.id}/192.png` : null;
  const shots = await getScreenshotsForProject(project.id);
  const appUrl   = (project as any).pwaUrl  || "#";
  const appName  = (project as any).pwaName || project.name;
  const appDesc  = (project as any).pwaDescription || "";
  const themeColor = (project as any).pwaThemeColor || "#000000";
  const bgColor    = (project as any).pwaBgColor    || "#ffffff";
  const manifestUrl = `${base}/pwa/manifest.json?key=${project.apiKey}`;

  const screenshotHtml = shots.map(s =>
    `<img src="${base}/pwa/screenshot/${s.id}.png" class="screenshot" alt="${s.label || appName} screenshot" />`
  ).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Install ${appName}</title>
  <link rel="manifest" href="${manifestUrl}">
  <meta name="theme-color" content="${themeColor}">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="${appName}">
  ${icon ? `<link rel="apple-touch-icon" href="${icon}">` : ""}
  <meta property="og:title" content="Install ${appName}"/>
  <meta property="og:description" content="${appDesc || `Add ${appName} to your home screen`}"/>
  ${icon ? `<meta property="og:image" content="${icon}"/>` : ""}
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,sans-serif;background:${bgColor};color:#111;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:2rem 1rem 4rem}
    .card{background:#fff;border-radius:20px;box-shadow:0 8px 40px rgba(0,0,0,.12);width:100%;max-width:480px;overflow:hidden}
    .hero{background:${themeColor};padding:2.5rem 2rem 1.5rem;display:flex;flex-direction:column;align-items:center;gap:1rem}
    .app-icon{width:96px;height:96px;border-radius:22px;box-shadow:0 4px 20px rgba(0,0,0,.3);object-fit:cover}
    .app-icon-placeholder{width:96px;height:96px;border-radius:22px;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:2.5rem}
    .app-name{font-size:1.5rem;font-weight:700;color:#fff;text-align:center}
    .app-url{font-size:.78rem;color:rgba(255,255,255,.65);text-align:center}
    .body{padding:1.5rem}
    .desc{font-size:.9rem;color:#444;line-height:1.6;margin-bottom:1.5rem}
    .screenshots{overflow-x:auto;display:flex;gap:.75rem;padding-bottom:.5rem;margin:0 -1.5rem 1.5rem;padding-left:1.5rem;padding-right:1.5rem;scrollbar-width:none}
    .screenshots::-webkit-scrollbar{display:none}
    .screenshot{height:220px;border-radius:12px;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,.12);object-fit:cover}
    .install-btn{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;padding:.9rem;background:${themeColor};color:#fff;border:none;border-radius:12px;font-size:1rem;font-weight:700;cursor:pointer;transition:opacity .15s;text-decoration:none}
    .install-btn:hover{opacity:.9}
    .ios-tip{display:none;margin-top:1rem;padding:.85rem 1rem;background:#f5f5f5;border-radius:10px;font-size:.8rem;color:#555;line-height:1.6;text-align:center}
    .open-btn{display:block;margin-top:.75rem;text-align:center;font-size:.82rem;color:#888;text-decoration:none}
    .powered{margin-top:2rem;font-size:.7rem;color:#bbb;text-align:center}
  </style>
</head>
<body>
  <div class="card">
    <div class="hero">
      ${icon ? `<img src="${icon}" class="app-icon" alt="${appName}"/>` : `<div class="app-icon-placeholder">📱</div>`}
      <div>
        <div class="app-name">${appName}</div>
        <div class="app-url">${appUrl.replace(/^https?:\/\//, "")}</div>
      </div>
    </div>
    <div class="body">
      ${appDesc ? `<p class="desc">${appDesc}</p>` : ""}
      ${shots.length ? `<div class="screenshots">${screenshotHtml}</div>` : ""}
      <button class="install-btn" id="install-btn" onclick="triggerInstall()">
        <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Add to Home Screen
      </button>
      <div class="ios-tip" id="ios-tip">
        Tap <strong>Share</strong> (the box with arrow) then <strong>Add to Home Screen</strong> in the menu.
      </div>
      <a class="open-btn" href="${appUrl}">Open in browser →</a>
    </div>
  </div>
  <div class="powered">Powered by Push Service</div>

  <script>
    var dp = null;
    var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
    var isInstalled = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;

    if (isInstalled) {
      document.getElementById('install-btn').textContent = 'Already installed ✓';
      document.getElementById('install-btn').disabled = true;
      document.getElementById('install-btn').style.opacity = '.5';
    } else if (isIos) {
      document.getElementById('ios-tip').style.display = 'block';
      document.getElementById('install-btn').innerHTML = '<span>Add to Home Screen</span>';
    }

    window.addEventListener('beforeinstallprompt', function(e) {
      e.preventDefault(); dp = e;
    });

    function triggerInstall() {
      if (dp) { dp.prompt(); dp.userChoice.then(function(r){ if(r.outcome==='accepted') window.location.href='${appUrl}'; }); }
      else if (isIos) { document.getElementById('ios-tip').style.display = 'block'; }
      else { window.location.href = '${appUrl}'; }
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function(){});
    }
  </script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(html);
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
