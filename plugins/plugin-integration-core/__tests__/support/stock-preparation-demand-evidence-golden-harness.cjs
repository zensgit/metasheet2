'use strict'

// Batch-refresh step 2a — THE GOLDEN HARNESS.
//
// Drives every hash and identity the stock-preparation pull mints off an expansion — the small
// dry-run revision, its token subset and evidence, the source-content revision and digest, the
// ledger's input revision and the three ledger families' identities, the archive revision and the
// snapshot_/sync_ ids derived from it, the batch identity in both modes, the snapshot lines, the
// large-BOM artifact / plan / target revisions and the public job projection, and the apply
// response — over SYNTHETIC in-memory sources, and reduces each to a digest.
//
// `__tests__/stock-preparation-demand-evidence-golden.test.cjs` pins those digests as literals that
// were captured on origin/main BEFORE demand-evidence capture existed, and replays them with the
// expander's capture switched OFF and ON. A digest that moves under ON means some hash reads the
// expansion object as a whole (or the evidence leaked into rows / summary / evidence) — exactly the
// regression batch-refresh plan §12.2 item 2 forbids.
//
// The capture switch was written and the GOLDEN literals captured on origin/main fae8946d1, where
// `demandEvidence` was an input the expander ignored; the throwing leg was added with the recorder.
// Review round 1 made the large lane route-shaped (normalized snapshot + the run route's options);
// its `large.*` literals were recaptured by running this harness over fae8946d1's lib — see the
// golden test header.
//
// HOW "ON" IS REACHED WITHOUT WIRING ANY CALLER. The table-action and large-BOM modules destructure
// `expandPlmProjectBom` at require time. This harness replaces that export on the expander module
// BEFORE either consumer is first required, with a pass-through that — only in the ON modes — adds
// `demandEvidence` to the expander input. No production module is edited and nothing lands on disk.
// `assertConsumersNotYetLoaded` refuses to install the switch over consumers that already captured
// the original function (the switch would then be silently inert and every ON leg would pass for
// the wrong reason); `calls` lets the suite prove the switch actually carried every expansion.
//
// VALUES-FREE: every project number, part id and drawing number below is synthetic and invented for
// this file.

const crypto = require('node:crypto')
const path = require('node:path')

const LIB = path.join(__dirname, '..', '..', 'lib')
const EXPANSION_PATH = require.resolve(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))
const CONSUMER_PATHS = Object.freeze([
  require.resolve(path.join(LIB, 'stock-preparation-table-actions.cjs')),
  require.resolve(path.join(LIB, 'stock-preparation-large-bom-jobs.cjs')),
])

const DEMAND_EVIDENCE_PATH = require.resolve(path.join(LIB, 'stock-preparation-demand-evidence.cjs'))

// off       no `demandEvidence` on the expander input — the walk every caller runs today.
// on        `demandEvidence: true` — the recorder runs and the expansion carries its result.
// throwing  as `on`, but the raw recorder throws from every hook and from finalize (the seam is the
//           demand-evidence module's own `createDemandEvidenceRecorder` export). The walk must not
//           notice; the evidence must say `capture_error`.
const MODES = Object.freeze(['off', 'on', 'throwing'])

