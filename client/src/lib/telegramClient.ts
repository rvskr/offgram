import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram';

const apiId = Number(import.meta.env.VITE_TELEGRAM_API_ID);
const apiHash = String(import.meta.env.VITE_TELEGRAM_API_HASH);

if (!apiId || !apiHash) {
  // Provide a clear error for missing env vars
  // eslint-disable-next-line no-console
  console.error('Missing VITE_TELEGRAM_API_ID or VITE_TELEGRAM_API_HASH in environment.');
}

// --- Simple in-memory entities cache (id -> entity) ---
const entitiesCache: Map<string, any> = new Map()

function entityIdFromPeerId(peerId: any): string | '' {
  try {
    return String(peerId?.userId ?? peerId?.channelId ?? peerId?.chatId ?? '')
  } catch { return '' }
}

export function cacheEntities(list: any[]) {
  for (const e of list || []) {
    try {
      const id = entityIdFromPeerId((e as any).id ? (e as any).id : (e as any).peerId)
      if (id) entitiesCache.set(id, e)
    } catch {}
  }
}

export async function ensureEntityForId(id: string): Promise<any | null> {
  if (entitiesCache.has(id)) return entitiesCache.get(id)
  try {
    // Prefer using cache populated from dialogs/pages; otherwise return null
    return entitiesCache.get(id) ?? null
  } catch { return null }
}

// --- Flood-wait guard wrapper ---
let cooldownUntil = 0
export async function withFloodGuard<T>(fn: () => Promise<T>): Promise<T> {
  // wait for global cooldown
  const now = Date.now()
  if (cooldownUntil > now) {
    await new Promise(res => setTimeout(res, Math.min(1000, cooldownUntil - now)))
  }
  try {
    return await fn()
  } catch (e: any) {
    const sec = Number((e && (e.seconds ?? e.duration ?? e.wait ?? undefined)))
    if (sec && isFinite(sec) && sec > 0) {
      cooldownUntil = Date.now() + sec * 1000 + 300
    }
    throw e
  }
}

// --- Small shared helpers to reduce duplication ---
function toUnix(ts: any): number {
  return typeof ts === 'number' ? ts : Math.floor(new Date(ts).getTime() / 1000)
}

function bufferToBlob(buf: any): Blob {
  return buf instanceof Blob ? buf : new Blob([buf])
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve) => {
    const r = new FileReader()
    r.onloadend = () => resolve(String(r.result))
    r.readAsDataURL(blob)
  })
}

