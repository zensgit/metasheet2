import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// C-R4-3a: the composition runtime-tier service layer — list approved compositions + run an approved
// chain with the strict { inputs: { key } } contract, plus a values-free response normalizer.

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

import {
  listReadSourceCompositions,
  runReadSourceComposition,
  normalizeCompositionRunResult,
} from '../src/services/integration/readSourceCompositions'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } })
}
function errorResponse(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'Content-Type': 'application/json' } })
}

const SCOPE = { tenantId: 'default', workspaceId: null }

beforeEach(() => apiFetchMock.mockReset())
afterEach(() => vi.clearAllMocks())

describe('listReadSourceCompositions', () => {
  it('requests approved compositions and normalizes rows, dropping malformed ones', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse([
      { id: 'rscc_1', name: 'material-to-bom', version: 2, status: 'approved', contentKey: 'ck', updatedAt: '2026-07-05' },
      { id: '', name: 'bad' },       // no id → dropped
      { name: 'no-id' },             // no id → dropped
      { id: 'rscc_2', status: 'weird' }, // unknown status → coerced to draft
    ]))
    const rows = await listReadSourceCompositions(SCOPE, { status: 'approved' })
    expect(apiFetchMock).toHaveBeenCalledWith('/api/integration/read-source-compositions?tenantId=default&status=approved')
    expect(rows).toEqual([
      { id: 'rscc_1', name: 'material-to-bom', version: 2, status: 'approved', contentKey: 'ck', updatedAt: '2026-07-05' },
      { id: 'rscc_2', name: '', version: 0, status: 'draft', contentKey: '', updatedAt: null },
    ])
  })
})

describe('runReadSourceComposition', () => {
  it('POSTs ONLY { inputs: { key } } — never a config/plan/target/per-hop key', async () => {
    let sentBody: Record<string, unknown> | undefined
    apiFetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body || '{}'))
      return jsonResponse({
        evidence: { ok: true, failedStep: null, steps: [{ step: 0, ok: true, rule: 'exactly_one' }, { step: 1, ok: true, rule: 'first_when_sorted' }] },
        data: { resolver: { target: 'bom_number', value: 'BOM-2026-X' } },
      })
    })
    const result = await runReadSourceComposition('rscc_1', 'M-001', SCOPE)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/integration/read-source-compositions/rscc_1/run?tenantId=default', expect.objectContaining({ method: 'POST' }))
    expect(sentBody).toEqual({ inputs: { key: 'M-001' } })
    expect(Object.keys(sentBody as object)).toEqual(['inputs'])
    expect(Object.keys((sentBody as { inputs: object }).inputs)).toEqual(['key'])
    expect(result.evidence.ok).toBe(true)
    expect(result.data).toEqual({ resolver: { target: 'bom_number', value: 'BOM-2026-X' } })
  })

  it('surfaces a fail-closed run outcome (approved chain, hop aborted) values-free', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      evidence: {
        ok: false, failedStep: 0,
        steps: [{ step: 0, ok: false, rule: 'exactly_one', errorCode: 'READ_SOURCE_RESOLVER_AMBIGUOUS' }, { step: 1, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' }],
        errorCode: 'READ_SOURCE_COMPOSITION_STEP_FAILED',
      },
      data: null,
    }))
    const result = await runReadSourceComposition('rscc_1', 'M-001', SCOPE)
    expect(result.evidence.ok).toBe(false)
    expect(result.evidence.failedStep).toBe(0)
    expect(result.evidence.errorCode).toBe('READ_SOURCE_COMPOSITION_STEP_FAILED')
    expect(result.evidence.steps[1]).toEqual({ step: 1, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' })
    expect(result.data).toBeNull()
  })

  it('throws a coarse error on a 409 approved-only gate', async () => {
    apiFetchMock.mockResolvedValueOnce(errorResponse('READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED', 'not approved', 409))
    await expect(runReadSourceComposition('rscc_draft', 'M-001', SCOPE)).rejects.toThrow('READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED')
  })

  it('drops the raw server error.message from the thrown error — values-free by construction', async () => {
    // A (hypothetical) server bug echoing a business value into error.message must NEVER reach the client
    // error render. The thrown error carries only the clamped code (+ clamped reason), not the raw message.
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'READ_SOURCE_COMPOSITION_RUN_CONTRACT_INVALID', message: 'boom near MAT-001 SECRET', details: { reason: 'unexpected_field' } } }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      }),
    )
    const err = await runReadSourceComposition('rscc_1', 'M-001', SCOPE).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('READ_SOURCE_COMPOSITION_RUN_CONTRACT_INVALID: unexpected_field')
    // The raw server message (and any business value in it) never rides into the error the panel renders.
    expect(JSON.stringify({ message: (err as Error).message, ...(err as Record<string, unknown>) })).not.toContain('MAT-001 SECRET')
    expect((err as Error).message).not.toContain('boom')
  })

  it('coarsens a non-conforming server error code to a fixed fallback', async () => {
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'leaky code MAT-001', message: 'x' } }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
    )
    const err = await runReadSourceComposition('rscc_1', 'M-001', SCOPE).then(() => null, (e) => e)
    expect((err as Error).message).toBe('READ_SOURCE_COMPOSITION_REQUEST_FAILED')
    expect((err as Error).message).not.toContain('MAT-001')
  })

  it('clamps error.code to the EXACT registered set — a code-SHAPED business value coarsens to fallback', async () => {
    // A regex clamp (uppercase+underscore) would PASS this; the registered-set clamp coarsens it.
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'MAT_001_SECRET', message: 'x' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    )
    const err = await runReadSourceComposition('rscc_1', 'M-001', SCOPE).then(() => null, (e) => e)
    expect((err as Error).message).toBe('READ_SOURCE_COMPOSITION_REQUEST_FAILED')
    expect((err as Error).message).not.toContain('MAT_001_SECRET')
    // A genuinely registered code still passes through.
    apiFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED', message: 'x' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    )
    const ok = await runReadSourceComposition('rscc_1', 'M-001', SCOPE).then(() => null, (e) => e)
    expect((ok as Error).message).toBe('READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED')
  })
})

