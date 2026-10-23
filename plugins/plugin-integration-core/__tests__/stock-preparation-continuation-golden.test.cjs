'use strict'

// Batch-refresh step 4, PR-1 — GOLDEN BYTE-IDENTITY of the old flow over a SECOND-PULL sheet.
//
// WHY A SECOND GOLDEN SUITE. The #6502 golden (`stock-preparation-demand-evidence-golden.test.cjs`)
// pins every hash the pull mints, but over sheets that are empty (the archive and apply legs) or
// carry one inactive row (the carry family). PR-1 attaches a record reference to every existing row
// the project-scoped reader returns (`EXISTING_ROW_RECORD_REF`, a Symbol key — design §6.5) and adds
// an optional `continuation` input to the planner. Neither may move anything for a project that is
// not governed (design §6.1 invariant (i), constraint 6). That claim is only tested by a sheet that
// HOLDS rows the planner sweeps, updates, skips and leaves alone, read through the real reader, on
// every lane: the small dry-run (revision, token subset, evidence, response), the source-content
// revision / digest, the ledger (reconcile's input revision, the three families, the plan itself),
// the archive (archive revision, snapshot_ / sync_ ids, batch identity, snapshot lines), the apply
// (response, written rows), the large lane (plan revision, plan artifact, stored job), the planner
// called directly, and the demand-evidence fingerprint (capture ON).
//
// GOLDEN BASELINE: every literal in GOLDEN below was captured on origin/main
//   1638ab91cc89e04b839dc78ed55a7b49bb40ff4f
// BEFORE any PR-1 code existed (no Symbol attach, no continuation input), by running this file with
// SCC_CAPTURE=1. Between the design's base 5f978b240 and that commit, the only stock-preparation lib
// changes are two NEW files (`stock-preparation-yida-allocation.mjs` / `.d.mts`, #6315), required only
// by the yida modules; the conflict planner, table actions, BOM expansion and demand evidence are
// unchanged (`git diff --stat 5f978b240 1638ab91c` over those four files is empty). A literal that has
// to move is a behaviour change of the old flow, not a re-capture.
//
// RE-CAPTURED ON origin/main cde8e17e21b93384154eca6aa9c4679621e1a15b (#6501, the project write lease)
// with the lanes wrapped the way that commit's golden harness wraps them (binder-wrapped dry-run,
// lease-wrapped apply with its guard, consumable token store) — again with no PR-1 code (a
// `git -c core.autocrlf=false archive` copy of that commit's plugin directory, this file added): the
// SCC_CAPTURE output was BYTE-IDENTICAL to the 1638ab91c capture, so GOLDEN holds on both bases.
//
// After PR-1 the same legs must reproduce GOLDEN exactly AND the rows the reader returned must carry
// the record reference (otherwise the identity would be vacuous: nothing would have been attached).
//
// VALUES-FREE: synthetic project numbers, part ids and drawing numbers only.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')

const {
  createMemoryStorage,
  createRecordsApi,
  createSourceAdapter,
  digest,
  installExpansionCaptureSwitch,
  routeShapedLargeExpansionOptions,
  stableStringify,
} = require('./support/stock-preparation-demand-evidence-golden-harness.cjs')

const GOLDEN_BASE_SHA = '1638ab91cc89e04b839dc78ed55a7b49bb40ff4f'
// The #6501 base the same literals were re-captured on (byte-identical, see the header).
const GOLDEN_RECAPTURE_SHA = 'cde8e17e21b93384154eca6aa9c4679621e1a15b'
const CAPTURE = process.env.SCC_CAPTURE === '1'
const RECORD_REF = Symbol.for('metasheet.stock-preparation.existingRow.recordRef')