function buildTitleFromEntity(entity: any): { id: string; title: string; isUser: boolean; isChat: boolean; isChannel: boolean } {
  let title = 'Unknown'
  let id = ''
  let isUser = false
  let isChat = false
  let isChannel = false
  if (entity) {
    if ('firstName' in entity || 'lastName' in entity) {
      title = [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || 'User'
      try { id = String(entity.id) } catch {}
      isUser = true
    }
    if ('title' in entity) {
      title = entity.title || title
      try { id = String(entity.id) } catch {}
      isChat = Boolean(entity.className?.includes('Chat'))
      isChannel = Boolean(entity.className?.includes('Channel'))
    }
    if (!id && 'id' in entity) { try { id = String(entity.id) } catch {} }
  }
  return { id, title, isUser, isChat, isChannel }
}

function getReplyToMsgId(m: any): number | undefined {
  const r = m?.replyTo || m?.reply_to
  const direct = m?.replyToMsgId ?? m?.reply_to_msg_id
  if (typeof direct === 'number') return direct
  const id = r?.replyToMsgId ?? r?.reply_to_msg_id ?? r?.replyToMsgID
  return typeof id === 'number' ? id : undefined
}

function extractMediaMeta(media: any): {
  mediaType?: 'photo' | 'video' | 'video_note' | 'audio' | 'voice' | 'sticker' | 'document' | 'animation' | 'unknown'
  mediaMime?: string
  mediaSize?: number
  fileName?: string
  mediaDuration?: number
  mediaWidth?: number
  mediaHeight?: number
} {
  let mediaType: any
  let mediaMime: string | undefined
  let mediaSize: number | undefined
  let fileName: string | undefined
  let mediaDuration: number | undefined
  let mediaWidth: number | undefined
  let mediaHeight: number | undefined
  if (!media) return {}
  if (media.photo) mediaType = 'photo'
  else if (media.document) {
    try {
      mediaMime = String((media.document as any).mimeType || '')
      mediaSize = Number((media.document as any).size || (media.document as any).size_) || undefined
      fileName = ((media.document as any).attributes || []).find((a: any) => String(a?.className || a?._ || '').includes('DocumentAttributeFilename'))?.fileName
      const attrs: any[] = (media.document as any).attributes || []
      let isRound = false
      for (const a of attrs) {
        const an = String(a?.className || a?._ || '')
        if (an.includes('DocumentAttributeVideo')) {
          if (typeof (a as any).w === 'number') mediaWidth = (a as any).w
          if (typeof (a as any).h === 'number') mediaHeight = (a as any).h
          if (typeof (a as any).duration === 'number') mediaDuration = (a as any).duration
          // video note (кружок) признак — roundMessage
          try { isRound = Boolean((a as any).roundMessage ?? (a as any).round_message ?? (a as any).round) } catch {}
          if (!mediaType) mediaType = isRound ? 'video_note' : 'video'
        }
        if (an.includes('DocumentAttributeAnimated')) mediaType = 'animation'
        if (an.includes('DocumentAttributeSticker')) mediaType = 'sticker'
        if (an.includes('DocumentAttributeImageSize')) {
          if (typeof (a as any).w === 'number') mediaWidth = mediaWidth ?? (a as any).w
          if (typeof (a as any).h === 'number') mediaHeight = mediaHeight ?? (a as any).h
        }
        if (an.includes('DocumentAttributeAudio')) {
          // Не перетираем видео/кружок/анимацию/стикер аудио-типом
          const highPriority = mediaType === 'video' || mediaType === 'video_note' || mediaType === 'animation' || mediaType === 'sticker'
          if (!highPriority) {
            mediaType = (a as any).voice ? 'voice' : 'audio'
          }
          if (typeof (a as any).duration === 'number') mediaDuration = (a as any).duration
        }
      }
      if (!mediaType) {
        if (mediaMime?.startsWith('image/')) mediaType = 'photo'
        else if (mediaMime?.startsWith('video/')) mediaType = (isRound ? 'video_note' : 'video')
        else if (mediaMime?.includes('gif')) mediaType = 'animation'
        else mediaType = 'document'
      }
    } catch {}
  } else if (media.webpage) {
    // ignore webpage previews for now
  } else if (media.game) {
    // ignore games
  }
  // Photos may have sizes array with dimensions
  try {
    if (!mediaWidth || !mediaHeight) {
      const sizes: any[] = (media?.photo?.sizes || media?.photo?.sizes_) || []
      let best: { w?: number; h?: number } | undefined
      for (const s of sizes) {
        const w = Number((s as any).w ?? (s as any).width)
        const h = Number((s as any).h ?? (s as any).height)
        if (Number.isFinite(w) && Number.isFinite(h)) {
          if (!best || (w * h) > ((best.w || 0) * (best.h || 0))) best = { w, h }
        }
      }
      if (best && (!mediaWidth || !mediaHeight)) {
        mediaWidth = mediaWidth ?? best.w
        mediaHeight = mediaHeight ?? best.h
      }
    }
  } catch {}
  // Documents (videos/animations) may also have thumbs with sizes
  try {
    if ((!mediaWidth || !mediaHeight) && media?.document) {
      const thumbs: any[] = (media.document as any).thumbs || (media.document as any).thumbs_ || []
      let best: { w?: number; h?: number } | undefined
      for (const t of thumbs) {
        const w = Number((t as any).w ?? (t as any).width)
        const h = Number((t as any).h ?? (t as any).height)
        if (Number.isFinite(w) && Number.isFinite(h)) {
          if (!best || (w * h) > ((best.w || 0) * (best.h || 0))) best = { w, h }
        }
      }
      if (best) {
        mediaWidth = mediaWidth ?? best.w
        mediaHeight = mediaHeight ?? best.h
      }
    }
  } catch {}
  return { mediaType, mediaMime, mediaSize, fileName, mediaDuration, mediaWidth, mediaHeight }
}

// --- Coalescing TTL cache for API calls and helpers ---
type CacheEntry<T> = { v: T; exp: number }
const cacheMap: Map<string, CacheEntry<any>> = new Map()
const inflight: Map<string, Promise<any>> = new Map()

function nowMs() { return Date.now() }
function setCache<T>(k: string, v: T, ttlMs: number) { cacheMap.set(k, { v, exp: nowMs() + ttlMs }) }
function tryGetCache<T>(k: string): T | undefined {
  const e = cacheMap.get(k)
  if (!e) return undefined
  if (e.exp < nowMs()) { cacheMap.delete(k); return undefined }
  return e.v as T
}

async function invokeWithCache<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })()
  const hit = tryGetCache<T>(key)
  if (typeof hit !== 'undefined') {
    if (metrics) console.debug('[cache-hit]', key)
    return hit
  }
  const inF = inflight.get(key)
  if (inF) {
    if (metrics) console.debug('[inflight-coalesce]', key)
    return inF as Promise<T>
  }
  const p = (async () => {
    try {
      const start = Date.now()
      const val = await withFloodGuard(fn)
      if (metrics) console.debug('[api-done]', key, (Date.now() - start) + 'ms')
      if (ttlMs > 0) setCache(key, val, ttlMs)
      return val
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

// Memo for getInputEntity/getEntity
const inputEntityCache = new Map<string, any>()
async function getCachedInputEntity(entityOrId: any): Promise<any> {
  const c = getClient()
  const key = (() => {
    try {
      if (typeof entityOrId === 'string') return entityOrId
      const raw = (entityOrId?.id ?? entityOrId?.userId ?? entityOrId?.channelId ?? entityOrId?.chatId)
      return raw ? String(raw) : JSON.stringify(entityOrId)
    } catch { return JSON.stringify(entityOrId) }
  })()
  const hit = inputEntityCache.get(key)
  if (hit) return hit
  const ip = await (c as any).getInputEntity(entityOrId)
  inputEntityCache.set(key, ip)
  return ip
}

// Coalesced getMessages by ids (short TTL)
async function getMessagesCached(entity: any, opts: any): Promise<any[]> {
  const c = getClient()
  await ensureConnected()
  const idsKey = Array.isArray(opts?.ids) ? (opts.ids as any[]).map((x) => String(x)).sort().join(',') : ''
  const key = 'getMessages:' + String(entity?.id ?? entity) + ':' + idsKey
  return invokeWithCache(key, 5_000, async () => await c.getMessages(entity, opts))
}

// --- Normalization helpers ---
export function normalizeMessage(m: any): {
  dialogId: string
  msgId: number
  date: number
  out: boolean
  fromId?: string
  senderName?: string
  text?: string
  mediaType?: 'photo' | 'video' | 'video_note' | 'audio' | 'voice' | 'sticker' | 'document' | 'animation' | 'unknown'
  mediaMime?: string
  mediaSize?: number
  fileName?: string
  replyToMsgId?: number
  mediaDuration?: number
  mediaWidth?: number
  mediaHeight?: number
} | null {
  if (!m) return null
  const peer = (m as any).peerId || (m as any).peer
  const dialogId = String(peer?.userId ?? peer?.channelId ?? peer?.chatId ?? '')
  if (!dialogId) return null
  // sender name
  let senderName: string | undefined
  try {
    const s = (m as any).sender || (m as any).from
    if (s) {
      if ('firstName' in s || 'lastName' in s) senderName = [s.firstName, s.lastName].filter(Boolean).join(' ') || (s as any).username
      else senderName = (s as any).title || (s as any).username
    }
  } catch {}
  const meta = extractMediaMeta((m as any).media)
  const { mediaType, mediaMime, mediaSize, fileName, mediaDuration } = meta
  let { mediaWidth, mediaHeight } = meta
  // Dimension fallbacks (no logging)
  try {
    if ((mediaType === 'photo' || mediaType === 'video' || mediaType === 'animation') && (!mediaWidth || !mediaHeight)) {
      // As last resort, try very shallow fallbacks
      const w = (m as any).width ?? (m as any).w
      const h = (m as any).height ?? (m as any).h
      if (!mediaWidth && Number.isFinite(w)) mediaWidth = Number(w)
      if (!mediaHeight && Number.isFinite(h)) mediaHeight = Number(h)
    }
  } catch {}
  const replyToMsgId = getReplyToMsgId(m)
  return {
    dialogId,
    msgId: Number((m as any).id),
    date: toUnix((m as any).date),
    out: Boolean((m as any).out),
    fromId: (m as any).fromId ? String((m as any).fromId.userId ?? (m as any).fromId.channelId ?? (m as any).fromId.chatId ?? '') : undefined,
    senderName,
    text: (m as any).message,
    mediaType,
    mediaMime,
    mediaSize,
    fileName,
    replyToMsgId,
    mediaDuration,
    mediaWidth,
    mediaHeight,
  }
}

// Extended normalization for history list with extra metadata used by UI
export function normalizeMessageExtended(m: any): (ReturnType<typeof normalizeMessage> & {
  entities?: any[]
  forwardedFrom?: string
  groupedId?: string
  serviceType?: 'phone_call'
  callReason?: 'missed' | 'busy' | 'ended' | 'declined'
  callOutgoing?: boolean
  callIsVideo?: boolean
  callDuration?: number
  edited?: boolean
  editedAt?: number
}) | null {
  const base = normalizeMessage(m)
  if (!base) return null
  let entities: any[] | undefined
  let forwardedFrom: string | undefined
  // edits
  let edited: boolean | undefined
  let editedAt: number | undefined
  // entities
  try { entities = Array.isArray((m as any).entities) ? (m as any).entities : undefined } catch {}
  // edited flags
  try {
    const ed: any = (m as any).editDate
    if (ed) {
      edited = true
      // editDate может быть числом (sec) или датой — приводим к epoch sec
      const ts = typeof ed === 'number' ? ed : toUnix(ed)
      editedAt = typeof ts === 'number' ? ts : undefined
    }
  } catch {}
  // forwarded
  try {
    const f: any = (m as any).fwdFrom
    if (f) {
      const id = (f.fromId?.userId ?? f.fromId?.channelId ?? f.fromId?.chatId)
      if (id) forwardedFrom = String(id)
    }
  } catch {}
  // grouped (albums)
  let groupedId: string | undefined
  try {
    const g = (m as any).groupedId ?? (m as any).grouped_id ?? (m as any).groupId
    if (typeof g !== 'undefined' && g !== null) {
      groupedId = String((g as any).value ?? g)
    }
  } catch {}
  // service phone call
  let serviceType: 'phone_call' | undefined
  let callReason: 'missed' | 'busy' | 'ended' | 'declined' | undefined
  let callOutgoing: boolean | undefined
  let callIsVideo: boolean | undefined
  let callDuration: number | undefined
  try {
    const cls = String((m as any).className || (m as any)._ || '')
    const act = (m as any).action
    const actName = String(act?.className || act?._ || '')
    if (cls.includes('MessageService') && act) {
      if (actName.includes('MessageActionPhoneCall')) {
        serviceType = 'phone_call'
        const r = String(act?.reason?.className || act?.reason?._ || '')
        if (r.includes('DiscardReasonMissed')) callReason = 'missed'
        else if (r.includes('DiscardReasonBusy')) callReason = 'busy'
        else if (r.includes('DiscardReasonHangup')) callReason = 'ended'
        else if (r.includes('DiscardReasonDisconnect') || r.includes('DiscardReasonDecline')) callReason = 'declined'
        callOutgoing = Boolean((m as any).out)
        callIsVideo = Boolean(act?.video)
        if (typeof act?.duration === 'number') callDuration = act.duration
      }
    }
  } catch {}
  return { ...base, entities, forwardedFrom, groupedId, serviceType, callReason, callOutgoing, callIsVideo, callDuration, edited, editedAt }
}

export async function getPeerDialogsBatch(entities: any[]): Promise<Array<{ dialogId: string; topMessage?: ReturnType<typeof normalizeMessage> }>> {
  if (!entities || entities.length === 0) return []
  cacheEntities(entities)
  const c = getClient()
  await ensureConnected()
  const InputDialogPeer = (Api as any).InputDialogPeer
  const peers = [] as any[]
  for (const e of entities) {
    try {
      const ip = await getCachedInputEntity(e)
      peers.push(new InputDialogPeer({ peer: ip }))
    } catch {}
  }
  if (!peers.length) return []
  const res = await invokeWithCache('messages.GetPeerDialogs:' + peers.length, 10_000, async () => await (c as any).invoke(new (Api as any).messages.GetPeerDialogs({ peers })))
  try {
    const msgs: any[] = (res as any).messages || []
    const byId = new Map<number, any>()
    for (const m of msgs) byId.set(Number((m as any).id), m)
    const out: Array<{ dialogId: string; topMessage?: ReturnType<typeof normalizeMessage> }> = []
    for (const d of ((res as any).dialogs || [])) {
      try {
        const peerId = (d as any).peer?.userId ?? (d as any).peer?.channelId ?? (d as any).peer?.chatId
        const dialogId = String(peerId ?? '')
        let top: any
        const topId = Number((d as any).topMessage || 0)
        if (topId && byId.has(topId)) top = byId.get(topId)
        const norm = normalizeMessage(top)
        if (dialogId) out.push({ dialogId, topMessage: norm || undefined })
      } catch {}
    }
    // Also cache users/chats
    cacheEntities((res as any).users || [])
    cacheEntities((res as any).chats || [])
    return out
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('getPeerDialogsBatch failed', e)
    return []
  }
}

// Fetch a single message by id and normalize minimal fields used in UI
export async function getMessageById(entity: any, msgId: number): Promise<{
  dialogId: string
  msgId: number
  date: number
  out: boolean
  fromId?: string
  senderName?: string
  text?: string
  mediaType?: 'photo' | 'video' | 'video_note' | 'audio' | 'voice' | 'sticker' | 'document' | 'animation' | 'unknown'
  mediaMime?: string
  mediaSize?: number
  fileName?: string
} | null> {
  await ensureConnected()
  try {
    const msgs = await getMessagesCached(entity, { ids: [msgId] })
    const m: any = msgs?.[0]
    if (!m) return null
    const norm = normalizeMessage(m)
    if (!norm) return null
    // keep the original return shape (no replyToMsgId)
    const { dialogId, msgId: id, date, out, fromId, senderName, text, mediaType, mediaMime, mediaSize, fileName } = norm
    return { dialogId, msgId: id, date, out, fromId, senderName, text, mediaType, mediaMime, mediaSize, fileName }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('getMessageById failed', e)
    return null
  }
}

export async function subscribeCallUpdates(handler: (update: any) => void) {
  const c = getClient()
  await ensureConnected()
  try {
    const ev = await import('telegram/events') as any
    if (ev?.Raw) {
      c.addEventHandler(handler as any, new ev.Raw({}))
      return () => { try { (c as any).removeEventHandler?.(handler) } catch {} }
    }
  } catch {}
  // fallback: generic
  // @ts-ignore
  c.addEventHandler(handler as any)
  return () => { try { (c as any).removeEventHandler?.(handler) } catch {} }
}

// Try to join a channel (or supergroup) to ensure we can view history
export async function joinChannelIfNeeded(entity: any): Promise<boolean> {
  try {
    const c = getClient()
    await ensureConnected()
    // In GramJS, JoinChannel works for channels and supergroups
    await (c as any).invoke(new (Api as any).channels.JoinChannel({ channel: entity }))
    return true
  } catch (e: any) {
    // Ignore common cases when already a participant or joining not required
    // eslint-disable-next-line no-console
    console.debug('joinChannelIfNeeded skipped', e?.message || e)
    return false
  }
}

// Try to extract a stable id of the current (top) profile photo from a peer entity
export function getPeerTopPhotoId(entity: any): string | undefined {
  try {
    const p = entity?.photo
    // GramJS User/Chat/Channel entities often have .photo with .photoId (bigint)
    const raw = (p?.photoId ?? p?._photoId ?? p?.id ?? p?._id)
    if (typeof raw !== 'undefined' && raw !== null) {
      // BigInt | number | string
      try { return String(raw) } catch { /* ignore */ }
    }
    // Some builds expose sizes; pick biggest/smallest id
    const sizes = p?.sizes || p?._sizes
    if (Array.isArray(sizes) && sizes[0]) {
      const sid = sizes[0].id ?? sizes[0]._id
      if (typeof sid !== 'undefined') return String(sid)
    }
  } catch {}
  return undefined
}

// Subscribe to edit/delete updates.
export async function subscribeEditsDeletes(handler: (update: any) => void) {
  const c = getClient()
  await ensureConnected()
  try {
    const ev = await import('telegram/events') as any
    if (ev?.EditedMessage) {
      c.addEventHandler(handler as any, new ev.EditedMessage({}))
    }
    if (ev?.MessageDeleted) {
      c.addEventHandler(handler as any, new ev.MessageDeleted({}))
    }
    // Fallback: also listen for NewMessage to catch some service edits
    if (ev?.Raw) {
      // Some GramJS builds expose Raw to receive all updates
      c.addEventHandler(handler as any, new ev.Raw({}))
    }
  } catch {
    // As a last resort, attach a generic handler without filter
    // @ts-ignore
    c.addEventHandler(handler as any)
  }
  return () => {
    try { (c as any).removeEventHandler?.(handler) } catch {}
  }
}

// Download small avatar for a peer entity and return as data URL (or null if absent)
export async function downloadPeerAvatarSmall(entity: any): Promise<string | null> {
  const c = getClient()
  await ensureConnected()
  try {
    // PhotoId-based cache to avoid re-downloading unchanged avatars
    const topId = getPeerTopPhotoId(entity)
    const avaCacheKey = topId ? 'ava:' + topId : undefined
    if (avaCacheKey) {
      const hit = tryGetCache<string>(avaCacheKey)
      if (hit) return hit
    }
    // Some GramJS builds expose helper to download profile photo directly
    try {
      // @ts-ignore experimental helper if available
      const buf = await (c as any).downloadProfilePhoto?.(entity, { isBig: false })
      if (buf) {
        const blob = bufferToBlob(buf)
        const url = await blobToDataUrl(blob)
        if (avaCacheKey) setCache(avaCacheKey, url, 24 * 3600_000)
        return url
      }
    } catch {}

    // Fallback: query profile photos and download smallest thumb
    // @ts-ignore getProfilePhotos exists on TelegramClient
    const photos = await (c as any).getProfilePhotos(entity, { limit: 1 })
    const p = Array.isArray(photos) ? photos[0] : (photos?.photos?.[0] ?? photos?.[0])
    if (!p) return null
    // @ts-ignore downloadMedia should work on photo
    const buf = await (c as any).downloadMedia(p, { thumb: 'small' })
    if (!buf) return null
    const blob = bufferToBlob(buf)
    const url = await blobToDataUrl(blob)
    if (avaCacheKey) setCache(avaCacheKey, url, 24 * 3600_000)
    return url
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('downloadPeerAvatarSmall failed', e)
    return null
  }
}

// Persist session string in localStorage
const SESSION_KEY = 'tg_session_string';
// Multi-account storage
const ACCOUNTS_KEY = 'tg_accounts_v1';
export type StoredAccount = {
  id: string
  label?: string
  userId?: string
  phone?: string
  session: string
}

export function getStoredSession(): string {
  return localStorage.getItem(SESSION_KEY) ?? '';
}

export function setStoredSession(sess: string) {
  localStorage.setItem(SESSION_KEY, sess);
}

function readAccounts(): StoredAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter(a => a && typeof a.session === 'string')
    return []
  } catch { return [] }
}

function writeAccounts(list: StoredAccount[]) {
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)) } catch {}
}

