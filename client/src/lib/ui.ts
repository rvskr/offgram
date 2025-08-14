export function getInitials(name?: string) {
  const n = (name || '').trim()
  if (!n) return ''
  const parts = n.split(/\s+/)
  const a = parts[0]?.[0] || ''
  const b = parts[1]?.[0] || ''
  return (a + b).toUpperCase()
}
