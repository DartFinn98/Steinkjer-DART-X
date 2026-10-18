const CACHE_NAME = 'steinkjer-dart-x-v4'
const APP_SHELL = ['/', '/manifest.webmanifest', '/dart-mark.svg', '/logo.png']

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const response = await fetch('/')
    const html = await response.text()
    const appAssets = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)].map((match) => match[1])
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll([...APP_SHELL, ...appAssets])
  })())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
  )))
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return

  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone()
      void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy))
    }
    return response
  }).catch(async () => {
    const cached = await caches.match(event.request)
    if (cached) return cached
    if (event.request.mode === 'navigate') {
      const appShell = await caches.match('/')
      if (appShell) return appShell
    }
    throw new Error('This resource is not cached for offline use.')
  }))
})
