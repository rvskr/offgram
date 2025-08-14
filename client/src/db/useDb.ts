import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type DBDialog, type DBMessage, type DBUser } from './db'

export function useDialogs(query: { search?: string } = {}) {
  const { search } = query
  return useLiveQuery(async () => {
    let list: DBDialog[] = await db.dialogs.toArray()
    // Order: pinned first, then by lastMessageAt desc
    list.sort((a, b) => {
      const ap = a.pinned ? 1 : 0
      const bp = b.pinned ? 1 : 0
      if (ap !== bp) return bp - ap
      const at = a.lastMessageAt ?? 0
      const bt = b.lastMessageAt ?? 0
      if (bt !== at) return bt - at
      // fallback by title
      return (a.title || '').localeCompare(b.title || '')
    })
    if (search && search.trim()) {
      const s = search.trim().toLowerCase()
      return list.filter((d) => d.title.toLowerCase().includes(s))
    }
    return list
  }, [search], []) as DBDialog[]
}

export function useMessages(dialogId?: string) {
  const result = useLiveQuery(async () => {
    if (!dialogId) return [] as DBMessage[]
    const list = await db.messages.where('dialogId').equals(dialogId).sortBy('msgId')
    return list.map(m => ({ ...m })) as DBMessage[]
  }, [dialogId], undefined) as DBMessage[] | undefined
  const [stable, setStable] = useState<DBMessage[]>([])
  // Сброс при смене диалога
  useEffect(() => { setStable([]) }, [dialogId])
  useEffect(() => {
    if (Array.isArray(result)) setStable(result)
  }, [result])
  return dialogId ? stable : []
}

export function useUsers() {
  const result = useLiveQuery(async () => db.users.toArray(), [], undefined) as DBUser[] | undefined
  const [stable, setStable] = useState<DBUser[]>([])
  useEffect(() => {
    if (Array.isArray(result)) setStable(result)
  }, [result])
  return stable
}

// Возвращает только последние N сообщений из кэша (IndexedDB) для быстрого рендера «хвоста» чата
export function useMessagesWindow(dialogId?: string, opts?: { limit?: number }) {
  const limit = Math.max(1, Number(opts?.limit ?? 10))
  const result = useLiveQuery(async () => {
    if (!dialogId) return [] as DBMessage[]
    // Берём все сообщения для диалога, сортируем по msgId и оставляем хвост из N элементов
    const all = await db.messages.where('dialogId').equals(dialogId).sortBy('msgId')
    const tail = all.slice(Math.max(0, all.length - limit))
    return tail.map((m: DBMessage) => ({ ...m })) as DBMessage[]
  }, [dialogId, limit], undefined) as DBMessage[] | undefined
  const [stable, setStable] = useState<DBMessage[]>([])
  useEffect(() => { setStable([]) }, [dialogId])
  useEffect(() => {
    if (Array.isArray(result)) setStable(result)
  }, [result])
  return dialogId ? stable : []
}
