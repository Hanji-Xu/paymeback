/* Pay Me Back offline cache. The page works without it. With it, every visit after the first loads from
   this device, and the page opens with no connection.

   - First visit: the files of the page are saved.
   - Every later visit: the page is served from the saved files at once. In the background the server is
     asked whether any file changed (a short "not changed" answer per file when nothing did). If something
     changed, the whole new set is kept aside, and it is used from the next visit on. So the files a visit
     runs on never change under it, and files of two versions never mix.
   - Requests to other sites (the exchange rates) are not touched: they go straight to the network.

   Change the number in CACHE whenever this file changes. The old cache is deleted once every tab that
   still runs the old worker has been closed. */

const CACHE = 'paymeback-v2';   // the files visits are served from
const NEXT = CACHE + '-next';      // a newer version, fetched during a visit, for the next one
const ROOT = new URL('./', self.location).href;   // this file sits next to index.html
const FILES = ['./', './css/style.css', './js/app.js', './js/core.js', './js/editor.js', './js/graph.js',
  './js/parse.js', './js/share.js', './js/simplify.js', './js/stage.js', './js/store.js', './method.html'];

// "no-cache" makes the browser ask the server every time, so files fetched together are of one version.
const fetchAll = () => Promise.all(FILES.map(url => fetch(new Request(url, { cache: 'no-cache' }))));
const saveAll = (cache, responses) => Promise.all(responses.map((response, i) => cache.put(FILES[i], response)));
// What tells two versions of a file apart without reading them.
const stamp = response => response && (response.headers.get('etag') || response.headers.get('last-modified'));

// The address a request is saved under: no "?..." part, and index.html is the same page as the folder.
function keyOf(request) {
  const url = request.url.split(/[?#]/)[0];
  return url === ROOT + 'index.html' ? ROOT : url;
}

// The page is being opened: a version that was kept aside during the last visit is used from here on.
async function useNewer() {
  if (!(await caches.has(NEXT))) return;
  const next = await caches.open(NEXT), responses = await Promise.all(FILES.map(url => next.match(url)));
  if (responses.every(Boolean)) await saveAll(await caches.open(CACHE), responses);
  await caches.delete(NEXT);
}

// In the background: if any file on the server differs from the saved one, keep the whole new set aside.
async function lookForNewer() {
  const fresh = await fetchAll();
  if (!fresh.every(response => response.ok)) return;
  const cache = await caches.open(CACHE), saved = await Promise.all(FILES.map(url => cache.match(url)));
  if (fresh.every((response, i) => stamp(response) && stamp(response) === stamp(saved[i]))) return;
  await caches.delete(NEXT);
  await saveAll(await caches.open(NEXT), fresh);
}

self.addEventListener('install', event => {
  event.waitUntil(fetchAll().then(async responses => {
    if (!responses.every(response => response.ok)) throw new Error('A file of the page could not be fetched.');
    await saveAll(await caches.open(CACHE), responses);
  }));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names =>
    Promise.all(names.filter(name => name.startsWith('paymeback-') && name !== CACHE && name !== NEXT).map(name => caches.delete(name)))));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(ROOT)) return;   // not ours: the browser handles it
  const opening = request.mode === 'navigate';
  const ready = opening ? useNewer().catch(() => {}) : Promise.resolve();
  event.respondWith(ready.then(() => caches.open(CACHE)).then(cache => cache.match(keyOf(request), { ignoreVary: true }))
    .then(saved => saved || fetch(request)));
  if (opening) event.waitUntil(ready.then(lookForNewer).catch(() => {}));   // offline, this just fails
});
