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
})
