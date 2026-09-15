/**
 * 记录级送审 前端 / Record-level approval submit — 多维表 × 审批 阶段二 PR 2b (design
 * docs/development/takeover-beiliao-20260821/multitable-approval-phase2-record-submit-design-20260915.md
 * §5, verification matrix §6 "前端" row).
 *
 * What this file pins (and what a mutation to each would break):
 *  1. The kebab entry is gated by BOTH the server-derived capability and a usable client — no
 *     `canSubmitApproval` ⇒ hidden (drop the `canSubmitApproval &&` half of the v-if ⇒ red), no
 *     `apiClient` ⇒ hidden (drop the `apiClient &&` half ⇒ red), both ⇒ shown.
 *  2. The template picker asks the SERVER for published templates (`{ status: 'published' }`), so a
 *     draft/archived template can never reach it — asserted on the mock's ARGUMENTS, not on a
 *     client-side filter of what happened to come back.
 *  3. A template carrying a field type the generic form cannot render REFUSES to submit and says so.
 *  4. A 409 surfaces the in-flight request number (link only where a router exists) instead of a
 *     generic failure.
 *  5. A success emits `approval-submitted` upward with the server's submission (the workbench toasts
 *     the request number off exactly that payload).
 *  6. The FROZEN MetaRecordDrawer compat shell forwards the new prop + emit 1:1 (design §2 item 10:
 *     a shell that silently drops them loses coverage for seven frozen specs).
 *
 * The client tier is covered here too (URL/body/normalization/409 typing) because those four methods
 * exist only for this surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import {
  MultitableApiClient,
  isRecordApprovalInFlightError,
} from '../src/multitable/api/client'
import type { MetaField, MetaRecord, MetaRecordApprovalSubmission } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const FIELDS = [{ id: 'fld_title', name: 'Title', type: 'string' }] as unknown as MetaField[]
const RECORD = { id: 'rec_1', version: 3, data: { fld_title: 'Alpha' } } as unknown as MetaRecord

const PUBLISHED_TEMPLATES = [
  { id: 'tpl_leave', name: '请假申请', status: 'published' },
  { id: 'tpl_purchase', name: '采购申请', status: 'published' },
]

const SIMPLE_FORM = {
  id: 'tpl_leave',
  name: '请假申请',
  status: 'published',
  formFields: [
    { id: 'reason', type: 'text', label: '事由', required: true },
    { id: 'days', type: 'number', label: '天数' },
    { id: 'urgent', type: 'checkbox', label: '加急' },
  ],
}

const UNSUPPORTED_FORM = {
  id: 'tpl_purchase',
  name: '采购申请',
  status: 'published',
  formFields: [
    { id: 'reason', type: 'text', label: '事由' },
    { id: 'items', type: 'detail', label: '明细' },
  ],
}

const SUBMISSION: MetaRecordApprovalSubmission = {
  id: 'sub_1',
  templateId: 'tpl_leave',
  status: 'pending',
  approvalInstanceId: 'inst_1',
  requestNo: 'AP-2026-0001',
  drift: { changed: false, changedFieldIds: [] },
}

function fakeApiClient(overrides: Record<string, unknown> = {}) {
  return {
    getRecordSubscriptionStatus: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
    subscribeRecord: vi.fn().mockResolvedValue({ subscribed: true, subscription: null }),
    unsubscribeRecord: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
    listRecordHistory: vi.fn().mockResolvedValue([]),
    listApprovalTemplates: vi.fn().mockResolvedValue({ data: PUBLISHED_TEMPLATES, total: 2 }),
    getApprovalTemplate: vi.fn().mockResolvedValue(SIMPLE_FORM),
    submitRecordApproval: vi.fn().mockResolvedValue(SUBMISSION),
    listRecordApprovals: vi.fn().mockResolvedValue([]),
    ...overrides,
  }
}

const mountedApps: App[] = []

interface HarnessOptions {
  canSubmitApproval?: boolean
  withClient?: boolean
  client?: ReturnType<typeof fakeApiClient>
  sheetId?: string | undefined
  withRouter?: boolean
  onApprovalSubmitted?: (submission: MetaRecordApprovalSubmission) => void
  component?: typeof MetaRecordInspector | typeof MetaRecordDrawer
}

function mountInspector(options: HarnessOptions = {}): {
  container: HTMLElement
  app: App
  client: ReturnType<typeof fakeApiClient>
  router: Router | null
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const client = options.client ?? fakeApiClient()
  const component = options.component ?? MetaRecordInspector
  const app = createApp({
    render() {
      return h(component as never, {
        visible: true,
        record: RECORD,
        fields: FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: false,
        sheetId: 'sheetId' in options ? options.sheetId : 'sheet_1',
        ...(options.withClient === false ? {} : { apiClient: client }),
        ...(options.canSubmitApproval === undefined ? {} : { canSubmitApproval: options.canSubmitApproval }),
        ...(options.onApprovalSubmitted ? { onApprovalSubmitted: options.onApprovalSubmitted } : {}),
      })
    },
  })
  let router: Router | null = null
  if (options.withRouter) {
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: { template: '<div />' } },
        { path: '/approvals/:id', name: 'approval-detail', component: { template: '<div />' } },
      ],
    })
    app.use(router)
  }
  app.mount(container)
  mountedApps.push(app)
  return { container, app, client, router }
}

async function openKebab(root: HTMLElement) {
  const trigger = root.querySelector<HTMLButtonElement>('[data-testid="record-inspector-menu"]')
  expect(trigger).not.toBeNull()
  trigger!.focus()
  // Same millisecond-stamp race the sibling drawer specs document (Vue's DOM event invoker drops a
  // click whose `_vts` equals the outer handler's `attached` stamp): let ≥1ms of real time elapse.
  const start = Date.now()
  for (let i = 0; i < 50 && Date.now() <= start; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1))
  trigger!.click()
  await flushUi()
  for (let i = 0; i < 10 && !document.querySelector('.mt-menu'); i += 1) await flushUi()
  expect(document.querySelector('.mt-menu')).not.toBeNull()
}

const submitApprovalItem = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="record-inspector-submit-approval"]')
const dialog = () => document.querySelector<HTMLElement>('[data-testid="record-approval-dialog"]')
const submitBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="record-approval-submit"]')
const templateSelect = () => document.querySelector<HTMLSelectElement>('[data-testid="record-approval-template-select"]')

async function openDialog(container: HTMLElement) {
  await openKebab(container)
  const item = submitApprovalItem()
  expect(item).not.toBeNull()
  item!.click()
  await flushUi(6)
  expect(dialog()).not.toBeNull()
}

async function pickTemplate(templateId: string) {
  const select = templateSelect()
  expect(select).not.toBeNull()
  select!.value = templateId
  select!.dispatchEvent(new Event('change'))
  await flushUi(6)
}

function setFieldValue(fieldId: string, value: string) {
  const control = document.querySelector<HTMLInputElement>(`[data-testid="record-approval-field-${fieldId}"]`)
  expect(control).not.toBeNull()
  control!.value = value
  control!.dispatchEvent(new Event('input'))
}

afterEach(() => {
  while (mountedApps.length > 0) {
    try { mountedApps.pop()!.unmount() } catch { /* already unmounted */ }
  }
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('记录抽屉 送审 entry (kebab gating)', () => {
  it('hides the 送审 item when canSubmitApproval is absent (fail-closed default)', async () => {
    const { container } = mountInspector()
    await flushUi()
    await openKebab(container)
    expect(submitApprovalItem()).toBeNull()
  })

  it('hides the 送审 item when canSubmitApproval is explicitly false', async () => {
    const { container } = mountInspector({ canSubmitApproval: false })
    await flushUi()
    await openKebab(container)
    expect(submitApprovalItem()).toBeNull()
  })

  it('hides the 送审 item when the capability is granted but no apiClient is mounted', async () => {
    // The router-less / client-less harness shape several FROZEN drawer specs use (design §2 item 10).
    const { container } = mountInspector({ canSubmitApproval: true, withClient: false })
    await flushUi()
    await openKebab(container)
    expect(submitApprovalItem()).toBeNull()
  })

  it('hides the 送审 item when the capability is granted but there is no sheetId', async () => {
    const { container } = mountInspector({ canSubmitApproval: true, sheetId: undefined })
    await flushUi()
    await openKebab(container)
    expect(submitApprovalItem()).toBeNull()
  })

  it('shows the 送审 item with capability + client + sheetId + record', async () => {
    const { container } = mountInspector({ canSubmitApproval: true })
    await flushUi()
    await openKebab(container)
    expect(submitApprovalItem()).not.toBeNull()
    expect(submitApprovalItem()!.textContent).toContain('Submit for approval')
  })

  it('renders no submit dialog until the kebab item is selected', async () => {
    const { container } = mountInspector({ canSubmitApproval: true })
    await flushUi()
    expect(dialog()).toBeNull()
    await openDialog(container)
    expect(dialog()!.getAttribute('role')).toBe('dialog')
    expect(dialog()!.getAttribute('aria-label')).toBe('Submit for approval')
  })

  it('the FROZEN MetaRecordDrawer shell forwards canSubmitApproval 1:1 (design §2 item 10)', async () => {
    const { container } = mountInspector({ canSubmitApproval: true, component: MetaRecordDrawer })
    await flushUi()
    await openKebab(container)
    expect(submitApprovalItem()).not.toBeNull()
  })

  it('the FROZEN shell keeps the entry hidden when the capability is absent', async () => {
    const { container } = mountInspector({ component: MetaRecordDrawer })
    await flushUi()
    await openKebab(container)
    expect(submitApprovalItem()).toBeNull()
  })
})

