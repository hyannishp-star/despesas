/* Service worker: guarda o app no iPhone para abrir sem internet. Nunca guarda dados do usuário (esses ficam no IndexedDB). */
const VERSAO = "rd-pwa-v5";
const ARQUIVOS = ["./", "index.html", "rd-local.js", "manifest.webmanifest", "icone-180.png", "icone-512.png", "fonte.woff2",
  "vendor/exceljs.min.js", "vendor/jszip.min.js", "vendor/tesseract/tesseract.min.js", "vendor/tesseract/worker.min.js",
  "vendor/tesseract/tesseract-core-relaxedsimd-lstm.wasm.js", "vendor/tesseract/tesseract-core-simd-lstm.wasm.js", "vendor/tesseract/tesseract-core-lstm.wasm.js", "vendor/tesseract/eng.traineddata.gz"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url); if (u.origin !== location.origin) return;   // consultas externas (sq ft) passam direto
  e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(c => c || fetch(e.request)));
});
