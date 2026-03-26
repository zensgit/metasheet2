import { createApp, h, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'

async function flushUi() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('MetaGridTable attachment editing', () => {
  it('uses deleteAttachmentFn for grid attachment removals without patching the row again', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const patchSpy = vi.fn()
    const deleteSpy = vi.fn().mockResolvedValue(undefined)

    const app = createApp({
      render() {
        return h(MetaGridTable, {
          rows: [
            { id: 'rec_1', version: 4, data: { fld_files: ['att_keep', 'att_remove'] } },
          ],
          visibleFields: [
            { id: 'fld_files', name: 'Files', type: 'attachment' },
          ],
          sortRules: [],
          loading: false,
          currentPage: 1,
          totalPages: 1,
          startIndex: 0,
          selectedRecordId: null,
          canEdit: true,
          canDelete: false,
          attachmentSummaries: {
            rec_1: {
              fld_files: [
                {
                  id: 'att_keep',
                  filename: 'keep.pdf',
                  mimeType: 'application/pdf',
                  size: 100,
                  url: '/api/multitable/attachments/att_keep',
                  thumbnailUrl: null,
                  uploadedAt: '2026-03-21T10:00:00.000Z',
                },
                {
                  id: 'att_remove',
                  filename: 'remove.pdf',
                  mimeType: 'application/pdf',
                  size: 120,
                  url: '/api/multitable/attachments/att_remove',
                  thumbnailUrl: null,
                  uploadedAt: '2026-03-21T10:01:00.000Z',
                },
              ],
            },
          },
          deleteAttachmentFn: deleteSpy,
          onPatchCell: patchSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    ;(container.querySelector('.meta-grid__cell') as HTMLTableCellElement | null)
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()

    const removeButtons = Array.from(container.querySelectorAll('.meta-attachment-list__remove')) as HTMLButtonElement[]
    removeButtons[1]?.click()
    await flushUi()

    expect(deleteSpy).toHaveBeenCalledWith('att_remove', {
      recordId: 'rec_1',
      fieldId: 'fld_files',
    })
    expect(patchSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('falls back to patching attachment ids when no deleteAttachmentFn is injected', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const patchSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaGridTable, {
          rows: [
            { id: 'rec_2', version: 7, data: { fld_files: ['att_a', 'att_b'] } },
          ],
          visibleFields: [
            { id: 'fld_files', name: 'Files', type: 'attachment' },
          ],
          sortRules: [],
          loading: false,
          currentPage: 1,
          totalPages: 1,
          startIndex: 0,
          selectedRecordId: null,
          canEdit: true,
          canDelete: false,
          attachmentSummaries: {
            rec_2: {
              fld_files: [
                {
                  id: 'att_a',
                  filename: 'a.pdf',
                  mimeType: 'application/pdf',
                  size: 100,
                  url: '/api/multitable/attachments/att_a',
                  thumbnailUrl: null,
                  uploadedAt: '2026-03-21T10:00:00.000Z',
                },
                {
                  id: 'att_b',
                  filename: 'b.pdf',
                  mimeType: 'application/pdf',
                  size: 120,
                  url: '/api/multitable/attachments/att_b',
                  thumbnailUrl: null,
                  uploadedAt: '2026-03-21T10:01:00.000Z',
                },
              ],
            },
          },
          onPatchCell: patchSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    ;(container.querySelector('.meta-grid__cell') as HTMLTableCellElement | null)
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()

    ;(container.querySelector('.meta-attachment-list__remove') as HTMLButtonElement | null)?.click()
    await flushUi()

    expect(patchSpy).toHaveBeenCalledWith('rec_2', 'fld_files', ['att_b'], 7)

    app.unmount()
    container.remove()
  })
})
