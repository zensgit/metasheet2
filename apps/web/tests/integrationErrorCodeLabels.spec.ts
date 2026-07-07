import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Mirror-sync tripwire (IU-1, design-lock docs/development/integration-ux-workbench-redesign-design-lock-20260706.md,
// #3739): every code in the server's registered vocabularies (resolver/probe/composition/BOM-list) must
// have a non-empty zh + en label entry in errorCodeLabels.ts. If the server ever extends a vocabulary and
// this module is not synced, this test fails RED — same discipline as
// multitable-resolver-vocab-mirror.spec.ts / composition-vocab-mirror.spec.ts.
import {
  DEAD_LETTER_MAINLINE_ERROR_CODES,
  K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES,
  integrationErrorCodeDisplayLabel,
  integrationErrorCodeLabel,
} from '../src/services/integration/errorCodeLabels'

const require = createRequire(import.meta.url)
const pluginLib = path.resolve(__dirname, '../../../plugins/plugin-integration-core/lib')

// The server exports these directly — require, never text-parse.
const { READ_SOURCE_PROBE_ERROR_CODES: SERVER_PROBE_ERROR_CODES, READ_SOURCE_RESOLVER_ERROR_CODES: SERVER_RESOLVER_ERROR_CODES } =
  require(path.join(pluginLib, 'read-source-probe-contract.cjs'))
const { READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES: SERVER_COMPOSITION_ERROR_CODES } =
  require(path.join(pluginLib, 'read-source-composition-planner.cjs'))
const { K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES: SERVER_BOM_LIST_ERROR_CODES } =
  require(path.join(pluginLib, 'read-source-bom-list-by-material-contract.cjs'))

function expectLabeled(code: string): void {
  const label = integrationErrorCodeLabel(code, 'en')
  expect(label, `expected a label entry for ${code}`).not.toBeNull()
  expect(label?.zh, `${code} zh must be non-empty`).toBeTruthy()
  expect(label?.en, `${code} en must be non-empty`).toBeTruthy()
}

describe('errorCodeLabels coverage (mirror tripwire)', () => {
  it('every server resolver code (9) has a label', () => {
    expect(SERVER_RESOLVER_ERROR_CODES.length).toBe(9)
    for (const code of SERVER_RESOLVER_ERROR_CODES) expectLabeled(code)
  })

  it('every server probe code (union set) has a label', () => {
    // NOTE: as of this writing the server's READ_SOURCE_PROBE_ERROR_CODES spreads in BOTH the 9
    // resolver codes AND the 8 K3 WISE BOM-list-by-material codes (BL2), so the union is 28, not the
    // 20 originally cited in the design-lock research doc (11 probe-own + 9 resolver) — the doc itself
    // warned the cited line numbers/counts might have shifted since. This is a PRE-EXISTING drift
    // between the server vocabulary and the client mirror in readSourceConfigs.ts (which still only
    // spreads in the 9 resolver codes, not the 8 BOM-list codes) — out of scope to fix here (IU-1 is
    // labels-only, zero behavior change), but every code in the server's CURRENT union set must still
    // have a label in this module, which is asserted below.
    expect(SERVER_PROBE_ERROR_CODES.length).toBe(28)
    for (const code of SERVER_PROBE_ERROR_CODES) expectLabeled(code)
  })

  it('every server composition code (8) has a label', () => {
    expect(SERVER_COMPOSITION_ERROR_CODES.length).toBe(8)
    for (const code of SERVER_COMPOSITION_ERROR_CODES) expectLabeled(code)
  })

  it('every server K3 WISE BOM-list-by-material code (8) has a label, and the local mirror matches the server set', () => {
    expect(SERVER_BOM_LIST_ERROR_CODES.length).toBe(8)
    expect(new Set(K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES)).toEqual(new Set(SERVER_BOM_LIST_ERROR_CODES))
    for (const code of SERVER_BOM_LIST_ERROR_CODES) expectLabeled(code)
  })

  it('every dead-letter known-mainline code (10) has a label', () => {
    expect(DEAD_LETTER_MAINLINE_ERROR_CODES.length).toBe(10)
    for (const code of DEAD_LETTER_MAINLINE_ERROR_CODES) expectLabeled(code)
  })
})

describe('integrationErrorCodeLabel / integrationErrorCodeDisplayLabel (exact-key lookup only)', () => {
  it('returns null for an enum-shaped-but-unregistered code', () => {
    expect(integrationErrorCodeLabel('READ_SOURCE_PROBE_NOT_A_REAL_CODE', 'en')).toBeNull()
  })

  it('returns null for undefined / null / empty string', () => {
    expect(integrationErrorCodeLabel(undefined, 'en')).toBeNull()
    expect(integrationErrorCodeLabel(null, 'en')).toBeNull()
    expect(integrationErrorCodeLabel('', 'en')).toBeNull()
  })

  it('does not prefix/substring match — a code that merely CONTAINS a registered code is not a hit', () => {
    expect(integrationErrorCodeLabel('READ_SOURCE_PROBE_TIMEOUT_EXTRA', 'en')).toBeNull()
    expect(integrationErrorCodeLabel('XREAD_SOURCE_PROBE_TIMEOUT', 'en')).toBeNull()
  })

  it('never resolves inherited Object.prototype keys as a "code"', () => {
    expect(integrationErrorCodeLabel('toString', 'en')).toBeNull()
    expect(integrationErrorCodeLabel('constructor', 'en')).toBeNull()
    expect(integrationErrorCodeLabel('hasOwnProperty', 'en')).toBeNull()
  })

  it('integrationErrorCodeDisplayLabel returns the generic unknown text for unregistered codes', () => {
    expect(integrationErrorCodeDisplayLabel('READ_SOURCE_PROBE_NOT_A_REAL_CODE', 'en')).toBe('Unknown error')
    expect(integrationErrorCodeDisplayLabel('READ_SOURCE_PROBE_NOT_A_REAL_CODE', 'zh-CN')).toBe('未知错误')
    expect(integrationErrorCodeDisplayLabel(undefined, 'en')).toBe('Unknown error')
  })

  it('locale switching: the same registered code returns different zh vs en text', () => {
    const zh = integrationErrorCodeLabel('READ_SOURCE_RESOLVER_AMBIGUOUS', 'zh-CN')
    const en = integrationErrorCodeLabel('READ_SOURCE_RESOLVER_AMBIGUOUS', 'en')
    expect(zh?.zh).toBe('匹配到多条记录，无法唯一确定')
    expect(en?.en).toBe('Multiple records matched; the result is ambiguous.')
    expect(zh?.zh).not.toBe(en?.en)

    expect(integrationErrorCodeDisplayLabel('READ_SOURCE_RESOLVER_AMBIGUOUS', 'zh-CN')).toBe('匹配到多条记录，无法唯一确定')
    expect(integrationErrorCodeDisplayLabel('READ_SOURCE_RESOLVER_AMBIGUOUS', 'en')).toBe(
      'Multiple records matched; the result is ambiguous.',
    )
  })

  it('a registered code with a hint carries it through; one without does not', () => {
    expect(integrationErrorCodeLabel('READ_SOURCE_RESOLVER_AMBIGUOUS', 'en')?.hint?.en).toBeTruthy()
    expect(integrationErrorCodeLabel('READ_SOURCE_RESOLVER_FAILED', 'en')?.hint).toBeUndefined()
  })
})
