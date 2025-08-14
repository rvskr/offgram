import {
  searchContacts as tgSearchContacts,
  searchGlobalMessages as tgSearchGlobalMessages,
  getDialogNotifySettings as tgGetDialogNotifySettings,
  downloadPeerAvatarSmall as tgDownloadPeerAvatarSmall,
  getHistory as tgGetHistory,
  getMoreHistory as tgGetMoreHistory,
  resolvePeerEntityTitle,
  type GlobalMessageHit,
  type SearchPeer,
} from '../telegramClient'
import { withCache } from './cache'

// Re-export types for UI convenience
export type { GlobalMessageHit, SearchPeer }

// Cached wrappers (short TTL) to reduce duplicate calls from UI
export async function searchContacts(q: string, limit = 30) {
  return withCache(`store:contacts:${q}:${limit}`, 30_000, () => tgSearchContacts(q, limit))
}

export async function searchGlobalMessages(q: string, limit = 20) {
  return withCache(`store:searchGlobal:${q}:${limit}`, 30_000, () => tgSearchGlobalMessages(q, limit))
}

export async function getDialogNotifySettings(entity: any) {
  // 10 minutes cache; invalidated implicitly when toggled in app via UpdateNotifySettings updates
  const key = `store:notify:${String(entity?.id ?? 'x')}`
  return withCache(key, 10 * 60_000, () => tgGetDialogNotifySettings(entity))
}

export async function downloadPeerAvatarSmall(entity: any) {
  // Avatары уже кэшируются по photoId в telegramClient, но добавим тонкий общий кэш-ключ
  const key = `store:ava:${String(entity?.id ?? 'x')}`
  return withCache(key, 60_000, () => tgDownloadPeerAvatarSmall(entity))
}

export async function getEntityTitle(rawId: any) {
  return withCache(`store:entitle:${String(typeof rawId === 'object' ? JSON.stringify(rawId) : rawId)}`, 60_000, () => resolvePeerEntityTitle(rawId))
}

// History wrappers (short TTL ~ 5s) для коалесинга частых вызовов
// Single-flight, throttle и централизованный бэкофф на FloodWait
const inflight = new Map<string, Promise<any>>()
const lastPeerCallAt = new Map<string | number, number>()
let globalFloodUntil = 0

async function withSingleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>
  const p = (async () => {
    try {
      return await fn()
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

async function withPeerThrottle<T>(peerKey: string | number, minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const last = lastPeerCallAt.get(peerKey) ?? 0
  const delta = now - last
  if (delta < minIntervalMs) {
    await new Promise(res => setTimeout(res, minIntervalMs - delta))
  }
  try {
    return await fn()
  } finally {
    lastPeerCallAt.set(peerKey, Date.now())
  }
}

async function withFloodBackoff<T>(peerKey: string | number, fn: () => Promise<T>): Promise<T> {
  // Глобальная пауза, если недавно словили FloodWait где-либо
  const now = Date.now()
  if (globalFloodUntil > now) {
    await new Promise(res => setTimeout(res, Math.min(2_000, globalFloodUntil - now)))
  }
  try {
    return await fn()
  } catch (e: any) {
    const sec = Number((e && (e.seconds ?? e.duration ?? e.wait ?? undefined)))
    if (sec && isFinite(sec) && sec > 0) {
      // Обновляем глобальный бэкофф и добавим небольшой запас
      globalFloodUntil = Date.now() + (sec * 1000) + 300
    }
    throw e
  }
}

export async function getHistory(entity: any, limit = 10, offsetId?: number) {
  const peerKey = String(entity?.id ?? entity)
  const key = `store:hist:${peerKey}:${limit}:${offsetId ?? 0}`
  // Short TTL cache to coalesce close repeats
  return withCache(key, 5_000, () =>
    withSingleFlight(key, () =>
      withFloodBackoff(peerKey, () =>
        withPeerThrottle(peerKey, 2_500, () => tgGetHistory(entity, limit, offsetId))
      )
    )
  )
}

export async function getMoreHistory(entity: any, oldestMsgId?: number, pageSize = 50) {
  const peerKey = String(entity?.id ?? entity)
  const key = `store:hist-more:${peerKey}:${oldestMsgId ?? 0}:${pageSize}`
  return withCache(key, 5_000, () =>
    withSingleFlight(key, () =>
      withFloodBackoff(peerKey, () =>
        withPeerThrottle(peerKey, 2_500, () => tgGetMoreHistory(entity, oldestMsgId, pageSize))
      )
    )
  )
}
