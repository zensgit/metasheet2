import { describe, expect, it } from 'vitest'
import { applyAdminPageContentSearch, clearAdminPageContentSearch } from '../src/views/attendance/adminPageContentSearch'

describe('admin page content search', () => {
  it('hides non-matching fields and restores them when cleared', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <section>
        <label class="attendance__field" id="absence"><span>自动缺勤</span></label>
        <label class="attendance__field" id="lookback"><span>回溯天数</span></label>
      </section>
    `
    const result = applyAdminPageContentSearch(root, '回溯')
    expect(result.matched).toBeGreaterThan(0)
    expect(root.querySelector('#absence')?.getAttribute('data-admin-page-search-hidden')).toBe('true')
    expect(root.querySelector('#lookback')?.classList.contains('attendance__page-search-hit')).toBe(true)

    clearAdminPageContentSearch(root)
    expect(root.querySelector('#absence')?.getAttribute('data-admin-page-search-hidden')).toBeNull()
    expect(root.querySelector('#lookback')?.classList.contains('attendance__page-search-hit')).toBe(false)
  })
})
