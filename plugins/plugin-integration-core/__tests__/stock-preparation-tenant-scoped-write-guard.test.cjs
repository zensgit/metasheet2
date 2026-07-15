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
      `${handler}'s normalizer ${normName} calls resolveTenantId(req, input) — resolveTenantId honors a request tenantId for admins, so a structure/metadata write could be steered into another tenant's project`,
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
    assert.equal(/resolveTenantId\(req,/.test(body), false, 'stagingInstall must not call resolveTenantId(req, body/input) — that honors a request tenantId for admins')
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

console.log(`\nstock-preparation-tenant-scoped-write-guard.test.cjs: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('stock-preparation-tenant-scoped-write-guard.test.cjs FAILED')
  process.exit(1)
}
console.log('stock-preparation-tenant-scoped-write-guard.test.cjs OK')
