import { afterEach, describe, expect, it, vi } from 'vitest'
import { restoreImportedManualArchiveOverHttp } from '../../scripts/verify-recovery-local-manual-http'

const generationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const recordIds = Array.from({ length: 5001 }, (_, index) => `record-${String(index).padStart(5, '0')}`)
const recordId = recordIds[2500]
afterEach(() => vi.restoreAllMocks())

function fixture(asyncCount = 5001, executionKind = 'async', abortAtPreview?: AbortController) {
  let edited = false
  let applied = false
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes('UPDATE public.meta_records')) {
      expect(sql).toContain('id=ANY($1::text[])')
      expect(values?.[0]).toEqual(recordIds)
      edited = true
      return { rows: [], rowCount: 5001 }
    }
    if (sql.includes("data->>$2='edited'")) return { rows: [{ count: 5001 }] }
    if (sql.includes('meta_record_revisions')) return { rows: [{ count: applied ? 1 : 0 }] }
    return { rows: [{ data: { scalar: edited ? 'edited' : 'captured', file: applied || !edited ? ['attachment'] : [] },
      version: applied ? 3 : edited ? 2 : 1 }] }
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const target = String(url)
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {}
    requests.push({ url: target, body })
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status })
    if (target.includes('/catalog/')) return reply({ generationId })
    if (target.endsWith('/preview')) {
      const async = (body.scope as { kind: string }).kind === 'whole_sheet'
      abortAtPreview?.abort(new Error('synthetic parent loss'))
      return reply({ generationId, executable: true, blockedReason: null,
        executionKind: async ? executionKind : 'sync', previewIdentity: async ? 'async-token' : 'sync-token',
        summary: { effectiveWriteCount: async ? asyncCount : 1, reverts: [{ recordId, fieldIds: ['file'] }] } })
    }
    if (target.endsWith('/execute')) {
      if (applied) return reply({}, 409)
      applied = true
      return reply({ revertedCount: 1, resurrectedCount: 0, deletedCount: 0 })
    }
    if (target.endsWith('/jobs/accept')) return reply({ jobId, totalCount: '5001' }, 202)
    throw new Error('unexpected request')
  })
  return { requests, query, input: { runtime: { query }, identity: { sheetId: 'sheet', actorId: 'actor' },
    generationId, recordId, recordIds, fieldId: 'scalar', attachmentFieldId: 'file', attachmentId: 'attachment' } }
}

describe('same archive LOCAL HTTP verification sequence', () => {
  it('uses attachment-only sync, fresh same-generation whole-sheet preview, and one async accept', async () => {
    const f = fixture()
    await expect(restoreImportedManualArchiveOverHttp(f.input, 'http://synthetic.test', {})).resolves.toBe(jobId)
    const previews = f.requests.filter(request => request.url.endsWith('/preview'))
    expect(previews.map(request => request.body)).toEqual([
      { generationId, mode: 'revert', scope: { kind: 'selected_fields', recordIds: [recordId], fieldIds: ['file'] } },
      { generationId, mode: 'revert', scope: { kind: 'whole_sheet' } },
    ])
    expect(f.requests.filter(request => request.url.endsWith('/jobs/accept')).map(request => request.body))
      .toEqual([{ previewIdentity: 'async-token' }])
    expect(f.requests.some(request => request.url.endsWith('/resume'))).toBe(false)
  })
  it('refuses a truncated 5000-write preview before accepting a job', async () => {
    const f = fixture(5000)
    await expect(restoreImportedManualArchiveOverHttp(f.input, 'http://synthetic.test', {})).rejects.toThrow()
    expect(f.requests.some(request => request.url.endsWith('/jobs/accept'))).toBe(false)
  })
  it('refuses a sync-shaped preview despite a 5001 count', async () => {
    const f = fixture(5001, 'sync')
    await expect(restoreImportedManualArchiveOverHttp(f.input, 'http://synthetic.test', {})).rejects.toThrow()
    expect(f.requests.some(request => request.url.endsWith('/jobs/accept'))).toBe(false)
  })

  it('starts no HTTP or SQL work when the parent has already disappeared', async () => {
    const cancellation = new AbortController()
    const f = fixture()
    cancellation.abort(new Error('synthetic parent loss'))
    await expect(restoreImportedManualArchiveOverHttp({ ...f.input, signal: cancellation.signal },
      'http://synthetic.test', {})).rejects.toThrow('synthetic parent loss')
    expect(f.requests).toEqual([])
    expect(f.query).not.toHaveBeenCalled()
  })

  it('carries parent cancellation into HTTP and starts no later SQL or execute after preview', async () => {
    const cancellation = new AbortController()
    const f = fixture(5001, 'async', cancellation)
    await expect(restoreImportedManualArchiveOverHttp({ ...f.input, signal: cancellation.signal },
      'http://synthetic.test', {})).rejects.toThrow('synthetic parent loss')
    expect(f.requests.map(request => request.url.split('/').at(-1))).toEqual([generationId, 'preview'])
    expect(f.query).toHaveBeenCalledTimes(3)
    expect(vi.mocked(fetch).mock.calls.map(([, options]) => options?.signal))
      .toEqual([cancellation.signal, cancellation.signal])
  })
})
