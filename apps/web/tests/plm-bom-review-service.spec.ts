import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  getPlmBomMultitableContext,
  updatePlmBomMultitableLine,
} from '../src/services/integration/workbench'

// The relay returns a BARE object (NOT the {ok,data} integration envelope).
function rawJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const CONTEXT = {
  part: { part_id: 'P1', item_number: 'P-001', name: 'Assembly', state: 'Released', generation: 3 },
  lines: [
    { bom_line_id: 'R1', part_id: 'C1', item_number: 'C-001', name: 'Bracket', state: 'Draft', generation: 1, quantity: 2, uom: 'EA', find_num: '10', refdes: 'R1,R2', level: 1, path: ['P1'], path_labels: ['P-001'], source_version: 1, source_updated_at: '2026-06-05T00:00:00', sync_status: 'snapshot' },
  ],
  source_version: 3,
  source_updated_at: '2026-06-05T00:00:00',
  sync_status: 'snapshot',
  template_key: 'bom_review',
}

describe('getPlmBomMultitableContext (P3-C consumer service)', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('does not fetch when dataSourceId or partId is empty', async () => {
    const r = await getPlmBomMultitableContext('ds-1', '   ')
    expect(r).toEqual({ data_source_id: 'ds-1', available: false, reason: 'unavailable' })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('reads the BARE relay object on entitled success (not parseIntegrationResponse)', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ data_source_id: 'ds-1', available: true, entitled: true, context: CONTEXT }))
    const r = await getPlmBomMultitableContext('ds-1', 'P1')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/context')
    expect(r).toEqual({ data_source_id: 'ds-1', available: true, entitled: true, context: CONTEXT })
  })

  it('unentitled relay -> entitled:false + null context', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ data_source_id: 'ds-1', available: true, entitled: false, context: null }))
    const r = await getPlmBomMultitableContext('ds-1', 'P1')
    expect(r).toEqual({ data_source_id: 'ds-1', available: true, entitled: false, context: null })
  })

  it('unsupported/unavailable relay -> available:false with the reason', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ data_source_id: 'ds-1', available: false, reason: 'unsupported' }))
    const r = await getPlmBomMultitableContext('ds-1', 'P1')
    expect(r).toEqual({ data_source_id: 'ds-1', available: false, reason: 'unsupported' })
  })

  it('non-ok HTTP -> degrades to unavailable', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({}, 500))
    const r = await getPlmBomMultitableContext('ds-1', 'P1')
    expect(r).toEqual({ data_source_id: 'ds-1', available: false, reason: 'unavailable' })
  })

  it('entitled but malformed context (not part+lines) -> nulls the context', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ data_source_id: 'ds-1', available: true, entitled: true, context: { bogus: 1 } }))
    const r = await getPlmBomMultitableContext('ds-1', 'P1')
    expect(r).toEqual({ data_source_id: 'ds-1', available: true, entitled: true, context: null })
  })

  it('carries a relayed reason on an entitled + null-context result (transient failure)', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ data_source_id: 'ds-1', available: true, entitled: true, context: null, reason: 'unavailable' }))
    const r = await getPlmBomMultitableContext('ds-1', 'P1')
    expect(r).toEqual({ data_source_id: 'ds-1', available: true, entitled: true, context: null, reason: 'unavailable' })
  })
})

describe('updatePlmBomMultitableLine (Phase 7 consumer write-back service)', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('sends the caller-owned Idempotency-Key and whitelisted patch body', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ ok: true, bom_line_id: 'R1' }))
    const r = await updatePlmBomMultitableLine(
      'ds-1',
      'P1',
      'R1',
      { quantity: 6, refdes: null },
      'submit-1',
    )
    expect(r).toEqual({ ok: true, bom_line_id: 'R1' })
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/lines/R1',
      {
        method: 'PATCH',
        headers: { 'Idempotency-Key': 'submit-1' },
        body: JSON.stringify({ quantity: 6, refdes: null }),
        suppressUnauthorizedRedirect: true,
      },
    )
  })

  it('returns a fixed message for provider errors and does not echo the body', async () => {
    apiFetchMock.mockResolvedValue(rawJsonResponse({ error: 'locked', reason: 'provider-rejected' }, 409))
    const r = await updatePlmBomMultitableLine(
      'ds-1',
      'P1',
      'R1',
      { quantity: 6 },
      'submit-1',
    )
    expect(r).toEqual({
      ok: false,
      status: 409,
      reason: 'provider-rejected',
      message: 'BOM 写入失败，详情见服务端日志',
    })
    expect(JSON.stringify(r)).not.toContain('locked')
  })

  it('passes native 403 uncertainty through and does not invent it when the body omits it', async () => {
    apiFetchMock.mockResolvedValueOnce(rawJsonResponse({
      error: 'BOM 写入失败，详情见服务端日志',
      code: 'PLM_BOM_WRITEBACK_FAILED',
      reason: 'provider-rejected',
      attempt_outcome: 'refused',
      operation_may_have_applied: true,
      retry_policy: 'same-operation',
    }, 403))
    apiFetchMock.mockResolvedValueOnce(rawJsonResponse({
      error: 'secret-body',
      code: 'PLM_BOM_WRITE_FORBIDDEN',
      reason: 'PLM_BOM_WRITE_FORBIDDEN',
    }, 403))
    const native = await updatePlmBomMultitableLine('ds-1', 'P1', 'R1', { quantity: 6 }, 'submit-1')
    const local = await updatePlmBomMultitableLine('ds-1', 'P1', 'R1', { quantity: 6 }, 'submit-1')
    expect(native).toEqual({
      ok: false,
      status: 403,
      reason: 'provider-rejected',
      message: 'BOM 写入失败，详情见服务端日志',
      attemptOutcome: 'refused',
      operationMayHaveApplied: true,
      retryPolicy: 'same-operation',
    })
    expect(local).toEqual({
      ok: false,
      status: 403,
      reason: 'PLM_BOM_WRITE_FORBIDDEN',
      message: 'BOM 写入失败，详情见服务端日志',
    })
    expect(JSON.stringify(local)).not.toContain('secret-body')
    expect(local).not.toHaveProperty('operationMayHaveApplied')
  })

  it('refuses incomplete requests before fetching', async () => {
    const r = await updatePlmBomMultitableLine('ds-1', 'P1', 'R1', {}, 'submit-1')
    expect(r.ok).toBe(false)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})

