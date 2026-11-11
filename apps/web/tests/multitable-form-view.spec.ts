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

// --- attachment writes stay with the record they started on ---
describe('MetaFormView attachment record binding', () => {
  const FIELDS = [
    { id: 'fld_title', name: 'Title', type: 'string' },
    { id: 'fld_files', name: 'Files', type: 'attachment' },
  ]
  const REC_A = () => ({ id: 'rec_A', version: 1, data: { fld_title: 'Alpha', fld_files: ['att_a1', 'att_a2'] } })
  const REC_B = () => ({ id: 'rec_B', version: 1, data: { fld_title: 'Beta', fld_files: ['att_b1'] } })

  function attachment(id: string, filename: string) {
    return {
      id,
      filename,
      mimeType: 'application/pdf',
      size: 1024,
      url: `https://files.example.com/${filename}`,
      thumbnailUrl: null,
      uploadedAt: '2026-03-25T01:00:00.000Z',
    }
  }

  function deferred<T = void>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  // Each call to the returned fn waits on its own deferred, kept in `pending` in call order.
  function deferredFn<T = void>() {
    const pending: Array<ReturnType<typeof deferred<T>>> = []
    const fn = vi.fn(() => {
      const next = deferred<T>()
      pending.push(next)
      return next.promise
    })
    return { fn, pending }
  }

  function mountForm(options: {
    record: Record<string, unknown> | null
    uploadFn?: unknown
    deleteAttachmentFn?: unknown
  }) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const record = ref(options.record)
    const initialValues = ref<Record<string, unknown> | null>(null)
    const submitSpy = vi.fn()
    const Harness = defineComponent({
      render() {
        return h(MetaFormView, {
          fields: FIELDS,
          record: record.value,
          initialValues: initialValues.value,
          loading: false,
          readOnly: false,
          uploadFn: options.uploadFn,
          deleteAttachmentFn: options.deleteAttachmentFn,
          onSubmit: submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })
    const app = createApp(Harness)
    app.mount(container)
    return {
      container,
      record,
      initialValues,
      submitSpy,
      fileInput: () => container.querySelector('.meta-form-view__file-input') as HTMLInputElement,
      unmount() {
        app.unmount()
        container.remove()
      },
    }
  }

  function pickFiles(input: HTMLInputElement, files: File[]) {
    Object.defineProperty(input, 'files', {
      value: {
        ...files,
        length: files.length,
        item: (index: number) => files[index] ?? null,
        [Symbol.iterator]: function* iterator() {
          yield* files
        },
      },
      configurable: true,
    })
    input.dispatchEvent(new Event('change'))
  }

  // What the form would submit right now.
  async function submitted(view: ReturnType<typeof mountForm>) {
    view.submitSpy.mockClear()
    view.container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()
    expect(view.submitSpy).toHaveBeenCalledTimes(1)
    return view.submitSpy.mock.calls[0][0]
  }

  const fieldError = (view: ReturnType<typeof mountForm>) =>
    view.container.querySelector('.meta-form-view__attachment-field .meta-form-view__field-error')

  it('keeps an upload that ends after the form moved to another record out of that record\'s form', async () => {
    const upload = deferredFn<ReturnType<typeof attachment>>()
    const view = mountForm({ record: REC_A(), uploadFn: upload.fn })
    const file = new File(['new'], 'new.pdf', { type: 'application/pdf' })

    pickFiles(view.fileInput(), [file])
    await flushUi()
    view.record.value = REC_B()
    await flushUi()
    upload.pending[0].resolve(attachment('att_new', 'new.pdf'))
    await flushUi()

    // The upload was A's; B's form keeps B's own list and does not show A's file.
    expect(upload.fn).toHaveBeenCalledWith(file, { recordId: 'rec_A', fieldId: 'fld_files' })
    expect(view.container.textContent).not.toContain('new.pdf')
    expect(await submitted(view)).toEqual({ fld_title: 'Beta', fld_files: ['att_b1'] })

    view.unmount()
  })

  it('sends every file of a multi-file upload to the record it started on', async () => {
    const upload = deferredFn<ReturnType<typeof attachment>>()
    const view = mountForm({ record: REC_A(), uploadFn: upload.fn })
    const one = new File(['one'], 'one.pdf', { type: 'application/pdf' })
    const two = new File(['two'], 'two.pdf', { type: 'application/pdf' })

    pickFiles(view.fileInput(), [one, two])
    await flushUi()
    view.record.value = REC_B()
    await flushUi()
    upload.pending[0].resolve(attachment('att_one', 'one.pdf'))
    await flushUi()

    // The second file is still uploaded to A, not to the record now shown.
    expect(upload.fn).toHaveBeenCalledTimes(2)
    expect(upload.fn.mock.calls[1]).toEqual([two, { recordId: 'rec_A', fieldId: 'fld_files' }])

    upload.pending[1].resolve(attachment('att_two', 'two.pdf'))
    await flushUi()
    expect(await submitted(view)).toEqual({ fld_title: 'Beta', fld_files: ['att_b1'] })

    view.unmount()
  })

  it('deletes every attachment of a clear-all from the record it started on and leaves the next record\'s list alone', async () => {
    const remove = deferredFn()
    const view = mountForm({ record: REC_A(), deleteAttachmentFn: remove.fn })

    ;(view.container.querySelector('.meta-form-view__attachment-clear') as HTMLButtonElement).click()
    await flushUi()
    view.record.value = REC_B()
    await flushUi()
    remove.pending[0].resolve()
    await flushUi()

    // The second delete still names A.
    expect(remove.fn).toHaveBeenCalledTimes(2)
    expect(remove.fn.mock.calls[1]).toEqual(['att_a2', { recordId: 'rec_A', fieldId: 'fld_files' }])

    remove.pending[1].resolve()
    await flushUi()
    // B's list is not emptied by A's clear.
    expect(view.container.querySelector('.meta-form-view__attachment-clear')).not.toBeNull()
    expect(await submitted(view)).toEqual({ fld_title: 'Beta', fld_files: ['att_b1'] })

    view.unmount()
  })

  it('leaves the next record\'s form data alone when a remove ends after the switch', async () => {
    const remove = deferredFn()
    const view = mountForm({ record: REC_A(), deleteAttachmentFn: remove.fn })

    ;(view.container.querySelector('.meta-attachment-list__remove') as HTMLButtonElement).click()
    await flushUi()
    // B has never had a value for the field, so any write to it shows up in the payload.
    view.record.value = { id: 'rec_B', version: 1, data: { fld_title: 'Beta' } }
    await flushUi()
    remove.pending[0].resolve()
    await flushUi()

    expect(remove.fn).toHaveBeenCalledWith('att_a1', { recordId: 'rec_A', fieldId: 'fld_files' })
    expect(await submitted(view)).toEqual({ fld_title: 'Beta' })
    expect(view.submitSpy.mock.calls[0][0]).not.toHaveProperty('fld_files')

    view.unmount()
  })

  it('keeps the next record\'s own upload shown as uploading when the earlier record\'s upload ends', async () => {
    const upload = deferredFn<ReturnType<typeof attachment>>()
    const view = mountForm({ record: REC_A(), uploadFn: upload.fn })

    pickFiles(view.fileInput(), [new File(['late'], 'late.pdf', { type: 'application/pdf' })])
    await flushUi()
    view.record.value = REC_B()
    await flushUi()
    expect(view.fileInput().disabled).toBe(false)
    pickFiles(view.fileInput(), [new File(['own'], 'own.pdf', { type: 'application/pdf' })])
    await flushUi()
    expect(upload.fn.mock.calls[1][1]).toEqual({ recordId: 'rec_B', fieldId: 'fld_files' })

    upload.pending[0].resolve(attachment('att_late', 'late.pdf'))
    await flushUi()

    // A's late result neither ends B's activity nor puts A's file into B's list.
    expect(view.fileInput().disabled).toBe(true)
    expect(view.container.querySelector('.meta-form-view__uploading')).not.toBeNull()
    expect(view.container.textContent).not.toContain('late.pdf')

    upload.pending[1].resolve(attachment('att_b2', 'own.pdf'))
    await flushUi()
    expect(view.fileInput().disabled).toBe(false)
    expect(view.container.querySelector('.meta-form-view__uploading')).toBeNull()
    expect(view.container.textContent).toContain('own.pdf')
    expect(await submitted(view)).toEqual({ fld_title: 'Beta', fld_files: ['att_b1', 'att_b2'] })

    view.unmount()
  })

  it('keeps the next record\'s own upload shown as uploading when the earlier record\'s remove ends', async () => {
    const upload = deferredFn<ReturnType<typeof attachment>>()
    const remove = deferredFn()
    const view = mountForm({ record: REC_A(), uploadFn: upload.fn, deleteAttachmentFn: remove.fn })

    ;(view.container.querySelector('.meta-attachment-list__remove') as HTMLButtonElement).click()
    await flushUi()
    view.record.value = REC_B()
    await flushUi()
    pickFiles(view.fileInput(), [new File(['own'], 'own.pdf', { type: 'application/pdf' })])
    await flushUi()

    remove.pending[0].resolve()
    await flushUi()

    // A's finished remove does not end B's upload activity.
    expect(view.fileInput().disabled).toBe(true)
    expect(view.container.querySelector('.meta-form-view__uploading')).not.toBeNull()

    upload.pending[0].resolve(attachment('att_b2', 'own.pdf'))
    await flushUi()
    expect(await submitted(view)).toEqual({ fld_title: 'Beta', fld_files: ['att_b1', 'att_b2'] })

    view.unmount()
  })

  it.each(['remove fails', 'clear-all fails', 'clear-all ends'])(
    'keeps the next record\'s own upload shown as uploading when the earlier record\'s %s after the switch',
    async (settle) => {
      const upload = deferredFn<ReturnType<typeof attachment>>()
      const remove = deferredFn()
      const view = mountForm({ record: REC_A(), uploadFn: upload.fn, deleteAttachmentFn: remove.fn })
      const button = settle === 'remove fails' ? '.meta-attachment-list__remove' : '.meta-form-view__attachment-clear'
      const saveButton = () => view.container.querySelector('.meta-form-view__submit') as HTMLButtonElement

      ;(view.container.querySelector(button) as HTMLButtonElement).click()
      await flushUi()
      view.record.value = REC_B()
      await flushUi()
      pickFiles(view.fileInput(), [new File(['own'], 'own.pdf', { type: 'application/pdf' })])
      await flushUi()
      expect(saveButton().disabled).toBe(true)

      if (settle === 'clear-all ends') {
        // Both of A's deletes finish: the clear's success path runs after the switch.
        remove.pending[0].resolve()
        await flushUi()
        remove.pending[1].resolve()
      } else {
        remove.pending[0].reject(new Error('Delete refused'))
      }
      await flushUi()

      // A's settled write neither ends B's upload activity nor shows its error under B.
      expect(view.fileInput().disabled).toBe(true)
      expect(saveButton().disabled).toBe(true)
      expect(view.container.querySelector('.meta-form-view__uploading')).not.toBeNull()
      expect(fieldError(view)).toBeNull()
      expect(view.container.textContent).not.toContain('Delete refused')

      upload.pending[0].resolve(attachment('att_b2', 'own.pdf'))
      await flushUi()
      expect(view.fileInput().disabled).toBe(false)
      expect(saveButton().disabled).toBe(false)
      expect(await submitted(view)).toEqual({ fld_title: 'Beta', fld_files: ['att_b1', 'att_b2'] })

      view.unmount()
    },
  )

  it.each([
    {
      name: 'upload',
      start: (view: ReturnType<typeof mountForm>) =>
        pickFiles(view.fileInput(), [new File(['big'], 'big.pdf', { type: 'application/pdf' })]),
    },
    {
      name: 'remove',
      start: (view: ReturnType<typeof mountForm>) =>
        (view.container.querySelector('.meta-attachment-list__remove') as HTMLButtonElement).click(),
    },
    {
      name: 'clear-all',
      start: (view: ReturnType<typeof mountForm>) =>
        (view.container.querySelector('.meta-form-view__attachment-clear') as HTMLButtonElement).click(),
    },
  ])('shows no error under the next record when the earlier record\'s $name fails after the switch', async ({ start }) => {
    const upload = deferredFn<ReturnType<typeof attachment>>()
    const remove = deferredFn()
    const view = mountForm({ record: REC_A(), uploadFn: upload.fn, deleteAttachmentFn: remove.fn })

    start(view)
    await flushUi()
    view.record.value = REC_B()
    await flushUi()
    ;[...upload.pending, ...remove.pending].forEach((call) => call.reject(new Error('Storage quota exceeded')))
    await flushUi()

    expect(fieldError(view)).toBeNull()
    expect(view.container.textContent).not.toContain('Storage quota exceeded')
    expect(view.fileInput().disabled).toBe(false)
    expect(await submitted(view)).toEqual({ fld_title: 'Beta', fld_files: ['att_b1'] })

    view.unmount()
  })

  it('appends an upload to the same record\'s form when no switch happens', async () => {
    const upload = deferredFn<ReturnType<typeof attachment>>()
    const view = mountForm({ record: REC_A(), uploadFn: upload.fn })
    const file = new File(['new'], 'new.pdf', { type: 'application/pdf' })

    pickFiles(view.fileInput(), [file])
    await flushUi()
    expect(view.container.querySelector('.meta-form-view__uploading')).not.toBeNull()
    upload.pending[0].resolve(attachment('att_new', 'new.pdf'))
    await flushUi()

    expect(upload.fn).toHaveBeenCalledWith(file, { recordId: 'rec_A', fieldId: 'fld_files' })
    expect(view.container.textContent).toContain('new.pdf')
    expect(view.container.querySelector('.meta-form-view__uploading')).toBeNull()
    expect(view.fileInput().disabled).toBe(false)
    expect(await submitted(view)).toEqual({ fld_title: 'Alpha', fld_files: ['att_a1', 'att_a2', 'att_new'] })

    view.unmount()
  })

  it('updates the same record\'s form after a remove and then a clear-all', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const view = mountForm({ record: REC_A(), deleteAttachmentFn: remove })

    ;(view.container.querySelector('.meta-attachment-list__remove') as HTMLButtonElement).click()
    await flushUi()
    expect(remove).toHaveBeenCalledWith('att_a1', { recordId: 'rec_A', fieldId: 'fld_files' })
    expect(await submitted(view)).toEqual({ fld_title: 'Alpha', fld_files: ['att_a2'] })

    ;(view.container.querySelector('.meta-form-view__attachment-clear') as HTMLButtonElement).click()
    await flushUi()
    expect(remove).toHaveBeenLastCalledWith('att_a2', { recordId: 'rec_A', fieldId: 'fld_files' })
    expect(await submitted(view)).toEqual({ fld_title: 'Alpha', fld_files: [] })
    expect(view.container.querySelector('.meta-form-view__attachment-clear')).toBeNull()

    view.unmount()
  })

  it('shows the error on the same record when its upload or remove fails', async () => {
    const upload = vi.fn().mockRejectedValue(new Error('Storage quota exceeded'))
    const remove = vi.fn().mockRejectedValue(new Error('Delete refused'))
    const view = mountForm({ record: REC_A(), uploadFn: upload, deleteAttachmentFn: remove })

    pickFiles(view.fileInput(), [new File(['big'], 'big.pdf', { type: 'application/pdf' })])
    await flushUi()
    expect(fieldError(view)?.textContent).toBe('Storage quota exceeded')
    expect(view.fileInput().disabled).toBe(false)

    ;(view.container.querySelector('.meta-attachment-list__remove') as HTMLButtonElement).click()
    await flushUi()
    expect(fieldError(view)?.textContent).toBe('Delete refused')
    expect(view.fileInput().disabled).toBe(false)
    // The failed remove keeps the list as it was.
    expect(await submitted(view)).toEqual({ fld_title: 'Alpha', fld_files: ['att_a1', 'att_a2'] })

    view.unmount()
  })

  // A form that moves between create mode and a record (a deep link with its discard prompt accepted, or the record
  // removed under it) is another form too: the late upload stays out of it.
  it.each([
    ['create mode, then rec_B', null, REC_B],
    ['rec_A, then create mode', REC_A, null],
  ] as const)('keeps an upload that ends after the form moved from %s out of the form now shown', async (_label, first, second) => {
    const upload = deferredFn<ReturnType<typeof attachment>>()
    const view = mountForm({ record: first && first(), uploadFn: upload.fn })
    await flushUi()

    pickFiles(view.fileInput(), [new File(['late'], 'late.pdf', { type: 'application/pdf' })])
    await flushUi()
    view.record.value = second && second()
    await flushUi()
    upload.pending[0].resolve(attachment('att_late', 'late.pdf'))
    await flushUi()

    expect(view.container.textContent).not.toContain('late.pdf')
    expect((await submitted(view)).fld_files ?? []).not.toContain('att_late')

    view.unmount()
  })

  it('lands an upload in a create-mode form (no record) even when the prefill arrives during the upload', async () => {
    const upload = deferredFn<ReturnType<typeof attachment>>()
    const view = mountForm({ record: null, uploadFn: upload.fn })
    const file = new File(['new'], 'new.pdf', { type: 'application/pdf' })

    pickFiles(view.fileInput(), [file])
    await flushUi()
    // The public form loads its prefill late; the form re-syncs but is still the same (record-less) form.
    view.initialValues.value = { fld_title: 'Seeded' }
    await flushUi()
    upload.pending[0].resolve(attachment('att_new', 'new.pdf'))
    await flushUi()

    expect(upload.fn).toHaveBeenCalledTimes(1)
    expect(upload.fn.mock.calls[0][1]).toEqual({ recordId: undefined, fieldId: 'fld_files' })
    expect(upload.fn.mock.calls[0][1].recordId).toBeUndefined()
    expect(view.container.textContent).toContain('new.pdf')
    expect(view.container.querySelector('.meta-form-view__uploading')).toBeNull()
    expect(await submitted(view)).toEqual({ fld_title: 'Seeded', fld_files: ['att_new'] })

    view.unmount()
  })
})

// --- A4: multi-page / prefill / cross-page validation ---
describe('MetaFormView A4 form logic', () => {
  it('renders exactly the flat single-page form when no layout is provided (backward compat)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_a', name: 'A', type: 'string' },
            { id: 'fld_b', name: 'B', type: 'string' },
          ],
          record: null,
          loading: false,
          readOnly: false,
          onSubmit: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    // Both fields visible at once; no page header / nav chrome.
    expect(container.querySelector('#field_fld_a')).not.toBeNull()
    expect(container.querySelector('#field_fld_b')).not.toBeNull()
    expect(container.querySelector('[data-form-page-header]')).toBeNull()
    expect(container.querySelector('[data-form-next]')).toBeNull()
    expect(container.querySelector('[data-form-submit]')).not.toBeNull()

    app.unmount()
    container.remove()
  })

  it('renders only the current page and navigates with Next/Prev', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_a', name: 'A', type: 'string' },
            { id: 'fld_b', name: 'B', type: 'string' },
          ],
          record: null,
          loading: false,
          readOnly: false,
          formLayout: {
            pages: [
              { id: 'p1', title: 'First', fieldIds: ['fld_a'] },
              { id: 'p2', title: 'Second', fieldIds: ['fld_b'] },
            ],
          },
          onSubmit: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    // Page 1: only fld_a, Next present, submit absent.
    expect(container.querySelector('#field_fld_a')).not.toBeNull()
    expect(container.querySelector('#field_fld_b')).toBeNull()
    expect(container.querySelector('[data-form-page-indicator]')?.textContent).toContain('Page 1 of 2')
    expect(container.querySelector('[data-form-submit]')).toBeNull()

    container.querySelector<HTMLButtonElement>('[data-form-next]')?.click()
    await flushUi()

    // Page 2: only fld_b, Prev present, submit present, Next absent.
    expect(container.querySelector('#field_fld_a')).toBeNull()
    expect(container.querySelector('#field_fld_b')).not.toBeNull()
    expect(container.querySelector('[data-form-page-indicator]')?.textContent).toContain('Page 2 of 2')
    expect(container.querySelector('[data-form-prev]')).not.toBeNull()
    expect(container.querySelector('[data-form-submit]')).not.toBeNull()
    expect(container.querySelector('[data-form-next]')).toBeNull()

    container.querySelector<HTMLButtonElement>('[data-form-prev]')?.click()
    await flushUi()
    expect(container.querySelector('#field_fld_a')).not.toBeNull()

    app.unmount()
    container.remove()
  })

  it('blocks submit on a required field on ANOTHER page and jumps to it (no silent cross-page skip)', async () => {
    const submitSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_a', name: 'A', type: 'string' },
            { id: 'fld_required', name: 'Required B', type: 'string', required: true },
          ],
          record: null,
          loading: false,
          readOnly: false,
          formLayout: {
            pages: [
              { id: 'p1', title: 'First', fieldIds: ['fld_a'] },
              { id: 'p2', title: 'Second', fieldIds: ['fld_required'] },
            ],
          },
          onSubmit: submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    // On page 1; submit isn't even shown here, so navigate to page 2 to reach it,
    // then clear the required value to force the cross-page block via the form.
    container.querySelector<HTMLButtonElement>('[data-form-next]')?.click()
    await flushUi()
    expect(container.querySelector('[data-form-page-indicator]')?.textContent).toContain('Page 2 of 2')

    // Go back to page 1, then submit the form directly (the required field on
    // page 2 is empty). validate() must fail and jump back to page 2.
    container.querySelector<HTMLButtonElement>('[data-form-prev]')?.click()
    await flushUi()
    expect(container.querySelector('[data-form-page-indicator]')?.textContent).toContain('Page 1 of 2')

    container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()

    expect(submitSpy).not.toHaveBeenCalled()
    // Jumped to the page carrying the error, and the inline error is visible there.
    expect(container.querySelector('[data-form-page-indicator]')?.textContent).toContain('Page 2 of 2')
    expect(container.querySelector('#error_fld_required')).not.toBeNull()
    expect(container.textContent).toContain('Required B is required')

    app.unmount()
    container.remove()
  })

  it('seeds create-mode formData from initialValues but never seeds a read-only field', async () => {
    const submitSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_locked', name: 'Locked', type: 'string' },
          ],
          record: null, // create mode
          loading: false,
          readOnly: false,
          fieldPermissions: {
            fld_name: { visible: true, readOnly: false },
            fld_locked: { visible: true, readOnly: true },
          },
          initialValues: { fld_name: 'Seeded', fld_locked: 'should-be-ignored' },
          onSubmit: submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const nameInput = container.querySelector('#field_fld_name') as HTMLInputElement | null
    expect(nameInput?.value).toBe('Seeded')
    const lockedInput = container.querySelector('#field_fld_locked') as HTMLInputElement | null
    expect(lockedInput?.value).toBe('') // read-only field NOT seeded

    container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()

    expect(submitSpy).toHaveBeenCalledWith({ fld_name: 'Seeded' })

    app.unmount()
    container.remove()
  })

  it('never lets initialValues override a loaded record (edit mode)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          record: { id: 'rec_1', version: 1, data: { fld_name: 'FromRecord' } },
          loading: false,
          readOnly: false,
          initialValues: { fld_name: 'FromPrefill' },
          onSubmit: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const nameInput = container.querySelector('#field_fld_name') as HTMLInputElement | null
    expect(nameInput?.value).toBe('FromRecord')

    app.unmount()
    container.remove()
  })
})

describe('MetaFormView number draft', () => {
  it('a number box holding a draft it cannot read leaves the form value as it was, so Save does not clear the stored number', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const submitSpy = vi.fn()
    const app = createApp({
      render: () => h(MetaFormView, {
        fields: [{ id: 'fld_num', name: 'Amount', type: 'number' }],
        record: { id: 'rec_A', version: 1, data: { fld_num: 5 } },
        loading: false,
        readOnly: false,
        onSubmit: submitSpy,
      }),
    })
    app.mount(container)
    await flushUi()
    const box = container.querySelector('input[type="number"]') as HTMLInputElement
    const validity = { badInput: true }
    Object.defineProperty(box, 'validity', { get: () => validity, configurable: true })
    const submit = async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit'))
      await flushUi()
      return submitSpy.mock.calls.at(-1)![0]
    }
    box.value = ''
    box.dispatchEvent(new Event('input'))
    expect(await submit()).toMatchObject({ fld_num: 5 })
    // An empty box (a readable value) still clears it. (The submit re-rendered the box with the stored 5.)
    validity.badInput = false
    box.value = ''
    box.dispatchEvent(new Event('input'))
    expect(await submit()).toMatchObject({ fld_num: null })
    app.unmount()
    container.remove()
  })
})
