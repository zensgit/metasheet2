import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ElMessageBox } from 'element-plus'
import { createApp, h, nextTick } from 'vue'
import AutomationExecutionsView from '../src/views/AutomationExecutionsView.vue'
import { useLocale } from '../src/composables/useLocale'
import type { AutomationRunView } from '../src/multitable/types'
import type { AutomationReadRequestStatus } from '../src/services/integration/automationRead'
import { MultitableApiClient } from '../src/multitable/api/client'
import { normalizeAutomationRunReadReference } from '../src/multitable/automationReadExecution'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

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
    // 客户反馈 2026-09-24 #4c follow-up: triggeredAt 2026-05-28T00:00Z in the business timezone (Asia/Shanghai
    // default), 24-hour, to the second — whatever the browser's zone / locale.
    expect(mounted.container.querySelector('[data-run-id="axe_1"] .automation-runs__time')?.textContent?.trim()).toBe('2026-05-28 08:00:00')
  })

  // B3-11 — additive server-resolved ruleName/sheetName: render the resolved label as plain
  // text instead of the raw <code> id.
  it('B3-11: shows the resolved ruleName/sheetName as plain text (not the raw <code> id)', async () => {
    const client = makeClient({
      listAutomationRuns: vi.fn().mockResolvedValue([
        { ...RUN_LIST, ruleName: 'Notify Customers', sheetName: 'Orders' },
      ]),
    })
    mounted = mount(client)
    await settle()
    const ruleField = mounted.container.querySelector('[data-field="ruleName"]')
    const sheetField = mounted.container.querySelector('[data-field="sheetName"]')
    expect(ruleField?.textContent?.trim()).toBe('Notify Customers')
    expect(sheetField?.textContent?.trim()).toBe('Orders')
    // resolved names render as plain text — no honest-id <code> fallback in this row
    expect(ruleField?.querySelector('[data-field="ruleId"]')).toBeNull()
    expect(sheetField?.querySelector('[data-field="sheetId"]')).toBeNull()
  })

  // Honest fallback (mirrors the backend's degrade-to-id contract): an unresolved name (rule/
  // sheet deleted server-side, surfaced as ruleName === ruleId) still renders the raw id via
  // the same <code> treatment as a payload that never included ruleName/sheetName at all
  // (backward compatible with an old cached response).
  it('B3-11: DEGRADES to the raw <code> id when ruleName/sheetName is unresolved (equals the id) or absent', async () => {
    const client = makeClient({
      listAutomationRuns: vi.fn().mockResolvedValue([
        { ...RUN_LIST, id: 'axe_gone', ruleName: 'rule-1', sheetName: 'sheet-a' }, // unresolved: name === id
        { ...RUN_LIST, id: 'axe_old' }, // backward-compat: no ruleName/sheetName field at all
      ]),
    })
    mounted = mount(client)
    await settle()
    for (const runId of ['axe_gone', 'axe_old']) {
      const row = mounted.container.querySelector(`[data-run-id="${runId}"]`) as HTMLElement
      expect(row.querySelector('[data-field="ruleId"]')?.textContent).toBe('rule-1')
      expect(row.querySelector('[data-field="sheetId"]')?.textContent).toBe('sheet-a')
    }
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
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
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
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue(new Error('cancel'))
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
    const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
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

  // #5803: resumeExecution() refuses a rule whose sheet is soft-deleted with 409 SHEET_DELETED, before the
  // single-use token is claimed. The view must show its own localized copy, not the raw English sentence.
  const RESUME_SHEET_DELETED_SERVER_TEXT = "SHEET_DELETED: the rule's sheet has been deleted; suspended execution not resumed."
  for (const locale of [
    { name: 'zh', set: 'zh-CN', expected: '规则所在的表已被删除，未恢复执行。请先恢复该表后重试。' },
    { name: 'en', set: 'en', expected: "The rule's sheet has been deleted, so nothing was resumed. Restore the sheet and try again." },
  ] as const) {
    it(`#5803 (${locale.name}): a 409 SHEET_DELETED resume refusal renders the sheet-deleted copy inline`, async () => {
      useLocale().setLocale(locale.set)
      const confirmSpy = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
      const err = Object.assign(new Error(RESUME_SHEET_DELETED_SERVER_TEXT), { code: 'SHEET_DELETED' })
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
      expect(client.resumeAutomation).toHaveBeenCalledTimes(1)
      const inline = mounted.container.querySelector('[data-field="resume-error"]')
      expect(inline?.textContent ?? '').toBe(locale.expected)
      expect(mounted.container.textContent).not.toContain(RESUME_SHEET_DELETED_SERVER_TEXT)
      confirmSpy.mockRestore()
      useLocale().setLocale('en')
    })
  }
})

