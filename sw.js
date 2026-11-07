/* เก็บไฟล์แอปไว้ในเครื่อง เปิดได้แม้ไม่มีเน็ต เปลี่ยนเลข VERSION ทุกครั้งที่แก้แอป */
const VERSION = 'v1';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/jspdf.umd.min.js', 'vendor/sarabun.css',
  'vendor/sarabun-400-thai.woff2', 'vendor/sarabun-400-latin.woff2',
  'vendor/sarabun-600-thai.woff2', 'vendor/sarabun-600-latin.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* ใช้ของในเน็ตก่อนถ้าต่อได้ จะได้ของใหม่เสมอ ต่อไม่ได้ค่อยใช้ของในเครื่อง */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
