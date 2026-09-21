/**
 * PROPOSED (H-3, 2026-09-22) — candidate mitigations for user-supplied regex in
 * the formula engine. NOT ratified: `formula/engine.ts` is a runtime-contract
 * "frozen core" (see `multitable/formula-engine.ts` dryRun note) and every export
 * here changes an observable formula behaviour, so the owner decides whether and
 * which of these land. See docs/development/input-regex-redos-census-*.md.
 *
 * Background: REGEXMATCH / REGEXEXTRACT / REGEXREPLACE compile a caller-authored
 * string into `new RegExp(...)`, and SUBSTITUTE compiled arg-2 into a regex too.
 * A 57-character formula expression froze an unrelated tenant's request for ~55s
 * on the shared single-threaded event loop (measured; see verification MD).
 */

/**
 * Excel / Google-Sheets SUBSTITUTE is a LITERAL text replacement, not a regex
 * one. `split(old).join(new)` is O(n), matches the spec exactly, and removes the
 * ReDoS vector entirely — arg-2 never reaches a regex engine.
 *
 * Excel semantics preserved: an empty `old_text` returns `text` unchanged.
 */
export function substituteLiteral(text: string, oldText: string, newText: string): string {
  if (oldText === '') return text
  return text.split(oldText).join(newText)
}

/** A caller-supplied subject longer than this is refused before the regex runs.
 * Bounds the O(n^2) "global trim idiom as pattern" cost; a legitimate pattern on a
 * larger cell is a contract change (PROPOSED). ~5000 keeps even the quadratic
 * shapes measured in the census under ~15ms. */
export const USER_REGEX_MAX_SUBJECT_LEN = 5000

/** A caller-supplied pattern longer than this is refused before compilation. */
export const USER_REGEX_MAX_PATTERN_LEN = 1000

/**
 * True when the body of `pattern` (outside character classes) contains an
 * unbounded quantifier (`+`, `*`, or `{n,}`) applied to an atom.
 */
function bodyHasUnboundedQuantifier(body: string): boolean {
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '\\') { i++; continue }
    if (c === '[') {
      i++
      while (i < body.length && body[i] !== ']') { if (body[i] === '\\') i++; i++ }
      continue
    }
    if (c === '+' || c === '*') return true
    if (c === '{') {
      const close = body.indexOf('}', i)
      if (close > i && /^\{\d*,\d*\}$/.test(body.slice(i, close + 1)) && /,\s*\}$|,\s*\d{3,}\}$/.test(body.slice(i, close + 1))) return true
    }
  }
  return false
}

/**
 * Heuristic detector for statically-obvious catastrophic backtracking: a
 * quantified GROUP whose body itself carries an unbounded quantifier — `(a+)+`,
 * `(.*)*`, `(\d+){2,}`, `(?:x+)*`, … This is what makes `^(a+)+$` exponential.
 *
 * PARTIAL, by design: it does NOT catch alternation-overlap ReDoS such as
 * `(a|a)*` or `(a|ab)*`. The COMPLETE fix for arbitrary user-supplied patterns
 * is a linear-time engine (RE2) or an interruptible/step-budgeted matcher — an
 * owner/dependency decision, not made here.
 */
export function hasNestedUnboundedQuantifier(pattern: string): boolean {
  const stack: number[] = []
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') { i++; continue }
    if (c === '[') {
      i++
      while (i < pattern.length && pattern[i] !== ']') { if (pattern[i] === '\\') i++; i++ }
      continue
    }
    if (c === '(') { stack.push(i); continue }
    if (c === ')') {
      const start = stack.pop()
      if (start === undefined) continue
      const after = pattern.slice(i + 1)
      const groupQuantified = /^(?:[*+]|\{\d*,\s*\}|\{\d*,\s*\d{3,}\})/.test(after)
      if (groupQuantified && bodyHasUnboundedQuantifier(pattern.slice(start + 1, i))) return true
    }
  }
  return false
}

export type PatternAssessment = { safe: true } | { safe: false; reason: string }

/** Reject a user-supplied pattern that is over length or statically catastrophic. */
export function assessUserPattern(pattern: string): PatternAssessment {
  if (pattern.length > USER_REGEX_MAX_PATTERN_LEN) {
    return { safe: false, reason: `pattern exceeds ${USER_REGEX_MAX_PATTERN_LEN} characters` }
  }
  if (hasNestedUnboundedQuantifier(pattern)) {
    return { safe: false, reason: 'nested unbounded quantifier (catastrophic backtracking risk)' }
  }
  return { safe: true }
}
