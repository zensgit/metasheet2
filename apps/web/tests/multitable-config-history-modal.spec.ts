// @vitest-environment jsdom
/**
 * T9-R4 — MetaConfigHistoryModal: the dedicated config-history view. The server gates per entity type (R3); the FE
 * is a FAITHFUL CLIENT — it renders exactly the items the server returned and never filters for security. The
 * entity-type filter only emits a re-fetch (server re-applies the gate). Mounted via createApp + jsdom (Teleport).
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'

import MetaConfigHistoryModal from '../src/multitable/components/MetaConfigHistoryModal.vue'
import type { MetaConfigRevision } from '../src/multitable/api/client'

const rev = (over: Partial<MetaConfigRevision>): MetaConfigRevision => ({
  id: 'r1', entityType: 'field', entityId: 'fld_1', action: 'create', before: null, after: { name: 'X' },
  changedKeys: [], batchId: null, actorId: 'u1', createdAt: '2026-06-24T00:00:00Z', ...over,
})

type Props = {
  visible: boolean; items: MetaConfigRevision[]; loading: boolean; entityType: string
  recordLabelOf: (id: string) => string; isZh: boolean; onClose: () => void; onFilterChange: (t: string) => void
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
