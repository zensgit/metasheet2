/**
 * O2-A1 / P3-1 — the SHARED recovery-conflict census table.
 *
 * Extracted from tests/unit/recovery-conflict-census.test.ts so that BOTH the static
 * census (source-level call-site count per row) and the RUNTIME leg recorder
 * (tests/unit/lib/recovery-census-recorder.ts) read the same single source of truth.
 * A site can therefore never be "registered" for the census while being unknown to the
 * runtime coverage assertion, or vice versa.
 */

/** One behaviour leg: a census site id and the unit-test file carrying its tagged leg. */
export type CensusLeg = {
  /** Stable site id; the linked test's name must contain `[recovery-census:<site>]`. */
  site: string
  /** File under tests/unit that carries the tagged discriminating behaviour leg. */
  testFile: string
}

export type CensusCall = {
  /** Adapter call token this surface must invoke. */
  token: string
  /** Exactly one leg per call site — the source count must EQUAL legs.length. */
  legs: readonly CensusLeg[]
}

export type WiringRequirement = {
  /** Repo-relative path under packages/core-backend/src. */
  file: string
  calls: readonly CensusCall[]
}

export const SVC = 'recovery-conflict-surfaces-services.test.ts'
export const RBAC = 'recovery-conflict-surfaces-routes-rbac.test.ts'
export const AUTH = 'recovery-conflict-surfaces-routes-auth.test.ts'
export const ADMDIR = 'recovery-conflict-surfaces-routes-admin-directory.test.ts'
export const ADMUSR = 'admin-users-routes.test.ts'
export const ACT = 'recovery-conflict-activate-mapping.test.ts'

/**
 * The census table. The first 11 rows are the O2-S2 taskbook's enumerated write
 * surfaces; the last two are the HTTP boundaries that complete two service surfaces
 * (mapActivateError lives in routes/admin-users.ts; the deprovision-evidence and
 * directory-sync service errors surface via routes/admin-directory.ts).
 */
export const WIRING_CENSUS: readonly WiringRequirement[] = [
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

/** Every registered leg, flattened, in table order. */
export function allCensusLegs(): CensusLeg[] {
  const legs: CensusLeg[] = []
  for (const requirement of WIRING_CENSUS) {
    for (const call of requirement.calls) {
      for (const leg of call.legs) legs.push(leg)
    }
  }
  return legs
}

/**
 * site-id set per linked test file. Derived — never hand-maintained — so the runtime
 * recorder and the static census can never disagree about which sites a file owns.
 */
export function censusSitesByTestFile(): Map<string, ReadonlySet<string>> {
  const byFile = new Map<string, Set<string>>()
  for (const leg of allCensusLegs()) {
    let bucket = byFile.get(leg.testFile)
    if (!bucket) {
      bucket = new Set<string>()
      byFile.set(leg.testFile, bucket)
    }
    bucket.add(leg.site)
  }
  return byFile as Map<string, ReadonlySet<string>>
}

/** The distinct test files carrying census legs. */
export function censusTestFiles(): string[] {
  return [...censusSitesByTestFile().keys()]
}
