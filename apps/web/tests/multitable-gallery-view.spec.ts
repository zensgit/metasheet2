import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import MetaGalleryView from '../src/multitable/components/MetaGalleryView.vue'
import { useLocale } from '../src/composables/useLocale'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

describe('MetaGalleryView', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:gallery-cover')
      static revokeObjectURL = vi.fn()
    })
    vi.mocked(apiFetch).mockImplementation(async () => new Response('image', { status: 200 }))
  })
  afterEach(() => {
    useLocale().setLocale('en')
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.mocked(apiFetch).mockReset()
  })

  it.each(['success', 'denied', 'removed'] as const)('owns authenticated cover lifecycle: %s', async mode => {
    let resolve!: (response: Response) => void
    vi.mocked(apiFetch).mockReturnValue(new Promise<Response>(done => { resolve = done }))
    const rows = ref([{ id: 'row', version: 1, data: { cover: ['att/image'] } }])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render: () => h(MetaGalleryView, {
      rows: rows.value, fields: [{ id: 'cover', name: 'Cover', type: 'attachment' }],
      loading: false, currentPage: 1, totalPages: 1, viewConfig: { coverFieldId: 'cover' },
      attachmentSummaries: { row: { cover: [{ id: 'att/image', filename: 'image.png',
        mimeType: 'image/png', size: 5, url: 'https://untrusted.invalid/image', uploadedAt: '2026-09-20T00:00:00.000Z' }] } },
    }) })
    app.mount(container)
    try {
      expect(apiFetch).toHaveBeenCalledWith('/api/multitable/attachments/att%2Fimage?thumbnail=true', { signal: expect.any(AbortSignal) })
      expect(container.querySelector('img')).toBeNull()
      const signal = vi.mocked(apiFetch).mock.calls[0][1]?.signal
      if (mode === 'removed') { rows.value = []; await nextTick(); expect(signal?.aborted).toBe(true) }
      resolve(new Response('image', { status: mode === 'denied' ? 403 : 200 }))
      await new Promise(done => setTimeout(done, 0))
      await nextTick()
      if (mode === 'success') {
        expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:gallery-cover')
      } else {
        expect(URL.createObjectURL).not.toHaveBeenCalled()
        expect(container.querySelector('img')).toBeNull()
      }
    } finally { app.unmount(); container.remove() }
    if (mode === 'success') expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:gallery-cover')
  })

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
    await vi.waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:gallery-cover'))

    const grid = container.querySelector('.meta-gallery__grid') as HTMLElement | null
    const image = container.querySelector('.meta-gallery__cover-image') as HTMLImageElement | null
    const card = container.querySelector('.meta-gallery__card') as HTMLElement | null
    const cardBody = container.querySelector('.meta-gallery__card-body') as HTMLElement | null

    expect(grid?.style.gridTemplateColumns).toContain('repeat(2')
    expect(image?.getAttribute('src')).toBe('blob:gallery-cover')
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

  it('localizes gallery chrome while keeping field and card values raw', async () => {
    useLocale().setLocale('zh-CN')
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaGalleryView, {
          rows: [],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_cover', name: 'Cover', type: 'attachment' },
            { id: 'fld_status', name: 'Status', type: 'string' },
          ],
          loading: false,
          canCreate: true,
          currentPage: 1,
          totalPages: 2,
          viewConfig: {
            titleFieldId: 'fld_title',
            coverFieldId: 'fld_cover',
            fieldIds: ['fld_status'],
            columns: 2,
            cardSize: 'large',
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('标题')
    expect(container.textContent).toContain('封面')
    expect(container.textContent).toContain('列数')
    expect(container.textContent).toContain('卡片尺寸')
    expect(container.textContent).toContain('大')
    expect(container.textContent).toContain('卡片字段（1）')
    expect(container.textContent).toContain('没有可显示的记录')
    expect(container.textContent).toContain('创建第一条记录')
    expect(container.textContent).toContain('上一页')
    expect(container.textContent).toContain('下一页')
    expect(container.textContent).toContain('Status')
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0)
    expect(container.querySelectorAll('[title]')).toHaveLength(0)
    expect(container.querySelectorAll('[placeholder]')).toHaveLength(0)

    app.unmount()
  })
})
