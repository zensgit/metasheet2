/**
 * Bounds for caller-supplied regular expressions (slice H-3, route (ii)).
 *
 * Two places in this package compile a string the caller wrote into `new RegExp`
 * and run it on the shared event loop: the formula engine's REGEX* / SUBSTITUTE
 * functions (`formula/engine.ts`) and the field-validation `pattern` rule
 * (`multitable/field-validation-engine.ts`). This module is the one entry point
 * both of them go through. It does exactly three things, in this order:
 *
 *   1. LENGTH GATE (refuses). A pattern longer than `USER_REGEX_MAX_PATTERN_LEN`
 *      is refused before it is compiled; a subject longer than
 *      `USER_REGEX_MAX_SUBJECT_LEN` is refused before the pattern runs on it.
 *      Both limits are taken from constraints the product already enforces
 *      elsewhere (see the constants below for the exact sources), so a value or
 *      pattern that the rest of the product accepts is not refused here.
 *
 *   2. SHAPE WARNING (never refuses, never throws). At compile time the pattern
 *      is scanned for the two shapes that are known to backtrack super-linearly
 *      — an unbounded quantifier nested directly under another unbounded
 *      quantifier, and an alternation under an unbounded quantifier — and a
 *      warning is logged, once per distinct (pattern, flags) per process. The
 *      pattern is then evaluated UNCHANGED. The scan is a heuristic: it has
 *      false positives (some linear idioms are flagged) and false negatives
 *      (ambiguity it does not model), which is why it only ever logs.
 *
 *   3. EVALUATION. The compiled RegExp is handed to the caller's `execute`
 *      callback, and whatever that returns is the result. Nothing here changes
 *      the answer a pattern gives on an input inside the limits.
 *
 * What this module does NOT do, stated plainly: it does not bound the cost of a
 * pattern that is super-linear inside the limits. A backtracking engine on a
 * nested-quantifier pattern is unbounded at any subject length; the earlier
 * measurement-based guard on this slice's predecessor branch was withdrawn
 * because its benign-input cost and boundary refusals were judged a design
 * cost rather than a defect. Bounding that class needs a linear-time engine or
 * an interruptible worker, either of which changes the set of patterns that can
 * be expressed and is therefore an owner decision, not something this module
 * can do on its own.
 *
 * Two sibling copies of the LENGTH GATE (constants + `findUserRegexLengthRefusal`)
 * exist because there is no import edge between the roots:
 *   - `apps/web/src/utils/userRegexLimits.ts` (public form, browser)
 *   - `plugins/plugin-integration-core/lib/validator.cjs` (pipeline validator)
 * `tests/unit/user-regex-limits-three-copy-parity.test.ts` replays one table
 * through all three. The shape warning is backend-only on purpose: the log it
 * writes is read by an operator of this process, and it is not a gate.
 */
import { Logger } from '../core/logger'

const logger = new Logger('UserRegexGuard')

/**
 * Longest subject a caller-supplied pattern is run against.
 *
 * SOURCE: `getDefaultValidationRules` in `multitable/field-validation-engine.ts`
 * caps `string` / `longText` fields at `maxLength: 10000`. A field without an
 * explicit validation list already refuses a longer value on write, so this
 * limit adds no new refusal for that population. It IS a new refusal for a
 * field whose explicit rule list carries a pattern rule but no maxLength rule
 * (`explicitRules ?? defaultRules` replaces the defaults rather than merging
 * them — `routes/univer-meta.ts` and `multitable/record-service.ts`); that is
 * the population the gate exists for, because it had no length bound at all.
 */
export const USER_REGEX_MAX_SUBJECT_LEN = 10000

/**
 * Longest pattern that will be compiled.
 *
 * SOURCE: `DRY_RUN_MAX_EXPRESSION_LEN = 4000` in `routes/univer-meta.ts` — the
 * longest formula expression the dry-run route accepts. A pattern literal is a
 * substring of its expression, so nothing that route accepts is refused here.
 * The stored-formula path and the field-validation rule blob carry no length
 * cap of their own; this constant gives them the same one.
 */
export const USER_REGEX_MAX_PATTERN_LEN = 4000

export type UserRegexLengthRefusal =
  | { kind: 'pattern-too-long'; length: number; limit: number }
  | { kind: 'subject-too-long'; length: number; limit: number }

export type UserRegexRefusal =
  | UserRegexLengthRefusal
  | { kind: 'invalid-pattern'; message: string }

export type UserRegexOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'refused'; refusal: UserRegexRefusal }

/**
 * The length gate, as a pure function of the two lengths. Pattern first: it is
 * the cheaper check and it is the one that must run BEFORE compilation.
 * Returns `null` when both lengths are inside the limits (a length equal to the
 * limit is inside).
 *
 * Kept identical, line for line where the language allows, in the two sibling
 * copies named in the module comment.
 */
