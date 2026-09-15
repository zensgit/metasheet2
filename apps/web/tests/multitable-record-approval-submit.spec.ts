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
 *
 * Round 2 (adversarial review) adds:
 *  7. The 409 identifiers are read off the REAL wire envelope, where the route nests them under
 *     `error.details` (routes/multitable-record-approvals.ts `fail()`); the flat shape stays supported
 *     as the legacy/tolerance case. Drop the `details` merge in `recordApprovalConflictFields` ⇒ red.
 *  8. The picker asks for the route's page-size CEILING (its default of 20 truncates silently) and says
 *     so when the answer fills it.
 *  9. A coded refusal renders LOCALIZED copy, not the route's fixed English sentence.
 * 10. The FROZEN shell re-emits `approval-submitted` (the prop half was pinned, the emit half was not).
 * 11. `aria-modal="true"` is backed by real focus/Esc behaviour.
 * 12. The inspector NEVER unmounts (MultitableWorkbench mounts it unconditionally), so the local
 *     `showApprovalSubmit` flag outlives any single record: a record that disappears under an OPEN
 *     dialog must not leave the flag set and auto-open the dialog against the NEXT record's id.
 *     Drop the `showApprovalSubmit.value = false` reset in the `props.record` watcher ⇒ red.
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
    listRecordApprovals: vi.fn().mockResolvedValue({ submissions: [], hasMore: false }),
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

  it('the FROZEN shell RE-EMITS approval-submitted 1:1 (delete the forwarding line ⇒ red)', async () => {
    // The prop half was already pinned above; without this case the shell could drop the emit and every
    // suite would stay green (design §2 item 10 asks for BOTH halves).
    const onApprovalSubmitted = vi.fn()
    const { container } = mountInspector({
      canSubmitApproval: true,
      component: MetaRecordDrawer,
      onApprovalSubmitted,
    })
    await flushUi()
    await openDialog(container)
    await pickTemplate('tpl_leave')
    setFieldValue('reason', '年假')
    await flushUi()
    submitBtn()!.click()
    await flushUi(8)
    expect(onApprovalSubmitted).toHaveBeenCalledWith(SUBMISSION)
  })
})

