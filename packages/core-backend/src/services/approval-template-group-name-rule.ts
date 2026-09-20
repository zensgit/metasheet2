/**
 * Approval form group NAME RULE — the single source of truth.
 *
 * STATUS: **Erratum 3 CANDIDATE / PROPOSED (round-4 revision, 2026-09-20). NOT ratified, NOT
 * authorized, NOT merged.** Lock v2.13 §2 still says `CHECK (name ~ '[!-~]')` verbatim; the owner's
 * 2026-09-20 ruling on erratum 3 was 「暂缓定案:支持两层规则,但先提交准确字符规则及上述反例测试;
 * 两处 org_id CHECK 不动」 — direction supported, wording NOT adopted. Nothing in this file may be
 * read as adoption. The two `org_id` CHECKs and the migration are untouched by this revision.
 *
 * WHY THIS FILE EXISTS AT ALL (it is a move, not a new layer). Round 3 kept the rule inside
 * `ApprovalTemplateGroupService.ts`, which imports the pg pool. The owner ran an own-machine,
 * NO-DATABASE probe of the rule as the round-3 documents SPELLED it (`[\p{L}\p{N}\p{P}\p{S}]`) and
 * measured `true` for U+3164 / U+115F / U+2800 — 「字符属于这些类别,不等于可见」. That probe could
 * not import the code, so it re-typed the predicate, and a re-typed predicate is the thing that
 * disagreed. This module therefore holds the rule with ZERO runtime imports, so the service, the
 * suite and `scripts/dev/probe-group-name-rule.mjs` all evaluate the SAME function objects and the
 * owner never has to re-type a character class again.
 *
 * THE PREDICATE, STATED EXPLICITLY (this comment and `isVisibleCodePoint` below are line-for-line
 * the same rule; there is no second spelling anywhere):
 *
 *     visible(cp) := cp ∈ [\p{L}\p{N}\p{P}\p{S}]
 *                  ∧ cp ∉ \p{Default_Ignorable_Code_Point}
 *                  ∧ cp ∉ BLANK_GLYPH_CODE_POINTS
 *                  ∧ cp ∉ \p{White_Space}
 *
 * and a submitted name is accepted only if, after the edge trim, it contains at least one code
 * point for which `visible` holds.
 *
 * WHICH CONJUNCTS ARE NECESSARY TODAY — MEASURED, not asserted, and deliberately unflattering.
 * Every claim in this block is re-derived by `tests/unit/approval-group-name-rule.test.ts`'s
 * NECESSITY case (a full-range sweep that deletes one conjunct at a time and lists what becomes
 * acceptable), so the block cannot rot into the kind of prose that produced this round
 * (`feedback_exemption_reasons_rot_make_them_data`):
 *
 *   - `[\p{L}\p{N}\p{P}\p{S}]` (POSITIVE class) — NECESSARY. Delete it and every Mark/Control/
 *     Format/Separator becomes an acceptable name. Witnesses decided by this conjunct alone:
 *     U+FE0F (Mn), U+061C / U+2062 / U+E0001 (Cf).
 *   - `∉ BLANK_GLYPH_CODE_POINTS` — NECESSARY, through exactly ONE member: delete the list and
 *     U+2800 BRAILLE PATTERN BLANK (`So`, not default-ignorable, not White_Space) becomes an
 *     acceptable name. Nothing else in the 56 does.
 *   - `∉ Default_Ignorable_Code_Point` — REDUNDANT TODAY, and this file previously claimed
 *     otherwise. Measured: `L/N/P/S ∧ Default_Ignorable` is exactly the four Hangul fillers
 *     {U+115F, U+1160, U+3164, U+FFA0}, and all four are enumerated in `BLANK_GLYPH_CODE_POINTS`,
 *     so deleting this conjunct leaves both group suites green (mutation MUT-R4-B:
 *     31/31 real-DB, 12/12 unit). It is KEPT because it is the only conjunct that covers a
 *     default-ignorable code point a FUTURE Unicode version adds, with no code change — the
 *     enumeration cannot do that. Stated as redundancy rather than as strength: a gate that finds
 *     MUT-R4-B green must be able to read here that this is the designed outcome, not a hole.
 *   - `∉ White_Space` — REDUNDANT TODAY, for the same kind of reason and with no witness:
 *     `White_Space ∩ L/N/P/S = ∅` under Unicode 17.0 (they are Cc/Zs/Zl/Zp). Kept for spec
 *     fidelity: the rule is "at least one VISIBLE character", and a rule that reads "visible"
 *     while relying on a general-category accident is exactly the shape that produced this round.
 *
 * So two of the four conjuncts carry today's behaviour and two are future-proofing. The pair
 * {Default_Ignorable, BLANK_GLYPH_CODE_POINTS} is JOINTLY necessary for the four Hangul fillers —
 * deleting either alone still rejects them, deleting both accepts them — which is also swept.
 *
 * NOT CLOSURE. Any code point that is in L/N/P/S, is not default-ignorable, is not White_Space and
 * is not enumerated in `BLANK_GLYPH_CODE_POINTS` is ACCEPTED even if some font renders it blank.
 * This rule is claimed to reject (i) everything `\p{White_Space}` and JS `\s` cover, (ii) the DB
 * trim set, (iii) every default-ignorable code point, (iv) every Mark/Control/Separator-only name,
 * and (v) every enumerated `BLANK_GLYPH_CODE_POINTS` member. It is NOT claimed to reject
 * "everything invisible".
 */

