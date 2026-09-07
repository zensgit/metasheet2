// P3-4 — whole-execution re-run button on AutomationExecutionsView.
//
// Distinct from two EXISTING controls this file must NOT change the behavior of:
//  - the load-failure "Retry" (`data-action="retry"`, ~L30-36) — reloads the list only, lives
//    inside `v-if="loadError"`, and is textually "Retry" (log.retry).
//  - the per-step "Resume" (`data-action="resume"`, ~L85-93) — continues one SUSPENDED step's
//    remaining actions via `automation/resume`.
// This button (`data-action="rerun"`) re-runs the WHOLE execution via the EXISTING A5 endpoint
// (`POST /automation-executions/:id/retry`), only for admins and only when the row's status is
// one the backend's retryExecution() actually accepts (failed/skipped — automation-service.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElMessageBox } from 'element-plus'
import { createApp, h, nextTick } from 'vue'
import AutomationExecutionsView from '../src/views/AutomationExecutionsView.vue'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRunView } from '../src/multitable/types'

let mockIsAdmin = true
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ hasAdminAccess: () => mockIsAdmin }),
}))

// Rule/sheet names distinct from every other fixture and from the static confirm-dialog copy
// (req 2: rule name, target sheet — must come through verbatim, not be masked by boilerplate).
const FAILED_LIST: AutomationRunView = {
  id: 'axe_f', ruleId: 'rule-1', sheetId: 'sheet-a', status: 'failed', statusLegacy: 'failed',
  triggeredBy: 'event', triggeredAt: '2026-05-28T00:00:00.000Z', finishedAt: '2026-05-28T00:00:01.000Z',
  duration: 12, error: 'boom', schemaVersion: 1,
  steps: [{ id: 'axe_f:step:0', executionId: 'axe_f', stepKey: '0', status: 'failed', upstreamJobId: null, error: 'boom' }],
  ruleName: 'Notify Customers', sheetName: 'Orders Table',
}
// Two action kinds whose localized labels ("Lock record" / "Send email", "锁定记录" / "发送邮件")
// appear NOWHERE in the static confirm-dialog chrome strings — so asserting on them (rather than
// a generic "record"/"action" substring) is what makes "remove the consequence list" mutation red.
const FAILED_DETAIL: AutomationRunView = {
  ...FAILED_LIST,
  triggerEvent: { recordId: 'rec1' },
  ruleSnapshot: {
    id: 'rule-1', name: 'Notify Customers',
    actions: [{ type: 'lock_record', config: {} }, { type: 'send_email', config: {} }],
  },
}
const SKIPPED_LIST: AutomationRunView = { ...FAILED_LIST, id: 'axe_sk', status: 'skipped', statusLegacy: 'skipped' }
const SKIPPED_DETAIL: AutomationRunView = { ...FAILED_DETAIL, id: 'axe_sk', status: 'skipped', statusLegacy: 'skipped' }
// A non-retryable status (backend's retryExecution() 409s NOT_RETRYABLE for anything but
// failed/skipped) — the button must not render even though the row is otherwise identical.
const RESOLVED_LIST: AutomationRunView = { ...FAILED_LIST, id: 'axe_r', status: 'resolved', statusLegacy: 'success' }
const RESOLVED_DETAIL: AutomationRunView = { ...FAILED_DETAIL, id: 'axe_r', status: 'resolved', statusLegacy: 'success' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeClient(over: Record<string, any> = {}): any {
  return {
    listAutomationRuns: vi.fn().mockResolvedValue([FAILED_LIST]),
    getAutomationRun: vi.fn().mockResolvedValue(FAILED_DETAIL),
    retryAutomationExecution: vi.fn(),
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

async function expandRow(container: HTMLElement, runId: string) {
  ;(container.querySelector(`[data-run-id="${runId}"]`) as HTMLElement).click()
  await settle()
}

describe('AutomationExecutionsView — whole-execution re-run (P3-4)', () => {
  it('is absent for non-admin (gate)', async () => {
    mockIsAdmin = false
    const client = makeClient()
    mounted = mount(client)
    await nextTick()
    expect(mounted.container.querySelector('[data-denied="true"]')).not.toBeNull()
    expect(mounted.container.querySelector('[data-action="rerun"]')).toBeNull()
    expect(client.retryAutomationExecution).not.toHaveBeenCalled()
  })

  it('is absent for a non-retryable status (resolved) even for an admin', async () => {
    const client = makeClient({
      listAutomationRuns: vi.fn().mockResolvedValue([RESOLVED_LIST]),
      getAutomationRun: vi.fn().mockResolvedValue(RESOLVED_DETAIL),
    })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_r')
    expect(mounted.container.querySelector('[data-detail="true"]')).not.toBeNull()
    expect(mounted.container.querySelector('[data-action="rerun"]')).toBeNull()
  })

  it('renders for failed AND skipped (the two statuses the backend retryExecution() accepts)', async () => {
    const client = makeClient({
      listAutomationRuns: vi.fn().mockResolvedValue([FAILED_LIST, SKIPPED_LIST]),
      getAutomationRun: vi.fn((id: string) => Promise.resolve(id === 'axe_sk' ? SKIPPED_DETAIL : FAILED_DETAIL)),
    })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    expect(mounted.container.querySelector('[data-action="rerun"]')).not.toBeNull()
    await expandRow(mounted.container, 'axe_f') // collapse
    await expandRow(mounted.container, 'axe_sk')
    expect(mounted.container.querySelector('[data-action="rerun"]')).not.toBeNull()
  })

  it('the confirm dialog enumerates rule name, target sheet, action kinds, and that actions run again', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue(new Error('cancel'))
    const client = makeClient()
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const message = confirmSpy.mock.calls[0]?.[0] as string
    expect(message).toContain('Notify Customers') // rule name (from the row, not the detail)
    expect(message).toContain('Orders Table') // target sheet (from the row)
    expect(message).toContain('Lock record') // action kind #1 (from detail.ruleSnapshot.actions)
    expect(message).toContain('Send email') // action kind #2
    expect(message).toContain('again') // "will run again" framing (runs.rerunConfirmFooter)
    confirmSpy.mockRestore()
  })

  it('cancelling the confirm sends nothing', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue(new Error('cancel'))
    const client = makeClient()
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).toHaveBeenCalled()
    expect(client.retryAutomationExecution).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('confirming calls retryAutomationExecution with exactly the execution id and shows the new id', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const client = makeClient({
      retryAutomationExecution: vi.fn().mockResolvedValue({ ...FAILED_DETAIL, id: 'axe_new', status: 'running', statusLegacy: 'running' }),
    })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(client.retryAutomationExecution).toHaveBeenCalledTimes(1)
    expect(client.retryAutomationExecution).toHaveBeenCalledWith('axe_f')
    const success = mounted.container.querySelector('[data-field="rerun-success"]')
    expect(success).not.toBeNull()
    expect(success?.textContent ?? '').toContain('axe_new')
    confirmSpy.mockRestore()
  })

  it('a failed response renders the error inline and does NOT clear the runs list', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const err = Object.assign(new Error('x'), { code: 'RULE_CHANGED' })
    const client = makeClient({ retryAutomationExecution: vi.fn().mockRejectedValue(err) })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    const inline = mounted.container.querySelector('[data-field="rerun-error"]')
    expect(inline).not.toBeNull()
    expect(inline?.textContent ?? '').toContain('changed') // RULE_CHANGED -> localized inline message
    // The list must still show the row — a failed re-run must not blank the view.
    expect(mounted.container.querySelector('[data-run-id="axe_f"]')).not.toBeNull()
    expect(mounted.container.querySelector('[data-field="rerun-success"]')).toBeNull()
    confirmSpy.mockRestore()
  })

  it('zh: the button label and confirm dialog switch to the zh copy', async () => {
    useLocale().setLocale('zh-CN')
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue(new Error('cancel'))
    const client = makeClient()
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    const btn = mounted.container.querySelector('[data-action="rerun"]') as HTMLElement
    expect(btn.textContent).toBe('重新执行整条流程')
    btn.click()
    await settle()
    const message = confirmSpy.mock.calls[0]?.[0] as string
    expect(message).toContain('锁定记录')
    expect(message).toContain('发送邮件')
    expect(message).toContain('Notify Customers') // raw rule/sheet identifiers stay unlocalized
    confirmSpy.mockRestore()
    useLocale().setLocale('en')
  })

  // Pins requirement (1): the load-failure Retry is untouched — different action, different text,
  // and clicking it must never reach the new endpoint.
  it('pin: the load-failure Retry stays distinct from rerun and calls only listAutomationRuns', async () => {
    const client = makeClient({
      listAutomationRuns: vi.fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce([FAILED_LIST]),
    })
    mounted = mount(client)
    await settle()
    const retryBtn = mounted.container.querySelector('[data-action="retry"]') as HTMLElement
    expect(retryBtn).not.toBeNull()
    expect(retryBtn.textContent).toBe('Retry')
    retryBtn.click()
    await settle()
    expect(client.listAutomationRuns).toHaveBeenCalledTimes(2)
    expect(client.retryAutomationExecution).not.toHaveBeenCalled()
    await expandRow(mounted.container, 'axe_f')
    const rerunBtn = mounted.container.querySelector('[data-action="rerun"]') as HTMLElement
    expect(rerunBtn.textContent).not.toBe(retryBtn.textContent)
    expect(rerunBtn.textContent).toBe('Re-run execution')
  })
})
