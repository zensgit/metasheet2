/**
 * Web catalog ⊆ live-engine-callable drift guard.
 *
 * The user-facing formula catalog lives in apps/web (FORMULA_FUNCTION_DOCS,
 * apps/web/src/multitable/utils/formula-docs.ts) — a picker/autocomplete source that must never
 * advertise a name the engine cannot actually execute (else the user gets `#NAME?`). apps/web has
 * no build/runtime dependency on @metasheet/core-backend, so the catalog cannot import
 * getRegisteredFunctionNames() directly; the original web-side guard
 * (apps/web/tests/multitable-formula-catalog-parity-12.spec.ts) worked around this by hand-copying
 * the engine's registry into a same-PR mirror constant and diffing the catalog against that mirror.
 * That is a wire-vs-fixture blind spot: it is impossible for a change to engine.ts to turn the
 * web-side test red, because there is no import edge to the engine at all. An adversarial gate
 * proved this by deleting `this.functions.set('XOR', …)` from engine.ts — the web guard stayed
 * green while a user's `=XOR(...)` would now fail with `#NAME?`.
 *
 * This test closes that gap from the side that CAN see both: a backend test file can construct the
 * real FormulaEngine (LIVE getRegisteredFunctionNames(), no mirror) and fs-read the web catalog
 * source, so a genuine engine/catalog drift turns THIS test red.
 *
 * Direction matters: this asserts catalog ⊆ callable, never equality. The engine legitimately
 * registers functions (e.g. COUNTIF) that the catalog must NOT advertise, because they take a
 * range/criteria the `{fld}`-single-value-reference model can't express — that is a deliberate
 * catalog omission, not a gap this guard should flag.
 *
 * Anti-fixture hardening: the drift check depends on a regex scrape of the web catalog's source
 * text. If the catalog's formatting or relative path ever changes, a naive scrape would silently
 * match zero names, `uncallable` would trivially be `[]`, and this guard would go quietly green —
 * reproducing the exact blind spot it exists to close. The sanity assertions below (file
 * non-empty, scraped count in a plausible range, known anchor names present) exist so a broken
 * scrape fails LOUD instead of passing silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FormulaEngine } from '../../src/formula/engine'
import { createMockDb } from '../utils/test-db'

// Relation-scoped resolver helpers (resolved separately against linked-record data, not part of
// FormulaEngine's own `this.functions` registry) that the catalog is allowed to document.
const REL_HELPERS = new Set(['RELSUMIF', 'RELAVGIF', 'RELCOUNTIF', 'RELLOOKUP', 'RELVALUES'])

// Catalog entries documenting infix operator syntax rather than a registered callable function name.
const OPERATOR_DOCS = new Set([
  'ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'POWER_OPERATOR', 'PERCENT_OPERATOR', 'CONCAT_OPERATOR', 'COMPARISON',
])

const WEB_CATALOG_PATH = resolve(__dirname, '../../../../apps/web/src/multitable/utils/formula-docs.ts')
const CATALOG_NAME_PATTERN = /^ {4}name: '([A-Z0-9_]+)',$/gm

function scrapeCatalogNames(): { source: string; names: string[] } {
  const source = readFileSync(WEB_CATALOG_PATH, 'utf8')
  const names = [...source.matchAll(CATALOG_NAME_PATTERN)].map((m) => m[1])
  return { source, names }
}

describe('formula catalog web-parity drift guard', () => {
  it('sanity: the web catalog source file is readable and non-trivial (anti-fixture: a broken path must fail LOUD)', () => {
    const { source } = scrapeCatalogNames()
    expect(source.length).toBeGreaterThan(1000)
  })

  it('sanity: the name scrape finds a plausible entry count and known anchor names (anti-fixture: a broken regex must fail LOUD, not silently pass with an empty diff)', () => {
    const { names } = scrapeCatalogNames()
    // Measured catalog size at authoring time was 90; live engine registry was 78. Bound loosely so
    // small additive changes don't need to touch this test, while a scrape that finds ~0 names
    // (broken regex/path) is unambiguously wrong.
    expect(names.length).toBeGreaterThanOrEqual(80)
    expect(names).toContain('SUM')
    expect(names).toContain('IFERROR')
  })

  it('every catalog function name is callable: live engine registry ∪ REL* helpers ∪ operator docs (never advertise a false capability)', () => {
    const engine = new FormulaEngine({ db: createMockDb() })
    const live = new Set(engine.getRegisteredFunctionNames())

    const { names } = scrapeCatalogNames()
    // Re-assert the anti-fixture bound here too: if this ever regresses to 0, the `uncallable`
    // check below would trivially and silently pass.
    expect(names.length).toBeGreaterThanOrEqual(80)

    const uncallable = names.filter((n) => !live.has(n) && !REL_HELPERS.has(n) && !OPERATOR_DOCS.has(n))
    expect(uncallable, `catalog advertises uncallable: ${uncallable.join(', ')}`).toEqual([])
  })
})
