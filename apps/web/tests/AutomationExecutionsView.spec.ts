import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import AutomationExecutionsView from '../src/views/AutomationExecutionsView.vue'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRunView } from '../src/multitable/types'

let mockIsAdmin = true
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ hasAdminAccess: () => mockIsAdmin }),
}))

const RUN_LIST: AutomationRunView = {
  id: 'axe_1',
  ruleId: 'rule-1',
  sheetId: 'sheet-a',
  status: 'resolved',
  statusLegacy: 'success',
  triggeredBy: 'event',
  triggeredAt: '2026-05-28T00:00:00.000Z',
  finishedAt: '2026-05-28T00:00:01.000Z',
  duration: 12,
  error: null,
  schemaVersion: 1,
  steps: [
    { id: 'axe_1:step:0', executionId: 'axe_1', stepKey: '0', status: 'resolved', upstreamJobId: null, result: { ok: true } },
    { id: 'axe_1:step:1', executionId: 'axe_1', stepKey: '1', status: 'failed', upstreamJobId: 'axe_1:step:0', error: 'boom' },
  ],
}
const RUN_DETAIL: AutomationRunView = {
  ...RUN_LIST,
  triggerEvent: { recordId: 'rec1', secret: 'Bearer abc.def.ghijklmnop12345' },
  ruleSnapshot: { id: 'rule-1', name: 'Notify' },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeClient(over: Record<string, any> = {}): any {
  return {
    listAutomationRuns: vi.fn().mockResolvedValue([RUN_LIST]),
    getAutomationRun: vi.fn().mockResolvedValue(RUN_DETAIL),
    ...over,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mount(client: any) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(AutomationExecutionsView, { client }) })
  app.mount(container)
  return { container, app }
}

// Flush pending microtasks (mock promise resolution) THEN the Vue render queue —
// the view fires loadData() at setup, so a bare nextTick can race the fetch.
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mounted: { container: HTMLElement; app: any } | null = null
beforeEach(() => {
  mockIsAdmin = true
  useLocale().setLocale('en')
})
afterEach(() => {
  if (mounted) {
    mounted.app.unmount()
    mounted.container.remove()
    mounted = null
  }
})

describe('AutomationExecutionsView (A3 admin runs view)', () => {
  it('lists runs with the C1 status label (success → resolved) for admins', async () => {
    const client = makeClient()
    mounted = mount(client)
    await settle()
    expect(client.listAutomationRuns).toHaveBeenCalled()
    expect(mounted.container.querySelector('[data-run-id="axe_1"]')).not.toBeNull()
    expect(mounted.container.querySelector('[data-status="resolved"]')).not.toBeNull()
    expect(mounted.container.textContent ?? '').toContain('resolved')
  })

  it('shows the admin-only notice and does NOT call the API when not admin', async () => {
    mockIsAdmin = false
    const client = makeClient()
    mounted = mount(client)
    await nextTick()
    expect(mounted.container.querySelector('[data-denied="true"]')).not.toBeNull()
    expect(client.listAutomationRuns).not.toHaveBeenCalled()
  })

  it('expanding a run fetches detail and renders C1 steps + redacted snapshot', async () => {
    const client = makeClient()
    mounted = mount(client)
    await settle()
    const row = mounted.container.querySelector('[data-run-id="axe_1"]') as HTMLElement
    row.click()
    await settle()
    expect(client.getAutomationRun).toHaveBeenCalledWith('axe_1')
    expect(mounted.container.querySelector('[data-detail="true"]')).not.toBeNull()
    expect(mounted.container.querySelector('[data-field="step-error"]')?.textContent ?? '').toContain('boom')
    const trigger = mounted.container.querySelector('[data-field="trigger-event"]')?.textContent ?? ''
    expect(trigger).toContain('rec1')
    // jsonView redacts secret-shaped values defensively
    expect(trigger).not.toContain('abc.def.ghijklmnop12345')
  })

  it('passes the status filter through to the API', async () => {
    const client = makeClient()
    mounted = mount(client)
    await settle()
    const select = mounted.container.querySelector('[data-field="statusFilter"]') as HTMLSelectElement
    select.value = 'failed'
    select.dispatchEvent(new Event('change'))
    ;(mounted.container.querySelector('[data-action="refresh"]') as HTMLElement).click()
    await settle()
    expect(client.listAutomationRuns).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }))
  })
})
