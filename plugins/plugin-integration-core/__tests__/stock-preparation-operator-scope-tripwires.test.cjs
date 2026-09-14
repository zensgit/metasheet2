'use strict'

// TRIPWIRES for the operator value scope — the guards whose ABSENCE the shipped code survives.
//
// The directory suite (stock-preparation-operator-project-directory.test.cjs) asserts what the
// feature DOES. An adversarial re-read of it found the other half missing: several properties the
// design leans on are true in the shipped code and would stay green if you deleted the line that
// makes them true. A guarantee nothing can red is a comment. These are the reds.
//
//   S-01 THE WIRING, THROUGH THE REAL index.cjs. Every other route suite hands `services` straight to
//        `registerIntegrationRoutes`, so the plugin's own passthrough
//        (`context.services.tenantPrincipalDirectory`) is never exercised: deleting it would red
//        nothing. This activates the REAL plugin entry point and asserts the seam arrives — and that
//        a host which does NOT inject it produces the named 501, not a read on `req.user.tenantId`.
//   S-02 THE RESPONSE PROJECTION IS KEY-PINNED. The directory builds an explicit ten-key object; a
//        future `...data` spread would ship `owner`, and any customer-pack `ext_` column that happens
//        to sit on the project row, with no test noticing. A canary is planted in BOTH a template
//        field the projection omits (`owner`) and a NON-template physical column, and neither may
//        appear in any byte of the response.
//   S-03 THE SEAM IS ASKED THE RIGHT QUESTION. The verdict is checked but the QUESTION was not: a
//        route that asked about the request's tenant, or about `user.email` instead of `user.id`,
//        would pass every existing assertion. Both substitutions are red here.
//   S-04 A TRUTHY VERDICT IS NOT A VERDICT. `member !== true` is deliberately strict; relaxing it to
//        truthiness redded nothing. The malformed-verdict matrix fixes that.
//   S-05 THE PLATFORM-ADMIN CONVENTION, PINNED DELIBERATELY. A tenant-BOUND platform admin holding no
//        stock-prep grant at all is SERVED this read for the tenant they are a member of. That is the
//        existing `role:admin`/`integration:admin` convention this plugin has always followed
//        (satisfiesStockPrepAccess short-circuits on it) — stated here as an intended property with
//        its two real limits, not left to be discovered.
//   S-06 THE AUDIT ROW CARRIES NO PROJECT NUMBER, and that is a CHOICE rather than an accident of
//        validation: the audit store's SAFE_STRING_PATTERN would happily accept `230920006`.
//   S-07 NO AUDIT STORE, NO VALUES. `requireStockPreparationAudit`'s 501 was untested on this route.
//
// THIRD-ROUND ADDITION — S-03d. `ownTenantId`'s resolved `tenantId` (verified-claim-preferred) is what
// scope.cjs:279 must send the host, not `user.tenantId` re-read at the call site: a mutant
// `tenantId: optionalString(user.tenantId) || ''` survived every existing fixture because every one of
// them sets `user.tenantId === authenticatedTenantId`, so the two values were always the same string.
// S-03d is a principal that carries NO `user.tenantId` at all (a verified-claim-only token) — the two
// values then differ (`''` vs the verified claim), and only the resolved one is correct.
//
// A NOTE ON `OPERATOR_SCOPE_TENANT_CONTRADICTED`: as `packages/core-backend/src/auth/jwt-middleware.ts`
// (`hydrateAuthenticatedUser`) is written today, `req.authenticatedTenantId` is assigned FROM
// `user.tenantId` at the moment it is set (`authenticatedTenantId = user.tenantId.trim()`), and the
// `x-tenant-id` header is only ever copied onto `user.tenantId` in the branch where `user.tenantId` was
// falsy — the branch that never set `authenticatedTenantId` in the first place. So a verified claim and
// a DIFFERENT carried `user.tenantId` cannot co-occur through this host as it stands today: the
// contradiction guard is unreachable via this real caller, and is defence-in-depth for a host wired
// differently (or wired incorrectly later), not a path this suite can red through the real middleware.
//
// Hermetic: no DB, no network. Every service these routes must not touch is stubbed to throw.

const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

// S-01 loads the REAL plugin entry point, whose module graph reaches three things that have nothing
// to do with the tenant seam: the workspace package `@metasheet/mssql-readonly-utils`, and the `pg` /
// `mssql` drivers. On a checkout where the plugin's own dependencies were not installed, the require
// throws before any of this suite's subject matter is reached — a property of the CHECKOUT, not of
// the code under test.
//
// So each is resolved by a LAST-RESORT fallback, used only when normal resolution has already failed:
//
//   * the workspace package is resolved BY PATH to the very file the pnpm link would have pointed at
//     — byte-identical, no substitution at all; and
//   * the two drivers are resolved to a stub that REFUSES to be used: it survives a load-time
//     destructure and throws by name on the first call, so it can never quietly green a path that
//     really touched a database. Nothing on this path does (the sealed-snapshot runtime flag is off).
//
// On a properly installed checkout (CI) none of these branches runs.
const WORKSPACE_FALLBACKS = Object.freeze({
  '@metasheet/mssql-readonly-utils': path.join(__dirname, '..', '..', '..', 'packages', 'mssql-readonly-utils', 'index.cjs'),
  pg: path.join(__dirname, 'fixtures', 'absent-runtime-driver-stub.cjs'),
  mssql: path.join(__dirname, 'fixtures', 'absent-runtime-driver-stub.cjs'),
})
const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function resolveWithWorkspaceFallback(request, ...rest) {
  try {
    return originalResolveFilename.call(this, request, ...rest)
  } catch (error) {
    const fallback = WORKSPACE_FALLBACKS[request]
    if (!fallback) throw error
    return originalResolveFilename.call(this, fallback, ...rest)
  }
}