const LIB = path.join(__dirname, '..', 'lib')
const ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const TENANT_ID = 'tenant_scc_golden'
const WORKSPACE_ID = 'workspace_scc_golden'
const SHEET_ID = 'sheet_scc_golden'
const PLANNED_AT = '2026-10-23T01:00:00.000Z'
const RUN_ID = 'run_scc_golden'
const FIXED_NOW = Date.parse('2026-10-23T02:00:00.000Z')
const SANDBOX_POLICY = Object.freeze({ enabled: true, allowedTargetObjectIds: ['stockPreparationMain'] })

function baseAction() {
  return {
    actionId: ACTION_ID,
    source: { externalSystemId: 'plm_scc_golden', kind: 'data-source:sql-readonly' },
    target: { sheetId: SHEET_ID, objectId: 'stockPreparationMain' },
  }
}

function part(id, code, name, version) {
  return { OBJ_ID: id, IdentityNo: code, IdentityName: name, Material: 'SCC-STEEL', SysVer: version }
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

function key(projectNo, componentSourceId, tokens) {
  return JSON.stringify({
    projectNo,
    componentSourceId,
    parentSourceId: tokens.length > 1 ? tokens[tokens.length - 2] : null,
    path: tokens,
  })
}

// An existing sheet row as the plugin wrote it on an earlier pull: every plm_system column, the run
// stamps, and (where given) a human cell.
function sheetRow(projectNo, tokens, fields) {
  const componentSourceId = tokens[tokens.length - 1]
  return {
    projectNo,
    idempotencyKey: key(projectNo, componentSourceId, tokens),
    componentSourceId,
    parentSourceId: tokens.length > 1 ? tokens[tokens.length - 2] : null,
    path: JSON.stringify(tokens),
    depth: tokens.length - 1,
    active: true,
    lastPlmRefreshRunId: 'run_scc_first_pull',
    lastPlmRefreshAt: '2026-10-01T01:00:00.000Z',
    lastPlmRefreshDecision: 'add',
    lastPlmConflictSummary: '',
    ...fields,
  }
}

// THE SECOND PULL. First pull: S-001 and N-001 were ordered on their own (S-001 with its child
// C-001). Second pull: P-001 is ordered, contains S-001 (dash hierarchy, so root selection drops the
// S-001 line), N-001's order quantity changed, and an earlier-swept row is already inactive.
// Old flow: ADD x3 (P-001 and the copied S-001 subtree), UPDATE N-001, INACTIVE x2 (the old S-001
// subtree), SKIP the already-inactive row — exactly the shape step 4 governs, planned ungoverned.
function secondPullScenario() {
  const projectNo = 'SCC-GOLD-2ND'
  return {
    name: 'second_pull_dash',
    projectNo,
    data: {
      ...orderModule(projectNo, [
        { part_id: 'SCC-P1', quantity: '5' },
        { part_id: 'SCC-S1', quantity: '10' },
        { part_id: 'SCC-N1', quantity: '1' },
      ]),
      DN_PDM_PartLibraryInfo: [
        part('SCC-P1', 'Q8100-01', 'SCC-assembly', 'V1'),
        part('SCC-S1', 'Q8100-01-03', 'SCC-subassembly', 'V1'),
        part('SCC-C1', 'C8100-9', 'SCC-bracket', 'V2'),
        part('SCC-N1', 'R8100-1', 'SCC-loose', 'V1'),
      ],
      DN_PDM_BomHeadInfo: [
        { part_id: 'SCC-P1', bom_id: 'SCC-BOM-P1', SysVer: 'V1', bom_able: true },
        { part_id: 'SCC-S1', bom_id: 'SCC-BOM-S1', SysVer: 'V1', bom_able: true },
      ],
      DN_PDM_BomDetailsInfo: [
        { bom_pid: 'SCC-BOM-P1', part_id: 'SCC-S1', Bom_ExAttr1: '2', sort_id: '1' },
        { bom_pid: 'SCC-BOM-S1', part_id: 'SCC-C1', Bom_ExAttr1: '3', sort_id: '1' },
      ],
    },
    existingRows: [
      { id: 'rec_scc_s1', version: 4, data: sheetRow(projectNo, ['SCC-S1'], {
        componentCode: 'Q8100-01-03', componentName: 'SCC-subassembly', material: 'SCC-STEEL', sourceVersion: 'V1',
        rawQuantity: 10, totalQuantity: 10, notes: 'synthetic human note S', stockPreparationStatus: 'synthetic-done',
      }) },
      { id: 'rec_scc_c1', version: 2, data: sheetRow(projectNo, ['SCC-S1', 'SCC-C1'], {
        componentCode: 'C8100-9', componentName: 'SCC-bracket', material: 'SCC-STEEL', sourceVersion: 'V2',
        rawQuantity: 3, totalQuantity: 30, parentComponentCode: 'Q8100-01-03', parentComponentName: 'SCC-subassembly',
        notes: 'synthetic human note C',
      }) },
      { id: 'rec_scc_n1', version: 7, data: sheetRow(projectNo, ['SCC-N1'], {
        componentCode: 'R8100-1', componentName: 'SCC-loose', material: 'SCC-STEEL', sourceVersion: 'V1',
        rawQuantity: 2, totalQuantity: 2,
      }) },
      { id: 'rec_scc_x1', version: 3, data: sheetRow(projectNo, ['SCC-X1'], {
        componentCode: 'X8100-1', componentName: 'SCC-gone', material: 'SCC-STEEL', sourceVersion: 'V1',
        rawQuantity: 1, totalQuantity: 1, active: false, lastPlmRefreshDecision: 'inactive',
      }) },
    ],
    applyable: true,
    large: true,
  }
}

// A held second pull: one keyless row a PERSON put on the sheet (created_by set — GOV-05's Symbol)
// next to plugin rows that now also carry the record reference. Dry-run + ledger only (held plans
// are not archived).
function foreignKeylessScenario() {
  const projectNo = 'SCC-GOLD-FOREIGN'
  return {
    name: 'second_pull_foreign_keyless',
    projectNo,
    data: {
      ...orderModule(projectNo, [{ part_id: 'SCC-K1', quantity: '2' }]),
      DN_PDM_PartLibraryInfo: [part('SCC-K1', 'K8200-1', 'SCC-kept', 'V1')],
      DN_PDM_BomHeadInfo: [],
      DN_PDM_BomDetailsInfo: [],
    },
    existingRows: [
      { id: 'rec_scc_k1', version: 5, data: sheetRow(projectNo, ['SCC-K1'], {
        componentCode: 'K8200-1', componentName: 'SCC-kept', material: 'SCC-STEEL', sourceVersion: 'V1',
        rawQuantity: 2, totalQuantity: 2, notes: 'synthetic human note K',
      }) },
      { id: 'rec_scc_foreign', version: 1, createdBy: 'actor_scc_person', data: {
        projectNo, componentSourceId: 'SCC-HAND', componentCode: 'H8200-1', totalQuantity: 1, active: true, notes: 'typed by a person',
      } },
    ],
  }
}

const SCENARIOS = Object.freeze([secondPullScenario, foreignKeylessScenario])

function seededRecordsApi(scenario) {
  const api = createRecordsApi(scenario.existingRows.map((entry) => ({ id: entry.id, sheetId: SHEET_ID, data: entry.data })))
  // The harness pins every version to 1 and drops createdBy; restore both so the envelope carries
  // what a host record carries.
  scenario.existingRows.forEach((entry, index) => {
    api.rows[index].version = entry.version
    if (entry.createdBy) api.rows[index].createdBy = entry.createdBy
  })
  return api
}

function withoutTimes(value) {
  if (Array.isArray(value)) return value.map(withoutTimes)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [entryKey, entry] of Object.entries(value)) {
      if (/(At|Time)$/.test(entryKey)) continue
      out[entryKey] = withoutTimes(entry)
    }
    return out
  }
  return value
}

