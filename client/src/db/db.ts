import Dexie, { type Table } from 'dexie'

export type DBUser = {
  id: string
  username?: string
  firstName?: string
  lastName?: string
  avatarSmall?: string // data URL cached
  avatarPhotoId?: string // top profile photo id for change detection
}

export type DBDialog = {
  id: string // peer id as string
  title: string
  kind: 'user' | 'chat' | 'channel'
  pinned?: boolean
  archived?: boolean
  folderId?: number // Telegram folderId (e.g. 1=Archived, others=user folders)
  pinRank?: number // порядок среди закреплённых (меньше — выше)
  lastMessageAt?: number // epoch seconds
  // last message preview (for dialogs list)
  lastMessageId?: number
  lastPreview?: string
  lastOut?: boolean
  lastFromName?: string
  avatarSmall?: string // data URL cached
  avatarPhotoId?: string // top profile photo id for change detection
}

export type DBMessage = {
  id: string // message id unique per dialog; combine: `${dialogId}:${msgId}`
  dialogId: string
  msgId: number
  date: number // epoch seconds
  out: boolean
  fromId?: string
  senderName?: string
  text?: string
  // reply
  replyToMsgId?: number
  // rich text
  entities?: Array<{ offset: number; length: number; type: string; url?: string }>
  // forwarded info
  forwardedFrom?: string
  // albums (Telegram media groups)
  groupedId?: string // same for items in one media album
  // media
  mediaType?: 'photo' | 'video' | 'video_note' | 'audio' | 'voice' | 'sticker' | 'document' | 'animation' | 'unknown'
  mediaMime?: string
  mediaSize?: number
  mediaDuration?: number
  mediaWidth?: number
  mediaHeight?: number
  fileName?: string
  mediaThumb?: string // legacy data URL (optional)
  mediaThumbBlob?: Blob // preferred cache
  mediaBlob?: Blob // full media
  mediaPath?: string // placeholder for future external path if needed
  // status
  edited?: boolean
  deleted?: boolean
  editVersion?: number // increment on each edit
  editedAt?: number // epoch seconds
  // service messages (calls, etc.)
  serviceType?: 'phone_call' | 'video_chat'
  callIsVideo?: boolean
  callOutgoing?: boolean
  callReason?: 'missed' | 'declined' | 'busy' | 'ended'
  callDuration?: number // seconds
}

export type DBMessageVersion = {
  id: string // `${dialogId}:${msgId}:${version}`
  dialogId: string
  msgId: number
  version: number
  date: number
  editedAt?: number
  text?: string
}

export class TgDexie extends Dexie {
  users!: Table<DBUser, string>
  dialogs!: Table<DBDialog, string>
  messages!: Table<DBMessage, string>
  messageVersions!: Table<DBMessageVersion, string>

  constructor() {
    super('tg_local')
    this.version(1).stores({
      users: '&id, username',
      dialogs: '&id, lastMessageAt, pinned, archived',
      messages: '&id, dialogId, msgId, date, fromId, out',
    })
    this.version(2).stores({
      users: '&id, username',
      dialogs: '&id, lastMessageAt, pinned, archived',
      messages: '&id, dialogId, msgId, date, fromId, out, edited, deleted, editedAt',
      messageVersions: '&id, dialogId, msgId, version',
    }).upgrade(async (tx) => {
      // Initialize editVersion to 0 for existing messages
      const msgs = await tx.table('messages').toArray()
      for (const m of msgs) {
        if (typeof (m as any).editVersion !== 'number') {
          ;(m as any).editVersion = 0
          await tx.table('messages').put(m)
        }
      }
    })
    this.version(3).stores({
      users: '&id, username',
      dialogs: '&id, lastMessageAt, pinned, archived',
      messages: '&id, dialogId, msgId, date, fromId, out, edited, deleted, editedAt',
      messageVersions: '&id, dialogId, msgId, version',
    }).upgrade(async (_tx) => {
      // No index changes required; Blob fields are stored in the same store
    })
    this.version(4).stores({
      users: '&id, username',
      dialogs: '&id, lastMessageAt, pinned, archived',
      // Add compound index [dialogId+msgId] to speed exact lookups
      messages: '&id, [dialogId+msgId], dialogId, msgId, date, fromId, out, edited, deleted, editedAt',
      messageVersions: '&id, dialogId, msgId, version',
    }).upgrade(async (_tx) => {
      // No data migration necessary
    })
    this.version(5).stores({
      users: '&id, username',
      dialogs: '&id, lastMessageAt, pinned, archived',
      // schema unchanged (field added without new index)
      messages: '&id, [dialogId+msgId], dialogId, msgId, date, fromId, out, edited, deleted, editedAt',
      messageVersions: '&id, dialogId, msgId, version',
    }).upgrade(async (_tx) => {
      // groupedId added to DBMessage; no index or data migration required
    })
    this.version(6).stores({
      users: '&id, username',
      dialogs: '&id, lastMessageAt, pinned, archived',
      messages: '&id, [dialogId+msgId], dialogId, msgId, date, fromId, out, edited, deleted, editedAt',
      messageVersions: '&id, dialogId, msgId, version',
    }).upgrade(async (_tx) => {
      // Added service/call fields; no index changes
    })
    this.version(7).stores({
      users: '&id, username',
      dialogs: '&id, lastMessageAt, pinned, archived',
      messages: '&id, [dialogId+msgId], dialogId, msgId, date, fromId, out, edited, deleted, editedAt',
      messageVersions: '&id, dialogId, msgId, version',
    }).upgrade(async (_tx) => {
      // folderId added to DBDialog; no index changes
    })
    this.version(8).stores({
      users: '&id, username',
      dialogs: '&id, lastMessageAt, pinned, archived',
      messages: '&id, [dialogId+msgId], dialogId, msgId, date, fromId, out, edited, deleted, editedAt',
      messageVersions: '&id, dialogId, msgId, version',
    }).upgrade(async (_tx) => {
      // pinRank added to DBDialog; no index changes
    })
    this.version(9).stores({
      users: '&id, username',
      dialogs: '&id, lastMessageAt, pinned, archived',
      messages: '&id, [dialogId+msgId], dialogId, msgId, date, fromId, out, edited, deleted, editedAt',
      messageVersions: '&id, dialogId, msgId, version',
    }).upgrade(async (_tx) => {
      // replyToMsgId added to DBMessage; no index changes
    })
    this.version(10).stores({
      // indexes unchanged; added preview fields in dialogs store without new indexes
      users: '&id, username',
      dialogs: '&id, lastMessageAt, pinned, archived',
      messages: '&id, [dialogId+msgId], dialogId, msgId, date, fromId, out, edited, deleted, editedAt',
      messageVersions: '&id, dialogId, msgId, version',
    }).upgrade(async (_tx) => {
      // lastPreview/lastFromName/lastOut/lastMessageId added to DBDialog; no index changes
    })
  }
}

export const db = new TgDexie()

// Helpers
export function msgKey(dialogId: string, msgId: number) {
  return `${dialogId}:${msgId}`
}