describe('AutomationExecutionsView — closed integration read audits', () => {
  const requestId = '12345678-1234-1234-1234-123456789abc'
  const statuses = {
    queued: ['已排队，未完成', 'Queued, not complete'], running: ['正在运行', 'Running'],
    succeeded: ['只读预览完成', 'Read-only preview complete'], blocked: ['已阻止执行', 'Execution blocked'],
    failed: ['执行失败', 'Execution failed'], cancelled: ['已取消', 'Cancelled'],
    outcome_unknown: ['结果未知，不会自动重做', 'Outcome unknown; no automatic rerun'],
  } as const
  function readRun(status: AutomationReadRequestStatus): AutomationRunView {
    const legacy = status === 'succeeded' ? 'success' : ['blocked', 'cancelled'].includes(status) ? 'skipped'
      : ['failed', 'outcome_unknown'].includes(status) ? 'failed' : 'running'
    return {
      ...RUN_LIST, id: 'axe_read', status: legacy === 'success' ? 'resolved' : legacy,
      statusLegacy: legacy, triggeredBy: 'integration-read-owner', steps: [],
      triggerEvent: null, ruleSnapshot: null, integrationRead: { requestId, status },
    }
  }
  function getClient(list: unknown[], detail: unknown) {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') throw new Error('Unexpected mutation transport')
      return new Response(JSON.stringify(url.includes('/axe_read') ? detail : { executions: list }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    })
    return { client: new MultitableApiClient({ fetchFn }), fetchFn }
  }

  it('clears loaded read metadata immediately on a principal switch', async () => {
    mounted = mount(makeClient({ listAutomationRuns: vi.fn().mockResolvedValue([readRun('failed')]) }))
    await settle()
    expect(mounted.container.querySelector('[data-run-id="axe_read"]')).not.toBeNull()
    notifyAuthPrincipalChange()
    await settle()
    expect(mounted.container.querySelector('[data-run-id]')).toBeNull()
  })

  it.each(['principal', 'storage', 'focus'] as const)('drops a late read list after a %s session change', async mode => {
    const prior = localStorage.getItem('auth_token')
    localStorage.setItem('auth_token', 'synthetic.owner.session')
    let release!: (rows: AutomationRunView[]) => void
    const pending = new Promise<AutomationRunView[]>(resolve => { release = resolve })
    try {
      mounted = mount(makeClient({ listAutomationRuns: vi.fn().mockReturnValue(pending) }))
      await settle()
      if (mode === 'principal') notifyAuthPrincipalChange()
      localStorage.setItem('auth_token', 'synthetic.other.session')
      if (mode === 'storage') window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }))
      if (mode === 'focus') window.dispatchEvent(new Event('focus'))
      release([readRun('succeeded')])
      await settle()
      expect(mounted.container.querySelector('[data-run-id]')).toBeNull()
      expect(mounted.container.querySelector('[data-field="integration-read-status"]')).toBeNull()
    } finally {
      if (prior === null) localStorage.removeItem('auth_token')
      else localStorage.setItem('auth_token', prior)
    }
  })

  it('discards a late read list after session A → B → A', async () => {
    let release!: (rows: AutomationRunView[]) => void
    const pending = new Promise<AutomationRunView[]>(resolve => { release = resolve })
    mounted = mount(makeClient({ listAutomationRuns: vi.fn().mockReturnValue(pending) }))
    await settle()
    notifyAuthPrincipalChange()
    notifyAuthPrincipalChange()
    release([readRun('succeeded')])
    await settle()
    expect(mounted.container.querySelector('[data-run-id]')).toBeNull()
  })

  it('rejects an ordinary retry handler for a read action in a historical snapshot', async () => {
    const row = { ...RUN_LIST, status: 'failed' as const, ruleSnapshot: {
      actionType: 'integration_read_preview', actionConfig: { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: true },
    } }
    const retry = vi.fn()
    mounted = mount(makeClient({ listAutomationRuns: vi.fn().mockResolvedValue([row]),
      getAutomationRun: vi.fn().mockResolvedValue({ ...row, ruleSnapshot: null, triggerEvent: { recordId: 'rec1' } }), retryAutomationExecution: retry }))
    await settle()
    ;(mounted.container.querySelector('[data-run-id="axe_1"]') as HTMLElement).click()
    await settle()
    const button = mounted.container.querySelector('[data-action="rerun"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    button.dispatchEvent(new Event('click', { bubbles: true }))
    await settle()
    expect(retry).not.toHaveBeenCalled()
  })
  for (const [status, labels] of Object.entries(statuses)) {
    for (const locale of ['en', 'zh-CN'] as const) {
      it(`${status} (${locale}): real GET list/detail show exact read state and never generic rerun`, async () => {
        useLocale().setLocale(locale)
        const row = readRun(status as AutomationReadRequestStatus)
        const { client, fetchFn } = getClient([row], row)
        const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
        try {
          mounted = mount(client)
          await settle()
          const expected = labels[locale === 'zh-CN' ? 0 : 1]
          expect(mounted.container.querySelector('[data-field="integration-read-status"]')?.textContent?.trim()).toBe(expected)
          expect(mounted.container.querySelector('[data-status="failed"]')).toBeNull()
          ;(mounted.container.querySelector('[data-run-id="axe_read"]') as HTMLElement).click()
          await settle()
          expect(mounted.container.querySelector('[data-field="integration-read-detail"] [data-read-status]')?.textContent?.trim()).toBe(expected)
          expect(mounted.container.querySelector('[data-field="integration-read-request-id"]')?.textContent).toBe(requestId)
          expect(mounted.container.querySelector('[data-field="step-output"]')).toBeNull()
          const rerun = mounted.container.querySelector('[data-action="rerun"]') as HTMLButtonElement | null
          if (row.status === 'failed' || row.status === 'skipped') {
            expect(rerun?.disabled).toBe(true)
            expect(mounted.container.querySelector('[data-field="rerun-blocked-reason"]')?.textContent).toContain(locale === 'zh-CN' ? '备料面板' : 'preparation panel')
            // Native dispatch bypasses disabled.click(), pinning the handler too.
            rerun?.dispatchEvent(new Event('click', { bubbles: true }))
            await settle()
          } else expect(rerun).toBeNull()
          expect(confirm).not.toHaveBeenCalled()
          expect(fetchFn).toHaveBeenCalledTimes(2)
          expect(fetchFn.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
        } finally { confirm.mockRestore() }
      })
    }
  }

  for (const invalidRef of [
    { requestId, status: 'future_state' },
    { requestId, status: 'failed', result: { private: 'must-not-render' } },
    { requestId: 'bad-id', status: 'failed' },
    null,
  ]) {
    it(`real GET rejects illegal optional reference ${JSON.stringify(invalidRef)} in list and detail`, async () => {
      const invalidRun = { ...readRun('failed'), integrationRead: invalidRef }
      const { client, fetchFn } = getClient([invalidRun], invalidRun)
      await expect(client.listAutomationRuns()).rejects.toThrow('Invalid read-preview execution response')
      await expect(client.getAutomationRun('axe_read')).rejects.toThrow('Invalid read-preview execution response')
      mounted = mount(client)
      await settle()
      expect(mounted.container.querySelector('[data-run-id]')).toBeNull()
      expect(mounted.container.textContent).not.toContain('must-not-render')
      expect(mounted.container.querySelector('[data-action="rerun"]')).toBeNull()
      expect(fetchFn.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
    })
  }

  it('own outer, own status and inherited getters are refused without being invoked at the view boundary', async () => {
    const getter = vi.fn(() => ({ requestId, status: 'failed' }))
    const outer = { ...readRun('failed') }
    Object.defineProperty(outer, 'integrationRead', { enumerable: true, get: getter })
    const statusGetter = vi.fn(() => 'failed')
    const inner = { requestId }
    Object.defineProperty(inner, 'status', { enumerable: true, get: statusGetter })
    const inherited = { ...RUN_LIST, id: 'axe_read' }
    Object.setPrototypeOf(inherited, Object.defineProperty({}, 'integrationRead', { enumerable: true, get: getter }))
    for (const row of [outer, { ...readRun('failed'), integrationRead: inner }, inherited]) {
      expect(() => normalizeAutomationRunReadReference(row as AutomationRunView)).toThrow('Invalid read-preview execution response')
    }
    mounted = mount(makeClient({ listAutomationRuns: vi.fn().mockResolvedValue([outer]) }))
    await settle()
    expect(mounted.container.querySelector('[data-run-id]')).toBeNull()
    expect(getter).not.toHaveBeenCalled()
    expect(statusGetter).not.toHaveBeenCalled()
  })

  it('an invalid detail reference collapses without painting private fields or offering retry', async () => {
    const retry = vi.fn()
    mounted = mount(makeClient({
      listAutomationRuns: vi.fn().mockResolvedValue([readRun('failed')]),
      getAutomationRun: vi.fn().mockResolvedValue({ ...readRun('failed'), integrationRead: { requestId, status: 'failed', selector: 'must-not-render' } }),
      retryAutomationExecution: retry,
    }))
    await settle()
    ;(mounted.container.querySelector('[data-run-id="axe_read"]') as HTMLElement).click()
    await settle()
    expect(mounted.container.querySelector('[data-detail="true"]')).toBeNull()
    expect(mounted.container.textContent).not.toContain('must-not-render')
    expect(retry).not.toHaveBeenCalled()
  })

  it('fixed owner origin blocks a legacy missing-reference/missing-snapshot shell even with a usable trigger', async () => {
    const row = { ...readRun('failed'), integrationRead: undefined, triggerEvent: { _triggeredBy: 'schedule' }, ruleSnapshot: null }
    const retry = vi.fn()
    mounted = mount(makeClient({ listAutomationRuns: vi.fn().mockResolvedValue([row]), getAutomationRun: vi.fn().mockResolvedValue(row), retryAutomationExecution: retry }))
    await settle()
    ;(mounted.container.querySelector('[data-run-id="axe_read"]') as HTMLElement).click()
    await settle()
    const button = mounted.container.querySelector('[data-action="rerun"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(mounted.container.querySelector('[data-field="rerun-blocked-reason"]')?.textContent).toContain('preparation panel')
    button.dispatchEvent(new Event('click', { bubbles: true }))
    await settle()
    expect(retry).not.toHaveBeenCalled()
  })

  for (const source of ['list', 'detail'] as const) {
    it(`a ${source}-only read reference blocks rerun independently of origin or missing trigger`, async () => {
      const base = { ...readRun('failed'), triggeredBy: 'event', triggerEvent: { recordId: 'rec1' }, integrationRead: undefined }
      const withRef = { ...base, integrationRead: { requestId, status: 'failed' as const } }
      const retry = vi.fn()
      mounted = mount(makeClient({
        listAutomationRuns: vi.fn().mockResolvedValue([source === 'list' ? withRef : base]),
        getAutomationRun: vi.fn().mockResolvedValue(source === 'detail' ? withRef : base),
        retryAutomationExecution: retry,
      }))
      await settle()
      ;(mounted.container.querySelector('[data-run-id="axe_read"]') as HTMLElement).click()
      await settle()
      const button = mounted.container.querySelector('[data-action="rerun"]') as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(mounted.container.querySelector('[data-field="rerun-blocked-reason"]')?.textContent).toContain('preparation panel')
      button.dispatchEvent(new Event('click', { bubbles: true }))
      await settle()
      expect(retry).not.toHaveBeenCalled()
    })
  }

  it('a detail reference accessor is rejected without invocation or rendering a retry action', async () => {
    const getter = vi.fn(() => ({ requestId, status: 'failed' }))
    const bad = { ...readRun('failed') }
    Object.defineProperty(bad, 'integrationRead', { enumerable: true, get: getter })
    const retry = vi.fn()
    mounted = mount(makeClient({ listAutomationRuns: vi.fn().mockResolvedValue([readRun('failed')]), getAutomationRun: vi.fn().mockResolvedValue(bad), retryAutomationExecution: retry }))
    await settle()
    ;(mounted.container.querySelector('[data-run-id="axe_read"]') as HTMLElement).click()
    await settle()
    expect(getter).not.toHaveBeenCalled()
    expect(mounted.container.querySelector('[data-detail="true"]')).toBeNull()
    expect(mounted.container.querySelector('[data-action="rerun"]')).toBeNull()
    expect(retry).not.toHaveBeenCalled()
  })

  it('linked read renders no generic snapshots or business step output', async () => {
    const row = {
      ...readRun('outcome_unknown'), triggerEvent: { project: 'must-not-render' },
      ruleSnapshot: { result: 'must-not-render' }, steps: [{ ...RUN_LIST.steps[1], result: { project: 'must-not-render' } }],
    }
    mounted = mount(makeClient({ listAutomationRuns: vi.fn().mockResolvedValue([row]), getAutomationRun: vi.fn().mockResolvedValue(row) }))
    await settle()
    ;(mounted.container.querySelector('[data-run-id="axe_read"]') as HTMLElement).click()
    await settle()
    expect(mounted.container.textContent).toContain('Outcome unknown; no automatic rerun')
    expect(mounted.container.textContent).not.toContain('must-not-render')
    expect(mounted.container.querySelector('[data-field="trigger-event"]')).toBeNull()
    expect(mounted.container.querySelector('[data-field="rule-snapshot"]')).toBeNull()
    expect(mounted.container.querySelector('[data-field="step-output"]')).toBeNull()
    expect(mounted.container.querySelector('[data-status="failed"]')).toBeNull()
  })

  it('ordinary real GET run fields and generic resolved display remain unchanged', async () => {
    const { client } = getClient([RUN_LIST], RUN_DETAIL)
    expect(await client.listAutomationRuns()).toEqual([RUN_LIST])
    expect(normalizeAutomationRunReadReference(RUN_LIST)).toBe(RUN_LIST)
    mounted = mount(client)
    await settle()
    expect(mounted.container.querySelector('[data-status="resolved"]')).not.toBeNull()
    expect(mounted.container.querySelector('[data-field="integration-read-status"]')).toBeNull()
  })
})

// 客户反馈 2026-09-24 #3 final review F1 — the step result used to be rendered as raw one-line JSON, so a zh
// admin read `"reason":"target_record_missing"`. Recognised values-free codes render as a sentence, and the
// code key is dropped from the JSON line (ids stay raw).
describe('AutomationExecutionsView — values-free step reasons render as copy (F1)', () => {
  const REASON_DETAIL: AutomationRunView = {
    ...RUN_DETAIL,
    id: 'axe_1',
    status: 'skipped',
    statusLegacy: 'skipped',
    steps: [
      { id: 'axe_1:step:0', executionId: 'axe_1', stepKey: '0', status: 'skipped', upstreamJobId: null, result: { recordId: 'rec_gone', sheetId: 'sheet-a', reason: 'target_record_missing' } },
      { id: 'axe_1:step:1', executionId: 'axe_1', stepKey: '1', status: 'resolved', upstreamJobId: 'axe_1:step:0', result: { approvalInstanceId: 'ai_1', backwriteSkipped: 'target_record_missing' } },
      { id: 'axe_1:step:2', executionId: 'axe_1', stepKey: '2', status: 'skipped', upstreamJobId: 'axe_1:step:1', result: { reason: 'APPROVAL_FWB_WRITEBACK_ENABLED is OFF' } },
    ],
  }

  for (const locale of [
    { name: 'zh', set: 'zh-CN', skipped: '触发记录已不存在，已跳过（未做任何修改）', backwrite: '审批结果未写回：触发记录已不存在（未做任何修改）' },
    { name: 'en', set: 'en', skipped: 'The trigger record no longer exists; skipped (nothing was changed).', backwrite: 'Approval result not written back: the trigger record no longer exists (nothing was changed).' },
  ] as const) {
    it(`${locale.name}: the reason sentences replace the internal code, ids stay, unknown reasons stay raw`, async () => {
      useLocale().setLocale(locale.set)
      const client = makeClient({ getAutomationRun: vi.fn().mockResolvedValue(REASON_DETAIL) })
      mounted = mount(client)
      await settle()
      ;(mounted.container.querySelector('[data-run-id="axe_1"]') as HTMLElement).click()
      await settle()

      const reasons = [...mounted.container.querySelectorAll('[data-field="step-reason"]')].map((el) => el.textContent?.trim())
      expect(reasons).toEqual([locale.skipped, locale.backwrite])
      const outputs = [...mounted.container.querySelectorAll('[data-field="step-output"]')].map((el) => el.textContent?.trim() ?? '')
      expect(outputs).toHaveLength(3)
      expect(outputs[0]).toContain('rec_gone')
      expect(outputs[1]).toContain('ai_1')
      for (const text of outputs.slice(0, 2)) expect(text).not.toContain('target_record_missing')
      // Positive control: a reason this change does not know is left exactly as before.
      expect(outputs[2]).toContain('APPROVAL_FWB_WRITEBACK_ENABLED is OFF')
      useLocale().setLocale('en')
    })
  }
})
