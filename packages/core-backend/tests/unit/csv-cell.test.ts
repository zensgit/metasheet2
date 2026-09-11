/**
 * P3-1 -- CSV cell sanitizer (contract Sec.3).
 *
 * Two independent axes are covered here, each with its own discipline:
 *
 *   DANGEROUS axis (`CSV_FORMULA_INJECTION_LEAD_CHARS`) -- a small, contract-ratified 7-entry
 *   table. Three independent assertions, because a test that only iterates the exported table and
 *   feeds it back into the same code path proves nothing but "the set the code uses equals the set
 *   the code uses": (1) behavior over the exported table -- reds if the neutralizer body is gutted;
 *   (2) an independent LITERAL census of the table -- reds if a vector is silently DROPPED (e.g.
 *   someone removes `-` because negative numbers render as text) -- iteration alone cannot see a
 *   removal, only re-typing the expected set by hand can; (3) negative controls (`'a'`, `'{'`,
 *   `'0'`, `''`) -- reds if a mutation prefixes EVERY cell (which would otherwise pass every
 *   positive-half assertion vacuously).
 *
 *   IGNORABLE axis (`isCsvIgnorableLeadChar`) -- fix round P3-B (gate-2 finding) first replaced a
 *   7-entry hand-typed table with a closed-form Unicode-category predicate plus a named supplement,
 *   because the table approach does not converge (gate 2 measured 18 residual lead-ins the table
 *   missed -- see [[feedback_trap_enumeration_does_not_converge]]). Fix round P2-2/NIT-1 (gate-3
 *   findings) then found THAT predicate itself did not converge either (missed 4036 of Unicode's
 *   4174 `Default_Ignorable_Code_Point` characters) and replaced its category set -- see
 *   `CSV_IGNORABLE_LEAD_PATTERN`'s own comment in `src/services/csv-cell.ts` for the measured
 *   before/after numbers. A test that iterates an exported list would just move the enumeration
 *   into the test file, so this axis is instead driven from an independent CORPUS (below) that
 *   names every one of gate 2's 18 residuals, gate 3's additional named residuals (the
 *   `Default_Ignorable_Code_Point` entries the second predicate missed, plus a C0-control sample),
 *   and the original 7 table entries -- asserting the OUTCOME of `isCsvIgnorableLeadChar` and of
 *   `neutralizeFormulaInjectionLead` for each -- the corpus's expected values are hand-set, never
 *   computed by calling the functions under test. The single-entry supplement additionally gets its
 *   own independent literal census (same discipline as the DANGEROUS table), since a silent drop
 *   from THAT small hand-typed list is exactly what iteration cannot see.
 *
 *   SPLIT, not just union (NIT-2 fix): each corpus entry also names WHICH mechanism is expected to
 *   cover it -- the base pattern or the named supplement -- and a dedicated assertion checks that
 *   split directly against `CSV_IGNORABLE_LEAD_PATTERN` and `CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS`
 *   independently, not merely against the OR'd outcome `isCsvIgnorableLeadChar` returns. Before
 *   this, the pattern-vs-supplement split lived only in this corpus's LABEL PROSE ("Cc -- named
 *   supplement entry"), so an entry silently moved between the two mechanisms (exactly what
 *   happened to NUL and NEL in the P2-2/NIT-1 fix round, when `\p{Cc}` absorbed them out of the
 *   supplement) would leave every outcome-only assertion green while the label went stale.
 */
import { describe, expect, it } from 'vitest'
import {
  CSV_FORMULA_INJECTION_LEAD_CHARS,
  CSV_IGNORABLE_LEAD_PATTERN,
  CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS,
  CSV_LINE_TERMINATOR,
  isCsvIgnorableLeadChar,
  neutralizeFormulaInjectionLead,
  quoteRfc4180,
  sanitizeCsvCell,
  sanitizeCsvRow,
  stringifyCsvValue,
} from '../../src/services/csv-cell'