/** Code points, not UTF-16 units. See `countCodePoints`. */
export const GROUP_NAME_MAX_LENGTH = 255

/**
 * The EDGE-TRIM set — a DIFFERENT set from `BLANK_GLYPH_CODE_POINTS`, with a different job.
 * A reviewer will ask why U+2800 is in both: this set decides what is STRIPPED from the two ends
 * of a submitted name (cosmetics, plus the DB-superset guarantee below); the blank-glyph set
 * decides what may not COUNT as the name's one required visible character, wherever it sits.
 * Neither subsumes the other — U+FE0F is in the blank set and deliberately NOT here (trimming it
 * would rewrite a trailing emoji's presentation, '报销☺️' → '报销☺'), U+1680 / U+2000-U+200A are
 * here and not there (they are White_Space, already invisible by conjunct 4).
 *
 * Members, by provenance (UNCHANGED from round 3 — only its file moved):
 *   (a) everything `String.prototype.trim` strips — JS `\s`: TAB, LF, VT, FF, CR, U+0020, U+00A0,
 *       U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
 *   (b) the `atg_name_nonblank` trim-set members JS `\s` does not cover: U+200B, U+200C, U+200D,
 *       U+2060. Because (b) is present, every NON-EMPTY string `trimNameEdges` returns still
 *       satisfies the migration's CHECK by construction — its first and last code points are
 *       outside a superset of the CHECK's own trim set, so the CHECK's `btrim` cannot empty it.
 *   (c) the blank-rendering code points gate round 1 P2-1 landed as 201 rows: U+00AD, U+180E,
 *       U+034F, U+2800, U+3164, U+115F, plus U+1160 (U+3164's Jungseong sibling).
 */
const NAME_EDGE_TRIM_CODE_POINTS: ReadonlySet<number> = new Set<number>([
  // (a) String.prototype.trim's own set
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
  // (b) DB trim-set members JS \s misses
  0x200b, 0x200c, 0x200d, 0x2060,
  // (c) gate round 1 P2-1's blank-rendering codepoints + U+1160
  0x00ad, 0x180e, 0x034f, 0x2800, 0x3164, 0x115f, 0x1160,
])

/**
 * Round 2's character class, kept ONLY as the specification the Set above is checked against by
 * the suite's equivalence case (it sweeps every code point in 0..0x10FFFF). NOTHING at runtime
 * builds a pattern from it. DO NOT reintroduce a quantifier over it (`[CLASS]+`) — that shape,
 * anchored at `$`, is exactly the round-2 P1 (catastrophic backtracking on a cross-tenant route).
 */
export const NAME_EDGE_TRIM_CLASS =
  '\\s\\u200B\\u200C\\u200D\\u2060\\u00AD\\u180E\\u034F\\u2800\\u3164\\u115F\\u1160'

/** Exported for the equivalence case and the probe; the runtime path reads the Set, never the class. */
export const NAME_EDGE_TRIM_CODE_POINT_SET: ReadonlySet<number> = NAME_EDGE_TRIM_CODE_POINTS

