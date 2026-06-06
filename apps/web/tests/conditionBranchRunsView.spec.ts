// A6-3-2b — condition_branch readability in the admin runs view (read-only).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import AutomationExecutionsView from '../src/views/AutomationExecutionsView.vue'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRunView } from '../src/multitable/types'

let mockIsAdmin = true
vi.mock('../src/composables/useAuth', () => ({ useAuth: () => ({ hasAdminAccess: () => mockIsAdmin }) }))

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

const LIST = {
  id: 'axe_cb', ruleId: 'rule-1', sheetId: 'sheet-a', status: 'resolved', statusLegacy: 'success',
  triggeredBy: 'event', triggeredAt: '2026-06-06T00:00:00.000Z', finishedAt: '2026-06-06T00:00:01.000Z',
  duration: 1, error: null, schemaVersion: 1, steps: [],
}
function detailWith(steps: unknown[]): AutomationRunView {
  return { ...LIST, triggerEvent: { recordId: 'rec1' }, ruleSnapshot: { id: 'rule-1', name: 'Branch' }, steps } as AutomationRunView
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeClient(detail: AutomationRunView): any {
  return { listAutomationRuns: vi.fn().mockResolvedValue([LIST]), getAutomationRun: vi.fn().mockResolvedValue(detail) }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mount(client: any) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(AutomationExecutionsView, { client }) })
  app.mount(container)
  return { container, app }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mounted: { container: HTMLElement; app: any } | null = null
beforeEach(() => { mockIsAdmin = true; useLocale().setLocale('en') })
afterEach(() => { if (mounted) { mounted.app.unmount(); mounted.container.remove(); mounted = null } })

async function expand(detail: AutomationRunView) {
  mounted = mount(makeClient(detail))
  await settle()
  ;(mounted.container.querySelector('[data-run-id="axe_cb"]') as HTMLElement).click()
  await settle()
  return mounted.container
}

describe('A6-3-2b condition_branch runs readability', () => {
  it('shows the selected branch on the parent step + indents/labels the nested branch jobs', async () => {
    const c = await expand(detailWith([
      { id: 'axe_cb:step:0', executionId: 'axe_cb', stepKey: '0', status: 'resolved', upstreamJobId: null, result: { ok: true } },
      { id: 'axe_cb:step:1', executionId: 'axe_cb', stepKey: '1', status: 'resolved', upstreamJobId: 'axe_cb:step:0', result: { selectedBranchKey: 'vip', matched: true } },
      { id: 'axe_cb:step:1b', executionId: 'axe_cb', stepKey: '1.branch.vip.0', status: 'resolved', upstreamJobId: 'axe_cb:step:1', result: { updated: 1 } },
    ]))
    const sel = c.querySelector('[data-field="branch-selection"]')
    expect(sel).not.toBeNull()
    expect(sel?.textContent ?? '').toContain('vip') // selected branch surfaced from result.selectedBranchKey
    const child = c.querySelector('[data-field="branch-child"]')
    expect(child).not.toBeNull()
    expect(child?.textContent ?? '').toContain('vip') // parsed from the nested stepKey
    expect(child?.textContent ?? '').toContain('#0')
    expect(c.querySelector('.automation-runs__step--branch-child')).not.toBeNull() // indented
  })

  it('shows the no-match label when no branch was selected (no default) and suppresses the raw output', async () => {
    const c = await expand(detailWith([
      { id: 'axe_cb:step:0', executionId: 'axe_cb', stepKey: '0', status: 'resolved', upstreamJobId: null, result: { selectedBranchKey: null, matched: false } },
    ]))
    const sel = c.querySelector('[data-field="branch-selection"]')
    expect(sel).not.toBeNull()
    expect(sel?.textContent ?? '').toContain('No branch matched')
    // the raw {selectedBranchKey:null,...} output is suppressed in favour of the branch-selection line
    expect(c.querySelector('[data-field="step-output"]')).toBeNull()
  })
})
