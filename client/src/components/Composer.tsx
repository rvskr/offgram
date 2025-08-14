import { useMemo, useState } from 'react'
import { sendText, sendFile } from '../lib/telegramClient'
import type { DBMessage } from '../db/db'

export default function Composer({ activeEntity, disabled, onSent, replyTo, onClearReply }: {
  activeEntity: any
  disabled?: boolean
  onSent?: () => void | Promise<void>
  replyTo?: DBMessage | null
  onClearReply?: () => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const replySnippet = useMemo(() => {
    if (!replyTo) return ''
    const t = (replyTo.text || '').trim()
    if (t) return t.length > 120 ? t.slice(0, 117) + '…' : t
    const mt = (replyTo.mediaType as any)
    if (!mt) return 'сообщение'
    const map: Record<string, string> = {
      photo: 'фото',
      video: 'видео',
      video_note: 'кружок',
      voice: 'голосовое',
      audio: 'аудио',
      document: 'документ',
      animation: 'гиф',
      contact: 'контакт',
      poll: 'опрос',
      location: 'локация',
      game: 'игра',
      sticker: 'стикер',
    }
    return map[String(mt)] || 'вложение'
  }, [replyTo])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (disabled || !activeEntity || !text.trim()) return
    setBusy(true)
    try {
      await sendText(activeEntity, text.trim(), replyTo?.msgId)
      setText('')
      onClearReply?.()
      await onSent?.()
    } finally {
      setBusy(false)
    }
  }

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f || disabled || !activeEntity) return
    setBusy(true)
    try {
      await sendFile(activeEntity, f, undefined, replyTo?.msgId)
      onClearReply?.()
      await onSent?.()
    } finally {
      setBusy(false)
      e.target.value = ''
    }
  }

  return (
    <form onSubmit={onSubmit} className="sticky bottom-0 bg-white border-t border-gray-200 p-2 md:p-3 flex flex-col gap-2 pb-[max(env(safe-area-inset-bottom),0px)]">
      {replyTo && (
        <div className="flex items-start gap-2 px-3 py-2 border border-blue-200 rounded bg-blue-50">
          <div className="w-1 h-6 mt-0.5 bg-blue-400 rounded" />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-blue-700 font-medium truncate">{replyTo.senderName || 'Сообщение'}</div>
            <div className="text-xs text-gray-700 truncate">{replySnippet}</div>
          </div>
          <button type="button" onClick={onClearReply} className="text-gray-500 hover:text-gray-700 text-sm">✕</button>
        </div>
      )}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={disabled ? 'Выберите диалог' : 'Напишите сообщение...'}
        disabled={disabled}
        className="px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-60 text-sm md:text-base"
      />
      <div className="flex items-end gap-2">
        <label className={`${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'} px-3 py-2 border border-gray-300 rounded cursor-pointer min-w-[40px] h-10 md:h-10 flex items-center justify-center`}>
          📎
          <input type="file" onChange={onPickFile} disabled={disabled} className="hidden" />
        </label>
        <button type="submit" disabled={disabled || busy || !text.trim()} className="px-4 py-2 h-10 rounded bg-blue-600 text-white disabled:opacity-50 hover:bg-blue-700 text-sm md:text-base">
          Отправить
        </button>
      </div>
    </form>
  )
}
