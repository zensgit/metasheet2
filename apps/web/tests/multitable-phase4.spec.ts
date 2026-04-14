import { describe, it, expect, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'

function mockClientWithFn(fetchFn: ReturnType<typeof vi.fn>) {
  return new MultitableApiClient({ fetchFn })
}

// --- Sheet creation ---
describe('sheet creation API', () => {
  it('createSheet calls POST with baseId and seed', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { sheet: { id: 's_new', name: 'Sheet 2', baseId: 'b1', seeded: true } },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.createSheet({ name: 'Sheet 2', baseId: 'b1', seed: true })
    expect(result.sheet.id).toBe('s_new')
    expect(result.sheet.seeded).toBe(true)
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/sheets', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(body.baseId).toBe('b1')
    expect(body.seed).toBe(true)
  })
})

// --- Record detail fetch ---
describe('getRecord API', () => {
  it('fetches record by ID with sheetId/viewId params', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          sheet: { id: 's1', name: 'S1' },
          fields: [{ id: 'f1', name: 'Name', type: 'string' }],
          record: { id: 'r1', version: 3, data: { f1: 'Alice' } },
          capabilities: { canRead: true },
          commentsScope: {},
        },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.getRecord('r1', { sheetId: 's1', viewId: 'v1' })
    expect(result.record.id).toBe('r1')
    expect(result.record.data.f1).toBe('Alice')
    const calledUrl = fetchFn.mock.calls[0][0] as string
    expect(calledUrl).toContain('/api/multitable/records/r1')
    expect(calledUrl).toContain('sheetId=s1')
  })

  it('fetches record without optional params', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          sheet: { id: 's1', name: 'S1' },
          fields: [],
          record: { id: 'r2', version: 1, data: {} },
          capabilities: {},
          commentsScope: {},
        },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.getRecord('r2')
    expect(result.record.id).toBe('r2')
  })
})

// --- Form context ---
describe('loadFormContext API', () => {
  it('calls form-context endpoint with params', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          mode: 'form',
          readOnly: false,
          submitPath: '/api/multitable/views/v1/submit',
          sheet: { id: 's1', name: 'S1' },
          fields: [{ id: 'f1', name: 'Name', type: 'string' }],
          capabilities: { canRead: true },
        },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.loadFormContext({ sheetId: 's1', viewId: 'v1' })
    expect(result.mode).toBe('form')
    expect(result.readOnly).toBe(false)
    expect(result.fields).toHaveLength(1)
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/multitable/form-context'))
  })

  it('includes the public token when loading anonymous form context', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          mode: 'form',
          readOnly: false,
          submitPath: '/api/multitable/views/v1/submit',
          sheet: { id: 's1', name: 'S1' },
          fields: [],
          capabilities: { canRead: true },
        },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    await client.loadFormContext({ sheetId: 's1', viewId: 'v1', publicToken: 'pub_123' })

    expect(fetchFn.mock.calls[0]?.[0]).toContain('/api/multitable/form-context')
    expect(fetchFn.mock.calls[0]?.[0]).toContain('publicToken=pub_123')
  })
})

// --- Record summaries ---
describe('listRecordSummaries API', () => {
  it('calls records-summary endpoint with search', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          records: [{ id: 'r1', display: 'Alice' }, { id: 'r2', display: 'Bob' }],
          displayMap: { r1: 'Alice', r2: 'Bob' },
          page: { offset: 0, limit: 20, total: 2, hasMore: false },
        },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.listRecordSummaries({ sheetId: 's1', search: 'Al', limit: 20 })
    expect(result.records).toHaveLength(2)
    expect(result.records[0].display).toBe('Alice')
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/multitable/records-summary'))
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('search=Al'))
  })
})

// --- Form submit ---
describe('form submit API', () => {
  it('submitForm calls correct endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { mode: 'create', record: { id: 'r1', version: 1, data: {} }, commentsScope: {} },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const result = await client.submitForm('v1', { data: { name: 'Alice' } })
    expect(result.mode).toBe('create')
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/views/v1/submit', expect.objectContaining({ method: 'POST' }))
  })

  it('submitForm sends recordId for updates', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { mode: 'update', record: { id: 'r1', version: 2, data: {} }, commentsScope: {} },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    await client.submitForm('v1', { recordId: 'r1', expectedVersion: 1, data: { name: 'Bob' } })
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(body.recordId).toBe('r1')
    expect(body.expectedVersion).toBe(1)
  })

  it('submitForm sends the public token with anonymous form submissions', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          mode: 'create',
          record: { id: 'r1', version: 1, data: {} },
          commentsScope: {},
        },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    await client.submitForm('v1', { publicToken: 'pub_123', data: { name: 'Bob' } })

    expect(fetchFn.mock.calls[0]?.[0]).toContain('/api/multitable/views/v1/submit')
    expect(fetchFn.mock.calls[0]?.[0]).toContain('publicToken=pub_123')
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(body.publicToken).toBe('pub_123')
  })
})

// --- API error handling ---
describe('API error handling', () => {
  it('throws error with message from response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: { message: 'Field name required' } }), { status: 400 }),
    )
    const client = mockClientWithFn(fetchFn)
    await expect(client.createField({ sheetId: 's1', name: '' })).rejects.toThrow('Field name required')
  })

  it('throws generic error when no message', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), { status: 500 }),
    )
    const client = mockClientWithFn(fetchFn)
    await expect(client.listSheets()).rejects.toThrow('API 500')
  })
})
