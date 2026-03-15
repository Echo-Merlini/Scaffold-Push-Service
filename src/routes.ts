import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireApiKey, requireAdminKey } from "./middleware/auth.js";
import {
  createProject, listProjects, deleteProject, updateProjectLogo,
  getProjectByApiKey, getProjectById, updateProjectPwa, updateProjectWidgets,
  addScreenshot, deleteScreenshot, getScreenshotsForProject, getScreenshotById,
  upsertSubscription, removeSubscription, removeSubscriptionById, getSubscriptionsForProject,
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
    res.json({ ok: true, logo: project.logo, logo512: project.logo512, logoBadge: project.logoBadge, logoIco: !!(project as any).logoIco, logoSvg: !!(project as any).logoSvg });
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

// Save widget enable/disable settings
router.patch("/admin/projects/:id/widgets", requireAdminKey, async (req, res) => {
  const schema = z.object({
    bell:          z.boolean(),
    banner:        z.boolean(),
    install:       z.boolean(),
    installBanner: z.boolean().optional(),
  });
  const cfg = schema.parse(req.body);
  const project = await updateProjectWidgets(req.params.id, JSON.stringify(cfg));
  res.json(project);
});

// Public — widget config fetched by client apps
router.get("/pwa/config", async (req, res) => {
  const key = req.query.key as string;
  if (!key) { res.status(400).json({ error: "key required" }); return; }
  const project = await getProjectByApiKey(key);
  if (!project) { res.status(404).json({ error: "project not found" }); return; }
  const defaults = { bell: true, banner: true, install: true };
  try {
    const parsed = JSON.parse((project as any).widgetsConfig || "{}");
    res.json({ ...defaults, ...parsed });
  } catch {
    res.json(defaults);
  }
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

// List subscribers for a project (admin view — returns safe subset of fields)
router.get("/admin/projects/:id/subscribers", requireAdminKey, async (req, res) => {
  const subs = await getSubscriptionsForProject(req.params.id);
  res.json(subs.map(s => ({
    id: s.id,
    endpointHint: s.endpoint.slice(-12),   // last 12 chars to identify without exposing full URL
    userAgent: s.userAgent || null,
    createdAt: s.createdAt,
  })));
});

// Remove a subscriber by ID (admin)
router.delete("/admin/subscribers/:id", requireAdminKey, async (req, res) => {
  await removeSubscriptionById(req.params.id);
  res.json({ ok: true });
});

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

// ── Hosted widget script (include with one <script> tag) ─────────────────────

router.get("/widgets.js", async (req, res) => {
  const key = req.query.key as string;
  if (!key) { res.status(400).send("// key query param required"); return; }

  const project = await getProjectByApiKey(key);
  if (!project) { res.status(404).send("// project not found"); return; }

  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const base  = `${proto}://${req.get("host")}`;
  const defaults = { bell: true, banner: false, install: true, installBanner: false };
  let widgetCfg = defaults;
  try { widgetCfg = { ...defaults, ...JSON.parse((project as any).widgetsConfig || "{}") }; } catch {}

  const themeColor = project.pwaThemeColor || "#16a34a";
  const iconUrl    = project.logo ? `${base}/pwa/icon/${project.id}/192.png` : null;
  const appName    = (project.pwaName || project.name).replace(/'/g, "\\'");
  const installUrl = `${base}/install/${project.id}`;

  const js = `/* Push Service Widgets — ${project.name} */
(function(){
  var PUSH='${base}';
  var KEY='${key}';
  var THEME='${themeColor}';
  var ICON=${iconUrl ? `'${iconUrl}'` : 'null'};
  var APP_NAME='${appName}';
  var INSTALL_URL='${installUrl}';
  var CFG=${JSON.stringify(widgetCfg)};
  var DISMISSED_INSTALL='_pws_install_dismissed';
  var dp=null;

  /* ── Helpers ── */
  function urlB64(b){
    var p='='.repeat((4-b.length%4)%4);
    var s=(b+p).replace(/-/g,'+').replace(/_/g,'/');
    var r=atob(s);
    return Uint8Array.from([].slice.call(r).map(function(c){return c.charCodeAt(0);}));
  }

  function css(el,styles){Object.assign(el.style,styles);}

  function mkEl(tag,attrs,styles){
    var el=document.createElement(tag);
    if(attrs)Object.assign(el,attrs);
    if(styles)css(el,styles);
    return el;
  }

  /* ── Service Worker ── */
  function registerSW(){
    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('/sw.js').catch(function(){});
    }
  }

  /* ── Subscribe ── */
  async function subscribe(){
    if(!('serviceWorker' in navigator && 'PushManager' in window))return false;
    try{
      var reg=await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      var ex=await reg.pushManager.getSubscription();
      if(ex)await ex.unsubscribe();
      var vr=await fetch(PUSH+'/vapid-public-key');
      var vj=await vr.json();
      var sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64(vj.publicKey)});
      await fetch(PUSH+'/subscribe',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':KEY},body:JSON.stringify(sub.toJSON())});
      return true;
    }catch(e){return false;}
  }

  async function unsubscribe(){
    try{
      var reg=await navigator.serviceWorker.getRegistration('/sw.js');
      if(!reg)return false;
      var sub=await reg.pushManager.getSubscription();
      if(!sub)return false;
      await fetch(PUSH+'/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':KEY},body:JSON.stringify({endpoint:sub.endpoint})});
      await sub.unsubscribe();
      return true;
    }catch(e){return false;}
  }

  async function isSubscribed(){
    try{
      var reg=await navigator.serviceWorker.getRegistration('/sw.js');
      if(!reg)return false;
      return !!(await reg.pushManager.getSubscription());
    }catch(e){return false;}
  }

  /* ── Bell Widget ── */
  function mountBell(){
    // navigator.vendor is "Apple Computer, Inc." on all Safari versions (stable across iOS versions)
    // maxTouchPoints>0 distinguishes iPhone/iPad from Mac (Macs always return 0)
    var isAppleMobile=(/apple/i.test(navigator.vendor))&&navigator.maxTouchPoints>0;
    var isStandalone=!!(window.navigator.standalone)||window.matchMedia('(display-mode:standalone)').matches;
    var pushSupported='serviceWorker' in navigator&&'PushManager' in window;

    // Show on Apple touch devices (to guide install) or any browser with push support
    if(!pushSupported&&!isAppleMobile)return;

    var wrap=mkEl('div',null,{position:'fixed',bottom:'24px',right:'24px',zIndex:'999999',display:'flex',flexDirection:'column',alignItems:'flex-end',gap:'8px',fontFamily:'system-ui,-apple-system,sans-serif'});

    var panel=mkEl('div',null,{display:'none',background:'#111',border:'1px solid #333',borderRadius:'16px',boxShadow:'0 8px 32px rgba(0,0,0,.5)',padding:'16px',width:'280px',color:'#e5e5e5',fontSize:'13px'});

    var panelHead=mkEl('div',null,{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'12px'});
    var panelTitle=mkEl('span',{textContent:'Push Notifications'},{fontWeight:'600',fontSize:'14px'});
    var closeBtn=mkEl('button',{textContent:'✕'},{background:'none',border:'none',color:'#888',cursor:'pointer',fontSize:'14px',lineHeight:'1',padding:'0'});
    closeBtn.onclick=function(){panel.style.display='none';};
    panelHead.append(panelTitle,closeBtn);

    var panelBody=mkEl('div');
    panel.append(panelHead,panelBody);

    var btn=mkEl('button',null,{width:'48px',height:'48px',borderRadius:'50%',border:'none',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',boxShadow:'0 4px 12px rgba(0,0,0,.4)',transition:'transform .15s',background:'#1a1a1a',color:'#aaa',fontSize:'20px'});
    btn.innerHTML='&#x1F515;';
    btn.onmouseenter=function(){btn.style.transform='scale(1.1)';};
    btn.onmouseleave=function(){btn.style.transform='scale(1)';};

    // Apple mobile in browser — push requires installed PWA, show install instructions
    if(isAppleMobile && !isStandalone){
      btn.onclick=function(){panel.style.display=panel.style.display==='none'?'flex':'none';};
      panel.style.flexDirection='column';
      panelBody.innerHTML=
        '<p style="color:#aaa;font-size:12px;margin-bottom:10px;line-height:1.5">To receive push notifications on iOS, install this app to your Home Screen first.</p>'+
        '<ol style="color:#888;font-size:11px;line-height:1.8;padding-left:1.1rem;margin-bottom:10px">'+
        '<li>Tap the <strong style="color:#aaa">Share</strong> button (&#x2B06; box with arrow) in Safari</li>'+
        '<li>Tap <strong style="color:#aaa">Add to Home Screen</strong></li>'+
        '<li>Open the app from your Home Screen</li>'+
        '<li>Tap the bell to enable notifications</li>'+
        '</ol>'+
        '<p style="color:#555;font-size:11px">Requires iOS 16.4 or later.</p>';
      wrap.append(panel,btn);
      document.body.append(wrap);
      return;
    }

    if(!pushSupported)return;

    var subbed=false;

    function refresh(s){
      subbed=s;
      if(s){
        btn.style.background=THEME;
        btn.style.color='#fff';
        btn.innerHTML='&#x1F514;';
        btn.title='Manage notifications';
        panelBody.innerHTML='<div style="background:#0d2a17;border-radius:8px;padding:10px;color:#4ade80;font-size:12px;margin-bottom:10px">&#x2713; You are subscribed to notifications.</div>';
        var ub=mkEl('button',{textContent:'Unsubscribe'},{width:'100%',background:'none',border:'1px solid #333',borderRadius:'8px',color:'#888',padding:'8px',cursor:'pointer',fontSize:'12px'});
        ub.onclick=async function(){ub.disabled=true;ub.textContent='...';var ok=await unsubscribe();refresh(false);if(ok)ub.textContent='Done';};
        panelBody.append(ub);
      } else {
        btn.style.background='#1a1a1a';
        btn.style.color='#aaa';
        btn.innerHTML='&#x1F515;';
        btn.title='Enable notifications';
        panelBody.innerHTML='<p style="color:#888;font-size:12px;margin-bottom:12px">Get notified about new posts and community updates — even when you\\'re away.</p>';
        var sb=mkEl('button',{textContent:'Enable notifications'},{width:'100%',background:THEME,border:'none',borderRadius:'10px',color:'#fff',padding:'10px',cursor:'pointer',fontWeight:'600',fontSize:'13px'});
        sb.onclick=async function(){
          sb.disabled=true;sb.textContent='...';
          var perm=await Notification.requestPermission();
          if(perm!=='granted'){sb.textContent='Blocked — check browser settings';return;}
          var ok=await subscribe();
          refresh(ok);
        };
        panelBody.append(sb);
      }
    }

    btn.onclick=function(){panel.style.display=panel.style.display==='none'?'flex':'none';};
    panel.style.flexDirection='column';

    isSubscribed().then(refresh);
    wrap.append(panel,btn);
    document.body.append(wrap);
  }

  /* ── Install Prompt ── */
  function mountInstall(){
    if(localStorage.getItem(DISMISSED_INSTALL))return;

    var card=mkEl('div',null,{display:'none',position:'fixed',bottom:'88px',right:'24px',zIndex:'999998',width:'280px',background:'#111',border:'1px solid #333',borderRadius:'16px',boxShadow:'0 8px 32px rgba(0,0,0,.5)',padding:'16px',fontFamily:'system-ui,-apple-system,sans-serif',color:'#e5e5e5',fontSize:'13px'});

    function dismiss(){localStorage.setItem(DISMISSED_INSTALL,'1');card.remove();}

    var head=mkEl('div',null,{display:'flex',alignItems:'center',gap:'10px',marginBottom:'12px'});
    var iconWrap=mkEl('div',null,{width:'36px',height:'36px',borderRadius:'8px',background:'#1a0a30',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:'0'});
    if(ICON){var ic=mkEl('img',{src:ICON},{width:'28px',height:'28px',borderRadius:'6px',objectFit:'cover'});iconWrap.append(ic);}
    else{iconWrap.textContent='📲';}
    var titleEl=mkEl('span',{textContent:'Install App'},{fontWeight:'600',fontSize:'14px'});
    var xBtn=mkEl('button',{textContent:'✕'},{marginLeft:'auto',background:'none',border:'none',color:'#888',cursor:'pointer',fontSize:'14px',lineHeight:'1'});
    xBtn.onclick=dismiss;
    head.append(iconWrap,titleEl,xBtn);

    var desc=mkEl('p',{textContent:'Add to your home screen for a faster, app-like experience.'},{color:'#888',fontSize:'12px',marginBottom:'12px',lineHeight:'1.5'});

    var row=mkEl('div',null,{display:'flex',gap:'8px'});
    var instBtn=mkEl('button',{textContent:'Install'},{flex:'1',background:THEME,border:'none',borderRadius:'10px',color:'#fff',padding:'9px',cursor:'pointer',fontWeight:'600',fontSize:'13px'});
    var notNow=mkEl('button',{textContent:'Not now'},{background:'none',border:'none',color:'#666',cursor:'pointer',fontSize:'12px',padding:'9px 4px'});
    notNow.onclick=dismiss;
    row.append(instBtn,notNow);
    card.append(head,desc,row);
    document.body.append(card);

    window.addEventListener('beforeinstallprompt',function(e){
      e.preventDefault();dp=e;
      card.style.display='block';
    });

    instBtn.onclick=async function(){
      if(!dp)return;
      instBtn.disabled=true;
      await dp.prompt();
      var r=await dp.userChoice;
      if(r.outcome==='accepted')card.remove();
      else dismiss();
    };
  }

  /* ── Installation Banner ── */
  function mountInstallBanner(){
    var DISMISSED_BANNER='_pws_ibanner';
    var isAppleMobile=(/apple/i.test(navigator.vendor))&&navigator.maxTouchPoints>0;
    var isStandalone=!!window.navigator.standalone||window.matchMedia('(display-mode:standalone)').matches;
    if(isStandalone)return; // already installed
    var last=localStorage.getItem(DISMISSED_BANNER);
    if(last&&Date.now()-parseInt(last)<7*24*60*60*1000)return; // snoozed for 7 days

    var banner=mkEl('div',null,{position:'fixed',bottom:'0',left:'0',right:'0',zIndex:'999997',
      background:'#111',borderTop:'1px solid #222',display:'flex',alignItems:'center',
      gap:'10px',padding:'10px 14px',fontFamily:'system-ui,-apple-system,sans-serif',
      transform:'translateY(100%)',transition:'transform .35s cubic-bezier(.4,0,.2,1)'});

    function dismiss(){localStorage.setItem(DISMISSED_BANNER,Date.now().toString());banner.remove();}

    if(ICON){var ic=mkEl('img',{src:ICON},{width:'40px',height:'40px',borderRadius:'10px',objectFit:'cover',flexShrink:'0'});}
    else{var ic=mkEl('div',{textContent:'📲'},{fontSize:'28px',flexShrink:'0'});}

    var info=mkEl('div',null,{flex:'1',minWidth:'0'});
    var nm=mkEl('div',{textContent:APP_NAME},{fontWeight:'700',fontSize:'13px',color:'#fff',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'});
    var sub=mkEl('div',{textContent:isAppleMobile?'Tap to install on your Home Screen':'Install for the best experience'},{fontSize:'11px',color:'#888',marginTop:'2px'});
    info.append(nm,sub);

    var instBtn=mkEl('button',{textContent:'Install'},{background:THEME,border:'none',borderRadius:'10px',
      color:'#fff',padding:'8px 16px',cursor:'pointer',fontWeight:'700',fontSize:'13px',flexShrink:'0',
      whiteSpace:'nowrap'});
    var xBtn=mkEl('button',{textContent:'✕'},{background:'none',border:'none',color:'#555',
      cursor:'pointer',fontSize:'16px',padding:'4px',flexShrink:'0',lineHeight:'1'});
    xBtn.onclick=dismiss;

    banner.append(ic,info,instBtn,xBtn);
    document.body.append(banner);
    requestAnimationFrame(function(){requestAnimationFrame(function(){banner.style.transform='translateY(0)';});});

    var deferred=null;
    window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();deferred=e;});

    instBtn.onclick=async function(){
      if(deferred){
        instBtn.disabled=true;
        await deferred.prompt();
        var r=await deferred.userChoice;
        if(r.outcome==='accepted'){banner.remove();return;}
        dismiss();
      }else if(isAppleMobile){
        window.location.href=INSTALL_URL;
      }else{
        window.location.href=INSTALL_URL;
      }
    };
  }

  /* ── Init ── */
  document.addEventListener('DOMContentLoaded',function(){
    registerSW();
    if(CFG.bell)mountBell();
    if(CFG.install)mountInstall();
    if(CFG.installBanner)mountInstallBanner();
  });

})();`;

  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-cache"); // always fresh so toggle changes take effect
  res.send(js);
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
  // SVG first — "any" size means the browser scales it perfectly at any resolution
  if ((project as any).logoSvg) {
    icons.push({ src: `${base}/pwa/icon/${project.id}/icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" });
  }
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

// Serve original SVG icon
router.get("/pwa/icon/:projectId/icon.svg", async (req, res) => {
  const project = await getProjectById(req.params.projectId);
  if (!project) { res.status(404).end(); return; }
  const dataUrl = (project as any).logoSvg as string | null;
  if (!dataUrl) { res.status(404).end(); return; }
  const base64 = dataUrl.split(",")[1];
  if (!base64) { res.status(404).end(); return; }
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(Buffer.from(base64, "base64"));
});

// Serve favicon.ico (multi-res ICO)
router.get("/pwa/icon/:projectId/favicon.ico", async (req, res) => {
  const project = await getProjectById(req.params.projectId);
  if (!project) { res.status(404).end(); return; }
  const dataUrl = (project as any).logoIco as string | null;
  if (!dataUrl) { res.status(404).end(); return; }
  const base64 = dataUrl.split(",")[1];
  if (!base64) { res.status(404).end(); return; }
  res.setHeader("Content-Type", "image/x-icon");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(Buffer.from(base64, "base64"));
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

  // Use hosted icon URL (not base64 data URL — push payload must be < 4096 bytes)
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const base  = `${proto}://${req.get("host")}`;
  const iconUrl = project.logo ? `${base}/pwa/icon/${project.id}/192.png` : undefined;

  const finalPayload = {
    ...payload,
    icon: payload.icon ?? iconUrl,
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

  // Surface first failure reason for dashboard debugging
  const firstFailure = results.find(r => !r.success);
  res.json({
    sent: successCount,
    failed: failureCount,
    expired: expired.length,
    ...(firstFailure ? { errorStatus: firstFailure.errorStatus, errorBody: firstFailure.errorBody } : {}),
  });
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
