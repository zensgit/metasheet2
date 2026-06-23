import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Source guard against the 委托设置 page becoming an orphan: DelegationSettingsView.vue is
 * only a usable product capability if it is wired into the router under the manage
 * permission. Asserted on the appRoutes.ts SOURCE (not an import — appRoutes top-level
 * imports real .vue views, which pull in Element Plus CSS that vitest can't transform).
 */
const routesSrc = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/router/appRoutes.ts'),
  'utf8',
)

describe('委托设置 route', () => {
  it('declares the /approval-delegations route (DelegationSettingsView is reachable)', () => {
    expect(routesSrc, 'no /approval-delegations route — DelegationSettingsView would be unreachable').toContain("path: '/approval-delegations'")
  })

  it('points the route at DelegationSettingsView', () => {
    expect(routesSrc).toMatch(/approval-delegations[\s\S]{0,200}DelegationSettingsView\.vue/)
  })

  it('guards the route with approval-templates:manage', () => {
    expect(routesSrc).toMatch(/approval-delegations[\s\S]{0,400}approval-templates:manage/)
  })
})
