export function parseDingTalkDepartmentIds(value: unknown, fallback: readonly string[]): string[] | null {
  if (value === undefined || value === null) return [...fallback]
  if (!Array.isArray(value)) return null

  const ids: string[] = []
  for (const item of value) {
    const id = typeof item === 'string'
      ? item.trim()
      : typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? String(item) : ''
    if (!id) return null
    ids.push(id)
  }
  return ids
}
