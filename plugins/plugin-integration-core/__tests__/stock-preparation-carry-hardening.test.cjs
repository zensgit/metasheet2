'use strict'

// W4 carry wiring — ADVERSARIAL HARDENING battery (findings from the #5434 verification pass).
//
// Three CONFIRMED defects in the first cut of the carry wiring, each reproduced here as a working
// exploit BEFORE its guard, so the guard is witnessed and not asserted:
//
//  A (P1) UNBOUND DECISION↔LEDGER PAIR. The route took `decision`, `decisionId` and
//     `inputFingerprint` as three INDEPENDENT client-supplied fields. applyCarryViaConfirm validated
//     only the decision; confirmCarryConfirmationDecision validated only the named row. Nothing
//     compared the row's stored `rowIdentity` to `decision.idempotencyKey`. So an admin could carry
//     pair B while naming pair C's decision: B gets the human fields, C is never carried, and C's
//     hold is stamped confirmed FOREVER (reconcile leaves CONFIRMED rows with a matching fingerprint
//     alone, and the orphan sweep only closes PENDING rows — C never reopens). The human-approval
//     step was decorative: the write that happened and the hold that closed were two unvalidated
//     inputs. Same lane, second exploit: the carried field set could exceed the ledgered proposal's.
//     A-1..A-5 below.
//
//  B (P3) CROSS-PROJECT CARRY. The anti-forgery check required decision/source/target to agree on
//     `componentSourceId` — precisely so a hand-crafted decision could not reattach across unrelated
//     components — but never compared `projectNo`. Two projects sharing one PLM component (routine in
//     BOM data) satisfied it, so project A's human band could be copied onto project B's row. B-1.
//
//  C (P3) STEP-6 READ-WRITE WINDOW. "A non-blank target cell is NEVER clobbered" was decided from a
//     `targetData` read and enforced by a bare patch with NO optimistic concurrency — the guarantee
//     was only as strong as the window. The platform supports expectedVersion end to end
//     (plugin-scope forwards the whole input; records.ts enforces it in code AND in the SQL
//     predicate). C-1..C-2.
//
// Every guard added for these is itself mutation-covered: disabling it reds a named case here.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  applyCarryViaConfirm,
  StockPreparationConfirmWriteError,
} = require(path.join(LIB, 'stock-preparation-confirm-writes.cjs'))
const {
  OBJECT_ID: LEDGER_OBJECT_ID,
  STATUSES,
  createConfirmationDecisionReconcileLease,
  reconcileConfirmationDecisions,
} = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
  physicalRow,
  logicalData,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const httpRoutes = require(path.join(LIB, 'http-routes.cjs'))
const { createStockPreparationAuditStore } = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))

const CANONICAL_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const STAGING = 'tenant-a:integration-core'
const CANONICAL_SHEET = 'sheet_plm_stock_preparation_main'
const LEDGER_SHEET = 'sheet_confirmation_decisions'
const OPERATOR = 'user_admin_1'
const PROJECT_NO = 'P-9'

// THE BOUND TARGET the deployment's table action names. The carry executor takes this instead of
// resolving the canonical objectId through provisioning — see stock-preparation-carry-target-
// binding.test.cjs for why those are different tables on a default install. Every exploit below is
// therefore now run against a BOUND target, which is the state a real deployment is in.
const CARRY_TARGET = Object.freeze({
  sheetId: CANONICAL_SHEET,
  objectId: CANONICAL_OBJECT_ID,
  fieldIdMap: Object.freeze(Object.fromEntries(
    STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => [field.id, physicalFieldId(STAGING, CANONICAL_OBJECT_ID, field.id)]),
  )),
})
const CARRY_TABLE_ACTION_CONFIG = Object.freeze({
  actionId: PLM_STOCK_PREPARATION_ACTION_ID,
  source: { externalSystemId: 'plm_sql_source', kind: 'data-source:sql-readonly' },
  target: CARRY_TARGET,
})
const CARRY_ROUTE = '/api/integration/stock-preparation/carry/confirm'

const ADMIN = Object.freeze({ id: OPERATOR, roles: ['admin'], tenantId: 'tenant-a' })

