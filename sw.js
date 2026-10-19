/* Build placeholders are replaced for the published /ayat/ scope. */
const VERSION = '15c11438eb97';
const PRECACHE = ["./index.html","./manifest.webmanifest","./uthmanic-hafs.woff2","./data/quran.json","./voice-worker.js","./lib/align.js","./lib/progress.js","./lib/audio.js","./app.js?v=15c11438eb97","./runtime.js?v=15c11438eb97","./pwa.js?v=15c11438eb97","./config.js?v=15c11438eb97","./styles.css?v=15c11438eb97","./ui.css?v=15c11438eb97","./lib/native-recitation.js?v=15c11438eb97","./lib/recitation-feedback.js?v=15c11438eb97","./lib/recitation-follow.js?v=15c11438eb97","./lib/live-progress.js?v=15c11438eb97","./icons/icon-192.png","./icons/icon-512.png","./icons/maskable-512.png","./icons/apple-touch-icon.png"];
const FONT_BASE = 'https://cdn.jsdelivr.net/gh/hussainsajib/qpc-v4-mushaf-bundle@f84ccb5688d5404748a0d38e6c53e09df4469ec9/fonts';
const ROOT = new URL('./', self.location.href);
const PREFIX = `ayat:${ROOT.pathname}:`;
const SHELL = `${PREFIX}shell:${VERSION}`;
const CONTENT = `${PREFIX}reading:6984834459ca`;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(PRECACHE.map(file => new Request(new URL(file, ROOT), { cache: 'reload' })));
    // Updates wait for closed tabs or an explicit tap; never interrupt a mic.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const shells = (await caches.keys()).filter(key => key.startsWith(`${PREFIX}shell:`));
    // Keep one previous shell for another tab still finishing its recording.
    await Promise.all(shells.slice(0, -2).map(key => caches.delete(key)));
    const readings = (await caches.keys()).filter(key => key.startsWith(`${PREFIX}reading:`));
    await Promise.all(readings.slice(0, -2).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

function fontUrl(url) {
  return url.href.startsWith(`${FONT_BASE}/`) && /\/(?:qpcv4\/p\d{1,3}|surah-name-v4|QCF4_Hafs_01_W)\.woff2$/.test(url.pathname);
}

async function cacheReadingFile(url) {
  const cache = await caches.open(CONTENT);
  if (await cache.match(url)) return;
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok || response.type === 'opaque') throw new Error('Not available offline');
  await cache.put(url, response);
}

self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') { self.skipWaiting(); return; }
  if (event.data?.type !== 'SAVE_READING_PAGE') return;
  const page = Number(event.data.page);
  if (!Number.isInteger(page) || page < 1 || page > 604) return;
  event.waitUntil((async () => {
    try {
      await Promise.all([
        cacheReadingFile(new URL(`data/pages/${page}.json`, ROOT).href),
        cacheReadingFile(`${FONT_BASE}/qpcv4/p${page}.woff2`),
        cacheReadingFile(`${FONT_BASE}/surah-name-v4.woff2`),
        cacheReadingFile(`${FONT_BASE}/QCF4_Hafs_01_W.woff2`),
      ]);
      event.source?.postMessage({ type: 'READING_PAGE_SAVED', page });
    } catch {
      event.source?.postMessage({ type: 'READING_PAGE_SAVE_FAILED', page });
    }
  })());
});

async function navigation(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.ok) return response;
  } catch {} finally { clearTimeout(timer); }
  // The cached document and its versioned modules were installed together.
  return (await caches.open(SHELL)).match(new URL('index.html', ROOT).href);
}

async function resource(request, bucket) {
  const cache = await caches.open(bucket);
  const stored = await cache.match(request);
  if (stored) return stored;
  try {
    const response = await fetch(request);
    if (response.ok && response.type !== 'opaque') {
      try { await cache.put(request, response.clone()); } catch {}
    }
    return response;
  } catch {
    const json = new URL(request.url).pathname.endsWith('.json');
    return new Response(json ? JSON.stringify({ error: 'Бұл бет құрылғыда сақталмаған. Интернетпен бір рет ашыңыз.' }) : '', {
      status: 503, headers: { 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain' },
    });
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  // Audio, inference requests and unrelated sites never enter the PWA cache.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (fontUrl(url)) { event.respondWith(resource(request, CONTENT)); return; }
  if (url.origin !== ROOT.origin || !url.pathname.startsWith(ROOT.pathname)) return;
  const relative = url.pathname.slice(ROOT.pathname.length);
  if (request.mode === 'navigate' && (relative === '' || relative === 'index.html')) {
    event.respondWith(navigation(request)); return;
  }
  if (/^data\/(?:pages\/\d{1,3}|recitation)\.json$/.test(relative)) {
    event.respondWith(resource(request, CONTENT)); return;
  }
  if (/^(?:app|config|runtime|pwa|voice-worker)\.js$|^(?:styles|ui)\.css$|^lib\/[\w-]+\.js$|^icons\/[\w-]+\.(?:png|svg)$|^(?:manifest\.webmanifest|uthmanic-hafs\.woff2|data\/quran\.json)$/.test(relative)) {
    event.respondWith(resource(request, SHELL));
  }
});
