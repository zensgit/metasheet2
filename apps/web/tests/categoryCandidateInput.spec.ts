import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'

// approval-form-ux-slice1 (20260916 design §3) — CategoryCandidateInput's OWN contract, isolated
// from the two views that mount it (TemplateAuthoringView.vue, TemplateDetailView.vue; those two
// views' own specs cover the C3 raw-DOM-testid regression — see design §3.3-C3 — and are
// deliberately UNCHANGED by this slice, proving the swap kept that contract). This file covers
// what those specs cannot: that the candidates endpoint is actually called (C1), that the field
// stays fully free-text (allow-create, never a closed set), and that a broken/slow endpoint never
// blocks typing.
const listTemplateCategoriesSpy = vi.fn()
vi.mock('../src/approvals/api', () => ({
  listTemplateCategories: () => listTemplateCategoriesSpy(),
}))

import CategoryCandidateInput from '../src/approvals/components/CategoryCandidateInput.vue'

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('CategoryCandidateInput', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    listTemplateCategoriesSpy.mockReset()
    listTemplateCategoriesSpy.mockResolvedValue(['请假', '采购', '报销'])
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  // A real v-model round trip (not just an emit-capturing stub): `modelValue` is a live `ref` fed
  // back on every `update:modelValue`, exactly like `v-model="draft.category"` at the real call
  // sites. Several assertions below (filtering, allow-create) depend on the component actually
  // seeing what was typed on its next render, not a frozen initial prop.
  async function mountInput(initial = '', extraProps: Record<string, unknown> = {}) {
    const updates: string[] = []
    const value = ref(initial)
    const Host = defineComponent({
      setup() {
        return () =>
          h(CategoryCandidateInput, {
            'data-testid': 'category-input',
            modelValue: value.value,
            ...extraProps,
            'onUpdate:modelValue': (v: string) => {
              updates.push(v)
              value.value = v
            },
          })
      },
    })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
    return updates
  }

  function input(): HTMLInputElement {
    return container!.querySelector('[data-testid="category-input"]') as HTMLInputElement
  }

  // C1 — "两处输入均从端点取候选": the endpoint is actually hit on mount, not just wired-but-unused
  // (the exact gap design §3.1 identified: listTemplateCategories had zero callers before this
  // slice, and the two writer surfaces are the ONLY new call sites this component introduces).
  it('C1: fetches candidates from listTemplateCategories on mount', async () => {
    await mountInput('')
    expect(listTemplateCategoriesSpy).toHaveBeenCalledTimes(1)
  })

  it('C1: the testid resolves to a real native <input> (not a wrapper) — direct .value/.dispatchEvent still works', async () => {
    await mountInput('')
    const el = input()
    expect(el).toBeInstanceOf(HTMLInputElement)
    expect(el.tagName).toBe('INPUT')
  })

  it('renders fetched candidates in a dropdown on focus', async () => {
    const updates = await mountInput('')
    input().dispatchEvent(new Event('focus'))
    await flushUi()
    const items = Array.from(container!.querySelectorAll('[data-testid="category-candidate-list"] li'))
    expect(items.map((li) => li.textContent)).toEqual(['请假', '采购', '报销'])
    expect(updates).toEqual([]) // focus alone must not emit a value change
  })

  it('C1: clicking a candidate selects it (emits update:modelValue) and closes the dropdown', async () => {
    const updates = await mountInput('')
    input().dispatchEvent(new Event('focus'))
    await flushUi()
    const item = container!.querySelector('[data-testid="category-candidate-list"] li') as HTMLLIElement
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushUi()
    expect(updates).toEqual(['请假'])
    expect(container!.querySelector('[data-testid="category-candidate-list"]')).toBeNull()
  })

  // C1 — "输入不在候选内的值仍可保存": allow-create is the load-bearing requirement (design §3.2)
  // — this must NEVER degrade into a closed set. Typing an arbitrary value not in the fetched list
  // must emit it unchanged; nothing in this component may reject, clamp, or silently drop it.
  it('C1 / allow-create: typing a value NOT in the candidate list still emits it verbatim', async () => {
    const updates = await mountInput('')
    const el = input()
    el.value = '临时分组-xyz'
    el.dispatchEvent(new Event('input'))
    await flushUi()
    expect(updates).toEqual(['临时分组-xyz'])
  })

  it('filters the dropdown to candidates matching the current typed text (case-insensitive substring)', async () => {
    await mountInput('')
    const el = input()
    el.value = '采'
    el.dispatchEvent(new Event('input'))
    await flushUi()
    const items = Array.from(container!.querySelectorAll('[data-testid="category-candidate-list"] li'))
    expect(items.map((li) => li.textContent)).toEqual(['采购'])
  })

  // M4-adjacent positive control: a candidate list that legitimately returns zero matches for the
  // typed text must render NO dropdown at all — not an empty, inert `<ul>` (repo-wide "no
  // inert/empty control" convention).
  it('shows no dropdown when nothing matches the typed text', async () => {
    await mountInput('')
    const el = input()
    el.value = 'zzz-no-match'
    el.dispatchEvent(new Event('input'))
    await flushUi()
    expect(container!.querySelector('[data-testid="category-candidate-list"]')).toBeNull()
  })

  // Fail-soft (design doc comment in CategoryCandidateInput.vue): a broken/offline categories
  // endpoint must never block typing or saving an arbitrary category value.
  it('fail-soft: a rejected candidates fetch leaves the field fully usable with zero candidates', async () => {
    listTemplateCategoriesSpy.mockRejectedValueOnce(new Error('network down'))
    const updates = await mountInput('')
    const el = input()
    el.value = '差旅'
    el.dispatchEvent(new Event('input'))
    await flushUi()
    expect(updates).toEqual(['差旅'])
    input().dispatchEvent(new Event('focus'))
    await flushUi()
    expect(container!.querySelector('[data-testid="category-candidate-list"]')).toBeNull()
  })

  it('respects disabled and maxlength passthrough props', async () => {
    await mountInput('', { disabled: true, maxlength: 64 })
    const el = input()
    expect(el.disabled).toBe(true)
    expect(el.maxLength).toBe(64)
  })
})