function recordRefsOf(rows) {
  return rows.map((row) => (row && row[RECORD_REF] ? { id: row[RECORD_REF].id, version: row[RECORD_REF].version } : null))
}

async function observeScenario(harness, scenario) {
  const { tableActions, largeBomJobs } = harness
  // The lanes the way the routes drive them since #6501 (the same wrapping the #6502 golden harness's
  // `laneCalls` applies): the dry-run through the generation binder, the apply inside the project write
  // lease with its guard (a records fake gets the kit's fake host write fence), and a token store with
  // the atomic consume. The large approval stays unbound, as in that harness.
  const writeLockKit = require('./support/stock-preparation-project-write-lock-kit.cjs')
  const writeLock = writeLockKit.createLibWriteLockHarness()
  const dryRunStockPreparationAction = writeLock.wrapDryRun(tableActions.dryRunStockPreparationAction)
  const applyStockPreparationAction = writeLock.wrapApply(tableActions.applyStockPreparationAction)
  const createTokenStore = () => writeLockKit.createConsumableStorage()
  const {
    prepareStockPreparationConfirmationDecisions,
    prepareStockPreparationMvpSnapshot,
    stockPreparationSourceContentDigest,
    __internals: tableActionInternals,
  } = tableActions
  const { deriveDecisionCandidates } = require(path.join(LIB, 'stock-preparation-confirmation-decisions.cjs'))
  const { planStockPreparationConflicts } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
  const { mintStockPreparationBatchIdentity, BATCH_IDENTITY_MODES } = require(path.join(LIB, 'stock-preparation-batch-identity.cjs'))
  const { mapExpansionRowsToSnapshotLines } = require(path.join(LIB, 'stock-preparation-expansion-snapshot-mapper.cjs'))

  const action = baseAction()
  const normalizedAction = tableActions.assertStockPreparationTargetReady(action)
  const parameters = { projectNo: scenario.projectNo }
  const sourceAdapter = createSourceAdapter(scenario.data)
  const observed = {}
  const refs = {}

  // 1. Small dry-run against the seeded sheet.
  const tokenStore = createTokenStore()
  const dryRun = await dryRunStockPreparationAction({
    action, parameters, sourceAdapter, recordsApi: seededRecordsApi(scenario), tokenStore, plannedAt: PLANNED_AT, runId: RUN_ID,
  })
  const dryRunExpansion = harness.calls[harness.calls.length - 1].result
  observed.dryRun = {
    status: dryRun.status,
    canApply: dryRun.canApply,
    counts: JSON.parse(JSON.stringify(dryRun.counts)),
    revision: dryRun.revision,
    evidenceDigest: digest(dryRun.evidence),
    responseDigest: digest(withoutTimes({ ...JSON.parse(JSON.stringify(dryRun)), dryRunToken: dryRun.dryRunToken ? 'minted' : null, plmReadPhase: undefined })),
    rowsDigest: digest(dryRunExpansion.rows),
  }
  if (dryRun.dryRunToken) {
    const stored = await tokenStore.get(`integration:table-action:dry-run-token:${dryRun.dryRunToken}`)
    if (!stored) throw new Error('continuation golden: the minted dry-run token record was not found')
    observed.dryRun.tokenSubsetDigest = digest({
      actionId: stored.actionId,
      parametersHash: stored.parametersHash,
      revision: stored.revision,
      conflictPolicyReview: stored.conflictPolicyReview === undefined ? null : stored.conflictPolicyReview,
    })
  }
  if (dryRunExpansion.demandEvidence) observed.demandEvidenceFingerprint = dryRunExpansion.demandEvidence.fingerprint

  // 2. Source content.
  const sourceContentRevision = tableActionInternals.buildSourceContentRevision({ action: normalizedAction, parameters, expansion: dryRunExpansion })
  observed.sourceContent = { revision: sourceContentRevision, digest: stockPreparationSourceContentDigest(sourceContentRevision) }

  // 3. Ledger: reconcile's input revision, the three families, and the PLAN the reconcile derives from.
  const prepared = await prepareStockPreparationConfirmationDecisions({
    action, parameters, sourceAdapter, recordsApi: seededRecordsApi(scenario), plannedAt: PLANNED_AT, runId: RUN_ID,
  })
  const derived = deriveDecisionCandidates({ projectNo: scenario.projectNo, plan: prepared.plan, sourceRevision: prepared.revision })
  const identities = (list) => list.map((entry) => ({ decisionId: entry.decisionId, stableDecisionKey: entry.stableDecisionKey, inputFingerprint: entry.inputFingerprint }))
  observed.ledger = {
    confirmationInputRevision: prepared.revision,
    duplicateFamily: identities(derived.candidates),
    anonymousFamily: identities(derived.anonymousCandidates),
    carryFamily: identities(derived.carryCandidates),
    derivedDigest: digest(derived),
    planDigest: digest(prepared.plan),
    planJsonDigest: crypto.createHash('sha256').update(JSON.stringify(prepared.plan)).digest('hex'),
  }

  // 4. The planner called directly over the rows the project-scoped reader returns.
  const readerRows = await tableActionInternals.readExistingStockPreparationRows(seededRecordsApi(scenario), normalizedAction.target, scenario.projectNo)
  refs.reader = recordRefsOf(readerRows)
  const directPlan = planStockPreparationConflicts({
    template: normalizedAction.template,
    expandedRows: dryRunExpansion.rows,
    existingRows: readerRows,
    rowErrors: dryRunExpansion.rowErrors,
    runId: RUN_ID,
    plannedAt: PLANNED_AT,
  })
  observed.planner = {
    planDigest: digest(directPlan),
    planJsonDigest: crypto.createHash('sha256').update(JSON.stringify(directPlan)).digest('hex'),
  }

  if (scenario.applyable) {
    // 5. Archive over the SEEDED sheet (people-owned columns are present, so archiveRevision differs
    //    from the dry-run revision here — unlike the #6502 golden's empty-sheet archive).
    const archived = await prepareStockPreparationMvpSnapshot({
      action, parameters, sourceAdapter, recordsApi: seededRecordsApi(scenario), plannedAt: PLANNED_AT, runId: RUN_ID,
    })
    const stableScope = `${TENANT_ID}\n${action.actionId}\n${archived.parameters.projectNo}`
    const batchDigest = crypto.createHash('sha256').update(`${stableScope}\n${archived.archiveRevision}`).digest('hex').slice(0, 32)
    const legacyBatchId = `snapshot_${batchDigest}`
    const sourceRevisionIdentity = mintStockPreparationBatchIdentity({
      mode: BATCH_IDENTITY_MODES.SOURCE_REVISION, projectNo: archived.parameters.projectNo, rows: archived.expansionResult, legacyBatchId,
    })
    const hourIdentity = mintStockPreparationBatchIdentity({
      mode: BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR, projectNo: archived.parameters.projectNo, rows: archived.expansionResult, legacyBatchId,
    })
    observed.archive = {
      revision: archived.revision,
      archiveRevision: archived.archiveRevision,
      snapshotBatchId: legacyBatchId,
      syncRunId: `sync_${batchDigest}`,
      batchIdentitySourceRevision: digest(sourceRevisionIdentity),
      batchIdentityMaterialCreateHour: digest(hourIdentity),
      snapshotLinesDigest: digest(mapExpansionRowsToSnapshotLines(archived.expansionResult, { snapshotBatchId: sourceRevisionIdentity.batchId })),
      evidenceDigest: digest(archived.evidence),
    }

    // 6. Apply onto the SEEDED sheet: the written rows include the patched (UPDATE / INACTIVE) ones.
    const applyStore = createTokenStore()
    const applyRecords = seededRecordsApi(scenario)
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
    })
    observed.apply = {
      status: applied.status,
      dryRunRevision: applied.dryRunRevision,
      sourceContentRevision: applied.sourceContentRevision,
      responseDigest: digest(withoutTimes(applied)),
      writtenRowsDigest: digest(withoutTimes(applyRecords.rows.map((row) => ({ id: row.id, version: row.version, data: row.data })))),
    }
  }

  if (scenario.large) {
    // 7. Large lane, route-shaped, with the SEEDED sheet read through the reader exactly as the plan
    //    route reads it (http-routes.cjs `tableActionInternals.readExistingStockPreparationRows`).
    const storage = createMemoryStorage({ durable: true })
    const now = () => new Date(FIXED_NOW)
    const scope = { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID }
    const queued = await largeBomJobs.createLargeBomBackgroundExpansionJob({
      storage, ...scope, action: normalizedAction, parameters, principal: 'principal_scc_golden', createJobId: () => 'job_scc_golden', now,
    })
    const runAction = tableActions.assertStockPreparationTargetReady(queued.actionSnapshot)
    const ran = await largeBomJobs.runLargeBomBackgroundExpansionJob({
      storage,
      ...scope,
      actionId: action.actionId,
      jobId: 'job_scc_golden',
      sourceAdapter,
      expansionOptions: { ...routeShapedLargeExpansionOptions(tableActions, runAction), requireCompleteBatch: false },
      now,
    })
    const largeExistingRows = await tableActionInternals.readExistingStockPreparationRows(seededRecordsApi(scenario), runAction.target, scenario.projectNo)
    refs.large = recordRefsOf(largeExistingRows)
    const planned = await largeBomJobs.planLargeBomBackgroundExpansionJob({
      storage, ...scope, actionId: action.actionId, jobId: 'job_scc_golden', existingRows: largeExistingRows, plannedAt: PLANNED_AT, now,
    })
    observed.large = {
      status: ran.status,
      artifactRevision: ran.artifactRevision,
      planRevision: planned.planRevision,
      planArtifactDigest: digest(planned.planArtifact),
      storedJobDigest: digest(planned),
    }
  }
  return { observed, refs }
}

