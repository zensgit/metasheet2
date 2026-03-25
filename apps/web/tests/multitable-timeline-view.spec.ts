import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import MetaTimelineView from '../src/multitable/components/MetaTimelineView.vue'

describe('MetaTimelineView', () => {
  it('renders persisted label field and zoom state in the timeline header', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaTimelineView, {
          rows: [
            {
              id: 'rec_1',
              version: 1,
              data: {
                fld_name: 'Roadmap',
                fld_start: '2026-03-01',
                fld_end: '2026-03-05',
              },
            },
          ],
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            labelFieldId: 'fld_name',
            zoom: 'month',
          },
        })
      },
    })

    app.mount(container)
    await nextTick()

    expect(container.textContent).toContain('Roadmap')
    expect(container.querySelector('.meta-timeline__placeholder')).toBeNull()
    expect(container.querySelector('.meta-timeline__bar')).not.toBeNull()
    expect(container.textContent).toContain('Label: Name')
    expect(container.textContent).toContain('Zoom: Month')
    const selects = Array.from(container.querySelectorAll('.meta-timeline__config-select')) as HTMLSelectElement[]
    expect(selects[2]?.value).toBe('fld_name')
    expect(selects[3]?.value).toBe('month')

    app.unmount()
    container.remove()
  })

  it('emits update-view-config when label field or zoom changes', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaTimelineView, {
          rows: [],
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            labelFieldId: 'fld_name',
            zoom: 'week',
          },
          onUpdateViewConfig: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const selects = Array.from(container.querySelectorAll('.meta-timeline__config-select')) as HTMLSelectElement[]
    const labelSelect = selects[2]
    const zoomSelect = selects[3]

    labelSelect.value = ''
    labelSelect.dispatchEvent(new Event('change', { bubbles: true }))
    zoomSelect.value = 'day'
    zoomSelect.dispatchEvent(new Event('change', { bubbles: true }))

    expect(updateSpy).toHaveBeenCalled()
    expect(updateSpy.mock.calls[0][0]).toMatchObject({
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: null,
        zoom: 'week',
      },
    })
    expect(updateSpy.mock.calls[1][0]).toMatchObject({
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: null,
        zoom: 'day',
      },
    })

    app.unmount()
    container.remove()
  })

  it('emits patch-dates when a bar is dropped to a new position', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const patchSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaTimelineView, {
          rows: [
            {
              id: 'rec_1',
              version: 3,
              data: {
                fld_name: 'Roadmap',
                fld_start: '2026-03-01',
                fld_end: '2026-03-03',
              },
            },
          ],
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          canEdit: true,
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            labelFieldId: 'fld_name',
            zoom: 'week',
          },
          onPatchDates: patchSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const bar = container.querySelector('.meta-timeline__bar') as HTMLDivElement | null
    const barArea = container.querySelector('.meta-timeline__bar-area') as HTMLDivElement | null
    expect(bar).not.toBeNull()
    expect(barArea).not.toBeNull()

    Object.defineProperty(barArea!, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 200, top: 0, height: 24, right: 200, bottom: 24 }),
    })

    bar?.dispatchEvent(new Event('dragstart', { bubbles: true }))
    barArea?.dispatchEvent(new MouseEvent('drop', { bubbles: true, clientX: 100 }))

    expect(patchSpy).toHaveBeenCalledTimes(1)
    expect(patchSpy.mock.calls[0][0]).toMatchObject({
      recordId: 'rec_1',
      version: 3,
      startFieldId: 'fld_start',
      endFieldId: 'fld_end',
    })

    app.unmount()
    container.remove()
  })

  it('emits create-record with seeded start and end dates from timeline quick create', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const createSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaTimelineView, {
          rows: [],
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          canCreate: true,
          viewConfig: {
            startFieldId: 'fld_start',
            endFieldId: 'fld_end',
            labelFieldId: 'fld_name',
            zoom: 'week',
          },
          onCreateRecord: createSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const button = container.querySelector('.meta-timeline__create-btn') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    button!.click()

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const iso = today.toISOString().slice(0, 10)
    expect(createSpy).toHaveBeenCalledWith({
      fld_start: iso,
      fld_end: iso,
    })

    app.unmount()
    container.remove()
  })

  it('preserves local timeline draft when parent replays stale viewConfig props', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()
    const originalViewConfig = {
      startFieldId: 'fld_start',
      endFieldId: 'fld_end',
      labelFieldId: 'fld_name',
      zoom: 'week',
    }
    const cloneViewConfig = () => ({ ...originalViewConfig })
    const currentViewConfig = ref(cloneViewConfig())

    const app = createApp({
      setup() {
        return () => h(MetaTimelineView, {
          rows: [],
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
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

    const selects = Array.from(container.querySelectorAll('.meta-timeline__config-select')) as HTMLSelectElement[]
    const labelSelect = selects[2]
    const zoomSelect = selects[3]

    labelSelect.value = ''
    labelSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    await nextTick()

    expect(updateSpy.mock.calls[0]?.[0]).toEqual({
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: null,
        zoom: 'week',
      },
    })

    zoomSelect.value = 'day'
    zoomSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    await nextTick()

    expect(updateSpy.mock.calls[1]?.[0]).toEqual({
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: null,
        zoom: 'day',
      },
    })

    app.unmount()
    container.remove()
  })
})
