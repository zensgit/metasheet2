import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, withKeys, type App as VueApp } from 'vue'

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

  // C1 — "两处输入均从端点取候选": the endpoint is actually hit, not just wired-but-unused (the
  // exact gap design §3.1 identified: before this slice the two WRITER surfaces — this component's
  // two call sites — had zero callers of it; `TemplateCenterView.vue` was already a reader).
  //
  // Remedy round 3 (gate 2, P1-1): the fetch must be LAZY — first focus/open, never on mount. A
  // mount-time fetch reds the required `approval-browser-verify` Playwright lane, which mounts
  // production views without stubbing this endpoint. Two independently load-bearing pins:
  // reverting to a mount-time fetch reds the first (spy called with zero interaction); reverting to
  // no fetch at all reds the second (spy never called even after focus).
  it('C1: does NOT fetch candidates on mount', async () => {
    await mountInput('')
    expect(listTemplateCategoriesSpy).not.toHaveBeenCalled()
  })

  it('C1: fetches candidates from listTemplateCategories on first focus (not before)', async () => {
    await mountInput('')
    expect(listTemplateCategoriesSpy).not.toHaveBeenCalled()
    input().dispatchEvent(new Event('focus'))
    await flushUi()
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

  // Remedy round 4 (P2-B, owner review) — keyboard + combobox semantics, and the "parent-shortcut
  // isolation" problem: TemplateDetailView.vue wires `@keyup.enter="saveCategory"
  // @keyup.escape="cancelEditCategory"` directly onto <CategoryCandidateInput>. Because this
  // component declares `inheritAttrs: false` and forwards `$attrs` (everything but `class`) onto
  // its OWN inner <input> via `inputAttrs`, those two parent handlers land on the SAME native
  // <input> element as this component's own listeners: two `@keyup.x` bindings on one template
  // element compile to ONE `onKeyup` prop holding an ARRAY of handlers, and Vue's `mergeProps`
  // concatenates that array onto whatever this component's own `@keyup` binding already put there
  // — they are not two separate DOM listeners on two different elements, so ordinary
  // `stopPropagation()` (which only stops bubbling to ANCESTOR elements) cannot isolate one from
  // the other. `mountWithParentShortcuts` below reproduces that exact compiled shape with `withKeys`
  // (not `container.addEventListener`, which would exercise real DOM bubbling — a different code
  // path with different stopPropagation semantics) so these tests exercise the real mechanism.
  describe('P2-B: keyboard + combobox semantics', () => {
    function mountWithParentShortcuts(saveSpy: (e: Event) => void, cancelSpy: (e: Event) => void, initial = '') {
      return mountInput(initial, {
        onKeyup: [withKeys(saveSpy, ['enter']), withKeys(cancelSpy, ['escape'])],
      })
    }

    function fireKey(el: HTMLElement, type: 'keydown' | 'keyup', key: string): void {
      el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }))
    }

    it('(a) ArrowDown x2 + Enter selects the SECOND candidate, and the parent keyup.enter save shortcut is NOT invoked', async () => {
      const saveSpy = vi.fn()
      const cancelSpy = vi.fn()
      const updates = await mountWithParentShortcuts(saveSpy, cancelSpy)
      const el = input()

      fireKey(el, 'keydown', 'ArrowDown') // opens the list, kicks off the fetch, seeds index 0
      await flushUi()
      fireKey(el, 'keydown', 'ArrowDown') // candidates have resolved by now: index 0 -> 1 (second)
      await flushUi()
      fireKey(el, 'keydown', 'Enter')
      fireKey(el, 'keyup', 'Enter')
      await flushUi()

      expect(updates).toEqual(['采购']) // second of ['请假', '采购', '报销']
      expect(saveSpy).not.toHaveBeenCalled()
    })

    it('(b2) gate-4 P3-1: a consumed Enter whose keyup is LOST (blur before keyup) must not swallow the NEXT Enter once the list is closed', async () => {
      const saveSpy = vi.fn()
      const cancelSpy = vi.fn()
      await mountWithParentShortcuts(saveSpy, cancelSpy)
      const el = input()

      fireKey(el, 'keydown', 'ArrowDown') // opens the list, kicks off the fetch, seeds index 0
      await flushUi()
      fireKey(el, 'keydown', 'Enter') // consumed: selects candidate 0 and marks the Enter as consumed
      // The matching keyup never arrives: focus leaves mid-press. onBlur closes the list after 150ms.
      el.dispatchEvent(new Event('blur'))
      await new Promise((resolve) => setTimeout(resolve, 200))
      await flushUi()
      // No refocus on purpose: a `focus` would reopen the (cached) candidate list, and the point
      // under test is the CLOSED-list pass-through — the stale consumption marker must not
      // swallow this fresh Enter's keyup.
      fireKey(el, 'keydown', 'Enter')
      fireKey(el, 'keyup', 'Enter')
      await flushUi()

      expect(saveSpy).toHaveBeenCalledTimes(1)
    })

    it('(b) positive control: Enter with the list CLOSED still reaches the parent keyup.enter save shortcut', async () => {
      const saveSpy = vi.fn()
      const cancelSpy = vi.fn()
      await mountWithParentShortcuts(saveSpy, cancelSpy)
      const el = input()

      fireKey(el, 'keydown', 'Enter')
      fireKey(el, 'keyup', 'Enter')
      await flushUi()

      expect(saveSpy).toHaveBeenCalledTimes(1)
    })

    it('(c) Escape with the list open closes it, and the parent keyup.escape cancel shortcut is NOT invoked', async () => {
      const saveSpy = vi.fn()
      const cancelSpy = vi.fn()
      await mountWithParentShortcuts(saveSpy, cancelSpy)
      const el = input()

      el.dispatchEvent(new Event('focus'))
      await flushUi()
      expect(container!.querySelector('[data-testid="category-candidate-list"]')).not.toBeNull()

      fireKey(el, 'keydown', 'Escape')
      fireKey(el, 'keyup', 'Escape')
      await flushUi()

      expect(container!.querySelector('[data-testid="category-candidate-list"]')).toBeNull()
      expect(cancelSpy).not.toHaveBeenCalled()
    })

    it('(d) positive control: Escape with the list CLOSED still reaches the parent keyup.escape cancel shortcut', async () => {
      const saveSpy = vi.fn()
      const cancelSpy = vi.fn()
      await mountWithParentShortcuts(saveSpy, cancelSpy)
      const el = input()

      fireKey(el, 'keydown', 'Escape')
      fireKey(el, 'keyup', 'Escape')
      await flushUi()

      expect(cancelSpy).toHaveBeenCalledTimes(1)
    })

    // Advisor-flagged gap in (c)/(d) as originally scoped: `open` alone is not "the list is
    // visible" — it goes true on plain focus, before anything has matched. Gating Escape-consume on
    // `open` (instead of `listboxVisible`) would let a focused-but-empty-match field swallow Escape
    // and never reach the parent's cancel shortcut.
    it('Escape reaches the parent cancel shortcut when focused but the list has no match (nothing visibly open)', async () => {
      const saveSpy = vi.fn()
      const cancelSpy = vi.fn()
      await mountWithParentShortcuts(saveSpy, cancelSpy, 'zzz-no-match')
      const el = input()

      el.dispatchEvent(new Event('focus'))
      await flushUi()
      expect(container!.querySelector('[data-testid="category-candidate-list"]')).toBeNull()

      fireKey(el, 'keydown', 'Escape')
      fireKey(el, 'keyup', 'Escape')
      await flushUi()

      expect(cancelSpy).toHaveBeenCalledTimes(1)
    })

    it('(e) ARIA: combobox/listbox/option attributes reflect open state and the active item, absent when none', async () => {
      await mountInput('')
      const el = input()
      expect(el.getAttribute('role')).toBe('combobox')
      expect(el.getAttribute('aria-autocomplete')).toBe('list')
      expect(el.getAttribute('aria-expanded')).toBe('false')
      expect(el.hasAttribute('aria-activedescendant')).toBe(false)
      const listboxId = el.getAttribute('aria-controls')
      expect(listboxId).toBeTruthy()

      fireKey(el, 'keydown', 'ArrowDown')
      await flushUi()
      fireKey(el, 'keydown', 'ArrowDown') // now on the second candidate
      await flushUi()

      expect(el.getAttribute('aria-expanded')).toBe('true')
      const list = container!.querySelector('[data-testid="category-candidate-list"]') as HTMLUListElement
      expect(list.getAttribute('role')).toBe('listbox')
      expect(list.id).toBe(listboxId)
      const options = Array.from(list.querySelectorAll('li'))
      expect(options.every((o) => o.getAttribute('role') === 'option')).toBe(true)
      expect(options[0].getAttribute('aria-selected')).toBe('false')
      expect(options[1].getAttribute('aria-selected')).toBe('true')
      expect(el.getAttribute('aria-activedescendant')).toBe(options[1].id)

      // Selecting closes the list — aria-activedescendant must go back to absent, not merely empty.
      options[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await flushUi()
      expect(el.getAttribute('aria-expanded')).toBe('false')
      expect(el.hasAttribute('aria-activedescendant')).toBe(false)
    })

    it('(f) mouse selection still works alongside the new keyboard wiring (regression, mirrors the existing C1 click test)', async () => {
      const saveSpy = vi.fn()
      const cancelSpy = vi.fn()
      const updates = await mountWithParentShortcuts(saveSpy, cancelSpy)
      const el = input()
      el.dispatchEvent(new Event('focus'))
      await flushUi()
      const item = container!.querySelector('[data-testid="category-candidate-list"] li') as HTMLLIElement
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await flushUi()
      expect(updates).toEqual(['请假'])
      expect(container!.querySelector('[data-testid="category-candidate-list"]')).toBeNull()
    })

    it('ArrowUp does nothing while the list is closed (only ArrowDown opens it)', async () => {
      await mountInput('')
      const el = input()
      fireKey(el, 'keydown', 'ArrowUp')
      await flushUi()
      expect(listTemplateCategoriesSpy).not.toHaveBeenCalled()
      expect(container!.querySelector('[data-testid="category-candidate-list"]')).toBeNull()
    })

    it('ArrowDown/ArrowUp wrap at both ends of the visible candidate list', async () => {
      await mountInput('')
      const el = input()
      fireKey(el, 'keydown', 'ArrowDown')
      await flushUi() // index 0 (请假)
      fireKey(el, 'keydown', 'ArrowUp')
      await flushUi() // wraps to the LAST candidate (报销), index 2
      const list = container!.querySelector('[data-testid="category-candidate-list"]') as HTMLUListElement
      const options = Array.from(list.querySelectorAll('li'))
      expect(options[2].getAttribute('aria-selected')).toBe('true')
    })

    // Advisor review: the active item is tracked by VALUE (`activeCandidateValue`, re-resolved by
    // `indexOf` against the CURRENT list on every read), not by a raw numeric index re-applied
    // against a possibly-different-shaped LATER list. This is the genuinely discriminating
    // repro: an EXTERNAL `v-model` write (bypassing this component's own `onInput` — which already
    // resets on every keystroke the user types through the field itself, so ordinary typing is safe
    // under either design) changes which candidates match while an index is already active. Filter
    // narrowing only ever REMOVES entries (never reorders — `candidates` is fetched once and never
    // reshuffled), so with 5 candidates and the active one sitting at position 2, narrowing to 4
    // OTHER matching candidates leaves position 2 of the NEW list occupied by a candidate the user
    // never navigated to. A raw stored index would silently relabel that different candidate as
    // active; this component must not. NOT reachable from the two real call sites today (neither
    // reassigns its `v-model` while this field is open — see the design's own file doc comment) —
    // this locks the underlying mechanism directly rather than relying on that being permanently
    // true. This is genuinely a different code path than the isolated Host's normal `mountInput`
    // (which only ever writes `modelValue` back FROM the component's own `update:modelValue` emit),
    // so it mounts its own Host that exposes the ref for a direct EXTERNAL write.
    it('an EXTERNAL v-model write that shrinks the list (bypassing onInput) drops a now-absent active item — never relabels a different one at the same index', async () => {
      listTemplateCategoriesSpy.mockReset().mockResolvedValue(['出差1', '出差2', '报销', '出差3', '出差4'])
      const externalValue = ref('')
      const Host = defineComponent({
        setup() {
          return () =>
            h(CategoryCandidateInput, {
              'data-testid': 'category-input',
              modelValue: externalValue.value,
              'onUpdate:modelValue': (v: string) => {
                externalValue.value = v
              },
            })
        },
      })
      app = createApp(Host)
      app.mount(container!)
      await flushUi()
      const el = input()

      fireKey(el, 'keydown', 'ArrowDown')
      await flushUi()
      fireKey(el, 'keydown', 'ArrowDown')
      await flushUi()
      fireKey(el, 'keydown', 'ArrowDown')
      await flushUi() // index 2 of the unfiltered 5-item list: '报销'
      let list = container!.querySelector('[data-testid="category-candidate-list"]') as HTMLUListElement
      expect(Array.from(list.querySelectorAll('li'))[2].textContent).toBe('报销')
      expect(Array.from(list.querySelectorAll('li'))[2].getAttribute('aria-selected')).toBe('true')

      // EXTERNAL write — not through this component's own onInput — to a query matching the four
      // '出差N' candidates and excluding '报销'. Position 2 of the NEW filtered list is '出差3', a
      // candidate the user never navigated to.
      externalValue.value = '出差'
      await flushUi()

      list = container!.querySelector('[data-testid="category-candidate-list"]') as HTMLUListElement
      const options = Array.from(list.querySelectorAll('li'))
      expect(options.map((o) => o.textContent)).toEqual(['出差1', '出差2', '出差3', '出差4'])
      expect(options.every((o) => o.getAttribute('aria-selected') === 'false')).toBe(true)
      expect(el.hasAttribute('aria-activedescendant')).toBe(false)
    })
  })

  // Advisor review, bug fix: a plain `let instanceSeq = 0` written directly inside `<script setup>`
  // re-initializes to 0 on EVERY component instance (it compiles into the per-instance `setup()`
  // function body, not module scope) — so two mounted fields would both compute the SAME `uid` and
  // collide on `id`/`aria-controls`/`aria-activedescendant`. Mounts two instances side by side and
  // asserts their `aria-controls` targets differ.
  it('two mounted instances never collide on id/aria-controls (module-scope instance counter)', async () => {
    const containerB = document.createElement('div')
    document.body.appendChild(containerB)
    const appB = createApp(
      defineComponent({
        setup() {
          const value = ref('')
          return () =>
            h(CategoryCandidateInput, {
              'data-testid': 'category-input-b',
              modelValue: value.value,
              'onUpdate:modelValue': (v: string) => {
                value.value = v
              },
            })
        },
      }),
    )
    appB.mount(containerB)
    await flushUi()
    try {
      await mountInput('') // instance A, uses this describe's own `container`/`app`
      const elA = input()
      const elB = containerB.querySelector('[data-testid="category-input-b"]') as HTMLInputElement
      expect(elA.getAttribute('aria-controls')).toBeTruthy()
      expect(elB.getAttribute('aria-controls')).toBeTruthy()
      expect(elA.getAttribute('aria-controls')).not.toBe(elB.getAttribute('aria-controls'))
    } finally {
      appB.unmount()
      containerB.remove()
    }
  })
})