/**
 * BLANK_GLYPH_CODE_POINTS — code points that carry no glyph of their own, ENUMERATED.
 *
 * WHY ENUMERATE WHAT `\p{Default_Ignorable_Code_Point}` ALREADY COVERS. Under Unicode 17.0 (the
 * table Node 20/22/25 ships) all but one member below is already rejected by another conjunct —
 * U+2800 is the single member that is `So` and not default-ignorable. The enumeration is not
 * arithmetic: (1) a derived property is a TABLE, and the runtime's table version is not pinned by
 * this repository, so a member silently leaving `Default_Ignorable_Code_Point` in a future Node
 * would silently become an acceptable name; (2) the owner named U+3164 / U+115F / U+2800
 * explicitly, and an explicit ruling deserves an explicit line of code rather than a property
 * whose membership a reader has to go and look up. Redundancy here is the point.
 *
 * THE COST OF THAT REDUNDANCY, stated rather than hidden: because the four Hangul fillers are
 * enumerated here, the `Default_Ignorable_Code_Point` conjunct has no independent witness left and
 * is redundant today (see the file header's necessity block). That is a deliberate trade — an
 * explicit list a reader can check, at the price of one conjunct whose value is entirely in what
 * Unicode adds NEXT — and it is the reason the unit suite measures necessity per conjunct instead
 * of asserting that each one is load-bearing.
 *
 * Members (56), by block:
 *   U+2800                braille blank (the ONE non-default-ignorable member)
 *   U+115F U+1160 U+3164 U+FFA0   the Hangul filler family (`Lo`, all default-ignorable)
 *   U+3000                ideographic space
 *   U+180E                Mongolian vowel separator
 *   U+200B-U+200F         zero-width family + LRM/RLM
 *   U+2028-U+202F         line/paragraph separators, bidi overrides, narrow NBSP
 *   U+2060-U+206F         word joiner, invisible operators, deprecated format characters
 *   U+FEFF                byte order mark
 *   U+FE00-U+FE0F         variation selectors 1-16
 *   U+034F                combining grapheme joiner
 *   U+00AD                soft hyphen
 *   U+061C                Arabic letter mark
 */
function buildBlankGlyphCodePoints(): ReadonlySet<number> {
  const set = new Set<number>([0x2800, 0x115f, 0x1160, 0x3164, 0xffa0, 0x3000, 0x180e, 0xfeff, 0x034f, 0x00ad, 0x061c])
  for (let cp = 0x200b; cp <= 0x200f; cp += 1) set.add(cp)
  for (let cp = 0x2028; cp <= 0x202f; cp += 1) set.add(cp)
  for (let cp = 0x2060; cp <= 0x206f; cp += 1) set.add(cp)
  for (let cp = 0xfe00; cp <= 0xfe0f; cp += 1) set.add(cp)
  return set
}

export const BLANK_GLYPH_CODE_POINTS: ReadonlySet<number> = buildBlankGlyphCodePoints()

/**
 * The three Unicode property tests of the predicate, each as its own single-character pattern with
 * no repetition — the engine advances one position per attempt and cannot backtrack into a
 * quantifier (round-2 P1's shape), so each test is O(1) on a one-code-point string.
 */
const VISIBLE_CATEGORY_PATTERN = /[\p{L}\p{N}\p{P}\p{S}]/u
const DEFAULT_IGNORABLE_PATTERN = /\p{Default_Ignorable_Code_Point}/u
const WHITE_SPACE_PATTERN = /\p{White_Space}/u

/** `cp ∈ [\p{L}\p{N}\p{P}\p{S}]` — the positive conjunct, exposed so the probe can print it. */
export function isVisibleCategory(codePoint: number): boolean {
  return VISIBLE_CATEGORY_PATTERN.test(String.fromCodePoint(codePoint))
}

/** `cp ∈ \p{Default_Ignorable_Code_Point}` — exposed so the probe MEASURES it instead of asserting it. */
export function isDefaultIgnorable(codePoint: number): boolean {
  return DEFAULT_IGNORABLE_PATTERN.test(String.fromCodePoint(codePoint))
}

/** `cp ∈ \p{White_Space}` — exposed for the probe and for the redundancy sweep. */
export function isUnicodeWhiteSpace(codePoint: number): boolean {
  return WHITE_SPACE_PATTERN.test(String.fromCodePoint(codePoint))
}

/**
 * `visible(cp)` — the predicate from this file's header, one conjunct per line, in the same order.
 * This function is THE rule: the service, the real-DB suite and the no-DB probe all call it.
 */
export function isVisibleCodePoint(codePoint: number): boolean {
  return isVisibleCategory(codePoint)
    && !isDefaultIgnorable(codePoint)
    && !BLANK_GLYPH_CODE_POINTS.has(codePoint)
    && !isUnicodeWhiteSpace(codePoint)
}

/**
 * "At least one visible character", walked code point by code point. Linear, no pattern, no
 * backtracking; `classifyGroupName` only ever hands it a string already bounded by
 * `GROUP_NAME_MAX_LENGTH`.
 */
export function hasVisibleCharacter(value: string): boolean {
  for (const character of value) {
    if (isVisibleCodePoint(character.codePointAt(0) as number)) return true
  }
  return false
}

/**
 * Code points, counted without materialising an array. `[...s].length` allocates one element per
 * code point, and `express.json`'s 10mb body limit means `s` is caller-controlled in size, so the
 * spread form turns a long name into a multi-million-element allocation before the cap can reject
 * it. This walks UTF-16 units and pairs surrogates, and it counts the WHOLE string: the number
 * that reaches `details.actualLength` is the real length, not a short-circuited "at least".
 */
export function countCodePoints(value: string): number {
  let count = 0
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i += 1
    }
    count += 1
  }
  return count
}

