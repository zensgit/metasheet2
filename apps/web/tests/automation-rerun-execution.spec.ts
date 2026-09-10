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
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { beginExplicitSessionOrgChange, installExplicitSessionOrg } from '../src/utils/explicitSessionOrg'
import { authHeaders } from '../src/utils/api'
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

// Round-2 B1 — rows the backend refuses using data ALREADY on screen.
// (a) triggeredBy === 'manual_test' → 409 TEST_RUN_NOT_RETRYABLE (automation-service.ts:2733).
const MANUAL_TEST_LIST: AutomationRunView = { ...FAILED_LIST, id: 'axe_mt', triggeredBy: 'manual_test' }
const MANUAL_TEST_DETAIL: AutomationRunView = { ...FAILED_DETAIL, id: 'axe_mt', triggeredBy: 'manual_test' }
// (b) the stored trigger event is not a NON-EMPTY plain object → 409 MISSING_TRIGGER_EVENT
// (automation-service.ts:2740, predicate at :903 — null/undefined, array, and `{}` all refuse).
const NO_EVENT_CASES: { name: string; triggerEvent: unknown }[] = [
  { name: 'null', triggerEvent: null },
  { name: 'an array', triggerEvent: [] },
  { name: 'an empty object', triggerEvent: {} },
]
// Positive control for the SHAPE of that mirror: the backend's own comment (automation-service.ts:900)
// blesses a record-less scheduler event as retryable, so a mirror narrowed to "has recordId" would
// disable a row the server accepts. This row must stay ENABLED.
const SCHEDULE_DETAIL: AutomationRunView = { ...FAILED_DETAIL, triggerEvent: { _triggeredBy: 'schedule' } }
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
  localStorage.clear()
  useLocale().setLocale('en')
})
afterEach(() => {
  if (mounted) {
    mounted.app.unmount()
    mounted.container.remove()
    mounted = null
  }
  vi.restoreAllMocks()
  localStorage.clear()
})

async function expandRow(container: HTMLElement, runId: string) {
  ;(container.querySelector(`[data-run-id="${runId}"]`) as HTMLElement).click()
  await settle()
}

function selectSyntheticOrg(tenantId: string) {
  const payload = { userId: 'synthetic-admin', tenantId, exp: 4_000_000_000 }
  const token = `synthetic.${btoa(JSON.stringify(payload))}.unsigned`
  const previousToken = localStorage.getItem('auth_token') ?? token
  localStorage.setItem('auth_token', previousToken)
  const change = beginExplicitSessionOrgChange(previousToken)
  expect(change).not.toBeNull()
  localStorage.setItem('auth_token', token)
  localStorage.setItem('jwt', token)
  expect(installExplicitSessionOrg(token, tenantId, payload, change!)).toBe(true)
  return token
}

