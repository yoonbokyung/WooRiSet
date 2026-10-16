/**
 * 오프라인 지원용 서비스 워커
 * 네트워크 우선 → 실패하면 캐시. 코드를 고치면 바로 반영되고, 오프라인일 때만 저장본을 쓴다.
 * 파일을 추가·삭제하면 ASSETS를 수정하고 CACHE 버전을 올린다.
 * (사진 캐시 hl-photos는 photos.js가 관리하므로 여기서 지우지 않는다)
 */
const CACHE_PREFIX = 'home-ledger-';
const CACHE = `${CACHE_PREFIX}v11`;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/reset.css',
  './css/variables.css',
  './css/common.css',
  './css/main.css',
  './js/app.js',
  './js/api.js',
  './js/config.js',
  './js/forms.js',
  './js/icons.js',
  './js/store.js',
  './js/ui.js',
  './js/utils.js',
  './js/modules/index.js',
  './js/modules/rent.js',
  './js/modules/household.js',
  './js/modules/travel.js',
  './js/photos.js',
  './js/map.js',
  './js/trip_import.js',
  './js/sms_rules.js',
  './js/views/dashboard.js',
  './js/views/menu.js',
  './js/views/settings.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })),
  );
});
