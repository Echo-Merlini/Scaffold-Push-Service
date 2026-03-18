import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireApiKey, requireAdminKey } from "./middleware/auth.js";
import {
  createProject, listProjects, deleteProject, updateProjectLogo,
  getProjectByApiKey, getProjectById, getProjectBySlug, updateProjectPwa, updateProjectWidgets,
  addScreenshot, deleteScreenshot, getScreenshotsForProject, getScreenshotById,
  upsertSubscription, removeSubscription, removeSubscriptionById, getSubscriptionsForProject, getSubscriptionsByUserId,
  logNotification, getNotificationHistory,
  createScheduledNotification, getScheduledNotificationsForProject, cancelScheduledNotification,
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
    pwaName: z.string().nullable().optional(),
    pwaShortName: z.string().nullable().optional(),
    pwaThemeColor: z.string().nullable().optional(),
    pwaBgColor: z.string().nullable().optional(),
    pwaDisplay: z.enum(["standalone", "fullscreen", "minimal-ui", "browser"]).nullable().optional(),
    pwaUrl: z.string().url().nullable().optional(),
    pwaDescription: z.string().nullable().optional(),
    pwaYoutubeUrl: z.string().url().nullable().optional(),
    installSlug: z.string().regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers and hyphens").nullable().optional(),
  });
  const pwa = schema.parse(req.body);
  const project = await updateProjectPwa(req.params.id, pwa);
  res.json(project);
});

