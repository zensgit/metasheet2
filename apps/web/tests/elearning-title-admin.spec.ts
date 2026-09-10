import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  getTitles: vi.fn(),
  publishTitles: vi.fn(),
}))

vi.mock('../src/services/elearningCredit', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningCredit')>(
    '../src/services/elearningCredit',
  )
  return {
    ...actual,
    getElearningTitleSnapshot: h.getTitles,
    publishElearningTitleSnapshot: h.publishTitles,
  }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningTitleAdminSection from '../src/views/ElearningTitleAdminSection.vue'

const REQUEST_A = '11111111-1111-4111-8111-111111111111'
const REQUEST_B = '22222222-2222-4222-8222-222222222222'
const REVISION = '33333333-3333-4333-8333-333333333333'

async function flushUi(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function snapshot(threshold = 0) {
  return {
    revisionId: REVISION,
    version: 1,
    titles: [{ id: 'starter', name: 'Starter', threshold }],
    createdAt: '2026-08-30T00:00:00.000Z',
  }
}

function fill(element: HTMLInputElement, value: string): void {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('ElearningTitleAdminSection', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null
  let uuidSpy: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    useLocale().setLocale('en')
    h.getTitles.mockReset()
    h.publishTitles.mockReset()
    h.getTitles.mockResolvedValue(snapshot())
    let index = 0
    uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => (
      [REQUEST_A, REQUEST_B][index++] ?? REQUEST_B
    ) as `${string}-${string}-${string}-${string}-${string}`)
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    uuidSpy?.mockRestore()
    app = null
    root = null
    vi.clearAllMocks()
  })

  function mountView(): HTMLDivElement {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningTitleAdminSection)
    app.mount(root)
    return root
  }

  function q(testid: string): HTMLElement {
    const value = root?.querySelector(`[data-testid="${testid}"]`)
    if (!(value instanceof HTMLElement)) throw new Error(`missing ${testid}`)
    return value
  }

  it('loads the active snapshot and publishes only the canonical full table', async () => {
    const view = mountView()
    await flushUi()
    expect(h.getTitles).toHaveBeenCalledTimes(1)
    expect((q('elearning-title-name') as HTMLInputElement).value).toBe('Starter')

    h.publishTitles.mockResolvedValueOnce(snapshot())
    ;(q('elearning-title-publish') as HTMLButtonElement).click()
    await flushUi()
    expect(h.publishTitles).toHaveBeenCalledWith({
      requestId: REQUEST_A,
      titles: [{ id: 'starter', name: 'Starter', threshold: 0 }],
    })
    expect(view.textContent).toContain('Titles published')
  })

  it('reuses request identity on retry and rotates it when title values change', async () => {
    mountView()
    await flushUi()
    h.publishTitles.mockRejectedValueOnce(new ElearningApiError('network_error', 0))
    ;(q('elearning-title-publish') as HTMLButtonElement).click()
    await flushUi()
    expect(h.publishTitles.mock.calls[0]?.[0].requestId).toBe(REQUEST_A)

    h.publishTitles.mockRejectedValueOnce(new ElearningApiError('unavailable', 503))
    ;(q('elearning-title-publish') as HTMLButtonElement).click()
    await flushUi()
    expect(h.publishTitles.mock.calls[1]?.[0].requestId).toBe(REQUEST_A)

    fill(q('elearning-title-threshold') as HTMLInputElement, '10')
    h.publishTitles.mockResolvedValueOnce(snapshot(10))
    ;(q('elearning-title-publish') as HTMLButtonElement).click()
    await flushUi()
    expect(h.publishTitles.mock.calls[2]?.[0]).toMatchObject({
      requestId: REQUEST_B,
      titles: [{ threshold: 10 }],
    })
  })

  it('keeps errors values-free and supports publishing an empty snapshot', async () => {
    mountView()
    await flushUi()
    ;(q('elearning-title-remove') as HTMLButtonElement).click()
    h.publishTitles.mockRejectedValueOnce(new ElearningApiError('conflict', 409))
    ;(q('elearning-title-publish') as HTMLButtonElement).click()
    await flushUi()
    expect(h.publishTitles).toHaveBeenCalledWith({
      requestId: REQUEST_A,
      titles: [],
    })
    const status = q('elearning-title-status').textContent ?? ''
    expect(status).toContain('request ID')
    expect(status).not.toContain(REQUEST_A)
    expect(status).not.toContain('starter')
  })
})
