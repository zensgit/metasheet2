import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import MetaAttachmentList from '../src/multitable/components/MetaAttachmentList.vue'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

describe('MetaAttachmentList', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:image-preview')
      static revokeObjectURL = vi.fn()
    })
    vi.mocked(apiFetch).mockImplementation(async () => new Response(new Uint8Array([1]), { status: 200 }))
  })
  afterEach(() => {
    useLocale().setLocale('en')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.mocked(apiFetch).mockReset()
  })

  it.each(['success', 'denied', 'removed'] as const)('loads authenticated image and releases its owned URL: %s', async mode => {
    const createObjectURL = vi.fn(() => 'blob:authenticated-image')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    })
    let resolve!: (response: Response) => void
    vi.mocked(apiFetch).mockReturnValue(new Promise<Response>(done => { resolve = done }))
    const attachments = ref([{
      id: 'att_image', filename: 'image.png', mimeType: 'image/png', size: 4,
      url: 'https://untrusted.invalid/image', uploadedAt: '2026-09-19T00:00:00.000Z',
    }])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render: () => h(MetaAttachmentList, { attachments: attachments.value }) })
    app.mount(container)
    try {
      await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1))
      expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/api/multitable/attachments/att_image?thumbnail=true')
      if (mode === 'removed') {
        attachments.value = []
        await nextTick()
        expect((vi.mocked(apiFetch).mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true)
      }
      resolve(new Response(new Uint8Array([0, 255, 128, 1]), { status: mode === 'denied' ? 403 : 200 }))
      if (mode === 'success') {
        await vi.waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:authenticated-image'))
        ;(container.querySelector('button.meta-attachment-list__card--preview') as HTMLButtonElement).click()
        await nextTick()
        expect(document.body.querySelector('.meta-attachment-list__lightbox-image')?.getAttribute('src')).toBe('blob:authenticated-image')
        attachments.value = []
        await nextTick()
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:authenticated-image')
        expect(document.body.querySelector('.meta-attachment-list__lightbox')).toBeNull()
      } else {
        await new Promise(done => setTimeout(done, 0))
        expect(createObjectURL).not.toHaveBeenCalled()
        expect(container.querySelector('img')?.getAttribute('src') ?? '').not.toContain('untrusted')
        if (mode === 'denied') expect(container.querySelector('[role="alert"]')).not.toBeNull()
      }
    } finally {
      app.unmount()
      container.remove()
    }
  })

  it.each(['success', 'denied', 'unmount'] as const)('authenticates original download without trusting stored URL: %s', async mode => {
    const createObjectURL = vi.fn(() => 'blob:synthetic-download')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    })
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { clicked.push(this) })
    let resolve!: (response: Response) => void
    vi.mocked(apiFetch).mockReturnValue(new Promise<Response>(done => { resolve = done }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render: () => h(MetaAttachmentList, { attachments: [{
      id: 'att opaque/identity', filename: 'restored.bin', mimeType: 'application/octet-stream',
      size: 4, url: 'https://untrusted.invalid/file', uploadedAt: '2026-09-19T00:00:00.000Z',
    }] }) })
    app.mount(container)
    try {
      ;(container.querySelector('[data-attachment-download]') as HTMLButtonElement).click()
      await nextTick()
      expect(apiFetch).toHaveBeenCalledTimes(1)
      expect(vi.mocked(apiFetch).mock.calls[0][0]).toBe('/api/multitable/attachments/att%20opaque%2Fidentity')
      const signal = vi.mocked(apiFetch).mock.calls[0][1]?.signal as AbortSignal
      if (mode === 'unmount') {
        app.unmount()
        expect(signal.aborted).toBe(true)
      }
      resolve(new Response(new Uint8Array([0, 255, 128, 1]), { status: mode === 'denied' ? 403 : 200 }))
      if (mode === 'success') {
        await vi.waitFor(() => expect(clicked).toHaveLength(1))
        expect(clicked[0].download).toBe('restored.bin')
        expect(clicked[0].href).toBe('blob:synthetic-download')
        await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-download'))
      } else if (mode === 'denied') {
        await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain('unavailable'))
        expect(clicked).toEqual([])
        expect(createObjectURL).not.toHaveBeenCalled()
      } else {
        await new Promise(done => setTimeout(done, 0))
        expect(clicked).toEqual([])
        expect(createObjectURL).not.toHaveBeenCalled()
      }
    } finally {
      if (mode !== 'unmount') app.unmount()
      container.remove()
    }
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
    await vi.waitFor(() => expect(image?.getAttribute('src')).toBe('blob:image-preview'))
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

    await vi.waitFor(() => expect((container.querySelector('button.meta-attachment-list__card--preview') as HTMLButtonElement).disabled).toBe(false))
    ;(container.querySelector('button.meta-attachment-list__card--preview') as HTMLButtonElement | null)?.click()
    await nextTick()

    const lightbox = document.body.querySelector('.meta-attachment-list__lightbox')
    const lightboxImage = document.body.querySelector('.meta-attachment-list__lightbox-image') as HTMLImageElement | null
    expect(lightbox).not.toBeNull()
    expect(lightboxImage?.getAttribute('src')).toBe('blob:image-preview')
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

    await vi.waitFor(() => expect(previewButton?.disabled).toBe(false))
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
