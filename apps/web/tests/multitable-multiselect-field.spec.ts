import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'

async function flushUi(cycles = 3) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('multiSelect field UI', () => {
  it('renders array values as select chips with option colors', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellRenderer, {
          field: {
            id: 'fld_tags',
            name: 'Tags',
            type: 'multiSelect',
            options: [
              { value: 'Urgent', color: '#f56c6c' },
              { value: 'VIP', color: '#409eff' },
            ],
          },
          value: ['Urgent', 'VIP'],
        })
      },
    })

    app.mount(container)
    await flushUi()

    const tags = Array.from(container.querySelectorAll('.meta-cell-renderer__tag'))
    expect(tags.map((tag) => tag.textContent)).toEqual(['Urgent', 'VIP'])

    app.unmount()
    container.remove()
  })

  it('uses a multiple select cell editor and emits selected values', async () => {
    const updateSpy = vi.fn()
    const confirmSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellEditor, {
          field: {
            id: 'fld_tags',
            name: 'Tags',
            type: 'multiSelect',
            options: [{ value: 'Urgent' }, { value: 'VIP' }, { value: 'Later' }],
          },
          modelValue: ['Urgent'],
          'onUpdate:modelValue': updateSpy,
          onConfirm: confirmSpy,
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const select = container.querySelector('select[multiple]') as HTMLSelectElement | null
    expect(select).not.toBeNull()
    for (const option of Array.from(select!.options)) {
      option.selected = option.value === 'Urgent' || option.value === 'VIP'
    }
    select!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    expect(updateSpy).toHaveBeenCalledWith(['Urgent', 'VIP'])
    select!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    await flushUi()
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    app.unmount()
    container.remove()
  })

  it('submits multiSelect arrays from form view', async () => {
    const submitSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            {
              id: 'fld_tags',
              name: 'Tags',
              type: 'multiSelect',
              options: [{ value: 'Urgent' }, { value: 'VIP' }],
            },
          ],
          record: { id: 'rec_1', version: 1, data: { fld_tags: ['Urgent'] } },
          loading: false,
          readOnly: false,
          onSubmit: submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const select = container.querySelector('#field_fld_tags') as HTMLSelectElement | null
    expect(select?.multiple).toBe(true)
    for (const option of Array.from(select!.options)) {
      option.selected = option.value === 'VIP'
    }
    select!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()

    expect(submitSpy).toHaveBeenCalledWith({ fld_tags: ['VIP'] })

    app.unmount()
    container.remove()
  })

  it('patches multiSelect arrays from the record drawer', async () => {
    const patchSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: { id: 'rec_1', version: 1, data: { fld_tags: ['Urgent'] } },
          fields: [{
            id: 'fld_tags',
            name: 'Tags',
            type: 'multiSelect',
            options: [{ value: 'Urgent' }, { value: 'VIP' }],
          }],
          canEdit: true,
          canComment: false,
          canDelete: false,
          onPatch: patchSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    const select = container.querySelector('#drawer_field_fld_tags') as HTMLSelectElement | null
    expect(select?.multiple).toBe(true)
    for (const option of Array.from(select!.options)) {
      option.selected = option.value === 'Urgent' || option.value === 'VIP'
    }
    select!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledWith('fld_tags', ['Urgent', 'VIP'])

    app.unmount()
    container.remove()
  })
})