describe('CSV_FORMULA_INJECTION_LEAD_CHARS (independent literal census)', () => {
  it('is exactly the owner-specified vector set -- a silent drop must fail this, not just iteration', () => {
    // Re-typed by hand, NOT derived from the constant under test -- this is what catches removal.
    expect([...CSV_FORMULA_INJECTION_LEAD_CHARS].sort()).toEqual(
      ['=', '+', '-', '@', '\t', '\r', '\n'].sort(),
    )
    expect(CSV_FORMULA_INJECTION_LEAD_CHARS.length).toBe(7)
  })
})

describe('sanitizeCsvCell -- positive half (iterates the exported table)', () => {
  for (const lead of CSV_FORMULA_INJECTION_LEAD_CHARS) {
    it(`neutralizes a cell whose value starts with ${JSON.stringify(lead)}`, () => {
      const raw = `${lead}cmd|'/c calc'!A1`
      const cell = sanitizeCsvCell(raw)
      // The neutralized-and-RFC4180-quoted text must begin with an apostrophe once any
      // surrounding quoting is stripped, and must never begin with the raw dangerous character.
      const unquoted = cell.startsWith('"') && cell.endsWith('"')
        ? cell.slice(1, -1).replace(/""/g, '"')
        : cell
      expect(unquoted.startsWith("'")).toBe(true)
      expect(unquoted[1]).toBe(lead)
      expect(cell.startsWith(lead)).toBe(false)
    })
  }

  it('neutralizes at the value level even when the whole cell is a bare dangerous char', () => {
    for (const lead of CSV_FORMULA_INJECTION_LEAD_CHARS) {
      const neutralized = neutralizeFormulaInjectionLead(lead)
      expect(neutralized).toBe(`'${lead}`)
    }
  })
})

describe('CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS (independent literal census)', () => {
  it('is exactly the 1 named out-of-category exception -- a silent drop must fail this, not just iteration', () => {
    // Re-typed by hand, NOT derived from the constant under test -- this is what catches removal.
    // Written as \uXXXX escapes (not raw invisible/control bytes) so the list stays human-auditable.
    // NUL (\u0000) and NEL (\u0085) used to live here too; the P2-2/NIT-1 fix round moved both
    // into base-pattern coverage via `\p{Cc}`, so a THIRD escape appearing here again (without a
    // matching change to `CSV_IGNORABLE_LEAD_PATTERN`'s own comment) is exactly the regression
    // this census exists to catch.
    expect([...CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS].sort()).toEqual(['\u0301'].sort())
    expect(CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS.length).toBe(1)
  })
})

type IgnorableCorpusEntry = {
  label: string
  char: string
  expectIgnorable: boolean
  /**
   * NIT-2 fix -- which mechanism is expected to cover this entry, asserted independently of the
   * OR'd `isCsvIgnorableLeadChar` outcome (see the "SPLIT, not just union" describe block below).
   * `true` = the named supplement should carry it; `false` = the base pattern should carry it (or,
   * for a non-ignorable entry, neither should).
   */
  coveredBySupplement: boolean
}

/**
 * Gate 2's own 18 named residual lead-ins (`p31-gate2-findings.md`, finding P3-B), each with the
 * Unicode general category that determines whether `CSV_IGNORABLE_LEAD_PATTERN` covers it, or
 * whether it needs the named supplement. Expected values are hand-set from that category, NOT
 * computed by calling `isCsvIgnorableLeadChar` — that would make the assertion vacuous.
 *
 * `coveredBySupplement` reflects the CURRENT (post P2-2/NIT-1) predicate
 * (`/[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u`): NUL and NEL are `Cc` and are now
 * pattern-covered (`coveredBySupplement: false`), where the pre-P2-2/NIT-1 predicate needed them
 * in the supplement. U+0301 remains the one entry the pattern does not reach.
 */