export function getAccounts(): StoredAccount[] {
  return readAccounts()
}

export function getActiveAccountId(): string | undefined {
  const sess = getStoredSession()
  if (!sess) return undefined
  const list = readAccounts()
  const found = list.find(a => a.session === sess)
  return found?.id
}

export async function addCurrentAccount(): Promise<StoredAccount | null> {
  const sess = getStoredSession()
  if (!sess) return null
  const list = readAccounts()
  if (list.some(a => a.session === sess)) return list.find(a => a.session === sess) || null
  // Try to enrich label from current client
  let label: string | undefined; let userId: string | undefined; let phone: string | undefined
  try {
    const c = getClient()
    await ensureConnected()
    const me: any = await c.getMe()
    label = [me?.firstName, me?.lastName].filter(Boolean).join(' ') || me?.username || 'Аккаунт'
    try { userId = me?.id ? String(me.id) : undefined } catch {}
    try { phone = me?.phone ? String(me.phone) : undefined } catch {}
  } catch {}
  const acc: StoredAccount = {
    id: String(Date.now()) + ':' + Math.random().toString(36).slice(2, 8),
    label,
    userId,
    phone,
    session: sess,
  }
  const next = [...list, acc]
  writeAccounts(next)
  return acc
}

export function removeAccount(id: string) {
  const list = readAccounts()
  const next = list.filter(a => a.id !== id)
  writeAccounts(next)
}

