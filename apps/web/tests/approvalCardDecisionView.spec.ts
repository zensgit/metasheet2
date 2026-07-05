/**
 * A-3 decision page (one-tap lock #3594 §5) — view behavior + the no-raw-/actions tripwire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
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

async function flushUi(cycles = 6) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('ApprovalCardDecisionView (A-3)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  async function mountView() {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(ApprovalCardDecisionView)
    for (const name of ['ElAlert', 'ElInput', 'ElButton']) app.component(name, stub(name))
    app.directive('loading', { mounted() {}, updated() {} })
    app.mount(container)
    await flushUi()
  }

  beforeEach(() => {
    routeQuery = { d: 'del_1', t: 'a'.repeat(32) }
    apiFetchMock.mockReset()
    mockUserId = 'user_a'
    sessionStorage.clear()
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  it('renders the summary and blocks 驳回 until a comment is typed (rejectCommentRequired)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: summaryFixture() }))
    await mountView()

    expect(container!.querySelector('[data-testid="card-decision-title"]')?.textContent).toBe('出差报销')
    const reject = container!.querySelector('[data-testid="card-decision-reject"]') as HTMLButtonElement
    expect(reject.disabled).toBe(true)
    expect(container!.querySelector('[data-testid="card-decision-reject-hint"]')).toBeTruthy()

    const commentBox = container!.querySelector('[data-testid="card-decision-comment"] textarea, textarea') as HTMLTextAreaElement
    commentBox.value = '材料不全'
    commentBox.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect((container!.querySelector('[data-testid="card-decision-reject"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('approve submits to the card-delivery endpoint and renders the terminal state', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: summaryFixture() }))
    await mountView()
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      data: summaryFixture({ cardState: 'acted', actionable: false, actedAction: 'approve', approval: { ...summaryFixture().approval, status: 'approved' } }),
    }))

    ;(container!.querySelector('[data-testid="card-decision-approve"]') as HTMLButtonElement).click()
    await flushUi()

    const calls = apiFetchMock.mock.calls.map((c) => String(c[0]))
    expect(calls[1]).toBe('/api/approval-card-deliveries/del_1/actions')
    const init = apiFetchMock.mock.calls[1][1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({ t: 'a'.repeat(32), decision: 'approve' })
    expect(container!.querySelector('[data-testid="card-decision-stale"]')?.getAttribute('data-title')).toContain('已处理')
  })

  it('a 409 stale response swaps in the REAL terminal summary instead of a dead form', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: summaryFixture() }))
    await mountView()
    apiFetchMock.mockResolvedValueOnce(jsonResponse({
      error: { code: 'APPROVAL_CARD_DELIVERY_STALE', message: 'This card is no longer actionable' },
      data: summaryFixture({ cardState: 'superseded', actionable: false }),
    }, 409))

    ;(container!.querySelector('[data-testid="card-decision-approve"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container!.querySelector('[data-testid="card-decision-stale"]')).toBeTruthy()
  })

  it('missing d/t query renders an invalid-link error without calling the api', async () => {
    routeQuery = {}
    await mountView()
    expect(container!.querySelector('[data-testid="card-decision-load-error"]')?.getAttribute('data-title')).toContain('链接无效')
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('P2: an unauthenticated deep link auto-launches DingTalk OAuth — never the generic /login', async () => {
    mockUserId = null
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: 'http://localhost/m/approval-decision?d=del_1' },
    })
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { url: 'https://oapi.dingtalk.com/launch/abc' } }))

    await mountView()

    const calls = apiFetchMock.mock.calls.map((c) => String(c[0]))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/api/auth/dingtalk/launch?redirect=')
    expect(decodeURIComponent(calls[0].split('redirect=')[1])).toBe(`/m/approval-decision?d=del_1&t=${'a'.repeat(32)}`)
    expect(window.location.href).toBe('https://oapi.dingtalk.com/launch/abc')
    // no summary fetch, no /login navigation of any kind
    expect(calls.some((u) => u.includes('/api/approval-card-deliveries/'))).toBe(false)
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })

  it('P2: bounced back still unauthenticated → manual 钉钉登录 button instead of a redirect loop', async () => {
    mockUserId = null
    sessionStorage.setItem('approval-card-launch-attempted:del_1', '1')
    await mountView()
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(container!.querySelector('[data-testid="card-decision-launch"]')).toBeTruthy()
  })

  it('P2: an authenticated visit never triggers the launch flow', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, data: summaryFixture() }))
    await mountView()
    const calls = apiFetchMock.mock.calls.map((c) => String(c[0]))
    expect(calls.some((u) => u.includes('/api/auth/dingtalk/launch'))).toBe(false)
    expect(calls[0]).toContain('/api/approval-card-deliveries/del_1')
  })

  it('P2: a missing d/t link stays a LOCAL invalid-link error — no launch, no api call', async () => {
    mockUserId = null
    routeQuery = {}
    await mountView()
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(container!.querySelector('[data-testid="card-decision-load-error"]')?.getAttribute('data-title')).toContain('链接无效')
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
