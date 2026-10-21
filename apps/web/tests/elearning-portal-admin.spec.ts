import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({
  get: vi.fn(),
  publish: vi.fn(),
}))

vi.mock('../src/services/elearningPortal', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningPortal')>(
    '../src/services/elearningPortal',
  )
  return {
    ...actual,
    getElearningPortalSettings: h.get,
    publishElearningPortalSettings: h.publish,
  }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningPortalAdminSection from '../src/views/ElearningPortalAdminSection.vue'

const REQUEST_1 = '11111111-1111-4111-8111-111111111111'
const REQUEST_2 = '22222222-2222-4222-8222-222222222222'
const REVISION = '33333333-3333-4333-8333-333333333333'
const CURRENT = {
  revisionId: REVISION,
  version: 1,
  siteName: 'MetaSheet Academy',
  tagline: 'Learn together',
  bannerUrl: '/assets/banner.png',
  navigation: [{ label: 'My courses', href: '/elearning' }],
  createdAt: '2026-08-30T01:02:03.456Z',
}

async function flushUi(cycles = 12): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function fill(element: HTMLInputElement, value: string): void {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ElearningPortalAdminSection', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null
  let uuidSpy: ReturnType<typeof vi.spyOn> | null = null

  function mount() {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningPortalAdminSection)
    app.mount(root)
    return root
  }

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    h.get.mockReset()
    h.publish.mockReset()
    h.get.mockResolvedValue(CURRENT)
    h.publish.mockResolvedValue({ ...CURRENT, version: 2, duplicate: false })
    const ids = [REQUEST_1, REQUEST_2, REVISION]
    uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockImplementation(() => ids.shift() ?? REVISION)
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    uuidSpy?.mockRestore()
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  it('loads the active revision and publishes a closed ordered draft', async () => {
    const view = mount()
    await flushUi()
    expect((view.querySelector('[data-testid="elearning-portal-site-name"]') as HTMLInputElement).value)
      .toBe('MetaSheet Academy')
    expect(view.querySelectorAll('[data-testid^="elearning-portal-navigation-"]')).toHaveLength(1)

    ;(view.querySelector('[data-testid="elearning-portal-add-navigation"]') as HTMLButtonElement).click()
    await flushUi()
    const rows = view.querySelectorAll('[data-testid^="elearning-portal-navigation-"]')
    fill(rows[1]!.querySelectorAll('input')[0]!, 'My wallet')
    fill(rows[1]!.querySelectorAll('input')[1]!, '/elearning/wallet')
    ;(view.querySelector('[data-testid="elearning-portal-save"]') as HTMLButtonElement).click()
    await flushUi()

    expect(h.publish).toHaveBeenCalledWith({
      requestId: REQUEST_1,
      siteName: CURRENT.siteName,
      tagline: CURRENT.tagline,
      bannerUrl: CURRENT.bannerUrl,
      navigation: [
        { label: 'My courses', href: '/elearning' },
        { label: 'My wallet', href: '/elearning/wallet' },
      ],
    })
    expect(view.querySelector('[data-testid="elearning-portal-admin-status"]')?.textContent)
      .toContain('v2')
  })

  it('reuses the request id after retryable failure and rotates after payload change', async () => {
    const view = mount()
    await flushUi()
    h.publish.mockRejectedValueOnce(new ElearningApiError('network_error', 0))
    const save = view.querySelector('[data-testid="elearning-portal-save"]') as HTMLButtonElement
    save.click()
    await flushUi()
    const firstId = h.publish.mock.calls[0][0].requestId
    save.click()
    await flushUi()
    expect(h.publish.mock.calls[1][0].requestId).toBe(firstId)

    fill(view.querySelector('[data-testid="elearning-portal-tagline"]') as HTMLInputElement, 'Changed')
    save.click()
    await flushUi()
    expect(h.publish.mock.calls[2][0].requestId).not.toBe(firstId)
  })

  it('keeps server errors values-free and does not claim success', async () => {
    const view = mount()
    await flushUi()
    h.publish.mockRejectedValueOnce(new ElearningApiError('conflict', 409))
    ;(view.querySelector('[data-testid="elearning-portal-save"]') as HTMLButtonElement).click()
    await flushUi()
    const status = view.querySelector('[data-testid="elearning-portal-admin-status"]')
    expect(status?.textContent).toContain('冲突')
    expect(status?.className).toContain('error')
  })
})
