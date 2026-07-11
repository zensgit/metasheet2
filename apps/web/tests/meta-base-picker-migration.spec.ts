import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaBasePicker from '../src/multitable/components/MetaBasePicker.vue'
import type { DecoratedBase } from '../src/multitable/utils/base-local-state'

// UI-P2-1c batch-3: MetaBasePicker's `meta-base-picker__create-btn` (its only sharer — the glyph-only "+"
// new-base button) is now <MtIconButton variant="primary">. The bespoke #409eff fill normalizes to
// --ms-color-primary (sanctioned token convergence); its bespoke CSS is removed (no double-styling, single
// sharer). The row-select favorite toggle (a domain ★/☆ control, aria-pressed state) stays untouched.
// Behavior-preservation proof: the button stays a native, keyboard-operable <button>; :disabled survives
// (empty new-base name); clicking it still emits `create` with the same trimmed name.

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('MetaBasePicker — MtIconButton migration (UI-P2-1c batch-3)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    useLocale().setLocale('en')
  })

  function mountPicker(options?: {
    bases?: DecoratedBase[]
    activeBaseId?: string
    onCreate?: (name: string) => void
    onToggleFavorite?: (baseId: string) => void
  }) {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(MetaBasePicker as Component, {
      bases: options?.bases ?? [
        { id: 'base_ops', name: 'Ops Base', isFavorite: false, lastOpenedAt: null },
      ],
      activeBaseId: options?.activeBaseId ?? 'base_ops',
      canCreate: true,
      onCreate: options?.onCreate,
      onToggleFavorite: options?.onToggleFavorite,
    })
    app.mount(container)
    return container
  }

  const createBtn = () => container!.querySelector('.meta-base-picker__create-btn') as HTMLButtonElement | null

  it('renders the create button as a native <button>, disabled until a name is typed', async () => {
    const root = mountPicker()
    await flushUi()
    root.querySelector<HTMLElement>('.meta-base-picker__current')?.click() // open = true
    await flushUi()

    expect(createBtn()).not.toBeNull()
    expect(createBtn()!.tagName).toBe('BUTTON') // keyboard-operable, not a bare div
    expect(createBtn()!.disabled).toBe(true) // :disabled="!newBaseName.trim()"
  })

  it('typing a name then clicking + still emits `create` with the same trimmed name (unchanged)', async () => {
    const onCreate = vi.fn()
    const root = mountPicker({ onCreate })
    await flushUi()
    root.querySelector<HTMLElement>('.meta-base-picker__current')?.click()
    await flushUi()

    const input = root.querySelector<HTMLInputElement>('.meta-base-picker__create-input')!
    input.value = '  New Base  '
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    expect(createBtn()!.disabled).toBe(false)
    createBtn()!.click() // onCreate() → emit('create', newBaseName.value.trim())
    await flushUi()

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith('New Base')
  })

  it('the favorite toggle (a domain control, not this migration) is untouched and unaffected', async () => {
    const onToggleFavorite = vi.fn()
    const root = mountPicker({
      bases: [{ id: 'base_ops', name: 'Ops Base', isFavorite: false, lastOpenedAt: null }],
      onToggleFavorite,
    })
    await flushUi()
    root.querySelector<HTMLElement>('.meta-base-picker__current')?.click()
    await flushUi()
    root.querySelector<HTMLButtonElement>('.meta-base-picker__favorite')?.click()
    await flushUi()
    expect(onToggleFavorite).toHaveBeenCalledWith('base_ops')
  })
})
