'use strict'

// ── Tenant-scoped WRITE routes: static steering tripwire ─────────────────────────────────────────────
//
// GHSA (private): the shared `resolveTenantId(req, input)` resolves the tenant from the REQUEST first
// (`input.tenantId` / `req.query.tenantId` / `req.params.tenantId`) and, for ADMINS, skips the
// tenant-mismatch check. On a tenant-scoped WRITE route that is a cross-tenant steering vector: a
// tenant_1 admin can redirect the write to another tenant's `${tenantId}:integration-core` staging
// project. A SECOND vector rides `resolveIntegrationStagingProjectId(tenantId, input.projectId)`: that
// helper returns a request-supplied `X:integration-core` projectId VERBATIM (isIntegrationCoreProjectId),
// so `projectId: "tenant_evil:integration-core"` steers the staging target regardless of the tenant.
//
// The fix for every tenant-scoped WRITE route: derive the tenant from the AUTHENTICATED principal only
// (`resolveAuthUserTenantId(req)`), and derive the staging project from that tenant WITHOUT a
// request-supplied projectId (`resolveIntegrationStagingProjectId(tenantId, undefined)`), so neither the
// body/query/params tenantId nor the projectId can move the write off the caller's own tenant.
//
// This tripwire is STATIC (parses the route source) so the class cannot silently reappear: a new write
// route, or a regression on an existing one, that reaches back for `resolveTenantId(req, input)` or
// `resolveIntegrationStagingProjectId(tenantId, input.projectId)` fails the build here.
//
// NOTE: the readonly source-run routes (`...PlmBomSourceRun`, `...ErpMaterialSourceRun`) and the sync
// PLAN route are intentionally NOT in this list — whether an explicit, audited cross-tenant admin READ
// capability is desirable is a separate decision (GHSA step 2), so they are not mechanically converted.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROUTES_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'http-routes.cjs'),
  'utf8',
)

// Every CONFIRMED tenant-scoped WRITE route (derives a `${tenant}:integration-core` staging target and
// then create/patch-es rows into it). erp-material-sync is the reference route hardened in #4206.
const TENANT_SCOPED_WRITE_HANDLERS = [
  'stockPreparationErpMaterialSync',
  'stockPreparationMvpSyncPersist',
  'stockPreparationMaterialMappingCandidatesSync',
  'stockPreparationMaterialMappingConfirm',
  'stockPreparationMaterialMappingRetire',
  'stockPreparationUnitConversionConfirm',
  'stockPreparationUnitConversionRetire',
  'stockPreparationGenerationRun',
  'stockPreparationExceptionResolve',
  'stockPreparationExceptionBulkResolve',
]

// Extract a handler's body: from `    async NAME(req, res) {` to the first `    },` at handler indent.
function handlerBody(src, name) {
  const startMarker = `    async ${name}(req, res) {`
  const start = src.indexOf(startMarker)
  assert.notEqual(start, -1, `handler ${name} not found in http-routes.cjs`)
  const end = src.indexOf('\n    },', start)
  assert.notEqual(end, -1, `handler ${name} has no closing brace`)
  // Strip line comments so a security guard reasons about CODE, not prose: a comment that NAMES the
  // forbidden pattern (e.g. explaining why resolveTenantId is unsafe) must not trip an absence check,
  // and a comment must never satisfy a presence check either. (No handler body here has `//` outside a
  // comment.)
  return src.slice(start, end).replace(/\/\/[^\n]*/g, '')
}

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failed += 1
    console.error(`FAIL: ${name}`)
    console.error(error && error.message ? error.message : error)
  }
}

for (const name of TENANT_SCOPED_WRITE_HANDLERS) {
  const body = handlerBody(ROUTES_SRC, name)

  check(`${name}: does NOT derive tenant via the request-steerable resolveTenantId(req, input)`, () => {
    assert.equal(
      body.includes('resolveTenantId(req, input)'),
      false,
      `${name} calls resolveTenantId(req, input) — a tenant-scoped write must derive tenant from the authenticated principal (resolveAuthUserTenantId), never the request`,
    )
  })

  check(`${name}: derives tenant from the authenticated principal (resolveAuthUserTenantId)`, () => {
    assert.equal(
      body.includes('resolveAuthUserTenantId(req)'),
      true,
      `${name} must call resolveAuthUserTenantId(req)`,
    )
  })

  check(`${name}: does NOT let a request projectId steer the staging project`, () => {
    assert.equal(
      body.includes('resolveIntegrationStagingProjectId(tenantId, input.projectId)'),
      false,
      `${name} passes a request projectId into resolveIntegrationStagingProjectId — an X:integration-core projectId is returned verbatim, steering the staging target; pass undefined so staging is always the authenticated tenant's`,
    )
  })
}

