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
import { useAuth } from '../src/composables/useAuth'
import { getAuthPrincipalKey, onAuthPrincipalChange } from '../src/composables/authPrincipal'

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

// Round-2 item 1: the page asks the SERVER whether the caller is an approval administrator (the
// same DB-backed predicate the approval list scope binds) instead of trusting the token-derived
// admin flag the route/nav gate uses. The module is mocked here so each of its three answers can be
// driven independently; the module's OWN mapping from the wire is exercised against the real
// implementation further down (`vi.importActual`), so nothing about it is only ever asserted
// against a stub.
const resolveCapabilitySpy = vi.fn()
vi.mock('../src/approvals/adminCapability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/adminCapability')>()
  return { ...actual, resolveApprovalAdminCapability: (...args: unknown[]) => resolveCapabilitySpy(...args) }
})

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
          placeholder: this.placeholder,
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
      placeholder: this.placeholder,
      value: this.modelValue,
      onInput: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
    })
  },
})

const ElCheckbox = defineComponent({
  name: 'ElCheckbox',
  props: { modelValue: { type: Boolean, default: false }, disabled: Boolean },
  emits: ['update:modelValue'],
  // The stub's root is a wrapper, so attribute fallthrough would ALSO stamp `data-testid` on that
  // wrapper — and a `[data-testid=...]` query would then return the wrapper instead of the input.
  inheritAttrs: false,
  render() {
    // The real el-checkbox renders its default slot as the visible label; the stub must too, or a
    // locale assertion over the page text silently skips every checkbox label. A <span>, not a
    // <label>: a real <label> forwards activation to the input it wraps, which would make a
    // programmatic `change` on the input round-trip and re-toggle it.
    return h('span', {}, [
      h('input', {
        type: 'checkbox',
        checked: this.modelValue,
        disabled: this.disabled,
        'data-testid': (this.$attrs as Record<string, string>)['data-testid'],
        onChange: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLInputElement).checked),
      }),
      this.$slots.default?.(),
    ])
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, description: String, type: String, showIcon: Boolean, closable: Boolean },
  render() {
    return h('div', {
      'data-testid': (this.$attrs as Record<string, string>)['data-testid'],
      'data-alert-type': this.type,
    }, [this.title, this.description].filter(Boolean).join(' '))
  },
})

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

