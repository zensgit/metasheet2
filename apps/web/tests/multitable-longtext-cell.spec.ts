import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'

describe('longText cells', () => {
  it('renders multiline values with the long-text renderer class', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellRenderer, {
          field: { id: 'fld_notes', name: 'Notes', type: 'longText' },
          value: 'line 1\nline 2',
        })
      },
    })

    app.mount(container)
    await nextTick()

    const value = container.querySelector('.meta-cell-renderer__long-text') as HTMLElement | null
    expect(value).not.toBeNull()
    expect(value?.textContent).toBe('line 1\nline 2')

    app.unmount()
    container.remove()
  })

  it('uses a textarea editor and confirms with Ctrl+Enter', async () => {
    const updateSpy = vi.fn()
    const confirmSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_notes', name: 'Notes', type: 'longText' },
          modelValue: 'line 1',
          recordId: 'rec_1',
          'onUpdate:modelValue': updateSpy,
          onConfirm: confirmSpy,
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await nextTick()

    const textarea = container.querySelector('textarea.meta-cell-editor__textarea') as HTMLTextAreaElement | null
    expect(textarea).not.toBeNull()
    textarea!.value = 'line 1\nline 2\n'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('line 1\nline 2\n')
    textarea!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
    }))
    await nextTick()

    expect(confirmSpy).toHaveBeenCalledTimes(1)

    app.unmount()
    container.remove()
  })
})