describe('normalizeCompositionRunResult (values-free allowlist)', () => {
  it('drops unknown fields and never widens the data plane', () => {
    const result = normalizeCompositionRunResult({
      evidence: {
        ok: true, failedStep: null,
        steps: [{ step: 0, ok: true, rule: 'exactly_one', host: 'SECRET_HOST', candidateValues: ['SECRET'] }],
        secretField: 'LEAK',
      },
      data: { resolver: { target: 'bom_number', value: 'BOM-OK', host: 'SECRET_HOST' }, rawRows: [{ x: 'SECRET' }] },
    })
    // step vector keeps ONLY the allowlisted keys.
    expect(result.evidence.steps).toEqual([{ step: 0, ok: true, rule: 'exactly_one' }])
    // chain data keeps ONLY target+value.
    expect(result.data).toEqual({ resolver: { target: 'bom_number', value: 'BOM-OK' } })
    const text = JSON.stringify(result)
    for (const leak of ['SECRET_HOST', 'candidateValues', 'secretField', 'rawRows']) {
      expect(text).not.toContain(leak)
    }
  })

  it('coarsens an unknown errorCode to nothing and rejects a non-scalar resolved value', () => {
    const unknownCode = normalizeCompositionRunResult({ evidence: { ok: false, failedStep: 1, steps: [], errorCode: 'MAT_001_SECRET' }, data: null })
    expect(unknownCode.evidence.errorCode).toBeUndefined() // unknown code not surfaced as a coarse enum
    // a non-scalar resolved value (object/boolean) is never placed into data even if evidence says ok.
    const nonScalar = normalizeCompositionRunResult({ evidence: { ok: true, failedStep: null, steps: [] }, data: { resolver: { target: 't', value: { leak: 'x' } } } })
    expect(nonScalar.data).toBeNull()
    const boolVal = normalizeCompositionRunResult({ evidence: { ok: true, failedStep: null, steps: [] }, data: { resolver: { target: 't', value: true } } })
    expect(boolVal.data).toBeNull()
  })

  it('exact-allowlists per-step errorCode against the composition ∪ probe/resolver union; drops unknown', () => {
    const result = normalizeCompositionRunResult({
      evidence: {
        ok: false, failedStep: 0,
        steps: [
          { step: 0, ok: false, rule: 'exactly_one', errorCode: 'MAT_001_SECRET' },       // unknown → dropped
          { step: 1, ok: false, errorCode: 'READ_SOURCE_RESOLVER_AMBIGUOUS' },             // resolver → kept
          { step: 2, ok: false, errorCode: 'READ_SOURCE_PROBE_TIMEOUT' },                  // probe → kept
          { step: 3, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' },       // composition → kept
        ],
      },
      data: null,
    })
    expect(result.evidence.steps[0]).toEqual({ step: 0, ok: false, rule: 'exactly_one' }) // errorCode dropped
    expect(result.evidence.steps[1].errorCode).toBe('READ_SOURCE_RESOLVER_AMBIGUOUS')
    expect(result.evidence.steps[2].errorCode).toBe('READ_SOURCE_PROBE_TIMEOUT')
    expect(result.evidence.steps[3].errorCode).toBe('READ_SOURCE_COMPOSITION_STEP_NOT_RUN')
    expect(JSON.stringify(result)).not.toContain('MAT_001_SECRET')
  })

  it('keeps values-free planErrors triples and drops malformed ones', () => {
    const result = normalizeCompositionRunResult({
      evidence: {
        ok: false, failedStep: null, steps: [], errorCode: 'READ_SOURCE_COMPOSITION_PLAN_INVALID',
        planErrors: [
          { code: 'READ_SOURCE_COMPOSITION_STEP_NOT_APPROVED', field: 'steps.1.readSourceConfigId', reason: 'approved_read_config_required' },
          { code: 'X', field: 'y' }, // missing reason → dropped
          { nope: true },            // malformed → dropped
        ],
      },
      data: null,
    })
    expect(result.evidence.planErrors).toEqual([
      { code: 'READ_SOURCE_COMPOSITION_STEP_NOT_APPROVED', field: 'steps.1.readSourceConfigId', reason: 'approved_read_config_required' },
    ])
  })

  it('bounded-clamps each planErrors field — a business value in code/field/reason drops the entry', () => {
    const result = normalizeCompositionRunResult({
      evidence: {
        ok: false, failedStep: null, steps: [], errorCode: 'READ_SOURCE_COMPOSITION_PLAN_INVALID',
        planErrors: [
          // reason carries a business value (uppercase/space) → whole entry dropped.
          { code: 'READ_SOURCE_COMPOSITION_STEP_NOT_APPROVED', field: 'steps.1.readSourceConfigId', reason: 'material MAT-001 SECRET' },
          // field carries a business value → dropped.
          { code: 'READ_SOURCE_COMPOSITION_STEP_MODE_INVALID', field: 'MAT-001 the material number', reason: 'resolver_lookup_required' },
          // code is a code-SHAPED business value (no READ_SOURCE_COMPOSITION_ prefix) → dropped.
          { code: 'MAT_001_SECRET', field: 'steps.0.readSourceConfigId', reason: 'approved_read_config_required' },
          // a well-formed validator triple survives.
          { code: 'READ_SOURCE_COMPOSITION_WRITE_CONFIG_REJECTED', field: 'steps.0.savePath', reason: 'write_shaped_key' },
        ],
      },
      data: null,
    })
    expect(result.evidence.planErrors).toEqual([
      { code: 'READ_SOURCE_COMPOSITION_WRITE_CONFIG_REJECTED', field: 'steps.0.savePath', reason: 'write_shaped_key' },
    ])
    const text = JSON.stringify(result)
    for (const leak of ['MAT-001 SECRET', 'MAT-001 the material number', 'MAT_001_SECRET']) {
      expect(text).not.toContain(leak)
    }
  })
})
