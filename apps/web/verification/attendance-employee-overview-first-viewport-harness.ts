// Browser-verification harness for issue #4355 first-viewport contract.
// Mounts the real AttendanceEmployeeWorkspace plus representative parent
// chrome (app nav 50px, attendance tabs, compact overview header) so the
// 1440x900 / 390x844 measurements include the same stacked chrome the
// employee overview actually sits under. Not part of the app build.
import { createApp, h, ref } from 'vue'
import '../src/styles/tokens.css'
import AttendanceEmployeeWorkspace from '../src/views/attendance/AttendanceEmployeeWorkspace.vue'
import {
  buildEmployeeWorkspaceProps,
  type OverviewHarnessState,
} from './attendance-employee-overview-first-viewport-fixtures'

const STATES: OverviewHarnessState[] = ['normal', 'late', 'missing', 'pending', 'empty']

function readState(): OverviewHarnessState {
  const raw = new URLSearchParams(window.location.search).get('state') ?? 'missing'
  return (STATES as string[]).includes(raw) ? raw as OverviewHarnessState : 'missing'
}

createApp({
  setup() {
    const state = ref<OverviewHarnessState>(readState())

    function setState(next: OverviewHarnessState) {
      state.value = next
      const url = new URL(window.location.href)
      url.searchParams.set('state', next)
      window.history.replaceState({}, '', url)
    }

    return () => h('div', { class: 'harness-app' }, [
      h('nav', { class: 'app-nav', 'data-harness-nav': '' }, [
        h('span', { class: 'brand-text' }, 'MetaSheet'),
        h('span', { class: 'nav-link' }, '考勤'),
      ]),
      h('main', { class: 'app-main' }, [
        h('div', { class: 'attendance-shell' }, [
          h('nav', { class: 'attendance-shell__tabs', 'data-harness-tabs': '' }, [
            h('button', { class: 'attendance-shell__tab attendance-shell__tab--active', type: 'button' }, '总览'),
            h('button', { class: 'attendance-shell__tab', type: 'button' }, '报表'),
          ]),
          h('div', { class: 'attendance attendance--overview' }, [
            h('header', { class: 'attendance__header', 'data-attendance-overview-header': '' }, [
              h('div', { class: 'attendance__header-copy' }, [
                h('h2', { class: 'attendance__title' }, 'MetaSheet 考勤'),
                h('p', { class: 'attendance__subtitle' }, '跟踪打卡、汇总和补卡调整。'),
              ]),
              h('div', {
                class: 'attendance__header-aside',
                'data-attendance-overview-header-aside': '',
              }),
            ]),
            h(AttendanceEmployeeWorkspace, buildEmployeeWorkspaceProps(state.value)),
            h('div', { class: 'harness-state-row', 'data-harness-states': '' }, STATES.map((item) =>
              h('button', {
                type: 'button',
                'data-harness-state': item,
                class: state.value === item ? 'harness-state-row__btn harness-state-row__btn--active' : 'harness-state-row__btn',
                onClick: () => setState(item),
              }, item),
            )),
          ]),
        ]),
      ]),
    ])
  },
}).mount('#app')