// ── GHSA-m6qv-2rpf-q7mh step-1 FOLLOW-UP (owner re-review P1) ────────────────────────────────────
// The list above covers the business-ROW writes, which derive the tenant INLINE in the handler body.
// These SIX faces write STRUCTURE (bases/tables) or FIELD METADATA and derive the tenant inside their
// input NORMALIZER instead — so asserting on the handler body alone would be a wrapper-grep that proves
// nothing. Each check below FOLLOWS THE DELEGATION: it reads the normalizer the handler actually calls
// and asserts on THAT function's body.
const STRUCTURE_WRITE_HANDLERS = [
  'stockPreparationTargetEnsure',
  'stockPreparationSandboxTargetEnsure',
  'stockPreparationOptionsSync',
  'stockPreparationMvpEnsure',
  'stockPreparationMvpOptionsSync',
  'fieldOptionsSync',
]

// Extract a top-level `function NAME(req, rawInput = {}) { ... }` body.
function normalizerBody(src, name) {
  const startMarker = `function ${name}(req, rawInput = {}) {`
  const start = src.indexOf(startMarker)
  assert.notEqual(start, -1, `normalizer ${name} not found in http-routes.cjs`)
  const end = src.indexOf('\n}', start)
  assert.notEqual(end, -1, `normalizer ${name} has no closing brace`)
  return src.slice(start, end).replace(/\/\/[^\n]*/g, '')  // strip comments — guards reason about code, not prose
}

// Which normalizer does this handler actually call? (Read it out of the handler body — so renaming or
// swapping the normalizer cannot silently bypass this guard.)
function normalizerFor(src, handler) {
  const body = handlerBody(src, handler)
  const m = body.match(/const input = ([A-Za-z]+Input)\(req/)
  assert.ok(m, `${handler}: could not find its input normalizer call — the guard must follow the delegation, so this is a hard failure, not a skip`)
  return m[1]
}

for (const handler of STRUCTURE_WRITE_HANDLERS) {
  const normName = normalizerFor(ROUTES_SRC, handler)
  const body = normalizerBody(ROUTES_SRC, normName)

  check(`${handler} → ${normName}: does NOT derive tenant via the request-steerable resolveTenantId(req, input)`, () => {
    assert.equal(
      body.includes('resolveTenantId(req, input)'),
      false,
      `${handler}'s normalizer ${normName} calls resolveTenantId(req, input) — a tenantless platform admin may select a read tenant, but a structure/metadata write must never inherit request-selected scope`,
    )
  })

  check(`${handler} → ${normName}: derives tenant from the authenticated principal (resolveAuthUserTenantId)`, () => {
    assert.equal(
      body.includes('resolveAuthUserTenantId(req)'),
      true,
      `${handler}'s normalizer ${normName} must call resolveAuthUserTenantId(req)`,
    )
  })

  check(`${handler} → ${normName}: does NOT let a request projectId steer the staging project`, () => {
    assert.equal(
      body.includes('resolveIntegrationStagingProjectId(tenantId, input.projectId)'),
      false,
      `${handler}'s normalizer ${normName} passes a request projectId into resolveIntegrationStagingProjectId — an "X:integration-core" projectId is returned VERBATIM, steering the target regardless of tenant; pass undefined`,
    )
  })
}

// The READ faces deliberately keep the request-steerable normalizers (GHSA step 2 decides whether an
// audited cross-tenant admin READ is desirable). Pin that boundary so a future "cleanup" that points a
// WRITE handler back at a shared read normalizer is caught here.
for (const [readHandler, sharedNormalizer] of [
  ['stockPreparationTargetReadiness', 'stockPreparationTargetInput'],
  ['stockPreparationSandboxTargetReadiness', 'stockPreparationSandboxTargetInput'],
  ['stockPreparationMvpReadiness', 'stockPreparationMvpTargetInput'],
]) {
  check(`${readHandler}: still uses the shared ${sharedNormalizer} (step-2 boundary, deliberately unchanged)`, () => {
    assert.equal(normalizerFor(ROUTES_SRC, readHandler), sharedNormalizer)
  })
}

// GHSA-m6qv step-1 follow-up (owner decision A): the 3 WRITE-path normalizers must reject an explicit
// request baseId (fail-closed, third steering axis) and must NOT forward a request baseId to provisioning.
function writeVariantBody(src, name) {
  const startMarker = `function ${name}(req, rawInput = {}) {`
  const start = src.indexOf(startMarker)
  assert.notEqual(start, -1, `write normalizer ${name} not found`)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end).replace(/\/\/[^\n]*/g, '')  // strip comments — guards reason about code, not prose
}
for (const name of ['stockPreparationTargetWriteInput', 'stockPreparationSandboxTargetWriteInput', 'stockPreparationMvpTargetWriteInput']) {
  const body = writeVariantBody(ROUTES_SRC, name)
  check(`${name}: rejects an explicit request baseId (assertNoRequestBaseId)`, () => {
    assert.equal(body.includes('assertNoRequestBaseId(rawInput)'), true, `${name} must call assertNoRequestBaseId(rawInput) before building the input`)
  })
  check(`${name}: does NOT forward a request baseId into the resolved write input`, () => {
    assert.equal(body.includes('baseId: input.baseId'), false, `${name} must not carry baseId: input.baseId — a request baseId is a cross-tenant steering axis`)
  })
}

