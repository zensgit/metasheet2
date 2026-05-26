/**
 * Frozen-columns view.config helpers (benchmark v2 #4 sub-slice 2).
 *
 * `view.config` is freeform JSON (`Record<string, unknown>`); `frozenLeftColumnIds` is read with a
 * NARROW helper so dirty/invalid config can never reach the sticky-offset math. Strict: only an array
 * whose every element is a string passes; anything else → []. (Design §1/§7.)
 */
export function parseFrozenIds(config: Record<string, unknown> | null | undefined): string[] {
  const value = config?.frozenLeftColumnIds
  if (!Array.isArray(value)) return []
  if (!value.every((x) => typeof x === 'string')) return []
  return value as string[]
}

/**
 * Length of the longest contiguous LEFT prefix of `orderedFieldIds` whose ids are all in the frozen
 * set. Reorder-robust: only a contiguous left prefix is ever frozen; non-prefix frozen ids are ignored.
 */
export function frozenPrefixCount(orderedFieldIds: string[], frozenIds: string[]): number {
  const set = new Set(frozenIds)
  let n = 0
  for (const id of orderedFieldIds) {
    if (set.has(id)) n++
    else break
  }
  return n
}
