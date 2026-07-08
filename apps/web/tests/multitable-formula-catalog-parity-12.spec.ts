/**
 * Formula catalog parity — intent guard (audit-driven).
 *
 * A benchmark audit found 12 scalar functions the ENGINE (packages/core-backend/src/formula/engine.ts,
 * `registerBuiltinFunctions`) already implements but the user-facing CATALOG (FORMULA_FUNCTION_DOCS)
 * never advertised: DAYS, EDATE, IFERROR, IFS, ISBLANK, ISERROR, ISNUMBER, ROUNDDOWN, ROUNDUP, SECOND,
 * WEEKDAY, XOR. This spec locks the user-facing INTENT of that audit: the 12 are now present, and
 * COUNTIF stays intentionally absent (it takes a range, which the `{fld}`-reference model can't
 * express — advertising it would be a false-capability bug).
 *
 * This spec deliberately does NOT assert catalog ⊆ engine-registry here. An earlier version of this
 * file hand-copied the engine's registry into a same-PR mirror constant and asserted the subset
 * relationship against that mirror — a wire-vs-fixture blind spot: with no import edge to the engine,
 * no change to engine.ts could ever turn this spec red (proven by an adversarial gate: deleting
 * `this.functions.set('XOR', …)` from engine.ts left the mirror-based version of this spec green,
 * while a user's `=XOR(...)` would now fail with `#NAME?`). apps/web has no dependency on
 * @metasheet/core-backend, so this package cannot check that relationship against the LIVE registry.
 *
 * The catalog ⊆ callable-functions drift guard now lives where it can see both sides:
 * packages/core-backend/tests/unit/formula-catalog-web-parity.test.ts constructs the real
 * FormulaEngine, reads getRegisteredFunctionNames() LIVE (no mirror), and fs-reads this package's
 * catalog source — so a genuine engine/catalog drift (including a bogus/typo'd catalog entry, or an
 * engine removal/rename) turns that test red. See that file's header for the full rationale.
 */
import { describe, expect, it } from 'vitest'
import { FORMULA_FUNCTION_DOCS } from '../src/multitable/utils/formula-docs'

const AUDITED_FUNCTIONS = [
  'DAYS', 'EDATE', 'IFERROR', 'IFS', 'ISBLANK', 'ISERROR', 'ISNUMBER', 'ROUNDDOWN', 'ROUNDUP', 'SECOND',
  'WEEKDAY', 'XOR',
]

describe('formula catalog — parity intent guard', () => {
  it('now advertises all 12 audited engine-supported scalar functions', () => {
    const catalogNames = new Set(FORMULA_FUNCTION_DOCS.map((doc) => doc.name))
    for (const fn of AUDITED_FUNCTIONS) {
      expect(catalogNames.has(fn), `catalog missing audited function ${fn}`).toBe(true)
    }
  })

  it('does NOT advertise COUNTIF — it takes a range, which the {fld}-reference model cannot express', () => {
    const catalogNames = new Set(FORMULA_FUNCTION_DOCS.map((doc) => doc.name))
    expect(catalogNames.has('COUNTIF')).toBe(false)
  })
})