export function switchAccount(id: string): boolean {
  const list = readAccounts()
  const acc = list.find(a => a.id === id)
  if (!acc) return false
  // set new session and reset client singleton; next ensureConnected() will re-connect
  setStoredSession(acc.session)
  try { client = null } catch {}
  try { connecting = null } catch {}
  return true
}

// Create a singleton Telegram client
let client: TelegramClient | null = null;
let connecting: Promise<void> | null = null;

export function getClient(): TelegramClient {
  if (!client) {
    const stringSession = new StringSession(getStoredSession());
    client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });
  }
  return client;
}

export async function ensureConnected() {
  const c = getClient();
  // @ts-ignore check connected flag if present
  if ((c as any).connected) return;
  if (connecting) {
    await connecting;
    return;
  }
  connecting = (async () => {
    const maxAttempts = 3;
    let lastErr: unknown = null;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await c.connect();
        // @ts-ignore
        if ((c as any).connected) return;
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 + i * 300));
      }
    }
    if (lastErr) throw lastErr;
  })();
  try {
    await connecting;
  } finally {
    connecting = null;
  }
}

export function clearSession() {
  try {
    setStoredSession('');
    // Reset singleton
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // @ts-ignore
    if (client) client.session = new StringSession('')
  } catch {}
}

export async function startAuth(
  phoneNumber: string,
  onCode?: () => Promise<string>,
  onPassword?: () => Promise<string>,
) {
  const c = getClient();

  await c.start({
    phoneNumber: async () => phoneNumber,
    phoneCode: async () => {
      if (!onCode) throw new Error('No code provider');
      return onCode();
    },
    password: async () => {
      if (!onPassword) throw new Error('No password provider');
      return onPassword();
    },
    onError: (err) => {
      // eslint-disable-next-line no-console
      console.error('Auth error:', err);
    },
  });

  // Save session
  const sess = (c.session as StringSession).save();
  setStoredSession(sess);
}