export function findUserRegexLengthRefusal(
  patternLength: number,
  subjectLength: number,
): UserRegexLengthRefusal | null {
  if (patternLength > USER_REGEX_MAX_PATTERN_LEN) {
    return { kind: 'pattern-too-long', length: patternLength, limit: USER_REGEX_MAX_PATTERN_LEN }
  }
  if (subjectLength > USER_REGEX_MAX_SUBJECT_LEN) {
    return { kind: 'subject-too-long', length: subjectLength, limit: USER_REGEX_MAX_SUBJECT_LEN }
  }
  return null
}

/** One-line, values-free description of a refusal, for an error message. */
export function describeUserRegexRefusal(refusal: UserRegexRefusal, label = 'value'): string {
  switch (refusal.kind) {
    case 'pattern-too-long':
      return `${label} has a pattern rule longer than the ${refusal.limit}-character limit`
    case 'subject-too-long':
      return `${label} exceeds the ${refusal.limit}-character limit for pattern checks`
    case 'invalid-pattern':
      return `${label} has an invalid pattern rule`
  }
}

// ---------------------------------------------------------------------------
// Shape warning
// ---------------------------------------------------------------------------

export type UserRegexShapeWarning = {
  /**
   * `nested-quantifier`: a group under an unbounded quantifier whose first
   * mandatory atom is itself under an unbounded quantifier.
   * `quantified-alternation`: a group under an unbounded quantifier whose body
   * has a top-level alternation.
   */
  kind: 'nested-quantifier' | 'quantified-alternation'
  /** Index of the group's opening parenthesis in the pattern source. */
  at: number
}

type Quantifier = { min: number; max: number }

type SequenceSummary = {
  /** Index just past the `)` that closed this sequence, or the pattern length. */
  end: number
  /** The sequence has a `|` at its own level. */
  alternation: boolean
  /**
   * In at least one alternative, the first atom that must consume input is under
   * an unbounded quantifier (directly, or through a group that starts that way).
   */
  startsUnbounded: boolean
}

const UNBOUNDED = Number.POSITIVE_INFINITY

/**
 * Scan a pattern for the two shapes described on `UserRegexShapeWarning`.
 *
 * This is a heuristic over the pattern's SYNTAX, not a decision procedure for
 * ambiguity, and it is used only to log. Known limits, so nobody reads more into
 * a warning (or its absence) than it carries:
 *   - FALSE POSITIVES: a group that starts with an unbounded atom but whose
 *     iterations are separated by a delimiter later in the body is flagged
 *     although it is linear.
 *   - FALSE NEGATIVES: overlap between a group's alternatives, or between an
 *     atom and what follows it, is not modelled; a bounded-but-large quantifier
 *     (`{1,1000}`) is treated as bounded.
 *   - Never throws: any input the scanner cannot make sense of yields `[]`.
 */
export function describeUserRegexShape(pattern: string): UserRegexShapeWarning[] {
  const warnings: UserRegexShapeWarning[] = []
  try {
    scanSequence(pattern, 0, warnings)
  } catch {
    // A shape scan that cannot finish reports nothing. The pattern itself is
    // still compiled and evaluated by the caller; this is a log, not a gate.
    return []
  }
  return warnings
}

function parseQuantifier(src: string, pos: number): { q: Quantifier; end: number } | null {
  const c = src[pos]
  let q: Quantifier | null = null
  let end = pos
  if (c === '*') { q = { min: 0, max: UNBOUNDED }; end = pos + 1 }
  else if (c === '+') { q = { min: 1, max: UNBOUNDED }; end = pos + 1 }
  else if (c === '?') { q = { min: 0, max: 1 }; end = pos + 1 }
  else if (c === '{') {
    const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(src.slice(pos))
    if (!m) return null
    const min = Number(m[1])
    const max = m[2] === undefined ? min : m[3] === '' ? UNBOUNDED : Number(m[3])
    q = { min, max }
    end = pos + m[0].length
  }
  if (!q) return null
  if (src[end] === '?') end += 1 // lazy — same bounds
  return { q, end }
}

function skipClass(src: string, pos: number): number {
  // pos is at '['. A ']' immediately after '[' or '[^' is a literal in a class.
  let i = pos + 1
  if (src[i] === '^') i += 1
  if (src[i] === ']') i += 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === ']') return i + 1
    i += 1
  }
  return src.length
}

