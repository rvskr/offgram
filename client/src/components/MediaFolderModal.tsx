import { useEffect, useMemo, useRef, useState } from 'react'
import type { DBMessage } from '../db/db'

export type MediaFolderModalProps = {
  open: boolean
  items: DBMessage[]
  onClose: () => void
  onOpenItem: (filteredItems: DBMessage[], startIndex: number) => void
  onRequestFile?: (msgId: number) => Promise<void> | void
}

const CATEGORIES = [
  { key: 'all', label: 'Все' },
  { key: 'photos', label: 'Фото' },
  { key: 'videos', label: 'Видео' },
  { key: 'gifs', label: 'GIF' },
  { key: 'audio', label: 'Аудио' },
  { key: 'voice', label: 'Голос' },
  { key: 'files', label: 'Файлы' },
  { key: 'links', label: 'Ссылки' },
] as const

export type CategoryKey = typeof CATEGORIES[number]['key']

// Cache object URLs per message+kind with size/mime guards to prevent flicker on updates
type CacheEntry = { url: string; size?: number; mime?: string }
const useMsgUrlCache = () => {
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map())
  const createdRef = useRef<Set<string>>(new Set())
  const msgKey = (m: DBMessage, kind: 'full' | 'thumb') => `${m.dialogId}:${m.msgId}:${kind}`
  const getMsgBlobUrl = (m: DBMessage, kind: 'full' | 'thumb') => {
    const anyM = m as any
    const blob: Blob | undefined = kind === 'full' ? anyM.mediaBlob : anyM.mediaThumbBlob
    if (!blob) return null
    const key = msgKey(m, kind)
    const size = typeof m.mediaSize === 'number' ? m.mediaSize : undefined
    const mime = m.mediaMime
    const cached = cacheRef.current.get(key)
    if (cached && cached.size === size && cached.mime === mime) return cached.url
    if (cached) {
      try { URL.revokeObjectURL(cached.url) } catch {}
      createdRef.current.delete(cached.url)
    }
    const u = URL.createObjectURL(blob)
    cacheRef.current.set(key, { url: u, size, mime })
    createdRef.current.add(u)
    return u
  }
  useEffect(() => () => {
    for (const u of createdRef.current) {
      try { URL.revokeObjectURL(u) } catch {}
    }
    createdRef.current.clear()
    cacheRef.current.clear()
  }, [])
  return getMsgBlobUrl
}

