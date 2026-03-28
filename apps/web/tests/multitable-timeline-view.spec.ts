import { describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
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

    app.unmount()
    container.remove()
  })

  it('emits update-view-config and patch-dates from timeline interactions', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()
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
          onUpdateViewConfig: updateSpy,
          onPatchDates: patchSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const selects = Array.from(container.querySelectorAll('.meta-timeline__config-select')) as HTMLSelectElement[]
    selects[3]!.value = 'day'
    selects[3]!.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith({
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: 'fld_name',
        zoom: 'day',
      },
    })

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
})
