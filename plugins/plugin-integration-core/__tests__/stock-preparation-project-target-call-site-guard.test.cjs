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
//        and `undefined` (never a request projectId);
//   C-06 (R1) the three large-BOM routes that work on a STORED snapshot — plan, apply-start,
//        apply-run — look the registry up by the job's own projectNo and run
//        `assertLargeBomJobTargetMatchesProjectTarget(` on the stored target BEFORE any IO on it
//        (apply-run on both the expansion snapshot and the apply job's target, before the gate);
//   C-07 (R2) the OTHER lib caller of `getTableAction` — the preflight's env-binding probe — declares
//        `targetPurpose: 'readiness'`, and http-routes.cjs + stock-preparation-preflight.cjs are the
//        ONLY lib files that call it (a new caller must be argued here);
//   C-08 (E2b) `projectSheetGateFor` reads the switch live and the registry objectId from the
//        RESOLVED target, never a literal and never the deployment objectId.
//   C-09 (S2, R-36) the project-sheet CREATE reads the deployment's env binding (a 'readiness'
//        lookup, never overlaid) and plans the customer packs BEFORE it provisions, installs them
//        AFTER it provisions and BEFORE it registers — so a failed install leaves no registered row —
//        and heals a replayed (already registered) sheet through the same install.
//   C-01 also rejects `projectNo: undefined` (key present, no value — E2e).
//
// Mutation: delete `projectNo` from any one lookup, or change a `'source'` to `'write'`, or drop a
// wall call, and the corresponding check reds naming the handler.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
// Comments stripped BEFORE scanning so prose can neither satisfy nor trip a check.
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const SRC = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8')
const CODE = stripComments(SRC)
const PREFLIGHT_CODE = stripComments(fs.readFileSync(path.join(LIB, 'stock-preparation-preflight.cjs'), 'utf8'))

