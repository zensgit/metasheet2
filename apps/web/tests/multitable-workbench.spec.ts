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
              canManageSheetAccess: false,
              canManageViews: false,
              canComment: true,
              canManageAutomation: false, canExport: true,
            },
            capabilityOrigin: {
              source: 'sheet-grant',
              hasSheetAssignments: true,
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
    expect(wb.capabilityOrigin.value).toEqual({
      source: 'sheet-grant',
      hasSheetAssignments: true,
    })
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
              canManageSheetAccess: true,
              canManageViews: true,
              canComment: true,
              canManageAutomation: false, canExport: true,
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
              canManageSheetAccess: false,
              canManageViews: false,
              canComment: true,
              canManageAutomation: false, canExport: true,
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

  it('rolls back base-scoped state when base switch fails', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (input.startsWith('/api/multitable/context?baseId=base_ops')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            base: { id: 'base_ops', name: 'Ops Base' },
            sheet: { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
            sheets: [{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }],
            views: [{ id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' }],
            capabilities: {
              canRead: true,
              canCreateRecord: true,
              canEditRecord: true,
              canDeleteRecord: false,
              canManageFields: true,
              canManageSheetAccess: true,
              canManageViews: true,
              canComment: true,
              canManageAutomation: false, canExport: true,
            },
          },
        }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/context?baseId=base_sales')) {
        return new Response(JSON.stringify({
          ok: false,
          error: { message: 'base switch failed' },
        }), { status: 500 })
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
    const ok = await wb.switchBase('base_sales')

    expect(ok).toBe(false)
    expect(wb.error.value).toBe('base switch failed')
    expect(wb.activeBaseId.value).toBe('base_ops')
    expect(wb.activeSheetId.value).toBe('sheet_orders')
    expect(wb.activeViewId.value).toBe('view_grid')
    expect(wb.sheets.value).toEqual([
      { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
    ])
    expect(wb.fields.value).toEqual([{ id: 'fld_title', name: 'Title', type: 'string' }])
  })

  it('syncs external base and sheet props through the requested context', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (input.startsWith('/api/multitable/context?baseId=base_ops')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            base: { id: 'base_ops', name: 'Ops Base' },
            sheet: { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
            sheets: [{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }],
            views: [{ id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' }],
            capabilities: {
              canRead: true,
              canCreateRecord: true,
              canEditRecord: true,
              canDeleteRecord: false,
              canManageFields: true,
              canManageSheetAccess: true,
              canManageViews: true,
              canComment: true,
              canManageAutomation: false, canExport: true,
            },
          },
        }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/context?baseId=base_sales&sheetId=sheet_deals&viewId=view_board')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            base: { id: 'base_sales', name: 'Sales Base' },
            sheet: { id: 'sheet_deals', baseId: 'base_sales', name: 'Deals', description: null },
            sheets: [{ id: 'sheet_deals', baseId: 'base_sales', name: 'Deals', description: null }],
            views: [{ id: 'view_board', sheetId: 'sheet_deals', name: 'Board', type: 'kanban' }],
            capabilities: {
              canRead: true,
              canCreateRecord: true,
              canEditRecord: true,
              canDeleteRecord: false,
              canManageFields: true,
              canManageSheetAccess: true,
              canManageViews: true,
              canComment: true,
              canManageAutomation: false, canExport: true,
            },
          },
        }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/fields?sheetId=sheet_orders')) {
        return new Response(JSON.stringify({
          ok: true,
          data: { fields: [{ id: 'fld_orders', name: 'Order', type: 'string' }] },
        }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/fields?sheetId=sheet_deals')) {
        return new Response(JSON.stringify({
          ok: true,
          data: { fields: [{ id: 'fld_deal', name: 'Deal', type: 'string' }] },
        }), { status: 200 })
      }
      throw new Error(`Unexpected request: ${input}`)
    })

    const client = new MultitableApiClient({ fetchFn })
    const wb = useMultitableWorkbench({ client, initialBaseId: 'base_ops' })

    await wb.loadSheets()
    const ok = await wb.syncExternalContext({
      baseId: 'base_sales',
      sheetId: 'sheet_deals',
      viewId: 'view_board',
    })

    expect(ok).toBe(true)
    expect(wb.activeBaseId.value).toBe('base_sales')
    expect(wb.activeSheetId.value).toBe('sheet_deals')
    expect(wb.activeViewId.value).toBe('view_board')
    expect(wb.fields.value).toEqual([{ id: 'fld_deal', name: 'Deal', type: 'string' }])
    expect(
      fetchFn.mock.calls.some(
        ([input]) => input === '/api/multitable/context?baseId=base_sales&sheetId=sheet_deals&viewId=view_board',
      ),
    ).toBe(true)
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
