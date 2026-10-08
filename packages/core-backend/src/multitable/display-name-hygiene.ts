/**
 * Display-name hygiene — REFUSE mojibake instead of storing it.
 *
 * ── The defect this module closes ──────────────────────────────────────────────
 * On the live deployment two fields were created through a Windows-shell `curl` whose console
 * codepage mangled the CJK bytes before they ever reached the wire. The server stored the result
 * verbatim — a name full of U+FFFD REPLACEMENT CHARACTER — and the customer's grid rendered
 * ����. Garbage in, garbage stored, silently, and the only repair was a direct DB UPDATE.
 *
 * A U+FFFD in a submitted name is not a name: it is the decoder's own marker that bytes were lost.
 * Storing it destroys information that the client still had a moment earlier. So this is a
 * FAIL-CLOSED refusal, matching the repo's doctrine — no normalization, no silent stripping, no
 * "best effort" repair. The client is told what is wrong and resends.
 *
 * ── What is refused ───────────────────────────────────────────────────────────
 *   U+FFFD                the decoder lost bytes (the actual live symptom)
 *   U+0000-U+001F, U+007F C0 controls + DEL — a display name is a single line; a raw control
 *                         character in one is either corruption or an injection attempt
 *   U+0080-U+009F         C1 controls — the classic latin1-decoded-as-UTF-8 signature
 *   U+D800-U+DFFF         unpaired surrogates — invalid UTF-8 by construction (Postgres rejects
 *                         them too, as a 500 rather than a readable 400)
 *
 * Legitimate text is untouched: CJK, emoji (astral code points via surrogate PAIRS), combining
 * marks, and every ordinary Latin/Cyrillic/Arabic name pass unchanged, byte for byte. This module
 * never rewrites a name — it only answers "is this storable".
 *
 * ── Values-free reporting ─────────────────────────────────────────────────────
 * The refusal names the CODE POINTS and their POSITIONS (`U+FFFD at position 3`). It never echoes
 * the submitted text back: echoing corrupt bytes into a JSON error body just moves the mojibake
 * into the error channel, and echoing user content at all is what the repo's values-free rule
 * forbids. A code point identifier is a fact about the input's shape, not its content.
 */

/** Coded reason for a refusal. Callers surface it verbatim so clients can branch on it. */
export const DISPLAY_NAME_INVALID_CHARACTERS_CODE = 'NAME_INVALID_CHARACTERS'

export type DisplayNameDefectKind =
  | 'replacement-character'
  | 'control-character'
  | 'unpaired-surrogate'

export interface DisplayNameDefect {
  kind: DisplayNameDefectKind
  /** 1-based position in CODE POINTS (not UTF-16 units), so the number matches what a human counts. */
  position: number
  /** `U+XXXX` — the code point's identifier. Never the surrounding text. */
  codePoint: string
}

/** How many defects a refusal message enumerates before it summarises the rest. Bounds the body. */
const MAX_REPORTED_DEFECTS = 5

const REPLACEMENT_CHARACTER = 0xfffd

function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
}

function classify(codePoint: number): DisplayNameDefectKind | null {
  if (codePoint === REPLACEMENT_CHARACTER) return 'replacement-character'
  if (codePoint <= 0x1f || codePoint === 0x7f) return 'control-character'
  if (codePoint >= 0x80 && codePoint <= 0x9f) return 'control-character'
  // A well-formed astral character arrives as a surrogate PAIR, which `Array.from` yields as ONE
  // code point above 0xFFFF — so anything still sitting in the surrogate range here is unpaired.
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 'unpaired-surrogate'
  return null
}

/**
 * Every defect in `name`, in order. Empty array ⇒ the name is storable.
 * Pure: it inspects, it never rewrites.
 */
export function findDisplayNameDefects(name: string): DisplayNameDefect[] {
  const defects: DisplayNameDefect[] = []
  let position = 0
  for (const character of Array.from(name)) {
    position += 1
    const codePoint = character.codePointAt(0)
    if (typeof codePoint !== 'number') continue
    const kind = classify(codePoint)
    if (kind) defects.push({ kind, position, codePoint: formatCodePoint(codePoint) })
  }
  return defects
}

/** Convenience predicate for call sites that only need the yes/no. */
export function isCleanDisplayName(name: string): boolean {
  return findDisplayNameDefects(name).length === 0
}

/**
 * The refusal message: what is wrong, where, and what the client should do about it. Values-free —
 * code points and positions only. Deterministic, so tests can pin it exactly.
 */
export function describeDisplayNameDefects(defects: readonly DisplayNameDefect[]): string {
  const listed = defects
    .slice(0, MAX_REPORTED_DEFECTS)
    .map((defect) => `${defect.codePoint} at position ${defect.position}`)
    .join(', ')
  const remainder = defects.length - Math.min(defects.length, MAX_REPORTED_DEFECTS)
  const tail = remainder > 0 ? `, and ${remainder} more` : ''
  const encodingHint = defects.some((defect) => defect.kind === 'replacement-character')
    ? ' U+FFFD means the bytes were already lost before the server saw them — this is usually a client'
      + ' encoding mistake (a Windows console codepage instead of UTF-8). Resend the name as UTF-8.'
    : ' Resend the name as UTF-8 text without control characters.'
  return `The name contains characters that cannot be stored: ${listed}${tail}.${encodingHint} Nothing was written.`
}

export interface DisplayNameHygieneRefusal {
  code: typeof DISPLAY_NAME_INVALID_CHARACTERS_CODE
  message: string
  defects: DisplayNameDefect[]
}

/**
 * The single entry point every display-name write shares: returns `null` when the name is storable,
 * or the coded, values-free refusal when it is not.
 */
export function checkDisplayNameHygiene(name: string): DisplayNameHygieneRefusal | null {
  const defects = findDisplayNameDefects(name)
  if (defects.length === 0) return null
  return {
    code: DISPLAY_NAME_INVALID_CHARACTERS_CODE,
    message: describeDisplayNameDefects(defects),
    defects,
  }
}
