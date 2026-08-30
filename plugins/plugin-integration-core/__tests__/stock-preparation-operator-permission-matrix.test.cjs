/**
 * O2 / R-11 — the stock-preparation confirmation-queue workbench PERMISSION MATRIX.
 *
 * R-11 in one line: what is VISIBLE must be ACTIONABLE, and what is NOT PERMITTED must NOT be
 * VISIBLE. Two directions, and a suite that checks one of them proves nothing about the other. This
 * file crosses five actor tiers with every operator-facing route and asserts BOTH:
 *
 *   A. NOTHING VISIBLE-BUT-403 — for each tier, every route the web front end would let that tier
 *      reach must be answered, not refused.
 *   B. NOTHING PERMITTED-BUT-HIDDEN — for each tier, every route the server would answer must have
 *      a front-end surface that tier can actually reach.
 *
 * Direction B is the half that is easy to ship broken, because nothing 403s when you get it wrong:
 * the authority simply sits there unreachable until someone finds it with curl. It is checked here
 * by re-deriving the FRONT END's answer (the route-guard admission code plus the per-control
 * predicate) from the SAME route table and comparing the two answers cell by cell.
 *
 * WHY THIS FILE HAD TO EXIST
 * Before it, the five `/stock-preparation/confirmation-decisions*` routes were invoked over HTTP by
 * NO test at all, and the sixth (reconcile) only ever as ADMIN. `requireAccess(req, 'admin')` could
 * have been deleted from all six and the whole 180-suite chain would still have gone green. The
 * gates this PR installs would inherit exactly that hole if the matrix below did not close it, so
 * every gate here is witnessed RED (drop the check → this file fails) before being restored.
 *
 * THE PREDICATE IS IMPORTED, NEVER RE-IMPLEMENTED. `hasStockPrepPermission` comes from the module
 * under test. A local copy would be free to agree with a bug in the original.
 *
 * VALUES-FREE + SYNTHETIC: every actor is a made-up id, every route is driven with synthetic ids,
 * and no assertion inspects a cell value. Denial cases are asserted to reach NO host call at all,
 * so a refusal cannot be a refusal that already leaked.
 *
 * LANE: `plugins/plugin-integration-core/package.json` `scripts.test` (the explicit `&&` chain — see
 * test-chain-completeness.test.cjs), run by `.github/workflows/integration-guard.yml`. No workflow
 * edit is required and none is made.
 */
const assert = require('node:assert/strict')

const httpRoutes = require('../lib/http-routes.cjs')

const {
  hasStockPrepPermission,
  STOCK_PREP_PERMISSIONS,
  STOCK_PREP_READ_PERMISSION,
  STOCK_PREP_CONFIRM_PERMISSION,
} = httpRoutes.__internals

const TENANT_ID = 'tenant_o2'
const PROJECT_NO = 'PRJ-O2-0001'
const DECISION_ID = 'decision_o2_0001'
const ACTION_ID = 'action_o2'

/* ─────────────────────────────── the five actor tiers ─────────────────────────────── */

/**
 * Synthetic principals. Shapes mirror the fixtures the rest of the suite uses
 * (http-routes.test.cjs, stock-preparation-customer-pack-routes.test.cjs): `permissions` is the
 * grant array, `roles` carries the platform role, and `getUser` reads `req.user`.
 */
const ANONYMOUS = undefined
const NO_CODES = Object.freeze({ id: 'u_bare', tenantId: TENANT_ID, permissions: [] })
const READER = Object.freeze({ id: 'u_reader', tenantId: TENANT_ID, permissions: [STOCK_PREP_READ_PERMISSION] })
const CONFIRMER = Object.freeze({
  id: 'u_confirmer',
  tenantId: TENANT_ID,
  permissions: [STOCK_PREP_READ_PERMISSION, STOCK_PREP_CONFIRM_PERMISSION],
})
const ADMIN = Object.freeze({
  id: 'u_admin',
  tenantId: TENANT_ID,
  roles: ['admin'],
  permissions: ['integration:admin'],
})

/**
 * The pre-O2 integration tiers, carried as NEGATIVE CONTROLS. `integration:write` is what
 * `/stock-prep` used to admit, so it is the exact principal whose "visible but 403" experience this
 * PR exists to end: it must now be refused by the ROUTER too, and the alignment legs below check
 * that its server answer and its router answer agree (both no).
 */
