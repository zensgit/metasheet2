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

  it('accepts a pool wrapper in addition to a raw query for loadSheetRow', async () => {
    const pool = createPool((_sql, params) => {
      expect(params).toEqual(['sheet_wrap'])
      return [
        { id: 'sheet_wrap', base_id: null, name: 'Wrapped', description: null },
      ]
    })

    await expect(loadSheetRow(pool, 'sheet_wrap')).resolves.toEqual({
      id: 'sheet_wrap',
      baseId: null,
      name: 'Wrapped',
      description: null,
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

  it('accepts a raw query for loadFieldsForSheet', async () => {
    let calls = 0
    const pool = createPool((_sql, params) => {
      calls += 1
      expect(params).toEqual(['sheet_raw'])
      return [
        {
          id: 'fld_name',
          name: 'Name',
          type: 'string',
          property: {},
          order: 0,
        },
      ]
    })

    const result = await loadFieldsForSheet(pool.query, 'sheet_raw')
    expect(calls).toBe(1)
    expect(result[0]).toMatchObject({ id: 'fld_name', type: 'string' })
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

  it('falls back to a module-level cache when no cache is supplied to tryResolveView', async () => {
    let calls = 0
    const pool = createPool((_sql, params) => {
      calls += 1
      expect(params).toEqual(['view_default_cache_probe'])
      return [
        {
          id: 'view_default_cache_probe',
          sheet_id: 'sheet_any',
          name: 'Default Cache Probe',
          type: 'grid',
          filter_info: {},
          sort_info: {},
          group_info: {},
          hidden_field_ids: [],
          config: {},
        },
      ]
    })

    const first = await tryResolveView(pool, 'view_default_cache_probe')
    const second = await tryResolveView(pool, 'view_default_cache_probe')

    expect(calls).toBe(1)
    expect(first).toBe(second)
  })

  it('accepts a raw query for tryResolveView', async () => {
    let calls = 0
    const cache = new Map<string, any>()
    const pool = createPool((_sql, params) => {
      calls += 1
      expect(params).toEqual(['view_raw'])
      return [
        {
          id: 'view_raw',
          sheet_id: 'sheet_any',
          name: 'Raw Query',
          type: 'grid',
          filter_info: {},
          sort_info: {},
          group_info: {},
          hidden_field_ids: [],
          config: {},
        },
      ]
    })

    const result = await tryResolveView(pool.query, 'view_raw', cache)
    expect(calls).toBe(1)
    expect(result).toMatchObject({ id: 'view_raw', sheetId: 'sheet_any' })
  })
})
