/**
 * Shared predicate for accounts that may still appear in pickers, search, and admin lists.
 * Recycle-bin rows have deleted_at set. Purged rows keep deleted_at and also set purged_at.
 */
export function visibleUserPredicate(alias = ''): string {
  const prefix = alias ? `${alias}.` : ''
  return `${prefix}deleted_at IS NULL AND ${prefix}purged_at IS NULL`
}

/** Escape `\`, `%`, and `_` so a search term is a literal ILIKE substring. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export function likeContainsPattern(value: string): string {
  return `%${escapeLikePattern(value.trim())}%`
}
