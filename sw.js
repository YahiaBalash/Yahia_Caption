/* =========================================================
   كابشن AI — عامل الخدمة (Service Worker)
   يجعل الموقع قابلاً للتثبيت كتطبيق، ويفتح الواجهة بسرعة حتى عند ضعف الاتصال.
   طلبات /api/ لا تُخزَّن أبداً: الاستخراج يحتاج دائماً إلى الخادم.
   ========================================================= */
const CACHE = "captionai-v1";
const SHELL = [
  "/",
  "/style.css",
  "/script.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // واجهة الخادم: مباشرة من الشبكة دائماً
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;

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

  if (url.origin !== location.origin) return;

  // ملفات الواجهة: من الشبكة أولاً (لتصل التحديثات)، ومن الذاكرة عند انقطاع الاتصال
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          const key = req.mode === "navigate" ? "/" : req;
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req, { ignoreSearch: true })) ||
        (req.mode === "navigate" ? caches.match("/") : Response.error()))
  );
});
