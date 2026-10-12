import { describe, expect, it } from 'vitest'
import type { RouteRecordRaw } from 'vue-router'
import { createMemoryHistory, createRouter } from 'vue-router'
import { appRoutes } from '../src/router/appRoutes'
import {
  buildRouteGuardContext,
  resolveRouteGuardDecision,
  type RouteGuardPolicyContext,
} from '../src/router/guardPolicy'
import { useAuth } from '../src/composables/useAuth'
import { useFeatureFlags } from '../src/stores/featureFlags'

/**
 * Gate 22's own wording drives the lookup by PATH ("断言对象：spec import appRoutes 后取出
 * path==='/tasks' 的记录"), not by route name. Name is asserted separately where it matters.
 */
function routeByPath(path: string): RouteRecordRaw {
  const route = appRoutes.find((item) => item.path === path)
  expect(route, `expected exported route at path ${path}`).toBeTruthy()
  return route as RouteRecordRaw
}

function isLazyViewLoader(component: RouteRecordRaw['component'], viewFile: string): boolean {
  return typeof component === 'function' && String(component).includes(viewFile)
}

/**
 * Gate 22's "comparison projection": requiresAuth === true, permissions deep-equal
 * ['tasks:read'], and title/titleZh present as non-empty strings. Applied identically to both
 * /tasks and /tasks/:id. Superseded in one point: the projection used to require NO
 * requiredFeature; both routes now carry requiredFeature 'tasks' so that, with TASKS_ENABLED not
 * exactly 'true', /tasks redirects home instead of opening a page whose API is not mounted.
 */
function expectGuardRelevantProjection(route: RouteRecordRaw): void {
  const meta = route.meta as Record<string, unknown>
  expect(meta.requiresAuth).toBe(true)
  expect(meta.permissions).toEqual(['tasks:read'])
  expect(meta.requiredFeature).toBe('tasks')
  expect(typeof meta.title).toBe('string')
  expect((meta.title as string).length).toBeGreaterThan(0)
  expect(typeof meta.titleZh).toBe('string')
  expect((meta.titleZh as string).length).toBeGreaterThan(0)
}

describe('tasks routes (design lock §5.2)', () => {
  it('exports a lazy /tasks route gated on the tasks feature and tasks:read, loading TasksView.vue', () => {
    const route = routeByPath('/tasks')

    expect(route.name).toBe('tasks')
    expect(route.meta).toEqual({
      title: 'Tasks',
      titleZh: '任务',
      requiresAuth: true,
      requiredFeature: 'tasks',
      permissions: ['tasks:read'],
    })
    expectGuardRelevantProjection(route)
    expect(isLazyViewLoader(route.component, 'TasksView.vue')).toBe(true)
  })

  it('exports a lazy /tasks/:id route with the same guard-relevant projection, loading TasksView.vue', () => {
    const route = routeByPath('/tasks/:id')

    expect(route.name).toBe('task-detail')
    expect(route.meta).toEqual({
      title: 'Tasks',
      titleZh: '任务',
      requiresAuth: true,
      requiredFeature: 'tasks',
      permissions: ['tasks:read'],
    })
    expectGuardRelevantProjection(route)
    expect(isLazyViewLoader(route.component, 'TasksView.vue')).toBe(true)
  })
})

