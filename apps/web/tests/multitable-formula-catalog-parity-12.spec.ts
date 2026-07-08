/**
 * Formula catalog parity — subset guard (audit-driven).
 *
 * A benchmark audit found 12 scalar functions the ENGINE (packages/core-backend/src/formula/engine.ts,
 * `registerBuiltinFunctions`) already implements but the user-facing CATALOG (FORMULA_FUNCTION_DOCS)
 * never advertised: DAYS, EDATE, IFERROR, IFS, ISBLANK, ISERROR, ISNUMBER, ROUNDDOWN, ROUNDUP, SECOND,
 * WEEKDAY, XOR. This test locks two things:
 *   1. the catalog is a SUBSET of (engine registry ∪ RELxxx relation-scoped helpers ∪ operator docs) —
 *      never advertise a function users can't actually call;
 *   2. the 12 audited functions are now present, and COUNTIF stays intentionally absent (it takes a
 *      range, which the `{fld}`-reference model can't express — advertising it would be a false-
 *      capability bug).
 *
 * This is deliberately NOT an equality check (catalog === engine): RELSUMIF/RELAVGIF/RELCOUNTIF/
 * RELLOOKUP/RELVALUES are relation-scoped resolver helpers outside `FormulaEngine`, and the catalog's
 * operator entries (ADD/SUBTRACT/.../COMPARISON) document infix syntax rather than registered function
 * names — neither shows up in `getRegisteredFunctionNames()`.
 *
 * ENGINE_REGISTRY below mirrors the engine's real registered names (captured via
 * `new FormulaEngine().getRegisteredFunctionNames()` while auditing this slice). apps/web has no
 * dependency on @metasheet/core-backend (importing the engine module would also pull in a live Kysely/pg
 * pool from ../db/db at import time), so this list is a locked mirror rather than a live cross-package
 * import — matching the precedent in packages/core-backend/tests/unit/formula-1a-text-date-expansion.test.ts,
 * which hardcodes its own expected-name list rather than importing a shared constant.
 */
import { describe, expect, it } from 'vitest'
import { FORMULA_FUNCTION_DOCS } from '../src/multitable/utils/formula-docs'

// Mirrors packages/core-backend/src/formula/engine.ts `registerBuiltinFunctions()` — every key ever
// passed to `this.functions.set(...)`, alphabetized (matches `getRegisteredFunctionNames()`'s `.sort()`).
const ENGINE_REGISTRY = new Set([
  'ABS', 'AND', 'AVERAGE', 'CEILING', 'CONCAT', 'CONCATENATE', 'COUNT', 'COUNTA', 'COUNTIF', 'DATE',
  'DATEADD', 'DATEDIF', 'DATEDIFF', 'DAY', 'DAYS', 'EDATE', 'EOMONTH', 'EXP', 'FALSE', 'FIND', 'FLOOR',
  'HLOOKUP', 'HOUR', 'IF', 'IFERROR', 'IFS', 'INDEX', 'INT', 'ISBLANK', 'ISERROR', 'ISNUMBER', 'LEFT',
  'LEN', 'LN', 'LOG', 'LOWER', 'MATCH', 'MAX', 'MEDIAN', 'MID', 'MIN', 'MINUTE', 'MOD', 'MODE', 'MONTH',
  'NOT', 'NOW', 'OR', 'POWER', 'REGEXEXTRACT', 'REGEXMATCH', 'REGEXREPLACE', 'REPLACE', 'REPT', 'RIGHT',
  'ROUND', 'ROUNDDOWN', 'ROUNDUP', 'SEARCH', 'SECOND', 'SQRT', 'STDEV', 'SUBSTITUTE', 'SUM', 'SWITCH',
  'TEXT', 'TODAY', 'TRIM', 'TRUE', 'TRUNC', 'UPPER', 'VAR', 'VLOOKUP', 'WEEKDAY', 'WEEKNUM', 'WORKDAY',
  'XOR', 'YEAR',
])

// Relation-scoped resolver helpers (not part of FormulaEngine's own registry — resolved separately
// against linked-record data) that the catalog is allowed to document.
const REL_HELPERS = new Set(['RELSUMIF', 'RELAVGIF', 'RELCOUNTIF', 'RELLOOKUP', 'RELVALUES'])

// Catalog entries that document infix operator syntax rather than a callable registered function name.
const OPERATOR_DOCS = new Set([
  'ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'POWER_OPERATOR', 'PERCENT_OPERATOR', 'CONCAT_OPERATOR', 'COMPARISON',
])

const ALLOWED_CATALOG_NAMES = new Set([...ENGINE_REGISTRY, ...REL_HELPERS, ...OPERATOR_DOCS])

const AUDITED_FUNCTIONS = [
  'DAYS', 'EDATE', 'IFERROR', 'IFS', 'ISBLANK', 'ISERROR', 'ISNUMBER', 'ROUNDDOWN', 'ROUNDUP', 'SECOND',
  'WEEKDAY', 'XOR',
]

describe('formula catalog — parity subset guard', () => {
  it('is a SUBSET of the engine registry ∪ REL* helpers ∪ operator docs (never advertises a false capability)', () => {
    for (const doc of FORMULA_FUNCTION_DOCS) {
      expect(ALLOWED_CATALOG_NAMES.has(doc.name), `catalog advertises ${doc.name} but it is not callable`).toBe(true)
    }
  })

  it('now advertises all 12 audited engine-supported scalar functions', () => {
    const catalogNames = new Set(FORMULA_FUNCTION_DOCS.map((doc) => doc.name))
    for (const fn of AUDITED_FUNCTIONS) {
      expect(catalogNames.has(fn), `catalog missing audited function ${fn}`).toBe(true)
      expect(ENGINE_REGISTRY.has(fn), `${fn} expected in engine registry mirror`).toBe(true)
    }
  })

  it('does NOT advertise COUNTIF — it takes a range, which the {fld}-reference model cannot express', () => {
    const catalogNames = new Set(FORMULA_FUNCTION_DOCS.map((doc) => doc.name))
    expect(catalogNames.has('COUNTIF')).toBe(false)
    // Sanity: COUNTIF really is engine-supported, so its absence is a deliberate catalog choice, not a gap.
    expect(ENGINE_REGISTRY.has('COUNTIF')).toBe(true)
  })
})