const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const {
  STOCK_PREP_OPERATE,
  STOCK_PREP_READ,
} = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const {
  OBJECT_ID: DECISION_OBJECT_ID,
  FIRST_CUT_CONFLICT_TYPE,
  STATUSES,
} = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const {
  PROJECT_OBJECT_ID,
} = require(path.join(LIB, 'stock-preparation-operator-project-directory.cjs'))
const auditStoreModule = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))
const {
  FEATURE_FLAG: STOCK_PREPARATION_FEATURE_FLAG,
} = require(path.join(LIB, 'sealed-export', 'stock-preparation-runtime-config.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
  physicalRow,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const DIRECTORY_PATH = '/api/integration/stock-preparation/operator/projects'

const TENANT_A = 'tenant-a'
const STAGING_A = `${TENANT_A}:integration-core`
const PROJECT_SHEET_A = 'sheet_project_a'
const LEDGER_SHEET_A = 'sheet_ledger_a'

const PROJECT_A_NO = '230920006'
const PROJECT_A_NAME = 'RY2注射水缓冲罐部件'
const PROJECT_A_ID = 'stockprep_project_a1'

// THE PROJECTION CANARIES. `owner` is a real field of the frozen project template that the operator
// projection deliberately omits; the second is a column no template knows about at all — the shape a
// customer pack's `ext_` field takes on a real deployment. A response containing either means the row
// was spread rather than projected.
const OWNER_CANARY = 'ZZOWNERCANARYZZ'
const EXTRA_COLUMN_CANARY = 'ZZEXTRACOLUMNCANARYZZ'
const EXTRA_COLUMN_PHYSICAL_ID = 'fld_zzunknowncolumnzz1234'

/**
 * THE DEFAULT ROW — the ten keys an operator project row carries when the caller asked for nothing
 * beyond the directory itself. A new key here is a widening; restate it.
 *
 * IT IS ALSO THE PRE-设计稿-N1 ROW, BYTE FOR BYTE, and that is now a ruled property rather than an
 * accident (核验裁决 r3): the union scan is `?includePullTargets=1` opt-in, so a plain GET of this
 * route answers exactly what it answered before this line of work started. `OPERATOR_PROJECT_ROW_
 * WITH_PULL_TARGETS` below is what the opt-in adds.
 */
const OPERATOR_PROJECT_PROJECTION_DEFAULT = Object.freeze([
  'heldLineCount',
  'lastSyncRunId',
  'openExceptionCount',
  'pendingDecisionCount',
  'projectId',
  'projectName',
  'projectNo',
  'projectStatus',
  'readyLineCount',
  'snapshotBatchCount',
])

/** The fourteen keys a row carries under `?includePullTargets=1`. */
// CONTRACT REVIEW — 设计稿 N1/N6, this PR. THE OPT-IN ROW GROWS BY FOUR, and each one is argued for
// here because this list is the only place a row key can be added at all:
//
//   `sources`                     WHICH STORE(S) ANSWERED — `['mvp']`, `['pull_target']`, or both.
//       The directory is now a union, and the two stores are written by two different TIERS: the
//       archive by `mvp-persist` (platform-admin, and empty on the flow the operator tier exists
//       for), the pull target by the operator's own `apply`. Without this token a pull-only row's
//       zeros read as 「归档里是零」 rather than 「还没归档」 — the same conflation that made a
//       successful import look like nothing had happened on 项目备料页. Values-free: a closed
//       two-token vocabulary, fixed in code.
//   `lastChangedFromPlmAt`        当 project 的行最近一次从 PLM 变更的时刻, ISO or null. The board
//       already returns this field, computed by the SAME shared scan; the directory had no
//       timestamp at all, so time filtering and sorting were impossible (设计稿 N6).
//   `lastChangedFromPlmBounded`   THE THIRD STATE. A max over a truncated, unordered page scan is
//       not a floor the way a truncated count is — rows past the bound may be NEWER — so the
//       bounded case reports a null timestamp and sets this flag instead of quietly understating
//       freshness. It is also true when nobody scanned at all, because a row travels alone into a
//       table cell or a sort key and cannot consult a top-level flag. 「未知」 and 「从未变更」 must
//       not be the same pixel.
//   `lastExportAt`                最近一次导出物料清单的时刻, ISO or null, from the values-free audit
//       trail — the same fact 项目备料页 shows for one project, read here for the whole tenant in
//       ONE bounded window (see the response-level `lastExportAtMayBeIncomplete`).
//
// NONE of the four is a customer ROW VALUE: two timestamps, one boolean and one closed enum list.
// The two value-bearing fields on this row are still exactly `projectNo` and `projectName`, and
// S-02b pins that the pull target's own part names and quantities reach no byte of this response.
//
// AND ALL FOUR ARE ABSENT WITHOUT THE OPT-IN, not present-and-null. `lastChangedFromPlmBounded` on
// a row nobody scanned would be a truthful 「未知」 rendered as a whole column of 「未知」 on every
// home page; a row key that only ever carries "we did not look" is worse than no key. S-02d pins it.
const OPERATOR_PROJECT_ROW_WITH_PULL_TARGETS = Object.freeze([
  'heldLineCount',
  'lastChangedFromPlmAt',
  'lastChangedFromPlmBounded',
  'lastExportAt',
  'lastSyncRunId',
  'openExceptionCount',
  'pendingDecisionCount',
  'projectId',
  'projectName',
  'projectNo',
  'projectStatus',
  'readyLineCount',
  'snapshotBatchCount',
  'sources',
])

/**
 * THE DEFAULT TOP-LEVEL KEY SET — what a plain GET of this route answers with, and what it answered
 * with before 设计稿 N1. Restated as a named constant because THREE assertions now compare against
 * it (S-02a, S-02c, S-02d) and a widening that edited only one of them would still be a widening.
 */
const DIRECTORY_RESPONSE_KEYS_DEFAULT = Object.freeze([
  'directoryReady',
  'ledgerReady',
  'pendingProjectCount',
  'projectCount',
  'projects',
  'tenantId',
])

// ---------------------------------------------------------------------------
// actors
// ---------------------------------------------------------------------------

const OPERATOR_A = Object.freeze({ id: 'u_op_a', tenantId: TENANT_A, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
/** id AND email, different strings, so "which one travels" is decidable rather than coincidental. */
const OPERATOR_A_WITH_EMAIL = Object.freeze({
  id: 'u_op_a',
  email: 'operator-a@example.invalid',
  tenantId: TENANT_A,
  permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE],
})
/** No `id` at all — the fallback the confirm/export routes already use for `actor`. */
const OPERATOR_A_EMAIL_ONLY = Object.freeze({
  email: 'operator-a@example.invalid',
  tenantId: TENANT_A,
  permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE],
})
/**
 * NO `tenantId` FIELD AT ALL — a verified-claim-only principal, the shape a token-only deployment
 * produces (see the header note on `OPERATOR_SCOPE_TENANT_CONTRADICTED`). S-03d's subject: this is the
 * one fixture where `user.tenantId` and the resolved `ownTenantId(...).tenantId` are NOT the same
 * string (`undefined`/`''` vs the verified claim), so a call site that re-reads `user.tenantId` instead
 * of the resolved value is distinguishable.
 */
const OPERATOR_A_NO_CARRIED_TENANT = Object.freeze({ id: 'u_op_a', permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
/** A TENANT-BOUND platform admin holding NO stock-prep grant whatsoever. S-05's subject. */
const PLATFORM_ADMIN_IN_TENANT_A = Object.freeze({ id: 'u_adm_a', tenantId: TENANT_A, roles: ['admin'], permissions: ['integration:admin'] })
const INTEGRATION_ADMIN_IN_TENANT_A = Object.freeze({ id: 'u_iadm_a', tenantId: TENANT_A, permissions: ['integration:admin'] })

// ---------------------------------------------------------------------------
// substrate
// ---------------------------------------------------------------------------

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => {
      throw new Error(`unexpected service call: ${method}`)
    }
  }
  return service
}

function baseServices() {
  return {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'getExternalSystemForAdapter', 'deleteExternalSystem', 'listExternalSystems']),
    adapterRegistry: inertService(['createAdapter', 'listAdapterKinds']),
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForApply']),
  }
}