function categoryMatch(cat: CategoryKey, m: DBMessage): boolean {
  const t = m.mediaType as any
  switch (cat) {
    case 'all': return true
    case 'photos': return t === 'photo'
    case 'videos': return t === 'video' || t === 'video_note'
    case 'gifs': return t === 'animation'
    case 'audio': return t === 'audio'
    case 'voice': return t === 'voice'
    case 'files': return t === 'document'
    case 'links': return !!(m.text && /https?:\/\//i.test(m.text))
  }
}

export default function MediaFolderModal({ open, items, onClose, onOpenItem, onRequestFile }: MediaFolderModalProps) {
  const getMsgBlobUrl = useMsgUrlCache()
  const [cat, setCat] = useState<CategoryKey>('all')
  const [visibleCount, setVisibleCount] = useState(60)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const filtered = useMemo(() => items.filter(m => categoryMatch(cat, m)), [items, cat])
  const page = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])

  useEffect(() => { setVisibleCount(60) }, [cat, open])

  useEffect(() => {
    if (!open) return
    const el = sentinelRef.current
    if (!el) return
    const ob = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          setVisibleCount(c => Math.min(c + 60, filtered.length))
        }
      }
    }, { root: scrollRef.current, rootMargin: '200px' })
    ob.observe(el)
    return () => ob.disconnect()
  }, [open, filtered.length])

  const itemObserver = useRef<IntersectionObserver | null>(null)
  useEffect(() => {
    if (!open) return
    if (itemObserver.current) {
      itemObserver.current.disconnect()
      itemObserver.current = null
    }
    itemObserver.current = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const node = e.target as HTMLElement
        const msgId = Number(node.getAttribute('data-msgid'))
        const hasBlob = node.getAttribute('data-hasblob') === '1'
        const mediaType = node.getAttribute('data-mediatype') || undefined
        const sizeStr = node.getAttribute('data-mediasize')
        const size = sizeStr ? Number(sizeStr) : undefined
        const limit = 20 * 1024 * 1024
        if (e.isIntersecting && !hasBlob && onRequestFile) {
          if (mediaType === 'sticker') {
            onRequestFile(msgId)
          } else if (typeof size === 'number' && size <= limit) {
            onRequestFile(msgId)
          }
        }
      }
    }, { root: scrollRef.current, rootMargin: '200px' })
    return () => { itemObserver.current?.disconnect(); itemObserver.current = null }
  }, [open, onRequestFile])

  const openAt = (m: DBMessage) => {
    const startIndex = filtered.findIndex(x => x.msgId === m.msgId)
    onOpenItem(filtered, startIndex >= 0 ? startIndex : 0)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex flex-col" onClick={onClose}>
      <div className="sticky top-0 flex items-center justify-between px-2 md:px-4 py-2 md:py-3 text-white select-none backdrop-blur-sm bg-black/30" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-none [-ms-overflow-style:none] [scrollbar-width:none]">
          {CATEGORIES.map(c => (
            <button
              key={c.key}
              onClick={() => setCat(c.key)}
              className={`shrink-0 min-w-[44px] h-9 px-3 text-sm rounded ${cat === c.key ? 'bg-white text-black' : 'bg-white/10 hover:bg-white/20'}`}
            >{c.label}</button>
          ))}
        </div>
        <button className="min-w-[64px] h-9 px-3 text-sm bg-white/10 hover:bg-white/20 rounded" onClick={onClose}>Закрыть</button>
      </div>
      <div id="media-folder-scroll" ref={scrollRef} className="flex-1 overflow-auto p-2 md:p-3 pb-[max(env(safe-area-inset-bottom),0px)]" onClick={e => e.stopPropagation()}>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-1.5 md:gap-2">
          {page.map(m => {
            const anyM = m as any
            const hasBlob = !!anyM.mediaBlob
            const hasThumbBlob = !!anyM.mediaThumbBlob
            const isVideo = m.mediaType === 'video' || m.mediaType === 'video_note'
            const box = 'w-full aspect-square rounded overflow-hidden bg-gray-100 flex items-center justify-center'
            const fullSrc = hasBlob ? (getMsgBlobUrl(m, 'full') || undefined) : undefined
            const thumbSrc = hasThumbBlob ? (getMsgBlobUrl(m, 'thumb') || undefined) : (m.mediaThumb || undefined)
            const click = () => { hasBlob ? openAt(m) : onRequestFile?.(m.msgId) }
            return (
              <div
                key={m.msgId}
                className="relative group cursor-pointer select-none"
                data-msgid={m.msgId}
                data-hasblob={hasBlob ? '1' : '0'}
                data-mediatype={m.mediaType}
                data-mediasize={typeof m.mediaSize === 'number' ? String(m.mediaSize) : undefined}
                ref={(el) => { if (el) itemObserver.current?.observe(el) }}
                onClick={click}
              >
                <div className={box}>
                  {fullSrc ? (
                    isVideo ? (
                      <video src={fullSrc} className="max-w-full max-h-full object-contain" controls={false} muted playsInline />
                    ) : (
                      <img src={fullSrc} className="max-w-full max-h-full object-contain" />
                    )
                  ) : thumbSrc ? (
                    <img src={thumbSrc} className="max-w-full max-h-full object-contain opacity-90" />
                  ) : (
                    <div className="text-[11px] text-gray-500">Нет файла</div>
                  )}
                </div>
                <div className="absolute bottom-1 left-1 right-1 hidden group-hover:flex items-center justify-between text-[10px] px-1 py-0.5 bg-black/40 text-white rounded">
                  <span>{m.mediaType}</span>
                  {m.mediaDuration ? <span>{m.mediaDuration}s</span> : null}
                </div>
                {/* statuses intentionally not shown here; present in MessageList footer */}
              </div>
            )
          })}
        </div>
        <div ref={sentinelRef} className="h-8" />
        {!filtered.length && (
          <div className="text-center text-white/70 py-8">Нет элементов</div>
        )}
      </div>
    </div>
  )
}
