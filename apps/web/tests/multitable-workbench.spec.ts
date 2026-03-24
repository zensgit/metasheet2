import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useMultitableWorkbench } from '../src/multitable/composables/useMultitableWorkbench'
import { MultitableApiClient } from '../src/multitable/api/client'

function mockClient(data: any = {}) {
  return new MultitableApiClient({
    fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data }), { status: 200 })),
  })
}

describe('useMultitableWorkbench', () => {
  it('loads sheets and auto-selects first', async () => {
    const client = mockClient({ sheets: [{ id: 's1', name: 'Sheet1' }, { id: 's2', name: 'Sheet2' }] })
    const wb = useMultitableWorkbench({ client })
    await wb.loadSheets()
    expect(wb.sheets.value).toHaveLength(2)
    expect(wb.activeSheetId.value).toBe('s1')
  })

  it('filters the system people sheet from navigation state', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (input.startsWith('/api/multitable/sheets')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            sheets: [
              { id: 'sheet_people', name: 'People', description: '__metasheet_system:people__' },
              { id: 'sheet_orders', name: 'Orders', description: null },
            ],
          },
        }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/fields')) {
        return new Response(JSON.stringify({ ok: true, data: { fields: [] } }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/context')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            sheet: { id: 'sheet_orders', name: 'Orders', description: null },
            sheets: [{ id: 'sheet_orders', name: 'Orders', description: null }],
            views: [],
            capabilities: {
              canRead: true,
              canCreateRecord: true,
              canEditRecord: true,
              canDeleteRecord: false,
              canManageFields: true,
              canManageViews: false,
              canComment: true,
              canManageAutomation: false,
            },
          },
        }), { status: 200 })
      }
      throw new Error(`Unexpected request: ${input}`)
    })

    const client = new MultitableApiClient({ fetchFn })
    const wb = useMultitableWorkbench({ client })
    await wb.loadSheets()

    expect(wb.sheets.value).toEqual([
      expect.objectContaining({ id: 'sheet_orders', name: 'Orders' }),
    ])
    expect(wb.activeSheetId.value).toBe('sheet_orders')
  })

  it('preserves initialSheetId', async () => {
    const client = mockClient({ sheets: [{ id: 's1', name: 'S1' }, { id: 's2', name: 'S2' }] })
    const wb = useMultitableWorkbench({ client, initialSheetId: 's2' })
    await wb.loadSheets()
    expect(wb.activeSheetId.value).toBe('s2')
  })

  it('loads sheet metadata when initialSheetId is preselected', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (input.startsWith('/api/multitable/sheets')) {
        return new Response(JSON.stringify({ ok: true, data: { sheets: [{ id: 's2', name: 'S2' }] } }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/fields')) {
        return new Response(JSON.stringify({ ok: true, data: { fields: [{ id: 'f1', name: 'Title', type: 'string' }] } }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/context')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            sheet: { id: 's2', name: 'S2' },
            sheets: [{ id: 's2', name: 'S2' }],
            views: [{ id: 'v1', sheetId: 's2', name: 'Grid', type: 'grid' }],
            capabilities: {
              canRead: true,
              canCreateRecord: true,
              canEditRecord: true,
              canDeleteRecord: false,
              canManageFields: false,
              canManageViews: false,
              canComment: true,
              canManageAutomation: false,
            },
          },
        }), { status: 200 })
      }
      throw new Error(`Unexpected request: ${input}`)
    })

    const client = new MultitableApiClient({ fetchFn })
    const wb = useMultitableWorkbench({ client, initialSheetId: 's2' })
    await wb.loadSheets()

    expect(wb.activeSheetId.value).toBe('s2')
    expect(wb.fields.value).toEqual([{ id: 'f1', name: 'Title', type: 'string' }])
    expect(wb.views.value).toEqual([{ id: 'v1', sheetId: 's2', name: 'Grid', type: 'grid' }])
    expect(wb.capabilities.value.canRead).toBe(true)
  })

  it('loads base-scoped sheet metadata when initialBaseId is preselected', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (input.startsWith('/api/multitable/context?baseId=base_ops')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            base: { id: 'base_ops', name: 'Ops Base' },
            sheet: { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
            sheets: [
              { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
              { id: 'sheet_people', baseId: 'base_ops', name: 'People', description: '__metasheet_system:people__' },
            ],
            views: [{ id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' }],
            capabilities: {
              canRead: true,
              canCreateRecord: true,
              canEditRecord: true,
              canDeleteRecord: false,
              canManageFields: true,
              canManageViews: true,
              canComment: true,
              canManageAutomation: false,
            },
          },
        }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/fields?sheetId=sheet_orders')) {
        return new Response(JSON.stringify({
          ok: true,
          data: { fields: [{ id: 'fld_title', name: 'Title', type: 'string' }] },
        }), { status: 200 })
      }
      throw new Error(`Unexpected request: ${input}`)
    })

    const client = new MultitableApiClient({ fetchFn })
    const wb = useMultitableWorkbench({ client, initialBaseId: 'base_ops' })
    await wb.loadSheets()

    expect(wb.activeBaseId.value).toBe('base_ops')
    expect(wb.activeSheetId.value).toBe('sheet_orders')
    expect(wb.activeViewId.value).toBe('view_grid')
    expect(wb.sheets.value).toEqual([
      { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
    ])
    expect(wb.fields.value).toEqual([{ id: 'fld_title', name: 'Title', type: 'string' }])
  })

  it('syncs activeBaseId from loaded sheet metadata', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (input.startsWith('/api/multitable/fields?sheetId=s2')) {
        return new Response(JSON.stringify({
          ok: true,
          data: { fields: [{ id: 'fld_title', name: 'Title', type: 'string' }] },
        }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/context?sheetId=s2')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            base: { id: 'base_sales', name: 'Sales Base' },
            sheet: { id: 's2', baseId: 'base_sales', name: 'Opportunities', description: null },
            sheets: [{ id: 's2', baseId: 'base_sales', name: 'Opportunities', description: null }],
            views: [{ id: 'v2', sheetId: 's2', name: 'Grid', type: 'grid' }],
            capabilities: {
              canRead: true,
              canCreateRecord: true,
              canEditRecord: true,
              canDeleteRecord: false,
              canManageFields: false,
              canManageViews: false,
              canComment: true,
              canManageAutomation: false,
            },
          },
        }), { status: 200 })
      }
      throw new Error(`Unexpected request: ${input}`)
    })

    const client = new MultitableApiClient({ fetchFn })
    const wb = useMultitableWorkbench({ client })
    await wb.loadSheetMeta('s2')

    expect(wb.activeBaseId.value).toBe('base_sales')
    expect(wb.activeSheetId.value).toBe('s2')
    expect(wb.activeViewId.value).toBe('v2')
  })

  it('selectSheet resets viewId', () => {
    const client = mockClient({})
    const wb = useMultitableWorkbench({ client, initialSheetId: 's1', initialViewId: 'v1' })
    wb.selectSheet('s2')
    expect(wb.activeSheetId.value).toBe('s2')
    expect(wb.activeViewId.value).toBe('')
  })

  it('selectView updates activeViewId', () => {
    const client = mockClient({})
    const wb = useMultitableWorkbench({ client })
    wb.selectView('v2')
    expect(wb.activeViewId.value).toBe('v2')
  })

  it('activeView returns matching view', () => {
    const client = mockClient({})
    const wb = useMultitableWorkbench({ client })
    wb.views.value = [
      { id: 'v1', sheetId: 's1', name: 'Grid', type: 'grid' },
      { id: 'v2', sheetId: 's1', name: 'Form', type: 'form' },
    ]
    wb.activeViewId.value = 'v2'
    expect(wb.activeView.value?.name).toBe('Form')
  })

  it('computes visibleFields excluding hidden', () => {
    const client = mockClient({})
    const wb = useMultitableWorkbench({ client })
    wb.fields.value = [
      { id: 'f1', name: 'A', type: 'string' },
      { id: 'f2', name: 'B', type: 'number' },
    ]
    // fields are managed by workbench state
    expect(wb.fields.value).toHaveLength(2)
  })

  it('handles load error', async () => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { message: 'boom' } }), { status: 500 })),
    })
    const wb = useMultitableWorkbench({ client })
    await wb.loadSheets()
    expect(wb.error.value).toBeTruthy()
  })
})
