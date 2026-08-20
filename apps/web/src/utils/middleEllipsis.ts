/**
 * Middle-ellipsis truncation that keeps the END of a string visible.
 *
 * The plain CSS `text-overflow: ellipsis` truncation used elsewhere in the app keeps the
 * BEGINNING of a string and hides the end — fine for prose, but wrong for identifiers
 * whose distinguishing part is a suffix. Truncating from the end there can render several
 * such identifiers as an indistinguishable shared prefix.
 *
 * This helper keeps a short head (for at-a-glance recognizability) AND a tail (the
 * distinguishing suffix), eliding only the middle. Callers should still put the full,
 * untruncated value in a `title` attribute so it's available on hover/inspection.
 *
 * NOT the account-identity display: for email-shaped values, `accountIdentityDisplay.ts`'s
 * `truncateAccountIdentity()` supersedes this module — a fixed-length tail here lands on
 * the DOMAIN for long-domain shapes (see that module's header comment for why that's a
 * regression, not just a style choice), so it drops the domain entirely and keeps the
 * local-part tail instead. This module remains the generic path for non-email identifiers.
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
// chars" truncation would use) for the generic, non-email identifiers this module still
// truncates directly (see accountIdentityDisplay.spec.ts and middleEllipsis.spec.ts for the
// fixtures). For email-shaped account identities specifically, this fixed-length tail is
// NOT sufficient on its own — a long enough domain consumes the whole tail budget and this
// module can't tell "keep the domain" from "keep the distinguishing local-part suffix"
// apart; that email-aware decision is `accountIdentityDisplay.ts`'s job, not this module's.
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
