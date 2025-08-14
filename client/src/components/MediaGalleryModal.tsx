import { useEffect, useRef, useState } from 'react'
import type { DBMessage } from '../db/db'
import { db } from '../db/db'

export type MediaGalleryModalProps = {
  open: boolean
  items: DBMessage[]
  startIndex?: number
  onClose: () => void
  onRequestFile?: (msgId: number) => void | Promise<void>
}

// Cache object URLs per message+kind with size/mime guards to avoid flicker on updates
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

export default function MediaGalleryModal({ open, items, startIndex = 0, onClose, onRequestFile }: MediaGalleryModalProps) {
  const getMsgBlobUrl = useMsgUrlCache()
  const [index, setIndex] = useState(startIndex)
  const [src, setSrc] = useState<string | null>(null)
  const [kind, setKind] = useState<'image' | 'video' | 'audio'>('image')
  const item = items[index]

  useEffect(() => { setIndex(startIndex) }, [startIndex])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') next()
      if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  useEffect(() => {
    if (!open || !item) return
    ;(async () => {
      const t = item.mediaType
      if (t === 'video' || t === 'video_note') setKind('video')
      else if (t === 'audio' || t === 'voice') setKind('audio')
      else setKind('image')

      if ((item as any).mediaBlob) {
        const u = getMsgBlobUrl(item, 'full')
        setSrc(u)
        return
      }
      if ((item as any).mediaThumbBlob) {
        const u = getMsgBlobUrl(item, 'thumb')
        setSrc(u)
      } else if (item.mediaThumb) {
        setSrc(item.mediaThumb)
      } else {
        setSrc(null)
      }
      try { await onRequestFile?.(item.msgId) } catch {}
      const fresh = await db.messages.where({ dialogId: item.dialogId, msgId: item.msgId }).first()
      if (fresh && (fresh as any).mediaBlob) {
        const u = getMsgBlobUrl(fresh as any, 'full')
        setSrc(u)
      }
    })()
  }, [open, index, item?.id])

  const prev = () => setIndex(i => (i > 0 ? i - 1 : i))
  const next = () => setIndex(i => (i < items.length - 1 ? i + 1 : i))

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={onClose}>
      <div className="sticky top-0 flex items-center justify-between px-3 md:px-4 py-2 md:py-3 text-white select-none backdrop-blur-sm bg-black/30" onClick={e => e.stopPropagation()}>
        <div className="text-sm md:text-base opacity-80 truncate">
          {item?.fileName || item?.mediaMime || ''}
        </div>
        <div className="flex items-center gap-2">
          <button className="min-w-[44px] h-9 px-2 text-sm bg-white/10 hover:bg-white/20 rounded disabled:opacity-40" onClick={prev} disabled={index === 0}>←</button>
          <button className="min-w-[44px] h-9 px-2 text-sm bg-white/10 hover:bg-white/20 rounded disabled:opacity-40" onClick={next} disabled={index === items.length - 1}>→</button>
          <button className="min-w-[64px] h-9 px-3 text-sm bg-white/10 hover:bg-white/20 rounded" onClick={onClose}>Закрыть</button>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center p-2 pb-[max(env(safe-area-inset-bottom),0px)]" onClick={e => e.stopPropagation()}>
        {src ? (
          kind === 'image' ? (
            <img src={src} alt={item?.fileName || ''} className="max-w-[95vw] max-h-[85vh] object-contain rounded" />
          ) : kind === 'video' ? (
            <video controls className="max-w-[95vw] max-h-[85vh] rounded bg-black" poster={(item as any).mediaThumbBlob ? (getMsgBlobUrl(item, 'thumb') || undefined) : (item?.mediaThumb || undefined)} preload="metadata">
              <source src={src} type={item?.mediaMime || (item?.fileName?.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4')} />
              Ваш браузер не поддерживает воспроизведение этого видео.
            </video>
          ) : (
            <audio src={src} controls className="w-[90vw] max-w-[720px]" />
          )
        ) : (
          <div className="text-white/80">Загрузка…</div>
        )}
      </div>
    </div>
  )
}
