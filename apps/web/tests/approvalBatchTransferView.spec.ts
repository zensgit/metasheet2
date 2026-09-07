import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { routerKey } from 'vue-router'
import { resolveAdminRouteRedirect } from '../src/router/adminAccess'
import { appRoutes } from '../src/router/appRoutes'
import {
  blockReasonForTransfer,
  buildTransferOutcomes,
  describeSkipReason,
  isKnownSkipReason,
  summarizeTransferOutcomes,
  APPROVAL_BATCH_TRANSFER_SKIP_LABELS,
} from '../src/approvals/batchTransfer'
import { normalizeBulkReassignEnvelope } from '../src/approvals/api'
import { useLocale } from '../src/composables/useLocale'

// P1b slice 3 — the admin 批量转交 page over the EXISTING bulk reassign endpoint.
//
// WHAT IS MOCKED, AND WHY IT IS THE TRANSPORT AND NOT THE CLIENT: only `../src/utils/api`'s
// `apiGet`/`apiPost` are replaced. The view therefore runs the REAL
// `listPendingApprovalsForApprover` / `bulkReassignApprovals`, so these tests pin the whole chain —
// which control triggers which call, the request PATH and QUERY, and the request BODY — instead of
// pinning a client stub that could disagree with the wire. `../src/approvals/api` deliberately has
// no USE_MOCK branch on those two functions; a mock branch would be active under vitest
// (import.meta.env.DEV is true) and would make every payload assertion here vacuously green.

const apiGetSpy = vi.fn()
const apiPostSpy = vi.fn()
vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return {
    ...actual,
    getApiBase: () => 'http://example.test',
    apiGet: (...args: unknown[]) => apiGetSpy(...args),
    apiPost: (...args: unknown[]) => apiPostSpy(...args),
  }
})

const confirmSpy = vi.fn()
const messageSuccessSpy = vi.fn()
const messageErrorSpy = vi.fn()
vi.mock('element-plus', () => ({
  ElMessage: {
    success: (...a: unknown[]) => messageSuccessSpy(...a),
    error: (...a: unknown[]) => messageErrorSpy(...a),
    warning: vi.fn(),
  },
  ElMessageBox: { confirm: (...a: unknown[]) => confirmSpy(...a) },
}))

// The real picker fetches the participant directory on mount; the stub keeps these tests on the
// page's own behaviour while still exposing the props the page binds (notably `excludedUserIds`,
// which is how "source and target must differ" is enforced through the EXISTING picker API).
vi.mock('../src/approvals/components/ApprovalUserPicker.vue', async () => {
  const { defineComponent: dc, h: vh } = await import('vue')
  return {
    default: dc({
      name: 'ApprovalUserPicker',
      props: {
        modelValue: { type: [String, Array], default: null },
        placeholder: { type: String, default: '' },
        excludedUserIds: { type: Array, default: () => [] },
      },
      emits: ['update:modelValue'],
      render() {
        return vh('input', {
          'data-testid': (this.$attrs as Record<string, string>)['data-testid'],
          'data-approval-user-picker': 'true',
          'data-excluded': (this.excludedUserIds as string[]).join(','),
          value: (this.modelValue as string | null) ?? '',
          onInput: (event: Event) => {
            const value = (event.target as HTMLInputElement).value
            this.$emit('update:modelValue', value.length > 0 ? value : null)
          },
        })
      },
    }),
  }
})

function passthrough(name: string, tag = 'div') {
  return defineComponent({
    name,
    render() {
      return h(tag, { 'data-testid': (this.$attrs as Record<string, string>)['data-testid'] }, this.$slots.default?.())
    },
  })
}

const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, loading: Boolean, disabled: Boolean },
  emits: ['click'],
  render() {
    return h('button', {
      type: 'button',
      disabled: this.disabled || this.loading,
      'data-testid': (this.$attrs as Record<string, string>)['data-testid'],
      onClick: (event: Event) => this.$emit('click', event),
    }, this.$slots.default?.())
  },
})

const ElInput = defineComponent({
  name: 'ElInput',
  props: { modelValue: { type: String, default: '' }, type: String, rows: Number, placeholder: String },
  emits: ['update:modelValue'],
  render() {
    return h('textarea', {
      'data-testid': (this.$attrs as Record<string, string>)['data-testid'],
      value: this.modelValue,
      onInput: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
    })
  },
})

