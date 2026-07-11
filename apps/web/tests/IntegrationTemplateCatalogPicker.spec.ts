import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import IntegrationTemplateCatalogPicker from '../src/components/integration/IntegrationTemplateCatalogPicker.vue'
import {
  INTEGRATION_TEMPLATE_CATALOG,
  integrationTemplateCatalogEntriesFor,
  type IntegrationTemplateCatalogEntry,
} from '../src/services/integration/readSourceTemplateCatalog'

// TC-1 connector/experience template catalog picker — standalone component spec (design-lock
// docs/development/integration-connector-template-catalog-design-lock-20260708.md, #3879). The
// end-to-end wiring (seeding a real panel's draft, forcing view mode back to wizard) is covered by the
// ADD-ONLY tests appended to IntegrationReadSourceWizard.spec.ts / IntegrationCompositionWizard.spec.ts;
// this spec is the picker's own contract in isolation — filtering, rendering, collapse/expand, emit.

const ElIcon = defineComponent({
  name: 'ElIcon',
  setup(_props, { slots }) {
    return () => h('span', { class: 'el-icon' }, slots.default?.())
  },
})

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('IntegrationTemplateCatalogPicker', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let selected: IntegrationTemplateCatalogEntry[] = []

  beforeEach(() => {
    selected = []
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  function mount(seedsWizard: 'read-source' | 'composition' | 'bridge', testidPrefix = 'rsc'): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () => h(IntegrationTemplateCatalogPicker, {
        seedsWizard,
        testidPrefix,
        onSelect: (entry: IntegrationTemplateCatalogEntry) => selected.push(entry),
      }),
    })
    app.component('ElIcon', ElIcon)
    app.mount(container)
    return container
  }

  function q<T extends HTMLElement>(root: HTMLElement, testid: string): T {
    const el = root.querySelector<T>(`[data-testid="${testid}"]`)
    if (!el) throw new Error(`missing [data-testid=${testid}]`)
    return el
  }

  function maybe(root: HTMLElement, testid: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
  }

  it('renders collapsed by default and expands via the toggle', async () => {
    const root = mount('read-source')
    await flushUi()
    expect((q(root, 'rsc-template-catalog-body')).style.display).toBe('none')
    q<HTMLButtonElement>(root, 'rsc-template-catalog-toggle').click()
    await flushUi()
    expect((q(root, 'rsc-template-catalog-body')).style.display).not.toBe('none')
  })

  it('lists exactly the catalog entries matching the seedsWizard prop — no more, no fewer', async () => {
    const root = mount('read-source')
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-template-catalog-toggle').click()
    await flushUi()

    const expected = integrationTemplateCatalogEntriesFor('read-source')
    for (const entry of expected) {
      expect(maybe(root, `rsc-template-catalog-card-${entry.id}`), entry.id).not.toBeNull()
    }
    const nonMatching = INTEGRATION_TEMPLATE_CATALOG.filter((entry) => entry.seedsWizard !== 'read-source')
    for (const entry of nonMatching) {
      expect(maybe(root, `rsc-template-catalog-card-${entry.id}`), entry.id).toBeNull()
    }
  })

  it('clicking a card emits select with the exact catalog entry object', async () => {
    const root = mount('composition', 'rscauth')
    await flushUi()
    q<HTMLButtonElement>(root, 'rscauth-template-catalog-toggle').click()
    await flushUi()
    q<HTMLButtonElement>(root, 'rscauth-template-catalog-card-two-hop-composition').click()
    await flushUi()

    expect(selected).toHaveLength(1)
    expect(selected[0].id).toBe('two-hop-composition')
    expect(selected[0].seedsWizard).toBe('composition')
  })

  it('bridge templates render in a bridge-scoped picker (data-complete even with no interactive host wired in TC-1)', async () => {
    const root = mount('bridge')
    await flushUi()
    q<HTMLButtonElement>(root, 'rsc-template-catalog-toggle').click()
    await flushUi()
    expect(maybe(root, 'rsc-template-catalog-card-bridge-legacy-sql-readonly')).not.toBeNull()
  })

  it('renders zh copy through useLocale', async () => {
    const { setLocale } = useLocale()
    setLocale('zh-CN')
    try {
      const root = mount('read-source')
      await flushUi()
      expect(q(root, 'rsc-template-catalog-toggle').textContent).toContain('从模板开始')
    } finally {
      setLocale('en')
    }
  })

  // SENTINEL, DOM layer (design-lock §5.2: "sentinel 测试断言占位符形态,DOM 层复证" — the data-level
  // scan already lives in readSourceTemplateCatalog.spec.ts; this re-verifies the same five patterns
  // against the ACTUALLY RENDERED grid text, in both locales, mirroring the Bridge-Agent line's
  // "double proof" discipline (data scan + DOM scan) rather than trusting the data-level scan alone.
  const DIGIT_RUN_TOO_LONG = /\d{5,}/
  const HAS_URL_SCHEME = /https?:\/\//i
  const HAS_HOST_SHAPE = /\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/i
  const HAS_IPV4_SHAPE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/
  const HAS_CREDENTIAL_KEYWORD = /(password|secret|token|apikey|api[_-]?key|authorization|credential)/i

  it('SENTINEL (DOM layer): the rendered catalog grid never carries a digit-run/URL/host/IP/credential-shaped string, in either locale', async () => {
    const { setLocale } = useLocale()
    for (const locale of ['en', 'zh-CN'] as const) {
      setLocale(locale)
      for (const kind of ['read-source', 'composition', 'bridge'] as const) {
        const root = mount(kind)
        await flushUi()
        q<HTMLButtonElement>(root, 'rsc-template-catalog-toggle').click()
        await flushUi()
        const gridText = q(root, 'rsc-template-catalog-grid').textContent ?? ''
        expect(gridText, `${kind}/${locale}`).not.toMatch(DIGIT_RUN_TOO_LONG)
        expect(gridText, `${kind}/${locale}`).not.toMatch(HAS_URL_SCHEME)
        expect(gridText, `${kind}/${locale}`).not.toMatch(HAS_HOST_SHAPE)
        expect(gridText, `${kind}/${locale}`).not.toMatch(HAS_IPV4_SHAPE)
        expect(gridText, `${kind}/${locale}`).not.toMatch(HAS_CREDENTIAL_KEYWORD)
        app?.unmount()
        container?.remove()
        app = null
        container = null
      }
    }
    setLocale('en')
  })
})
