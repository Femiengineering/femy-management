// Service worker: lets the app open without a network connection.
const CACHE = 'femy-v22';
const ASSETS = [
  './',
  './index.html',
  './firebase-config.js',
  './users.json',
  './cloud.js',
  './google-config.js',
  './google.js',
  './sheet-sync.js',
  './drive-protocols.js',
  './ledger-xlsx.js',
  './accounts/consultant-accounts.json',
  './protocols/drive-protocols.json',
  './projects/drive-projects.json',
  './manifest.webmanifest',
  './docs/logo.png',
  './docs/letterhead.jpg',
  './docs/blank-template.docx',
  './vendor/jszip.min.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, so updates show up right away; fall back to the cache offline.
// Besides the site itself, only the Firebase library files are cached. Everything
// else (sign-in, database, Drive, Claude) goes straight to the network.
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/';
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  const own = new URL(url).origin === location.origin;
  if (!own && !url.startsWith(FIREBASE_SDK)) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || (own && e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
