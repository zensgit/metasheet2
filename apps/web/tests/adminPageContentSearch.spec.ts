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

  it('leaves the page visible when nothing matches', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <table><tbody><tr id="row"><td>张三</td></tr></tbody></table>
      <label class="attendance__field" id="field"><span>班次</span></label>
    `
    const result = applyAdminPageContentSearch(root, 'zzz-no-such-page-text')
    expect(result).toEqual({ matched: 0, hidden: 0 })
    expect(root.querySelector('[data-admin-page-search-hidden]')).toBeNull()
    expect(root.querySelector('#row')?.style.display ?? '').toBe('')
    expect(root.querySelector('#field')?.style.display ?? '').toBe('')
  })
})