/** The handler (`    async NAME(req, res) {`) a source offset sits in, or null outside any handler. */
function handlerAt(offset, code = CODE) {
  const pattern = /\n {4}async ([A-Za-z0-9_$]+)\(req, res\) \{/g
  let current = null
  let match = pattern.exec(code)
  while (match && match.index < offset) {
    current = match[1]
    match = pattern.exec(code)
  }
  return current
}

/** Every `getTableAction(` call with its balanced argument text. */
function getTableActionCalls(code = CODE) {
  const calls = []
  const needle = 'getTableAction('
  let from = 0
  for (;;) {
    const at = code.indexOf(needle, from)
    if (at < 0) break
    let depth = 0
    let end = at + needle.length - 1
    for (let i = at + needle.length - 1; i < code.length; i += 1) {
      const ch = code[i]
      if (ch === '(') depth += 1
      if (ch === ')') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    const args = code.slice(at + needle.length, end)
    calls.push({ offset: at, handler: handlerAt(at, code), args })
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
// E2e: a key that is PRESENT but explicitly `undefined` is not a projectNo — the overlay would 400 it
// with the switch on, so a route written that way is a broken route the scan must not bless.
const carriesProjectNo = (args) => {
  if (/projectNo:\s*undefined\b/.test(args)) return false
  return /(^|[\s{,])projectNo\b/.test(args)
}

check('C-01 self-check (E2e): the projectNo predicate takes a shorthand or a valued key and rejects an explicit undefined', () => {
  assert.ok(carriesProjectNo('{ actionId, projectNo }'))
  assert.ok(carriesProjectNo("{ actionId, projectNo: firstString(x), targetPurpose: 'write' }"))
  assert.ok(carriesProjectNo('{\n  ...routeScope,\n  actionId,\n  projectNo: job.parameters && job.parameters.projectNo,\n}'))
  assert.ok(!carriesProjectNo('{ actionId, projectNo: undefined }'))
  assert.ok(!carriesProjectNo("{ actionId, projectNo: undefined, targetPurpose: 'write' }"))
  assert.ok(!carriesProjectNo("{ actionId, targetPurpose: 'write' }"))
})

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
  // (The plan route works on the stored snapshot; since R1 it looks the registry up by the job's
  // own projectNo with a 'read' purpose — C-06 — which is a project lookup, not a readiness probe.)
  assert.deepEqual(readinessHandlers, [
    'stockPreparationOperatorProjectDirectory',
    // S2 (R-36): the project-sheet create reads the DEPLOYMENT's own action (env target objectId +
    // declared ext band) to decide which customer packs the new sheet must carry. A 'readiness'
    // purpose is right — it is never overlaid, so it cannot resolve the project sheet it is about
    // to create — and C-09 pins where in the handler it runs.
    'stockPreparationProjectTargetCreate',
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
  // S2: the resolver also receives the looked-up action's declared ext band (server config, from the
  // registry), and hands it to the binding — never anything from the request.
  assert.match(wiring, /resolveProjectTarget: stockPreparationProjectTargets\s*\?\s*async \(\{ tenantId, projectNo, targetPurpose, extensionFieldIds \}\) => resolveProjectTargetForAction\(\{/)
  assert.match(wiring, /\n\s*extensionFieldIds,\n\s*env: process\.env,/, 'the resolver forwards the band it was handed, verbatim')
  assert.match(wiring, /projectId: resolveIntegrationStagingProjectId\(tenantId, undefined\)/)
  assert.ok(!/projectId: resolveIntegrationStagingProjectId\(tenantId, [^u]/.test(wiring), 'never a request projectId')
  assert.match(wiring, /env: process\.env/, 'the switch is read per call, from the live environment')
})

check('C-06 (R1) the three snapshot-driven large-BOM routes refuse a stale job target before any IO on it', () => {
  const ROUTES = {
    tableActionLargeBomExpansionJobPlan: { projectNo: 'job.parameters && job.parameters.projectNo', purpose: 'read', targets: ['action.target'] },
    tableActionLargeBomApplyJobStart: { projectNo: 'expansionJob.parameters && expansionJob.parameters.projectNo', purpose: 'write', targets: ['snapshotAction.target'] },
    tableActionLargeBomApplyJobRun: { projectNo: 'runExpansionJob.parameters && runExpansionJob.parameters.projectNo', purpose: 'write', targets: ['runSnapshotAction.target', 'pendingJob.target'] },
  }
  for (const [handler, spec] of Object.entries(ROUTES)) {
    const start = CODE.indexOf(`    async ${handler}(req, res) {`)
    assert.notEqual(start, -1, `${handler} exists`)
    const body = CODE.slice(start, CODE.indexOf('\n    },', start))
    const lookup = getTableActionCalls(body).find((call) => call.args.includes(`projectNo: ${spec.projectNo}`))
    assert.ok(lookup, `${handler}: looks the registry up by the job's own projectNo`)
    assert.equal(purposeOf(lookup.args), spec.purpose, `${handler}: lookup purpose`)
    for (const target of spec.targets) {
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const at = body.search(new RegExp(`assertLargeBomJobTargetMatchesProjectTarget\\(\\s*${escaped},`))
      assert.notEqual(at, -1, `${handler}: checks ${target} against the registry`)
      // ...before the field probe, the existing-row / foreign-row reads and the write gate.
      for (const io of ['assertTargetFieldsExist(', 'assertTargetSheetHoldsNoForeignActiveRows(', 'readExistingStockPreparationRows(', 'assertStockPrepApplyAllowed(', 'createLargeBomCheckpointApplyJob(', 'runLargeBomCheckpointApplyJobChunk(']) {
        const ioAt = body.indexOf(io)
        if (ioAt !== -1) assert.ok(at < ioAt, `${handler}: the staleness check on ${target} precedes ${io}`)
      }
    }
  }
  // The helper itself: both ids must match, the refusal is a typed 409.
  const helperStart = CODE.indexOf('function assertLargeBomJobTargetMatchesProjectTarget(')
  assert.notEqual(helperStart, -1, 'the helper exists')
  const helper = CODE.slice(helperStart, CODE.indexOf('\n  }\n', helperStart))
  assert.match(helper, /if \(!projectAction \|\| !isPlainObject\(projectAction\.projectTarget\)\) return/, 'a no-op without the overlay marker (switch off stays byte-identical)')
  assert.match(helper, /stored\.objectId === registry\.objectId/)
  assert.match(helper, /stored\.sheetId === registry\.sheetId/)
  assert.match(helper, /if \(objectIdMatches && sheetIdMatches\) return/)
  assert.match(helper, /409,\s*'STOCK_PREPARATION_JOB_TARGET_STALE'/)
})

check('C-07 (R2) the preflight env-binding probe is a readiness lookup, and the lib callers of getTableAction are exactly two', () => {
  const probes = getTableActionCalls(PREFLIGHT_CODE)
  assert.ok(probes.length >= 1, 'the preflight looks the action up')
  for (const probe of probes) {
    assert.equal(purposeOf(probe.args), 'readiness', `preflight lookup must declare readiness: (${probe.args.trim()})`)
    assert.ok(!carriesProjectNo(probe.args), 'the env-binding probe names no project')
  }
  const callers = fs.readdirSync(LIB)
    .filter((name) => name.endsWith('.cjs'))
    .filter((name) => /\.getTableAction\(/.test(stripComments(fs.readFileSync(path.join(LIB, name), 'utf8'))))
    .sort()
  assert.deepEqual(callers, ['http-routes.cjs', 'stock-preparation-preflight.cjs'])
})

check('C-08 (E2b) projectSheetGateFor reads the switch per call and the registry objectId from the resolved target', () => {
  const start = CODE.indexOf('function projectSheetGateFor(action) {')
  assert.notEqual(start, -1, 'the gate-input builder exists')
  const body = CODE.slice(start, CODE.indexOf('\n  }\n', start))
  assert.match(body, /enabled: stockPreparationProjectSheetsEnabled\(process\.env\)/, 'enabled is the live switch, never a literal')
  assert.ok(!/enabled:\s*true/.test(body), 'enabled is not hard-coded')
  assert.match(body, /registeredProjectObjectId: action\.target && typeof action\.target\.objectId === 'string' \? action\.target\.objectId : null/, 'the registry objectId is the RESOLVED target\'s')
  assert.ok(!/registeredProjectObjectId:[^\n]*deploymentTargetObjectId/.test(body), 'never the deployment objectId')
  assert.match(body, /deploymentTargetObjectId: typeof action\.projectTarget\.deploymentTargetObjectId === 'string'/)
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

check('C-09 (S2) the create plans the customer packs before provisioning, installs them before registering, and heals a replay', () => {
  const createStart = CODE.indexOf('    async stockPreparationProjectTargetCreate(req, res) {')
  const body = CODE.slice(createStart, CODE.indexOf('\n    },', createStart))
  const lookupAt = body.indexOf('getTableAction(')
  const planAt = body.indexOf('planProjectSheetCustomerPacks(')
  const provisionAt = body.indexOf('provisionProjectSheet(')
  const installAt = body.indexOf('installPacks(provisioned.objectId)')
  const registerAt = body.indexOf('store.create(')
  const healAt = body.indexOf('installPacks(registered.objectId)')
  assert.ok(lookupAt !== -1 && planAt !== -1 && lookupAt < planAt, 'the env binding is read before the plan')
  assert.ok(provisionAt !== -1 && planAt < provisionAt, 'the plan (reads only, may refuse) precedes provisioning')
  assert.ok(installAt !== -1 && provisionAt < installAt, 'the packs are installed onto the sheet that was just provisioned')
  assert.ok(registerAt !== -1 && installAt < registerAt, 'INSTALL BEFORE REGISTER: a failed install leaves no registered row')
  assert.ok(healAt !== -1 && healAt > registerAt, 'the replay leg heals an already registered sheet through the same install')
  assert.match(body, /getTableAction\(\{\s*actionId: PLM_STOCK_PREPARATION_ACTION_ID,\s*tenantId,\s*targetPurpose: 'readiness',\s*\}\)/, 'the env binding probe is a tenant-scoped readiness lookup')
  assert.match(body, /packCatalog: customerPackCatalog,\s*packInstallStore: stockPreparationPackInstalls,/, 'packs come from the server-held catalog and the install ledger, never the request')
})

if (failed) {
  console.error(`stock-preparation-project-target-call-site-guard.test.cjs FAILED (${failed} of ${passed + failed})`)
  process.exit(1)
}
console.log(`✓ stock-preparation-project-target-call-site-guard (${passed} checks)`)
