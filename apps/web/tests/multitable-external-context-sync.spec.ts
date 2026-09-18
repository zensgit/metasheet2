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
// back as ctx.base.id / ctx.sheet.baseId, and `viewIds` is the sheet's view catalogue -- both are
// what syncContextState() writes into activeBaseId / activeViewId.
// NB on the base id: today's route (packages/core-backend/src/routes/univer-meta.ts, GET /context)
// keeps the caller's baseId verbatim and 403s when the requested sheet does not live in it, so a
// SUCCESSFUL answer whose base id differs from the requested one is not something the current
// server emits -- the divergence cases it really produces are the view fallback and the system
// people sheet below. The differently-spelled-base case is kept as a resolver-agnostic regression
// guard on the composable (the URL slug is caller data; nothing in this file may assume the server
// hands the active triple back unchanged).
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

// Two sheets in one base, with the /fields leg of the FIRST sheet held open on demand -- that is
// the window loadBaseContext leaves between applying the context and resolving.
function makeRaceClient() {
  const counters = { context: 0, fields: 0 }
  const sheets = [
    { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
    { id: 'sheet_deals', baseId: 'base_ops', name: 'Deals', description: null },
  ]
  let release: ((value: unknown) => void) | null = null
  const fetchFn = vi.fn(async (input: string) => {
    if (input.startsWith('/api/multitable/context')) {
      counters.context += 1
      const sheetId = /sheetId=([^&]*)/.exec(input)?.[1] ?? 'sheet_orders'
      const viewId = sheetId === 'sheet_orders' ? 'view_grid' : 'view_deals'
      return json({
        base: { id: 'base_ops', name: 'Ops Base' },
        sheet: sheets.find((sheet) => sheet.id === sheetId),
        sheets,
        views: [{ id: viewId, sheetId, name: viewId, type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [], config: {} }],
        capabilities: CAPS,
        capabilityOrigin: null,
        fieldPermissions: {},
        viewPermissions: {},
        personalOverrideViewIds: [],
      })
    }
    if (input.startsWith('/api/multitable/fields')) {
      counters.fields += 1
      if (input.includes('sheetId=sheet_orders') && !release) {
        await new Promise((resolve) => { release = resolve })
      }
      return json({ fields: [{ id: 'fld_title', name: 'Title', type: 'string' }] })
    }
    throw new Error(`Unexpected request: ${input}`)
  })
  return {
    client: new MultitableApiClient({ fetchFn }),
    counters,
    releaseFields: {
      pending: () => !!release,
      flush: () => { release?.(null) },
    },
  }
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

  // Resolver-agnostic guard (see the note on makeClient): if a /context answer ever resolves the
  // caller's base id to a different one, the repeat must still converge rather than loop.
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

  // #5750 review: the memo must record what THIS sync applied, not whatever happens to be on
  // screen when it finally returns. Context and fields apply atomically; a rail click or a second
  // host navigation during the fields request supersedes the first request. The cancelled request
  // must not memoize the newer writer's state as its own successful result.
  it('does not memoize a state another writer produced while it was awaiting (rail click mid-sync)', async () => {
    const { client, counters, releaseFields } = makeRaceClient()
    const wb = useMultitableWorkbench({ client })

    // 1) host navigate -> Orders: /context lands, but /fields still prevents atomic application.
    const navigate = wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await vi.waitFor(() => expect(releaseFields.pending()).toBe(true))
    expect(wb.activeSheetId.value).toBe('')

    // 2) the user clicks another sheet in the rail while that /fields is open.
    wb.selectSheet('sheet_deals')
    await wb.loadSheetMeta('sheet_deals')
    expect(wb.activeSheetId.value).toBe('sheet_deals')

    // 3) the held /fields answers; the superseded sync reports false and preserves the rail click.
    releaseFields.flush()
    expect(await navigate).toBe(false)
    expect(wb.activeSheetId.value).toBe('sheet_deals')

    // 4) the host re-sends the SAME navigate: it must actually navigate, not report a memoized hit.
    const contextBefore = counters.context
    expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })).toBe(true)
    expect(wb.activeSheetId.value).toBe('sheet_orders')
    expect(counters.context).toBe(contextBefore + 1)

    // ...and from there it converges again.
    expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })).toBe(true)
    expect(counters.context).toBe(contextBefore + 1)
  })

  it('does not memoize a state a second overlapping sync produced', async () => {
    const { client, counters, releaseFields } = makeRaceClient()
    const wb = useMultitableWorkbench({ client })

    // Host navigate #1 -> Orders, its /fields leg still in flight...
    const first = wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })
    await vi.waitFor(() => expect(releaseFields.pending()).toBe(true))
    // ...while host navigate #2 -> Deals arrives and completes first.
    expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_deals', viewId: 'view_deals' })).toBe(true)
    expect(wb.activeSheetId.value).toBe('sheet_deals')
    releaseFields.flush()
    expect(await first).toBe(false)

    // Going back to #1's context has to re-fetch; #2's context stays memoized on its own terms.
    const contextBefore = counters.context
    expect(await wb.syncExternalContext({ baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' })).toBe(true)
    expect(wb.activeSheetId.value).toBe('sheet_orders')
    expect(counters.context).toBe(contextBefore + 1)
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