function throwingRecorderFactory() {
  return new Proxy({}, {
    get() {
      return () => {
        throw new Error('golden harness: injected recorder fault')
      }
    },
  })
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function assertConsumersNotYetLoaded() {
  for (const consumer of CONSUMER_PATHS) {
    if (require.cache[consumer]) {
      throw new Error(`golden harness: ${path.basename(consumer)} was required before the capture switch was installed`)
    }
  }
}

function installExpansionCaptureSwitch() {
  assertConsumersNotYetLoaded()
  const expansionModule = require(EXPANSION_PATH)
  const original = expansionModule.expandPlmProjectBom
  const state = { mode: 'off', calls: [], options: undefined }
  expansionModule.expandPlmProjectBom = async function expandPlmProjectBomUnderGoldenSwitch(input) {
    const effective = state.mode === 'off' ? input : { ...input, demandEvidence: state.options === undefined ? true : state.options }
    const result = await original(effective)
    state.calls.push({ mode: state.mode, input: effective, result })
    return result
  }
  const tableActions = require(CONSUMER_PATHS[0])
  const largeBomJobs = require(CONSUMER_PATHS[1])
  const demandEvidenceModule = require(DEMAND_EVIDENCE_PATH)
  const realRecorderFactory = demandEvidenceModule.createDemandEvidenceRecorder
  return {
    expansionModule,
    demandEvidenceModule,
    tableActions,
    largeBomJobs,
    original,
    setMode(mode, options) {
      if (!MODES.includes(mode)) throw new Error(`golden harness: unknown mode ${mode}`)
      state.mode = mode
      state.options = options
      state.calls = []
      demandEvidenceModule.createDemandEvidenceRecorder = mode === 'throwing' ? throwingRecorderFactory : realRecorderFactory
    },
    get calls() {
      return state.calls
    },
  }
}

// ── synthetic source ──────────────────────────────────────────────────────────────────────────

function createSourceAdapter(data, { failObjects = [] } = {}) {
  return {
    async read(input = {}) {
      if (failObjects.includes(input.object)) {
        const error = new Error('synthetic source read failure')
        error.code = 'SYNTHETIC_READ_FAILURE'
        throw error
      }
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      const matches = rows.filter((row) =>
        Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
      const offset = input.cursor ? Number(input.cursor) : 0
      const limit = input.limit || 1000
      const records = matches.slice(offset, offset + limit).map(clone)
      return {
        records,
        done: offset + records.length >= matches.length,
        nextCursor: offset + records.length < matches.length ? String(offset + records.length) : null,
      }
    },
  }
}

function createMemoryStorage({ durable = false } = {}) {
  const map = new Map()
  return {
    durable,
    map,
    async get(key) { return map.has(key) ? clone(map.get(key)) : null },
    async set(key, value) { map.set(key, clone(value)) },
    async delete(key) { map.delete(key) },
  }
}

function createRecordsApi(existing = []) {
  const rows = existing.map((entry, index) => ({
    id: entry.id || `rec_${index + 1}`,
    sheetId: entry.sheetId || 'sheet_sde_golden',
    version: 1,
    data: { ...(entry.data || entry) },
  }))
  return {
    rows,
    async queryRecords(input = {}) {
      return rows
        .filter((record) => record.sheetId === input.sheetId)
        .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
        .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
        .map(clone)
    },
    async createRecord(input = {}) {
      const record = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
      rows.push(record)
      return clone(record)
    },
    async patchRecord(input = {}) {
      const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
      if (!record) throw new Error('golden harness: record not found')
      record.version += 1
      record.data = { ...record.data, ...(input.changes || {}) }
      return clone(record)
    },
  }
}

const ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const TENANT_ID = 'tenant_sde_golden'
const WORKSPACE_ID = 'workspace_sde_golden'
const PLANNED_AT = '2026-10-22T01:00:00.000Z'
const RUN_ID = 'run_sde_golden'
const FIXED_NOW = Date.parse('2026-10-22T02:00:00.000Z')
const SANDBOX_POLICY = Object.freeze({ enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] })

function baseAction(overrides = {}) {
  return {
    actionId: ACTION_ID,
    source: { externalSystemId: 'plm_sde_golden', kind: 'data-source:sql-readonly', ...(overrides.source || {}) },
    target: { sheetId: 'sheet_sde_golden', objectId: 'stockPreparationMain' },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'source')),
  }
}

function part(id, code, name, version, extra = {}) {
  return { OBJ_ID: id, IdentityNo: code, IdentityName: name, Material: 'SDE-STEEL', SysVer: version, ...extra }
}