const GATE2_RESIDUAL_CORPUS: ReadonlyArray<IgnorableCorpusEntry> = [
  { label: 'U+3000 IDEOGRAPHIC SPACE (Zs)', char: '\u3000', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+2000 EN QUAD (Zs)', char: '\u2000', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+2009 THIN SPACE (Zs)', char: '\u2009', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+200A HAIR SPACE (Zs)', char: '\u200A', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+202F NARROW NO-BREAK SPACE (Zs)', char: '\u202F', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+205F MEDIUM MATHEMATICAL SPACE (Zs)', char: '\u205F', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+1680 OGHAM SPACE MARK (Zs)', char: '\u1680', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+180E MONGOLIAN VOWEL SEPARATOR (Cf since Unicode 6.3)', char: '\u180E', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+000B VT (Cc, but ECMAScript WhiteSpace)', char: '\u000B', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+000C FF (Cc, but ECMAScript WhiteSpace)', char: '\u000C', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+202E RIGHT-TO-LEFT OVERRIDE (Cf)', char: '\u202E', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+200E LEFT-TO-RIGHT MARK (Cf)', char: '\u200E', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+0000 NUL (Cc — pattern-covered as of P2-2/NIT-1, was a supplement entry before)', char: '\u0000', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+2060 WORD JOINER (Cf)', char: '\u2060', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+0301 COMBINING ACUTE ACCENT (Mn — the one remaining named supplement entry)', char: '\u0301', expectIgnorable: true, coveredBySupplement: true },
  { label: 'U+00AD SOFT HYPHEN (Cf)', char: '\u00AD', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+0085 NEL (Cc — pattern-covered as of P2-2/NIT-1, was a supplement entry before)', char: '\u0085', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+2028 LINE SEPARATOR (Zl, but ECMAScript LineTerminator)', char: '\u2028', expectIgnorable: true, coveredBySupplement: false },
]

/**
 * Gate 3's additional named residuals (P2-2/NIT-1 findings): `Default_Ignorable_Code_Point`
 * characters the SECOND predicate (`/[\s\p{Cf}\p{Zs}]/u`) missed entirely, plus a representative
 * C0-control sample (including the U+001C-U+001F information separators) the second predicate
 * also left un-neutralized. All are covered by the THIRD predicate's pattern alone — none need
 * the supplement.
 */
