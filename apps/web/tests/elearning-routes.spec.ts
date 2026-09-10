import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RouteRecordRaw } from 'vue-router'
import { describe, expect, it } from 'vitest'
import { appRoutes } from '../src/router/appRoutes'
import {
  resolveRouteGuardDecision,
  type RouteGuardPolicyContext,
} from '../src/router/guardPolicy'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const manifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'plugins/plugin-elearning/app.manifest.json'), 'utf8'),
) as {
  navigation: Array<{
    id: string
    title: string
    path: string
    icon?: string
    order?: number
    location?: string
  }>
  objects: unknown[]
  workflows: unknown[]
  integrations: unknown[]
  featureFlags: string[]
}

function routeByName(name: string): RouteRecordRaw {
  const route = appRoutes.find((item) => item.name === name)
  expect(route, `expected exported route named ${name}`).toBeTruthy()
  return route as RouteRecordRaw
}

function isLazyViewLoader(component: RouteRecordRaw['component'], viewFile: string): boolean {
  return typeof component === 'function' && String(component).includes(viewFile)
}

describe('elearning V0.1 routes and plugin navigation', () => {
  it('exports a lazy /learn learner route that is never admin-only', () => {
    const route = routeByName('elearning-learner')

    expect(route.path).toBe('/learn')
    expect(route.name).toBe('elearning-learner')
    expect(route.meta).toEqual({
      title: 'Learning Center',
      titleZh: '学习中心',
      requiresAuth: true,
      requiredFeature: 'elearning',
      permissions: ['elearning:read'],
    })
    expect(route.meta?.requiresAdmin).not.toBe(true)
    expect(route.meta?.permissions).toEqual(['elearning:read'])
    expect(route.meta?.permissions).not.toContain('elearning:admin')
    expect(isLazyViewLoader(route.component, 'ElearningLearnerView.vue')).toBe(true)
  })

  it('exports a lazy /admin/elearning admin route gated only by elearning:admin', () => {
    const route = routeByName('elearning-admin')

    expect(route.path).toBe('/admin/elearning')
    expect(route.name).toBe('elearning-admin')
    expect(route.meta).toEqual({
      title: 'Cloud Classroom Admin',
      titleZh: '云课堂管理',
      requiresAuth: true,
      requiredFeature: 'elearning',
      permissions: ['elearning:admin'],
    })
    expect(route.meta).not.toHaveProperty('requiresAdmin')
    expect(route.meta?.permissions).toEqual(['elearning:admin'])
    expect(isLazyViewLoader(route.component, 'ElearningAdminView.vue')).toBe(true)
  })

  it('exports a lazy /elearning/grading L3 route gated only by elearning:grade, standalone from admin', () => {
    const route = routeByName('elearning-manual-grading')

    expect(route.path).toBe('/elearning/grading')
    expect(route.name).toBe('elearning-manual-grading')
    expect(route.meta).toEqual({
      title: 'Manual Grading',
      titleZh: '人工阅卷',
      requiresAuth: true,
      requiredFeature: 'elearning',
      permissions: ['elearning:grade'],
    })
    expect(route.meta?.requiresAdmin).not.toBe(true)
    expect(route.meta?.permissions).toEqual(['elearning:grade'])
    expect(route.meta?.permissions).not.toContain('elearning:admin')
    expect(isLazyViewLoader(route.component, 'ElearningManualGradingView.vue')).toBe(true)
  })

  it('keeps the catch-all last and does not expose broader e-learning routes', () => {
    expect(appRoutes.at(-1)).toMatchObject({
      path: '/:pathMatch(.*)*',
      name: 'not-found',
    })

    const learnerIndex = appRoutes.findIndex((route) => route.name === 'elearning-learner')
    const adminIndex = appRoutes.findIndex((route) => route.name === 'elearning-admin')
    const gradingIndex = appRoutes.findIndex((route) => route.name === 'elearning-manual-grading')
    const catchAllIndex = appRoutes.findIndex((route) => route.name === 'not-found')
    expect(learnerIndex).toBeGreaterThanOrEqual(0)
    expect(adminIndex).toBeGreaterThanOrEqual(0)
    expect(gradingIndex).toBeGreaterThanOrEqual(0)
    expect(learnerIndex).toBeLessThan(catchAllIndex)
    expect(adminIndex).toBeLessThan(catchAllIndex)
    expect(gradingIndex).toBeLessThan(catchAllIndex)

    const elearningRoutes = appRoutes.filter((route) => {
      const pathValue = String(route.path)
      const name = String(route.name ?? '')
      return (
        pathValue === '/learn'
        || pathValue.includes('elearning')
        || pathValue.includes('plugin-elearning')
        || name.startsWith('elearning')
      )
    })

    expect(elearningRoutes.map((route) => route.path)).toEqual([
      '/learn',
      '/admin/elearning',
      '/elearning/grading',
    ])
  })

  // The plugin app.manifest.json navigation stays EXACTLY the pre-existing two
  // entries below — deliberately unchanged by the L3 grading route. Two reasons:
  // (1) it is deep-pinned in three places across two packages (this file,
  // plugins/plugin-elearning/__tests__/manifest.test.cjs, and
  // packages/core-backend/tests/unit/elearning-plugin-runtime.test.ts, the last
  // sitting in the required test(20.x) lane); (2) PlatformAppShellView.vue lists
  // manifest.navigation filtered only by `location !== 'hidden'` — no permission
  // check — so adding a grading nav entry there would advertise the surface to
  // every user who opens /apps/elearning, not just elearning:grade holders. The
  // route itself is still reachable directly (see the test above); it is just
  // not advertised in the app-launcher quick-entry list.
  it('exposes exactly two V0.1 plugin navigation entries and no broader capabilities', () => {
    expect(manifest.navigation).toEqual([
      {
        id: 'elearning-learner',
        title: '学习中心',
        path: '/learn',
        icon: 'book',
        order: 70,
        location: 'main-nav',
      },
      {
        id: 'elearning-admin',
        title: '云课堂管理',
        path: '/admin/elearning',
        icon: 'settings',
        order: 10,
        location: 'admin',
      },
    ])

    expect(manifest.navigation.map((item) => item.location)).toEqual(['main-nav', 'admin'])
    expect(manifest.objects).toEqual([])
    expect(manifest.workflows).toEqual([])
    expect(manifest.integrations).toEqual([])
    expect(manifest.featureFlags).toEqual(['elearning'])

    const serializedNav = JSON.stringify(manifest.navigation)
    expect(serializedNav).not.toMatch(/\/p\/plugin-elearning/)
    expect(serializedNav).not.toMatch(/elearning:write|elearning:grade|elearning:stats/)
    expect(serializedNav).not.toMatch(/elearning_course|ELEARNING_TASKS|ELEARNING_STATS/)
  })
})

