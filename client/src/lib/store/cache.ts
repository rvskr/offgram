// Simple TTL cache and coalescing promises for app-wide use
export type CacheEntry<T> = { v: T; exp: number }

const map = new Map<string, CacheEntry<any>>()
const inflight = new Map<string, Promise<any>>()

const now = () => Date.now()

export function getCache<T>(k: string): T | undefined {
  const e = map.get(k)
  if (!e) return undefined
  if (e.exp < now()) { map.delete(k); return undefined }
  return e.v as T
}

export function setCache<T>(k: string, v: T, ttlMs: number) {
  map.set(k, { v, exp: now() + ttlMs })
}

export async function withCache<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = getCache<T>(key)
  if (typeof hit !== 'undefined') return hit
  const inf = inflight.get(key)
  if (inf) return inf as Promise<T>
  const p = (async () => {
    try {
      const v = await fn()
      if (ttlMs > 0) setCache(key, v, ttlMs)
      return v
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

export function clearCache(prefix?: string) {
  if (!prefix) { map.clear(); return }
  for (const k of Array.from(map.keys())) if (k.startsWith(prefix)) map.delete(k)
}
