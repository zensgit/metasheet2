import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref, type App } from 'vue'

const useYjsCellBindingMock = vi.fn(() => ({
  active: ref(false),
  text: ref(''),
  setText: vi.fn(),
  collaborators: ref([]),
  release: vi.fn(),
}))

vi.mock('../src/multitable/composables/useYjsCellBinding', () => ({
  useYjsCellBinding: (...args: unknown[]) => useYjsCellBindingMock(...args),
}))

async function loadEditor() {
  return (await import('../src/multitable/components/cells/MetaCellEditor.vue')).default
}

describe('MetaCellEditor Yjs binding eligibility', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    useYjsCellBindingMock.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('does not construct a Yjs binding for non-string editors', async () => {
    const MetaCellEditor = await loadEditor()

    app = createApp(defineComponent({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_qty', name: 'Quantity', type: 'number' },
          modelValue: 12,
          recordId: 'rec_1',
          'onUpdate:modelValue': vi.fn(),
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    }))

    app.mount(container!)

    expect(useYjsCellBindingMock).not.toHaveBeenCalled()
  })

  it('constructs a Yjs binding for normal string editors with a record id', async () => {
    const MetaCellEditor = await loadEditor()

    app = createApp(defineComponent({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_title', name: 'Title', type: 'string' },
          modelValue: 'hello',
          recordId: 'rec_1',
          'onUpdate:modelValue': vi.fn(),
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    }))

    app.mount(container!)

    expect(useYjsCellBindingMock).toHaveBeenCalledTimes(1)
  })
})
