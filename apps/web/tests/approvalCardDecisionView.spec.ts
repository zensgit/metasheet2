/**
 * A-3 decision page (one-tap lock #3594 §5) — view behavior + the no-raw-/actions tripwire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App as VueApp } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let routeQuery: Record<string, string> = {}
vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRoute: () => ({
      query: routeQuery,
      params: {},
      path: '/m/approval-decision',
      fullPath: `/m/approval-decision${Object.keys(routeQuery).length ? `?${new URLSearchParams(routeQuery).toString()}` : ''}`,
      meta: {},
    }),
  }
})

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

let mockUserId: string | null = 'user_a'
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: vi.fn().mockImplementation(async () => mockUserId) }),
}))

import ApprovalCardDecisionView from '../src/views/approval/ApprovalCardDecisionView.vue'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

// Cross a real macrotask boundary so fixed microtask/nextTick flushes cannot pass these waits by luck.
async function delayedJsonResponse(data: unknown, status = 200): Promise<Response> {
  await new Promise((resolve) => setTimeout(resolve, 25))
  return jsonResponse(data, status)
}

function summaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    deliveryId: 'del_1',
    cardState: 'sent',
    sendStatus: 'sent',
    nodeKey: 'approval_1',
    recipientUserId: 'user_a',
    viewerIsRecipient: true,
    actionable: true,
    approval: {
      instanceId: 'apv_1',
      title: '出差报销',
      requestNo: 'AP-1001',
      status: 'pending',
      currentNodeKey: 'approval_1',
      rejectCommentRequired: true,
    },
    actedAction: null,
    actedAt: null,
    ...overrides,
  }
}

const stub = (name: string, tag = 'div') => defineComponent({
  name,
  props: { title: String, type: String, modelValue: {}, loading: Boolean, disabled: Boolean },
  emits: ['update:modelValue', 'click'],
  render() {
    if (name === 'ElInput') {
      return h('textarea', {
        value: this.modelValue as string,
        onInput: (e: Event) => this.$emit('update:modelValue', (e.target as HTMLTextAreaElement).value),
      })
    }
    if (name === 'ElButton') {
      return h('button', {
        disabled: this.disabled || undefined,
        onClick: (e: Event) => this.$emit('click', e),
      }, this.$slots.default?.())
    }
    return h(tag, { 'data-stub': name, 'data-title': this.title ?? '' }, [this.title ?? '', this.$slots.default?.()])
  },
})

const UI_WAIT_OPTIONS = { timeout: 5_000, interval: 10 }

describe('ApprovalCardDecisionView (A-3)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let savedLocation: Location | null = null

  function unmountView() {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  }

  async function waitForElement<T extends Element>(selector: string): Promise<T> {
    let element: T | null = null
    await vi.waitFor(() => {
      element = container?.querySelector<T>(selector) ?? null
      expect(element).not.toBeNull()
    }, UI_WAIT_OPTIONS)
    return element!
  }

  async function waitForUi(assertion: () => void): Promise<void> {
    await vi.waitFor(assertion, UI_WAIT_OPTIONS)
  }

  function stubWindowLocation(href: string) {
    savedLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...savedLocation, href },
    })
  }

  function restoreWindowLocation() {
    if (!savedLocation) return
    Object.defineProperty(window, 'location', { configurable: true, value: savedLocation })
    savedLocation = null
  }

  async function mountView() {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(ApprovalCardDecisionView)
    for (const name of ['ElAlert', 'ElInput', 'ElButton']) app.component(name, stub(name))
    app.directive('loading', { mounted() {}, updated() {} })
    app.mount(container)
  }

  beforeEach(() => {
    routeQuery = { d: 'del_1', t: 'a'.repeat(32) }
    apiFetchMock.mockReset()
    mockUserId = 'user_a'
    sessionStorage.clear()
  })

  afterEach(() => {
    unmountView()
    restoreWindowLocation()
  })

  it('renders the summary and blocks 驳回 until a comment is typed (rejectCommentRequired)', async () => {
    apiFetchMock.mockImplementationOnce(() => delayedJsonResponse({ ok: true, data: summaryFixture() }))
    await mountView()

    const title = await waitForElement('[data-testid="card-decision-title"]')
    expect(title.textContent).toBe('出差报销')
    const reject = await waitForElement<HTMLButtonElement>('[data-testid="card-decision-reject"]')
    expect(reject.disabled).toBe(true)
    expect(container!.querySelector('[data-testid="card-decision-reject-hint"]')).toBeTruthy()

    const commentBox = container!.querySelector('[data-testid="card-decision-comment"] textarea, textarea') as HTMLTextAreaElement
    commentBox.value = '材料不全'
    commentBox.dispatchEvent(new Event('input', { bubbles: true }))
    await waitForUi(() => {
      expect((container!.querySelector('[data-testid="card-decision-reject"]') as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('PR #4046 Phase B: an actionable outcome_unknown card renders live buttons; a non-actionable one gets 已流转 — never 未成功投递', async () => {
    // The valid deep-link token only ever existed inside the delivered card, so an
    // outcome_unknown delivery whose instance is pending stays actionable server-side.
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: summaryFixture({ sendStatus: 'outcome_unknown' }) }))
    await mountView()
    await waitForElement('[data-testid="card-decision-approve"]')
    expect(container!.querySelector('[data-testid="card-decision-stale"]')).toBeNull()
    unmountView()

    // Non-actionable for ANOTHER reason (superseded): the accurate message is 已流转 —
    // "未成功投递" is reserved for pending/failed sends, where non-delivery is KNOWN.
    apiFetchMock.mockReset()
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: summaryFixture({ sendStatus: 'outcome_unknown', cardState: 'superseded', actionable: false }) }))
    await mountView()
    const stale = await waitForElement('[data-testid="card-decision-stale"]')
    expect(stale?.getAttribute('data-title')).toContain('已流转')
    expect(stale?.getAttribute('data-title')).not.toContain('未成功投递')
  })

  it('approve submits to the card-delivery endpoint and renders the terminal state', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: summaryFixture() }))
    await mountView()
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: summaryFixture({ cardState: 'acted', actionable: false, actedAction: 'approve', approval: { ...summaryFixture().approval, status: 'approved' } }),
    }))

    const approve = await waitForElement<HTMLButtonElement>('[data-testid="card-decision-approve"]')
    approve.click()
    await waitForUi(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))

    const calls = apiFetchMock.mock.calls.map((c) => String(c[0]))
    expect(calls[1]).toBe('/api/approval-card-deliveries/del_1/actions')
    const init = apiFetchMock.mock.calls[1][1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({ t: 'a'.repeat(32), decision: 'approve' })
    const stale = await waitForElement('[data-testid="card-decision-stale"]')
    expect(stale.getAttribute('data-title')).toContain('已处理')
  })

  it('a 409 stale response swaps in the REAL terminal summary instead of a dead form', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: summaryFixture() }))
    await mountView()
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      error: { code: 'APPROVAL_CARD_DELIVERY_STALE', message: 'This card is no longer actionable' },
      data: summaryFixture({ cardState: 'superseded', actionable: false }),
    }, 409))

    const approve = await waitForElement<HTMLButtonElement>('[data-testid="card-decision-approve"]')
    approve.click()
    await waitForElement('[data-testid="card-decision-stale"]')
  })

  it('missing d/t query renders an invalid-link error without calling the api', async () => {
    routeQuery = {}
    await mountView()
    const error = await waitForElement('[data-testid="card-decision-load-error"]')
    expect(error.getAttribute('data-title')).toContain('链接无效')
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('P2: an unauthenticated deep link auto-launches DingTalk OAuth — never the generic /login', async () => {
    mockUserId = null
    stubWindowLocation('http://localhost/m/approval-decision?d=del_1')
    apiFetchMock.mockImplementationOnce(() => delayedJsonResponse({ success: true, data: { url: 'https://oapi.dingtalk.com/launch/abc' } }))

    await mountView()
    await waitForUi(() => expect(window.location.href).toBe('https://oapi.dingtalk.com/launch/abc'))

    const calls = apiFetchMock.mock.calls.map((c) => String(c[0]))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/api/auth/dingtalk/launch?redirect=')
    expect(decodeURIComponent(calls[0].split('redirect=')[1])).toBe(`/m/approval-decision?d=del_1&t=${'a'.repeat(32)}`)
    expect(window.location.href).toBe('https://oapi.dingtalk.com/launch/abc')
    // no summary fetch, no /login navigation of any kind
    expect(calls.some((u) => u.includes('/api/approval-card-deliveries/'))).toBe(false)
  })

  it('P2: bounced back still unauthenticated → manual 钉钉登录 button instead of a redirect loop', async () => {
    mockUserId = null
    sessionStorage.setItem('approval-card-launch-attempted:del_1', '1')
    await mountView()
    await waitForElement('[data-testid="card-decision-launch"]')
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('P2: an authenticated visit never triggers the launch flow', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: summaryFixture() }))
    await mountView()
    await waitForElement('[data-testid="card-decision-title"]')
    const calls = apiFetchMock.mock.calls.map((c) => String(c[0]))
    expect(calls.some((u) => u.includes('/api/auth/dingtalk/launch'))).toBe(false)
    expect(calls[0]).toContain('/api/approval-card-deliveries/del_1')
  })

  it('P2: a missing d/t link stays a LOCAL invalid-link error — no launch, no api call', async () => {
    mockUserId = null
    routeQuery = {}
    await mountView()
    const error = await waitForElement('[data-testid="card-decision-load-error"]')
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(error.getAttribute('data-title')).toContain('链接无效')
  })

  it('TRIPWIRE: the decision page and its api module never touch raw /api/approvals/ paths', () => {
    // Direct calls would bypass the card ledger writeback + channel attribution (lock §5 hard rule).
    const view = readFileSync(resolve(__dirname, '../src/views/approval/ApprovalCardDecisionView.vue'), 'utf8')
    const api = readFileSync(resolve(__dirname, '../src/approvals/cardDecision.ts'), 'utf8')
    for (const source of [view, api]) {
      expect(source).not.toContain("'/api/approvals/")
      expect(source).not.toContain('`/api/approvals/')
    }
    expect(api).toContain('/api/approval-card-deliveries/')
  })
})
