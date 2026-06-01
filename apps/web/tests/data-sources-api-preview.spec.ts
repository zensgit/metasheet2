import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.hoisted(() => vi.fn())
const apiGetMock = vi.hoisted(() => vi.fn())

vi.mock('../src/utils/api', () => ({
  apiFetch: apiFetchMock,
  apiGet: apiGetMock,
}))

import { getDataSourceSchema, getDataSourceTableInfo, previewDataSourceRows } from '../src/data-sources/api'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Bad Request',
    json: async () => body,
  } as Response
}

describe('data-sources preview API client', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    apiGetMock.mockReset()
  })

  it('loads schema through the schema endpoint', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: { tables: [{ name: 'items', schema: 'public', columns: [] }] },
    }))

    const schema = await getDataSourceSchema('pg/source')

    expect(schema.tables?.[0].name).toBe('items')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/data-sources/pg%2Fsource/schema')
  })

  it('loads table details through the table-info endpoint with schema query', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: { name: 'items', schema: 'public', columns: [{ name: 'id', type: 'int', nullable: false }] },
    }))

    const table = await getDataSourceTableInfo('pg/source', 'items', 'public')

    expect(table.columns?.[0].name).toBe('id')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/data-sources/pg%2Fsource/tables/items?schema=public')
  })

  it('previews rows through bounded /select and never calls raw /query', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        data: [{ id: 1 }],
        metadata: { columns: [{ name: 'id', type: 'int' }] },
      },
    }))

    const result = await previewDataSourceRows('pg', { table: 'public.items', limit: 100 })

    expect(result.data).toEqual([{ id: 1 }])
    expect(apiFetchMock).toHaveBeenCalledWith('/api/data-sources/pg/select', {
      method: 'POST',
      body: JSON.stringify({ table: 'public.items', limit: 100 }),
    })
    expect(apiFetchMock.mock.calls.some(([path]) => String(path).includes('/query'))).toBe(false)
  })
})
