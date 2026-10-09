'use strict'

// 一个项目一张备料表 — THE CALL-SITE GUARD (S1 of ADR adr-stock-prep-project-sheets-20261008 §3
// 「防止漏传」), in the form of stock-preparation-tenant-scoped-write-guard.test.cjs: a SOURCE scan of
// http-routes.cjs, because a route-level behaviour test can only see the lookups it drives.
//
// WHAT IT PINS. While the switch is on, `getTableAction` resolves the SHEET from the project
// registry, keyed by `projectNo`. A lookup that forgets the number would either be refused 400 by
// the overlay (harmless but a broken route) or — if it also declared a purpose the overlay skips —
// silently read the OLD mixed sheet. So:
//   C-01 every `tableActions.getTableAction(` call in the route source carries EITHER a `projectNo`
//        key OR an explicit `targetPurpose: 'source'` / `targetPurpose: 'readiness'`;
//   C-02 the SOURCE-only lookups are exactly the four the ADR names (overview list, source
//        preflight, source-binding picker, source-binding set) — pinned by handler, so a fifth
//        `'source'` must be argued here;
//   C-03 the READINESS lookups are exactly the five large-BOM job routes (they work on the stored
//        snapshot) plus the directory's switch-off probe — pinned by handler;
//   C-04 every write route the ADR lists runs the resolved-target tenant wall
//        (`assertResolvedProjectTargetTenancy(`) after its lookup — pinned by handler;
//   C-05 the registry construction wires `resolveProjectTarget` through
//        `resolveProjectTargetForAction` with a staging project derived from the lookup's tenant
//        and `undefined` (never a request projectId).
//
// Mutation: delete `projectNo` from any one lookup, or change a `'source'` to `'write'`, or drop a
// wall call, and the corresponding check reds naming the handler.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http-routes.cjs'), 'utf8')
// Comments stripped BEFORE scanning so prose can neither satisfy nor trip a check.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** The handler (`    async NAME(req, res) {`) a source offset sits in, or null outside any handler. */
function handlerAt(offset) {
  const pattern = /\n {4}async ([A-Za-z0-9_$]+)\(req, res\) \{/g
  let current = null
  let match = pattern.exec(CODE)
  while (match && match.index < offset) {
    current = match[1]
    match = pattern.exec(CODE)
  }
  return current
}

/** Every `getTableAction(` call with its balanced argument text. */
function getTableActionCalls() {
  const calls = []
  const needle = 'getTableAction('
  let from = 0
  for (;;) {
    const at = CODE.indexOf(needle, from)
    if (at < 0) break
    let depth = 0
    let end = at + needle.length - 1
    for (let i = at + needle.length - 1; i < CODE.length; i += 1) {
      const ch = CODE[i]
      if (ch === '(') depth += 1
      if (ch === ')') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    const args = CODE.slice(at + needle.length, end)
    calls.push({ offset: at, handler: handlerAt(at), args })
    from = end
  }
  return calls
}

let passed = 0
let failed = 0
function check(name, fn) {
  try { fn(); passed += 1 } catch (error) { failed += 1; console.error(`FAIL: ${name}`); console.error(error && error.message ? error.message : error) }
}

const calls = getTableActionCalls().filter((call) => call.handler)
check('the scan finds the route lookups (derivation is not vacuous)', () => {
  assert.ok(calls.length >= 20, `expected at least 20 getTableAction lookups inside handlers, found ${calls.length}`)
})

const purposeOf = (args) => {
  const m = args.match(/targetPurpose:\s*'([a-z]+)'/)
  return m ? m[1] : null
}
const carriesProjectNo = (args) => /(^|[\s{,])projectNo\b/.test(args) || /projectNo:\s*/.test(args)

check('C-01 every lookup carries projectNo or an explicit source / readiness purpose', () => {
  const offenders = calls
    .filter((call) => !(carriesProjectNo(call.args) || purposeOf(call.args) === 'source' || purposeOf(call.args) === 'readiness'))
    .map((call) => call.handler)
  assert.deepEqual(offenders, [], 'these handlers look up the table action without a projectNo and without declaring a source/readiness purpose')
})

check('C-02 the SOURCE-only lookups are exactly the four the ADR names', () => {
  const sourceHandlers = [...new Set(calls.filter((call) => purposeOf(call.args) === 'source').map((call) => call.handler))].sort()
  assert.deepEqual(sourceHandlers, [
    'integrationHubOverview',
    'stockPreparationSourceBindingGet',
    'stockPreparationSourceBindingSet',
    'stockPreparationSourcePreflight',
  ].sort())
  for (const call of calls.filter((c) => purposeOf(c.args) === 'source')) {
    assert.ok(!carriesProjectNo(call.args), `${call.handler}: a source-only lookup names no project`)
  }
})

check('C-03 the READINESS lookups are exactly the five large-BOM job routes and the directory probe', () => {
  const readinessHandlers = [...new Set(calls.filter((call) => purposeOf(call.args) === 'readiness').map((call) => call.handler))].sort()
  // (The plan route takes its target from the stored snapshot and never looks the action up.)
  assert.deepEqual(readinessHandlers, [
    'stockPreparationOperatorProjectDirectory',
    'tableActionLargeBomApplyJobGet',
    'tableActionLargeBomApplyJobRun',
    'tableActionLargeBomApplyJobStart',
    'tableActionLargeBomExpansionJobCancel',
    'tableActionLargeBomExpansionJobGet',
  ].sort())
})

check('C-04 every ADR write route runs the resolved-target tenant wall after its lookup', () => {
  const WALLED = [
    'tableActionDryRun',
    'tableActionApply',
    'tableActionConfirmationDecisionsReconcile',
    'tableActionMvpPersist',
    'tableActionLargeBomExpansionJobStart',
    'tableActionConflictPoliciesList',
    'tableActionConflictPoliciesSave',
    'tableActionConflictPoliciesDelete',
  ]
  for (const handler of WALLED) {
    const start = CODE.indexOf(`    async ${handler}(req, res) {`)
    assert.notEqual(start, -1, `${handler} exists`)
    const end = CODE.indexOf('\n    },', start)
    const body = CODE.slice(start, end)
    const lookupAt = body.indexOf('getTableAction(')
    const wallAt = body.indexOf('assertResolvedProjectTargetTenancy(')
    assert.notEqual(lookupAt, -1, `${handler}: has a lookup`)
    assert.notEqual(wallAt, -1, `${handler}: runs assertResolvedProjectTargetTenancy`)
    assert.ok(wallAt > lookupAt, `${handler}: the wall runs AFTER the lookup`)
  }
  // The large-BOM apply-run re-reads the registry per chunk (a WRITE lookup) and feeds the gate.
  const runStart = CODE.indexOf('    async tableActionLargeBomApplyJobRun(req, res) {')
  assert.notEqual(runStart, -1, 'the large-BOM apply-run handler exists')
  const runBody = CODE.slice(runStart, CODE.indexOf('\n    },', runStart))
  assert.match(runBody, /getTableAction\(\{[\s\S]*?projectNo: runExpansionJob\.parameters && runExpansionJob\.parameters\.projectNo,[\s\S]*?targetPurpose: 'write',/, 'apply-run re-resolves the registry row for the run')
  assert.match(runBody, /projectSheetGate: projectSheetGateFor\(runProjectAction\)/, 'apply-run builds its gate input from that re-read')
  // The small apply builds its gate input from the overlaid action.
  const applyStart = CODE.indexOf('    async tableActionApply(req, res) {')
  const applyBody = CODE.slice(applyStart, CODE.indexOf('\n    },', applyStart))
  assert.match(applyBody, /projectSheetGate: projectSheetGateFor\(action\)/, 'apply hands the gate the overlay marker')
})

check('C-05 the registry wires the overlay through resolveProjectTargetForAction with a tenant-derived staging project', () => {
  const wiring = CODE.slice(CODE.indexOf('const tableActions = createStockPreparationTableActionRegistry({'), CODE.indexOf('const customerPackCatalog = createCustomerPackCatalog({'))
  assert.match(wiring, /resolveProjectTarget: stockPreparationProjectTargets\s*\?\s*async \(\{ tenantId, projectNo, targetPurpose \}\) => resolveProjectTargetForAction\(\{/)
  assert.match(wiring, /projectId: resolveIntegrationStagingProjectId\(tenantId, undefined\)/)
  assert.ok(!/projectId: resolveIntegrationStagingProjectId\(tenantId, [^u]/.test(wiring), 'never a request projectId')
  assert.match(wiring, /env: process\.env/, 'the switch is read per call, from the live environment')
})

check('the three S1 routes check the switch BEFORE any IO and the create route is PULL-gated', () => {
  for (const handler of ['stockPreparationProjectTargetGet', 'stockPreparationProjectTargetCreate', 'stockPreparationProjectTargetList']) {
    const start = CODE.indexOf(`    async ${handler}(req, res) {`)
    const body = CODE.slice(start, CODE.indexOf('\n    },', start))
    const gateAt = body.indexOf('requireAccess(req, ')
    const switchAt = body.indexOf('requireProjectSheetsEnabled()')
    assert.notEqual(switchAt, -1, `${handler}: checks the switch`)
    assert.ok(gateAt !== -1 && gateAt < switchAt, `${handler}: the permission gate precedes the switch check`)
    const firstAwait = body.indexOf('await ')
    assert.ok(firstAwait === -1 || firstAwait > switchAt, `${handler}: no IO before the switch check`)
    assert.match(body, /resolveOperatorValueScope\(\{/, `${handler}: tenant from the host-vouched scope`)
  }
  const createStart = CODE.indexOf('    async stockPreparationProjectTargetCreate(req, res) {')
  const createBody = CODE.slice(createStart, CODE.indexOf('\n    },', createStart))
  assert.match(createBody, /requireAccess\(req, STOCK_PREP_PULL\)/)
  assert.match(createBody, /normalizeStockPreparationConfirmBody\(requestBody\(req\), VALID_EMPTY_REQUEST_KEYS/, 'an EMPTY closed body')
  assert.match(createBody, /store\.count\(\{ tenantId \}\)[\s\S]*?MAX_PROJECT_TARGETS_PER_TENANT/, 'the cap is checked before provisioning')
  assert.ok(createBody.indexOf('store.count(') < createBody.indexOf('provisionProjectSheet('), 'cap before provision')
  assert.ok(createBody.indexOf('provisionProjectSheet(') < createBody.indexOf('store.create('), 'provision before register')
  assert.ok(createBody.indexOf('store.create(') < createBody.indexOf('grantProjectSheetRoles('), 'register before grant')
  assert.match(createBody, /roleIds: resolveProjectSheetGrantRoleIds\(process\.env\)/, 'roles from server config, never the request')
})

if (failed) {
  console.error(`stock-preparation-project-target-call-site-guard.test.cjs FAILED (${failed} of ${passed + failed})`)
  process.exit(1)
}
console.log(`✓ stock-preparation-project-target-call-site-guard (${passed} checks)`)
