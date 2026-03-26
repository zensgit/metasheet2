import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaGalleryView from '../src/multitable/components/MetaGalleryView.vue'

describe('MetaGalleryView', () => {
  it('renders persisted gallery config including cover image and configured fields', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaGalleryView, {
          rows: [
            {
              id: 'rec_1',
              version: 1,
              data: {
                fld_title: 'Launch plan',
                fld_cover: ['att_1'],
                fld_status: 'In progress',
                fld_owner: ['user_1'],
                fld_notes: 'Customer pilot',
              },
            },
          ],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_cover', name: 'Cover', type: 'attachment' },
            { id: 'fld_status', name: 'Status', type: 'string' },
            { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', limitSingleRecord: true } },
            { id: 'fld_notes', name: 'Notes', type: 'string' },
          ],
          loading: false,
          currentPage: 1,
          totalPages: 1,
          viewConfig: {
            titleFieldId: 'fld_title',
            coverFieldId: 'fld_cover',
            fieldIds: ['fld_status', 'fld_owner'],
            columns: 2,
            cardSize: 'large',
          },
          linkSummaries: {
            rec_1: {
              fld_owner: [{ id: 'user_1', display: 'Jamie' }],
            },
          },
          attachmentSummaries: {
            rec_1: {
              fld_cover: [{
                id: 'att_1',
                filename: 'cover.png',
                mimeType: 'image/png',
                size: 1024,
                url: '/api/multitable/attachments/att_1',
                thumbnailUrl: '/api/multitable/attachments/att_1?thumbnail=true',
                uploadedAt: '2026-03-21T10:00:00.000Z',
              }],
            },
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const grid = container.querySelector('.meta-gallery__grid') as HTMLElement | null
    const image = container.querySelector('.meta-gallery__cover-image') as HTMLImageElement | null
    const card = container.querySelector('.meta-gallery__card') as HTMLElement | null
    const cardBody = container.querySelector('.meta-gallery__card-body') as HTMLElement | null

    expect(grid?.style.gridTemplateColumns).toContain('repeat(2')
    expect(image?.getAttribute('src')).toContain('thumbnail=true')
    expect(card?.classList.contains('meta-gallery__card--large')).toBe(true)
    expect(container.textContent).toContain('Launch plan')
    expect(container.textContent).toContain('Status')
    expect(container.textContent).toContain('Jamie')
    expect(cardBody?.textContent).not.toContain('Notes')

    app.unmount()
    container.remove()
  })

  it('emits inline gallery config changes for quick view tuning', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaGalleryView, {
          rows: [],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_cover', name: 'Cover', type: 'attachment' },
            { id: 'fld_status', name: 'Status', type: 'string' },
            { id: 'fld_notes', name: 'Notes', type: 'string' },
          ],
          loading: false,
          currentPage: 1,
          totalPages: 1,
          viewConfig: {
            titleFieldId: 'fld_title',
            coverFieldId: 'fld_cover',
            fieldIds: ['fld_status', 'fld_notes'],
            columns: 2,
            cardSize: 'medium',
          },
          onUpdateViewConfig: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const selects = Array.from(container.querySelectorAll('.meta-gallery__toolbar-select')) as HTMLSelectElement[]
    expect(selects).toHaveLength(4)

    selects[2].value = '4'
    selects[2].dispatchEvent(new Event('change'))
    await nextTick()

    expect(updateSpy.mock.calls[0]?.[0]).toEqual({
      config: {
        titleFieldId: 'fld_title',
        coverFieldId: 'fld_cover',
        fieldIds: ['fld_status', 'fld_notes'],
        columns: 4,
        cardSize: 'medium',
      },
    })

    app.unmount()
    container.remove()
  })
})
