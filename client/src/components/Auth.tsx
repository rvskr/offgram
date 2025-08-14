import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getBase } from '../lib/base'
import { ensureConnected, isAuthorized, startAuth, startAuthNew, addAccountFromSession, getAccounts, getActiveAccountId, switchAccount, removeAccount, addCurrentAccount, clearSession, type StoredAccount } from '../lib/telegramClient'

export default function Auth({ onDone }: { onDone: () => void }) {
  // Accounts management state
  const [accounts, setAccounts] = useState<StoredAccount[]>(getAccounts())
  const activeId = useMemo(() => getActiveAccountId(), [])
  const [phone, setPhone] = useState('')
  const [status, setStatus] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [needCode, setNeedCode] = useState(false)
  const [needPassword, setNeedPassword] = useState(false)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')

  const codeResolver = useRef<((v: string) => void) | null>(null)
  const passwordResolver = useRef<((v: string) => void) | null>(null)
  const phoneRef = useRef<HTMLInputElement | null>(null)
  const codeRef = useRef<HTMLInputElement | null>(null)
  const pwdRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const onFocus = () => setAccounts(getAccounts())
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  const base = getBase()

  const provideCode = useCallback(async () => {
    setNeedCode(true)
    setStatus('Введите код из Telegram...')
    try { setCode('') } catch {}
    return new Promise<string>((resolve) => {
      codeResolver.current = resolve
    })
  }, [])

  const providePassword = useCallback(async () => {
    setNeedPassword(true)
    setStatus('Введите пароль (2FA)...')
    try { setPassword('') } catch {}
    return new Promise<string>((resolve) => {
      passwordResolver.current = resolve
    })
  }, [])

  const onSubmitPhone = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    setStatus('Отправляем код...')
    try {
      // Если уже есть активный аккаунт — не трогаем текущую сессию, авторизуемся временным клиентом
      if (activeId) {
        const sess = await startAuthNew(phone, async () => provideCode(), async () => providePassword())
        await addAccountFromSession(sess)
        setStatus('Аккаунт добавлен')
        setAccounts(getAccounts())
        // Сбрасываем формы
        setNeedCode(false); setNeedPassword(false); setCode(''); setPassword('')
      } else {
        // Первый вход: используем основной клиент и делаем аккаунт активным
        await ensureConnected()
        await startAuth(phone, async () => provideCode(), async () => providePassword())
        const ok = await isAuthorized()
        if (ok) {
          setStatus('Успешный вход')
          try { await addCurrentAccount() } catch {}
          onDone()
        } else {
          setError('Не удалось авторизоваться')
        }
      }
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setLoading(false)
    }
  }

  const onSubmitCode = (e: React.FormEvent) => {
    e.preventDefault()
    if (codeResolver.current) {
      codeResolver.current(String(code ?? '').trim())
      codeResolver.current = null
      setNeedCode(false)
      setStatus('Проверяем код...')
    }
  }

  const onSubmitPassword = (e: React.FormEvent) => {
    e.preventDefault()
    if (passwordResolver.current) {
      passwordResolver.current(String(password ?? '').trim())
      passwordResolver.current = null
      setStatus('Проверяем пароль...')
    }
  }

  useEffect(() => {
    // Autofocus current step
    const t = setTimeout(() => {
      try {
        if (needCode) {
          codeRef.current?.focus()
        } else if (needPassword) {
          pwdRef.current?.focus()
        } else {
          phoneRef.current?.focus()
        }
      } catch {}
    }, 30)
    return () => clearTimeout(t)
  }, [needCode, needPassword])

  const initials = (label?: string, phoneVal?: string) => {
    const base = (label || phoneVal || '').trim()
    if (!base) return 'T'
    const parts = base.split(/\s+/)
    const first = parts[0]?.[0]
    const second = parts[1]?.[0]
    return (first || 'T').toUpperCase() + (second ? second.toUpperCase() : '')
  }

  return (
    <div className="max-w-md mx-auto p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-left">
          <div className="text-2xl font-semibold text-gray-900">Telegram</div>
          <div className="text-sm text-gray-500">Вход и управление аккаунтами</div>
        </div>
        <button
          type="button"
          onClick={() => { try { history.pushState({ view: 'settings' }, '', `${base}#/settings`) } catch {}; try { window.dispatchEvent(new PopStateEvent('popstate', { state: { view: 'settings' } as any })) } catch {} }}
          className="inline-flex items-center px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
        >Настройки</button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <div className="text-sm font-medium text-gray-700">Аккаунты</div>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{accounts.length}</span>
        </div>
        <div className="p-3">
          {accounts.length === 0 ? (
            <div className="text-sm text-gray-500">Нет сохранённых аккаунтов. Введите номер ниже, чтобы авторизоваться и сохранить сессию.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {accounts.map(a => (
                <div key={a.id} className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-gray-50">
                  <div className="w-9 h-9 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-semibold">
                    {initials(a.label || a.phone || a.userId, a.phone)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{a.label || a.phone || a.userId || a.id}</div>
                    <div className="text-xs text-gray-500 truncate">{(a.phone || a.userId || '')}{activeId === a.id ? ' · текущий' : ''}</div>
                  </div>
                  <button
                    onClick={() => { if (switchAccount(a.id)) window.location.reload() }}
                    className={`text-xs px-3 py-1.5 rounded border transition ${activeId === a.id ? 'opacity-50 cursor-not-allowed border-gray-200 text-gray-400' : 'border-blue-200 text-blue-700 hover:bg-blue-50'}`}
                    disabled={activeId === a.id}
                  >Сделать активным</button>
                  <button
                    onClick={() => { 
                      removeAccount(a.id); 
                      if (activeId === a.id) { try { clearSession() } catch {}; window.location.reload(); return }
                      setAccounts(getAccounts()) 
                    }}
                    className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
                  >Удалить</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 bg-white border border-gray-200 rounded-xl shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <div className="text-sm font-medium text-gray-700">Новый вход</div>
        </div>
        <div className="p-4">
          {!!status && (
            <div className="text-sm text-gray-600 mb-2">{status}</div>
          )}
          {!!error && <div className="text-sm text-red-600 mb-3">{error}</div>}

          {!needCode && !needPassword && (
            <form onSubmit={onSubmitPhone} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Телефон</label>
                <input
                  type="tel"
                  placeholder="+1234567890"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                  ref={phoneRef}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none text-sm"
                />
              </div>
              <button type="submit" disabled={loading || !phone} className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-[#2AABEE] text-white text-sm font-medium hover:bg-[#229fd9] disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? 'Отправка...' : 'Получить код'}
              </button>
            </form>
          )}

          {needCode && (
            <form onSubmit={onSubmitCode} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Код из Telegram</label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="12345"
                  required
                  ref={codeRef}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none text-sm tracking-widest"
                />
              </div>
              <button type="submit" className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-[#2AABEE] text-white text-sm font-medium hover:bg-[#229fd9]">Отправить код</button>
            </form>
          )}

          {needPassword && (
            <form onSubmit={onSubmitPassword} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Пароль (2FA)</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  ref={pwdRef}
                  className="w-full px-3 py-2 rounded-lg border border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none text-sm"
                />
              </div>
              <button type="submit" className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg bg-[#2AABEE] text-white text-sm font-medium hover:bg-[#229fd9]">Отправить пароль</button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
