import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('MetaCellEditor attachment flow', () => {
  it('uploads files through uploadFn and emits attachment ids', async () => {
    const uploadFn = vi.fn().mockResolvedValue({
      id: 'att_specs',
      filename: 'specs.pdf',
      mimeType: 'application/pdf',
      size: 512,
      url: 'https://files.example.com/specs.pdf',
      thumbnailUrl: null,
      uploadedAt: '2026-03-25T00:00:00.000Z',
    })
    const updateSpy = vi.fn()
    const confirmSpy = vi.fn()

    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const modelValue = ref<unknown>(['att_existing'])
        return { modelValue }
      },
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_files', name: 'Files', type: 'attachment' },
          modelValue: this.modelValue,
          uploadFn,
          uploadContext: { recordId: 'rec_1' },
          'onUpdate:modelValue': (value: unknown) => {
            this.modelValue = value
            updateSpy(value)
          },
          onConfirm: confirmSpy,
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    app.mount(container)

    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null
    expect(input).toBeTruthy()
    const file = new File(['pdf'], 'specs.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', {
      value: {
        0: file,
        length: 1,
        item: (index: number) => (index === 0 ? file : null),
        [Symbol.iterator]: function* iterator() {
          yield file
        },
      },
      configurable: true,
    })
    input?.dispatchEvent(new Event('change'))
    await flushUi()

    expect(uploadFn).toHaveBeenCalledWith(file, {
      recordId: 'rec_1',
      fieldId: 'fld_files',
    })
    expect(updateSpy).toHaveBeenCalledWith(['att_existing', 'att_specs'])
    expect(confirmSpy).toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('removes and clears attachments through deleteAttachmentFn', async () => {
    const deleteAttachmentFn = vi.fn().mockResolvedValue(undefined)
    const updateSpy = vi.fn()
    const confirmSpy = vi.fn()

    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const modelValue = ref<unknown>(['att_a', 'att_b'])
        return { modelValue }
      },
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_files', name: 'Files', type: 'attachment' },
          modelValue: this.modelValue,
          deleteAttachmentFn,
          attachmentSummaries: [
            {
              id: 'att_a',
              filename: 'a.pdf',
              mimeType: 'application/pdf',
              size: 100,
              url: '/api/multitable/attachments/att_a',
              thumbnailUrl: null,
              uploadedAt: '2026-03-25T00:00:00.000Z',
            },
            {
              id: 'att_b',
              filename: 'b.pdf',
              mimeType: 'application/pdf',
              size: 120,
              url: '/api/multitable/attachments/att_b',
              thumbnailUrl: null,
              uploadedAt: '2026-03-25T00:01:00.000Z',
            },
          ],
          uploadContext: { recordId: 'rec_1' },
          'onUpdate:modelValue': (value: unknown) => {
            this.modelValue = value
            updateSpy(value)
          },
          onConfirm: confirmSpy,
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    app.mount(container)
    await flushUi()

    const removeButtons = Array.from(container.querySelectorAll('.meta-attachment-list__remove')) as HTMLButtonElement[]
    removeButtons[0]?.click()
    await flushUi()

    expect(deleteAttachmentFn).toHaveBeenCalledWith('att_a', {
      recordId: 'rec_1',
      fieldId: 'fld_files',
    })
    expect(updateSpy).toHaveBeenCalledWith(['att_b'])

    ;(container.querySelector('.meta-cell-editor__clear-btn') as HTMLButtonElement | null)?.click()
    await flushUi()

    expect(deleteAttachmentFn).toHaveBeenCalledWith('att_b', {
      recordId: 'rec_1',
      fieldId: 'fld_files',
    })
    expect(updateSpy).toHaveBeenLastCalledWith([])
    expect(confirmSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('replaces an existing single attachment after uploading the new file', async () => {
    const uploadFn = vi.fn().mockResolvedValue({
      id: 'att_new',
      filename: 'replacement.pdf',
      mimeType: 'application/pdf',
      size: 512,
      url: 'https://files.example.com/replacement.pdf',
      thumbnailUrl: null,
      uploadedAt: '2026-03-25T00:00:00.000Z',
    })
    const updateSpy = vi.fn()

    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const modelValue = ref<unknown>(['att_old'])
        return { modelValue }
      },
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 1 } },
          modelValue: this.modelValue,
          uploadFn,
          uploadContext: { recordId: 'rec_1' },
          'onUpdate:modelValue': (value: unknown) => {
            this.modelValue = value
            updateSpy(value)
          },
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    app.mount(container)

    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null
    const file = new File(['pdf'], 'replacement.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', {
      value: {
        0: file,
        length: 1,
        item: (index: number) => (index === 0 ? file : null),
        [Symbol.iterator]: function* iterator() {
          yield file
        },
      },
      configurable: true,
    })
    input?.dispatchEvent(new Event('change'))
    await flushUi()

    expect(updateSpy).toHaveBeenCalledWith(['att_new'])

    app.unmount()
    container.remove()
  })
})
