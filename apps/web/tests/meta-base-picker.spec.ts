import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaBasePicker from '../src/multitable/components/MetaBasePicker.vue'
import type { DecoratedBase } from '../src/multitable/utils/base-local-state'

async function flushUi(cycles = 3): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('MetaBasePicker', () => {
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
    onSelect?: (baseId: string) => void
    onToggleFavorite?: (baseId: string) => void
    onRename?: (baseId: string, name: string) => void
    canCreate?: boolean
    canManageFields?: boolean
  }) {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(MetaBasePicker as Component, {
      bases: options?.bases ?? [
        { id: 'base_sales', name: 'Sales Base', isFavorite: true, lastOpenedAt: null },
        { id: 'base_ops', name: 'Ops Base', isFavorite: false, lastOpenedAt: '2026-05-18T08:00:00.000Z' },
      ],
      activeBaseId: options?.activeBaseId ?? 'base_ops',
      canCreate: options?.canCreate,
      canManageFields: options?.canManageFields,
      onSelect: options?.onSelect,
      onToggleFavorite: options?.onToggleFavorite,
      onRename: options?.onRename,
    })
    app.mount(container)
    return container
  }

  it('renders decorated base badges in provided order', async () => {
    const root = mountPicker()
    await flushUi()

    root.querySelector<HTMLElement>('.meta-base-picker__current')?.click()
    await flushUi()

    const names = Array.from(root.querySelectorAll('.meta-base-picker__item-name'))
      .map((node) => node.textContent?.trim())
    expect(names).toEqual(['Sales Base', 'Ops Base'])
    expect(root.textContent).toContain('Favorite')
    expect(root.textContent).toContain('Recent')
    expect(root.textContent).not.toContain('收藏')
    expect(root.textContent).not.toContain('最近打开')
  })

  it('emits favorite toggles without selecting the base', async () => {
    const onSelect = vi.fn()
    const onToggleFavorite = vi.fn()
    const root = mountPicker({ onSelect, onToggleFavorite })
    await flushUi()

    root.querySelector<HTMLElement>('.meta-base-picker__current')?.click()
    await flushUi()

    root.querySelector<HTMLButtonElement>('[aria-label="Remove Sales Base from favorites"]')?.click()
    await flushUi()

    expect(onToggleFavorite).toHaveBeenCalledWith('base_sales')
    expect(onSelect).not.toHaveBeenCalled()

    root.querySelector<HTMLElement>('.meta-base-picker__item')?.click()
    await flushUi()

    expect(onSelect).toHaveBeenCalledWith('base_sales')
  })

  it('renders zh-CN picker chrome while preserving base names raw', async () => {
    useLocale().setLocale('zh-CN')
    const root = mountPicker({ canCreate: true })
    await flushUi()

    root.querySelector<HTMLElement>('.meta-base-picker__current')?.click()
    await flushUi()

    expect(root.querySelector<HTMLInputElement>('.meta-base-picker__search-input')?.getAttribute('placeholder')).toBe('搜索工作区...')
    expect(root.querySelector<HTMLInputElement>('.meta-base-picker__create-input')?.getAttribute('placeholder')).toBe('新工作区名称...')
    expect(root.textContent).toContain('Sales Base')
    expect(root.textContent).toContain('Ops Base')
    expect(root.textContent).toContain('收藏')
    expect(root.textContent).toContain('最近打开')
    expect(root.textContent).not.toContain('Favorite')
    expect(root.textContent).not.toContain('Recent')
    expect(root.querySelector<HTMLButtonElement>('[aria-label="取消收藏 Sales Base"]')).toBeTruthy()
  })

  it('localizes the empty and no-active-base states', async () => {
    useLocale().setLocale('zh-CN')
    const root = mountPicker({
      activeBaseId: 'missing',
      bases: [{ id: 'base_sales', name: 'Sales Base', isFavorite: false, lastOpenedAt: null }],
    })
    await flushUi()

    expect(root.querySelector('.meta-base-picker__name')?.textContent).toBe('选择工作区')

    root.querySelector<HTMLElement>('.meta-base-picker__current')?.click()
    await flushUi()

    const search = root.querySelector<HTMLInputElement>('.meta-base-picker__search-input')
    expect(search).toBeTruthy()
    search!.value = 'none'
    search!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    expect(root.textContent).toContain('未找到工作区')
    expect(root.textContent).not.toContain('No bases found')
  })

  // Rename affordance (feat/multitable-rename). Hiding is UX only: the server is the real
  // enforcement (PATCH /api/multitable/bases/:id gates on canManageFields).
  describe('rename affordance', () => {
    async function openPicker(root: HTMLElement): Promise<void> {
      root.querySelector<HTMLElement>('.meta-base-picker__current')?.click()
      await flushUi()
    }

    it('canManageFields=false (or absent) renders NO rename affordance at all', async () => {
      const rootAbsent = mountPicker({ canManageFields: undefined })
      await openPicker(rootAbsent)
      expect(rootAbsent.querySelector('[data-testid="base-picker-rename"]')).toBeNull()

      const rootFalse = mountPicker({ canManageFields: false })
      await openPicker(rootFalse)
      expect(rootFalse.querySelector('[data-testid="base-picker-rename"]')).toBeNull()
    })

    it('canManageFields=true renders one rename button per base', async () => {
      const root = mountPicker({ canManageFields: true })
      await openPicker(root)
      expect(root.querySelectorAll('[data-testid="base-picker-rename"]').length).toBe(2)
    })

    it('clicking rename swaps the row into an input and does NOT select the base', async () => {
      const onSelect = vi.fn()
      const root = mountPicker({ canManageFields: true, onSelect })
      await openPicker(root)

      const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-testid="base-picker-rename"]'))
      buttons[0].click() // Sales Base (first item)
      await flushUi()

      expect(onSelect).not.toHaveBeenCalled()
      const input = root.querySelector<HTMLInputElement>('[data-testid="base-picker-rename-input"]')
      expect(input).toBeTruthy()
      expect(input!.value).toBe('Sales Base')
    })

    it('confirming with Enter emits rename with the TRIMMED name, and does not select the base', async () => {
      const onSelect = vi.fn()
      const onToggleFavorite = vi.fn()
      const onRename = vi.fn()
      const root = mountPicker({ canManageFields: true, onSelect, onToggleFavorite, onRename })
      await openPicker(root)

      const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-testid="base-picker-rename"]'))
      buttons[0].click()
      await flushUi()

      const input = root.querySelector<HTMLInputElement>('[data-testid="base-picker-rename-input"]')!
      input.value = '  Sales Base Renamed  '
      input.dispatchEvent(new Event('input'))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await flushUi()

      expect(onRename).toHaveBeenCalledTimes(1)
      expect(onRename).toHaveBeenCalledWith('base_sales', 'Sales Base Renamed')
      expect(onSelect).not.toHaveBeenCalled()
      expect(onToggleFavorite).not.toHaveBeenCalled()
      expect(root.querySelector('[data-testid="base-picker-rename-input"]')).toBeNull()
    })

    it('confirming with an unchanged name does NOT emit rename', async () => {
      const onRename = vi.fn()
      const root = mountPicker({ canManageFields: true, onRename })
      await openPicker(root)

      const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-testid="base-picker-rename"]'))
      buttons[0].click()
      await flushUi()
      root.querySelector<HTMLButtonElement>('[data-testid="base-picker-rename-confirm"]')?.click()
      await flushUi()

      expect(onRename).not.toHaveBeenCalled()
    })

    it('a whitespace-only name disables the confirm button', async () => {
      const root = mountPicker({ canManageFields: true })
      await openPicker(root)

      root.querySelectorAll<HTMLButtonElement>('[data-testid="base-picker-rename"]')[0].click()
      await flushUi()
      const input = root.querySelector<HTMLInputElement>('[data-testid="base-picker-rename-input"]')!
      input.value = '   '
      input.dispatchEvent(new Event('input'))
      await flushUi()

      expect(root.querySelector<HTMLButtonElement>('[data-testid="base-picker-rename-confirm"]')?.disabled).toBe(true)
    })

    it('Escape cancels the rename without emitting', async () => {
      const onRename = vi.fn()
      const root = mountPicker({ canManageFields: true, onRename })
      await openPicker(root)

      root.querySelectorAll<HTMLButtonElement>('[data-testid="base-picker-rename"]')[0].click()
      await flushUi()
      const input = root.querySelector<HTMLInputElement>('[data-testid="base-picker-rename-input"]')!
      input.value = 'Should not be saved'
      input.dispatchEvent(new Event('input'))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await flushUi()

      expect(onRename).not.toHaveBeenCalled()
      expect(root.querySelector('[data-testid="base-picker-rename-input"]')).toBeNull()
    })

    it('the ✗ cancel button cancels without emitting', async () => {
      const onRename = vi.fn()
      const root = mountPicker({ canManageFields: true, onRename })
      await openPicker(root)

      root.querySelectorAll<HTMLButtonElement>('[data-testid="base-picker-rename"]')[0].click()
      await flushUi()
      root.querySelector<HTMLButtonElement>('[data-testid="base-picker-rename-cancel"]')?.click()
      await flushUi()

      expect(onRename).not.toHaveBeenCalled()
      expect(root.querySelector('[data-testid="base-picker-rename-input"]')).toBeNull()
    })
  })
})
