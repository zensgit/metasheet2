import { describe, expect, it } from 'vitest'
import { createApp, nextTick } from 'vue'
import AttendanceListTruncationNotice from '../src/views/attendance/AttendanceListTruncationNotice.vue'
import { ATTENDANCE_ADMIN_LIST_MAX_PAGES } from '../src/views/attendance/attendanceAdminListPage'

const tr = (en: string) => en

async function mountNotice(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let loadedMore = 0
  const app = createApp(AttendanceListTruncationNotice, {
    tr,
    listKey: 'sample',
    loaded: 1,
    total: 1,
    page: 1,
    lastPageCount: 1,
    ...props,
    onLoadMore: () => {
      loadedMore += 1
    },
  })
  app.mount(container)
  await nextTick()
  return {
    container,
    loadedMore: () => loadedMore,
    unmount: () => {
      app.unmount()
      container.remove()
    },
  }
}

describe('AttendanceListTruncationNotice', () => {
  it('hides itself when the loaded page covers total', async () => {
    const view = await mountNotice({ loaded: 2, total: 2 })
    expect(view.container.querySelector('[data-attendance-list-truncated="sample"]')).toBeNull()
    view.unmount()
  })

  it('shows the loaded count and loads the next page', async () => {
    const view = await mountNotice({ loaded: 1, total: 4, page: 1, lastPageCount: 1 })
    const notice = view.container.querySelector('[data-attendance-list-truncated="sample"]')
    expect(notice?.textContent).toContain('Showing 1 of 4.')
    view.container.querySelector<HTMLButtonElement>('[data-attendance-list-load-more="sample"]')!.click()
    expect(view.loadedMore()).toBe(1)
    view.unmount()
  })

  it('discloses the load cap without another request', async () => {
    const view = await mountNotice({
      loaded: 1,
      total: 400,
      page: ATTENDANCE_ADMIN_LIST_MAX_PAGES,
      lastPageCount: 1,
    })
    expect(view.container.querySelector('[data-attendance-list-load-more="sample"]')).toBeNull()
    expect(view.container.querySelector('[data-attendance-list-cap="sample"]')?.textContent).toContain('Stopped at the load cap.')
    view.unmount()
  })
})
