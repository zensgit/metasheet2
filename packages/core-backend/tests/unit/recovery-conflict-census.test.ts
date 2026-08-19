/**
 * O2-S2 / O2-A1 — MECHANICAL census: every enumerated 40001 write surface routes through
 * the ONE classifier module (src/db/recovery-conflict.ts), and every individual call
 * site is linked to a discriminating behaviour leg.
 *
 * Lesson constraint (枚举陷阱不收敛): per-site try/catch traps do not converge, so the
 * gate is not "did we remember each trap" but a source-level census over a HARDCODED
 * table of the enumerated writers.
 *
 * O2-A1 upgrade (adversarial gate P3-1 — the L0 blocker): a token count alone proves
 * PRESENCE, not reachability — `if (false && sendIfRecoveryConflict(...))` kept the old
 * census green. The census therefore now pins, per row and per adapter token:
 *
 *   1. EXACT call-site count == the number of registered behaviour legs (a new call
 *      site without a registered leg turns this red — and so does deleting a site);
 *   2. every registered leg's `[recovery-census:<site>]` tag EXISTS in its named test
 *      file (deleting or renaming a behaviour leg turns this red);
 *   3. declarations (`function <token>(`) never satisfy a count — only call sites do.
 *
 * The REACHABILITY proof itself lives in the tagged behaviour legs: each one drives the
 * real route/service until the marker 40001 (or the named RecoveryConflictError) crosses
 * exactly that call site, so dead-branching any single site turns its tagged leg red.
 * This census is the inventory index that makes the per-site legs mechanically
 * complete: row ↔ leg linkage is 1:1 by construction, and a missing linkage is red.
 *
 * NIT-1 closure: routes/admin-users.ts's six platform-admin writer sites call the local
 * `sendIfRecoveryAuthorityBusy` wrapper (which delegates to sendIfRecoveryConflict), so
 * they are counted under their OWN token with six site-level legs — the single
 * delegation call inside the helper can no longer satisfy the row for all of them.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = path.resolve(__dirname, '../../src')
const TESTS_ROOT = path.resolve(__dirname, '.')

/** One behaviour leg: a census site id and the unit-test file carrying its tagged leg. */
type CensusLeg = {
  /** Stable site id; the linked test's name must contain `[recovery-census:<site>]`. */
  site: string
  /** File under tests/unit that carries the tagged discriminating behaviour leg. */
  testFile: string
}

type CensusCall = {
  /** Adapter call token this surface must invoke. */
  token: string
  /** Exactly one leg per call site — the source count must EQUAL legs.length. */
  legs: readonly CensusLeg[]
}

type WiringRequirement = {
  /** Repo-relative path under packages/core-backend/src. */
  file: string
  calls: readonly CensusCall[]
}

const SVC = 'recovery-conflict-surfaces-services.test.ts'
const RBAC = 'recovery-conflict-surfaces-routes-rbac.test.ts'
const AUTH = 'recovery-conflict-surfaces-routes-auth.test.ts'
const ADMDIR = 'recovery-conflict-surfaces-routes-admin-directory.test.ts'
const ADMUSR = 'admin-users-routes.test.ts'
const ACT = 'recovery-conflict-activate-mapping.test.ts'

/**
 * The census table. The first 11 rows are the O2-S2 taskbook's enumerated write
 * surfaces; the last two are the HTTP boundaries that complete two service surfaces
 * (mapActivateError lives in routes/admin-users.ts; the deprovision-evidence and
 * directory-sync service errors surface via routes/admin-directory.ts).
 */
