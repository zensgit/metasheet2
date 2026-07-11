// UI-P2-1c batch5: MultitableTemplateCenterView's hero refresh, category filter chips (the "全部" ALL-category
// button + its v-for per-category siblings — both sharers of `.multitable-templates__category-btn` migrate
// together per the shared-class rule), and error-banner retry were migrated from bespoke <button> elements to
// the shared MtButton primitive: refresh/retry/category-chips all default to ghost (bespoke bordered/accent
// CSS dropped — same sanctioned normalization as prior batches); the active-category visual cue is preserved
// as an additive `--active` CSS overlay (MtButton has no selected/active variant), same pattern as
// MultitableHomeView's `.multitable-home__favorite[aria-pressed='true']`. Behavior-preservation proof: all
// three stay a native <button>, keep their exact :disabled / @click bindings, and clicking any of them still
// runs the SAME handler (loadTemplates / activeCategory assignment) as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp, type Component } from 'vue'
import MultitableTemplateCenterView from '../src/views/MultitableTemplateCenterView.vue'
import { useLocale } from '../src/composables/useLocale'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  listTemplates: vi.fn(),
  installTemplate: vi.fn(),
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: mocks.push }),
  }
})

vi.mock('../src/multitable/api/client', () => ({
  multitableClient: {
    listTemplates: mocks.listTemplates,
    installTemplate: mocks.installTemplate,
  },
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function makeTemplate(id: string, category: string) {
  return {
    id,
    name: `Template ${id}`,
    description: '',
    category,
    icon: 'T',
    color: '#2563eb',
    sheets: [{ id: `${id}-sheet`, name: 'Sheet 1', fields: [{ id: 'f0', name: 'Name', type: 'string' }], views: [{ id: 'v0', name: 'Grid', type: 'grid' }] }],
  }
}

const mounted: VueApp<Element>[] = []
const containers: HTMLDivElement[] = []

function mountView() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  const app = createApp(MultitableTemplateCenterView as Component)
  app.component('router-link', {
    props: ['to'],
    render() {
      return h('a', { 'data-router-link': true }, this.$slots.default ? this.$slots.default() : [])
    },
  })
  app.mount(container)
  mounted.push(app)
  return container
}

beforeEach(() => {
  useLocale().setLocale('zh-CN')
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  while (containers.length) containers.pop()!.remove()
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.clearAllMocks()
})

describe('MultitableTemplateCenterView — MtButton migration (UI-P2-1c batch5)', () => {
  it('refresh: renders as a native <button> (MtButton, ghost) and clicking it re-invokes loadTemplates', async () => {
    mocks.listTemplates.mockResolvedValue({ templates: [] })
    const root = mountView()
    await flushUi()
    expect(mocks.listTemplates).toHaveBeenCalledTimes(1)

    const btn = root.querySelector<HTMLButtonElement>('.multitable-templates__refresh')!
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('mt-button--ghost')).toBe(true)
    expect(btn.disabled).toBe(false)

    btn.click()
    await flushUi()
    expect(mocks.listTemplates).toHaveBeenCalledTimes(2)
  })

  it('refresh: :disabled tracks loading — a disabled MtButton still blocks the click (no extra loadTemplates call)', async () => {
    let resolveList: ((v: unknown) => void) | null = null
    mocks.listTemplates.mockReturnValue(new Promise((resolve) => { resolveList = resolve }))
    const root = mountView()
    await flushUi()

    const btn = root.querySelector<HTMLButtonElement>('.multitable-templates__refresh')!
    expect(btn.disabled).toBe(true) // loading === true while the initial listTemplates() is in-flight

    btn.click()
    await flushUi()
    expect(mocks.listTemplates).toHaveBeenCalledTimes(1) // native disabled (+ MtButton's own guard) blocks the click

    resolveList!({ templates: [] })
    await flushUi()
    expect(root.querySelector<HTMLButtonElement>('.multitable-templates__refresh')!.disabled).toBe(false)
  })

  it('retry: renders as a native <button> (MtButton, ghost) inside the error banner and clicking it re-invokes loadTemplates', async () => {
    mocks.listTemplates.mockRejectedValueOnce(new Error('boom'))
    const root = mountView()
    await flushUi()

    const retry = root.querySelector<HTMLButtonElement>('.multitable-templates__retry')!
    expect(retry.tagName).toBe('BUTTON')
    expect(retry.classList.contains('mt-button--ghost')).toBe(true)

    mocks.listTemplates.mockResolvedValueOnce({ templates: [] })
    retry.click()
    await flushUi()
    expect(mocks.listTemplates).toHaveBeenCalledTimes(2)
    expect(root.querySelector('.multitable-templates__error')).toBeNull()
  })

  it('category chips: "全部" + per-category siblings render as native <button> (MtButton, ghost, --active overlay class toggles with the selection)', async () => {
    mocks.listTemplates.mockResolvedValue({
      templates: [makeTemplate('a', 'Sales'), makeTemplate('b', 'Ops')],
    })
    const root = mountView()
    await flushUi()

    const chips = Array.from(root.querySelectorAll<HTMLButtonElement>('.multitable-templates__category-btn'))
    expect(chips).toHaveLength(3) // "全部" + Sales + Ops
    chips.forEach((chip) => {
      expect(chip.tagName).toBe('BUTTON')
      expect(chip.classList.contains('mt-button--ghost')).toBe(true)
    })

    const allChip = chips[0]
    expect(allChip.classList.contains('multitable-templates__category-btn--active')).toBe(true) // default selection

    const salesChip = root.querySelector<HTMLButtonElement>('[data-category-value="Sales"]')!
    expect(salesChip.classList.contains('multitable-templates__category-btn--active')).toBe(false)

    salesChip.click()
    await flushUi()

    expect(root.querySelector<HTMLButtonElement>('.multitable-templates__category-btn')!
      .classList.contains('multitable-templates__category-btn--active')).toBe(false) // "全部" no longer active
    expect(root.querySelector<HTMLButtonElement>('[data-category-value="Sales"]')!
      .classList.contains('multitable-templates__category-btn--active')).toBe(true) // Sales now active
    // Behavioral anchor: the filter actually narrowed the visible template count, same as pre-migration.
    expect(root.querySelector('.multitable-templates__stats')?.textContent).toContain('1')
  })
})
