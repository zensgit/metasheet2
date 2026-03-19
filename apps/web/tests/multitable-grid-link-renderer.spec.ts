import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'

describe('MetaCellRenderer link rendering', () => {
  it('shows linked record summaries instead of raw ids when summaries are present', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellRenderer, {
          field: {
            id: 'fld_vendor',
            name: 'Vendor',
            type: 'link',
          },
          value: ['rec_vendor_1', 'rec_vendor_2'],
          linkSummaries: [
            { id: 'rec_vendor_1', display: 'Acme Supply' },
            { id: 'rec_vendor_2', display: 'Beacon Labs' },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('Acme Supply')
    expect(container.textContent).toContain('Beacon Labs')
    expect(container.textContent).not.toContain('rec_vendor_1')
    expect(container.textContent).not.toContain('rec_vendor_2')

    app.unmount()
    container.remove()
  })

  it('shows attachment filenames instead of raw ids when summaries are present', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellRenderer, {
          field: {
            id: 'fld_files',
            name: 'Files',
            type: 'attachment',
          },
          value: ['att_001'],
          attachmentSummaries: [
            {
              id: 'att_001',
              filename: 'report.pdf',
              mimeType: 'application/pdf',
              size: 1024,
              url: '/api/multitable/attachments/att_001',
              thumbnailUrl: null,
              uploadedAt: '2026-03-19T10:00:00.000Z',
            },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('report.pdf')
    expect(container.textContent).not.toContain('att_001')

    app.unmount()
    container.remove()
  })

  it('matches grid search text against linked record summary display', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaGridTable, {
          rows: [
            {
              id: 'rec_order_1',
              version: 1,
              data: { fld_vendor: ['rec_vendor_1'] },
            },
          ],
          visibleFields: [
            { id: 'fld_vendor', name: 'Vendor', type: 'link' },
          ],
          sortRules: [],
          loading: false,
          currentPage: 1,
          totalPages: 1,
          startIndex: 0,
          canEdit: false,
          linkSummaries: {
            rec_order_1: {
              fld_vendor: [{ id: 'rec_vendor_1', display: 'Acme Supply' }],
            },
          },
          searchText: 'Acme',
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('Acme Supply')
    expect(container.textContent).not.toContain('No matching records')

    app.unmount()
    container.remove()
  })
})
