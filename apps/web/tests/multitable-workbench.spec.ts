import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useLocale } from '../src/composables/useLocale'
import { useMultitableWorkbench } from '../src/multitable/composables/useMultitableWorkbench'
import { MultitableApiClient } from '../src/multitable/api/client'

function mockClient(data: any = {}) {
  return new MultitableApiClient({
    fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data }), { status: 200 })),
  })
}

describe('workbench context request ownership', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: Error) => void
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
    return { promise, resolve, reject }
  }

  function fixture() {
    const client = mockClient()
    const wb = useMultitableWorkbench({
      client, initialBaseId: 'base_a', initialSheetId: 'sheet_a', initialViewId: 'view_a',
    })
    const context = (suffix: string) => ({
      base: { id: `base_${suffix}`, name: suffix },
      sheet: { id: `sheet_${suffix}`, baseId: `base_${suffix}`, name: suffix },
      sheets: [{ id: `sheet_${suffix}`, baseId: `base_${suffix}`, name: suffix }],
      views: [{ id: `view_${suffix}`, sheetId: `sheet_${suffix}`, name: suffix, type: 'grid' as const }],
      capabilities: { ...wb.capabilities.value, canRead: true },
    })
    const fieldData = (name: string) => ({ fields: [{ id: 'field', name, type: 'string' as const }] })
    const contexts = vi.spyOn(client, 'loadContext').mockImplementation(async (params) => (
      context((params.baseId ?? params.sheetId ?? 'base_a').split('_')[1])
    ))
    const fields = vi.spyOn(client, 'listFields').mockImplementation(async (sheetId) => fieldData(sheetId))
    return { wb, client, context, fieldData, contexts, fields }
  }

  it('does not let an older poll overwrite a newer restore refresh on the same sheet', async () => {
    const { wb, fields, fieldData } = fixture()
    const late = deferred<ReturnType<typeof fieldData>>()
    fields.mockImplementationOnce(() => late.promise)
    const oldPoll = wb.loadSheetMeta('sheet_a')
    expect(await wb.loadSheetMeta('sheet_a')).toBe(true)
    const latestFields = wb.fields.value
    late.resolve(fieldData('before restore'))
    expect(await oldPoll).toBe(false)
    expect(wb.fields.value).toBe(latestFields)
    expect(wb.fields.value).toEqual(fieldData('sheet_a').fields)
    expect(wb.error.value).toBeNull()
  })

  it('does not let a restored-sheet refresh return the user to an older base', async () => {
    const { wb, fields, fieldData } = fixture()
    const late = deferred<ReturnType<typeof fieldData>>()
    fields.mockImplementationOnce(() => late.promise)
    const refresh = wb.loadSheetMeta('sheet_a')
    expect(await wb.switchBase('base_b')).toBe(true)
    late.resolve(fieldData('old base'))
    expect(await refresh).toBe(false)
    expect([wb.activeBaseId.value, wb.activeSheetId.value, wb.activeViewId.value])
      .toEqual(['base_b', 'sheet_b', 'view_b'])
    expect(wb.fields.value).toEqual(fieldData('sheet_b').fields)
  })

  it('does not roll back a newer successful switch when an older context returns', async () => {
    const { wb, contexts, context, fieldData } = fixture()
    const late = deferred<ReturnType<typeof context>>()
    contexts.mockImplementationOnce(() => late.promise)
    const oldSwitch = wb.switchBase('base_b')
    expect(await wb.switchBase('base_c')).toBe(true)
    late.resolve(context('b'))
    expect(await oldSwitch).toBe(false)
    expect([wb.activeBaseId.value, wb.activeSheetId.value, wb.activeViewId.value])
      .toEqual(['base_c', 'sheet_c', 'view_c'])
    expect(wb.fields.value).toEqual(fieldData('sheet_c').fields)
    expect(wb.error.value).toBeNull()
    expect(wb.loading.value).toBe(false)
  })

  it('does not apply an older base field response after the new base finishes', async () => {
    const { wb, fields, fieldData } = fixture()
    const late = deferred<ReturnType<typeof fieldData>>()
    fields.mockImplementationOnce(() => late.promise)
    const oldSwitch = wb.switchBase('base_b')
    await vi.waitFor(() => expect(fields).toHaveBeenCalledWith('sheet_b'))
    expect(await wb.switchBase('base_c')).toBe(true)
    late.resolve(fieldData('old fields'))
    expect(await oldSwitch).toBe(false)
    expect(wb.activeBaseId.value).toBe('base_c')
    expect(wb.fields.value).toEqual(fieldData('sheet_c').fields)
    expect(wb.loading.value).toBe(false)
  })

  it('ignores a stale external-context error without rolling back the newer selection', async () => {
    const { wb, fields, fieldData } = fixture()
    const late = deferred<ReturnType<typeof fieldData>>()
    fields.mockImplementationOnce(() => late.promise)
    const oldSwitch = wb.syncExternalContext({ sheetId: 'sheet_b' })
    expect(await wb.switchBase('base_c')).toBe(true)
    late.reject(new Error('older request failed'))
    expect(await oldSwitch).toBe(false)
    expect(wb.activeBaseId.value).toBe('base_c')
    expect(wb.fields.value).toEqual(fieldData('sheet_c').fields)
    expect(wb.error.value).toBeNull()
  })

  it.each([
    { scope: 'sheet', input: { sheetId: 'sheet_b' }, suffix: 'b', viewId: 'view_b' },
    { scope: 'view', input: { viewId: 'view_selected' }, suffix: 'a', viewId: 'view_selected' },
  ])('marks an external $scope navigation busy until its metadata settles', async ({ input, suffix, viewId }) => {
    const { wb, contexts, context, fields, fieldData } = fixture()
    const late = deferred<ReturnType<typeof fieldData>>()
    fields.mockImplementationOnce(() => late.promise)
    const target = context(suffix)
    contexts.mockResolvedValueOnce({
      ...target,
      views: [{ ...target.views[0], id: viewId }],
    })
    const navigation = wb.syncExternalContext(input)
    expect(wb.loading.value).toBe(true)
    late.resolve(fieldData('selected context'))
    expect(await navigation).toBe(true)
    expect([wb.activeSheetId.value, wb.activeViewId.value]).toEqual([`sheet_${suffix}`, viewId])
    expect(wb.fields.value).toEqual(fieldData('selected context').fields)
    expect(wb.loading.value).toBe(false)
  })

  it('keeps a view selected while an older metadata response was in flight', async () => {
    const { wb, fields, fieldData } = fixture()
    const late = deferred<ReturnType<typeof fieldData>>()
    fields.mockImplementationOnce(() => late.promise)
    const refresh = wb.loadSheetMeta('sheet_a')
    wb.selectView('view_selected')
    late.resolve(fieldData('old view'))
    expect(await refresh).toBe(false)
    expect(wb.activeViewId.value).toBe('view_selected')
    expect(wb.fields.value).toEqual([])
  })

  it('keeps the latest loading state while an older base request finishes', async () => {
    const { wb, contexts, context } = fixture()
    const older = deferred<ReturnType<typeof context>>()
    const latest = deferred<ReturnType<typeof context>>()
    contexts.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => latest.promise)
    const oldSwitch = wb.switchBase('base_b')
    const newSwitch = wb.switchBase('base_c')
    older.resolve(context('b'))
    expect(await oldSwitch).toBe(false)
    expect(wb.loading.value).toBe(true)
    latest.resolve(context('c'))
    expect(await newSwitch).toBe(true)
    expect(wb.loading.value).toBe(false)
    expect(wb.activeBaseId.value).toBe('base_c')
  })

  it('ignores an older global sheet list after a base context is selected', async () => {
    const { wb, client, context } = fixture()
    wb.activeBaseId.value = ''
    wb.activeSheetId.value = ''
    const late = deferred<{ sheets: ReturnType<typeof context>['sheets'] }>()
    vi.spyOn(client, 'listSheets').mockImplementationOnce(() => late.promise)
    const globalLoad = wb.loadSheets()
    expect(await wb.switchBase('base_b')).toBe(true)
    late.resolve({ sheets: context('a').sheets })
    await globalLoad
    expect(wb.sheets.value).toEqual(context('b').sheets)
    expect(wb.activeBaseId.value).toBe('base_b')
  })
})

