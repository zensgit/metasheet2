import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'

describe('MetaRecordDrawer', () => {
  it('shows multiple selected link summaries for link fields', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: {
            id: 'rec_1',
            version: 1,
            data: {
              fld_vendor: ['vendor_1', 'vendor_2'],
            },
          },
          fields: [
            { id: 'fld_vendor', name: 'Vendor', type: 'link' },
          ],
          canEdit: true,
          canComment: false,
          canDelete: false,
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
        return h(MetaRecordDrawer, {
          visible: true,
          record: {
            id: 'rec_people_2',
            version: 1,
            data: {
              fld_owner: ['user_1'],
            },
          },
          fields: [
            { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', limitSingleRecord: true } },
          ],
          canEdit: true,
          canComment: false,
          canDelete: false,
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

  it('shows attachment filenames from attachment summaries', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: {
            id: 'rec_2',
            version: 1,
            data: {
              fld_files: ['att_2'],
            },
          },
          fields: [
            { id: 'fld_files', name: 'Files', type: 'attachment' },
          ],
          canEdit: true,
          canComment: false,
          canDelete: false,
          attachmentSummariesByField: {
            fld_files: [{
              id: 'att_2',
              filename: 'diagram.png',
              mimeType: 'image/png',
              size: 2048,
              url: '/api/multitable/attachments/att_2',
              thumbnailUrl: '/api/multitable/attachments/att_2?thumbnail=true',
              uploadedAt: '2026-03-19T11:00:00.000Z',
            }],
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('diagram.png')
    expect(container.textContent).not.toContain('att_2')
    const image = container.querySelector('img') as HTMLImageElement | null
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toContain('thumbnail=true')

    app.unmount()
    container.remove()
  })

  it('removes attachments through deleteAttachmentFn without emitting patch', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const deleteAttachmentFn = vi.fn().mockResolvedValue(undefined)
    const patchSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: {
            id: 'rec_remove_2',
            version: 1,
            data: {
              fld_files: ['att_remove'],
            },
          },
          fields: [
            { id: 'fld_files', name: 'Files', type: 'attachment' },
          ],
          canEdit: true,
          canComment: false,
          canDelete: false,
          attachmentSummariesByField: {
            fld_files: [{
              id: 'att_remove',
              filename: 'remove.pdf',
              mimeType: 'application/pdf',
              size: 1024,
              url: '/api/multitable/attachments/att_remove',
              thumbnailUrl: null,
              uploadedAt: '2026-03-21T12:30:00.000Z',
            }],
          },
          deleteAttachmentFn,
          onPatch: patchSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-attachment-list__remove') as HTMLButtonElement | null)?.click()
    await nextTick()
    await nextTick()

    expect(deleteAttachmentFn).toHaveBeenCalledWith('att_remove', {
      recordId: 'rec_remove_2',
      fieldId: 'fld_files',
    })
    expect(patchSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })
})
