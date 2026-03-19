import { describe, expect, it } from 'vitest'
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

    expect(container.textContent).toContain('Edit links (2)')
    expect(container.textContent).toContain('Acme Supply, Beacon Labs')

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

    app.unmount()
    container.remove()
  })
})