// Save widget enable/disable settings
router.patch("/admin/projects/:id/widgets", requireAdminKey, async (req, res) => {
  const schema = z.object({
    bell:               z.boolean(),
    banner:             z.boolean(),
    install:            z.boolean(),
    installBanner:      z.boolean().optional(),
    bellColor:          z.string().optional(),
    bannerColor:        z.string().optional(),
    installColor:       z.string().optional(),
    installBannerColor: z.string().optional(),
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
  const installUrl = `${base}/install/${(project as any).installSlug || project.id}`;

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
  // Capture beforeinstallprompt as early as possible — it can fire before DOMContentLoaded
  var dp=null;
  window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();dp=e;});

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
    if(!('serviceWorker' in navigator && 'PushManager' in window))
      return {ok:false,error:'Push notifications are not supported in this browser.'};
    try{
      var reg=await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      var ex=await reg.pushManager.getSubscription();
      if(ex)await ex.unsubscribe();
      var vr=await fetch(PUSH+'/vapid-public-key');
      var vj=await vr.json();
      var sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlB64(vj.publicKey)});
      await fetch(PUSH+'/subscribe',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':KEY},body:JSON.stringify(sub.toJSON())});
      return {ok:true};
    }catch(e){
      var msg=e&&e.message?e.message:String(e);
      // pushManager.subscribe fails in Brave when Google services are disabled
      var hint=msg.toLowerCase().indexOf('push service')!==-1||msg.toLowerCase().indexOf('registration failed')!==-1
        ?'In Brave: Settings \u2192 Privacy \u2192 enable \u201cUse Google services for push messaging\u201d.'
        :'Check that notifications are allowed for this site in your browser settings.';
      return {ok:false,error:hint};
    }
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
  function mountBell(color){color=color||THEME;
    // navigator.vendor is "Apple Computer, Inc." on all Safari versions (stable across iOS versions)
    // maxTouchPoints>0 distinguishes iPhone/iPad from Mac (Macs always return 0)
    var isAppleMobile=(/apple/i.test(navigator.vendor))&&navigator.maxTouchPoints>0;
    var isStandalone=!!(window.navigator.standalone)||window.matchMedia('(display-mode:standalone)').matches;
    var pushSupported='serviceWorker' in navigator&&'PushManager' in window;

    // Show on Apple touch devices (to guide install) or any browser with push support
    if(!pushSupported&&!isAppleMobile)return;

    var wrap=mkEl('div',null,{position:'fixed',bottom:CFG.installBanner?'88px':'24px',right:'24px',zIndex:'999999',display:'flex',flexDirection:'column',alignItems:'flex-end',gap:'8px',fontFamily:'system-ui,-apple-system,sans-serif'});

    var panel=mkEl('div',null,{display:'none',background:'#111',border:'1px solid #333',borderRadius:'16px',boxShadow:'0 8px 32px rgba(0,0,0,.5)',padding:'16px',width:'280px',color:'#e5e5e5',fontSize:'13px'});

    var panelHead=mkEl('div',null,{display:'flex',alignItems:'center',gap:'8px',marginBottom:'12px'});
    if(ICON){var logoEl=mkEl('img',{src:ICON},{width:'26px',height:'26px',borderRadius:'6px',objectFit:'cover',flexShrink:'0'});panelHead.append(logoEl);}
    var panelTitle=mkEl('span',{textContent:APP_NAME},{fontWeight:'600',fontSize:'14px',flex:'1',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'});
    var closeBtn=mkEl('button',{textContent:'✕'},{background:'none',border:'none',color:'#888',cursor:'pointer',fontSize:'14px',lineHeight:'1',padding:'0',flexShrink:'0'});
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
        btn.style.background=color;
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

        var blocked=typeof Notification!=='undefined'&&Notification.permission==='denied';
        panelBody.innerHTML='<p style="color:#888;font-size:12px;margin-bottom:12px">Get notified about new posts and community updates — even when you\\'re away.</p>';

        if(blocked){
          // Permission already denied — requesting again shows nothing; tell the user how to fix it
          panelBody.innerHTML+='<p style="color:#f87171;font-size:11px;margin-bottom:10px">&#x26A0; Notifications are blocked. To enable them, click the lock icon in your browser\\'s address bar and allow notifications for this site.</p>';
          var sb=mkEl('button',{textContent:'Notifications blocked'},{width:'100%',background:'#333',border:'none',borderRadius:'10px',color:'#888',padding:'10px',cursor:'default',fontWeight:'600',fontSize:'13px'});
          panelBody.append(sb);
        } else {
          var sb=mkEl('button',{textContent:'Enable notifications'},{width:'100%',background:color,border:'none',borderRadius:'10px',color:'#fff',padding:'10px',cursor:'pointer',fontWeight:'600',fontSize:'13px'});
          var errEl=mkEl('p',{textContent:''},{color:'#f87171',fontSize:'11px',marginTop:'8px',lineHeight:'1.5',display:'none'});
          sb.onclick=async function(){
            sb.disabled=true;sb.textContent='...';errEl.style.display='none';
            var perm=await Notification.requestPermission();
            if(perm!=='granted'){
              sb.disabled=false;sb.textContent='Enable notifications';
              errEl.textContent='Permission denied. Click the lock icon in your address bar to allow notifications.';
              errEl.style.display='block';
              return;
            }
            var result=await subscribe();
            if(result.ok){refresh(true);}
            else{
              sb.disabled=false;sb.textContent='Enable notifications';
              errEl.textContent=result.error||'Subscription failed — try again.';
              errEl.style.display='block';
            }
          };
          panelBody.append(sb,errEl);
        }
      }
    }

    btn.onclick=function(){panel.style.display=panel.style.display==='none'?'flex':'none';};
    panel.style.flexDirection='column';

    // Only show the bell to users who are not yet subscribed
    isSubscribed().then(function(s){
      if(s)return;
      refresh(false);
      wrap.append(panel,btn);
      document.body.append(wrap);
    });
  }

  /* ── Install Prompt ── */
  function mountInstall(color){color=color||THEME;
    if(localStorage.getItem(DISMISSED_INSTALL))return;
    var isAppleMobile=(/apple/i.test(navigator.vendor))&&navigator.maxTouchPoints>0;
    var isStandalone=!!window.navigator.standalone||window.matchMedia('(display-mode:standalone)').matches;
    if(isStandalone)return;

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

    var desc=mkEl('p',{
      textContent:isAppleMobile
        ?'Tap Install to add this app to your Home Screen.'
        :'Add to your home screen for a faster, app-like experience.'
    },{color:'#888',fontSize:'12px',marginBottom:'12px',lineHeight:'1.5'});

    var row=mkEl('div',null,{display:'flex',gap:'8px'});
    var instBtn=mkEl('button',{textContent:'Install'},{flex:'1',background:color,border:'none',borderRadius:'10px',color:'#fff',padding:'9px',cursor:'pointer',fontWeight:'600',fontSize:'13px'});
    var notNow=mkEl('button',{textContent:'Not now'},{background:'none',border:'none',color:'#666',cursor:'pointer',fontSize:'12px',padding:'9px 4px'});
    notNow.onclick=dismiss;
    row.append(instBtn,notNow);
    card.append(head,desc,row);
    document.body.append(card);

    // On iOS, beforeinstallprompt never fires — show card immediately
    if(isAppleMobile||dp)card.style.display='block';
    window.addEventListener('beforeinstallprompt',function(){card.style.display='block';});

    instBtn.onclick=async function(){
      if(dp){
        instBtn.disabled=true;
        await dp.prompt();
        var r=await dp.userChoice;
        if(r.outcome==='accepted')card.remove();
        else dismiss();
      }else{
        // iOS or no prompt — go to dedicated install page
        window.location.href=INSTALL_URL;
      }
    };
  }

  /* ── Subscribe Banner (top-centered drop card) ── */
  function mountBanner(color){color=color||THEME;
    var DISMISSED='_pws_sub_banner';
    if(localStorage.getItem(DISMISSED))return;
    var isAppleMobile=(/apple/i.test(navigator.vendor))&&navigator.maxTouchPoints>0;
    var isStandalone=!!window.navigator.standalone||window.matchMedia('(display-mode:standalone)').matches;
    var pushSupported='serviceWorker' in navigator&&'PushManager' in window;

    // iOS in browser (not installed PWA): push unavailable — show "install first" banner instead
    if(isAppleMobile&&!isStandalone&&!pushSupported){
      showBannerCard(true);
      return;
    }
    if(!pushSupported)return;

    isSubscribed().then(function(already){
      if(already)return;
      showBannerCard(false);
    });

    function showBannerCard(iosMode){
      var card=mkEl('div',null,{
        position:'fixed',top:'12px',left:'50%',zIndex:'999996',
        transform:'translateX(-50%) translateY(-120%)',
        transition:'transform .4s cubic-bezier(.34,1.56,.64,1)',
        width:'min(360px,calc(100% - 24px))',
        background:'#111',border:'1px solid #2a2a2a',borderRadius:'16px',
        boxShadow:'0 8px 32px rgba(0,0,0,.5)',
        padding:'14px 16px',fontFamily:'system-ui,-apple-system,sans-serif',
        color:'#e5e5e5'
      });

      function dismiss(){
        localStorage.setItem(DISMISSED,'1');
        card.style.transform='translateX(-50%) translateY(-120%)';
        setTimeout(function(){card.remove();},400);
      }

      // Header row: icon + name + close
      var head=mkEl('div',null,{display:'flex',alignItems:'center',gap:'10px',marginBottom:'10px'});
      if(ICON){var ic=mkEl('img',{src:ICON},{width:'36px',height:'36px',borderRadius:'9px',objectFit:'cover',flexShrink:'0'});head.append(ic);}
      var headText=mkEl('div',null,{flex:'1',minWidth:'0'});
      var nm=mkEl('div',{textContent:APP_NAME},{fontWeight:'700',fontSize:'13px',color:'#fff',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'});
      var tagline=mkEl('div',{
        textContent:iosMode?'Install the app to enable notifications':'Enable notifications to stay updated'
      },{fontSize:'11px',color:'#888',marginTop:'2px'});
      headText.append(nm,tagline);
      var xBtn=mkEl('button',{textContent:'✕'},{background:'none',border:'none',color:'#555',cursor:'pointer',fontSize:'15px',padding:'2px',flexShrink:'0',lineHeight:'1'});
      xBtn.onclick=dismiss;
      head.append(headText,xBtn);

      var subBtn=mkEl('button',{
        textContent:iosMode?'How to install':'Enable notifications'
      },{
        width:'100%',background:color,border:'none',borderRadius:'10px',
        color:'#fff',padding:'9px',cursor:'pointer',fontWeight:'700',fontSize:'13px'
      });
      var errEl=mkEl('p',{textContent:''},{color:'#f87171',fontSize:'11px',marginTop:'6px',lineHeight:'1.5',display:'none'});

      if(iosMode){
        subBtn.onclick=function(){window.location.href=INSTALL_URL;};
      }else{
        subBtn.onclick=async function(){
          subBtn.disabled=true;subBtn.textContent='...';errEl.style.display='none';
          var perm=await Notification.requestPermission();
          if(perm!=='granted'){
            subBtn.textContent='Blocked';
            errEl.textContent='Allow notifications in your browser settings, then reload.';
            errEl.style.display='block';
            subBtn.disabled=false;
            return;
          }
          var result=await subscribe();
          if(result.ok){
            subBtn.textContent='✓ Subscribed!';
            setTimeout(function(){dismiss();},1200);
          }else{
            subBtn.disabled=false;subBtn.textContent='Enable notifications';
            errEl.textContent=result.error||'Subscription failed — try again.';
            errEl.style.display='block';
          }
        };
      }

      card.append(head,subBtn,errEl);
      document.body.append(card);
      requestAnimationFrame(function(){requestAnimationFrame(function(){
        card.style.transform='translateX(-50%) translateY(0)';
      });});
    }
  }

  /* ── Installation Banner ── */
  function mountInstallBanner(color){color=color||THEME;
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

    var instBtn=mkEl('button',{textContent:'Install'},{background:color,border:'none',borderRadius:'10px',
      color:'#fff',padding:'8px 16px',cursor:'pointer',fontWeight:'700',fontSize:'13px',flexShrink:'0',
      whiteSpace:'nowrap'});
    var xBtn=mkEl('button',{textContent:'✕'},{background:'none',border:'none',color:'#555',
      cursor:'pointer',fontSize:'16px',padding:'4px',flexShrink:'0',lineHeight:'1'});
    xBtn.onclick=dismiss;

    banner.append(ic,info,instBtn,xBtn);
    document.body.append(banner);
    requestAnimationFrame(function(){requestAnimationFrame(function(){banner.style.transform='translateY(0)';});});

    // dp is the shared top-level deferred prompt
    instBtn.onclick=async function(){
      if(dp){
        instBtn.disabled=true;
        await dp.prompt();
        var r=await dp.userChoice;
        if(r.outcome==='accepted'){banner.remove();return;}
        dismiss();
      }else{
        window.location.href=INSTALL_URL;
      }
    };
  }

  /* Identify: link a userId to the existing push subscription  */
  /* Usage: window.scaffoldPush.identify('userId123')           */
  window.scaffoldPush = {
    identify: async function(userId){
      if(!('serviceWorker' in navigator && 'PushManager' in window)) return false;
      try{
        var reg = await navigator.serviceWorker.getRegistration('/sw.js');
        if(!reg) return false;
        var sub = await reg.pushManager.getSubscription();
        if(!sub) return false;
        var j = sub.toJSON();
        await fetch(PUSH+'/subscribe',{
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':KEY},
          body:JSON.stringify({endpoint:j.endpoint,keys:j.keys,userId:String(userId)})
        });
        return true;
      }catch(e){ return false; }
    }
  };

  /* ── Init ── */
  document.addEventListener('DOMContentLoaded',function(){
    registerSW();
    if(CFG.bell)mountBell(CFG.bellColor||THEME);
    if(CFG.banner)mountBanner(CFG.bannerColor||THEME);
    if(CFG.install)mountInstall(CFG.installColor||THEME);
    if(CFG.installBanner)mountInstallBanner(CFG.installBannerColor||THEME);
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

// Same-origin manifest for install page — start_url stays on the push service
// so beforeinstallprompt fires. When opened in standalone, the page redirects to the real app.
router.get("/pwa/install-manifest/:slugOrId", async (req, res) => {
  const param = req.params.slugOrId;
  let project = await getProjectBySlug(param);
  if (!project) project = await getProjectById(param);
  if (!project) { res.status(404).json({ error: "not found" }); return; }

  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const base  = `${proto}://${req.get("host")}`;
  const installPath = `/install/${(project as any).installSlug || project.id}`;

  const icons: object[] = [];
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

  res.setHeader("Content-Type", "application/manifest+json");
  res.json({
    name:             project.pwaName      || project.name,
    short_name:       project.pwaShortName || project.name.slice(0, 12),
    start_url:        installPath,
    scope:            "/install/",
    display:          project.pwaDisplay    || "standalone",
    theme_color:      project.pwaThemeColor || "#000000",
    background_color: project.pwaBgColor    || "#ffffff",
    icons,
  });
});

// Installation page — resolve by custom slug OR project ID
router.get("/install/:slugOrId", async (req, res) => {
  const param = req.params.slugOrId;
  // Try slug first, fall back to ID
  let project = await getProjectBySlug(param);
  if (!project) project = await getProjectById(param);
  if (!project) { res.status(404).send("App not found"); return; }

  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const base  = `${proto}://${req.get("host")}`;
  const icon  = project.logo512
    ? `${base}/pwa/icon/${project.id}/512.png`
    : project.logo ? `${base}/pwa/icon/${project.id}/192.png` : null;
  const shots = await getScreenshotsForProject(project.id);
  const appUrl     = (project as any).pwaUrl         || "#";
  const appName    = (project as any).pwaName        || project.name;
  const appDesc    = (project as any).pwaDescription || "";
  const youtubeUrl = (project as any).pwaYoutubeUrl  || "";
  const themeColor = (project as any).pwaThemeColor  || "#000000";
  const bgColor    = (project as any).pwaBgColor     || "#ffffff";
  const installManifestUrl = `${base}/pwa/install-manifest/${(project as any).installSlug || project.id}`;

  const screenshotUrls = shots.map(s => `${base}/pwa/screenshot/${s.id}.png`);
  const screenshotHtml = shots.map((s, i) =>
    `<img src="${screenshotUrls[i]}" class="screenshot" alt="${s.label || appName} screenshot" onclick="lbOpen(${i})" />`
  ).join("");

  // Convert YouTube watch URL to embed URL
  let youtubeEmbed = "";
  if (youtubeUrl) {
    const ytMatch = youtubeUrl.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (ytMatch) {
      youtubeEmbed = `https://www.youtube.com/embed/${ytMatch[1]}`;
    }
  }

  // Determine if bgColor is dark so we can set appropriate text colors
  function hexLuminance(hex: string): number {
    const h = hex.replace("#", "").padEnd(6, "0");
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const lin = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  const isDark = hexLuminance(bgColor) < 0.35;
  const textColor    = isDark ? "#f0f0f0" : "#111111";
  const mutedColor   = isDark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)";
  const iosTipBg     = isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.05)";
  const iosTipColor  = isDark ? "rgba(255,255,255,0.65)" : "rgba(0,0,0,0.55)";
  const dividerColor = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Install ${appName}</title>
  <link rel="manifest" href="${installManifestUrl}">
  <meta name="theme-color" content="${bgColor}">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="${appName}">
  ${icon ? `<link rel="apple-touch-icon" href="${icon}">` : ""}
  <meta property="og:title" content="${appName}"/>
  <meta property="og:description" content="${appDesc || `Install ${appName} on your device`}"/>
  ${icon ? `<meta property="og:image" content="${icon}"/>` : ""}
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%}
    body{
      font-family:system-ui,-apple-system,sans-serif;
      background:${bgColor};
      color:${textColor};
      min-height:100vh;
      display:flex;
      flex-direction:column;
      align-items:center;
    }
    .wrap{width:100%;max-width:860px;padding:0 2rem;display:flex;flex-direction:column;flex:1}

    /* Top row: icon + info + install btn */
    .top-row{display:flex;align-items:center;gap:1.25rem;padding:2.5rem 0 1.75rem}
    .app-icon{width:92px;height:92px;border-radius:22px;object-fit:cover;box-shadow:0 6px 24px rgba(0,0,0,.28);flex-shrink:0}
    .app-icon-placeholder{width:92px;height:92px;border-radius:22px;background:${themeColor};display:flex;align-items:center;justify-content:center;font-size:2.75rem;flex-shrink:0}
    .top-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:.35rem}
    .app-name{font-size:1.6rem;font-weight:800;letter-spacing:-.02em;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .app-url{font-size:.78rem;color:${mutedColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .install-btn{
      display:flex;align-items:center;justify-content:center;gap:.45rem;
      padding:.7rem 1.35rem;
      background:${themeColor};color:#fff;
      border:none;border-radius:12px;
      font-size:1rem;font-weight:700;letter-spacing:.01em;
      cursor:pointer;transition:transform .1s,opacity .15s;
      text-decoration:none;white-space:nowrap;flex-shrink:0;
    }
    .install-btn:active{transform:scale(.97)}
    .install-btn:disabled{opacity:.45;cursor:default;transform:none}

    /* Media carousel — full-bleed single row */
    .media-wrap{position:relative;margin:0 -2rem 1.75rem}
    .media-scroll{overflow-x:auto;display:flex;gap:.85rem;padding:.25rem 2rem .85rem;scrollbar-width:none;align-items:flex-start;scroll-behavior:smooth}
    .media-scroll::-webkit-scrollbar{display:none}
    .media-yt{flex-shrink:0;width:calc(360px * 16 / 9);height:360px;border-radius:14px;overflow:hidden;border:0}
    .screenshot{height:360px;border-radius:14px;flex-shrink:0;object-fit:cover;box-shadow:0 4px 16px rgba(0,0,0,.18);cursor:zoom-in;transition:transform .15s,box-shadow .15s}
    .screenshot:hover{transform:scale(1.015);box-shadow:0 8px 28px rgba(0,0,0,.28)}

    /* Lightbox */
    .lb-overlay{display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);align-items:center;justify-content:center;cursor:zoom-out}
    .lb-overlay.open{display:flex}
    .lb-img{max-width:92vw;max-height:88vh;border-radius:12px;object-fit:contain;box-shadow:0 16px 64px rgba(0,0,0,.6);user-select:none}
    .lb-close{position:fixed;top:1.1rem;right:1.25rem;background:rgba(255,255,255,.1);border:none;color:#fff;font-size:1.4rem;line-height:1;width:2.4rem;height:2.4rem;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px)}
    .lb-close:hover{background:rgba(255,255,255,.2)}
    .lb-nav{position:fixed;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.1);border:none;color:#fff;font-size:1.8rem;line-height:1;width:2.8rem;height:2.8rem;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);transition:background .15s}
    .lb-nav:hover{background:rgba(255,255,255,.22)}
    .lb-prev{left:1rem}
    .lb-next{right:1rem}
    .carousel-btn{
      display:none;position:absolute;top:50%;transform:translateY(-50%);
      width:40px;height:40px;border-radius:50%;
      background:${isDark ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.12)"};
      border:1px solid ${isDark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.15)"};
      color:${textColor};cursor:pointer;
      align-items:center;justify-content:center;
      font-size:18px;line-height:1;
      transition:background .15s,transform .1s;
      z-index:2;backdrop-filter:blur(4px);
    }
    .carousel-btn:hover{background:${isDark ? "rgba(255,255,255,.22)" : "rgba(0,0,0,.22)"};}
    .carousel-btn:active{transform:translateY(-50%) scale(.93);}
    .carousel-btn.left{left:.5rem}
    .carousel-btn.right{right:.5rem}
    @media(hover:hover){.carousel-btn{display:flex;}}

    /* Description */
    .desc{font-size:.93rem;line-height:1.65;color:${mutedColor};padding:.25rem 0 1.5rem}

    /* Static info blocks */
    .info-section{display:flex;flex-direction:column;gap:.1rem;padding-bottom:2rem}
    .info-block{padding:1.1rem 0;border-top:1px solid ${dividerColor}}
    .info-block:last-child{border-bottom:1px solid ${dividerColor}}
    .info-block h3{font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${mutedColor};margin-bottom:.5rem}
    .info-block p{font-size:.88rem;line-height:1.65;color:${isDark ? "rgba(255,255,255,.7)" : "rgba(0,0,0,.65)"}}
    .platform-chips{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.6rem}
    .chip{display:inline-flex;align-items:center;gap:.3rem;padding:.25rem .65rem;border-radius:20px;font-size:.75rem;font-weight:500;background:${isDark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.06)"};color:${isDark ? "rgba(255,255,255,.7)" : "rgba(0,0,0,.6)"}}

    /* Bottom link */
    .open-btn{
      display:block;text-align:center;font-size:.82rem;color:${mutedColor};
      text-decoration:none;padding:.6rem;margin-top:auto;padding-bottom:2rem;
      transition:opacity .15s;
    }
    .open-btn:hover{opacity:.7}

    /* Divider */
    .divider{width:40px;height:1px;background:${dividerColor};margin:.25rem auto}

    /* iOS modal overlay */
    .ios-overlay{
      display:none;position:fixed;inset:0;z-index:9999;
      background:rgba(0,0,0,.55);
      align-items:flex-end;justify-content:center;
    }
    .ios-overlay.open{display:flex;}
    .ios-sheet{
      background:${isDark ? "#1c1c1e" : "#ffffff"};
      border-radius:20px 20px 0 0;
      padding:1.5rem 1.5rem calc(1.5rem + env(safe-area-inset-bottom));
      width:100%;max-width:520px;
      font-family:system-ui,-apple-system,sans-serif;
    }
    .ios-sheet-handle{width:36px;height:4px;border-radius:2px;background:${isDark ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.15)"};margin:0 auto 1.25rem;}
    .ios-sheet h2{font-size:1rem;font-weight:700;color:${textColor};text-align:center;margin-bottom:1.25rem;}
    .ios-app-row{display:flex;align-items:center;gap:.85rem;padding:.85rem 1rem;background:${iosTipBg};border-radius:14px;margin-bottom:1.25rem;}
    .ios-app-icon{width:52px;height:52px;border-radius:13px;object-fit:cover;flex-shrink:0;}
    .ios-app-name{font-size:.9rem;font-weight:600;color:${textColor};}
    .ios-app-domain{font-size:.75rem;color:${mutedColor};margin-top:.15rem;}
    .ios-steps{display:flex;flex-direction:column;gap:.85rem;margin-bottom:1.5rem;}
    .ios-step{display:flex;align-items:center;gap:.85rem;}
    .ios-step-num{width:28px;height:28px;border-radius:50%;background:${themeColor};color:#fff;font-size:.8rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .ios-step-text{font-size:.88rem;color:${textColor};line-height:1.4;}
    .ios-step-text em{font-style:normal;font-weight:600;}
    .ios-close{width:100%;padding:.85rem;background:${iosTipBg};border:none;border-radius:12px;font-size:.95rem;font-weight:600;color:${textColor};cursor:pointer;}
  </style>
</head>
<body>
  <div class="wrap">
    <!-- Top row: icon · info · install button -->
    <div class="top-row">
      ${icon
        ? `<img src="${icon}" class="app-icon" alt="${appName}"/>`
        : `<div class="app-icon-placeholder">📱</div>`}
      <div class="top-info">
        <h1 class="app-name">${appName}</h1>
        ${appUrl !== "#" ? `<div class="app-url">${appUrl.replace(/^https?:\/\//, "")}</div>` : ""}
      </div>
      <button class="install-btn" id="install-btn" onclick="triggerInstall()">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Install
      </button>
    </div>

    <!-- Media carousel: YouTube + screenshots in one horizontal row -->
    ${(youtubeEmbed || shots.length) ? `<div class="media-wrap">
      <button class="carousel-btn left" id="carousel-prev" onclick="carouselScroll(-1)" aria-label="Previous">&#8249;</button>
      <div class="media-scroll" id="media-scroll">${youtubeEmbed ? `<iframe class="media-yt" src="${youtubeEmbed}" allowfullscreen loading="lazy" title="${appName} preview"></iframe>` : ""}${screenshotHtml}</div>
      <button class="carousel-btn right" id="carousel-next" onclick="carouselScroll(1)" aria-label="Next">&#8250;</button>
    </div>` : ""}

    ${appDesc ? `<p class="desc">${appDesc}</p>` : ""}

    <div class="info-section">
      <div class="info-block">
        <h3>What is this app?</h3>
        <p>This app is a Progressive Web App (PWA). Install it on any smartphone, tablet or desktop — it uses very little storage space and requires no updates. By design, a PWA cannot access your device data or personal information.</p>
      </div>
      <div class="info-block">
        <h3>Availability</h3>
        <p>Install ${appName} in a few seconds — directly from your browser. Simply click the <strong>Install</strong> button at the top of the page.</p>
        <div class="platform-chips">
          <span class="chip"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24C14.97 8.03 13.55 7.6 12 7.6s-2.97.43-4.47 1.11L5.65 5.47c-.18-.28-.54-.37-.83-.22-.3.16-.42.54-.26.85L6.4 9.48C3.3 11.25 1.28 14.44 1 18h22c-.28-3.56-2.3-6.75-5.4-8.52zM7 15.25c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25zm10 0c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25z"/></svg>Android (Chrome)</span>
          <span class="chip"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>iOS (Safari)</span>
          <span class="chip"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M0 12C0 5.373 5.373 0 12 0s12 5.373 12 12-5.373 12-12 12S0 18.627 0 12zm3.84 0c0 4.505 3.655 8.16 8.16 8.16 4.505 0 8.16-3.655 8.16-8.16 0-4.505-3.655-8.16-8.16-8.16C7.495 3.84 3.84 7.495 3.84 12z"/></svg>Windows (Chrome / Edge)</span>
          <span class="chip"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>macOS (Chrome)</span>
        </div>
      </div>
    </div>

    ${appUrl !== "#" ? `<a class="open-btn" href="${appUrl}">Open in browser →</a>` : ""}
  </div>

  <!-- Lightbox -->
  <div class="lb-overlay" id="lb-overlay" onclick="lbClose(event)">
    <button class="lb-close" onclick="lbClose()" aria-label="Close">&#x2715;</button>
    ${shots.length > 1 ? `<button class="lb-nav lb-prev" onclick="event.stopPropagation();lbStep(-1)" aria-label="Previous">&#8249;</button>` : ""}
    <img class="lb-img" id="lb-img" src="" alt="" />
    ${shots.length > 1 ? `<button class="lb-nav lb-next" onclick="event.stopPropagation();lbStep(1)" aria-label="Next">&#8250;</button>` : ""}
  </div>

  <!-- iOS install instructions modal -->
  <div class="ios-overlay" id="ios-overlay" onclick="closeIosModal(event)">
    <div class="ios-sheet">
      <div class="ios-sheet-handle"></div>
      <h2>Add to Home Screen</h2>
      <div class="ios-app-row">
        ${icon
          ? `<img src="${icon}" class="ios-app-icon" alt="${appName}"/>`
          : `<div class="ios-app-icon" style="background:${themeColor};display:flex;align-items:center;justify-content:center;font-size:1.5rem">📱</div>`}
        <div>
          <div class="ios-app-name">${appName}</div>
          <div class="ios-app-domain">${appUrl.replace(/^https?:\/\//, "") || "App"}</div>
        </div>
      </div>
      <div class="ios-steps">
        <div class="ios-step">
          <div class="ios-step-num">1</div>
          <div class="ios-step-text">Tap the <em>Share</em> button <svg style="vertical-align:middle" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> in the browser toolbar</div>
        </div>
        <div class="ios-step">
          <div class="ios-step-num">2</div>
          <div class="ios-step-text">Scroll down and tap <em>Add to Home Screen</em></div>
        </div>
        <div class="ios-step">
          <div class="ios-step-num">3</div>
          <div class="ios-step-text">Tap <em>Add</em> in the top-right corner</div>
        </div>
      </div>
      <button class="ios-close" onclick="closeIosModal()">Got it</button>
    </div>
  </div>

  <script>
    var lbUrls = ${JSON.stringify(screenshotUrls)};
    var lbIdx  = 0;
    var lbOverlay = null;

    function lbOpen(i) {
      lbIdx = i;
      if (!lbOverlay) lbOverlay = document.getElementById('lb-overlay');
      document.getElementById('lb-img').src = lbUrls[i];
      lbOverlay.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function lbClose(e) {
      if (e && e.target !== lbOverlay && !e.target.classList.contains('lb-close')) return;
      if (!e) {
        lbOverlay = lbOverlay || document.getElementById('lb-overlay');
        lbOverlay.classList.remove('open');
        document.body.style.overflow = '';
        return;
      }
      lbOverlay.classList.remove('open');
      document.body.style.overflow = '';
    }
    function lbStep(dir) {
      lbIdx = (lbIdx + dir + lbUrls.length) % lbUrls.length;
      document.getElementById('lb-img').src = lbUrls[lbIdx];
    }
    document.addEventListener('keydown', function(e) {
      var ov = document.getElementById('lb-overlay');
      if (!ov || !ov.classList.contains('open')) return;
      if (e.key === 'Escape') { ov.classList.remove('open'); document.body.style.overflow = ''; }
      if (e.key === 'ArrowLeft')  lbStep(-1);
      if (e.key === 'ArrowRight') lbStep(1);
    });

    function carouselScroll(dir) {
      var el = document.getElementById('media-scroll');
      if (!el) return;
      el.scrollBy({ left: dir * 320, behavior: 'smooth' });
    }

    var dp = null;
    var isAppleMobile = (/apple/i.test(navigator.vendor)) && navigator.maxTouchPoints > 0;
    var isStandalone  = window.matchMedia('(display-mode:standalone)').matches || !!window.navigator.standalone;

    // Opened from home screen — skip the install page and go straight to the app
    if (isStandalone && '${appUrl}' !== '#') {
      window.location.replace('${appUrl}');
    }

    window.addEventListener('beforeinstallprompt', function(e) {
      e.preventDefault();
      dp = e;
      // Show the install button now that we have the prompt
      document.getElementById('install-btn').disabled = false;
    });

    var btn = document.getElementById('install-btn');
    var overlay = document.getElementById('ios-overlay');

    function openIosModal() { overlay.classList.add('open'); }
    function closeIosModal(e) {
      if (!e || e.target === overlay) overlay.classList.remove('open');
    }

    function triggerInstall() {
      if (dp) {
        btn.disabled = true;
        dp.prompt();
        dp.userChoice.then(function(r) {
          if (r.outcome === 'accepted') {
            btn.textContent = 'Installed ✓';
          } else {
            btn.disabled = false;
          }
        });
      } else if (isAppleMobile) {
        openIosModal();
      } else {
        window.open('${appUrl}', '_blank');
      }
    }

    // Register same-origin SW (required for beforeinstallprompt to fire).
    // If it's the very first install, reload once it activates so the prompt fires.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/install-sw.js', { scope: '/install/' })
        .then(function(reg) {
          if (reg.installing) {
            reg.installing.addEventListener('statechange', function() {
              if (this.state === 'activated') window.location.reload();
            });
          }
        }).catch(function(){});
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
  userId: z.string().optional(),
});

router.post("/subscribe", requireApiKey, async (req, res) => {
  const project = (req as any).project;
  const { endpoint, keys, userId } = subscribeSchema.parse(req.body);

  console.log(`[subscribe] projectId=${project.id} userId=${userId ?? "NONE"} endpoint=${endpoint.slice(0, 60)}...`);

  const sub = await upsertSubscription({
    projectId: project.id,
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userAgent: req.headers["user-agent"],
    userId,
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
  scheduledAt: z.string().optional(),
  actions: z.array(z.object({ action: z.string(), title: z.string(), url: z.string().optional() })).max(2).optional(),
  targetUserId: z.string().optional(),
});

router.post("/notify", requireApiKey, async (req, res) => {
  const project = (req as any).project;
  const body = notifySchema.parse(req.body);

  // Use hosted icon URL (not base64 data URL — push payload must be < 4096 bytes)
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const base  = `${proto}://${req.get("host")}`;
  const iconUrl = project.logo ? `${base}/pwa/icon/${project.id}/192.png` : undefined;

  // If scheduledAt is provided, store as scheduled and return immediately
  if (body.scheduledAt) {
    const scheduledDate = new Date(body.scheduledAt);
    if (isNaN(scheduledDate.getTime()) || scheduledDate <= new Date()) {
      res.status(400).json({ error: "scheduledAt must be a valid future datetime" }); return;
    }
    await createScheduledNotification({
      projectId: project.id,
      title: body.title,
      body: body.body,
      url: body.url,
      image: body.image,
      icon: project.logo ? `${base}/pwa/icon/${project.id}/192.png` : undefined,
      actions: body.actions ? JSON.stringify(body.actions) : undefined,
      scheduledAt: scheduledDate,
    });
    res.json({ scheduled: true, scheduledAt: scheduledDate });
    return;
  }

  const finalPayload: any = {
    title: body.title,
    body: body.body,
    url: body.url,
    icon: body.icon ?? iconUrl,
    badge: body.badge,
    image: body.image,
  };
  if (body.actions?.length) finalPayload.actions = body.actions;

  const subs = body.targetUserId
    ? await getSubscriptionsByUserId(project.id, body.targetUserId)
    : await getSubscriptionsForProject(project.id);
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
    title: body.title,
    body: body.body,
    url: body.url,
    image: body.image,
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

// List pending scheduled notifications for a project
router.get("/admin/projects/:id/scheduled", requireAdminKey, async (req, res) => {
  const rows = await getScheduledNotificationsForProject(req.params.id);
  res.json(rows);
});

// Cancel a scheduled notification
router.delete("/admin/scheduled/:id", requireAdminKey, async (req, res) => {
  await cancelScheduledNotification(req.params.id);
  res.json({ ok: true });
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
