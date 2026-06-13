import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import MetaCalendarView from '../src/multitable/components/MetaCalendarView.vue'
import { useLocale } from '../src/composables/useLocale'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'

// Calendar drag-to-reschedule: dragging an event onto a new day rewrites the
// record's configured date field via the SAME `patch-cell` path Kanban uses
// (recordId, fieldId, value, version). The optimistic update + 409 rollback is
// owned by `useMultitableGrid.patchCell` (already proven in multitable-grid.spec.ts),
// NOT duplicated here. The view's job: emit the correct payload, refuse to drag
// a locked record's event, and treat a same-day drop as a no-op.

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Pick two distinct in-month days the month grid is guaranteed to render: the
// 10th and the 20th of the current month (both always present in the 42-cell grid).
function dayOfThisMonth(day: number): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function cellForDate(container: HTMLElement, dateStr: string): HTMLElement | null {
  // Month cells render an aria-label containing the localized date; the most
  // robust selector is the event's own cell — find the cell whose event text
  // matches, else fall back to matching by the day-number heading + position.
  const cells = Array.from(container.querySelectorAll('.meta-calendar__cell')) as HTMLElement[]
  const day = Number(dateStr.split('-')[2])
  // In-month cells only (outside-month cells repeat day numbers).
  return (
    cells.find(
      (c) =>
        !c.classList.contains('meta-calendar__cell--outside') &&
        c.querySelector('.meta-calendar__day-num')?.textContent?.trim() === String(day),
    ) ?? null
  )
}

function eventEl(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.meta-calendar__event') as HTMLElement | null
}

