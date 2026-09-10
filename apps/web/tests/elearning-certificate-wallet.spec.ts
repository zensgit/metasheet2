import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('../src/services/elearningCertificate', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningCertificate')>(
    '../src/services/elearningCertificate',
  )
  return { ...actual, listMyElearningCertificates: h.list }
})

import ElearningCertificateWalletSection from '../src/views/ElearningCertificateWalletSection.vue'

const REVISION = '11111111-1111-4111-8111-111111111111'
const ISSUE = '22222222-2222-4222-8222-222222222222'
const SERIAL = '33333333-3333-4333-8333-333333333333'

async function flushUi(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function certificate(over: Record<string, unknown> = {}) {
  return {
    issueId: ISSUE,
    certificateId: 'course-completion',
    templateRevisionId: REVISION,
    templateName: 'Course completion',
    serialNumber: SERIAL,
    parameters: { courseName: 'Safety', learnerName: 'Learner' },
    backgroundImageUrl: 'https://assets.example.test/certificate.png',
    issuedAt: '2026-08-30T05:00:00.000Z',
    ...over,
  }
}

describe('ElearningCertificateWalletSection', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null

  function mountView(): HTMLDivElement {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningCertificateWalletSection)
    app.mount(root)
    return root
  }

  beforeEach(() => {
    useLocale().setLocale('en')
    h.list.mockReset()
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    vi.clearAllMocks()
  })

  it('renders the immutable certificate snapshot and protected background image', async () => {
    h.list.mockResolvedValueOnce([certificate()])
    const view = mountView()
    await flushUi()
    expect(h.list).toHaveBeenCalledTimes(1)
    expect(view.textContent).toContain('Course completion')
    expect(view.textContent).toContain(SERIAL)
    expect(view.textContent).toContain('courseName')
    expect(view.textContent).toContain('Safety')
    const image = view.querySelector('img')
    expect(image?.getAttribute('src')).toBe('https://assets.example.test/certificate.png')
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('renders a text-only certificate without inventing a downloadable artifact', async () => {
    h.list.mockResolvedValueOnce([certificate({ backgroundImageUrl: null })])
    const view = mountView()
    await flushUi()
    expect(view.querySelector('img')).toBeNull()
    expect(view.querySelector('a[download]')).toBeNull()
    expect(view.textContent).toContain('Course completion')
  })

  it('keeps load failure distinct from an empty certificate wallet', async () => {
    h.list.mockRejectedValueOnce(new Error('network'))
    const view = mountView()
    await flushUi()
    expect(view.querySelector('[data-testid="elearning-certificate-wallet-error"]')).toBeTruthy()
    expect(view.querySelector('[data-testid="elearning-certificate-wallet-empty"]')).toBeNull()
  })
})