/**
 * Tenant A's project row, carrying BOTH canaries: `owner` (a template field the projection omits) and
 * a physical column no template declares, which is how a customer pack's `ext_` field really arrives.
 * `toLogicalRecord` passes an unknown physical id through untranslated, so a spread would ship it
 * key and all.
 */
function projectRowWithCanaries() {
  const row = physicalRow(STAGING_A, PROJECT_OBJECT_ID, {
    projectId: PROJECT_A_ID,
    sourceProjectNo: PROJECT_A_NO,
    projectName: PROJECT_A_NAME,
    projectStatus: 'active',
    lastSyncRunId: 'run_a1',
    owner: OWNER_CANARY,
  }, 'rec_a1')
  row.sheetId = PROJECT_SHEET_A
  row.data[EXTRA_COLUMN_PHYSICAL_ID] = EXTRA_COLUMN_CANARY
  return row
}

function decisionRow() {
  const row = physicalRow(STAGING_A, DECISION_OBJECT_ID, {
    decisionId: 'decision_a_1',
    projectNo: PROJECT_A_NO,
    conflictType: FIRST_CUT_CONFLICT_TYPE,
    status: STATUSES.PENDING,
    inputFingerprint: 'sha16:0000000000000001',
  }, 'rec_d1')
  row.sheetId = LEDGER_SHEET_A
  return row
}

/** Counts every provisioning/records call, so "refused before any IO" is measured. */
function countedSubstrate() {
  let hostCalls = 0
  const provisioningA = makeFakeProvisioning({
    stagingProjectId: STAGING_A,
    sheetIdByObjectId: { [PROJECT_OBJECT_ID]: PROJECT_SHEET_A, [DECISION_OBJECT_ID]: LEDGER_SHEET_A },
  })
  const recordsA = makeStrictRecordsApi({
    stagingProjectId: STAGING_A,
    objectIdBySheetId: { [PROJECT_SHEET_A]: PROJECT_OBJECT_ID, [LEDGER_SHEET_A]: DECISION_OBJECT_ID },
    rowsBySheet: {
      [PROJECT_SHEET_A]: [projectRowWithCanaries()],
      [LEDGER_SHEET_A]: [decisionRow()],
    },
  })
  function counted(target) {
    return new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver)
        if (typeof value !== 'function') return value
        return (...args) => {
          hostCalls += 1
          return value.apply(obj, args)
        }
      },
    })
  }
  return {
    hostCallCount: () => hostCalls,
    provisioning: counted({
      findObjectSheet: (input) => provisioningA.findObjectSheet(input),
      resolveFieldIds: (input) => provisioningA.resolveFieldIds(input),
      async ensureObject() { throw new Error('unexpected provisioning write: ensureObject') },
    }),
    records: counted({
      queryRecords: (input) => recordsA.queryRecords(input),
      async createRecord() { throw new Error('unexpected records write: createRecord') },
      async patchRecord() { throw new Error('unexpected records write: patchRecord') },
    }),
  }
}

/**
 * A recording seam. `calls` is what S-03 asserts on; `verdict` is what S-04 varies.
 *
 * The verdict is passed as a ONE-ELEMENT ARRAY rather than directly, because S-04's matrix includes
 * `undefined` — and a default parameter would have quietly turned that case into `{ member: true }`,
 * i.e. into a test that asserts the opposite of what it claims. (It did, on the first run.)
 */
function hostDirectory(box = [{ member: true }]) {
  const [verdict] = box
  const calls = []
  return {
    calls,
    async verifyTenantMembership(input) {
      calls.push(input)
      return verdict
    },
  }
}