function scanSequence(src: string, start: number, warnings: UserRegexShapeWarning[]): SequenceSummary {
  let i = start
  let alternation = false
  let startsUnbounded = false
  // Per alternative: have we passed an atom that must consume input?
  let seenMandatory = false

  const noteAtom = (mandatory: boolean, unboundedStart: boolean) => {
    if (seenMandatory) return
    if (unboundedStart) startsUnbounded = true
    if (mandatory) seenMandatory = true
  }

  while (i < src.length) {
    const c = src[i]

    if (c === ')') return { end: i + 1, alternation, startsUnbounded }

    if (c === '|') { alternation = true; seenMandatory = false; i += 1; continue }

    // Zero-width assertions: never consume, never quantified in any way that matters here.
    if (c === '^' || c === '$') { i += 1; continue }

    if (c === '(') {
      const open = i
      let bodyStart = i + 1
      let zeroWidth = false
      if (src[i + 1] === '?') {
        const rest = src.slice(i + 2, i + 8)
        if (rest.startsWith(':')) bodyStart = i + 3
        else if (rest.startsWith('=') || rest.startsWith('!')) { bodyStart = i + 3; zeroWidth = true }
        else if (rest.startsWith('<=') || rest.startsWith('<!')) { bodyStart = i + 4; zeroWidth = true }
        else if (rest.startsWith('<')) {
          const close = src.indexOf('>', i + 3)
          if (close < 0) throw new Error('unterminated group name')
          bodyStart = close + 1
        } else {
          throw new Error('unknown group prefix')
        }
      }
      const body = scanSequence(src, bodyStart, warnings)
      i = body.end
      const quant = parseQuantifier(src, i)
      if (quant) i = quant.end
      if (zeroWidth) continue
      const q = quant?.q ?? { min: 1, max: 1 }
      if (q.max === UNBOUNDED) {
        if (body.startsUnbounded) warnings.push({ kind: 'nested-quantifier', at: open })
        if (body.alternation) warnings.push({ kind: 'quantified-alternation', at: open })
      }
      noteAtom(q.min >= 1, q.max === UNBOUNDED || (q.min >= 1 && body.startsUnbounded))
      continue
    }

    // A single consuming atom: escape, class, or literal / dot.
    if (c === '\\') {
      const next = src[i + 1]
      if (next === undefined) throw new Error('trailing backslash')
      if (next === 'b' || next === 'B') { i += 2; continue } // zero-width
      i += 2
    } else if (c === '[') {
      i = skipClass(src, i)
    } else {
      i += 1
    }
    const quant = parseQuantifier(src, i)
    if (quant) i = quant.end
    const q = quant?.q ?? { min: 1, max: 1 }
    noteAtom(q.min >= 1, q.max === UNBOUNDED)
  }

  return { end: i, alternation, startsUnbounded }
}

// ---------------------------------------------------------------------------
// Warning sink (log only) with per-process de-duplication
// ---------------------------------------------------------------------------

/** Replaceable so a test can observe warnings without a logger spy. */
export const userRegexGuardHooks = {
  warn(message: string, meta: Record<string, unknown>): void {
    logger.warn(message, meta)
  },
}

/** Bound on the de-duplication table so a stream of distinct patterns cannot grow it without limit. */
export const USER_REGEX_SHAPE_WARNING_MEMORY = 256

const warnedShapes = new Map<string, true>()

/** Test hook: forget which shapes have already been warned about. */
export function resetUserRegexShapeWarnings(): void {
  warnedShapes.clear()
}

function warnUserRegexShape(pattern: string, flags: string | undefined, site: string | undefined): void {
  try {
    const warnings = describeUserRegexShape(pattern)
    if (warnings.length === 0) return
    const key = `${flags ?? ''}/${pattern}`
    if (warnedShapes.has(key)) return
    if (warnedShapes.size >= USER_REGEX_SHAPE_WARNING_MEMORY) {
      const oldest = warnedShapes.keys().next().value
      if (oldest !== undefined) warnedShapes.delete(oldest)
    }
    warnedShapes.set(key, true)
    userRegexGuardHooks.warn(
      'caller-supplied regex has a shape that can backtrack super-linearly; evaluated unchanged',
      {
        site: site ?? 'unknown',
        kinds: [...new Set(warnings.map((w) => w.kind))],
        patternLength: pattern.length,
        patternPreview: pattern.slice(0, 80),
        flags: flags ?? '',
      },
    )
  } catch {
    // The warning path must never affect the evaluation path.
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Gate, compile, warn, evaluate — in that order. `execute` receives the compiled
 * RegExp and the (unchanged) subject and returns whatever the call site needs;
 * an exception thrown by `execute` propagates to the caller unchanged.
 */
export function runUserRegex<T>(
  pattern: string,
  flags: string | undefined,
  subject: string,
  execute: (re: RegExp, subject: string) => T,
  options?: { site?: string },
): UserRegexOutcome<T> {
  const refusal = findUserRegexLengthRefusal(pattern.length, subject.length)
  if (refusal) return { status: 'refused', refusal }

  let re: RegExp
  try {
    re = new RegExp(pattern, flags)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'refused', refusal: { kind: 'invalid-pattern', message } }
  }

  warnUserRegexShape(pattern, flags, options?.site)

  return { status: 'ok', value: execute(re, subject) }
}
