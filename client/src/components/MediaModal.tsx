import { useEffect } from 'react'

export type MediaModalProps = {
  open: boolean
  src?: string | null
  kind: 'image' | 'video'
  title?: string
  onClose: () => void
}

export default function MediaModal({ open, src, kind, title, onClose }: MediaModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (open) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex flex-col" onClick={onClose}>
      <div className="sticky top-0 flex items-center justify-between px-3 md:px-4 py-2 md:py-3 text-white select-none backdrop-blur-sm bg-black/30" onClick={e => e.stopPropagation()}>
        <div className="text-sm md:text-base opacity-80 truncate">{title || ''}</div>
        <button className="min-w-[44px] h-9 px-3 py-1.5 text-sm bg-white/10 hover:bg-white/20 rounded" onClick={onClose}>Закрыть</button>
      </div>
      <div className="flex-1 flex items-center justify-center p-2 pb-[max(env(safe-area-inset-bottom),0px)]" onClick={e => e.stopPropagation()}>
        {src ? (
          kind === 'image' ? (
            <img src={src} alt={title || ''} className="max-w-[95vw] max-h-[85vh] object-contain rounded" />
          ) : (
            <video controls className="max-w-[95vw] max-h-[85vh] rounded bg-black" preload="metadata">
              <source src={src} />
            </video>
          )
        ) : (
          <div className="text-white/80">Загрузка…</div>
        )}
      </div>
    </div>
  )
}
