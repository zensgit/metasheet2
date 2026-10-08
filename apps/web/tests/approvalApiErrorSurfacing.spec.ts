import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it , vi} from 'vitest'
import {
  APPROVAL_EXPORT_DEFAULT_FILE_NAME,
  APPROVAL_EXPORT_UNEXPECTED_RESPONSE,
  ApprovalApiError,
  approvalRequestError,
  exportApprovalsCsv,
  normalizeApprovalHistoryEnvelope,
} from '../src/approvals/api'
import { collectHistoryAttachmentRefIds } from '../src/approvals/attachmentRefs'
import { useLocale } from '../src/composables/useLocale'

/**
 * B1-04 (宽恕型错误三件套) — unit coverage for the error-surfacing helper that
 * `createApproval` and `dispatchAction` (apps/web/src/approvals/api.ts) funnel their failed
 * (non-OK) responses through, generalizing the ad hoc `payload.error.code/message` parsing
 * `remindApproval` already did for its own failure branches.
 *
 * This exercises `approvalRequestError` directly against a fabricated `Response`, rather than
 * via `createApproval`/`dispatchAction` themselves: `approvals/api.ts`'s `USE_MOCK` flag is
 * `import.meta.env.DEV || ...`, and `DEV` is always `true` under Vitest, so those exported
 * functions always take their mock branch here and never reach the real fetch path. The helper
 * itself has no such gate, so it is independently testable.
 */
function fakeResponse(status: number, jsonImpl: () => Promise<unknown>): Response {
  return { status, json: jsonImpl } as unknown as Response
}

describe('approvalRequestError', () => {
  // O-8 / F8-1: the status-coded fallback follows the shell locale; these cases pin its zh-CN
  // spelling (the English one is covered at the end of this describe).
  beforeEach(() => {
    useLocale().setLocale('zh-CN')
  })

  it('surfaces the server error message + code verbatim', async () => {
    const response = fakeResponse(400, async () => ({
      error: { code: 'AMOUNT_MISMATCH', message: '金额合计不一致' },
    }))

    let caught: unknown
    try {
      await approvalRequestError(response)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ApprovalApiError)
    const error = caught as ApprovalApiError
    expect(error.message).toBe('金额合计不一致')
    expect(error.code).toBe('AMOUNT_MISMATCH')
    expect(error.status).toBe(400)
  })

  it('falls back to a status-coded message for a non-JSON body', async () => {
    const response = fakeResponse(500, async () => {
      throw new Error('Unexpected token < in JSON')
    })

    let caught: unknown
    try {
      await approvalRequestError(response)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ApprovalApiError)
    const error = caught as ApprovalApiError
    expect(error.message).toBe('请求失败（500）')
    expect(error.code).toBeUndefined()
    expect(error.status).toBe(500)
  })

  it('falls back to a status-coded message when the JSON body has no `error.message`', async () => {
    const response = fakeResponse(403, async () => ({ ok: false }))

    let caught: unknown
    try {
      await approvalRequestError(response)
    } catch (err) {
      caught = err
    }

    expect((caught as ApprovalApiError).message).toBe('请求失败（403）')
    expect((caught as ApprovalApiError).code).toBeUndefined()
  })

  it('ignores a blank server message and falls back to the status-coded message', async () => {
    const response = fakeResponse(422, async () => ({ error: { code: 'X', message: '   ' } }))

    let caught: unknown
    try {
      await approvalRequestError(response)
    } catch (err) {
      caught = err
    }

    const error = caught as ApprovalApiError
    expect(error.message).toBe('请求失败（422）')
    expect(error.code).toBe('X')
  })

  it('in English the status-coded fallback is English, while a server message stays verbatim', async () => {
    useLocale().setLocale('en')
    let caught: unknown
    try {
      await approvalRequestError(fakeResponse(500, async () => ({ ok: false })))
    } catch (err) {
      caught = err
    }
    expect((caught as ApprovalApiError).message).toBe('Request failed (500)')

    caught = undefined
    try {
      await approvalRequestError(fakeResponse(400, async () => ({ error: { code: 'X', message: 'server text' } })))
    } catch (err) {
      caught = err
    }
    expect((caught as ApprovalApiError).message).toBe('server text')
  })
})

