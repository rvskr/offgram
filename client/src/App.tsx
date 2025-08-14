import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import Auth from './components/Auth'
import DialogsList from './components/DialogsList'
import MessageList from './components/MessageList'
import Composer from './components/Composer'
import type { DBMessage } from './db/db'
import { isAuthorized, downloadMessageFile, getDialogsPage, joinChannelIfNeeded, toggleDialogPin, toggleDialogMute, deleteDialogHistory, subscribeNewMessages, getMessageById, subscribeRaw, getPeerDialogsBatch } from './lib/telegramClient'
import { getDialogNotifySettings, getHistory, getMoreHistory } from './lib/store/store'
import type { DialogPeer, DialogsPageCursor } from './lib/telegramClient'
import { upsertDialogs, upsertMessages, clearAll, clearDialogMessages, updateMessageBlob, markMessagesDeleted } from './db/ops'
import { db, msgKey } from './db/db'
import { createDownloadQueue, type DownloadQueue } from './lib/downloadQueue'
import { useDialogs, useMessagesWindow } from './db/useDb'
import MediaGalleryModal from './components/MediaGalleryModal'
import MediaFolderModal from './components/MediaFolderModal'
import { pushTargeted } from './lib/push'
import SettingsPage from './components/SettingsPage'
import { getSettings, subscribe as subscribeSettings, allowAutoDownloadByEntity } from './lib/settings'

// Make readable snippet for notification body
function computeBodySnippet(m: Partial<DBMessage> | undefined): string {
  if (!m) return 'У вас новое сообщение'
  const raw = (m as any).text ?? (m as any).message ?? ''
  const t = String(raw).replace(/\s+/g, ' ').trim()
  if (t) return t.slice(0, 200)
  const mt = (m as any).mediaType as string | undefined
  const name = (m as any).fileName as string | undefined
  if (mt) {
    const map: Record<string, string> = {
      photo: '[Фото]',
      video: '[Видео]',
      video_note: '[Кружок]',
      audio: '[Аудио]',
      voice: '[Голосовое]',
      sticker: '[Стикер]',
      document: '[Файл]',
      animation: '[Анимация]',
      unknown: '[Вложение]'
    }
    const label = map[mt] || '[Вложение]'
    return name ? `${label} ${name}` : label
  }
  return 'У вас новое сообщение'
}

