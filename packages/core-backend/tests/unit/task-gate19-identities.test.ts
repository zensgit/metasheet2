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