describe('送审对话框 / MetaRecordApprovalSubmitDialog', () => {
  it('asks the SERVER for published templates only and lists exactly what came back', async () => {
    const { container, client } = mountInspector({ canSubmitApproval: true })
    await flushUi()
    await openDialog(container)
    expect(client.listApprovalTemplates).toHaveBeenCalledTimes(1)
    // pageSize is the route's ceiling (MAX_APPROVAL_PAGE_SIZE): its DEFAULT of 20 would truncate the
    // picker silently, and this dialog has no paging and (by design) no free-text id fallback.
    expect(client.listApprovalTemplates).toHaveBeenCalledWith({ status: 'published', pageSize: 200 })
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
    // The row still has a real label target: an unsupported field renders no control, so the <label for>
    // pointed at nothing at all until the notice span took the control id.
    const unsupportedRow = document.querySelector('[data-testid="record-approval-field-unsupported-items"]')!
    const label = Array.from(dialog()!.querySelectorAll('label')).find((node) => node.textContent?.includes('明细'))!
    expect(label.getAttribute('for')).toBe(unsupportedRow.id)
    expect(unsupportedRow.id).not.toBe('')
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

  it('a CODED refusal renders localized copy, not the route\'s English sentence', async () => {
    // The route's refusals are fixed English strings ('Insufficient permissions'), which the shared
    // client surfaces as `error.message`; a zh operator must not read that.
    useLocale().setLocale('zh-CN')
    const denied = Object.assign(new Error('Insufficient permissions'), {
      status: 403,
      code: 'RECORD_APPROVAL_PERMISSION_DENIED',
    })
    const client = fakeApiClient({ submitRecordApproval: vi.fn().mockRejectedValue(denied) })
    const { container } = mountInspector({ canSubmitApproval: true, client })
    await flushUi()
    await openDialog(container)
    await pickTemplate('tpl_leave')
    setFieldValue('reason', '年假')
    await flushUi()
    submitBtn()!.click()
    await flushUi(8)
    const notice = document.querySelector('[data-testid="record-approval-submit-error"]')!
    expect(notice.textContent).toContain('没有送审权限')
    expect(notice.textContent).not.toContain('Insufficient permissions')
  })

  it('a VALIDATION_ERROR (form does not match the template) is localized too', async () => {
    useLocale().setLocale('zh-CN')
    const invalid = Object.assign(new Error('Approval creation was rejected'), {
      status: 400,
      code: 'VALIDATION_ERROR',
    })
    const client = fakeApiClient({ submitRecordApproval: vi.fn().mockRejectedValue(invalid) })
    const { container } = mountInspector({ canSubmitApproval: true, client })
    await flushUi()
    await openDialog(container)
    await pickTemplate('tpl_leave')
    setFieldValue('reason', '年假')
    await flushUi()
    submitBtn()!.click()
    await flushUi(8)
    expect(document.querySelector('[data-testid="record-approval-submit-error"]')!.textContent)
      .toContain('表单内容不符合模板要求')
  })

  it('warns when the template has an unpublished draft (the form shown is not the form validated)', async () => {
    const client = fakeApiClient({
      getApprovalTemplate: vi.fn().mockResolvedValue({ ...SIMPLE_FORM, activeVersionId: 'v1', latestVersionId: 'v2' }),
    })
    const { container } = mountInspector({ canSubmitApproval: true, client })
    await flushUi()
    await openDialog(container)
    expect(document.querySelector('[data-testid="record-approval-template-draft-notice"]')).toBeNull()
    await pickTemplate('tpl_leave')
    expect(document.querySelector('[data-testid="record-approval-template-draft-notice"]')).not.toBeNull()
    // It is a WARNING, not a block: the server still owns the verdict.
    setFieldValue('reason', '年假')
    await flushUi()
    expect(submitBtn()!.disabled).toBe(false)
  })

  it('says so when the published roster fills the page-size ceiling (no paging, no id fallback)', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `tpl_${i}`, name: `T${i}`, status: 'published' }))
    const client = fakeApiClient({ listApprovalTemplates: vi.fn().mockResolvedValue({ data: many, total: 200 }) })
    const { container } = mountInspector({ canSubmitApproval: true, client })
    await flushUi()
    await openDialog(container)
    expect(document.querySelector('[data-testid="record-approval-templates-truncated"]')).not.toBeNull()
  })

  it('does NOT cry truncation when the roster fits', async () => {
    const { container } = mountInspector({ canSubmitApproval: true })
    await flushUi()
    await openDialog(container)
    expect(document.querySelector('[data-testid="record-approval-templates-truncated"]')).toBeNull()
  })

  it('backs its aria-modal promise: focus lands inside, Esc closes only the dialog', async () => {
    const { container } = mountInspector({ canSubmitApproval: true })
    await flushUi()
    await openDialog(container)
    const modal = dialog()!
    expect(modal.contains(document.activeElement)).toBe(true)
    modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushUi(6)
    expect(dialog()).toBeNull()
    // The drawer itself is still open: Esc in the modal closed the modal only.
    expect(container.querySelector('[data-testid="record-inspector-menu"]')).not.toBeNull()
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

  it('reads the 409 identifiers out of the REAL envelope (error.details), not just a flat body', async () => {
    // routes/multitable-record-approvals.ts `fail()` nests them: { ok, error: { code, message, details } },
    // with details = { submissionId, approvalInstanceId, requestNo, status } (pinned by the backend's own
    // unit test). Reading only the flat keys made the dialog's request number + link dead in production.
    const fetchFn = vi.fn().mockResolvedValue(json({
      ok: false,
      error: {
        code: 'RECORD_APPROVAL_IN_FLIGHT',
        message: 'This record already has an in-flight approval for this template',
        details: { submissionId: 'sub_x', approvalInstanceId: 'inst_9', requestNo: 'AP-9', status: 'pending' },
      },
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

  it('getApprovalTemplate keeps the two version ids (draft-vs-active divergence is detectable)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({
      data: { id: 'tpl_leave', status: 'published', activeVersionId: 'v1', latestVersionId: 'v2', formSchema: { fields: [] } },
    }))
    const detail = await clientWith(fetchFn).getApprovalTemplate('tpl_leave')
    expect(detail.activeVersionId).toBe('v1')
    expect(detail.latestVersionId).toBe('v2')
  })

  it('listApprovalTemplates({ status, pageSize }) sends the page size the picker asked for', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ data: PUBLISHED_TEMPLATES, total: 2 }))
    await clientWith(fetchFn).listApprovalTemplates({ status: 'published', pageSize: 200 })
    expect(fetchFn).toHaveBeenCalledWith('/api/approval-templates?status=published&pageSize=200')
  })

  it('maps 409 to the typed in-flight error carrying approvalInstanceId/requestNo (flat legacy body)', async () => {
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
    const page = await clientWith(fetchFn).listRecordApprovals('sheet_1', 'rec_1')
    // No `?limit=` when the caller asked for none: an empty/garbage one is "said nothing" on the server
    // (clampRecordApprovalListLimit) and must not be sent as a page size the UI did not choose.
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/sheets/sheet_1/records/rec_1/approvals')
    expect(page.submissions).toHaveLength(2)
    expect(page.submissions[0].drift).toEqual({ changed: true, changedFieldIds: ['fld_a', 'fld_b'] })
    expect(page.submissions[1].drift).toEqual({ changed: false, changedFieldIds: [] })
    // hasMore ABSENT => false: an old server must not make the panel claim a truncation it cannot prove.
    expect(page.hasMore).toBe(false)
  })

  it('listRecordApprovals forwards ?limit= and returns the server hasMore (backend #5763)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({
      data: {
        submissions: [{ id: 'sub_1', templateId: 'tpl_leave', status: 'approved', error: 'RECORD_APPROVAL_NOTIFICATION_FAILED', drift: { changed: false, changedFieldIds: [] } }],
        hasMore: true,
      },
    }))
    const page = await clientWith(fetchFn).listRecordApprovals('sheet_1', 'rec_1', { limit: 20 })
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/sheets/sheet_1/records/rec_1/approvals?limit=20')
    expect(page.hasMore).toBe(true)
    // The ROW error code survives normalisation - the panel renders its marker from this, by CODE.
    expect(page.submissions[0].error).toBe('RECORD_APPROVAL_NOTIFICATION_FAILED')
  })

  it('a non-positive / non-finite limit is NOT sent, and a non-boolean hasMore is not believed', async () => {
    // A fresh Response per call: a Response body can only be read once.
    const fetchFn = vi.fn().mockImplementation(async () => json({ data: { submissions: [], hasMore: 'yes' } }))
    const page = await clientWith(fetchFn).listRecordApprovals('sheet_1', 'rec_1', { limit: 0 })
    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/sheets/sheet_1/records/rec_1/approvals')
    expect(page.hasMore).toBe(false)
    await clientWith(fetchFn).listRecordApprovals('sheet_1', 'rec_1', { limit: Number.NaN })
    expect(fetchFn).toHaveBeenLastCalledWith('/api/multitable/sheets/sheet_1/records/rec_1/approvals')
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

describe('选中记录消失时的对话框状态 / dialog state across a record switch', () => {
  it('a record that vanishes while the 送审 dialog is OPEN does not re-open it against the NEXT record', async () => {
    // Why this is not theoretical: MultitableWorkbench.vue mounts this shell with NO `v-if` at the call
    // site (only the shell's own root carries `v-if="visible"`), so the instance — and the local
    // `showApprovalSubmit` ref — lives for the whole workbench session. The dialog itself IS `v-if`-gated
    // on `record`, so a realtime delete (or the workbench clearing the selection) sets `record` to null
    // and DESTROYS the dialog without its `@close` ever running. The flag stays `true`; the next record
    // re-satisfies the `v-if` and the dialog reappears unasked, now carrying `:record-id="record.id"` of a
    // record the user never chose — one confirm away from 送审 on the wrong row.
    const container = document.createElement('div')
    document.body.appendChild(container)
    const record = ref<MetaRecord | null>(RECORD)
    const client = fakeApiClient()
    const app = createApp({
      render() {
        return h(MetaRecordInspector, {
          visible: true,
          record: record.value,
          fields: FIELDS,
          canEdit: true,
          canComment: false,
          canDelete: false,
          sheetId: 'sheet_1',
          apiClient: client as never,
          canSubmitApproval: true,
        })
      },
    })
    app.mount(container)
    mountedApps.push(app)
    await flushUi()

    await openDialog(container)
    expect(dialog()).not.toBeNull()

    // The record disappears underneath the open dialog.
    record.value = null
    await flushUi(6)
    expect(dialog()).toBeNull()

    // The next record arrives. Without the reset in the `props.record` watcher the dialog is back.
    record.value = { id: 'rec_2', version: 1, data: { fld_title: 'Beta' } } as unknown as MetaRecord
    await flushUi(6)
    expect(dialog()).toBeNull()
    expect(templateSelect()).toBeNull()

    // The entry is not broken by the reset — opening it deliberately for rec_2 still works.
    await openDialog(container)
    expect(dialog()).not.toBeNull()
  })

  it('an id-EQUAL record replacement (a background re-read) leaves an open dialog alone', async () => {
    // The other half of the line: the grid hands the shell a fresh `record` object for the SAME row
    // after any patch/re-read. Resetting on every replacement (rather than on an id change) would slam
    // a half-filled 送审 form shut on an unrelated background refresh.
    const container = document.createElement('div')
    document.body.appendChild(container)
    const record = ref<MetaRecord | null>(RECORD)
    const client = fakeApiClient()
    const app = createApp({
      render() {
        return h(MetaRecordInspector, {
          visible: true,
          record: record.value,
          fields: FIELDS,
          canEdit: true,
          canComment: false,
          canDelete: false,
          sheetId: 'sheet_1',
          apiClient: client as never,
          canSubmitApproval: true,
        })
      },
    })
    app.mount(container)
    mountedApps.push(app)
    await flushUi()

    await openDialog(container)
    expect(dialog()).not.toBeNull()

    record.value = { id: 'rec_1', version: 4, data: { fld_title: 'Alpha 2' } } as unknown as MetaRecord
    await flushUi(6)
    expect(dialog()).not.toBeNull()
  })
})