describe('elearning V0.1 focus-mode reachability (behavior)', () => {
  const learnerMeta = {
    requiredFeature: 'elearning',
    permissions: ['elearning:read'],
  }
  const adminMeta = {
    requiredFeature: 'elearning',
    permissions: ['elearning:admin'],
  }
  const gradingMeta = {
    requiredFeature: 'elearning',
    permissions: ['elearning:grade'],
  }

  const ctx = (over: Partial<RouteGuardPolicyContext> = {}): RouteGuardPolicyContext => ({
    hasFeature: () => true,
    hasPermission: () => true,
    attendanceFocused: false,
    plmWorkbenchFocused: false,
    resolveHomePath: () => '/HOME',
    ...over,
  })
  const decide = (path: string, meta: unknown, over: Partial<RouteGuardPolicyContext> = {}) =>
    resolveRouteGuardDecision({ path, meta }, ctx(over))

  it('allows exact /learn, /admin/elearning, and /elearning/grading in attendance and plm-workbench focus after feature and permission gates', () => {
    for (const focus of [
      { attendanceFocused: true },
      { plmWorkbenchFocused: true },
    ] as const) {
      expect(decide('/learn', learnerMeta, focus)).toEqual({ action: 'allow' })
      expect(decide('/admin/elearning', adminMeta, focus)).toEqual({ action: 'allow' })
      expect(decide('/elearning/grading', gradingMeta, focus)).toEqual({ action: 'allow' })
    }
  })

  it('still redirects sibling and evil neighbors in both focus modes', () => {
    const evil = [
      '/learn/x',
      '/learn-evil',
      '/learner',
      '/admin/elearning/x',
      '/admin/elearning-evil',
      '/admin/elearnings',
      '/admin',
      '/elearning',
      '/elearning/grading/x',
      '/elearning/grading-evil',
      '/elearning/gradings',
    ]
    for (const path of evil) {
      expect(decide(path, {}, { attendanceFocused: true })).toEqual({
        action: 'redirect',
        target: '/attendance',
      })
      expect(decide(path, {}, { plmWorkbenchFocused: true })).toEqual({
        action: 'redirect',
        target: '/plm',
      })
    }
  })

  it('required-feature and exact route permission gates still win over focus reachability', () => {
    expect(decide('/learn', learnerMeta, {
      attendanceFocused: true,
      hasFeature: () => false,
    })).toEqual({ action: 'redirect', target: '/HOME' })
    expect(decide('/admin/elearning', adminMeta, {
      plmWorkbenchFocused: true,
      hasFeature: () => false,
    })).toEqual({ action: 'redirect', target: '/HOME' })
    expect(decide('/learn', learnerMeta, {
      attendanceFocused: true,
      hasPermission: () => false,
    })).toEqual({ action: 'redirect', target: '/HOME' })
    expect(decide('/admin/elearning', adminMeta, {
      plmWorkbenchFocused: true,
      hasPermission: (permission) => permission !== 'elearning:admin',
    })).toEqual({ action: 'redirect', target: '/HOME' })
    expect(decide('/elearning/grading', gradingMeta, {
      attendanceFocused: true,
      hasFeature: () => false,
    })).toEqual({ action: 'redirect', target: '/HOME' })
    expect(decide('/elearning/grading', gradingMeta, {
      plmWorkbenchFocused: true,
      hasPermission: (permission) => permission !== 'elearning:grade',
    })).toEqual({ action: 'redirect', target: '/HOME' })
  })
})
