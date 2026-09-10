import { createRequire } from 'node:module'
import { READ_SOURCE_PROBE_ERROR_CODES as CLIENT_PROBE_ERROR_CODES } from '../src/services/integration/readSourceConfigs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Mirror-sync tripwire (IU-1, design-lock docs/development/integration-ux-workbench-redesign-design-lock-20260706.md,
// #3739): every code in the server's registered vocabularies (resolver/probe/composition/BOM-list) must
// have a non-empty zh + en label entry in errorCodeLabels.ts. If the server ever extends a vocabulary and
// this module is not synced, this test fails RED — same discipline as
// multitable-resolver-vocab-mirror.spec.ts / composition-vocab-mirror.spec.ts.
import {
  BRIDGE_AGENT_ERROR_CODES,
  DEAD_LETTER_MAINLINE_ERROR_CODES,
  EXTERNAL_WRITE_FENCE_ERROR_CODES,
  K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES,
  integrationErrorCodeDisplayLabel,
  integrationErrorCodeHint,
  integrationErrorCodeLabel,
} from '../src/services/integration/errorCodeLabels'
import {
  K3_EXTERNAL_WRITE_TARGET_KINDS,
  K3_WRITE_FENCE_NOTICE,
  isK3ExternalWriteTargetKind,
} from '../src/services/integration/writeFence'
import { integrationApiErrorCode, parseIntegrationResponse } from '../src/services/integration/workbench'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const pluginLib = path.resolve(__dirname, '../../../plugins/plugin-integration-core/lib')

// The server exports these directly — require, never text-parse.
const { READ_SOURCE_PROBE_ERROR_CODES: SERVER_PROBE_ERROR_CODES, READ_SOURCE_RESOLVER_ERROR_CODES: SERVER_RESOLVER_ERROR_CODES } =
  require(path.join(pluginLib, 'read-source-probe-contract.cjs'))
const { READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES: SERVER_COMPOSITION_ERROR_CODES } =
  require(path.join(pluginLib, 'read-source-composition-planner.cjs'))
const { K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES: SERVER_BOM_LIST_ERROR_CODES } =
  require(path.join(pluginLib, 'read-source-bom-list-by-material-contract.cjs'))
const { BRIDGE_AGENT_READONLY_ADAPTER_ERROR_CODES: SERVER_BRIDGE_AGENT_ERROR_CODES } =
  require(path.join(pluginLib, 'adapters', 'bridge-agent-readonly-adapter.cjs'))
const {
  K3_WISE_EXTERNAL_WRITE_DISABLED: SERVER_K3_EXTERNAL_WRITE_DISABLED,
  K3_EXTERNAL_WRITE_TARGET_KINDS: SERVER_K3_FENCED_KINDS,
} = require(path.join(pluginLib, 'k3-external-write-permanent-fence.cjs'))
const { OUTBOUND_HTTP_WRITE_DISABLED: SERVER_OUTBOUND_HTTP_WRITE_DISABLED } =
  require(path.join(pluginLib, 'outbound-http-write-gate.cjs'))
const { K3_FENCE_NOTICE: SERVER_K3_FENCE_NOTICE } =
  require(path.join(pluginLib, 'integration-hub-overview.cjs'))