function orderModule(projectNo, lines) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: `${projectNo}-PATH` }],
    DN_PDM_PathInfo: [{ OBJ_ID: `${projectNo}-PATH` }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: `${projectNo}-ORDER-1`, path_id: `${projectNo}-PATH` }],
    DN_PDM_OrderDetailInfo: lines.map((line, index) => ({
      order_id: `${projectNo}-ORDER-1`,
      sort_id: String((index + 1) * 10),
      ...line,
    })),
  }
}

// ── the seven golden scenarios (+ the carry family) ───────────────────────────────────────────
//
// Every scenario names what it exercises. Codes follow the default 根选择 rules (总图 `J…-00`,
// 钣金 `J…-A`/`-B`, dash hierarchy by segment) so each scenario hits a different rule branch.

function dashScenario() {
  const projectNo = 'SDE-GOLD-DASH'
  return {
    name: 'dash_drop',
    projectNo,
    data: {
      ...orderModule(projectNo, [
        { part_id: 'SDE-P1', quantity: '2' },
        { part_id: 'SDE-S1', quantity: '4' },
      ]),
      DN_PDM_PartLibraryInfo: [
        part('SDE-P1', 'P7100-01', 'SDE parent assembly', 'V1'),
        part('SDE-S1', 'P7100-01-03', 'SDE sub assembly', 'V1'),
        part('SDE-C1', 'C7100-9', 'SDE bracket', 'V2'),
      ],
      DN_PDM_BomHeadInfo: [
        { part_id: 'SDE-P1', bom_id: 'SDE-BOM-P1', SysVer: 'V1', bom_able: true },
        { part_id: 'SDE-S1', bom_id: 'SDE-BOM-S1', SysVer: 'V1', bom_able: true },
      ],
      DN_PDM_BomDetailsInfo: [
        { bom_pid: 'SDE-BOM-P1', part_id: 'SDE-S1', Bom_ExAttr1: '2', sort_id: '1' },
        { bom_pid: 'SDE-BOM-S1', part_id: 'SDE-C1', Bom_ExAttr1: '3', sort_id: '1' },
      ],
    },
    applyable: true,
    large: true,
  }
}

function mainDrawingScenario() {
  const projectNo = 'SDE-GOLD-MAIN'
  return {
    name: 'main_drawing_superseded',
    projectNo,
    data: {
      ...orderModule(projectNo, [
        { part_id: 'SDE-M1', quantity: '1' },
        { part_id: 'SDE-M2', quantity: '1' },
        { part_id: 'SDE-SM1', quantity: '6' },
        { part_id: 'SDE-X1', quantity: '5' },
      ]),
      DN_PDM_PartLibraryInfo: [
        part('SDE-M1', 'J7200-00', 'SDE main drawing', 'V1'),
        part('SDE-M2', 'J7200-00', 'SDE main drawing', 'V2'),
        part('SDE-SM1', 'J7200-A', 'SDE sheet metal', 'V1'),
        part('SDE-X1', 'K7200-9', 'SDE loose item', 'V1'),
        part('SDE-C2', 'C7200-1', 'SDE plate', 'V1'),
      ],
      DN_PDM_BomHeadInfo: [
        { part_id: 'SDE-M2', bom_id: 'SDE-BOM-M2', SysVer: 'V2', bom_able: true },
        { part_id: 'SDE-SM1', bom_id: 'SDE-BOM-SM1', SysVer: 'V1', bom_able: true },
      ],
      DN_PDM_BomDetailsInfo: [
        { bom_pid: 'SDE-BOM-M2', part_id: 'SDE-X1', Bom_ExAttr1: '5', sort_id: '1' },
        { bom_pid: 'SDE-BOM-SM1', part_id: 'SDE-C2', Bom_ExAttr1: '2', sort_id: '1' },
      ],
    },
    applyable: true,
    large: true,
  }
}

