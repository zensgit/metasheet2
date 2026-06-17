import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { isRoutePermitted, routeMetaPermissions } from '../src/router/routeAccess'

/**
 * Locks the router permission gate that protects the approval-template authoring
 * routes. Two complementary checks:
 *   1. The pure `routeAccess` gate (extracted from main.ts beforeEach) — the
 *      "non-manager is redirected away" invariant, previously untested.
 *   2. A source-level drift pin on appRoutes.ts — the authoring routes must keep
 *      `permissions: ['approval-templates:manage']` so the FE fence can't drift
 *      out of sync with the backend rbacGuard. (Read at the source level on
 *      purpose: importing appRoutes eagerly pulls every view + element-plus CSS
 *      into the jsdom test, matching the repo's existing `.guard.test.ts` idiom.)
 */
describe('routeAccess gate (extracted from the router beforeEach)', () => {
  it('blocks when a required permission is missing, allows when all are held', () => {
    const manageMeta = { permissions: ['approval-templates:manage'] }
    expect(isRoutePermitted(manageMeta, () => false)).toBe(false)
    expect(isRoutePermitted(manageMeta, (p) => p === 'approval-templates:manage')).toBe(true)
    // every() semantics: ALL declared permissions are required
    expect(isRoutePermitted({ permissions: ['a', 'b'] }, (p) => p === 'a')).toBe(false)
    expect(isRoutePermitted({ permissions: ['a', 'b'] }, () => true)).toBe(true)
  })

  it('permits routes that declare no permissions (byte-identical baseline)', () => {
    expect(isRoutePermitted({ permissions: [] }, () => false)).toBe(true)
    expect(isRoutePermitted({}, () => false)).toBe(true)
    expect(isRoutePermitted(undefined, () => false)).toBe(true)
  })

  it('routeMetaPermissions normalizes missing / non-array meta to []', () => {
    expect(routeMetaPermissions(undefined)).toEqual([])
    expect(routeMetaPermissions({})).toEqual([])
    expect(routeMetaPermissions({ permissions: 'x' })).toEqual([])
    expect(routeMetaPermissions({ permissions: ['x'] })).toEqual(['x'])
  })
})

describe('approval-template authoring routes require approval-templates:manage (drift pin)', () => {
  const SRC = readFileSync(join(__dirname, '../src/router/appRoutes.ts'), 'utf8')

  // Find a route's source block by its PATH so the block includes — and the test
  // asserts — the path value the title claims, plus the path→name binding (the
  // earlier name-anchored slice started after the path line and never checked it).
  function routeBlockByPath(path: string): string | null {
    const i = SRC.indexOf(`path: '${path}'`)
    if (i === -1) return null
    const end = SRC.indexOf('\n  },', i)
    return end === -1 ? SRC.slice(i) : SRC.slice(i, end)
  }

  for (const [name, path] of [
    ['approval-template-create', '/approval-templates/new'],
    ['approval-template-edit', '/approval-templates/:id/edit'],
  ] as const) {
    it(`${name} (${path}) is auth-gated to exactly approval-templates:manage`, () => {
      const block = routeBlockByPath(path)
      expect(block, `route ${path} must exist in appRoutes.ts`).toBeTruthy()
      // path → name → fence all asserted on the same route object
      expect(block).toContain(`name: '${name}'`)
      expect(block).toMatch(/requiresAuth:\s*true/)
      expect(block).toMatch(/permissions:\s*\[\s*'approval-templates:manage'\s*\]/)
    })
  }

  it('the public template-list route (/approval-templates) stays unguarded (no false-positive fence)', () => {
    const block = routeBlockByPath('/approval-templates')
    expect(block).toBeTruthy()
    expect(block).toContain("name: 'approval-template-list'")
    expect(block).not.toMatch(/permissions:/)
  })
})
