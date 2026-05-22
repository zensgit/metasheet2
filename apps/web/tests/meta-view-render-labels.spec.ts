import { describe, expect, it } from 'vitest'
import {
  VIEW_RENDER_LABEL_KEYS,
  calendarCellAriaLabel,
  calendarEventCount,
  calendarMoreEvents,
  calendarViewModeLabel,
  calendarWeekdayShort,
  cardFieldsSummary,
  dashboardDefaultName,
  ganttResizeAria,
  openFieldCommentsAria,
  openFieldCommentsForRecordAria,
  openRecordCommentsAria,
  timelineAutoUsesFieldHint,
  timelineLabelSummary,
  unscheduledCount,
  viewRenderLabel,
  viewSizeLabel,
  viewZoomLabel,
} from '../src/multitable/utils/meta-view-render-labels'

describe('meta-view-render-labels', () => {
  it('exposes all view-render keys in both locales', () => {
    expect(VIEW_RENDER_LABEL_KEYS.length).toBeGreaterThan(70)
    for (const key of VIEW_RENDER_LABEL_KEYS) {
      expect(viewRenderLabel(key, false)).toBeTruthy()
      expect(viewRenderLabel(key, true)).toBeTruthy()
    }
  })

  it('localizes common static chrome', () => {
    expect(viewRenderLabel('common.loading', false)).toBe('Loading...')
    expect(viewRenderLabel('common.loading', true)).toBe('正在加载...')
    expect(viewRenderLabel('dashboard.addPanel', true)).toBe('+ 添加面板')
    expect(viewRenderLabel('kanban.uncategorized', true)).toBe('未分类')
  })

  it('handles size, zoom, view mode, and weekday labels with raw unknown fallbacks', () => {
    expect(viewSizeLabel('small', false)).toBe('Small')
    expect(viewSizeLabel('large', true)).toBe('大')
    expect(viewSizeLabel('giant', true)).toBe('giant')
    expect(viewZoomLabel('week', false)).toBe('Week')
    expect(viewZoomLabel('month', true)).toBe('月')
    expect(viewZoomLabel('quarter', true)).toBe('quarter')
    expect(calendarViewModeLabel('day', false)).toBe('Day')
    expect(calendarViewModeLabel('month', true)).toBe('月')
    expect(calendarViewModeLabel('agenda', true)).toBe('agenda')
    expect(calendarWeekdayShort(0, false)).toBe('Sun')
    expect(calendarWeekdayShort(1, true)).toBe('周一')
  })

  it('formats plural/count labels', () => {
    expect(calendarMoreEvents(1, false)).toBe('+1 more')
    expect(calendarMoreEvents(2, true)).toBe('+2 条更多')
    expect(calendarEventCount(1, false)).toBe('1 event')
    expect(calendarEventCount(2, false)).toBe('2 events')
    expect(calendarEventCount(2, true)).toBe('2 个事件')
    expect(cardFieldsSummary(3, false)).toBe('Card fields (3)')
    expect(cardFieldsSummary(3, true)).toBe('卡片字段（3）')
    expect(unscheduledCount(1, false)).toBe('Unscheduled (1)')
    expect(unscheduledCount(2, true)).toBe('未排期（2）')
  })

  it('keeps raw field, record, and task labels inside localized chrome', () => {
    expect(openRecordCommentsAria('客户 A', false)).toBe('Open comments for 客户 A')
    expect(openRecordCommentsAria('客户 A', true)).toBe('打开 客户 A 的评论')
    expect(openFieldCommentsAria('状态', true)).toBe('打开 状态 的评论')
    expect(openFieldCommentsForRecordAria('状态', '客户 A', false)).toBe('Open comments for 状态 on 客户 A')
    expect(openFieldCommentsForRecordAria('状态', '客户 A', true)).toBe('打开 客户 A 中 状态 的评论')
    expect(ganttResizeAria('start', '任务 A', false)).toBe('Resize start for 任务 A')
    expect(ganttResizeAria('end', '任务 A', true)).toBe('调整 任务 A 的结束时间')
  })

  it('formats timeline and calendar helper text', () => {
    expect(timelineLabelSummary('auto', null, false)).toBe('Label: auto')
    expect(timelineLabelSummary('custom', null, true)).toBe('标签：自定义')
    expect(timelineLabelSummary('field', '状态', false)).toBe('Label: 状态')
    expect(timelineAutoUsesFieldHint('标题', true)).toBe('自动模式会优先使用 标题。')
    expect(calendarCellAriaLabel('2026年5月22日', ['春节'], 2, true)).toBe('2026年5月22日，春节，2 个事件')
    expect(calendarCellAriaLabel('May 22, 2026', ['National Day'], 1, false)).toBe('May 22, 2026, National Day, 1 event')
  })

  it('generates dashboard default names at event time', () => {
    expect(dashboardDefaultName(2, false)).toBe('Dashboard 2')
    expect(dashboardDefaultName(2, true)).toBe('仪表板 2')
  })
})
