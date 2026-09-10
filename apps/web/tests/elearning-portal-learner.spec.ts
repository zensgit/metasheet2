import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'

const h = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../src/services/elearningPortal', async () => {
  const actual = await vi.importActual<typeof import('../src/services/elearningPortal')>(
    '../src/services/elearningPortal',
  )
  return { ...actual, getElearningPortalSettings: h.get }
})

import { ElearningApiError } from '../src/services/elearning'
import ElearningPortalHero from '../src/views/ElearningPortalHero.vue'

const SETTINGS = {
  revisionId: '33333333-3333-4333-8333-333333333333',
  version: 1,
  siteName: '<MetaSheet Academy>',
  tagline: '<script>not markup</script>',
  bannerUrl: '/assets/banner.png',
  navigation: [{ label: '<My courses>', href: '/elearning' }],
  createdAt: '2026-08-30T01:02:03.456Z',
}

async function flushUi(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('ElearningPortalHero', () => {
  let app: VueApp<Element> | null = null
  let root: HTMLDivElement | null = null

  function mount() {
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ElearningPortalHero)
    app.mount(root)
    return root
  }

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    h.get.mockReset()
  })

  afterEach(() => {
    app?.unmount()
    root?.remove()
    app = null
    root = null
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  it('renders text as text, the configured image and only parsed internal navigation', async () => {
    h.get.mockResolvedValue(SETTINGS)
    const view = mount()
    await flushUi()
    expect(view.querySelector('[data-testid="elearning-portal-hero"]')).not.toBeNull()
    expect(view.querySelector('script')).toBeNull()
    expect(view.querySelector('h2')?.textContent).toBe('<MetaSheet Academy>')
    expect(view.querySelector('p')?.textContent).toBe('<script>not markup</script>')
    expect(view.querySelector('[data-testid="elearning-portal-banner"]')?.getAttribute('src'))
      .toBe('/assets/banner.png')
    expect(view.querySelector('a')?.getAttribute('href')).toBe('/elearning')
    expect(view.querySelector('a')?.textContent).toBe('<My courses>')
  })

  it('stays absent for the closed empty default', async () => {
    h.get.mockResolvedValue({
      revisionId: null,
      version: 0,
      siteName: null,
      tagline: null,
      bannerUrl: null,
      navigation: [],
      createdAt: null,
    })
    const view = mount()
    await flushUi()
    expect(view.querySelector('[data-testid="elearning-portal-hero"]')).toBeNull()
    expect(view.querySelector('[data-testid="elearning-portal-error"]')).toBeNull()
  })

  it('fails closed with a localized error and no stale portal', async () => {
    h.get.mockRejectedValue(new ElearningApiError('unavailable', 503))
    const view = mount()
    await flushUi()
    expect(view.querySelector('[data-testid="elearning-portal-hero"]')).toBeNull()
    expect(view.querySelector('[data-testid="elearning-portal-error"]')?.textContent)
      .toContain('无法加载')
  })
})
