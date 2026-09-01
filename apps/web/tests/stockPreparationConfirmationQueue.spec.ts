import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `confirmationQueue.ts` is the client for the ONLY tab a floor stock-prep operator can see
 * (O1' ruling — docs/development/takeover-beiliao-20260821/o1-ruling-20260829.md §附). It had ZERO
 * spec coverage before this file. That absence is what let the three read routes ship building their
 * request URL as `${path}${query}` — `buildQueryString` (workbench.ts) returns a BARE
 * `a=1&b=2` querystring with no leading `?`, and `apiFetch` (utils/api.ts) does no normalization
 * (`fetch(\`${base}${path}\`)`), so a non-empty query merged straight into the path with no separator,
 * e.g. `/api/.../confirmation-decisionsprojectNo=230920006` — a guaranteed 404. `projectNo` is
 * REQUIRED on the list call and `decisionId` is required on the value-entry call, so those two were
 * ALWAYS broken; the readiness call broke only when tenantId/workspaceId were set.
 *
 * Modeled on approval-comments-client.spec.ts's approach: mock `../src/utils/api`'s `apiFetch`
 * directly and assert on the URL string it was called with.
 */
const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  listStockPreparationDecisions,
  readStockPreparationDecisionReadiness,
  readStockPreparationValueEntry,
} from '../src/services/integration/stockPreparation/confirmationQueue'

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('confirmationQueue request URLs (O1 — the query string must be separated from the path by "?")', () => {
  it('listStockPreparationDecisions: a projectNo (ALWAYS present — required on this call) is joined with "?", not concatenated bare onto the path', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: { rowCount: 0, byStatus: {}, byResolutionAction: {}, parkedCount: 0, rows: [] },
    }))

    await listStockPreparationDecisions({ projectNo: '230920006' })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const url = apiFetchMock.mock.calls[0]?.[0] as string
    expect(url).toBe('/api/integration/stock-preparation/confirmation-decisions?projectNo=230920006')
    expect(url).toContain('?projectNo=')
    // The historical bug's exact shape — never regress to this.
    expect(url).not.toBe('/api/integration/stock-preparation/confirmation-decisionsprojectNo=230920006')
  })

  it('readStockPreparationValueEntry: a decisionId (ALWAYS present — required on this call) is joined with "?", not concatenated bare onto the path', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: {
        decisionId: 'stockprep_confirm_decision_0123456789abcdef',
        conflictType: null,
        status: null,
        resolutionAction: null,
        inputFingerprint: null,
        valueEntry: { resolvedValue: null, resolvedAuxValue: null, notes: null },
      },
    }))

    await readStockPreparationValueEntry({ decisionId: 'stockprep_confirm_decision_0123456789abcdef' })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const url = apiFetchMock.mock.calls[0]?.[0] as string
    expect(url).toBe('/api/integration/stock-preparation/confirmation-decisions/value-entry?decisionId=stockprep_confirm_decision_0123456789abcdef')
    expect(url).toContain('?decisionId=')
  })

  it('readStockPreparationDecisionReadiness: a set tenantId/workspaceId is joined with "?", not concatenated bare onto the path', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { ready: true } }))

    await readStockPreparationDecisionReadiness({ tenantId: 'default', workspaceId: 'ws_1' })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const url = apiFetchMock.mock.calls[0]?.[0] as string
    expect(url).toBe('/api/integration/stock-preparation/confirmation-decisions/readiness?tenantId=default&workspaceId=ws_1')
    expect(url).toContain('?tenantId=')
  })

  it('readStockPreparationDecisionReadiness: an all-empty scope produces a path with NO trailing "?" (the fix must not overcorrect into a dangling "?")', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: { ready: true } }))

    await readStockPreparationDecisionReadiness({})

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const url = apiFetchMock.mock.calls[0]?.[0] as string
    expect(url).toBe('/api/integration/stock-preparation/confirmation-decisions/readiness')
    expect(url.endsWith('?')).toBe(false)
  })
})