// A JSON error envelope exactly as plugin-integration-core `sendError` emits it.
function envelopeResponse(status: number, error: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function expectLabeled(code: string): void {
  const label = integrationErrorCodeLabel(code, 'en')
  expect(label, `expected a label entry for ${code}`).not.toBeNull()
  expect(label?.zh, `${code} zh must be non-empty`).toBeTruthy()
  expect(label?.en, `${code} en must be non-empty`).toBeTruthy()
}

// G10 — the external-write FENCE family.
//
// These three codes are not faults; they are the runtime saying "this write is permanently not
// offered". Unlabeled, they rendered as the generic 未知错误 fallback (or, at the status bar, as the
// server's English refusal prose), which reads like an outage and sends an operator hunting for a
// switch that does not exist. Every assertion below is about that being impossible again.
describe('external-write fence codes (G10)', () => {
  it('mirrors the exact server tokens for the fence codes', () => {
    expect(EXTERNAL_WRITE_FENCE_ERROR_CODES.length).toBe(4)
    // Two of the three are exported constants — required, never text-parsed, like every other family.
    expect(EXTERNAL_WRITE_FENCE_ERROR_CODES).toContain(SERVER_K3_EXTERNAL_WRITE_DISABLED)
    expect(EXTERNAL_WRITE_FENCE_ERROR_CODES).toContain(SERVER_OUTBOUND_HTTP_WRITE_DISABLED)
    // The third is NOT exported: pipeline-runner.cjs spells K3_WISE_PIPELINE_RUN_DISABLED as an inline
    // literal at its target-resolution gate, and this slice is not allowed to edit plugins/. A scoped
    // source scan is the only tripwire available — it still fails RED if the token is ever renamed
    // server-side without this table following, which is the property that matters.
    const runnerSource = readFileSync(path.join(pluginLib, 'pipeline-runner.cjs'), 'utf8')
    expect(
      runnerSource,
      'pipeline-runner.cjs no longer spells K3_WISE_PIPELINE_RUN_DISABLED — resync errorCodeLabels.ts',
    ).toContain("code: 'K3_WISE_PIPELINE_RUN_DISABLED'")
    expect(EXTERNAL_WRITE_FENCE_ERROR_CODES).toContain('K3_WISE_PIPELINE_RUN_DISABLED')
    // Same story for the replay refusal — also an inline literal, also in a PipelineRunnerError detail.
    expect(
      runnerSource,
      'pipeline-runner.cjs no longer spells K3_WISE_REPLAY_DISABLED — resync errorCodeLabels.ts',
    ).toContain("code: 'K3_WISE_REPLAY_DISABLED'")
    expect(EXTERNAL_WRITE_FENCE_ERROR_CODES).toContain('K3_WISE_REPLAY_DISABLED')
  })

  it('the fenced-kind badge is byte-identical to the server notice the same screen renders', () => {
    // The 对接总览 panel on the workbench renders writeCapability.notice straight from the server for these
    // kinds. Two different sentences for one fact on one screen is how a reader learns to distrust both.
    expect(K3_WRITE_FENCE_NOTICE.zh).toBe(SERVER_K3_FENCE_NOTICE.zh)
    expect(K3_WRITE_FENCE_NOTICE.en).toBe(SERVER_K3_FENCE_NOTICE.en)
  })

  // F01 — the code an operator needs is NOT at the top of the envelope for the whole
  // PipelineRunnerError family. `inferErrorCode` falls back to `error.name`, so /run refusals report the
  // CLASS there and carry the product code in details.code. Reading only the top level meant
  // K3_WISE_PIPELINE_RUN_DISABLED could never be looked up, and the label was dead weight.
  it('parseIntegrationResponse recovers the product code from details.code for the /run refusal shape', async () => {
    // The exact shape pinned server-side by
    // plugins/plugin-integration-core/__tests__/http-routes-plm-k3wise-poc.test.cjs.
    const response = envelopeResponse(422, {
      code: 'PipelineRunnerError',
      message: 'K3 WISE live writes are C6-only: use external-write dry-run + apply',
      details: { code: 'K3_WISE_PIPELINE_RUN_DISABLED', pipelineId: 'pipe_1' },
    })

    const error = await parseIntegrationResponse(response).then(
      () => { throw new Error('expected parseIntegrationResponse to reject') },
      (thrown: unknown) => thrown,
    )

    expect(integrationApiErrorCode(error)).toBe('K3_WISE_PIPELINE_RUN_DISABLED')
    // The message is still carried verbatim — this change adds a code, it does not rewrite text.
    expect((error as Error).message).toBe('K3 WISE live writes are C6-only: use external-write dry-run + apply')
    // …and that code is registered, so a call site renders人话 rather than the English prose above.
    expect(integrationErrorCodeDisplayLabel('K3_WISE_PIPELINE_RUN_DISABLED', 'zh-CN')).not.toBe('未知错误')
  })

  it('a real top-level product code still wins over a details.code', async () => {
    // HttpRouteError / ExternalWriteDryRunError DO carry their own `.code`; the details fallback must not
    // shadow them. The class-name test is case-sensitive, so SCREAMING_SNAKE codes are never mistaken for
    // a class (note UNKNOWN_ERROR ends in 'ERROR', not 'Error').
    const response = envelopeResponse(403, {
      code: 'K3_WISE_EXTERNAL_WRITE_DISABLED',
      message: 'K3 external write-back is permanently disabled',
      details: { code: 'SOMETHING_ELSE', targetKind: 'erp:k3-wise-webapi' },
    })

    const error = await parseIntegrationResponse(response).then(
      () => { throw new Error('expected parseIntegrationResponse to reject') },
      (thrown: unknown) => thrown,
    )
    expect(integrationApiErrorCode(error)).toBe('K3_WISE_EXTERNAL_WRITE_DISABLED')

    const unknownTop = envelopeResponse(500, {
      code: 'UNKNOWN_ERROR',
      message: 'boom',
      details: { code: 'NOT_THIS_ONE' },
    })
    const unknownError = await parseIntegrationResponse(unknownTop).then(
      () => { throw new Error('expected parseIntegrationResponse to reject') },
      (thrown: unknown) => thrown,
    )
    expect(integrationApiErrorCode(unknownError)).toBe('UNKNOWN_ERROR')
  })

  it('every fence code renders a humanized label plus a 只读 hint, never the unknown fallback', () => {
    for (const code of EXTERNAL_WRITE_FENCE_ERROR_CODES) {
      expectLabeled(code)
      const zhHint = integrationErrorCodeHint(code, 'zh-CN')
      expect(zhHint, `${code} must carry a zh hint`).toBeTruthy()
      // The one word an operator needs: this target is READ-ONLY, by design.
      expect(zhHint, `${code} hint must say 只读`).toContain('只读')
      expect(integrationErrorCodeHint(code, 'en'), `${code} must carry an en hint`).toBeTruthy()
      expect(integrationErrorCodeDisplayLabel(code, 'zh-CN')).not.toBe('未知错误')
      expect(integrationErrorCodeDisplayLabel(code, 'en')).not.toBe('Unknown error')
    }
  })

  it('the client fence-kind mirror equals the server fence subject set, exact-match only', () => {
    expect([...K3_EXTERNAL_WRITE_TARGET_KINDS]).toEqual([...SERVER_K3_FENCED_KINDS])
    for (const kind of SERVER_K3_FENCED_KINDS) {
      expect(isK3ExternalWriteTargetKind(kind), `${kind} must be fenced client-side`).toBe(true)
    }
    // Not a prefix/regex match: a K3-ADJACENT kind the server has not banned must stay unfenced, or the
    // mirror would be inventing policy of its own and hiding a button that should render.
    expect(isK3ExternalWriteTargetKind('erp:k3-wise-webapi-v2')).toBe(false)
    expect(isK3ExternalWriteTargetKind('erp:k3')).toBe(false)
    expect(isK3ExternalWriteTargetKind('metasheet:multitable')).toBe(false)
    expect(isK3ExternalWriteTargetKind('http')).toBe(false)
    expect(isK3ExternalWriteTargetKind('')).toBe(false)
    expect(isK3ExternalWriteTargetKind(null)).toBe(false)
    expect(isK3ExternalWriteTargetKind(undefined)).toBe(false)
  })
})

describe('errorCodeLabels coverage (mirror tripwire)', () => {
  it('every server resolver code (9) has a label', () => {
    expect(SERVER_RESOLVER_ERROR_CODES.length).toBe(9)
    for (const code of SERVER_RESOLVER_ERROR_CODES) expectLabeled(code)
  })

  it('every server probe code (union set) has a label', () => {
    // The server's READ_SOURCE_PROBE_ERROR_CODES spreads in BOTH the 9 resolver codes AND the 8
    // K3 WISE BOM-list-by-material codes (BL2) — union 28.
    expect(SERVER_PROBE_ERROR_CODES.length).toBe(28)
    for (const code of SERVER_PROBE_ERROR_CODES) expectLabeled(code)
  })

  it('client probe-code mirror covers the full server union (no client-side scrubbing of registered codes)', () => {
    // Mirror-drift tripwire (quality-gate finding on IU-1): the client allowlist in readSourceConfigs.ts
    // must contain EVERY server-registered probe/resolver/BOM-list code — otherwise a registered code
    // arriving in probe/composition evidence is scrubbed to the generic fallback BEFORE the label layer
    // sees it, and its label is dead code. A future server-side family addition fails here until the
    // client mirror (and its labels) are synced.
    for (const code of SERVER_PROBE_ERROR_CODES) {
      expect(CLIENT_PROBE_ERROR_CODES.has(code), `client mirror missing ${code}`).toBe(true)
    }
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

  // BA-UI-1 (docs/development/bridge-agent-admin-page-design-lock-20260707.md): the Bridge Agent
  // readonly adapter's own error-code vocabulary (distinct from an operator's Bridge Agent HTTP
  // response body, which may carry an arbitrary, unregistered `error.code`).
  it('every server Bridge Agent adapter code (4) has a label, and the local mirror matches the server set', () => {
    expect(SERVER_BRIDGE_AGENT_ERROR_CODES.length).toBe(4)
    expect(new Set(BRIDGE_AGENT_ERROR_CODES)).toEqual(new Set(SERVER_BRIDGE_AGENT_ERROR_CODES))
    for (const code of SERVER_BRIDGE_AGENT_ERROR_CODES) expectLabeled(code)
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