// GHSA-m6qv step-1 follow-up (owner P1): stagingInstall is a same-class tenant-scoped STRUCTURE write
// but derives INLINE in the handler (not via a *WriteInput normalizer) — the original tripwire missed it.
// Assert the handler body directly.
{
  const body = handlerBody(ROUTES_SRC, 'stagingInstall')
  check('stagingInstall: derives tenant from the authenticated principal (resolveAuthUserTenantId)', () => {
    assert.equal(body.includes('resolveAuthUserTenantId(req)'), true, 'stagingInstall must call resolveAuthUserTenantId(req)')
  })
  check('stagingInstall: does NOT derive tenant from the request-steerable resolveTenantId(req, ...)', () => {
    assert.equal(/resolveTenantId\(req,/.test(body), false, 'stagingInstall must not call resolveTenantId(req, body/input) — writes cannot inherit a tenantless platform admin request-selected read scope')
  })
  check('stagingInstall: the ONLY staging-project derivation passes undefined (no request projectId steers it)', () => {
    const calls = body.match(/resolveIntegrationStagingProjectId\(tenantId, [^)]*\)/g) || []
    assert.ok(calls.length > 0, 'stagingInstall must derive the staging project id')
    assert.ok(calls.every((c) => c === 'resolveIntegrationStagingProjectId(tenantId, undefined)'), `stagingInstall must derive the staging project with undefined (got ${JSON.stringify(calls)})`)
  })
  // Assert BOTH sources DISTINCTLY — a count>=2 could be satisfied by checking `body` twice, leaving the
  // query hole open (owner: exactly that regression stayed static-green under a count-only guard).
  check('stagingInstall: rejects an explicit baseId from the request BODY (assertNoRequestBaseId(body))', () => {
    assert.equal(body.includes('assertNoRequestBaseId(body)'), true, 'stagingInstall must call assertNoRequestBaseId(body)')
  })
  check('stagingInstall: rejects an explicit baseId from the request QUERY (assertNoRequestBaseId(query))', () => {
    assert.equal(body.includes('assertNoRequestBaseId(query)'), true, 'stagingInstall must call assertNoRequestBaseId(query) — a baseId can also arrive on the query string')
  })
}

