import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaKanbanView from '../src/multitable/components/MetaKanbanView.vue'

describe('MetaKanbanView', () => {
  it('renders people and attachment summaries with persisted card field config', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaKanbanView, {
          rows: [
            {
              id: 'rec_1',
              version: 1,
              data: {
                fld_title: 'Pilot card',
                fld_status: 'Doing',
                fld_owner: ['user_1'],
                fld_files: ['att_1'],
              },
            },
          ],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Doing', color: '#409eff' }] },
            { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', limitSingleRecord: true } },
            { id: 'fld_files', name: 'Files', type: 'attachment' },
          ],
          loading: false,
          canCreate: false,
          canEdit: false,
          viewConfig: {
            groupFieldId: 'fld_status',
            cardFieldIds: ['fld_owner', 'fld_files'],
          },
          linkSummaries: {
            rec_1: {
              fld_owner: [{ id: 'user_1', display: 'Jamie' }],
            },
          },
          attachmentSummaries: {
            rec_1: {
              fld_files: [{
                id: 'att_1',
                filename: 'plan.pdf',
                mimeType: 'application/pdf',
                size: 1200,
                url: '/api/multitable/attachments/att_1',
                thumbnailUrl: null,
                uploadedAt: '2026-03-22T09:00:00.000Z',
              }],
            },
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('Pilot card')
    expect(container.textContent).toContain('Jamie')
    expect(container.textContent).toContain('plan.pdf')

    app.unmount()
    container.remove()
  })

  it('emits quick kanban config changes for group and card fields', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaKanbanView, {
          rows: [],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Todo', color: '#aaa' }] },
            { id: 'fld_priority', name: 'Priority', type: 'select', options: [{ value: 'P1', color: '#f56c6c' }] },
            { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user' } },
          ],
          loading: false,
          canCreate: false,
          canEdit: true,
          viewConfig: {
            groupFieldId: 'fld_status',
            cardFieldIds: ['fld_owner'],
          },
          onUpdateViewConfig: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const checkbox = Array.from(container.querySelectorAll('.meta-kanban__field-picker-item')).find((item) =>
      item.textContent?.includes('Owner'),
    )?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(checkbox).not.toBeNull()
    checkbox!.checked = false
    checkbox!.dispatchEvent(new Event('change'))
    await nextTick()

    expect(updateSpy.mock.calls[0]?.[0]).toEqual({
      config: {
        groupFieldId: 'fld_status',
        cardFieldIds: [],
      },
      groupInfo: { fieldId: 'fld_status' },
    })

    app.unmount()
    container.remove()
  })
})
