import { describe, expect, it } from 'vitest'
import {
  BLANK_GLYPH_CODE_POINTS,
  GROUP_NAME_MAX_LENGTH,
  NAME_EDGE_TRIM_CLASS,
  NAME_EDGE_TRIM_CODE_POINT_SET,
  classifyGroupName,
  describeCodePoint,
  isDefaultIgnorable,
  isUnicodeWhiteSpace,
  isVisibleCategory,
  isVisibleCodePoint,
  trimNameEdges,
} from '../../src/services/approval-template-group-name-rule'

/**
 * Approval form group NAME RULE — the NO-DATABASE half of the erratum-3 candidate's evidence.
 *
 * STATUS: the rule is a CANDIDATE (PROPOSED 2026-09-20, owner ruled 「暂缓定案」). Passing this file
 * is technical verification, not ratification.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE REAL-DB SUITE. Everything asserted here is pure
 * computation: no socket, no `DATABASE_URL`, no Postgres. The real-DB file
 * (`tests/integration/approval-template-groups-lifecycle.db.test.ts`) is `describeIfDatabase`-
 * gated and only runs in the one plugin-tests.yml step that has a database, so a predicate
 * regression would be invisible on every OTHER CI leg. This file runs in `pnpm --filter
 * @metasheet/core-backend test` — the required `test (20.x)` job's always-on lane — so the
 * predicate itself is gated everywhere, and the real-DB file keeps what only a real route can
 * prove: the HTTP status, the error code, and that zero rows were written.
 *
 * WHAT THE OWNER MEASURED, AND WHAT THIS FILE DOES ABOUT IT. On 2026-09-20 the owner ran an
 * own-machine, no-DB probe of the rule AS THE DESIGN DOCUMENTS SPELLED IT — `[\p{L}\p{N}\p{P}\p{S}]`
 * — and measured `true` for U+3164 / U+115F / U+2800: 「字符属于这些类别,不等于可见」. The measurement
 * is correct and is REPRODUCED below (`the positive class alone accepts …`), as a fixture rather
 * than as prose, because the documents were the thing that was wrong: the shipped predicate
 * already carried the two exclusions the prose omitted. Every case here imports the production
 * module; nothing re-types a character class.
 */