describe('送审对话框 / MetaRecordApprovalSubmitDialog', () => {
  it('asks the SERVER for published templates only and lists exactly what came back', async () => {
    const { container, client } = mountInspector({ canSubmitApproval: true })
    await flushUi()
    await openDialog(container)
    expect(client.listApprovalTemplates).toHaveBeenCalledTimes(1)
    expect(client.listApprovalTemplates).toHaveBeenCalledWith({ status: 'published' })
    const options = Array.from(templateSelect()!.querySelectorAll('option')).map((o) => o.value)
    // option[0] is the placeholder; the rest are exactly the roster the server returned.
    expect(options).toEqual(['', 'tpl_leave', 'tpl_purchase'])
  })

  it('shows the no-template / no-permission notice and NO free-text id input when the roster is empty', async () => {
    const client = fakeApiClient({ listApprovalTemplates: vi.fn().mockResolvedValue({ data: [], total: 0 }) })
    const { container } = mountInspector({ canSubmitApproval: true, client })
    await flushUi()
    await openDialog(container)
    expect(document.querySelector('[data-testid="record-approval-templates-unavailable"]')).not.toBeNull()
    expect(templateSelect()).toBeNull()
    // The design forbids degrading to a hand-typed template id: no text input anywhere in the dialog.
    expect(dialog()!.querySelectorAll('input[type="text"], input:not([type])')).toHaveLength(0)
  })

  it('shows the same notice when the roster read is refused (403)', async () => {
    const forbidden = Object.assign(new Error('forbidden'), { status: 403 })
    const client = fakeApiClient({ listApprovalTemplates: vi.fn().mockRejectedValue(forbidden) })
    const { container } = mountInspector({ canSubmitApproval: true, client })
    await flushUi()
    await openDialog(container)
    expect(document.querySelector('[data-testid="record-approval-templates-unavailable"]')).not.toBeNull()
    expect(submitBtn()!.disabled).toBe(true)
  })

  it('loads the picked template form and enables submit once every required field is filled', async () => {
    const { container, client } = mountInspector({ canSubmitApproval: true })
    await flushUi()
    await openDialog(container)
    expect(client.getApprovalTemplate).not.toHaveBeenCalled()
    await pickTemplate('tpl_leave')
    expect(client.getApprovalTemplate).toHaveBeenCalledWith('tpl_leave')
    expect(submitBtn()!.disabled).toBe(true)
    expect(document.querySelector('[data-testid="record-approval-required-notice"]')).not.toBeNull()
    setFieldValue('reason', '年假')
    await flushUi()
    expect(submitBtn()!.disabled).toBe(false)
  })

  it('a template with an unsupported field type disables submit and says why', async () => {
    const client = fakeApiClient({ getApprovalTemplate: vi.fn().mockResolvedValue(UNSUPPORTED_FORM) })
    const { container } = mountInspector({ canSubmitApproval: true, client })
    await flushUi()
    await openDialog(container)
    await pickTemplate('tpl_purchase')
    expect(document.querySelector('[data-testid="record-approval-unsupported-notice"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="record-approval-field-unsupported-items"]')).not.toBeNull()
    expect(submitBtn()!.disabled).toBe(true)
    // Even filling the supported field does not unlock it.
    setFieldValue('reason', '采购')
    await flushUi()
    expect(submitBtn()!.disabled).toBe(true)
  })

  it('submits { templateId, formData } and emits approval-submitted with the server submission', async () => {
    const onApprovalSubmitted = vi.fn()
    const { container, client } = mountInspector({ canSubmitApproval: true, onApprovalSubmitted })
    await flushUi()
    await openDialog(container)
    await pickTemplate('tpl_leave')
    setFieldValue('reason', '年假')
    setFieldValue('days', '2')
    await flushUi()
    submitBtn()!.click()
    await flushUi(8)
    expect(client.submitRecordApproval).toHaveBeenCalledWith('sheet_1', 'rec_1', {
      templateId: 'tpl_leave',
      formData: { reason: '年假', days: 2, urgent: false },
    })
    expect(onApprovalSubmitted).toHaveBeenCalledWith(SUBMISSION)
    // Success closes the dialog (the inspector owns the open state).
    await flushUi()
    expect(dialog()).toBeNull()
  })

  it('409 shows the in-flight notice with the request number (no router ⇒ no link, no crash)', async () => {
    const conflict = Object.assign(new Error('in flight'), { status: 409 })
    conflict.name = 'MultitableRecordApprovalInFlightError'
    Object.assign(conflict, { code: 'RECORD_APPROVAL_IN_FLIGHT', approvalInstanceId: 'inst_9', requestNo: 'AP-2026-0009' })
    const onApprovalSubmitted = vi.fn()
    const client = fakeApiClient({ submitRecordApproval: vi.fn().mockRejectedValue(conflict) })
    const { container } = mountInspector({ canSubmitApproval: true, client, onApprovalSubmitted })
    await flushUi()
    await openDialog(container)
    await pickTemplate('tpl_leave')
    setFieldValue('reason', '年假')
    await flushUi()
    submitBtn()!.click()
    await flushUi(8)
    const notice = document.querySelector('[data-testid="record-approval-in-flight-notice"]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('already in approval')
    expect(document.querySelector('[data-testid="record-approval-in-flight-request-no"]')!.textContent).toBe('AP-2026-0009')
    // Router-less mount: the instance link is suppressed by the hasRouter guard, the notice still shows.
    expect(document.querySelector('[data-testid="record-approval-in-flight-link"]')).toBeNull()
    expect(onApprovalSubmitted).not.toHaveBeenCalled()
    expect(dialog()).not.toBeNull()
  })

  it('409 renders the instance link when a router IS present', async () => {
    const conflict = Object.assign(new Error('in flight'), { status: 409 })
    conflict.name = 'MultitableRecordApprovalInFlightError'
    Object.assign(conflict, { approvalInstanceId: 'inst_9', requestNo: 'AP-2026-0009' })
    const client = fakeApiClient({ submitRecordApproval: vi.fn().mockRejectedValue(conflict) })
    const { container } = mountInspector({ canSubmitApproval: true, client, withRouter: true })
    await flushUi()
    await openDialog(container)
    await pickTemplate('tpl_leave')
    setFieldValue('reason', '年假')
    await flushUi()
    submitBtn()!.click()
    await flushUi(8)
    const link = document.querySelector<HTMLAnchorElement>('[data-testid="record-approval-in-flight-link"]')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('/approvals/inst_9')
  })

  it('a non-409 failure shows the plain submit error, never the in-flight notice', async () => {
    const client = fakeApiClient({
      submitRecordApproval: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 })),
    })
    const { container } = mountInspector({ canSubmitApproval: true, client })
    await flushUi()
    await openDialog(container)
    await pickTemplate('tpl_leave')
    setFieldValue('reason', '年假')
    await flushUi()
    submitBtn()!.click()
    await flushUi(8)
    expect(document.querySelector('[data-testid="record-approval-in-flight-notice"]')).toBeNull()
    expect(document.querySelector('[data-testid="record-approval-submit-error"]')!.textContent).toContain('boom')
  })
})