describe('tasks route guard decisions (gate 22, stubbed context)', () => {
  const ctx = (over: Partial<RouteGuardPolicyContext> = {}): RouteGuardPolicyContext => ({
    hasFeature: () => true,
    hasPermission: () => true,
    attendanceFocused: false,
    plmWorkbenchFocused: false,
    resolveHomePath: () => '/HOME',
    ...over,
  })

  it('allow cell: hasPermission(tasks:read)=true and both focus flags false', () => {
    const route = routeByPath('/tasks')
    const decision = resolveRouteGuardDecision(
      { path: '/tasks', meta: route.meta },
      ctx({ hasPermission: (p) => p === 'tasks:read' }),
    )
    expect(decision).toEqual({ action: 'allow' })
  })

  it('redirect cell: hasPermission(tasks:read)=false redirects to ctx.resolveHomePath()', () => {
    const route = routeByPath('/tasks')
    const decision = resolveRouteGuardDecision(
      { path: '/tasks', meta: route.meta },
      ctx({ hasPermission: () => false }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/HOME' })
  })

  it('attendance-focus cell: attendanceFocused=true, plmWorkbenchFocused=false redirects to /attendance', () => {
    const route = routeByPath('/tasks')
    const decision = resolveRouteGuardDecision(
      { path: '/tasks', meta: route.meta },
      ctx({ hasPermission: () => true, attendanceFocused: true, plmWorkbenchFocused: false }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/attendance' })
  })

  it('plm-focus cell: plmWorkbenchFocused=true, attendanceFocused=false redirects to /plm', () => {
    const route = routeByPath('/tasks')
    const decision = resolveRouteGuardDecision(
      { path: '/tasks', meta: route.meta },
      ctx({ hasPermission: () => true, plmWorkbenchFocused: true, attendanceFocused: false }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/plm' })
  })

  it('focus reverse-control: attendanceFocused=true with path /attendance and hasPermission=true still allows', () => {
    // Gate 22: "input.meta 每格用该投影" — every cell uses the tasks route's own meta projection,
    // only the path varies. '/attendance' is on the attendance-focus allowlist, so even with the
    // tasks route's meta attached the decision is allow, not a focus redirect.
    const route = routeByPath('/tasks')
    const decision = resolveRouteGuardDecision(
      { path: '/attendance', meta: route.meta },
      ctx({ hasPermission: () => true, attendanceFocused: true, plmWorkbenchFocused: false }),
    )
    expect(decision).toEqual({ action: 'allow' })
  })
})

describe('tasks route guard admin cell (real useAuth, gate 22)', () => {
  it('allows /tasks for an admin snapshot (isAdmin=true, permissions=[]) driven through the real useAuth.hasPermission', () => {
    const store: Record<string, string> = {}
    const fakeLocalStorage = {
      getItem: (key: string) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
      setItem: (key: string, value: string) => {
        store[key] = value
      },
      removeItem: (key: string) => {
        delete store[key]
      },
    }
    const originalLocalStorage = globalThis.localStorage

    ;(globalThis as unknown as { localStorage: typeof fakeLocalStorage }).localStorage = fakeLocalStorage
    try {
      // Admin-by-role, zero explicit permission codes — exactly the fixture the lock's admin cell
      // names: `snapshot.isAdmin=true`, `permissions=[]`.
      store.user_roles = JSON.stringify(['admin'])

      const auth = useAuth()
      const snapshot = auth.getAccessSnapshot()
      expect(snapshot.isAdmin).toBe(true)
      expect(snapshot.permissions).toEqual([])

      const guardCtx = buildRouteGuardContext({
        auth: {
          hasPermission: auth.hasPermission,
          getAccessSnapshot: auth.getAccessSnapshot,
        },
        flags: {
          hasFeature: () => true,
          isAttendanceFocused: () => false,
          isPlmWorkbenchFocused: () => false,
          resolveHomePath: () => '/HOME',
        },
      })

      const route = routeByPath('/tasks')
      const decision = resolveRouteGuardDecision({ path: '/tasks', meta: route.meta }, guardCtx)
      expect(decision).toEqual({ action: 'allow' })
    } finally {
      ;(globalThis as unknown as { localStorage: typeof originalLocalStorage }).localStorage = originalLocalStorage
    }
  })
})

describe('tasks route feature gate (tasks session feature off -> redirect home, like the other feature-gated routes)', () => {
  const ctx = (over: Partial<RouteGuardPolicyContext> = {}): RouteGuardPolicyContext => ({
    hasFeature: () => true,
    hasPermission: () => true,
    attendanceFocused: false,
    plmWorkbenchFocused: false,
    resolveHomePath: () => '/HOME',
    ...over,
  })

  it.each([
    ['/tasks', '/tasks'],
    ['/tasks/:id', '/tasks/task-1'],
  ] as const)('%s with the tasks feature off redirects to ctx.resolveHomePath() even though every permission passes', (routePath, path) => {
    const route = routeByPath(routePath)
    const decision = resolveRouteGuardDecision(
      { path, meta: route.meta },
      ctx({ hasFeature: (feature) => feature !== 'tasks', hasPermission: () => true }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/HOME' })
  })

  it('with only the tasks feature on, /tasks is allowed', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/tasks', meta: routeByPath('/tasks').meta },
      ctx({ hasFeature: (feature) => feature === 'tasks', hasPermission: (p) => p === 'tasks:read' }),
    )
    expect(decision).toEqual({ action: 'allow' })
  })

  it('decides exactly like the elearning /learn route when each one\'s own feature is off', () => {
    const off = ctx({ hasFeature: () => false, hasPermission: () => true })
    const tasksDecision = resolveRouteGuardDecision({ path: '/tasks', meta: routeByPath('/tasks').meta }, off)
    const learnDecision = resolveRouteGuardDecision({ path: '/learn', meta: routeByPath('/learn').meta }, off)
    expect(tasksDecision).toEqual({ action: 'redirect', target: '/HOME' })
    expect(tasksDecision).toEqual(learnDecision)
  })

  it('real store defaults (no session loaded: tasks off) + an administrator through the real useAuth: /tasks redirects to /home', () => {
    localStorage.setItem('user_roles', JSON.stringify(['admin']))
    try {
      const auth = useAuth()
      expect(auth.hasPermission('tasks:read')).toBe(true)
      const flags = useFeatureFlags()
      expect(flags.hasFeature('tasks')).toBe(false)

      const guardCtx = buildRouteGuardContext({
        auth: { hasPermission: auth.hasPermission, getAccessSnapshot: auth.getAccessSnapshot },
        flags,
      })
      const decision = resolveRouteGuardDecision({ path: '/tasks', meta: routeByPath('/tasks').meta }, guardCtx)
      expect(decision).toEqual({ action: 'redirect', target: '/home' })
    } finally {
      localStorage.removeItem('user_roles')
    }
  })
})

// ---------------------------------------------------------------------------------------------
// M4 FE-3 — /tasks/settings (frontend design docs/development/task-m4-frontend-design-20261007.md
// §2.1, §10.1): the same gate as /tasks, a static path listed before /tasks/:id, and the gate-22
// cells above copied for the new path.
// ---------------------------------------------------------------------------------------------

describe('tasks settings route (M4 FE-3, design §2.1)', () => {
  it('exports a lazy /tasks/settings route named tasks-settings with the /tasks gate, loading TasksSettingsView.vue', () => {
    const route = routeByPath('/tasks/settings')

    expect(route.name).toBe('tasks-settings')
    expect(route.meta).toEqual({
      title: 'Task Settings',
      titleZh: '任务设置',
      requiresAuth: true,
      requiredFeature: 'tasks',
      permissions: ['tasks:read'],
    })
    expectGuardRelevantProjection(route)
    expect(isLazyViewLoader(route.component, 'TasksSettingsView.vue')).toBe(true)
  })

  it('is listed before /tasks/:id', () => {
    const settingsIndex = appRoutes.findIndex((item) => item.path === '/tasks/settings')
    const detailIndex = appRoutes.findIndex((item) => item.path === '/tasks/:id')
    expect(settingsIndex).toBeGreaterThanOrEqual(0)
    expect(detailIndex).toBeGreaterThanOrEqual(0)
    expect(settingsIndex).toBeLessThan(detailIndex)
  })

  it('a router built from appRoutes resolves /tasks/settings to tasks-settings, not to a task id', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: appRoutes })
    expect(router.resolve('/tasks/settings').name).toBe('tasks-settings')
    expect(router.resolve('/tasks/settings').params).toEqual({})
    expect(router.resolve('/tasks/tsk_1').name).toBe('task-detail')
    expect(router.resolve('/tasks/tsk_1').params).toEqual({ id: 'tsk_1' })
    expect(router.resolve('/tasks').name).toBe('tasks')
  })
})

describe('tasks settings route guard decisions (gate 22 cells for /tasks/settings, stubbed context)', () => {
  const ctx = (over: Partial<RouteGuardPolicyContext> = {}): RouteGuardPolicyContext => ({
    hasFeature: () => true,
    hasPermission: () => true,
    attendanceFocused: false,
    plmWorkbenchFocused: false,
    resolveHomePath: () => '/HOME',
    ...over,
  })
  const meta = () => routeByPath('/tasks/settings').meta

  it('allow cell: the tasks feature on, hasPermission(tasks:read)=true and both focus flags false', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/tasks/settings', meta: meta() },
      ctx({ hasFeature: (feature) => feature === 'tasks', hasPermission: (p) => p === 'tasks:read' }),
    )
    expect(decision).toEqual({ action: 'allow' })
  })

  it('redirect cell: hasPermission(tasks:read)=false redirects to ctx.resolveHomePath()', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/tasks/settings', meta: meta() },
      ctx({ hasPermission: () => false }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/HOME' })
  })

  it('attendance-focus cell: attendanceFocused=true, plmWorkbenchFocused=false redirects to /attendance', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/tasks/settings', meta: meta() },
      ctx({ hasPermission: () => true, attendanceFocused: true, plmWorkbenchFocused: false }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/attendance' })
  })

  it('plm-focus cell: plmWorkbenchFocused=true, attendanceFocused=false redirects to /plm', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/tasks/settings', meta: meta() },
      ctx({ hasPermission: () => true, plmWorkbenchFocused: true, attendanceFocused: false }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/plm' })
  })

  it('feature-off cell: the tasks feature off redirects to ctx.resolveHomePath() even though every permission passes', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/tasks/settings', meta: meta() },
      ctx({ hasFeature: (feature) => feature !== 'tasks', hasPermission: () => true }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/HOME' })
  })

  it('real store defaults (no session loaded: tasks off) + an administrator through the real useAuth: /tasks/settings redirects to /home', () => {
    localStorage.setItem('user_roles', JSON.stringify(['admin']))
    try {
      const auth = useAuth()
      expect(auth.hasPermission('tasks:read')).toBe(true)
      const flags = useFeatureFlags()
      expect(flags.hasFeature('tasks')).toBe(false)

      const guardCtx = buildRouteGuardContext({
        auth: { hasPermission: auth.hasPermission, getAccessSnapshot: auth.getAccessSnapshot },
        flags,
      })
      const decision = resolveRouteGuardDecision({ path: '/tasks/settings', meta: meta() }, guardCtx)
      expect(decision).toEqual({ action: 'redirect', target: '/home' })
    } finally {
      localStorage.removeItem('user_roles')
    }
  })
})

// ---------------------------------------------------------------------------------------------
// M4 FE-5 — /task-lists/:id (frontend design docs/development/task-m4-frontend-design-20261007.md
// §2.1, §10.1): the same gate as /tasks, no index page, and the gate-22 cells copied for the path.
// ---------------------------------------------------------------------------------------------

describe('task list route (M4 FE-5, design §2.1)', () => {
  it('exports a lazy /task-lists/:id route named task-list-detail with the /tasks gate, loading TaskListView.vue', () => {
    const route = routeByPath('/task-lists/:id')

    expect(route.name).toBe('task-list-detail')
    expect(route.meta).toEqual({
      title: 'Task Lists',
      titleZh: '任务清单',
      requiresAuth: true,
      requiredFeature: 'tasks',
      permissions: ['tasks:read'],
    })
    expectGuardRelevantProjection(route)
    expect(isLazyViewLoader(route.component, 'TaskListView.vue')).toBe(true)
  })

  it('a router built from appRoutes resolves /task-lists/:id with the id; /task-lists alone is no page of its own', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: appRoutes })
    expect(router.resolve('/task-lists/tl_1').name).toBe('task-list-detail')
    expect(router.resolve('/task-lists/tl_1').params).toEqual({ id: 'tl_1' })
    expect(router.resolve('/task-lists/a%2Fb').params).toEqual({ id: 'a/b' })
    expect(router.resolve('/task-lists').name).toBe('not-found')
    expect(appRoutes.filter((item) => item.path.startsWith('/task-lists')).map((item) => item.path)).toEqual(['/task-lists/:id'])
  })
})