// CAPTURED on GOLDEN_BASE_SHA with SCC_CAPTURE=1 (the ON leg; the OFF leg is identical minus
// demandEvidenceFingerprint, which only exists when capture is on).
const GOLDEN = {
  second_pull_dash: {
    apply: {
      dryRunRevision: '79cc45c884ebf7e6872bca6f2d9b58985eb9ea9538085db3182b88919b5f9258',
      responseDigest: '22bb6b6e005018a551d36029abdaf91987d0073396afeff25d3db137e411ba2b',
      sourceContentRevision: '02e2f27ed907ef830df74c3f85ff486089b3ed1888ce6c9aca4fb8f8215a37c6',
      status: 'succeeded',
      writtenRowsDigest: '76d3b2fc87b13cf49f1e57c0a9b09f84446556c2aa5fc5621cac0851052a8d4d',
    },
    archive: {
      archiveRevision: '2c418b5257e1e82642377a943b1241c4857bface0da694638178dfb574bbba87',
      batchIdentityMaterialCreateHour: '834449345eef9436a170f58049906e6b5495cebefdd7855df753a166da653c28',
      batchIdentitySourceRevision: '1e8d09b3c27800c3cab520f97f2d5c5022dc6c5b5423a8fa601b0a6da8c467f7',
      evidenceDigest: 'd0502bbe9fa6a2413d1351a8351977cea1d0719ba8d7b6cb63f627954fe677d5',
      revision: '79cc45c884ebf7e6872bca6f2d9b58985eb9ea9538085db3182b88919b5f9258',
      snapshotBatchId: 'snapshot_b4ef7f8206ea99dc310b93f9b797e07d',
      snapshotLinesDigest: '60c7046b57904c06bfdf943c7acab3838e140436c6e2a6b84163549da6197a3e',
      syncRunId: 'sync_b4ef7f8206ea99dc310b93f9b797e07d',
    },
    demandEvidenceFingerprint: '781c534ddc309eebe4f9b714dcea86ac7d73f51473ca4d8c141c086966436d2f',
    dryRun: {
      canApply: true,
      counts: {
        add: 3,
        inactive: 2,
        manual_confirm: 0,
        skip: 1,
        update: 1,
      },
      evidenceDigest: 'd0502bbe9fa6a2413d1351a8351977cea1d0719ba8d7b6cb63f627954fe677d5',
      responseDigest: 'd4269c3ad607076c0a741fc91fd73b418b710d0eb44820e821a54f2e28d17cec',
      revision: '79cc45c884ebf7e6872bca6f2d9b58985eb9ea9538085db3182b88919b5f9258',
      rowsDigest: '47d3160c0766132e27699c08a99bcc9e5602b528c1f23c1b4aa38ba471f1cc39',
      status: 'ready',
      tokenSubsetDigest: 'aba51864f0e73598b4b9f2e16ce259b3d8b61111950559c33159900127204b96',
    },
    large: {
      artifactRevision: 'dc8742a438e7eb4d9669fd9a301082e6827fc12fc6bd581a5b9c4c583388ca29',
      planArtifactDigest: '0809da6a99cbb7c824de2526facd8183038340e411c8a42d4d60286178f7e025',
      planRevision: '0b288a97299e53462a70160ea10c2db4123c08383210e335aa41d56c00c498dd',
      status: 'completed',
      storedJobDigest: '93b7ef434f968d07848878837ae4648746c086e8e55569396338f73511870085',
    },
    ledger: {
      anonymousFamily: [],
      carryFamily: [],
      confirmationInputRevision: '79cc45c884ebf7e6872bca6f2d9b58985eb9ea9538085db3182b88919b5f9258',
      derivedDigest: 'b01658a409c077c85a1bc8d99ecd83d5957bcc65534fc79f18621e67f393776c',
      duplicateFamily: [],
      planDigest: 'c97cacd0535ba5879ac125d2d062fcdb1a2030f6c0aa8cd94055a2f346ea2b3b',
      planJsonDigest: 'cd185b71a3acbef2fe05bbfee087f102d5f4d1376ecf2a6b8843ac468fe16cdc',
    },
    planner: {
      planDigest: 'c97cacd0535ba5879ac125d2d062fcdb1a2030f6c0aa8cd94055a2f346ea2b3b',
      planJsonDigest: 'cd185b71a3acbef2fe05bbfee087f102d5f4d1376ecf2a6b8843ac468fe16cdc',
    },
    sourceContent: {
      digest: '35ec74352cf1fba8644e124b9281dc08',
      revision: '02e2f27ed907ef830df74c3f85ff486089b3ed1888ce6c9aca4fb8f8215a37c6',
    },
  },
  second_pull_foreign_keyless: {
    demandEvidenceFingerprint: '6260fbebdd2141291fddf52b821a6ee5537d5545506614b8ac358130c75f8703',
    dryRun: {
      canApply: true,
      counts: {
        add: 0,
        inactive: 0,
        manual_confirm: 1,
        skip: 1,
        update: 0,
      },
      evidenceDigest: '5b35f7a8b8c959a96755d54c6167513b18a5e98b0431824e042a322038bbc7ba',
      responseDigest: '7c449550224b7b7a40b272bba8f2c2ccae6140265d144a95ae24ae6649486efc',
      revision: '2fefef158d62224e2a561244d5e1affb7400fb72fdecf2d91c0f78f11dd0dc60',
      rowsDigest: '5df3682dd30a37cfdea416e47c06fe157321e4acca09c5afae160887f1542db5',
      status: 'manual_confirm_required',
      tokenSubsetDigest: '35a6fe373200ee6e367b4346f5e05b0fd8fc7a0c60ad062d2e1b5c3be4e0d589',
    },
    ledger: {
      anonymousFamily: [
        {
          decisionId: 'sha256:2f4f1be1f8b11d3ce205864ca11fa7c9',
          inputFingerprint: 'sha256:d65ee2a9b6a96ff0d468f4ce46dce122',
          stableDecisionKey: 'sha256:65ff71c75df2b9dd3bb47d0da330f6f9',
        },
      ],
      carryFamily: [],
      confirmationInputRevision: '2fefef158d62224e2a561244d5e1affb7400fb72fdecf2d91c0f78f11dd0dc60',
      derivedDigest: 'd816ad6520c00139d08c63caced5a805f2305683d0dc75cfdc343e4c020ff5c6',
      duplicateFamily: [],
      planDigest: '4cb25a651675d122d8d9a09167529b3da7056d44be1b8795c0d96af538faabd4',
      planJsonDigest: 'b615d18b40a9914efd1dcd0acc803397c0d42dab259b8298e277b85b9d736d35',
    },
    planner: {
      planDigest: '4cb25a651675d122d8d9a09167529b3da7056d44be1b8795c0d96af538faabd4',
      planJsonDigest: 'b615d18b40a9914efd1dcd0acc803397c0d42dab259b8298e277b85b9d736d35',
    },
    sourceContent: {
      digest: '851f7de5f386fae13eb341b00c6e3db6',
      revision: '0ec9900f38e67cd524f233751d5be6c36933ddb40ba64e6fec7aef8fc25653ff',
    },
  },
}