describe('AutomationExecutionsView — whole-execution re-run (P3-4)', () => {
  // Round-2 B2 — this test asserts on the BUTTON, and it drives the non-admin mount down every path
  // an un-gated body would offer (refresh → load, expand → detail). The previous shape ("mount as
  // non-admin, never expand, expect null") could not tell a working gate apart from a page with
  // nothing seeded: removing the admin gate from the body left it green. The paired positive control
  // below (same client, same seeding, admin) is what makes the absence meaningful.
  it('the BUTTON is absent for a non-admin even when the view is driven towards it (gate)', async () => {
    // Positive control: identical seeding as an admin renders the button.
    mockIsAdmin = true
    const adminClient = makeClient()
    const adminMount = mount(adminClient)
    await settle()
    await expandRow(adminMount.container, 'axe_f')
    expect(adminMount.container.querySelector('[data-action="rerun"]')).not.toBeNull()
    adminMount.app.unmount()
    adminMount.container.remove()

    mockIsAdmin = false
    const client = makeClient()
    mounted = mount(client)
    await settle()
    expect(mounted.container.querySelector('[data-denied="true"]')).not.toBeNull()
    // If the body were un-gated, these two clicks would load the list and expand the row — the exact
    // sequence that reveals the button. Both controls are absent while the gate holds.
    const refresh = mounted.container.querySelector('[data-action="refresh"]') as HTMLElement | null
    refresh?.click()
    await settle()
    const row = mounted.container.querySelector('[data-run-id="axe_f"]') as HTMLElement | null
    row?.click()
    await settle()
    // THE gate assertion, asserted first so a regression is reported on the control itself.
    expect(mounted.container.querySelector('[data-action="rerun"]')).toBeNull()
    expect(refresh).toBeNull()
    expect(row).toBeNull()
    expect(client.listAutomationRuns).not.toHaveBeenCalled()
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

  // ── Round-2 B1: refusals this view can predict from loaded data are shown, not sent ──
  // Chosen shape: DISABLED + reason (not hidden). A hidden button leaves an operator staring at a
  // failed run with no control and no explanation, and the two reasons below are not legible from
  // the row on their own. The status gate stays HIDDEN because the row's own status tag already
  // states that reason, and because "absent for a non-retryable status" is a shipped assertion.
  it('B1: a manual_test row renders the button DISABLED with the refusal reason and sends nothing', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const client = makeClient({
      listAutomationRuns: vi.fn().mockResolvedValue([MANUAL_TEST_LIST]),
      getAutomationRun: vi.fn().mockResolvedValue(MANUAL_TEST_DETAIL),
    })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_mt')
    const btn = mounted.container.querySelector('[data-action="rerun"]') as HTMLButtonElement
    expect(btn).not.toBeNull() // shown, so the operator sees WHY — not silently removed
    expect(btn.disabled).toBe(true)
    const reason = mounted.container.querySelector('[data-field="rerun-blocked-reason"]')
    expect(reason?.textContent ?? '').toContain('Manual test runs cannot be re-run.')
    // The reason is a visible sibling AND is announced with the control: a disabled button can be
    // dropped from the accessibility tree, so a title-only reason would not reach a screen reader.
    expect(reason?.id).toBeTruthy()
    expect(btn.getAttribute('aria-describedby')).toBe(reason?.id)
    btn.click()
    await settle()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(client.retryAutomationExecution).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  for (const testCase of NO_EVENT_CASES) {
    it(`B1: a stored trigger event that is ${testCase.name} renders DISABLED with the refusal reason`, async () => {
      const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
      const client = makeClient({
        getAutomationRun: vi.fn().mockResolvedValue({ ...FAILED_DETAIL, triggerEvent: testCase.triggerEvent }),
      })
      mounted = mount(client)
      await settle()
      await expandRow(mounted.container, 'axe_f')
      const btn = mounted.container.querySelector('[data-action="rerun"]') as HTMLButtonElement
      expect(btn).not.toBeNull()
      expect(btn.disabled).toBe(true)
      const reason = mounted.container.querySelector('[data-field="rerun-blocked-reason"]')
      expect(reason?.textContent ?? '').toContain('The original trigger data is unavailable')
      btn.click()
      await settle()
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(client.retryAutomationExecution).not.toHaveBeenCalled()
      confirmSpy.mockRestore()
    })
  }

  // Positive control for the two mirrors above: neither may be wider than the backend's guard.
  it('B1: a record-less scheduler trigger event stays ENABLED (the mirror is key-count, not recordId)', async () => {
    const client = makeClient({ getAutomationRun: vi.fn().mockResolvedValue(SCHEDULE_DETAIL) })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    const btn = mounted.container.querySelector('[data-action="rerun"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.disabled).toBe(false)
    expect(mounted.container.querySelector('[data-field="rerun-blocked-reason"]')).toBeNull()
    // No stale description pointing at a span that is not rendered.
    expect(btn.getAttribute('aria-describedby')).toBeNull()
  })

  it('B1: an ordinary event-triggered row with a usable trigger event is ENABLED and sends', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const client = makeClient({
      retryAutomationExecution: vi.fn().mockResolvedValue({ ...FAILED_DETAIL, id: 'axe_new2' }),
    })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    const btn = mounted.container.querySelector('[data-action="rerun"]') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(mounted.container.querySelector('[data-field="rerun-blocked-reason"]')).toBeNull()
    btn.click()
    await settle()
    expect(client.retryAutomationExecution).toHaveBeenCalledTimes(1)
    confirmSpy.mockRestore()
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

  // ── Round-2 B3: the consequence list is not always derivable ──
  // Chosen shape: say so honestly and demand a SECOND acknowledgement (not: refuse the re-run).
  // `retryExecution()` never reads `ruleSnapshot`, so an unusable snapshot is not a server refusal —
  // refusing here would withdraw a capability the backend still grants.
  for (const snapshotCase of [
    { name: 'a null ruleSnapshot', ruleSnapshot: null },
    { name: 'a ruleSnapshot with no actions array', ruleSnapshot: { id: 'rule-1', name: 'Notify Customers' } },
    { name: 'an action whose type is unreadable', ruleSnapshot: { actions: [{ type: 'lock_record' }, { config: {} }] } },
    { name: 'an unknown action type', ruleSnapshot: { actions: [{ type: 'lock_record' }, { type: 'future_action' }] } },
    { name: 'a prototype property as an action type', ruleSnapshot: { actions: [{ type: 'toString' }] } },
    { name: 'an unknown default-branch action', ruleSnapshot: { actions: [{ type: 'condition_branch', config: {
      branches: [{ key: 'matched', actions: [{ type: 'lock_record' }] }],
      defaultBranch: { key: 'fallback', actions: [{ type: 'future_action' }] },
    } }] } },
    { name: 'malformed default-branch actions', ruleSnapshot: { actions: [{ type: 'condition_branch', config: {
      branches: [{ key: 'matched', actions: [{ type: 'lock_record' }] }],
      defaultBranch: { key: 'fallback', actions: 'unreadable' },
    } }] } },
    { name: 'a container with no config', ruleSnapshot: { actions: [{ type: 'parallel_branch' }] } },
    { name: 'a too-deep container', ruleSnapshot: { actions: [{ type: 'condition_branch', config: {
      branches: [{ key: 'matched', actions: [{ type: 'condition_branch', config: {
        branches: [{ key: 'nested', actions: [{ type: 'lock_record' }] }],
      } }] }],
    } }] } },
  ]) {
    it(`B3: ${snapshotCase.name} shows "cannot be listed" and requires a second acknowledgement`, async () => {
      const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
      const client = makeClient({
        getAutomationRun: vi.fn().mockResolvedValue({ ...FAILED_DETAIL, ruleSnapshot: snapshotCase.ruleSnapshot }),
        retryAutomationExecution: vi.fn().mockResolvedValue({ ...FAILED_DETAIL, id: 'axe_new3' }),
      })
      mounted = mount(client)
      await settle()
      await expandRow(mounted.container, 'axe_f')
      ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
      await settle()
      const first = confirmSpy.mock.calls[0]?.[0] as string
      expect(first).toContain('CANNOT BE LISTED')
      expect(first).not.toContain('Lock record') // no partial list dressed up as the full one
      // The extra acknowledgement is a SECOND dialog with its own copy — not a re-render of the first.
      expect(confirmSpy).toHaveBeenCalledTimes(2)
      const second = confirmSpy.mock.calls[1]?.[0] as string
      expect(second).toContain('cannot be listed')
      expect(confirmSpy.mock.calls[1]?.[1] as string).toContain('without knowing which actions')
      expect(client.retryAutomationExecution).toHaveBeenCalledTimes(1)
      confirmSpy.mockRestore()
    })
  }

  it('B3: cancelling the extra acknowledgement sends nothing', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm')
      .mockResolvedValueOnce('confirm' as never)
      .mockRejectedValueOnce(new Error('cancel'))
    const client = makeClient({
      getAutomationRun: vi.fn().mockResolvedValue({ ...FAILED_DETAIL, ruleSnapshot: null }),
    })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(client.retryAutomationExecution).not.toHaveBeenCalled()
    expect(mounted.container.querySelector('[data-field="rerun-success"]')).toBeNull()
    confirmSpy.mockRestore()
  })

  // Positive control: an enumerable run must NOT pay the extra acknowledgement.
  it('B3: an enumerable run asks exactly once and sends', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const client = makeClient({
      retryAutomationExecution: vi.fn().mockResolvedValue({ ...FAILED_DETAIL, id: 'axe_new4' }),
    })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0]?.[0] as string).toContain('Lock record')
    expect(client.retryAutomationExecution).toHaveBeenCalledTimes(1)
    confirmSpy.mockRestore()
  })

  it('lists condition children AND default-branch side effects before one confirmation', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const client = makeClient({ getAutomationRun: vi.fn().mockResolvedValue({
      ...FAILED_DETAIL,
      ruleSnapshot: { actions: [{ type: 'condition_branch', config: {
        branches: [{ key: 'matched', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'lock_record', config: {} }] }],
        defaultBranch: { key: 'fallback', actions: [{ type: 'send_email', config: {} }] },
      } }] },
    }) })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const message = confirmSpy.mock.calls[0]?.[0] as string
    expect(message).toContain('Lock record')
    expect(message).toContain('Send email')
    expect(message).not.toContain('CANNOT BE LISTED')
    expect(client.retryAutomationExecution.mock.calls).toEqual([['axe_f']])
  })

  it('lists both parallel branches, not just the container label', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const client = makeClient({ getAutomationRun: vi.fn().mockResolvedValue({
      ...FAILED_DETAIL,
      ruleSnapshot: { actions: [{ type: 'parallel_branch', config: { joinMode: 'all', branches: [
        { key: 'update', actions: [{ type: 'update_record', config: {} }] },
        { key: 'notify', actions: [{ type: 'send_notification', config: {} }] },
      ] } }] },
    }) })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('Update record')
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('Send notification')
    expect(client.retryAutomationExecution.mock.calls).toEqual([['axe_f']])
  })

  it('accepts supported empty condition branches while listing the nonempty fallback', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const client = makeClient({ getAutomationRun: vi.fn().mockResolvedValue({
      ...FAILED_DETAIL,
      ruleSnapshot: { actions: [{ type: 'condition_branch', config: {
        branches: [{ key: 'empty' }, { key: 'null', actions: null }],
        defaultBranch: { key: 'fallback', actions: [{ type: 'send_email' }] },
      } }] },
    }) })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('Send email')
    expect(client.retryAutomationExecution.mock.calls).toEqual([['axe_f']])
  })

  for (const transition of ['unchanged', 'other-org', 'org-cycle', 'changing'] as const) {
    it(`binds pending confirmation to explicit session org and epoch: ${transition}`, async () => {
      const token = selectSyntheticOrg('synthetic-org-a')
      localStorage.setItem('tenantId', 'unrelated-login-hint')
      const originalHeaders = authHeaders()
      expect(originalHeaders['x-tenant-id']).toBe('synthetic-org-a')
      let confirm!: (value: never) => void
      const confirmSpy = vi.spyOn(ElMessageBox, 'confirm')
        .mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve }))
      const client = makeClient()
      mounted = mount(client)
      await settle()
      await expandRow(mounted.container, 'axe_f')
      ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
      await settle()
      expect(confirmSpy).toHaveBeenCalledTimes(1)
      // Model another tab: no local auth notification is delivered.
      if (transition === 'other-org' || transition === 'org-cycle') selectSyntheticOrg('synthetic-org-b')
      if (transition === 'org-cycle') {
        expect(selectSyntheticOrg('synthetic-org-a')).toBe(token)
        expect(authHeaders()).toEqual(originalHeaders)
      }
      if (transition === 'changing') expect(beginExplicitSessionOrgChange(token)).not.toBeNull()
      confirm('confirm' as never)
      await settle()
      expect(client.retryAutomationExecution.mock.calls).toEqual(transition === 'unchanged' ? [['axe_f']] : [])
      expect((mounted.container.querySelector('[data-action="rerun"]') as HTMLButtonElement).disabled).toBe(false)
    })
  }

  for (const transition of ['unmount', 'principal', 'tenant', 'auth-cycle', 'execution', 'admin-revoked'] as const) {
    it(`pending confirmation is invalidated by ${transition} without sending an old execution`, async () => {
      let confirm!: (value: never) => void
      const confirmSpy = vi.spyOn(ElMessageBox, 'confirm')
        .mockImplementation(() => new Promise((resolve) => { confirm = resolve }))
      localStorage.setItem('auth_token', 'synthetic-session-a')
      localStorage.setItem('tenantId', 'synthetic-org-a')
      const client = makeClient({
        listAutomationRuns: vi.fn().mockResolvedValue([FAILED_LIST, SKIPPED_LIST]),
        getAutomationRun: vi.fn((id: string) => Promise.resolve(id === 'axe_sk' ? SKIPPED_DETAIL : FAILED_DETAIL)),
      })
      mounted = mount(client)
      await settle()
      await expandRow(mounted.container, 'axe_f')
      ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
      await settle()
      expect(confirmSpy).toHaveBeenCalledTimes(1)
      if (transition === 'unmount') {
        mounted.app.unmount()
        mounted.container.remove()
        mounted = null
      } else if (transition === 'principal') {
        // Cross-tab storage changes do not broadcast through useAuth.
        localStorage.setItem('auth_token', 'synthetic-session-b')
      } else if (transition === 'tenant') {
        localStorage.setItem('tenantId', 'synthetic-org-b')
      } else if (transition === 'auth-cycle') {
        // Broadcast precedes storage writes; even an A -> B -> A cycle voids this confirmation.
        notifyAuthPrincipalChange()
        localStorage.setItem('auth_token', 'synthetic-session-b')
        notifyAuthPrincipalChange()
        localStorage.setItem('auth_token', 'synthetic-session-a')
      } else if (transition === 'execution') {
        await expandRow(mounted.container, 'axe_sk')
        await expandRow(mounted.container, 'axe_f')
      } else {
        mockIsAdmin = false
      }
      confirm('confirm' as never)
      await settle()
      expect(client.retryAutomationExecution).not.toHaveBeenCalled()
      expect(confirmSpy).toHaveBeenCalledTimes(1)
      if (mounted) expect(mounted.container.querySelector('[data-field="rerun-success"]')).toBeNull()
    })
  }

  it('unmount during the second acknowledgement cannot send after it resolves', async () => {
    let confirm!: (value: never) => void
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm')
      .mockResolvedValueOnce('confirm' as never)
      .mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve }))
    const client = makeClient({ getAutomationRun: vi.fn().mockResolvedValue({ ...FAILED_DETAIL, ruleSnapshot: null }) })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    mounted.app.unmount()
    mounted.container.remove()
    mounted = null
    confirm('confirm' as never)
    await settle()
    expect(client.retryAutomationExecution).not.toHaveBeenCalled()
  })

  it('does not open the unknown-action acknowledgement after the component unmounts', async () => {
    let confirm!: (value: never) => void
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm')
      .mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve }))
      .mockResolvedValue('confirm' as never)
    const client = makeClient({ getAutomationRun: vi.fn().mockResolvedValue({ ...FAILED_DETAIL, ruleSnapshot: null }) })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    mounted.app.unmount()
    mounted.container.remove()
    mounted = null
    confirm('confirm' as never)
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(client.retryAutomationExecution).not.toHaveBeenCalled()
  })

  it('refuses stale loaded detail after tenant changes before clicking', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    localStorage.setItem('tenantId', 'synthetic-org-a')
    const client = makeClient()
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    localStorage.setItem('tenantId', 'synthetic-org-b')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(client.retryAutomationExecution).not.toHaveBeenCalled()
  })

  it('reserves a pending confirmation, then sends exactly once when context stays current', async () => {
    let confirm!: (value: never) => void
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm')
      .mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve }))
    const client = makeClient()
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    const button = mounted.container.querySelector('[data-action="rerun"]') as HTMLButtonElement
    button.click()
    button.click()
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(client.retryAutomationExecution).not.toHaveBeenCalled()
    confirm('confirm' as never)
    await settle()
    expect(client.retryAutomationExecution.mock.calls).toEqual([['axe_f']])
    expect(button.disabled).toBe(false)
  })

  it('does not offer rerun from detail loaded across a tenant change', async () => {
    let resolveDetail!: (value: AutomationRunView) => void
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    localStorage.setItem('tenantId', 'synthetic-org-a')
    const client = makeClient({ getAutomationRun: vi.fn(() => new Promise<AutomationRunView>((resolve) => {
      resolveDetail = resolve
    })) })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    expect(client.getAutomationRun.mock.calls).toEqual([['axe_f']])
    localStorage.setItem('tenantId', 'synthetic-org-b')
    resolveDetail(FAILED_DETAIL)
    await settle()
    expect(mounted.container.querySelector('[data-action="rerun"]')).toBeNull()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(client.retryAutomationExecution).not.toHaveBeenCalled()
  })

  it('drops an earlier same-row detail response after collapse and re-open', async () => {
    let resolveDetail!: (value: AutomationRunView) => void
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const client = makeClient({ getAutomationRun: vi.fn()
      .mockImplementationOnce(() => new Promise<AutomationRunView>((resolve) => { resolveDetail = resolve }))
      .mockResolvedValueOnce(FAILED_DETAIL),
    })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    await expandRow(mounted.container, 'axe_f')
    await expandRow(mounted.container, 'axe_f')
    resolveDetail({ ...FAILED_DETAIL, ruleSnapshot: null })
    await settle()
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('Lock record')
    expect(client.retryAutomationExecution.mock.calls).toEqual([['axe_f']])
  })

  it.each([
    ['success', 'execution'], ['failure', 'execution'],
    ['success', 'principal'], ['failure', 'principal'],
  ] as const)('does not paint an old rerun %s after changing %s and releases loading', async (outcome, transition) => {
    let resolveRetry!: (value: AutomationRunView) => void
    let rejectRetry!: (reason: Error) => void
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const client = makeClient({
      listAutomationRuns: vi.fn().mockResolvedValue([FAILED_LIST, SKIPPED_LIST]),
      getAutomationRun: vi.fn((id: string) => Promise.resolve(id === 'axe_sk' ? SKIPPED_DETAIL : FAILED_DETAIL)),
      retryAutomationExecution: vi.fn(() => new Promise<AutomationRunView>((resolve, reject) => {
        resolveRetry = resolve
        rejectRetry = reject
      })),
    })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    expect(client.retryAutomationExecution.mock.calls).toEqual([['axe_f']])
    if (transition === 'execution') await expandRow(mounted.container, 'axe_sk')
    else {
      notifyAuthPrincipalChange()
      localStorage.setItem('auth_token', 'synthetic-new-principal')
    }
    if (outcome === 'success') resolveRetry({ ...FAILED_DETAIL, id: 'axe_old_result' })
    else rejectRetry(new Error('synthetic-old-error'))
    await settle()
    expect(mounted.container.querySelector('[data-field="rerun-success"]')).toBeNull()
    expect(mounted.container.querySelector('[data-field="rerun-error"]')).toBeNull()
    expect(mounted.container.textContent).not.toContain('axe_old_result')
    expect(mounted.container.textContent).not.toContain('synthetic-old-error')
    expect((mounted.container.querySelector('[data-action="rerun"]') as HTMLButtonElement).disabled).toBe(false)
  })

  // ── Round-2 B4/B5: the UI admin mirror is NOT the backend's admin predicate ──
  // `useAuth().hasAdminAccess()` reads the JWT payload + localStorage; the route calls
  // requireAdminRole() against the RBAC service, so a principal this view treats as admin can still
  // be refused. That refusal must render honestly, and in the reader's language (B5).
  it('B4/B5: a 403 AccessDenied refusal renders localized copy inline, not the raw server string', async () => {
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const err = Object.assign(new Error('This operation requires admin privileges'), { code: 'AccessDenied' })
    const client = makeClient({ retryAutomationExecution: vi.fn().mockRejectedValue(err) })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    const inline = mounted.container.querySelector('[data-field="rerun-error"]')
    expect(inline?.textContent ?? '').toBe('Re-running an execution requires admin privileges.')
    expect(inline?.textContent ?? '').not.toContain('This operation requires admin privileges')
    // Honest degradation: no success, the row is still listed, nothing was reloaded away.
    expect(mounted.container.querySelector('[data-field="rerun-success"]')).toBeNull()
    expect(mounted.container.querySelector('[data-run-id="axe_f"]')).not.toBeNull()
    expect(client.listAutomationRuns).toHaveBeenCalledTimes(1)
    confirmSpy.mockRestore()
  })

  it('B5: the documented ADMIN_REQUIRED code renders the zh copy in a zh session', async () => {
    useLocale().setLocale('zh-CN')
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const err = Object.assign(new Error('This operation requires admin privileges'), { code: 'ADMIN_REQUIRED' })
    const client = makeClient({ retryAutomationExecution: vi.fn().mockRejectedValue(err) })
    mounted = mount(client)
    await settle()
    await expandRow(mounted.container, 'axe_f')
    ;(mounted.container.querySelector('[data-action="rerun"]') as HTMLElement).click()
    await settle()
    const inline = mounted.container.querySelector('[data-field="rerun-error"]')
    expect(inline?.textContent ?? '').toBe('重新执行需要管理员权限。')
    confirmSpy.mockRestore()
    useLocale().setLocale('en')
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
