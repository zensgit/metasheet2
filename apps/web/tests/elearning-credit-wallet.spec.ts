import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({ getWallet: vi.fn() }))
vi.mock('../src/services/elearningCredit', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningCredit')>(
    '../src/services/elearningCredit',
  )
  return { ...actual, getMyElearningCreditWallet: h.getWallet }
})

import ElearningCreditWalletSection from '../src/views/ElearningCreditWalletSection.vue'

const FIRST = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function item(decisionId: string, points: number) {
  return {
    decisionId,
    behavior: 'complete_course' as const,
    awardedPoints: points,
    status: 'awarded' as const,
    occurredAt: '2026-08-29T00:00:00.000Z',
    createdAt: '2026-08-29T00:00:01.000Z',
  }
}

function adjustment(decisionId: string, points: number) {
  return {
    decisionId,
    behavior: 'manual_adjust' as const,
    awardedPoints: points,
    status: 'adjusted' as const,
    occurredAt: '2026-08-29T00:00:00.000Z',
    createdAt: '2026-08-29T00:00:01.000Z',
  }
}

describe('ElearningCreditWalletSection', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null

  function mountView(): HTMLDivElement {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningCreditWalletSection)
    app.mount(root)
    return root
  }

  beforeEach(() => {
    useLocale().setLocale('en')
    h.getWallet.mockReset()
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    vi.clearAllMocks()
  })

  it('shows the balance and appends keyset pages without replacing earlier history', async () => {
    h.getWallet
      .mockResolvedValueOnce({
        userId: 'user-1',
        balancePoints: 5,
        items: [item(FIRST, 5)],
        nextCursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        userId: 'user-1',
        balancePoints: 8,
        items: [item(SECOND, 3)],
        nextCursor: null,
      })
    const view = mountView()
    await flushUi()
    expect(h.getWallet).toHaveBeenCalledWith(null)
    expect(view.querySelector('[data-testid="elearning-credit-wallet-balance"]')?.textContent).toBe('5')
    expect(view.textContent).toContain('+5')

    ;(view.querySelector('[data-testid="elearning-credit-wallet-more"]') as HTMLButtonElement).click()
    await flushUi()
    expect(h.getWallet).toHaveBeenLastCalledWith('cursor-2')
    expect(view.querySelector('[data-testid="elearning-credit-wallet-balance"]')?.textContent).toBe('8')
    expect(view.textContent).toContain('+5')
    expect(view.textContent).toContain('+3')
    expect(view.querySelector('[data-testid="elearning-credit-wallet-more"]')).toBeNull()
  })

  it('keeps an explicit error state instead of presenting a failed request as an empty wallet', async () => {
    h.getWallet.mockRejectedValueOnce(new Error('network'))
    const view = mountView()
    await flushUi()
    expect(view.querySelector('[data-testid="elearning-credit-wallet-error"]')).toBeTruthy()
    expect(view.querySelector('[data-testid="elearning-credit-wallet-empty"]')).toBeNull()
  })

  it('renders positive and negative manual adjustments without a false plus sign', async () => {
    h.getWallet.mockResolvedValueOnce({
      userId: 'user-1',
      balancePoints: 7,
      items: [adjustment(FIRST, -3), adjustment(SECOND, 2)],
      nextCursor: null,
    })
    const view = mountView()
    await flushUi()
    const text = view.textContent ?? ''
    expect(text).toContain('-3')
    expect(text).toContain('+2')
    expect(text).not.toContain('+-3')
    expect(text).toContain('Manual adjustment')
  })
})
