/**
 * Truncation for the signed-in account identity shown in the app header, tuned for the
 * shape that actually broke: a long, shared EMAIL DOMAIN that consumes the whole
 * truncation budget before the part that distinguishes one account from another is ever
 * reached.
 *
 * Concretely, the staging trial's accounts are shaped like
 * 'synth-w4w7-853b767f-u01@w4w7-soak.synthetic' — 43 characters, with a 20-character
 * domain. A generic head+tail middle-ellipsis (see `middleEllipsis.ts`) keeps its last N
 * characters; for this shape, the last 20 characters ARE the domain, so every account in
 * the same org/domain renders identically ('synth-…@w4w7-soak.synthetic') — worse than
 * doing nothing, since the pre-fix CSS end-ellipsis at least showed the org hash at wide
 * viewports.
 *
 * Browser-measured (headless chromium, playwright-core, against `.nav-user`'s real CSS —
 * see the PR body for the exact table) across five candidates, only ONE kept the
 * distinguishing suffix on screen at every tested viewport (1440/1024/900/800/769 px):
 * dropping the domain ENTIRELY from the visible text and showing only the tail of the
 * LOCAL PART (the part before '@'), plus a `min-width` floor on the header element so the
 * flex layout can't crush it to 0 px first. Keeping the domain in any form — even
 * shortened ('local@…') — lost the identity below ~1024 px, because the local part plus a
 * literal '@' plus even one more character no longer fits the crushed box.
 *
 * The full, untruncated value belongs on a `title` attribute regardless — this module only
 * decides what's in the visible text node.
 *
 * Suffix-priority assumption (GATE-5047 P3-4): keeping the TAIL of the local part is a
 * deliberate bet that the staging shape's distinguishing segment sits at the end
 * ('...853b767f-u01'). It is not a general solution for every naming scheme — two long
 * local parts that are distinguished by a PREFIX instead, e.g. 'alice.smith.engineering@'
 * and 'bob.smith.engineering@', collide on a 12-character tail by design ('....engineering'
 * for both, see accountIdentityDisplay.spec.ts) the same way the pre-fix domain-tail
 * truncation collided on the staging shape. This module does not attempt to detect or
 * special-case that; `title` still carries the full, untruncated value as the recovery
 * path.
 */

import { middleEllipsis } from './middleEllipsis'

export interface AccountIdentityDisplayOptions {
  /** Below this length, the value is shown in full (including any domain) — unchanged
   *  from the pre-fix behaviour for short values that never needed truncation. */
  maxLength?: number
  /** For an email-shaped value that needs truncating: how many trailing characters of the
   *  LOCAL PART (before the last '@') to keep. Browser-measured sufficient (with a
   *  matching `min-width: 14ch` on `.nav-user`) for the self-service nav (1-link and
   *  5-link) at 1440/1024/900/800/769 px. NOT re-measured against a wide admin nav (17+
   *  links) — re-verify there before relying on it in that surface. */
  emailLocalTailLength?: number
  /** Passed through to middleEllipsis() for non-email values. */
  headLength?: number
  tailLength?: number
}

const DEFAULT_MAX_LENGTH = 27
const DEFAULT_EMAIL_LOCAL_TAIL_LENGTH = 12
const ELLIPSIS = '…'

function isEmailShaped(value: string): boolean {
  const at = value.lastIndexOf('@')
  return at > 0 && at < value.length - 1
}

export function truncateAccountIdentity(
  value: string | null | undefined,
  options: AccountIdentityDisplayOptions = {},
): string {
  const raw = value == null ? '' : String(value)
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
  if (raw.length <= maxLength) return raw

  if (isEmailShaped(raw)) {
    const at = raw.lastIndexOf('@')
    const localPart = raw.slice(0, at)
    const tailLength = Math.max(0, options.emailLocalTailLength ?? DEFAULT_EMAIL_LOCAL_TAIL_LENGTH)
    // GATE-5047 P3-4: we already know raw.length > maxLength (that's how we got here) — so
    // even when the whole local part fits under tailLength, the domain is still being
    // dropped. Mark that with a trailing ellipsis instead of returning what would otherwise
    // look like a complete, untruncated value.
    if (localPart.length <= tailLength) return `${localPart}${ELLIPSIS}`
    // `.slice(-0)` returns the WHOLE string (negative zero is still zero as an index), not
    // an empty one — guard tailLength === 0 explicitly instead of relying on slice's sign.
    const tail = tailLength > 0 ? localPart.slice(-tailLength) : ''
    return `${ELLIPSIS}${tail}`
  }

  return middleEllipsis(raw, { headLength: options.headLength, tailLength: options.tailLength, maxLength })
}