/**
 * Lock-9 FE fix round (2026-08-22, gate P1-2) — `getApprovalHistory` itself is behind the same
 * `USE_MOCK` gate `approvalRequestError` above is documented as unable to bypass under Vitest
 * (`DEV` is always `true`), so this exercises the extracted pure normalizer directly rather than
 * fighting the module-level const with `vi.stubEnv`/`vi.resetModules`. The payload below is the
 * VERBATIM body captured from a real `MetaSheetServer` + live Postgres read in the independent
 * gate (`GET /api/approvals/:id/history`, platform branch, one seeded `comment` row) — not a
 * fabricated fixture.
 */
describe('normalizeApprovalHistoryEnvelope (Lock-9 fix round, gate P1-2)', () => {
  const REAL_WIRE_ENVELOPE = {
    ok: true,
    data: {
      items: [
        {
          id: '1052',
          occurred_at: '2026-08-22T06:04:24.994Z',
          actor_id: 'probe-req-1787378664639',
          actor_name: 'Requester',
          action: 'comment',
          comment: 'hello',
          from_status: null,
          to_status: 'approved',
          version: 1,
          from_version: null,
          to_version: 1,
        },
      ],
      page: 1,
      pageSize: 50,
      total: 1,
    },
  }

  it('unwraps the real {ok, data:{items}} envelope to the items array', () => {
    const result = normalizeApprovalHistoryEnvelope(REAL_WIRE_ENVELOPE)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect((result[0] as unknown as { id: string }).id).toBe('1052')
  })

  it('passes an already-array payload through unchanged (mock branch / defensive future-proofing)', () => {
    const arr = [{ id: 'h1' }]
    expect(normalizeApprovalHistoryEnvelope(arr)).toBe(arr)
  })

  it('fails closed to [] for a malformed/absent envelope rather than throwing', () => {
    expect(normalizeApprovalHistoryEnvelope(null)).toEqual([])
    expect(normalizeApprovalHistoryEnvelope(undefined)).toEqual([])
    expect(normalizeApprovalHistoryEnvelope({ ok: true })).toEqual([])
    expect(normalizeApprovalHistoryEnvelope({ ok: true, data: {} })).toEqual([])
    expect(normalizeApprovalHistoryEnvelope({ ok: true, data: { items: 'not-an-array' } })).toEqual([])
  })

  it('end-to-end: the real wire envelope, normalized, no longer throws through collectHistoryAttachmentRefIds', () => {
    // This IS the P1-2 chain: attachmentRefs.ts:145 `for (const item of history ?? [])` used to
    // receive the raw envelope object and throw `TypeError: ... is not iterable`. Feeding it
    // through the normalizer first (as `getApprovalHistory` now does) makes that structurally
    // impossible regardless of what the server returns.
    const history = normalizeApprovalHistoryEnvelope(REAL_WIRE_ENVELOPE)
    expect(() => collectHistoryAttachmentRefIds(history as never)).not.toThrow()
    // The platform branch's row has no `metadata` column at all (gate P1-1, disclosed in the PR
    // body) — correctly resolves to no ids, not a crash and not a fabricated one.
    expect(collectHistoryAttachmentRefIds(history as never)).toEqual([])
  })

  it('getApprovalHistory itself unwraps the real envelope (pins the CALL SITE, not just the helper)', async () => {
    // Requal P2 (2026-08-22): reverting getApprovalHistory to its pre-fix body while leaving the
    // normalizer intact left the ENTIRE required lane green — the five tests above exercise the
    // function, nothing exercised the wiring. This test pins the call site: it must red if the
    // route function stops routing through the normalizer.
    vi.resetModules()
    vi.stubEnv('DEV', false)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => REAL_WIRE_ENVELOPE,
      clone() { return this },
    }))
    try {
      const { getApprovalHistory } = await import('../src/approvals/api')
      await expect(getApprovalHistory('apv_1')).resolves.toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  it('end-to-end: a PLM-shaped row (metadata present) still resolves its staged process-attachment ids', () => {
    const plmShapedHistory = normalizeApprovalHistoryEnvelope({
      ok: true,
      data: {
        items: [{ id: 'h1', metadata: { attachmentIds: ['att_probe_1'] } }],
        page: 1,
        pageSize: 50,
        total: 1,
      },
    })
    expect(collectHistoryAttachmentRefIds(plmShapedHistory as never)).toEqual(['att_probe_1'])
  })
})