/**
 * Strip `NAME_EDGE_TRIM_CODE_POINTS` members from both ends. Exported so the suite can time it
 * DIRECTLY: the route-level regression case cannot tell the linear trim apart from the length
 * gate, because either one alone keeps the route fast (gate round 2 §2.2's shapes).
 *
 * Surrogate pairs are stepped over as single code points in BOTH directions — no trim-set member
 * is astral today (the suite asserts that mechanically, so adding one forces a discriminating
 * case), but a right-to-left scan that read a trailing low surrogate on its own would be doing
 * arithmetic no current case discriminates, which is how a future member becomes a silent
 * mangling bug.
 */
export function trimNameEdges(value: string): string {
  let start = 0
  let end = value.length
  while (start < end) {
    const cp = value.codePointAt(start) as number
    if (!NAME_EDGE_TRIM_CODE_POINTS.has(cp)) break
    start += cp > 0xffff ? 2 : 1
  }
  while (end > start) {
    let cpStart = end - 1
    const unit = value.charCodeAt(end - 1)
    if (unit >= 0xdc00 && unit <= 0xdfff && end - 2 >= start) {
      const prev = value.charCodeAt(end - 2)
      if (prev >= 0xd800 && prev <= 0xdbff) cpStart = end - 2
    }
    const cp = value.codePointAt(cpStart) as number
    if (!NAME_EDGE_TRIM_CODE_POINTS.has(cp)) break
    end = cpStart
  }
  return start === 0 && end === value.length ? value : value.slice(start, end)
}

/**
 * Which STAGE decided a submitted name. The probe prints this, so an owner who types `⠀` and
 * sees a rejection can tell WHY it was rejected — the edge trim emptied it — instead of reading
 * `visible=false` and concluding the visible-character rule did the work. Three of the stages are
 * verdicts; `accepted` is the fourth.
 */
export type GroupNameStage = 'length' | 'trimmed-to-empty' | 'no-visible-character' | 'accepted'

export type GroupNameVerdict =
  | { ok: true; stage: 'accepted'; name: string }
  | { ok: false; stage: 'length'; code: 'GROUP_NAME_TOO_LONG'; maxLength: number; actualLength: number }
  | { ok: false; stage: 'trimmed-to-empty' | 'no-visible-character'; code: 'GROUP_NAME_REQUIRED' }

/**
 * The whole application-layer rule, as one pure function. `ApprovalTemplateGroupService` turns the
 * verdict into a `ServiceError`; the probe prints it; the suite asserts against the HTTP result of
 * the same call. Order is load-bearing and unchanged from round 3:
 *
 *   1. LENGTH, on the value AS SUBMITTED (round-3 fix, part 2) — bounds the input before any
 *      per-character rule walks it, so neither the trim nor the visible test can be handed an
 *      unbounded string.
 *   2. EDGE TRIM (linear, `trimNameEdges`).
 *   3. VISIBLE CHARACTER, over the trimmed value.
 *
 * A non-string (missing / null / number body field) is treated as the empty string, which falls out
 * at stage 2 as `trimmed-to-empty` → 400 `GROUP_NAME_REQUIRED`, exactly as before.
 */
export function classifyGroupName(name: unknown): GroupNameVerdict {
  const submitted = typeof name === 'string' ? name : ''
  const actualLength = countCodePoints(submitted)
  if (actualLength > GROUP_NAME_MAX_LENGTH) {
    return { ok: false, stage: 'length', code: 'GROUP_NAME_TOO_LONG', maxLength: GROUP_NAME_MAX_LENGTH, actualLength }
  }
  const trimmed = trimNameEdges(submitted)
  if (!trimmed) return { ok: false, stage: 'trimmed-to-empty', code: 'GROUP_NAME_REQUIRED' }
  if (!hasVisibleCharacter(trimmed)) return { ok: false, stage: 'no-visible-character', code: 'GROUP_NAME_REQUIRED' }
  return { ok: true, stage: 'accepted', name: trimmed }
}

/** One code point's full evaluation — the probe's row shape, built from the real predicate. */
export type CodePointReport = {
  codePoint: number
  label: string
  visibleCategory: boolean
  defaultIgnorable: boolean
  blankGlyphListed: boolean
  whiteSpace: boolean
  edgeTrimmed: boolean
  visible: boolean
}

export function describeCodePoint(codePoint: number): CodePointReport {
  return {
    codePoint,
    label: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`,
    visibleCategory: isVisibleCategory(codePoint),
    defaultIgnorable: isDefaultIgnorable(codePoint),
    blankGlyphListed: BLANK_GLYPH_CODE_POINTS.has(codePoint),
    whiteSpace: isUnicodeWhiteSpace(codePoint),
    edgeTrimmed: NAME_EDGE_TRIM_CODE_POINTS.has(codePoint),
    visible: isVisibleCodePoint(codePoint),
  }
}
