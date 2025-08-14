self.addEventListener('install', (event) => {
  console.log('[sw] install')
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  console.log('[sw] activate')
  event.waitUntil(self.clients.claim())
})

// Runtime config from page (PUSH_BASE_URL, VAPID_PUBLIC_KEY)
let __PUSH_CFG__ = { baseUrl: '', vapid: '' }

// Show notification from push payload
self.addEventListener('push', (event) => {
  const log = (...a) => console.log('[sw] push', ...a)
  let payload = null
  let text = null
  const hasData = !!event.data
  try {
    if (event.data) {
      try { payload = event.data.json() }
      catch (e1) { try { text = event.data.text() } catch (e2) {} }
    }
  } catch (e) { log('json parse error', e?.message || e) }
  log('event', { hasData, payload, textLen: text ? (''+text).length : 0 })
  event.waitUntil((async () => {
    try {
      // If no payload in push, try to fetch last payload from server (by this subscription hash)
      if (!payload && !text && __PUSH_CFG__.baseUrl) {
        try {
          const sub = await self.registration.pushManager.getSubscription()
          if (sub && sub.endpoint) {
            const ehash = djb2Hash(sub.endpoint)
            log('fetching /last for', ehash)
            const r = await fetch(`${__PUSH_CFG__.baseUrl}/last?e=${encodeURIComponent(ehash)}`, { cache: 'no-store' })
            if (r.ok) {
              const j = await r.json()
              log('fetched /last ok, hasPayload=', !!(j && j.payload))
              if (j && j.payload) payload = j.payload
            } else {
              log('fetch /last status', r.status)
            }
          }
        } catch (e) { log('fetch last failed', e) }
      }

      const DEFAULT_BODY = 'У вас новое сообщение'
      const title = payload?.title || 'Новое сообщение'
      const bodyRaw = payload?.body || (text || DEFAULT_BODY)
      const icon = payload?.icon || '/tg.svg'
      const tag = payload?.tag || `push:auto:${Date.now()}`
      const data = {
        url: payload?.url || null,
        dialogId: payload?.dialogId || null,
        text: bodyRaw,
        source: 'push',
        via: 'cloudflare-worker'
      }
      // Keep title as-is; only control body visibility
      const rawSnippet = String(bodyRaw || '').trim()
      const hasRealSnippet = rawSnippet && rawSnippet !== DEFAULT_BODY
      const options = {
        body: hasRealSnippet ? bodyRaw : '',
        icon,
        tag,
        renotify: true,
        timestamp: Date.now(),
        requireInteraction: false,
        silent: false,
        data
      }
      log('showNotification', { title, bodyLen: (hasRealSnippet ? (bodyRaw||'').length : 0), hasUrl: !!options?.data?.url })
      await self.registration.showNotification(title, options)
      log('notification shown')
    } catch (e) {
      // Fallback без payload
      console.error('[sw] push handler error, fallback', e)
      const title = 'Новое сообщение'
      const body = 'У вас новое сообщение'
      const options = {
        body,
        icon: '/tg.svg',
        tag: `push:auto:${Date.now()}`,
        renotify: true,
        timestamp: Date.now(),
        requireInteraction: true,
        data: { text: body, source: 'push', via: 'cloudflare-worker' }
      }
      await self.registration.showNotification(title, options)
    }
  })())
})

// Receive messages (optional)
self.addEventListener('message', (event) => {
  console.log('[sw] message', event && event.data)
  const data = event.data || {}
  if (data && data.type === 'push-config') {
    if (typeof data.baseUrl === 'string') __PUSH_CFG__.baseUrl = data.baseUrl
    if (typeof data.vapid === 'string') __PUSH_CFG__.vapid = data.vapid
    console.log('[sw] config set', __PUSH_CFG__)
    return
  }
  if (data && data.type === 'show-notification' && self.registration?.showNotification) {
    const { title, options } = data
    console.log('[sw] show-notification', { title, options })
    self.registration.showNotification(title, options)
  }
})

self.addEventListener('notificationclick', (event) => {
  console.log('[sw] notificationclick', event && event.notification && event.notification.data)
  event.notification.close()
  let url = event.notification?.data && event.notification.data.url
  // Fallback: build URL from dialogId if no explicit url provided
  try {
    if (!url) {
      const did = event?.notification?.data && event.notification.data.dialogId
      if (did) {
        // self.registration.scope ends with base path (e.g. https://host/offgram/)
        const base = (self.registration && self.registration.scope) ? self.registration.scope : '/'
        url = `${base}#/dialog/${did}`
      }
    }
  } catch {}
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })
    const client = all.find(c => 'focus' in c)
    if (client) {
      client.focus()
      if (url) client.postMessage({ type: 'navigate', url })
    } else if (url) {
      console.log('[sw] openWindow', url)
      self.clients.openWindow(url)
    }
  })())
})

// Auto re-subscribe if the push subscription is changed/invalidated
self.addEventListener('pushsubscriptionchange', (event) => {
  console.warn('[sw] pushsubscriptionchange — attempting re-subscribe', __PUSH_CFG__)
  event.waitUntil((async () => {
    try {
      const appServerKey = __PUSH_CFG__.vapid
        ? urlBase64ToUint8Array(__PUSH_CFG__.vapid)
        : undefined
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey,
      })
      console.log('[sw] re-subscribed ok, endpoint hash=', sub?.endpoint ? djb2Hash(sub.endpoint) : null)
      if (__PUSH_CFG__.baseUrl) {
        const r = await fetch(__PUSH_CFG__.baseUrl + '/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(sub),
          keepalive: true,
        })
        console.log('[sw] re-subscribe POST /subscribe', r.status)
      }
    } catch (e) { console.error('[sw] re-subscribe error', e) }
  })())
})

// Helpers
function urlBase64ToUint8Array(base64String) {
  try {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = atob(base64)
    const outputArray = new Uint8Array(rawData.length)
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
    return outputArray
  } catch { return undefined }
}

// Simple djb2 hash to match worker side for endpoint keying
function djb2Hash(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i)
  // return hex string prefix similar to worker
  return 'h' + (h >>> 0).toString(16)
}
