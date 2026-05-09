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
  it('renders longText as textarea and submits multiline values unchanged', async () => {
    const submitSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_notes', name: 'Notes', type: 'longText' },
          ],
          record: {
            id: 'rec_1',
            version: 1,
            data: {
              fld_notes: 'line 1',
            },
          },
          loading: false,
          readOnly: false,
          onSubmit: submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const textarea = container.querySelector('#field_fld_notes') as HTMLTextAreaElement | null
    expect(textarea).not.toBeNull()
    expect(textarea?.tagName).toBe('TEXTAREA')
    textarea!.value = 'line 1\nline 2\n'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    const form = container.querySelector('form') as HTMLFormElement | null
    form?.dispatchEvent(new Event('submit'))
    await flushUi()

    expect(submitSpy).toHaveBeenCalledWith({
      fld_notes: 'line 1\nline 2\n',
    })

    app.unmount()
    container.remove()
  })

  it('hides non-visible fields and disables read-only scoped fields', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_secret', name: 'Secret', type: 'string' },
          ],
          record: {
            id: 'rec_1',
            version: 1,
            data: {
              fld_title: 'Draft',
              fld_secret: 'Hidden',
            },
          },
          loading: false,
          readOnly: false,
          fieldPermissions: {
            fld_title: { visible: true, readOnly: true },
            fld_secret: { visible: false, readOnly: false },
          },
          onSubmit: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const titleInput = container.querySelector('#field_fld_title') as HTMLInputElement | null
    const secretInput = container.querySelector('#field_fld_secret') as HTMLInputElement | null

    expect(titleInput).not.toBeNull()
    expect(titleInput?.disabled).toBe(true)
    expect(secretInput).toBeNull()
    expect(container.textContent).not.toContain('Secret')

    app.unmount()
    container.remove()
  })

  it('omits readonly system fields from submit payloads', async () => {
    const submitSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_created_at', name: 'Created at', type: 'createdTime' },
          ],
          record: {
            id: 'rec_1',
            version: 1,
            data: {
              fld_title: 'Draft',
              fld_created_at: '2026-04-30T08:15:00.000Z',
            },
          },
          loading: false,
          readOnly: false,
          onSubmit: submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    expect(container.querySelector('#field_fld_created_at')).toBeNull()
    expect(container.textContent).toContain('2026')

    const titleInput = container.querySelector('#field_fld_title') as HTMLInputElement | null
    titleInput!.value = 'Revised'
    titleInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()

    expect(submitSpy).toHaveBeenCalledWith({
      fld_title: 'Revised',
    })

    app.unmount()
    container.remove()
  })

  it('emits dirty state while the form has unsaved edits', async () => {
    const dirtySpy = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
          ],
          record: {
            id: 'rec_1',
            version: 1,
            data: {
              fld_title: 'Draft',
            },
          },
          loading: false,
          readOnly: false,
          onSubmit: vi.fn(),
          onOpenLinkPicker: vi.fn(),
          'onUpdate:dirty': dirtySpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    expect(dirtySpy).toHaveBeenLastCalledWith(false)

    const input = container.querySelector('#field_fld_title') as HTMLInputElement | null
    input!.value = 'Revised'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    expect(dirtySpy).toHaveBeenLastCalledWith(true)

    const resetButton = container.querySelector('.meta-form-view__reset') as HTMLButtonElement | null
    resetButton?.click()
    await flushUi()

    expect(dirtySpy).toHaveBeenLastCalledWith(false)
    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved changes?')

    app.unmount()
    container.remove()
  })

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

  it('replaces an existing single attachment locally after upload succeeds', async () => {
    const uploadFn = vi.fn().mockResolvedValue({
      id: 'att_new',
      filename: 'replacement.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      url: 'https://files.example.com/replacement.pdf',
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
            fld_files: ['att_old'],
          },
        })
        return { record }
      },
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 1 } },
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
    const file = new File(['replacement'], 'replacement.pdf', { type: 'application/pdf' })
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

    expect(container.textContent).toContain('replacement.pdf')

    container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()

    expect(submitSpy).toHaveBeenCalledWith({
      fld_files: ['att_new'],
    })

    app.unmount()
    container.remove()
  })

  it('preserves uploaded attachment filenames across same-record hydration during multi-upload', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const record = ref({
          id: 'rec_1',
          version: 1,
          data: {
            fld_files: [],
          },
        })

        const uploadFn = vi.fn(async (file: File) => {
          if (file.name === 'beta.txt') {
            record.value = {
              id: 'rec_1',
              version: 2,
              data: {
                fld_files: ['att_alpha', 'att_beta'],
              },
            }
            await nextTick()
          }

          return {
            id: file.name === 'alpha.txt' ? 'att_alpha' : 'att_beta',
            filename: file.name,
            mimeType: 'text/plain',
            size: file.size,
            url: `https://files.example.com/${file.name}`,
            thumbnailUrl: null,
            uploadedAt: '2026-03-25T01:00:00.000Z',
          }
        })

        const submitSpy = vi.fn()
        return { record, uploadFn, submitSpy }
      },
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_files', name: 'Files', type: 'attachment' },
          ],
          record: this.record,
          loading: false,
          readOnly: false,
          uploadFn: this.uploadFn,
          onSubmit: this.submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    app.mount(container)

    const input = container.querySelector('.meta-form-view__file-input') as HTMLInputElement | null
    const alpha = new File(['alpha'], 'alpha.txt', { type: 'text/plain' })
    const beta = new File(['beta'], 'beta.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', {
      value: {
        0: alpha,
        1: beta,
        length: 2,
        item: (index: number) => (index === 0 ? alpha : index === 1 ? beta : null),
        [Symbol.iterator]: function* iterator() {
          yield alpha
          yield beta
        },
      },
      configurable: true,
    })
    input?.dispatchEvent(new Event('change'))
    await flushUi(6)

    const text = container.textContent ?? ''
    expect(text).toContain('alpha.txt')
    expect(text).toContain('beta.txt')
    expect(text).not.toContain('att_alpha')

    app.unmount()
    container.remove()
  })
})
