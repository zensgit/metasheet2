import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'

import { matchesAnyPermission, matchesPermission } from '../src/utils/permission-match'
import { useAuth } from '../src/composables/useAuth'
import { isPlatformAppAccessible, type PlatformAppSummary } from '../src/composables/usePlatformApps'

/**
 * Browser side of the two-sided pin for App Center visibility (G-7 ④).
 *
 * THE SAME FILE on disk drives `packages/core-backend/tests/unit/permission-match.test.ts`. That is
 * the point: a server-only or browser-only change to the algebra turns the other side red, so the
 * server can never hide a card the browser still shows (a dead entry) or show one the server
 * refuses (a 404 on click) — either split is itself the fake entry G-7 exists to forbid.
 */
const TRUTH_TABLE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/core-backend/tests/fixtures/permission-match-truth-table.json',
)

interface TruthTable {
  cases: Array<{ name: string; codes: string[]; required: string; expected: boolean }>
  anyOfCases: Array<{ name: string; codes: string[]; required: string[]; expected: boolean }>
}

const table = JSON.parse(readFileSync(TRUTH_TABLE_PATH, 'utf8')) as TruthTable

/**
 * `getAccessSnapshot` treats these as "this principal is an administrator" and `hasPermission`
 * short-circuits on them BEFORE the code algebra. Rows holding one of them therefore describe the
 * pure matcher only, and are replayed through `hasPermission` in the admin-bypass case below
 * instead of in the delegation case.
 */
const ADMIN_MARKERS = ['*:*', 'admin:all', 'users:write', 'roles:write', 'permissions:write']

function holdsAdminMarker(codes: string[]): boolean {
  return codes.some((code) => ADMIN_MARKERS.includes(code.trim()))
}

function seedPermissions(codes: string[]): void {
  localStorage.setItem('user_permissions', JSON.stringify(codes))
  localStorage.removeItem('user_roles')
}

describe('permission-match parity with the server matcher', () => {
  it('reads a non-trivial table (a silently emptied fixture must not pass as green)', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(20)
    expect(table.anyOfCases.length).toBeGreaterThanOrEqual(5)
    expect(table.cases.some((row) => row.expected === false)).toBe(true)
  })

  it.each(table.cases.map((row) => [row.name, row] as const))(
    'matchesPermission: %s',
    (_name, row) => {
      expect(matchesPermission(row.codes, row.required)).toBe(row.expected)
    },
  )

  it.each(table.anyOfCases.map((row) => [row.name, row] as const))(
    'matchesAnyPermission: %s',
    (_name, row) => {
      expect(matchesAnyPermission(row.codes, row.required)).toBe(row.expected)
    },
  )
})

describe('useAuth().hasPermission delegates to that same matcher', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  const delegated = table.cases.filter((row) => !holdsAdminMarker(row.codes))

  it('covers most of the table (the admin-marker rows are the only exclusions)', () => {
    expect(delegated.length).toBeGreaterThanOrEqual(table.cases.length - 3)
  })

  it.each(delegated.map((row) => [row.name, row] as const))(
    'hasPermission: %s',
    (_name, row) => {
      seedPermissions(row.codes)
      expect(useAuth().hasPermission(row.required)).toBe(row.expected)
    },
  )

  it('still short-circuits on the admin snapshot, which is why those rows are excluded', () => {
    // `admin:all` is NOT a wildcard in the algebra (the table says false) but IS an admin marker in
    // the snapshot, so the composable answers true. That difference is the bypass, not a drift.
    expect(matchesPermission(['admin:all'], 'stock-prep:read')).toBe(false)
    seedPermissions(['admin:all'])
    expect(useAuth().hasPermission('stock-prep:read')).toBe(true)
    expect(useAuth().hasAdminAccess()).toBe(true)
  })
})

function summary(permissions: string[]): PlatformAppSummary {
  return { id: 'stock-preparation', permissions } as unknown as PlatformAppSummary
}

describe('isPlatformAppAccessible (the App Center card gate)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('hides an app when the caller holds none of its declared codes', () => {
    seedPermissions(['elearning:read', 'integration:write'])
    expect(isPlatformAppAccessible(summary(['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin']))).toBe(false)
  })

  it('shows it on ANY ONE declared code', () => {
    for (const held of ['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin']) {
      localStorage.clear()
      seedPermissions([held])
      expect(isPlatformAppAccessible(summary(['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin']))).toBe(true)
    }
  })

  it('treats an app that declares no codes as public, and an unusable declaration as closed', () => {
    seedPermissions([])
    expect(isPlatformAppAccessible(summary([]))).toBe(true)
    expect(isPlatformAppAccessible(summary(['', '   ']))).toBe(false)
  })

  it('lets a platform admin through', () => {
    localStorage.setItem('user_roles', JSON.stringify(['admin']))
    localStorage.setItem('user_permissions', JSON.stringify([]))
    expect(isPlatformAppAccessible(summary(['stock-prep:read']))).toBe(true)
  })

  it('agrees with the shared any-of table row for row', () => {
    for (const row of table.anyOfCases) {
      if (holdsAdminMarker(row.codes)) continue
      localStorage.clear()
      seedPermissions(row.codes)
      expect(
        isPlatformAppAccessible(summary(row.required)),
        `${row.name}: browser card gate disagrees with the shared truth table`,
      ).toBe(row.expected)
    }
  })
})
