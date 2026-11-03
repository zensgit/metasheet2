import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { diffIdentities, lockIdentities, passedIdentities } from '../helpers/gate19-identities'

const LOCK = [
  'text',
  '```i-m2',
  'gate19|assignee|assigned',
  'gate19|creator|delegated|noa',
  '```',
].join('\n')

describe('gate 19 identity extraction', () => {
  it('counts only passed (✓) lines, across files, with prefixes and ANSI stripped', () => {
    const verbose = [
      ' ✓ tests/integration/task-a.db.test.ts > grid > gate19|assignee|assigned 12ms',
      ' \u001b[32m✓\u001b[39m tests/integration/task-b.db.test.ts > gate19|creator|delegated|noa\u001b[33m 340ms\u001b[39m',
      ' ↓ tests/integration/task-b.db.test.ts > gate19|none|assigned [skipped]',
      ' × tests/integration/task-b.db.test.ts > gate19|none|following',
    ].join('\n')
    expect(passedIdentities(verbose)).toEqual(['gate19|assignee|assigned', 'gate19|creator|delegated|noa'])
  })

  it('reads the i-m2 block from the lock', () => {
    expect(lockIdentities(LOCK)).toEqual(['gate19|assignee|assigned', 'gate19|creator|delegated|noa'])
  })

  it('equal sets give an empty diff', () => {
    const verbose = ' ✓ a > gate19|assignee|assigned\n ✓ b > gate19|creator|delegated|noa'
    expect(diffIdentities(passedIdentities(verbose), lockIdentities(LOCK))).toEqual({ missing: [], extra: [] })
  })

  it('a skipped cell counts as missing, so a skipped grid cannot pass', () => {
    const verbose = ' ✓ a > gate19|assignee|assigned\n ↓ b > gate19|creator|delegated|noa [skipped]'
    expect(diffIdentities(passedIdentities(verbose), lockIdentities(LOCK)).missing).toEqual(['gate19|creator|delegated|noa'])
  })

  it('a cell that is not in the lock is reported as extra', () => {
    const verbose = ' ✓ a > gate19|assignee|assigned\n ✓ b > gate19|creator|delegated|noa\n ✓ c > gate19|none|any_role|of'
    expect(diffIdentities(passedIdentities(verbose), lockIdentities(LOCK)).extra).toEqual(['gate19|none|any_role|of'])
  })

  it('throws when the lock has no i-m2 block', () => {
    expect(() => lockIdentities('no block here')).toThrow()
  })
})

// ASSUMPTION(task-m4): [own-20] the i-m4 list sits in the M4 design doc (candidate, not in the lock).
describe('gate 19 identity extraction — M4 parameters', () => {
  const DESIGN = new URL('../../../../docs/development/task-m4-pr3a-backend-design-20260930.md', import.meta.url)
  const LIST_ROLES = new URL('../integration/task-m4-list-roles.db.test.ts', import.meta.url)
  const M4 = { fence: 'i-m4', prefix: 'gate19m4|' }

  it('the default prefix does not pick up gate19m4 names, and the M4 prefix does not pick up gate19 names', () => {
    const verbose = ' ✓ a > gate19|assignee|assigned\n ✓ b > gate19m4|list-reader|any_role'
    expect(passedIdentities(verbose)).toEqual(['gate19|assignee|assigned'])
    expect(passedIdentities(verbose, { prefix: M4.prefix })).toEqual(['gate19m4|list-reader|any_role'])
  })

  it('reads a named fence and prefix; the defaults still read i-m2', () => {
    const md = ['```i-m2', 'gate19|assignee|assigned', '```', '```i-m4', 'gate19m4|list-editor|created', '```'].join('\n')
    expect(lockIdentities(md)).toEqual(['gate19|assignee|assigned'])
    expect(lockIdentities(md, M4)).toEqual(['gate19m4|list-editor|created'])
    expect(() => lockIdentities('```i-m2\ngate19|a|b\n```', M4)).toThrow()
  })

  it('the design i-m4 block equals the 25 names in task-m4-list-roles.db.test.ts', () => {
    const fromDesign = lockIdentities(readFileSync(DESIGN, 'utf8'), M4)
    const source = readFileSync(LIST_ROLES, 'utf8')
    const fromTest = [...new Set([...source.matchAll(/'(gate19m4\|[A-Za-z0-9|+_-]+)'/g)].map((m) => m[1]))].sort()
    expect(fromDesign).toHaveLength(25)
    expect(fromTest).toEqual(fromDesign)
  })
})
