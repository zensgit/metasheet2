import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
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

    expect(container.querySelector('.meta-calendar__mode-select') instanceof HTMLSelectElement).toBe(true)
    expect((container.querySelector('.meta-calendar__mode-select') as HTMLSelectElement).value).toBe('week')

    const weekCells = container.querySelectorAll('.meta-calendar__cell')
    expect(weekCells.length).toBe(7)

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

  it('uses persisted calendar config for week start and end-date spanning', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

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
            weekStartsOn: 1,
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const weekdayLabels = Array.from(container.querySelectorAll('.meta-calendar__weekday')).map((node) => node.textContent?.trim())
    expect(weekdayLabels[0]).toBe('Mon')
    expect(container.querySelector('.meta-calendar__picker')).toBeNull()
    expect(container.textContent?.split('Pilot').length).toBeGreaterThan(2)

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

  it('preserves local calendar draft when parent replays stale viewConfig props', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()
    const originalViewConfig = {
      dateFieldId: 'fld_start',
      endDateFieldId: 'fld_end',
      titleFieldId: 'fld_title',
      defaultView: 'week',
      weekStartsOn: 1,
    }
    const cloneViewConfig = () => ({ ...originalViewConfig })
    const currentViewConfig = ref(cloneViewConfig())

    const app = createApp({
      setup() {
        return () => h(MetaCalendarView, {
          rows: [],
          fields: [
            { id: 'fld_title', name: 'Title', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_due', name: 'Due', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          canCreate: false,
          viewConfig: currentViewConfig.value,
          onUpdateViewConfig: (payload: { config: Record<string, unknown> }) => {
            updateSpy(payload)
            currentViewConfig.value = cloneViewConfig()
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const changeButton = container.querySelector('.meta-calendar__change-btn') as HTMLButtonElement | null
    expect(changeButton).not.toBeNull()
    changeButton!.click()
    await nextTick()
    await nextTick()

    expect(updateSpy.mock.calls[0]?.[0]).toEqual({
      config: {
        dateFieldId: null,
        endDateFieldId: 'fld_end',
        titleFieldId: 'fld_title',
        defaultView: 'week',
        weekStartsOn: 1,
      },
    })
    expect(container.querySelector('.meta-calendar__picker')).not.toBeNull()

    const fieldSelect = container.querySelector('.meta-calendar__picker .meta-calendar__field-select') as HTMLSelectElement | null
    expect(fieldSelect).not.toBeNull()
    fieldSelect!.value = 'fld_due'
    fieldSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    await nextTick()

    expect(updateSpy.mock.calls[1]?.[0]).toEqual({
      config: {
        dateFieldId: 'fld_due',
        endDateFieldId: 'fld_end',
        titleFieldId: 'fld_title',
        defaultView: 'week',
        weekStartsOn: 1,
      },
    })

    const modeSelect = container.querySelector('.meta-calendar__mode-select') as HTMLSelectElement | null
    expect(modeSelect).not.toBeNull()
    modeSelect!.value = 'day'
    modeSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    await nextTick()

    expect(updateSpy.mock.calls[2]?.[0]).toEqual({
      config: {
        dateFieldId: 'fld_due',
        endDateFieldId: 'fld_end',
        titleFieldId: 'fld_title',
        defaultView: 'day',
        weekStartsOn: 1,
      },
    })

    app.unmount()
    container.remove()
  })
})
