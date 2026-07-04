import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Mirror-sync tripwire (C-R4-2, #1709): the composition chain-evidence coarse codes are mirrored
// client-side in readSourceCompositions.ts from the server source-of-truth
// (plugins/plugin-integration-core/lib/read-source-composition-planner.cjs). If the server ever extends
// the coarse-code vocabulary and the client is not synced, the client silently drops the new value and
// the C-R4-3 UI mislabels it. This test fails RED the moment the two diverge — sync
// readSourceCompositions.ts (and any C-R4-3 UI/tests) whenever it does. Same discipline as
// multitable-resolver-vocab-mirror.spec.ts.
import {
  COMPOSITION_PLAN_ERROR_CODES,
  asCompositionPlanErrorCode,
} from '../src/services/integration/readSourceCompositions'

const require = createRequire(import.meta.url)
const pluginLib = path.resolve(__dirname, '../../../plugins/plugin-integration-core/lib')
// The server exports the frozen array directly — require, never text-parse.
const { READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES: SERVER_COMPOSITION_PLAN_ERROR_CODES } =
  require(path.join(pluginLib, 'read-source-composition-planner.cjs'))

const set = (values: Iterable<string>): Set<string> => new Set(values)

describe('composition vocab client/server mirror parity (tripwire)', () => {
  it('client COMPOSITION_PLAN_ERROR_CODES === server READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES', () => {
    expect(set(COMPOSITION_PLAN_ERROR_CODES)).toEqual(set(SERVER_COMPOSITION_PLAN_ERROR_CODES))
    // Guard the count so a same-size swap still trips.
    expect(COMPOSITION_PLAN_ERROR_CODES.length).toBe(8)
    expect(new Set(COMPOSITION_PLAN_ERROR_CODES).size).toBe(8)
    expect(SERVER_COMPOSITION_PLAN_ERROR_CODES.length).toBe(8)
  })

  it('every server code is a recognized client code (no unknown coarse code slips through)', () => {
    for (const code of SERVER_COMPOSITION_PLAN_ERROR_CODES) {
      expect(asCompositionPlanErrorCode(code)).toBe(code)
    }
  })

  it('asCompositionPlanErrorCode narrows unknown / non-string to null', () => {
    expect(asCompositionPlanErrorCode('READ_SOURCE_COMPOSITION_NOT_A_REAL_CODE')).toBeNull()
    expect(asCompositionPlanErrorCode('MAT_001_SECRET')).toBeNull()
    expect(asCompositionPlanErrorCode(undefined)).toBeNull()
    expect(asCompositionPlanErrorCode(42)).toBeNull()
  })
})
