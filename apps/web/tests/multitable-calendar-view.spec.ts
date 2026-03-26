import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCalendarView from '../src/multitable/components/MetaCalendarView.vue'

function isoDate(offsetDays = 0): string {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

describe('MetaCalendarView', () => {
  it('renders persisted default view and emits config changes when switching modes', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateViewConfig = vi.fn()

    const app = createApp({
      render() {
        return h(MetaCalendarView, {
          rows: [
            {
              id: 'rec_1',
              version: 1,
              data: {
                fld_title: 'Pilot',
                fld_start: isoDate(0),
                fld_end: isoDate(1),
              },
            },
          ],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          canCreate: true,
          viewConfig: {
            dateFieldId: 'fld_start',
            endDateFieldId: 'fld_end',
            titleFieldId: 'fld_title',
            defaultView: 'week',
            weekStartsOn: 1,
          },
          onUpdateViewConfig: updateViewConfig,
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect((container.querySelector('.meta-calendar__mode-select') as HTMLSelectElement).value).toBe('week')
    expect(container.querySelectorAll('.meta-calendar__cell').length).toBe(7)

    const modeSelect = container.querySelector('.meta-calendar__mode-select') as HTMLSelectElement
    modeSelect.value = 'day'
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(updateViewConfig).toHaveBeenCalledWith({
      config: expect.objectContaining({
        dateFieldId: 'fld_start',
        endDateFieldId: 'fld_end',
        titleFieldId: 'fld_title',
        defaultView: 'day',
        weekStartsOn: 1,
      }),
    })
    expect(container.querySelector('.meta-calendar__day-view')).not.toBeNull()

    app.unmount()
    container.remove()
  })

  it('emits quick-create payload with start and end dates from the visible anchor day', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const createSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaCalendarView, {
          rows: [],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          canCreate: true,
          viewConfig: {
            dateFieldId: 'fld_start',
            endDateFieldId: 'fld_end',
            titleFieldId: 'fld_title',
            defaultView: 'day',
          },
          onCreateRecord: createSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const button = container.querySelector('.meta-calendar__create-btn') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    button!.click()

    const today = new Date()
    const expectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    expect(createSpy).toHaveBeenCalledWith({
      fld_start: expectedDate,
      fld_end: expectedDate,
    })

    app.unmount()
    container.remove()
  })
})