// ── #5442 通知下一步 (F3): THE HANDOFF FACES, ENROLLED ───────────────────────────────────────────
// This file's header promises that "a new write route … that reaches back for `resolveTenantId(req,
// input)` … fails the build here". `stockPreparationHandoffAdvance` is the first tenant-scoped write
// added since that promise was made, and it was enrolled in NEITHER list — reverting its tenant
// derivation to the pre-#5445 form left this suite green (62 passed, 0 failed) while the dynamic
// witnesses in stock-preparation-handoff.test.cjs went red. The dynamic ones are the real guard; this
// one exists because dynamic witnesses can be deleted in the same commit that regresses the code.
//
// THE ASSERTIONS ARE SHAPED DIFFERENTLY FROM THE TEN ABOVE, and deliberately. Those routes are the
// resolveAuthUserTenantId era: derive the tenant from `user.tenantId` and never from the request. That
// is no longer sufficient here, because `user.tenantId` IS request-fillable — the auth middleware
// copies the x-tenant-id header onto it whenever the verified token carries no tenant claim. These two
// routes must go further and make the HOST vouch for the (principal, tenant) pairing, so what is
// pinned is the presence of `resolveOperatorValueScope(` and the ABSENCE of BOTH older derivations.
//
// The STATUS route is included even though its payload is values-free: it is still the route whose
// tenant a header used to decide, and "it only reads" is exactly the argument that left it out.
for (const name of ['stockPreparationHandoffAdvance', 'stockPreparationHandoffStatus']) {
  const body = handlerBody(ROUTES_SRC, name)

  check(`${name}: does NOT derive tenant via the request-steerable resolveTenantId(req, ...)`, () => {
    assert.equal(
      /resolveTenantId\(req,/.test(body),
      false,
      `${name} calls resolveTenantId(req, …) — it lets a tenantless platform admin select the tenant from the request, which on this route decides whose cursor moves and whose project number is announced`,
    )
  })

  check(`${name}: does NOT derive tenant from the header-fillable user.tenantId (resolveAuthUserTenantId)`, () => {
    assert.equal(
      body.includes('resolveAuthUserTenantId(req)'),
      false,
      `${name} calls resolveAuthUserTenantId(req) — that reads user.tenantId, which the auth middleware fills from the x-tenant-id HEADER when the token carries no tenant claim; on this route that header would choose whose chain advances`,
    )
  })

  check(`${name}: derives tenant through the host-vouched operator scope (resolveOperatorValueScope)`, () => {
    assert.equal(
      body.includes('resolveOperatorValueScope('),
      true,
      `${name} must resolve its tenant through resolveOperatorValueScope — the #5445 seam that prefers the VERIFIED claim, refuses a contradicting carrier, refuses a tenantless principal, and makes the host vouch for the pairing`,
    )
  })

  check(`${name}: uses the RESOLVED tenant, not one it re-derived afterwards`, () => {
    assert.equal(
      body.includes('scope.tenantId'),
      true,
      `${name} must take its tenant from the resolved scope (scope.tenantId); calling the resolver and then using something else would pass the check above while changing nothing`,
    )
  })
}

// The advance route is additionally the one that SPEAKS OUTSIDE THE SYSTEM, so pin that its
// deploy-config chain is checked against the resolved tenant before anything is written or sent.
check('stockPreparationHandoffAdvance: checks the configured chain belongs to the resolved tenant', () => {
  const body = handlerBody(ROUTES_SRC, 'stockPreparationHandoffAdvance')
  assert.equal(
    body.includes('requireStockPreparationHandoffChainForTenant(chain, tenantId)'),
    true,
    'stockPreparationHandoffAdvance must refuse a chain bound to another tenant — the DingTalk destinations are deploy config and nothing downstream relates them to the advancing tenant',
  )
})

// ── The VALUE-BEARING READS: the same tripwire, pointed the other way ────────────────────────────
//
// The four reads below are the ONLY stock-prep GETs that carry customer values to the caller (project
// numbers and names, material names and quantities, an author's own entered value). They do NOT use
// `resolveAuthUserTenantId` — they use `resolveOperatorValueScope`, which is stricter still: it
// prefers a VERIFIED token claim, refuses a request-carried tenant, refuses a header that
// contradicts the claim, refuses a principal with no tenant of its own, and makes the HOST vouch for
// the (user, tenant) pairing. `user.tenantId` alone is not enough here, because the host's auth
// middleware fills that field from the `x-tenant-id` REQUEST HEADER when a token carries no tenant
// claim — so on a claimless deployment `resolveTenantId` would let a header pick whose values are
// served.
//
// WHY STATIC. Every route-level behaviour test enters through the handler and therefore only ever
// sees the scope that IS resolved; swapping `scope.tenantId` for `resolveTenantId(req, input)` at
// the derivation sites kept all nine plugin suites green. Only a source-level assertion says "this
// class of handler does not reach for the request-steerable resolver at all", and only that form
// stays true when a fifth value-bearing read arrives.
// DERIVED, NOT TYPED. A hand-kept list is a guard that can be disarmed by deleting a line from
// itself: removing the board from this array left every assertion below still passing, on a
// smaller set, and said nothing. So the set is SCANNED out of the route source — every handler
// that calls `resolveOperatorValueScope(` is by definition deciding whose VALUES it may show —
// and then cross-checked against a pinned literal. A fifth value-bearing read joins the tripwire
// automatically; deleting one becomes a visible edit to a pinned constant that this file refuses.
function handlersCallingOperatorValueScope(src) {
  const found = []
  const pattern = /\n {4}async ([A-Za-z0-9_$]+)\(req, res\) \{/g
  let match = pattern.exec(src)
  while (match) {
    const body = handlerBody(src, match[1])
    if (body.includes('resolveOperatorValueScope(')) found.push(match[1])
    match = pattern.exec(src)
  }
  return found.sort()
}

/** The value-bearing reads as of this commit. A change here is a deliberate, reviewable act. */
const PINNED_VALUE_BEARING_READ_HANDLERS = [
  'stockPreparationConfirmationDecisionsValueEntry',
  // 通知下一步 (#5442). The two handoff faces derive their tenant through the same host-vouched
  // operator scope, so the DERIVED set picked them up the moment that PR landed — which is the point
  // of deriving it. They are pinned here rather than special-cased: the three per-handler checks
  // below are exactly the ones #5442's own block already makes of them, so running them twice costs
  // nothing and means a future regression on either is caught by whichever guard is read first.
  'stockPreparationHandoffAdvance',
  'stockPreparationHandoffStatus',
  'stockPreparationOperatorProjectBoard',
  'stockPreparationOperatorProjectDirectory',
  'stockPreparationPrepLineExport',
].sort()

const VALUE_BEARING_READ_HANDLERS = handlersCallingOperatorValueScope(ROUTES_SRC)

check('the value-bearing read set is DERIVED from the source and is not empty', () => {
  assert.ok(
    VALUE_BEARING_READ_HANDLERS.length > 0,
    'the scan found no handler calling resolveOperatorValueScope( — the derivation broke, and every '
    + 'per-handler assertion below became vacuous',
  )
})

check('the derived set equals the pinned set (a new value-bearing read must be pinned here)', () => {
  assert.deepEqual(
    VALUE_BEARING_READ_HANDLERS,
    PINNED_VALUE_BEARING_READ_HANDLERS,
    'a handler that resolves an operator VALUE scope has been added or removed. If added: it carries '
    + 'customer values, so pin it here and let the three checks below run over it. If removed: say so '
    + 'in the pin.',
  )
})

// The three that derive their staging project inline. (The export does not: its sheet is the bound
// table action's deploy-time target, which is why its own handler comment spells out what the
// verified tenant does and does not decide there.)
const VALUE_BEARING_READS_WITH_INLINE_STAGING = new Set([
  'stockPreparationConfirmationDecisionsValueEntry',
  'stockPreparationOperatorProjectDirectory',
  'stockPreparationOperatorProjectBoard',
])

for (const name of VALUE_BEARING_READ_HANDLERS) {
  const body = handlerBody(ROUTES_SRC, name)

  check(`${name}: does NOT derive tenant via the request-steerable resolveTenantId`, () => {
    assert.equal(
      /resolveTenantId\(/.test(body),
      false,
      `${name} calls resolveTenantId(...) — a VALUE-BEARING read must derive its tenant from resolveOperatorValueScope, which is the sole tenancy authority on this plane`,
    )
  })

  check(`${name}: does NOT read user.tenantId directly`, () => {
    assert.equal(
      /user\.tenantId/.test(body),
      false,
      `${name} reads user.tenantId — that field is filled from the x-tenant-id REQUEST HEADER on a tenant-claimless deployment, so it is not a verified claim`,
    )
  })

  check(`${name}: derives WHOSE values through resolveOperatorValueScope`, () => {
    assert.equal(
      body.includes('resolveOperatorValueScope('),
      true,
      `${name} must resolve the operator value scope`,
    )
  })

  if (VALUE_BEARING_READS_WITH_INLINE_STAGING.has(name)) {
    check(`${name}: the staging project comes from the RESOLVED SCOPE, with no request projectId`, () => {
      const calls = body.match(/resolveIntegrationStagingProjectId\([^)]*\)/g) || []
      assert.ok(calls.length > 0, `${name} must derive its staging project`)
      assert.ok(
        calls.every((call) => call === 'resolveIntegrationStagingProjectId(scope.tenantId, undefined)'),
        `${name} must derive the staging project from scope.tenantId with undefined (got ${JSON.stringify(calls)})`,
      )
    })
  }
}

console.log(`\nstock-preparation-tenant-scoped-write-guard.test.cjs: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('stock-preparation-tenant-scoped-write-guard.test.cjs FAILED')
  process.exit(1)
}
console.log('stock-preparation-tenant-scoped-write-guard.test.cjs OK')