export async function isAuthorized(): Promise<boolean> {
  const c = getClient();
  try {
    // If we have a session, try connecting
    await ensureConnected();
    // Any call that requires auth will throw if not authorized
    const me = await c.getMe();
    return Boolean(me);
  } catch {
    return false;
  }
}

// Basic dialogs/messages helpers
export type DialogPeer = {
  id: string
  title: string
  isUser?: boolean
  isChat?: boolean
  isChannel?: boolean
  pinned?: boolean
  archived?: boolean
  folderId?: number
  pinRank?: number
  lastMessageAt?: number
  entity: any
}

export async function getDialogs(limit = 30): Promise<DialogPeer[]> {
  const c = getClient()
  await ensureConnected()
  const dialogs = await c.getDialogs({ limit })
  const peers: DialogPeer[] = dialogs.map((d: any) => {
    const entity = d.entity
    const meta = buildTitleFromEntity(entity)
    // pinned/archived/last activity
    const pinnedRaw = (d as any).pinned
    // В полном списке диалогов трактуем отсутствие как не закреплён
    const pinned = Boolean(pinnedRaw)
    const folderId: number | undefined = (d as any).folderId
    const archivedRaw = (d as any).archived
    const archived = folderId === 1 ? true : (archivedRaw === undefined ? undefined : Boolean(archivedRaw))
    let lastMessageAt: number | undefined = undefined
    try {
      const dt = (d as any).date || (d as any).message?.date
      if (dt) lastMessageAt = toUnix(dt)
    } catch {}
    // Fallbacks: sometimes dialog container has peer ids
    let id = meta.id
    if (!id) {
      const peer = (d as any).peer || {}
      id = String(peer.userId ?? peer.channelId ?? peer.chatId ?? (d as any).id ?? '')
    }
    return { id, title: meta.title, isUser: meta.isUser, isChat: meta.isChat, isChannel: meta.isChannel, pinned, archived, folderId, lastMessageAt, entity } as DialogPeer
  })
  // Сохраняем порядок закреплённых как пришёл из Telegram
  let rank = 0
  for (const p of peers) {
    if (p.pinned === true) (p as any).pinRank = rank++
  }
  return peers
}

