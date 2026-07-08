import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaHierarchyView from '../src/multitable/components/MetaHierarchyView.vue'
import type { MetaField } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaHierarchyView's toolbar "Add root" control was migrated from a bespoke <button> to the
// shared MtButton primitive (variant="primary"; the bespoke #2563eb == --ms-color-primary). Its class is
// unique, so the bespoke hex CSS was removed. The h()-rendered per-node controls (toggle/child-add/comment)
// stay bespoke. Behavior-preservation proof: it stays a native, keyboard-operable <button> gated by
// canCreate; clicking it still emits `create-record` with the SAME `{}` payload.

const fields: MetaField[] = [
  { id: 'fld_title', name: 'Title', type: 'string' },
  { id: 'fld_parent', name: 'Parent', type: 'link' },
]

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-hierarchy').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaHierarchyView, { fields, loading: false, rows: [], ...props }) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const addRoot = (r: HTMLElement) => r.querySelector('.meta-hierarchy__create') as HTMLButtonElement | null

describe('MetaHierarchyView — MtButton migration (UI-P2-1c)', () => {
  it('renders Add-root as a native <button> only when canCreate', () => {
    expect(addRoot(mount({ canCreate: false }))).toBeNull() // v-if="canCreate" preserved
    const root = mount({ canCreate: true })
    expect(addRoot(root)!.tagName).toBe('BUTTON') // keyboard-operable, not a bare div
  })

  it('clicking Add-root emits `create-record` with {} (unchanged)', () => {
    const onCreateRecord = vi.fn()
    const root = mount({ canCreate: true, onCreateRecord })
    addRoot(root)!.click()
    expect(onCreateRecord).toHaveBeenCalledTimes(1)
    expect(onCreateRecord).toHaveBeenCalledWith({})
  })
})
