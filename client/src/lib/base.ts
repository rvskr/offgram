// Centralized base URL detection for GH Pages and local dev/preview
// Priority:
// 1) window.__OFFGRAM_BASE if provided (manual override)
// 2) import.meta.env.BASE_URL (provided by Vite from vite.config.base) — not a secret
// 3) Derive from location.pathname first segment (GitHub Pages repo path)
// 4) Fallback '/'

export function getBase(): string {
  try {
    const w = window as any
    if (typeof w.__OFFGRAM_BASE === 'string' && w.__OFFGRAM_BASE) {
      const v = String(w.__OFFGRAM_BASE)
      return v.endsWith('/') ? v : v + '/'
    }
  } catch {}
  try {
    // Vite injects this at build and dev/preview time; it's fine to use (not from secrets)
    const v = (import.meta as any)?.env?.BASE_URL
    if (typeof v === 'string' && v.length > 0) {
      return v.endsWith('/') ? v : v + '/'
    }
  } catch {}
  try {
    const parts = window.location.pathname.split('/').filter(Boolean)
    const seg = parts[0]
    const v = seg ? `/${seg}/` : '/'
    return v
  } catch {}
  return '/'
}