export async function getHistory(entity: any, limit = 20, offsetId?: number): Promise<any[]> {
  const c = getClient()
  await ensureConnected()
  const opts: any = { limit }
  if (offsetId) opts.offsetId = offsetId
  const msgs = await c.getMessages(entity, opts)
  return msgs.map(m => normalizeMessageExtended(m)).filter(Boolean) as any[]
}

export async function getMoreHistory(entity: any, oldestMsgId?: number, pageSize = 20) {
  // Используем oldestMsgId - 1, чтобы запрашивать СТРОГО более старые сообщения
  // (offsetId == X у GramJS часто включает X в выдачу; X-1 снижает дубли)
  const nextOffset = (typeof oldestMsgId === 'number' && Number.isFinite(oldestMsgId))
    ? Math.max(0, oldestMsgId - 1)
    : undefined
  return getHistory(entity, pageSize, nextOffset)
}

// Resolve peer entity and best-effort title by ID (user/chat/channel)
export async function resolvePeerEntityTitle(rawId: any): Promise<{ entity: any | null; title: string | undefined }> {
  const c = getClient()
  await ensureConnected()
  let id: any = rawId
  try {
    if (rawId && typeof rawId === 'object' && 'value' in rawId) id = (rawId as any).value
  } catch {}
  try {
    const ent = await invokeWithCache('getEntity:' + String(id), 60_000, async () => await c.getEntity(id))
    if (!ent) return { entity: null, title: undefined }
    let title: string | undefined
    if ('firstName' in ent || 'lastName' in ent) {
      title = [ent.firstName, ent.lastName].filter(Boolean).join(' ') || (ent as any).username
    } else {
      title = (ent as any).title || (ent as any).username
    }
    return { entity: ent, title }
  } catch {
    return { entity: null, title: undefined }
  }
}

// Pagination for dialogs (infinite scroll support)
export type DialogsPageCursor = {
  offsetDate?: number
  offsetPeer?: any
  offsetId?: number
}

