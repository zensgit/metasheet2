/** Heading next to 余额: picker display name first, short id kept when it differs. */
export function formatAnnualBalanceSubject(userId: string | null | undefined, displayName: string | null | undefined): string {
  const id = String(userId || '').trim()
  const name = String(displayName || '').trim()
  if (name && id && name !== id) return `${name}（${id}）`
  return name || id
}
