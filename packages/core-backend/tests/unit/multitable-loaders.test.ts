import { describe, expect, it } from 'vitest'

import {
  loadFieldsForSheet,
  loadSheetRow,
  tryResolveView,
  type MultitableLoaderQueryFn,
} from '../../src/multitable/loaders'

type QueryRow = Record<string, unknown>

function createPool(handler: (sql: string, params?: unknown[]) => QueryRow[]) {
  return {
    query: (async (sql: string, params?: unknown[]) => ({
      rows: handler(sql, params),
    })) as MultitableLoaderQueryFn,
  }
}

describe('multitable loaders helper', () => {
  it('loads one sheet row', async () => {
    const pool = createPool((sql, params) => {
      expect(sql).toContain('FROM meta_sheets')
      expect(params).toEqual(['sheet_ops'])
      return [
        {
          id: 'sheet_ops',
          base_id: 'base_ops',
          name: 'Orders',
          description: 'Ops records',
        },
      ]
    })

    await expect(loadSheetRow(pool.query, 'sheet_ops')).resolves.toEqual({
      id: 'sheet_ops',
      baseId: 'base_ops',
      name: 'Orders',
      description: 'Ops records',
    })
  })

  it('loads fields and caches them', async () => {
    let calls = 0
    const cache = new Map<string, any[]>()
    const pool = createPool((_sql, params) => {
      calls += 1
      expect(params).toEqual(['sheet_ops'])
      return [
        {
          id: 'fld_status',
          name: 'Status',
          type: 'select',
          property: { options: [{ value: 'open' }] },
          order: 0,
        },
      ]
    })

    const first = await loadFieldsForSheet(pool, 'sheet_ops', cache)
    const second = await loadFieldsForSheet(pool, 'sheet_ops', cache)

    expect(calls).toBe(1)
    expect(first).toEqual(second)
    expect(first[0]).toMatchObject({
      id: 'fld_status',
      type: 'select',
      options: [{ value: 'open' }],
    })
  })

  it('loads one view config and caches it', async () => {
    let calls = 0
    const cache = new Map<string, any>()
    const pool = createPool((_sql, params) => {
      calls += 1
      expect(params).toEqual(['view_form'])
      return [
        {
          id: 'view_form',
          sheet_id: 'sheet_ops',
          name: 'Intake Form',
          type: 'form',
          filter_info: {},
          sort_info: {},
          group_info: {},
          hidden_field_ids: ['fld_hidden'],
          config: { submitText: 'Save' },
        },
      ]
    })

    const first = await tryResolveView(pool, 'view_form', cache)
    const second = await tryResolveView(pool, 'view_form', cache)

    expect(calls).toBe(1)
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      id: 'view_form',
      sheetId: 'sheet_ops',
      hiddenFieldIds: ['fld_hidden'],
    })
  })
})