const WIRING_CENSUS: readonly WiringRequirement[] = [
  {
    file: 'directory/deprovision-evidence-api.ts',
    calls: [{
      token: 'translateRecoveryConflict',
      legs: [
        { site: 'deprovision-evidence:compensate', testFile: SVC },
        { site: 'deprovision-evidence:restore', testFile: SVC },
      ],
    }],
  },
  {
    file: 'directory/deprovision-ledger.ts',
    calls: [{
      token: 'translateRecoveryConflict',
      legs: [{ site: 'deprovision-ledger:apply', testFile: SVC }],
    }],
  },
  {
    file: 'auth/invite-accept-writes.ts',
    calls: [{
      token: 'translateRecoveryConflict',
      legs: [{ site: 'invite-accept-writes:apply', testFile: SVC }],
    }],
  },
  {
    file: 'auth/user-activate.ts',
    calls: [{
      token: 'translateRecoveryConflict',
      legs: [{ site: 'user-activate:activate', testFile: SVC }],
    }],
  },
  {
    file: 'routes/attendance-admin.ts',
    calls: [{
      token: 'sendIfRecoveryConflict',
      legs: [
        { site: 'attendance-admin:batch-assign', testFile: RBAC },
        { site: 'attendance-admin:batch-unassign', testFile: RBAC },
        { site: 'attendance-admin:assign', testFile: RBAC },
        { site: 'attendance-admin:unassign', testFile: RBAC },
      ],
    }],
  },
  {
    file: 'routes/spreadsheet-permissions.ts',
    calls: [{
      token: 'sendIfRecoveryConflict',
      legs: [
        { site: 'spreadsheet-permissions:grant', testFile: RBAC },
        { site: 'spreadsheet-permissions:revoke', testFile: RBAC },
      ],
    }],
  },
  {
    file: 'routes/permissions.ts',
    calls: [{
      token: 'sendIfRecoveryConflict',
      legs: [
        { site: 'permissions:grant', testFile: RBAC },
        { site: 'permissions:revoke', testFile: RBAC },
        { site: 'permissions:template-apply', testFile: RBAC },
      ],
    }],
  },
  {
    file: 'routes/roles.ts',
    calls: [{
      token: 'sendIfRecoveryConflict',
      legs: [
        { site: 'roles:create', testFile: RBAC },
        { site: 'roles:update', testFile: RBAC },
        { site: 'roles:delete', testFile: RBAC },
      ],
    }],
  },
  {
    file: 'directory/directory-sync.ts',
    calls: [{
      token: 'translateRecoveryConflict',
      legs: [
        { site: 'directory-sync:sync-local-apply', testFile: SVC },
        { site: 'directory-sync:bind', testFile: SVC },
        { site: 'directory-sync:admit', testFile: SVC },
        { site: 'directory-sync:unbind', testFile: SVC },
      ],
    }],
  },
  {
    file: 'auth/dingtalk-oauth.ts',
    calls: [{
      token: 'translateRecoveryConflict',
      legs: [
        { site: 'dingtalk-oauth:provision', testFile: SVC },
        { site: 'dingtalk-oauth:bind-identity', testFile: SVC },
        { site: 'dingtalk-oauth:self-unbind', testFile: SVC },
      ],
    }],
  },
  {
    file: 'routes/auth.ts',
    calls: [
      {
        token: 'sendIfRecoveryConflict',
        legs: [
          { site: 'auth:register', testFile: AUTH },
          { site: 'auth:invite-accept', testFile: AUTH },
          { site: 'auth:dingtalk-unbind', testFile: AUTH },
          { site: 'auth:dingtalk-callback', testFile: AUTH },
          { site: 'auth:container-login', testFile: AUTH },
        ],
      },
      {
        // activate-intent passthrough: a recovery conflict must not collapse into
        // mapDingTalkActivationFailure's 500 fallback.
        token: 'classifyRecoveryConflict',
        legs: [{ site: 'auth:dingtalk-callback-activate-passthrough', testFile: AUTH }],
      },
    ],
  },
  {
    file: 'routes/admin-users.ts',
    calls: [
      {
        // The single delegation call INSIDE sendIfRecoveryAuthorityBusy.
        token: 'sendIfRecoveryConflict',
        legs: [{ site: 'admin-users:busy-delegation', testFile: ADMUSR }],
      },
      {
        // mapActivateError's retryable-409 branch.
        token: 'classifyRecoveryConflict',
        legs: [{ site: 'admin-users:activate-mapping', testFile: ACT }],
      },
      {
        // NIT-1: the six platform-admin writer sites, counted at SITE level — the
        // helper's internal delegation cannot satisfy these (declarations are
        // stripped before counting, so the helper's own `function` line is inert).
        token: 'sendIfRecoveryAuthorityBusy',
        legs: [
          { site: 'admin-users:member-group-action', testFile: ADMUSR },
          { site: 'admin-users:delegated-role-action', testFile: ADMUSR },
          { site: 'admin-users:create-user', testFile: ADMUSR },
          { site: 'admin-users:role-assign', testFile: ADMUSR },
          { site: 'admin-users:role-unassign', testFile: ADMUSR },
          { site: 'admin-users:status', testFile: ADMUSR },
        ],
      },
    ],
  },
  {
    file: 'routes/admin-directory.ts',
    calls: [{
      token: 'sendIfRecoveryConflict',
      legs: [
        { site: 'admin-directory:sync-async', testFile: ADMDIR },
        { site: 'admin-directory:sync', testFile: ADMDIR },
        { site: 'admin-directory:bind', testFile: ADMDIR },
        { site: 'admin-directory:admit-user', testFile: ADMDIR },
        { site: 'admin-directory:batch-bind', testFile: ADMDIR },
        { site: 'admin-directory:batch-admit', testFile: ADMDIR },
        { site: 'admin-directory:unbind', testFile: ADMDIR },
        { site: 'admin-directory:batch-unbind', testFile: ADMDIR },
        { site: 'admin-directory:deprovision-restore', testFile: ADMDIR },
        { site: 'admin-directory:compensate-deny', testFile: ADMDIR },
      ],
    }],
  },
] as const

const IMPORT_RE = /from\s+['"][^'"]*\/db\/recovery-conflict['"]/

