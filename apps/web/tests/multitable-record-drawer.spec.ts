import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('MetaRecordDrawer', () => {
  it('edits longText values with a textarea in the drawer', async () => {
    const patchSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: {
            id: 'rec_notes_1',
            version: 1,
            data: {
              fld_notes: 'line 1',
            },
          },
          fields: [
            { id: 'fld_notes', name: 'Notes', type: 'longText' },
          ],
          canEdit: true,
          canComment: false,
          canDelete: false,
          onPatch: patchSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    const textarea = container.querySelector('.meta-record-drawer__textarea') as HTMLTextAreaElement | null
    expect(textarea).not.toBeNull()
    textarea!.value = 'line 1\nline 2'
    textarea!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledWith('fld_notes', 'line 1\nline 2')

    app.unmount()
    container.remove()
  })

  it('uses scoped field permissions to render readonly fields as display-only values', async () => {
    const patchSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: {
            id: 'rec_readonly_1',
            version: 1,
            data: {
              fld_title: 'Locked title',
            },
          },
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
          ],
          canEdit: true,
          canComment: false,
          canDelete: false,
          rowActions: {
            canEdit: true,
            canDelete: false,
            canComment: false,
          },
          fieldPermissions: {
            fld_title: { visible: true, readOnly: true },
          },
          onPatch: patchSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    expect(container.querySelector('.meta-record-drawer__input')).toBeNull()
    expect(container.querySelector('.meta-record-drawer__text')?.textContent).toContain('Locked title')
    expect(patchSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('honors scoped row actions and exposes the workflow entry', async () => {
    const toggleCommentsSpy = vi.fn()
    const openAutomationSpy = vi.fn()
    const patchSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: {
            id: 'rec_scoped_1',
            version: 1,
            data: {
              fld_title: 'Scoped title',
            },
          },
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
          ],
          canEdit: true,
          canComment: true,
          canDelete: true,
          canManageAutomation: true,
          rowActions: {
            canEdit: false,
            canDelete: false,
            canComment: true,
          },
          onPatch: patchSpy,
          onToggleComments: toggleCommentsSpy,
          onOpenAutomation: openAutomationSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    expect(container.querySelector('.meta-record-drawer__input')).toBeNull()
    expect(container.textContent).not.toContain('Delete')
    expect(container.textContent).toContain('Workflow')

    ;(container.querySelector('button[title="Comments"]') as HTMLButtonElement | null)?.click()
    ;(container.querySelector('button[title="Open workflow designer"]') as HTMLButtonElement | null)?.click()
    await flushUi()

    expect(toggleCommentsSpy).toHaveBeenCalledTimes(1)
    expect(openAutomationSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

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

  it('replaces an existing single attachment by patching the new uploaded id', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const uploadFn = vi.fn().mockResolvedValue({
      id: 'att_replace',
      filename: 'replace.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      url: '/api/multitable/attachments/att_replace',
      thumbnailUrl: null,
      uploadedAt: '2026-03-21T12:30:00.000Z',
    })
    const patchSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: {
            id: 'rec_replace_1',
            version: 1,
            data: {
              fld_files: ['att_old'],
            },
          },
          fields: [
            { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 1 } },
          ],
          canEdit: true,
          canComment: false,
          canDelete: false,
          uploadFn,
          attachmentSummariesByField: {
            fld_files: [{
              id: 'att_old',
              filename: 'old.pdf',
              mimeType: 'application/pdf',
              size: 1024,
              url: '/api/multitable/attachments/att_old',
              thumbnailUrl: null,
              uploadedAt: '2026-03-21T12:30:00.000Z',
            }],
          },
          onPatch: patchSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const input = container.querySelector('.meta-record-drawer__file-input') as HTMLInputElement | null
    const file = new File(['replace'], 'replace.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', {
      value: {
        0: file,
        length: 1,
        item: (index: number) => (index === 0 ? file : null),
        [Symbol.iterator]: function* iterator() {
          yield file
        },
      },
      configurable: true,
    })
    input?.dispatchEvent(new Event('change'))
    await flushUi()

    expect(uploadFn).toHaveBeenCalledWith(file, {
      recordId: 'rec_replace_1',
      fieldId: 'fld_files',
    })
    expect(patchSpy).toHaveBeenCalledWith('fld_files', ['att_replace'])

    app.unmount()
    container.remove()
  })
})
