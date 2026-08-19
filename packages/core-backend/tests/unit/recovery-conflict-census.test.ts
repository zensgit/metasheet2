/**
 * O2-S2 — MECHANICAL census: every enumerated 40001 write surface routes through the ONE
 * classifier module (src/db/recovery-conflict.ts).
 *
 * Lesson constraint (枚举陷阱不收敛): per-site try/catch traps do not converge, so the
 * gate is not "did we remember each trap" but a source-level census over a HARDCODED
 * table of the enumerated writers: each file must import the classifier module and carry
 * at least the expected number of adapter calls. Removing a wiring — or a single call
 * site from a multi-site file — turns this red (proven by the negative controls below,
 * which run the SAME census function over mutated copies of the real sources).
 *
 * This is a static census, not a behaviour proof — the discriminating behaviour tests
 * live in recovery-conflict-classifier.test.ts and recovery-conflict-surfaces-*.test.ts.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = path.resolve(__dirname, '../../src')

type WiringRequirement = {
  /** Repo-relative path under packages/core-backend/src. */
  file: string
  /** Adapter call tokens this surface must invoke, with the minimum call-site count. */
  calls: Array<{ token: string; minCount: number }>
}

/**
 * The census table. The first 11 rows are the O2-S2 taskbook's enumerated write
 * surfaces; the last two are the HTTP boundaries that complete two service surfaces
 * (mapActivateError lives in routes/admin-users.ts; the deprovision-evidence and
 * directory-sync service errors surface via routes/admin-directory.ts).
 */
const WIRING_CENSUS: readonly WiringRequirement[] = [
  { file: 'directory/deprovision-evidence-api.ts', calls: [{ token: 'translateRecoveryConflict', minCount: 2 }] },
  { file: 'directory/deprovision-ledger.ts', calls: [{ token: 'translateRecoveryConflict', minCount: 1 }] },
  { file: 'auth/invite-accept-writes.ts', calls: [{ token: 'translateRecoveryConflict', minCount: 1 }] },
  { file: 'auth/user-activate.ts', calls: [{ token: 'translateRecoveryConflict', minCount: 1 }] },
  { file: 'routes/attendance-admin.ts', calls: [{ token: 'sendIfRecoveryConflict', minCount: 4 }] },
  { file: 'routes/spreadsheet-permissions.ts', calls: [{ token: 'sendIfRecoveryConflict', minCount: 2 }] },
  { file: 'routes/permissions.ts', calls: [{ token: 'sendIfRecoveryConflict', minCount: 3 }] },
  { file: 'routes/roles.ts', calls: [{ token: 'sendIfRecoveryConflict', minCount: 3 }] },
  { file: 'directory/directory-sync.ts', calls: [{ token: 'translateRecoveryConflict', minCount: 4 }] },
  { file: 'auth/dingtalk-oauth.ts', calls: [{ token: 'translateRecoveryConflict', minCount: 3 }] },
  {
    file: 'routes/auth.ts',
    calls: [
      // register / invite-accept / dingtalk unbind / dingtalk callback / container login.
      { token: 'sendIfRecoveryConflict', minCount: 5 },
      // activate-intent passthrough: a recovery conflict must not collapse into
      // mapDingTalkActivationFailure's 500 fallback.
      { token: 'classifyRecoveryConflict', minCount: 1 },
    ],
  },
  {
    file: 'routes/admin-users.ts',
    calls: [
      // sendIfRecoveryAuthorityBusy delegates here for all six platform-admin writers.
      { token: 'sendIfRecoveryConflict', minCount: 1 },
      // mapActivateError's retryable-409 branch.
      { token: 'classifyRecoveryConflict', minCount: 1 },
    ],
  },
  // restore / compensate / sync x2 / bind / admit / batch-bind / batch-admit /
  // unbind / batch-unbind.
  { file: 'routes/admin-directory.ts', calls: [{ token: 'sendIfRecoveryConflict', minCount: 10 }] },
] as const

const IMPORT_RE = /from\s+['"][^'"]*\/db\/recovery-conflict['"]/

