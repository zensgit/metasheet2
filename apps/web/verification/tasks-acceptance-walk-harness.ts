// Tasks acceptance-walk harness (task usability package 1, walk items 1 and 2). Two surfaces, picked
// by `?surface=`:
//
//   dispatch (default) — the REAL MetaRecordInspector (the multitable record drawer) on one record,
//     whose kebab 派发任务 entry opens the REAL MetaRecordTaskDispatchDialog, as a user reaches it.
//   detail — the REAL TasksView on `/tasks/:id`, under a real vue-router with the task route
//     records' paths, names and views, where an assignee is added.
//
// WHAT IS REAL. The components, `tasksApi`, `apiFetch` (so every request is built and every answer
// parsed by production code), `useAuth`, `useLocale`, the feature-flag store and the dispatch binding
// (`createDispatchBinding`, made here the way MultitableWorkbench makes it). The session comes the
// way the app gets it: a token in storage, then `loadProductFeatures(true)`, whose session probe
// (`GET /api/auth/me`) resolves the `tasks` feature from the session payload. No dev override
// (`metasheet_features`) is set.
//
// WHAT THE HARNESS SETS UP OR REPLACES, AND WHY.
//  * The network: every `/api/**` answer comes from the paired spec (`page.route`), in the shapes
//    the server sends (tasks-acceptance-walk-fixtures.ts names each source). The tasks path has no
//    dev-mode mock layer: `approvals/api.ts` and `approvals/delegations.ts` mock under
//    `import.meta.env.DEV`, but nothing on these two surfaces calls them, and the feature-flag
//    store's dev override is only read from storage, which is left empty.
//  * The token: a JWT-shaped token written to the two keys `setToken` writes (`auth_token`, `jwt`),
//    before any app module is imported. Every app import below is dynamic for that reason: some
//    modules read storage when they are evaluated.
//  * The locale is not set here: the spec's browser context has the zh-CN language, and `useLocale`
//    picks the browser language when nothing is stored, as it does for a first-time user. The page
//    refuses to start if that did not give zh-CN, so a context change cannot quietly switch the
//    strings the spec compares.
//  * The workbench around the drawer: its content row (harness HTML) and the narrow-screen overlay
//    class MultitableWorkbench binds on the drawer at a viewport of 768px or less (its
//    `RAIL_NARROW_BREAKPOINT`, not exported, so copied). The viewport is set before the page loads
//    and is not resized afterwards.
//  * No multitable `apiClient` is passed to the drawer. On the workbench it feeds the watch entry
//    and the history and approval panels; none of them is on the dispatch path, and without it they
//    render nothing and send nothing. With no multitable requests, the workbench's before-send hook
//    on the binding has nothing to see, so it is not installed.
//  * The detail surface uses a memory history and does not install main.ts's route guards. Its
//    route records are written here rather than imported from router/appRoutes.ts, so the page
//    loads only the task views; tests/tasks-routes.spec.ts pins the production records.
import { createApp, defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type RouteRecordRaw } from 'vue-router'
// The stylesheets main.ts loads, in its order.
import 'element-plus/dist/index.css'
import '../src/styles/tokens.css'
import '../src/styles/calendar-source-palette.css'
import '../src/styles/form-layout-utilities.css'
import type { MetaField, MetaRecord, PersonSummary } from '../src/multitable/types'
import {
  WALK_BASE_ID,
  WALK_NO_ACCESS_USER_ID,
  WALK_RECORD_ID,
  WALK_RECORD_TITLE,
  WALK_SHEET_ID,
  WALK_TASK_ID,
  WALK_TOKEN,
  WALK_VIEW_ID,
} from './tasks-acceptance-walk-fixtures'

declare global {
  interface Window {
    __TASKS_WALK_READY__?: boolean
    __TASKS_WALK_ERROR__?: string
  }
}

