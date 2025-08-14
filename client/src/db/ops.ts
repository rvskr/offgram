import { db, type DBDialog, type DBMessage, msgKey, type DBUser, type DBMessageVersion } from './db'
import type { DialogPeer } from '../lib/telegramClient'

export async function upsertDialogs(peers: DialogPeer[]) {
  const items: DBDialog[] = peers
    .filter((p) => !!p.id)
    .map((p) => ({
      id: p.id,
      // Не форсим id как title: пусть будет undefined, чтобы не перетёреть человеческое имя
      title: p.title,
      kind: p.isChannel ? 'channel' : p.isChat ? 'chat' : 'user',
      // не затираем undefined -> false, оставим как есть; сольём ниже с prev
      pinned: (p as any).pinned as any,
      pinRank: (p as any).pinRank as any,
      archived: (p as any).archived as any,
      folderId: (p as any).folderId,
      // не сбрасываем на 0 — оставим как есть; сольём ниже с prev
      lastMessageAt: (p as any).lastMessageAt as any,
    }))

  // Upsert dialogs preserving existing fields (like avatarSmall)
  await db.transaction('rw', db.dialogs, db.users, async () => {
    const sameDialog = (a: DBDialog, b: DBDialog) => {
      return (
        a.id === b.id &&
        a.title === b.title &&
        a.kind === b.kind &&
        a.pinned === b.pinned &&
        a.pinRank === b.pinRank &&
        a.archived === b.archived &&
        a.folderId === b.folderId &&
        a.lastMessageAt === b.lastMessageAt &&
        a.avatarSmall === b.avatarSmall &&
        a.avatarPhotoId === b.avatarPhotoId
      );
    };
    for (const it of items) {
      const prev = await db.dialogs.get(it.id)
      if (prev) {
        // Важное правило: не понижаем флаги до false на частичных апдейтах
        // (например, при заходе в диалог приходит объект без информации о pin).
        // Но если явно пришёл pinned:false — считаем откреплением и сбрасываем pinRank.
        let nextPinned: boolean | undefined = prev.pinned
        let nextPinRank: number | undefined = prev.pinRank as any
        if (it.pinned === true) {
          nextPinned = true
          // при закреплении сохраняем порядок из Telegram, если пришёл; иначе оставим предыдущий
          nextPinRank = (it as any).pinRank !== undefined ? (it as any).pinRank : nextPinRank
        } else if (it.pinned === false) {
          nextPinned = undefined
          nextPinRank = undefined
        }
        // Не затираем title на числовой id при частичных апдейтах
        const nextTitle = (it.title !== undefined && it.title !== it.id) ? it.title : prev.title
        const merged: DBDialog = {
          ...prev,
          ...it,
          title: nextTitle,
          pinned: nextPinned,
          pinRank: nextPinRank,
          archived: it.archived === true ? true : prev.archived,
          // folderId также не затираем на undefined
          folderId: it.folderId !== undefined ? it.folderId : prev.folderId,
          // если lastMessageAt не пришёл — сохраняем прошлый
          lastMessageAt: it.lastMessageAt !== undefined ? it.lastMessageAt : prev.lastMessageAt,
        }
        if (!sameDialog(prev, merged)) {
          await db.dialogs.put(merged)
        }
      } else {
        const firstPinned = it.pinned === true ? true : undefined
        const firstPinRank = firstPinned ? (it as any).pinRank : undefined
        // При первичной вставке попытаемся взять имя из users, если title не пришёл
        let initialTitle = it.title
        if (!initialTitle || initialTitle === it.id) {
          try {
            const u = await db.users.get(it.id)
            if (u) initialTitle = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || initialTitle || it.id
          } catch {}
        }
        await db.dialogs.put({
          ...it,
          title: initialTitle || it.id,
          pinned: firstPinned,
          pinRank: firstPinRank as any,
          archived: it.archived === true ? true : undefined,
        } as DBDialog)
      }
    }
    // upsert users for direct dialogs to resolve names/avatars, preserving avatarSmall
    const userItems: DBUser[] = items
      .filter((d) => d.kind === 'user')
      .map((d) => ({ id: d.id, username: undefined, firstName: d.title }))
    for (const u of userItems) {
      const prev = await db.users.get(u.id)
      if (prev) {
        await db.users.put({ ...prev, ...u })
      } else {
        await db.users.put(u)
      }
    }
  })
  // Eager network fetching of avatars removed.
  // Загрузка аватаров теперь лениво инициируется в списке диалогов по видимости элемента.
  // debug
  try {
    const count = await db.dialogs.count()
    const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })()
    if (metrics) {
      // eslint-disable-next-line no-console
      console.debug('[Dexie] dialogs upserted:', items.length, 'total:', count)
    }
  } catch {}
}

