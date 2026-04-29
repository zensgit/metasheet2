import { createApp, h, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import MetaHierarchyView from '../src/multitable/components/MetaHierarchyView.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'

const fields: MetaField[] = [
  { id: 'fld_title', name: 'Title', type: 'string' },
  { id: 'fld_parent', name: 'Parent', type: 'link' },
]

function mountHierarchy(props: {
  rows: MetaRecord[]
  viewConfig?: Record<string, unknown>
  canCreate?: boolean
  canComment?: boolean
  onSelectRecord?: (recordId: string) => void
  onOpenComments?: (recordId: string) => void
  onCreateRecord?: (data: Record<string, unknown>) => void
  onUpdateViewConfig?: (input: { config: Record<string, unknown> }) => void
}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaHierarchyView, {
        fields,
        loading: false,
        ...props,
      })
    },
  })
  app.mount(container)
  return {
    container,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

describe('MetaHierarchyView', () => {
  it('builds a tree from rows and the first parent link id', async () => {
    const selectSpy = vi.fn()
    const createSpy = vi.fn()
    const { container, unmount } = mountHierarchy({
      rows: [
        { id: 'rec_root', version: 1, data: { fld_title: 'Root' } },
        { id: 'rec_child', version: 1, data: { fld_title: 'Child', fld_parent: ['rec_root', 'ignored_parent'] } },
      ],
      viewConfig: { parentFieldId: 'fld_parent', titleFieldId: 'fld_title', defaultExpandDepth: 2 },
      canCreate: true,
      onSelectRecord: selectSpy,
      onCreateRecord: createSpy,
    })
    await nextTick()

    expect(container.textContent).toContain('Root')
    expect(container.textContent).toContain('Child')

    ;(Array.from(container.querySelectorAll('.meta-hierarchy__title')) as HTMLButtonElement[])
      .find((button) => button.textContent === 'Child')
      ?.click()
    await nextTick()
    expect(selectSpy).toHaveBeenCalledWith('rec_child')

    ;(Array.from(container.querySelectorAll('.meta-hierarchy__child-btn')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Child'))
      ?.click()
    await nextTick()
    expect(createSpy).toHaveBeenCalledWith({ fld_parent: ['rec_root'] })

    unmount()
  })

  it('falls back for missing parents and cycles on the client', async () => {
    const { container, unmount } = mountHierarchy({
      rows: [
        { id: 'rec_orphan', version: 1, data: { fld_title: 'Orphan', fld_parent: ['missing'] } },
        { id: 'rec_cycle_a', version: 1, data: { fld_title: 'Cycle A', fld_parent: ['rec_cycle_b'] } },
        { id: 'rec_cycle_b', version: 1, data: { fld_title: 'Cycle B', fld_parent: ['rec_cycle_a'] } },
      ],
      viewConfig: { parentFieldId: 'fld_parent', titleFieldId: 'fld_title', orphanMode: 'root' },
    })
    await nextTick()

    expect(container.textContent).toContain('Orphan')
    expect(container.textContent).toContain('Cycle A')
    expect(container.textContent).toContain('Cycle B')
    expect(container.textContent).toContain('1 orphan record shown at root.')
    expect(container.textContent).toContain('2 cyclic records detached to root.')

    unmount()
  })

  it('emits hierarchy config updates from inline controls', async () => {
    const updateSpy = vi.fn()
    const { container, unmount } = mountHierarchy({
      rows: [],
      viewConfig: { parentFieldId: 'fld_parent', titleFieldId: 'fld_title', defaultExpandDepth: 2, orphanMode: 'root' },
      onUpdateViewConfig: updateSpy,
    })
    await nextTick()

    const orphanSelect = Array.from(container.querySelectorAll('.meta-hierarchy__control select'))[2] as HTMLSelectElement
    orphanSelect.value = 'hidden'
    orphanSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith({
      config: {
        parentFieldId: 'fld_parent',
        titleFieldId: 'fld_title',
        defaultExpandDepth: 2,
        orphanMode: 'hidden',
      },
    })

    unmount()
  })
})