// (Оставляем мемоизацию внутри элементов MessageList; внешний memo может быть добавлен позже с явным типом пропсов)

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const dialogs = useDialogs()
  const [dialogsHasMore, setDialogsHasMore] = useState(false)
  const loadingDialogsRef = useRef(false)
  const lastDialogsLoadAtRef = useRef<number>(0)
  const dialogsCursorRef = useRef<DialogsPageCursor | undefined>(undefined)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [view, setView] = useState<'chat' | 'settings' | 'auth' | null>(null)

  // Helper: быстрый чек mute из локального состояния/БД с fallback к сети
  const isDialogMuted = useCallback(async (dialogId: string): Promise<boolean> => {
    const d = dialogs.find(dd => dd.id === dialogId) as any
    if (d && typeof d.muted === 'boolean') return d.muted
    try {
      const ent = await ensureEntityForId(dialogId)
      if (!ent) return false
      const st = await getDialogNotifySettings(ent)
      // сохраняем в БД для будущих рендеров
      await upsertDialogs([{ id: dialogId, muted: Boolean(st.muted), muteUntil: st.muteUntil } as any])
      return Boolean(st.muted)
    } catch { return false }
  }, [dialogs])
  const [incomingCall, setIncomingCall] = useState<{ dialogId?: string; from?: string; isVideo?: boolean } | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const lastMsgIdByDialogRef = useRef<Map<string, number>>(new Map())
  const bootstrappedRef = useRef<boolean>(false)
  const bootStartedAtRef = useRef<number>(Date.now())
  activeIdRef.current = activeId
  const [windowLimit, setWindowLimit] = useState(50)
  const messages = useMessagesWindow(activeId ?? undefined, { limit: windowLimit })
  const oldestRef = useRef<number | undefined>(undefined)
  const activeEntityRef = useRef<any>(null)
  const peersRef = useRef<DialogPeer[]>([])
  const entityByIdRef = useRef<Map<string, any>>(new Map())
  // Очередь загрузок медиа вынесена в lib/downloadQueue
  const downloadQueueRef = useRef<DownloadQueue | null>(null)
  // Буфер задач до инициализации очереди загрузок
  const pendingEnqRef = useRef<Array<[string, number, number]>>([])
  const enqueueDownload = useCallback((dialogId: string, msgId: number, priority = 10) => {
    const q = downloadQueueRef.current
    if (q) {
      try { q.enqueue(dialogId, msgId, priority) } catch {}
    } else {
      pendingEnqRef.current.push([dialogId, msgId, priority])
      try { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[auto-dl] buffered', { dialogId, msgId, priority }) } catch {}
    }
  }, [])
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const [galleryItems, setGalleryItems] = useState<any[]>([])
  const [galleryStart, setGalleryStart] = useState(0)
  const [needsJoinId, setNeedsJoinId] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<any | null>(null)
  // Какие диалоги уже вставлены в БД (для дозагрузки остатка первой страницы без сети)
  const insertedIdsRef = useRef<Set<string>>(new Set())

  // Приводим onRequestFile к ожидаемой сигнатуре MessageList: (msgId) => Promise<void>
  const onRequestFileMsg = useCallback(async (msgId: number) => {
    const did = activeIdRef.current
    if (!did) return
    try {
      const row = await db.messages.get(msgKey(did, msgId))
      if (row?.mediaBlob) return
      const ent = activeEntityRef.current
      if (!ent) return
      if (!allowAutoDownloadByEntity(getSettings(), ent)) return
    } catch {}
    enqueueDownload(did, msgId, 5)
  }, [])

  // Batched prefetch of last messages with cancel and timeout support
  const navEpochRef = useRef(0)
  const prefetchedIdsRef = useRef<Set<string>>(new Set())
  const cooldownUntilRef = useRef<number>(0)
  useEffect(() => () => { navEpochRef.current++ }, [])

  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms)
      p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
    })
  }

  const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

  async function prefetchBatch(peers: any[], opts?: { limit?: number; concurrency?: number; timeoutMs?: number }) {
    const { limit = 15, concurrency = 3, timeoutMs = 5000 } = opts || {}
    const epoch = navEpochRef.current
    const pool = peers.slice(0, limit).filter(p => !prefetchedIdsRef.current.has(String(p.id)))
    if (!pool.length) return
    // First try a single batched request
    try {
      const batchRes = await withTimeout(getPeerDialogsBatch(pool.map(p => p.entity)), timeoutMs)
      if (navEpochRef.current !== epoch) return
      const got = new Set<string>()
      for (const r of batchRes) {
        if (!r?.dialogId || !r.topMessage) continue
        try {
          await upsertMessages(r.dialogId, [{
            msgId: Number(r.topMessage.msgId),
            date: Number(r.topMessage.date),
            out: Boolean(r.topMessage.out),
            senderName: r.topMessage.senderName,
            text: (r.topMessage as any).text,
            message: (r.topMessage as any).text,
            mediaType: (r.topMessage as any).mediaType,
            mediaMime: (r.topMessage as any).mediaMime,
            mediaSize: (r.topMessage as any).mediaSize,
            fileName: (r.topMessage as any).fileName,
            replyToMsgId: (r.topMessage as any).replyToMsgId,
          } as any])
          prefetchedIdsRef.current.add(r.dialogId)
          got.add(r.dialogId)
        } catch {}
      }
      // Prepare remaining peers for fallback
      const remaining = pool.filter(p => !got.has(String(p.id)))
      if (!remaining.length) return
      // Fallback to per-peer (below)
      peers = remaining
    } catch {
      // If batch fails, fall back to per-peer flow for current pool
    }
    let i = 0
    const worker = async () => {
      while (i < pool.length && navEpochRef.current === epoch) {
        const idx = i++
        const p = peers[idx] ?? pool[idx]
        const id = String(p.id)
        try {
          // Wait if global cooldown is active
          const now = Date.now()
          if (cooldownUntilRef.current > now) {
            await sleep(Math.min(1000, cooldownUntilRef.current - now))
          }
          // Small jitter to spread requests
          await sleep(120 + Math.floor(Math.random() * 80))
          let msgs = await withTimeout(getHistory(p.entity, 20), timeoutMs)
          let m = msgs?.[0]
          // If no messages (e.g., not joined channel), try to join and retry once
          if (!m && p?.isChannel) {
            try { await withTimeout(joinChannelIfNeeded(p.entity), 3000) } catch {}
            try { msgs = await withTimeout(getHistory(p.entity, 20), timeoutMs) } catch {}
            m = msgs?.[0]
          }
          if (m && navEpochRef.current === epoch) {
            await upsertMessages(id, [{
              msgId: Number(m.msgId),
              date: Number(m.date),
              out: Boolean(m.out),
              senderName: m.senderName,
              text: (m as any).text ?? (m as any).message,
              message: (m as any).message ?? (m as any).text,
              mediaType: (m as any).mediaType,
              mediaMime: (m as any).mediaMime,
              mediaSize: (m as any).mediaSize,
              fileName: (m as any).fileName,
              replyToMsgId: (m as any).replyToMsgId,
            } as any])
            prefetchedIdsRef.current.add(id)
          }
        } catch (e: any) {
          // Handle FloodWait like errors with seconds property
          const sec = Number((e && (e.seconds ?? e.duration ?? e.wait ?? undefined)))
          if (sec && isFinite(sec) && sec > 0) {
            cooldownUntilRef.current = Date.now() + (sec * 1000) + 300
          }
          // On network or timeout errors just continue; item may be fetched by fallback
        }
      }
    }
    const workers = new Array(concurrency).fill(0).map(() => worker())
    await Promise.all(workers)
  }

  // Fallback: префетч для диалогов без превью из IndexedDB
  async function prefetchMissingPreviews(limit = 20) {
    try {
      const list = await db.dialogs.toArray()
      const missing = list.filter(d => !d.lastMessageId || !(d as any).lastPreview).slice(0, limit)
      if (!missing.length) return
      const peers: any[] = []
      for (const d of missing) {
        const ent = entityByIdRef.current.get(d.id)
        if (ent) peers.push({ id: d.id, entity: ent, isChannel: (d as any).kind === 'channel' })
      }
      if (peers.length) await prefetchBatch(peers, { limit: Math.min(limit, peers.length), concurrency: 4, timeoutMs: 5000 })
    } catch {}
  }

  // One-time background backfill: load last message preview for dialogs missing it
  useEffect(() => {
    let cancelled = false
    let running = false
    ;(async () => {
      if (running) return; running = true
      try {
        // take a small batch of dialogs without preview
        const all = await db.dialogs.toArray()
        const targets = all.filter(d => !('lastPreview' in (d as any)) || !(d as any).lastPreview).slice(0, 20)
        for (const d of targets) {
          if (cancelled) break
          try {
            const ent = await ensureEntityForId(d.id)
            if (!ent) continue
            const hist = await getHistory(ent, 20)
            const newest: any = hist?.[0]
            if (newest && typeof newest.msgId === 'number') {
              await upsertMessages(d.id, [{
                msgId: newest.msgId,
                date: newest.date,
                out: !!newest.out,
                fromId: newest.fromId,
                senderName: newest.senderName,
                message: newest.message,
                entities: newest.entities,
                forwardedFrom: newest.forwardedFrom,
                edited: newest.edited,
                editVersion: newest.editVersion,
                editedAt: newest.editedAt,
                mediaType: newest.mediaType,
                mediaMime: newest.mediaMime,
                mediaSize: newest.mediaSize,
                mediaDuration: newest.mediaDuration,
                mediaWidth: newest.mediaWidth,
                mediaHeight: newest.mediaHeight,
                fileName: newest.fileName,
                groupedId: newest.groupedId,
                serviceType: newest.serviceType,
                callIsVideo: newest.callIsVideo,
                callOutgoing: newest.callOutgoing,
                callReason: newest.callReason,
                callDuration: newest.callDuration,
              }])
            }
          } catch {}
        }
      } finally {
        running = false
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Реалтайм: слушаем raw updates и синхронизируем pin/mute статусы
  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    (async () => {
      try {
        unsubscribe = await subscribeRaw(async (upd: any) => {
          const cls = upd?.className || upd?._
          // Update of a single dialog pinned flag
          if (cls && cls.includes('UpdateDialogPinned')) {
            const peer = upd.peer
            const pinned = Boolean(upd.pinned)
            const id = String(peer?.userId ?? peer?.chatId ?? peer?.channelId ?? '')
            if (id) {
              await upsertDialogs([{ id, pinned, pinRank: pinned ? 0 : undefined } as any])
            }
          }
          // Bulk pinned order change
          if (cls && cls.includes('UpdatePinnedDialogs')) {
            // We don't get exact set here per peer, but order changed — force refresh next page
            // Minimal action: set pinRank=0 for existing pinned ones remains; nothing to do specific
          }
          // Notify/mute changes
          if (cls && cls.includes('UpdateNotifySettings')) {
            const notify = upd?.notifySettings || upd?.settings
            const peerWrap = upd?.peer
            // peer can be NotifyPeer or variants; extract inner peer
            const inner = peerWrap?.peer || peerWrap
            const id = String(inner?.userId ?? inner?.chatId ?? inner?.channelId ?? '')
            const muteUntil = typeof notify?.muteUntil === 'number' ? notify.muteUntil : undefined
            const nowSec = Math.floor(Date.now() / 1000)
            const muted = typeof muteUntil === 'number' && muteUntil > nowSec
            if (id) {
              await upsertDialogs([{ id, muted, muteUntil } as any])
            }
          }
          // new/edit/delete messages -> realtime sync (balanced try/catch)
          try {
            const kind = upd?._ || upd?.constructor?.name
            const clsName = String((upd as any)?.className || kind || '')
            try { console.debug('[raw]', kind, upd) } catch {}

            // new message
            if (kind === 'UpdateNewMessage' || kind === 'UpdateNewChannelMessage' || clsName.includes('UpdateNewMessage') || clsName.includes('UpdateNewChannelMessage')) {
              const msg = (upd as any).message
              const peer = msg?.peerId || msg?.peer
              const dialogId = String(peer?.userId ?? peer?.channelId ?? peer?.chatId ?? '')
              const msgId = Number(msg?.id)
              if (dialogId && Number.isFinite(msgId)) {
                let ent: any = undefined
                try { ent = await ensureEntityForId(dialogId) } catch {}
                // immediate enqueue by raw
                try {
                  const mediaRaw: any = (msg as any).media
                  const hasMedia = !!mediaRaw && !String(mediaRaw?.className || mediaRaw?._ || '').includes('Empty')
                  if (hasMedia) {
                    const row = await db.messages.get(msgKey(dialogId, msgId))
                    const cached = !!row?.mediaBlob
                    const peerGuess = msg?.peerId || msg?.peer
                    const isUser = !!(peerGuess && typeof peerGuess.userId !== 'undefined')
                    const settingsNow = getSettings()
                    const allowed = ent ? allowAutoDownloadByEntity(settingsNow, ent) : (isUser ? !!settingsNow.autoDownload.users : false)
                    if (!cached && allowed) enqueueDownload(dialogId, msgId, 2)
                  }
                } catch {}
                if (ent) {
                  try {
                    const norm = await getMessageById(ent, msgId)
                    if (norm) {
                      await upsertMessages(dialogId, [norm])
                      if (norm.mediaType) {
                        const row2 = await db.messages.get(msgKey(dialogId, norm.msgId))
                        const cached2 = !!row2?.mediaBlob
                        if (!cached2 && allowAutoDownloadByEntity(settings, ent)) enqueueDownload(dialogId, norm.msgId, 4)
                      }
                    }
                  } catch {}
                }
              }
            }

            // edits
            if (kind === 'UpdateEditMessage' || kind === 'UpdateEditChannelMessage' || clsName.includes('UpdateEditMessage') || clsName.includes('UpdateEditChannelMessage')) {
              try { console.debug('[raw] handle edit') } catch {}
              const rawMsg = (upd as any).message ?? (upd as any)
              const peer = rawMsg?.peerId || rawMsg?.peer
              const dialogId = String(peer?.userId ?? peer?.channelId ?? peer?.chatId ?? rawMsg?.userId ?? rawMsg?.chatId ?? rawMsg?.channelId ?? '')
              const msgId = Number(rawMsg?.id)
              if (dialogId && Number.isFinite(msgId)) {
                try {
                  const key = `${dialogId}:${msgId}`
                  const ed = (rawMsg as any).editDate
                  const editedAt = typeof ed === 'number' ? ed : (ed ? Math.floor(new Date(ed).getTime() / 1000) : Math.floor(Date.now() / 1000))
                  await db.messages.update(key, { edited: true, editedAt })
                } catch {}
                const ent = await ensureEntityForId(dialogId)
                if (ent) {
                  try {
                    const norm = await getMessageById(ent, msgId)
                    if (norm) {
                      const ed = (rawMsg as any).editDate
                      const editedAt = typeof ed === 'number' ? ed : (ed ? Math.floor(new Date(ed).getTime() / 1000) : Math.floor(Date.now() / 1000))
                      await upsertMessages(dialogId, [{ ...norm, edited: true, editedAt } as any])
                    }
                  } catch {}
                }
              }
            }

            // deletions
            if (kind === 'UpdateDeleteMessages' || kind === 'UpdateDeleteChannelMessages' || clsName.includes('UpdateDeleteMessages') || clsName.includes('UpdateDeleteChannelMessages')) {
              try { console.debug('[raw] handle delete') } catch {}
              const ids: number[] = (upd.messageIds || upd.messages || upd.ids || []).map((x: any) => Number(x)).filter((n: any) => Number.isFinite(n))
              if (ids.length) {
                const peer = (upd as any).peer || (upd as any).peerId
                let dialogId = String(peer?.userId ?? peer?.chatId ?? peer?.channelId ?? '')
                if (!dialogId && typeof (upd as any).channelId !== 'undefined') dialogId = String((upd as any).channelId)
                if (dialogId) {
                  await markMessagesDeleted(dialogId, ids)
                } else {
                  try {
                    const rows = await db.messages.where('msgId').anyOf(ids as any).toArray()
                    const byDialog = new Map<string, number[]>()
                    for (const r of rows) {
                      if (!r.dialogId) continue
                      const arr = byDialog.get(r.dialogId) || []
                      arr.push(r.msgId)
                      byDialog.set(r.dialogId, arr)
                    }
                    for (const [did, mids] of byDialog) {
                      await markMessagesDeleted(did, mids)
                    }
                  } catch {}
                }
              }
            }
          } catch (e) {}
        })
      } catch {}
    })()
    return () => { try { unsubscribe?.() } catch {} }
  }, [])

  // Resolve active entity for downloading media/thumbs
  useEffect(() => {
    (async () => {
      if (!activeId) { activeEntityRef.current = null; return }
      try {
        const ent = await ensureEntityForId(activeId)
        activeEntityRef.current = ent || null
      } catch {
        activeEntityRef.current = null
      }
    })()
  }, [activeId])

  

  // Lightweight polling: check first page of dialogs for updates and fire targeted push when appropriate
  useEffect(() => {
    if (!authed) return
    let stop = false
    const tick = async () => {
      if (stop) return
      const allowNotify = bootstrappedRef.current || (Date.now() - bootStartedAtRef.current) > 5000
      try {
        const page = await getDialogsPage(8, undefined)
        for (const p of page.peers) {
          const dlgId = p.id
          const lastKnown = lastMsgIdByDialogRef.current.get(dlgId) || 0
          // fetch newest message id for this dialog quickly
          let newestMsgId = 0
          try {
            const ent = await ensureEntityForId(dlgId)
            if (!ent) continue
            const hist = await getHistory(ent, 20)
            const newest = hist?.[0]
            if (newest) {
              newestMsgId = newest.msgId
              // if new and should notify
              const shouldNotify = allowNotify && (newestMsgId > lastKnown) && (!newest.out) && (
                (typeof document !== 'undefined' && document.hidden) || dlgId !== activeIdRef.current
              )
              if (shouldNotify) {
                const muted = await isDialogMuted(dlgId)
                if (!muted) {
                  const title = p.title || 'Новое сообщение'
                  const snippet = computeBodySnippet(newest)
                  const body = snippet
                  const url = `/#/dialog/${encodeURIComponent(dlgId)}`
                  { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[notify] poll detected new message → pushTargeted', { dialogId: dlgId, msgId: newest.msgId }) }
                  try { await pushTargeted({ title, body, url, tag: `dialog:${dlgId}`, dialogId: dlgId }) } catch {}
                } else {
                  { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[notify] muted by Telegram — skip push', { dialogId: dlgId }) }
                }
              }
            }
          } catch (e: any) {
            const msg = String(e?.message || e || '')
            { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.warn('[notify] poll error', dlgId, msg) }
            if (/flood/i.test(msg)) {
              // simple backoff on flood wait
              await new Promise(r => setTimeout(r, 5000))
            }
          }
          if (newestMsgId) lastMsgIdByDialogRef.current.set(dlgId, newestMsgId)
        }
      } catch {}
      // schedule next tick
      if (!stop) setTimeout(tick, 7000)
    }
    tick()
    return () => { stop = true }
  }, [authed])

  // Realtime DB sync: handle raw updates and upsert newest messages for previews/sorting
  useEffect(() => {
    if (!authed) return
    let unsubscribe: (() => void) | null = null
    ;(async () => {
      try {
        unsubscribe = await subscribeRaw(async (upd: any) => {
          const visit = async (u: any) => {
            try {
              const t = String(u?._ || u?.className || u?.constructor?.name || '')
              try { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[raw] update type', t, u) } catch {}
              // Containers with nested updates
              if (Array.isArray(u?.updates)) {
                for (const v of u.updates) await visit(v)
                return
              }
              if (t === 'Updates' || t === 'UpdatesCombined') {
                if (Array.isArray(u?.updates)) {
                  for (const v of u.updates) await visit(v)
                }
                return
              }
              // Full new message updates (have message object)
              if (t === 'UpdateNewMessage' || t === 'UpdateNewChannelMessage') {
                const m = u.message || u?.msg || u
                const peer = m?.peerId || m?.peer
                const dialogId = String(peer?.userId ?? peer?.chatId ?? peer?.channelId ?? '')
                const msgId = Number(m?.id)
                try { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[raw] new message', { dialogId, msgId }) } catch {}
                if (!dialogId || !msgId) return
                let norm: any | null = null
                try {
                  const ent = await ensureEntityForId(dialogId)
                  if (ent) norm = await getMessageById(ent, msgId)
                } catch {}
                if (!norm && m) {
                  const d = typeof m.date === 'number' ? m.date : Math.floor(new Date(m.date).getTime() / 1000)
                  norm = { msgId, date: d, out: !!m.out, fromId: m.fromId, message: typeof m.message === 'string' ? m.message : undefined }
                }
                if (norm) {
                  try { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[raw] upsert minimal/normalized', { dialogId, norm }) } catch {}
                  await upsertMessages(dialogId, [norm])
                }
                return
              }
              // Short updates (no embedded message entity)
              if (t === 'UpdateShortMessage') {
                const dialogId = String(u.userId ?? u?.peerId?.userId ?? '')
                const msgId = Number(u.id)
                try { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[raw] short user msg', { dialogId, msgId }) } catch {}
                if (!dialogId || !msgId) return
                const d = typeof u.date === 'number' ? u.date : Math.floor(new Date(u.date).getTime() / 1000)
                const norm = { msgId, date: d, out: !!u.out, fromId: { userId: u.userId }, message: typeof u.message === 'string' ? u.message : undefined }
                await upsertMessages(dialogId, [norm])
                return
              }
              if (t === 'UpdateShortChatMessage') {
                const dialogId = String(u.chatId ?? u?.peerId?.chatId ?? '')
                const msgId = Number(u.id)
                try { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[raw] short chat msg', { dialogId, msgId }) } catch {}
                if (!dialogId || !msgId) return
                const d = typeof u.date === 'number' ? u.date : Math.floor(new Date(u.date).getTime() / 1000)
                const norm = { msgId, date: d, out: !!u.out, fromId: { userId: u.fromId }, message: typeof u.message === 'string' ? u.message : undefined }
                await upsertMessages(dialogId, [norm])
                return
              }
              if (t === 'UpdateShortSentMessage') {
                // В этом апдейте часто отсутствует peerId, поэтому иногда невозможно вычислить dialogId
                const dialogId = String(u?.peerId?.userId ?? u?.peerId?.chatId ?? u?.peerId?.channelId ?? '')
                const msgId = Number(u.id)
                try { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[raw] short sent msg', { dialogId, hasPeerId: !!dialogId, msgId }) } catch {}
                if (!dialogId || !msgId) return
                const d = typeof u.date === 'number' ? u.date : Math.floor(new Date(u.date).getTime() / 1000)
                const norm = { msgId, date: d, out: true, message: typeof u.message === 'string' ? u.message : undefined }
                await upsertMessages(dialogId, [norm])
                return
              }
            } catch {}
          }
          await visit(upd?.update ?? upd)
        })
      } catch {}
    })()
    return () => { try { unsubscribe?.() } catch {} }
  }, [authed])

  // Realtime: subscribe to Telegram updates to avoid waiting for poll
  useEffect(() => {
    if (!authed) return
    let unsubscribe: (() => void) | null = null
    ;(async () => {
      try {
        unsubscribe = await subscribeNewMessages(async (update: any) => {
          try {
            const u: any = update?.message ?? update
            const peer = u?.peerId || u?.peer
            const dialogId = String(peer?.userId ?? peer?.chatId ?? peer?.channelId ?? '')
            const msgId = Number(u?.id)
            const out = Boolean(u?.out)
            if (!dialogId || !msgId || out) return

            // Gate to avoid backlog on reload
            const allowNotify = bootstrappedRef.current || (Date.now() - bootStartedAtRef.current) > 5000
            if (!allowNotify) return

            // Only if hidden or different dialog is active
            const inactive = (typeof document !== 'undefined' && document.hidden) || dialogId !== activeIdRef.current
            if (!inactive) return

            // Respect mute
            const muted = await isDialogMuted(dialogId)
            if (muted) { console.log('[notify] rt muted — skip', { dialogId }); return }

            // Build payload
            let title = 'Новое сообщение'
            const dlg = dialogs.find(d => d.id === dialogId)
            if (dlg?.title) title = dlg.title
            // Fetch normalized message to get text/media
            const ent = await ensureEntityForId(dialogId)
            const newest = ent ? await getMessageById(ent, msgId) : null
            const snippet = computeBodySnippet(newest || u)
            const body = snippet
            const url = `/#/dialog/${encodeURIComponent(dialogId)}`
            { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[notify] rt new message → pushTargeted', { dialogId, msgId }) }
            try { await pushTargeted({ title, body, url, tag: `dialog:${dialogId}`, dialogId }) } catch {}

            // Update last seen id to prevent duplicate via poll
            lastMsgIdByDialogRef.current.set(dialogId, msgId)
          } catch (e) {
            console.warn('[notify] rt handler error', e)
          }
        })
      } catch (e) { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.warn('[notify] subscribeNewMessages failed', e) }
    })()
    return () => { try { unsubscribe?.() } catch {} }
  }, [authed, dialogs])

  // Bootstrap: on auth, prefill lastMsgIdByDialogRef to avoid backlog notifications after reload
  useEffect(() => {
    if (!authed) return
    let cancelled = false
    ;(async () => {
      try {
        { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[notify] bootstrap start') }
        const page = await getDialogsPage(5, undefined)
        for (const p of page.peers) {
          try {
            const ent = await ensureEntityForId(p.id)
            if (!ent) continue
            const hist = await getHistory(ent, 1)
            const newest = hist?.[0]
            if (newest) lastMsgIdByDialogRef.current.set(p.id, newest.msgId)
          } catch {}
        }
      } catch (e) { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.warn('[notify] bootstrap error', e) }
      finally {
        if (!cancelled) {
          bootstrappedRef.current = true
          { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[notify] bootstrap done, dialogs=', lastMsgIdByDialogRef.current.size) }
        }
      }
    })()
    return () => { cancelled = true }
  }, [authed])

  useEffect(() => {
    (async () => {
      const ok = await isAuthorized()
      setAuthed(ok)
      if (ok) {
        await loadDialogsPage(true)
      }
    })()
  }, [])

  // (перемещено ниже, после объявления enqueueDownload)

  // Сбрасывать выбранный ответ при смене диалога
  useEffect(() => {
    setReplyTo(null)
  }, [activeId])

  // Sync with browser history for Android system back behavior
  useEffect(() => {
    (async () => {
      const ok = await isAuthorized()
      setAuthed(ok)
      if (ok) {
        await loadDialogsPage(true)
        // initial hash
        const hash = location.hash
        if (/^#\/settings/.test(hash)) {
          setView('settings')
          history.replaceState({ view: 'settings' }, '', '/#/settings')
        } else {
          const m = hash.match(/#\/dialog\/([^/]+)/)
          if (m) {
            const id = decodeURIComponent(m[1])
            setView('chat')
            setActiveId(id)
            history.replaceState({ view: 'chat', id }, '', `/#/dialog/${encodeURIComponent(id)}`)
          }
        }
      }
    })()
    const onPop = (e: PopStateEvent) => {
      const st = e.state as any
      if (st && st.view === 'auth') { setView('auth'); setActiveId(null); return }
      if (st && st.view === 'settings') { setView('settings'); setActiveId(null); return }
      if (st && st.view === 'chat' && st.id) { setActiveId(String(st.id)); return }
      setActiveId(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    (async () => {
      // resolve entity for current activeId and fetch history in one place
      const found = peersRef.current.find(p => p.id === activeId)
      const byMap = activeId ? entityByIdRef.current.get(activeId) : null
      activeEntityRef.current = byMap ?? (found ? found.entity : null)
      oldestRef.current = undefined
      if (!activeId || !activeEntityRef.current) return
      // join channel/supergroup if required then try fetch
      const cls = (activeEntityRef.current as any)?.className as string | undefined
      try {
        // аватарки подтянутся централизованно через upsertDialogs() при первичной загрузке
        if (cls && cls.includes('Channel')) {
          try { await joinChannelIfNeeded(activeEntityRef.current) } catch {}
        }
        const hist = await getHistory(activeEntityRef.current, 50)
        oldestRef.current = hist.length ? hist[hist.length - 1].msgId : undefined
        const lastLocal = messages.length ? messages[messages.length - 1].msgId : undefined
        const newest = hist?.[0]
        // Всегда апсертим пачку истории, upsertMessages сам дедуплицирует
        await upsertMessages(activeId, hist)
        // Уведомления только если пришло новое входящее
        try {
          const allowNotify = bootstrappedRef.current || (Date.now() - bootStartedAtRef.current) > 5000
          if (allowNotify && typeof document !== 'undefined' && document.hidden && newest && !newest.out && (!lastLocal || newest.msgId > lastLocal)) {
            const muted = await isDialogMuted(activeId)
            if (!muted) {
              const dlg = dialogs.find(d => d.id === activeId)
              const title = dlg?.title || 'Новое сообщение'
              const snippet = computeBodySnippet(newest)
              const body = snippet
              const url = `/#/dialog/${encodeURIComponent(activeId)}`
              { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[notify] hidden/newest incoming → pushTargeted', { dialogId: activeId, msgId: newest.msgId }) }
              await pushTargeted({ title, body, url, tag: `dialog:${activeId}`, dialogId: activeId })
            } else {
              { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[notify] muted by Telegram — skip push', { dialogId: activeId }) }
            }
          }
        } catch {}
        if (newest) lastMsgIdByDialogRef.current.set(activeId, newest.msgId)
        // При входе показываем небольшой хвост из кэша
        setWindowLimit(50)
        // Only download media if present in the newest message (no old media downloads)
        try {
          const newest = hist?.[0]
          const LIMIT_BYTES = 20 * 1024 * 1024
          const size = newest?.mediaSize
          const hasMedia = !!newest?.mediaType && newest.mediaType !== 'sticker'
          if (hasMedia && (typeof size !== 'number' || size <= LIMIT_BYTES)) {
            // Проверка кэша: пропускаем, если уже есть mediaBlob
            let cached: any = null
            try { cached = newest ? await db.messages.get(msgKey(activeId, newest.msgId)) : null } catch {}
            const hasCached = !!cached?.mediaBlob
            const ent = activeEntityRef.current
            const allowed = ent ? allowAutoDownloadByEntity(settings, ent) : false
            if (!hasCached && allowed && ent) {
              const blob = await downloadMessageFile(ent, newest.msgId)
              if (blob) await updateMessageBlob(activeId, newest.msgId, blob)
            }
          }
        } catch {}
        setNeedsJoinId(null)
      } catch (e: any) {
        const msg = String(e?.message || e || '')
        if (cls && cls.includes('Channel') && /PRIVATE|FORBIDDEN|AUTH|JOIN|SUBSCR/i.test(msg)) {
          setNeedsJoinId(activeId)
        } else {
          // eslint-disable-next-line no-console
          console.warn('getHistory failed', e)
        }
      }
    })()
  }, [activeId])

  const loadMoreTop = useCallback(async () => {
    if (!activeIdRef.current || !activeEntityRef.current) return
    const before = messages.length
    // сначала расширяем окно, чтобы показать, что уже есть в кэше
    setWindowLimit((l) => l + 20)
    // подождём кадр, чтобы React/IndexedDB успели отдать новые элементы окна
    await new Promise((r) => setTimeout(r, 0))
    const after = messages.length
    // если окно не выросло, значит кэш исчерпан — просим старые из сети
    if (after <= before) {
      const more = await getMoreHistory(activeEntityRef.current, oldestRef.current, 20)
      if (more.length) {
        oldestRef.current = more[more.length - 1].msgId
        await upsertMessages(activeIdRef.current, more)
        // расширим окно ещё раз, чтобы отобразить догруженное
        setWindowLimit((l) => l + 20)
      }
    }
  }, [messages.length])

  // onLogout removed from UI; sessions switch/manage is in Auth

  // Settings subscription
  const [settings, setSettingsState] = useState(getSettings())
  useEffect(() => {
    const unsub = subscribeSettings(setSettingsState)
    return () => { try { (unsub as any)?.() } catch {} }
  }, [])

  const openSettings = () => {
    setView('settings'); setActiveId(null)
    history.pushState({ view: 'settings' }, '', '/#/settings')
  }

  const openAuth = () => {
    setView('auth'); setActiveId(null)
    history.pushState({ view: 'auth' }, '', '/#/auth')
  }

  const closeSettings = () => {
    setView('chat');
    history.back()
  }

  const onClearCache = async () => {
    // очищаем локальную БД/кэш, не трогая сессию
    await clearAll()
  }

  // ensure entity by dialog id
  async function ensureEntityForId(id: string) {
    let ent = entityByIdRef.current.get(id)
    if (ent) return ent
    // try to load next page once if available (serialized)
    await loadDialogsPage(false)
    return entityByIdRef.current.get(id)
  }

  // Unified, serialized loader for dialogs pages
  async function loadDialogsPage(initial: boolean) {
    if (loadingDialogsRef.current) return
    // Если не initial, сначала отдадим остаток локальной первой страницы (без сети)
    if (!initial) {
      const remainingLocal = peersRef.current.filter(p => !insertedIdsRef.current.has(p.id))
      if (remainingLocal.length > 0) {
        // сортируем как в списке: закреплённые первыми (с учётом pinRank), затем по дате
        remainingLocal.sort((a, b) => {
          const ap = a.pinned === true, bp = b.pinned === true
          if (ap !== bp) return ap ? -1 : 1
          if (ap && bp) {
            const ar = (a as any).pinRank, br = (b as any).pinRank
            if (typeof ar === 'number' && typeof br === 'number' && ar !== br) return ar - br
          }
          const ad = a.lastMessageAt ?? 0, bd = b.lastMessageAt ?? 0
          if (ad !== bd) return bd - ad
          const at = (a.title || '').toLowerCase(); const bt = (b.title || '').toLowerCase()
          return at.localeCompare(bt)
        })
        const chunk = remainingLocal.slice(0, 30)
        await upsertDialogs(chunk)
        for (const p of chunk) insertedIdsRef.current.add(p.id)
        // Ещё остались локальные? пусть hasMore остаётся true, иначе смотреть дальше (сеть)
        const stillLeft = peersRef.current.some(p => !insertedIdsRef.current.has(p.id))
        setDialogsHasMore(stillLeft || Boolean(dialogsCursorRef.current))
        lastDialogsLoadAtRef.current = Date.now()
        return
      }
      if (!dialogsHasMore) return
    }
    // Basic throttle: avoid spamming network after локальные попытки
    const now = Date.now()
    if (now - lastDialogsLoadAtRef.current < 1200) return
    loadingDialogsRef.current = true
    try {
      const page = await getDialogsPage(50, initial ? undefined : dialogsCursorRef.current)
      lastDialogsLoadAtRef.current = Date.now()
      dialogsCursorRef.current = page.nextCursor
      setDialogsHasMore(page.hasMore)
      // merge peers cache and upsert
      for (const p of page.peers) entityByIdRef.current.set(p.id, p.entity)
      if (initial) {
        // Храним полный список пиров в оперативном кеше
        peersRef.current = page.peers
        // В БД (и в список слева) изначально попадают: все закреплённые + 10 самых свежих по дате сообщения
        const pinned = page.peers.filter(p => p.pinned === true)
        const others = page.peers.filter(p => !p.pinned)
        others.sort((a, b) => {
          const ad = a.lastMessageAt ?? 0, bd = b.lastMessageAt ?? 0
          if (ad !== bd) return bd - ad
          const at = (a.title || '').toLowerCase()
          const bt = (b.title || '').toLowerCase()
          return at.localeCompare(bt)
        })
        const top = others.slice(0, 10)
        const subset = [...pinned, ...top]
        await upsertDialogs(subset)
        // Prefetch last messages for the first page to instantly fill previews
        await prefetchBatch(page.peers, { limit: 25, concurrency: 4, timeoutMs: 5000 })
        // Fire-and-forget: добить оставшиеся диалоги большим батчем и добрать отсутствующие превью из БД
        setTimeout(() => { void prefetchBatch(page.peers, { limit: 50, concurrency: 4, timeoutMs: 6000 }) }, 50)
        setTimeout(() => { void prefetchMissingPreviews(30) }, 200)
        // пометим вставленные
        insertedIdsRef.current = new Set(subset.map(p => p.id))
        // если в первой странице осталось что-то локально, держим hasMore=true
        const remainingLocal = page.peers.length - subset.length
        if (remainingLocal > 0) setDialogsHasMore(true)
      } else {
        peersRef.current = [...peersRef.current, ...page.peers]
        await upsertDialogs(page.peers)
        // Prefetch for next batch during scroll
        await prefetchBatch(page.peers, { limit: 15, concurrency: 3, timeoutMs: 5000 })
        // Fire-and-forget: добить оставшиеся диалоги и fallback на отсутствующие превью
        setTimeout(() => { void prefetchBatch(page.peers, { limit: 40, concurrency: 4, timeoutMs: 6000 }) }, 50)
        setTimeout(() => { void prefetchMissingPreviews(30) }, 200)
        for (const p of page.peers) insertedIdsRef.current.add(p.id)
      }
      // если нет курсора и локальных остатков — выключаем hasMore
      const anyLocalLeft = peersRef.current.some(p => !insertedIdsRef.current.has(p.id))
      if (!anyLocalLeft && !dialogsCursorRef.current && !page.hasMore) setDialogsHasMore(false)
    } finally {
      loadingDialogsRef.current = false
    }
  }

  // Инициализация очереди загрузок
  useEffect(() => {
    downloadQueueRef.current = createDownloadQueue({
      maxConcurrency: 3,
      getEntity: async (dialogId: string) => {
        // Быстрая попытка: если активный диалог совпадает
        let ent = (activeIdRef.current === dialogId) ? activeEntityRef.current : undefined
        if (ent) return ent
        try { ent = await ensureEntityForId(dialogId) } catch {}
        return ent
      },
      download: async (entity: any, msgId: number) => {
        // загружаем полный файл (без превью)
        const blob = await downloadMessageFile(entity, msgId)
        return blob || undefined
      },
      onBlob: async (dialogId: string, msgId: number, blob: Blob) => {
        // сохраняем в БД только если разрешено настройками
        if (getSettings().saveMediaToDb) {
          await updateMessageBlob(dialogId, msgId, blob)
        }
      },
    })
    // Слить буфер задач, накопленных до инициализации очереди
    try {
      const q = downloadQueueRef.current
      if (q && pendingEnqRef.current.length) {
        for (const [did, mid, pr] of pendingEnqRef.current.splice(0)) {
          try { q.enqueue(did, mid, pr) } catch {}
        }
        try { const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(); if (metrics) console.debug('[auto-dl] drained buffered') } catch {}
      }
    } catch {}
    return () => { downloadQueueRef.current?.dispose(); downloadQueueRef.current = null }
  }, [])

  // Приоритетная подкачка: новейшие медиасообщения без файла — в очередь с высоким приоритетом
  useEffect(() => {
    if (!activeId || !Array.isArray(messages) || messages.length === 0) return
    // уважаем настройку автоскачивания по типу сущности
    (async () => {
      let ent: any = undefined
      try { ent = await ensureEntityForId(activeId) } catch {}
      if (!allowAutoDownloadByEntity(settings, ent)) return
      const tail = [...messages].slice(-10).reverse()
      for (const m of tail) {
        const anyM = m as any
        if (m.mediaType && !anyM.mediaBlob) {
          try {
            const row = await db.messages.get(msgKey(m.dialogId, m.msgId))
            if (!row?.mediaBlob) enqueueDownload(m.dialogId, m.msgId, 10)
          } catch {}
        }
      }
    })()
  }, [messages, activeId, settings])

  // When clicking media in message list, open gallery at that item
  const openGalleryAt = useCallback((msgId: number) => {
    const allowed = new Set(['photo','video','video_note','animation','audio','voice','document'])
    const items = messages.filter(m => allowed.has(m.mediaType as any))
    const idx = items.findIndex(m => m.msgId === msgId)
    setGalleryItems(items)
    setGalleryStart(idx >= 0 ? idx : 0)
    setGalleryOpen(true)
  }, [messages])

  

  if (authed === null) {
    return <div className="p-6 text-gray-500">Загрузка...</div>
  }

  if (!authed) {
    return <Auth onDone={() => window.location.reload()} />
  }

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden">
      {/* Баннер входящего звонка */}
      {incomingCall && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 bg-white border border-gray-200 shadow rounded-full px-4 py-2 flex items-center gap-2">
          <span className="text-lg" aria-hidden>{incomingCall.isVideo ? '🎥' : '📞'}</span>
          <span className="text-sm text-gray-800">Входящий {incomingCall.isVideo ? 'видеозвонок' : 'звонок'} от <b>{incomingCall.from}</b></span>
          <button className="ml-2 px-2 py-1 text-xs rounded-full bg-gray-100 hover:bg-gray-200" onClick={() => setIncomingCall(null)}>Скрыть</button>
        </div>
      )}
      <div className="h-full w-full flex min-h-0 overflow-hidden">
        <aside className={`${activeId ? 'hidden md:block' : 'block'} h-full w-full md:w-96 shrink-0 bg-white border-r border-gray-200 overflow-hidden min-h-0`}>
          {view === 'settings' ? (
            <SettingsPage
              onBack={closeSettings}
              onClearCache={onClearCache}
              onOpenAccounts={openAuth}
            />
          ) : view === 'auth' ? (
            <Auth onDone={() => { setView('chat'); window.location.reload() }} />
          ) : (
            <DialogsList dialogs={dialogs} hasMore={dialogsHasMore} onLoadMore={async () => {
              await loadDialogsPage(false)
            }} activeId={activeId ?? undefined} onSelect={(id, entity) => {
              (async () => {
                // cache entity from search (if any) so history loads immediately
                if (entity) {
                  entityByIdRef.current.set(id, entity)
                  activeEntityRef.current = entity
                  // Ensure dialog record exists; avatars will be handled in upsertDialogs
                  try {
                    const cls = (entity as any)?.className as string | undefined
                    const isUser = !!cls && cls.includes('User')
                    const isChannel = !!cls && cls.includes('Channel')
                    const isChat = !!cls && cls.includes('Chat') && !isChannel
                    const title = (entity as any)?.title || [
                      (entity as any)?.firstName,
                      (entity as any)?.lastName,
                    ].filter(Boolean).join(' ') || (entity as any)?.username || 'Диалог'
                    const peer: DialogPeer = {
                      id: String(id),
                      title,
                      isUser,
                      isChat,
                      isChannel,
                      pinned: false,
                      lastMessageAt: undefined,
                      entity,
                    } as any
                    await upsertDialogs([peer])
                  } catch {}
                }
                setActiveId(id)
              })()
            }}
            onOpenSettings={openSettings}
            onTogglePin={async (id, wantPin) => {
              const ent = await ensureEntityForId(id)
              if (!ent) return
              try {
                // оптимистично обновим локально
                await upsertDialogs([{ id, pinned: wantPin, pinRank: wantPin ? 0 : undefined } as any])
                await toggleDialogPin(ent, wantPin)
              } catch (e) {
                console.warn('toggle pin failed', e)
              }
            }}
            onToggleMute={async (id, mute) => {
              const ent = await ensureEntityForId(id)
              if (!ent) return
              try {
                // оптимистичное обновление
                await upsertDialogs([{ id, muted: mute, muteUntil: mute ? Math.floor(Date.now()/1000) + 365*24*3600 : 0 } as any])
                await toggleDialogMute(ent, mute)
              } catch (e) { console.warn('toggle mute failed', e) }
            }}
            onDeleteHistory={async (id) => {
              const ent = await ensureEntityForId(id)
              if (!ent) return
              try { await deleteDialogHistory(ent, false) } catch (e) { console.warn('delete history failed', e) }
            }}
            onDeleteForAll={async (id) => {
              const ent = await ensureEntityForId(id)
              if (!ent) return
              try { await deleteDialogHistory(ent, true) } catch (e) { console.warn('delete chat failed', e) }
            }}
            onClearCache={async (id) => {
              try { await clearDialogMessages(id) } catch {}
            }}
            getEntity={ensureEntityForId}
          />
          )}
        </aside>
        <main className={`${activeId ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 min-h-0 flex-col overflow-hidden`}>
          <header className="h-14 bg-white border-b border-gray-200 px-4 flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              {activeId && (
                <button
                  className="inline-flex items-center justify-center w-9 h-9 rounded border border-gray-300 hover:bg-gray-50"
                  onClick={() => {
                    setActiveId(null)
                    try { window.history.replaceState({ view: 'list' }, '') } catch {}
                  }}
                  aria-label="Назад к списку"
                >
                  ←
                </button>
              )}
              {activeId && (() => {
                const d = dialogs.find(dd => dd.id === activeId)
                const title = d?.title || activeId || 'Диалог'
                const avatar = (d as any)?.avatarSmall as string | undefined
                return (
                  <>
                    {avatar ? (
                      <img src={avatar} alt={title} className="w-8 h-8 rounded-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-semibold">
                        {(title || '').slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="font-semibold truncate max-w-[40vw] md:max-w-[50vw]">{title}</div>
                  </>
                )
              })()}
              {!activeId && (
                <div className="font-semibold truncate">Выберите диалог</div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {activeId && needsJoinId === activeId && (
                <button
                  className="px-3 py-1.5 text-sm border border-amber-400 text-amber-700 bg-amber-50 rounded hover:bg-amber-100"
                  onClick={async () => {
                    if (!activeId || !activeEntityRef.current) return
                    try {
                      await joinChannelIfNeeded(activeEntityRef.current)
                      const hist = await getHistory(activeEntityRef.current, 50)
                      oldestRef.current = hist.length ? hist[hist.length - 1].msgId : undefined
                      await upsertMessages(activeId, hist)
                      setNeedsJoinId(null)
                    } catch (e) {
                      // eslint-disable-next-line no-alert
                      alert('Не удалось подписаться/вступить. Возможно требуется приглашение или доступ ограничен.')
                    }
                  }}
                >Вступить/Подписаться</button>
              )}
              {activeId && (
                <button
                  onClick={() => setFolderOpen(true)}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
                >Медиа</button>
              )}
              {activeId && (
                <button
                  onClick={async () => {
                    if (!activeId) return
                    if (!confirm('Очистить кэш сообщений для этого чата?')) return
                    await clearDialogMessages(activeId)
                  }}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded hover:bg-gray-50"
                >Очистить кэш чата</button>
              )}
              {/* Кнопка настроек перенесена в DialogsList (левая панель) */}
            </div>
          </header>
          {view === 'auth' ? (
            // Auth теперь рендерится слева (в aside), правая панель остаётся как есть
            <></>
          ) : (
            <>
              <MessageList
                key={activeId || 'none'}
                messages={messages}
                canLoadMoreTop={!!oldestRef.current}
                canLoadMoreBottom={false}
                onLoadMoreTop={loadMoreTop}
                onLoadMoreBottom={async () => {}}
                onRequestFile={onRequestFileMsg}
                onOpenGalleryAt={openGalleryAt}
                onPickReply={(m: DBMessage) => setReplyTo(m)}
                activeEntity={activeEntityRef.current}
              />
              {activeId && (
                <>
                  <MediaFolderModal
                    open={folderOpen}
                    onClose={() => setFolderOpen(false)}
                    items={messages.filter(m => {
                      const t = m.mediaType as any
                      if (['photo','video','video_note','animation','audio','voice','document'].includes(t)) return true
                      if (m.text && /https?:\/\//i.test(m.text)) return true
                      return false
                    })}
                    onRequestFile={onRequestFileMsg}
                    onOpenItem={(filtered, startIndex) => {
                      setGalleryItems(filtered)
                      setGalleryStart(startIndex)
                      setFolderOpen(false)
                      setGalleryOpen(true)
                    }}
                  />
                  <MediaGalleryModal
                    open={galleryOpen}
                    onClose={() => setGalleryOpen(false)}
                    items={galleryItems.length ? galleryItems : []}
                    startIndex={galleryStart}
                    onRequestFile={onRequestFileMsg}
                  />
                </>
              )}
              <Composer activeEntity={activeEntityRef.current} disabled={!activeId} replyTo={replyTo} onClearReply={() => setReplyTo(null)} onSent={async () => {
                if (activeId && activeEntityRef.current) {
                  const hist = await getHistory(activeEntityRef.current, 50)
                  oldestRef.current = hist.length ? hist[hist.length - 1].msgId : oldestRef.current
                  // вставляем только если действительно новое
                  const lastLocal = messages.length ? messages[messages.length - 1].msgId : undefined
                  const newest = hist?.[0]
                  if (!lastLocal || (newest && newest.msgId > lastLocal)) {
                    await upsertMessages(activeId, hist)
                    setWindowLimit((l) => Math.max(l, (messages.length + 1)))
                  }
                }
              }} />
            </>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
