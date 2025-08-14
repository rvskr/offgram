import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ensureConnected, isAuthorized, startAuth, getAccounts, getActiveAccountId, switchAccount, removeAccount, addCurrentAccount, clearSession, type StoredAccount } from '../lib/telegramClient'

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

  useEffect(() => {
    const onFocus = () => setAccounts(getAccounts())
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const provideCode = useCallback(async () => {
    setNeedCode(true)
    setStatus('Введите код из Telegram...')
    return new Promise<string>((resolve) => {
      codeResolver.current = resolve
    })
  }, [])

  const providePassword = useCallback(async () => {
    setNeedPassword(true)
    setStatus('Введите пароль (2FA)...')
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
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setLoading(false)
    }
  }

  const onSubmitCode = (e: React.FormEvent) => {
    e.preventDefault()
    if (codeResolver.current) {
      codeResolver.current(code)
      codeResolver.current = null
      setNeedCode(false)
      setStatus('Проверяем код...')
    }
  }

  const onSubmitPassword = (e: React.FormEvent) => {
    e.preventDefault()
    if (passwordResolver.current) {
      passwordResolver.current(password)
      passwordResolver.current = null
      setNeedPassword(false)
      setStatus('Проверяем пароль...')
    }
  }

  useEffect(() => {
    // Autofocus logic could be added here
  }, [])

  return (
    <div style={{ maxWidth: 540, margin: '24px auto', padding: 16 }}>
      <h2>Вход в Telegram</h2>
      <div style={{ marginTop: 12, padding: 12, border: '1px solid #e5e7eb', borderRadius: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Аккаунты</div>
        {accounts.length === 0 ? (
          <div style={{ fontSize: 13, color: '#6b7280' }}>Нет сохранённых аккаунтов. Введите номер ниже, чтобы авторизоваться и сохранить сессию.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {accounts.map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.label || a.phone || a.userId || a.id}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                    {(a.phone || a.userId || '')}{activeId === a.id ? ' · текущий' : ''}
                  </div>
                </div>
                <button
                  onClick={() => { if (switchAccount(a.id)) window.location.reload() }}
                  style={{ fontSize: 12, padding: '6px 10px', border: '1px solid #93c5fd', color: '#1d4ed8', borderRadius: 4, background: '#eff6ff' }}
                  disabled={activeId === a.id}
                >Сделать активным</button>
                <button
                  onClick={() => { 
                    removeAccount(a.id); 
                    if (activeId === a.id) { try { clearSession() } catch {}; window.location.reload(); return }
                    setAccounts(getAccounts()) 
                  }}
                  style={{ fontSize: 12, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 4 }}
                >Удалить</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, fontSize: 13, color: '#6b7280' }}>Новый вход:</div>
      {!!status && (
        <div style={{ marginTop: 8, color: '#4b5563' }}>{status}</div>
      )}
      {!!error && <div style={{ margin: '8px 0', color: '#b91c1c' }}>{error}</div>}

      {!needCode && !needPassword && (
        <form onSubmit={onSubmitPhone}>
          <label style={{ display: 'block', marginBottom: 8 }}>
            Телефон
            <input
              type="tel"
              placeholder="+79991234567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              style={{ width: '100%', padding: 8, marginTop: 4 }}
            />
          </label>
          <button type="submit" disabled={loading || !phone} style={{ padding: '8px 12px' }}>
            {loading ? 'Отправка...' : 'Получить код'}
          </button>
        </form>
      )}

      {needCode && (
        <form onSubmit={onSubmitCode} style={{ marginTop: 12 }}>
          <label style={{ display: 'block', marginBottom: 8 }}>
            Код из Telegram
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="12345"
              required
              style={{ width: '100%', padding: 8, marginTop: 4 }}
            />
          </label>
          <button type="submit" style={{ padding: '8px 12px' }}>Отправить код</button>
        </form>
      )}

      {needPassword && (
        <form onSubmit={onSubmitPassword} style={{ marginTop: 12 }}>
          <label style={{ display: 'block', marginBottom: 8 }}>
            Пароль (2FA)
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ width: '100%', padding: 8, marginTop: 4 }}
            />
          </label>
          <button type="submit" style={{ padding: '8px 12px' }}>Отправить пароль</button>
        </form>
      )}
    </div>
  )
}