const GATE3_RESIDUAL_CORPUS: ReadonlyArray<IgnorableCorpusEntry> = [
  { label: 'U+115F HANGUL CHOSEONG FILLER (Lo, but Default_Ignorable_Code_Point)', char: '\u115F', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+1160 HANGUL JUNGSEONG FILLER (Lo, but Default_Ignorable_Code_Point)', char: '\u1160', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+3164 HANGUL FILLER (Lo, but Default_Ignorable_Code_Point)', char: '\u3164', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+FFA0 HALFWIDTH HANGUL FILLER (Lo, but Default_Ignorable_Code_Point)', char: '\uFFA0', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+034F COMBINING GRAPHEME JOINER (Mn, but Default_Ignorable_Code_Point)', char: '\u034F', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+FE0F VARIATION SELECTOR-16 (Mn, but Default_Ignorable_Code_Point)', char: '\uFE0F', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+0001 SOH (C0 control, Cc)', char: '\u0001', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+0007 BEL (C0 control, Cc)', char: '\u0007', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+0018 CAN (C0 control, Cc)', char: '\u0018', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+001C FILE SEPARATOR (C0 control, Cc)', char: '\u001C', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+001D GROUP SEPARATOR (C0 control, Cc)', char: '\u001D', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+001E RECORD SEPARATOR (C0 control, Cc)', char: '\u001E', expectIgnorable: true, coveredBySupplement: false },
  { label: 'U+001F UNIT SEPARATOR (C0 control, Cc)', char: '\u001F', expectIgnorable: true, coveredBySupplement: false },
]

/** The original 7-entry table this fix round replaced, still exercised as part of the same corpus. */
const ORIGINAL_TABLE_CORPUS: ReadonlyArray<IgnorableCorpusEntry> = [
  { label: 'ASCII SPACE U+0020', char: ' ', expectIgnorable: true, coveredBySupplement: false },
  { label: 'TAB U+0009 (also DANGEROUS — see precedence tests below)', char: '\t', expectIgnorable: true, coveredBySupplement: false },
  { label: 'NBSP U+00A0', char: '\u00A0', expectIgnorable: true, coveredBySupplement: false },
  { label: 'ZWSP U+200B', char: '\u200B', expectIgnorable: true, coveredBySupplement: false },
  { label: 'ZWNJ U+200C', char: '\u200C', expectIgnorable: true, coveredBySupplement: false },
  { label: 'ZWJ U+200D', char: '\u200D', expectIgnorable: true, coveredBySupplement: false },
  { label: 'BOM/ZWNBSP U+FEFF', char: '\uFEFF', expectIgnorable: true, coveredBySupplement: false },
]

/** Ordinary characters that must NOT be classified ignorable -- discriminating power for the corpus. */
const ORDINARY_CORPUS: ReadonlyArray<IgnorableCorpusEntry> = [
  { label: 'lowercase letter', char: 'a', expectIgnorable: false, coveredBySupplement: false },
  { label: 'digit', char: '0', expectIgnorable: false, coveredBySupplement: false },
  { label: 'opening brace', char: '{', expectIgnorable: false, coveredBySupplement: false },
  { label: 'dangerous "=" (not ignorable -- it is DANGEROUS)', char: '=', expectIgnorable: false, coveredBySupplement: false },
]

const FULL_CORPUS = [...GATE2_RESIDUAL_CORPUS, ...GATE3_RESIDUAL_CORPUS, ...ORIGINAL_TABLE_CORPUS, ...ORDINARY_CORPUS]

describe('isCsvIgnorableLeadChar -- corpus-driven outcome assertions (not a re-listed enumeration)', () => {
  it('the corpus is discriminating (contains both true and false expectations)', () => {
    const trueCount = FULL_CORPUS.filter((c) => c.expectIgnorable).length
    const falseCount = FULL_CORPUS.filter((c) => !c.expectIgnorable).length
    expect(trueCount).toBeGreaterThan(0)
    expect(falseCount).toBeGreaterThan(0)
  })

  for (const { label, char, expectIgnorable } of FULL_CORPUS) {
    it(`${label} => isCsvIgnorableLeadChar is ${expectIgnorable}`, () => {
      expect(isCsvIgnorableLeadChar(char)).toBe(expectIgnorable)
    })
  }
})

describe('isCsvIgnorableLeadChar -- SPLIT, not just union (NIT-2 fix)', () => {
  it('the split is discriminating (both mechanisms are actually exercised by the corpus)', () => {
    const supplementCovered = FULL_CORPUS.filter((c) => c.coveredBySupplement).length
    const patternCovered = FULL_CORPUS.filter((c) => c.expectIgnorable && !c.coveredBySupplement).length
    expect(supplementCovered).toBeGreaterThan(0)
    expect(patternCovered).toBeGreaterThan(0)
  })

  for (const { label, char, expectIgnorable, coveredBySupplement } of FULL_CORPUS) {
    it(`${label} => mechanism is ${coveredBySupplement ? 'the named supplement' : (expectIgnorable ? 'the base pattern' : 'neither')}`, () => {
      // Checked against the two EXPORTED primitives directly -- never against
      // `isCsvIgnorableLeadChar`'s own OR'd outcome, which is exactly what would stay green if an
      // entry silently moved from one mechanism to the other without its label being updated.
      expect((CSV_IGNORABLE_LEAD_SUPPLEMENT_CHARS as readonly string[]).includes(char)).toBe(coveredBySupplement)
      expect(CSV_IGNORABLE_LEAD_PATTERN.test(char)).toBe(expectIgnorable && !coveredBySupplement)
    })
  }
})

describe('sanitizeCsvCell / neutralizeFormulaInjectionLead -- leading-ignorable-run bypass (P3-6 fix, P3-B corpus)', () => {
  for (const { label, char, expectIgnorable } of FULL_CORPUS) {
    if (!expectIgnorable) continue
    it(`a dangerous char hiding behind a leading ${label} is still neutralized`, () => {
      const raw = `${char}=cmd|'/c calc'!A1`
      const neutralized = neutralizeFormulaInjectionLead(raw)
      // The ORIGINAL text must survive byte-for-byte behind the apostrophe -- never trimmed.
      expect(neutralized).toBe(`'${raw}`)
      expect(neutralized.startsWith("'")).toBe(true)
      // The ignorable character itself is still there, right after the apostrophe -- proof this is
      // a PREFIX, not a trim-then-reconstruct.
      expect(neutralized[1]).toBe(char)
    })
  }

  it('reproduces the exact gate-1-reported vector: a leading ASCII space in front of a formula', () => {
    const raw = " =cmd|'/c calc'!A1"
    expect(neutralizeFormulaInjectionLead(raw)).toBe(`'${raw}`)
  })

  it('skips a RUN of multiple different ignorable characters, not just one', () => {
    const raw = '   \u200B=cmd'
    expect(neutralizeFormulaInjectionLead(raw)).toBe(`'${raw}`)
  })

  it('a lone ignorable character with NO dangerous character behind it is left untouched (negative control)', () => {
    for (const { char } of FULL_CORPUS.filter((c) => c.expectIgnorable)) {
      // TAB is a member of BOTH the dangerous table and the ignorable predicate -- excluded here
      // because a bare TAB is dangerous on its own; that case is already covered by the
      // "bare dangerous char" test above. Every OTHER ignorable character, alone, must be a no-op.
      if (char === '\t') continue
      expect(neutralizeFormulaInjectionLead(char)).toBe(char)
      expect(neutralizeFormulaInjectionLead(`${char}hello`)).toBe(`${char}hello`)
    }
  })

  it('an ordinary (non-ignorable, non-dangerous) leading character stops the scan -- nothing to neutralize', () => {
    for (const { char, expectIgnorable } of ORDINARY_CORPUS) {
      if (char === '=') continue // '=' is DANGEROUS, not ordinary -- covered by the dangerous-table tests.
      expect(expectIgnorable).toBe(false)
      expect(neutralizeFormulaInjectionLead(`${char}=cmd`)).toBe(`${char}=cmd`)
    }
  })

  it('precedence: TAB, CR, and LF are members of BOTH tables and always stay dangerous', () => {
    // Documents the precedence rule directly: dangerous-membership beats ignorable-membership,
    // for every character that is a member of both -- not just TAB (CR/LF are ALSO now covered by
    // the ignorable predicate via `\s`, unlike the pre-P3-B 7-entry table, which only overlapped
    // on TAB).
    for (const dangerousAndIgnorable of ['\t', '\r', '\n']) {
      expect(isCsvIgnorableLeadChar(dangerousAndIgnorable)).toBe(true)
      expect(neutralizeFormulaInjectionLead(dangerousAndIgnorable)).toBe(`'${dangerousAndIgnorable}`)
      expect(neutralizeFormulaInjectionLead(`${dangerousAndIgnorable}hello`)).toBe(`'${dangerousAndIgnorable}hello`)
    }
  })
})

describe('sanitizeCsvCell -- negative controls (must NOT be touched)', () => {
  for (const safe of ['a', '{', '0', '', 'hello world', 'SUM of things']) {
    it(`leaves ${JSON.stringify(safe)} unprefixed`, () => {
      expect(neutralizeFormulaInjectionLead(safe)).toBe(safe)
      // sanitizeCsvCell may still RFC-4180 quote (none of these need it), but must never prepend
      // an apostrophe to a value that does not start with a dangerous character.
      const cell = sanitizeCsvCell(safe)
      const unquoted = cell.startsWith('"') && cell.endsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell
      expect(unquoted.startsWith("'")).toBe(false)
      expect(unquoted).toBe(safe)
    })
  }
})

describe('RFC-4180 quoting (quoteRfc4180)', () => {
  it('wraps and doubles internal quotes when the cell contains a double quote', () => {
    expect(quoteRfc4180('he said "hi"')).toBe('"he said ""hi"""')
  })
  it('wraps when the cell contains a comma', () => {
    expect(quoteRfc4180('a,b')).toBe('"a,b"')
  })
  it('wraps when the cell contains CR or LF', () => {
    expect(quoteRfc4180('line1\nline2')).toBe('"line1\nline2"')
    expect(quoteRfc4180('line1\rline2')).toBe('"line1\rline2"')
  })
  it('leaves a plain cell untouched', () => {
    expect(quoteRfc4180('plain value')).toBe('plain value')
  })
})

describe('sanitizeCsvCell -- ordering (neutralize BEFORE quote, contract Sec.3.1)', () => {
  it('a formula-leading cell that also needs quoting gets both, apostrophe innermost', () => {
    const cell = sanitizeCsvCell('=A1,B1')
    expect(cell).toBe('"\'=A1,B1"')
  })
})

describe('stringifyCsvValue', () => {
  it('renders null/undefined as an empty cell, never the literal text', () => {
    expect(stringifyCsvValue(null)).toBe('')
    expect(stringifyCsvValue(undefined)).toBe('')
  })
  it('passes strings through unchanged', () => {
    expect(stringifyCsvValue('hello')).toBe('hello')
  })
  it('stringifies numbers and booleans', () => {
    expect(stringifyCsvValue(42)).toBe('42')
    expect(stringifyCsvValue(-42)).toBe('-42')
    expect(stringifyCsvValue(true)).toBe('true')
  })
  it('JSON-serializes objects and arrays (structured DTO fields round-trip)', () => {
    expect(stringifyCsvValue({ recordId: 'r1' })).toBe('{"recordId":"r1"}')
    expect(stringifyCsvValue({ inaccessible: true })).toBe('{"inaccessible":true}')
    expect(stringifyCsvValue([1, 2, 3])).toBe('[1,2,3]')
  })
  it('does not crash on a value JSON.stringify itself returns undefined for', () => {
    // A bare function is not a realistic DTO value, but the sanitizer must never throw on it.
    expect(() => stringifyCsvValue((() => {}) as unknown)).not.toThrow()
    expect(stringifyCsvValue((() => {}) as unknown)).toBe('')
  })
  it('a JSON-wrapped object never starts with a dangerous character, but is still run through the same sanitizer', () => {
    // Structural safety of "{" is incidental, not a substitute for calling the sanitizer: a
    // record-link value that contains a formula-leading string value is still safe because the
    // outer JSON brace is the CELL's leading character, but the sanitizer must be applied to this
    // field uniformly regardless (contract Sec.3.3 -- every JSON-sourced field, not just the
    // obvious ones). Confirm no accidental prefix is added to well-formed JSON text.
    const cell = sanitizeCsvCell({ note: '=cmd' })
    // JSON.stringify's own double quotes make this cell RFC-4180-quotable regardless (it contains
    // `"`), which is orthogonal to the leading-character neutralization this assertion targets.
    expect(cell.startsWith("'")).toBe(false)
    expect(cell.startsWith('"')).toBe(true)
    expect(cell.slice(1, -1).replace(/""/g, '"')).toBe('{"note":"=cmd"}')
  })
})

describe('sanitizeCsvRow / CSV_LINE_TERMINATOR', () => {
  it('joins sanitized cells with a comma', () => {
    expect(sanitizeCsvRow(['a', 'b,c', '=cmd'])).toBe('a,"b,c",\'=cmd')
  })
  it('applies sanitization to every cell, including what would be a header row', () => {
    const header = sanitizeCsvRow(['id', '=HEADER-INJECTION', 'status'])
    expect(header).toBe("id,'=HEADER-INJECTION,status")
  })
  it('exports CRLF as the documented line terminator', () => {
    expect(CSV_LINE_TERMINATOR).toBe('\r\n')
  })
})
