import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaTimelineView from '../src/multitable/components/MetaTimelineView.vue'
import { useLocale } from '../src/composables/useLocale'
import { resetBusinessTimezone } from '../src/multitable/utils/business-timezone'

describe('MetaTimelineView', () => {
  afterEach(() => {
    useLocale().setLocale('en')
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

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

  it('localizes timeline chrome and preserves raw field and record labels', async () => {
    useLocale().setLocale('zh-CN')
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
          canCreate: true,
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

    expect(container.querySelector('.meta-timeline')?.getAttribute('aria-label')).toBe('时间轴视图')
    expect(container.textContent).toContain('开始日期')
    expect(container.textContent).toContain('结束日期')
    expect(container.textContent).toContain('标签：Name')
    expect(container.textContent).toContain('缩放: 月')
    expect(container.textContent).toContain('Roadmap')
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(2)
    expect(container.querySelectorAll('[title]')).toHaveLength(1)
    expect(container.querySelectorAll('[placeholder]')).toHaveLength(0)

    app.unmount()
  })

  // #6181 (the rule #6178 applies to `date` cells): the bar title names the day a `date` value shows — a stored
  // INSTANT on its business-timezone day (Asia/Shanghai default: `2026-09-17T16:00:00.000Z` is 09-18), never the
  // UTC day of the instant (09-17); a day as written keeps its day and its bar position.
  it('#6181: date start / end holding instants title and place the bar on their business-timezone days', async () => {
    resetBusinessTimezone()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaTimelineView, {
          rows: [
            { id: 'rec_instant', version: 1, data: { fld_name: 'PLM refresh', fld_start: '2026-09-17T16:00:00.000Z', fld_end: '2026-09-19T16:00:00.000Z' } },
            { id: 'rec_written', version: 1, data: { fld_name: 'Written days', fld_start: '2026-09-18', fld_end: '2026-09-20' } },
          ],
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          loading: false,
          viewConfig: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_name', zoom: 'week' },
        })
      },
    })

    app.mount(container)
    await nextTick()

    const bars = Array.from(container.querySelectorAll('.meta-timeline__bar')) as HTMLElement[]
    expect(bars).toHaveLength(2)
    expect(bars.map((bar) => bar.getAttribute('title'))).toEqual([
      '2026-09-18 → 2026-09-20', // the instants — UTC days would be 2026-09-17 → 2026-09-19
      '2026-09-18 → 2026-09-20', // the days as written
    ])
    expect(bars[0]!.getAttribute('style')).toBe(bars[1]!.getAttribute('style'))

    app.unmount()
  })
})
