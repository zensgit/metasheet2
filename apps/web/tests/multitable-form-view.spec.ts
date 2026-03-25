import { describe, it, expect, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'

describe('MetaFormView', () => {
  it('renders field-level validation errors on the matching input', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_owner', name: 'Owner', type: 'string' },
          ],
          record: {
            id: 'rec_1',
            version: 1,
            data: { fld_title: 'Ship pilot', fld_owner: 'Alex' },
          },
          loading: false,
          readOnly: false,
          fieldErrors: {
            fld_title: 'Title is required',
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const inputs = Array.from(container.querySelectorAll('input'))
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.classList.contains('meta-form-view__input--error')).toBe(true)
    expect(inputs[1]?.classList.contains('meta-form-view__input--error')).toBe(false)
    expect(container.textContent).toContain('Title is required')

    app.unmount()
    container.remove()
  })

  it('shows selected link summaries for link fields', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_vendor', name: 'Vendor', type: 'link' },
          ],
          record: {
            id: 'rec_2',
            version: 2,
            data: { fld_vendor: ['vendor_1'] },
          },
          loading: false,
          readOnly: false,
          linkSummariesByField: {
            fld_vendor: [{ id: 'vendor_1', display: 'Acme Supply' }],
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('Edit linked records (1)')
    expect(container.textContent).toContain('Acme Supply')

    app.unmount()
    container.remove()
  })

  it('shows multiple selected link summaries for link fields', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_vendor', name: 'Vendor', type: 'link' },
          ],
          record: {
            id: 'rec_3',
            version: 3,
            data: { fld_vendor: ['vendor_1', 'vendor_2'] },
          },
          loading: false,
          readOnly: false,
          linkSummariesByField: {
            fld_vendor: [
              { id: 'vendor_1', display: 'Acme Supply' },
              { id: 'vendor_2', display: 'Beacon Labs' },
            ],
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('Edit linked records (2)')
    expect(container.textContent).toContain('Acme Supply, Beacon Labs')

    app.unmount()
    container.remove()
  })

  it('uses person-specific labels for people fields', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', limitSingleRecord: true } },
          ],
          record: {
            id: 'rec_people_1',
            version: 1,
            data: { fld_owner: ['user_1'] },
          },
          loading: false,
          readOnly: false,
          linkSummariesByField: {
            fld_owner: [{ id: 'user_1', display: 'Jamie' }],
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('Edit person (1)')
    expect(container.textContent).toContain('Jamie')

    app.unmount()
    container.remove()
  })

  it('treats an empty link selection as empty for required validation', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const submitSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_vendor', name: 'Vendor', type: 'link', required: true },
          ],
          record: {
            id: 'rec_3',
            version: 1,
            data: { fld_vendor: [] },
          },
          loading: false,
          readOnly: false,
          onSubmit: submitSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('form') as HTMLFormElement | null)?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()

    expect(submitSpy).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Vendor is required')

    app.unmount()
    container.remove()
  })

  it('shows attachment filenames from attachment summaries', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_files', name: 'Files', type: 'attachment' },
          ],
          record: {
            id: 'rec_4',
            version: 1,
            data: { fld_files: ['att_1'] },
          },
          loading: false,
          readOnly: false,
          attachmentSummariesByField: {
            fld_files: [{
              id: 'att_1',
              filename: 'report.pdf',
              mimeType: 'application/pdf',
              size: 1024,
              url: '/api/multitable/attachments/att_1',
              thumbnailUrl: null,
              uploadedAt: '2026-03-19T10:00:00.000Z',
            }],
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('report.pdf')
    expect(container.textContent).not.toContain('att_1')

    app.unmount()
    container.remove()
  })

  it('renders image thumbnails from attachment summaries', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_images', name: 'Images', type: 'attachment' },
          ],
          record: {
            id: 'rec_5',
            version: 1,
            data: { fld_images: ['att_img_2'] },
          },
          loading: false,
          readOnly: false,
          attachmentSummariesByField: {
            fld_images: [{
              id: 'att_img_2',
              filename: 'diagram.png',
              mimeType: 'image/png',
              size: 2048,
              url: '/api/multitable/attachments/att_img_2',
              thumbnailUrl: '/api/multitable/attachments/att_img_2?thumbnail=true',
              uploadedAt: '2026-03-21T10:00:00.000Z',
            }],
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const image = container.querySelector('img') as HTMLImageElement | null
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toContain('thumbnail=true')

    app.unmount()
    container.remove()
  })

  it('removes attachments through deleteAttachmentFn before submit', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const deleteAttachmentFn = vi.fn().mockResolvedValue(undefined)
    const submitSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [
            { id: 'fld_files', name: 'Files', type: 'attachment' },
          ],
          record: {
            id: 'rec_remove_1',
            version: 1,
            data: { fld_files: ['att_keep', 'att_remove'] },
          },
          loading: false,
          readOnly: false,
          attachmentSummariesByField: {
            fld_files: [
              {
                id: 'att_keep',
                filename: 'keep.pdf',
                mimeType: 'application/pdf',
                size: 100,
                url: '/api/multitable/attachments/att_keep',
                thumbnailUrl: null,
                uploadedAt: '2026-03-21T12:00:00.000Z',
              },
              {
                id: 'att_remove',
                filename: 'remove.pdf',
                mimeType: 'application/pdf',
                size: 120,
                url: '/api/multitable/attachments/att_remove',
                thumbnailUrl: null,
                uploadedAt: '2026-03-21T12:00:00.000Z',
              },
            ],
          },
          deleteAttachmentFn,
          onSubmit: submitSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const removeButtons = Array.from(container.querySelectorAll('.meta-attachment-list__remove')) as HTMLButtonElement[]
    removeButtons[1]?.click()
    await nextTick()
    await Promise.resolve()
    await nextTick()

    expect(deleteAttachmentFn).toHaveBeenCalledWith('att_remove', {
      recordId: 'rec_remove_1',
      fieldId: 'fld_files',
    })

    ;(container.querySelector('form') as HTMLFormElement | null)?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()

    expect(submitSpy).toHaveBeenCalledWith({
      fld_files: ['att_keep'],
    })

    app.unmount()
    container.remove()
  })
})