/** Comments must not satisfy the census — strip them before counting call tokens. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

function countCalls(strippedSource: string, token: string): number {
  const matches = strippedSource.match(new RegExp(`\\b${token}\\s*\\(`, 'g'))
  return matches ? matches.length : 0
}

/**
 * The census core, over CONTENT (not paths) so the negative controls can run the exact
 * same logic against mutated copies. Returns human-readable violations; [] means wired.
 */
function auditRecoveryConflictWiring(contents: ReadonlyMap<string, string>): string[] {
  const violations: string[] = []
  for (const requirement of WIRING_CENSUS) {
    const source = contents.get(requirement.file)
    if (source === undefined) {
      violations.push(`${requirement.file}: MISSING from the provided content map`)
      continue
    }
    // Guard the scan itself (扫描窗口教训): an empty read is indistinguishable from an
    // unwired file, so fail loudly on it rather than counting zero occurrences.
    if (source.trim().length === 0) {
      violations.push(`${requirement.file}: EMPTY source — census scan itself is broken`)
      continue
    }
    if (!IMPORT_RE.test(source)) {
      violations.push(`${requirement.file}: no import from db/recovery-conflict`)
    }
    const stripped = stripComments(source)
    for (const call of requirement.calls) {
      const count = countCalls(stripped, call.token)
      if (count < call.minCount) {
        violations.push(
          `${requirement.file}: expected >= ${call.minCount} call(s) of ${call.token}(), found ${count}`,
        )
      }
    }
  }
  return violations
}

function loadRealContents(): Map<string, string> {
  const contents = new Map<string, string>()
  for (const requirement of WIRING_CENSUS) {
    contents.set(requirement.file, readFileSync(path.join(SRC_ROOT, requirement.file), 'utf8'))
  }
  return contents
}

describe('O2-S2 recovery-conflict wiring census', () => {
  it('every enumerated write surface routes through the single classifier module', () => {
    expect(auditRecoveryConflictWiring(loadRealContents())).toEqual([])
  })

  it('NEGATIVE CONTROL: fully unwiring one surface turns the census red', () => {
    const contents = loadRealContents()
    const target = 'routes/roles.ts'
    const original = contents.get(target) as string
    // Mutation anchor: the wiring must actually be present before we strip it —
    // otherwise this control proves nothing (无效mutation教训).
    expect(original).toMatch(/\bsendIfRecoveryConflict\b/)

    const mutated = original.replace(/\bsendIfRecoveryConflict\b/g, 'neverClassifiedHere')
    expect(mutated).not.toBe(original)
    contents.set(target, mutated)

    const violations = auditRecoveryConflictWiring(contents)
    expect(violations.some((entry) => entry.startsWith(`${target}:`))).toBe(true)
    // And ONLY that surface regressed — the control must not pass by breaking the world.
    expect(violations.filter((entry) => !entry.startsWith(`${target}:`))).toEqual([])
  })

  it('NEGATIVE CONTROL: dropping a single call site from a multi-site surface turns the census red', () => {
    const contents = loadRealContents()
    const target = 'routes/attendance-admin.ts'
    const original = contents.get(target) as string
    const callRe = /\bsendIfRecoveryConflict\s*\(/
    expect(callRe.test(stripComments(original))).toBe(true)

    // Neutralize exactly one call site (rename its identifier; the import stays).
    const mutated = original.replace(callRe, 'sendIfRecoveryConflictDisabled(')
    expect(mutated).not.toBe(original)
    contents.set(target, mutated)

    const violations = auditRecoveryConflictWiring(contents)
    expect(
      violations.some((entry) =>
        entry.startsWith(`${target}:`) && entry.includes('sendIfRecoveryConflict'),
      ),
    ).toBe(true)
  })

  it('NEGATIVE CONTROL: a comment cannot satisfy the census (call counting ignores comments)', () => {
    const stripped = stripComments(
      '// sendIfRecoveryConflict(res, error)\n/* translateRecoveryConflict(() => op()) */\nconst x = 1\n',
    )
    expect(countCalls(stripped, 'sendIfRecoveryConflict')).toBe(0)
    expect(countCalls(stripped, 'translateRecoveryConflict')).toBe(0)
    // Positive control for the counter itself.
    expect(countCalls('await sendIfRecoveryConflict(res, error)', 'sendIfRecoveryConflict')).toBe(1)
  })
})
