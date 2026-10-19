/* =========================================================
   كابشن AI — عامل الخدمة (Service Worker)
   - يجعل الموقع قابلاً للتثبيت كتطبيق ويفتح الواجهة بسرعة حتى دون اتصال.
   - يستقبل الفيديوهات والروابط المُشارَكة من تطبيقات الهاتف (share-target).
   - يضيف ترويسات العزل (COOP/COEP) لتعمل نماذج Whisper على عدة أنوية في المعالج.
   - طلبات api/ لا تُخزَّن أبداً: الاستخراج من الروابط يحتاج دائماً إلى الخادم.
   كل المسارات نسبية حتى يعمل الموقع في مجلد فرعي (GitHub Pages) وفي جذر الخادم المحلي.
   ========================================================= */
const CACHE = "captionai-v3";
const SHARE_CACHE = "captionai-share";
const SCOPE = self.registration.scope; // مثل https://user.github.io/Yahia_Caption/
const SHELL = [
  "./",
  "style.css",
  "script.js",
  "asr-worker.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/favicon-32.png",
].map((p) => new URL(p, SCOPE).href);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** يضيف ترويسات العزل إلى صفحة التطبيق (تفعّل SharedArrayBuffer لتشغيل Whisper بعدة أنوية) */
function withIsolation(res) {
  if (!res || res.status === 0 || res.type === "opaque") return res;
  const headers = new Headers(res.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "credentialless");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** استقبال ما يُشارَك من التطبيقات الأخرى: يُحفظ الملف مؤقتاً ثم تُفتح الصفحة لتعالجه */
async function handleShare(request) {
  const form = await request.formData();
  const file = form.get("media");
  const params = new URLSearchParams();
  ["title", "text", "url"].forEach((k) => { const v = form.get(k); if (v) params.set(k, v); });
  if (file && typeof file !== "string" && file.size) {
    const cache = await caches.open(SHARE_CACHE);
    await cache.put(new URL("shared-media", SCOPE).href, new Response(file, {
      headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name || "shared-video.mp4") },
    }));
    params.set("shared-file", "1");
  }
  return Response.redirect(SCOPE + "?" + params.toString(), 303);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === "POST" && url.href.startsWith(SCOPE) && url.pathname.endsWith("/share-target")) {
    event.respondWith(handleShare(req));
    return;
  }
  if (req.method !== "GET") return;

  // واجهة الخادم: مباشرة من الشبكة دائماً
  if (url.origin === location.origin && url.pathname.includes("/api/")) return;

  // خطوط Google: من الذاكرة أولاً ثم تحديثها في الخلفية
  if (url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => { cache.put(req, res.clone()); return res; }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // نماذج Whisper ومكتبة التفريغ تُخزّنها المكتبة نفسها؛ لا نتدخل فيها
  if (url.origin !== location.origin) return;

  // الصفحة وملف العامل (Worker) كلاهما يحتاج ترويسات العزل، وإلا يرفض المتصفح تشغيل العامل
  const isPage = req.mode === "navigate";
  const needsIsolation = isPage || req.destination === "worker";
  // ملفات الواجهة: من الشبكة أولاً (لتصل التحديثات)، ومن الذاكرة عند انقطاع الاتصال
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(isPage ? SHELL[0] : req, copy));
        }
        return needsIsolation ? withIsolation(res) : res;
      })
      .catch(async () => {
        const cached = (await caches.match(req, { ignoreSearch: true })) || (isPage ? await caches.match(SHELL[0]) : null);
        if (!cached) return Response.error();
        return needsIsolation ? withIsolation(cached) : cached;
      })
  );
});
