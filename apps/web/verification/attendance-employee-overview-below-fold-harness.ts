// Browser-verification harness for the employee overview BELOW the first viewport.
// Injects the parent-owned historyFilters slot (the first-viewport harness does
// not) plus the request/makeup disclosure, and applies the parent field CSS
// including the 180px input min-width that overflowed at 390px.
import { createApp, h, nextTick, onMounted } from 'vue'
import '../src/styles/tokens.css'
import AttendanceEmployeeWorkspace from '../src/views/attendance/AttendanceEmployeeWorkspace.vue'
import { shouldRevealOverviewRequestTools } from '../src/views/attendance/attendanceOverviewRequestReveal'
import { buildEmployeeWorkspaceProps } from './attendance-employee-overview-first-viewport-fixtures'

function readSection(): string {
  return new URLSearchParams(window.location.search).get('section') ?? ''
}

function readFiltersOpen(): boolean {
  return new URLSearchParams(window.location.search).get('filters') === 'open'
}

function historyFilterField(id: string, name: string, label: string, type: 'date' | 'text', value: string) {
  return h('label', { class: 'attendance__field attendance-ew__history-filter-control', for: id }, [
    h('span', label),
    h('input', { id, name, type, value }),
  ])
}

createApp({
  setup() {
    const section = readSection()
    const requestOpen = shouldRevealOverviewRequestTools(section, '')

    onMounted(() => {
      void nextTick(() => {
        const details = document.querySelector('[data-attendance-history-filters]')
        if (details instanceof HTMLDetailsElement && readFiltersOpen()) details.open = true
      })
    })

    return () => h('div', { class: 'harness-app' }, [
      h('nav', { class: 'app-nav', 'data-harness-nav': '' }, [
        h('span', { class: 'brand-text' }, 'MetaSheet'),
        h('span', { class: 'nav-link' }, '考勤'),
      ]),
      h('main', { class: 'app-main' }, [
        h('div', { class: 'attendance-shell' }, [
          h('nav', { class: 'attendance-shell__tabs' }, [
            h('button', { class: 'attendance-shell__tab attendance-shell__tab--active', type: 'button' }, '总览'),
          ]),
          h('div', { class: 'attendance attendance--overview' }, [
            h(AttendanceEmployeeWorkspace, {
              ...buildEmployeeWorkspaceProps('pending'),
              historyFromDate: '2026-03-26',
              historyToDate: '2026-04-25',
            }, {
              historyFilters: () => [
                historyFilterField('attendance-from-date', 'fromDate', '开始', 'date', '2026-03-26'),
                historyFilterField('attendance-to-date', 'toDate', '结束', 'date', '2026-04-25'),
                historyFilterField('attendance-org-id', 'orgId', '组织 ID', 'text', ''),
                historyFilterField('attendance-user-id', 'targetUserId', '用户 ID（可选）', 'text', ''),
                h('button', {
                  class: 'attendance__btn attendance-ew__history-filter-control',
                  type: 'button',
                }, '刷新'),
              ],
            }),
            h('details', {
              class: 'attendance__card attendance__card--request-tools',
              'data-attendance-request-tools': '',
              id: 'attendance-overview-anomalies',
              open: requestOpen,
            }, [
              h('summary', { class: 'attendance__details-summary' }, '补卡申请'),
              h('label', { class: 'attendance__field', for: 'attendance-request-work-date' }, [
                h('span', '工作日期'),
                h('input', { id: 'attendance-request-work-date', name: 'requestWorkDate', type: 'date' }),
              ]),
            ]),
          ]),
        ]),
      ]),
    ])
  },
}).mount('#app')
