import { createApp, h, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MetaGanttView from '../src/multitable/components/MetaGanttView.vue'
import { resolveGanttViewConfig } from '../src/multitable/utils/view-config'

describe('MetaGanttView', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('resolves sensible defaults from date, title, progress and group fields', () => {
    const config = resolveGanttViewConfig([
      { id: 'fld_name', name: 'Name', type: 'string' },
      { id: 'fld_start', name: 'Start', type: 'date' },
      { id: 'fld_end', name: 'End', type: 'date' },
      { id: 'fld_progress', name: 'Progress', type: 'number' },
      { id: 'fld_status', name: 'Status', type: 'select' },
    ])

    expect(config).toEqual({
      startFieldId: 'fld_start',
      endFieldId: 'fld_end',
      titleFieldId: 'fld_name',
      progressFieldId: 'fld_progress',
      groupFieldId: null,
      zoom: 'week',
    })
  })

  it('renders grouped task bars and emits record selection', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const selectSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaGanttView, {
          loading: false,
          canCreate: true,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_progress', name: 'Progress', type: 'number' },
            { id: 'fld_status', name: 'Status', type: 'select' },
          ],
          rows: [
            {
              id: 'rec_1',
              version: 1,
              data: {
                fld_name: 'Design',
                fld_start: '2026-04-01',
                fld_end: '2026-04-10',
                fld_progress: 60,
                fld_status: 'Open',
              },
            },
          ],
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            titleFieldId: 'fld_name',
            progressFieldId: 'fld_progress',
            groupFieldId: 'fld_status',
          },
          groupInfo: { fieldId: 'fld_status' },
          onSelectRecord: selectSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('Open')
    expect(container.textContent).toContain('Design')
    expect(container.querySelector('.meta-gantt__bar-progress')?.getAttribute('style')).toContain('width: 60%')

    ;(container.querySelector('.meta-gantt__row') as HTMLButtonElement).click()
    await nextTick()

    expect(selectSpy).toHaveBeenCalledWith('rec_1')

    app.unmount()
  })

  it('emits persisted Gantt config and groupInfo from toolbar changes', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaGanttView, {
          loading: false,
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_status', name: 'Status', type: 'select' },
          ],
          rows: [],
          viewConfig: { startFieldId: 'fld_start', endFieldId: 'fld_end' },
          onUpdateViewConfig: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const controls = Array.from(container.querySelectorAll('.meta-gantt__control select')) as HTMLSelectElement[]
    const groupSelect = controls[4]
    groupSelect.value = 'fld_status'
    groupSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith({
      config: expect.objectContaining({ groupFieldId: 'fld_status' }),
      groupInfo: { fieldId: 'fld_status' },
    })

    app.unmount()
  })
})