describe('client tier — the four record-approval methods', () => {
  function clientWith(fetchFn: ReturnType<typeof vi.fn>) {
    return new MultitableApiClient({ fetchFn: fetchFn as never })
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('listApprovalTemplates() with no argument keeps the pre-existing unfiltered URL (#5747 re-wrap intact)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ data: PUBLISHED_TEMPLATES, total: 2 }))
    const result = await clientWith(fetchFn).listApprovalTemplates()
    expect(fetchFn).toHaveBeenCalledWith('/api/approval-templates')
    expect(result).toEqual({ data: PUBLISHED_TEMPLATES, total: 2 })
  })

  it('listApprovalTemplates({ status }) sends the status as a SERVER query parameter', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ data: PUBLISHED_TEMPLATES, total: 2 }))
    await clientWith(fetchFn).listApprovalTemplates({ status: 'published' })
    expect(fetchFn).toHaveBeenCalledWith('/api/approval-templates?status=published')
  })

  it('getApprovalTemplate normalizes the active version form schema and drops values (no defaultValue)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({
      data: {
        id: 'tpl_leave',
        name: '请假申请',
        status: 'published',
        formSchema: {
          fields: [
            { id: 'reason', type: 'text', label: '事由', required: true, defaultValue: '上次填的' },
            { id: 'kind', type: 'select', label: '类型', options: [{ label: '年假', value: 'annual' }] },
            { type: 'text', label: 'no id — dropped' },
          ],
        },
      },
    }))
    const detail = await clientWith(fetchFn).getApprovalTemplate('tpl_leave')
    expect(fetchFn).toHaveBeenCalledWith('/api/approval-templates/tpl_leave')
    expect(detail.id).toBe('tpl_leave')
    expect(detail.formFields).toEqual([
      { id: 'reason', type: 'text', label: '事由', required: true },
      { id: 'kind', type: 'select', label: '类型', options: [{ label: '年假', value: 'annual' }] },
    ])
    expect(JSON.stringify(detail)).not.toContain('上次填的')
  })

  it('submitRecordApproval POSTs to the record-scoped route and normalizes the submission', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({
      data: { submission: { id: 'sub_1', templateId: 'tpl_leave', status: 'pending', approvalInstanceId: 'inst_1', requestNo: 'AP-1', recordVersionAtSubmit: 3 } },
    }))
    const submission = await clientWith(fetchFn).submitRecordApproval('sheet_1', 'rec_1', {
      templateId: 'tpl_leave',
      formData: { reason: 'x' },
    })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/multitable/sheets/sheet_1/records/rec_1/approvals')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ templateId: 'tpl_leave', formData: { reason: 'x' } })
    expect(submission).toEqual({
      id: 'sub_1',
      templateId: 'tpl_leave',
      status: 'pending',
      approvalInstanceId: 'inst_1',
      requestNo: 'AP-1',
      recordVersionAtSubmit: 3,
      drift: { changed: false, changedFieldIds: [] },
    })
  })

  it('maps 409 to the typed in-flight error carrying approvalInstanceId/requestNo', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({
      error: { code: 'RECORD_APPROVAL_IN_FLIGHT', message: '已在审批中', approvalInstanceId: 'inst_9', requestNo: 'AP-9' },
    }, 409))
    await expect(clientWith(fetchFn).submitRecordApproval('sheet_1', 'rec_1', { templateId: 't', formData: {} }))
      .rejects.toSatisfy((error: unknown) => {
        if (!isRecordApprovalInFlightError(error)) return false
        return error.status === 409
          && error.code === 'RECORD_APPROVAL_IN_FLIGHT'
          && error.approvalInstanceId === 'inst_9'
          && error.requestNo === 'AP-9'
      })
  })

  it('a non-409 submit failure stays a plain MultitableApiError (not the in-flight type)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ error: { code: 'RECORD_APPROVAL_PERMISSION_DENIED' } }, 403))
    await expect(clientWith(fetchFn).submitRecordApproval('sheet_1', 'rec_1', { templateId: 't', formData: {} }))
      .rejects.toSatisfy((error: unknown) => !isRecordApprovalInFlightError(error) && (error as { status?: number }).status === 403)
  })

  it('listRecordApprovals GETs the same route and normalizes drift (ids only, never values)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({
      data: {
        submissions: [
          { id: 'sub_1', templateId: 'tpl_leave', templateName: '请假申请', status: 'pending', requestNo: 'AP-1', submittedBy: 'u1', createdAt: '2026-09-15T02:00:00.000Z', drift: { changed: true, changedFieldIds: ['fld_a', 'fld_b'] } },
          { id: 'sub_0', templateId: 'tpl_leave', status: 'approved', drift: { changed: false, changedFieldIds: [] } },
          { notASubmission: true },
        ],
      },
    }))
    const rows = await clientWith(fetchFn).listRecordApprovals('sheet_1', 'rec_1')
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/sheets/sheet_1/records/rec_1/approvals')
    expect(rows).toHaveLength(2)
    expect(rows[0].drift).toEqual({ changed: true, changedFieldIds: ['fld_a', 'fld_b'] })
    expect(rows[1].drift).toEqual({ changed: false, changedFieldIds: [] })
  })
})

describe('reactivity of the capability prop', () => {
  it('flipping canSubmitApproval false → true reveals the entry without a remount', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const canSubmitApproval = ref(false)
    const client = fakeApiClient()
    const app = createApp({
      render() {
        return h(MetaRecordInspector, {
          visible: true,
          record: RECORD,
          fields: FIELDS,
          canEdit: true,
          canComment: false,
          canDelete: false,
          sheetId: 'sheet_1',
          apiClient: client as never,
          canSubmitApproval: canSubmitApproval.value,
        })
      },
    })
    app.mount(container)
    mountedApps.push(app)
    await flushUi()
    await openKebab(container)
    expect(submitApprovalItem()).toBeNull()
    canSubmitApproval.value = true
    await flushUi()
    expect(submitApprovalItem()).not.toBeNull()
  })
})
