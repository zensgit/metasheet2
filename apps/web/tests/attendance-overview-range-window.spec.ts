import { createApp, defineComponent, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import OverviewRangeNotice from '../src/views/attendance/OverviewRangeNotice.vue'
import AttendanceEmployeeWorkspace from '../src/views/attendance/AttendanceEmployeeWorkspace.vue'
import { buildEmployeeWorkspaceProps } from '../verification/attendance-employee-overview-first-viewport-fixtures'
import {
  OVERVIEW_ANOMALIES_PAGE_FLOOR,
  OVERVIEW_API_PAGE_SIZE_CAP,
  OVERVIEW_RECORDS_PAGE_FLOOR,
  OVERVIEW_REQUESTS_PAGE_FLOOR,
  REPORT_RECORDS_PAGE_SIZE,
  inclusiveDaySpan,
  nextOverviewPage,
  overviewRangeNotice,
  overviewWindowPageSize,
  readPagedPayload,
  reduceOverviewPage,
} from '../src/views/attendance/overviewRangeWindow'

const en = (english: string, _zh: string) => english

function pageOf<T>(incoming: T[], input: {
  page?: number
  pageSize: number
  total: number
  append?: boolean
  previousItems?: T[]
  previousFetched?: number
  keyOf: (item: T) => string
}) {
  return reduceOverviewPage({
    previousItems: input.previousItems ?? [],
    previousFetched: input.previousFetched ?? 0,
    incoming,
    page: input.page ?? 1,
    pageSize: input.pageSize,
    total: input.total,
    append: input.append ?? false,
    keyOf: input.keyOf,
  })
}

describe('overview range window', () => {
  it('covers a default 31-day record range that pageSize 20 would clip', () => {
    expect(inclusiveDaySpan('2026-08-24', '2026-09-23')).toBe(31)
    expect(overviewWindowPageSize('2026-08-24', '2026-09-23', OVERVIEW_RECORDS_PAGE_FLOOR)).toBe(31)
    expect(overviewWindowPageSize('2026-09-01', '2026-09-30', OVERVIEW_RECORDS_PAGE_FLOOR)).toBe(31)
    expect(REPORT_RECORDS_PAGE_SIZE).toBe(20)

    const records = Array.from({ length: 25 }, (_, index) => ({
      work_date: `2026-08-${String(index + 1).padStart(2, '0')}`,
    }))
    const covered = pageOf(records, {
      pageSize: overviewWindowPageSize('2026-08-24', '2026-09-23', OVERVIEW_RECORDS_PAGE_FLOOR),
      total: 25,
      keyOf: item => item.work_date,
    })
    expect(covered.window.truncated).toBe(false)
    expect(covered.items).toHaveLength(25)
    expect(overviewRangeNotice('records', covered.window)).toBeNull()
    expect(nextOverviewPage(covered.window)).toBeNull()

    const clipped = pageOf(records.slice(0, REPORT_RECORDS_PAGE_SIZE), {
      pageSize: REPORT_RECORDS_PAGE_SIZE,
      total: 25,
      keyOf: item => item.work_date,
    })
    expect(clipped.window.truncated).toBe(true)
    expect(overviewRangeNotice('records', clipped.window)?.en).toContain('20 of 25')
    expect(overviewRangeNotice('records', clipped.window)?.en).toContain('missing from the grid')
    expect(overviewRangeNotice('records', clipped.window)?.zh).toContain('未出现在格子上')
  })

  it('caps a year of records at the API max and clears the notice after the next page', () => {
    expect(overviewWindowPageSize('2026-01-01', '2026-12-31', OVERVIEW_RECORDS_PAGE_FLOOR)).toBe(OVERVIEW_API_PAGE_SIZE_CAP)
    expect(inclusiveDaySpan('2026-02-01', '2026-02-28')).toBe(28)
    expect(inclusiveDaySpan('2026-09-23', '2026-09-01')).toBeNull()
    expect(inclusiveDaySpan('2026-02-31', '2026-03-01')).toBeNull()
    expect(overviewWindowPageSize('not-a-date', '2026-09-23', OVERVIEW_RECORDS_PAGE_FLOOR)).toBe(OVERVIEW_RECORDS_PAGE_FLOOR)

    const firstItems = Array.from({ length: 200 }, (_, index) => ({ work_date: `a-${index}` }))
    const first = pageOf(firstItems, { pageSize: 200, total: 365, keyOf: item => item.work_date })
    expect(first.window.truncated).toBe(true)
    expect(nextOverviewPage(first.window)).toBe(2)
    expect(overviewRangeNotice('records', first.window)?.en).toContain('200 of 365')

    const rest = Array.from({ length: 165 }, (_, index) => ({ work_date: `b-${index}` }))
    const second = pageOf(rest, {
      page: 2,
      pageSize: 200,
      total: 365,
      append: true,
      previousItems: first.items,
      previousFetched: first.window.fetched,
      keyOf: item => item.work_date,
    })
    expect(second.window.truncated).toBe(false)
    expect(second.items).toHaveLength(365)
    expect(overviewRangeNotice('records', second.window)).toBeNull()
  })

  it('keeps a pending request past the old page of 10, and discloses a still-short window', () => {
    expect(overviewWindowPageSize('2026-08-24', '2026-09-23', OVERVIEW_REQUESTS_PAGE_FLOOR)).toBe(200)
    const requests = Array.from({ length: 12 }, (_, index) => ({
      id: `request-${index}`,
      status: index === 11 ? 'pending' : 'approved',
    }))
    const covered = pageOf(requests, {
      pageSize: OVERVIEW_REQUESTS_PAGE_FLOOR,
      total: 12,
      keyOf: item => item.id,
    })
    expect(covered.window.truncated).toBe(false)
    expect(covered.items.filter(item => item.status === 'pending')).toHaveLength(1)

    const firstPage = pageOf(requests.slice(0, 10), {
      pageSize: 10,
      total: 12,
      keyOf: item => item.id,
    })
    expect(firstPage.items.filter(item => item.status === 'pending')).toHaveLength(0)
    const notice = overviewRangeNotice('requests', firstPage.window, 0)
    expect(notice?.en).toContain('latest 10 of 12')
    expect(notice?.en).toContain('0 pending in the loaded set')
    expect(notice?.en).toContain('not included yet')
    expect(notice?.zh).toContain('待审批')
  })

  it('loads anomaly rows past 50 up to the cap, and tells batch resolve about the remainder', () => {
    expect(OVERVIEW_ANOMALIES_PAGE_FLOOR).toBe(50)
    expect(overviewWindowPageSize('2026-08-24', '2026-09-23', OVERVIEW_ANOMALIES_PAGE_FLOOR)).toBe(50)
    expect(overviewWindowPageSize('2026-01-01', '2026-12-31', OVERVIEW_ANOMALIES_PAGE_FLOOR)).toBe(200)

    const eighty = Array.from({ length: 80 }, (_, index) => ({ recordId: `anomaly-${index}` }))
    const covered = pageOf(eighty, { pageSize: 200, total: 80, keyOf: item => item.recordId })
    expect(covered.window.truncated).toBe(false)
    expect(covered.items).toHaveLength(80)

    const first = pageOf(
      Array.from({ length: 200 }, (_, index) => ({ recordId: `anomaly-${index}` })),
      { pageSize: 200, total: 240, keyOf: item => item.recordId },
    )
    expect(first.window.truncated).toBe(true)
    const notice = overviewRangeNotice('anomalies', first.window)
    expect(notice?.en).toContain('200 of 240')
    expect(notice?.en).toContain('Batch resolve can only select loaded rows')
    expect(notice?.zh).toContain('批量处理只能选择已加载行')

    const second = pageOf(
      Array.from({ length: 40 }, (_, index) => ({ recordId: `later-${index}` })),
      {
        page: 2,
        pageSize: 200,
        total: 240,
        append: true,
        previousItems: first.items,
        previousFetched: first.window.fetched,
        keyOf: item => item.recordId,
      },
    )
    expect(second.window.truncated).toBe(false)
    expect(second.items).toHaveLength(240)
    expect(second.items[0]?.recordId).toBe('anomaly-0')
    expect(second.items[239]?.recordId).toBe('later-39')
  })

  it('treats a missing total as the returned page and does not duplicate keys', () => {
    expect(readPagedPayload({ data: { items: [{ id: 'a' }] } })).toEqual({
      items: [{ id: 'a' }],
      total: 1,
    })
    expect(readPagedPayload({ data: { items: [], total: 4 } }).total).toBe(4)
    expect(readPagedPayload(null)).toEqual({ items: [], total: 0 })

    const first = pageOf([{ work_date: '2026-09-02' }, { work_date: '2026-09-01' }], {
      pageSize: 2,
      total: 3,
      keyOf: item => item.work_date,
    })
    const second = pageOf([{ work_date: '2026-09-01' }, { work_date: '2026-08-31' }], {
      page: 2,
      pageSize: 2,
      total: 3,
      append: true,
      previousItems: first.items,
      previousFetched: first.window.fetched,
      keyOf: item => item.work_date,
    })
    expect(second.items.map(item => item.work_date)).toEqual(['2026-09-02', '2026-09-01', '2026-08-31'])
    expect(second.window.truncated).toBe(false)
  })

  it('discloses whenever total is still ahead of the rows in hand', () => {
    const short = pageOf([{ recordId: 'a' }, { recordId: 'b' }], {
      pageSize: 50,
      total: 80,
      keyOf: item => item.recordId,
    })
    expect(short.window.truncated).toBe(true)
    expect(overviewRangeNotice('anomalies', short.window)?.en).toContain('2 of 80')
    expect(overviewRangeNotice('anomalies', short.window)?.en).toContain('Batch resolve can only select loaded rows')

    const emptyFollowUp = pageOf([], {
      page: 2,
      pageSize: 50,
      total: 80,
      append: true,
      previousItems: short.items,
      previousFetched: short.window.fetched,
      keyOf: item => item.recordId,
    })
    expect(emptyFollowUp.window.truncated).toBe(false)
    expect(overviewRangeNotice('anomalies', emptyFollowUp.window)).toBeNull()
  })
})

describe('OverviewRangeNotice', () => {
  it('hides itself until there is a truncation note, then emits load-more', async () => {
    const clicks = ref(0)
    const note = ref('')
    const Host = defineComponent({
      components: { OverviewRangeNotice },
      setup() {
        return { clicks, note }
      },
      template: `
        <OverviewRangeNotice
          kind="records"
          :note="note"
          load-more-label="Load earlier days"
          @load-more="clicks++"
        />
      `,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(Host)
    app.mount(container)
    await nextTick()
    expect(container.querySelector('[data-overview-range-notice]')).toBeNull()

    note.value = 'Calendar shows 20 of 25 records in this range. 5 earlier record(s) are missing from the grid until you load more.'
    await nextTick()
    const notice = container.querySelector('[data-overview-range-notice]')
    expect(notice?.getAttribute('data-overview-range-kind')).toBe('records')
    expect(notice?.textContent).toContain('20 of 25')
    const button = container.querySelector<HTMLButtonElement>('[data-overview-range-load-more]')
    expect(button?.textContent).toContain('Load earlier days')
    button?.click()
    await nextTick()
    expect(clicks.value).toBe(1)
    app.unmount()
    container.remove()
  })
})

describe('employee workspace request window', () => {
  it('shows the pending-count truncation note next to the request chips', async () => {
    const clicks = ref(0)
    const note = 'Pending count and follow-up use the latest 10 of 12 requests (0 pending in the loaded set). 2 older request(s) are not included yet.'
    const Host = defineComponent({
      components: { AttendanceEmployeeWorkspace },
      setup() {
        return {
          clicks,
          workspaceProps: {
            ...buildEmployeeWorkspaceProps('pending'),
            tr: en,
            requestWindowNote: note,
            requestWindowLoading: false,
          },
        }
      },
      template: `<AttendanceEmployeeWorkspace v-bind="workspaceProps" @load-more-requests="clicks++" />`,
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(Host)
    app.mount(container)
    await nextTick()

    const notice = container.querySelector('[data-overview-range-kind="requests"]')
    expect(notice?.textContent).toContain('0 pending in the loaded set')
    expect(notice?.textContent).toContain('10 of 12')
    container.querySelector<HTMLButtonElement>('[data-overview-range-load-more]')?.click()
    await nextTick()
    expect(clicks.value).toBe(1)

    app.unmount()
    container.remove()
  })

  it('does not render a request-window notice when the loaded set is complete', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(AttendanceEmployeeWorkspace, {
      ...buildEmployeeWorkspaceProps('pending'),
      tr: en,
    })
    app.mount(container)
    await nextTick()
    expect(container.querySelector('[data-overview-range-notice]')).toBeNull()
    app.unmount()
    container.remove()
  })
})