let passed = 0
let failed = 0
const failures = []

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1 })
    .catch((error) => {
      failed += 1
      failures.push(name)
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

function keyFor(projectNo, componentSourceId, pathTokens) {
  return JSON.stringify({ projectNo, componentSourceId, parentSourceId: null, path: pathTokens })
}

// ── two INDEPENDENT re-keyed pairs, exactly as a real re-import produces them ────────────────────
const B_OLD = keyFor(PROJECT_NO, 'COMP-B', ['OLD', 'COMP-B'])
const B_NEW = keyFor(PROJECT_NO, 'COMP-B', ['NEW', 'COMP-B'])
const C_OLD = keyFor(PROJECT_NO, 'COMP-C', ['OLD', 'COMP-C'])
const C_NEW = keyFor(PROJECT_NO, 'COMP-C', ['NEW', 'COMP-C'])
const B_NOTE = 'B ordered 2026-08-01'
const B_REPLY = 'B supplier confirmed'
const C_NOTE = 'C ordered 2026-08-02'

function canonicalRow(logical, id) {
  const row = physicalRow(STAGING, CANONICAL_OBJECT_ID, logical, id)
  row.sheetId = CANONICAL_SHEET
  return row
}

function pairRows() {
  return [
    canonicalRow({
      projectNo: PROJECT_NO, idempotencyKey: B_OLD, componentSourceId: 'COMP-B',
      path: JSON.stringify(['OLD', 'COMP-B']), totalQuantity: 2, active: false,
      notes: B_NOTE, procurementReply: B_REPLY,
    }, 'row_b_old'),
    canonicalRow({
      projectNo: PROJECT_NO, idempotencyKey: B_NEW, componentSourceId: 'COMP-B',
      path: JSON.stringify(['NEW', 'COMP-B']), totalQuantity: 2, active: true,
    }, 'row_b_new'),
    canonicalRow({
      projectNo: PROJECT_NO, idempotencyKey: C_OLD, componentSourceId: 'COMP-C',
      path: JSON.stringify(['OLD', 'COMP-C']), totalQuantity: 1, active: false,
      notes: C_NOTE,
    }, 'row_c_old'),
    canonicalRow({
      projectNo: PROJECT_NO, idempotencyKey: C_NEW, componentSourceId: 'COMP-C',
      path: JSON.stringify(['NEW', 'COMP-C']), totalQuantity: 1, active: true,
    }, 'row_c_new'),
  ]
}

function carryDecision({ idempotencyKey, sourceIdempotencyKey, componentSourceId, carryFields }) {
  return {
    decision: 'carry_via_confirm',
    idempotencyKey,
    sourceIdempotencyKey,
    componentSourceId,
    carryKey: 'component_source_id',
    manualRowReattach: 'propose_confirm',
    carryFields,
    writeVia: 'k2_confirm',
    requiresConfirm: true,
    carry: true,
  }
}

const B_DECISION = carryDecision({ idempotencyKey: B_NEW, sourceIdempotencyKey: B_OLD, componentSourceId: 'COMP-B', carryFields: ['notes'] })
const C_DECISION = carryDecision({ idempotencyKey: C_NEW, sourceIdempotencyKey: C_OLD, componentSourceId: 'COMP-C', carryFields: ['notes'] })

// The planner's carry proposal hold, verbatim in shape (see conflict-planner emitCarryOutcome).
function carryProposalHold(decision) {
  return {
    decision: 'manual_confirm',
    idempotencyKey: decision.idempotencyKey,
    conflictSummary: { type: 'carry_reattach_requires_confirm', proposed: true },
    changedFields: [],
    source: 'carry_policy',
    carryProposal: decision,
  }
}

function inertService(methods) {
  const out = {}
  for (const method of methods) out[method] = async () => { throw new Error(`unexpected ${method}`) }
  return out
}

function createFakeAuditDb() {
  const rows = []
  return {
    rows,
    async insertOne(table, row) {
      rows.push({ __table: table, ...JSON.parse(JSON.stringify(row)) })
      return [row]
    },
    async select(table) { return rows.filter((row) => row.__table === table) },
  }
}

function makeFakeLeaseDb() {
  const rows = new Map()
  return {
    async insertOne(table, row) {
      if (rows.has(row.scope_key)) { const e = new Error('duplicate key'); e.code = '23505'; throw e }
      rows.set(row.scope_key, { ...row })
      return [{ ...row }]
    },
    async selectOne(table, where) { const row = rows.get(where.scope_key); return row ? { ...row } : null },
    async updateRow(table, set, where) {
      const row = rows.get(where.scope_key)
      if (!row || row.lease_id !== where.lease_id) return []
      Object.assign(row, set); return [{ ...row }]
    },
    async deleteRows(table, where) {
      const row = rows.get(where.scope_key)
      if (!row || row.lease_id !== where.lease_id) return []
      rows.delete(where.scope_key); return [{ ...row }]
    },
  }
}

// Mount the REAL routes over ONE substrate shared with the reconcile call, so the ledger row the
// exploit names is a GENUINE reconcile artifact (correct decisionId + inputFingerprint), never a
// hand-made row that a guard could reject for the wrong reason.
function mount({ canonicalRows = pairRows(), recordsWrapper } = {}) {
  const routes = new Map()
  const auditDb = createFakeAuditDb()
  const auditStore = createStockPreparationAuditStore({ db: auditDb, idGenerator: () => `audit_${auditDb.rows.length + 1}` })
  const provisioning = makeFakeProvisioning({
    stagingProjectId: STAGING,
    sheetIdByObjectId: { [CANONICAL_OBJECT_ID]: CANONICAL_SHEET, [LEDGER_OBJECT_ID]: LEDGER_SHEET },
  })
  const baseRecords = makeStrictRecordsApi({
    stagingProjectId: STAGING,
    objectIdBySheetId: { [CANONICAL_SHEET]: CANONICAL_OBJECT_ID, [LEDGER_SHEET]: LEDGER_OBJECT_ID },
    rowsBySheet: { [CANONICAL_SHEET]: canonicalRows, [LEDGER_SHEET]: [] },
  })
  const records = recordsWrapper ? recordsWrapper(baseRecords) : baseRecords
  const context = {
    api: {
      http: { addRoute(method, routePath, handler) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } },
      multitable: { provisioning, records },
    },
    storage: new Map(),
    // The deploy-time table action the carry route reads its target off.
    config: { stockPreparationTableActions: [CARRY_TABLE_ACTION_CONFIG] },
  }
  const services = {
    externalSystemRegistry: {
      ...inertService(['upsertExternalSystem', 'deleteExternalSystem']),
      async getExternalSystem() { return null },
      async getExternalSystemForAdapter() { return null },
      async listExternalSystems() { return [] },
    },
    adapterRegistry: { listAdapterKinds() { return [] }, createAdapter() { throw new Error('unexpected adapter') } },
    pipelineRegistry: { ...inertService(['upsertPipeline', 'getPipeline', 'listPipelineRuns']), async listPipelines() { return [] } },
    pipelineRunner: inertService(['runPipeline']),
    deadLetterStore: inertService(['listDeadLetters']),
    stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
    templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
    readSourceConfigStore: { ...inertService(['saveVersion', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']), async list() { return [] } },
    readSourceCompositionConfigStore: { ...inertService(['saveVersion', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']), async list() { return [] } },
    bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    stockPreparationAuditStore: auditStore,
    // The host capability the carry route's tenant wall requires (#5445): the plugin submits two
    // identity strings and receives one boolean. These suites drive the route as the deployment's own
    // tenant, so the pairing is vouched for and the wall is transparent to them — the wall itself is
    // witnessed in stock-preparation-carry-target-binding.test.cjs (T9-*).
    tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
  }
  httpRoutes.registerIntegrationRoutes({ context, services, logger: { info() {}, warn() {}, error() {} } })
  return { routes, auditDb, provisioning, records, baseRecords }
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
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  return res
}

function canonicalData(mounted) {
  return mounted.baseRecords.rows(CANONICAL_SHEET).map((row) => logicalData(STAGING, CANONICAL_OBJECT_ID, row.data))
}

function ledgerData(mounted) {
  return mounted.baseRecords.rows(LEDGER_SHEET).map((row) => logicalData(STAGING, LEDGER_OBJECT_ID, row.data))
}

function rowByKey(mounted, key) {
  return canonicalData(mounted).find((data) => data.idempotencyKey === key)
}

// Produce a GENUINE pending ledger row by running the real reconcile over a plan holding `holds`.
async function seedLedger(mounted, holds) {
  await reconcileConfirmationDecisions({
    recordsApi: mounted.records,
    provisioning: mounted.provisioning,
    targetProjectId: STAGING,
    permission: 'admin',
    reconcileLease: createConfirmationDecisionReconcileLease({ db: makeFakeLeaseDb() }),
    projectNo: PROJECT_NO,
    plan: { decisions: holds },
    sourceRevision: 'rev-hardening-1',
  })
  return ledgerData(mounted)
}

async function main() {
  // =========================================================================
  // FIX A — the P1: the decision and the ledger row must be ONE bound pair.
  // =========================================================================

  await run('A-1 EXPLOIT: carrying pair B while naming pair C\'s decision is REFUSED — B unwritten, C still pending', async () => {
    const mounted = mount()
    const ledger = await seedLedger(mounted, [carryProposalHold(C_DECISION)])
    assert.equal(ledger.length, 1, 'exactly one pending carry row (C)')
    assert.equal(ledger[0].rowIdentity, C_NEW)
    assert.equal(ledger[0].status, STATUSES.PENDING)

    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: {
        decision: B_DECISION,                          // ← carries B
        decisionId: ledger[0].decisionId,              // ← but names C's hold
        inputFingerprint: ledger[0].inputFingerprint,
      },
    })

    assert.equal(res.statusCode, 409, `expected a refusal, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.ok, false)
    assert.equal(res.body.error.code, 'CONFIRMATION_DECISION_CARRY_ROW_IDENTITY_MISMATCH')

    // The write must not have happened AT ALL — a refusal after the carry would leave B carried
    // with no approval record, which is the same defect wearing a different mask.
    assert.equal(rowByKey(mounted, B_NEW).notes, undefined, 'row B must NOT be carried')
    assert.equal(mounted.baseRecords.patchCalls.length, 0, 'zero patches: refused BEFORE the canonical write')

    // C's hold must still be open — a wrongly-confirmed C never reopens (reconcile leaves CONFIRMED
    // fingerprint-matching rows alone; the orphan sweep only closes PENDING).
    const after = ledgerData(mounted)
    assert.equal(after[0].status, STATUSES.PENDING, 'C stays pending')
    assert.equal(after[0].resolutionAction, undefined, 'C is not stamped')
  })

  await run('A-2 EXPLOIT: widening carryFields beyond the ledgered proposal is REFUSED (fingerprint recompute)', async () => {
    const mounted = mount()
    // The LEDGERED proposal carries ONLY `notes` (that is what the planner proposed and the human saw).
    const ledger = await seedLedger(mounted, [carryProposalHold(B_DECISION)])
    assert.equal(ledger[0].rowIdentity, B_NEW)

    const widened = carryDecision({
      idempotencyKey: B_NEW, sourceIdempotencyKey: B_OLD, componentSourceId: 'COMP-B',
      carryFields: ['notes', 'procurementReply'],      // ← more than was approved
    })
    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: { decision: widened, decisionId: ledger[0].decisionId, inputFingerprint: ledger[0].inputFingerprint },
    })

    assert.equal(res.statusCode, 409, `expected a refusal, got ${res.statusCode}: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.error.code, 'CONFIRMATION_DECISION_CARRY_PROPOSAL_MISMATCH')
    assert.equal(rowByKey(mounted, B_NEW).notes, undefined, 'nothing carried')
    assert.equal(rowByKey(mounted, B_NEW).procurementReply, undefined)
    assert.equal(mounted.baseRecords.patchCalls.length, 0)
    assert.equal(ledgerData(mounted)[0].status, STATUSES.PENDING)
  })

  await run('A-3 EXPLOIT: swapping the SOURCE row under an approved target is REFUSED', async () => {
    const mounted = mount()
    const ledger = await seedLedger(mounted, [carryProposalHold(B_DECISION)])
    // Same approved target (B_NEW) but a different source than the one the human approved.
    const swapped = carryDecision({
      idempotencyKey: B_NEW, sourceIdempotencyKey: C_OLD, componentSourceId: 'COMP-B', carryFields: ['notes'],
    })
    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: { decision: swapped, decisionId: ledger[0].decisionId, inputFingerprint: ledger[0].inputFingerprint },
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.body.error.code, 'CONFIRMATION_DECISION_CARRY_PROPOSAL_MISMATCH')
    assert.equal(mounted.baseRecords.patchCalls.length, 0)
    assert.equal(ledgerData(mounted)[0].status, STATUSES.PENDING)
  })

  await run('A-4 the MATCHING pair still works end to end (the guard refuses forgery, not the feature)', async () => {
    const mounted = mount()
    const ledger = await seedLedger(mounted, [carryProposalHold(B_DECISION)])
    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: { decision: B_DECISION, decisionId: ledger[0].decisionId, inputFingerprint: ledger[0].inputFingerprint },
    })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.equal(res.body.data.mode, 'carried')
    assert.equal(res.body.data.ledger.status, STATUSES.CONFIRMED)
    assert.equal(rowByKey(mounted, B_NEW).notes, B_NOTE, 'the approved carry landed')
    // Only the approved field crossed; the unapproved one did not ride along.
    assert.equal(rowByKey(mounted, B_NEW).procurementReply, undefined)
    assert.equal(ledgerData(mounted)[0].resolutionAction, 'carry_via_confirm')
  })

  await run('A-5 a NON-proposal carry type (ambiguous hold) cannot be closed by the carry route', async () => {
    const mounted = mount()
    const ambiguous = {
      decision: 'manual_confirm',
      idempotencyKey: B_NEW,
      componentSourceId: 'COMP-B',
      carryKey: 'component_source_id',
      manualRowReattach: 'propose_confirm',
      conflictSummary: { type: 'carry_ambiguous_component_source', matchCount: 2 },
      source: 'carry_policy',
      carry: false,
    }
    const ledger = await seedLedger(mounted, [ambiguous])
    assert.equal(ledger[0].conflictType, 'carry_ambiguous_component_source')
    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: { decision: B_DECISION, decisionId: ledger[0].decisionId, inputFingerprint: ledger[0].inputFingerprint },
    })
    assert.equal(res.statusCode, 409)
    assert.equal(res.body.error.code, 'CONFIRMATION_DECISION_CARRY_PROPOSAL_REQUIRED')
    assert.equal(mounted.baseRecords.patchCalls.length, 0)
    assert.equal(ledgerData(mounted)[0].status, STATUSES.PENDING, 'an ambiguity hold is not resolvable this way')
  })

  // =========================================================================
  // FIX B — cross-project carry on a shared component.
  // =========================================================================

  await run('B-1 EXPLOIT: carrying across two PROJECTS that share one PLM component is REFUSED', async () => {
    const P1 = 'P-ALPHA'
    const P2 = 'P-BETA'
    const sharedComponent = 'COMP-SHARED'
    const p1Old = keyFor(P1, sharedComponent, ['OLD', sharedComponent])
    const p2New = keyFor(P2, sharedComponent, ['NEW', sharedComponent])
    const provisioning = makeFakeProvisioning({
      stagingProjectId: STAGING,
      sheetIdByObjectId: { [CANONICAL_OBJECT_ID]: CANONICAL_SHEET, [LEDGER_OBJECT_ID]: LEDGER_SHEET },
    })
    const records = makeStrictRecordsApi({
      stagingProjectId: STAGING,
      objectIdBySheetId: { [CANONICAL_SHEET]: CANONICAL_OBJECT_ID, [LEDGER_SHEET]: LEDGER_OBJECT_ID },
      rowsBySheet: {
        [CANONICAL_SHEET]: [
          canonicalRow({
            projectNo: P1, idempotencyKey: p1Old, componentSourceId: sharedComponent,
            path: JSON.stringify(['OLD', sharedComponent]), totalQuantity: 1, active: false,
            notes: 'ALPHA private procurement note',
          }, 'row_p1_old'),
          canonicalRow({
            projectNo: P2, idempotencyKey: p2New, componentSourceId: sharedComponent,
            path: JSON.stringify(['NEW', sharedComponent]), totalQuantity: 1, active: true,
          }, 'row_p2_new'),
        ],
        [LEDGER_SHEET]: [],
      },
    })

    let caught = null
    try {
      await applyCarryViaConfirm({
        permission: 'admin',
        recordsApi: records,
        provisioning,
        targetProjectId: STAGING,
        target: CARRY_TARGET,
        decision: carryDecision({
          idempotencyKey: p2New, sourceIdempotencyKey: p1Old,
          componentSourceId: sharedComponent, carryFields: ['notes'],
        }),
        confirmedBy: OPERATOR,
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof StockPreparationConfirmWriteError,
      `expected a refusal, got ${caught && caught.name}: ${caught && caught.message}`)
    assert.equal(caught.status, 409)
    assert.equal(caught.code, 'CONFIRM_CARRY_PROJECT_MISMATCH')
    assert.equal(records.patchCalls.length, 0, 'no cross-project write')
    // Values-free: the other project's note must not ride the error out.
    assert.equal(JSON.stringify(caught.details || {}).includes('ALPHA private'), false)
  })

  // The project scope has TWO legs (the stored rows, and the projectNo embedded in each key). They
  // are redundant on the headline exploit above — each catches it — so neither is witnessed by it
  // alone. These two cases isolate them: remove either leg and exactly one of them reds.
  await run('B-1a ROW-leg isolated: opaque keys that embed no project still cannot cross projects', async () => {
    const sharedComponent = 'COMP-OPAQUE'
    // Legacy/opaque keys: not the JSON shape, so the key-parse leg cannot fire at all.
    const sourceKey = 'legacy-key-source-1'
    const targetKey = 'legacy-key-target-1'
    const provisioning = makeFakeProvisioning({
      stagingProjectId: STAGING,
      sheetIdByObjectId: { [CANONICAL_OBJECT_ID]: CANONICAL_SHEET, [LEDGER_OBJECT_ID]: LEDGER_SHEET },
    })
    const records = makeStrictRecordsApi({
      stagingProjectId: STAGING,
      objectIdBySheetId: { [CANONICAL_SHEET]: CANONICAL_OBJECT_ID, [LEDGER_SHEET]: LEDGER_OBJECT_ID },
      rowsBySheet: {
        [CANONICAL_SHEET]: [
          canonicalRow({
            projectNo: 'P-ALPHA', idempotencyKey: sourceKey, componentSourceId: sharedComponent,
            path: 'OLD', totalQuantity: 1, active: false, notes: 'ALPHA note',
          }, 'row_opaque_old'),
          canonicalRow({
            projectNo: 'P-BETA', idempotencyKey: targetKey, componentSourceId: sharedComponent,
            path: 'NEW', totalQuantity: 1, active: true,
          }, 'row_opaque_new'),
        ],
        [LEDGER_SHEET]: [],
      },
    })
    let caught = null
    try {
      await applyCarryViaConfirm({
        permission: 'admin', recordsApi: records, provisioning, targetProjectId: STAGING, target: CARRY_TARGET,
        decision: carryDecision({
          idempotencyKey: targetKey, sourceIdempotencyKey: sourceKey,
          componentSourceId: sharedComponent, carryFields: ['notes'],
        }),
        confirmedBy: OPERATOR,
      })
    } catch (error) { caught = error }
    assert.ok(caught instanceof StockPreparationConfirmWriteError, `expected a refusal, got ${caught && caught.name}`)
    assert.equal(caught.code, 'CONFIRM_CARRY_PROJECT_MISMATCH')
    assert.equal(caught.details.field, 'projectNo', 'the ROW leg is what refused here')
    assert.equal(records.patchCalls.length, 0)
  })

  await run('B-1b KEY-leg isolated: a forged key naming another project is refused even when both rows agree', async () => {
    const sharedComponent = 'COMP-FORGE'
    // Both stored rows are in ONE project (so the row leg passes), but the decision's SOURCE key
    // claims a different project — a forged key that the row check alone would wave through.
    const honestTarget = keyFor('P-ALPHA', sharedComponent, ['NEW', sharedComponent])
    const forgedSource = keyFor('P-BETA', sharedComponent, ['OLD', sharedComponent])
    const provisioning = makeFakeProvisioning({
      stagingProjectId: STAGING,
      sheetIdByObjectId: { [CANONICAL_OBJECT_ID]: CANONICAL_SHEET, [LEDGER_OBJECT_ID]: LEDGER_SHEET },
    })
    const records = makeStrictRecordsApi({
      stagingProjectId: STAGING,
      objectIdBySheetId: { [CANONICAL_SHEET]: CANONICAL_OBJECT_ID, [LEDGER_SHEET]: LEDGER_OBJECT_ID },
      rowsBySheet: {
        [CANONICAL_SHEET]: [
          canonicalRow({
            projectNo: 'P-ALPHA', idempotencyKey: forgedSource, componentSourceId: sharedComponent,
            path: JSON.stringify(['OLD', sharedComponent]), totalQuantity: 1, active: false, notes: 'note',
          }, 'row_forge_old'),
          canonicalRow({
            projectNo: 'P-ALPHA', idempotencyKey: honestTarget, componentSourceId: sharedComponent,
            path: JSON.stringify(['NEW', sharedComponent]), totalQuantity: 1, active: true,
          }, 'row_forge_new'),
        ],
        [LEDGER_SHEET]: [],
      },
    })
    let caught = null
    try {
      await applyCarryViaConfirm({
        permission: 'admin', recordsApi: records, provisioning, targetProjectId: STAGING, target: CARRY_TARGET,
        decision: carryDecision({
          idempotencyKey: honestTarget, sourceIdempotencyKey: forgedSource,
          componentSourceId: sharedComponent, carryFields: ['notes'],
        }),
        confirmedBy: OPERATOR,
      })
    } catch (error) { caught = error }
    assert.ok(caught instanceof StockPreparationConfirmWriteError, `expected a refusal, got ${caught && caught.name}`)
    assert.equal(caught.code, 'CONFIRM_CARRY_PROJECT_MISMATCH')
    assert.equal(caught.details.field, 'sourceIdempotencyKey', 'the KEY leg is what refused here')
    assert.equal(records.patchCalls.length, 0)
  })

  await run('B-2 same-project carry on the same component still works (the guard is scope, not a block)', async () => {
    const mounted = mount()
    const result = await applyCarryViaConfirm({
      permission: 'admin',
      recordsApi: mounted.records,
      provisioning: mounted.provisioning,
      targetProjectId: STAGING,
      target: CARRY_TARGET,
      decision: B_DECISION,
      confirmedBy: OPERATOR,
    })
    assert.equal(result.mode, 'carried')
    assert.equal(rowByKey(mounted, B_NEW).notes, B_NOTE)
  })

  // =========================================================================
  // FIX C — the step-6 read-write window.
  // =========================================================================

  await run('C-1 EXPLOIT: a concurrent human edit inside the read-write window is REFUSED, not clobbered', async () => {
    // A concurrent writer sets `notes` on the target AFTER this call has read it blank and decided
    // to carry. Without optimistic concurrency the patch lands and the human edit is silently lost —
    // exactly what step 6 promises can never happen.
    let armed = true
    const mounted = mount({
      recordsWrapper(base) {
        return {
          ...base,
          rows: base.rows.bind(base),
          get patchCalls() { return base.patchCalls },
          async queryRecords(input) {
            const rows = await base.queryRecords(input)
            // Fire once, right after the TARGET row has been read and handed back.
            const isTargetRead = rows.some((row) => logicalData(STAGING, CANONICAL_OBJECT_ID, row.data).idempotencyKey === B_NEW)
            if (armed && isTargetRead) {
              armed = false
              const stored = base.store.get(CANONICAL_SHEET).find((row) => row.id === 'row_b_new')
              stored.data[physicalNotesKey()] = 'the human typed this meanwhile'
              stored.version += 1
            }
            return rows
          },
          async createRecord(input) { return base.createRecord(input) },
          async patchRecord(input) { return base.patchRecord(input) },
        }
      },
    })

    let caught = null
    try {
      await applyCarryViaConfirm({
        permission: 'admin',
        recordsApi: mounted.records,
        provisioning: mounted.provisioning,
        targetProjectId: STAGING,
        target: CARRY_TARGET,
        decision: B_DECISION,
        confirmedBy: OPERATOR,
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof StockPreparationConfirmWriteError,
      `expected a version-conflict refusal, got ${caught && caught.name}: ${caught && caught.message}`)
    assert.equal(caught.status, 409)
    assert.equal(caught.code, 'CONFIRM_CARRY_TARGET_VERSION_CONFLICT')
    assert.equal(rowByKey(mounted, B_NEW).notes, 'the human typed this meanwhile', 'the human edit stands')
  })

  await run('C-2 the patch carries expectedVersion (optimistic concurrency is actually requested)', async () => {
    const mounted = mount()
    await applyCarryViaConfirm({
      permission: 'admin',
      recordsApi: mounted.records,
      provisioning: mounted.provisioning,
      targetProjectId: STAGING,
      target: CARRY_TARGET,
      decision: B_DECISION,
      confirmedBy: OPERATOR,
    })
    assert.equal(mounted.baseRecords.patchCalls.length, 1)
    const patch = mounted.baseRecords.patchCalls[0]
    assert.equal(typeof patch.expectedVersion, 'number', 'the carry patch must request optimistic concurrency')
    assert.equal(patch.expectedVersion, 1, 'and it must be the version the decision was made against')
  })

  // =========================================================================
  // END TO END over the REAL planner output — the one case that proves the two halves of the
  // fingerprint recipe agree.
  //
  // Every other case here builds the hold from a local fixture, so a DRIFT between what the planner
  // emits and what the verifier recomputes would be invisible to them: the ledger would derive from
  // the planner's summary and the confirm would recompute from the frozen constant, and every real
  // carry confirm would fail in production while the suite stayed green. This drives the actual
  // planner, reconciles ITS hold, and confirms through the route.
  // =========================================================================
  await run('E2E: a hold emitted by the REAL planner reconciles and confirms through the route (recipe agreement)', async () => {
    const { planStockPreparationConflicts } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
    const mounted = mount()

    // The genuine plan: COMP-B re-keyed, its predecessor inactive and carrying human work.
    const expandedRow = {
      projectNo: PROJECT_NO,
      idempotencyKey: B_NEW,
      componentSourceId: 'COMP-B',
      parentSourceId: null,
      path: JSON.stringify(['NEW', 'COMP-B']),
      depth: 1,
      totalQuantity: 2,
      active: true,
    }
    const existingRow = {
      projectNo: PROJECT_NO,
      idempotencyKey: B_OLD,
      componentSourceId: 'COMP-B',
      parentSourceId: null,
      path: JSON.stringify(['OLD', 'COMP-B']),
      depth: 1,
      totalQuantity: 2,
      active: false,
      notes: B_NOTE,
    }
    const plan = planStockPreparationConflicts({
      expandedRows: [expandedRow],
      existingRows: [existingRow],
      runId: 'e2e-run',
      plannedAt: '2026-09-02T00:00:00.000Z',
      carryPolicy: { carryKey: 'component_source_id' },
    })
    const plannerHold = plan.decisions.find((decision) =>
      decision.conflictSummary && decision.conflictSummary.type === 'carry_reattach_requires_confirm')
    assert.ok(plannerHold, 'the real planner emitted a carry proposal hold')

    // Ledger it through the real reconcile — the fingerprint is derived from the PLANNER's summary.
    const ledger = await seedLedger(mounted, [plannerHold])
    assert.equal(ledger.length, 1)

    // Confirm through the route with the PLANNER's own proposal — the verifier recomputes the
    // fingerprint from the frozen constant, so this passes ONLY if the two agree byte for byte.
    const res = await call(mounted.routes, 'POST', CARRY_ROUTE, {
      user: ADMIN,
      body: {
        decision: plannerHold.carryProposal,
        decisionId: ledger[0].decisionId,
        inputFingerprint: ledger[0].inputFingerprint,
      },
    })
    assert.equal(res.statusCode, 200, `the planner's own proposal must be confirmable: ${JSON.stringify(res.body)}`)
    assert.equal(res.body.data.mode, 'carried')
    assert.equal(res.body.data.ledger.status, STATUSES.CONFIRMED)
    assert.equal(rowByKey(mounted, B_NEW).notes, B_NOTE, 'the human work followed the re-keyed row')
    assert.equal(ledgerData(mounted)[0].resolutionAction, 'carry_via_confirm')
  })

  console.log(`carry-hardening: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error(`failures: ${failures.join(', ')}`)
    process.exit(1)
  }
}

// The physical field id for `notes` on the canonical object (the fake stores physical keys).
function physicalNotesKey() {
  const probe = physicalRow(STAGING, CANONICAL_OBJECT_ID, { notes: 'x' })
  return Object.keys(probe.data)[0]
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
