/**
 * W1-1 (design-lock 2026-07-05 §2 LOCK-F, F1) — DURABLE STRUCTURAL GUARD pinning the Yjs-bridge
 * production wiring itself.
 *
 * `index.ts`'s Yjs-bridge `RecordWriteHelpers` construction is exercised at server startup only
 * (behind `ENABLE_YJS_COLLAB`), inside a class method that is not exported/importable — so it
 * cannot be driven end-to-end from a unit test the way `multitable-w11-bridge-formula-freshness-
 * realdb.test.ts` drives the underlying `recalculateFormulaFieldsForActor` logic (that suite
 * constructs its OWN helpers object mirroring index.ts's, which proves the LOGIC is correct and
 * taint-safe but cannot, by itself, catch a future accidental revert of the one-line production
 * wiring back to the stub). This guard closes that gap with a source-text pin: it fails if
 * index.ts's bridge helpers ever again read `recalculateFormulaFields: async () => []`, and it
 * fails if the real actor-based helper import/wiring goes missing.
 *
 * Verified non-vacuous manually during PR development: temporarily reverting index.ts's
 * `recalculateFormulaFields` field back to the literal stub flips this guard RED; restoring the
 * real wiring flips it back GREEN. (Not re-asserted here as a mutation test — this file pins the
 * CURRENT source text, which is the durable, low-maintenance form the sibling chokepoint guard
 * `multitable-stored-data-taint-chokepoint.guard.test.ts` also uses.)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const INDEX_TS = readFileSync(join(__dirname, '../../src/index.ts'), 'utf8')

describe('W1-1 LOCK-F — Yjs-bridge formula recompute wiring guard', () => {
  test('the stale stub (recalculateFormulaFields: async () => []) is gone from index.ts', () => {
    expect(INDEX_TS).not.toMatch(/recalculateFormulaFields:\s*async\s*\(\s*\)\s*=>\s*\[\]/)
  })

  test('the bridge RecordWriteHelpers wires recalculateFormulaFields to the real actor-based helper', () => {
    expect(INDEX_TS).toContain('recalculateFormulaFieldsForActor')
    // The wiring must live in the SAME object literal as the (still deliberately stubbed, F4)
    // lookup/rollup fan-out helpers — i.e. it is the Yjs-bridge RecordWriteHelpers construction,
    // not some unrelated reference to the symbol.
    expect(INDEX_TS).toMatch(
      /computeDependentLookupRollupRecords:\s*async\s*\(\)\s*=>\s*\[\][\s\S]{0,800}recalculateFormulaFieldsForActor/,
    )
  })

  test('lookup/rollup fan-out stays a deliberate stub on the bridge path (F4 — named residual, GF9)', () => {
    expect(INDEX_TS).toMatch(/applyLookupRollup:\s*async\s*\(\)\s*=>\s*\{\}/)
    expect(INDEX_TS).toMatch(/computeDependentLookupRollupRecords:\s*async\s*\(\)\s*=>\s*\[\]/)
  })
})
