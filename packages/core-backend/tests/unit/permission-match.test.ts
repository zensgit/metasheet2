import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { matchesAnyPermission, matchesPermission, normalizePermissionCodes } from '../../src/auth/permission-match'

/**
 * Server side of the two-sided pin. The SAME file is replayed by
 * `apps/web/tests/permission-match-parity.spec.ts` against `apps/web/src/utils/permission-match.ts`
 * (which `useAuth().hasPermission` delegates to), so the browser and the App Center router cannot
 * drift into a state where one hides a card the other shows.
 */
const TRUTH_TABLE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/permission-match-truth-table.json',
)

interface TruthTable {
  cases: Array<{ name: string; codes: string[]; required: string; expected: boolean }>
  anyOfCases: Array<{ name: string; codes: string[]; required: string[]; expected: boolean }>
}

const table = JSON.parse(fs.readFileSync(TRUTH_TABLE_PATH, 'utf8')) as TruthTable

describe('permission-match (shared truth table)', () => {
  it('reads a non-trivial table (a silently emptied fixture must not pass as green)', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(20)
    expect(table.anyOfCases.length).toBeGreaterThanOrEqual(5)
    expect(table.cases.some((row) => row.expected === false)).toBe(true)
    expect(table.anyOfCases.some((row) => row.expected === false)).toBe(true)
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

describe('normalizePermissionCodes', () => {
  it('drops non-strings, trims, and drops blanks', () => {
    expect(normalizePermissionCodes(['  a:b ', '', '   ', 42, null, 'c:d'] as unknown)).toEqual(['a:b', 'c:d'])
  })

  it('answers [] for every non-array shape', () => {
    for (const value of [undefined, null, 'a:b', 7, {}, { permissions: ['a:b'] }]) {
      expect(normalizePermissionCodes(value)).toEqual([])
    }
  })
})