describe('task list route guard decisions (gate 22 cells for /task-lists/:id, stubbed context)', () => {
  const ctx = (over: Partial<RouteGuardPolicyContext> = {}): RouteGuardPolicyContext => ({
    hasFeature: () => true,
    hasPermission: () => true,
    attendanceFocused: false,
    plmWorkbenchFocused: false,
    resolveHomePath: () => '/HOME',
    ...over,
  })
  const meta = () => routeByPath('/task-lists/:id').meta

  it('allow cell: the tasks feature on, hasPermission(tasks:read)=true and both focus flags false', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/task-lists/tl_1', meta: meta() },
      ctx({ hasFeature: (feature) => feature === 'tasks', hasPermission: (p) => p === 'tasks:read' }),
    )
    expect(decision).toEqual({ action: 'allow' })
  })

  it('redirect cell: hasPermission(tasks:read)=false redirects to ctx.resolveHomePath()', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/task-lists/tl_1', meta: meta() },
      ctx({ hasPermission: () => false }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/HOME' })
  })

  it('attendance-focus cell: attendanceFocused=true, plmWorkbenchFocused=false redirects to /attendance', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/task-lists/tl_1', meta: meta() },
      ctx({ hasPermission: () => true, attendanceFocused: true, plmWorkbenchFocused: false }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/attendance' })
  })

  it('plm-focus cell: plmWorkbenchFocused=true, attendanceFocused=false redirects to /plm', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/task-lists/tl_1', meta: meta() },
      ctx({ hasPermission: () => true, plmWorkbenchFocused: true, attendanceFocused: false }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/plm' })
  })

  it('feature-off cell: the tasks feature off redirects to ctx.resolveHomePath() even though every permission passes', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/task-lists/tl_1', meta: meta() },
      ctx({ hasFeature: (feature) => feature !== 'tasks', hasPermission: () => true }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/HOME' })
  })

  it('real store defaults (no session loaded: tasks off) + an administrator through the real useAuth: /task-lists/:id redirects to /home', () => {
    localStorage.setItem('user_roles', JSON.stringify(['admin']))
    try {
      const auth = useAuth()
      expect(auth.hasPermission('tasks:read')).toBe(true)
      const flags = useFeatureFlags()
      expect(flags.hasFeature('tasks')).toBe(false)

      const guardCtx = buildRouteGuardContext({
        auth: { hasPermission: auth.hasPermission, getAccessSnapshot: auth.getAccessSnapshot },
        flags,
      })
      const decision = resolveRouteGuardDecision({ path: '/task-lists/tl_1', meta: meta() }, guardCtx)
      expect(decision).toEqual({ action: 'redirect', target: '/home' })
    } finally {
      localStorage.removeItem('user_roles')
    }
  })
})
