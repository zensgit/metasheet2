import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Source guard against the 我的委托 self-service page becoming an orphan: MyDelegationView.vue
 * is only a usable capability if wired into the router. Asserted on the appRoutes.ts SOURCE
 * (not an import — top-level view imports pull in Element Plus CSS vitest can't transform).
 *
 * Unlike 委托设置 (admin, approval-templates:manage), self-service is available to ANY
 * authenticated user — it must be requiresAuth WITHOUT a manage permission.
 */
const routesSrc = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/router/appRoutes.ts'),
  'utf8',
)

describe('我的委托 (self-service) route', () => {
  it('declares the /my-delegation route (MyDelegationView is reachable)', () => {
    expect(routesSrc, 'no /my-delegation route — MyDelegationView would be unreachable').toContain("path: '/my-delegation'")
  })

  it('points the route at MyDelegationView', () => {
    expect(routesSrc).toMatch(/my-delegation[\s\S]{0,200}MyDelegationView\.vue/)
  })

  it('does NOT gate self-service behind a manage permission (any authenticated user)', () => {
    const block = routesSrc.slice(routesSrc.indexOf("path: '/my-delegation'"))
    const meta = block.slice(0, block.indexOf('}', block.indexOf('meta:')))
    expect(meta).toContain('requiresAuth: true')
    expect(meta).not.toContain('permissions')
  })
})