export async function getDialogsPage(limit = 50, cursor?: DialogsPageCursor): Promise<{
  peers: DialogPeer[]
  nextCursor?: DialogsPageCursor
  hasMore: boolean
}> {
  const c = getClient()
  await ensureConnected()
  // GramJS getDialogs supports offset parameters
  const params: any = { limit }
  if (cursor?.offsetDate) params.offsetDate = cursor.offsetDate
  if (cursor?.offsetPeer) params.offsetPeer = cursor.offsetPeer
  if (typeof cursor?.offsetId === 'number' && Number.isFinite(cursor.offsetId)) {
    // clamp to 32-bit signed int range to satisfy TL int
    const INT32_MAX = 0x7fffffff
    params.offsetId = Math.max(0, Math.min(INT32_MAX, Math.floor(cursor.offsetId)))
  }
  const list: any[] = await c.getDialogs(params)
  const peers = list.map((d: any) => {
    const entity = d.entity
    const meta = buildTitleFromEntity(entity)
    const pinnedRaw = (d as any).pinned
    const pinned = pinnedRaw === undefined ? undefined : Boolean(pinnedRaw)
    const folderId: number | undefined = (d as any).folderId
    const archivedRaw = (d as any).archived
    const archived = folderId === 1 ? true : (archivedRaw === undefined ? undefined : Boolean(archivedRaw))
    let lastMessageAt: number | undefined = undefined
    try {
      const dt = (d as any).date || (d as any).message?.date
      if (dt) lastMessageAt = toUnix(dt)
    } catch {}
    let id = meta.id
    if (!id) {
      const peer = (d as any).peer || {}
      id = String(peer.userId ?? peer.channelId ?? peer.chatId ?? (d as any).id ?? '')
    }
    return { id, title: meta.title, isUser: meta.isUser, isChat: meta.isChat, isChannel: meta.isChannel, pinned, archived, folderId, lastMessageAt, entity } as DialogPeer
  }) as DialogPeer[]
  // Порядок закреплённых по ответу Telegram
  let rank = 0
  for (const p of peers) {
    if (p.pinned === true) (p as any).pinRank = rank++
  }
  // next cursor from last item in page
  let nextCursor: DialogsPageCursor | undefined
  if (list.length) {
    const last = list[list.length - 1]
    const ts = (last as any).date || (last as any).message?.date
    const offsetDate = ts ? (typeof ts === 'number' ? ts : Math.floor(new Date(ts).getTime() / 1000)) : undefined
    const offsetPeer = last?.entity ?? (last as any).peer
    // offsetId must be message id (int32), not peer id (which may be 64-bit)
    const rawMsgId = (last as any).message?.id
    const offsetId = typeof rawMsgId === 'number' ? rawMsgId : 0
    nextCursor = { offsetDate, offsetPeer, offsetId }
  }
  const hasMore = (list?.length ?? 0) === limit
  return { peers, nextCursor, hasMore }
}

// Global search helpers
export type SearchPeer = DialogPeer
export type GlobalMessageHit = {
  dialogId: string
  msgId: number
  date: number
  text?: string
  senderName?: string
}

export async function searchContacts(query: string, limit = 30): Promise<SearchPeer[]> {
  const c = getClient()
  await ensureConnected()
  try {
    const res: any = await invokeWithCache(
      'contacts.Search:' + JSON.stringify({ q: query, limit }),
      30_000,
      async () => await (c as any).invoke(new (Api as any).contacts.Search({ q: query, limit }))
    )
    const users: any[] = Array.isArray(res?.users) ? res.users : []
    const chats: any[] = Array.isArray(res?.chats) ? res.chats : []
    const entities = [...users, ...chats]
    return entities.map((entity: any) => {
      const meta = buildTitleFromEntity(entity)
      return { id: meta.id, title: meta.title, isUser: meta.isUser, isChat: meta.isChat, isChannel: meta.isChannel, entity } as DialogPeer
    })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('searchContacts failed', e)
    return []
  }
}

export async function searchGlobalMessages(query: string, limit = 20): Promise<GlobalMessageHit[]> {
  const c = getClient()
  await ensureConnected()
  try {
    const InputPeerEmpty = (Api as any).InputPeerEmpty
    const InputMessagesFilterEmpty = (Api as any).InputMessagesFilterEmpty
    const res: any = await invokeWithCache(
      'messages.SearchGlobal:' + JSON.stringify({ q: query, limit }),
      30_000,
      async () => await (c as any).invoke(new (Api as any).messages.SearchGlobal({
        q: query,
        limit,
        offsetRate: 0,
        offsetPeer: new InputPeerEmpty(),
        filter: new InputMessagesFilterEmpty(),
      }))
    )
    const msgs: any[] = Array.isArray(res?.messages) ? res.messages : []
    const hits: GlobalMessageHit[] = []
    for (const m of msgs) {
      const peer = (m as any).peerId || (m as any).peer
      const dialogId = String(peer?.userId ?? peer?.channelId ?? peer?.chatId ?? '')
      if (!dialogId) continue
      const text = (m as any).message
      const dateRaw = (m as any).date
      const date = toUnix(dateRaw)
      const msgId = Number((m as any).id)
      hits.push({ dialogId, msgId, date, text })
    }
    return hits
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('searchGlobalMessages failed', e)
    return []
  }
}

export async function downloadMessageThumb(entity: any, msgId: number): Promise<string | null> {
  const c = getClient()
  await ensureConnected()
  try {
    const msgs = await getMessagesCached(entity, { ids: [msgId] })
    const m = msgs?.[0]
    if (!m) return null
    // @ts-ignore gramjs client can download media from message; try to get small thumb where possible
    const buf = await (c as any).downloadMedia(m, { thumb: 'small' })
    if (!buf) return null
    const blob = bufferToBlob(buf)
    return await blobToDataUrl(blob)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('downloadMessageThumb failed', e)
    return null
  }
}

