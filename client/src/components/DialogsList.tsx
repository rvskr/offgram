import { useEffect, useMemo, useRef, useState } from 'react'
import type { DBDialog } from '../db/db'
import { db } from '../db/db'
import { searchContacts, searchGlobalMessages, downloadPeerAvatarSmall, getDialogNotifySettings, type GlobalMessageHit, type SearchPeer } from '../lib/store/store'
import { getInitials } from '../lib/ui'

export default function DialogsList({ dialogs, hasMore, onLoadMore, activeId, onSelect, onOpenSettings, onTogglePin, onToggleMute, onDeleteHistory, onDeleteForAll, onClearCache, getEntity }: {
  dialogs: DBDialog[]
  hasMore?: boolean
  onLoadMore?: () => void
  activeId?: string
  onSelect: (id: string, entity?: any) => void
  onOpenSettings?: () => void
  onTogglePin?: (id: string, wantPin: boolean) => void
  onToggleMute?: (id: string, mute: boolean) => void
  onDeleteHistory?: (id: string) => void
  onDeleteForAll?: (id: string) => void
  onClearCache?: (id: string) => void
  getEntity?: (id: string) => Promise<any>
}) {
  const [search, setSearch] = useState('')
  const [searchPeers, setSearchPeers] = useState<SearchPeer[] | null>(null)
  const [searchMsgs, setSearchMsgs] = useState<GlobalMessageHit[] | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const savedScrollRef = useRef<number>(0)
  const debRef = useRef<number | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [muteById, setMuteById] = useState<Map<string, boolean>>(new Map())
  const requestedMuteRef = useRef<Set<string>>(new Set())
  const longPressRef = useRef<number | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const arr = dialogs.filter(d => !q || (d.title || d.id).toLowerCase().includes(q))
    arr.sort((a, b) => {
      const ap = a.pinned === true, bp = b.pinned === true
      if (ap !== bp) return ap ? -1 : 1 // pinned first
      if (ap && bp) {
        const ar = (a as any).pinRank
        const br = (b as any).pinRank
        if (typeof ar === 'number' && typeof br === 'number' && ar !== br) return ar - br
      }
      const ad = a.lastMessageAt ?? 0, bd = b.lastMessageAt ?? 0
      if (ad !== bd) return bd - ad // newest first for others
      const at = (a.title || '').toLowerCase()
      const bt = (b.title || '').toLowerCase()
      return at.localeCompare(bt)
    })
    return arr
  }, [dialogs, search])

  // Сохранение/восстановление позиции прокрутки — чтобы не дёргался список при апдейтах
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => { savedScrollRef.current = el.scrollTop }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const top = savedScrollRef.current
    requestAnimationFrame(() => { el.scrollTop = top })
  }, [filtered.length])

  // Подтянем аватарки из users для диалогов вида kind==='user', если у диалога нет avatarSmall
  const [userAvatars, setUserAvatars] = useState<Map<string, string | undefined>>(new Map())
  const [brokenAvatars, setBrokenAvatars] = useState<Set<string>>(new Set())
  // Стабильный ключ по видимым user-id, чтобы не триггерить эффект без фактических изменений
  const visibleUserKey = useMemo(() => (
    filtered.filter(d => d.kind === 'user').map(d => d.id).sort().join(',')
  ), [filtered])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (search.trim()) return // не тянем аватары диалогов, когда включён поиск
      const entries: Array<[string, string | undefined]> = []
      const ids = visibleUserKey ? visibleUserKey.split(',') : []
      for (const id of ids) {
        try {
          const u = await db.users.get(id)
          entries.push([id, (u as any)?.avatarSmall as string | undefined])
        } catch {
          entries.push([id, undefined])
        }
      }
      if (cancelled) return
      setUserAvatars(prev => {
        let changed = false
        const next = new Map(prev)
        for (const [id, url] of entries) {
          if (next.get(id) !== url) { next.set(id, url); changed = true }
        }
        return changed ? next : prev
      })
    })()
    return () => { cancelled = true }
  }, [visibleUserKey, search])

  // initials now comes from shared util getInitials
  const closeMenu = () => setMenuFor(null)
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest?.('[data-dialog-menu]')) setMenuFor(null)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [])

  // Load notification status when menu opens for a dialog
  useEffect(() => {
    (async () => {
      const id = menuFor
      if (!id) return
      if (muteById.has(id)) return
      try {
        const ent = await getEntity?.(id)
        if (!ent) return
        const s = await getDialogNotifySettings(ent)
        setMuteById(prev => {
          const next = new Map(prev)
          next.set(id, !!s.muted)
          return next
        })
        // persist в БД для восстановления
        try { await db.dialogs.update(id, { muted: !!s.muted } as any) } catch {}
      } catch {}
    })()
  }, [menuFor])

  // Prefetch notification status for visible dialogs to show instantly
  useEffect(() => {
    if (search.trim()) return
    // Возьмём ограниченный срез видимых элементов (например, первые 40)
    const batch = filtered.slice(0, 40)
    ;(async () => {
      for (const d of batch) {
        const id = d.id
        // сперва пробуем локальный кэш из БД
        try {
          const item = await db.dialogs.get(id)
          const cached = (item as any)?.muted
          if (typeof cached === 'boolean' && !muteById.has(id)) {
            setMuteById(prev => {
              const next = new Map(prev)
              if (!next.has(id)) next.set(id, cached)
              return next
            })
          }
        } catch {}
        if (muteById.has(id)) continue
        if (requestedMuteRef.current.has(id)) continue
        requestedMuteRef.current.add(id)
        try {
          const ent = await getEntity?.(id)
          if (!ent) continue
          const s = await getDialogNotifySettings(ent)
          setMuteById(prev => {
            const next = new Map(prev)
            if (!next.has(id)) next.set(id, !!s.muted)
            return next
          })
          // persist в БД для восстановления после перезагрузки
          try { await db.dialogs.update(id, { muted: !!s.muted } as any) } catch {}
        } catch {}
      }
    })()
  }, [filtered, search, getEntity])

  // Debounced global search
  useEffect(() => {
    const q = search.trim()
    if (!q) {
      setSearchPeers(null)
      setSearchMsgs(null)
      setSearchLoading(false)
      return
    }
    setSearchLoading(true)
    if (debRef.current) window.clearTimeout(debRef.current)
    debRef.current = window.setTimeout(async () => {
      try {
        const [peers, msgs] = await Promise.all([
          searchContacts(q, 30),
          searchGlobalMessages(q, 20),
        ])
        setSearchPeers(peers)
        setSearchMsgs(msgs)
      } catch {
        setSearchPeers([])
        setSearchMsgs([])
      } finally {
        setSearchLoading(false)
      }
    }, 300)
    return () => {
      if (debRef.current) window.clearTimeout(debRef.current)
    }
  }, [search])

  // Infinite scroll via sentinel (более надёжно)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const loadLockRef = useRef(false)
  useEffect(() => {
    if (search.trim()) return
    if (!hasMore || !onLoadMore) return
    const root = scrollRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel) return
    const tryLoad = async () => {
      if (loadLockRef.current) return
      if (!hasMore || !onLoadMore) return
      loadLockRef.current = true
      try {
        await onLoadMore()
      } finally {
        loadLockRef.current = false
      }
      // Если после загрузки sentinel всё ещё виден — подгружаем дальше без жеста пользователя
      const r = root.getBoundingClientRect()
      const s = sentinel.getBoundingClientRect()
      const intersects = s.top <= r.bottom && s.bottom >= r.top
      if (intersects && hasMore) {
        // Дадим layout примениться и продолжаем цепочку
        setTimeout(() => { void tryLoad() }, 0)
      }
    }
    const io = new IntersectionObserver(async (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          void tryLoad()
        }
      }
    }, { root, rootMargin: '400px', threshold: 0 })
    io.observe(sentinel)
    return () => io.disconnect()
  }, [hasMore, onLoadMore, search])

  // Если контента меньше высоты контейнера — автодогружаем, чтобы пользователь сразу видел много элементов
  useEffect(() => {
    if (search.trim()) return
    if (!hasMore || !onLoadMore) return
    const root = scrollRef.current
    if (!root) return
    let cancelled = false
    ;(async () => {
      // максимум 8 итераций за один проход, чтобы не зациклиться
      for (let i = 0; i < 8; i++) {
        if (cancelled) return
        if (loadLockRef.current) break
        const needMore = root.scrollHeight <= root.clientHeight
        if (!needMore) break
        loadLockRef.current = true
        try { await onLoadMore() } catch {} finally { loadLockRef.current = false }
        // дадим layout примениться
        await new Promise(r => setTimeout(r, 0))
        if (!hasMore) break
      }
    })()
    return () => { cancelled = true }
  }, [filtered.length, hasMore, onLoadMore, search])

  // Lazy-load avatars for visible dialog items (main list, not search)
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map())
  const inflightRef = useRef<Set<string>>(new Set())
  // Очередь и семафор для ограничения одновременных загрузок аватаров
  const queueRef = useRef<string[]>([])
  const runningRef = useRef(0)
  const disposedRef = useRef(false)
  const AVA_MAX_CONCURRENCY = 2
  useEffect(() => {
    if (search.trim()) return // не трогаем при поиске
    const root = scrollRef.current
    if (!root) return
    disposedRef.current = false

    const pump = async () => {
      if (disposedRef.current) return
      while (!disposedRef.current && runningRef.current < AVA_MAX_CONCURRENCY && queueRef.current.length > 0) {
        const id = queueRef.current.shift()!
        if (!id) break
        if (inflightRef.current.has(id)) continue
        runningRef.current++
        inflightRef.current.add(id)
        ;(async () => {
          try {
            const dlg = dialogs.find(d => d.id === id)
            const fallback = dlg?.kind === 'user' ? userAvatars.get(id) : undefined
            const hasAny = !!(dlg?.avatarSmall || fallback)
            if (hasAny) return
            const ent = await getEntity?.(id)
            if (!ent) return
            const url = await downloadPeerAvatarSmall(ent)
            if (!url) return
            await db.dialogs.update(id, { avatarSmall: url })
            try { await db.users.update(id, { avatarSmall: url } as any) } catch {}
            setUserAvatars(prev => {
              const next = new Map(prev)
              next.set(id, url)
              return next
            })
          } catch {}
          finally {
            inflightRef.current.delete(id)
            runningRef.current--
            if (!disposedRef.current && queueRef.current.length > 0) setTimeout(pump, 0)
          }
        })()
      }
    }

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const id = (e.target as HTMLElement).dataset.dialogId
        if (!id) continue
        const dlg = dialogs.find(d => d.id === id)
        const fallback = dlg?.kind === 'user' ? userAvatars.get(id) : undefined
        const hasAny = !!(dlg?.avatarSmall || fallback)
        if (hasAny) { io.unobserve(e.target); continue }
        if (inflightRef.current.has(id)) { io.unobserve(e.target); continue }
        // ставим в очередь только видимые элементы
        queueRef.current.push(id)
        io.unobserve(e.target)
      }
      // запустим насос после батча событий
      setTimeout(pump, 0)
    }, { root, rootMargin: '50px', threshold: 0.1 })
    // Подписываемся на элементы без аватара
    for (const d of filtered) {
      const el = rowRefs.current.get(d.id)
      if (!el) continue
      const fallback = d.kind === 'user' ? userAvatars.get(d.id) : undefined
      if (d.avatarSmall || fallback) continue
      io.observe(el)
    }
    return () => { io.disconnect(); disposedRef.current = true; queueRef.current.length = 0; runningRef.current = 0 }
  }, [filtered, dialogs, search, getEntity, userAvatars])

  // Avatars for search peers (reuse cache; fetch from network if missing)
  const [searchAvatars, setSearchAvatars] = useState<Map<string, string | undefined>>(new Map())
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!searchPeers || !searchPeers.length) return
      const uniqueIds = Array.from(new Set(searchPeers.map(p => p.id)))
      const pairs: Array<[string, string | undefined]> = []
      for (const id of uniqueIds) {
        try {
          const d = await db.dialogs.get(id)
          const u = await db.users.get(id)
          pairs.push([id, (d as any)?.avatarSmall || (u as any)?.avatarSmall])
        } catch {
          pairs.push([id, undefined])
        }
      }
      if (cancelled) return
      setSearchAvatars(prev => {
        const next = new Map(prev)
        for (const [id, url] of pairs) next.set(id, url)
        return next
      })

      // Fetch missing from network with small concurrency
      const need = uniqueIds.filter(id => !pairs.find(([pid, url]) => pid === id && url))
      if (!need.length) return
      const byId = new Map(searchPeers.map(p => [p.id, p]))
      const CONC = 3
      let idx = 0
      await Promise.all(new Array(Math.min(CONC, need.length)).fill(0).map(async () => {
        while (idx < need.length) {
          const id = need[idx++]!
          const peer = byId.get(id)
          const ent = peer?.entity as any
          if (!ent) continue
          try {
            const dataUrl = await downloadPeerAvatarSmall(ent)
            if (!dataUrl) continue
            if (cancelled) return
            setSearchAvatars(prev => {
              const next = new Map(prev)
              next.set(id, dataUrl)
              return next
            })
            // Persist best-effort
            try {
              const dlg = await db.dialogs.get(id)
              if (dlg) await db.dialogs.update(id, { avatarSmall: dataUrl })
              else await db.users.update(id, { avatarSmall: dataUrl } as any)
            } catch {}
          } catch {}
        }
      }))
    })()
    return () => { cancelled = true }
  }, [searchPeers])

  return (
    <div ref={scrollRef} className="w-full h-full flex flex-col overflow-auto">
      <div className="p-3 border-b border-gray-200">
        <div className="font-semibold">Диалоги</div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск"
          className="w-full mt-2 px-3 py-2 border border-gray-300 rounded text-sm"
        />
      </div>
      {/* Search results */}
      {search.trim() ? (
        <div className="divide-y divide-gray-100">
          {searchLoading && (
            <div className="p-3 text-sm text-gray-400">Поиск...</div>
          )}
          {!!(searchPeers?.length) && (
            <div className="p-2 text-xs text-gray-500">Пользователи и чаты</div>
          )}
          {searchPeers?.map(p => (
            <div
              key={`peer:${p.id}`}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.id, p.entity) } }}
              onClick={() => onSelect(p.id, p.entity)}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-50 ${activeId === p.id ? 'bg-gray-100' : ''}`}
            >
              {(() => {
                const src = searchAvatars.get(p.id)
                if (src && !brokenAvatars.has(p.id)) {
                  return (
                    <img
                      src={src}
                      alt={p.title || p.id}
                      className="w-10 h-10 rounded-full object-cover"
                      onError={() => {
                        setBrokenAvatars(prev => {
                          const next = new Set(prev)
                          next.add(p.id)
                          return next
                        })
                      }}
                    />
                  )
                }
                return (
                  <div className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-semibold">
                    {getInitials(p.title || p.id)}
                  </div>
                )
              })()}
              <div className="min-w-0">
                <div className="font-medium truncate">{p.title || p.id}</div>
                <div className="text-xs text-gray-400">{p.isUser ? 'Пользователь' : p.isChannel ? 'Канал' : 'Чат'}</div>
              </div>
            </div>
          ))}
          {!!(searchMsgs?.length) && (
            <div className="p-2 text-xs text-gray-500">Сообщения</div>
          )}
          {searchMsgs?.map(h => (
            <div
              key={`msg:${h.dialogId}:${h.msgId}`}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(h.dialogId) } }}
              onClick={() => onSelect(h.dialogId)}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-50 ${activeId === h.dialogId ? 'bg-gray-100' : ''}`}
            >
              <div className="w-10 h-10 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center text-sm font-semibold">
                🔎
              </div>
              <div className="min-w-0">
                <div className="font-medium truncate">{dialogs.find(d => d.id === h.dialogId)?.title || h.dialogId}</div>
                <div className="text-xs text-gray-500 truncate">{h.text || 'Сообщение'}</div>
              </div>
            </div>
          ))}
          {!searchLoading && !((searchPeers?.length ?? 0) + (searchMsgs?.length ?? 0)) && (
            <div className="p-3 text-sm text-gray-400">Ничего не найдено</div>
          )}
        </div>
      ) : (
        <div className="divide-y divide-gray-100">
          <div className="p-2 flex items-center justify-between">
            <div className="text-xs text-gray-500">Диалоги</div>
            <button
              className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
              onClick={() => onOpenSettings?.()}
            >Настройки</button>
          </div>
          {filtered.map(d => (
            <div
              key={d.id}
              ref={(el) => { if (el) rowRefs.current.set(d.id, el); else rowRefs.current.delete(d.id) }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(d.id) } }}
              onClick={() => onSelect(d.id)}
              className={`w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-50 ${activeId === d.id ? 'bg-gray-100' : ''}`}
              data-dialog-id={d.id}
              onMouseEnter={async () => {
                if (!getEntity) return
                if (muteById.has(d.id)) return
                if (requestedMuteRef.current.has(d.id)) return
                requestedMuteRef.current.add(d.id)
                try {
                  const ent = await getEntity(d.id)
                  if (!ent) return
                  const s = await getDialogNotifySettings(ent)
                  setMuteById(prev => {
                    const next = new Map(prev)
                    next.set(d.id, !!s.muted)
                    return next
                  })
                } catch {}
              }}
              onMouseDown={() => {
                if (longPressRef.current) window.clearTimeout(longPressRef.current)
                longPressRef.current = window.setTimeout(() => setMenuFor(d.id), 500)
              }}
              onMouseUp={() => { if (longPressRef.current) window.clearTimeout(longPressRef.current) }}
              onMouseLeave={() => { if (longPressRef.current) window.clearTimeout(longPressRef.current) }}
            >
              {(() => {
                const fallback = d.kind === 'user' ? userAvatars.get(d.id) : undefined
                const src = d.avatarSmall || fallback
                if (src && !brokenAvatars.has(d.id)) {
                  return (
                    <img
                      src={src}
                      alt={d.title || d.id}
                      className="w-10 h-10 rounded-full object-cover"
                      onError={() => {
                        setBrokenAvatars(prev => {
                          const next = new Set(prev)
                          next.add(d.id)
                          return next
                        })
                      }}
                    />
                  )
                }
                return (
                  <div className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-semibold">
                    {getInitials(d.title || d.id)}
                  </div>
                )
              })()}
              <div className="min-w-0">
                <div className="font-medium truncate flex items-center gap-2">
                  <span className="truncate">{d.title || d.id}</span>
                  {d.pinned && (
                    <span title="Закреплено" className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px]">
                      <span aria-hidden>📌</span>
                      <span>закреплён</span>
                    </span>
                  )}
                  {(muteById.get(d.id) ?? (d as any)?.muted) && (
                    <span title="Уведомления выключены" className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[10px]">
                      <span aria-hidden>🔕</span>
                      <span>без звука</span>
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {(() => {
                    const has = (d as any).lastPreview && typeof (d as any).lastPreview === 'string'
                    if (!has) return ''
                    const you = (d as any).lastOut === true ? 'Вы: ' : ''
                    const from = (d as any).lastFromName && !(d as any).lastOut ? `${(d as any).lastFromName}: ` : ''
                    return `${you || from}${(d as any).lastPreview as string}`
                  })()}
                </div>
              </div>
              <div className="ml-auto relative" data-dialog-menu>
                <button
                  className="w-8 h-8 flex items-center justify-center text-gray-500 hover:text-gray-700"
                  onClick={(e) => { e.stopPropagation(); setMenuFor(prev => prev === d.id ? null : d.id) }}
                  aria-label="Меню"
                >⋮</button>
                {menuFor === d.id && (
                  <div className="absolute right-0 top-9 z-10 w-48 bg-white border border-gray-200 rounded shadow-md py-1" data-dialog-menu>
                    <button className="w-full text-left px-3 py-2 hover:bg-gray-50" onClick={(e) => { e.stopPropagation(); onTogglePin?.(d.id, !(d.pinned === true)); closeMenu() }}>{d.pinned ? 'Открепить' : 'Закрепить'}</button>
                    <button className="w-full text-left px-3 py-2 hover:bg-gray-50" onClick={async (e) => {
                      e.stopPropagation()
                      const curr = (muteById.get(d.id) ?? (d as any)?.muted) === true
                  // toggle to opposite
                  onToggleMute?.(d.id, !curr)
                  // optimistic UI
                  setMuteById(prev => {
                    const next = new Map(prev)
                    next.set(d.id, !curr)
                    return next
                  })
                  // persist optimistic value
                  try { await db.dialogs.update(d.id, { muted: !curr } as any) } catch {}
                  closeMenu()
                }}>{muteById.get(d.id) ? 'Включить уведомления' : 'Выключить уведомления'}</button>
                    <div className="h-px bg-gray-100 my-1" />
                    <button className="w-full text-left px-3 py-2 hover:bg-gray-50 text-red-600" onClick={(e) => { e.stopPropagation(); if (confirm('Очистить историю чата?')) onDeleteHistory?.(d.id); closeMenu() }}>Очистить историю</button>
                    <button className="w-full text-left px-3 py-2 hover:bg-gray-50 text-red-600" onClick={(e) => { e.stopPropagation(); if (confirm('Удалить чат для всех (если доступно)?')) onDeleteForAll?.(d.id); closeMenu() }}>Удалить чат</button>
                    <button className="w-full text-left px-3 py-2 hover:bg-gray-50" onClick={(e) => { e.stopPropagation(); if (confirm('Очистить локальный кэш чата?')) onClearCache?.(d.id); closeMenu() }}>Очистить кэш чата</button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {hasMore && (
            <div className="p-3 text-center text-sm text-gray-400">Прокрутите вниз для подгрузки...</div>
          )}
          <div ref={sentinelRef} className="h-1" />
          {!filtered.length && (
            <div className="text-gray-400 p-3">Нет диалогов</div>
          )}
        </div>
      )}
    </div>
  )
}
