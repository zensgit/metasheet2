import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import App from '../src/App.vue'

const loadProductFeatures = vi.fn().mockResolvedValue(undefined)
const fetchPlugins = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', () => ({
  useRoute: () => ({
    path: '/login',
    meta: {
      hideNavbar: true,
      requiresGuest: true,
    },
  }),
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    navItems: ref([]),
    fetchPlugins,
  }),
}))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    loadProductFeatures,
    isAttendanceFocused: () => false,
    hasFeature: () => false,
  }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref('zh-CN'),
    isZh: ref(true),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/utils/api', () => ({
  clearStoredAuthState: vi.fn(),
  getStoredAuthToken: vi.fn(() => ''),
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('App guest bootstrap', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  it('skips session probing and plugin fetches on guest routes', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(App as Component)
    app.component('router-view', { render: () => h('div') })
    app.component('router-link', {
      props: ['to'],
      render() {
        return h('a', { href: this.$props.to }, this.$slots.default ? this.$slots.default() : [])
      },
    })

    app.mount(container)
    await flushUi()

    expect(loadProductFeatures).toHaveBeenCalledTimes(1)
    expect(loadProductFeatures).toHaveBeenCalledWith(false, { skipSessionProbe: true })
    expect(fetchPlugins).not.toHaveBeenCalled()
  })
})
