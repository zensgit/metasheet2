import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RouteRecordRaw } from 'vue-router'
import { describe, expect, it } from 'vitest'
import { appRoutes } from '../src/router/appRoutes'

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

  it('keeps the catch-all last and does not expose broader e-learning routes', () => {
    expect(appRoutes.at(-1)).toMatchObject({
      path: '/:pathMatch(.*)*',
      name: 'not-found',
    })

    const learnerIndex = appRoutes.findIndex((route) => route.name === 'elearning-learner')
    const adminIndex = appRoutes.findIndex((route) => route.name === 'elearning-admin')
    const catchAllIndex = appRoutes.findIndex((route) => route.name === 'not-found')
    expect(learnerIndex).toBeGreaterThanOrEqual(0)
    expect(adminIndex).toBeGreaterThanOrEqual(0)
    expect(learnerIndex).toBeLessThan(catchAllIndex)
    expect(adminIndex).toBeLessThan(catchAllIndex)

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

    expect(elearningRoutes.map((route) => route.path)).toEqual(['/learn', '/admin/elearning'])
  })

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