describe('approval group name rule — visible(cp) predicate (no database)', () => {
  /**
   * The owner's three, r1's seven, and the six added in round 4 — DEDUPLICATED into the union, one
   * row per code point, each with the conjunct that decides it. `decidedBy` is not decoration: a
   * table that only recorded "rejected" would keep passing if two conjuncts swapped roles, which is
   * exactly how the round-3 documents came to describe a rule they no longer matched.
   *
   * `positiveClass` is the owner's own measurement, restated per row: `true` means
   * `[\p{L}\p{N}\p{P}\p{S}]` ACCEPTS this code point and some later conjunct is what rejects it.
   */
  const COUNTEREXAMPLES: Array<{
    label: string
    codePoint: number
    positiveClass: boolean
    /**
     * EVERY conjunct that excludes this code point, in the predicate's own order — not "the first
     * one", which would be an artifact of evaluation order rather than a fact about the rule. The
     * NECESSITY case below is what turns this column into a statement about which conjuncts
     * actually carry behaviour.
     */
    excludedBy: string
    provenance: string
  }> = [
    // ── the owner's three (2026-09-20 no-DB probe)
    { label: 'U+3164 HANGUL FILLER', codePoint: 0x3164, positiveClass: true, excludedBy: 'default-ignorable+blank-glyph-list', provenance: "owner 2026-09-20" },
    { label: 'U+115F HANGUL CHOSEONG FILLER', codePoint: 0x115f, positiveClass: true, excludedBy: 'default-ignorable+blank-glyph-list', provenance: "owner 2026-09-20" },
    { label: 'U+2800 BRAILLE PATTERN BLANK', codePoint: 0x2800, positiveClass: true, excludedBy: 'blank-glyph-list', provenance: "owner 2026-09-20" },
    // ── gate round 1 P2-1's seven (the three above are four of the seven's members; the rest follow)
    { label: 'U+00AD SOFT HYPHEN', codePoint: 0x00ad, positiveClass: false, excludedBy: 'positive-class+default-ignorable+blank-glyph-list', provenance: 'gate r1 P2-1' },
    { label: 'U+180E MONGOLIAN VOWEL SEPARATOR', codePoint: 0x180e, positiveClass: false, excludedBy: 'positive-class+default-ignorable+blank-glyph-list', provenance: 'gate r1 P2-1' },
    { label: 'U+034F COMBINING GRAPHEME JOINER', codePoint: 0x034f, positiveClass: false, excludedBy: 'positive-class+default-ignorable+blank-glyph-list', provenance: 'gate r1 P2-1' },
    { label: 'U+FE0F VARIATION SELECTOR-16', codePoint: 0xfe0f, positiveClass: false, excludedBy: 'positive-class+default-ignorable+blank-glyph-list', provenance: 'gate r1 P2-1' },
    // ── round 4 additions
    { label: 'U+1160 HANGUL JUNGSEONG FILLER', codePoint: 0x1160, positiveClass: true, excludedBy: 'default-ignorable+blank-glyph-list', provenance: 'round 4' },
    { label: 'U+FFA0 HALFWIDTH HANGUL FILLER', codePoint: 0xffa0, positiveClass: true, excludedBy: 'default-ignorable+blank-glyph-list', provenance: 'round 4' },
    { label: 'U+3000 IDEOGRAPHIC SPACE', codePoint: 0x3000, positiveClass: false, excludedBy: 'positive-class+blank-glyph-list+white-space', provenance: 'round 4' },
    { label: 'U+061C ARABIC LETTER MARK', codePoint: 0x061c, positiveClass: false, excludedBy: 'positive-class+default-ignorable+blank-glyph-list', provenance: 'round 4' },
    { label: 'U+2062 INVISIBLE TIMES', codePoint: 0x2062, positiveClass: false, excludedBy: 'positive-class+default-ignorable+blank-glyph-list', provenance: 'round 4' },
    { label: 'U+E0001 LANGUAGE TAG', codePoint: 0xe0001, positiveClass: false, excludedBy: 'positive-class+default-ignorable', provenance: 'round 4' },
  ]

  it('reproduces the owner 2026-09-20 measurement: the positive class ALONE accepts U+3164 / U+115F / U+2800', () => {
    // 「字符属于这些类别,不等于可见」 — stated as three measurements of the SHIPPED
    // `isVisibleCategory`, so this case reds if someone "simplifies" the predicate back to the
    // spelling the design documents used.
    expect(isVisibleCategory(0x3164), 'U+3164 is Lo — the positive class accepts it').toBe(true)
    expect(isVisibleCategory(0x115f), 'U+115F is Lo — the positive class accepts it').toBe(true)
    expect(isVisibleCategory(0x2800), 'U+2800 is So — the positive class accepts it').toBe(true)
    // …and the full predicate rejects all three. Both halves in one case on purpose: the first
    // three lines alone would read as a bug report, the last three as a claim with no measurement.
    expect(isVisibleCodePoint(0x3164), 'U+3164 is not visible under the full predicate').toBe(false)
    expect(isVisibleCodePoint(0x115f), 'U+115F is not visible under the full predicate').toBe(false)
    expect(isVisibleCodePoint(0x2800), 'U+2800 is not visible under the full predicate').toBe(false)
  })

  it('every counterexample is invisible, and the conjuncts that exclude it are the ones this table claims — ALL of them, not just the first', () => {
    // One array comparison, not per-row expects: a per-iteration `expect` aborts at the first
    // failure and names one row, so a mutation that changes several would be reported as if it
    // changed one (the same reasoning as the real-DB suite's NEITHER-SET case).
    //
    // Listing EVERY failing conjunct rather than the first one is the round-4 correction. The
    // first draft of this file recorded "decidedBy" in the predicate's evaluation order and, on the
    // strength of that column, the module claimed the Default_Ignorable conjunct was load-bearing
    // with U+FFA0 as its witness. Deleting that conjunct then left 11/11 unit and 31/31 real-DB
    // tests green (mutation MUT-R4-B) — because `BLANK_GLYPH_CODE_POINTS` enumerates all four
    // Hangul fillers. Evaluation order is not necessity; the NECESSITY case below measures that.
    const observed = COUNTEREXAMPLES.map(({ label, codePoint }) => {
      const report = describeCodePoint(codePoint)
      const excludedBy = [
        report.visibleCategory ? null : 'positive-class',
        report.defaultIgnorable ? 'default-ignorable' : null,
        report.blankGlyphListed ? 'blank-glyph-list' : null,
        report.whiteSpace ? 'white-space' : null,
      ].filter(Boolean).join('+')
      return `${label} positiveClass=${report.visibleCategory} visible=${report.visible} excludedBy=${excludedBy}`
    })
    expect(observed).toEqual(
      COUNTEREXAMPLES.map(
        ({ label, positiveClass, excludedBy }) => `${label} positiveClass=${positiveClass} visible=false excludedBy=${excludedBy}`,
      ),
    )
  })

  it('NECESSITY, swept over every scalar value: deleting the positive class or the blank-glyph list changes behaviour; deleting Default_Ignorable or White_Space does not', () => {
    // `feedback_exemption_reasons_rot_make_them_data`. The module header states which conjuncts
    // carry today's behaviour; this case DERIVES that statement from the full Unicode range, so the
    // header cannot drift from the code and a gate reading a green MUT-R4-B can see, here, that a
    // redundant conjunct is the designed outcome rather than an untested guard.
    //
    // First: the derivation below reconstructs `visible` from the four reported properties, so pin
    // that the reconstruction IS the production predicate — over every scalar value, not over the
    // thirteen rows above. Without this line the necessity numbers would describe a private
    // re-implementation (`feedback_mock_is_not_the_contract`).
    const drift: string[] = []
    const becomesVisible = { withoutPositiveClass: 0, withoutDefaultIgnorable: 0, withoutBlankList: 0, withoutWhiteSpace: 0, withoutDiAndBlankList: 0 }
    const blankListWitnesses: string[] = []
    const diWitnesses: string[] = []
    const diAndBlankWitnesses: string[] = []
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const category = isVisibleCategory(cp)
      const di = isDefaultIgnorable(cp)
      const blank = BLANK_GLYPH_CODE_POINTS.has(cp)
      const ws = isUnicodeWhiteSpace(cp)
      const reconstructed = category && !di && !blank && !ws
      if (reconstructed !== isVisibleCodePoint(cp)) drift.push(`U+${cp.toString(16).toUpperCase()}`)
      if (reconstructed) continue // already acceptable — deleting a conjunct cannot change it
      if (!category && !di && !blank && !ws) becomesVisible.withoutPositiveClass += 1
      if (category && !blank && !ws && di) { becomesVisible.withoutDefaultIgnorable += 1; diWitnesses.push(`U+${cp.toString(16).toUpperCase()}`) }
      if (category && !di && !ws && blank) { becomesVisible.withoutBlankList += 1; blankListWitnesses.push(`U+${cp.toString(16).toUpperCase()}`) }
      if (category && !di && !blank && ws) becomesVisible.withoutWhiteSpace += 1
      if (category && !ws && (di || blank)) { becomesVisible.withoutDiAndBlankList += 1; diAndBlankWitnesses.push(`U+${cp.toString(16).toUpperCase()}`) }
    }
    expect(drift, 'the reconstruction must equal isVisibleCodePoint everywhere').toEqual([])

    // NECESSARY — deleting the blank-glyph list makes exactly U+2800 an acceptable name.
    expect(blankListWitnesses, 'code points only the blank-glyph list rejects').toEqual(['U+2800'])

    // REDUNDANT TODAY — no code point is rejected ONLY by Default_Ignorable, because the four
    // Hangul fillers are also enumerated in the blank-glyph list. This is the measurement that
    // falsified the module's first draft, kept as a case so the claim cannot silently flip back.
    expect(diWitnesses, 'code points only Default_Ignorable rejects').toEqual([])

    // JOINTLY NECESSARY — deleting BOTH accepts exactly the four Hangul fillers plus U+2800.
    expect(diAndBlankWitnesses.sort(), 'code points rejected only by {Default_Ignorable, blank list}').toEqual(
      ['U+115F', 'U+1160', 'U+2800', 'U+3164', 'U+FFA0'].sort(),
    )

    // REDUNDANT TODAY, with no witness at all — White_Space ∩ L/N/P/S = ∅.
    expect(becomesVisible.withoutWhiteSpace, 'code points only White_Space rejects').toBe(0)

    // NECESSARY, and by far the widest — the positive class alone rejects six figures of code
    // points. The exact number is a Unicode-table fact, so assert the ORDER OF MAGNITUDE rather
    // than pinning a digit that a Node upgrade would churn.
    expect(becomesVisible.withoutPositiveClass, 'code points only the positive class rejects').toBeGreaterThan(800_000)
  })

  it('each counterexample is 400 GROUP_NAME_REQUIRED as a one-code-point name, and the STAGE says which half of the rule rejected it', () => {
    // The two stages are the SAME public outcome (400 GROUP_NAME_REQUIRED), so the HTTP-level
    // suite cannot tell them apart — and the difference matters: a name the EDGE TRIM empties
    // never reaches the visible-character rule at all, so such a row has ZERO discriminating power
    // over the predicate. Recording the stage here is what makes the wrapped rows in the real-DB
    // suite (see below) demonstrably necessary rather than decorative.
    const observed = COUNTEREXAMPLES.map(({ label, codePoint }) => {
      const verdict = classifyGroupName(String.fromCodePoint(codePoint))
      return `${label} -> ${verdict.ok ? '201' : `400 ${verdict.code}`} (${verdict.stage})`
    })
    expect(observed).toEqual([
      'U+3164 HANGUL FILLER -> 400 GROUP_NAME_REQUIRED (trimmed-to-empty)',
      'U+115F HANGUL CHOSEONG FILLER -> 400 GROUP_NAME_REQUIRED (trimmed-to-empty)',
      'U+2800 BRAILLE PATTERN BLANK -> 400 GROUP_NAME_REQUIRED (trimmed-to-empty)',
      'U+00AD SOFT HYPHEN -> 400 GROUP_NAME_REQUIRED (trimmed-to-empty)',
      'U+180E MONGOLIAN VOWEL SEPARATOR -> 400 GROUP_NAME_REQUIRED (trimmed-to-empty)',
      'U+034F COMBINING GRAPHEME JOINER -> 400 GROUP_NAME_REQUIRED (trimmed-to-empty)',
      'U+FE0F VARIATION SELECTOR-16 -> 400 GROUP_NAME_REQUIRED (no-visible-character)',
      'U+1160 HANGUL JUNGSEONG FILLER -> 400 GROUP_NAME_REQUIRED (trimmed-to-empty)',
      'U+FFA0 HALFWIDTH HANGUL FILLER -> 400 GROUP_NAME_REQUIRED (no-visible-character)',
      'U+3000 IDEOGRAPHIC SPACE -> 400 GROUP_NAME_REQUIRED (trimmed-to-empty)',
      'U+061C ARABIC LETTER MARK -> 400 GROUP_NAME_REQUIRED (no-visible-character)',
      'U+2062 INVISIBLE TIMES -> 400 GROUP_NAME_REQUIRED (no-visible-character)',
      'U+E0001 LANGUAGE TAG -> 400 GROUP_NAME_REQUIRED (no-visible-character)',
    ])
  })

  it('WRAPPED in U+FE0F, every counterexample reaches the VISIBLE-CHARACTER rule — the eight that the edge trim would otherwise swallow included', () => {
    // U+FE0F is deliberately NOT in the edge-trim set, so wrapping puts the code point under test
    // in an INTERNAL position where the trim cannot touch it. Without these rows, deleting
    // `BLANK_GLYPH_CODE_POINTS` or the `Default_Ignorable` exclusion would leave the bare rows
    // green (the trim still empties them) — a guard covering for another guard.
    const observed = COUNTEREXAMPLES.map(({ label, codePoint }) => {
      const verdict = classifyGroupName(`\uFE0F${String.fromCodePoint(codePoint)}\uFE0F`)
      return `${label} -> ${verdict.ok ? '201' : `400 ${verdict.code}`} (${verdict.stage})`
    })
    expect(observed).toEqual(
      COUNTEREXAMPLES.map(({ label }) => `${label} -> 400 GROUP_NAME_REQUIRED (no-visible-character)`),
    )
  })

  it('positive controls create: CJK / traditional / Japanese / Korean / emoji / internal zero-width are all accepted, and the returned name is the trimmed value', () => {
    const positives: Array<{ label: string; value: string; expected: string }> = [
      { label: '请假 (the product OWN placeholder text)', value: '请假', expected: '请假' },
      { label: '採購 (traditional Chinese)', value: '採購', expected: '採購' },
      { label: '日本語', value: '日本語', expected: '日本語' },
      { label: '한국어 (real Hangul — NOT the fillers above)', value: '한국어', expected: '한국어' },
      { label: '😀 (astral emoji, a surrogate pair)', value: '😀', expected: '😀' },
      { label: 'ASCII around an INTERNAL zero-width', value: 'a\u200Bb', expected: 'a\u200Bb' },
      { label: 'padded — the rule TRIMS the edges, it does not reject', value: '\u200B\u3000HR\uFEFF\u2060', expected: 'HR' },
      { label: '报销 with a trailing emoji + its variation selector', value: '报销☺\uFE0F', expected: '报销☺\uFE0F' },
    ]
    const observed = positives.map(({ label, value }) => {
      const verdict = classifyGroupName(value)
      return `${label} -> ${verdict.ok ? `201 ${JSON.stringify(verdict.name)}` : `400 ${verdict.code}`}`
    })
    expect(observed).toEqual(positives.map(({ label, expected }) => `${label} -> 201 ${JSON.stringify(expected)}`))
    // 한국어 is the row that distinguishes "Hangul is rejected" from "the Hangul FILLERS are
    // rejected" — a rule that keyed off the Hangul blocks instead of Default_Ignorable would pass
    // every other row in this file and fail exactly here.
    expect(classifyGroupName('한국어').ok, 'real Hangul must create').toBe(true)
  })

  it('BLANK_GLYPH_CODE_POINTS: every listed member is invisible, and exactly ONE member (U+2800) is load-bearing today', () => {
    // (a) No member may be acceptable as a name's only character.
    const acceptable = [...BLANK_GLYPH_CODE_POINTS].filter((cp) => isVisibleCodePoint(cp))
    expect(acceptable, 'every BLANK_GLYPH_CODE_POINTS member must be invisible').toEqual([])

    // (b) WHICH members would still be rejected if the list itself were deleted. Under Unicode
    // 17.0 that is all of them but U+2800 — so the list's own contribution to today's behaviour is
    // exactly one code point, and saying so here is what keeps the disclosure honest. This is
    // MEASURED, not copied from the module's comment: if a future Unicode table moves a member out
    // of Default_Ignorable, this case reds and the list's role grows in the diff rather than
    // silently.
    const loadBearing = [...BLANK_GLYPH_CODE_POINTS]
      .filter((cp) => isVisibleCategory(cp) && !isDefaultIgnorable(cp) && !isUnicodeWhiteSpace(cp))
      .sort((a, b) => a - b)
    expect(loadBearing.map((cp) => `U+${cp.toString(16).toUpperCase()}`)).toEqual(['U+2800'])

    // (c) Size, pinned. Adding or dropping a member without touching this number is not possible,
    // which is the mechanical form of "the set has a single source" (a second, narrower copy
    // somewhere else would not change this count and would therefore be caught by the sweep in the
    // real-DB suite instead).
    expect(BLANK_GLYPH_CODE_POINTS.size, 'BLANK_GLYPH_CODE_POINTS member count').toBe(56)
  })

  it('the White_Space conjunct is REDUNDANT today — swept, not asserted — so no case claims a witness it does not have', () => {
    // `\p{White_Space} ∩ [\p{L}\p{N}\p{P}\p{S}] = ∅` under this runtime's tables, which is why the
    // fourth conjunct has no witness row above. Proving the emptiness mechanically is the
    // difference between "we could not think of one" and "there is none": if a future Unicode
    // version makes a White_Space code point letter-like, this reds and the conjunct acquires a
    // witness in the same change.
    const overlap: number[] = []
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue // lone surrogates are not scalar values
      if (isUnicodeWhiteSpace(cp) && isVisibleCategory(cp)) overlap.push(cp)
    }
    expect(overlap.map((cp) => `U+${cp.toString(16).toUpperCase()}`), 'White_Space ∩ L/N/P/S').toEqual([])
  })

  it('the edge-trim Set is EXACTLY the documented character class, has no astral member, and drops none of the DB trim set', () => {
    // (a) Set ≡ class, swept over every scalar value. Same sweep the real-DB suite runs; repeated
    // here because THIS file runs on every CI leg and that one does not.
    const singleCharClass = new RegExp(`^[${NAME_EDGE_TRIM_CLASS}]$`, 'u')
    const mismatches: string[] = []
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const inClass = singleCharClass.test(String.fromCodePoint(cp))
      const inSet = NAME_EDGE_TRIM_CODE_POINT_SET.has(cp)
      if (inClass !== inSet) mismatches.push(`U+${cp.toString(16).toUpperCase()} class=${inClass} set=${inSet}`)
    }
    expect(mismatches, 'edge-trim Set must equal the documented class').toEqual([])

    // (b) Gate round 3 P3-1, turned from a disclosure into data: `trimNameEdges`'s surrogate-pair
    // branches are inert precisely because no member is astral. Adding an astral member makes this
    // case red FIRST, forcing whoever adds it to also add a case that discriminates the pairing
    // arithmetic — instead of that member entering a branch with zero coverage.
    expect([...NAME_EDGE_TRIM_CODE_POINT_SET].filter((cp) => cp > 0xffff), 'no astral trim member — see gate round 3 P3-1').toEqual([])

    // (c) Superset of the migration's ten-member btrim set, so every non-empty string the trim
    // returns still satisfies `atg_name_nonblank` by construction. Listed one member per line
    // because this is the property the DB layer's safety rests on.
    for (const cp of [0x0020, 0x0009, 0x000d, 0x000a, 0x3000, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) {
      expect(NAME_EDGE_TRIM_CODE_POINT_SET.has(cp), `DB trim-set member U+${cp.toString(16).toUpperCase()} must be in the edge-trim set`).toBe(true)
    }
    expect(NAME_EDGE_TRIM_CODE_POINT_SET.size, 'edge-trim member count').toBe(36)
    // U+FE0F must stay OUT: trimming it would rewrite a trailing emoji's presentation, and the
    // wrapped rows above depend on it being untrimmed.
    expect(NAME_EDGE_TRIM_CODE_POINT_SET.has(0xfe0f), 'U+FE0F must stay out of the trim set').toBe(false)
  })

  it('length is measured on the SUBMITTED value, in code points, before the trim runs', () => {
    const visible = '报'.repeat(GROUP_NAME_MAX_LENGTH)
    expect(classifyGroupName(visible), 'exactly at the cap').toMatchObject({ ok: true, stage: 'accepted' })

    const overLong = classifyGroupName('报'.repeat(GROUP_NAME_MAX_LENGTH + 1))
    expect(overLong).toMatchObject({
      ok: false,
      stage: 'length',
      code: 'GROUP_NAME_TOO_LONG',
      maxLength: GROUP_NAME_MAX_LENGTH,
      actualLength: GROUP_NAME_MAX_LENGTH + 1,
    })

    // Round-3 behaviour change, pinned as its own row (it is an owner decision point): padding
    // counts, because the cap reads what the caller SENT. 259 submitted → 255 after trimming → still
    // rejected.
    const padded = classifyGroupName(`\u200B\u3000${visible}\uFEFF\u2060`)
    expect(padded, 'padded to 259 submitted code points').toMatchObject({
      ok: false,
      stage: 'length',
      code: 'GROUP_NAME_TOO_LONG',
      actualLength: GROUP_NAME_MAX_LENGTH + 4,
    })

    // Astral characters are ONE code point each, not two UTF-16 units.
    expect(classifyGroupName('😀'.repeat(GROUP_NAME_MAX_LENGTH)), 'astral at the cap').toMatchObject({ ok: true })
    expect(classifyGroupName('😀'.repeat(GROUP_NAME_MAX_LENGTH + 1)), 'astral over the cap').toMatchObject({
      ok: false,
      actualLength: GROUP_NAME_MAX_LENGTH + 1,
    })
  })

  it('a non-string name (missing / null / number) is the empty string, not a crash and not an accepted name', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      const verdict = classifyGroupName(value)
      expect(verdict, `non-string ${JSON.stringify(value) ?? 'undefined'}`).toMatchObject({
        ok: false,
        stage: 'trimmed-to-empty',
        code: 'GROUP_NAME_REQUIRED',
      })
    }
  })

  it('trimNameEdges is LINEAR — the shape that made the round-2 quantified class quadratic returns immediately', () => {
    // Gate round 2 P1-1 (cross-tenant ReDoS). Kept here as well as in the real-DB suite because
    // this file runs on the always-on lane: a quantified re-implementation would red here first.
    //
    // THE BUDGET IS DERIVED, not a round number, because a timing assertion on a required lane is
    // a flake generator if it is set anywhere near the measured time. Two measurements bracket it:
    // the LINEAR implementation takes 0.04-1.05ms for these four shapes on the development machine,
    // and gate round 2 measured the QUANTIFIED implementation at 16.10s for the third one. 3000ms
    // sits ~3000x above the fast side and ~5x below the slow side, so a CI runner would have to be
    // roughly three thousand times slower than this machine to false-red, while a reintroduced
    // quantifier still fails by a factor of five. (If a future change makes the quadratic case
    // FASTER than 3s, this case loses its power — which is why the real-DB suite keeps its own
    // route-level timing case as well, and why the mutation ledger records the 16.10s measurement
    // rather than leaving it as folklore.)
    const run = '\u200B'.repeat(128_000)
    for (const [label, value] of [
      ['leading run', `${run}报销`],
      ['trailing run', `报销${run}`],
      ['visible-run-visible (the quadratic shape)', `报${run}销`],
      ['all trim members', run],
    ] as const) {
      const started = process.hrtime.bigint()
      trimNameEdges(value)
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
      expect(elapsedMs, `${label} must stay linear`).toBeLessThan(3000)
    }
    expect(trimNameEdges(`报${run}销`), 'an INTERNAL run is preserved, not collapsed').toBe(`报${run}销`)
  })
})
