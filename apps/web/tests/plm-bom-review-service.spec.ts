import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: (...args: unknown[]) => apiFetchMock(...args),
}))

import { getPlmBomMultitableContext } from '../src/services/integration/workbench'

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
})
