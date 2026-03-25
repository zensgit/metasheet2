import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaAttachmentList from '../src/multitable/components/MetaAttachmentList.vue'

describe('MetaAttachmentList', () => {
  it('renders thumbnails for image attachments', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaAttachmentList, {
          attachments: [{
            id: 'att_img_1',
            filename: 'photo.png',
            mimeType: 'image/png',
            size: 2048,
            url: '/api/multitable/attachments/att_img_1',
            thumbnailUrl: '/api/multitable/attachments/att_img_1?thumbnail=true',
            uploadedAt: '2026-03-21T10:00:00.000Z',
          }],
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

  it('opens an image preview lightbox when the thumbnail is clicked', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaAttachmentList, {
          attachments: [{
            id: 'att_img_2',
            filename: 'diagram.png',
            mimeType: 'image/png',
            size: 4096,
            url: '/api/multitable/attachments/att_img_2',
            thumbnailUrl: '/api/multitable/attachments/att_img_2?thumbnail=true',
            uploadedAt: '2026-03-21T11:00:00.000Z',
          }],
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('button.meta-attachment-list__card--preview') as HTMLButtonElement | null)?.click()
    await nextTick()

    const lightbox = document.body.querySelector('.meta-attachment-list__lightbox')
    const lightboxImage = document.body.querySelector('.meta-attachment-list__lightbox-image') as HTMLImageElement | null
    expect(lightbox).not.toBeNull()
    expect(lightboxImage?.getAttribute('src')).toContain('/api/multitable/attachments/att_img_2')
    expect(document.body.textContent).toContain('Open original')

    app.unmount()
    container.remove()
  })

  it('emits remove for removable attachments', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const removed: string[] = []
    const app = createApp({
      render() {
        return h(MetaAttachmentList, {
          attachments: [{
            id: 'att_doc_1',
            filename: 'report.pdf',
            mimeType: 'application/pdf',
            size: 1024,
            url: '/api/multitable/attachments/att_doc_1',
            thumbnailUrl: null,
            uploadedAt: '2026-03-21T12:00:00.000Z',
          }],
          removable: true,
          onRemove: (attachmentId: string) => removed.push(attachmentId),
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-attachment-list__remove') as HTMLButtonElement | null)?.click()
    await nextTick()

    expect(removed).toEqual(['att_doc_1'])

    app.unmount()
    container.remove()
  })
})