const ElCheckbox = defineComponent({
  name: 'ElCheckbox',
  props: { modelValue: { type: Boolean, default: false }, disabled: Boolean },
  emits: ['update:modelValue'],
  render() {
    return h('input', {
      type: 'checkbox',
      checked: this.modelValue,
      disabled: this.disabled,
      'data-testid': (this.$attrs as Record<string, string>)['data-testid'],
      onChange: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLInputElement).checked),
    })
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, type: String, showIcon: Boolean, closable: Boolean },
  render() {
    return h('div', { 'data-testid': (this.$attrs as Record<string, string>)['data-testid'] }, this.title)
  },
})

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function listRow(id: string, title: string) {
  return {
    id,
    sourceSystem: 'platform',
    externalApprovalId: null,
    workflowKey: null,
    businessKey: null,
    title,
    status: 'pending',
    requester: null,
    subject: null,
    policy: null,
    currentStep: 1,
    totalSteps: 2,
    assignments: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Route admin gate
// ─────────────────────────────────────────────────────────────────────────────
describe('批量转交 route admin gate', () => {
  const flags = {
    loadProductFeatures: vi.fn().mockResolvedValue(undefined),
    resolveHomePath: () => '/home',
  } as unknown as Parameters<typeof resolveAdminRouteRedirect>[2]

  function batchTransferRoute() {
    return appRoutes.find((route) => route.path === '/approvals/batch-transfer')
  }

  it('the route exists and points at the new view', () => {
    const route = batchTransferRoute()
    expect(route).toBeTruthy()
    expect(route!.name).toBe('approval-batch-transfer')
    expect(route!.meta?.requiresAuth).toBe(true)
    expect(route!.meta?.requiresAdmin).toBe(true)
  })

  it('a NON-ADMIN is redirected away by the existing admin guard', async () => {
    const redirect = await resolveAdminRouteRedirect(
      { meta: batchTransferRoute()!.meta } as Parameters<typeof resolveAdminRouteRedirect>[0],
      { hasAdminAccess: () => false },
      flags,
    )
    expect(redirect).toBe('/home')
  })

  it('an admin is let through by that same guard (positive control)', async () => {
    const redirect = await resolveAdminRouteRedirect(
      { meta: batchTransferRoute()!.meta } as Parameters<typeof resolveAdminRouteRedirect>[0],
      { hasAdminAccess: () => true },
      flags,
    )
    expect(redirect).toBeNull()
  })

  it('the guard itself only fires on requiresAdmin routes (negative control on the same helper)', async () => {
    const selfService = appRoutes.find((route) => route.path === '/my-delegation')
    const redirect = await resolveAdminRouteRedirect(
      { meta: selfService!.meta } as Parameters<typeof resolveAdminRouteRedirect>[0],
      { hasAdminAccess: () => false },
      flags,
    )
    expect(redirect).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────
describe('批量转交 outcome helpers', () => {
  it('joins succeeded / skipped back onto the submitted ids in the operator’s order', () => {
    const outcomes = buildTransferOutcomes(['a', 'b', 'c'], {
      succeeded: ['c', 'a'],
      skipped: [{ id: 'b', reason: 'not-pending' }],
      affectedRequesterIds: [],
    })
    expect(outcomes).toEqual([
      { id: 'a', kind: 'transferred' },
      { id: 'b', kind: 'skipped', reason: 'not-pending' },
      { id: 'c', kind: 'transferred' },
    ])
  })

  it('reports an id the server mentioned in NEITHER array as unreported, never as transferred', () => {
    const outcomes = buildTransferOutcomes(['a', 'ghost'], {
      succeeded: ['a'],
      skipped: [],
      affectedRequesterIds: [],
    })
    expect(outcomes[1]).toEqual({ id: 'ghost', kind: 'unreported' })
    expect(summarizeTransferOutcomes(outcomes)).toEqual({
      submitted: 2, transferred: 1, skipped: 0, unreported: 1,
    })
  })

  it('names every skip code the server declares, and falls back for an unrecognised one', () => {
    // The server union, transcribed from ApprovalProductService's ApprovalBulkReassignSkipReason.
    const serverCodes = [
      'not-found', 'not-pending', 'not-assigned',
      'target-is-requester', 'target-already-assignee', 'target-user-invalid', 'error',
    ]
    expect(Object.keys(APPROVAL_BATCH_TRANSFER_SKIP_LABELS).sort()).toEqual([...serverCodes].sort())
    const rendered = serverCodes.map((code) => describeSkipReason(code, true))
    expect(new Set(rendered).size).toBe(serverCodes.length)
    for (const code of serverCodes) {
      expect(isKnownSkipReason(code)).toBe(true)
      expect(describeSkipReason(code, false)).not.toBe('')
    }
    expect(isKnownSkipReason('a-code-added-later')).toBe(false)
    expect(describeSkipReason('a-code-added-later', true)).toBe('未转交（原因未知）')
  })

  it('blocks a submit for each refusal the endpoint itself makes', () => {
    const base = { fromUserId: 'u1', toUserId: 'u2', reason: 'cover', selectedIds: ['a'] }
    expect(blockReasonForTransfer(base)).toBeNull()
    expect(blockReasonForTransfer({ ...base, fromUserId: ' ' })).toBe('no-source')
    expect(blockReasonForTransfer({ ...base, toUserId: '' })).toBe('no-target')
    expect(blockReasonForTransfer({ ...base, toUserId: 'u1' })).toBe('same-user')
    expect(blockReasonForTransfer({ ...base, selectedIds: [] })).toBe('no-selection')
    expect(blockReasonForTransfer({ ...base, reason: '   ' })).toBe('no-reason')
    expect(blockReasonForTransfer({ ...base, selectedIds: Array.from({ length: 201 }, (_, i) => `a${i}`) })).toBe('over-limit')
  })

  it('unwraps the endpoint’s {ok,data} envelope (the shape the server actually sends)', () => {
    const unwrapped = normalizeBulkReassignEnvelope({
      ok: true,
      data: { succeeded: ['a'], skipped: [{ id: 'b', reason: 'error' }], affectedRequesterIds: ['r1'] },
    })
    expect(unwrapped).toEqual({
      succeeded: ['a'], skipped: [{ id: 'b', reason: 'error' }], affectedRequesterIds: ['r1'],
    })
    // Fails closed rather than throwing on a shape it does not recognise.
    expect(normalizeBulkReassignEnvelope(null)).toEqual({ succeeded: [], skipped: [], affectedRequesterIds: [] })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Mounted page
// ─────────────────────────────────────────────────────────────────────────────
describe('ApprovalBatchTransferView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    apiGetSpy.mockReset()
    apiPostSpy.mockReset()
    confirmSpy.mockReset().mockResolvedValue(undefined)
    messageSuccessSpy.mockReset()
    messageErrorSpy.mockReset()
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  async function mountView(): Promise<HTMLElement> {
    const { default: View } = await import('../src/views/approval/ApprovalBatchTransferView.vue')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View)
    app.component('ElButton', ElButton)
    app.component('ElInput', ElInput)
    app.component('ElCheckbox', ElCheckbox)
    app.component('ElAlert', ElAlert)
    app.component('ElSelect', passthrough('ElSelect', 'select'))
    app.component('ElOption', passthrough('ElOption', 'option'))
    // PageHeader (shared chrome) resolves an el-icon and calls useRouter(); neither is exercised
    // here (no `backTo` prop), so both are quieted rather than wired to a real router.
    app.component('ElIcon', passthrough('ElIcon', 'i'))
    app.provide(routerKey, { push: vi.fn(), back: vi.fn() })
    app.mount(container)
    await flushUi()
    return container
  }

  function q<T extends HTMLElement>(root: HTMLElement, testId: string): T {
    return root.querySelector(`[data-testid="${testId}"]`) as T
  }

  async function setPicker(root: HTMLElement, testId: string, value: string): Promise<void> {
    const input = q<HTMLInputElement>(root, testId)
    input.value = value
    input.dispatchEvent(new Event('input'))
    await flushUi()
  }

  async function setReason(root: HTMLElement, value: string): Promise<void> {
    const box = q<HTMLTextAreaElement>(root, 'batch-transfer-reason')
    box.value = value
    box.dispatchEvent(new Event('input'))
    await flushUi()
  }

  async function loadTwoRows(root: HTMLElement): Promise<void> {
    apiGetSpy.mockResolvedValue({ data: [listRow('apv_1', '出差申请'), listRow('apv_2', '采购申请')], total: 2 })
    await setPicker(root, 'batch-transfer-source-picker', 'user_from')
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()
  }

  it('lists the SELECTED approver’s pending items through the existing projection', async () => {
    const root = await mountView()
    await loadTwoRows(root)

    expect(apiGetSpy).toHaveBeenCalledTimes(1)
    const url = String(apiGetSpy.mock.calls[0][0])
    const [path, query] = url.split('?')
    const params = new URLSearchParams(query)
    expect(path).toBe('/api/approvals')
    expect(params.get('assignee')).toBe('user_from')
    expect(params.get('status')).toBe('pending')
    expect(params.get('sourceSystem')).toBe('platform')
    expect(params.get('limit')).toBe('200')
    // NO `tab`: the pending TAB conjoins an active-seat subquery bound to the CALLING actor, which
    // would silently list the admin's own queue instead of the picked approver's.
    expect(params.get('tab')).toBeNull()

    expect(q(root, 'batch-transfer-row-apv_1')).toBeTruthy()
    expect(q(root, 'batch-transfer-row-apv_2')).toBeTruthy()
    expect(q(root, 'batch-transfer-selected-count').textContent).toContain('已选 2 / 2')
  })

  it('says so when the approver has MORE pending items than one request can load', async () => {
    const root = await mountView()
    // 3 rows returned, 250 reported by the server: a complete-looking page that is not the queue.
    apiGetSpy.mockResolvedValue({
      data: [listRow('apv_1', 'A'), listRow('apv_2', 'B'), listRow('apv_3', 'C')],
      total: 250,
    })
    await setPicker(root, 'batch-transfer-source-picker', 'user_from')
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()

    const notice = q(root, 'batch-transfer-truncated')
    expect(notice).toBeTruthy()
    expect(notice.textContent).toContain('250')
    expect(notice.textContent).toContain('3')
    // The remedy is named, not left to be discovered by reloading and noticing rows come back.
    expect(notice.textContent).toContain('重新载入')
  })

  it('shows no truncation notice when the page IS the whole queue', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    expect(q(root, 'batch-transfer-truncated')).toBeNull()
  })

  it('clears the truncation notice when the source approver changes', async () => {
    const root = await mountView()
    apiGetSpy.mockResolvedValue({ data: [listRow('apv_1', 'A')], total: 250 })
    await setPicker(root, 'batch-transfer-source-picker', 'user_from')
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()
    expect(q(root, 'batch-transfer-truncated')).toBeTruthy()

    await setPicker(root, 'batch-transfer-source-picker', 'user_other')
    expect(q(root, 'batch-transfer-truncated')).toBeNull()
  })

  it('labels a row with neither a title nor a request number by ORDINAL, never by its raw id', async () => {
    const root = await mountView()
    const untitled = { ...listRow('apv_9', ''), title: null as string | null, requestNo: null as string | null }
    apiGetSpy.mockResolvedValue({ data: [untitled], total: 1 })
    await setPicker(root, 'batch-transfer-source-picker', 'user_from')
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()

    const title = q(root, 'batch-transfer-row-apv_9').querySelector('.batch-transfer__row-title')
    expect(title?.textContent?.trim()).toBe('审批 1')
    expect(title?.textContent).not.toContain('apv_9')
  })

  it('passes the source approver to the target picker’s exclusion list', async () => {
    const root = await mountView()
    await setPicker(root, 'batch-transfer-source-picker', 'user_from')
    expect(q(root, 'batch-transfer-target-picker').getAttribute('data-excluded')).toBe('user_from')
  })

  it('confirms before submitting, and makes NO request when the operator cancels', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '原审批人休假')

    confirmSpy.mockRejectedValueOnce(new Error('cancel'))
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(apiPostSpy).not.toHaveBeenCalled()
  })

  it('posts the pinned payload to the existing endpoint after the confirm resolves', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '  原审批人休假  ')

    apiPostSpy.mockResolvedValue({
      ok: true,
      data: { succeeded: ['apv_1', 'apv_2'], skipped: [], affectedRequesterIds: [] },
    })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(apiPostSpy).toHaveBeenCalledTimes(1)
    const [path, body] = apiPostSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe('/api/approvals/admin/reassign')
    expect(body).toEqual({
      fromUserId: 'user_from',
      toUserId: 'user_to',
      reason: '原审批人休假',
      instanceIds: ['apv_1', 'apv_2'],
    })
    // The ids are always explicit — the server's own discovery branch is never invoked, so the
    // operator can never submit a set they did not see.
    expect(Array.isArray(body.instanceIds)).toBe(true)
  })

  it('submits only the ticked rows', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '原审批人休假')

    const rowCheck = q<HTMLInputElement>(root, 'batch-transfer-row-check-apv_1')
    rowCheck.checked = false
    rowCheck.dispatchEvent(new Event('change'))
    await flushUi()
    expect(q(root, 'batch-transfer-selected-count').textContent).toContain('已选 1 / 2')

    apiPostSpy.mockResolvedValue({ ok: true, data: { succeeded: ['apv_2'], skipped: [], affectedRequesterIds: [] } })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()

    const [, body] = apiPostSpy.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.instanceIds).toEqual(['apv_2'])
  })

  it('renders the per-row outcome for each submitted id, success and failure alike', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '原审批人休假')

    apiPostSpy.mockResolvedValue({
      ok: true,
      data: {
        succeeded: ['apv_1'],
        skipped: [{ id: 'apv_2', reason: 'target-already-assignee' }],
        affectedRequesterIds: [],
      },
    })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()

    const ok = q(root, 'batch-transfer-outcome-apv_1')
    expect(ok.getAttribute('data-outcome')).toBe('transferred')
    expect(ok.textContent?.trim()).toBe('已转交')

    const skipped = q(root, 'batch-transfer-outcome-apv_2')
    expect(skipped.getAttribute('data-outcome')).toBe('skipped')
    expect(skipped.getAttribute('data-outcome-reason')).toBe('target-already-assignee')
    expect(skipped.textContent?.trim()).toBe('目标用户已是该审批的处理人')

    expect(q(root, 'batch-transfer-summary').textContent).toContain('成功 1')
    expect(q(root, 'batch-transfer-summary').textContent).toContain('跳过 1')
  })

  it('reports an id the server answered about in neither array rather than implying success', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '原审批人休假')

    apiPostSpy.mockResolvedValue({ ok: true, data: { succeeded: ['apv_1'], skipped: [], affectedRequesterIds: [] } })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()

    expect(q(root, 'batch-transfer-outcome-apv_2').getAttribute('data-outcome')).toBe('unreported')
    expect(q(root, 'batch-transfer-unreported')).toBeTruthy()
  })

  it('refuses to submit without a reason, and says why', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')

    expect(q(root, 'batch-transfer-block-reason').textContent?.trim()).toBe('请填写转交原因')
    expect(q<HTMLButtonElement>(root, 'batch-transfer-submit').disabled).toBe(true)
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(apiPostSpy).not.toHaveBeenCalled()
  })

  it('surfaces a failed list read instead of rendering an empty, reassuring page', async () => {
    const root = await mountView()
    apiGetSpy.mockRejectedValue(new Error('unavailable'))
    await setPicker(root, 'batch-transfer-source-picker', 'user_from')
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()

    expect(q(root, 'batch-transfer-load-error')).toBeTruthy()
    // "no rows" and "the read failed" must not render the same.
    expect(q(root, 'batch-transfer-empty')).toBeNull()
  })

  it('renders the empty state when the approver genuinely has nothing pending', async () => {
    const root = await mountView()
    apiGetSpy.mockResolvedValue({ data: [], total: 0 })
    await setPicker(root, 'batch-transfer-source-picker', 'user_from')
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()

    expect(q(root, 'batch-transfer-empty')).toBeTruthy()
    expect(q(root, 'batch-transfer-load-error')).toBeNull()
  })

  it('surfaces a failed submit without inventing per-row outcomes', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '原审批人休假')

    apiPostSpy.mockRejectedValue(new Error('unavailable'))
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()

    expect(messageErrorSpy).toHaveBeenCalledTimes(1)
    expect(q(root, 'batch-transfer-summary')).toBeNull()
    expect(q(root, 'batch-transfer-outcome-apv_1')).toBeNull()
  })
})
