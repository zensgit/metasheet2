import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaKanbanView from '../src/multitable/components/MetaKanbanView.vue'
import { useLocale } from '../src/composables/useLocale'

describe('MetaKanbanView', () => {
  afterEach(() => {
    useLocale().setLocale('en')
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

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

  it('localizes kanban chrome while keeping option values and card titles raw', async () => {
    useLocale().setLocale('zh-CN')
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
                fld_note: 'Raw note',
              },
            },
          ],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Doing', color: '#409eff' }] },
            { id: 'fld_note', name: 'Note', type: 'string' },
          ],
          loading: false,
          canCreate: true,
          canEdit: true,
          canComment: true,
          viewConfig: {
            groupFieldId: 'fld_status',
            cardFieldIds: ['fld_note'],
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('分组')
    expect(container.textContent).toContain('分组依据：')
    expect(container.textContent).toContain('卡片字段（1）')
    expect(container.textContent).toContain('未分类')
    expect(container.textContent).toContain('+ 添加记录')
    expect(container.textContent).toContain('+ 添加')
    expect(container.textContent).toContain('Doing')
    expect(container.textContent).toContain('Pilot card')
    expect(container.textContent).toContain('Raw note')
    expect(container.querySelector('.meta-kanban__comment-btn')?.getAttribute('aria-label')).toBe('打开 Pilot card 的评论')
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(3)
    expect(container.querySelectorAll('[title]')).toHaveLength(0)
    expect(container.querySelectorAll('[placeholder]')).toHaveLength(0)

    app.unmount()
  })

  const swimlaneFields = [
    { id: 'fld_title', name: 'Title', type: 'string' },
    { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Todo', color: '#aaa' }, { value: 'Doing', color: '#409eff' }] },
    { id: 'fld_priority', name: 'Priority', type: 'select', options: [{ value: 'P1', color: '#f56c6c' }, { value: 'P2', color: '#67c23a' }] },
  ]
  const swimlaneRows = [
    { id: 'rec_1', version: 1, data: { fld_title: 'A', fld_status: 'Doing', fld_priority: 'P1' } },
    { id: 'rec_2', version: 1, data: { fld_title: 'B', fld_status: 'Todo', fld_priority: 'P2' } },
  ]

  function mountKanban(props: Record<string, unknown>) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render() { return h(MetaKanbanView, props) } })
    app.mount(container)
    return { container, app }
  }

  it('backward-compat: no swimlaneFieldId renders a single-dimension board (no swimlane headers)', async () => {
    const { container, app } = mountKanban({
      rows: swimlaneRows, fields: swimlaneFields, loading: false,
      viewConfig: { groupFieldId: 'fld_status', cardFieldIds: [] },
    })
    await nextTick()
    expect(container.querySelector('.meta-kanban__board--swimlaned')).toBeNull()
    expect(container.querySelectorAll('.meta-kanban__swimlane-header')).toHaveLength(0)
    // one implicit lane → one strip of columns (uncategorized + Todo + Doing)
    expect(container.querySelectorAll('.meta-kanban__swimlane')).toHaveLength(1)
    expect(container.querySelectorAll('.meta-kanban__column')).toHaveLength(3)
    app.unmount(); container.remove()
  })

  it('swimlane mode renders a row per swimlane option, each with the column layout', async () => {
    const { container, app } = mountKanban({
      rows: swimlaneRows, fields: swimlaneFields, loading: false,
      viewConfig: { groupFieldId: 'fld_status', swimlaneFieldId: 'fld_priority', cardFieldIds: [] },
    })
    await nextTick()
    expect(container.querySelector('.meta-kanban__board--swimlaned')).not.toBeNull()
    const headers = Array.from(container.querySelectorAll('.meta-kanban__swimlane-label')).map((el) => el.textContent)
    expect(headers).toEqual(['P1', 'P2'])
    // 2 swimlanes × 3 columns (uncategorized + Todo + Doing) each
    expect(container.querySelectorAll('.meta-kanban__swimlane')).toHaveLength(2)
    expect(container.querySelectorAll('.meta-kanban__column')).toHaveLength(6)
    expect(container.textContent).toContain('A')
    expect(container.textContent).toContain('B')
    app.unmount(); container.remove()
  })

  it('create-in-cell prefills BOTH the column field and the swimlane field', async () => {
    const createSpy = vi.fn()
    const { container, app } = mountKanban({
      rows: swimlaneRows, fields: swimlaneFields, loading: false, canCreate: true,
      viewConfig: { groupFieldId: 'fld_status', swimlaneFieldId: 'fld_priority', cardFieldIds: [] },
      onCreateRecord: createSpy,
    })
    await nextTick()
    // swimlane[0] = P1; its columns = [uncategorized, Todo, Doing]; the last add button = the Doing cell.
    const lane0 = container.querySelectorAll('.meta-kanban__swimlane')[0]
    const addButtons = lane0.querySelectorAll('.meta-kanban__add-btn')
    ;(addButtons[addButtons.length - 1] as HTMLButtonElement).click()
    await nextTick()
    expect(createSpy).toHaveBeenCalledWith({ fld_status: 'Doing', fld_priority: 'P1' })
    app.unmount(); container.remove()
  })
})