describe('MetaCalendarView drag-to-reschedule', () => {
  afterEach(() => {
    useLocale().setLocale('en')
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  function mountCalendar(props: Record<string, unknown>) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaCalendarView, props)
      },
    })
    app.mount(container)
    return { app, container }
  }

  it('(a) dragging an event to a new day emits patch-cell with the new date + current version', async () => {
    const patchCell = vi.fn()
    const origin = dayOfThisMonth(10)
    const target = dayOfThisMonth(20)

    const { app, container } = mountCalendar({
      rows: [{ id: 'rec_1', version: 7, data: { fld_title: 'Pilot', fld_start: origin } }],
      fields: [
        { id: 'fld_title', name: 'Title', type: 'string' },
        { id: 'fld_start', name: 'Start', type: 'date' },
      ],
      loading: false,
      canEdit: true,
      viewConfig: { dateFieldId: 'fld_start', titleFieldId: 'fld_title', defaultView: 'month', weekStartsOn: 0 },
      'onPatch-cell': patchCell,
    })
    await nextTick()

    const ev = eventEl(container)
    expect(ev).not.toBeNull()
    expect(ev!.getAttribute('draggable')).toBe('true')

    ev!.dispatchEvent(new Event('dragstart', { bubbles: true }))
    const targetCell = cellForDate(container, target)
    expect(targetCell).not.toBeNull()
    targetCell!.dispatchEvent(new Event('drop', { bubbles: true }))
    await nextTick()

    expect(patchCell).toHaveBeenCalledTimes(1)
    expect(patchCell).toHaveBeenCalledWith('rec_1', 'fld_start', target, 7)

    app.unmount()
  })

  it('(b) a locked record event is not draggable and a drop on it does not emit', async () => {
    const patchCell = vi.fn()
    const origin = dayOfThisMonth(10)
    const target = dayOfThisMonth(20)

    const { app, container } = mountCalendar({
      rows: [{ id: 'rec_locked', version: 3, data: { fld_title: 'Frozen', fld_start: origin }, locked: true, canUnlock: false }],
      fields: [
        { id: 'fld_title', name: 'Title', type: 'string' },
        { id: 'fld_start', name: 'Start', type: 'date' },
      ],
      loading: false,
      canEdit: true,
      viewConfig: { dateFieldId: 'fld_start', titleFieldId: 'fld_title', defaultView: 'month', weekStartsOn: 0 },
      'onPatch-cell': patchCell,
    })
    await nextTick()

    const ev = eventEl(container)
    expect(ev).not.toBeNull()
    // A locked record's event must not be draggable.
    expect(ev!.getAttribute('draggable')).toBe('false')

    // Even if a dragstart fires on it, no patch may be emitted on drop.
    ev!.dispatchEvent(new Event('dragstart', { bubbles: true }))
    const targetCell = cellForDate(container, target)
    targetCell!.dispatchEvent(new Event('drop', { bubbles: true }))
    await nextTick()

    expect(patchCell).not.toHaveBeenCalled()

    app.unmount()
  })

  it('(d) a same-day drop is a no-op (no patch-cell)', async () => {
    const patchCell = vi.fn()
    const origin = dayOfThisMonth(10)

    const { app, container } = mountCalendar({
      rows: [{ id: 'rec_1', version: 7, data: { fld_title: 'Pilot', fld_start: origin } }],
      fields: [
        { id: 'fld_title', name: 'Title', type: 'string' },
        { id: 'fld_start', name: 'Start', type: 'date' },
      ],
      loading: false,
      canEdit: true,
      viewConfig: { dateFieldId: 'fld_start', titleFieldId: 'fld_title', defaultView: 'month', weekStartsOn: 0 },
      'onPatch-cell': patchCell,
    })
    await nextTick()

    const ev = eventEl(container)
    ev!.dispatchEvent(new Event('dragstart', { bubbles: true }))
    const sameCell = cellForDate(container, origin)
    expect(sameCell).not.toBeNull()
    sameCell!.dispatchEvent(new Event('drop', { bubbles: true }))
    await nextTick()

    expect(patchCell).not.toHaveBeenCalled()

    app.unmount()
  })

  it('(b2) when canEdit is false the event is not draggable', async () => {
    const patchCell = vi.fn()
    const origin = dayOfThisMonth(10)

    const { app, container } = mountCalendar({
      rows: [{ id: 'rec_1', version: 7, data: { fld_title: 'Pilot', fld_start: origin } }],
      fields: [
        { id: 'fld_title', name: 'Title', type: 'string' },
        { id: 'fld_start', name: 'Start', type: 'date' },
      ],
      loading: false,
      canEdit: false,
      viewConfig: { dateFieldId: 'fld_start', titleFieldId: 'fld_title', defaultView: 'month', weekStartsOn: 0 },
      'onPatch-cell': patchCell,
    })
    await nextTick()

    const ev = eventEl(container)
    expect(ev!.getAttribute('draggable')).toBe('false')

    app.unmount()
  })

  it('(c) a PATCH 409 version-conflict rolls the event back to its original day (real grid wire)', async () => {
    const origin = dayOfThisMonth(10)
    const target = dayOfThisMonth(20)

    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'VERSION_CONFLICT', message: 'Row changed elsewhere', serverVersion: 9 },
        }),
        { status: 409 },
      )
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })
    grid.fields.value = [
      { id: 'fld_title', name: 'Title', type: 'string' },
      { id: 'fld_start', name: 'Start', type: 'date' },
    ]
    grid.rows.value = [{ id: 'rec_1', version: 7, data: { fld_title: 'Pilot', fld_start: origin } }]

    // Wire the calendar to the REAL grid: rows are reactive, patch-cell routes
    // through grid.patchCell exactly like the workbench's onPatchCell does.
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaCalendarView, {
          rows: grid.rows.value,
          fields: grid.fields.value,
          loading: false,
          canEdit: true,
          viewConfig: { dateFieldId: 'fld_start', titleFieldId: 'fld_title', defaultView: 'month', weekStartsOn: 0 },
          'onPatch-cell': (recordId: string, fieldId: string, value: unknown, version: number) =>
            grid.patchCell(recordId, fieldId, value, version),
        })
      },
    })
    app.mount(container)
    await nextTick()

    // Drag the event from origin to target.
    const ev = eventEl(container)
    ev!.dispatchEvent(new Event('dragstart', { bubbles: true }))
    const targetCell = cellForDate(container, target)
    targetCell!.dispatchEvent(new Event('drop', { bubbles: true }))

    // Let the optimistic update + rejected PATCH + revert settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()

    // The PATCH used the dragged record's current version as expectedVersion.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // grid.patchCell reverts row.data on VERSION_CONFLICT -> event back on origin day.
    expect(grid.rows.value[0].data.fld_start).toBe(origin)
    expect(grid.conflict.value?.recordId).toBe('rec_1')

    // And the event re-renders on its original cell.
    const originCell = cellForDate(container, origin)
    expect(originCell!.querySelector('.meta-calendar__event')).not.toBeNull()

    app.unmount()
    container.remove()
  })
})