let passed = 0
let failed = 0

async function run(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failed += 1
    console.error(`FAIL: ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}

async function main() {
  assert.match(GOLDEN_BASE_SHA, /^[0-9a-f]{40}$/)
  assert.match(GOLDEN_RECAPTURE_SHA, /^[0-9a-f]{40}$/)
  const harness = installExpansionCaptureSwitch()
  const captured = {}

  for (const mode of ['off', 'on']) {
    for (const build of SCENARIOS) {
      const scenario = build()
      harness.setMode(mode)
      const { observed, refs } = await observeScenario(harness, scenario)
      if (mode === 'off') delete observed.demandEvidenceFingerprint
      if (CAPTURE) {
        captured[`${mode}:${scenario.name}`] = observed
        continue
      }
      const expected = { ...GOLDEN[scenario.name] }
      if (mode === 'off') delete expected.demandEvidenceFingerprint
      await run(`[${mode}] ${scenario.name}: every hash and identity matches the ${GOLDEN_BASE_SHA.slice(0, 9)} golden`, () => {
        assert.deepEqual(observed, expected)
      })
      await run(`[${mode}] ${scenario.name}: the reader attached a record reference to every existing row (the identity is not vacuous)`, () => {
        const expectedRefs = scenario.existingRows.map((entry) => ({ id: entry.id, version: entry.version }))
        assert.deepEqual(refs.reader, expectedRefs)
        if (scenario.large) assert.deepEqual(refs.large, expectedRefs)
      })
    }
  }

  if (CAPTURE) {
    console.log(stableStringify(captured))
    console.log('SCC_CAPTURE: printed, no assertions run')
    return
  }

  await run('the record reference is the planner\'s exported Symbol.for key', () => {
    const planner = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
    assert.equal(planner.EXISTING_ROW_RECORD_REF, RECORD_REF)
  })

  console.log(`stock-preparation-continuation-golden: ${passed} passed, ${failed} failed`)
  if (failed > 0) throw new Error(`${failed} check(s) failed`)
}

require('./support/fail-closed-suite-runner.cjs').runFailClosedMain('stock-preparation-continuation-golden.test.cjs', main)
