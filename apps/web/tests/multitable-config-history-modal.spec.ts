// @vitest-environment jsdom
/**
 * T9-R4 — MetaConfigHistoryModal: the dedicated config-history view. The server gates per entity type (R3); the FE
 * is a FAITHFUL CLIENT — it renders exactly the items the server returned and never filters for security. The
 * entity-type filter only emits a re-fetch (server re-applies the gate). Mounted via createApp + jsdom (Teleport).
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'

import MetaConfigHistoryModal from '../src/multitable/components/MetaConfigHistoryModal.vue'
import { MultitableApiClient, type MetaConfigRevision, type ConfigRestorePreview } from '../src/multitable/api/client'

const previewOf = (over: Partial<ConfigRestorePreview>): ConfigRestorePreview => ({
  revisionId: 'a', entityType: 'field', entityId: 'fld_1', changedKeys: ['name'],
  current: { name: 'New' }, target: { name: 'Old' }, driftConflict: false, opKind: 'safe', baselineHash: 'h1', previewToken: 'tok1', ...over,
})

const rev = (over: Partial<MetaConfigRevision>): MetaConfigRevision => ({
  id: 'r1', entityType: 'field', entityId: 'fld_1', action: 'create', before: null, after: { name: 'X' },
  changedKeys: [], batchId: null, actorId: 'u1', createdAt: '2026-06-24T00:00:00Z', ...over,
})

type Props = {
  visible: boolean; items: MetaConfigRevision[]; loading: boolean; entityType: string
  recordLabelOf: (id: string) => string; isZh: boolean; onClose: () => void; onFilterChange: (t: string) => void
  previewRevert?: (id: string) => Promise<ConfigRestorePreview>; executeRevert?: (id: string, h: string) => Promise<void>; onReverted?: () => void
}
const mounted: Array<{ unmount: () => void }> = []
function mountModal(over: Partial<Props>) {
  const props: Props = {
    visible: true, items: [], loading: false, entityType: '', recordLabelOf: (id) => `name:${id}`, isZh: false,
    onClose: vi.fn(), onFilterChange: vi.fn(), ...over,
  }
  const app = createApp(MetaConfigHistoryModal, props as unknown as Record<string, unknown>)
  const c = document.createElement('div'); document.body.appendChild(c); app.mount(c); mounted.push(app); return props
}
const q = (s: string) => document.body.querySelector(s) as HTMLElement | null
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }
const waitUntil = async (pred: () => boolean, tries = 100): Promise<void> => {
  for (let i = 0; i < tries; i++) {
    if (pred()) return
    await flush()
  }
  throw new Error('waitUntil: condition not met in time')
}
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); document.body.innerHTML = '' })

describe('MetaConfigHistoryModal — T9-R4 config-history view', () => {
  it('renders the server revisions FAITHFULLY (action, entity, changed before→after) — no client-side filtering', async () => {
    mountModal({ items: [
      rev({ id: 'a', entityType: 'field', entityId: 'fld_1', action: 'update', changedKeys: ['name'], before: { name: 'Old' }, after: { name: 'New' } }),
      rev({ id: 'b', entityType: 'view', entityId: 'view_1', action: 'create' }),
    ] })
    await nextTick()
    expect(q('[data-test="config-history-list"]')).toBeTruthy()
    expect(document.body.textContent).toContain('name:fld_1') // recordLabelOf resolved
    expect(document.body.textContent).toContain('Old') // before
    expect(document.body.textContent).toContain('New') // after
    expect(document.body.querySelectorAll('.cfg-history__row').length).toBe(2) // BOTH rendered — the FE doesn't drop rows
  })

  it('renders config objects as a compact k: v summary, not a raw JSON blob (diff-rendering depth)', async () => {
    mountModal({ items: [
      rev({
        id: 'a',
        entityType: 'permission',
        entityId: 'fld_1',
        action: 'update',
        changedKeys: ['grant'],
        before: { grant: { visible: true, readOnly: false } },
        after: { grant: { visible: false, readOnly: true } },
      }),
    ] })
    await nextTick()
    expect(document.body.textContent).toContain('visible: false, readOnly: true')
    expect(document.body.textContent).not.toContain('{"visible"')
  })

  it('the entity-type filter EMITS filter-change (server re-fetches; the FE never client-filters for security)', async () => {
    const props = mountModal({ items: [rev({})] })
    await nextTick()
    ;(q('[data-test="config-history-filter-view"]') as HTMLButtonElement).click()
    expect(props.onFilterChange).toHaveBeenCalledWith('view')
    // the list still shows the (unchanged) items — filtering is the server's job on the next load, not a client cull
    expect(document.body.querySelectorAll('.cfg-history__row').length).toBe(1)
  })

  it('shows the loading state', async () => {
    mountModal({ loading: true }); await nextTick()
    expect(q('[data-test="config-history-loading"]')).toBeTruthy()
    expect(q('[data-test="config-history-list"]')).toBeFalsy()
  })

  it('shows the empty state when the server returns nothing (e.g. an actor who manages no config)', async () => {
    mountModal({ items: [] }); await nextTick()
    expect(q('[data-test="config-history-empty"]')).toBeTruthy()
  })

  it('close emits close', async () => {
    const props = mountModal({ items: [rev({})] }); await nextTick()
    ;(q('.cfg-history__close') as HTMLButtonElement).click()
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})

describe('MetaConfigHistoryModal — T9-W revert action (server-gated, FE renders the decision)', () => {
  const updateRev = () => rev({ id: 'a', action: 'update', changedKeys: ['name'], before: { name: 'Old' }, after: { name: 'New' } })

  it('no revert button when previewRevert is not provided (read-only mode)', async () => {
    mountModal({ items: [updateRev()] }); await nextTick()
    expect(q('[data-test="config-history-revert"]')).toBeFalsy()
  })

  it('SAFE: revert → preview → confirm → executeRevert(id, previewToken) + reverted emitted', async () => {
    const previewRevert = vi.fn(async () => previewOf({}))
    const executeRevert = vi.fn(async () => {})
    const onReverted = vi.fn()
    mountModal({ items: [updateRev()], previewRevert, executeRevert, onReverted })
    await nextTick()
    ;(q('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await flush()
    expect(previewRevert).toHaveBeenCalledWith('a')
    expect(q('[data-test="config-restore-confirm"]')).toBeTruthy()
    expect(document.body.textContent).toContain('Old') // target
    ;(q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).click()
    await flush()
    expect(executeRevert).toHaveBeenCalledWith('a', 'tok1') // the server-minted previewToken, NOT a client hash
    expect(onReverted).toHaveBeenCalledTimes(1)
  })

  it('GATED: the server says opKind=gated → shows the reason, NO confirm button (FE renders, never overrides)', async () => {
    const previewRevert = vi.fn(async () => previewOf({ opKind: 'gated', gatedReason: 'field type reverts are not supported in this slice' }))
    mountModal({ items: [updateRev()], previewRevert, executeRevert: vi.fn() })
    await nextTick(); (q('[data-test="config-history-revert"]') as HTMLButtonElement).click(); await flush()
    expect(q('[data-test="config-restore-gated"]')).toBeTruthy()
    expect(document.body.textContent).toContain('not supported')
    expect(q('[data-test="config-restore-confirm-btn"]')).toBeFalsy()
  })

  it('DRIFT: the server flags driftConflict → warning shown + confirm disabled', async () => {
    const previewRevert = vi.fn(async () => previewOf({ driftConflict: true }))
    mountModal({ items: [updateRev()], previewRevert, executeRevert: vi.fn() })
    await nextTick(); (q('[data-test="config-history-revert"]') as HTMLButtonElement).click(); await flush()
    expect(q('[data-test="config-restore-drift"]')).toBeTruthy()
    expect((q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('END-TO-END wire: Revert button → real client → config-restore-preview then -execute with the SERVER previewToken', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('config-restore-preview')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            preview: {
              revisionId: 'a',
              entityType: 'field',
              entityId: 'fld_1',
              changedKeys: ['name'],
              current: { name: 'New' },
              target: { name: 'Old' },
              driftConflict: false,
              opKind: 'safe',
              baselineHash: 'h-server',
            },
            previewToken: 'server-token-xyz',
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, data: { restored: { revisionId: 'a' } } }), { status: 200 })
    })
    const client = new MultitableApiClient({ fetchFn })
    const onReverted = vi.fn()
    mountModal({
      items: [updateRev()],
      onReverted,
      previewRevert: (id: string) => client.getConfigRestorePreview('sheet_1', id),
      executeRevert: (id: string, token: string) => client.executeConfigRestore('sheet_1', id, token),
    })
    await nextTick()
    ;(q('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await waitUntil(() => !!q('[data-test="config-restore-confirm-btn"]'))
    ;(q('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).click()
    await waitUntil(() => fetchFn.mock.calls.length >= 2 && onReverted.mock.calls.length >= 1)

    expect(fetchFn.mock.calls[0][0]).toContain('/config-restore-preview')
    expect(fetchFn.mock.calls[1][0]).toContain('/config-restore-execute')
    const execBody = JSON.parse((fetchFn.mock.calls[1][1] as RequestInit).body as string)
    expect(execBody.previewToken).toBe('server-token-xyz')
    expect(execBody.baselineHash).toBeUndefined()
    expect(onReverted).toHaveBeenCalledTimes(1)
  })
})

describe('getConfigHistory — T9-R3↔R4 wire (drift lock)', () => {
  it('round-trips the REAL R3 {ok,data:{items}} envelope (not a fixture) — never silently returns []', async () => {
    // The R3↔R4 seam is drift-prone (cf. dayIndex). R3 returns { ok, data: { items, limit, offset } }; the client's
    // parseJson unwraps .data, so getConfigHistory reads .items off the unwrapped body. Assert against a real-shaped
    // envelope so a future envelope change can't make getConfigHistory always-empty while every isolated test stays green.
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { items: [
        { id: 'cr_1', entityType: 'field', entityId: 'fld_1', action: 'update', before: { name: 'A' }, after: { name: 'B' }, changedKeys: ['name'], batchId: null, actorId: 'u1', createdAt: '2026-06-24T00:00:00Z' },
      ], limit: 50, offset: 0 },
    }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    const items = await client.getConfigHistory('sheet_1', { entityType: 'field' })

    expect(items).toHaveLength(1) // NOT [] — the envelope was unwrapped
    expect(items[0].entityId).toBe('fld_1')
    expect(items[0].changedKeys).toEqual(['name'])
    expect(fetchFn).toHaveBeenCalledWith(expect.stringContaining('/api/multitable/sheets/sheet_1/config-history')) // GET passes the URL only
    expect(fetchFn.mock.calls[0][0]).toContain('entityType=field')
  })

  it('getConfigRestorePreview unwraps the REAL {ok,data:{preview}} envelope (not a fixture)', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { preview: { revisionId: 'a', entityType: 'field', entityId: 'fld_1', changedKeys: ['name'], current: { name: 'New' }, target: { name: 'Old' }, driftConflict: false, opKind: 'safe', baselineHash: 'h1' }, previewToken: 'tok1' },
    }), { status: 200 }))
    const client = new MultitableApiClient({ fetchFn })

    const preview = await client.getConfigRestorePreview('sheet_1', 'a')

    expect(preview.baselineHash).toBe('h1') // unwrapped — NOT undefined
    expect(preview.previewToken).toBe('tok1') // the server token folded in — the execute wire depends on it
    expect(preview.target).toEqual({ name: 'Old' })
    expect(preview.opKind).toBe('safe')
    expect(fetchFn.mock.calls[0][0]).toContain('/config-restore-preview')
  })
})