describe('useMultitableWorkbench', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })

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

  it('localizes sheet-load fallback when backend message is absent', async () => {
    useLocale().setLocale('zh-CN')
    const client = { listSheets: vi.fn().mockRejectedValue({}) } as any
    const wb = useMultitableWorkbench({ client })

    await wb.loadSheets()

    expect(wb.error.value).toBe('加载数据表失败')
  })

  it('keeps backend load errors raw ahead of localized fallbacks', async () => {
    useLocale().setLocale('zh-CN')
    const client = { listSheets: vi.fn().mockRejectedValue(new Error('backend raw')) } as any
    const wb = useMultitableWorkbench({ client })

    await wb.loadSheets()

    expect(wb.error.value).toBe('backend raw')
  })

  // #5743: the manager dialogs reload sheet meta on a keep-alive. The REQUEST always goes out (that
  // is the point of a refresh), but an unchanged answer used to re-seat sheets/views/fields/
  // capabilities/permissions with brand-new object identities every time, which re-ran every
  // identity-keyed watcher in the workbench. An unchanged payload must now be a pure no-op.
  describe('#5743 unchanged sheet-meta payloads', () => {
    function metaFetch(fieldsPayload: () => any[], viewsPayload?: () => any[]) {
      const views = viewsPayload ?? (() => [{ id: 'v1', sheetId: 's1', name: 'Grid', type: 'grid' }])
      return vi.fn(async (input: string) => {
        if (input.startsWith('/api/multitable/fields?sheetId=s1')) {
          return new Response(JSON.stringify({ ok: true, data: { fields: fieldsPayload() } }), { status: 200 })
        }
        if (input.startsWith('/api/multitable/context?sheetId=s1')) {
          return new Response(JSON.stringify({
            ok: true,
            data: {
              base: { id: 'base_ops', name: 'Ops Base' },
              sheet: { id: 's1', baseId: 'base_ops', name: 'Orders', description: null },
              sheets: [{ id: 's1', baseId: 'base_ops', name: 'Orders', description: null }],
              views: views(),
              capabilities: {
                canRead: true,
                canCreateRecord: true,
                canEditRecord: true,
                canDeleteRecord: false,
                canManageFields: true,
                canManageSheetAccess: true,
                canManageViews: true,
                canComment: true,
                canManageAutomation: false,
                canExport: true,
              },
              fieldPermissions: { fld_title: { fieldId: 'fld_title', canRead: true, canWrite: true } },
              viewPermissions: { v1: { viewId: 'v1', canRead: true, canWrite: true } },
              personalOverrideViewIds: [],
            },
          }), { status: 200 })
        }
        throw new Error('Unexpected request: ' + input)
      })
    }

    it('re-fetches but does not replace object identities when nothing changed', async () => {
      const fields = [{ id: 'fld_title', name: 'Title', type: 'string' }]
      const fetchFn = metaFetch(() => fields)
      const client = new MultitableApiClient({ fetchFn })
      const wb = useMultitableWorkbench({ client, initialViewId: 'v1' })

      expect(await wb.loadSheetMeta('s1')).toBe(true)
      const fieldsRef = wb.fields.value
      const viewsRef = wb.views.value
      const sheetsRef = wb.sheets.value
      const capabilitiesRef = wb.capabilities.value
      const fieldPermissionsRef = wb.fieldPermissions.value
      const viewPermissionsRef = wb.viewPermissions.value
      const personalOverrideRef = wb.personalOverrideViewIds.value
      const callsAfterFirst = fetchFn.mock.calls.length

      expect(await wb.loadSheetMeta('s1')).toBe(true)

      // The poll still hits the server: /fields + /context, exactly as before.
      expect(fetchFn.mock.calls.length).toBe(callsAfterFirst + 2)
      expect(wb.fields.value).toBe(fieldsRef)
      expect(wb.views.value).toBe(viewsRef)
      expect(wb.sheets.value).toBe(sheetsRef)
      expect(wb.capabilities.value).toBe(capabilitiesRef)
      expect(wb.fieldPermissions.value).toBe(fieldPermissionsRef)
      expect(wb.viewPermissions.value).toBe(viewPermissionsRef)
      expect(wb.personalOverrideViewIds.value).toBe(personalOverrideRef)
      expect(wb.activeSheetId.value).toBe('s1')
      expect(wb.activeViewId.value).toBe('v1')
    })

    it('does replace them as soon as the payload actually changes', async () => {
      let fields = [{ id: 'fld_title', name: 'Title', type: 'string' }]
      const fetchFn = metaFetch(() => fields)
      const client = new MultitableApiClient({ fetchFn })
      const wb = useMultitableWorkbench({ client, initialViewId: 'v1' })

      await wb.loadSheetMeta('s1')
      const fieldsRef = wb.fields.value
      await wb.loadSheetMeta('s1')
      expect(wb.fields.value).toBe(fieldsRef)

      fields = [
        { id: 'fld_title', name: 'Title', type: 'string' },
        { id: 'fld_qty', name: 'Qty', type: 'number' },
      ]
      expect(await wb.loadSheetMeta('s1')).toBe(true)

      expect(wb.fields.value).not.toBe(fieldsRef)
      expect(wb.fields.value).toEqual([
        { id: 'fld_title', name: 'Title', type: 'string' },
        { id: 'fld_qty', name: 'Qty', type: 'number' },
      ])
    })

    it('never skips when the requested sheet differs, even if that sheet answers with the same shape', async () => {
      const fetchFn = vi.fn(async (input: string) => {
        const sheetId = input.includes('s2') ? 's2' : 's1'
        if (input.startsWith('/api/multitable/fields')) {
          return new Response(JSON.stringify({ ok: true, data: { fields: [{ id: 'fld_title', name: 'Title', type: 'string' }] } }), { status: 200 })
        }
        if (input.startsWith('/api/multitable/context')) {
          return new Response(JSON.stringify({
            ok: true,
            data: {
              sheet: { id: sheetId, baseId: 'base_ops', name: sheetId, description: null },
              sheets: [
                { id: 's1', baseId: 'base_ops', name: 's1', description: null },
                { id: 's2', baseId: 'base_ops', name: 's2', description: null },
              ],
              views: [{ id: sheetId + '_view', sheetId, name: 'Grid', type: 'grid' }],
            },
          }), { status: 200 })
        }
        throw new Error('Unexpected request: ' + input)
      })
      const client = new MultitableApiClient({ fetchFn })
      const wb = useMultitableWorkbench({ client })

      await wb.loadSheetMeta('s1')
      const fieldsRef = wb.fields.value
      await wb.loadSheetMeta('s2')

      expect(wb.activeSheetId.value).toBe('s2')
      expect(wb.activeViewId.value).toBe('s2_view')
      expect(wb.fields.value).not.toBe(fieldsRef)
    })

    // The fingerprint folded `undefined` into `null`, so a key flipping between the two read as
    // "unchanged" and the skip swallowed it. Unreachable through the JSON-parsing production client,
    // reachable through any injected one (this test, a future embed host).
    it('does not confuse an undefined field property with an explicit null', async () => {
      let description: string | null | undefined = null
      const context = {
        base: { id: 'base_ops', name: 'Ops Base' },
        sheet: { id: 's1', baseId: 'base_ops', name: 'Orders', description: null },
        sheets: [{ id: 's1', baseId: 'base_ops', name: 'Orders', description: null }],
        views: [{ id: 'v1', sheetId: 's1', name: 'Grid', type: 'grid' }],
        fieldPermissions: {},
        viewPermissions: {},
        personalOverrideViewIds: [],
      }
      const client = {
        listFields: vi.fn(async () => ({
          fields: [{ id: 'fld_title', name: 'Title', type: 'string', description }],
        })),
        loadContext: vi.fn(async () => context),
      } as unknown as MultitableApiClient
      const wb = useMultitableWorkbench({ client, initialViewId: 'v1' })

      await wb.loadSheetMeta('s1')
      const fieldsRef = wb.fields.value
      await wb.loadSheetMeta('s1')
      expect(wb.fields.value).toBe(fieldsRef)

      description = undefined
      expect(await wb.loadSheetMeta('s1')).toBe(true)
      expect(wb.fields.value).not.toBe(fieldsRef)
    })

    // The skip is keyed on the payload AND on a fingerprint of the state that payload produced.
    // Everything else that writes these refs — a dialog assigning wb.fields.value optimistically,
    // selectView, loadBaseContext, restoreSnapshot — moves the state out from under the recorded
    // fingerprint without touching the record itself. With only the payload half, the very next
    // poll would read "same answer as last time" and skip, and the workbench would stay desynced
    // from the server answer it just fetched, for as long as that answer keeps coming back the
    // same (i.e. forever on an idle sheet). These three cases pin the state half.
    it('re-applies an identical payload after the fields ref was written directly', async () => {
      const fields = [
        { id: 'fld_title', name: 'Title', type: 'string' },
        { id: 'fld_qty', name: 'Qty', type: 'number' },
      ]
      const fetchFn = metaFetch(() => fields)
      const client = new MultitableApiClient({ fetchFn })
      const wb = useMultitableWorkbench({ client, initialViewId: 'v1' })

      expect(await wb.loadSheetMeta('s1')).toBe(true)
      const appliedFields = wb.fields.value
      expect(await wb.loadSheetMeta('s1')).toBe(true)
      // Baseline: an unchanged payload on unchanged state is still skipped.
      expect(wb.fields.value).toBe(appliedFields)

      wb.fields.value = wb.fields.value.filter((field) => field.id !== 'fld_qty')
      const writtenDirectly = wb.fields.value
      expect(writtenDirectly).toHaveLength(1)

      expect(await wb.loadSheetMeta('s1')).toBe(true)
      expect(wb.fields.value).not.toBe(writtenDirectly)
      expect(wb.fields.value.map((field) => field.id)).toEqual(['fld_title', 'fld_qty'])
    })

    it('re-applies an identical payload after selectView moved the active view', async () => {
      const fetchFn = metaFetch(
        () => [{ id: 'fld_title', name: 'Title', type: 'string' }],
        () => [
          { id: 'v1', sheetId: 's1', name: 'Grid', type: 'grid' },
          { id: 'v2', sheetId: 's1', name: 'Kanban', type: 'kanban' },
        ],
      )
      const client = new MultitableApiClient({ fetchFn })
      const wb = useMultitableWorkbench({ client, initialViewId: 'v1' })

      expect(await wb.loadSheetMeta('s1')).toBe(true)
      const viewsRef = wb.views.value
      expect(await wb.loadSheetMeta('s1')).toBe(true)
      expect(wb.views.value).toBe(viewsRef)

      wb.selectView('v2')
      expect(wb.activeViewId.value).toBe('v2')

      // Asking for v1 again: sheetId, viewId and payload all match what was recorded, so the state
      // half is the only thing that can notice activeViewId drifted away in between. (A keep-alive
      // poll with no viewId opt would carry requestedViewId 'v2' and be caught by the viewId half
      // instead — this is the case that half cannot see.)
      expect(await wb.loadSheetMeta('s1', { viewId: 'v1' })).toBe(true)
      expect(wb.activeViewId.value).toBe('v1')
      expect(wb.views.value).not.toBe(viewsRef)
    })

    // restoreSnapshot() is not part of the composable's public surface (its only caller is
    // syncExternalContext's rollback, which restores content-identical state, so the clause is not
    // observable through it) — loadBaseContext is the public sibling write path, same hazard.
    it('re-applies an identical payload after loadBaseContext rewrote the state', async () => {
      const sheetContext = {
        base: { id: 'base_ops', name: 'Ops Base' },
        sheet: { id: 's1', baseId: 'base_ops', name: 'Orders', description: null },
        sheets: [{ id: 's1', baseId: 'base_ops', name: 'Orders', description: null }],
        views: [{ id: 'v1', sheetId: 's1', name: 'Grid', type: 'grid' }],
        fieldPermissions: {},
        viewPermissions: {},
        personalOverrideViewIds: [],
      }
      const baseContext = {
        ...sheetContext,
        sheets: [
          { id: 's1', baseId: 'base_ops', name: 'Orders', description: null },
          { id: 's2', baseId: 'base_ops', name: 'Invoices', description: null },
        ],
      }
      const client = {
        listFields: vi.fn(async () => ({ fields: [{ id: 'fld_title', name: 'Title', type: 'string' }] })),
        loadContext: vi.fn(async (params: { baseId?: string; sheetId?: string }) => (
          params.baseId ? baseContext : sheetContext
        )),
      } as unknown as MultitableApiClient
      const wb = useMultitableWorkbench({ client, initialViewId: 'v1' })

      expect(await wb.loadSheetMeta('s1')).toBe(true)
      const fieldsRef = wb.fields.value
      expect(await wb.loadSheetMeta('s1')).toBe(true)
      expect(wb.fields.value).toBe(fieldsRef)

      expect(await wb.loadBaseContext('base_ops')).toBe(true)
      expect(wb.sheets.value.map((sheet) => sheet.id)).toEqual(['s1', 's2'])

      expect(await wb.loadSheetMeta('s1')).toBe(true)
      expect(wb.sheets.value.map((sheet) => sheet.id)).toEqual(['s1'])
    })
  })
})
