import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import MetaCalendarView from '../src/multitable/components/MetaCalendarView.vue'
import MetaGalleryView from '../src/multitable/components/MetaGalleryView.vue'
import MetaKanbanView from '../src/multitable/components/MetaKanbanView.vue'
import MetaTimelineView from '../src/multitable/components/MetaTimelineView.vue'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('multitable non-grid summary rendering', () => {
  it('renders link summaries inside kanban preview fields', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp(defineComponent({
      render() {
        return h(MetaKanbanView, {
          rows: [{
            id: 'rec_1',
            version: 1,
            data: {
              fld_status: 'Open',
              fld_owner: ['usr_1'],
            },
          }],
          fields: [
            { id: 'fld_status', name: 'Status', type: 'select', options: [{ value: 'Open' }] },
            { id: 'fld_owner', name: 'Owner', type: 'link' },
          ],
          loading: false,
          canCreate: false,
          canEdit: false,
          linkSummaries: {
            rec_1: {
              fld_owner: [{ id: 'usr_1', display: 'Amy Wong' }],
            },
          },
          onSelectRecord: () => {},
          onPatchCell: () => {},
          onCreateRecord: () => {},
        })
      },
    }))

    app.mount(container)
    const select = container.querySelector('.meta-kanban__field-select') as HTMLSelectElement | null
    expect(select).toBeTruthy()
    if (select) {
      select.value = 'fld_status'
      select.dispatchEvent(new Event('change'))
    }
    await flushUi()

    expect(container.textContent).toContain('Amy Wong')
    expect(container.textContent).not.toContain('usr_1')

    app.unmount()
    container.remove()
  })

  it('renders attachment filenames inside gallery cards', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp(defineComponent({
      render() {
        return h(MetaGalleryView, {
          rows: [{
            id: 'rec_1',
            version: 1,
            data: {
              fld_title: 'Spec',
              fld_files: ['att_1'],
            },
          }],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_files', name: 'Files', type: 'attachment' },
          ],
          loading: false,
          currentPage: 1,
          totalPages: 1,
          attachmentSummaries: {
            rec_1: {
              fld_files: [{
                id: 'att_1',
                filename: 'brief.pdf',
                mimeType: 'application/pdf',
                size: 123,
                url: 'https://files.example.com/brief.pdf',
                thumbnailUrl: null,
                uploadedAt: '2026-03-25T00:00:00.000Z',
              }],
            },
          },
          onSelectRecord: () => {},
          onGoToPage: () => {},
        })
      },
    }))

    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('brief.pdf')
    expect(container.textContent).not.toContain('att_1')
    expect(container.querySelector('.meta-attachment-list')).toBeTruthy()

    app.unmount()
    container.remove()
  })

  it('renders link summaries in calendar event titles', async () => {
    const currentMonthDate = new Date()
    const dateValue = `${currentMonthDate.getFullYear()}-${String(currentMonthDate.getMonth() + 1).padStart(2, '0')}-${String(Math.max(1, Math.min(28, currentMonthDate.getDate()))).padStart(2, '0')}`
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp(defineComponent({
      render() {
        return h(MetaCalendarView, {
          rows: [{
            id: 'rec_1',
            version: 1,
            data: {
              fld_owner: ['usr_1'],
              fld_due: dateValue,
            },
          }],
          fields: [
            { id: 'fld_owner', name: 'Owner', type: 'link' },
            { id: 'fld_due', name: 'Due', type: 'date' },
          ],
          loading: false,
          canCreate: false,
          linkSummaries: {
            rec_1: {
              fld_owner: [{ id: 'usr_1', display: 'Amy Wong' }],
            },
          },
          onSelectRecord: () => {},
          onCreateRecord: () => {},
        })
      },
    }))

    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('Amy Wong')
    expect(container.textContent).not.toContain('usr_1')

    app.unmount()
    container.remove()
  })

  it('renders attachment previews in calendar events when the title field is an attachment', async () => {
    const currentMonthDate = new Date()
    const dateValue = `${currentMonthDate.getFullYear()}-${String(currentMonthDate.getMonth() + 1).padStart(2, '0')}-${String(Math.max(1, Math.min(28, currentMonthDate.getDate()))).padStart(2, '0')}`
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp(defineComponent({
      render() {
        return h(MetaCalendarView, {
          rows: [{
            id: 'rec_attachments',
            version: 1,
            data: {
              fld_files: ['att_1'],
              fld_due: dateValue,
            },
          }],
          fields: [
            { id: 'fld_files', name: 'Files', type: 'attachment' },
            { id: 'fld_due', name: 'Due', type: 'date' },
          ],
          loading: false,
          canCreate: false,
          attachmentSummaries: {
            rec_attachments: {
              fld_files: [{
                id: 'att_1',
                filename: 'brief.pdf',
                mimeType: 'application/pdf',
                size: 200,
                url: 'https://files.example.com/brief.pdf',
                thumbnailUrl: null,
                uploadedAt: '2026-03-25T00:00:00.000Z',
              }],
            },
          },
          onSelectRecord: () => {},
          onCreateRecord: () => {},
        })
      },
    }))

    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('brief.pdf')
    expect(container.querySelector('.meta-calendar__event-attachments')).toBeTruthy()

    app.unmount()
    container.remove()
  })

  it('renders link summaries in timeline labels', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp(defineComponent({
      render() {
        return h(MetaTimelineView, {
          rows: [{
            id: 'rec_1',
            version: 1,
            data: {
              fld_owner: ['usr_1'],
              fld_start: '2026-03-25',
              fld_end: '2026-03-26',
            },
          }],
          fields: [
            { id: 'fld_owner', name: 'Owner', type: 'link' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          linkSummaries: {
            rec_1: {
              fld_owner: [{ id: 'usr_1', display: 'Amy Wong' }],
            },
          },
          onSelectRecord: () => {},
        })
      },
    }))

    app.mount(container)
    const selects = Array.from(container.querySelectorAll('.meta-timeline__config-select')) as HTMLSelectElement[]
    expect(selects).toHaveLength(4)
    selects[0]!.value = 'fld_start'
    selects[0]!.dispatchEvent(new Event('change'))
    selects[1]!.value = 'fld_end'
    selects[1]!.dispatchEvent(new Event('change'))
    await flushUi()

    expect(container.textContent).toContain('Amy Wong')
    expect(container.textContent).not.toContain('usr_1')

    app.unmount()
    container.remove()
  })

  it('renders attachment previews in timeline labels', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp(defineComponent({
      render() {
        return h(MetaTimelineView, {
          rows: [{
            id: 'rec_attach_timeline',
            version: 1,
            data: {
              fld_files: ['att_1'],
              fld_start: '2026-03-25',
              fld_end: '2026-03-26',
            },
          }],
          fields: [
            { id: 'fld_files', name: 'Files', type: 'attachment' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          attachmentSummaries: {
            rec_attach_timeline: {
              fld_files: [{
                id: 'att_1',
                filename: 'roadmap.pdf',
                mimeType: 'application/pdf',
                size: 200,
                url: 'https://files.example.com/roadmap.pdf',
                thumbnailUrl: null,
                uploadedAt: '2026-03-25T00:00:00.000Z',
              }],
            },
          },
          onSelectRecord: () => {},
        })
      },
    }))

    app.mount(container)
    const selects = Array.from(container.querySelectorAll('.meta-timeline__config-select')) as HTMLSelectElement[]
    expect(selects).toHaveLength(4)
    selects[0]!.value = 'fld_start'
    selects[0]!.dispatchEvent(new Event('change'))
    selects[1]!.value = 'fld_end'
    selects[1]!.dispatchEvent(new Event('change'))
    await flushUi()

    expect(container.textContent).toContain('roadmap.pdf')
    expect(container.querySelector('.meta-attachment-list')).toBeTruthy()

    app.unmount()
    container.remove()
  })
})
