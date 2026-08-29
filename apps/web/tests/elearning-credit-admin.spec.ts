import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  list: vi.fn(),
  publish: vi.fn(),
}))

vi.mock('../src/services/elearningCredit', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningCredit')>(
    '../src/services/elearningCredit',
  )
  return {
    ...actual,
    listElearningCreditRules: h.list,
    publishElearningCreditRule: h.publish,
  }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningCreditAdminSection from '../src/views/ElearningCreditAdminSection.vue'

const REQUEST_A = '11111111-1111-4111-8111-111111111111'
const REQUEST_B = '22222222-2222-4222-8222-222222222222'
const RULE = '33333333-3333-4333-8333-333333333333'

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function rule(over: Record<string, unknown> = {}) {
  return {
    behavior: 'complete_course' as const,
    ruleId: RULE,
    version: 1,
    points: 5,
    dailyCap: null,
    timeZone: 'Asia/Taipei',
    createdAt: '2026-08-29T00:00:00.000Z',
    ...over,
  }
}

function fill(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('ElearningCreditAdminSection', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null
  let uuidSpy: ReturnType<typeof vi.spyOn> | null = null

  function mountView(): HTMLDivElement {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningCreditAdminSection)
    app.mount(root)
    return root
  }

  function q(testid: string): HTMLElement {
    const value = root?.querySelector(`[data-testid="${testid}"]`)
    if (!(value instanceof HTMLElement)) throw new Error(`missing ${testid}`)
    return value
  }

  beforeEach(() => {
    useLocale().setLocale('en')
    h.list.mockReset()
    h.publish.mockReset()
    h.list.mockResolvedValue([rule()])
    let index = 0
    const ids = [REQUEST_A, REQUEST_B]
    uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => (
      ids[index++] ?? REQUEST_B
    ) as `${string}-${string}-${string}-${string}-${string}`)
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    uuidSpy?.mockRestore()
    vi.clearAllMocks()
  })

  it('loads the current active rules', async () => {
    const view = mountView()
    await flushUi()
    expect(h.list).toHaveBeenCalledTimes(1)
    expect(view.textContent).toContain('Complete course')
    expect(view.textContent).toContain('v1')
  })

  it('reuses requestId after a retryable failure and rotates it after values change', async () => {
    mountView()
    await flushUi()
    fill(q('elearning-credit-rule-points') as HTMLInputElement, '5')
    h.publish.mockRejectedValueOnce(new ElearningApiError('network_error', 0))
    ;(q('elearning-credit-rule-submit') as HTMLButtonElement).click()
    await flushUi()
    expect(h.publish.mock.calls[0]?.[0]).toMatchObject({ requestId: REQUEST_A, points: 5 })

    h.publish.mockRejectedValueOnce(new ElearningApiError('unavailable', 503))
    ;(q('elearning-credit-rule-submit') as HTMLButtonElement).click()
    await flushUi()
    expect(h.publish.mock.calls[1]?.[0]).toMatchObject({ requestId: REQUEST_A, points: 5 })

    fill(q('elearning-credit-rule-points') as HTMLInputElement, '6')
    h.publish.mockResolvedValueOnce(rule({ points: 6, version: 2 }))
    h.list.mockResolvedValueOnce([rule({ points: 6, version: 2 })])
    ;(q('elearning-credit-rule-submit') as HTMLButtonElement).click()
    await flushUi()
    expect(h.publish.mock.calls[2]?.[0]).toMatchObject({ requestId: REQUEST_B, points: 6 })
    expect(q('elearning-credit-rule-status').textContent).toContain('published')
  })

  it('shows values-free conflict guidance without echoing the attempted rule', async () => {
    mountView()
    await flushUi()
    h.publish.mockRejectedValueOnce(new ElearningApiError('conflict', 409))
    ;(q('elearning-credit-rule-submit') as HTMLButtonElement).click()
    await flushUi()
    const status = q('elearning-credit-rule-status').textContent ?? ''
    expect(status).toContain('request ID')
    expect(status).not.toContain(REQUEST_A)
    expect(status).not.toContain('complete_course')
  })
})