function missingComponentScenario() {
  const projectNo = 'SDE-GOLD-MISS'
  return {
    name: 'root_missing_component',
    projectNo,
    data: {
      ...orderModule(projectNo, [
        { part_id: 'SDE-Q1', quantity: '3' },
        { part_id: 'SDE-GONE', quantity: '1' },
      ]),
      DN_PDM_PartLibraryInfo: [part('SDE-Q1', 'Q7300-1', 'SDE present part', 'V1')],
      DN_PDM_BomHeadInfo: [],
      DN_PDM_BomDetailsInfo: [],
    },
    ledger: true,
  }
}

function notFoundScenario() {
  return {
    name: 'not_found',
    projectNo: 'SDE-GOLD-NONE',
    data: { DN_PDM_PathExAttrInfo: [], DN_PDM_PathInfo: [] },
  }
}

function readFailedScenario() {
  const scenario = dashScenario()
  return {
    ...scenario,
    name: 'global_read_failed',
    projectNo: 'SDE-GOLD-DASH',
    failObjects: ['DN_PDM_OrderDetailInfo'],
    applyable: false,
    large: false,
  }
}

function duplicateScenario() {
  const projectNo = 'SDE-GOLD-DUP'
  return {
    name: 'duplicate_key_hold_with_ledger_decision',
    projectNo,
    data: {
      ...orderModule(projectNo, [
        { part_id: 'SDE-D1', quantity: '2' },
        { part_id: 'SDE-D1', quantity: '3' },
      ]),
      DN_PDM_PartLibraryInfo: [part('SDE-D1', 'D7400-1', 'SDE doubled part', 'V1')],
      DN_PDM_BomHeadInfo: [],
      DN_PDM_BomDetailsInfo: [],
    },
    ledger: true,
    ledgerDecision: true,
  }
}

function subtreeScenario() {
  const projectNo = 'SDE-GOLD-TREE'
  return {
    name: 'subtree_on',
    projectNo,
    readPlan: {
      maxReadCount: 500,
      projectSubtree: {
        pathInfo: { parentIdField: 'parent_id' },
        bomHead: { pathIdField: 'path_id' },
        maxSubtreeDepth: 2,
      },
    },
    data: {
      ...orderModule(projectNo, [{ part_id: 'SDE-T0', quantity: '2' }]),
      DN_PDM_PathInfo: [
        { OBJ_ID: `${projectNo}-PATH` },
        { OBJ_ID: `${projectNo}-PATH-2`, parent_id: `${projectNo}-PATH` },
      ],
      DN_PDM_PartLibraryInfo: [
        part('SDE-T0', 'T7500-0', 'SDE ordered root', 'V1'),
        part('SDE-T1', 'T7500-1', 'SDE folder root', 'V1'),
        part('SDE-T2', 'T7500-2', 'SDE folder child', 'V1'),
      ],
      DN_PDM_BomHeadInfo: [
        { part_id: 'SDE-T0', bom_id: 'SDE-BOM-T0', SysVer: 'V1', bom_able: true, path_id: `${projectNo}-PATH` },
        { part_id: 'SDE-T1', bom_id: 'SDE-BOM-T1', SysVer: 'V1', bom_able: true, path_id: `${projectNo}-PATH-2` },
      ],
      DN_PDM_BomDetailsInfo: [
        { bom_pid: 'SDE-BOM-T0', part_id: 'SDE-T2', Bom_ExAttr1: '1', sort_id: '1' },
        { bom_pid: 'SDE-BOM-T1', part_id: 'SDE-T2', Bom_ExAttr1: '4', sort_id: '1' },
      ],
    },
    applyable: true,
    large: true,
  }
}

