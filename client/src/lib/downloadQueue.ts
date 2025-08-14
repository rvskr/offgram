export type DownloadQueue = {
  enqueue: (dialogId: string, msgId: number, prio?: number) => void
  dispose: () => void
}

import { db, msgKey } from '../db/db'

export function createDownloadQueue(params: {
  maxConcurrency?: number
  // Obtain entity to perform download for a given dialog
  getEntity: (dialogId: string) => Promise<any | undefined>
  // Download function (entity, msgId) -> Blob | undefined
  download: (entity: any, msgId: number) => Promise<Blob | undefined>
  // Persist downloaded blob into DB
  onBlob: (dialogId: string, msgId: number, blob: Blob) => Promise<void>
}): DownloadQueue {
  const MAX = Math.max(1, params.maxConcurrency ?? 3)
  const queue: Array<{ dialogId: string; msgId: number; key: string; prio: number; ts: number }> = []
  const queued = new Set<string>()
  const inflight = new Set<string>()
  let disposed = false

  const pump = async () => {
    if (disposed) return
    while (!disposed && inflight.size < MAX && queue.length > 0) {
      // higher prio first; if equal -> newer first
      queue.sort((a, b) => (b.prio - a.prio) || (b.ts - a.ts))
      const item = queue.shift()!
      queued.delete(item.key)
      if (inflight.has(item.key)) continue
      inflight.add(item.key)
      ;(async () => {
        try {
          // Финальный барьер: пропустим, если уже есть mediaBlob в БД
          try {
            const row = await db.messages.get(msgKey(item.dialogId, item.msgId))
            if (row?.mediaBlob) return
          } catch {}
          let ent = await params.getEntity(item.dialogId)
          if (!ent) return
          const blob = await params.download(ent, item.msgId)
          if (blob) await params.onBlob(item.dialogId, item.msgId, blob)
        } catch {}
        finally {
          inflight.delete(item.key)
          if (!disposed && queue.length > 0) setTimeout(pump, 0)
        }
      })()
    }
  }

  const enqueue = (dialogId: string, msgId: number, prio = 5) => {
    if (disposed) return
    if (!dialogId) return
    const key = `${dialogId}:${msgId}`
    if (inflight.has(key) || queued.has(key)) return
    queued.add(key)
    queue.push({ dialogId, msgId, key, prio, ts: Date.now() })
    void pump()
  }

  const dispose = () => {
    disposed = true
    queue.length = 0
    queued.clear()
    inflight.clear()
  }

  return { enqueue, dispose }
}