const INTEGRATION_READER = Object.freeze({ id: 'u_int_read', tenantId: TENANT_ID, permissions: ['integration:read'] })
const INTEGRATION_WRITER = Object.freeze({ id: 'u_int_write', tenantId: TENANT_ID, permissions: ['integration:write'] })

const TIERS = Object.freeze([
  { id: 'anonymous', user: ANONYMOUS, expectStatus: 401 },
  { id: 'logged-in-no-codes', user: NO_CODES, expectStatus: 403 },
  { id: 'stockprep-read', user: READER, expectStatus: 403 },
  { id: 'stockprep-read+confirm', user: CONFIRMER, expectStatus: 403 },
  { id: 'admin', user: ADMIN, expectStatus: 403 },
  { id: 'integration-read', user: INTEGRATION_READER, expectStatus: 403 },
  { id: 'integration-write', user: INTEGRATION_WRITER, expectStatus: 403 },
])

/* ─────────────────────────── the operator-facing route table ─────────────────────────── */

/**
 * Every route the `/stock-prep` workbench line touches, with the tiers that may reach it and the
 * front-end surface that renders it. `feSurface` is what direction B is checked against:
 *
 *   'queue'        rendered by the confirmation-queue view for a principal who passes the route
 *                  guard (`stockprep:read`);
 *   'confirm-tier' rendered by that view only when the confirm predicate holds;
 *   'none'         NO control at any tier, deliberately (stated per row).
 */
const ROUTES = Object.freeze([
  {
    label: 'confirmation-decisions list (the authoritative values-free queue)',
    method: 'GET',
    path: '/api/integration/stock-preparation/confirmation-decisions',
    req: { query: { tenantId: TENANT_ID, projectNo: PROJECT_NO } },
    allow: ['stockprep-read', 'stockprep-read+confirm', 'admin'],
    feSurface: 'queue',
  },
  {
    label: 'confirmation-decisions readiness',
    method: 'GET',
    path: '/api/integration/stock-preparation/confirmation-decisions/readiness',
    req: { query: { tenantId: TENANT_ID } },
    allow: ['stockprep-read', 'stockprep-read+confirm', 'admin'],
    feSurface: 'queue',
  },
  {
    label: 'confirmation-decisions value-entry (the ONE value-bearing read)',
    method: 'GET',
    path: '/api/integration/stock-preparation/confirmation-decisions/value-entry',
    req: { query: { tenantId: TENANT_ID, decisionId: DECISION_ID } },
    allow: ['stockprep-read+confirm', 'admin'],
    feSurface: 'confirm-tier',
  },
  {
    label: 'confirmation-decisions confirm (keep_multiple_rows / accept_current / manual_hold)',
    method: 'POST',
    path: '/api/integration/stock-preparation/confirmation-decisions/confirm',
    req: { body: { decisionId: DECISION_ID, inputFingerprint: 'fp', resolutionAction: 'manual_hold' } },
    allow: ['stockprep-read+confirm', 'admin'],
    feSurface: 'confirm-tier',
  },
  {
    // PROVISIONING, not queue work: it creates the managed ledger table. Admin-only, and the
    // workbench renders nothing for it, so direction B is satisfied by 'none'.
    label: 'confirmation-decisions ensure (provisioning)',
    method: 'POST',
    path: '/api/integration/stock-preparation/confirmation-decisions/ensure',
    req: { body: {} },
    allow: ['admin'],
    feSurface: 'none',
  },
  {
    // OWNER-LEVEL: re-reads the customer's external source and can burn a one-shot armed B2a claim.
    // Admin-only and rendered by nothing at any tier — performed out of band, never from the page.
    label: 'table-action confirmation-decisions reconcile (source read + B2a claim)',
    method: 'POST',
    path: '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile',
    req: { params: { actionId: ACTION_ID }, body: {} },
    allow: ['admin'],
    feSurface: 'none',
  },
])

/* ───────────────────────────────── the FE derivation ───────────────────────────────── */

/**
 * The FRONT END's answer, re-derived here from the same inputs the web app uses.
 *
 * `/stock-prep` declares `meta.permissions: ['stockprep:read']` and `isRoutePermitted`
 * (apps/web/src/router/routeAccess.ts) is an all-of over that array, so page admission is the read
 * code. Per-control visibility then follows services/integration/stockPreparation/permissions.ts:
 * the queue table for an admitted principal, the confirm controls for the confirm predicate.
 *
 * Deliberately written from the FE's rules rather than by calling the server predicate: if both
 * sides were the same function, "they agree" would be a tautology. The whole point is that two
 * independently-stated rules produce the same table.
 */