/**
 * F3-E1 (审批中心「导出 CSV」按钮) — the client half of `GET /api/approvals?format=csv`.
 *
 * `exportApprovalsCsv` has NO `USE_MOCK` branch (see its docblock), so unlike the functions the
 * header of this file describes it always takes the real `apiFetch` path under Vitest and a plain
 * `vi.stubGlobal('fetch', …)` is not vacuous here. The one case that also drives `listApprovals`
 * (which IS gated) uses the same `resetModules` + `stubEnv('DEV', false)` escape the
 * `getApprovalHistory` call-site test above already uses.
 */
describe('exportApprovalsCsv (F3-E1)', () => {
  const CSV_BODY = '\uFEFFid,title\r\napv_1,采购申请\r\n'

  function csvResponse(headers: Record<string, string>, blob: Blob = new Blob([CSV_BODY])): {
    response: Response
    blob: Blob
    blobSpy: ReturnType<typeof vi.fn>
  } {
    const blobSpy = vi.fn().mockResolvedValue(blob)
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(headers),
      blob: blobSpy,
      json: async () => { throw new Error('not json') },
      clone() { return this },
    } as unknown as Response
    return { response, blob, blobSpy }
  }

  const FULL_HEADERS = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="approvals-export.csv"',
    'X-Approval-Export-Row-Count': '1',
    'X-Approval-Export-Row-Limit': '500',
    'X-Approval-Export-Row-Cap': '500',
    'X-Approval-Export-Capped': 'false',
  }

  async function withFetch<T>(fetchMock: ReturnType<typeof vi.fn>, run: () => Promise<T>): Promise<T> {
    vi.stubGlobal('fetch', fetchMock)
    try {
      return await run()
    } finally {
      vi.unstubAllGlobals()
    }
  }

  function requestOf(fetchMock: ReturnType<typeof vi.fn>): { url: URL; init: RequestInit } {
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    return { url: new URL(rawUrl), init }
  }

  it('sends every list filter plus format=csv to the list route, with the auth header and no paging', async () => {
    const { response } = csvResponse(FULL_HEADERS)
    const fetchMock = vi.fn().mockResolvedValue(response)
    localStorage.setItem('auth_token', 'tok_export')
    try {
      await withFetch(fetchMock, () => exportApprovalsCsv({
        tab: 'mine',
        status: 'approved',
        search: '采购 A&B',
        sourceSystem: 'platform',
        templateId: 'tpl_7',
        createdFrom: '2026-05-01T00:00:00Z',
        createdTo: '2026-06-30T23:59:59Z',
        // A caller holding a list query still carries paging; it must not reach the export URL.
        ...({ page: 3, pageSize: 10 } as object),
      }))
    } finally {
      localStorage.removeItem('auth_token')
    }

    const { url, init } = requestOf(fetchMock)
    expect(url.pathname).toBe('/api/approvals')
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      tab: 'mine',
      status: 'approved',
      search: '采购 A&B',
      sourceSystem: 'platform',
      templateId: 'tpl_7',
      createdFrom: '2026-05-01T00:00:00Z',
      createdTo: '2026-06-30T23:59:59Z',
      format: 'csv',
    })
    // The server selects the CSV branch on the exact literal only.
    expect(url.searchParams.getAll('format')).toEqual(['csv'])
    expect(init.method).toBe('GET')
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer tok_export')
    expect(headers.get('Accept')).toBe('text/csv')
    expect(init.body).toBeUndefined()
  })

  it('never sends limit/offset of its own: the row ceiling stays the server default', async () => {
    const { response } = csvResponse(FULL_HEADERS)
    const fetchMock = vi.fn().mockResolvedValue(response)
    await withFetch(fetchMock, () => exportApprovalsCsv({ tab: 'pending' }))
    const { url } = requestOf(fetchMock)
    expect([...url.searchParams.keys()].sort()).toEqual(['format', 'tab'])
  })

  it('an empty query still asks for CSV (format is never dropped)', async () => {
    const { response } = csvResponse(FULL_HEADERS)
    const fetchMock = vi.fn().mockResolvedValue(response)
    await withFetch(fetchMock, () => exportApprovalsCsv())
    expect(requestOf(fetchMock).url.search).toBe('?format=csv')
  })

  // T1 (tester report 20261008, item 1) — header mode is OPT-IN. Every pin above is deliberately
  // left exactly as it was: a call with no options is byte-identical to before this change, so those
  // pins still describe the default request (and keep proving that nothing is sent unasked). The
  // cases below pin the new surface: the options add exactly `header` and `lang`, with their values.
  describe('T1: header mode and language (opt-in second argument)', () => {
    const FILTERS = {
      tab: 'mine' as const,
      status: 'approved' as const,
      search: '采购 A&B',
      sourceSystem: 'platform' as const,
      templateId: 'tpl_7',
      createdFrom: '2026-05-01T00:00:00Z',
      createdTo: '2026-06-30T23:59:59Z',
    }

    it.each(['zh', 'en'] as const)('{ header: label, lang: %s } adds exactly those two keys, with those values, beside every filter and format', async (lang) => {
      const { response } = csvResponse(FULL_HEADERS)
      const fetchMock = vi.fn().mockResolvedValue(response)
      await withFetch(fetchMock, () => exportApprovalsCsv(FILTERS, { header: 'label', lang }))
      const { url } = requestOf(fetchMock)
      expect(Object.fromEntries(url.searchParams.entries())).toEqual({
        ...FILTERS,
        format: 'csv',
        header: 'label',
        lang,
      })
      expect(url.searchParams.getAll('header')).toEqual(['label'])
      expect(url.searchParams.getAll('lang')).toEqual([lang])
      expect(url.searchParams.getAll('format')).toEqual(['csv'])
    })

    it('an options-only call (no filters) is exactly format + header + lang, in that order', async () => {
      const { response } = csvResponse(FULL_HEADERS)
      const fetchMock = vi.fn().mockResolvedValue(response)
      await withFetch(fetchMock, () => exportApprovalsCsv(undefined, { header: 'label', lang: 'en' }))
      expect(requestOf(fetchMock).url.search).toBe('?format=csv&header=label&lang=en')
    })

    it('each option is sent only when given: header alone, lang alone, and an empty options object', async () => {
      for (const [options, keys] of [
        [{ header: 'code' as const }, ['format', 'header', 'tab']],
        [{ lang: 'zh' as const }, ['format', 'lang', 'tab']],
        [{}, ['format', 'tab']],
      ] as const) {
        const { response } = csvResponse(FULL_HEADERS)
        const fetchMock = vi.fn().mockResolvedValue(response)
        await withFetch(fetchMock, () => exportApprovalsCsv({ tab: 'pending' }, options))
        expect([...requestOf(fetchMock).url.searchParams.keys()].sort()).toEqual(keys)
      }
    })

    it('POSITIVE CONTROL: with no options at all nothing about headers or language is sent (the default stays server-side)', async () => {
      const { response } = csvResponse(FULL_HEADERS)
      const fetchMock = vi.fn().mockResolvedValue(response)
      await withFetch(fetchMock, () => exportApprovalsCsv(FILTERS))
      const { url } = requestOf(fetchMock)
      expect(url.searchParams.has('header')).toBe(false)
      expect(url.searchParams.has('lang')).toBe(false)
    })

    it('still never sends limit / offset / paging of its own when options are given', async () => {
      const { response } = csvResponse(FULL_HEADERS)
      const fetchMock = vi.fn().mockResolvedValue(response)
      await withFetch(fetchMock, () => exportApprovalsCsv({ tab: 'pending', ...({ page: 3, pageSize: 10 } as object) }, { header: 'label', lang: 'zh' }))
      expect([...requestOf(fetchMock).url.searchParams.keys()].sort()).toEqual(['format', 'header', 'lang', 'tab'])
    })

    it('with options, the export still carries exactly the filters listApprovals sends for the same query, and the list request carries neither option', async () => {
      const { response } = csvResponse(FULL_HEADERS)
      const fetchMock = vi.fn(async (rawUrl: string) => (
        new URL(rawUrl).searchParams.get('format') === 'csv'
          ? response
          : { ok: true, status: 200, json: async () => ({ data: [], total: 0 }), clone() { return this } }
      ))
      vi.resetModules()
      vi.stubEnv('DEV', false)
      vi.stubGlobal('fetch', fetchMock)
      try {
        const api = await import('../src/approvals/api')
        await api.listApprovals({ ...FILTERS, page: 2, pageSize: 10 })
        await api.exportApprovalsCsv(FILTERS, { header: 'label', lang: 'zh' })
      } finally {
        vi.unstubAllEnvs()
        vi.unstubAllGlobals()
        vi.resetModules()
      }

      expect(fetchMock).toHaveBeenCalledTimes(2)
      const [listParams, exportParams] = fetchMock.mock.calls.map(([rawUrl]) => (
        Object.fromEntries(new URL(rawUrl).searchParams.entries())
      ))
      // Positive control: the list request really went out with paging and its filters.
      expect(listParams).toMatchObject({ page: '2', pageSize: '10', tab: 'mine', status: 'approved' })
      expect(listParams).not.toHaveProperty('header')
      expect(listParams).not.toHaveProperty('lang')
      const { page: _page, pageSize: _pageSize, ...listFilters } = listParams
      const { format, header, lang, ...exportFilters } = exportParams
      expect(format).toBe('csv')
      expect(header).toBe('label')
      expect(lang).toBe('zh')
      expect(exportFilters).toEqual(listFilters)
      expect(Object.keys(exportFilters).sort()).toEqual(Object.keys(FILTERS).sort())
    })
  })

  it('carries exactly the filters listApprovals sends for the same query (one shared mapping)', async () => {
    const query = {
      tab: 'completed' as const,
      status: 'rejected' as const,
      search: 'PO-2026',
      sourceSystem: 'all' as const,
      templateId: 'tpl_9',
      createdFrom: '2026-01-01T00:00:00Z',
      createdTo: '2026-01-31T23:59:59Z',
    }
    const { response } = csvResponse(FULL_HEADERS)
    const fetchMock = vi.fn(async (rawUrl: string) => (
      new URL(rawUrl).searchParams.get('format') === 'csv'
        ? response
        : { ok: true, status: 200, json: async () => ({ data: [], total: 0 }), clone() { return this } }
    ))
    vi.resetModules()
    vi.stubEnv('DEV', false)
    vi.stubGlobal('fetch', fetchMock)
    try {
      const api = await import('../src/approvals/api')
      await api.listApprovals({ ...query, page: 2, pageSize: 10 })
      await api.exportApprovalsCsv(query)
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      vi.resetModules()
    }

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [listParams, exportParams] = fetchMock.mock.calls.map(([rawUrl]) => (
      Object.fromEntries(new URL(rawUrl).searchParams.entries())
    ))
    // Positive control: the list request really went out with paging, so the comparison below is
    // between two real requests rather than between two empty objects.
    expect(listParams).toMatchObject({ page: '2', pageSize: '10', tab: 'completed' })
    const { page: _page, pageSize: _pageSize, ...listFilters } = listParams
    const { format, ...exportFilters } = exportParams
    expect(format).toBe('csv')
    expect(exportFilters).toEqual(listFilters)
    expect(Object.keys(exportFilters).sort()).toEqual(Object.keys(query).sort())
  })

  it('returns the response body untouched, with the file name and the four export headers', async () => {
    const { response, blob, blobSpy } = csvResponse({
      ...FULL_HEADERS,
      'X-Approval-Export-Row-Count': '37',
      'X-Approval-Export-Row-Limit': '500',
      'X-Approval-Export-Row-Cap': '500',
      'X-Approval-Export-Capped': 'false',
    })
    const result = await withFetch(vi.fn().mockResolvedValue(response), () => exportApprovalsCsv({ tab: 'pending' }))

    // Identity, not equality: the function hands back the very object `response.blob()` produced.
    expect(result.blob).toBe(blob)
    expect(blobSpy).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      fileName: 'approvals-export.csv',
      rowCount: 37,
      rowLimit: 500,
      rowCap: 500,
      capped: false,
    })
  })

  it('reports a capped export as capped', async () => {
    const { response } = csvResponse({
      ...FULL_HEADERS,
      'X-Approval-Export-Row-Count': '412',
      'X-Approval-Export-Capped': 'true',
    })
    const result = await withFetch(vi.fn().mockResolvedValue(response), () => exportApprovalsCsv())
    expect(result.capped).toBe(true)
    expect(result.rowCount).toBe(412)
  })

  it('reports unreadable export headers as null — never as zero rows or "not capped"', async () => {
    const { response } = csvResponse({ 'Content-Type': 'text/csv; charset=utf-8' })
    const result = await withFetch(vi.fn().mockResolvedValue(response), () => exportApprovalsCsv())
    expect(result.rowCount).toBeNull()
    expect(result.rowLimit).toBeNull()
    expect(result.rowCap).toBeNull()
    expect(result.capped).toBeNull()
    expect(result.fileName).toBe(APPROVAL_EXPORT_DEFAULT_FILE_NAME)
  })

  it.each([
    ['a negative count', '-1'],
    ['a fractional count', '1.5'],
    ['a non-number', 'many'],
    ['an empty value', ''],
    ['an unsafe integer', '9007199254740993'],
  ])('treats %s in a count header as unreadable', async (_label, value) => {
    const { response } = csvResponse({ ...FULL_HEADERS, 'X-Approval-Export-Row-Count': value })
    const result = await withFetch(vi.fn().mockResolvedValue(response), () => exportApprovalsCsv())
    expect(result.rowCount).toBeNull()
    // The sibling headers of the same response are still read.
    expect(result.rowCap).toBe(500)
  })

  it.each([['TRUE'], ['1'], ['yes'], ['']])('treats a non-canonical capped value (%j) as unknown', async (value) => {
    const { response } = csvResponse({ ...FULL_HEADERS, 'X-Approval-Export-Capped': value })
    const result = await withFetch(vi.fn().mockResolvedValue(response), () => exportApprovalsCsv())
    expect(result.capped).toBeNull()
  })

  it.each([
    ['a path fragment', 'attachment; filename="../approvals-export.csv"'],
    ['a name with a space', 'attachment; filename="approvals export.csv"'],
    ['a different extension', 'attachment; filename="approvals-export.exe"'],
    ['an unquoted name', 'attachment; filename=approvals-export.csv'],
    ['no file name at all', 'attachment'],
  ])('falls back to the fixed file name for %s', async (_label, disposition) => {
    const { response } = csvResponse({ ...FULL_HEADERS, 'Content-Disposition': disposition })
    const result = await withFetch(vi.fn().mockResolvedValue(response), () => exportApprovalsCsv())
    expect(result.fileName).toBe(APPROVAL_EXPORT_DEFAULT_FILE_NAME)
  })

  it('rejects a 200 that is not CSV instead of handing its body to the caller', async () => {
    // The shape a server without the CSV branch answers with: the JSON list, status 200.
    const blobSpy = vi.fn()
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json; charset=utf-8' }),
      blob: blobSpy,
      json: async () => ({ data: [], total: 0 }),
      clone() { return this },
    } as unknown as Response

    let caught: unknown
    try {
      await withFetch(vi.fn().mockResolvedValue(response), () => exportApprovalsCsv({ tab: 'pending' }))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ApprovalApiError)
    expect((caught as ApprovalApiError).code).toBe(APPROVAL_EXPORT_UNEXPECTED_RESPONSE)
    expect((caught as ApprovalApiError).status).toBe(200)
    expect(blobSpy).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'APPROVAL_EXPORT_SOURCE_SYSTEM_UNSUPPORTED'],
    [403, 'FORBIDDEN'],
    [500, 'APPROVAL_EXPORT_FAILED'],
    [503, 'APPROVAL_EXPORT_DEGRADED'],
  ])('surfaces a %i refusal as ApprovalApiError carrying the server code %s, and reads no body as CSV', async (status, code) => {
    const blobSpy = vi.fn()
    const response = {
      ok: false,
      status,
      headers: new Headers({ 'Content-Type': 'application/json; charset=utf-8' }),
      blob: blobSpy,
      json: async () => ({ error: { code, message: `server says ${code}` } }),
      clone() { return this },
    } as unknown as Response

    let caught: unknown
    try {
      await withFetch(vi.fn().mockResolvedValue(response), () => exportApprovalsCsv({ sourceSystem: 'plm' }))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ApprovalApiError)
    expect((caught as ApprovalApiError).status).toBe(status)
    expect((caught as ApprovalApiError).code).toBe(code)
    expect((caught as ApprovalApiError).message).toBe(`server says ${code}`)
    expect(blobSpy).not.toHaveBeenCalled()
  })

  it('source tripwire: the export path builds no CSV and no Blob of its own', () => {
    const source = readFileSync(resolve(__dirname, '../src/approvals/api.ts'), 'utf8')
    const start = source.indexOf('// CSV export of the approval list')
    const end = source.indexOf('export async function getApproval(')
    // Count guard so a rename that empties the slice cannot leave this vacuously green.
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const exportSection = source.slice(start, end)
    expect(exportSection).toContain('export async function exportApprovalsCsv(')
    expect(exportSection).toContain('await response.blob()')
    expect(exportSection).not.toMatch(/new\s+Blob\s*\(/)
    expect(exportSection).not.toMatch(/\.join\s*\(/)
    expect(exportSection).not.toMatch(/if\s*\(\s*USE_MOCK/)
    // A known bypass this tripwire does not see: CSV text assembled in ANOTHER module and passed
    // in. The view-level case in approval-center.spec.ts pins the other end (the object handed to
    // `URL.createObjectURL` is the very Blob this function returned).
  })
})