/** Comments must not satisfy the census — strip them before counting call tokens. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

/** A declaration is not a call — strip `function <token>(` before counting. */
function countCalls(strippedSource: string, token: string): number {
  const withoutDeclarations = strippedSource.replace(
    new RegExp(`\\bfunction\\s+${token}\\s*\\(`, 'g'),
    '',
  )
  const matches = withoutDeclarations.match(new RegExp(`\\b${token}\\s*\\(`, 'g'))
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
      if (count !== call.legs.length) {
        violations.push(
          `${requirement.file}: expected exactly ${call.legs.length} call site(s) of `
          + `${call.token}() (one per registered behaviour leg), found ${count} — `
          + 'register a [recovery-census:<site>] leg for every call site',
        )
      }
    }
  }
  return violations
}

/**
 * Row ↔ behaviour-leg linkage: every registered leg's tag must exist in its named test
 * file. Over CONTENT so the negative controls can run the same logic on mutated copies.
 */
function auditCensusLegLinkage(testContents: ReadonlyMap<string, string>): string[] {
  const violations: string[] = []
  const seenSites = new Set<string>()
  for (const requirement of WIRING_CENSUS) {
    for (const call of requirement.calls) {
      for (const leg of call.legs) {
        if (seenSites.has(leg.site)) {
          violations.push(`${leg.site}: DUPLICATE site id in the census table`)
          continue
        }
        seenSites.add(leg.site)
        const content = testContents.get(leg.testFile)
        if (content === undefined) {
          violations.push(`${leg.site}: linked test file ${leg.testFile} MISSING from the content map`)
          continue
        }
        if (content.trim().length === 0) {
          violations.push(`${leg.site}: linked test file ${leg.testFile} is EMPTY — linkage scan broken`)
          continue
        }
        if (!content.includes(`[recovery-census:${leg.site}]`)) {
          violations.push(
            `${leg.site}: no test tagged [recovery-census:${leg.site}] in ${leg.testFile}`,
          )
        }
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

function loadRealTestContents(): Map<string, string> {
  const contents = new Map<string, string>()
  for (const requirement of WIRING_CENSUS) {
    for (const call of requirement.calls) {
      for (const leg of call.legs) {
        if (!contents.has(leg.testFile)) {
          contents.set(leg.testFile, readFileSync(path.join(TESTS_ROOT, leg.testFile), 'utf8'))
        }
      }
    }
  }
  return contents
}

describe('O2-S2/O2-A1 recovery-conflict wiring census', () => {
  it('every enumerated write surface routes through the single classifier module, one call site per registered leg', () => {
    expect(auditRecoveryConflictWiring(loadRealContents())).toEqual([])
  })

  it('every census row is linked to its tagged behaviour leg (row ↔ leg 1:1; missing linkage = red)', () => {
    expect(auditCensusLegLinkage(loadRealTestContents())).toEqual([])
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

  it('NEGATIVE CONTROL: a NEW call site without a registered behaviour leg turns the census red', () => {
    const contents = loadRealContents()
    const target = 'routes/roles.ts'
    const original = contents.get(target) as string
    expect(countCalls(stripComments(original), 'sendIfRecoveryConflict')).toBe(3)

    // A hypothetical new handler adds a 4th call site but nobody registers a leg.
    const mutated = `${original}\nexport function newHandlerHook(res: never, error: never) { if (sendIfRecoveryConflict(res, error)) return }\n`
    contents.set(target, mutated)

    const violations = auditRecoveryConflictWiring(contents)
    expect(
      violations.some((entry) =>
        entry.startsWith(`${target}:`)
        && entry.includes('found 4')
        && entry.includes('behaviour leg'),
      ),
    ).toBe(true)
  })

  it('NEGATIVE CONTROL: a declaration cannot satisfy a site count (only call sites count)', () => {
    // The helper's own declaration line must be inert…
    expect(countCalls('function sendIfRecoveryAuthorityBusy(res: Response, error: unknown): boolean {', 'sendIfRecoveryAuthorityBusy')).toBe(0)
    // …while a real call site still counts (positive control for the counter).
    expect(countCalls('if (sendIfRecoveryAuthorityBusy(res, error)) return', 'sendIfRecoveryAuthorityBusy')).toBe(1)
    // And the REAL admin-users source counts exactly its six writer sites, not seven
    // (six calls + one declaration).
    const source = stripComments(
      readFileSync(path.join(SRC_ROOT, 'routes/admin-users.ts'), 'utf8'),
    )
    expect(countCalls(source, 'sendIfRecoveryAuthorityBusy')).toBe(6)
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

  it('NEGATIVE CONTROL: deleting a behaviour-leg tag from its test file turns the linkage audit red', () => {
    const testContents = loadRealTestContents()
    const target = 'recovery-conflict-surfaces-routes-rbac.test.ts'
    const tag = '[recovery-census:roles:update]'
    const original = testContents.get(target) as string
    // Anchor: the tag must exist before we delete it.
    expect(original.includes(tag)).toBe(true)

    testContents.set(target, original.replace(tag, ''))
    const violations = auditCensusLegLinkage(testContents)
    expect(violations).toEqual([
      `roles:update: no test tagged ${tag} in ${target}`,
    ])
  })
})
