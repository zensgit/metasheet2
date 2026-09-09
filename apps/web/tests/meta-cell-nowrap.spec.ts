import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, h, nextTick } from 'vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import type { MetaFieldType } from '../src/multitable/types'

const root = (...parts: string[]) => join(__dirname, '..', ...parts)

const ENGLISH_NOTES = 'Need the revised packing list before Friday so receiving can stage the inbound shipment.'

describe('grid notes / long-text single-line display', () => {
  it('locks nowrap + ellipsis on display cells and wrap on editing cells', () => {
    const grid = readFileSync(root('src/multitable/components/MetaGridTable.vue'), 'utf-8')
    expect(grid).toMatch(/\.meta-grid__cell \{[^}]*white-space:\s*nowrap/)
    expect(grid).toMatch(/\.meta-grid__cell \{[^}]*text-overflow:\s*ellipsis/)
    expect(grid).toMatch(/\.meta-grid__cell--editing \{[^}]*white-space:\s*normal/)
    const renderer = readFileSync(root('src/multitable/components/cells/MetaCellRenderer.vue'), 'utf-8')
    expect(renderer).toMatch(/\.meta-cell-renderer__long-text \{[\s\S]*white-space:\s*nowrap/)
    expect(renderer).toMatch(/\.meta-cell-renderer__long-text \{[\s\S]*text-overflow:\s*ellipsis/)
    expect(renderer).not.toMatch(/white-space:\s*pre-wrap/)
    const editor = readFileSync(root('src/multitable/components/cells/MetaCellEditor.vue'), 'utf-8')
    expect(editor).toMatch(/white-space:\s*pre-wrap/)
  })

  it('renders English sample notes as one line (newlines collapsed, no wrap markup)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaCellRenderer, {
          field: { id: 'fld_notes', name: 'Notes', type: 'longText' },
          value: `${ENGLISH_NOTES}\nCall the warehouse if the carton count changes.`,
        })
      },
    })
    app.mount(container)
    await nextTick()

    const value = container.querySelector('.meta-cell-renderer__long-text') as HTMLElement | null
    expect(value).not.toBeNull()
    expect(value?.querySelector('br')).toBeNull()
    expect(value?.textContent).toBe(
      `${ENGLISH_NOTES} Call the warehouse if the carton count changes.`,
    )
    expect(value?.textContent).not.toMatch(/\n/)
    expect(getComputedStyle(value!).whiteSpace).toBe('nowrap')

    app.unmount()
    container.remove()
  })

  it('treats leftover text-type notes the same as longText', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaCellRenderer, {
          field: { id: 'fld_notes', name: 'Notes', type: 'text' as MetaFieldType },
          value: 'First line\nSecond line',
        })
      },
    })
    app.mount(container)
    await nextTick()

    const value = container.querySelector('.meta-cell-renderer__long-text') as HTMLElement | null
    expect(value?.textContent).toBe('First line Second line')

    app.unmount()
    container.remove()
  })

  it('keeps the editor wrapping so notes can still be written on multiple lines', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_notes', name: 'Notes', type: 'longText' },
          modelValue: `${ENGLISH_NOTES}\nWarehouse`,
          recordId: 'rec_1',
          'onUpdate:modelValue': vi.fn(),
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })
    app.mount(container)
    await nextTick()

    const textarea = container.querySelector('textarea.meta-cell-editor__textarea') as HTMLTextAreaElement | null
    expect(textarea).not.toBeNull()
    expect(textarea?.value).toContain('\n')
    expect(getComputedStyle(textarea!).whiteSpace).toBe('pre-wrap')

    app.unmount()
    container.remove()
  })
})