export async function markMessagesDeleted(dialogId: string, msgIds: number[]) {
  await db.transaction('rw', db.messages, async () => {
    for (const mid of msgIds) {
      const id = msgKey(dialogId, mid)
      const prev = await db.messages.get(id)
      if (prev) {
        await db.messages.update(id, { deleted: true })
      }
    }
  })
}

export async function updateMessageBlob(dialogId: string, msgId: number, blob: Blob) {
  const id = msgKey(dialogId, msgId)
  await db.transaction('rw', db.messages, async () => {
    const prev = await db.messages.get(id)
    if (prev) {
      await db.messages.put({ ...prev, mediaBlob: blob })
    } else {
      // как минимум создадим каркас записи, чтобы реактивность сработала
      await db.messages.put({
        id,
        dialogId,
        msgId,
        date: Math.floor(Date.now() / 1000),
        out: false,
        mediaBlob: blob,
      } as any)
    }
  })
}

export async function upsertMessages(dialogId: string, msgs: Array<{ msgId: number; date: number; out: boolean; fromId?: any; message?: string; senderName?: string; replyToMsgId?: number; edited?: boolean; editVersion?: number; editedAt?: number; entities?: Array<{ offset: number; length: number; type: string; url?: string }>; forwardedFrom?: string; mediaType?: string; mediaMime?: string; mediaSize?: number; mediaDuration?: number; mediaWidth?: number; mediaHeight?: number; fileName?: string; groupedId?: string; serviceType?: 'phone_call' | 'video_chat'; callIsVideo?: boolean; callOutgoing?: boolean; callReason?: 'missed' | 'declined' | 'busy' | 'ended'; callDuration?: number }>) {
  const items: DBMessage[] = msgs.map((m) => ({
    id: msgKey(dialogId, m.msgId),
    dialogId,
    msgId: m.msgId,
    date: m.date,
    out: !!m.out,
    fromId: m.fromId ? String((m.fromId as any).userId ?? (m.fromId as any).channelId ?? (m.fromId as any).chatId ?? '') : undefined,
    senderName: m.senderName,
    text: (m as any).message ?? (m as any).text,
    replyToMsgId: m.replyToMsgId,
    entities: m.entities as any,
    forwardedFrom: m.forwardedFrom,
    edited: m.edited,
    editVersion: m.editVersion ?? 0,
    editedAt: m.editedAt,
    mediaType: m.mediaType as any,
    mediaMime: m.mediaMime,
    mediaSize: m.mediaSize,
    mediaDuration: m.mediaDuration,
    mediaWidth: m.mediaWidth,
    mediaHeight: m.mediaHeight,
    fileName: m.fileName,
    groupedId: (m as any).groupedId ?? (m as any).groupId,
    // service / calls
    serviceType: m.serviceType as any,
    callIsVideo: m.callIsVideo,
    callOutgoing: m.callOutgoing,
    callReason: m.callReason as any,
    callDuration: m.callDuration,
  }))
  // save versions for edited messages where text changed
  await db.transaction('rw', db.messages, db.messageVersions, async () => {
    const sameMsg = (a: DBMessage, b: DBMessage) => {
      return (
        a.id === b.id && a.dialogId === b.dialogId && a.msgId === b.msgId &&
        a.date === b.date && a.out === b.out && a.fromId === b.fromId &&
        a.senderName === b.senderName && a.text === b.text &&
        a.replyToMsgId === b.replyToMsgId &&
        JSON.stringify(a.entities || []) === JSON.stringify(b.entities || []) &&
        a.forwardedFrom === b.forwardedFrom &&
        a.mediaType === b.mediaType && a.mediaMime === b.mediaMime && a.mediaSize === b.mediaSize &&
        a.mediaDuration === b.mediaDuration && a.mediaWidth === b.mediaWidth && a.mediaHeight === b.mediaHeight &&
        a.fileName === b.fileName && (a as any).groupedId === (b as any).groupedId &&
        a.edited === b.edited && a.deleted === b.deleted &&
        a.editVersion === b.editVersion && a.editedAt === b.editedAt &&
        (a as any).mediaThumb === (b as any).mediaThumb &&
        (a as any).mediaThumbBlob === (b as any).mediaThumbBlob &&
        (a as any).mediaBlob === (b as any).mediaBlob &&
        a.serviceType === b.serviceType && a.callIsVideo === b.callIsVideo && a.callOutgoing === b.callOutgoing &&
        a.callReason === b.callReason && a.callDuration === b.callDuration
      );
    };
    for (const it of items) {
      const prev = await db.messages.get(it.id)
      if (!prev) {
        // New message: ensure initial version is stored when there is text
        if (typeof it.text === 'string') {
          const v: DBMessageVersion = {
            id: `${it.dialogId}:${it.msgId}:1`,
            dialogId: it.dialogId,
            msgId: it.msgId,
            version: 1,
            date: it.date,
            editedAt: it.editedAt,
            text: it.text,
          }
          it.editVersion = 1
          await db.messageVersions.put(v)
        } else {
          it.editVersion = 0
        }
        await db.messages.put(it)
      } else {
        // Preserve previous content for fields that may be omitted in updates
        if (typeof it.text === 'undefined') it.text = prev.text
        if (typeof it.senderName === 'undefined') it.senderName = prev.senderName
        if (typeof (it as any).replyToMsgId === 'undefined') (it as any).replyToMsgId = (prev as any).replyToMsgId
        if (typeof (it as any).entities === 'undefined') (it as any).entities = (prev as any).entities
        if (typeof (it as any).forwardedFrom === 'undefined') (it as any).forwardedFrom = (prev as any).forwardedFrom
        if (typeof (it as any).deleted === 'undefined') (it as any).deleted = prev.deleted
        if (typeof it.mediaType === 'undefined') it.mediaType = prev.mediaType
        if (typeof it.mediaMime === 'undefined') it.mediaMime = prev.mediaMime
        if (typeof it.mediaSize === 'undefined') it.mediaSize = prev.mediaSize
        if (typeof it.mediaDuration === 'undefined') it.mediaDuration = prev.mediaDuration
        if (typeof it.mediaWidth === 'undefined') it.mediaWidth = prev.mediaWidth
        if (typeof it.mediaHeight === 'undefined') it.mediaHeight = prev.mediaHeight
        if (typeof it.fileName === 'undefined') it.fileName = prev.fileName
        if (typeof (it as any).groupedId === 'undefined') (it as any).groupedId = (prev as any).groupedId
        if (typeof (it as any).mediaThumb === 'undefined') (it as any).mediaThumb = (prev as any).mediaThumb
        if (typeof (it as any).mediaThumbBlob === 'undefined') (it as any).mediaThumbBlob = (prev as any).mediaThumbBlob
        if (typeof (it as any).mediaBlob === 'undefined') (it as any).mediaBlob = (prev as any).mediaBlob

        // Versioning: if text actually changed, append a new version with the NEW text
        if (typeof it.text === 'string' && it.text !== prev.text) {
          const ver = (prev.editVersion ?? 0) + 1
          const v: DBMessageVersion = {
            id: `${it.dialogId}:${it.msgId}:${ver}`,
            dialogId: it.dialogId,
            msgId: it.msgId,
            version: ver,
            date: it.date,
            editedAt: it.editedAt,
            text: it.text,
          }
          it.editVersion = ver
          await db.messageVersions.put(v)
        } else {
          it.editVersion = prev.editVersion ?? 0
        }
        if (!sameMsg(prev, it)) {
          await db.messages.put(it)
        }
      }
    }
  })
  // Update dialog lastMessageAt and preview fields
  if (items.length) {
    // Ensure dialog row exists to receive preview update
    try {
      const existing = await db.dialogs.get(dialogId)
      if (!existing) {
        // Try infer a title from users cache if single-user dialog
        let title = 'Диалог'
        try {
          // Prefer senderName of the last message
          const lastSender = items[items.length - 1]?.senderName
          if (lastSender) title = lastSender
          else {
            // fallback by users table if fromId present
            const lastFrom = items[items.length - 1]?.fromId
            if (lastFrom) {
              const uid = String((lastFrom as any).userId ?? (lastFrom as any).chatId ?? (lastFrom as any).channelId ?? '')
              if (uid) {
                const u = await db.users.get(uid)
                if (u) title = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || title
              }
            }
          }
        } catch {}
        await db.dialogs.put({ id: dialogId, title, kind: 'user' } as any)
        try {
          const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })()
          if (metrics) console.debug('[Dexie] created dialog placeholder', { dialogId, title })
        } catch {}
      }
    } catch {}
    const last = items.reduce((a, b) => (a.date > b.date ? a : b))
    // Build short preview similar to Telegram
    const labelByMedia: Record<string, string> = {
      photo: '[Фото]',
      video: '[Видео]',
      video_note: '[Кружок]',
      audio: '[Аудио]',
      voice: '[Голосовое]',
      sticker: '[Стикер]',
      document: '[Файл]',
      animation: '[Анимация]',
      unknown: '[Вложение]',
    }
    let preview = ''
    const body = (typeof (last as any).message === 'string' ? (last as any).message : (typeof (last as any).text === 'string' ? (last as any).text : ''))
    if (body && body.trim()) {
      preview = body.trim()
    } else if (last.mediaType) {
      preview = labelByMedia[last.mediaType] || '[Вложение]'
      if (last.fileName) preview = `${preview} ${last.fileName}`
    } else if (last.serviceType === 'phone_call') {
      preview = '[Звонок]'
    } else if (last.serviceType === 'video_chat') {
      preview = '[Видеозвонок]'
    } else {
      preview = '[Сообщение]'
    }
    // Префикс для реплая: ↩ Имя: 
    try {
      const replyTo = (last as any).replyToMsgId
      if (replyTo) {
        const id = msgKey(dialogId, Number(replyTo))
        const replied = await db.messages.get(id)
        const who = replied?.senderName || 'Сообщение'
        preview = `↩ ${who}: ${preview}`
      }
    } catch {}
    if (preview.length > 200) preview = preview.slice(0, 200)
    const patch: Partial<DBDialog> = {
      lastMessageAt: last.date,
      lastMessageId: last.msgId,
      lastPreview: preview,
      lastOut: !!last.out,
      lastFromName: last.out ? undefined : last.senderName,
    }
    await db.dialogs.update(dialogId, patch)
    try {
      const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })()
      if (metrics) console.debug('[Dexie] dialog preview updated', { dialogId, patch })
    } catch {}
  }
  // debug
  try {
    const c = await db.messages.where('dialogId').equals(dialogId).count()
    const metrics = (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })()
    if (metrics) {
      // eslint-disable-next-line no-console
      console.debug('[Dexie] messages upserted:', items.length, 'for dialog', dialogId, 'total for dialog:', c)
    }
  } catch {}
}

export async function clearAll() {
  await db.transaction('rw', db.users, db.dialogs, db.messages, async () => {
    await db.users.clear()
    await db.dialogs.clear()
    await db.messages.clear()
  })
}

export async function clearDialogMessages(dialogId: string) {
  await db.transaction('rw', db.messages, db.messageVersions, db.dialogs, async () => {
    const ids = await db.messages.where('dialogId').equals(dialogId).primaryKeys()
    if (ids.length) await db.messages.bulkDelete(ids)
    const vIds = await db.messageVersions.where('dialogId').equals(dialogId).primaryKeys()
    if (vIds.length) await db.messageVersions.bulkDelete(vIds)
    await db.dialogs.update(dialogId, { lastMessageAt: 0 })
  })
}