/** The ordinary mount: services handed straight to registerIntegrationRoutes. */
function mount({ tenantPrincipalDirectory = hostDirectory(), auditStore } = {}) {
  const routes = new Map()
  const substrate = countedSubstrate()
  const auditAppends = []
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: { provisioning: substrate.provisioning, records: substrate.records },
    },
    storage: new Map(),
    config: {},
  }
  const services = baseServices()
  if (auditStore !== null) {
    services.stockPreparationAuditStore = auditStore || {
      async append(entry) {
        auditAppends.push(entry)
        return { ok: true }
      },
    }
  }
  if (tenantPrincipalDirectory) services.tenantPrincipalDirectory = tenantPrincipalDirectory
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, auditAppends, tenantPrincipalDirectory, hostCallCount: substrate.hostCallCount }
}

/**
 * S-01's mount: the REAL plugin entry point, activated exactly as the host activates it, with the
 * seam offered (or withheld) where the host really offers it — `context.services`.
 */
async function activateRealPlugin({ hostServices } = {}) {
  const entry = require(path.join(__dirname, '..', 'index.cjs'))
  const previousFlag = process.env[STOCK_PREPARATION_FEATURE_FLAG]
  process.env[STOCK_PREPARATION_FEATURE_FLAG] = 'false'
  const routes = new Map()
  const substrate = countedSubstrate()
  const auditRows = []
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      // The plugin builds its own audit store over this; an INSERT lands here, values-free.
      database: {
        async query(sql, params = []) {
          if (String(sql).startsWith('INSERT')) auditRows.push({ sql: String(sql), params })
          return []
        },
      },
      multitable: { provisioning: substrate.provisioning, records: substrate.records },
    },
    communication: { register() {}, call() {}, on() {}, emit() {} },
    logger: { info() {}, warn() {}, error() {} },
    services: hostServices || {},
    storage: new Map(),
    config: {},
  }
  await entry.activate(context)
  return {
    routes,
    auditRows,
    hostCallCount: substrate.hostCallCount,
    async dispose() {
      await entry.deactivate()
      if (previousFlag === undefined) delete process.env[STOCK_PREPARATION_FEATURE_FLAG]
      else process.env[STOCK_PREPARATION_FEATURE_FLAG] = previousFlag
    },
  }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    sentBody: undefined,
    sent: false,
    headers: {},
    status(code) { this.statusCode = code; return this },
    _write(payload) {
      this.body = payload
      if (!this.sent) {
        this.sent = true
        this.sentBody = payload
      }
      return this
    },
    json(payload) { return this._write(payload) },
    setHeader(name, value) { this.headers[name] = value; return this },
    send(payload) { return this._write(payload) },
  }
}

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler({
    user: req.user,
    authenticatedTenantId: req.authenticatedTenantId,
    body: req.body || {},
    query: req.query || {},
    params: req.params || {},
  }, res)
  return res
}

function errorCode(res) {
  return res.body && res.body.error && res.body.error.code
}