function webRouteGuardAdmits(user) {
  return webHasPermission(user, STOCK_PREP_READ_PERMISSION)
}

/**
 * `useAuth().hasPermission` (apps/web/src/composables/useAuth.ts), restricted to the shapes a
 * principal can actually hold: admin short-circuit, exact grant, `*:*`, `resource:*`,
 * `resource:admin`, and read-implied-by-write.
 */
function webHasPermission(user, code) {
  if (!user) return false
  const roles = Array.isArray(user.roles) ? user.roles : []
  const permissions = Array.isArray(user.permissions) ? user.permissions : []
  if (roles.includes('admin')) return true
  if (permissions.includes(code) || permissions.includes('*:*')) return true
  const [resource, action] = code.split(':')
  if (!resource || !action) return false
  if (permissions.includes(`${resource}:*`)) return true
  if (permissions.includes(`${resource}:admin`) && action !== 'admin') return true
  if (action === 'read' && permissions.includes(`${resource}:write`)) return true
  return false
}

/** Whether the workbench renders the surface a route belongs to, for this principal. */
function webRendersSurface(user, feSurface) {
  if (feSurface === 'none') return false
  if (!webRouteGuardAdmits(user)) return false
  if (feSurface === 'queue') return true
  return webHasPermission(user, STOCK_PREP_READ_PERMISSION) && webHasPermission(user, STOCK_PREP_CONFIRM_PERMISSION)
}

/* ─────────────────────────────────── route harness ─────────────────────────────────── */

/**
 * Mounts the real route registry against a host whose every capability COUNTS its calls, so a
 * denial can be asserted to have performed no host work rather than merely to have returned 403.
 */
