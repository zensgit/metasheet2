// A6-3-4/W3-2b — parallel_branch readability in the admin runs view (read-only).
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
  id: 'axe_pb', ruleId: 'rule-parallel', sheetId: 'sheet-a', status: 'resolved', statusLegacy: 'success',
  triggeredBy: 'event', triggeredAt: '2026-06-11T00:00:00.000Z', finishedAt: '2026-06-11T00:00:01.000Z',
  duration: 1, error: null, schemaVersion: 1, steps: [],
}

function detailWith(steps: unknown[]): AutomationRunView {
  return { ...LIST, triggerEvent: { recordId: 'rec1' }, ruleSnapshot: { id: 'rule-parallel', name: 'Parallel' }, steps } as AutomationRunView
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
  ;(mounted.container.querySelector('[data-run-id="axe_pb"]') as HTMLElement).click()
  await settle()
  return mounted.container
}

describe('A6-3-4/W3-2b parallel_branch runs readability', () => {
  it('shows join-all branch statuses and nested parallel child jobs without raw parent JSON', async () => {
    const c = await expand(detailWith([
      {
        id: 'axe_pb:step:0',
        executionId: 'axe_pb',
        stepKey: '0',
        status: 'resolved',
        upstreamJobId: null,
        result: {
          joinMode: 'all',
          branchCount: 2,
          childJobIds: ['axe_pb:job:0:parallel:ops:0', 'axe_pb:job:0:parallel:notify:0'],
          resolvedBranchKeys: ['ops', 'notify'],
          failedBranchKeys: [],
          branchStatuses: { ops: 'resolved', notify: 'resolved' },
          branchLabels: { ops: 'Ops team', notify: 'Notify team' },
        },
      },
      { id: 'axe_pb:step:0a', executionId: 'axe_pb', stepKey: '0.parallel.ops.0', status: 'resolved', upstreamJobId: 'axe_pb:step:0', result: { updated: 1 } },
      { id: 'axe_pb:step:0b', executionId: 'axe_pb', stepKey: '0.parallel.notify.0', status: 'resolved', upstreamJobId: 'axe_pb:step:0', result: { notified: 1 } },
    ]))

    const summary = c.querySelector('[data-field="parallel-summary"]')
    expect(summary).not.toBeNull()
    expect(summary?.textContent ?? '').toContain('Parallel join-all:')
    expect(summary?.textContent ?? '').toContain('Ops team (ops): resolved')
    expect(summary?.textContent ?? '').toContain('Notify team (notify): resolved')
    expect(c.querySelector('[data-field="step-output"]')?.textContent ?? '').not.toContain('childJobIds')

    const child = c.querySelector('[data-field="parallel-child"]')
    expect(child).not.toBeNull()
    expect(child?.textContent ?? '').toContain('parallel branch ops')
    expect(child?.textContent ?? '').toContain('#0')
    expect(c.querySelector('.automation-runs__step--branch-child')).not.toBeNull()
  })

  it('surfaces failed branch status while keeping sibling child jobs visible', async () => {
    const c = await expand(detailWith([
      {
        id: 'axe_pb:step:0',
        executionId: 'axe_pb',
        stepKey: '0',
        status: 'failed',
        upstreamJobId: null,
        error: 'parallel_branch failed branches: bad',
        result: {
          joinMode: 'all',
          branchStatuses: { bad: 'failed', good: 'resolved' },
          branchLabels: { good: 'Good path' },
        },
      },
      { id: 'axe_pb:step:0a', executionId: 'axe_pb', stepKey: '0.parallel.bad.0', status: 'failed', upstreamJobId: 'axe_pb:step:0', error: 'missing recipient' },
      { id: 'axe_pb:step:0b', executionId: 'axe_pb', stepKey: '0.parallel.good.0', status: 'resolved', upstreamJobId: 'axe_pb:step:0', result: { notified: 1 } },
    ]))

    const summary = c.querySelector('[data-field="parallel-summary"]')
    expect(summary?.textContent ?? '').toContain('bad: failed')
    expect(summary?.textContent ?? '').toContain('Good path (good): resolved')
    expect(c.querySelectorAll('[data-field="parallel-child"]')).toHaveLength(2)
  })

  it('keeps skipped parallel child jobs and downstream skipped steps visible', async () => {
    const c = await expand(detailWith([
      {
        id: 'axe_pb:step:0',
        executionId: 'axe_pb',
        stepKey: '0',
        status: 'failed',
        upstreamJobId: null,
        error: 'parallel_branch failed branches: bad',
        result: {
          joinMode: 'all',
          branchStatuses: { bad: 'failed', tail: 'skipped' },
          branchLabels: { tail: 'Tail path' },
        },
      },
      { id: 'axe_pb:step:0a', executionId: 'axe_pb', stepKey: '0.parallel.bad.0', status: 'failed', upstreamJobId: 'axe_pb:step:0', error: 'missing recipient' },
      { id: 'axe_pb:step:0b', executionId: 'axe_pb', stepKey: '0.parallel.tail.1', status: 'skipped', upstreamJobId: 'axe_pb:step:0', result: null },
      { id: 'axe_pb:step:1', executionId: 'axe_pb', stepKey: '1', status: 'skipped', upstreamJobId: 'axe_pb:step:0', result: null },
    ]))

    const summary = c.querySelector('[data-field="parallel-summary"]')
    expect(summary?.textContent ?? '').toContain('bad: failed')
    expect(summary?.textContent ?? '').toContain('Tail path (tail): skipped')
    const childRows = Array.from(c.querySelectorAll('[data-field="parallel-child"]'))
    expect(childRows).toHaveLength(2)
    expect(childRows[1]?.textContent ?? '').toContain('parallel branch tail')
    expect(childRows[1]?.textContent ?? '').toContain('#1')
    expect(c.textContent ?? '').toContain('skipped')
    expect(c.querySelectorAll('.automation-runs__badge--skipped').length).toBeGreaterThanOrEqual(2)
  })
})
