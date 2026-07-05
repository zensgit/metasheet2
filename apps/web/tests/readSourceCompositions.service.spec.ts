import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// C-R4-3a: the composition runtime-tier service layer — list approved compositions + run an approved
// chain with the strict { inputs: { key } } contract, plus a values-free response normalizer.

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))

import {
  listReadSourceCompositions,
  runReadSourceComposition,
  normalizeCompositionRunResult,
  buildReadSourceCompositionPayload,
  validateReadSourceCompositionDraft,
  saveReadSourceCompositionVersion,
  approveReadSourceComposition,
  retireReadSourceComposition,
  listReadSourceCompositionAudit,
  ReadSourceCompositionApiError,
  type ReadSourceCompositionDraft,
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

// --- authoring-tier service layer (save / approve / retire / audit) --------

const VALID_DRAFT: ReadSourceCompositionDraft = {
  name: 'material-to-bom',
  step1ConfigId: 'rsc_material_lookup',
  step2ConfigId: 'rsc_bom_lookup',
  sourceTarget: 'itemId',
}

describe('buildReadSourceCompositionPayload', () => {
  it('pins version/operations/toInput/step ids — a smuggled extra draft field never reaches the payload', () => {
    const hostileDraft = {
      ...VALID_DRAFT,
      // Fields a hostile/careless caller might attach to the draft object; the builder only ever
      // reads the four named draft properties, so none of these can ride into the payload.
      operations: ['write'],
      version: 99,
      steps: [{ id: 'evil' }],
      toInput: 'body',
    } as unknown as ReadSourceCompositionDraft
    const payload = buildReadSourceCompositionPayload(hostileDraft)
    expect(payload).toEqual({
      version: 1,
      name: 'material-to-bom',
      operations: ['read'],
      steps: [
        { id: 'step-1', readSourceConfigId: 'rsc_material_lookup' },
        {
          id: 'step-2',
          readSourceConfigId: 'rsc_bom_lookup',
          input: { fromStep: 'step-1', sourceTarget: 'itemId', toInput: 'key' },
        },
      ],
    })
  })

  it('trims whitespace-padded draft fields', () => {
    const payload = buildReadSourceCompositionPayload({
      name: '  material-to-bom  ',
      step1ConfigId: '  rsc_a  ',
      step2ConfigId: '  rsc_b  ',
      sourceTarget: '  itemId  ',
    })
    expect(payload.name).toBe('material-to-bom')
    expect(payload.steps[0].readSourceConfigId).toBe('rsc_a')
    expect(payload.steps[1].readSourceConfigId).toBe('rsc_b')
    expect(payload.steps[1].input.sourceTarget).toBe('itemId')
  })
})

describe('validateReadSourceCompositionDraft', () => {
  it('passes a well-formed draft with zero problems', () => {
    expect(validateReadSourceCompositionDraft(VALID_DRAFT)).toEqual([])
  })

  it('catches a bad name without echoing the raw value in any message', () => {
    const problems = validateReadSourceCompositionDraft({ ...VALID_DRAFT, name: 'has spaces MAT-001 SECRET' })
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join(' ')).not.toContain('MAT-001 SECRET')
  })

  it('catches duplicate step config ids', () => {
    const problems = validateReadSourceCompositionDraft({ ...VALID_DRAFT, step2ConfigId: VALID_DRAFT.step1ConfigId })
    expect(problems).toContain('step1ConfigId 与 step2ConfigId 不能相同')
  })

  it('catches a secret-shaped overlong value in step/target fields WITHOUT echoing it in any message', () => {
    const secret = `sk-${'A'.repeat(200)}`
    const problems = validateReadSourceCompositionDraft({ ...VALID_DRAFT, step1ConfigId: secret, sourceTarget: secret })
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join(' ')).not.toContain(secret)
  })
})

