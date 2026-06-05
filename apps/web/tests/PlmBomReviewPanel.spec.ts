import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'

const getContextMock = vi.fn()
vi.mock('../src/services/integration/workbench', () => ({
  getPlmBomMultitableContext: (...args: unknown[]) => getContextMock(...args),
}))

import PlmBomReviewPanel from '../src/components/plm/PlmBomReviewPanel.vue'

const CONTEXT = {
  part: { part_id: 'P1', item_number: 'P-001', name: 'Assembly', state: 'Released', generation: 3 },
  lines: [
    { bom_line_id: 'R1', part_id: 'C1', item_number: 'C-001', name: 'Bracket', state: 'Draft', generation: 1, quantity: 2, uom: 'EA', find_num: '10', refdes: 'R1,R2', level: 1, path: ['P1'], path_labels: ['P-001'], source_version: 1, source_updated_at: '2026-06-05T00:00:00', sync_status: 'snapshot' },
    { bom_line_id: 'R2', part_id: 'D1', item_number: 'D-001', name: 'Screw', state: 'Released', generation: 2, quantity: 4, uom: 'EA', find_num: '20', refdes: 'R3', level: 2, path: ['P1', 'C1'], path_labels: ['P-001', 'C-001'], source_version: 2, source_updated_at: '2026-06-05T00:00:00', sync_status: 'snapshot' },
  ],
  source_version: 3,
  source_updated_at: '2026-06-05T00:00:00',
  sync_status: 'snapshot',
  template_key: 'bom_review',
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

let app: VueApp | null = null
let container: HTMLDivElement

function mountPanel(dataSourceId = 'plm-ds'): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(PlmBomReviewPanel, { dataSourceId })
  app.mount(container)
}

function stateOf(): string | null {
  return container.querySelector('[data-testid="plm-bom-review-state"]')?.getAttribute('data-state') ?? null
}

async function setPartAndLoad(partId: string): Promise<void> {
  const input = container.querySelector('[data-testid="plm-bom-review-part-input"]') as HTMLInputElement
  input.value = partId
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushUi()
  ;(container.querySelector('[data-testid="plm-bom-review-load"]') as HTMLButtonElement).click()
  await flushUi()
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  getContextMock.mockReset()
})

describe('PlmBomReviewPanel (P3-C read-only BOM review)', () => {
  it('is idle and does NOT call the service on mount', async () => {
    mountPanel()
    await flushUi()
    expect(getContextMock).not.toHaveBeenCalled()
    expect(stateOf()).toBe('idle')
  })

  it('loads + renders the read-only table with stable row keys, hierarchy, qty + provenance', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: CONTEXT })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')

    expect(getContextMock).toHaveBeenCalledWith('plm-ds', 'P1')
    expect(stateOf()).toBe('table')
    const rows = container.querySelectorAll('[data-testid="plm-bom-review-row"]')
    expect(rows.length).toBe(2)
    // bom_line_id is the STABLE row key; level encodes the hierarchy
    expect((rows[0] as HTMLElement).dataset.bomLineId).toBe('R1')
    expect((rows[1] as HTMLElement).dataset.bomLineId).toBe('R2')
    expect((rows[1] as HTMLElement).dataset.level).toBe('2')
    // quantity + uom and the source provenance timestamp render
    expect(container.textContent).toContain('2 EA')
    expect(container.textContent).toContain('2026-06-05T00:00:00')
  })

  it('shows the upgrade affordance (no table) when supported but not entitled', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: false, context: null })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    expect(stateOf()).toBe('upgrade')
    expect(container.querySelector('[data-testid="plm-bom-review-row"]')).toBeNull()
  })

  it('degrades to unavailable when the relay reports no support (old PLM)', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: false, reason: 'unsupported' })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    expect(stateOf()).toBe('unavailable')
  })

  it('shows empty state when entitled but the context is null (part not found)', async () => {
    getContextMock.mockResolvedValue({ data_source_id: 'plm-ds', available: true, entitled: true, context: null })
    mountPanel()
    await flushUi()
    await setPartAndLoad('P1')
    expect(stateOf()).toBe('empty')
  })
})