/** MultitableWorkbench.vue's RAIL_NARROW_BREAKPOINT: at or below it the drawer is an overlay. */
const NARROW_BREAKPOINT = 768

const FIELDS: MetaField[] = [
  { id: 'fld_title', name: '标题', type: 'string' },
  { id: 'fld_owner', name: '负责人', type: 'person' },
]

/** The person field holds one active person: the assignee the walk names. */
const RECORD: MetaRecord = {
  id: WALK_RECORD_ID,
  version: 1,
  data: { fld_title: WALK_RECORD_TITLE, fld_owner: [WALK_NO_ACCESS_USER_ID] },
}

const PERSON_SUMMARIES: Record<string, PersonSummary[]> = {
  fld_owner: [{ id: WALK_NO_ACCESS_USER_ID, display: '未开通任务的同事' }],
}

async function mountDispatch(): Promise<void> {
  const { default: MetaRecordInspector } = await import('../src/multitable/components/MetaRecordInspector.vue')
  const { createDispatchBinding } = await import('../src/tasks/recordTaskDispatchIdentity')
  // Made after the session is in place, as the workbench makes it when the page is set up.
  const binding = createDispatchBinding()
  const overlay = window.innerWidth <= NARROW_BREAKPOINT
  const app = createApp(defineComponent({
    render: () => h('div', { class: 'walk-workbench-content' }, [
      h('div', { class: 'walk-workbench-main' }),
      h(MetaRecordInspector, {
        class: { 'meta-record-drawer--overlay': overlay },
        visible: true,
        record: RECORD,
        fields: FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: false,
        sheetId: WALK_SHEET_ID,
        viewId: WALK_VIEW_ID,
        baseId: WALK_BASE_ID,
        personSummariesByField: PERSON_SUMMARIES,
        dispatchBinding: binding,
      }),
    ]),
  }))
  app.mount('#app')
}

async function mountDetail(): Promise<void> {
  // The task route records of router/appRoutes.ts: path, name and lazy component. Their meta is left
  // out: it feeds main.ts's guards and page titles, neither of which is set up here.
  const routes: RouteRecordRaw[] = [
    { path: '/tasks', name: 'tasks', component: () => import('../src/views/tasks/TasksView.vue') },
    { path: '/tasks/settings', name: 'tasks-settings', component: () => import('../src/views/tasks/TasksSettingsView.vue') },
    { path: '/tasks/:id', name: 'task-detail', component: () => import('../src/views/tasks/TasksView.vue') },
    { path: '/task-lists/:id', name: 'task-list-detail', component: () => import('../src/views/tasks/TaskListView.vue') },
  ]
  const router = createRouter({ history: createMemoryHistory(), routes })
  const app = createApp(defineComponent({ render: () => h(RouterView) }))
  app.use(router)
  await router.push(`/tasks/${WALK_TASK_ID}`)
  await router.isReady()
  app.mount('#app')
}

async function main(): Promise<void> {
  const surface = new URLSearchParams(window.location.search).get('surface') === 'detail' ? 'detail' : 'dispatch'
  localStorage.setItem('auth_token', WALK_TOKEN)
  localStorage.setItem('jwt', WALK_TOKEN)

  const { useLocale } = await import('../src/composables/useLocale')
  const locale = useLocale().locale.value
  if (locale !== 'zh-CN') throw new Error(`expected the zh-CN locale from the browser language, got ${locale}`)

  const { useFeatureFlags } = await import('../src/stores/featureFlags')
  const flags = useFeatureFlags()
  await flags.loadProductFeatures(true)
  if (!flags.hasFeature('tasks')) throw new Error('the session did not turn the tasks feature on')

  if (surface === 'detail') await mountDetail()
  else await mountDispatch()

  document.documentElement.setAttribute('data-walk-surface', surface)
  window.__TASKS_WALK_READY__ = true
}

main().catch((error: unknown) => {
  window.__TASKS_WALK_ERROR__ = error instanceof Error ? error.message : String(error)
})
