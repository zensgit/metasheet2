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

// A6-2: a suspended run — legacy status stays `running` (D2); the C1 job step carries the suspend
// descriptor with the resume token (admin-detail-only; used by the Resume button, never displayed).
const SUSPENDED_TOKEN = 'rt_secret_should_not_render_123'
const SUSPENDED_LIST: AutomationRunView = {
  ...RUN_LIST, id: 'axe_s', status: 'running', statusLegacy: 'running', finishedAt: null,
}
const SUSPENDED_DETAIL: AutomationRunView = {
  ...SUSPENDED_LIST,
  triggerEvent: { recordId: 'recS' },
  ruleSnapshot: { id: 'rule-1', name: 'Notify' },
  steps: [
    { id: 'axe_s:step:0', executionId: 'axe_s', stepKey: '0', status: 'resolved', upstreamJobId: null, result: {} },
    { id: 'axe_s:step:1', executionId: 'axe_s', stepKey: '1', status: 'suspended', upstreamJobId: 'axe_s:step:0', suspend: { reason: 'external_event', resumeToken: SUSPENDED_TOKEN } },
  ],
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

  it('shows the admin-only notice and does NOT call the API (list/detail/resume) when not admin', async () => {
    mockIsAdmin = false
    const client = makeClient({ resumeAutomation: vi.fn() })
    mounted = mount(client)
    await nextTick()
    expect(mounted.container.querySelector('[data-denied="true"]')).not.toBeNull()
    expect(client.listAutomationRuns).not.toHaveBeenCalled()
    expect(client.getAutomationRun).not.toHaveBeenCalled()
    // A6-2: no admin surface for a non-admin → resume is unreachable + never requested.
    expect(client.resumeAutomation).not.toHaveBeenCalled()
    expect(mounted.container.querySelector('[data-action="resume"]')).toBeNull()
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

  it('drops a STALE detail response when a newer run is expanded (out-of-order race)', async () => {
    const runA = { ...RUN_LIST, id: 'axe_A' }
    const runB = { ...RUN_LIST, id: 'axe_B' }
    const detailA = { ...RUN_DETAIL, id: 'axe_A', triggerEvent: { recordId: 'recA' } }
    const detailB = { ...RUN_DETAIL, id: 'axe_B', triggerEvent: { recordId: 'recB' } }
    const resolvers: Record<string, (v: AutomationRunView) => void> = {}
    const client = makeClient({
      listAutomationRuns: vi.fn().mockResolvedValue([runA, runB]),
      getAutomationRun: vi.fn(
        (id: string) => new Promise<AutomationRunView>((resolve) => { resolvers[id] = resolve }),
      ),
    })
    mounted = mount(client)
    await settle()
    // Expand A, then B before A's detail resolves (both fetches now in flight).
    ;(mounted.container.querySelector('[data-run-id="axe_A"]') as HTMLElement).click()
    await nextTick()
    ;(mounted.container.querySelector('[data-run-id="axe_B"]') as HTMLElement).click()
    await nextTick()
    // Resolve B (the current row) first, then A (now stale) LAST — out of order.
    resolvers['axe_B'](detailB)
    resolvers['axe_A'](detailA)
    await settle()
    // Detail must reflect B (current), never the stale A response that resolved last.
    const trigger = mounted.container.querySelector('[data-field="trigger-event"]')?.textContent ?? ''
    expect(trigger).toContain('recB')
    expect(trigger).not.toContain('recA')
  })

  it('A6-2: a suspended step shows a confirm-gated Resume → resumeAutomation(token) + reloads detail; token never rendered', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const client = makeClient({
      listAutomationRuns: vi.fn().mockResolvedValue([SUSPENDED_LIST]),
      getAutomationRun: vi.fn().mockResolvedValue(SUSPENDED_DETAIL),
      resumeAutomation: vi.fn().mockResolvedValue({ ...SUSPENDED_DETAIL, status: 'resolved', statusLegacy: 'success' }),
    })
    mounted = mount(client)
    await settle()
    expect(mounted.container.textContent ?? '').not.toContain(SUSPENDED_TOKEN) // list view: no token
    ;(mounted.container.querySelector('[data-run-id="axe_s"]') as HTMLElement).click()
    await settle()
    const resumeBtn = mounted.container.querySelector('[data-action="resume"]') as HTMLElement
    expect(resumeBtn).not.toBeNull()
    expect(mounted.container.textContent ?? '').not.toContain(SUSPENDED_TOKEN) // detail: token used internally, not shown
    resumeBtn.click()
    await settle()
    expect(confirmSpy).toHaveBeenCalled() // confirm-gated (side-effects warning)
    expect(client.resumeAutomation).toHaveBeenCalledWith(SUSPENDED_TOKEN)
    expect(client.getAutomationRun).toHaveBeenCalledTimes(2) // expand + post-resume reload
    confirmSpy.mockRestore()
  })

  it('A6-2: cancelling the resume confirm does NOT call resumeAutomation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const client = makeClient({
      listAutomationRuns: vi.fn().mockResolvedValue([SUSPENDED_LIST]),
      getAutomationRun: vi.fn().mockResolvedValue(SUSPENDED_DETAIL),
      resumeAutomation: vi.fn(),
    })
    mounted = mount(client)
    await settle()
    ;(mounted.container.querySelector('[data-run-id="axe_s"]') as HTMLElement).click()
    await settle()
    ;(mounted.container.querySelector('[data-action="resume"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).toHaveBeenCalled()
    expect(client.resumeAutomation).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('A6-2: a discriminated resume error (409 RULE_CHANGED) maps to an INLINE message, not a toast', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const err = Object.assign(new Error('x'), { code: 'RULE_CHANGED' })
    const client = makeClient({
      listAutomationRuns: vi.fn().mockResolvedValue([SUSPENDED_LIST]),
      getAutomationRun: vi.fn().mockResolvedValue(SUSPENDED_DETAIL),
      resumeAutomation: vi.fn().mockRejectedValue(err),
    })
    mounted = mount(client)
    await settle()
    ;(mounted.container.querySelector('[data-run-id="axe_s"]') as HTMLElement).click()
    await settle()
    ;(mounted.container.querySelector('[data-action="resume"]') as HTMLElement).click()
    await settle()
    const inline = mounted.container.querySelector('[data-field="resume-error"]')
    expect(inline).not.toBeNull()
    expect(inline?.textContent ?? '').toContain('changed') // RULE_CHANGED → localized inline message
    confirmSpy.mockRestore()
  })
})