// The third ledger family (carry) needs an existing inactive predecessor that carries human work
// and an opted-in carryPolicy; the expansion half is a one-line order.
function carryScenario() {
  const projectNo = 'SDE-GOLD-CARRY'
  const predecessorKey = JSON.stringify({ projectNo, componentSourceId: 'SDE-K1', parentSourceId: null, path: ['SDE-OLD', 'SDE-K1'] })
  return {
    name: 'carry_family',
    projectNo,
    actionOverrides: { carryPolicy: { carryKey: 'component_source_id' } },
    existingRows: [{
      id: 'rec_carry_1',
      sheetId: 'sheet_sde_golden',
      data: {
        projectNo,
        idempotencyKey: predecessorKey,
        componentSourceId: 'SDE-K1',
        path: JSON.stringify(['SDE-OLD', 'SDE-K1']),
        totalQuantity: 2,
        active: false,
        notes: 'synthetic human note',
      },
    }],
    data: {
      ...orderModule(projectNo, [{ part_id: 'SDE-K1', quantity: '2' }]),
      DN_PDM_PartLibraryInfo: [part('SDE-K1', 'K7600-1', 'SDE carried part', 'V1')],
      DN_PDM_BomHeadInfo: [],
      DN_PDM_BomDetailsInfo: [],
    },
    ledger: true,
  }
}

const SCENARIOS = Object.freeze([
  dashScenario,
  mainDrawingScenario,
  missingComponentScenario,
  notFoundScenario,
  readFailedScenario,
  duplicateScenario,
  subtreeScenario,
  carryScenario,
])

// ── observation ───────────────────────────────────────────────────────────────────────────────

function actionFor(scenario) {
  const overrides = { ...(scenario.actionOverrides || {}) }
  if (scenario.readPlan) {
    const { PLM_STOCK_PREPARATION_BOM_READ_PLAN } = require(EXPANSION_PATH)
    overrides.source = { readPlan: { ...clone(PLM_STOCK_PREPARATION_BOM_READ_PLAN), ...scenario.readPlan } }
  }
  return baseAction(overrides)
}

function duplicateLedgerResolver(plannerInternals) {
  // The planner's group fingerprint over the duplicated key — the shape a confirmed
  // keep_multiple_rows ledger row reads back as (see loadConfirmedDuplicatePolicyReview).
  return async ({ plan }) => ({
    policies: plan.decisions
      .filter((decision) => decision.conflictSummary && decision.conflictSummary.type === 'duplicate_expanded_key')
      .map((decision) => ({ fingerprint: plannerInternals.stableFingerprint(decision.idempotencyKey), policy: 'keep_multiple_rows' })),
  })
}

function withoutTimes(value) {
  if (Array.isArray(value)) return value.map(withoutTimes)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (/(At|Time)$/.test(key)) continue
      out[key] = withoutTimes(entry)
    }
    return out
  }
  return value
}

// The large lane's expander options, built the way the run route builds them: http-routes.cjs
// `largeBomExpansionOptionsForAction(action)` over the RE-NORMALIZED stored action snapshot, plus
// `requireCompleteBatch: Boolean(largeBomB2aAuthorization)` — `false` while B2a is dormant. The route
// helper is not exported (http-routes.cjs is a pinned file), so this is a restatement; the golden
// suite evaluates the route's own helper source and pins that both agree for every scenario.
function routeShapedLargeExpansionOptions(tableActions, normalizedAction) {
  const source = normalizedAction && typeof normalizedAction.source === 'object' && normalizedAction.source ? normalizedAction.source : {}
  const options = {
    readPlan: source.readPlan,
    pageLimit: normalizedAction.pageLimit,
    maxDepth: normalizedAction.maxDepth,
    ...tableActions.largeBomBackgroundExpansionCaps(normalizedAction),
  }
  for (const key of Object.keys(options)) {
    if (options[key] === undefined || options[key] === null || options[key] === '') delete options[key]
  }
  return options
}

// EVERY entry point the scenarios drive, in ONE place: a wrapper that the routes put around these
// (a write lease, a generation binder, an atomic-consume token store) is a change to this function.
function laneCalls(harness) {
  const { tableActions, largeBomJobs } = harness
  // PR #6501 (sheet write lock): the dry-run through the generation binder, the apply inside the lease
  // with the guard (a records fake without the host write fence gets the kit's fake host fence), and a
  // token store with the atomic consume. The large approval stays UNBOUND (no binder), exactly as on main.
  const writeLockKit = require('./stock-preparation-project-write-lock-kit.cjs')
  const writeLock = writeLockKit.createLibWriteLockHarness()
  return {
    dryRun: writeLock.wrapDryRun(tableActions.dryRunStockPreparationAction),
    apply: writeLock.wrapApply(tableActions.applyStockPreparationAction),
    createLargeApplyJob: largeBomJobs.createLargeBomCheckpointApplyJob,
    tokenStore: () => writeLockKit.createConsumableStorage(),
  }
}

