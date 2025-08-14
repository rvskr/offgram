import { useEffect, useState } from 'react'
import { getSettings, subscribe, updateSettings, type AppSettings } from '../lib/settings'
// аккаунты управляются на странице авторизации

export default function SettingsPage({
  onBack,
  onClearCache,
  onOpenAccounts,
}: {
  onBack: () => void
  onClearCache: () => Promise<void>
  onOpenAccounts: () => void
}) {
  const [s, setS] = useState<AppSettings>(getSettings())
  useEffect(() => {
    const unsub = subscribe(setS)
    return () => { try { (unsub as any)() } catch {} }
  }, [])

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
        <button className="text-sm text-gray-600 hover:text-gray-800" onClick={onBack}>← Назад</button>
        <div className="font-semibold">Настройки</div>
        <div />
      </div>

      <div className="p-3 max-w-[720px] w-full mx-auto">
        <div className="mb-4">
          <div className="text-sm font-medium mb-2">Автоскачивание медиа</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="flex items-center gap-2 p-2 border rounded">
              <input type="checkbox" checked={s.autoDownload.users} onChange={(e) => updateSettings({ autoDownload: { users: e.target.checked } as any })} />
              <span>Личные сообщения</span>
            </label>
            <label className="flex items-center gap-2 p-2 border rounded">
              <input type="checkbox" checked={s.autoDownload.groups} onChange={(e) => updateSettings({ autoDownload: { groups: e.target.checked } as any })} />
              <span>Группы</span>
            </label>
            <label className="flex items-center gap-2 p-2 border rounded">
              <input type="checkbox" checked={s.autoDownload.channels} onChange={(e) => updateSettings({ autoDownload: { channels: e.target.checked } as any })} />
              <span>Каналы</span>
            </label>
            <label className="flex items-center gap-2 p-2 border rounded">
              <input type="checkbox" checked={s.autoDownload.bots} onChange={(e) => updateSettings({ autoDownload: { bots: e.target.checked } as any })} />
              <span>Боты</span>
            </label>
          </div>
        </div>

        <div className="mb-4">
          <div className="text-sm font-medium mb-2">Хранение</div>
          <label className="flex items-center gap-2 p-2 border rounded">
            <input type="checkbox" checked={s.saveMediaToDb} onChange={(e) => updateSettings({ saveMediaToDb: e.target.checked })} />
            <span>Сохранять загруженные медиафайлы в БД</span>
          </label>
        </div>

        <div className="mb-4">
          <div className="text-sm font-medium mb-2">Действия</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button className="px-3 py-2 rounded border border-gray-300 hover:bg-gray-50" onClick={async () => { await onClearCache() }}>Очистить кэш (без выхода)</button>
            <button className="px-3 py-2 rounded border border-gray-300 hover:bg-gray-50" onClick={onOpenAccounts}>Управление аккаунтами</button>
          </div>
        </div>

        {/* Управление аккаунтами перенесено на страницу авторизации */}
      </div>
    </div>
  )
}
