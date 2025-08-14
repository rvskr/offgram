export const BASE_PATH: string = (() => {
  try {
    let p = window.location?.pathname || ''
    if (!p || p === '/') return ''
    // Убираем завершающий слэш
    if (p.endsWith('/')) p = p.slice(0, -1)
    return p
  } catch {
    return ''
  }
})()

export const hashUrl = (sub: string): string => {
  const s = sub.replace(/^\/+/, '')
  return `${BASE_PATH}/#/${s}`
}
