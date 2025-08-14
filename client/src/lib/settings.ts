export type AutoDownloadSettings = {
  users: boolean
  groups: boolean
  channels: boolean
  bots: boolean
}

export type AppSettings = {
  autoDownload: AutoDownloadSettings
  saveMediaToDb: boolean
  tgMetrics: boolean
}

const KEY = 'appSettings'

const defaultSettings: AppSettings = {
  autoDownload: { users: true, groups: true, channels: true, bots: true },
  saveMediaToDb: true,
  // читаем устаревший ключ для обратной совместимости
  tgMetrics: (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(),
}

let cached: AppSettings | null = null
const listeners = new Set<(s: AppSettings) => void>()

export function getSettings(): AppSettings {
  if (cached) return cached
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      cached = {
        autoDownload: {
          users: !!parsed?.autoDownload?.users,
          groups: !!parsed?.autoDownload?.groups,
          channels: !!parsed?.autoDownload?.channels,
          bots: !!parsed?.autoDownload?.bots,
        },
        saveMediaToDb: parsed?.saveMediaToDb !== false,
        tgMetrics: typeof parsed?.tgMetrics === 'boolean'
          ? parsed.tgMetrics
          : (() => { try { return localStorage.getItem('tg_metrics') === '1' } catch { return false } })(),
      }
      return cached
    }
  } catch {}
  cached = { ...defaultSettings }
  return cached
}

export function setSettings(next: AppSettings) {
  cached = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch {}
  // синхронизация со старым ключом для логов
  try { localStorage.setItem('tg_metrics', next.tgMetrics ? '1' : '0') } catch {}
  for (const cb of listeners) cb(next)
}

export function updateSettings(patch: Partial<AppSettings>) {
  const prev = getSettings()
  const next: AppSettings = {
    autoDownload: { ...prev.autoDownload, ...patch.autoDownload },
    saveMediaToDb: patch.saveMediaToDb ?? prev.saveMediaToDb,
    tgMetrics: patch.tgMetrics ?? prev.tgMetrics,
  }
  setSettings(next)
}

export function subscribe(cb: (s: AppSettings) => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function allowAutoDownloadByEntity(s: AppSettings, entity: any | undefined): boolean {
  if (!entity) return true
  const cls: string | undefined = entity.className || entity._
  const isChannel = !!(cls && cls.includes('Channel'))
  const isChat = !!(cls && (cls.includes('Chat') || cls.includes('Supergroup')))
  const isUser = !isChannel && !isChat
  const isBot = !!(entity.bot === true)
  if (isBot) return !!s.autoDownload.bots
  if (isChannel) return !!s.autoDownload.channels
  if (isChat) return !!s.autoDownload.groups
  return !!s.autoDownload.users
}

// Удобный хелпер для чтения флага метрик
export function metricsEnabled(): boolean {
  return getSettings().tgMetrics
}
