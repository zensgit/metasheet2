import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
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

    const groupSelect = container.querySelector('.meta-kanban__header .meta-kanban__field-select') as HTMLSelectElement | null
    expect(groupSelect).not.toBeNull()
    groupSelect!.value = 'fld_priority'
    groupSelect!.dispatchEvent(new Event('change'))
    await nextTick()

    expect(updateSpy.mock.calls[1]?.[0]).toEqual({
      config: {
        groupFieldId: 'fld_priority',
        cardFieldIds: [],
      },
      groupInfo: { fieldId: 'fld_priority' },
    })

    groupSelect!.value = ''
    groupSelect!.dispatchEvent(new Event('change'))
    await nextTick()

    expect(updateSpy.mock.calls[2]?.[0]).toEqual({
      config: {
        groupFieldId: null,
        cardFieldIds: [],
      },
      groupInfo: {},
    })

    app.unmount()
    container.remove()
  })

  it('preserves explicit empty card-field config while rendering fallback fields', async () => {
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
                fld_title: 'Fallback card',
                fld_status: 'Doing',
                fld_priority: 'P1',
                fld_owner: ['user_1'],
              },
            },
          ],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Doing', color: '#409eff' }] },
            { id: 'fld_priority', name: 'Priority', type: 'select', options: [{ value: 'P1', color: '#f56c6c' }] },
            { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user', limitSingleRecord: true } },
          ],
          loading: false,
          canCreate: false,
          canEdit: false,
          viewConfig: {
            groupFieldId: 'fld_priority',
            cardFieldIds: [],
          },
          linkSummaries: {
            rec_1: {
              fld_owner: [{ id: 'user_1', display: 'Jamie' }],
            },
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.querySelectorAll('.meta-kanban__field-picker-item input:checked')).toHaveLength(0)
    expect(container.textContent).toContain('Status:')
    expect(container.textContent).toContain('Jamie')

    app.unmount()
    container.remove()
  })

  it('emits create-record from kanban empty state when grouping is not configured', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const createSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaKanbanView, {
          rows: [],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Todo', color: '#aaa' }] },
          ],
          loading: false,
          canCreate: true,
          canEdit: false,
          viewConfig: {
            groupFieldId: null,
            cardFieldIds: [],
          },
          onCreateRecord: createSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.querySelector('.meta-kanban__empty')).not.toBeNull()
    const createButton = container.querySelector('.meta-kanban__header-add') as HTMLButtonElement | null
    expect(createButton).not.toBeNull()
    createButton!.click()

    expect(createSpy).toHaveBeenCalledWith({})

    app.unmount()
    container.remove()
  })

  it('preserves local kanban draft when parent replays stale props after clear and reselect', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()
    const originalViewConfig = {
      groupFieldId: 'fld_status',
      cardFieldIds: ['fld_owner', 'fld_files'],
    }
    const originalGroupInfo = { fieldId: 'fld_status' }
    const cloneViewConfig = () => ({
      ...originalViewConfig,
      cardFieldIds: [...originalViewConfig.cardFieldIds],
    })
    const currentViewConfig = ref(cloneViewConfig())
    const currentGroupInfo = ref({ ...originalGroupInfo })

    const app = createApp({
      setup() {
        return () => h(MetaKanbanView, {
          rows: [],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Todo', color: '#aaa' }] },
            { id: 'fld_priority', name: 'Priority', type: 'select', options: [{ value: 'P1', color: '#f56c6c' }] },
            { id: 'fld_owner', name: 'Owner', type: 'link', property: { refKind: 'user' } },
            { id: 'fld_files', name: 'Files', type: 'attachment' },
          ],
          loading: false,
          canCreate: false,
          canEdit: true,
          viewConfig: currentViewConfig.value,
          groupInfo: currentGroupInfo.value,
          onUpdateViewConfig: (payload: { config: Record<string, unknown>; groupInfo?: Record<string, unknown> }) => {
            updateSpy(payload)
            currentViewConfig.value = cloneViewConfig()
            currentGroupInfo.value = { ...originalGroupInfo }
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const initialGroupSelect = container.querySelector('.meta-kanban__header .meta-kanban__field-select') as HTMLSelectElement | null
    expect(initialGroupSelect).not.toBeNull()
    initialGroupSelect!.value = ''
    initialGroupSelect!.dispatchEvent(new Event('change'))
    await nextTick()
    await nextTick()

    expect(updateSpy.mock.calls[0]?.[0]).toEqual({
      config: {
        groupFieldId: null,
        cardFieldIds: ['fld_owner', 'fld_files'],
      },
      groupInfo: {},
    })
    expect(container.querySelector('.meta-kanban__empty')).not.toBeNull()

    const emptyStateSelect = container.querySelector('.meta-kanban__empty .meta-kanban__field-select') as HTMLSelectElement | null
    expect(emptyStateSelect).not.toBeNull()
    emptyStateSelect!.value = 'fld_priority'
    emptyStateSelect!.dispatchEvent(new Event('change'))
    await nextTick()
    await nextTick()

    expect(updateSpy.mock.calls[1]?.[0]).toEqual({
      config: {
        groupFieldId: 'fld_priority',
        cardFieldIds: ['fld_owner', 'fld_files'],
      },
      groupInfo: { fieldId: 'fld_priority' },
    })

    const filesCheckbox = Array.from(container.querySelectorAll('.meta-kanban__field-picker-item')).find((item) =>
      item.textContent?.includes('Files'),
    )?.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(filesCheckbox).not.toBeNull()
    filesCheckbox!.checked = false
    filesCheckbox!.dispatchEvent(new Event('change'))
    await nextTick()
    await nextTick()

    expect(updateSpy.mock.calls[2]?.[0]).toEqual({
      config: {
        groupFieldId: 'fld_priority',
        cardFieldIds: ['fld_owner'],
      },
      groupInfo: { fieldId: 'fld_priority' },
    })

    app.unmount()
    container.remove()
  })
})
