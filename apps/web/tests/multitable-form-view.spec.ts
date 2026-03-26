import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('MetaFormView attachment flow', () => {
  it('renders uploaded attachment summaries and submits attachment ids', async () => {
    const uploadFn = vi.fn().mockResolvedValue({
      id: 'att_brief',
      filename: 'brief.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      url: 'https://files.example.com/brief.pdf',
      thumbnailUrl: null,
      uploadedAt: '2026-03-25T01:00:00.000Z',
    })
    const submitSpy = vi.fn()

    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const record = ref({
          id: 'rec_1',
          version: 1,
          data: {
            fld_title: 'Draft',
            fld_files: [],
          },
        })
        return { record }
      },
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_files', name: 'Files', type: 'attachment' },
          ],
          record: this.record,
          loading: false,
          readOnly: false,
          uploadFn,
          onSubmit: submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    app.mount(container)

    const input = container.querySelector('.meta-form-view__file-input') as HTMLInputElement | null
    expect(input).toBeTruthy()
    const file = new File(['brief'], 'brief.pdf', { type: 'application/pdf' })
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
    expect(container.textContent).toContain('brief.pdf')

    const form = container.querySelector('form') as HTMLFormElement | null
    expect(form).toBeTruthy()
    form?.dispatchEvent(new Event('submit'))
    await flushUi()

    expect(submitSpy).toHaveBeenCalledWith({
      fld_title: 'Draft',
      fld_files: ['att_brief'],
    })

    app.unmount()
    container.remove()
  })
})
