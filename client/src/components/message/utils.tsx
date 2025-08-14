import React from 'react'
import type { DBMessage } from '../../db/db'

export type MessageEntity = { offset: number; length: number; type: string; url?: string }

// Stable key for media URLs
export function mediaUrlKey(m: DBMessage, kind: 'full' | 'thumb') {
  return `${m.dialogId}:${m.msgId}:${kind}`
}

// ObjectURL cache helper to manage create/revoke safely
export class ObjectUrlCache {
  private map = new Map<string, { url: string; size?: number; mime?: string }>()
  private created = new Set<string>()
  private pending = new Set<string>()

  get(key: string, blob: Blob | undefined | null, meta?: { size?: number; mime?: string }): string | null {
    if (!blob) return null
    // Use provided meta or fallback to blob's own size/type for stability
    const size = (meta?.size ?? (blob as any)?.size) as number | undefined
    const mime = (meta?.mime ?? (blob as any)?.type) as string | undefined
    const prev = this.map.get(key)
    // If previous URL exists and meta is unchanged (or unknown), keep existing URL to avoid reloading media
    if (prev) {
      const metaKnown = typeof size === 'number' || typeof mime === 'string'
      if (!metaKnown) return prev.url
      if (prev.size === size && prev.mime === mime) return prev.url
    }
    if (prev) {
      // Не отзывать URL мгновенно: даём браузеру время завершить загрузку старого ресурса.
      const old = prev.url
      this.pending.add(old)
      setTimeout(() => {
        if (this.pending.has(old)) {
          try { URL.revokeObjectURL(old) } catch {}
          this.pending.delete(old)
          this.created.delete(old)
        }
      }, 10000)
    }
    const url = URL.createObjectURL(blob)
    this.map.set(key, { url, size, mime })
    this.created.add(url)
    return url
  }

  revokeAll() {
    for (const u of this.created) {
      try { URL.revokeObjectURL(u) } catch {}
    }
    this.created.clear()
    this.map.clear()
    // Также чистим отложенные URL
    for (const u of this.pending) {
      try { URL.revokeObjectURL(u) } catch {}
    }
    this.pending.clear()
  }
}

// Render rich text with Telegram-like entities
export function renderRichText(text?: string, entities?: MessageEntity[]) {
  if (!text) return null
  if (!entities || !entities.length) return <div className="whitespace-pre-wrap break-words">{text}</div>
  const parts: React.ReactNode[] = []
  const ens = [...entities].sort((a, b) => a.offset - b.offset)
  let i = 0
  let seg = 0
  for (const e of ens) {
    const start = Math.max(0, Math.min(text.length, e.offset))
    const end = Math.max(start, Math.min(text.length, e.offset + e.length))
    if (i < start) parts.push(<span key={`t-${i}-${seg}`}>{text.slice(i, start)}</span>)
    const slice = text.slice(start, end)
    parts.push(<React.Fragment key={`e-${start}-${end}-${seg}`}>{wrap(slice, e)}</React.Fragment>)
    i = end
    seg++
  }
  if (i < text.length) parts.push(<span key={`t-end-${seg}`}>{text.slice(i)}</span>)
  return <div className="whitespace-pre-wrap break-words">{parts}</div>
}

function wrap(s: string, e?: { type: string; url?: string }) {
  if (!e) return s
  const t = e.type || ''
  if (t.includes('MessageEntityBold')) return <strong>{s}</strong>
  if (t.includes('MessageEntityItalic')) return <em>{s}</em>
  if (t.includes('MessageEntityUnderline')) return <u>{s}</u>
  if (t.includes('MessageEntityStrike')) return <s>{s}</s>
  if (t.includes('MessageEntityCode')) return (
    <code className="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 font-mono text-[12px] align-baseline">{s}</code>
  )
  if (t.includes('MessageEntityTextUrl') && e.url) return (
    <a className="text-blue-600 hover:underline" href={e.url} target="_blank" rel="noopener noreferrer">{s}</a>
  )
  if (t.includes('MessageEntityUrl')) return (
    <a className="text-blue-600 hover:underline" href={s} target="_blank" rel="noopener noreferrer">{s}</a>
  )
  return s
}