let failures = 0
const only = process.env.ONLY_TEST || ''
async function run(name, fn) {
  if (only && !name.includes(only)) return
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}\n    ${error && error.stack ? error.stack : error}`)
  }
}

async function main() {
  // -------------------------------------------------------------------------
  // S-01 THE WIRING, THROUGH THE REAL index.cjs
  // -------------------------------------------------------------------------

  await run('S-01a the plugin passes the HOST-injected seam through to the route, and the read answers', async () => {
    const directory = hostDirectory()
    const harness = await activateRealPlugin({ hostServices: { tenantPrincipalDirectory: directory } })
    try {
      const res = await call(harness.routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
      assert.equal(res.statusCode, 200, `the activated plugin serves the read (${JSON.stringify(res.body && res.body.error)})`)
      assert.equal(res.body.data.tenantId, TENANT_A)
      assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), true, 'and it really carries the values')
      assert.deepEqual(directory.calls, [{ userId: OPERATOR_A.id, tenantId: TENANT_A }],
        'the seam the HOST injected is the one the route asked')
    } finally {
      await harness.dispose()
    }
  })

  await run('S-01b a host that injects NO seam yields the named 501 — never a read on req.user.tenantId', async () => {
    const harness = await activateRealPlugin({ hostServices: {} })
    try {
      const res = await call(harness.routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
      assert.equal(res.statusCode, 501)
      assert.equal(errorCode(res), 'OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE')
      assert.equal(harness.hostCallCount(), 0, 'and it costs no multitable IO')
      assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), false)
    } finally {
      await harness.dispose()
    }
  })

  // -------------------------------------------------------------------------
  // S-02 THE RESPONSE PROJECTION IS KEY-PINNED
  // -------------------------------------------------------------------------

  await run('S-02a the response and every project row carry EXACTLY the frozen projections', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200)
    // ─────────────────────────────────────────────────────────────────────────
    // CONTRACT REVIEW — 设计稿 N1/N2/N6 + 核验裁决 r3. THE DEFAULT KEY SET DID NOT GROW AT ALL.
    //
    // 设计稿 N1 added four top-level keys and four row keys. The owner then ruled that the union
    // scan they describe is too expensive to run on every open of an operator's home page (a
    // full-sheet, LIMIT/OFFSET-paged scan: ≈P²·500/2 row accesses), so the whole of N1 became
    // `?includePullTargets=1` opt-in and this — the UNQUALIFIED read — went back to exactly the
    // shape it had before. That is what this assertion is for now: not "these are the new keys",
    // but "asking for nothing still returns nothing new".
    //
    // The opt-in shapes are pinned separately and argued there: S-02c (the pending index) and
    // S-02d (the union). Every key that ever reaches this response is therefore reviewed in one of
    // the three, and a key that appeared in none of them fails all three.
    // ─────────────────────────────────────────────────────────────────────────
    assert.deepEqual(Object.keys(res.body.data).sort(), DIRECTORY_RESPONSE_KEYS_DEFAULT)
    assert.ok(res.body.data.projects.length > 0, 'precondition: there is a row to pin')
    for (const project of res.body.data.projects) {
      assert.deepEqual(Object.keys(project).sort(), OPERATOR_PROJECT_PROJECTION_DEFAULT,
        'a row must be BUILT key by key, never spread from the stored record')
    }
  })

  await run('S-02d the UNION is opt-in — `?includePullTargets=1` is the only thing that widens it', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // CONTRACT REVIEW — 设计稿 N1/N6 behind the r3 opt-in. FOUR top-level keys and FOUR row keys,
    // and every one of them is a fact about THE READ ITSELF or a timestamp — none is a customer row
    // value. They exist only when a caller asked for the scan that produces them:
    //
    //   `pullTargetReady`            WAS THE OPERATOR'S OWN STORE READABLE AT ALL. The directory is
    //       a UNION over the MVP archive and the bound table-action target — the sheet the
    //       operator's own pull writes, and the only store their run touches. When nothing is
    //       bound, when the bound sheet is not provably the caller's own, or when the scan throws,
    //       the union contributes nothing and every timestamp is an "unknown". Without this
    //       boolean, 「这个部署还没绑外接源」 and 「你确实没有项目」 are the same empty screen — the
    //       exact class of collapsed empty state `directoryReady`/`ledgerReady` already exist to
    //       prevent.
    //
    //   `directoryMayBeIncomplete`   THE ANTI-SILENT-TRUNCATION FLAG, required by 设计稿 N1 in as
    //       many words ("超限时必须返回『可能不全』标志,不得静默截断"). The union scan is bounded by
    //       the export's own PULL_TARGET_MAX_PAGES, and the merge is bounded by MAX_LIST_ROWS. A
    //       "find my project" surface that silently returns a prefix tells an operator their
    //       project does not exist. It is deliberately NOT the same fact as `pullTargetReady`: a
    //       deployment with nothing bound has no pull-target projects to be missing, and a flag
    //       that was permanently true there would train every reader to ignore it.
    //
    //   `pullTargetScanCapped`       WHICH KIND OF SHORT ANSWER (核验裁决 r3, a NEW key reviewed
    //       here). Past PULL_TARGET_MAX_PAGES×PAGE_LIMIT rows `directoryMayBeIncomplete` is
    //       permanently true — a DECLARED limit of this deployment, not an incident — and a scan
    //       that broke mid-flight raises the same flag while being exactly an incident. One says
    //       「表太大,目录只列到前 N 行」, the other says 「稍后再试」. A front end that cannot tell
    //       them apart tells an operator to retry forever, or files a data-loss ticket over a blip.
    //       True ONLY for the page bound; the merge cap and the mid-flight break are the other two
    //       states, and the trio is separable — asserted below.
    //
    //   `lastExportAtMayBeIncomplete`  THE SAME HONESTY FOR THE EXPORT COLUMN. `lastExportAt` is
    //       read from ONE bounded descending window over the values-free audit trail (the audit
    //       table has no index on project_id, so one query per project is not an option on a home
    //       page). When that window comes back full, a project whose last export fell outside it is
    //       indistinguishable from one that has never been exported — and 「从未导出」 is a claim,
    //       not an absence.
    //
    //   `fillTarget`                 THE DEEP-LINK HANDLE FOR THE 备料主表 (this PR) — `{ sheetId,
    //       viewId }` or null, and those two ids are the ONLY thing it carries. 项目备料页 has returned
    //       exactly this object since it shipped, from exactly this gate (`resolveOwnBoundSheet` — the
    //       bound sheet must be PROVED to belong to the caller's own staging project), but that page
    //       404s until a project number is in hand, so the home page's and the panels' 「到多维表」
    //       buttons had no sheet to route to and dropped the operator on the multitable chooser.
    //       IT RIDES THIS OPT-IN AND NO OTHER because `ownSheet` does: a caller that did not ask for
    //       the union resolved no bound sheet, and `fillTarget: null` would then claim
    //       「没有备料主表」 where the truth is 「没人问过」. It is NOT a permission decision — the plugin
    //       has no user-aware multitable ACL seam and multitable enforces access on landing — and it
    //       is values-free: no projectNo, no project name, no row.
    //
    // The row keys are reviewed at OPERATOR_PROJECT_ROW_WITH_PULL_TARGETS' own definition.
    // ─────────────────────────────────────────────────────────────────────────
    const { routes } = mount()
    const asked = await call(routes, 'GET', DIRECTORY_PATH, {
      user: OPERATOR_A,
      query: { includePullTargets: '1' },
    })
    assert.equal(asked.statusCode, 200)
    assert.deepEqual(Object.keys(asked.body.data).sort(), [
      'directoryMayBeIncomplete',
      'directoryReady',
      'fillTarget',
      'lastExportAtMayBeIncomplete',
      'ledgerReady',
      'pendingProjectCount',
      'projectCount',
      'projects',
      'pullTargetReady',
      'pullTargetScanCapped',
      'tenantId',
    ], 'the opt-in adds EXACTLY five keys and changes nothing else')
    // PRESENT-BUT-NULL IS THE ANSWER ON THIS SUBSTRATE, and it is the one that matters here: nothing
    // is bound in this harness, so no sheet can be proved to be the caller's own and the handle must
    // be null rather than a link composed from a deterministic hash into a table that may not exist.
    // The populated shape and the cross-tenant refusal are pinned in
    // stock-preparation-operator-project-directory.test.cjs (N7-a / N7-b / N7-c).
    assert.equal(asked.body.data.fillTarget, null,
      'no bound table action ⇒ no handle, never a hash-composed link into the dark')
    assert.ok(asked.body.data.projects.length > 0, 'precondition: there is a row to pin')
    for (const project of asked.body.data.projects) {
      assert.deepEqual(Object.keys(project).sort(), OPERATOR_PROJECT_ROW_WITH_PULL_TARGETS,
        'and the row is still BUILT key by key — four more named keys, never a spread')
    }
    // …and a flag is a flag: anything but "1" leaves the default shape alone, the same rule
    // `includePendingCounts` keeps (S-02c / N2-d).
    for (const value of ['0', 'true', 'yes', '']) {
      const res = await call(routes, 'GET', DIRECTORY_PATH, {
        user: OPERATOR_A,
        query: { includePullTargets: value },
      })
      assert.equal(res.statusCode, 200)
      assert.deepEqual(Object.keys(res.body.data).sort(), DIRECTORY_RESPONSE_KEYS_DEFAULT,
        `includePullTargets=${JSON.stringify(value)} must not open the union`)
    }
  })

  await run('S-02c the pending INDEX is opt-in — absent by default, and only "1" opens it', async () => {
    // 设计稿 N2. The index is keyed by CUSTOMER PROJECT NUMBERS, so making it default would widen a
    // value-bearing projection without anyone asking. The default response above must not contain
    // it, and this is the assertion that goes red if someone later moves it into the base object.
    const { routes } = mount()
    const plain = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(Object.prototype.hasOwnProperty.call(plain.body.data, 'pendingCountsByProjectNo'), false)

    const asked = await call(routes, 'GET', DIRECTORY_PATH, {
      user: OPERATOR_A,
      query: { includePendingCounts: '1' },
    })
    assert.equal(asked.statusCode, 200)
    assert.deepEqual(Object.keys(asked.body.data).sort(), [
      'directoryReady',
      'ledgerReady',
      'pendingCountsByProjectNo',
      'pendingProjectCount',
      'projectCount',
      'projects',
      'tenantId',
    ], 'the opt-in adds EXACTLY one key and changes nothing else')
    // THE TWO OPT-INS ARE INDEPENDENT. Asking for the pending index must not drag the union in with
    // it — that would put the expensive scan back on every caller that wanted a cheap count map.
    assert.deepEqual(Object.keys(asked.body.data).sort().filter((key) => !DIRECTORY_RESPONSE_KEYS_DEFAULT.includes(key)),
      ['pendingCountsByProjectNo'])
    // …and the in-process Map channel never reaches the wire under either shape: a Map would
    // serialize as `{}` and quietly report "nothing pending" for the whole tenant.
    assert.equal(Object.prototype.hasOwnProperty.call(asked.body.data, 'pendingByProjectNo'), false)
  })

  await run('S-02b neither the omitted template field NOR an unknown column reaches any byte', async () => {
    const { routes } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    const serialized = JSON.stringify(res.body)
    // The values...
    assert.equal(serialized.includes(OWNER_CANARY), false, 'owner is a stored value this route does not project')
    assert.equal(serialized.includes(EXTRA_COLUMN_CANARY), false, 'nor does it project a column no template declares')
    // ...and the field NAMES, which are themselves a disclosure about the customer's schema.
    assert.equal(serialized.includes('"owner"'), false)
    assert.equal(serialized.includes(EXTRA_COLUMN_PHYSICAL_ID), false)
    // The canaries really were in the substrate — otherwise this guard is vacuous.
    const seeded = projectRowWithCanaries()
    assert.equal(seeded.data[physicalFieldId(STAGING_A, PROJECT_OBJECT_ID, 'owner')], OWNER_CANARY)
    assert.equal(seeded.data[EXTRA_COLUMN_PHYSICAL_ID], EXTRA_COLUMN_CANARY)
    // ...and the feature itself still works, so this is not passing because nothing was returned.
    assert.equal(serialized.includes(PROJECT_A_NAME), true)
  })

  // -------------------------------------------------------------------------
  // S-03 THE SEAM IS ASKED THE RIGHT QUESTION
  // -------------------------------------------------------------------------

  await run('S-03a the seam receives the principal id and the SCOPED tenant, not the request\'s', async () => {
    const directory = hostDirectory()
    const { routes } = mount({ tenantPrincipalDirectory: directory })
    const res = await call(routes, 'GET', DIRECTORY_PATH, {
      user: OPERATOR_A_WITH_EMAIL,
      authenticatedTenantId: TENANT_A,
      // A request-carried tenant equal to the caller's own: compatibility, never a selector. It must
      // not be what the host is asked about, even when the two happen to agree.
      query: { tenantId: TENANT_A },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(directory.calls, [{ userId: OPERATOR_A_WITH_EMAIL.id, tenantId: TENANT_A }])
    // `id` wins over `email` when both exist: a seam asked about the email would be asking the host
    // about a principal handle the rest of this route family does not key on.
    assert.notEqual(directory.calls[0].userId, OPERATOR_A_WITH_EMAIL.email)
    // Exactly the two keys the port accepts — the boundary refuses a third, so a route that added one
    // would be silently denied rather than loudly wrong.
    assert.deepEqual(Object.keys(directory.calls[0]).sort(), ['tenantId', 'userId'])
  })

  await run('S-03b a principal with only an email travels under the email — the documented fallback', async () => {
    const directory = hostDirectory()
    const { routes } = mount({ tenantPrincipalDirectory: directory })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A_EMAIL_ONLY })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(directory.calls, [{ userId: OPERATOR_A_EMAIL_ONLY.email, tenantId: TENANT_A }])
  })

  await run('S-03c a principal with NO stable handle at all is refused before the host is asked', async () => {
    const directory = hostDirectory()
    const { routes, hostCallCount } = mount({ tenantPrincipalDirectory: directory })
    const res = await call(routes, 'GET', DIRECTORY_PATH, {
      user: { tenantId: TENANT_A, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] },
    })
    assert.equal(res.statusCode, 403)
    assert.equal(errorCode(res), 'OPERATOR_SCOPE_PRINCIPAL_UNKNOWN')
    assert.equal(directory.calls.length, 0, 'there is no question to ask about a principal with no name')
    assert.equal(hostCallCount(), 0)
  })

  // -------------------------------------------------------------------------
  // S-04 A TRUTHY VERDICT IS NOT A VERDICT
  // -------------------------------------------------------------------------

  const MALFORMED_VERDICTS = [
    ['undefined', undefined],
    ['null', null],
    ['the string "yes"', 'yes'],
    ['the number 1', 1],
    ['an empty object', {}],
    ['{ member: 1 }', { member: 1 }],
    ["{ member: 'true' }", { member: 'true' }],
    ["{ member: 'no' }", { member: 'no' }],
    ['{ member: [true] }', { member: [true] }],
    ['{ member: {} }', { member: {} }],
    ['{ member: false }', { member: false }],
    ['{ membership: true }', { membership: true }],
    ['an array', [{ member: true }]],
  ]
  for (const [label, verdict] of MALFORMED_VERDICTS) {
    await run(`S-04 a verdict of ${label} is a REFUSAL, not a truthy pass`, async () => {
      const { routes, hostCallCount } = mount({ tenantPrincipalDirectory: hostDirectory([verdict]) })
      const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
      assert.equal(res.statusCode, 403, `${label} must not be read as membership`)
      assert.equal(errorCode(res), 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED')
      assert.equal(hostCallCount(), 0, 'and nothing is read on the strength of it')
      assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), false)
    })
  }

  await run('S-04+ …and the ONE well-formed affirmative really is served (the positive control)', async () => {
    const { routes } = mount({ tenantPrincipalDirectory: hostDirectory([{ member: true }]) })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200, 'exactly `{ member: true }` passes — so S-04 is not refusing everything')
  })

  // -------------------------------------------------------------------------
  // S-05 THE PLATFORM-ADMIN CONVENTION, PINNED DELIBERATELY
  // -------------------------------------------------------------------------

  await run('S-05 a TENANT-BOUND platform admin with NO stock-prep grant is served their OWN tenant', async () => {
    // INTENDED, and stated as such: `satisfiesStockPrepAccess` short-circuits on `role:admin` /
    // `integration:admin`, which is this plugin's long-standing convention for every stock-prep code
    // — this route inherits it rather than inventing a new answer. The two limits that keep it sound
    // are asserted elsewhere and named here: the admin must have a tenant OF THEIR OWN (a TENANTLESS
    // platform admin is refused — directory suite G-04, and value-read-scope V-04), and the HOST must
    // still vouch for the pairing (S-04 above), so this is "an admin of tenant A sees tenant A", never
    // "an admin sees everything".
    for (const admin of [PLATFORM_ADMIN_IN_TENANT_A, INTEGRATION_ADMIN_IN_TENANT_A]) {
      const directory = hostDirectory()
      const { routes } = mount({ tenantPrincipalDirectory: directory })
      const res = await call(routes, 'GET', DIRECTORY_PATH, { user: admin })
      assert.equal(res.statusCode, 200, `${admin.id} holds no stock-prep code and is still served`)
      assert.equal(res.body.data.tenantId, TENANT_A)
      assert.deepEqual(directory.calls, [{ userId: admin.id, tenantId: TENANT_A }],
        'the host still had to vouch — admin is not an exemption from membership')
    }
  })

  await run('S-05b …and the host CAN refuse an admin: the short-circuit is on the permission, not on the tenant', async () => {
    const { routes } = mount({ tenantPrincipalDirectory: hostDirectory([{ member: false }]) })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: PLATFORM_ADMIN_IN_TENANT_A })
    assert.equal(res.statusCode, 403)
    assert.equal(errorCode(res), 'OPERATOR_SCOPE_TENANT_MEMBERSHIP_DENIED')
  })

  // -------------------------------------------------------------------------
  // S-06 NO PROJECT NUMBER ON THE TRAIL, BY CHOICE
  // -------------------------------------------------------------------------

  await run('S-06 the audit row carries no project number, though the store would have accepted one', async () => {
    const { routes, auditAppends } = mount()
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 200)
    assert.equal(auditAppends.length, 1)
    const entry = auditAppends[0]
    // The audit store's own validator WOULD have taken it — `230920006` is a perfectly legal
    // SAFE_STRING. So its absence is this route's decision, not a rule it merely failed to break.
    const SAFE_STRING_PATTERN = auditStoreModule.__internals && auditStoreModule.__internals.SAFE_STRING_PATTERN
    assert.ok(SAFE_STRING_PATTERN, 'the audit store exposes its value pattern')
    assert.equal(SAFE_STRING_PATTERN.test(PROJECT_A_NO), true, 'a pure-digit project number is SAFE_STRING-shaped')
    assert.equal(entry.projectId, undefined, 'this read is about a whole tenant, so no project handle belongs on it')
    assert.equal(entry.subjectId, undefined)
    // ...and no project number anywhere else in the row either.
    assert.equal(JSON.stringify(entry).includes(PROJECT_A_NO), false)
    // The ruling this pins: on THIS route the number would be a VALUE (the answer itself), not a
    // handle naming what the request was about — unlike prep_line_export, whose request IS one
    // project and whose `projectId` is therefore the navigation handle it looks like.
    assert.equal(entry.action, 'project_directory_read')
  })

  // -------------------------------------------------------------------------
  // S-07 NO AUDIT STORE, NO VALUES
  // -------------------------------------------------------------------------

  await run('S-07 an ABSENT audit store 501s the read — the trail is not optional for a value plane', async () => {
    const { routes, hostCallCount } = mount({ auditStore: null })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 501)
    assert.equal(errorCode(res), 'AUDIT_STORE_UNAVAILABLE')
    assert.equal(hostCallCount(), 0, 'refused before any read, so no values are even fetched')
    assert.equal(JSON.stringify(res.body).includes(PROJECT_A_NAME), false)
  })

  await run('S-07b an audit store whose append is not a function is the same refusal', async () => {
    const { routes } = mount({ auditStore: { append: 'not-a-function' } })
    const res = await call(routes, 'GET', DIRECTORY_PATH, { user: OPERATOR_A })
    assert.equal(res.statusCode, 501)
    assert.equal(errorCode(res), 'AUDIT_STORE_UNAVAILABLE')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // S-08 — OWNERSHIP IS NOT EXISTENCE. The gate at the MODULE, where both surfaces ride it.
  //
  // WHY IT IS A TRIPWIRE AND NOT A FEATURE TEST. `resolveOwnBoundSheet` claims to hand back a sheet
  // only when it is "proved to belong to the caller's own staging project AND to exist", and the
  // second half was NOT true on the registry path: `plugin_multitable_object_registry` is written at
  // provisioning time and no code path ever deletes a row from it, while dropping a table is
  // `UPDATE meta_sheets SET deleted_at = now()`. So a deleted table went on being claimed forever,
  // and every feature test stayed green because every fixture that owned a sheet also had one.
  //
  // BOTH SURFACES ARE THIS ONE FUNCTION — 项目备料页's board and the operator directory (which is what
  // put the handle on the home page and the project workbench in this PR) — so the assertion is
  // placed on the function rather than duplicated per route.
  // ─────────────────────────────────────────────────────────────────────────
  const STAGING = 'tenant-a:integration-core'
  const FILL_OBJECT_ID = 'plm_stock_preparation_main'
  const derived = (projectId, objectId) => `sheet__${projectId}__${objectId}`
  const BOUND_SHEET = derived(STAGING, FILL_OBJECT_ID)
  const gateProvisioning = ({ sheetExists, ownedByRegistry = true }) => ({
    async isSheetOwnedByProject(sheetId, projectId) {
      return ownedByRegistry && sheetId === BOUND_SHEET && projectId === STAGING
    },
    getObjectSheetId: derived,
    async findObjectSheet({ projectId, objectId } = {}) {
      if (!sheetExists) return null
      return projectId === STAGING && objectId === FILL_OBJECT_ID ? { id: BOUND_SHEET } : null
    },
  })

  await run('S-08 the registry says OWNED but the table is GONE ⇒ the gate answers null', async () => {
    const { resolveOwnBoundSheet } = require(path.join(LIB, 'stock-preparation-pull-target-scan.cjs'))
    const boundTarget = { sheetId: BOUND_SHEET, objectId: FILL_OBJECT_ID }
    // THE POSITIVE CONTROL FIRST, so the null below is the delete and not a fixture that never
    // resolved anything.
    const live = await resolveOwnBoundSheet(gateProvisioning({ sheetExists: true }), STAGING, boundTarget)
    assert.deepEqual(live, { sheetId: BOUND_SHEET, objectId: FILL_OBJECT_ID },
      'precondition: this exact fixture DOES resolve while the table exists')
    const deleted = await resolveOwnBoundSheet(gateProvisioning({ sheetExists: false }), STAGING, boundTarget)
    assert.equal(deleted, null,
      'the registry keeps claiming a soft-deleted sheet forever; ownership alone must not be enough')
  })

  await run('S-08b the D1=B sandbox rebinding is liveness-checked against the CANONICAL object', async () => {
    // The sanctioned deploy-window config names a SANDBOX objectId over the sheet the deployment
    // already had — a sheet whose id hashes from the canonical object. A liveness read that only
    // tried the BOUND objectId would be permanently "cannot say" on exactly that configuration, i.e.
    // the guard would be decorative where it matters most.
    const { resolveOwnBoundSheet } = require(path.join(LIB, 'stock-preparation-pull-target-scan.cjs'))
    const sandboxTarget = { sheetId: BOUND_SHEET, objectId: 'plm_stock_preparation_sandbox_main' }
    const live = await resolveOwnBoundSheet(gateProvisioning({ sheetExists: true }), STAGING, sandboxTarget)
    assert.ok(live, 'the runbook\'s own binding must keep working — this is the sanctioned config')
    assert.equal(live.sheetId, BOUND_SHEET)
    const deleted = await resolveOwnBoundSheet(gateProvisioning({ sheetExists: false }), STAGING, sandboxTarget)
    assert.equal(deleted, null, 'and the same binding over a deleted sheet is refused')
  })

  await run('S-08c a HAND-BOUND sheet is unchanged — the liveness read narrows, it never refuses blind', async () => {
    // The remaining gap, pinned as a PROPERTY rather than left as a surprise: an administrator can
    // bind a sheet whose id hashes from neither the bound nor the canonical object, and the host's
    // only existence read takes a (project, objectId) pair — so nothing on the plugin side can name
    // that sheet to it. Liveness is then "cannot say", and the registry's ownership answer stands, as
    // it always has. Closing this needs a host port that takes a SHEET ID; it is named in the PR body.
    const { resolveOwnBoundSheet } = require(path.join(LIB, 'stock-preparation-pull-target-scan.cjs'))
    const handBound = { sheetId: 'sheet_hand_made_by_an_admin', objectId: FILL_OBJECT_ID }
    const provisioning = {
      async isSheetOwnedByProject(sheetId, projectId) {
        return sheetId === 'sheet_hand_made_by_an_admin' && projectId === STAGING
      },
      getObjectSheetId: derived,
      async findObjectSheet() { return null },
    }
    const resolved = await resolveOwnBoundSheet(provisioning, STAGING, handBound)
    assert.deepEqual(resolved, { sheetId: 'sheet_hand_made_by_an_admin', objectId: FILL_OBJECT_ID },
      'an unprovable liveness must not become a refusal — that would drop the sheets PROOF 1 exists for')
    // …and the registry is still the thing that decides: without its YES, the same hand-bound sheet
    // is refused, so this case is not a hole punched through the tenant gate.
    const unclaimed = await resolveOwnBoundSheet({
      ...provisioning,
      async isSheetOwnedByProject() { return false },
    }, STAGING, handBound)
    assert.equal(unclaimed, null, 'no registry claim and no hash match ⇒ still nothing')
  })

  if (failures > 0) {
    console.error(`\n${failures} tripwire(s) FAILED`)
    process.exitCode = 1
  } else {
    console.log('\nall operator scope tripwires passed')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
