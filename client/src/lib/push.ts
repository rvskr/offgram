import { VAPID_PUBLIC_KEY, PUSH_BASE_URL } from '../config'
import { getBase } from './base'

function urlBase64ToUint8Array(base64String: string) {
  try {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    const rawData = atob(base64)
    const outputArray = new Uint8Array(rawData.length)
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
    return outputArray
  } catch { return undefined as any }
}

export async function ensurePushSubscription(): Promise<PushSubscription | null> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn('[push] not supported (serviceWorker/PushManager)')
      return null
    }
    if (!PUSH_BASE_URL) { console.warn('[push] no PUSH_BASE_URL'); return null }

    // Ensure permission
    if ('Notification' in window && Notification.permission === 'default') {
      console.log('[push] requesting Notification permission…')
      try { await Notification.requestPermission() } catch (e) { console.warn('[push] requestPermission error', e) }
    }
    if ('Notification' in window && Notification.permission !== 'granted') { console.warn('[push] permission not granted:', Notification.permission); return null }

    const reg = await navigator.serviceWorker.ready
    const existing = await reg.pushManager.getSubscription()
    if (existing) {
      // Try to sync subscription with server (idempotent)
      try {
        const ehash = existing.endpoint ? djb2Hash(existing.endpoint) : null
        console.log('[push] existing subscription, endpoint hash=', ehash)
        const r = await fetch(PUSH_BASE_URL + '/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(existing),
          keepalive: true,
        })
        console.log('[push] sync /subscribe status', r.status)
      } catch {}
      return existing
    }

    const applicationServerKey = VAPID_PUBLIC_KEY ? urlBase64ToUint8Array(VAPID_PUBLIC_KEY) : undefined
    console.log('[push] creating new subscription…')
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })

    try {
      const ehash = sub.endpoint ? djb2Hash(sub.endpoint) : null
      console.log('[push] new subscription endpoint hash=', ehash)
      const r = await fetch(PUSH_BASE_URL + '/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub),
        keepalive: true,
      })
      console.log('[push] POST /subscribe status', r.status)
    } catch (e) {
      console.warn('[push] failed to POST /subscribe', e)
    }
    return sub
  } catch (e) {
    console.warn('[push] ensurePushSubscription error', e)
    return null
  }
}

// Optional helper to trigger a test push from server (broadcast)
export async function triggerTestPush(): Promise<boolean> {
  if (!PUSH_BASE_URL) return false
  try {
    console.log('[push] triggerTestPush POST /push')
    const r = await fetch(PUSH_BASE_URL + '/push', { method: 'POST' })
    console.log('[push] triggerTestPush status', r.status)
    return r.ok
  } catch { return false }
}

// Return current subscription endpoint hash (or null)
export async function getCurrentSubHash(): Promise<string | null> {
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    const h = sub?.endpoint ? djb2Hash(sub.endpoint) : null
    console.log('[push] getCurrentSubHash', h)
    return h
  } catch { return null }
}

// Send targeted push via worker for current subscription
export async function pushTargeted(payload: any): Promise<boolean> {
  if (!PUSH_BASE_URL) return false
  try {
    const ehash = await getCurrentSubHash()
    if (!ehash) { console.warn('[push] pushTargeted: no sub hash'); return false }
    const body = { targets: [ehash], payload }
    console.log('[push] pushTargeted → /push', body)
    const r = await fetch(PUSH_BASE_URL + '/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    console.log('[push] pushTargeted status', r.status)
    return r.ok
  } catch (e) { console.warn('[push] pushTargeted error', e); return false }
}

// local djb2 for hashing endpoint (for logs/UI)
function djb2Hash(str: string): string {
  let h = 5381 >>> 0
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
  return 'h' + h.toString(16)
}

// Listen SW messages (navigate on notificationclick)
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
    const data: any = ev.data
    if (data && data.type === 'navigate' && typeof data.url === 'string') {
      try { window.focus() } catch {}
      try {
        // Prefer SPA navigation to avoid full reloads
        const u = new URL(data.url, window.location.origin)
        const hash = u.hash || '' // like '#/dialog/123'
        const m = hash.match(/#\/?dialog\/(.+)$/)
        if (m && m[1]) {
          const id = decodeURIComponent(m[1])
          const base = getBase()
          const listUrl = `${base}#/`
          const chatUrl = `${base}#/dialog/${encodeURIComponent(id)}`
          // Ensure a list entry before chat, so Back returns to dialogs list
          try { history.pushState({ view: 'chat' }, '', listUrl) } catch {}
          try { history.pushState({ view: 'chat', id }, '', chatUrl) } catch {}
          // Notify app via popstate to sync state
          try { window.dispatchEvent(new PopStateEvent('popstate', { state: { view: 'chat', id } as any })) } catch {}
          return
        }
        // Fallback: change only hash within same page (still no reload)
        try {
          const next = data.url.startsWith(window.location.origin)
            ? data.url.substring(window.location.origin.length)
            : data.url
          history.pushState({}, '', next)
          window.dispatchEvent(new PopStateEvent('popstate', { state: {} as any }))
        } catch {
          // Last resort: full redirect
          window.location.href = data.url
        }
      } catch {
        try { window.location.href = data.url } catch {}
      }
    }
  })
}
