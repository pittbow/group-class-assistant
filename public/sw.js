// Service Worker — 讓 PWA 可在離線時顯示上次的課表
//
// 策略：
// - 頁面與 API：網路優先，失敗（離線）才用快取 → 部署新版後，下次開啟就是新版
// - 只快取成功的回應，避免伺服器錯誤頁蓋掉原本可用的資料

const CACHE_NAME = 'group-class-v9';
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function networkFirst(request) {
  return fetch(request)
    .then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(request, clone));
      }
      return res;
    })
    .catch(() => caches.match(request).then(cached =>
      cached || (request.mode === 'navigate' ? caches.match('/') : Response.error())));
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;          // POST（重新抓取）直接走網路
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;  // 外部資源不攔截

  e.respondWith(networkFirst(e.request));
});