describe('requestPlmBomEcoRevisionIntent (ECO Phase 3 consumer service)', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('does not fetch when dataSourceId, partId, or the idempotency key is empty', async () => {
    const { requestPlmBomEcoRevisionIntent } = await import('../src/services/integration/workbench')
    const missingPart = await requestPlmBomEcoRevisionIntent('ds-1', '  ', 'submit-1')
    const missingKey = await requestPlmBomEcoRevisionIntent('ds-1', 'P1', '   ')
    expect(missingPart).toEqual({ ok: false, status: 400, reason: 'invalid-request', message: 'ECO revision request is incomplete' })
    expect(missingKey).toEqual(missingPart)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('POSTs the intent relay with the caller Idempotency-Key and no body', async () => {
    const { requestPlmBomEcoRevisionIntent } = await import('../src/services/integration/workbench')
    apiFetchMock.mockResolvedValue(rawJsonResponse({ eco_id: 'ECO-1', state: 'progress', attached: false }))
    const r = await requestPlmBomEcoRevisionIntent('ds-1', 'P1', 'submit-1')
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/plm-workbench/data-sources/ds-1/bom-multitable/P1/eco-intent',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'submit-1' },
        suppressUnauthorizedRedirect: true,
      },
    )
    expect(r).toEqual({ ok: true, eco_id: 'ECO-1', state: 'progress', attached: false })
  })

  it('relays the attach outcome (attached: true)', async () => {
    const { requestPlmBomEcoRevisionIntent } = await import('../src/services/integration/workbench')
    apiFetchMock.mockResolvedValue(rawJsonResponse({ eco_id: 'ECO-OLD', state: 'draft', attached: true }))
    const r = await requestPlmBomEcoRevisionIntent('ds-1', 'P1', 'submit-1')
    expect(r).toEqual({ ok: true, eco_id: 'ECO-OLD', state: 'draft', attached: true })
  })

  it('surfaces the relayed reason on a non-ok status (not_locked) without echoing the body', async () => {
    const { requestPlmBomEcoRevisionIntent } = await import('../src/services/integration/workbench')
    apiFetchMock.mockResolvedValue(rawJsonResponse({ error: 'conflict', reason: 'not_locked' }, 409))
    const r = await requestPlmBomEcoRevisionIntent('ds-1', 'P1', 'submit-1')
    expect(r).toEqual({
      ok: false,
      status: 409,
      reason: 'not_locked',
      message: 'ECO 意图请求失败，详情见服务端日志',
    })
    expect(JSON.stringify(r)).not.toContain('conflict')
  })

  it('keeps native 403 uncertainty and does not treat a local 403 as may-have-applied', async () => {
    const { requestPlmBomEcoRevisionIntent } = await import('../src/services/integration/workbench')
    apiFetchMock.mockResolvedValueOnce(rawJsonResponse({
      error: 'hidden',
      reason: 'provider-rejected',
      attempt_outcome: 'refused',
      operation_may_have_applied: true,
      retry_policy: 'same-operation',
    }, 403))
    const native = await requestPlmBomEcoRevisionIntent('ds-1', 'P1', 'submit-1')
    expect(native).toMatchObject({
      ok: false,
      status: 403,
      reason: 'provider-rejected',
      attemptOutcome: 'refused',
      operationMayHaveApplied: true,
      retryPolicy: 'same-operation',
    })
    expect(JSON.stringify(native)).not.toContain('hidden')
  })

  it('falls back to intent-failed when the error body carries no reason', async () => {
    const { requestPlmBomEcoRevisionIntent } = await import('../src/services/integration/workbench')
    apiFetchMock.mockResolvedValue(new Response('oops', { status: 503 }))
    const r = await requestPlmBomEcoRevisionIntent('ds-1', 'P1', 'submit-1')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(503)
      expect(r.reason).toBe('intent-failed')
    }
  })

  it('502 malformed-response when a 200 body lacks the contract keys', async () => {
    const { requestPlmBomEcoRevisionIntent } = await import('../src/services/integration/workbench')
    apiFetchMock.mockResolvedValue(rawJsonResponse({ eco_id: 'ECO-1' }))
    const r = await requestPlmBomEcoRevisionIntent('ds-1', 'P1', 'submit-1')
    expect(r).toEqual({
      ok: false, status: 502, reason: 'malformed-response',
      message: 'ECO revision intent returned a malformed response',
    })
  })
})
