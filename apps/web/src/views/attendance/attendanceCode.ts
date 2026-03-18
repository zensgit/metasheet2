function simpleHash(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

export function generateAttendanceCode(name: string, fallbackPrefix: string): string {
  const text = String(name ?? '').trim().toLowerCase()
  if (!text) return fallbackPrefix

  const ascii = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (ascii) return ascii

  return `${fallbackPrefix}_${simpleHash(text).slice(0, 6)}`
}
