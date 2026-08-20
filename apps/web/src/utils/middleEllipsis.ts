/**
 * Middle-ellipsis truncation that keeps the END of a string visible.
 *
 * The plain CSS `text-overflow: ellipsis` truncation used elsewhere in the app keeps the
 * BEGINNING of a string and hides the end — fine for prose, but wrong for identifiers
 * whose distinguishing part is a suffix (e.g. account names shaped like
 * 'synth-w4w7-9f2ab61c@example.com': a long shared prefix followed by the part that
 * actually tells two accounts apart). Truncating from the end there renders every such
 * account as an indistinguishable 'synth-w4w7-…'.
 *
 * This helper keeps a short head (for at-a-glance recognizability) AND a tail (the
 * distinguishing suffix), eliding only the middle. Callers should still put the full,
 * untruncated value in a `title` attribute so it's available on hover/inspection.
 */

export interface MiddleEllipsisOptions {
  /** Characters kept at the start. Default 6. */
  headLength?: number
  /** Characters kept at the end — the part this helper exists to preserve. Default 20. */
  tailLength?: number
  /** Below this length, the value is returned unchanged (no ellipsis inserted). */
  maxLength?: number
}

// Default tail is deliberately generous (20, not the ~10 a plain "keep a few trailing
// chars" truncation would use): for 'synth-w4w7-9f2ab61c@example.com' — the exact shape
// named in the design note — a tail of 10 lands mid-domain ('…xample.com'), still hiding
// the '9f2ab61c' segment that actually distinguishes one account from another. A tail of
// 20 captures that whole segment plus the domain ('…9f2ab61c@example.com'); only the
// shared, non-distinguishing 'w4w7-' batch tag falls into the elided middle.
const DEFAULT_HEAD_LENGTH = 6
const DEFAULT_TAIL_LENGTH = 20
const ELLIPSIS = '…' // …

export function middleEllipsis(value: string | null | undefined, options: MiddleEllipsisOptions = {}): string {
  const raw = value == null ? '' : String(value)
  const headLength = Math.max(0, options.headLength ?? DEFAULT_HEAD_LENGTH)
  const tailLength = Math.max(0, options.tailLength ?? DEFAULT_TAIL_LENGTH)
  const maxLength = options.maxLength ?? headLength + tailLength + ELLIPSIS.length

  if (raw.length <= maxLength) return raw

  const head = raw.slice(0, headLength)
  const tail = tailLength > 0 ? raw.slice(-tailLength) : ''
  return `${head}${ELLIPSIS}${tail}`
}
