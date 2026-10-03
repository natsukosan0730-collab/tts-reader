// PWAインストール要件を満たすための最小のService Worker（画面ファイルのみキャッシュ、APIは常にネットワーク）
const CACHE = 'tts-reader-v1';
const ASSETS = ['/', '/index.html', '/refine.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.origin !== location.origin) return;
  // ネットワーク優先、失敗時のみキャッシュ（更新が反映されやすい）
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
