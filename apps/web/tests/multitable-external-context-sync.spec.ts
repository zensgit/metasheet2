// #5750: the embedding host re-sends the SAME external context (mt:navigate / the
// external-context-result echo) on a timer -- roughly once a second. Every repeat used to walk the
// whole chain again:
//   requestExternalContextSync -> applyExternalContext -> useMultitableWorkbench.syncExternalContext
//     -> switchBase/loadBaseContext | loadSheetMeta -> client.loadContext + client.listFields
// because none of the guards on that path could recognise the repeat: the loaded CONTEXT, not the
// caller, decides the active triple (syncContextState overwrites activeBaseId with
// ctx.base.id / ctx.sheet.baseId and falls activeViewId back to views[0]), so the state never equals
// what the caller asked for.
//
// These tests drive the REAL composable with a counting fake fetch, so "refetch loop" is measured in
// HTTP calls rather than in spy calls on a mock of the very code under test.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocale } from '../src/composables/useLocale'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableWorkbench } from '../src/multitable/composables/useMultitableWorkbench'

const CAPS = {
  canRead: true,
  canCreateRecord: true,
  canEditRecord: true,
  canDeleteRecord: false,
  canManageFields: false,
  canManageSheetAccess: false,
  canManageViews: false,
  canComment: true,
  canManageAutomation: false,
  canExport: true,
}

// How many times the host re-sends the identical context after the first load.
const HOST_RESENDS = 5

function json(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200 })
}

// Fake /api/multitable/context + /api/multitable/fields. `contextBaseId` is what the server echoes
// back as ctx.base.id / ctx.sheet.baseId (the repo's own /context resolver answers with the base
// that OWNS the sheet, whatever the caller spelled), and `viewIds` is the sheet's view catalogue --
// both are what syncContextState() writes into activeBaseId / activeViewId.
function makeClient(opts: { contextBaseId: string; sheetId: string; viewIds: string[] }) {
  const counters = { context: 0, fields: 0 }
  const fetchFn = vi.fn(async (input: string) => {
    if (input.startsWith('/api/multitable/context')) {
      counters.context += 1
      return json({
        base: { id: opts.contextBaseId, name: 'Ops Base' },
        sheet: { id: opts.sheetId, baseId: opts.contextBaseId, name: 'Orders', description: null },
        sheets: [{ id: opts.sheetId, baseId: opts.contextBaseId, name: 'Orders', description: null }],
        views: opts.viewIds.map((id) => ({
          id,
          sheetId: opts.sheetId,
          name: id,
          type: 'grid',
          filterInfo: {},
          sortInfo: {},
          groupInfo: {},
          hiddenFieldIds: [],
          config: {},
        })),
        capabilities: CAPS,
        capabilityOrigin: null,
        fieldPermissions: {},
        viewPermissions: {},
        personalOverrideViewIds: [],
      })
    }
    if (input.startsWith('/api/multitable/fields')) {
      counters.fields += 1
      return json({ fields: [{ id: 'fld_title', name: 'Title', type: 'string' }] })
    }
    throw new Error(`Unexpected request: ${input}`)
  })
  return { client: new MultitableApiClient({ fetchFn }), counters }
}

