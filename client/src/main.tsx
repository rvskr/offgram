import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Buffer } from 'buffer'
import process from 'process/browser'
import App from './App'
import { ensurePushSubscription } from './lib/push'
import { VAPID_PUBLIC_KEY, PUSH_BASE_URL } from './config'
import { getBase } from './lib/base'

// Ensure Node-like globals for GramJS in browser
if (!(globalThis as any).global) (globalThis as any).global = globalThis
if (!(globalThis as any).Buffer) (globalThis as any).Buffer = Buffer
if (!(globalThis as any).process) (globalThis as any).process = process as any

// Ensure we are under the correct base path (useful on GitHub Pages and preview)
(() => {
  try {
    const base = getBase()
    if (base !== '/' && !window.location.pathname.startsWith(base)) {
      // Preserve current hash route
      const hash = window.location.hash || '#/'
      window.location.replace(base + hash)
    }
  } catch {}
})()

// Register Service Worker and request Notifications
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const base = getBase()
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).then(async (reg) => {
      // Передадим конфиг в SW (для pushsubscriptionchange)
      const sendCfg = () => {
        try {
          const msg = { type: 'push-config', baseUrl: PUSH_BASE_URL, vapid: VAPID_PUBLIC_KEY }
          if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage(msg)
          else if (reg.active) reg.active.postMessage(msg)
        } catch {}
      }
      // сразу и при смене контроллера
      sendCfg()
      navigator.serviceWorker.addEventListener('controllerchange', sendCfg)
      // Try to subscribe if config is provided
      ensurePushSubscription().catch(() => {})
    }).catch(() => {})
  })
}

async function ensureNotificationPermission() {
  try {
    if (!('Notification' in window)) return
    if (Notification.permission === 'default') {
      await Notification.requestPermission()
    }
  } catch {}
}
ensureNotificationPermission()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
