import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaAttachmentList from '../src/multitable/components/MetaAttachmentList.vue'

describe('MetaAttachmentList', () => {
  afterEach(() => {
    useLocale().setLocale('en')
  })

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
    const previewButton = container.querySelector('button.meta-attachment-list__card--preview') as HTMLButtonElement | null
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toContain('thumbnail=true')
    expect(previewButton?.getAttribute('title')).toBe('Preview photo.png')

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
    expect(document.body.querySelector('.meta-attachment-list__lightbox-close')?.getAttribute('aria-label')).toBe('Close attachment preview')

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

  it('localizes zh-CN attachment chrome while preserving filenames raw', async () => {
    useLocale().setLocale('zh-CN')
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaAttachmentList, {
          attachments: [{
            id: 'att_img_zh',
            filename: 'diagram.png',
            mimeType: 'image/png',
            size: 4096,
            url: '/api/multitable/attachments/att_img_zh',
            thumbnailUrl: '/api/multitable/attachments/att_img_zh?thumbnail=true',
            uploadedAt: '2026-03-21T11:00:00.000Z',
          }],
          removable: true,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const previewButton = container.querySelector('button.meta-attachment-list__card--preview') as HTMLButtonElement | null
    const removeButton = container.querySelector('.meta-attachment-list__remove') as HTMLButtonElement | null
    expect(previewButton?.getAttribute('title')).toBe('预览 diagram.png')
    expect(removeButton?.getAttribute('title')).toBe('移除 diagram.png')
    expect(container.textContent).toContain('diagram.png')

    previewButton?.click()
    await nextTick()

    expect(document.body.textContent).toContain('打开原文件')
    expect(document.body.textContent).not.toContain('Open original')
    expect(document.body.querySelector('.meta-attachment-list__lightbox-close')?.getAttribute('aria-label')).toBe('关闭附件预览')
    expect(document.body.querySelector('.meta-attachment-list__lightbox-title')?.textContent).toBe('diagram.png')

    app.unmount()
    container.remove()
  })
})