function mount() {
  const hostCalls = []
  const routes = new Map()
  const record = (name) => (...args) => {
    hostCalls.push(name)
    return args
  }
  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.set(`${method.toUpperCase()} ${routePath}`, handler)
        },
      },
      multitable: {
        provisioning: {
          async ensureObject(...a) { return record('provisioning.ensureObject')(...a) },
          async getObject(...a) { record('provisioning.getObject')(...a); return null },
          async listObjects(...a) { record('provisioning.listObjects')(...a); return [] },
        },
        records: {
          async queryRecords(...a) { record('records.queryRecords')(...a); return [] },
          async createRecord(...a) { return record('records.createRecord')(...a) },
          async patchRecord(...a) { return record('records.patchRecord')(...a) },
        },
      },
    },
    storage: new Map(),
    config: {},
  }
  // The registry's REQUIRED services. Every method throws on call (`inertService` shape, borrowed
  // from stock-preparation-customer-pack-routes.test.cjs): none of them is on a stock-prep path, so
  // reaching one would mean the request went somewhere this matrix is not describing.
  const inertService = (methods) => {
    const service = {}
    for (const method of methods) {
      service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
    }
    return service
  }
  const services = {
    externalSystemRegistry: inertService(['upsertExternalSystem', 'getExternalSystem', 'deleteExternalSystem', 'listExternalSystems']),
    adapterRegistry: inertService(['createAdapter', 'listAdapterKinds']),
    pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    // COUNTED, not inert: these two ARE on the stock-prep path, and a denial leg's whole claim is
    // that a refused caller reached neither.
    stockPreparationAudit: {
      async append(...a) { return record('audit.append')(...a) },
      async list(...a) { record('audit.list')(...a); return { rows: [] } },
    },
    tableActions: {
      async getTableAction(...a) { record('tableActions.getTableAction')(...a); return null },
      async listTableActions(...a) { record('tableActions.listTableActions')(...a); return { rows: [] } },
    },
  }
  httpRoutes.registerIntegrationRoutes({
    context,
    services,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { routes, hostCalls }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function call(routes, method, routePath, req = {}) {
  const handler = routes.get(`${method.toUpperCase()} ${routePath}`)
  assert.ok(handler, `route ${method} ${routePath} is registered`)
  const res = createResponse()
  await handler(
    { user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} },
    res,
  )
  assert.notEqual(res.body, undefined, `${method} ${routePath} produced a JSON body`)
  return res
}

/**
 * Did the SERVER refuse this caller on PERMISSION grounds?
 *
 * The distinction matters: these routes reach a fake host that cannot complete the work, so an
 * ALLOWED caller still ends in an error — just a different one (a validation, config, or store
 * error). Only 401 UNAUTHENTICATED / 403 FORBIDDEN mean "this tier may not". Asserting "status is
 * 200" would make every allow-leg fail for the wrong reason and force the fakes to grow into a
 * second implementation of the ledger.
 */
function refusedOnPermission(res) {
  if (res.body && res.body.ok !== false) return false
  const code = res.body && res.body.error && res.body.error.code
  return (res.statusCode === 401 && code === 'UNAUTHENTICATED')
    || (res.statusCode === 403 && code === 'FORBIDDEN')
}

/* ─────────────────────────────────────── legs ─────────────────────────────────────── */

const failures = []
function check(condition, message) {
  if (!condition) failures.push(message)
}

/** THE MATRIX: every tier × every route, server answer vs the table above. */
async function serverMatrixMatchesTheDeclaredTable() {
  for (const route of ROUTES) {
    for (const tier of TIERS) {
      const { routes, hostCalls } = mount()
      const res = await call(routes, route.method, route.path, { ...route.req, user: tier.user })
      const shouldAllow = route.allow.includes(tier.id)
      const refused = refusedOnPermission(res)

      if (shouldAllow) {
        check(!refused, `[allow] ${tier.id} must not be refused on ${route.method} ${route.path} (got ${res.statusCode} ${res.body && res.body.error && res.body.error.code})`)
      } else {
        check(refused, `[deny] ${tier.id} must be refused on ${route.method} ${route.path} (got ${res.statusCode})`)
        check(
          res.statusCode === (tier.user ? 403 : 401),
          `[deny] ${tier.id} on ${route.method} ${route.path} must be ${tier.user ? 403 : 401}, got ${res.statusCode}`,
        )
        // The gate runs BEFORE any host work: a refused caller must not have touched the host.
        check(
          hostCalls.length === 0,
          `[deny] ${tier.id} on ${route.method} ${route.path} performed host calls: ${hostCalls.join(', ')}`,
        )
      }
    }
  }
}

/** DIRECTION A — nothing visible-but-403. */
async function nothingVisibleIs403() {
  for (const route of ROUTES) {
    for (const tier of TIERS) {
      if (!webRendersSurface(tier.user, route.feSurface)) continue
      const { routes } = mount()
      const res = await call(routes, route.method, route.path, { ...route.req, user: tier.user })
      check(
        !refusedOnPermission(res),
        `[R-11 A] the workbench renders ${route.method} ${route.path} for ${tier.id}, but the server refuses it (${res.statusCode})`,
      )
    }
  }
}

/** DIRECTION B — nothing permitted-but-hidden. */
async function nothingPermittedIsHidden() {
  for (const route of ROUTES) {
    if (route.feSurface === 'none') {
      // Stated exception, asserted rather than assumed: a route with no control must be one this
      // PR deliberately keeps out of the workbench, i.e. admin-only.
      check(
        route.allow.length === 1 && route.allow[0] === 'admin',
        `[R-11 B] ${route.method} ${route.path} renders no control, so it must be admin-only; allow=${route.allow.join(',')}`,
      )
      continue
    }
    for (const tier of TIERS) {
      const { routes } = mount()
      const res = await call(routes, route.method, route.path, { ...route.req, user: tier.user })
      if (refusedOnPermission(res)) continue
      check(
        webRendersSurface(tier.user, route.feSurface),
        `[R-11 B] the server answers ${route.method} ${route.path} for ${tier.id}, but the workbench renders no surface that tier can reach`,
      )
    }
  }
}

/**
 * NEGATIVE CONTROL 1 — admin loses nothing.
 *
 * The failure mode a re-gating PR must rule out is silently narrowing the tier that already worked.
 * Every route in the table must answer an admin, and the assertion is made over the WHOLE table so
 * a route added later is covered without anyone remembering this leg exists.
 */
async function adminLosesNothing() {
  for (const route of ROUTES) {
    const { routes } = mount()
    const res = await call(routes, route.method, route.path, { ...route.req, user: ADMIN })
    check(!refusedOnPermission(res), `[negative] admin lost ${route.method} ${route.path} (${res.statusCode})`)
    check(route.allow.includes('admin'), `[negative] the table must allow admin on ${route.method} ${route.path}`)
  }
  // …and the predicate itself agrees, for both codes and for a code outside the vocabulary.
  check(hasStockPrepPermission(ADMIN, STOCK_PREP_READ_PERMISSION), '[negative] admin must hold read')
  check(hasStockPrepPermission(ADMIN, STOCK_PREP_CONFIRM_PERMISSION), '[negative] admin must hold confirm')
  check(hasStockPrepPermission(ADMIN, 'stockprep:not-a-code'), '[negative] admin short-circuits before any code compare')
}

/**
 * NEGATIVE CONTROL 2 — a bare logged-in user gains nothing.
 *
 * The mirror of the leg above, and the one that would catch a gate accidentally widened to
 * "authenticated". Checked over the whole table AND at the predicate.
 */
async function bareUserGainsNothing() {
  for (const route of ROUTES) {
    const { routes, hostCalls } = mount()
    const res = await call(routes, route.method, route.path, { ...route.req, user: NO_CODES })
    check(refusedOnPermission(res), `[negative] a bare logged-in user reached ${route.method} ${route.path} (${res.statusCode})`)
    check(hostCalls.length === 0, `[negative] a bare logged-in user caused host calls on ${route.method} ${route.path}`)
  }
  check(!hasStockPrepPermission(NO_CODES, STOCK_PREP_READ_PERMISSION), '[negative] no codes must not grant read')
  check(!hasStockPrepPermission(NO_CODES, STOCK_PREP_CONFIRM_PERMISSION), '[negative] no codes must not grant confirm')
}

/**
 * NEGATIVE CONTROL 3 — the pre-O2 integration tiers gain nothing HERE.
 *
 * `integration:write` was the old `/stock-prep` admission code. It must now be refused by the
 * server AND by the router, which is what closes the original R-11 violation rather than moving it.
 */
async function integrationTiersGainNothing() {
  for (const user of [INTEGRATION_READER, INTEGRATION_WRITER]) {
    check(!hasStockPrepPermission(user, STOCK_PREP_READ_PERMISSION), `[negative] ${user.id} must not hold stockprep read`)
    check(!hasStockPrepPermission(user, STOCK_PREP_CONFIRM_PERMISSION), `[negative] ${user.id} must not hold stockprep confirm`)
    check(!webRouteGuardAdmits(user), `[negative] the route guard must not admit ${user.id}`)
  }
}

/**
 * THE ADMISSION-TICKET RULE — confirm is never honored without read.
 *
 * This is what keeps direction B true by construction: the router admits the page on `stockprep:read`
 * alone, so a confirm-only principal could never reach the controls; if the server honored its
 * confirm grant anyway, that authority would be permitted-but-hidden.
 */
async function confirmWithoutReadAuthorizesNothing() {
  const confirmOnly = Object.freeze({
    id: 'u_confirm_only',
    tenantId: TENANT_ID,
    permissions: [STOCK_PREP_CONFIRM_PERMISSION],
  })
  check(!hasStockPrepPermission(confirmOnly, STOCK_PREP_READ_PERMISSION), '[admission] confirm alone must not grant read')
  check(!hasStockPrepPermission(confirmOnly, STOCK_PREP_CONFIRM_PERMISSION), '[admission] confirm alone must not grant confirm')
  check(!webRouteGuardAdmits(confirmOnly), '[admission] the route guard must not admit a confirm-only principal')

  for (const route of ROUTES) {
    const { routes } = mount()
    const res = await call(routes, route.method, route.path, { ...route.req, user: confirmOnly })
    check(refusedOnPermission(res), `[admission] confirm-only reached ${route.method} ${route.path} (${res.statusCode})`)
  }

  // POSITIVE CONTROL — the same predicate ACCEPTS the legitimate pair, so the leg above is a real
  // rule and not a predicate that refuses everything.
  check(hasStockPrepPermission(CONFIRMER, STOCK_PREP_READ_PERMISSION), '[admission] read+confirm must grant read')
  check(hasStockPrepPermission(CONFIRMER, STOCK_PREP_CONFIRM_PERMISSION), '[admission] read+confirm must grant confirm')
  check(hasStockPrepPermission(READER, STOCK_PREP_READ_PERMISSION), '[admission] read must grant read')
  check(!hasStockPrepPermission(READER, STOCK_PREP_CONFIRM_PERMISSION), '[admission] read alone must not grant confirm')

  // UNRECOGNISED CODE — refused, including for the most-privileged NON-admin tier.
  //
  // The natural way to write this predicate is "if it isn't read, require confirm", which answers
  // ALLOW when a read+confirm principal is checked against a code nobody minted. No call site passes
  // one today; this leg is what stops a later one from finding an open door.
  for (const code of ['stockprep:not-a-code', 'stockprep:admin', 'stockprep:*', '', 'admin']) {
    check(
      !hasStockPrepPermission(CONFIRMER, code),
      `[admission] read+confirm must be refused the unrecognised code ${JSON.stringify(code)}`,
    )
    check(
      !hasStockPrepPermission(READER, code),
      `[admission] read must be refused the unrecognised code ${JSON.stringify(code)}`,
    )
  }
}

/**
 * VOCABULARY CLOSURE — exactly two codes, and no third one anywhere.
 *
 * The FE `hasPermission` honors wildcard shapes (`stockprep:*`, `stockprep:admin`) that the server's
 * strict `includes` does not. That divergence is only harmless while no such code is mintable, so
 * the closure is asserted rather than assumed: two codes, both `stockprep:`, neither of them a
 * wildcard or an `:admin`, and the plugin source mints no other `stockprep:` token.
 */
function vocabularyIsClosed() {
  check(STOCK_PREP_PERMISSIONS.length === 2, `[vocabulary] expected 2 codes, got ${STOCK_PREP_PERMISSIONS.length}`)
  check(
    STOCK_PREP_PERMISSIONS.includes('stockprep:read') && STOCK_PREP_PERMISSIONS.includes('stockprep:confirm'),
    `[vocabulary] unexpected codes: ${STOCK_PREP_PERMISSIONS.join(',')}`,
  )
  for (const code of STOCK_PREP_PERMISSIONS) {
    check(/^stockprep:[a-z]+$/.test(code), `[vocabulary] ${code} is not a plain stockprep: code`)
    check(!code.endsWith(':admin') && !code.endsWith(':*'), `[vocabulary] ${code} must not be a wildcard or admin code`)
  }
  const source = require('node:fs').readFileSync(require.resolve('../lib/http-routes.cjs'), 'utf8')
  const minted = Array.from(new Set((source.match(/'stockprep:[a-z*]+'/g) || []).map((s) => s.slice(1, -1))))
  check(
    minted.length === 2 && minted.every((code) => STOCK_PREP_PERMISSIONS.includes(code)),
    `[vocabulary] the plugin source mints codes outside the vocabulary: ${minted.join(',')}`,
  )
}

/**
 * THE BINDING LEG — the FE derivation above must describe the REAL front end.
 *
 * Without this, `webRouteGuardAdmits` is just a comment: someone could change `/stock-prep`'s route
 * meta, or drop a `v-if` from a confirm control, and both R-11 directions would stay green because
 * they were being compared against a restatement rather than against the shipped page. So the three
 * FE facts the derivation depends on are read out of the actual sources and asserted:
 *
 *   1. the route's admission code IS the read code (and is a single-code all-of, since
 *      `isRoutePermitted` is `.every`, so a second code would silently narrow admission);
 *   2. the web permission module states the same admission-ticket rule the server does;
 *   3. the confirm-tier controls in the queue view really are gated on the confirm predicate.
 *
 * Read as source text, which is the repo's established idiom for asserting on `appRoutes.ts`
 * (importing it would pull every view and Element Plus into the process).
 */
function frontEndDeclarationsMatchTheDerivation() {
  const fs = require('node:fs')
  const path = require('node:path')
  const repoRoot = path.resolve(__dirname, '..', '..', '..')
  const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8')

  // 1. the route guard's admission code
  const appRoutes = read('apps/web/src/router/appRoutes.ts')
  const blockStart = appRoutes.indexOf("path: '/stock-prep'")
  check(blockStart > 0, '[binding] appRoutes.ts must declare a /stock-prep route')
  if (blockStart > 0) {
    const block = appRoutes.slice(blockStart, appRoutes.indexOf('\n  },', blockStart))
    const declared = /permissions:\s*\[([^\]]*)\]/.exec(block)
    check(Boolean(declared), '[binding] the /stock-prep route must declare meta.permissions')
    if (declared) {
      const codes = declared[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
      check(
        codes.length === 1 && codes[0] === STOCK_PREP_READ_PERMISSION,
        `[binding] /stock-prep must be admitted by exactly ['${STOCK_PREP_READ_PERMISSION}'], found [${codes.join(', ')}]`,
      )
    }
  }

  // 2. the web permission module's rule
  const webPermissions = read('apps/web/src/services/integration/stockPreparation/permissions.ts')
  check(
    webPermissions.includes(`'${STOCK_PREP_READ_PERMISSION}'`) && webPermissions.includes(`'${STOCK_PREP_CONFIRM_PERMISSION}'`),
    '[binding] the web permission module must declare both codes',
  )
  const canConfirmBody = /export function canConfirmStockPrepDecision[\s\S]*?\n}/.exec(webPermissions)
  check(Boolean(canConfirmBody), '[binding] the web module must export canConfirmStockPrepDecision')
  if (canConfirmBody) {
    check(
      canConfirmBody[0].includes('STOCK_PREP_READ_PERMISSION') && canConfirmBody[0].includes('&&'),
      '[binding] canConfirmStockPrepDecision must require the READ code too (the admission-ticket rule)',
    )
  }

  // 3. the confirm-tier controls
  const queueView = read('apps/web/src/components/integration/stockPreparation/StockPreparationConfirmationQueueView.vue')
  for (const testId of [
    'stock-prep-confirmation-reveal-value',
    'stock-prep-confirmation-open',
  ]) {
    const at = queueView.indexOf(testId)
    check(at > 0, `[binding] the queue view must render ${testId}`)
    if (at > 0) {
      // The control's own element must carry the confirm gate.
      const elementStart = queueView.lastIndexOf('<button', at)
      const element = queueView.slice(elementStart, queueView.indexOf('>', at))
      check(element.includes('v-if="canConfirm"'), `[binding] ${testId} must be gated on canConfirm`)
    }
  }
  const detailPane = queueView.indexOf('data-testid="stock-prep-confirmation-detail"')
  check(detailPane > 0, '[binding] the queue view must render the confirm detail pane')
  check(
    queueView.slice(Math.max(0, detailPane - 400), detailPane).includes('v-if="canConfirm && active"'),
    '[binding] the confirm detail pane (which holds the submit control) must be gated on canConfirm',
  )
  // …and RECONCILE must have NO control anywhere on the page, at any tier.
  //
  // Checked against CODE, not prose: these files document why reconcile is absent, and a check that
  // forbade the word would forbid explaining the decision. What must not exist is a request — i.e.
  // the path inside a string literal, which is the only way this front end can reach a route.
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '')
  for (const relative of [
    'apps/web/src/components/integration/stockPreparation/StockPreparationConfirmationQueueView.vue',
    'apps/web/src/components/integration/stockPreparation/StockPreparationWorkspace.vue',
    'apps/web/src/services/integration/stockPreparation/confirmationQueue.ts',
  ]) {
    check(
      !/['"`][^'"`]*confirmation-decisions\/reconcile/.test(stripComments(read(relative))),
      `[binding] ${relative} must not reach the owner-level reconcile route`,
    )
  }
  // POSITIVE CONTROL for the rule above — it must FIRE on a request-shaped occurrence, or "no
  // reconcile control" would be a claim that passes against any file at all.
  check(
    /['"`][^'"`]*confirmation-decisions\/reconcile/.test(
      stripComments("await apiFetch('/api/integration/table-actions/x/confirmation-decisions/reconcile')"),
    ),
    '[binding] the reconcile-absence rule must detect a real call',
  )
  check(
    !/['"`][^'"`]*confirmation-decisions\/reconcile/.test(
      stripComments('// never call confirmation-decisions/reconcile from here'),
    ),
    '[binding] the reconcile-absence rule must ignore a comment',
  )
}

/* ─────────────────────────────────────── runner ─────────────────────────────────────── */

async function main() {
  await serverMatrixMatchesTheDeclaredTable()
  await nothingVisibleIs403()
  await nothingPermittedIsHidden()
  await adminLosesNothing()
  await bareUserGainsNothing()
  await integrationTiersGainNothing()
  await confirmWithoutReadAuthorizesNothing()
  vocabularyIsClosed()
  frontEndDeclarationsMatchTheDerivation()

  if (failures.length) {
    for (const failure of failures) console.error(`  ✗ ${failure}`)
    assert.fail(`stock-prep operator permission matrix: ${failures.length} violation(s)`)
  }
  console.log(`stock-prep operator permission matrix OK (${ROUTES.length} routes × ${TIERS.length} tiers, both R-11 directions)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