// A parseable JWT-shaped token. `nonce` changes the token STRING while leaving `sub` — and so the
// principal key — identical; that is what makes the listener test discriminating. At module scope
// because the MOUNTED-page tests need it too: round 4 drives an identity change through the auth
// layer's own setter while a page is up.
function tokenFor(subject: string, nonce = 'a'): string {
  const payload = btoa(JSON.stringify({ sub: subject, nonce })).replace(/=+$/, '')
  return `header.${payload}.signature`
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

  // Round-4 item 1. The only arm here that does NOT mirror a refusal the endpoint makes: the
  // endpoint cannot see that the ids it was handed were listed for a different approver.
  it('refuses a batch whose rows were listed for a DIFFERENT approver than the one now picked', () => {
    const base = { fromUserId: 'u1', toUserId: 'u2', reason: 'cover', selectedIds: ['a'] }
    // Absent or empty, the helper answers exactly as it always did — nothing loaded, nothing to
    // disagree with.
    expect(blockReasonForTransfer(base)).toBeNull()
    expect(blockReasonForTransfer({ ...base, loadedForUserId: '' })).toBeNull()
    expect(blockReasonForTransfer({ ...base, loadedForUserId: '  ' })).toBeNull()
    // POSITIVE CONTROL: agreement is not a refusal.
    expect(blockReasonForTransfer({ ...base, loadedForUserId: 'u1' })).toBeNull()
    // Disagreement is.
    expect(blockReasonForTransfer({ ...base, loadedForUserId: 'u9' })).toBe('source-changed')
    // Ordering, both directions. With no source picked at all, "pick one" is the accurate answer;
    // once one IS picked, the mismatch outranks the refusals that are only its consequence.
    expect(blockReasonForTransfer({ ...base, fromUserId: '  ', loadedForUserId: 'u9' })).toBe('no-source')
    expect(blockReasonForTransfer({ ...base, loadedForUserId: 'u9', selectedIds: [], toUserId: '' })).toBe('source-changed')
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
    resolveCapabilitySpy.mockReset().mockResolvedValue('granted')
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
    // Round 4 drives real auth transitions in this block. The token is cleared AFTER the unmount so
    // the page's own subscription is already gone, and so the capability-client tests below start
    // from no session rather than inheriting one of these principals.
    useAuth().clearToken()
    localStorage.clear()
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

  // Everything a user can READ on the page: rendered text plus the attributes that carry copy
  // (aria-label, placeholder, title). A locale assertion on textContent alone would miss exactly
  // the strings this page had left hardcoded — the section landmarks and the two placeholders.
  function renderedTextAndAttributes(root: HTMLElement): string {
    const parts = [root.textContent ?? '']
    for (const el of Array.from(root.querySelectorAll('*'))) {
      for (const attr of ['aria-label', 'placeholder', 'title']) {
        const value = el.getAttribute(attr)
        if (value) parts.push(value)
      }
    }
    return parts.join(' | ')
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

  async function loadTwoRows(root: HTMLElement, titles: [string, string] = ['出差申请', '采购申请']): Promise<void> {
    apiGetSpy.mockResolvedValue({ data: [listRow('apv_1', titles[0]), listRow('apv_2', titles[1])], total: 2 })
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
    // Round-3 item 2: the in-flight latch closes at ENTRY, so the cancel path is the one that has to
    // re-open it. Without this assertion a latch that never re-opens ships as a green "no request
    // was made" — the operator says "no" once and the button is dead for the rest of the page.
    expect(q<HTMLButtonElement>(root, 'batch-transfer-submit').disabled).toBe(false)
    // …and re-arming is real, not just an enabled-looking button.
    apiPostSpy.mockResolvedValue({ ok: true, data: { succeeded: ['apv_1', 'apv_2'], skipped: [], affectedRequesterIds: [] } })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()
    expect(apiPostSpy).toHaveBeenCalledTimes(1)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Round-3 item 2 — the latch must close BEFORE the confirm is awaited.
  // ───────────────────────────────────────────────────────────────────────────
  it('two activations inside the CONFIRM window open one dialog and post one batch', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '原审批人休假')

    // A confirm that stays open, which is exactly the window the pre-fix code left unguarded: the
    // guard read `submitDisabled` and only THEN awaited, so both activations passed it.
    let release: (() => void) | null = null
    confirmSpy.mockReset().mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve() }))
    apiPostSpy.mockResolvedValue({
      ok: true,
      data: { succeeded: ['apv_1', 'apv_2'], skipped: [], affectedRequesterIds: [] },
    })

    const button = q<HTMLButtonElement>(root, 'batch-transfer-submit')
    button.click()
    // POSITIVE CONTROL on the test's own discriminating power. No `flushUi` between the two clicks,
    // so Vue has NOT re-rendered `:disabled` yet — the DOM gate is still open and the second click's
    // handler genuinely runs `submit()`. Asserting it here is what stops this test from passing
    // vacuously because jsdom silently dropped the second click on a disabled button; what refuses
    // the second run is the reactive latch inside `submit()`, which is the thing under test.
    expect(button.disabled).toBe(false)
    button.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(apiPostSpy).not.toHaveBeenCalled()

    release!()
    await flushUi()
    expect(apiPostSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    // The single batch that DID run is the whole selection, not a truncated one.
    expect((apiPostSpy.mock.calls[0][1] as { instanceIds: string[] }).instanceIds).toEqual(['apv_1', 'apv_2'])
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

  // ───────────────────────────────────────────────────────────────────────────
  // Round-2 item 1 — the page never states another approver's queue is empty off
  // a read its own caller scope may have narrowed.
  // ───────────────────────────────────────────────────────────────────────────
  it('asks the SERVER whether the caller is an approval administrator, once, on mount', async () => {
    await mountView()
    expect(resolveCapabilitySpy).toHaveBeenCalledTimes(1)
  })

  it('a DB-backed approval administrator sees the source approver\u2019s queue (positive control)', async () => {
    resolveCapabilitySpy.mockResolvedValue('granted')
    const root = await mountView()
    await loadTwoRows(root)

    expect(q(root, 'batch-transfer-row-apv_1')).toBeTruthy()
    expect(q(root, 'batch-transfer-row-apv_2')).toBeTruthy()
    expect(q(root, 'batch-transfer-forbidden')).toBeNull()
    expect(q(root, 'batch-transfer-capability-unavailable')).toBeNull()
  })

  it('a TOKEN-only admin gets an explicit insufficient-privilege state, never an empty queue', async () => {
    resolveCapabilitySpy.mockResolvedValue('denied')
    const root = await mountView()

    const state = q(root, 'batch-transfer-forbidden')
    expect(state).toBeTruthy()
    expect(state.textContent).toContain('\u6743\u9650\u4e0d\u8db3')
    // The whole queue surface is gone — there is nothing to read as "this approver has nothing".
    expect(q(root, 'batch-transfer-empty')).toBeNull()
    expect(q(root, 'batch-transfer-selected-count')).toBeNull()
    expect(q(root, 'batch-transfer-source-picker')).toBeNull()
    expect(q(root, 'batch-transfer-submit')).toBeNull()
    // And no list read is issued at all.
    expect(apiGetSpy).not.toHaveBeenCalled()
  })

  it('an UNCONFIRMED capability is reported as unconfirmed, not as a refusal', async () => {
    resolveCapabilitySpy.mockResolvedValue('unavailable')
    const root = await mountView()

    expect(q(root, 'batch-transfer-capability-unavailable')).toBeTruthy()
    // "could not determine" and "you are not an administrator" must not render the same.
    expect(q(root, 'batch-transfer-forbidden')).toBeNull()
    expect(q(root, 'batch-transfer-empty')).toBeNull()
    expect(q(root, 'batch-transfer-source-picker')).toBeNull()
    expect(apiGetSpy).not.toHaveBeenCalled()
  })

  it('a REJECTED capability read is reported as unconfirmed, never left stuck on "confirming"', async () => {
    // Unreachable through the shipped client (its own read is total), so this pins the view's
    // belt: without it `capability` would stay 'pending' forever — a page with no queue, no
    // privilege state and no error, which is the one outcome nothing else on this page covers.
    resolveCapabilitySpy.mockRejectedValue(new Error('capability read rejected'))
    const root = await mountView()

    expect(q(root, 'batch-transfer-capability-unavailable')).toBeTruthy()
    expect(q(root, 'batch-transfer-capability-pending')).toBeNull()
    expect(q(root, 'batch-transfer-forbidden')).toBeNull()
    expect(q(root, 'batch-transfer-source-picker')).toBeNull()
  })

  it('renders nothing actionable while the capability answer is still in flight', async () => {
    let release: ((value: string) => void) | null = null
    resolveCapabilitySpy.mockReturnValue(new Promise<string>((resolve) => { release = resolve }))
    const root = await mountView()

    expect(q(root, 'batch-transfer-capability-pending')).toBeTruthy()
    expect(q(root, 'batch-transfer-source-picker')).toBeNull()
    expect(q(root, 'batch-transfer-empty')).toBeNull()

    release!('granted')
    await flushUi()
    expect(q(root, 'batch-transfer-source-picker')).toBeTruthy()
    expect(q(root, 'batch-transfer-capability-pending')).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Round-4 item 1 — ONE source approver per batch. The read, the rows on screen
  // and the request are bound together; a superseded read is dropped rather than
  // merged, and a batch is never posted under an approver it was not listed for.
  // ───────────────────────────────────────────────────────────────────────────
  it('drops a superseded list response instead of refilling the page under a different approver', async () => {
    const root = await mountView()

    // A's read is issued and deliberately left open.
    let releaseA: ((page: unknown) => void) | null = null
    apiGetSpy.mockImplementationOnce(() => new Promise((resolve) => { releaseA = resolve }))
    await setPicker(root, 'batch-transfer-source-picker', 'user_a')
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()
    expect(apiGetSpy).toHaveBeenCalledTimes(1)

    // The operator moves to B and loads B's queue while A's read is still in flight. This half is a
    // POSITIVE CONTROL as much as a setup step: if the picker change did not release the load
    // control, B's read would never be issued at all and every assertion below would pass against
    // an empty page for the wrong reason.
    apiGetSpy.mockResolvedValue({ data: [listRow('apv_b1', 'B 的待办')], total: 1 })
    await setPicker(root, 'batch-transfer-source-picker', 'user_b')
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()
    expect(apiGetSpy).toHaveBeenCalledTimes(2)
    expect(String(apiGetSpy.mock.calls[1][0])).toContain('assignee=user_b')
    expect(q(root, 'batch-transfer-row-apv_b1')).toBeTruthy()

    // A's answer finally arrives. It describes an approver this page no longer names.
    releaseA!({ data: [listRow('apv_a1', 'A 的待办')], total: 1 })
    await flushUi()
    expect(q(root, 'batch-transfer-row-apv_a1')).toBeNull()
    expect(q(root, 'batch-transfer-row-apv_b1')).toBeTruthy()
    expect(q(root, 'batch-transfer-selected-count').textContent).toContain('已选 1 / 1')

    // And the request carries B's rows under B's name — never one approver's ids under another's.
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '原审批人休假')
    apiPostSpy.mockResolvedValue({ ok: true, data: { succeeded: ['apv_b1'], skipped: [], affectedRequesterIds: [] } })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()
    expect(apiPostSpy).toHaveBeenCalledTimes(1)
    const body = apiPostSpy.mock.calls[0][1] as { fromUserId: string; instanceIds: string[] }
    expect(body.fromUserId).toBe('user_b')
    expect(body.instanceIds).toEqual(['apv_b1'])
  })

  it('does not post a batch whose source approver changed while the confirmation was open', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '原审批人休假')

    // The confirmation is held open — the one window in which the picker is still live after the
    // entry checks have already passed.
    let resolveConfirm: (() => void) | null = null
    confirmSpy.mockReturnValue(new Promise<void>((resolve) => { resolveConfirm = () => resolve() }))
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    await setPicker(root, 'batch-transfer-source-picker', 'user_other')
    resolveConfirm!()
    await flushUi()

    // The operator confirmed a batch for the approver they were looking at, and the page is no
    // longer looking at that approver: nothing is sent, under either name.
    expect(apiPostSpy).not.toHaveBeenCalled()
    expect(q(root, 'batch-transfer-block-reason').textContent).toContain('原审批人已更改')

    // POSITIVE CONTROL, in this same test: the page is not bricked. Loading for the approver now
    // picked and submitting posts — under that approver's name.
    apiGetSpy.mockResolvedValue({ data: [listRow('apv_9', '新待办')], total: 1 })
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()
    confirmSpy.mockReset().mockResolvedValue(undefined)
    apiPostSpy.mockResolvedValue({ ok: true, data: { succeeded: ['apv_9'], skipped: [], affectedRequesterIds: [] } })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()
    expect(apiPostSpy).toHaveBeenCalledTimes(1)
    expect((apiPostSpy.mock.calls[0][1] as { fromUserId: string }).fromUserId).toBe('user_other')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Round-4 item 3 — a degraded read is a FAILED read, not an empty queue.
  // ───────────────────────────────────────────────────────────────────────────
  it('treats a DEGRADED list answer as a failed read, never as “this approver has nothing”', async () => {
    const root = await mountView()
    // The exact shape the backend sends when it cannot read the approval tables:
    // `routes/approvals.ts` answers `res.json({ data: [], total: 0, degraded: true })` — a 200 that
    // is indistinguishable from an empty queue unless the flag is read.
    apiGetSpy.mockResolvedValue({ data: [], total: 0, degraded: true })
    await setPicker(root, 'batch-transfer-source-picker', 'user_from')
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()

    expect(q(root, 'batch-transfer-load-error')).toBeTruthy()
    expect(q(root, 'batch-transfer-empty')).toBeNull()
    // Not only the test hook: the sentence itself must not be on the page.
    expect(root.textContent).not.toContain('该审批人名下没有可转交的平台待办')
    expect(q<HTMLButtonElement>(root, 'batch-transfer-submit').disabled).toBe(true)
  })

  it('treats a list answer that is not a page as a failed read', async () => {
    const root = await mountView()
    const payloads: unknown[] = [null, { ok: true }, { data: null, total: 0 }, { data: {}, total: 0 }]
    for (const [index, payload] of payloads.entries()) {
      apiGetSpy.mockResolvedValue(payload)
      await setPicker(root, 'batch-transfer-source-picker', `user_${index}`)
      q<HTMLButtonElement>(root, 'batch-transfer-load').click()
      await flushUi()
      expect(q(root, 'batch-transfer-load-error'), `payload ${index}`).toBeTruthy()
      expect(q(root, 'batch-transfer-empty'), `payload ${index}`).toBeNull()
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Round-4 item 2 — the answer belongs to a principal, and so does the queue.
  // The transition is driven through the auth layer's OWN setter, so what these
  // pin is the production path (useAuth → authPrincipal → the capability
  // module's invalidation → this page), not a hand-fired event.
  // ───────────────────────────────────────────────────────────────────────────
  it('re-reads the capability when the principal changes while the page is mounted', async () => {
    resolveCapabilitySpy.mockResolvedValue('granted')
    const root = await mountView()
    expect(q(root, 'batch-transfer-source-picker')).toBeTruthy()

    resolveCapabilitySpy.mockResolvedValue('denied')
    useAuth().setToken(tokenFor('user-b'))
    await flushUi()

    expect(resolveCapabilitySpy).toHaveBeenCalledTimes(2)
    expect(q(root, 'batch-transfer-forbidden')).toBeTruthy()
    expect(q(root, 'batch-transfer-source-picker')).toBeNull()
    expect(q(root, 'batch-transfer-empty')).toBeNull()
  })

  it('drops the previous principal’s queue on an identity change, even when the answer is unchanged', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setReason(root, '原审批人休假')
    expect(q(root, 'batch-transfer-row-apv_1')).toBeTruthy()

    // Same answer, different person. `granted` is a statement about the caller's rights, never
    // about whose queue is on screen — the rows were listed under the PREVIOUS principal's scope.
    useAuth().setToken(tokenFor('user-b'))
    await flushUi()

    expect(resolveCapabilitySpy).toHaveBeenCalledTimes(2)
    expect(q(root, 'batch-transfer-row-apv_1')).toBeNull()
    expect(q(root, 'batch-transfer-row-apv_2')).toBeNull()
    expect(q(root, 'batch-transfer-selected-count').textContent).toContain('已选 0 / 0')
    // Cleared, not merely hidden: the form the previous principal filled in is gone too.
    expect(q<HTMLInputElement>(root, 'batch-transfer-source-picker').value).toBe('')
    expect(q<HTMLTextAreaElement>(root, 'batch-transfer-reason').value).toBe('')
    // And "nothing to transfer" is not what an emptied page says.
    expect(q(root, 'batch-transfer-empty')).toBeNull()
  })

  it('shows nothing about the caller’s rights BETWEEN the two answers', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    expect(q(root, 'batch-transfer-row-apv_1')).toBeTruthy()

    // The re-read never settles, so everything asserted below is the state the page holds while the
    // new principal's answer is outstanding — the window the previous answer used to survive.
    resolveCapabilitySpy.mockReturnValue(new Promise<string>(() => {}))
    useAuth().setToken(tokenFor('user-b'))
    await flushUi()

    expect(q(root, 'batch-transfer-capability-pending')).toBeTruthy()
    // Not `granted` carried over, and not `denied` invented either: the server has said nothing yet.
    expect(q(root, 'batch-transfer-source-picker')).toBeNull()
    expect(q(root, 'batch-transfer-forbidden')).toBeNull()
    expect(q(root, 'batch-transfer-row-apv_1')).toBeNull()
  })

  it('discards a capability answer a newer read has already superseded', async () => {
    let releaseFirst: ((value: string) => void) | null = null
    resolveCapabilitySpy.mockReturnValueOnce(new Promise<string>((resolve) => { releaseFirst = resolve }))
    const root = await mountView()
    expect(q(root, 'batch-transfer-capability-pending')).toBeTruthy()

    resolveCapabilitySpy.mockResolvedValue('denied')
    useAuth().setToken(tokenFor('user-b'))
    await flushUi()
    expect(q(root, 'batch-transfer-forbidden')).toBeTruthy()

    // The FIRST read — issued for the principal that has since been replaced — finally answers, and
    // answers `granted`. Applying it would hand the new principal the old one's rights.
    releaseFirst!('granted')
    await flushUi()
    expect(q(root, 'batch-transfer-forbidden')).toBeTruthy()
    expect(q(root, 'batch-transfer-source-picker')).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Round-2 item 4 — a completed batch cannot be re-posted by a second click.
  // ───────────────────────────────────────────────────────────────────────────
  it('posts once and only once for a completed batch', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '\u539f\u5ba1\u6279\u4eba\u4f11\u5047')

    apiPostSpy.mockResolvedValue({
      ok: true,
      data: { succeeded: ['apv_1', 'apv_2'], skipped: [], affectedRequesterIds: [] },
    })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()
    // Positive control: the FIRST click did post, exactly once.
    expect(apiPostSpy).toHaveBeenCalledTimes(1)

    // Selection dropped, button disabled, and the page says why rather than showing a bare
    // "select at least one item" beside a success summary.
    expect(q(root, 'batch-transfer-selected-count').textContent).toContain('\u5df2\u9009 0 / 2')
    expect(q<HTMLButtonElement>(root, 'batch-transfer-submit').disabled).toBe(true)
    expect(q(root, 'batch-transfer-submitted-notice')).toBeTruthy()
    expect(q(root, 'batch-transfer-block-reason')).toBeNull()

    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()
    expect(apiPostSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    // The success summary still stands; it was not overwritten by a second pass of skips.
    expect(q(root, 'batch-transfer-summary').textContent).toContain('\u6210\u529f 2')
  })

  it('stays latched even if the operator re-ticks the stale rows, until the list is reloaded', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '\u539f\u5ba1\u6279\u4eba\u4f11\u5047')
    apiPostSpy.mockResolvedValue({ ok: true, data: { succeeded: ['apv_1', 'apv_2'], skipped: [], affectedRequesterIds: [] } })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()

    const rowCheck = q<HTMLInputElement>(root, 'batch-transfer-row-check-apv_1')
    rowCheck.checked = true
    rowCheck.dispatchEvent(new Event('change'))
    await flushUi()
    expect(q<HTMLButtonElement>(root, 'batch-transfer-submit').disabled).toBe(true)
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()
    expect(apiPostSpy).toHaveBeenCalledTimes(1)

    // Reloading the list is the documented way back.
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()
    expect(q(root, 'batch-transfer-submitted-notice')).toBeNull()
    expect(q<HTMLButtonElement>(root, 'batch-transfer-submit').disabled).toBe(false)
  })

  it('a FAILED submit stays re-armable — nothing was processed', async () => {
    const root = await mountView()
    await loadTwoRows(root)
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, '\u539f\u5ba1\u6279\u4eba\u4f11\u5047')

    apiPostSpy.mockRejectedValue(new Error('unavailable'))
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()

    expect(q(root, 'batch-transfer-submitted-notice')).toBeNull()
    expect(q<HTMLButtonElement>(root, 'batch-transfer-submit').disabled).toBe(false)
    apiPostSpy.mockResolvedValue({ ok: true, data: { succeeded: ['apv_1', 'apv_2'], skipped: [], affectedRequesterIds: [] } })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()
    expect(apiPostSpy).toHaveBeenCalledTimes(2)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Round-2 item 2 — one locale per page. Both assertions are on a MOUNTED page,
  // not on source text.
  // ───────────────────────────────────────────────────────────────────────────
  it('renders every chrome string in zh', async () => {
    useLocale().setLocale('zh-CN')
    const root = await mountView()
    apiGetSpy.mockResolvedValue({ data: [], total: 0 })
    await setPicker(root, 'batch-transfer-source-picker', 'user_from')
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()

    const text = root.textContent ?? ''
    for (const zh of ['\u6279\u91cf\u8f6c\u4ea4', '\u539f\u5ba1\u6279\u4eba', '\u8f7d\u5165\u5f85\u529e', '\u8f6c\u4ea4\u7ed9', '\u8f6c\u4ea4\u539f\u56e0', '\u5168\u9009', '\u5df2\u9009', '\u8f6c\u4ea4\u6240\u9009']) {
      expect(text).toContain(zh)
    }
    expect(q(root, 'batch-transfer-empty').textContent?.trim())
      .toBe('\u8be5\u5ba1\u6279\u4eba\u540d\u4e0b\u6ca1\u6709\u53ef\u8f6c\u4ea4\u7684\u5e73\u53f0\u5f85\u529e\u3002')
    expect(q<HTMLInputElement>(root, 'batch-transfer-source-picker').getAttribute('placeholder'))
      .toBe('\u641c\u7d22\u7528\u6237\u540d / \u90ae\u7bb1 / ID')
    // The section landmarks are localized too, not left as Chinese constants.
    expect(root.querySelector('[aria-label="\u6279\u91cf\u8f6c\u4ea4\u8bbe\u7f6e"]')).toBeTruthy()
    expect(root.querySelector('[aria-label="\u5f85\u8f6c\u4ea4\u5ba1\u6279"]')).toBeTruthy()
  })

  it('renders every chrome string in en — no Chinese survives on the page', async () => {
    useLocale().setLocale('en')
    const root = await mountView()
    apiGetSpy.mockResolvedValue({ data: [], total: 0 })
    await setPicker(root, 'batch-transfer-source-picker', 'user_from')
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()

    const text = root.textContent ?? ''
    for (const en of ['Batch Transfer', 'Source approver', 'Load pending items', 'Transfer to', 'Transfer reason', 'Select all', 'Selected', 'Transfer selected']) {
      expect(text).toContain(en)
    }
    expect(q(root, 'batch-transfer-empty').textContent?.trim())
      .toBe('This approver has no transferable platform items pending.')
    expect(root.querySelector('[aria-label="Batch transfer settings"]')).toBeTruthy()
    expect(root.querySelector('[aria-label="Approvals to transfer"]')).toBeTruthy()
    // The whole rendered page, including every aria-label and placeholder, carries no CJK.
    expect(renderedTextAndAttributes(root)).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('localizes the two capability states as well', async () => {
    resolveCapabilitySpy.mockResolvedValue('denied')
    useLocale().setLocale('en')
    let root = await mountView()
    expect(q(root, 'batch-transfer-forbidden').textContent).toContain('Insufficient privilege')
    expect(renderedTextAndAttributes(root)).not.toMatch(/[\u4e00-\u9fff]/)
    app?.unmount(); container?.remove(); app = null; container = null

    resolveCapabilitySpy.mockResolvedValue('unavailable')
    root = await mountView()
    expect(q(root, 'batch-transfer-capability-unavailable').textContent).toContain('could not be confirmed')
    expect(renderedTextAndAttributes(root)).not.toMatch(/[\u4e00-\u9fff]/)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Round-3 item 3 — the four en branches that live OUTSIDE the ZH/EN table.
  //
  // The round-2 en sweep asserted "no CJK survives on the page", which is only as strong as the
  // population it renders. It never rendered the truncation notice (no fixture set `total >
  // rows.length` in en), never rendered the ordinal row-label fallback (its fixture gave every row
  // an ASCII title), never triggered a block reason, and never looked at the string handed to the
  // confirm — so replacing ALL FOUR English branches with Chinese literals left it 42/42 green.
  // This fixture renders each of the four and asserts on it. The confirm body is asserted on the
  // ARGUMENT, not on the DOM: it is a JS string passed to a mocked dialog, so no sweep over
  // rendered text or attributes can ever reach it.
  // ───────────────────────────────────────────────────────────────────────────
  it('renders the truncation notice, the block reason, the ordinal row label and the confirm body in en', async () => {
    useLocale().setLocale('en')
    const root = await mountView()

    // (1) BLOCK TEXT — a source picked, no target yet.
    await setPicker(root, 'batch-transfer-source-picker', 'user_from')
    const block = q(root, 'batch-transfer-block-reason')
    expect(block).toBeTruthy()
    expect(block.textContent).toContain('Pick who to transfer to')
    expect(block.textContent).not.toMatch(/[\u4e00-\u9fff]/)

    // (2) TRUNCATION NOTICE and (3) ORDINAL ROW LABEL — a short page off a large queue, whose first
    // row carries neither a title nor a request number.
    const untitled = { ...listRow('apv_1', ''), title: null as string | null, requestNo: null as string | null }
    apiGetSpy.mockResolvedValue({ data: [untitled, listRow('apv_2', 'Purchase request')], total: 250 })
    q<HTMLButtonElement>(root, 'batch-transfer-load').click()
    await flushUi()

    const notice = q(root, 'batch-transfer-truncated')
    expect(notice).toBeTruthy()
    expect(notice.textContent).toContain('per-request cap')
    expect(notice.textContent).toContain('250')
    expect(notice.textContent).not.toMatch(/[\u4e00-\u9fff]/)

    const ordinal = q(root, 'batch-transfer-row-apv_1').querySelector('.batch-transfer__row-title')
    expect(ordinal?.textContent?.trim()).toBe('Approval 1')
    expect(ordinal?.textContent).not.toMatch(/[\u4e00-\u9fff]/)

    // (4) CONFIRM BODY.
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, 'approver on leave')
    apiPostSpy.mockResolvedValue({
      ok: true,
      data: { succeeded: ['apv_1', 'apv_2'], skipped: [], affectedRequesterIds: [] },
    })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const confirmBody = String(confirmSpy.mock.calls[0][0])
    expect(confirmBody).toContain('will be transferred to the selected user')
    expect(confirmBody).toContain('2')
    expect(confirmBody).not.toMatch(/[\u4e00-\u9fff]/)
    // The confirm TITLE comes from the table and is swept elsewhere; asserted here too so this
    // fixture pins the whole dialog it drives, not half of it.
    expect(String(confirmSpy.mock.calls[0][1])).toBe('Confirm batch transfer')

    // And the page around all four is still CJK-free, so a regression cannot hide by moving a
    // Chinese literal from one of these sites into the surrounding chrome.
    expect(renderedTextAndAttributes(root)).not.toMatch(/[\u4e00-\u9fff]/)
  })

  // Round-4 item 1 added a user-visible refusal, so it gets the same en fixture the other four
  // locale-branched strings on this page have: a branch only ever rendered in one language is
  // exactly the failure the round-2 sweep could not see.
  it('renders the source-changed refusal in en', async () => {
    useLocale().setLocale('en')
    const root = await mountView()
    await loadTwoRows(root, ['Travel request', 'Purchase request'])
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, 'approver on leave')
    // POSITIVE CONTROL: nothing refuses this batch until the source moves.
    expect(q(root, 'batch-transfer-block-reason')).toBeNull()

    await setPicker(root, 'batch-transfer-source-picker', 'user_other')
    const block = q(root, 'batch-transfer-block-reason')
    expect(block).toBeTruthy()
    expect(block.textContent).toContain('The source approver changed')
    expect(block.textContent).not.toMatch(/[\u4e00-\u9fff]/)
    expect(renderedTextAndAttributes(root)).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('localizes the per-row outcome labels', async () => {
    useLocale().setLocale('en')
    const root = await mountView()
    // ASCII row titles: the CJK sweep below is about the page's own CHROME, and a row title is
    // approval DATA the page must render verbatim in whatever language it was written.
    await loadTwoRows(root, ['Travel request', 'Purchase request'])
    await setPicker(root, 'batch-transfer-target-picker', 'user_to')
    await setReason(root, 'approver on leave')
    apiPostSpy.mockResolvedValue({
      ok: true,
      data: { succeeded: ['apv_1'], skipped: [{ id: 'apv_2', reason: 'not-pending' }], affectedRequesterIds: [] },
    })
    q<HTMLButtonElement>(root, 'batch-transfer-submit').click()
    await flushUi()

    expect(q(root, 'batch-transfer-outcome-apv_1').textContent?.trim()).toBe('Transferred')
    expect(q(root, 'batch-transfer-outcome-apv_2').textContent?.trim()).toBe('No longer pending')
    expect(q(root, 'batch-transfer-summary').textContent).toContain('Transferred 1')
    expect(renderedTextAndAttributes(root)).not.toMatch(/[\u4e00-\u9fff]/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The capability client itself — exercised against the REAL module (the mount
// tests above drive a stub of it, which cannot pin how the wire is read).
// ─────────────────────────────────────────────────────────────────────────────
describe('approval admin capability client', () => {
  type CapabilityModule = typeof import('../src/approvals/adminCapability')

  async function real(): Promise<CapabilityModule> {
    const actual = await vi.importActual<CapabilityModule>('../src/approvals/adminCapability')
    actual.resetApprovalAdminCapabilityCache()
    return actual
  }

  beforeEach(() => {
    apiGetSpy.mockReset()
    // The cache is keyed on the CURRENT principal, so a token left behind by a neighbouring test
    // would silently change which key each read below is filed under. Cleared through the auth
    // layer's own setter so the transition funnel fires too, then the module cache is dropped by
    // `real()`.
    useAuth().clearToken()
    localStorage.clear()
  })

  it('reads the pinned path', async () => {
    const mod = await real()
    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: true } })
    await mod.fetchApprovalAdminCapability()
    expect(apiGetSpy).toHaveBeenCalledWith('/api/approvals/admin/capability')
    expect(mod.APPROVAL_ADMIN_CAPABILITY_PATH).toBe('/api/approvals/admin/capability')
  })

  it('maps true/false to granted/denied, through the envelope and without it', async () => {
    const mod = await real()
    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: true } })
    await expect(mod.fetchApprovalAdminCapability()).resolves.toBe('granted')
    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: false } })
    await expect(mod.fetchApprovalAdminCapability()).resolves.toBe('denied')
    apiGetSpy.mockResolvedValue({ isApprovalAdmin: true })
    await expect(mod.fetchApprovalAdminCapability()).resolves.toBe('granted')
  })

  it('never folds a failure or an unrecognised shape into `denied`', async () => {
    const mod = await real()
    apiGetSpy.mockRejectedValue(new Error('network'))
    await expect(mod.fetchApprovalAdminCapability()).resolves.toBe('unavailable')
    for (const body of [null, {}, { ok: true, data: {} }, { ok: true, data: { isApprovalAdmin: 'yes' } }, { ok: true, data: { isApprovalAdmin: 1 } }]) {
      apiGetSpy.mockResolvedValue(body)
      await expect(mod.fetchApprovalAdminCapability()).resolves.toBe('unavailable')
    }
  })

  it('caches a definitive answer so the nav entry and the page share ONE request', async () => {
    const mod = await real()
    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: true } })
    const [a, b] = await Promise.all([
      mod.resolveApprovalAdminCapability(),
      mod.resolveApprovalAdminCapability(),
    ])
    expect([a, b]).toEqual(['granted', 'granted'])
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('granted')
    expect(apiGetSpy).toHaveBeenCalledTimes(1)
  })

  it('does NOT cache `unavailable` — a blip must not hide the entry for the session', async () => {
    const mod = await real()
    apiGetSpy.mockRejectedValue(new Error('network'))
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('unavailable')
    apiGetSpy.mockReset()
    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: true } })
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('granted')
    expect(apiGetSpy).toHaveBeenCalledTimes(1)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Round-3 item 1 — the cached answer belongs to a PRINCIPAL, not to the page.
  //
  // Round 2 observed principal B inheriting principal A's `granted` with no second read: the module
  // cached for the process lifetime on the premise that every logout is a full navigation, which is
  // false. TWO independent mechanisms now cover it, and they are pinned separately BECAUSE each
  // covers a case the other cannot — a single test that both satisfy would let either rot silently:
  //
  //   * the KEY covers a principal swap this app never performed (another tab writing the shared
  //     `localStorage`), where no transition fires at all;
  //   * the LISTENER covers the same subject re-authenticating, where the key is UNCHANGED by
  //     construction and only the transition is observable.
  // ───────────────────────────────────────────────────────────────────────────

  it('serves a cached answer only to the principal it was resolved for, even when the swap bypassed this app’s setters', async () => {
    const mod = await real()
    localStorage.setItem('auth_token', tokenFor('user-a'))
    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: true } })
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('granted')
    expect(apiGetSpy).toHaveBeenCalledTimes(1)

    // POSITIVE CONTROL: the same principal still shares ONE request, so this test cannot pass by the
    // cache having been disabled outright.
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('granted')
    expect(apiGetSpy).toHaveBeenCalledTimes(1)

    // Another tab signs a different principal in. No setter of this app ran, so no auth transition
    // was ever announced in this process — only the key can catch this.
    localStorage.setItem('auth_token', tokenFor('user-b'))
    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: false } })
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('denied')
    expect(apiGetSpy).toHaveBeenCalledTimes(2)
  })

  it('refetches when the SAME subject re-authenticates — a case the key cannot see', async () => {
    const mod = await real()
    const auth = useAuth()
    localStorage.setItem('auth_token', tokenFor('user-a', 'first'))
    const keyBefore = getAuthPrincipalKey()
    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: true } })
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('granted')
    expect(apiGetSpy).toHaveBeenCalledTimes(1)

    // A fresh token for the SAME person, through the app's own setter.
    auth.setToken(tokenFor('user-a', 'second'))
    // THE CONTROL THAT MAKES THIS TEST ABOUT THE LISTENER: the key is byte-identical across the
    // transition, so a refetch below cannot be attributed to the key. It also cannot be attributed
    // to "there is no cache", which the previous test's positive control rules out.
    expect(getAuthPrincipalKey()).toBe(keyBefore)
    expect(keyBefore).toBeTruthy()

    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: false } })
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('denied')
    expect(apiGetSpy).toHaveBeenCalledTimes(2)
  })

  it('refetches across a logout / login cycle', async () => {
    const mod = await real()
    const auth = useAuth()
    auth.setToken(tokenFor('user-a'))
    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: true } })
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('granted')
    expect(apiGetSpy).toHaveBeenCalledTimes(1)

    // Sign-out with no navigation — the shape `bootstrapSession`'s 401 branch takes.
    auth.clearToken()
    expect(getAuthPrincipalKey()).toBeNull()
    auth.setToken(tokenFor('user-b'))

    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: false } })
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('denied')
    expect(apiGetSpy).toHaveBeenCalledTimes(2)
    // This cycle changes BOTH the key and the transition state, so it is deliberately NOT the
    // discriminating evidence for either mechanism — the two tests above are. It is here because it
    // is the scenario an operator actually performs.
  })

  // Round-4 item 2. The mounted consumers re-read from INSIDE this notification, so "the cache is
  // dropped" and "the consumers are told" are not two independent facts — their ORDER decides
  // whether the re-read is a request or a replay of the answer that just went stale. Nothing in a
  // consumer can observe that order, so it is pinned here, at the module that owns both halves.
  it('has already dropped the cached answer by the time it tells consumers to re-read', async () => {
    const mod = await real()
    localStorage.setItem('auth_token', tokenFor('user-a', 'first'))
    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: true } })
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('granted')
    expect(apiGetSpy).toHaveBeenCalledTimes(1)

    let answeredInsideNotification: string | null = null
    const unsubscribe = mod.onApprovalAdminCapabilityInvalidated(() => {
      apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: false } })
      void mod.resolveApprovalAdminCapability().then((answer) => { answeredInsideNotification = answer })
    })
    try {
      // The SAME subject re-authenticates: the principal key is unchanged by construction, so the
      // key cannot be what produces a second request here — only the cache having been dropped
      // before this listener ran can.
      const keyBefore = getAuthPrincipalKey()
      useAuth().setToken(tokenFor('user-a', 'second'))
      expect(getAuthPrincipalKey()).toBe(keyBefore)
      await flushUi()
    } finally {
      unsubscribe()
    }

    expect(apiGetSpy).toHaveBeenCalledTimes(2)
    expect(answeredInsideNotification).toBe('denied')
  })

  it('exposes the reset as the auth layer’s subscriber, not only as a test seam', async () => {
    const mod = await real()
    localStorage.setItem('auth_token', tokenFor('user-a'))
    apiGetSpy.mockResolvedValue({ ok: true, data: { isApprovalAdmin: true } })
    await expect(mod.resolveApprovalAdminCapability()).resolves.toBe('granted')

    // A subscriber registered here proves the funnel really fires on a transition — the same funnel
    // the module registers on at import time. Without this, "the listener is wired" would rest on
    // reading the import side effect rather than on observing it.
    let notified = 0
    const unsubscribe = onAuthPrincipalChange(() => { notified += 1 })
    try {
      useAuth().clearToken()
      expect(notified).toBe(1)
    } finally {
      unsubscribe()
    }
    useAuth().setToken(tokenFor('user-c'))
    expect(notified).toBe(1)
  })
})