async function observeScenario(harness, scenario) {
  const { tableActions, largeBomJobs } = harness
  const lanes = laneCalls(harness)
  const dryRunStockPreparationAction = lanes.dryRun
  const applyStockPreparationAction = lanes.apply
  const {
    prepareStockPreparationConfirmationDecisions,
    prepareStockPreparationMvpSnapshot,
    stockPreparationSourceContentDigest,
    __internals: tableActionInternals,
  } = tableActions
  const { deriveDecisionCandidates } = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
  const { __internals: plannerInternals } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
  const { mintStockPreparationBatchIdentity, BATCH_IDENTITY_MODES } = require(path.join(LIB, 'stock-preparation-batch-identity.cjs'))
  const { mapExpansionRowsToSnapshotLines } = require(path.join(LIB, 'stock-preparation-expansion-snapshot-mapper.cjs'))

  const action = actionFor(scenario)
  const parameters = { projectNo: scenario.projectNo }
  const sourceAdapter = createSourceAdapter(scenario.data, { failObjects: scenario.failObjects || [] })
  const tokenStore = lanes.tokenStore()
  const observed = {}

  // 1. The small dry-run: revision, the token subset, evidence, counts / status / canApply, and the
  //    rows / summary the expansion handed the hashes.
  const resolver = scenario.ledgerDecision ? duplicateLedgerResolver(plannerInternals) : undefined
  const dryRun = await dryRunStockPreparationAction({
    action,
    parameters,
    sourceAdapter,
    recordsApi: createRecordsApi(scenario.existingRows || []),
    tokenStore,
    plannedAt: PLANNED_AT,
    runId: RUN_ID,
    ...(resolver ? { confirmationDecisionResolver: resolver } : {}),
  })
  const dryRunExpansion = harness.calls[harness.calls.length - 1].result
  observed.dryRun = {
    status: dryRun.status,
    canApply: dryRun.canApply,
    counts: clone(dryRun.counts),
    revision: dryRun.revision,
    evidenceDigest: digest(dryRun.evidence),
    responseDigest: digest(withoutTimes({ ...clone(dryRun), dryRunToken: dryRun.dryRunToken ? 'minted' : null, plmReadPhase: undefined })),
    rowsDigest: digest(dryRunExpansion.rows),
    summaryDigest: digest(dryRunExpansion.summary),
    rowErrorsDigest: digest(dryRunExpansion.rowErrors),
    errorsDigest: digest(dryRunExpansion.errors),
  }
  if (dryRun.dryRunToken) {
    const stored = await tokenStore.get(`integration:table-action:dry-run-token:${dryRun.dryRunToken}`)
    if (!stored) throw new Error('golden harness: the minted dry-run token record was not found')
    observed.dryRun.tokenSubsetDigest = digest({
      actionId: stored.actionId,
      parametersHash: stored.parametersHash,
      revision: stored.revision,
      conflictPolicyReview: stored.conflictPolicyReview === undefined ? null : stored.conflictPolicyReview,
    })
  }
  if (dryRun.evidence && dryRun.evidence.confirmationDecision) {
    observed.dryRun.confirmationInputRevision = dryRun.evidence.confirmationDecision.inputRevision
  }

  // 2. Source content: the revision and the 32-hex digest the apply answers and mvp-persist compares.
  //    Recomputed over the NORMALIZED action, exactly as computeDryRun does (it hashes
  //    `action.source.readPlan`, which only the normalizer fills in).
  const sourceContentRevision = tableActionInternals.buildSourceContentRevision({
    action: tableActions.assertStockPreparationTargetReady(action),
    parameters,
    expansion: dryRunExpansion,
  })
  observed.sourceContent = {
    revision: sourceContentRevision,
    digest: stockPreparationSourceContentDigest(sourceContentRevision),
  }

  // 3. The ledger: reconcile's pre-merge input revision and all three families' identities.
  if (scenario.ledger) {
    const prepared = await prepareStockPreparationConfirmationDecisions({
      action,
      parameters,
      sourceAdapter,
      recordsApi: createRecordsApi(scenario.existingRows || []),
      plannedAt: PLANNED_AT,
      runId: RUN_ID,
    })
    const derived = deriveDecisionCandidates({ projectNo: scenario.projectNo, plan: prepared.plan, sourceRevision: prepared.revision })
    const identities = (list) => list.map((entry) => ({
      decisionId: entry.decisionId,
      stableDecisionKey: entry.stableDecisionKey,
      inputFingerprint: entry.inputFingerprint,
    }))
    observed.ledger = {
      confirmationInputRevision: prepared.revision,
      duplicateFamily: identities(derived.candidates),
      anonymousFamily: identities(derived.anonymousCandidates),
      carryFamily: identities(derived.carryCandidates),
      derivedDigest: digest(derived),
    }
  }

  // 4. The archive: archiveRevision, the route's snapshot_/sync_ ids (the http-routes.cjs
  //    `tableActionMvpPersist` recipe, replicated here so the variable — archiveRevision — is what
  //    is pinned), batch identity in both modes, and the snapshot lines.
  if (scenario.applyable) {
    const prepared = await prepareStockPreparationMvpSnapshot({
      action,
      parameters,
      sourceAdapter,
      recordsApi: createRecordsApi([]),
      plannedAt: PLANNED_AT,
      runId: RUN_ID,
    })
    const stableScope = `${TENANT_ID}\n${action.actionId}\n${prepared.parameters.projectNo}`
    const batchDigest = crypto.createHash('sha256').update(`${stableScope}\n${prepared.archiveRevision}`).digest('hex').slice(0, 32)
    const legacyBatchId = `snapshot_${batchDigest}`
    const sourceRevisionIdentity = mintStockPreparationBatchIdentity({
      mode: BATCH_IDENTITY_MODES.SOURCE_REVISION,
      projectNo: prepared.parameters.projectNo,
      rows: prepared.expansionResult,
      legacyBatchId,
    })
    const hourIdentity = mintStockPreparationBatchIdentity({
      mode: BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR,
      projectNo: prepared.parameters.projectNo,
      rows: prepared.expansionResult,
      legacyBatchId,
    })
    const lines = mapExpansionRowsToSnapshotLines(prepared.expansionResult, { snapshotBatchId: sourceRevisionIdentity.batchId })
    observed.archive = {
      revision: prepared.revision,
      archiveRevision: prepared.archiveRevision,
      snapshotBatchId: legacyBatchId,
      syncRunId: `sync_${batchDigest}`,
      batchIdentitySourceRevision: digest(sourceRevisionIdentity),
      batchIdentityMaterialCreateHour: digest(hourIdentity),
      snapshotLinesDigest: digest(lines),
      evidenceDigest: digest(prepared.evidence),
      expansionResultDigest: digest(prepared.expansionResult),
    }

    // 5. Apply against an empty sheet, minus the random token and the clocks.
    const applyStore = lanes.tokenStore()
    const applyRecords = createRecordsApi([])
    const applyDryRun = await dryRunStockPreparationAction({
      action, parameters, sourceAdapter, recordsApi: applyRecords, tokenStore: applyStore, plannedAt: PLANNED_AT, runId: RUN_ID,
    })
    const applied = await applyStockPreparationAction({
      sandboxPolicy: SANDBOX_POLICY,
      action,
      parameters,
      dryRunToken: applyDryRun.dryRunToken,
      sourceAdapter,
      recordsApi: applyRecords,
      tokenStore: applyStore,
      permission: 'write',
      plannedAt: PLANNED_AT,
      runId: RUN_ID,
      acceptManualConfirmHold: true,
      acceptDuplicateResolution: true,
    })
    observed.apply = {
      status: applied.status,
      dryRunRevision: applied.dryRunRevision,
      sourceContentRevision: applied.sourceContentRevision,
      responseDigest: digest(withoutTimes(applied)),
      writtenRowsDigest: digest(withoutTimes(applyRecords.rows.map((row) => row.data))),
    }
  }

  // 6. The large-BOM lane, ROUTE-SHAPED (review round 1, F1): the start route snapshots the
  //    NORMALIZED action (http-routes.cjs `assertStockPreparationTargetReady(getTableAction(...))`),
  //    the run route re-normalizes that snapshot and expands with `largeBomExpansionOptionsForAction`
  //    + `requireCompleteBatch` (see `routeShapedLargeExpansionOptions`). Pins the artifact revision
  //    + artifact digest, plan revision, target revision, and the public job projection.
  if (scenario.large) {
    const storage = createMemoryStorage({ durable: true })
    const now = () => new Date(FIXED_NOW)
    const scope = { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID }
    const normalizedAction = tableActions.assertStockPreparationTargetReady(action)
    const queued = await largeBomJobs.createLargeBomBackgroundExpansionJob({
      storage, ...scope, action: normalizedAction, parameters, principal: 'principal_sde_golden', createJobId: () => 'job_sde_golden', now,
    })
    const runAction = tableActions.assertStockPreparationTargetReady(queued.actionSnapshot)
    const ran = await largeBomJobs.runLargeBomBackgroundExpansionJob({
      storage,
      ...scope,
      actionId: action.actionId,
      jobId: 'job_sde_golden',
      sourceAdapter,
      expansionOptions: { ...routeShapedLargeExpansionOptions(tableActions, runAction), requireCompleteBatch: false },
      now,
    })
    const planned = await largeBomJobs.planLargeBomBackgroundExpansionJob({
      storage, ...scope, actionId: action.actionId, jobId: 'job_sde_golden', existingRows: [], plannedAt: PLANNED_AT, now,
    })
    const applyJob = await lanes.createLargeApplyJob({
      storage,
      ...scope,
      actionId: action.actionId,
      jobId: 'job_sde_golden',
      principal: 'principal_sde_golden',
      permission: 'write',
      acceptManualConfirmHold: true,
      createApplyJobId: () => 'apply_job_sde_golden',
      now,
    })
    observed.large = {
      status: ran.status,
      artifactRevision: ran.artifactRevision,
      artifactDigest: digest(ran.artifact),
      planRevision: planned.planRevision,
      planArtifactDigest: digest(planned.planArtifact),
      targetRevision: applyJob.targetRevision,
      publicJobDigest: digest(largeBomJobs.publicBackgroundExpansionJob(planned)),
      storedJobDigest: digest(planned),
    }
  }
  return observed
}

async function observeAll(harness, mode, options) {
  const out = {}
  for (const build of SCENARIOS) {
    const scenario = build()
    harness.setMode(mode, options)
    out[scenario.name] = await observeScenario(harness, scenario)
    out[scenario.name].__expansionCalls = harness.calls.length
    out[scenario.name].__calls = harness.calls
  }
  return out
}

function stripHarnessKeys(observations) {
  const out = {}
  for (const [name, entry] of Object.entries(observations)) {
    const copy = { ...entry }
    delete copy.__expansionCalls
    delete copy.__calls
    out[name] = copy
  }
  return out
}

module.exports = {
  ACTION_ID,
  MODES,
  SCENARIOS,
  TENANT_ID,
  createMemoryStorage,
  createRecordsApi,
  createSourceAdapter,
  digest,
  installExpansionCaptureSwitch,
  observeAll,
  observeScenario,
  routeShapedLargeExpansionOptions,
  actionFor,
  stableStringify,
  stripHarnessKeys,
}