export async function downloadMessageFile(entity: any, msgId: number): Promise<Blob | null> {
  const c = getClient()
  await ensureConnected()
  try {
    const msgs = await getMessagesCached(entity, { ids: [msgId] })
    const m = msgs?.[0]
    if (!m) return null
    // @ts-ignore gramjs client can download media from message
    const buf = await (c as any).downloadMedia(m, {})
    if (!buf) return null
    // Derive MIME type from media meta to ensure proper playback (e.g., video/mp4, video/webm)
    let mime: string | undefined
    try {
      const meta = extractMediaMeta((m as any).media)
      if (meta?.mediaMime) mime = meta.mediaMime
    } catch {}
    return mime ? new Blob([buf], { type: mime }) : bufferToBlob(buf)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('downloadMessageFile failed', e)
    return null
  }
}

export async function sendText(entity: any, text: string, replyToMsgId?: number) {
  const c = getClient()
  await ensureConnected()
  const opts: any = { message: text }
  if (typeof replyToMsgId === 'number') {
    // GramJS supports numeric replyTo for sendMessage options
    // @ts-ignore
    opts.replyTo = replyToMsgId
  }
  await c.sendMessage(entity, opts)
}

export async function sendFile(entity: any, file: File, caption?: string, replyToMsgId?: number) {
  const c = getClient()
  await ensureConnected()
  const opts: any = { file, caption }
  if (typeof replyToMsgId === 'number') {
    // @ts-ignore replyTo is supported by gramjs
    opts.replyTo = replyToMsgId
  }
  // @ts-ignore gramjs supports sendFile in browser with File/Blob
  await c.sendFile(entity, opts)
}

// Deprecated alias retained for compatibility
export async function downloadPeerAvatar(entity: any): Promise<string | null> {
  return downloadPeerAvatarSmall(entity)
}

// Dialog actions
export async function toggleDialogPin(entity: any, pinned: boolean): Promise<void> {
  const c = getClient()
  await ensureConnected()
  try {
    // messages.ToggleDialogPin expects InputDialogPeer
    const inputPeer = await getCachedInputEntity(entity)
    const inputDialogPeer = new (Api as any).InputDialogPeer({ peer: inputPeer })
    await (c as any).invoke(new (Api as any).messages.ToggleDialogPin({ peer: inputDialogPeer, pinned }))
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('toggleDialogPin failed', e)
    throw e
  }
}

export async function toggleDialogMute(entity: any, mute: boolean): Promise<void> {
  const c = getClient()
  await ensureConnected()
  try {
    const until = mute ? Math.floor(Date.now() / 1000) + 365 * 24 * 3600 : 0
    const InputPeerNotifySettings = (Api as any).InputPeerNotifySettings
    const inputPeer = await getCachedInputEntity(entity)
    const InputNotifyPeer = (Api as any).InputNotifyPeer
    await (c as any).invoke(new (Api as any).account.UpdateNotifySettings({
      peer: new InputNotifyPeer({ peer: inputPeer }),
      settings: new InputPeerNotifySettings({ muteUntil: until })
    }))
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('toggleDialogMute failed', e)
    throw e
  }
}

// Read dialog notification settings and compute current mute status
export async function getDialogNotifySettings(entity: any): Promise<{ muted: boolean; muteUntil?: number; raw: any }> {
  const c = getClient()
  await ensureConnected()
  try {
    const inputPeer = await getCachedInputEntity(entity)
    const InputNotifyPeer = (Api as any).InputNotifyPeer
    const res = await invokeWithCache(
      'account.GetNotifySettings:' + String((entity?.id ?? 'x')),
      10 * 60_000,
      async () => await (c as any).invoke(new (Api as any).account.GetNotifySettings({ peer: new InputNotifyPeer({ peer: inputPeer }) }))
    )
    const muteUntil = (res as any)?.muteUntil as number | undefined
    const now = Math.floor(Date.now() / 1000)
    const muted = typeof muteUntil === 'number' && muteUntil > now
    return { muted, muteUntil, raw: res }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('getDialogNotifySettings failed', e)
    return { muted: false, raw: null }
  }
}

export async function deleteDialogHistory(entity: any, revoke = false): Promise<void> {
  const c = getClient()
  await ensureConnected()
  try {
    await (c as any).invoke(new (Api as any).messages.DeleteHistory({ peer: entity, revoke }))
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('deleteDialogHistory failed', e)
    throw e
  }
}

// Subscribe to new messages
export async function subscribeNewMessages(handler: (update: any) => void) {
  const c = getClient()
  await ensureConnected()
  const { NewMessage } = await import('telegram/events')
  // @ts-ignore
  c.addEventHandler(handler as any, new NewMessage({}))
  return () => {
    // @ts-ignore remove not available; using off-like workaround
    try { c.removeEventHandler?.(handler) } catch {}
  }
}

// Subscribe to raw updates (all types)
export async function subscribeRaw(handler: (update: any) => void) {
  const c = getClient()
  await ensureConnected()
  try {
    const ev = await import('telegram/events') as any
    if (ev?.Raw) {
      c.addEventHandler(handler as any, new ev.Raw({}))
      return () => { try { (c as any).removeEventHandler?.(handler) } catch {} }
    }
  } catch {}
  // fallback generic
  // @ts-ignore
  c.addEventHandler(handler as any)
  return () => { try { (c as any).removeEventHandler?.(handler) } catch {} }
}

// (streaming helpers removed; use full-file downloads only)