describe('saveReadSourceCompositionVersion', () => {
  it('POSTs exactly { config } (the pinned payload) and reports reused:false on a 201 mint', async () => {
    let sentBody: Record<string, unknown> | undefined
    apiFetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body || '{}'))
      return jsonResponse(
        { id: 'rscc_1', name: 'material-to-bom', version: 1, status: 'draft', contentKey: 'ck1', updatedAt: '2026-07-05', reused: false },
        201,
      )
    })
    const result = await saveReadSourceCompositionVersion(VALID_DRAFT, SCOPE)
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/integration/read-source-compositions?tenantId=default',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(Object.keys(sentBody as object)).toEqual(['config'])
    expect((sentBody as { config: unknown }).config).toEqual(buildReadSourceCompositionPayload(VALID_DRAFT))
    expect(result).toEqual({
      id: 'rscc_1', name: 'material-to-bom', version: 1, status: 'draft', contentKey: 'ck1', updatedAt: '2026-07-05', reused: false,
    })
  })

  it('reports reused:true on a 200 content-key hit', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(
      { id: 'rscc_1', name: 'material-to-bom', version: 1, status: 'draft', contentKey: 'ck1', updatedAt: '2026-07-05', reused: true },
      200,
    ))
    const result = await saveReadSourceCompositionVersion(VALID_DRAFT, SCOPE)
    expect(result.reused).toBe(true)
  })

  it('surfaces a 400 CONFIG_INVALID with CLAMPED fieldErrors — a well-formed triple is kept, a triple carrying a business-shaped value in field/reason/code is dropped whole', async () => {
    apiFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: 'READ_SOURCE_COMPOSITION_CONFIG_INVALID',
        message: 'composition config is invalid',
        details: {
          errors: [
            { code: 'READ_SOURCE_COMPOSITION_NAME_INVALID', field: 'name', reason: 'invalid_identifier' },
            // business-value field (space + business token) → dropped whole
            { code: 'READ_SOURCE_COMPOSITION_STEP_REF_INVALID', field: 'MAT-001 the material number', reason: 'invalid_reference' },
            // business-value reason (space + business token) → dropped whole
            { code: 'READ_SOURCE_COMPOSITION_STEP_INVALID', field: 'steps.0.id', reason: 'material MAT-001 SECRET' },
            // code-SHAPED business value without the required prefix → dropped whole
            { code: 'MAT_001_SECRET', field: 'steps.0.readSourceConfigId', reason: 'invalid_reference' },
          ],
        },
      },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
    const err = await saveReadSourceCompositionVersion(VALID_DRAFT, SCOPE).then(() => null, (e) => e)
    expect(err).toBeInstanceOf(ReadSourceCompositionApiError)
    const apiError = err as ReadSourceCompositionApiError
    expect(apiError.code).toBe('READ_SOURCE_COMPOSITION_CONFIG_INVALID')
    expect(apiError.fieldErrors).toEqual([
      { code: 'READ_SOURCE_COMPOSITION_NAME_INVALID', field: 'name', reason: 'invalid_identifier' },
    ])
    const text = JSON.stringify({ message: apiError.message, ...apiError })
    for (const leak of ['MAT-001 the material number', 'MAT-001 SECRET', 'MAT_001_SECRET']) {
      expect(text).not.toContain(leak)
    }
  })
})

describe('approveReadSourceComposition / retireReadSourceComposition', () => {
  it('POST to the approve/retire URLs and return the normalized row', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(
      { id: 'rscc_1', name: 'material-to-bom', version: 1, status: 'approved', contentKey: 'ck1', updatedAt: '2026-07-05' },
    ))
    const approved = await approveReadSourceComposition('rscc_1', SCOPE)
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/integration/read-source-compositions/rscc_1/approve?tenantId=default',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(approved?.status).toBe('approved')

    apiFetchMock.mockResolvedValueOnce(jsonResponse(
      { id: 'rscc_1', name: 'material-to-bom', version: 1, status: 'retired', contentKey: 'ck1', updatedAt: '2026-07-05' },
    ))
    const retired = await retireReadSourceComposition('rscc_1', SCOPE)
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/integration/read-source-compositions/rscc_1/retire?tenantId=default',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(retired?.status).toBe('retired')
  })

  it('throw with a clamped code only on a 409 NOT_APPROVED / STATUS_CONFLICT — the raw message never rides along', async () => {
    apiFetchMock.mockResolvedValueOnce(errorResponse('READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED', 'not approved yet MAT-001 SECRET', 409))
    const err1 = await approveReadSourceComposition('rscc_draft', SCOPE).then(() => null, (e) => e)
    expect((err1 as Error).message).toBe('READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED')
    expect((err1 as Error).message).not.toContain('MAT-001 SECRET')

    apiFetchMock.mockResolvedValueOnce(errorResponse('READ_SOURCE_COMPOSITION_CONFIG_STATUS_CONFLICT', 'status conflict MAT-001 SECRET', 409))
    const err2 = await retireReadSourceComposition('rscc_1', SCOPE).then(() => null, (e) => e)
    expect((err2 as Error).message).toBe('READ_SOURCE_COMPOSITION_CONFIG_STATUS_CONFLICT')
    expect((err2 as Error).message).not.toContain('MAT-001 SECRET')
  })
})

describe('listReadSourceCompositionAudit', () => {
  it('keeps only coarse fields; clamps detail to {from,to}; drops a smuggled value-bearing detail field and an unknown action', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse([
      {
        action: 'status_change', actor: 'user-1',
        detail: { from: 'draft', to: 'approved', secretNote: 'MAT-001 SECRET' },
        createdAt: '2026-07-05T00:00:00Z',
      },
      {
        // save_version rows carry a `version` number in real detail — must be dropped, never surfaced.
        action: 'save_version', actor: null,
        detail: { version: 3, secretNote: 'LEAK' },
        createdAt: '2026-07-04T00:00:00Z',
      },
      { action: 'weird_action', actor: 'x', detail: {}, createdAt: '2026-07-03T00:00:00Z' }, // unknown action → dropped
    ]))
    const rows = await listReadSourceCompositionAudit('rscc_1', SCOPE)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/integration/read-source-compositions/rscc_1/audit?tenantId=default')
    expect(rows).toEqual([
      { action: 'status_change', actor: 'user-1', detail: { from: 'draft', to: 'approved' }, createdAt: '2026-07-05T00:00:00Z' },
      { action: 'save_version', actor: null, detail: {}, createdAt: '2026-07-04T00:00:00Z' },
    ])
    const text = JSON.stringify(rows)
    for (const leak of ['MAT-001 SECRET', 'LEAK', 'weird_action']) {
      expect(text).not.toContain(leak)
    }
  })
})