describe('#5750 external context sync converges on identical host re-sends', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })

  it('converges when the requested base id equals the context base id and the view exists', async () => {
    const { client, counters } = makeClient({ contextBaseId: 'base_ops', sheetId: 'sheet_orders', viewIds: ['view_grid'] })
    const wb = useMultitableWorkbench({ client })

    for (let i = 0; i < HOST_RESENDS; i += 1) {
      expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })).toBe(true)
    }

    expect(counters.context).toBe(1)
    expect(counters.fields).toBe(1)
    expect(wb.activeBaseId.value).toBe('base_ops')
    expect(wb.activeSheetId.value).toBe('sheet_orders')
    expect(wb.activeViewId.value).toBe('view_grid')
  })

  it('converges when the requested base id is spelled differently from the context base id', async () => {
    const { client, counters } = makeClient({ contextBaseId: 'base_ops', sheetId: 'sheet_orders', viewIds: ['view_grid'] })
    const wb = useMultitableWorkbench({ client })

    for (let i = 0; i < HOST_RESENDS; i += 1) {
      expect(await wb.syncExternalContext({ baseId: 'base-ops-slug', sheetId: 'sheet_orders', viewId: 'view_grid' })).toBe(true)
    }

    // switchBase() compares the REQUESTED base id against activeBaseId, which syncContextState has
    // already overwritten with the context's own id -- so its early return can never fire here.
    expect(wb.activeBaseId.value).toBe('base_ops')
    expect(counters.context).toBe(1)
    expect(counters.fields).toBe(1)
  })

  it('converges when the requested view id is not in the context views (stale/deleted view in the URL)', async () => {
    const { client, counters } = makeClient({ contextBaseId: 'base_ops', sheetId: 'sheet_orders', viewIds: ['view_grid'] })
    const wb = useMultitableWorkbench({ client })

    for (let i = 0; i < HOST_RESENDS; i += 1) {
      expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_dead' })).toBe(true)
    }

    expect(wb.activeViewId.value).toBe('view_grid')
    expect(counters.context).toBe(1)
    expect(counters.fields).toBe(1)
  })

  it('converges on the sheet path (no base id) when the requested view id is stale', async () => {
    const { client, counters } = makeClient({ contextBaseId: 'base_ops', sheetId: 'sheet_orders', viewIds: ['view_grid'] })
    const wb = useMultitableWorkbench({ client, initialSheetId: 'sheet_orders' })

    for (let i = 0; i < HOST_RESENDS; i += 1) {
      expect(await wb.syncExternalContext({ sheetId: 'sheet_orders', viewId: 'view_dead' })).toBe(true)
    }

    // #5743's lastAppliedSheetMeta guard does not cover this: loadSheetMeta issues BOTH requests
    // before comparing, so without the sync-level memo every repeat still burned two HTTP calls.
    expect(wb.activeViewId.value).toBe('view_grid')
    expect(counters.context).toBe(1)
    expect(counters.fields).toBe(1)
  })

  it('converges on the sheet path (no base id) when the requested view id is live', async () => {
    const { client, counters } = makeClient({ contextBaseId: 'base_ops', sheetId: 'sheet_orders', viewIds: ['view_grid'] })
    const wb = useMultitableWorkbench({ client, initialSheetId: 'sheet_orders' })

    for (let i = 0; i < HOST_RESENDS; i += 1) {
      expect(await wb.syncExternalContext({ sheetId: 'sheet_orders', viewId: 'view_grid' })).toBe(true)
    }

    expect(counters.context).toBe(1)
    expect(counters.fields).toBe(1)
  })

  it('converges when the requested sheet is the system people sheet the workbench refuses to activate', async () => {
    const counters = { context: 0, fields: 0 }
    const fetchFn = vi.fn(async (input: string) => {
      if (input.startsWith('/api/multitable/context')) {
        counters.context += 1
        return json({
          base: { id: 'base_ops', name: 'Ops Base' },
          sheet: { id: 'sheet_people', baseId: 'base_ops', name: 'People', description: '__metasheet_system:people__' },
          sheets: [
            { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
            { id: 'sheet_people', baseId: 'base_ops', name: 'People', description: '__metasheet_system:people__' },
          ],
          views: [{ id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' }],
          capabilities: CAPS,
          capabilityOrigin: null,
          fieldPermissions: {},
          viewPermissions: {},
          personalOverrideViewIds: [],
        })
      }
      if (input.startsWith('/api/multitable/fields')) {
        counters.fields += 1
        return json({ fields: [] })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const wb = useMultitableWorkbench({ client: new MultitableApiClient({ fetchFn }) })

    for (let i = 0; i < HOST_RESENDS; i += 1) {
      expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_people', viewId: 'view_grid' })).toBe(true)
    }

    // syncContextState refuses to activate the system people sheet and falls back to the first
    // visible sheet, so the active sheet can never equal the requested one either.
    expect(wb.activeSheetId.value).toBe('sheet_orders')
    expect(counters.context).toBe(1)
    expect(counters.fields).toBe(1)
  })

  it('does NOT memoize a FAILED sync: a repeat is the only recovery path for a transient error', async () => {
    const counters = { context: 0 }
    let forbidden = true
    const fetchFn = vi.fn(async (input: string) => {
      if (input.startsWith('/api/multitable/context')) {
        counters.context += 1
        if (forbidden) {
          return new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } }), { status: 403 })
        }
        return json({
          base: { id: 'base_ops', name: 'Ops Base' },
          sheet: { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
          sheets: [{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }],
          views: [{ id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' }],
          capabilities: CAPS,
          capabilityOrigin: null,
          fieldPermissions: {},
          viewPermissions: {},
          personalOverrideViewIds: [],
        })
      }
      if (input.startsWith('/api/multitable/fields')) return json({ fields: [] })
      throw new Error(`Unexpected request: ${input}`)
    })
    const wb = useMultitableWorkbench({ client: new MultitableApiClient({ fetchFn }) })

    expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })).toBe(false)
    expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })).toBe(false)
    expect(counters.context).toBe(2)
    expect(wb.error.value).toBeTruthy()

    forbidden = false
    expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })).toBe(true)
    expect(counters.context).toBe(3)
    expect(wb.activeViewId.value).toBe('view_grid')

    // ...and once it succeeded, the identical repeat converges like every other case above.
    expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })).toBe(true)
    expect(counters.context).toBe(3)
  })

  it('still fetches a genuinely different context, and converges on that one too', async () => {
    const { client, counters } = makeClient({ contextBaseId: 'base_ops', sheetId: 'sheet_orders', viewIds: ['view_grid', 'view_board'] })
    const wb = useMultitableWorkbench({ client })

    await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    expect(counters.context).toBe(1)

    await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_board' })
    expect(counters.context).toBe(2)
    expect(wb.activeViewId.value).toBe('view_board')

    await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_board' })
    expect(counters.context).toBe(2)
  })

  it('re-fetches an identical request once another writer moved the workbench away', async () => {
    const { client, counters } = makeClient({ contextBaseId: 'base_ops', sheetId: 'sheet_orders', viewIds: ['view_grid', 'view_board'] })
    const wb = useMultitableWorkbench({ client })

    await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    expect(counters.context).toBe(1)

    // The memo records the state the sync PRODUCED, so any other writer invalidates it.
    wb.selectView('view_board')
    expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })).toBe(true)
    expect(counters.context).toBe(2)
    expect(wb.activeViewId.value).toBe('view_grid')
  })
})
