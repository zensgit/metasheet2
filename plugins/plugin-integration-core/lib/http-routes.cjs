'use strict'

const crypto = require('node:crypto')

// ---------------------------------------------------------------------------
// HTTP routes — plugin-integration-core
//
// Thin REST control plane over the plugin-local registries and runner. The
// route layer handles auth/tenant scoping and error shaping; business behavior
// stays in the underlying services.
// ---------------------------------------------------------------------------

const ROUTES = [
  ['GET', '/api/integration/status', 'status'],
  ['GET', '/api/integration/internal/k3-wise/call-audit', 'k3WiseCallAudit'],
  ['GET', '/api/integration/adapters', 'adaptersList'],
  // 对接总览 — ONE read that answers "对接了哪些系统、各用哪个连接、谁在用、状态如何". Read-tier,
  // read-only, values-free: it joins the external-system registry to the data_sources DISPLAY
  // descriptor (name/type/status only), to the server-held stock-prep table-action binding, to
  // pipelines, and to approved read-source configs/compositions. It mutates nothing and grants no
  // authority the read tier did not already have — every input is a read this same principal can
  // already perform one endpoint at a time.
  ['GET', '/api/integration/hub/overview', 'integrationHubOverview'],
  ['GET', '/api/integration/external-systems', 'externalSystemsList'],
  ['POST', '/api/integration/external-systems', 'externalSystemsUpsert'],
  ['GET', '/api/integration/external-systems/:id', 'externalSystemsGet'],
  ['DELETE', '/api/integration/external-systems/:id', 'externalSystemsDelete'],
  ['POST', '/api/integration/external-systems/:id/test', 'externalSystemsTest'],
  ['POST', '/api/integration/external-systems/:id/read-smoke', 'externalSystemReadSmoke'],
  ['POST', '/api/integration/external-systems/:id/read-source-probe', 'externalSystemReadSourceProbe'],
  ['POST', '/api/integration/read-source-configs', 'readSourceConfigsSave'],
  ['GET', '/api/integration/read-source-configs', 'readSourceConfigsList'],
  ['GET', '/api/integration/read-source-configs/:id', 'readSourceConfigsGet'],
  ['GET', '/api/integration/read-source-configs/:id/audit', 'readSourceConfigsAudit'],
  ['POST', '/api/integration/read-source-configs/:id/approve', 'readSourceConfigsApprove'],
  ['POST', '/api/integration/read-source-configs/:id/retire', 'readSourceConfigsRetire'],
  ['POST', '/api/integration/read-source-configs/:id/read', 'readSourceConfigsRead'],
  ['POST', '/api/integration/read-source-compositions', 'readSourceCompositionsSave'],
  ['GET', '/api/integration/read-source-compositions', 'readSourceCompositionsList'],
  ['GET', '/api/integration/read-source-compositions/:id', 'readSourceCompositionsGet'],
  ['GET', '/api/integration/read-source-compositions/:id/audit', 'readSourceCompositionsAudit'],
  ['POST', '/api/integration/read-source-compositions/:id/approve', 'readSourceCompositionsApprove'],
  ['POST', '/api/integration/read-source-compositions/:id/retire', 'readSourceCompositionsRetire'],
  ['POST', '/api/integration/read-source-compositions/:id/run', 'readSourceCompositionsRun'],
  // BA-APPLY-2a (design-lock docs/development/bridge-agent-controlled-apply-design-lock-20260708.md
  // §2 形态 B backend channel): approval gate + values-free checklist staging ONLY. NO route here
  // ever writes to the Bridge Agent or applies anything — GET :id is the approval gate itself
  // (approved-only, fail-closed on draft/retired).
  ['POST', '/api/integration/bridge-agent-checklists', 'bridgeAgentChecklistsSave'],
  ['GET', '/api/integration/bridge-agent-checklists/:id', 'bridgeAgentChecklistsGet'],
  ['POST', '/api/integration/bridge-agent-checklists/:id/approve', 'bridgeAgentChecklistsApprove'],
  ['POST', '/api/integration/bridge-agent-checklists/:id/retire', 'bridgeAgentChecklistsRetire'],
  ['GET', '/api/integration/external-systems/:id/objects', 'externalSystemObjects'],
  ['GET', '/api/integration/external-systems/:id/schema', 'externalSystemSchema'],
  ['GET', '/api/integration/pipelines', 'pipelinesList'],
  ['POST', '/api/integration/pipelines', 'pipelinesUpsert'],
  ['GET', '/api/integration/pipelines/:id', 'pipelinesGet'],
  ['POST', '/api/integration/pipelines/:id/run', 'pipelinesRun'],
  ['POST', '/api/integration/pipelines/:id/dry-run', 'pipelinesDryRun'],
  ['POST', '/api/integration/pipelines/:id/external-write/dry-run', 'pipelinesExternalWriteDryRun'],
  ['POST', '/api/integration/pipelines/:id/external-write/apply', 'pipelinesExternalWriteApply'],
  ['GET', '/api/integration/table-actions', 'tableActionsList'],
  ['POST', '/api/integration/table-actions/:actionId/dry-run', 'tableActionDryRun'],
  ['POST', '/api/integration/table-actions/:actionId/mvp-persist', 'tableActionMvpPersist'],
  ['POST', '/api/integration/table-actions/:actionId/apply', 'tableActionApply'],
  ['POST', '/api/integration/table-actions/:actionId/large-bom/expansion-jobs', 'tableActionLargeBomExpansionJobStart'],
  ['GET', '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId', 'tableActionLargeBomExpansionJobGet'],
  ['POST', '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/run', 'tableActionLargeBomExpansionJobRun'],
  ['POST', '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/plan', 'tableActionLargeBomExpansionJobPlan'],
  ['POST', '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs', 'tableActionLargeBomApplyJobStart'],
  ['GET', '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs/:applyJobId', 'tableActionLargeBomApplyJobGet'],
  ['POST', '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/apply-jobs/:applyJobId/run', 'tableActionLargeBomApplyJobRun'],
  ['POST', '/api/integration/table-actions/:actionId/large-bom/expansion-jobs/:jobId/cancel', 'tableActionLargeBomExpansionJobCancel'],
  ['GET', '/api/integration/table-actions/:actionId/conflict-policies', 'tableActionConflictPoliciesList'],
  ['PUT', '/api/integration/table-actions/:actionId/conflict-policies', 'tableActionConflictPoliciesSave'],
  ['DELETE', '/api/integration/table-actions/:actionId/conflict-policies', 'tableActionConflictPoliciesDelete'],
  // B-stage confirmation-decision LEDGER, first cut (duplicate_expanded_key x keep_multiple_rows
  // only). Reconcile repeats the readonly table-action plan SERVER-SIDE and persists values-free
  // decision metadata into the one managed supporting ledger table — no plan row is applied and no
  // request-supplied plan/revision is accepted. Admin-gated.
  ['POST', '/api/integration/table-actions/:actionId/confirmation-decisions/reconcile', 'tableActionConfirmationDecisionsReconcile'],
  // DEPLOYMENT PREFLIGHT — ONE call answering "is this deployment ready to run stock-prep, and if
  // not, exactly what do I run to fix it". It aggregates the readiness checks below plus the two
  // things none of them ever mentioned: the customer pack's OWN declared target, and the sandbox
  // WRITE authorization env allowlist. Read-only: it inspects and it provisions nothing.
  //
  // Gated on stock-prep:read (platform admin satisfies it as everywhere else), not on 'admin': the
  // whole point is that the operator who has to fix the deployment can see what is wrong, and the
  // response is values-free evidence — ids, counts, env KEY names — with no provisioning power.
  ['GET', '/api/integration/stock-preparation/preflight', 'stockPreparationPreflight'],
  // 源就绪预检 + 拓扑自测 — SOURCE PREFLIGHT. The deployment preflight above answers "is OUR side
  // ready"; this one answers the half that had no answer at all: is the CUSTOMER'S source reachable,
  // does it hold real BOM data, and WHICH schema shape is it — measured, not assumed. It ends with
  // the self-validating check: the measured bridge against the bridge the configured read plan
  // assumes, so "configured for the order module against a DesignBom-shaped source" is a loud
  // refusal instead of a run that expands zero rows and calls it success.
  //
  // Read-only, and read-TIER (`requireAccess(req, 'read')` — integration:read/write, or platform
  // admin). That tier is a deliberate choice between two live precedents, so it is stated here
  // rather than left to be inferred:
  //   - `externalSystemObjects` / `externalSystemSchema` construct an adapter and reach the source
  //     AT THE READ TIER already; this is the same class of act.
  //   - `externalSystemReadSmoke` / `externalSystemReadSourceProbe` sit at WRITE, on the rule that an
  //     active credentialed outbound probe is never end-user reachable.
  // What puts this one on the read side of that line is that it is fully non-steerable and produces
  // no data plane: the object roster is derived from the SERVER-held read plan (a request cannot name
  // an object), the page size is a module constant (a request cannot widen it), no filter, key or
  // page input exists, nothing is persisted, no B2a claim is consumed, and the response is shapes,
  // counts and closed-vocabulary codes checked by a values-free self-check before it is returned.
  // It is also NOT `stock-prep:read`: stock-preparation-workbench-access.cjs holds that triggering a
  // source read against the customer's system is an owner-level act and not a queue-operator one, and
  // that ruling is respected here — the stock-prep namespace does not open this route.
  ['GET', '/api/integration/stock-preparation/source-preflight', 'stockPreparationSourcePreflight'],
  ['GET', '/api/integration/stock-preparation/target/readiness', 'stockPreparationTargetReadiness'],
  ['POST', '/api/integration/stock-preparation/target/ensure', 'stockPreparationTargetEnsure'],
  ['GET', '/api/integration/stock-preparation/sandbox-target/readiness', 'stockPreparationSandboxTargetReadiness'],
  ['POST', '/api/integration/stock-preparation/sandbox-target/ensure', 'stockPreparationSandboxTargetEnsure'],
  ['POST', '/api/integration/stock-preparation/options/sync', 'stockPreparationOptionsSync'],
  // #3751 MVP: provision the 9 frozen MVP tables (readonly-internal, structure-only, admin-gated).
  ['GET', '/api/integration/stock-preparation/mvp/readiness', 'stockPreparationMvpReadiness'],
  ['POST', '/api/integration/stock-preparation/mvp/ensure', 'stockPreparationMvpEnsure'],
  ['POST', '/api/integration/stock-preparation/mvp/options/sync', 'stockPreparationMvpOptionsSync'],
  ['POST', '/api/integration/stock-preparation/mvp/sync/plan', 'stockPreparationMvpSyncPlan'],
  // #3751 MVP: COMMIT a previewed sync-run plan — persist its rows into the 9 internal MVP tables
  // (internal-only via target-scoped records API, idempotent, immutable, admin-gated, values-free).
  ['POST', '/api/integration/stock-preparation/mvp/sync/persist', 'stockPreparationMvpSyncPersist'],
  // #3889: approved readonly config -> normalized stock-preparation intake. The request selects a
  // stored config by reference; raw rows, paths, SQL, credentials, and write controls are absent.
  ['POST', '/api/integration/stock-preparation/mvp/source-runs/plm-bom', 'stockPreparationPlmBomSourceRun'],
  ['POST', '/api/integration/stock-preparation/mvp/source-runs/erp-materials', 'stockPreparationErpMaterialSourceRun'],
  // T2: COMMIT already-normalized ERP/K3 material-master intake rows into erp_material_master (the
  // internal cache confirm-writes.cjs / generation-runtime.cjs already read from). Upsert, not
  // immutable; own 'erp_material_sync' run record; NOT project-scoped (tenant-level cache).
  ['POST', '/api/integration/stock-preparation/mvp/erp-materials/sync', 'stockPreparationErpMaterialSync'],
  // #4163 T1: readonly, values-free PROJECT list (FE view 1, the project workspace / selector — the
  // deep-link entry point into views 2-6). read-gated (broader than the rest of this module).
  ['GET', '/api/integration/stock-preparation/projects', 'stockPreparationProjectList'],
  // #3751 MVP view 2: readonly snapshot-batch LIST + DIFF reads (queryRecords-only, admin-gated,
  // values-free). List is exact-path; diff carries the batch id in the path.
  ['GET', '/api/integration/stock-preparation/snapshot-batches', 'stockPreparationSnapshotBatchList'],
  ['GET', '/api/integration/stock-preparation/snapshot-batches/:snapshotBatchId/diff', 'stockPreparationSnapshotDiff'],
  // #3751 MVP W3 (diff rows): per-row diffType/changeTypes/reviewStatus browse for view 2 — closed
  // 11-key projection, optional caller-chosen base pair, optional enum filters, capped fail-closed.
  ['GET', '/api/integration/stock-preparation/snapshot-batches/:snapshotBatchId/diff/rows', 'stockPreparationSnapshotDiffRows'],
  // #3751 MVP W3 (confirm reads): values-free confirmation-state summaries + review-queue lists for
  // FE views 3/4 (queryRecords-only; unit candidates COMPUTED per read, never persisted).
  ['GET', '/api/integration/stock-preparation/material-mappings/summary', 'stockPreparationMaterialMappingSummary'],
  ['GET', '/api/integration/stock-preparation/material-mappings/candidates', 'stockPreparationMaterialMappingCandidates'],
  ['GET', '/api/integration/stock-preparation/unit-conversions/summary', 'stockPreparationUnitConversionSummary'],
  ['GET', '/api/integration/stock-preparation/unit-conversions/candidates', 'stockPreparationUnitConversionCandidates'],
  // #3751 MVP W3 (confirm writes): candidate-sync feeds the mapping review queue; confirm/retire are
  // the human confirmation surface over the two confirmation tables (multitable-internal only,
  // admin-gated, server-stamped confirmedBy/confirmedAt, values-free).
  ['POST', '/api/integration/stock-preparation/material-mappings/candidates/sync', 'stockPreparationMaterialMappingCandidatesSync'],
  ['POST', '/api/integration/stock-preparation/material-mappings/confirm', 'stockPreparationMaterialMappingConfirm'],
  ['POST', '/api/integration/stock-preparation/material-mappings/retire', 'stockPreparationMaterialMappingRetire'],
  ['POST', '/api/integration/stock-preparation/unit-conversions/confirm', 'stockPreparationUnitConversionConfirm'],
  ['POST', '/api/integration/stock-preparation/unit-conversions/retire', 'stockPreparationUnitConversionRetire'],
  // W4b (execution-plan general-prep-execution-plan-20260722.md:125): the K2 carry confirm — the
  // human confirms a CARRY_VIA_CONFIRM proposal and the server carries the inactive predecessor's
  // human fields onto the re-keyed row (applyCarryViaConfirm: admin-gated, closed body allowlist,
  // server-stamped carriedBy/carriedAt, no-overwrite, values-free audit). Optionally closes the
  // matching carry ledger row (decisionId + inputFingerprint together).
  ['POST', '/api/integration/stock-preparation/carry/confirm', 'stockPreparationCarryConfirm'],
  // #3751 MVP W4 (generation runtime): run the landed generation engine over CONFIRMED inputs and
  // persist draft prep lines + blocking exceptions + a run record (multitable-internal only); human
  // exception resolution single + bulk (same-reason gate). ready is computed SERVER-SIDE: engine
  // 'ready' AND zero unresolved blocking exceptions — never frontend-derived.
  ['POST', '/api/integration/stock-preparation/generation/run', 'stockPreparationGenerationRun'],
  ['POST', '/api/integration/stock-preparation/exceptions/resolve', 'stockPreparationExceptionResolve'],
  ['POST', '/api/integration/stock-preparation/exceptions/bulk-resolve', 'stockPreparationExceptionBulkResolve'],
  // #3751 MVP W5 (queue reads): values-free exception queue (view 6) + prep-line summary (view 5).
  // Value-bearing detail reads (drawing numbers / quantities / unit symbols) stay OWNER-GATED.
  ['GET', '/api/integration/stock-preparation/exceptions', 'stockPreparationExceptionList'],
  ['GET', '/api/integration/stock-preparation/prep-lines', 'stockPreparationPrepLineList'],
  // 按项目导出物料 Excel — 仓库/采购 export THIS PROJECT's plm_stock_preparation_main rows to xlsx after
  // the approval chain completes. Static literal segment before the bare '/prep-lines' collection GET
  // above cannot collide (no '/prep-lines/:id' route exists). VALUE-BEARING (material names,
  // quantities), unlike the values-free /prep-lines summary above, so it does NOT ride the same
  // stock-prep:read tier — see the handler for the gate choice and its justification.
  ['GET', '/api/integration/stock-preparation/prep-lines/export', 'stockPreparationPrepLineExport'],
  // 一线看得见自己工厂的项目 — the OPERATOR-scoped project directory/worklist. A SIBLING of the
  // values-free '/stock-preparation/projects' route above, never a widening of it: that one keeps its
  // byte-identical values-free projection for the platform/admin workspace, this one carries the
  // caller's OWN tenant's project NUMBER and NAME so a floor operator can find their project by name
  // instead of memorising that 230920006 is the RY2 注射水缓冲罐部件. VALUE-BEARING, so it rides
  // stock-prep:operate (the same tier as value-entry and the Excel export), and its tenant is derived
  // from the AUTHENTICATED principal with the host vouching for the pairing — see the handler.
  ['GET', '/api/integration/stock-preparation/operator/projects', 'stockPreparationOperatorProjectDirectory'],
  // 通知下一步 —— 备料多人接力的交接。Several people each fill their OWN fields on a project's prep
  // rows in an agreed order; this pair is "whose turn is it" and "I'm done, tell the next one". Both
  // are VALUES-FREE (step keys from a closed vocabulary, cursor integers, booleans, handler COUNTS),
  // unlike the export above — so the read rides the broad stock-prep:read queue-watcher tier and only
  // the advance rides the OPERATE write tier. See stock-preparation-handoff.cjs for what this is (a
  // visible turn signal) and, emphatically, what it is not (a permission mechanism, an approval
  // graph, or an impersonation of the last approver).
  ['GET', '/api/integration/stock-preparation/handoff', 'stockPreparationHandoffStatus'],
  ['POST', '/api/integration/stock-preparation/handoff/advance', 'stockPreparationHandoffAdvance'],
  // 项目备料页 — ONE project's board: the read behind the operator's single page. A SIBLING of the
  // directory above and gated identically (stock-prep:operate ∧ read, tenant derived from the
  // AUTHENTICATED principal). It carries the caller's own tenant's project number/name plus counts,
  // timestamps and a multitable deep-link HANDLE — never a row value. An unknown number and another
  // tenant's number take the SAME code path to the SAME 404, so this route is not an existence
  // oracle across tenants. Path-addressed by projectNo because the board IS one project; the number
  // never reaches an audit row. See stock-preparation-project-board.cjs.
  ['GET', '/api/integration/stock-preparation/projects/:projectNo/board', 'stockPreparationOperatorProjectBoard'],
  // #3751 MVP W5b (#3890): values-free audit trail over the stock-prep write surface.
  ['GET', '/api/integration/stock-preparation/audit', 'stockPreparationAuditList'],
  // 工作台里选源 — WHICH source the pull action reads, chosen in the workbench instead of in a server
  // env file. Both legs are the integration ADMIN tier: the GET returns the eligible-source picker,
  // i.e. exactly the choices whose Save would succeed, so it is the same authority as the POST and
  // is gated identically rather than at the wider read tier. Taking effect needs no restart — the
  // binding is resolved per request inside the table-action registry, not captured at activation.
  ['GET', '/api/integration/stock-preparation/source-binding', 'stockPreparationSourceBindingGet'],
  ['POST', '/api/integration/stock-preparation/source-binding', 'stockPreparationSourceBindingSet'],
  // B-stage confirmation-decision LEDGER surfaces. Static literal segments precede the bare
  // collection GET so they can never be mis-read as ids. The GET list is the AUTHORITATIVE
  // values-free exception queue of the takeover line (converged ruling); canonical-sheet filter
  // views are auxiliary only.
  //
  // O2 / R-11 permission split (stock-preparation-workbench-access.cjs holds the vocabulary):
  //   readiness, list        -> stock-prep:read     (values-free queue; the operator's entry surface)
  //   value-entry, confirm   -> stock-prep:operate  (the write tier + the author's own value readback)
  //   ensure                 -> platform admin      (PROVISIONS the ledger table — schema authoring,
  //                                                  which R-11 names as what the operator tier must
  //                                                  not open; unchanged by this PR)
  // Reconcile lives on the table-actions block above and also stays platform-admin: it re-runs the
  // readonly plan as a SOURCE READ and, when B2a is armed, consumes an operation claim. Handing a
  // customer operator the ability to trigger source reads is an owner-level decision, so the default
  // stands and this PR does not move it.
  ['GET', '/api/integration/stock-preparation/confirmation-decisions/readiness', 'stockPreparationConfirmationDecisionsReadiness'],
  ['POST', '/api/integration/stock-preparation/confirmation-decisions/ensure', 'stockPreparationConfirmationDecisionsEnsure'],
  ['POST', '/api/integration/stock-preparation/confirmation-decisions/confirm', 'stockPreparationConfirmationDecisionsConfirm'],
  // O1' value unlock: the ONE surface where entered value CONTENTS may cross — a per-decision,
  // admin-gated operator read for the /stock-prep workbench detail pane. The queue (GET list) and
  // every evidence/log payload stay values-free (presence booleans only).
  ['GET', '/api/integration/stock-preparation/confirmation-decisions/value-entry', 'stockPreparationConfirmationDecisionsValueEntry'],
  ['GET', '/api/integration/stock-preparation/confirmation-decisions', 'stockPreparationConfirmationDecisionsList'],
  // CUSTOMER PACK entry point — the executable surface for the config pack line. Admin-gated; the
  // pack itself is NEVER request-supplied (server-held allowlist, see
  // stock-preparation-customer-pack-catalog.cjs). Static paths precede ':packId' so the literal
  // segments can never be captured as a pack id.
  ['GET', '/api/integration/stock-preparation/customer-packs', 'stockPreparationCustomerPackList'],
  ['GET', '/api/integration/stock-preparation/customer-packs/installs', 'stockPreparationCustomerPackInstallList'],
  // Dry run: ZERO writes. Reuses the installer's own pre-scan so what it reports is what install does.
  ['POST', '/api/integration/stock-preparation/customer-packs/:packId/dry-run', 'stockPreparationCustomerPackDryRun'],
  ['POST', '/api/integration/stock-preparation/customer-packs/:packId/install', 'stockPreparationCustomerPackInstall'],
  // 列映射副驾 (schema-mapping copilot) — the first AI feature on the governed AI boundary. PROPOSE
  // gathers the schema signals a human would stare at (opaque columns + dictionary labels + sample
  // shapes), asks the governed boundary (dataClass:'business' → local-only) to PROPOSE per-column
  // meaning with reasoning, and cross-checks each proposal against the deterministic preset discovery.
  // The AI output is ADVISORY, never applied. CONFIRM takes the HUMAN-confirmed semantics and writes a
  // DETERMINISTIC vendor preset (the #5385 schema) — the authoritative artifact. Both integration:admin
  // (configuring a source's mapping). Fail-open: an absent/unavailable boundary degrades to manual.
  ['POST', '/api/integration/stock-preparation/schema-mapping-copilot/propose', 'schemaMappingCopilotPropose'],
  ['POST', '/api/integration/stock-preparation/schema-mapping-copilot/confirm', 'schemaMappingCopilotConfirm'],
  // FOS-2: generic field-option-sync (preset-driven). Stock-prep route above is a compat alias.
  ['POST', '/api/integration/field-options/sync', 'fieldOptionsSync'],
  ['GET', '/api/integration/templates', 'templatesList'],
  ['POST', '/api/integration/templates', 'templatesUpsert'],
  // S3-3: read-only reference-template catalog. MUST precede '/templates/:id' so ':id' can't capture 'references'.
  ['GET', '/api/integration/templates/references', 'templatesReferences'],
  ['GET', '/api/integration/templates/:id', 'templatesGet'],
  ['DELETE', '/api/integration/templates/:id', 'templatesDelete'],
  ['POST', '/api/integration/templates/preview', 'templatesPreview'],
  ['POST', '/api/integration/templates/derive', 'templatesDerive'],
  ['POST', '/api/integration/templates/:id/instantiate', 'templatesInstantiate'],
  ['GET', '/api/integration/staging/descriptors', 'stagingDescriptors'],
  ['POST', '/api/integration/staging/install', 'stagingInstall'],
  ['GET', '/api/integration/runs', 'runsList'],
  ['GET', '/api/integration/provenance', 'provenanceByRow'],
  ['GET', '/api/integration/dead-letters', 'deadLettersList'],
  ['POST', '/api/integration/dead-letters/:id/replay', 'deadLettersReplay'],
]
const STOCK_PREPARATION_SQLSERVER_RUNTIME_ROUTE = Object.freeze([
  'POST',
  '/api/integration/internal/stock-preparation/sqlserver-sealed-snapshot/run',
  'stockPreparationSqlServerSealedSnapshotRun',
])
const EXTERNAL_SYSTEM_OBJECTS_MAX_ITEMS = 1000
// 列映射副驾 (schema-mapping copilot): reuse the deterministic preset-discovery machinery to gather +
// ground the AI's per-column proposals, and the boundary-consuming copilot core. The AI PROPOSES;
// a human CONFIRMS; only confirm produces a deterministic vendor preset (the authoritative artifact).
const schemaMappingCopilot = require('./schema-mapping-copilot.cjs')
const { loadVendorPresetsFromDir } = require('./source-vendor-presets/preset-schema.cjs')
const { sanitizeIntegrationPayload, scrubSecretStringValue } = require('./payload-redaction.cjs')
const { hasPrivateConfigMutation } = require('./external-systems.cjs')
const { createRunLogger } = require('./run-log.cjs')
const { getPath, setPath, transformRecord } = require('./transform-engine.cjs')
// DF-T1-0/DF-T1: compose the no-write preview through the SAME K3 Save-body composer the
// adapter uses, so the preview is byte-identical to the real Save (single source of truth —
// replaces the former divergent applyPreviewReferenceShape/projectRecordForTemplate copies).
// DF-T1 reuses applyReferenceShape (shaping) + findUnfilledPlaceholders (detection); it does
// NOT introduce a new K3 shaper/projector.
const { projectRecordForBody, findUnfilledPlaceholders, applyReferenceShape, isBlankValue } = require('./adapters/k3-save-body-composer.cjs')
const { getK3WiseCallAuditSnapshot } = require('./adapters/k3-wise-call-audit.cjs')
// DF-T3b-2a: from_reference_table resolves a per-material reference via the shared resolver (the
// SAME decision both the preview and the record materializer use, so they cannot diverge).
const { resolveReferenceRuleValue } = require('./reference-mapping-resolver.cjs')
// DF-T3b-2b: live mapping-sheet bulk-read → referenceMappingIndexes for the preview seam (read-only).
const { buildReferenceMappingIndexes } = require('./reference-mapping-source.cjs')
const {
  getReadSmokePreset,
  buildReadSmokeRequest,
  applyReadSmokePresetOverlay,
  readSmokeSuccessEvidence,
  readSmokeErrorEvidence,
  normalizeReadSmokeContract,
} = require('./read-smoke.cjs')
// S2-b (#1709 self-service): fixed locate-container probe runtime. Consumes the S2-a contract only;
// evidence is the S2-a values-free schema on success and failure alike.
const {
  ReadSourceProbeRuntimeError,
  prepareReadSourceProbe,
  executeReadSourceProbe,
} = require('./read-source-probe-runtime.cjs')
// #3889: the executor rejects an execution option it cannot honour (e.g. the record plane for a mode that
// has no single row plane) with the same contract error the request normalizers use.
const { ReadSourceProbeContractError } = require('./read-source-probe-contract.cjs')
// S2-c (#1709 self-service): content-keyed config persistence + values-free audit. Stores the S1
// normalized structure and a systemId reference only — never a resolved URL, credential, or probe response.
const {
  ReadSourceConfigValidationError,
  ReadSourceConfigNotFoundError,
  ReadSourceConfigConflictError,
  ReadSourceConfigNotApprovedError,
} = require('./read-source-config-store.cjs')
// C-R4-1 (#1709 composition): the composition config store error surface (mirrors the read-source-config
// store) — for the composition authoring routes + the approved-only run route error mapping.
const {
  ReadSourceCompositionConfigValidationError,
  ReadSourceCompositionConfigNotFoundError,
  ReadSourceCompositionConfigConflictError,
  ReadSourceCompositionConfigNotApprovedError,
} = require('./read-source-composition-config-store.cjs')
// BA-APPLY-2a: the bridge-agent change-checklist store error surface (mirrors the read-source-config
// store) — for the save/approve/retire routes + the approved-only GET route error mapping. NOTHING
// downstream of these errors ever contacts the Bridge Agent (design-lock hard lock).
const {
  BridgeAgentChecklistValidationError,
  BridgeAgentChecklistNotFoundError,
  BridgeAgentChecklistConflictError,
  BridgeAgentChecklistNotApprovedError,
} = require('./bridge-agent-change-checklist-store.cjs')
// S3-2 (#1709 self-service): runtime-tier configured read — consumes an APPROVED stored config version;
// data plane (mapped values) flows to the authorized caller, evidence stays values-free.
const {
  prepareConfiguredRead,
  executeConfiguredRead,
} = require('./read-source-read-runtime.cjs')
// C-R4-1 (#1709 composition): the chain runtime executor — orchestrates an approved two-hop composition
// read-only. The run route loads the approved composition + each approved step config + system, then
// hands them in; the executor throws only on a client-supplied runtime-request contract violation.
const {
  executeReadSourceComposition,
  ReadSourceCompositionRuntimeError,
} = require('./read-source-composition-runtime.cjs')
const { K3_REFERENCE_MAPPING_TEMPLATES } = require('./reference-mapping-templates.cjs')
const { listReferenceIntegrationTemplates } = require('./reference-integration-templates.cjs')
// DF-T2c: read-only derive route reuses the DF-T2a helper (no duplication; pure compute, no write).
const { deriveK3MaterialTemplateDraft, summarizeTemplateForEvidence, TemplateDeriveError } = require('./connector-template-derive.cjs')
const { validateRecord } = require('./validator.cjs')
const {
  ExternalWriteDryRunError,
  applyExternalWrite,
  dryRunExternalWrite,
} = require('./external-write-dry-run.cjs')
// S1b-3: own metasheet:multitable C6 write target (raw write-source + profile + flat-config derive).
const {
  MULTITABLE_WRITE_TARGET_KIND,
  MULTITABLE_WRITE_PROFILE,
  createMetaSheetMultitableWriteSource,
  deriveMultitablePlannerTargetConfig,
} = require('./adapters/metasheet-multitable-target-adapter.cjs')
const {
  K3_WISE_C6_WRITE_TARGET_KIND,
  K3_WISE_C6_MAX_APPLY_ROWS,
  K3_WISE_C6_WRITE_PROFILE,
  createK3WiseC6WriteSource,
  deriveK3WiseC6PlannerTargetConfig,
} = require('./adapters/k3-wise-c6-write-profile.cjs')
// E4 / G-4 LAYER 1 of FOUR (HG v1.2 §10.2). The permanent K3 external-write fence. Required at
// the ROUTE so the refusal happens before the request can cost anything: no credential reload, no
// dry-run token consumption, no source read, no adapter construction, no wire call.
const { assertK3ExternalWriteRefused } = require('./k3-external-write-permanent-fence.cjs')
// 对接总览 — the pure projection behind GET /api/integration/hub/overview. It performs no I/O; this
// route layer gathers the five already-authorized reads and hands them over. See that module's
// header for the values-free boundary it enforces structurally.
const {
  buildIntegrationHubOverview,
  collectDataSourcePointers,
  describeConnectorKind,
} = require('./integration-hub-overview.cjs')
const {
  PLM_STOCK_PREPARATION_ACTION_ID,
  StockPreparationTableActionError,
  __internals: tableActionInternals,
  applyStockPreparationAction,
  assertProductionCleanRowsWithinBound,
  assertStockPrepApplyAllowed,
  assertStockPrepApplySandboxAllowed,
  assertStockPreparationTargetReady,
  createStockPreparationTableActionRegistry,
  createTargetScopedRecordsApi,
  dryRunStockPreparationAction,
  prepareStockPreparationConfirmationDecisions,
  prepareStockPreparationMvpSnapshot,
  normalizeActionParameters,
  resolveStockPrepApplyProductionPolicy,
  resolveStockPrepApplySandboxPolicy,
} = require('./stock-preparation-table-actions.cjs')
// 备料 batch identity — "物料创建日期(精确到小时)区分同一项目不同批次的物料". Pure and opt-in; see
// stock-preparation-batch-identity.cjs for why the content-revision digest stays the default.
const {
  StockPreparationBatchIdentityError,
  mintStockPreparationBatchIdentity,
  readStockPreparationBatchIdentityMode,
} = require('./stock-preparation-batch-identity.cjs')
// 工作台里选源 — the eligibility contract for the pull action's source, and the durable pointer that
// overrides the deploy-time env default. See stock-preparation-source-binding.cjs for why the
// allowlist is the BOM read kinds and why this line deliberately does NOT reuse the K3 fence token.
const {
  StockPreparationSourceBindingError,
  assertBindableSource,
  listEligibleSources,
  sourceBindingRefusalReason,
} = require('./stock-preparation-source-binding.cjs')
// B-stage confirmation-decision LEDGER (O1' semantics: duplicate_expanded_key; full frozen action
// vocabulary + Q2-A value entry). One managed supporting table; never a canonical-sheet write
// capability (see the module header).
const {
  StockPreparationConfirmationDecisionError,
  inspectConfirmationDecisionTarget,
  ensureConfirmationDecisionTarget,
  reconcileConfirmationDecisions,
  listConfirmationDecisions,
  confirmConfirmationDecision,
  confirmCarryConfirmationDecision,
  assertCarryConfirmDecisionBinding,
  readConfirmationDecisionValueEntry,
  loadConfirmedDuplicatePolicyReview,
} = require('./stock-preparation-confirmation-decisions.cjs')
// O2 / R-11: the confirmation-queue workbench permission vocabulary + capability manifest. Shared
// verbatim with the front end (the web alignment suite imports this same module), so the FE control
// set and the BE gate set cannot drift.
const {
  STOCK_PREP_OPERATE,
  STOCK_PREP_READ,
  isStockPrepPermissionCode,
  operatorMayRunStockPrepPull,
  satisfiesStockPrepAccess,
} = require('./stock-preparation-workbench-access.cjs')
// DEPLOYMENT PREFLIGHT: the one read that aggregates every "this deployment cannot run stock-prep
// yet" condition and names the literal fix for each. It reuses the inspection functions the four
// readiness routes already call — it re-derives no notion of "ready" — and it writes nothing.
const {
  computeStockPreparationPreflight,
} = require('./stock-preparation-preflight.cjs')
// SOURCE PREFLIGHT + TOPOLOGY SELF-TEST: the other half of "is this ready" — the CUSTOMER'S source
// rather than this deployment. It measures reachability, business-data presence, WHICH bridge the
// source uses (order module vs DesignBom) and WHICH generic slot carries the BOM quantity, then
// checks all of that against the configured read plan. Read-only; values-free by self-check.
// (The route path itself is a literal in ROUTES above, which is built before this require runs; the
// suite cross-checks that literal against SOURCE_PREFLIGHT_ROUTE_PATH so the two cannot drift.)
const {
  DECLARABLE_BRIDGES,
  SourcePreflightError,
  runStockPreparationSourcePreflight,
} = require('./stock-preparation-source-preflight.cjs')
const {
  assertAuthoritativeLargeBomExpansion,
  cancelLargeBomBackgroundExpansionJob,
  createLargeBomBackgroundExpansionJob,
  createLargeBomCheckpointApplyJob,
  loadLargeBomBackgroundExpansionJob,
  loadLargeBomCheckpointApplyJob,
  planLargeBomBackgroundExpansionJob,
  publicBackgroundExpansionJob,
  publicCheckpointApplyJob,
  runLargeBomCheckpointApplyJobChunk,
  runLargeBomBackgroundExpansionJob,
} = require('./stock-preparation-large-bom-jobs.cjs')
const {
  buildConflictPolicyReview,
  deleteTableScopeConflictPolicies,
  loadTableScopeConflictPolicies,
  normalizeRunOnlyConflictPolicyReview,
  saveTableScopeConflictPolicies,
} = require('./stock-preparation-conflict-policies.cjs')
const {
  duplicateExpandedKeyDiagnosticsForRows,
} = require('./stock-preparation-conflict-planner.cjs')
const {
  StockPreparationTargetProvisioningError,
  hashEvidenceValue,
  inspectStockPreparationCanonicalTarget,
  ensureStockPreparationCanonicalTarget,
  inspectStockPreparationSandboxTarget,
  ensureStockPreparationSandboxTarget,
  sandboxStockPreparationTemplate,
  // The ONE carry-ownership verdict, shared with the deploy-time preflight so the wall and the
  // warning cannot drift apart.
  CARRY_TARGET_OWNERSHIP_STATES,
  decideCarryTargetOwnership,
} = require('./stock-preparation-target-provisioning.cjs')
const {
  StockPreparationOptionSyncError,
  syncStockPreparationOptions,
  syncStockPreparationSandboxOptions,
  optionSetsFromInput,
} = require('./stock-preparation-option-sync.cjs')
// CUSTOMER PACK entry point. The installer is additive-only (never ensureObject); the catalog is the
// server-held allowlist; the seam turns the install ledger into the planner's optional
// `installedFieldProperties` input.
const {
  StockPreparationCustomerPackInstallError,
  installCustomerPack,
  planCustomerPackInstall,
} = require('./stock-preparation-customer-pack-installer.cjs')
const {
  StockPreparationCustomerPackCatalogError,
  createCustomerPackCatalog,
  resolveCustomerPackCatalogConfig,
} = require('./stock-preparation-customer-pack-catalog.cjs')
const { loadPackInstalledFieldProperties } = require('./stock-preparation-pack-installed-fields.cjs')
// The OTHER half of the pack line: a pack says WHICH tenant `ext_` columns exist, this says WHERE
// their values come from. Server-held and built once at registration, exactly like the catalog
// above. Absent config -> null -> the refresh path is byte-identical to one that never heard of it.
const {
  StockPreparationExtFieldMappingConfigError,
  createConfiguredExtFieldMapping,
} = require('./stock-preparation-ext-field-mapping-config.cjs')
// B2a trial registration. Dormant unless INTEGRATION_CORE_B2A_REGISTRY_PATH is set; once set, every
// gated stock-preparation source read must match a live, in-scope, unexpired entry.
const {
  readPlanSourceObjects,
  B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
  B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
  B2A_PURPOSE_C6_EXTERNAL_WRITE_DRY_RUN,
  B2A_PURPOSE_PIPELINE_RUNNER_READ,
  B2A_PURPOSE_SEALED_SNAPSHOT_SQLSERVER,
  B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
  C6_SAFE_LIFECYCLE_REQUIRED,
  SEALED_SNAPSHOT_BINDING_REF,
  // W-2: the already-asserted run marker. The pipeline fence now stands at this layer AND inside the
  // runner; this is what makes an HTTP-initiated run CONTINUE the claim taken here instead of being
  // refused by the runner as a second run on a spent registration. See the constant's own comment.
  B2A_AUTHORIZED_RUN_ID,
  // R-wave (external review finding 4): the server-side C6 write-lifecycle context. Attached by the
  // two governed write routes below AFTER their own lifecycle checks pass, and required by the
  // runner for any live write — which is what closes the cross-plugin write door. See the constant.
  C6_WRITE_LIFECYCLE_CONTEXT,
  // R-wave (external review finding 3): composes the object list the guard matches against
  // `objectScope`, including an object the source system's server-side config adds behind the read
  // plan's back (`data-source:sql-readonly`'s `lookupProjection.lookupObject`).
  resolveB2aSourceObjects,
  // H-4 (external review finding 4): the runtime artifact-replay refusal. Thrown at THIS layer ahead
  // of the read-authorization claim, so an armed replay the config layer permits no count for is
  // refused before it spends the registration's single operation.
  refuseB2aArtifactReplayNotAuthorized,
  B2aReadAuthorizationError,
  assertB2aReadAuthorization,
  createB2aRegistry,
} = require('./b2a-trial-registry.cjs')
// #3751 MVP: readiness / ensure / option-sync for the 9 frozen MVP tables. Metadata-only,
// structure-only (rows always []), admin-gated, values-free evidence, no external write.
const {
  inspectStockPreparationMvpTargets,
  ensureStockPreparationMvpTargets,
  syncStockPreparationMvpOptions,
} = require('./stock-preparation-mvp-provisioning.cjs')
// #3751 MVP: readonly BOM-snapshot sync-RUN PLAN orchestrator. Pure/deterministic; composes the landed
// mapper + diff engines into a values-free plan (batch + lines + run + diff + flags). Persists nothing,
// admin-gated, no external/PLM/K3 write path.
const { planBomSnapshotSyncRun } = require('./stock-preparation-sync-run-plan.cjs')
// #3751 MVP: COMMIT step for a previewed sync-run plan. Recomputes the deterministic plan and persists
// its batch + line + run rows into the internal MVP tables via a target-scoped records API — the FIRST
// business-row write. Internal-only (structural), idempotent, immutable, admin-gated, values-free.
const { persistStockPreparationSyncRun } = require('./stock-preparation-sync-run-persist.cjs')
// T3b-1c: the pure intake→persist bridge (OD-3) + the pre-I/O structural config guard (OD-3 amendment).
// Both are pure — the route stays the only place that sequences them against real I/O.
const {
  assertPlmAutoPersistSourceConfigSafe,
  buildPlmSourcePersistInput,
} = require('./stock-preparation-plm-source-persist-bridge.cjs')
// #3889: approved PLM / ERP-K3 readonly config -> existing pure intake contract. Routes return only
// the values-free projection; normalized rows remain an internal backend data plane.
const {
  publicReadonlySourceRunResult,
  runErpMaterialReadonlySource,
  runPlmBomReadonlySource,
} = require('./stock-preparation-readonly-source-run.cjs')
// T2 (#3751): COMMIT step for ALREADY-NORMALIZED ERP/K3 material-master intake rows (the shape
// stock-preparation-readonly-source-run.cjs's runErpMaterialReadonlySource / normalizeStockPreparation-
// ReadonlyIntake produce) into the internal erp_material_master CACHE table. Own module / own
// 'erp_material_sync' run type — NOT bolted onto persistStockPreparationSyncRun (a BOM-snapshot commit
// with an unrelated project/batch scope); mirrors how generation-runtime.cjs earns 'prep_generate' in
// its own committer. Internal-only (structural), upsert (cache refresh, not immutable), admin-gated,
// values-free. NOT project-scoped (same reasoning as the ERP source-run request allowlist below).
const { persistStockPreparationErpMaterialSync } = require('./stock-preparation-erp-material-sync-persist.cjs')
// #3751 MVP view 2: READONLY snapshot-batch LIST + DIFF read endpoints. queryRecords-only; admin-gated;
// values-free; TWO-project split (staging locator via resolveIntegrationStagingProjectId vs business
// project row filter). Persists nothing, no external / PLM / K3 write path.
const {
  listSnapshotBatches,
  getSnapshotDiff,
  listSnapshotDiffRows,
} = require('./stock-preparation-snapshot-reads.cjs')
// #4163 T1: READONLY project LIST (FE view 1, the project workspace / selector). queryRecords-only;
// READ-gated (broader than the rest of this module — see the route); values-free (projectName /
// sourceProjectNo never cross, OWNER-GATED OD-W3-1, not opened here).
const { listStockPreparationProjects } = require('./stock-preparation-project-reads.cjs')
// 一线看得见自己工厂的项目: the OPERATOR-tier sibling of the read above. Carries the caller's OWN
// tenant's projectNo + projectName; the values-free module it sits beside is not modified.
const {
  StockPreparationOperatorDirectoryError,
  listOperatorProjectDirectory,
} = require('./stock-preparation-operator-project-directory.cjs')
// 项目备料页 — ONE project's board. The fourth value-bearing stock-prep read; it rides the SAME
// operator value scope as the directory above and returns a frozen key set (numbers, names, counts,
// timestamps, handles), never a row value. See the module header.
const {
  STOCK_PREPARATION_PROJECT_BOARD_AUDIT_ACTION,
  STOCK_PREPARATION_PROJECT_BOARD_MODES,
  StockPreparationProjectBoardError,
  readOperatorProjectBoard,
} = require('./stock-preparation-project-board.cjs')
// ...and THE capability that decides whose data the caller may be shown. It is the one place a
// value-bearing read establishes "whose data is it", and it refuses a principal with no tenant of
// its own — which is how the platform/consultant side stays out of this surface.
const {
  StockPreparationOperatorScopeError,
  resolveOperatorValueScope,
} = require('./stock-preparation-operator-scope.cjs')
// #3751 MVP W3 (diff rows): route-level enum gates for the diff-row filters come from the SAME frozen
// vocabularies the engine exports (never re-typed literals).
const { DIFF_TYPES: STOCK_PREPARATION_DIFF_TYPES, REVIEW_STATUSES: STOCK_PREPARATION_REVIEW_STATUSES } = require('./stock-preparation-snapshot-diff.cjs')
// #3751 MVP W3: HUMAN CONFIRM writes for the material-mapping / unit-conversion-rule tables (plus the
// candidate-sync that feeds the review queue). Multitable-internal only (target-scoped records API
// over the frozen MVP sheets under the STAGING project); confirmedBy is the route user identity and
// confirmedAt is stamped in the module — the request body can carry NEITHER (closed allowlists).
const {
  syncMaterialMappingCandidates,
  confirmMaterialMapping,
  retireMaterialMapping,
  confirmUnitConversionRule,
  retireUnitConversionRule,
  // W4a: the ONE consumer of a CARRY_VIA_CONFIRM decision — the K2 carry write
  // onto the canonical sheet's human band (server-stamped, no-overwrite).
  applyCarryViaConfirm,
} = require('./stock-preparation-confirm-writes.cjs')
// #3751 MVP W3: READONLY confirmation-state reads for FE views 3/4 (summaries + review queues;
// queryRecords-only; unit candidates computed per read; values-free rows).
const {
  getMaterialMappingSummary,
  listMaterialMappingCandidates,
  getUnitConversionSummary,
  listUnitConversionCandidates,
  listStockPreparationExceptions,
  listStockPreparationPrepLines,
} = require('./stock-preparation-confirm-reads.cjs')
// #3751 MVP W4: generation run + human exception resolution. resolvedBy is the route user identity;
// resolvedAt is stamped in the module — the body can carry neither (closed allowlists).
const {
  runStockPreparationGeneration,
  resolveStockPreparationException,
  bulkResolveStockPreparationExceptions,
} = require('./stock-preparation-generation-runtime.cjs')
const { MATCH_STATUSES: STOCK_PREPARATION_MATCH_STATUSES } = require('./stock-preparation-material-match.cjs')
// FOS-4: canonical stock-prep objectId — readiness is bound per TARGET, so any preset targeting this
// table (v1 replace + the disable-missing prove-the-path preset) reuses the canonical readiness check.
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require('./stock-preparation-templates.cjs')
// 按项目导出物料 Excel: reads the ACTIVE plm_stock_preparation_main rows of one business project,
// projected to the agreed EXPORT_COLUMNS. Structurally read-only; never touches xlsx itself.
const {
  exportStockPreparationPrepLines,
  stockPreparationProjectHasMainRows,
} = require('./stock-preparation-prep-line-export.cjs')
// 通知下一步: the pure half of the 备料 handoff — the closed step vocabulary, the deploy-config parse,
// the compare-and-set advance decision, and the values-free notification bodies. No I/O of its own.
const {
  parseStockPreparationHandoffConfig,
  planStockPreparationHandoffAdvance,
  buildStockPreparationHandoffNotification,
  chainHasDestinationForHop,
  assertStockPreparationHandoffNotifyOutcome,
  projectHandoffSteps,
  isHandlerOfStep,
} = require('./stock-preparation-handoff.cjs')
// The shared shape rule for a 备料 business project number. See stock-preparation-common.cjs for why
// this is a HANDLE and not free text: the same string reaches a record filter, an append-only audit
// row, a durable cursor row and a DingTalk markdown body.
const { isValidStockPrepProjectNo } = require('./stock-preparation-common.cjs')
// FOS-2: generic field-option-sync route — resolve a FOS preset (FOS-1 catalog), validate operator
// option sets against the preset's source keys, and patch each mapped field's options + generic
// `fieldOptionSync` metadata through the SAME kernel stock-prep uses (no parallel write path).
const { syncFieldOptions } = require('./field-option-sync-runtime.cjs')
const {
  FieldOptionSyncContractError,
  listFieldOptionSyncPresets,
} = require('./field-option-sync-contract.cjs')
// FOS-4b-2: validate action-binding REFERENCES (registry ∩ preset.permittedActionIds) for the dry-run path.
// Used ONLY in dryRun mode — no apply/write/execution (that's a later, separately-gated sub-slice).
const { normalizeFieldOptionActionBinding } = require('./field-option-action-registry.cjs')

class HttpRouteError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'HttpRouteError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function sendJson(res, status, body) {
  if (typeof res.status === 'function') {
    return res.status(status).json(body)
  }
  res.statusCode = status
  return res.json(body)
}

function sendOk(res, data, status = 200) {
  return sendJson(res, status, { ok: true, data })
}

function sendError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : inferHttpStatus(error)
  const code = inferErrorCode(error)
  const message = error.message || 'Internal server error'
  const details = error.details ? sanitizeIntegrationPayload(error.details) : undefined
  return sendJson(res, status, {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  })
}

// THE CARRY TENANT WALL — "is the sheet this deployment is bound to the CALLER'S sheet?"
//
// WHAT THIS IS NOT ANY MORE. The first cut asked whether `target.sheetId` equalled
// `findObjectSheet(callerProject, target.objectId).id`, i.e. whether the two halves of the binding
// were derived from one tuple. That is a binding-SHAPE rule, not a tenancy proof, and nothing else
// in this line maintains it: `normalizeTarget` accepts any sheetId and defaults objectId
// independently, the sandbox apply gate reads ONLY objectId, and the writer / export / conflict
// policies take sheetId verbatim. A binding whose two halves name different tuples is therefore a
// state this codebase accepts everywhere else — and pre-registry installs, whose sheets were
// provisioned before the ownership registry existed, are in exactly that state through no fault of
// their own. The derived-id rule refused all of them while apply, dry-run and the export kept
// working, and it blamed "tenancy" for what was a shape mismatch, sending an operator after a
// tenant/membership problem that did not exist.
//
// WHAT OWNERSHIP ACTUALLY IS. `meta_sheets` carries no project column; a sheet's project survives
// only inside its derived id, which is one-way and — as above — is not an invariant. The one place
// ownership is RECORDED is `plugin_multitable_object_registry` (sheet_id -> project_id), written by
// plugin-scoped `provisioning.ensureObject`. So the wall asks the registry, through the host port
// `isSheetOwnedByProject`, whether the bound sheet belongs to the CALLER's staging project.
// A hand-bound sheet that the caller's own tenant really provisioned passes — which is precisely the
// 222 window shape — and a sheet owned by another tenant is refused however its id was derived.
//
// THE PORT IS A BOOLEAN, NOT AN OWNER. Asking "who owns this sheet" would hand the answer to a
// caller who may not be entitled to it: the plugin-scope guard can only narrow by project
// NAMESPACE, and every tenant of this plugin shares `integration-core`, so a foreign tenant's
// project id would pass that guard on its way back out. Asking "is it THIS project's" leaks
// nothing — the caller already knows the project it named. The cost is that "owned by someone
// else" and "not registered at all" become one answer, which is why the derived-id fallback below
// exists and why a false answer is never by itself the final word.
//
// THE REGISTRY MISS IS NOT A PASS. A sheet with no registry row is not "yours", it is
// "unattributable" (a pre-registry legacy install, or an id nothing ever provisioned). For a WRITE
// that lands human work in a customer's table, an unprovable owner must not be treated as
// permission — so a miss falls back to the only other evidence there is, the derived id, and refuses
// with its OWN code when that fails too. The two refusals say different things on purpose, because
// they send an operator to different places.
//
// Values-free: refusals name the objectId (a public config identifier) and nothing else — never a
// sheet id, never a project id, never a row.
async function assertCarryTargetBelongsToTenant({ provisioning, targetProjectId, target } = {}) {
  const boundSheetId = target && typeof target.sheetId === 'string' ? target.sheetId.trim() : ''
  const objectId = target && typeof target.objectId === 'string' ? target.objectId.trim() : ''
  if (!boundSheetId || !objectId) {
    throw new HttpRouteError(409, 'CONFIRM_CARRY_TARGET_TENANT_MISMATCH', 'the bound stock-preparation target cannot be attributed to a tenant', { objectId: objectId || null })
  }
  // REACHABLE, and deliberately so: the caller hands this the RAW host surface rather than a helper
  // that has already refused on its own terms, so a host without the ownership port fails here, with
  // the code that names what is missing, instead of behind a generic provisioning 503.
  if (!provisioning || typeof provisioning.isSheetOwnedByProject !== 'function') {
    throw new HttpRouteError(501, 'CONFIRM_CARRY_PROVISIONING_UNAVAILABLE', 'the carry tenant check requires multitable.provisioning.isSheetOwnedByProject', { requiredMethods: ['isSheetOwnedByProject'] })
  }
  const ownedByProject = await provisioning.isSheetOwnedByProject(boundSheetId, targetProjectId) === true
  // The derived id is the ONLY fallback evidence, and it is gathered only when ownership was not
  // proven — a pure hash, no IO. THE VERDICT ITSELF IS NOT DECIDED HERE: it comes from
  // `decideCarryTargetOwnership`, the same function the deploy-time preflight calls, so what an
  // operator was warned about and what their click returns cannot drift apart.
  const derive = !ownedByProject && typeof provisioning.getObjectSheetId === 'function'
    ? provisioning.getObjectSheetId
    : null
  const derivedSheetId = derive ? String(derive.call(provisioning, targetProjectId, objectId) || '') : ''
  const verdict = decideCarryTargetOwnership({ boundSheetId, objectId, ownedByProject, derivedSheetId })
  if (verdict.ok) return
  throw new HttpRouteError(409, verdict.refusalCode, CARRY_TARGET_OWNERSHIP_MESSAGES[verdict.state], { objectId })
}

// One message per refusing state. Values-free: they name no sheet id and no project id.
const CARRY_TARGET_OWNERSHIP_MESSAGES = Object.freeze({
  [CARRY_TARGET_OWNERSHIP_STATES.NOT_OWNED]: 'the sheet this deployment is bound to is not registered to the project of this caller, and its id is not the one derived for that project either',
  [CARRY_TARGET_OWNERSHIP_STATES.UNDECIDABLE]: 'the bound sheet is not registered to this project and this host exposes no id derivation to fall back on, so its owner cannot be established',
  [CARRY_TARGET_OWNERSHIP_STATES.UNBOUND]: 'the bound stock-preparation target cannot be attributed to a tenant',
})

function inferDataSourceBridgeErrorCode(error) {
  const code = error && error.code ? String(error.code) : ''
  if (/^DATA_SOURCE_/.test(code)) return code
  const message = error && error.message ? String(error.message) : ''
  if (message === 'data source read requires an owner principal (none provided)') {
    return 'DATA_SOURCE_PRINCIPAL_REQUIRED'
  }
  if (/^Data source with id '[^']+' not found$/.test(message)) {
    return 'DATA_SOURCE_NOT_FOUND'
  }
  if (/^data source '[^']+' is writable; the read-only bridge refuses a writable binding$/.test(message)) {
    return 'DATA_SOURCE_NOT_READ_ONLY'
  }
  return ''
}

function inferErrorCode(error) {
  const dataSourceCode = inferDataSourceBridgeErrorCode(error)
  if (dataSourceCode) return dataSourceCode
  return error.code || error.name || 'INTERNAL_ERROR'
}

function inferHttpStatus(error) {
  const name = error && error.name ? String(error.name) : ''
  if (inferDataSourceBridgeErrorCode(error)) return 422
  if (error instanceof ExternalWriteDryRunError) return error.status
  if (error instanceof StockPreparationTableActionError) return error.status
  // 工作台里选源: a 404 for "not found" (so another tenant's id, a deleted one and a typo look
  // identical) and a 422 for every eligibility refusal. Mapped here so an ineligible pick can never
  // reach the admin as an untyped 500 — the reason token is what tells them which property failed.
  if (error instanceof StockPreparationSourceBindingError) return error.status
  if (error instanceof StockPreparationOptionSyncError) return error.status
  if (error instanceof StockPreparationCustomerPackInstallError) return error.status
  if (error instanceof StockPreparationCustomerPackCatalogError) return error.status
  // Registration-time only in practice (the mapping is built once, before any request), but mapped
  // anyway so it can never surface as an untyped 500 if a future call site builds one lazily.
  if (error instanceof StockPreparationExtFieldMappingConfigError) return error.status
  // B2a refusals are 403 and B2a config faults are 500; both already carry `.status`, which
  // `sendError` prefers. Mapped here anyway so the typed error can never degrade to a generic 500 if
  // a future path strips the field.
  if (error instanceof B2aReadAuthorizationError) return error.status
  if (/NotFound/.test(name)) return 404
  if (/Conflict/.test(name)) return 409
  if (/Validation|Transform|Watermark|DeadLetter/.test(name)) return 400
  // A `data-source:sql-readonly` external system bound to a deleted / not-visible data source is a
  // CONFIG error (its config.dataSourceId dangles), NOT a server fault — map to 422, not 500.
  // Deliberately NOT 404: the route's `:id` addresses the external system (which exists), so a 404
  // would falsely read as "no such external system" and collide with ExternalSystemNotFoundError.
  if (/PipelineRunner|DataSourceUnavailable/.test(name)) return 422
  return 500
}

function getUser(req) {
  return req.user || req.authUser || null
}

// C2b: the owner principal for a per-source-owner-scoped read (the data-source:sql-readonly bridge
// facade authorizes reads with it). Direct external-system test/objects/schema calls run AS the
// request user; a missing user yields undefined → the facade fails closed (never a system/admin
// fallback). Adapters that don't need a principal (staging/k3/http) ignore the extra dep.
function requestPrincipal(req) {
  const user = getUser(req)
  return user ? (user.id || user.email) : undefined
}

function listUserPermissions(user) {
  const permissions = []
  if (Array.isArray(user && user.permissions)) permissions.push(...user.permissions)
  if (Array.isArray(user && user.roles)) permissions.push(...user.roles.map((role) => `role:${role}`))
  if (user && typeof user.role === 'string') permissions.push(`role:${user.role}`)
  return permissions.map((permission) => String(permission))
}

function hasPermission(user, action) {
  const permissions = listUserPermissions(user)
  // O2 / R-11: the `/stock-prep` confirmation-queue workbench has its OWN vocabulary
  // (stock-prep:read | :operate | :admin), decided in stock-preparation-workbench-access.cjs and
  // shared verbatim with the front end. It is checked FIRST and it OWNS its whole namespace, so a
  // token in it can never fall through to the legacy integration:write default — a mistyped gate
  // refuses everyone rather than silently widening. Platform admin still passes, inside that
  // decision, so no admin capability is lost. Nothing here grants a stock-prep code to a holder of
  // integration:read/write: R-11's mapping is zero-automatic.
  if (isStockPrepPermissionCode(action)) return satisfiesStockPrepAccess(permissions, action)
  if (permissions.includes('role:admin') || permissions.includes('integration:admin')) return true
  if (action === 'admin') return false
  if (action === 'read') {
    return permissions.includes('integration:read') || permissions.includes('integration:write')
  }
  return permissions.includes('integration:write')
}

function isAdmin(user) {
  const permissions = listUserPermissions(user)
  return permissions.includes('role:admin') || permissions.includes('integration:admin')
}

function isTenantlessPlatformAdmin(user) {
  if (!listUserPermissions(user).includes('role:admin')) return false
  const userTenantId = typeof (user && user.tenantId) === 'string' ? user.tenantId.trim() : ''
  return userTenantId.length === 0
}

function requireAccess(req, action) {
  const user = getUser(req)
  if (!user) {
    throw new HttpRouteError(401, 'UNAUTHENTICATED', 'Authentication required')
  }
  if (!hasPermission(user, action)) {
    throw new HttpRouteError(403, 'FORBIDDEN', 'Insufficient integration permissions')
  }
  return user
}

/**
 * 一线自己拉数据 — THE TABLE-ACTION GATE, WITH THE OPERATOR SPLIT.
 *
 * `requireAccess` answers "does this principal hold this tier". Two table-action sub-routes need a
 * second question answered after that one says no: "…or is this the ONE stock-prep pull action a
 * floor operator was ruled able to self-serve?".
 *
 * THE ORDER IS THE CONTRACT, and it is what makes this additive rather than a rewrite:
 *   1. no principal            -> 401, exactly as before;
 *   2. the LEGACY tier passes  -> admitted, exactly as before, with no operator check performed at
 *      all. Every caller who reaches these routes today takes this branch and nothing about them
 *      changes — not the tenant resolution below it, not the audit, not the B2a fence;
 *   3. otherwise, and ONLY for the one frozen action id, the stock-prep operator tier is consulted;
 *   4. otherwise 403, with the same code and message `requireAccess` would have produced.
 *
 * It is therefore impossible for this helper to REMOVE an admission or to re-route an existing one.
 * The `actionId` it receives is the one the handler already resolved from the route params (falling
 * back to the stock-prep action), so the gate and the action lookup can never disagree about which
 * action is being authorized.
 *
 * NOT expressed as a `requireAccess(req, <stock-prep code>)` call on purpose: this is a DISJUNCTION
 * of two tiers scoped to one action id, and writing it as a gate token would either widen those
 * generic routes to every table action or make `stockPrepGateTokensInSource`'s typo tripwire read a
 * conditional gate as an unconditional one.
 */
function requireTableActionAccess(req, actionId, legacyGate) {
  const user = getUser(req)
  if (!user) {
    throw new HttpRouteError(401, 'UNAUTHENTICATED', 'Authentication required')
  }
  if (hasPermission(user, legacyGate)) return user
  if (operatorMayRunStockPrepPull(listUserPermissions(user), actionId)) return user
  throw new HttpRouteError(403, 'FORBIDDEN', 'Insufficient integration permissions')
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

function resolveTenantId(req, input = {}) {
  const user = getUser(req)
  const tenantId = firstString(input.tenantId, req.query && req.query.tenantId, req.params && req.params.tenantId, user && user.tenantId)
  if (!tenantId) {
    throw new HttpRouteError(400, 'TENANT_REQUIRED', 'tenantId is required')
  }
  // Tenant-bound principals stay confined to their authenticated tenant, including tenant admins.
  // Only a tenantless platform admin retains the existing explicit cross-tenant read capability.
  if (user && !isTenantlessPlatformAdmin(user)) {
    const userTenantId = typeof user.tenantId === 'string' ? user.tenantId.trim() : ''
    if (!userTenantId) {
      throw new HttpRouteError(403, 'TENANT_CONTEXT_REQUIRED', 'tenant context is required')
    }
    if (userTenantId !== tenantId) {
      throw new HttpRouteError(403, 'TENANT_MISMATCH', 'tenant scope mismatch')
    }
  }
  return tenantId
}

// 按项目导出物料 Excel: filename/sheet-name helpers. Pure, no I/O. buildXlsxBuffer itself sanitizes the
// sheet name a second time (sanitizeSheetName, xlsx-service.ts) — this is belt-and-braces plus the
// Chinese label the factory's own vocabulary uses; the filename sanitizer is load-bearing (an
// unsanitized projectNo could otherwise carry a path/quote character into a Content-Disposition header).
function stockPreparationExportTimestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function stockPreparationExportSafeToken(value, fallback) {
  const safe = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return safe || fallback
}

function stockPreparationExportSheetName(projectNo) {
  return `备料导出-${projectNo}`
}

function stockPreparationExportFilename(projectNo, now) {
  const safeProject = stockPreparationExportSafeToken(projectNo, 'project')
  return `stock-prep-${safeProject}-${stockPreparationExportTimestamp(now)}.xlsx`
}

// A tenant-scoped WRITE must derive its tenant from the AUTHENTICATED principal ONLY — never from the
// request. resolveTenantId above honors a request-supplied tenantId only for tenantless platform
// admins (cross-tenant READS depend on that). On a write route even that allowance is a steering
// vector, so this fail-closed helper derives the tenant without consulting the request at all.
function resolveAuthUserTenantId(req) {
  const user = getUser(req)
  const tenantId = typeof (user && user.tenantId) === 'string' ? user.tenantId.trim() : ''
  if (!tenantId) {
    throw new HttpRouteError(400, 'TENANT_REQUIRED', 'authenticated tenant context is required')
  }
  return tenantId
}

function collectExplicitTenantIds(req, input = {}) {
  const body = requestBody(req)
  const query = requestQuery(req)
  const params = requestParams(req)
  return [input.tenantId, body && body.tenantId, query && query.tenantId, params && params.tenantId]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
}

// Write-bearing C6 Apply and private adapter-config mutation derive tenant from the
// authenticated principal only. Tenantless role:admin and any mismatched tenant carrier
// fail closed. An explicit tenantId that equals the auth tenant is compatibility-only.
function resolveAuthenticatedWriteTenantId(req, input = {}) {
  const tenantId = resolveAuthUserTenantId(req)
  for (const explicit of collectExplicitTenantIds(req, input)) {
    if (explicit !== tenantId) {
      throw new HttpRouteError(403, 'TENANT_MISMATCH', 'tenant scope mismatch')
    }
  }
  return tenantId
}

function scopedAuthenticatedWriteInput(req, input = {}) {
  return {
    ...input,
    tenantId: resolveAuthenticatedWriteTenantId(req, input),
    workspaceId: resolveWorkspaceId(req, input),
  }
}

function resolveWorkspaceId(req, input = {}) {
  return firstString(input.workspaceId, req.query && req.query.workspaceId, req.params && req.params.workspaceId)
}

function scopedInput(req, input = {}) {
  return {
    ...input,
    tenantId: resolveTenantId(req, input),
    workspaceId: resolveWorkspaceId(req, input),
  }
}

// Adapter resolution is an authority-bearing read: a canonical Connection is resolved for the
// same user that the adapter will execute as. Keeping this beside scopedInput prevents route
// callers from loading a connection under one identity and constructing the adapter under another.
function scopedAdapterInput(req, input = {}, principal = requestPrincipal(req)) {
  return scopedInput(req, {
    ...input,
    principal,
    runAs: 'user',
  })
}

function largeBomJobScope(req, input = {}) {
  const scope = scopedInput(req, input)
  return {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId || 'workspace-default',
  }
}

function isIntegrationCoreProjectId(projectId) {
  if (typeof projectId !== 'string') return false
  const suffix = projectId.trim().split(':').pop()
  return suffix === 'integration-core' || suffix === 'plugin-integration-core'
}

function resolveIntegrationStagingProjectId(tenantId, requestedProjectId) {
  if (isIntegrationCoreProjectId(requestedProjectId)) return requestedProjectId.trim()
  return `${tenantId}:integration-core`
}

// T3a (OD-1): the ERP source-run auto-persist gate. Default OFF (staged) — a truthy value only when the
// env var is EXACTLY 'true' (trimmed, case-insensitive), same idiom as the other MULTITABLE_ gates. Off
// keeps the source-run read-only; on wires its intake into T2 persist within the same request.
function stockPreparationErpAutoPersistEnabled() {
  return String(process.env.MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED ?? '').trim().toLowerCase() === 'true'
}

// T3a OD-2: with auto-persist ON the ERP source-run has a write side-effect, so an explicit request
// tenant/projectId (a steering vector) is rejected FAIL-CLOSED before any I/O — same discipline as
// assertNoRequestBaseId. workspaceId is a SAME-TENANT scope selector (it never changes the auth-derived
// tenant or the write target) and is deliberately NOT rejected.
function assertStockPreparationErpAutoPersistNoSteering(req) {
  const steers = (src) =>
    src && (`${src.tenantId ?? ''}`.trim() !== '' || `${src.projectId ?? ''}`.trim() !== '')
  if (steers(requestBody(req)) || steers(requestQuery(req)) || steers(requestParams(req))) {
    throw new HttpRouteError(
      400,
      'STOCK_PREPARATION_ERP_AUTOPERSIST_STEERING_NOT_ALLOWED',
      'an explicit tenantId/projectId is not allowed on the auto-persisting ERP source-run; the tenant and cache target are derived from the authenticated principal',
    )
  }
}

// T3b (OD-1): the PLM source-run auto-persist gate — a SEPARATE flag from the T3a ERP one (the lock
// forbids folding T3b into the T3a flag or reusing the ERP cache's autoPersist gate). Same strict
// idiom: only the literal 'true' (trimmed, case-insensitive) turns it on; default OFF keeps the PLM
// source-run read-only byte-for-byte.
function stockPreparationPlmAutoPersistEnabled() {
  return String(process.env.MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED ?? '').trim().toLowerCase() === 'true'
}

// Direct readonly table-action -> internal MVP persistence is a separately staged capability. It is
// deliberately NOT implied by either source-run auto-persist flag: only the exact literal `true`
// enables this manually-invoked admin write route, and a missing/malformed value stays fail-closed.
// ONE HTTP REQUEST = ONE B2a SOURCE-READ RUN.
//
// `sourceReadOperationLimit` is 1, and the guard distinguishes "another page of the read I already
// authorized" from "a second read" by Run identity. Every page of one request's read happens inside
// that request, so a fresh id per request is exactly the boundary the limit is written against — and
// it is generated SERVER-SIDE so a caller cannot present someone else's run id and ride their claim.
//
// The large-BOM expansion path deliberately does NOT use this: its Run is the stored job, so it
// passes the job id and a re-run of the same job continues on the claim it already holds.
// The sealed-snapshot runtime binding's frozen `objectKey`. Restated as a literal rather than
// imported out of the pinned sealed-export store, so a silent change there surfaces here as a B2a
// refusal (an object outside the registered scope) instead of as agreeing drift on both sides.
const SEALED_SNAPSHOT_OBJECT_KEY = 'stock-preparation-bom'

function b2aRunId(label) {
  return `${label}:${crypto.randomUUID()}`
}

function stockPreparationTableActionMvpPersistEnabled() {
  return String(process.env.MULTITABLE_STOCK_PREP_TABLE_ACTION_MVP_PERSIST_ENABLED ?? '').trim().toLowerCase() === 'true'
}

// Entity-level delivery containment. This negative gate is intentionally
// independent from the dry-run route: an internal evaluation environment can
// keep previews usable while refusing every C6 Apply before request parsing,
// token consumption, pipeline loading, or adapter/network activity.
function c6WriteApplyDisabled() {
  return String(process.env.INTEGRATION_C6_WRITE_APPLY_DISABLED ?? '').trim().toLowerCase() === 'true'
}

// T3b OD-2 (layered semantics — deliberately NOT a copy of the ERP guard): with auto-persist ON the
// PLM source-run gains a write side-effect, so an explicit tenantId on ANY carrier is a steering
// vector and is rejected fail-closed BEFORE body normalization and any I/O. projectId differs from
// T3a: the BODY projectId is the REQUIRED business project key carried on the written rows (it never
// derives the tenant or the physical target), so only a query/params projectId — a second, ambiguous
// carrier — is rejected. workspaceId stays a same-tenant approved-config selector and is not rejected.
function assertStockPreparationPlmAutoPersistNoSteering(req) {
  const explicit = (src, key) => Boolean(src) && `${src[key] ?? ''}`.trim() !== ''
  const body = requestBody(req)
  const query = requestQuery(req)
  const params = requestParams(req)
  if (
    explicit(body, 'tenantId') || explicit(query, 'tenantId') || explicit(params, 'tenantId') ||
    explicit(query, 'projectId') || explicit(params, 'projectId')
  ) {
    throw new HttpRouteError(
      400,
      'STOCK_PREPARATION_PLM_AUTOPERSIST_STEERING_NOT_ALLOWED',
      'an explicit tenantId (any carrier) or a query/params projectId is not allowed on the auto-persisting PLM source-run; the tenant and staging target derive from the authenticated principal and the business projectId rides only in the body',
    )
  }
}

// The table-action MVP route derives every physical scope from the authenticated principal and the
// deployed action config. Reject all request carriers that could otherwise influence tenant,
// workspace, or project selection before action lookup, source-system lookup, adapter creation, or
// source I/O. The route parameter `actionId` and body `parameters.projectNo` are its only selectors.
function assertStockPreparationTableActionMvpPersistNoSteering(req) {
  const steeringKeys = [
    'tenantId', 'workspaceId', 'projectId', 'targetProjectId', 'baseId', 'sheetId', 'objectId',
    'syncRunId', 'snapshotBatchId', 'snapshotVersion',
  ]
  const steers = (src) => Boolean(src) && steeringKeys
    .some((key) => `${src[key] ?? ''}`.trim() !== '')
  const query = requestQuery(req)
  const params = requestParams(req)
  const unsupportedParam = Object.keys(params).some((key) => key !== 'actionId')
  if (steers(requestBody(req)) || Object.keys(query).length !== 0 || unsupportedParam || steers(params)) {
    throw new HttpRouteError(
      400,
      'STOCK_PREPARATION_TABLE_ACTION_MVP_PERSIST_STEERING_NOT_ALLOWED',
      'tenantId, workspaceId, and projectId are derived from the authenticated principal and deployed action config',
    )
  }
}

function requestBody(req) {
  return req.body && typeof req.body === 'object' ? req.body : {}
}

function requestQuery(req) {
  return req.query && typeof req.query === 'object' ? req.query : {}
}

function requestParams(req) {
  return req.params && typeof req.params === 'object' ? req.params : {}
}

const MAX_LIST_LIMIT = 500
const MAX_LIST_OFFSET = 10000
const MAX_SAMPLE_LIMIT = 10000

// 对接总览 page sizes. SERVER-HELD, not request-tunable: the overview is a fixed first screen, so
// accepting a caller-supplied limit would only add a steering vector for no product gain. The
// system cap is deliberately smaller than the consumer cap — a tenant with 200 registered external
// systems has a governance problem this screen cannot fix, whereas one system can legitimately be
// referenced by many pipelines and approved read configs.
const HUB_OVERVIEW_SYSTEM_LIMIT = 200
const HUB_OVERVIEW_CONSUMER_LIMIT = MAX_LIST_LIMIT

// 工作台里选源 candidate page size. SERVER-HELD for the same reason and reusing the same number as
// the overview's system cap: both screens enumerate this tenant's registered external systems, and
// two different caps would mean a source visible on one screen and absent from the other.
const SOURCE_BINDING_CANDIDATE_LIMIT = HUB_OVERVIEW_SYSTEM_LIMIT

// The source-binding POST body may name a SOURCE and nothing else. Not "these are validated and the
// rest ignored" — an unlisted key is a 400. `kind`, `readPlan`, `target`, `actionId` and `tenantId`
// are all deliberately absent: the workbench moves WHERE the action reads, never what or how, and
// never whose.
const VALID_SOURCE_BINDING_BODY_KEYS = new Set(['externalSystemId'])

function asPositiveInt(value) {
  if (value === undefined || value === null || value === '') return undefined
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined
}

// 'replay' is internal-only: set by replayDeadLetter, not accepted over the API.
const VALID_USER_RUN_MODES = new Set(['manual', 'incremental', 'full'])

function asListLimit(value) {
  const n = asPositiveInt(value)
  if (n === undefined) return undefined
  return Math.min(n, MAX_LIST_LIMIT)
}

function asListOffset(value) {
  const n = asPositiveInt(value)
  if (n === undefined) return undefined
  return Math.min(n, MAX_LIST_OFFSET)
}

function asSampleLimit(value) {
  const n = asPositiveInt(value)
  if (n === undefined) return undefined
  return Math.min(n, MAX_SAMPLE_LIMIT)
}

function publicRunInput(body = {}) {
  if (body.cursor !== undefined && body.cursor !== null && body.cursor !== '') {
    if (typeof body.cursor !== 'string') {
      throw new HttpRouteError(400, 'INVALID_CURSOR', 'cursor must be a string', {
        received: Array.isArray(body.cursor) ? 'array' : typeof body.cursor,
      })
    }
  }
  if (body.mode !== undefined && body.mode !== null && body.mode !== '') {
    if (!VALID_USER_RUN_MODES.has(body.mode)) {
      throw new HttpRouteError(
        400,
        'INVALID_RUN_MODE',
        `mode must be one of: ${Array.from(VALID_USER_RUN_MODES).join(', ')}`,
        { received: body.mode }
      )
    }
  }
  const input = {
    tenantId: body.tenantId,
    workspaceId: body.workspaceId,
    mode: body.mode,
    cursor: body.cursor,
    sampleLimit: asSampleLimit(body.sampleLimit),
  }
  for (const key of Object.keys(input)) {
    if (input[key] === undefined || input[key] === null || input[key] === '') delete input[key]
  }
  return input
}

const VALID_TABLE_ACTION_DRY_RUN_BODY_KEYS = new Set(['parameters', 'conflictPolicyReview'])
// Confirmation-decision reconcile accepts EXACTLY the dry-run inputs: the plan/revision the ledger
// binds to are recomputed server-side and can never be request-supplied.
const VALID_TABLE_ACTION_CONFIRMATION_DECISION_RECONCILE_BODY_KEYS = new Set(['parameters', 'conflictPolicyReview'])
const VALID_TABLE_ACTION_MVP_PERSIST_BODY_KEYS = new Set(['parameters'])
const VALID_TABLE_ACTION_APPLY_BODY_KEYS = new Set(['parameters', 'confirm'])
const VALID_TABLE_ACTION_LARGE_BOM_START_BODY_KEYS = new Set(['parameters'])
const VALID_TABLE_ACTION_LARGE_BOM_PLAN_BODY_KEYS = new Set(['conflictPolicyReview'])
const VALID_TABLE_ACTION_LARGE_BOM_APPLY_START_BODY_KEYS = new Set(['confirm'])
const VALID_EMPTY_REQUEST_KEYS = new Set()
const VALID_C6_WRITE_DRY_RUN_BODY_KEYS = new Set(['tenantId', 'workspaceId', 'maxRows'])
const VALID_C6_WRITE_APPLY_BODY_KEYS = new Set(['tenantId', 'workspaceId', 'confirm'])
// S3-2: instantiate binds to caller-supplied systems by id only. The write profile / credentials
// are NEVER request-sourced; only these scope + binding keys are accepted (closed allowlist).
const VALID_TEMPLATE_INSTANTIATE_BODY_KEYS = new Set(['tenantId', 'workspaceId', 'targetSystemId', 'sourceSystemId', 'pipelineName'])
const VALID_C6_WRITE_APPLY_CONFIRM_KEYS = new Set(['dryRunToken'])
const VALID_STOCK_PREPARATION_TARGET_REQUEST_KEYS = new Set(['tenantId', 'workspaceId', 'projectId', 'baseId'])
// Confirmation-decision LEDGER request surfaces. Ensure takes NO body keys at all (the staging
// project is auth-derived; a projectId/baseId here would be a steering vector on a write route).
// The confirm body carries the full converged key vocabulary; resolvedValue/resolvedAuxValue are
// validated and stored by the module since the O1' ledger-semantics slice (Q2-A value unlock).
const VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_READINESS_QUERY_KEYS = new Set(['tenantId', 'workspaceId'])
// The preflight answers "is THIS deployment ready", so its only request surface is the scope the
// neighbouring readiness route already accepts. Deliberately no `projectId` and no `objectId`: the
// declared target comes from the PACK, and letting a request name one would recreate incident 2 at
// the API instead of in a chat window.
const VALID_STOCK_PREPARATION_PREFLIGHT_QUERY_KEYS = new Set(['tenantId', 'workspaceId'])
// SOURCE preflight. `externalSystemId` is the ONE addition, and it is a REGISTERED-SYSTEM SELECTOR,
// not a connection: it names a row the caller's tenant already owns, and everything about how to
// reach that row — host, credentials, driver — stays server-held exactly as it is for every other
// route. Deliberately absent: any object/table name, any filter, any limit, any read plan. A request
// that could name the object to read would be a bulk-read surface wearing a preflight's name, and a
// request that could supply a read plan would be able to make the alignment check agree with itself.
// `declaredBridge` is the SECOND addition, and it is a DECLARATION, not a widening. When both bridge
// candidates fill the bounded sample the probe cannot rank them, and the honest answer is a refusal;
// this lets a human who knows the deployment answer the question the sample could not, and the report
// then says the bridge was declared rather than measured. It cannot overrule a measurement that DID
// come out decisive (that is its own blocker), it cannot conjure a bridge into an empty catalog, and
// the module validates it against a two-value closed vocabulary — so it is not a free-text channel.
// Still deliberately absent: any object/table name, any filter, any limit, any read plan.
const VALID_STOCK_PREPARATION_SOURCE_PREFLIGHT_QUERY_KEYS = new Set(['tenantId', 'workspaceId', 'externalSystemId', 'declaredBridge'])
const VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_ENSURE_BODY_KEYS = new Set()
const VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_LIST_QUERY_KEYS = new Set(['tenantId', 'workspaceId', 'projectNo', 'status'])
const VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_VALUE_ENTRY_QUERY_KEYS = new Set(['tenantId', 'workspaceId', 'decisionId'])
const VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_CONFIRM_BODY_KEYS = new Set([
  'decisionId',
  'inputFingerprint',
  'resolutionAction',
  'resolvedValue',
  'resolvedAuxValue',
  'notes',
])
// CUSTOMER PACK install: `mode` is the ONLY accepted body key, and that is the whole point of the
// allowlist. A `pack` key would turn an admin-authenticated request into schema authoring on the
// canonical sheet (arbitrary `ext_` columns with arbitrary ownership bands) — packs are deploy-time
// data resolved from the server-held catalog, never from a request. `tenantId` / `projectId` /
// `objectId` are absent for the same reason the target-ensure write route rejects them: on a write
// route they are steering vectors, and the tenant is auth-derived.
const VALID_CUSTOMER_PACK_INSTALL_BODY_KEYS = new Set(['mode'])
const VALID_STOCK_PREPARATION_SANDBOX_TARGET_REQUEST_KEYS = new Set(['tenantId', 'workspaceId', 'projectId', 'baseId', 'objectId', 'label', 'optionSets', 'optionSources', 'configInfo'])
const VALID_STOCK_PREPARATION_OPTION_SYNC_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'optionSets',
  'optionSources',
  'configInfo',
])
// #3751 MVP: closed allowlists for the MVP readiness/ensure + option-sync routes. `objectIds`
// (optional) scopes to a subset of the 9 frozen MVP tables; never a sheetId / credentials.
const VALID_STOCK_PREPARATION_MVP_TARGET_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'baseId',
  'objectIds',
])
const VALID_STOCK_PREPARATION_MVP_OPTION_SYNC_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'objectIds',
  'optionSets',
  'optionSources',
  'configInfo',
])
// #3751 MVP: closed allowlist for the readonly sync-RUN PLAN route — ALSO reused verbatim by the
// COMMIT (persist) route below it (same body the admin previewed with /plan is replayed to /persist).
// Carries the readonly plan inputs only — an already-produced expansion result + optional prior
// batch/lines + plan ids/version/source — PLUS (#4163 T1) the project row's own populator inputs
// (`sourceProjectNo` / `projectName`): the plan orchestrator ignores both (it has no project-row
// concept), but /persist consumes them to upsert the project row. NEVER a credential, sheetId, or SQL.
// `projectId` here is the PLM business project id (preserved verbatim into the plan row), not a
// workspace sheet id.
const VALID_STOCK_PREPARATION_MVP_SYNC_PLAN_REQUEST_KEYS = new Set([
  'projectId',
  'syncRunId',
  'snapshotBatchId',
  'snapshotVersion',
  'sourceSystem',
  'sourceProjectNo',
  'projectName',
  'expansionResult',
  'previousSnapshotBatchId',
  'previousLines',
  'readPlan',
  'defaultDesignUnit',
])
// #3889 source-run bodies select an approved read config by reference and may supply only its named
// key input. No raw source row, endpoint/path, SQL, page control, credential, or external-write flag.
const VALID_STOCK_PREPARATION_PLM_SOURCE_RUN_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'sourceProjectNo',
  'projectName',
  'readSourceConfigId',
  'inputs',
  'syncRunId',
  'snapshotBatchId',
  'snapshotVersion',
])
// The ERP material run is not project-scoped (it caches the ERP material master), so it does NOT take a
// projectId — a field accepted and then ignored is an invitation to believe it scopes something.
const VALID_STOCK_PREPARATION_ERP_SOURCE_RUN_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'readSourceConfigId',
  'inputs',
  'syncRunId',
])
// T2: the ERP material SYNC (commit) request — same "not project-scoped" reasoning as the source-run
// allowlist above (this is a tenant-level cache commit, not a per-PLM-project write). `erpMaterials` is
// the caller's ALREADY-NORMALIZED row array (e.g. the output of runErpMaterialReadonlySource /
// normalizeStockPreparationReadonlyIntake, or a sample/fixture in the same shape) — this route does not
// itself read K3/ERP or re-derive business keys.
// NO tenantId / workspaceId here: this is a tenant-scoped WRITE, so the tenant is derived server-side
// from the authenticated principal (resolveAuthUserTenantId), never from the request. Accepting a
// request tenantId would be a steering vector (an admin could redirect the write to another tenant's
// staging project) — the closed allowlist rejects it outright, on top of the auth-only derivation.
const VALID_STOCK_PREPARATION_ERP_MATERIAL_SYNC_REQUEST_KEYS = new Set([
  'syncRunId',
  'erpMaterials',
])
// #4163 T1: closed query allowlist for the readonly PROJECT list. Unlike every other read in this
// module family, this route is NOT scoped to one business projectId — the project table IS the
// top-level list an operator picks a projectId FROM — so only the tenant/workspace scope rides the
// query (used to derive the STAGING targetProjectId; never a sheetId / credential / SQL).
const VALID_STOCK_PREPARATION_PROJECT_LIST_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
])
// #3751 MVP view 2: closed query allowlist for the readonly snapshot-batch LIST + DIFF reads. Only the
// tenant/workspace scope + the (business) projectId; the batch id rides the DIFF route PATH, never the
// query. Never a sheetId / credential / SQL.
const VALID_STOCK_PREPARATION_SNAPSHOT_READ_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
])
// #3751 MVP W3: the DIFF route additionally accepts a caller-chosen base batch id; the DIFF/ROWS
// route adds the two enum filters. Separate Sets per route — extending DIFF must not widen LIST.
const VALID_STOCK_PREPARATION_SNAPSHOT_DIFF_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'baseSnapshotBatchId',
])
const VALID_STOCK_PREPARATION_SNAPSHOT_DIFF_ROWS_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'baseSnapshotBatchId',
  'reviewStatus',
  'diffType',
])
// #3751 MVP W3 (confirm reads): closed query allowlists — one Set per route.
const VALID_STOCK_PREPARATION_MAPPING_SUMMARY_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
])
const VALID_STOCK_PREPARATION_MAPPING_CANDIDATES_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'matchStatus',
])
const VALID_STOCK_PREPARATION_UNIT_SUMMARY_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
])
const VALID_STOCK_PREPARATION_UNIT_CANDIDATES_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'snapshotBatchId',
])
// #3751 MVP W3: closed request allowlists for the confirm-write routes — one Set per route (no
// sharing that would widen a sibling parser). The confirmation stamps (confirmedBy / confirmedAt)
// are DELIBERATELY absent from every list: they are server-derived (route user identity + module
// stamp time), so a body that supplies either is rejected as an unknown field.
const VALID_STOCK_PREPARATION_MAPPING_CANDIDATES_SYNC_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'snapshotBatchId',
  'defaultVersionPolicy',
])
const VALID_STOCK_PREPARATION_MAPPING_CONFIRM_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'mappingId',
  'mapping',
  'notes',
])
const VALID_STOCK_PREPARATION_MAPPING_RETIRE_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'mappingId',
])
const VALID_STOCK_PREPARATION_UNIT_CONFIRM_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'conversionRuleId',
  'contextFingerprint',
  'snapshotBatchId',
  'rule',
])
// W4b: closed carry-confirm allowlist. The stamps (carriedBy / carriedAt — and the confirm stamps
// too) are DELIBERATELY absent: carriedBy is the route user identity and carriedAt is stamped in
// the carry executor, so a body that supplies either is rejected as an unknown field. decisionId /
// inputFingerprint are the OPTIONAL ledger-close pair (both or neither).
const VALID_STOCK_PREPARATION_CARRY_CONFIRM_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'decision',
  'decisionId',
  'inputFingerprint',
])
const VALID_STOCK_PREPARATION_UNIT_RETIRE_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'conversionRuleId',
])
// #3751 MVP W4: closed allowlists for the generation/exception routes. The resolution stamps
// (resolvedBy / resolvedAt) are DELIBERATELY absent — server-derived, body-supplied => 400.
const VALID_STOCK_PREPARATION_GENERATION_RUN_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'snapshotBatchId',
])
const VALID_STOCK_PREPARATION_EXCEPTION_RESOLVE_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'exceptionId',
  'resolutionAction',
])
const VALID_STOCK_PREPARATION_EXCEPTION_BULK_RESOLVE_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'exceptionIds',
  'resolutionAction',
])
const VALID_STOCK_PREPARATION_EXCEPTION_LIST_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'snapshotBatchId',
  'status',
  'exceptionType',
  'severity',
])
const VALID_STOCK_PREPARATION_AUDIT_LIST_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'action',
  'limit',
])
const VALID_STOCK_PREPARATION_PREP_LINE_LIST_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'snapshotBatchId',
  'prepStatus',
])
// 按项目导出物料 Excel: `projectNo`, NOT `projectId` — plm_stock_preparation_main's own business-project
// field (stock-preparation-templates.cjs), the same identifier the confirmation-decision ledger family
// scopes on (VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_LIST_QUERY_KEYS above), not the confirm-
// reads family's MVP-ledger `projectId`.
const VALID_STOCK_PREPARATION_PREP_LINE_EXPORT_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectNo',
])
// 一线看得见自己工厂的项目: the operator project directory takes NO project selector at all — it IS the
// selector, and it always returns the caller's whole own-tenant directory so the front end can tell
// "that number is not in this system" from "that project is real and has nothing pending". `tenantId`
// is accepted for shape-compatibility with every other call in this family and is NEVER a steering
// vector: the scope resolver refuses any value that is not the caller's own authenticated tenant.
const VALID_STOCK_PREPARATION_OPERATOR_PROJECT_DIRECTORY_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
])
// 通知下一步: the status READ. `projectNo` for the same reason the export uses it — the business
// project number, which is what a person means by "this project".
const VALID_STOCK_PREPARATION_HANDOFF_STATUS_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectNo',
])
// 通知下一步: the ADVANCE body. `fromStepKey` — the step the caller believes they are completing — is
// what turns a blind increment into a compare-and-set, which is the whole idempotency story (a double
// click is a detectable replay rather than a second advance). Deliberately ABSENT, so that a body
// supplying one is refused as an unknown field: `actor`/`advancedBy` (the principal is the ROUTE
// user, never the body), `toStepKey`/`stepIndex` (the destination is derived from the configured
// chain, never chosen by the caller — otherwise anyone could skip to the terminal step and fire the
// 仓库/采购 notice), and any destination id (the notification targets are deploy config).
const VALID_STOCK_PREPARATION_HANDOFF_ADVANCE_BODY_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectNo',
  'fromStepKey',
])

// 项目备料页: the board's query allowlist. `projectNo` is deliberately NOT here — it is a PATH
// param, so a request that also passes it as a query key is a malformed request and is refused
// rather than silently resolved toward one of the two. `tenantId` is accepted only so the shared
// `collectExplicitTenantIds` check can refuse a steering attempt with the right code; it never
// selects anything.
const VALID_STOCK_PREPARATION_OPERATOR_PROJECT_BOARD_QUERY_KEYS = new Set([
  'tenantId',
  'workspaceId',
])
// FOS-2: generic field-option-sync request — closed allowlist. Operator names a preset (FOS-1
// catalog) + supplies option sets keyed by the preset's source keys. No sheetId / credentials.
const VALID_FIELD_OPTION_SYNC_REQUEST_KEYS = new Set([
  'tenantId',
  'workspaceId',
  'projectId',
  'presetId',
  'optionSets',
  'dryRun', // FOS-4b-2: dry-run-only mode (validate + preview, NO write). Required to carry action bindings.
])

function normalizeTableActionBody(body = {}, allowedKeys = VALID_TABLE_ACTION_DRY_RUN_BODY_KEYS) {
  if (!isPlainObject(body)) {
    throw new HttpRouteError(400, 'TABLE_ACTION_REQUEST_INVALID', 'request body must be an object')
  }
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new HttpRouteError(400, 'TABLE_ACTION_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return body
}

function normalizeCustomerPackBody(body = {}, allowedKeys = VALID_EMPTY_REQUEST_KEYS) {
  if (!isPlainObject(body)) {
    throw new HttpRouteError(400, 'CUSTOMER_PACK_REQUEST_INVALID', 'request body must be an object')
  }
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      throw new HttpRouteError(400, 'CUSTOMER_PACK_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return body
}

function normalizeC6WriteDryRunBody(body = {}) {
  if (!isPlainObject(body)) {
    throw new HttpRouteError(400, 'C6_WRITE_DRY_RUN_REQUEST_INVALID', 'request body must be an object')
  }
  for (const key of Object.keys(body)) {
    if (!VALID_C6_WRITE_DRY_RUN_BODY_KEYS.has(key)) {
      throw new HttpRouteError(400, 'C6_WRITE_DRY_RUN_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return {
    tenantId: firstString(body.tenantId),
    workspaceId: firstString(body.workspaceId),
    maxRows: body.maxRows,
  }
}

function normalizeTemplateInstantiateBody(body = {}) {
  if (!isPlainObject(body)) {
    throw new HttpRouteError(400, 'TEMPLATE_INSTANTIATE_REQUEST_INVALID', 'request body must be an object')
  }
  for (const key of Object.keys(body)) {
    if (!VALID_TEMPLATE_INSTANTIATE_BODY_KEYS.has(key)) {
      throw new HttpRouteError(400, 'TEMPLATE_INSTANTIATE_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return {
    tenantId: firstString(body.tenantId),
    workspaceId: firstString(body.workspaceId),
    targetSystemId: firstString(body.targetSystemId),
    sourceSystemId: firstString(body.sourceSystemId),
    pipelineName: firstString(body.pipelineName),
  }
}

function normalizeC6WriteApplyBody(body = {}) {
  if (!isPlainObject(body)) {
    throw new HttpRouteError(400, 'C6_WRITE_APPLY_REQUEST_INVALID', 'request body must be an object')
  }
  for (const key of Object.keys(body)) {
    if (!VALID_C6_WRITE_APPLY_BODY_KEYS.has(key)) {
      throw new HttpRouteError(400, 'C6_WRITE_APPLY_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  const confirm = body.confirm === undefined || body.confirm === null ? {} : body.confirm
  if (!isPlainObject(confirm)) {
    throw new HttpRouteError(400, 'C6_WRITE_APPLY_REQUEST_INVALID', 'confirm must be an object', { field: 'confirm' })
  }
  for (const key of Object.keys(confirm)) {
    if (!VALID_C6_WRITE_APPLY_CONFIRM_KEYS.has(key)) {
      throw new HttpRouteError(400, 'C6_WRITE_APPLY_REQUEST_INVALID', `unsupported confirm field: ${key}`, { field: `confirm.${key}` })
    }
  }
  const dryRunToken = firstString(confirm.dryRunToken)
  if (!dryRunToken) {
    throw new HttpRouteError(400, 'C6_WRITE_DRY_RUN_TOKEN_REQUIRED', 'dryRunToken is required for apply', { field: 'confirm.dryRunToken' })
  }
  return {
    tenantId: firstString(body.tenantId),
    workspaceId: firstString(body.workspaceId),
    confirm: {
      dryRunToken,
    },
  }
}

// S1b-3: resolve the C6 write-source + profile + flat planner target config SERVER-SIDE by
// target kind. The profile is NEVER taken from the request — it IS the per-kind safety policy.
// metasheet:multitable rides the same C6 dry-run->apply lifecycle via its own-sheet raw
// write-source (zero external write); any other (default) target uses the host SQL write
// facade unchanged. Used by BOTH the dry-run and apply handlers with identical inputs so the
// apply recompute reproduces the same dry-run revision (the revision fence).
// C6 targets whose write source builds a TARGET ADAPTER, and therefore need credentials on the
// loaded system. Everything else (SQL write-gated, multitable) is served by dataSourceWrites and
// is deliberately loaded config-only.
const ADAPTER_BACKED_C6_TARGET_KINDS = new Set([K3_WISE_C6_WRITE_TARGET_KIND])

function resolveC6WritePlanInputs({ targetSystem, pipeline, context, adapterRegistry, ownerPrincipal, readSourceConfigs, getExternalSystem, instanceDigestOf }) {
  // K3WriteDecision (owner, 20260805): the K3 connector rides the same C6 dry-run->apply
  // lifecycle via its own profile + adapter-backed write source. `enforcedMaxRows` pins the
  // plan-level source read to the profile's frozen cap — a caller-supplied maxRows is
  // OVERRIDDEN for K3 targets (a >cap source read would only ever produce not_applyable).
  if (targetSystem && targetSystem.kind === K3_WISE_C6_WRITE_TARGET_KIND) {
    const flatConfig = deriveK3WiseC6PlannerTargetConfig({
      system: targetSystem,
      object: pipeline.targetObject,
      fieldMappings: pipeline.fieldMappings,
    })
    return {
      planTargetSystem: { ...targetSystem, config: flatConfig },
      dataSourceWrites: createK3WiseC6WriteSource({
        system: targetSystem,
        createAdapter: (system) => adapterRegistry.createAdapter(system, { role: 'target', principal: ownerPrincipal }),
        // B4 consumption scope (owner review 20260805): the approved read binding must belong to
        // one of THIS pipeline's endpoints — source OR target, since the K3 system may
        // legitimately be either or both. (This comment said "source system" through round 9;
        // the code has accepted both since the round-3 relation fix. Corrected — a comment that
        // disagrees with its code is how three earlier defects on this PR hid.)
        //
        // Server-side wiring only, never request-sourced: the values come from the PIPELINE
        // record, and the pipeline is resolved by an exact scope match upstream, so a request
        // claiming a different tenant/workspace does not reach this branch.
        //
        // COVERAGE, STATED EXACTLY (round 11 caught the previous wording overclaiming). The
        // round-10 comment said this property "is asserted in http-routes-plm-k3wise-poc" — it
        // is not, or not fully:
        //   * the test covers the WORKSPACE half only; the tenant half exits earlier through a
        //     different door (403 TENANT_MISMATCH) and is uncovered;
        //   * the test drives its own fake pipeline registry, so the real upstream guard in
        //     `lib/pipelines.cjs` does not execute in it;
        //   * it is not gate-exclusive — neutering the harness's own workspace comparison still
        //     leaves a 404 door standing.
        // What the test DOES prove, and all it proves, is the property that matters here: a
        // spoofed-workspace request reaches ZERO B4 lookups. The upstream guard's own negative
        // case belongs to `pipelines.test.cjs`, whose fixtures are all single-workspace today —
        // filed as follow-up rather than claimed.
        b4: {
          readSourceConfigs,
          tenantId: pipeline.tenantId,
          workspaceId: pipeline.workspaceId ?? null,
          // The binding must belong to one of THIS pipeline's endpoints (review P2-B1): the K3
          // system may legitimately be the source, the target, or both.
          // OWNER REVIEW 20260806 [P1]: with only the two pipeline endpoints here, the customer's
          // real K3 READ record is neither, so B4 could only ever bind to the TARGET — and the
          // same-instance check then compared the target against ITSELF. The check was structurally
          // incapable of detecting a read/write mismatch no matter how good the comparator was.
          //
          // The write target now DECLARES its paired read record (`config.pairedReadSystemId`), and
          // that one id joins the relation set. This is deliberately narrow: it admits exactly the
          // record the target itself names — not an arbitrary third system — and the binding must
          // still clear the ratified-contract match, the kind gate, and the same-instance check.
          //
          // NOTE this WIDENS #4769's relation check by one target-declared id. That is a change to
          // a ratified gate, made on the owner's explicit instruction to "让 B4 绑定真实
          // read-system，并比较 read/write 两条记录的规范实例身份".
          pipelineSystemIds: [
            pipeline.sourceSystemId,
            pipeline.targetSystemId,
            (targetSystem.config && targetSystem.config.pairedReadSystemId) || null,
          ].filter(Boolean),
          // SAME-INSTANCE CHECK (owner ruling 20260805: "A, bind B4 to the K3-write record").
          // The B4 contract is the material-LIST read contract, and a PROFILE-ARMED record
          // cannot hold list-read config — #4769 makes every readList* key a forbidden overlay,
          // and strips it even when it arrives from the frozen first-party read-smoke preset.
          // So the customer needs TWO K3 records (see delivery MD step 0-b), and with a non-K3
          // pipeline source the read record is neither endpoint. Binding to the TARGET record is
          // therefore the only option that satisfies the relation check.
          //
          // That is only honest while both records address the SAME physical K3. Without this
          // check, "bind to the target" would let one K3's read contract vouch for a DIFFERENT
          // K3's write — exactly the round-3 defect the relation check exists to stop, reopened
          // one level down. The check is fail-closed: it can only refuse bindings the relation
          // check already accepted, never admit new ones.
          targetBaseUrl: (targetSystem.config && targetSystem.config.baseUrl) || '',
          // Scope derived from the PIPELINE record, same as tenantId/workspaceId above — NOT
          // from the request. `scopedInput(req, …)` reads workspaceId from query/params but not
          // the body, so a workspace-scoped pipeline fell out of scope and the lookup returned
          // null, which the fail-closed comparator then read as "different instance".
          // OWNER RULING 20260806 [P1]: identity is (kind, origin, acctId), not origin alone.
          // The digest is computed inside external-systems — the only module holding decrypted
          // credentials — and ONLY the digest crosses this boundary, so the profile never sees
          // acctId. Both legs go through the SAME function, so a digest difference is a difference
          // in (kind, origin, account set) and nothing else.
          //
          // This REPLACES loadSystemById + targetBaseUrl: comparing baseUrls could not see the
          // account set at all, which is what made same-server/different-账套 compare equal.
          // `externalSystems` is NOT in this function's scope — only what the call sites inject is.
          // The first version referenced it here and every C6 dry-run died with a ReferenceError
          // that surfaced as "the route never consulted the read-source store", i.e. the gate
          // vanished rather than failing loudly. Injected like getExternalSystem is.
          instanceDigestOf: typeof instanceDigestOf === 'function'
            ? (id) => instanceDigestOf({
              id, tenantId: pipeline.tenantId, workspaceId: pipeline.workspaceId ?? null,
            })
            : undefined,
          targetSystemId: pipeline.targetSystemId,
        },
      }),
      targetWriteProfile: K3_WISE_C6_WRITE_PROFILE,
      enforcedMaxRows: K3_WISE_C6_MAX_APPLY_ROWS,
    }
  }
  if (targetSystem && targetSystem.kind === MULTITABLE_WRITE_TARGET_KIND) {
    const flatConfig = deriveMultitablePlannerTargetConfig({
      system: targetSystem,
      object: pipeline.targetObject,
      fieldMappings: pipeline.fieldMappings,
    })
    return {
      planTargetSystem: { ...targetSystem, config: flatConfig },
      dataSourceWrites: createMetaSheetMultitableWriteSource({ system: targetSystem, context }),
      targetWriteProfile: MULTITABLE_WRITE_PROFILE,
    }
  }
  // default (data-source:sql-write-gated): host SQL write facade, planner uses its SQL profile.
  return {
    planTargetSystem: targetSystem,
    dataSourceWrites: context && context.api && context.api.dataSourceWrites,
    targetWriteProfile: undefined,
  }
}

function normalizeStockPreparationTargetRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_TARGET_REQUEST_INVALID', 'request must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!VALID_STOCK_PREPARATION_TARGET_REQUEST_KEYS.has(key)) {
      throw new HttpRouteError(400, 'STOCK_PREPARATION_TARGET_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return {
    tenantId: firstString(input.tenantId),
    workspaceId: firstString(input.workspaceId),
    projectId: firstString(input.projectId),
    baseId: firstString(input.baseId),
  }
}

// GHSA-m6qv-2rpf-q7mh step-1 follow-up: WRITE-path input. Same shape as stockPreparationTargetInput, but the
// tenant comes from the AUTHENTICATED principal only (resolveTenantId would honor a request tenantId
// for admins) AND the staging project is derived from that tenant WITHOUT a request projectId
// (resolveIntegrationStagingProjectId returns a request "X:integration-core" VERBATIM). stockPreparationTargetInput
// itself is UNCHANGED — its READ caller keeps today's behavior; whether an audited cross-tenant admin
// READ is desirable is GHSA step 2, decided separately.
// GHSA-m6qv-2rpf-q7mh step-1 follow-up (owner decision A): a stock-preparation WRITE request must NOT
// carry an explicit baseId. After the tenant/projectId steering vectors are closed, baseId is a THIRD,
// independent axis: the host writes meta_sheets.base_id from this value with NO base-ownership check
// (provisioning.ensureSheet INSERTs base_id verbatim), so an explicit baseId parents a structure write
// into ANOTHER tenant's base. baseId is optional — trial provisioning binds no base — so we reject an
// explicit one, fail-closed, BEFORE any provisioning call. A future re-binding must derive a writable
// base from the AUTHENTICATED principal (a host resolveBaseWritable), never trust the request baseId.
function assertNoRequestBaseId(rawInput) {
  if (rawInput && Object.prototype.hasOwnProperty.call(rawInput, 'baseId') && `${rawInput.baseId ?? ''}`.trim() !== '') {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_BASE_ID_NOT_ALLOWED', 'an explicit baseId is not allowed on a stock-preparation write; the target base is derived server-side from the authenticated tenant')
  }
}

function stockPreparationTargetWriteInput(req, rawInput = {}) {
  assertNoRequestBaseId(rawInput)
  const input = normalizeStockPreparationTargetRequest(rawInput)
  const tenantId = resolveAuthUserTenantId(req)
  const projectId = resolveIntegrationStagingProjectId(tenantId, undefined)
  return {
    tenantId,
    workspaceId: input.workspaceId,
    projectId,
  }
}

function stockPreparationTargetInput(req, rawInput = {}) {
  const input = normalizeStockPreparationTargetRequest(rawInput)
  const tenantId = resolveTenantId(req, input)
  const projectId = resolveIntegrationStagingProjectId(tenantId, input.projectId)
  return {
    tenantId,
    workspaceId: input.workspaceId,
    projectId,
    baseId: input.baseId,
  }
}

function optionSetAliasValue(input, errorCode) {
  const aliases = ['optionSets', 'optionSources', 'configInfo'].filter((key) =>
    Object.prototype.hasOwnProperty.call(input, key),
  )
  if (aliases.length > 1) {
    throw new HttpRouteError(400, errorCode, 'use only one option set request field alias', { fields: aliases.sort() })
  }
  return aliases.length === 1 ? input[aliases[0]] : {}
}

function normalizeStockPreparationSandboxTargetRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_SANDBOX_TARGET_REQUEST_INVALID', 'request must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!VALID_STOCK_PREPARATION_SANDBOX_TARGET_REQUEST_KEYS.has(key)) {
      throw new HttpRouteError(400, 'STOCK_PREPARATION_SANDBOX_TARGET_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return {
    tenantId: firstString(input.tenantId),
    workspaceId: firstString(input.workspaceId),
    projectId: firstString(input.projectId),
    baseId: firstString(input.baseId),
    objectId: firstString(input.objectId),
    label: firstString(input.label),
    optionSets: optionSetAliasValue(input, 'STOCK_PREPARATION_SANDBOX_TARGET_REQUEST_INVALID'),
  }
}

// GHSA-m6qv-2rpf-q7mh step-1 follow-up: WRITE-path input. Same shape as stockPreparationSandboxTargetInput, but the
// tenant comes from the AUTHENTICATED principal only (resolveTenantId would honor a request tenantId
// for admins) AND the staging project is derived from that tenant WITHOUT a request projectId
// (resolveIntegrationStagingProjectId returns a request "X:integration-core" VERBATIM). stockPreparationSandboxTargetInput
// itself is UNCHANGED — its READ caller keeps today's behavior; whether an audited cross-tenant admin
// READ is desirable is GHSA step 2, decided separately.
function stockPreparationSandboxTargetWriteInput(req, rawInput = {}) {
  assertNoRequestBaseId(rawInput)
  const input = normalizeStockPreparationSandboxTargetRequest(rawInput)
  const tenantId = resolveAuthUserTenantId(req)
  const projectId = resolveIntegrationStagingProjectId(tenantId, undefined)
  return {
    tenantId,
    workspaceId: input.workspaceId,
    projectId,
    objectId: input.objectId,
    label: input.label,
    optionSets: input.optionSets,
  }
}

function stockPreparationSandboxTargetInput(req, rawInput = {}) {
  const input = normalizeStockPreparationSandboxTargetRequest(rawInput)
  const tenantId = resolveTenantId(req, input)
  const projectId = resolveIntegrationStagingProjectId(tenantId, input.projectId)
  return {
    tenantId,
    workspaceId: input.workspaceId,
    projectId,
    baseId: input.baseId,
    objectId: input.objectId,
    label: input.label,
    optionSets: input.optionSets,
  }
}

function validateStockPreparationSandboxOptionSeedInput(input = {}) {
  const template = sandboxStockPreparationTemplate({ objectId: input.objectId, label: input.label })
  const optionSets = optionSetsFromInput(input.optionSets || {})
  const allowedSourceKeys = new Set(
    template.fields
      .filter((field) => field.type === 'select' && field.optionSource)
      .map((field) => field.optionSource.key),
  )
  const unknownSourceKey = Object.keys(optionSets).find((sourceKey) => !allowedSourceKeys.has(sourceKey))
  if (unknownSourceKey) {
    throw new StockPreparationOptionSyncError(422, 'OPTION_SYNC_UNKNOWN_SOURCE', 'option set source key is not declared by the stock-preparation sandbox template', {
      sourceKey: unknownSourceKey,
      targetObjectIdHash: hashEvidenceValue(template.objectId),
    })
  }
}

function normalizeStockPreparationOptionSyncRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_OPTION_SYNC_REQUEST_INVALID', 'request must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!VALID_STOCK_PREPARATION_OPTION_SYNC_REQUEST_KEYS.has(key)) {
      throw new HttpRouteError(400, 'STOCK_PREPARATION_OPTION_SYNC_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return {
    tenantId: firstString(input.tenantId),
    workspaceId: firstString(input.workspaceId),
    projectId: firstString(input.projectId),
    optionSets: optionSetAliasValue(input, 'STOCK_PREPARATION_OPTION_SYNC_REQUEST_INVALID'),
  }
}

function stockPreparationOptionSyncInput(req, rawInput = {}) {
  const input = normalizeStockPreparationOptionSyncRequest(rawInput)
  // GHSA-m6qv-2rpf-q7mh step-1 follow-up: WRITE-only face — hardened IN PLACE (no read caller), so
  // no steerable variant survives. Tenant from the AUTHENTICATED principal; staging project derived
  // from it WITHOUT a request projectId (both are steering vectors: resolveTenantId honors a request
  // tenantId for admins, and resolveIntegrationStagingProjectId returns "X:integration-core" verbatim).
  const tenantId = resolveAuthUserTenantId(req)
  const projectId = resolveIntegrationStagingProjectId(tenantId, undefined)
  return {
    tenantId,
    workspaceId: input.workspaceId,
    projectId,
    optionSets: input.optionSets,
  }
}

// #3751 MVP: `objectIds` may arrive as a JSON array (POST body) or a
// comma-separated query string (GET). Collapse to a trimmed string[] or
// undefined (undefined => all 9 MVP tables). The module validates membership.
function normalizeRequestedMvpObjectIds(raw) {
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [raw]
  const cleaned = []
  for (const value of list) {
    const objectId = firstString(value)
    if (objectId) cleaned.push(objectId)
  }
  return cleaned.length ? cleaned : undefined
}

function normalizeStockPreparationMvpTargetRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_MVP_TARGET_REQUEST_INVALID', 'request must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!VALID_STOCK_PREPARATION_MVP_TARGET_REQUEST_KEYS.has(key)) {
      throw new HttpRouteError(400, 'STOCK_PREPARATION_MVP_TARGET_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return {
    tenantId: firstString(input.tenantId),
    workspaceId: firstString(input.workspaceId),
    projectId: firstString(input.projectId),
    baseId: firstString(input.baseId),
    objectIds: normalizeRequestedMvpObjectIds(input.objectIds),
  }
}

// GHSA-m6qv-2rpf-q7mh step-1 follow-up: WRITE-path input. Same shape as stockPreparationMvpTargetInput, but the
// tenant comes from the AUTHENTICATED principal only (resolveTenantId would honor a request tenantId
// for admins) AND the staging project is derived from that tenant WITHOUT a request projectId
// (resolveIntegrationStagingProjectId returns a request "X:integration-core" VERBATIM). stockPreparationMvpTargetInput
// itself is UNCHANGED — its READ caller keeps today's behavior; whether an audited cross-tenant admin
// READ is desirable is GHSA step 2, decided separately.
function stockPreparationMvpTargetWriteInput(req, rawInput = {}) {
  assertNoRequestBaseId(rawInput)
  const input = normalizeStockPreparationMvpTargetRequest(rawInput)
  const tenantId = resolveAuthUserTenantId(req)
  const projectId = resolveIntegrationStagingProjectId(tenantId, undefined)
  return {
    tenantId,
    workspaceId: input.workspaceId,
    projectId,
    objectIds: input.objectIds,
  }
}

function stockPreparationMvpTargetInput(req, rawInput = {}) {
  const input = normalizeStockPreparationMvpTargetRequest(rawInput)
  const tenantId = resolveTenantId(req, input)
  const projectId = resolveIntegrationStagingProjectId(tenantId, input.projectId)
  return {
    tenantId,
    workspaceId: input.workspaceId,
    projectId,
    baseId: input.baseId,
    objectIds: input.objectIds,
  }
}

function normalizeStockPreparationMvpOptionSyncRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_MVP_OPTION_SYNC_REQUEST_INVALID', 'request must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!VALID_STOCK_PREPARATION_MVP_OPTION_SYNC_REQUEST_KEYS.has(key)) {
      throw new HttpRouteError(400, 'STOCK_PREPARATION_MVP_OPTION_SYNC_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return {
    tenantId: firstString(input.tenantId),
    workspaceId: firstString(input.workspaceId),
    projectId: firstString(input.projectId),
    objectIds: normalizeRequestedMvpObjectIds(input.objectIds),
    optionSets: optionSetAliasValue(input, 'STOCK_PREPARATION_MVP_OPTION_SYNC_REQUEST_INVALID'),
  }
}

function stockPreparationMvpOptionSyncInput(req, rawInput = {}) {
  const input = normalizeStockPreparationMvpOptionSyncRequest(rawInput)
  // GHSA-m6qv-2rpf-q7mh step-1 follow-up: WRITE-only face — hardened IN PLACE (no read caller), so
  // no steerable variant survives. Tenant from the AUTHENTICATED principal; staging project derived
  // from it WITHOUT a request projectId (both are steering vectors: resolveTenantId honors a request
  // tenantId for admins, and resolveIntegrationStagingProjectId returns "X:integration-core" verbatim).
  const tenantId = resolveAuthUserTenantId(req)
  const projectId = resolveIntegrationStagingProjectId(tenantId, undefined)
  return {
    tenantId,
    workspaceId: input.workspaceId,
    projectId,
    objectIds: input.objectIds,
    optionSets: input.optionSets,
  }
}

// #3751 MVP: parse the readonly sync-RUN PLAN body against a CLOSED allowlist. Deep validation of the
// plan inputs lives in the orchestrator; this only rejects unknown fields and passes the readonly plan
// inputs through. `projectId` is NOT rewritten to a staging sheet id — it is the PLM business project
// id and must reach the plan row verbatim.
function stockPreparationMvpSyncPlanInput(rawInput = {}) {
  if (!isPlainObject(rawInput)) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_MVP_SYNC_PLAN_REQUEST_INVALID', 'request must be an object')
  }
  for (const key of Object.keys(rawInput)) {
    if (!VALID_STOCK_PREPARATION_MVP_SYNC_PLAN_REQUEST_KEYS.has(key)) {
      throw new HttpRouteError(400, 'STOCK_PREPARATION_MVP_SYNC_PLAN_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return {
    projectId: rawInput.projectId,
    syncRunId: rawInput.syncRunId,
    snapshotBatchId: rawInput.snapshotBatchId,
    snapshotVersion: rawInput.snapshotVersion,
    sourceSystem: rawInput.sourceSystem,
    expansionResult: rawInput.expansionResult,
    previousSnapshotBatchId: rawInput.previousSnapshotBatchId,
    previousLines: rawInput.previousLines,
    readPlan: rawInput.readPlan,
    defaultDesignUnit: rawInput.defaultDesignUnit,
  }
}

// #3751 MVP: the COMMIT request allowlist is IDENTICAL to the sync-plan allowlist (same body the admin
// previewed with /plan is replayed to /persist). Reuse the frozen key set; a persist-specific error code.
// #4163 T1: `sourceProjectNo` / `projectName` ALSO ride this same body — persist (unlike plan) actually
// consumes them to upsert the project row.
function stockPreparationMvpSyncPersistInput(rawInput = {}) {
  if (!isPlainObject(rawInput)) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_MVP_SYNC_PERSIST_REQUEST_INVALID', 'request must be an object')
  }
  for (const key of Object.keys(rawInput)) {
    if (!VALID_STOCK_PREPARATION_MVP_SYNC_PLAN_REQUEST_KEYS.has(key)) {
      throw new HttpRouteError(400, 'STOCK_PREPARATION_MVP_SYNC_PERSIST_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  return {
    projectId: rawInput.projectId,
    syncRunId: rawInput.syncRunId,
    snapshotBatchId: rawInput.snapshotBatchId,
    snapshotVersion: rawInput.snapshotVersion,
    sourceSystem: rawInput.sourceSystem,
    sourceProjectNo: rawInput.sourceProjectNo,
    projectName: rawInput.projectName,
    expansionResult: rawInput.expansionResult,
    previousSnapshotBatchId: rawInput.previousSnapshotBatchId,
    previousLines: rawInput.previousLines,
    readPlan: rawInput.readPlan,
    defaultDesignUnit: rawInput.defaultDesignUnit,
  }
}

function normalizeStockPreparationSourceRunInputs(value, code) {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) {
    throw new HttpRouteError(400, code, 'source-run inputs must be an object', { field: 'inputs' })
  }
  if (Object.keys(value).some((key) => key !== 'key')) {
    throw new HttpRouteError(400, code, 'source-run inputs contain an unsupported field', { field: 'inputs.<unexpected>' })
  }
  return Object.prototype.hasOwnProperty.call(value, 'key') ? { key: value.key } : {}
}

function normalizeStockPreparationSourceRunBody(rawInput, allowedKeys, code) {
  if (!isPlainObject(rawInput)) {
    throw new HttpRouteError(400, code, 'source-run request must be an object')
  }
  for (const key of Object.keys(rawInput)) {
    if (!allowedKeys.has(key)) {
      throw new HttpRouteError(400, code, 'source-run request contains an unsupported field', { field: '<unexpected>' })
    }
  }
  return {
    tenantId: firstString(rawInput.tenantId),
    workspaceId: firstString(rawInput.workspaceId),
    projectId: firstString(rawInput.projectId),
    sourceProjectNo: firstString(rawInput.sourceProjectNo),
    projectName: firstString(rawInput.projectName),
    readSourceConfigId: firstString(rawInput.readSourceConfigId),
    inputs: normalizeStockPreparationSourceRunInputs(rawInput.inputs, code),
    syncRunId: firstString(rawInput.syncRunId),
    snapshotBatchId: firstString(rawInput.snapshotBatchId),
    snapshotVersion: rawInput.snapshotVersion,
  }
}

// #3751 MVP view 2: parse the readonly snapshot-read query against the CLOSED allowlist. Rejects any
// unknown query field; returns only the tenant/workspace scope + the raw (business) projectId.
function normalizeStockPreparationSnapshotReadQuery(input = {}, code, allowedKeys = VALID_STOCK_PREPARATION_SNAPSHOT_READ_QUERY_KEYS) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, code, 'request must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new HttpRouteError(400, code, `unsupported request field: ${key}`, { field: key })
    }
  }
  const out = {}
  for (const key of allowedKeys) {
    out[key] = firstString(input[key])
  }
  return out
}

// #4163 T1: PROJECT LIST query — tenant/workspace scope only (no business projectId: this route lists
// every synced project, it does not filter rows OF one). `targetProjectId` is the STAGING locator the
// MVP tables were provisioned under, derived from the auth tenant (never request-sourced), via the
// SAME resolveIntegrationStagingProjectId the ensure/readiness/persist routes use.
function stockPreparationProjectListInput(req, rawQuery = {}) {
  const input = normalizeStockPreparationSnapshotReadQuery(rawQuery, 'STOCK_PREPARATION_PROJECT_LIST_REQUEST_INVALID', VALID_STOCK_PREPARATION_PROJECT_LIST_QUERY_KEYS)
  const tenantId = resolveTenantId(req, input)
  return {
    tenantId,
    workspaceId: input.workspaceId,
    targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
  }
}

// LIST: `projectId` is the PLM business project (REQUIRED — it filters + is echoed). `targetProjectId`
// is the STAGING locator the MVP tables were provisioned under, derived from the auth tenant (never
// request-sourced) via the same resolveIntegrationStagingProjectId the ensure/readiness routes use.
function stockPreparationSnapshotBatchListInput(req, rawQuery = {}) {
  const input = normalizeStockPreparationSnapshotReadQuery(rawQuery, 'STOCK_PREPARATION_SNAPSHOT_BATCH_LIST_REQUEST_INVALID')
  const tenantId = resolveTenantId(req, input)
  const businessProjectId = input.projectId
  if (!businessProjectId) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_SNAPSHOT_BATCH_LIST_REQUEST_INVALID', 'projectId is required', { field: 'projectId' })
  }
  return {
    tenantId,
    workspaceId: input.workspaceId,
    businessProjectId,
    targetProjectId: resolveIntegrationStagingProjectId(tenantId, businessProjectId),
  }
}

// DIFF: the batch id rides the PATH. `projectId` query is OPTIONAL (the FE diff call sends none — the
// business project is read from the batch row server-side); `targetProjectId` is the STAGING locator
// derived from the auth tenant.
function stockPreparationSnapshotDiffInput(req, rawQuery = {}) {
  const input = normalizeStockPreparationSnapshotReadQuery(rawQuery, 'STOCK_PREPARATION_SNAPSHOT_DIFF_REQUEST_INVALID', VALID_STOCK_PREPARATION_SNAPSHOT_DIFF_QUERY_KEYS)
  const tenantId = resolveTenantId(req, input)
  const snapshotBatchId = firstString(requestParams(req).snapshotBatchId)
  if (!snapshotBatchId) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_SNAPSHOT_DIFF_REQUEST_INVALID', 'snapshotBatchId is required', { field: 'snapshotBatchId' })
  }
  return {
    tenantId,
    workspaceId: input.workspaceId,
    businessProjectId: input.projectId,
    snapshotBatchId,
    baseSnapshotBatchId: input.baseSnapshotBatchId,
    targetProjectId: resolveIntegrationStagingProjectId(tenantId, input.projectId),
  }
}

// #3751 MVP W3: diff/rows query — DIFF keys + the two ENUM filters, gated against the engine's frozen
// vocabularies at the route (values-free 400 with the field name only).
function stockPreparationSnapshotDiffRowsInput(req, rawQuery = {}) {
  const input = normalizeStockPreparationSnapshotReadQuery(rawQuery, 'STOCK_PREPARATION_SNAPSHOT_DIFF_ROWS_REQUEST_INVALID', VALID_STOCK_PREPARATION_SNAPSHOT_DIFF_ROWS_QUERY_KEYS)
  const tenantId = resolveTenantId(req, input)
  const snapshotBatchId = firstString(requestParams(req).snapshotBatchId)
  if (!snapshotBatchId) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_SNAPSHOT_DIFF_ROWS_REQUEST_INVALID', 'snapshotBatchId is required', { field: 'snapshotBatchId' })
  }
  if (input.reviewStatus && !Object.values(STOCK_PREPARATION_REVIEW_STATUSES).includes(input.reviewStatus)) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_SNAPSHOT_DIFF_ROWS_REQUEST_INVALID', 'reviewStatus must be one of the review-status vocabulary', { field: 'reviewStatus' })
  }
  if (input.diffType && !Object.values(STOCK_PREPARATION_DIFF_TYPES).includes(input.diffType)) {
    throw new HttpRouteError(400, 'STOCK_PREPARATION_SNAPSHOT_DIFF_ROWS_REQUEST_INVALID', 'diffType must be one of the diff-type vocabulary', { field: 'diffType' })
  }
  return {
    tenantId,
    workspaceId: input.workspaceId,
    businessProjectId: input.projectId,
    snapshotBatchId,
    baseSnapshotBatchId: input.baseSnapshotBatchId,
    reviewStatus: input.reviewStatus,
    diffType: input.diffType,
    targetProjectId: resolveIntegrationStagingProjectId(tenantId, input.projectId),
  }
}

// #3751 MVP W3 (confirm reads): shared parse for the four read routes. `projectId` is REQUIRED on
// every one (FE always sends it; #4002-LIST parity) even where the table is tenant-scoped.
function stockPreparationConfirmReadInput(req, rawQuery, allowedKeys, code) {
  const input = normalizeStockPreparationSnapshotReadQuery(rawQuery, code, allowedKeys)
  const tenantId = resolveTenantId(req, input)
  if (!input.projectId) {
    throw new HttpRouteError(400, code, 'projectId is required', { field: 'projectId' })
  }
  return {
    ...input,
    tenantId,
    targetProjectId: resolveIntegrationStagingProjectId(tenantId, input.projectId),
  }
}

// #3751 MVP W3: parse a confirm-write body against ITS route's closed allowlist. Unknown fields
// (including body-supplied confirmedBy / confirmedAt) are rejected with the field NAME only.
function normalizeStockPreparationConfirmBody(input, allowedKeys, code) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, code, 'request must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new HttpRouteError(400, code, `unsupported request field: ${key}`, { field: key })
    }
  }
  return input
}

function normalizeFieldOptionSyncRequest(input = {}) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, 'FIELD_OPTION_SYNC_REQUEST_INVALID', 'request must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!VALID_FIELD_OPTION_SYNC_REQUEST_KEYS.has(key)) {
      throw new HttpRouteError(400, 'FIELD_OPTION_SYNC_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
    }
  }
  const presetId = firstString(input.presetId)
  if (!presetId) {
    throw new HttpRouteError(400, 'FIELD_OPTION_SYNC_REQUEST_INVALID', 'presetId is required', { field: 'presetId' })
  }
  return {
    tenantId: firstString(input.tenantId),
    workspaceId: firstString(input.workspaceId),
    projectId: firstString(input.projectId),
    presetId,
    optionSets: isPlainObject(input.optionSets) ? input.optionSets : {},
    dryRun: input.dryRun === true,
  }
}

function fieldOptionSyncInput(req, rawInput = {}) {
  const input = normalizeFieldOptionSyncRequest(rawInput)
  // GHSA-m6qv-2rpf-q7mh step-1 follow-up: WRITE-only face — hardened IN PLACE (no read caller), so
  // no steerable variant survives. Tenant from the AUTHENTICATED principal; staging project derived
  // from it WITHOUT a request projectId (both are steering vectors: resolveTenantId honors a request
  // tenantId for admins, and resolveIntegrationStagingProjectId returns "X:integration-core" verbatim).
  const tenantId = resolveAuthUserTenantId(req)
  const projectId = resolveIntegrationStagingProjectId(tenantId, undefined)
  return {
    tenantId,
    workspaceId: input.workspaceId,
    projectId,
    presetId: input.presetId,
    optionSets: input.optionSets,
    dryRun: input.dryRun === true,
  }
}

// FOS-2: resolve a FOS preset from the FOS-1 catalog by presetId (422 on unknown). Returns the
// validated, deep-copied preset (values-free by FOS-1 construction).
function resolveFieldOptionSyncPreset(presetId) {
  const preset = listFieldOptionSyncPresets().find((entry) => entry.presetId === presetId)
  if (!preset) {
    throw new HttpRouteError(422, 'FIELD_OPTION_SYNC_PRESET_UNKNOWN', 'field-option-sync preset is not in the catalog', { presetId })
  }
  return preset
}

// FOS-2: project preset optionFields ({valueField=sourceKey, targetField=field id}) into the kernel's
// optionFields shape ([{ id, optionSource:{ key, type } }]). type is the FOS source kind (metadata only).
function fieldOptionSyncKernelFields(preset) {
  return preset.optionFields.map((field) => ({
    id: field.targetField,
    optionSource: { key: field.valueField, type: preset.sourceKind },
  }))
}

// FOS-4b-2: strip action bindings from option sets before the (option-only) normalizer. Action bindings
// are validated separately via the FOS-4b-1 registry; this keeps the option normalizer free of them.
function stripActionBindingsFromOptionSets(optionSets) {
  const out = {}
  for (const [key, value] of Object.entries(optionSets)) {
    if (!Array.isArray(value)) { out[key] = value; continue }
    out[key] = value.map((option) => {
      if (!isPlainObject(option)) return option
      const { actionBindings, actions, ...rest } = option
      return rest
    })
  }
  return out
}

// FOS-2: values-free per-field evidence for the generic route (no option values/labels, no sheetId).
function summarizeFieldOptionSyncEvidence({ preset, synced, skipped }) {
  return {
    presetId: preset.presetId,
    targetTable: preset.targetTable,
    fields: synced.map((entry) => ({
      field: entry.field,
      sourceKey: entry.optionSource.key,
      optionCount: entry.set.options.length,
    })),
    skipped: skipped.map((entry) => ({
      field: entry.field,
      sourceKey: entry.optionSource.key,
      reason: entry.reason,
    })),
  }
}

function publicStockPreparationTargetResult(result) {
  return {
    ready: result.ready === true,
    mode: result.mode,
    targetBinding: result.target ? cloneJson(result.target) : null,
    evidence: result.evidence,
  }
}

function publicStockPreparationSandboxTargetResult(result) {
  return {
    ready: result.ready === true,
    mode: result.mode,
    targetBindingAvailable: result.target != null,
    // THE BINDING THIS ROUTE JUST CREATED OR VERIFIED — the thing a deployer has to paste into
    // `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`. This route IS the sanctioned
    // generator (the 222 window runbook sends operators here), and returning nothing made that
    // instruction impossible to follow: the response carried no sheetId, no fieldIdMap, not even a
    // plaintext objectId.
    //
    // It is the SAME key and shape the canonical sibling has always returned at this same admin tier
    // (publicStockPreparationTargetResult), so this removes an asymmetry rather than opening a door.
    // Nothing here is a disclosure: `objectId` is the caller's own request body, and `sheetId` and
    // every fieldIdMap entry are pure functions of (projectId, objectId) that
    // scripts/ops/stock-preparation-derive-target-binding.mjs prints offline with no auth at all.
    //
    // `evidence` below is deliberately NOT changed: it still hashes the objectId and carries no
    // option values or labels, because that half travels into issue reports while this half is an
    // answer to the admin who just asked.
    targetBinding: result.target ? cloneJson(result.target) : null,
    evidence: result.evidence,
    ...(result.optionSync ? { optionSync: result.optionSync } : {}),
  }
}

function sandboxTargetRouteError(error) {
  if (error instanceof HttpRouteError) return error
  if (error instanceof StockPreparationTargetProvisioningError) {
    const code = error.code || 'TARGET_SANDBOX_PROVISIONING_FAILED'
    if (
      code === 'TARGET_SANDBOX_OBJECT_ID_INVALID' ||
      code === 'TARGET_PROVISIONING_CONFIG_INVALID' ||
      code === 'TARGET_PROVISIONING_PERMISSION_DENIED' ||
      code === 'TARGET_PROVISIONING_API_UNAVAILABLE' ||
      code === 'TARGET_SCHEMA_INCOMPLETE'
    ) {
      return new HttpRouteError(
        Number.isInteger(error.status) ? error.status : 422,
        code,
        error.message || 'sandbox stock-preparation target provisioning failed',
        error.details || {},
      )
    }
  }
  if (error instanceof StockPreparationOptionSyncError) {
    return new HttpRouteError(
      Number.isInteger(error.status) ? error.status : 422,
      error.code || 'TARGET_SANDBOX_OPTION_SYNC_FAILED',
      error.message || 'sandbox stock-preparation target option sync failed',
      error.details || {},
    )
  }
  return new HttpRouteError(
    503,
    'TARGET_SANDBOX_PROVISIONING_FAILED',
    'sandbox stock-preparation target provisioning failed',
    { reason: 'provisioning_failed' },
  )
}

function largeBomExpansionOptionsForAction(action = {}) {
  const source = isPlainObject(action.source) ? action.source : {}
  const options = {
    readPlan: source.readPlan,
    pageLimit: action.pageLimit,
    maxPages: action.maxPages,
    maxReadCount: action.maxReadCount,
    maxElapsedMs: action.maxElapsedMs,
    maxDepth: action.maxDepth,
    maxRows: action.maxRows,
  }
  for (const key of Object.keys(options)) {
    if (options[key] === undefined || options[key] === null || options[key] === '') delete options[key]
  }
  return options
}

function assertApplyJobMatchesExpansion(applyJob, jobId) {
  if (firstString(applyJob && applyJob.sourceJobId) === firstString(jobId)) return applyJob
  throw new HttpRouteError(404, 'LARGE_BOM_APPLY_JOB_NOT_FOUND', 'large-BOM checkpoint apply job was not found', {
    applyJobIdPresent: Boolean(firstString(applyJob && applyJob.jobId)),
    sourceJobIdPresent: Boolean(firstString(jobId)),
  })
}

function redactDeadLetter(deadLetter, fullPayload = false) {
  if (!deadLetter || typeof deadLetter !== 'object') return deadLetter
  if (fullPayload) {
    return {
      ...deadLetter,
      sourcePayload: sanitizeIntegrationPayload(deadLetter.sourcePayload),
      transformedPayload: sanitizeIntegrationPayload(deadLetter.transformedPayload),
      // Scrub secret-shaped values from the free-text error message at display time too,
      // so pre-fix dead-letters (stored before write-time scrubbing) cannot leak on read.
      errorMessage: scrubSecretStringValue(deadLetter.errorMessage),
      payloadRedacted: true,
    }
  }
  const { sourcePayload: _sourcePayload, transformedPayload: _transformedPayload, ...safe } = deadLetter
  return {
    ...safe,
    errorMessage: scrubSecretStringValue(deadLetter.errorMessage),
    payloadRedacted: true,
  }
}

function redactSystemForTest(system) {
  if (!system || typeof system !== 'object') return system
  return {
    ...system,
    credentials: undefined,
    credentialsEncrypted: undefined,
  }
}

const TEST_CONNECTION_RESULT_KEYS = new Set([
  'ok',
  'status',
  'code',
  'message',
  'authenticated',
  'connected',
])
// Secret-text shapes are no longer maintained here — consolidated into the shared
// scrubber (payload-redaction.cjs `scrubSecretStringValue`). See redactSecretText below.
const DEFAULT_ADAPTER_SUPPORTS = ['testConnection', 'listObjects', 'getSchema', 'read', 'upsert']
const DEFAULT_ADAPTER_ROLES = ['source', 'target', 'bidirectional']
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

// Route-level secret-text redaction delegates to the shared scrubber
// (payload-redaction.cjs) — single secret-shape source, no second regex set here.
// DSN userinfo now preserves the username and masks only the password
// (scheme://user:[redacted]@host), matching the shared diagnostic-preserving behavior.
const redactSecretText = scrubSecretStringValue

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function describeAdapterKind(kind, adapterMetadata) {
  const metadata = adapterMetadata || {}
  return {
    kind,
    label: metadata.label || kind,
    roles: Array.isArray(metadata.roles) ? [...metadata.roles] : [...DEFAULT_ADAPTER_ROLES],
    supports: Array.isArray(metadata.supports) ? [...metadata.supports] : [...DEFAULT_ADAPTER_SUPPORTS],
    advanced: metadata.advanced === true,
    ...(metadata.guardrails ? { guardrails: cloneJson(metadata.guardrails) } : {}),
  }
}

function assertRelativeTemplatePath(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field} must be a string`, { field })
  }
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field} must be relative to the external-system base URL`, { field })
  }
  if (/[\u0000-\u001F\u007F]/.test(trimmed) || trimmed.includes('\\')) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field} must be a safe URL path`, { field })
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function normalizeTemplateSchema(schema, field) {
  if (schema === undefined || schema === null) return []
  if (!Array.isArray(schema)) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.schema must be an array`, { field: `${field}.schema` })
  }
  return schema.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.schema[${index}] must be an object`, {
        field: `${field}.schema[${index}]`,
      })
    }
    const name = firstString(item.name)
    if (!name) {
      throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.schema[${index}].name is required`, {
        field: `${field}.schema[${index}].name`,
      })
    }
    return {
      ...sanitizeIntegrationPayload(item),
      name,
      label: firstString(item.label) || name,
      type: firstString(item.type) || 'string',
      required: item.required === true,
    }
  })
}

function normalizeDocumentTemplate(template, index) {
  const field = `config.documentTemplates[${index}]`
  if (!isPlainObject(template)) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field} must be an object`, { field })
  }
  const id = firstString(template.id)
  if (!id) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.id is required`, { field: `${field}.id` })
  }
  const label = firstString(template.label)
  if (!label) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.label is required`, { field: `${field}.label` })
  }
  const object = firstString(template.object)
  if (!object) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATE', `${field}.object is required`, { field: `${field}.object` })
  }
  const bodyKey = firstString(template.bodyKey) || 'Data'
  const endpointPath = assertRelativeTemplatePath(
    firstString(template.endpointPath, template.savePath, template.path),
    `${field}.endpointPath`,
  )
  const operations = Array.isArray(template.operations) && template.operations.length > 0
    ? template.operations.map((operation) => firstString(operation)).filter(Boolean)
    : ['upsert']
  return {
    id,
    name: object,
    object,
    label,
    operations: operations.length > 0 ? operations : ['upsert'],
    schema: normalizeTemplateSchema(template.schema, field),
    source: 'documentTemplate',
    template: sanitizeIntegrationPayload({
      id,
      version: firstString(template.version),
      bodyKey,
      endpointPath,
      source: 'custom',
    }),
  }
}

function listDocumentTemplates(system) {
  const templates = system && system.config ? system.config.documentTemplates : undefined
  if (templates === undefined || templates === null) return []
  if (!Array.isArray(templates)) {
    throw new HttpRouteError(400, 'INVALID_DOCUMENT_TEMPLATES', 'config.documentTemplates must be an array', {
      field: 'config.documentTemplates',
    })
  }
  return templates.map((template, index) => normalizeDocumentTemplate(template, index))
}

function findDocumentTemplate(system, object) {
  return listDocumentTemplates(system).find((template) => template.object === object || template.name === object) || null
}

function normalizePreviewFieldMappings(value) {
  if (!Array.isArray(value)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'fieldMappings must be an array', { field: 'fieldMappings' })
  }
  return value
}

function normalizePreviewBodyKey(value) {
  const bodyKey = firstString(value) || 'Data'
  if (DANGEROUS_JSON_KEYS.has(bodyKey)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'template.bodyKey is unsafe', { field: 'template.bodyKey' })
  }
  if (/[\u0000-\u001F\u007F]/.test(bodyKey)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'template.bodyKey must be a safe JSON key', { field: 'template.bodyKey' })
  }
  return bodyKey
}

function normalizePreviewTemplate(value) {
  if (value === undefined || value === null) {
    return {
      bodyKey: 'Data',
      schema: [],
      meta: { bodyKey: 'Data' },
    }
  }
  if (!isPlainObject(value)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'template must be an object', { field: 'template' })
  }
  const endpointPath = assertRelativeTemplatePath(
    firstString(value.endpointPath, value.savePath, value.path),
    'template.endpointPath',
  )
  const bodyKey = normalizePreviewBodyKey(value.bodyKey)
  return {
    bodyKey,
    schema: normalizeTemplateSchema(value.schema, 'template'),
    meta: sanitizeIntegrationPayload({
      id: firstString(value.id),
      version: firstString(value.version),
      documentType: firstString(value.documentType, value.object, value.targetObject),
      bodyKey,
      endpointPath,
    }),
  }
}

function schemaRequiredErrors(record, schema) {
  const errors = []
  for (const field of schema || []) {
    if (field && field.required === true) {
      const value = getPath(record, field.name)
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        errors.push({
          field: field.name,
          code: 'REQUIRED',
          message: `${field.label || field.name} is required`,
          value,
          rule: 'required',
          details: { source: 'template.schema' },
        })
      }
    }
  }
  return errors
}

// projectRecordForTemplate / applyPreviewReferenceShape / normalizePreviewReferenceIdentifier
// moved to the shared K3 Save-body composer (DF-T1-0): the preview now composes
// byte-identically to the adapter Save instead of via a divergent duplicate.

// ---- DF-T1: target payload template preview (shape B — evidence under targetPayloadPreview) ----
const DF_T1_SOURCE_TYPES = new Set(['from_staging', 'from_constant', 'preserve_template', 'from_reference_table'])
const DF_T1_SHAPES = new Set(['scalar', 'object-passthrough', 'by-fnumber', 'by-fid'])
const DF_T1_COMPLETENESS = new Set(['none', 'require-fnumber-fname', 'require-fid-fname'])

function normalizeFieldRules(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'fieldRules must be an array', { field: 'fieldRules' })
  }
  return value.map((rule, index) => {
    if (!isPlainObject(rule)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `fieldRules[${index}] must be an object`, { field: `fieldRules[${index}]` })
    }
    const targetField = firstString(rule.targetField)
    if (!targetField) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `fieldRules[${index}].targetField is required`, { field: `fieldRules[${index}].targetField` })
    }
    const sourceType = firstString(rule.sourceType) || 'from_staging'
    if (!DF_T1_SOURCE_TYPES.has(sourceType)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `fieldRules[${index}].sourceType is invalid`, { field: `fieldRules[${index}].sourceType` })
    }
    const shape = firstString(rule.shape) || 'scalar'
    if (!DF_T1_SHAPES.has(shape)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `fieldRules[${index}].shape is invalid`, { field: `fieldRules[${index}].shape` })
    }
    const completeness = firstString(rule.completeness) || 'none'
    if (!DF_T1_COMPLETENESS.has(completeness)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `fieldRules[${index}].completeness is invalid`, { field: `fieldRules[${index}].completeness` })
    }
    return {
      targetField,
      sourceType,
      sourceField: firstString(rule.sourceField) || targetField,
      value: rule.value,
      shape,
      completeness,
      required: rule.required === true,
      // DF-T3b-2a: domain selects the mapping index for a from_reference_table rule (else undefined).
      domain: firstString(rule.domain) || undefined,
    }
  })
}

// Reuse the shared composer's reference shaping — never a new K3 shaper (DF-T1 req #3).
function applyDfT1Shape(value, shape) {
  if (shape === 'by-fnumber') return applyReferenceShape(value, { reference: { identifier: 'FNumber' } })
  if (shape === 'by-fid') return applyReferenceShape(value, { reference: { identifier: 'FID' } })
  return value // scalar / object-passthrough → as-is
}

function checkReferenceCompleteness(completeness, value) {
  if (completeness === 'require-fnumber-fname') {
    return isPlainObject(value) && !isBlankValue(value.FNumber) && !isBlankValue(value.FName) ? null : 'require-fnumber-fname'
  }
  if (completeness === 'require-fid-fname') {
    return isPlainObject(value) && !isBlankValue(value.FID) && !isBlankValue(value.FName) ? null : 'require-fid-fname'
  }
  return null
}

// DF-T3b-2b: bindings telling the preview which staging system/object holds each domain's mapping
// sheet. Tenant-scoped (the system is loaded scoped to the request) — the client names a binding, the
// server does the bulk-read. [{ domain, systemId, object }].
function normalizeReferenceMappingSources(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'referenceMappingSources must be an array', { field: 'referenceMappingSources' })
  }
  const seenDomains = new Set()
  return value.map((source, index) => {
    if (!isPlainObject(source)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `referenceMappingSources[${index}] must be an object`, { field: `referenceMappingSources[${index}]` })
    }
    const domain = firstString(source.domain)
    const systemId = firstString(source.systemId)
    const object = firstString(source.object)
    if (!domain || !systemId || !object) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `referenceMappingSources[${index}] requires domain, systemId, object`, { field: `referenceMappingSources[${index}]` })
    }
    // P2: one sheet per domain (#2036). A duplicate domain is a config error — fail closed rather than
    // silently letting the last binding win (Object.assign would otherwise overwrite).
    if (seenDomains.has(domain)) {
      throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `referenceMappingSources has a duplicate domain: ${domain}`, { field: `referenceMappingSources[${index}].domain` })
    }
    seenDomains.add(domain)
    return { domain, systemId, object }
  })
}

function buildTargetPayloadPreview(input, options = {}) {
  if (!isPlainObject(input.sourceRecord)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'sourceRecord must be an object', { field: 'sourceRecord' })
  }
  // DF-T3b-2a: mapping indexes are SERVER-SIDE only (not from the client body) — passed via options.
  // T3b-2a injects them in tests; T3b-2b will source them from a live mapping-sheet bulk-read.
  const referenceMappingIndexes = isPlainObject(options.referenceMappingIndexes) ? options.referenceMappingIndexes : undefined
  // Reuse the legacy preview's bodyKey guard (rejects __proto__/prototype/constructor and
  // control chars) — DF-T1 must NOT bypass it (P2).
  const bodyKey = normalizePreviewBodyKey(
    firstString(input.bodyKey) || (isPlainObject(input.template) ? firstString(input.template.bodyKey) : null),
  )
  const fieldRules = normalizeFieldRules(input.fieldRules)
  // Preserve whole-object payloadTemplate defaults; rules replace only the declared fields.
  const merged = cloneJson(input.payloadTemplate)
  const fieldProvenance = {}
  const missingRequiredFields = []
  const unresolvedReferenceComponents = []
  const referenceResolutions = [] // DF-T3b-2a: values-free resolution evidence per from_reference_table rule
  for (const rule of fieldRules) {
    if (rule.sourceType === 'preserve_template') {
      fieldProvenance[rule.targetField] = 'template'
    } else {
      let raw
      if (rule.sourceType === 'from_staging') {
        raw = getPath(input.sourceRecord, rule.sourceField)
      } else if (rule.sourceType === 'from_reference_table') {
        // DF-T3b-2a: resolve the material's sourceCode via the injected mapping index for rule.domain,
        // through the SHARED decision fn (so preview ≡ the record materializer). Non-resolved
        // (unresolved/ambiguous/incomplete) → UNRESOLVED sentinel → fail-closed via
        // findUnfilledPlaceholders, identical to the Save side. Evidence is values-free.
        const resolution = resolveReferenceRuleValue(referenceMappingIndexes, rule, getPath(input.sourceRecord, rule.sourceField))
        raw = resolution.value
        referenceResolutions.push({ field: rule.targetField, status: resolution.outcome.status, evidence: resolution.outcome.evidence })
      } else {
        raw = rule.value // from_constant
      }
      fieldProvenance[rule.targetField] = rule.sourceType === 'from_staging' ? 'staging'
        : rule.sourceType === 'from_constant' ? 'constant' : 'reference_table'
      const shaped = applyDfT1Shape(raw, rule.shape)
      if (isBlankValue(shaped)) {
        if (rule.required) missingRequiredFields.push(rule.targetField)
        // leave the template default in place; if it is a placeholder, fail-closed catches it.
      } else {
        setPath(merged, rule.targetField, shaped)
      }
    }
    const finalValue = getPath(merged, rule.targetField)
    if (rule.required && isBlankValue(finalValue) && !missingRequiredFields.includes(rule.targetField)) {
      missingRequiredFields.push(rule.targetField)
    }
    const incomplete = checkReferenceCompleteness(rule.completeness, finalValue)
    if (incomplete) unresolvedReferenceComponents.push({ field: rule.targetField, rule: incomplete })
  }

  const payload = { [bodyKey]: cloneJson(merged) }
  // Same placeholder DETECTION + CODE as the Save path (shared composer findUnfilledPlaceholders).
  const placeholderErrors = findUnfilledPlaceholders(payload).map((path) => ({
    field: path,
    code: 'K3_WISE_PRESET_PLACEHOLDER_UNFILLED',
    message: `unfilled template placeholder at ${path}`,
  }))
  // DF-T1.5: when the workbench UI path supplied fieldMappings, the DF-T1 branch ran the same
  // transform + (non-required) validation the legacy pipeline runs and passes the errors through
  // here, so the preview reflects the real pipeline. Runbook callers omit fieldMappings → both
  // stay [] (shape B). required stays owned by the fieldRules (missingRequiredFields).
  const transformErrors = (Array.isArray(input.transformErrors) ? input.transformErrors : []).map((e) => cloneJson(e))
  const validationErrors = (Array.isArray(input.validationErrors) ? input.validationErrors : []).map((e) => cloneJson(e))
  const errors = [
    ...transformErrors,
    ...validationErrors,
    ...placeholderErrors,
    ...missingRequiredFields.map((field) => ({ field, code: 'REQUIRED', message: `${field} is required` })),
    ...unresolvedReferenceComponents.map((u) => ({ field: u.field, code: 'INCOMPLETE_REFERENCE', message: `${u.field} requires ${u.rule}` })),
  ].map((e) => cloneJson(e))

  const response = sanitizeIntegrationPayload({
    valid: errors.length === 0,
    payload,
    targetRecord: cloneJson(merged),
    errors,
    placeholderErrors: placeholderErrors.map((e) => cloneJson(e)),
    // Shape-B: schemaErrors stays []. transformErrors/validationErrors are populated only when
    // fieldMappings were supplied (the UI path); runbook callers (no fieldMappings) keep them []
    // (P2). required is owned by the fieldRules (missingRequiredFields), not validationErrors.
    transformErrors,
    validationErrors,
    schemaErrors: [],
    targetPayloadPreview: {
      eligibleForSaveOnly: errors.length === 0,
      unresolvedPlaceholders: placeholderErrors.map((e) => e.field),
      unresolvedReferenceComponents: cloneJson(unresolvedReferenceComponents),
      missingRequiredFields: cloneJson(missingRequiredFields),
      fieldProvenance: cloneJson(fieldProvenance),
      // DF-T3b-2a: values-free per-reference resolution evidence (field/domain/sourceCode-presence/
      // error-type only — never customer values). Empty unless from_reference_table rules ran.
      referenceResolutions: cloneJson(referenceResolutions),
      compositionSource: 'k3-save-body-composer',
    },
  })
  // Redaction self-check: no secret-shaped value survived the sanitizer (DF-T1 req #4).
  const serialized = JSON.stringify(response)
  response.targetPayloadPreview.redactionSelfCheck = {
    applied: true,
    clean: serialized === scrubSecretStringValue(serialized),
  }
  return response
}

function buildTemplatePreview(input, options = {}) {
  if (!isPlainObject(input)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'input must be an object')
  }
  // DF-T1: target payload template mode (payloadTemplate + fieldRules). DF-T1 evidence is
  // namespaced under `targetPayloadPreview`; the legacy fieldMappings/schema preview is unchanged
  // and never carries that field (DF-T1 req #1, #2).
  if (Object.prototype.hasOwnProperty.call(input, 'payloadTemplate') && !isPlainObject(input.payloadTemplate)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'payloadTemplate must be an object', { field: 'payloadTemplate' })
  }
  if (isPlainObject(input.payloadTemplate)) {
    // DF-T1.5 reachability wire: when fieldMappings are provided (the workbench UI path), run the
    // SAME transform the legacy pipeline runs and compose from the TRANSFORMED record (keyed by
    // target field) so the DF-T1 preview predicts the real Save body, not raw staging values.
    // Derived fieldRules use sourceField = targetField. Callers that omit fieldMappings (operator
    // runbook evidence with a target-shaped sourceRecord) keep reading raw — same shape, two callers.
    const rawMappings = Array.isArray(input.fieldMappings) ? input.fieldMappings : []
    if (rawMappings.length > 0) {
      const fieldMappings = normalizePreviewFieldMappings(rawMappings)
      const transformed = transformRecord(input.sourceRecord, fieldMappings)
      // Run the SAME validation the legacy pipeline runs — but strip `required` from the mappings:
      // required is already enforced by the derived fieldRules (missingRequiredFields), so this avoids
      // double-counting while still surfacing non-required validations (min/max/regex/...) that the
      // pipeline would reject. Closes the residual "green DF-T1 preview but pipeline rejects" gap.
      const nonRequiredMappings = fieldMappings.map((mapping) => ({
        ...mapping,
        validation: Array.isArray(mapping.validation) ? mapping.validation.filter((rule) => rule && rule.type !== 'required') : [],
      }))
      const validation = transformed.ok ? validateRecord(transformed.value, nonRequiredMappings) : { errors: [] }
      // transformed.value is always an object (the legacy path projects it even when !ok); the errors
      // carry the bad news and are surfaced via transformErrors / validationErrors below.
      return buildTargetPayloadPreview({
        ...input,
        sourceRecord: transformed.value,
        transformErrors: transformed.errors,
        validationErrors: validation.errors,
      }, options)
    }
    return buildTargetPayloadPreview(input, options)
  }
  if (!isPlainObject(input.sourceRecord)) {
    throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', 'sourceRecord must be an object', { field: 'sourceRecord' })
  }
  const fieldMappings = normalizePreviewFieldMappings(input.fieldMappings)
  const template = normalizePreviewTemplate(input.template)
  const transformed = transformRecord(input.sourceRecord, fieldMappings)
  const validation = transformed.ok ? validateRecord(transformed.value, fieldMappings) : { ok: true, valid: true, errors: [] }
  const requiredErrors = transformed.ok ? schemaRequiredErrors(transformed.value, template.schema) : []
  // Compose through the shared composer (same projection + reference shaping + drop-blank the
  // adapter Save uses). template carries .schema + .bodyKey, so it serves as the objectConfig.
  const targetRecord = projectRecordForBody(transformed.value, template)
  const payload = {
    [template.bodyKey]: cloneJson(targetRecord),
  }
  // Same placeholder DETECTION as the Save path; the preview's disposition is valid:false
  // (the Save path throws). A clean preview therefore cannot hide a placeholder the Save rejects.
  // Same error CODE as the Save path's throw, so an operator can correlate a preview-detected
  // placeholder with the Save-side failure that would follow.
  const placeholderErrors = findUnfilledPlaceholders(payload).map((path) => ({
    field: path,
    code: 'K3_WISE_PRESET_PLACEHOLDER_UNFILLED',
    message: `unfilled template placeholder at ${path}`,
  }))
  const errors = [
    ...transformed.errors,
    ...validation.errors,
    ...requiredErrors,
    ...placeholderErrors,
  ].map((error) => cloneJson(error))
  return sanitizeIntegrationPayload({
    valid: errors.length === 0,
    payload,
    targetRecord: cloneJson(targetRecord),
    errors,
    transformErrors: transformed.errors.map((error) => cloneJson(error)),
    validationErrors: validation.errors.map((error) => cloneJson(error)),
    schemaErrors: requiredErrors.map((error) => cloneJson(error)),
    placeholderErrors: placeholderErrors.map((error) => cloneJson(error)),
    template: template.meta,
  })
}

function sanitizeTestConnectionResult(result) {
  const safe = {}
  for (const key of TEST_CONNECTION_RESULT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue
    const value = result[key]
    safe[key] = typeof value === 'string' ? redactSecretText(value) : value
  }
  return safe
}

function normalizeTestConnectionResult(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return sanitizeTestConnectionResult(result)
  }
  return {
    ok: result !== false,
  }
}

function testConnectionErrorResult(error) {
  return {
    ok: false,
    code: error && (error.code || error.name) ? String(error.code || error.name) : 'TEST_CONNECTION_FAILED',
    message: redactSecretText(error && error.message ? error.message : String(error)),
  }
}

function resolveTestedStatus(system, result) {
  if (!result || result.ok !== true) return 'error'
  // A connection test must not silently enable an intentionally inactive
  // external system. It only clears a previous error status after success.
  if (system && system.status === 'inactive') return 'inactive'
  return 'active'
}

function resolveTestError(result) {
  if (result && result.ok === true) return null
  return firstString(
    result && typeof result.message === 'string' ? redactSecretText(result.message) : result && result.message,
    result && typeof result.code === 'string' ? redactSecretText(result.code) : result && result.code,
    'connection test failed',
  )
}

async function persistExternalSystemTestResult(externalSystems, req, system, result) {
  if (!system || !system.id || !system.name || !system.kind) return null
  return externalSystems.upsertExternalSystem(scopedInput(req, {
    id: system.id,
    name: system.name,
    kind: system.kind,
    role: system.role || 'bidirectional',
    projectId: system.projectId,
    status: resolveTestedStatus(system, result),
    lastTestedAt: new Date().toISOString(),
    lastError: resolveTestError(result),
  }))
}

// S2-c: map read-source-config store errors to HTTP, keeping the payload values-free — the S1
// validator's { code, field, reason } tuples ride through untouched; nothing echoes the submitted
// config, a path, or a key.
function mapReadSourceConfigError(error) {
  if (error instanceof ReadSourceConfigValidationError) {
    // S1 tuples are values-free EXCEPT the unexpected-field case, where `field` is the raw
    // caller-supplied key name (could be URL/secret-shaped). Coarsen it here at the route boundary;
    // the S1 validator itself stays untouched.
    let details = error.details
    if (details && Array.isArray(details.errors)) {
      details = {
        ...details,
        errors: details.errors.map((entry) => (
          entry && entry.code === 'READ_SOURCE_UNEXPECTED_FIELD' ? { ...entry, field: '(unexpected)' } : entry
        )),
      }
    }
    return new HttpRouteError(400, 'READ_SOURCE_CONFIG_INVALID', 'read-source config is invalid', details)
  }
  if (error instanceof ReadSourceConfigNotFoundError) {
    return new HttpRouteError(404, 'READ_SOURCE_CONFIG_NOT_FOUND', 'read-source config not found')
  }
  if (error instanceof ReadSourceConfigNotApprovedError) {
    // Fail-closed runtime gate: draft/retired versions are not consumable. Coarse status enum only.
    return new HttpRouteError(409, 'READ_SOURCE_CONFIG_NOT_APPROVED', 'read-source config version is not approved', { status: error.details && error.details.status })
  }
  if (error instanceof ReadSourceConfigConflictError) {
    return new HttpRouteError(409, 'READ_SOURCE_CONFIG_STATUS_CONFLICT', 'read-source config status transition is not allowed', error.details)
  }
  return error
}

// C-R4-1: map composition config store errors to HTTP, values-free — the C-R1 validator's
// { code, field, reason } tuples ride through untouched; nothing echoes the submitted config, a step
// config id, a host, or a key. Mirrors mapReadSourceConfigError.
function mapReadSourceCompositionConfigError(error) {
  if (error instanceof ReadSourceCompositionConfigValidationError) {
    // The C-R1 validator uses fixed markers for unexpected keys ('(unexpected)' / 'steps.N.(unexpected)'),
    // so no raw caller key rides in field — the tuples are already values-free; pass them through.
    return new HttpRouteError(400, 'READ_SOURCE_COMPOSITION_CONFIG_INVALID', 'read-source composition config is invalid', error.details)
  }
  if (error instanceof ReadSourceCompositionConfigNotFoundError) {
    return new HttpRouteError(404, 'READ_SOURCE_COMPOSITION_CONFIG_NOT_FOUND', 'read-source composition config not found')
  }
  if (error instanceof ReadSourceCompositionConfigNotApprovedError) {
    return new HttpRouteError(409, 'READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED', 'read-source composition config version is not approved', { status: error.details && error.details.status })
  }
  if (error instanceof ReadSourceCompositionConfigConflictError) {
    return new HttpRouteError(409, 'READ_SOURCE_COMPOSITION_CONFIG_STATUS_CONFLICT', 'read-source composition config status transition is not allowed', error.details)
  }
  return error
}

// BA-APPLY-2a: map bridge-agent checklist store errors to HTTP, values-free — the contract
// validator's { code, field, reason } tuples ride through untouched (field is always a structural
// path, never a submitted object/field-key value). Mirrors mapReadSourceConfigError.
function mapBridgeAgentChecklistError(error) {
  if (error instanceof BridgeAgentChecklistValidationError) {
    return new HttpRouteError(400, 'BRIDGE_AGENT_CHECKLIST_INVALID', 'bridge-agent checklist is invalid', error.details)
  }
  if (error instanceof BridgeAgentChecklistNotFoundError) {
    return new HttpRouteError(404, 'BRIDGE_AGENT_CHECKLIST_NOT_FOUND', 'bridge-agent checklist not found')
  }
  if (error instanceof BridgeAgentChecklistNotApprovedError) {
    // Fail-closed approval gate: a draft/retired checklist is not fetchable by the apply consumer.
    return new HttpRouteError(409, 'BRIDGE_AGENT_CHECKLIST_NOT_APPROVED', 'bridge-agent checklist is not approved', { status: error.details && error.details.status })
  }
  if (error instanceof BridgeAgentChecklistConflictError) {
    return new HttpRouteError(409, 'BRIDGE_AGENT_CHECKLIST_STATUS_CONFLICT', 'bridge-agent checklist status transition is not allowed', error.details)
  }
  return error
}

function createHandlers(services, options = {}) {
  function requireService(name, methods) {
    const service = services[name]
    if (!service) throw new Error(`registerIntegrationRoutes: ${name} is required`)
    for (const method of methods) {
      if (typeof service[method] !== 'function') {
        throw new Error(`registerIntegrationRoutes: ${name}.${method} is required`)
      }
    }
    return service
  }

  const externalSystems = requireService('externalSystemRegistry', ['upsertExternalSystem', 'getExternalSystem', 'deleteExternalSystem', 'listExternalSystems'])
  // W5b (#3890): the stock-prep audit store is OPTIONAL at registration (environments without the
  // SQL db can still register read routes), but every W5b human-decision write fails closed without
  // it — an unaudited confirm/generation/resolve is refused, not silently allowed. System-sync
  // persists instead carry their immutable run record inside the same unit of work.
  const stockPreparationAudit = services.stockPreparationAuditStore || null
  function requireStockPreparationAudit() {
    if (!stockPreparationAudit || typeof stockPreparationAudit.append !== 'function') {
      throw new HttpRouteError(501, 'AUDIT_STORE_UNAVAILABLE', 'stock-preparation audit store is not available; writes are refused without an audit trail')
    }
    return stockPreparationAudit
  }
  // 工作台里选源 (migration 079): the persisted source binding. Optional at REGISTRATION for the same
  // reason the audit store is — an environment without the SQL db must still be able to register
  // routes, and a deployment that never binds anything keeps resolving the env default forever.
  //
  // NOT optional where it matters. Its two ROUTES fail closed without it (an admin must never be
  // shown a picker whose Save silently lands nowhere), and — more importantly — the RESOLVER below
  // is only wired when the store exists. Those two facts are the same fact: if the store is absent
  // there is no override to read, so the action resolves the env default exactly as it did before
  // this line existed. Absence degrades to the OLD behaviour, never to a wrong source.
  const stockPreparationSourceBinding = services.stockPreparationSourceBindingStore || null
  function requireStockPreparationSourceBinding() {
    if (!stockPreparationSourceBinding
      || typeof stockPreparationSourceBinding.get !== 'function'
      || typeof stockPreparationSourceBinding.set !== 'function') {
      throw new HttpRouteError(501, 'SOURCE_BINDING_STORE_UNAVAILABLE', 'stock-preparation source binding store is not available; the source cannot be read or changed here')
    }
    return stockPreparationSourceBinding
  }
  // Customer-pack install LEDGER. Optional at registration, exactly like the audit store above: an
  // environment without the SQL db still registers the read/dry-run routes. The INSTALL route,
  // however, fails closed without it — an install whose columns cannot be enumerated afterwards is
  // the very gap this line exists to close, so writing one unrecorded is refused, not allowed
  // silently. The refresh seam treats its absence as "no pack-aware information" (legacy bands).
  const stockPreparationPackInstalls = services.stockPreparationPackInstallStore || null
  function requireStockPreparationPackInstalls() {
    if (!stockPreparationPackInstalls || typeof stockPreparationPackInstalls.recordInstall !== 'function') {
      throw new HttpRouteError(501, 'CUSTOMER_PACK_LEDGER_UNAVAILABLE', 'customer pack install ledger is not available; installs are refused without it')
    }
    return stockPreparationPackInstalls
  }
  // HG v1.2 PR-A: DB-backed single-active-reconciler lease (migration 077). Optional at
  // registration like the two stores above; the reconcile WRITE fails closed without it — an
  // in-process lock is not a concurrency guarantee, so reconciling without the lease is refused.
  const stockPreparationConfirmationLease = services.stockPreparationConfirmationDecisionLease || null
  function requireConfirmationDecisionReconcileLease() {
    if (!stockPreparationConfirmationLease
      || typeof stockPreparationConfirmationLease.acquire !== 'function'
      || typeof stockPreparationConfirmationLease.release !== 'function') {
      throw new HttpRouteError(501, 'CONFIRMATION_DECISION_RECONCILE_LEASE_UNAVAILABLE', 'confirmation-decision reconcile lease is not available; reconcile is refused without a durable concurrency guarantee')
    }
    return stockPreparationConfirmationLease
  }
  const adapterRegistry = requireService('adapterRegistry', ['createAdapter', 'listAdapterKinds'])
  const pipelineRegistry = requireService('pipelineRegistry', ['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns'])
  const runner = requireService('pipelineRunner', ['runPipeline'])
  const deadLetters = requireService('deadLetterStore', ['listDeadLetters'])
  const stagingInstaller = requireService('stagingInstaller', ['installStaging', 'listStagingDescriptors'])
  const templateRegistry = requireService('templateRegistry', ['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate'])
  const readSourceConfigs = requireService('readSourceConfigStore', ['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime'])
  const readSourceCompositions = requireService('readSourceCompositionConfigStore', ['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime'])
  // BA-APPLY-2a: only the methods the 4 routes below actually call are required — save/approve/retire
  // (write-tier) + getForApply (the fail-closed approval gate for the GET route).
  const bridgeAgentChecklists = requireService('bridgeAgentChecklistStore', ['saveVersion', 'approve', 'retire', 'getForApply'])
  const stockPreparationSqlServerRuntime =
    services && services.stockPreparationSqlServerRuntime
  const context = options.context || {}
  // Values-free warnings only (the pack read-back seam's degrade-to-legacy notice).
  const routeLogger = options.logger || (context && context.logger) || null
  const configuredTableActions = context && context.config
    ? (context.config.stockPreparationTableActions || context.config.tableActions)
    : undefined
  // THE NO-RESTART SEAM. `actions` is still the deploy-time snapshot, drained into the registry's
  // Map once, right here, at activation — correct for the target sheet, template, read plan and
  // bounds. `resolveSourceBinding` is the one field that escapes that: it is an async callback the
  // registry invokes INSIDE `getTableAction`, which every stock-prep route already calls per
  // request, so a source picked in the workbench is read by the very next call. There is no cache to
  // invalidate because nothing is cached — the override is not read until a request asks for it.
  //
  // Wired ONLY when the store exists, and it hands back the id or null. A throw from the store
  // PROPAGATES (the registry does not catch): "the binding table is unreachable" must not be
  // indistinguishable from "no binding exists", because the second one silently resolves the env
  // default — which on a customer deployment is the synthetic demo source.
  const tableActions = createStockPreparationTableActionRegistry({
    actions: configuredTableActions,
    resolveSourceBinding: stockPreparationSourceBinding
      ? async (scope) => {
          const binding = await stockPreparationSourceBinding.get(scope)
          return binding ? binding.externalSystemId : null
        }
      : null,
  })
  // SERVER-HELD pack allowlist, built once at registration so a malformed deploy-time pack fails
  // here (visibly, at activation) rather than on a deployer's first install call. Absent config →
  // empty catalog → every packId is refused. Nothing about this map is request-influenced.
  const customerPackCatalog = createCustomerPackCatalog({
    packs: resolveCustomerPackCatalogConfig(context && context.config),
  })
  // SERVER-HELD source->`ext_` mapping, built here for the same reason and with the same posture as
  // the catalog above: once, at activation, so a malformed deploy-time mapping fails visibly here
  // rather than on a deployer's first dry-run. Its pack comes from the catalog, never from the
  // mapping config itself, so "which `ext_` columns exist and who owns them" keeps exactly one
  // authority. Absent config -> null -> both refresh routes omit `extFieldMapping` entirely, which
  // is byte-identical to the behaviour before the mapper existed.
  const stockPreparationExtFieldMapping = createConfiguredExtFieldMapping({
    config: context && context.config,
    packCatalog: customerPackCatalog,
  })
  // B2a TRIAL REGISTRATION, built once here for the same reason as the two above: a malformed
  // registration file must fail visibly at plugin activation, not on a deployer's first dry-run.
  //
  // TWO STATES, and the difference between them is the difference between a gate and no gate:
  //   * `null` (INTEGRATION_CORE_B2A_REGISTRY_PATH unset) -> DORMANT. Every stock-prep route below
  //     behaves byte-identically to a deployment that never heard of B2a. Real customer usage
  //     without a registration file is forbidden by the W0 operator checklist, not by this code —
  //     see the module header for why that trade was made deliberately.
  //   * a built registry (env set) -> ARMED. Every gated stock-prep source read must match a live
  //     entry on (tenant, external system, project-in-scope, purpose, effective, not expired) or is
  //     refused BEFORE `loadTableActionSourceAdapter` gets anywhere near a source row.
  //
  // Nothing about it is request-influenced: it is read once off server config and threaded, exactly
  // like `stockPreparationExtFieldMapping`.
  const b2aTrialRegistry = createB2aRegistry({ config: context && context.config })
  // Migration 078: the DB-enforced one-shot operation claim, built in index.cjs off the same `db`
  // handle the other stores use. Optional at REGISTRATION for the same reason the audit store and
  // the PR-A reconcile lease are — an environment without the SQL db must still be able to register
  // routes — but NOT optional at CHECK time: `assertB2aReadAuthorization` refuses an armed read that
  // reaches it without one (`operation_claim_unavailable`) rather than degrading to the kv-only
  // read-then-write path. A DORMANT deployment never gets that far, so its behaviour is unchanged.
  const b2aOperationClaim = (services && services.b2aOperationClaim) || null

  // 列映射副驾: the governed AI boundary is INJECTED (packages/core-backend GovernedAiService), OPTIONAL
  // at registration — an environment that never wired it still registers the routes and the copilot
  // fail-opens to manual mapping. It is duck-typed to { suggest(request, env?) }; nothing else here
  // reaches a provider. The server-held vendor preset catalog (committed, values-free structure) is
  // loaded once and reused for family detection + as the confirm skeleton — NEVER request-supplied.
  const governedAi = (services && services.governedAi) || null

  // 列级写权限: the narrow host port that writes the PLATFORM's own `field_permissions`
  // rows, injected per-plugin exactly like governedAi above. OPTIONAL here on purpose —
  // a customer pack that declares no `fieldWritePolicies` never reaches for it, so an
  // environment that has not wired it installs precisely as it does today. A pack that
  // DOES declare policies and finds no port makes the installer fail closed rather than
  // report a complete install whose scoping would not be enforced.
  const stockPreparationFieldPermissions = (services && services.stockPreparationFieldPermissions) || null

  // 按项目导出物料 Excel: the xlsx BUFFER BUILDER is INJECTED (packages/core-backend xlsx-service.ts
  // buildXlsxBuffer, wrapped around a lazily-imported `xlsx` module), same INJECTED-per-plugin shape as
  // governedAi above and for the same reason — the plugin has no `xlsx` dependency of its own (it is
  // not resolvable from this package's node_modules under the workspace's strict pnpm layout) and must
  // not add one; the ONE existing xlsx builder is reused via this host-provided seam instead. Duck-typed
  // to { buildWorkbookBuffer({ sheetName, headers, rows }) => Promise<Buffer> }.
  const stockPreparationXlsxExport = (services && services.stockPreparationXlsxExport) || null
  // 一线看得见自己工厂的项目: the host TENANT PRINCIPAL DIRECTORY (packages/core-backend
  // tenant-principal-directory-boundary.ts), same INJECTED-per-plugin shape as governedAi and
  // stockPreparationXlsxExport above. Unlike both of those it is NOT fail-open — the operator project
  // directory refuses with a named 501 when it is absent, because a value-bearing tenant-scoped read
  // that cannot get the host to vouch for the principal must not run on `req.user.tenantId` alone
  // (the auth middleware fills that field from the `x-tenant-id` header when the token has no claim).
  // Duck-typed to { verifyTenantMembership({ userId, tenantId }) => Promise<{ member }> }.
  const tenantPrincipalDirectory = (services && services.tenantPrincipalDirectory) || null

  // 通知下一步: the durable cursor (migration 084). OPTIONAL at REGISTRATION for the same reason the
  // audit store is — an environment without the SQL db must still be able to register routes — and
  // NOT optional where it matters: both handoff routes fail closed without it, because a turn signal
  // nobody can persist is worse than no turn signal (it would show a plausible "current step" that
  // resets on the next request).
  const stockPreparationHandoffStore = (services && services.stockPreparationHandoffStore) || null
  function requireStockPreparationHandoffStore() {
    if (!stockPreparationHandoffStore
      || typeof stockPreparationHandoffStore.get !== 'function'
      || typeof stockPreparationHandoffStore.advance !== 'function'
      // RC1: the notification claim is a THIRD store call now. A binding that has advance but not
      // claimNotification would move turns and never notify anyone, silently — exactly the failure
      // mode the split exists to remove — so the seam is required at the gate, not discovered later.
      || typeof stockPreparationHandoffStore.claimNotification !== 'function') {
      throw new HttpRouteError(501, 'STOCK_PREPARATION_HANDOFF_STORE_UNAVAILABLE', 'stock-preparation handoff store is not available; the handoff cannot be read or advanced here')
    }
    return stockPreparationHandoffStore
  }

  // 通知下一步: the DingTalk seam. INJECTED by the host for this plugin only — the same
  // INJECTED-per-plugin shape as governedAi and stockPreparationXlsxExport above, and for the same
  // reason: the plugin has no DingTalk client of its own and must not grow one. The host wraps the
  // EXISTING group-destination machinery (packages/core-backend dingtalk-group-destination-service.ts),
  // which is also why the seam speaks in DESTINATION IDs rather than webhooks or people.
  //
  // OPTIONAL — absent → every advance reports `notifyOutcome: 'not_configured'` and still moves the
  // turn. Turn state and notification are separate concerns and a deployment is allowed to want only
  // the first. Duck-typed to
  //   { sendToDestinations({ destinationIds, title, body, initiatedBy }) => Promise<{ delivered, failed }> }.
  const stockPreparationHandoffNotifier = (services && services.stockPreparationHandoffNotifier) || null

  // 通知下一步: the deploy-time chain, parsed ONCE and memoized.
  //
  // LAZY, not resolved at registration, and the difference is load-bearing. A MALFORMED chain must
  // throw rather than degrade (a typo must never be indistinguishable from "nothing configured", or
  // the deployment silently notifies nobody), but that throw must not take the whole plugin's route
  // surface down with it. Resolving here means a bad `stockPreparationHandoff` key fails exactly the
  // two handoff routes, loudly and by name, while every other integration route keeps serving.
  //
  // ABSENT key → `{ configured: false }` → the status read answers `configured: false` and the
  // advance refuses with a named 501 BEFORE touching the store, the notifier or the audit trail. A
  // deployment that never sets it is byte-identical to one that never heard of this feature.
  let stockPreparationHandoffChainCache = null
  function loadStockPreparationHandoffChain() {
    if (!stockPreparationHandoffChainCache) {
      stockPreparationHandoffChainCache = parseStockPreparationHandoffConfig(context && context.config)
    }
    return stockPreparationHandoffChainCache
  }
  /**
   * 通知下一步: dispatch one composed handoff notification. Returns an OUTCOME ENUM, never throws.
   *
   * NOT THROWING IS THE POINT. This runs AFTER the turn has already committed, so a throw here would
   * turn a successful handoff into a 500 and the operator would reasonably click again — at which
   * point they would be told "already handed off" and would have no idea whether anyone was ever
   * notified. Returning an enum lets the route answer honestly: the turn moved, the message did not
   * go out, go and tell them yourself.
   *
   *   'no_destination' —— no notifier injected, or the chain names no destination for this hop. The
   *                       turn still moved; a deployment is allowed to want turn state without
   *                       notifications. Since J3 the route no longer reaches this function in either
   *                       case (both fold into `hopHasDestination`, so no claim is spent), but the
   *                       guards stay: a dispatcher that can be called with nothing to send to must
   *                       still answer honestly rather than inventing a delivery.
   *                       NOT 'not_configured' — that meant "this deployment has no chain", which is
   *                       the advance route's 501 and has its own error copy.
   *   'sent'           —— every destination took it.
   *   'partial'        —— SOME destinations took it and some did not (RC4). Only the terminal hop
   *                       fans out — 仓库 AND 采购 — and that is exactly the hop where collapsing this
   *                       into 'sent' was worst: the department whose robot is broken is never told,
   *                       the operator is told in words that the group HAS been told, and at-most-once
   *                       means clicking again can never fix it. The host already keeps going past a
   *                       failure and returns both counts; the route used to discard `failed`.
   *   'failed'         —— the host threw, or every destination refused it.
   */
  async function dispatchStockPreparationHandoffNotification(notification) {
    if (!notification || !Array.isArray(notification.destinationIds) || notification.destinationIds.length === 0) {
      return 'no_destination'
    }
    if (!stockPreparationHandoffNotifier || typeof stockPreparationHandoffNotifier.sendToDestinations !== 'function') {
      return 'no_destination'
    }
    try {
      const result = await stockPreparationHandoffNotifier.sendToDestinations({
        destinationIds: notification.destinationIds,
        title: notification.title,
        body: notification.body,
      })
      const delivered = result && Number.isFinite(Number(result.delivered)) ? Number(result.delivered) : 0
      const failed = result && Number.isFinite(Number(result.failed)) ? Number(result.failed) : 0
      if (delivered === 0) return 'failed'
      return failed > 0 ? 'partial' : 'sent'
    } catch (error) {
      // Values-free by construction: the outcome is an enum and the host's own message is discarded
      // here rather than echoed, so a webhook error string can never reach the caller or the UI.
      if (routeLogger && typeof routeLogger.warn === 'function') {
        routeLogger.warn('[plugin-integration-core] stock-prep handoff notification failed; the turn already advanced')
      }
      return 'failed'
    }
  }

  // RC1 — IS THE DATABASE'S AUDIT VOCABULARY WIDE ENOUGH FOR THIS ACTION YET?
  //
  // `requireStockPreparationAudit()` proves the audit SERVICE is wired. It cannot prove the audit
  // TABLE will accept what we are about to write, and those are different facts: `db:migrate` is a
  // separate CLI, so a deployment can run code that knows about `handoff_advance` against a schema
  // whose CHECK constraint stops at 082. Every advance then moved the cursor, failed at the audit
  // insert, and handed the operator a raw constraint-violation message.
  //
  // ONLY THE POSITIVE VERDICT IS CACHED (G4), and the asymmetry is the whole point. The first cut
  // memoised whatever came back, so a deployment that ran migration 085 exactly as the 503 told it to
  // kept being refused until somebody restarted the process — a refusal its own instructions could
  // not clear, with nothing anywhere saying a restart was needed.
  //
  //   supported:true  — a deployment fact that cannot regress (a CHECK constraint is never narrowed
  //                     by a later migration), so it is cached for the life of the process and the
  //                     steady state costs nothing.
  //   supported:false — a TRANSIENT deployment state that the operator is actively being told to fix.
  //                     Re-probed on every request: one rolled-back INSERT per request while the
  //                     route is genuinely broken and refusing anyway is cheap, and it means the very
  //                     next click after `db:migrate` succeeds.
  //
  // The probe fails OPEN on anything it cannot diagnose — see the store — so a connection blip
  // degrades to "just try the write", exactly as before this existed.
  const stockPreparationAuditVocabularySupported = new Set()
  async function requireStockPreparationAuditVocabulary(audit, action, migration, tenantId) {
    if (!audit || typeof audit.supportsAction !== 'function') return
    if (stockPreparationAuditVocabularySupported.has(action)) return
    let verdict
    try {
      verdict = await audit.supportsAction(action, { tenantId })
    } catch (error) {
      // A probe that itself blew up tells us nothing; do not convert it into a refusal.
      return
    }
    if (verdict && verdict.supported === false) {
      throw new HttpRouteError(
        503,
        'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE',
        `this database does not yet accept the '${action}' audit action; run migration ${migration} before using this route`,
        { migration },
      )
    }
    stockPreparationAuditVocabularySupported.add(action)
  }

  // How far back the status read looks for notification_lost rows. Bounded because this is a display
  // hint on a hot read: a project whose trail is longer than this has had far bigger problems, and the
  // banner degrades to showing the recent losses rather than to costing the page.
  const STOCK_PREPARATION_HANDOFF_LOST_LOOKBACK = 200

  function requireConfiguredStockPreparationHandoffChain() {
    const chain = loadStockPreparationHandoffChain()
    if (!chain.configured) {
      throw new HttpRouteError(501, 'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED', 'this deployment has no stock-preparation handoff chain configured')
    }
    return chain
  }

  /**
   * IS THIS CHAIN THIS TENANT'S? Returns the chain when the answer is yes.
   *
   * Every configured chain names its tenant — the parser refuses one that does not — and it belongs
   * to that tenant alone: the destination ids it carries are deploy config, the host proves only that
   * they are admin-managed, and nothing downstream relates a destination's org to the tenant whose
   * project is about to be announced into it. So the refusal is here, before any write.
   *
   * G7 — AND THE REFUSAL IS INDISTINGUISHABLE FROM "THERE IS NO CHAIN HERE". The first cut answered a
   * distinct 403 CHAIN_NOT_FOR_THIS_TENANT, which meant one POST told a foreign tenant that this
   * deployment HAS a 备料 chain and it is somebody else's — a one-bit cross-tenant configuration
   * disclosure that the sibling status route was deliberately written to prevent (it answers
   * `configured: false` to exactly the same caller). A guard that the neighbouring route undoes is
   * not a guard, so the wire answer is now the same 501 an unconfigured deployment gives, and the
   * DISTINCT reason stays where an operator can use it and a stranger cannot: the log.
   *
   * The `chain.tenantId &&` guard is retained for the unconfigured chain object (whose tenantId is
   * null), which callers never reach with a real tenant because they check `configured` first.
   */
  function requireStockPreparationHandoffChainForTenant(chain, tenantId) {
    if (chain.tenantId && chain.tenantId !== tenantId) {
      if (routeLogger && typeof routeLogger.warn === 'function') {
        // Tenant ids are handles, not customer values, and this line is the operability half the wire
        // answer gives up.
        routeLogger.warn(
          `[plugin-integration-core] stock-prep handoff chain belongs to tenant ${chain.tenantId}; refusing an advance from ${tenantId} as not-configured`,
        )
      }
      throw new HttpRouteError(
        501,
        'STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED',
        'this deployment has no stock-preparation handoff chain configured',
      )
    }
    return chain
  }
  let vendorPresetCatalogCache = null
  function loadVendorPresetCatalog() {
    if (vendorPresetCatalogCache) return vendorPresetCatalogCache
    try {
      vendorPresetCatalogCache = loadVendorPresetsFromDir().map((entry) => entry.preset)
    } catch (err) {
      // A broken catalog must not take the routes down; the copilot degrades to family-agnostic.
      if (routeLogger && typeof routeLogger.warn === 'function') {
        routeLogger.warn('[plugin-integration-core] vendor preset catalog failed to load; copilot runs family-agnostic')
      }
      vendorPresetCatalogCache = []
    }
    return vendorPresetCatalogCache
  }

  function getMultitableRecordsApi() {
    const records = context && context.api && context.api.multitable && context.api.multitable.records
    if (!records || typeof records.queryRecords !== 'function') {
      throw new HttpRouteError(501, 'TABLE_ACTION_RECORDS_API_UNAVAILABLE', 'multitable records API is not available')
    }
    return records
  }

  // #3751 MVP: multitable provisioning accessor for the sync-run PERSIST route (findObjectSheet resolves
  // each MVP objectId -> sheetId). Same dep the MVP readiness/ensure paths use (context.api.multitable
  // .provisioning); we only need findObjectSheet here (persist never creates a sheet).
  function getMultitableProvisioning() {
    const provisioning = context && context.api && context.api.multitable && context.api.multitable.provisioning
    if (!provisioning || typeof provisioning.findObjectSheet !== 'function') {
      throw new HttpRouteError(503, 'STOCK_PREPARATION_MVP_PROVISIONING_API_UNAVAILABLE', 'multitable provisioning API is not available', {
        requiredMethods: ['findObjectSheet'],
      })
    }
    return provisioning
  }

  // Confirmation-ledger readback, resolved HERE on the server exactly like
  // `installedFieldProperties` / `extFieldMapping`: from auth-derived tenant +
  // server-held multitable APIs, threaded into the table-action as a parameter,
  // NEVER request-supplied (the body allowlists cannot name it). Before the
  // ledger table is provisioned it degrades to an empty review — the pre-ledger
  // dry-run behaviour, byte-identical: no reusable decision, the planner holds.
  function confirmationDecisionResolverForRequest(req) {
    const tenantId = resolveTenantId(req, {})
    const targetProjectId = resolveIntegrationStagingProjectId(tenantId, undefined)
    return async ({ projectNo, plan, sourceRevision }) => {
      try {
        return await loadConfirmedDuplicatePolicyReview({
          recordsApi: getMultitableRecordsApi(),
          provisioning: getMultitableProvisioning(),
          targetProjectId,
          permission: 'admin',
          projectNo,
          plan,
          sourceRevision,
        })
      } catch (error) {
        if (error instanceof StockPreparationConfirmationDecisionError && error.code === 'CONFIRMATION_DECISION_TARGET_NOT_READY') {
          return { scope: 'table_scope', policies: [] }
        }
        // Same degradation for a host that cannot resolve the ledger object's field ids at all
        // (no provisioning.resolveFieldIds, or no staging project) — the documented pre-ledger
        // posture. Degrading is the FAIL-CLOSED direction here: no readback means no confirmed
        // decision, so every manual-confirm hold simply stands.
        if (error && error.code === 'TABLE_ACTION_FIELD_IDS_UNRESOLVED') {
          return { scope: 'table_scope', policies: [] }
        }
        throw error
      }
    }
  }

  // The scoped provisioning surface the customer-pack installer asserts. Handed over as-is: the
  // installer does its own REQUIRED_PROVISIONING_METHODS check (which deliberately does NOT include
  // ensureObject), so the route must not narrow or widen that list here.
  function getCustomerPackProvisioning() {
    const provisioning = context && context.api && context.api.multitable && context.api.multitable.provisioning
    if (!provisioning) {
      throw new HttpRouteError(503, 'CUSTOMER_PACK_API_UNAVAILABLE', 'customer pack install requires the multitable provisioning API')
    }
    return provisioning
  }

  // Read-back seam accessor. Returns null rather than throwing when the host cannot serve the
  // per-field read: the refresh path must degrade to the (strictly narrower) legacy bands, never
  // start 503-ing because a pack ledger exists.
  function getPackReadbackProvisioning() {
    const provisioning = context && context.api && context.api.multitable && context.api.multitable.provisioning
    if (!provisioning || typeof provisioning.readObjectFieldsContent !== 'function') return null
    return provisioning
  }

  /**
   * Resolve `installedFieldProperties` for one refresh. THIS is what closes the executable gap the
   * comment in stock-preparation-table-actions.cjs used to describe: the ledger names the candidate
   * `ext_` ids, the host says which of them are still live and how they are classified, and the
   * planner is handed the result unchanged.
   *
   * `undefined` (no ledger, no pack installed, or any read failure) means the caller must OMIT the
   * parameter, which is byte-identical to the pre-pack behaviour.
   */
  async function resolveInstalledFieldProperties(req, action) {
    const objectId = (action && action.target && action.target.objectId)
      || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
    const tenantId = resolveTenantId(req, {})
    return loadPackInstalledFieldProperties({
      packInstallStore: stockPreparationPackInstalls,
      provisioning: getPackReadbackProvisioning(),
      tenantId,
      projectId: resolveIntegrationStagingProjectId(tenantId, undefined),
      objectId,
      logger: routeLogger,
    })
  }

  // FRESHNESS-DIVERGENCE NOTICE for the large-BOM job family.
  //
  // The two small-BOM refresh routes apply the configured source->`ext_` mapping. The large-BOM
  // routes do NOT: they expand into a stored job and plan out of that artifact, and neither call
  // supplies `extFieldMapping` or `installedFieldProperties` (the latter has never been supplied on
  // this path — see the note above `computeDryRun` in stock-preparation-table-actions.cjs).
  //
  // The consequence is NOT "no `ext_` write". Without `installedFieldProperties` the planner's
  // writable band is template-only (derivePackAwarePlmWritableFields, packAware=false), so
  // `pickFields` leaves every `ext_` id out of the update patch — and a patch does not blank what it
  // omits. Any `ext_` value an earlier SMALL-path refresh wrote therefore SURVIVES while every
  // canonical column around it moves to today's source. The row reads as fresh while its tenant
  // columns sit at an older epoch, which in a 备料 table is a worse failure than a missing value.
  //
  // Which path a project takes is not the operator's choice and is not monotonic either:
  // `read_time_limit_exceeded` is in LARGE_BOM_BOUNDED_ERROR_TYPES, so one unchanged project can go
  // small one day and large the next purely because the source was slow.
  //
  // So the divergence is ANNOUNCED rather than left silent, on every response in this family.
  // CONDITIONAL on purpose: with no mapping configured the payload is byte-identical to what it was
  // before this key existed, which is what keeps the inertness guarantee provable. Values-free — a
  // mappingId is a slug and a mappingVersion an integer, both schema, never a source cell.
  //
  // Deliberately NOT a 409. Refusing large BOMs whenever a mapping is configured would turn a
  // freshness divergence into "large projects cannot be refreshed at all" for a capability that is
  // dormant by default — a strictly worse trade than the one it would fix.
  function largeBomJobResponse(payload) {
    if (!stockPreparationExtFieldMapping) return payload
    return {
      ...payload,
      extFieldMappingConfiguredButNotAppliedOnThisPath: {
        mappingId: stockPreparationExtFieldMapping.mappingId,
        mappingVersion: stockPreparationExtFieldMapping.mappingVersion,
      },
    }
  }

  function stockPreparationSqlServerRunInput(req) {
    const body = requestBody(req)
    const query = requestQuery(req)
    const params = requestParams(req)
    if (
      !isPlainObject(body)
      || Object.keys(body).length !== 1
      || !Object.prototype.hasOwnProperty.call(body, 'operationId')
      || Object.keys(query).length !== 0
      || Object.keys(params).length !== 0
      || typeof body.operationId !== 'string'
      || body.operationId.length < 1
      || body.operationId.length > 128
      || body.operationId.trim() !== body.operationId
      || /[\u0000-\u001F\u007F]/.test(body.operationId)
    ) {
      throw new HttpRouteError(
        400,
        'STOCK_PREPARATION_SQLSERVER_SEALED_SNAPSHOT_REQUEST_INVALID',
        'request must contain only a valid operationId',
      )
    }
    return Object.freeze({ operationId: body.operationId })
  }

  async function loadStockPreparationReadonlySource(req, input, errorCode) {
    if (!input.readSourceConfigId) {
      throw new HttpRouteError(400, errorCode, 'readSourceConfigId is required', { field: 'readSourceConfigId' })
    }
    const configScope = {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      id: input.readSourceConfigId,
    }
    let row
    try {
      row = await readSourceConfigs.getForRuntime(scopedInput(req, configScope))
    } catch (error) {
      throw mapReadSourceConfigError(error)
    }
    if (!firstString(row && row.systemId)) {
      throw new HttpRouteError(409, 'STOCK_PREPARATION_SOURCE_SYSTEM_UNAVAILABLE', 'approved source-run system is unavailable')
    }

    let preparedRead
    try {
      preparedRead = prepareConfiguredRead({ config: row.config, inputs: input.inputs })
    } catch (error) {
      throw new HttpRouteError(400, errorCode, 'approved source-run config is not executable', {
        reason: error && typeof error.reason === 'string' ? error.reason : 'invalid',
      })
    }

    const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
      ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
      : externalSystems.getExternalSystem.bind(externalSystems)
    let system
    try {
      system = await loadSystem(scopedAdapterInput(req, {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        id: row.systemId,
      }))
    } catch (error) {
      const status = /NotFound/.test(error && error.name ? String(error.name) : '') ? 409 : 503
      throw new HttpRouteError(status, 'STOCK_PREPARATION_SOURCE_SYSTEM_UNAVAILABLE', 'approved source-run system is unavailable')
    }
    if (!system || system.kind !== preparedRead.plan.requiredKind) {
      throw new HttpRouteError(409, 'STOCK_PREPARATION_SOURCE_KIND_MISMATCH', 'approved source-run system kind does not match its config')
    }
    return {
      preparedRead,
      system,
      // T3b-1c: the APPROVED config row itself, so the auto-persist path can run its pure structural
      // guard on it BEFORE any source-adapter creation. Additive — the read-only paths ignore it.
      config: row.config,
      createAdapter: (adapterSystem) => adapterRegistry.createAdapter(adapterSystem, {
        principal: requestPrincipal(req),
      }),
    }
  }

  // FOS-2: scoped multitable provisioning API for the generic field-option-sync route. Same dep the
  // stock-prep option-sync path uses (context.api.multitable.provisioning); we only need the
  // metadata-patch method here.
  function getFieldOptionSyncProvisioning() {
    const provisioning = context && context.api && context.api.multitable && context.api.multitable.provisioning
    if (!provisioning || typeof provisioning.patchObjectFieldProperty !== 'function') {
      throw new HttpRouteError(503, 'FIELD_OPTION_SYNC_API_UNAVAILABLE', 'field-option-sync requires multitable.provisioning patchObjectFieldProperty API', {
        requiredMethods: ['patchObjectFieldProperty'],
      })
    }
    return provisioning
  }

  /**
   * ENTRY POINT (2)/(3): the pipeline-shaped B2a guard.
   *
   * Both the C6 external-write dry-run/apply and the ordinary pipeline runner read a source that is
   * described by a PIPELINE row, so both fill the key the same way and share one helper. It is
   * called BEFORE the first credential reload (`getExternalSystemForAdapter` decrypts), which is
   * itself before adapter creation and long before any wire read.
   *
   * `pipeline.projectId` is NULLABLE. A pipeline with no project id cannot be B2a-authorized: the
   * guard refuses it with `missing_scope`. Deliberate — a null data scope is not a wildcard, and
   * treating it as one would let every project-less pipeline through the moment the gate is armed.
   */
  /**
   * R-02 (external review finding 3): a NON-DECRYPTING loader for one source system's stored config,
   * or `null` when the registry offers no such accessor.
   *
   * `getExternalSystemAdapterConfig` reads the row and returns its config WITHOUT touching the
   * credentials — see external-systems.cjs. That is what lets an object-scope check that must see a
   * private config subtree (`lookupProjection`) still sit ahead of every credential reload, which is
   * where §13 PR-C puts the fence. `null` here is not a pass: `resolveB2aSourceObjects` refuses
   * fail-closed for a kind that can hide an object.
   */
  function b2aSourceSystemConfigLoader(req, systemId, scope = {}) {
    if (typeof externalSystems.getExternalSystemAdapterConfig !== 'function') return null
    return () => externalSystems.getExternalSystemAdapterConfig(scopedInput(req, { ...scope, id: systemId }))
  }

  async function assertB2aPipelineReadAuthorized(req, pipeline, { tenantScope, purpose, runId }) {
    // DORMANT -> return before the metadata read below. Without this short-circuit an unarmed
    // deployment would make one EXTRA `getExternalSystem` call per C6 dry-run, which is a
    // behavioural difference — small, but exactly the kind the dormancy guarantee is supposed to
    // exclude, and the existing C6 route test counts those calls.
    if (!b2aTrialRegistry) return null
    // The system TYPE, resolved through the CREDENTIAL-STRIPPED accessor. This is a platform
    // metadata read, not a credential reload — `getExternalSystem` never decrypts — so the fence
    // still precedes everything the contract names, while the registration keeps its full key: a
    // binding repointed at a different adapter kind stops matching a registration written for the
    // old one. The adapter-capable accessor (which DOES decrypt) is still several lines away.
    const sourceSystem = await externalSystems.getExternalSystem(scopedInput(req, { id: pipeline.sourceSystemId }))
    // R-02 (finding 3): `pipeline.sourceObject` is what the pipeline NAMES; a `data-source:sql-readonly`
    // source with a configured `lookupProjection` also reads a second, distinct table. Adding it here
    // means a registration that does not enumerate it is refused rather than silently widened. The
    // config comes from the non-decrypting accessor, so this stays ahead of the credential reload.
    const sourceObjects = await resolveB2aSourceObjects({
      sourceObjects: [pipeline.sourceObject],
      sourceSystemType: sourceSystem && sourceSystem.kind,
      loadSourceSystemConfig: b2aSourceSystemConfigLoader(req, pipeline.sourceSystemId),
    })
    return assertB2aReadAuthorization({
      registry: b2aTrialRegistry,
      store: context.storage,
      operationClaim: b2aOperationClaim,
      // The PIPELINE ROW's own tenant, not a request carrier: `resolveTenantId` honours a
      // body/query tenant for a tenantless platform admin, and the tenant this read is authorized
      // against must be the one that owns the record.
      tenantScope: firstString(pipeline.tenantId) || tenantScope,
      sourceSystemType: sourceSystem && sourceSystem.kind,
      sourceBindingRef: pipeline.sourceSystemId,
      dataScopeRef: pipeline.projectId,
      sourceObjects,
      purpose,
      runId,
      now: Date.now(),
    })
  }

  /**
   * ENTRY POINT (3) + THE E3-01 SAFE-LIFECYCLE CLOSURE, for the ordinary pipeline runner.
   *
   * Both fences live here because both must land before `runner.runPipeline`, which resolves and
   * decrypts BOTH systems and creates BOTH adapters as its first act (`loadPipelineContext`).
   * Placing them at the route also covers dead-letter replay, which re-enters `runPipeline`.
   *
   * WHY THE ROUTE *AND* THE RUNNER, since W-2. This fence used to be the only one, and the note here
   * used to say every caller was a route. It was not: `index.cjs` also registers a cross-plugin
   * communication namespace whose `runPipeline` / `replayDeadLetter` enter the runner directly. The
   * B2a read guard is therefore ALSO inside `pipeline-runner.cjs` now (index.cjs gives the runner the
   * registry and the same claim store), and this route-level fence is KEPT as defence in depth —
   * it is what puts the refusal ahead of the E3-01 write fence and ahead of the dead-letter row read.
   *
   * The two never burn two claims: the run id generated by the caller of this helper is handed to the
   * runner under `B2A_AUTHORIZED_RUN_ID`, and the runner's guard continues that claim.
   *
   * E3-01: the ordinary non-dry `pipeline-runner -> metasheet:multitable upsert` path is a live,
   * token-less write to a MetaSheet target, outside the C6 dry-run -> token -> apply lifecycle. It
   * is reachable TODAY at all three layers — the route forwards no `dryRun`, `pipelines.cjs`
   * validates target ROLE but never target KIND, and the adapter's `upsert` has no lifecycle guard —
   * so "physically unreachable" is not an available claim and a real fence is required.
   *
   * The fence is scoped to an ARMED B2a deployment, matching the contract's own wording ("对部署
   * runtime 中可触达 B2a MetaSheet target 的…路径"). That keeps the dormancy guarantee the rest of
   * this change rests on: with the registry unset, every existing pipeline behaves exactly as before.
   * It is NOT the general closure of that bypass for non-B2a deployments — see the honest gap list.
   */
  async function assertPipelineRunAllowed(req, { pipelineId, dryRun, runId }) {
    // Dormant -> nothing to do, and not one extra platform read happens either.
    if (!b2aTrialRegistry) return null
    const scope = scopedInput(req, { id: pipelineId })
    const pipeline = await pipelineRegistry.getPipeline(scope)

    if (!dryRun) {
      // Credential-STRIPPED accessor: identifying the target kind must not itself reload secrets.
      const targetSystem = await externalSystems.getExternalSystem(scopedInput(req, { id: pipeline.targetSystemId }))
      if (targetSystem && targetSystem.kind === MULTITABLE_WRITE_TARGET_KIND) {
        throw new HttpRouteError(
          403,
          C6_SAFE_LIFECYCLE_REQUIRED,
          'a live MetaSheet multitable write must go through the C6 dry-run -> token -> apply lifecycle',
          { reason: 'ordinary_runner_multitable_write', pipelineId: pipeline.id, dryRun: false },
        )
      }
    }

    return assertB2aPipelineReadAuthorized(req, pipeline, {
      tenantScope: scope.tenantId,
      purpose: B2A_PURPOSE_PIPELINE_RUNNER_READ,
      runId,
    })
  }

  /**
   * ENTRY POINT (1): the stock-preparation BOM expansion, fenced AT THE ROUTE.
   *
   * WHY HERE AS WELL AS IN THE WRAPPER. The table-action wrappers guard before `computeDryRun`,
   * which is before any `sourceAdapter.read` — but `loadTableActionSourceAdapter` runs EARLIER, in
   * the route, and it calls `getExternalSystemForAdapter`, which DECRYPTS the source system's
   * credentials. The contract puts the fence before "任何外部/源数据库连接、credential reload、源查询
   * 或 sourceAdapter.read", so the wrapper alone is one step too late. This hoists it.
   *
   * THE TWO GUARDS SHARE A RUN. The route claims the operation and hands the SAME `runId` to the
   * wrapper, whose guard then CONTINUES on that claim rather than trying to take a second one — the
   * same "bounded paging inside one operation" rule the large-BOM job relies on. So the evidence
   * stanza a small-route dry-run carries reports `operationClaimed: false` / `operationContinued:
   * true`: the claim was taken a few lines earlier, in the same Run.
   *
   * The wrapper's guard is kept rather than replaced, deliberately: it is the only thing standing
   * between a FUTURE in-process caller of `dryRunStockPreparationAction` and an unfenced read.
   *
   * `parameters` is normalized here purely to resolve `projectNo` before the adapter load. The
   * wrapper normalizes again from the same raw body — `normalizeActionParameters` is pure and
   * idempotent, so the two cannot disagree.
   */
  async function assertB2aStockPreparationReadAuthorized(action, rawParameters, { req, tenantScope, purpose, runId }) {
    if (!b2aTrialRegistry) return null
    const parameters = normalizeActionParameters(rawParameters)
    return assertB2aReadAuthorization({
      registry: b2aTrialRegistry,
      store: context.storage,
      operationClaim: b2aOperationClaim,
      tenantScope,
      sourceSystemType: action.source.kind,
      sourceBindingRef: action.source.externalSystemId,
      dataScopeRef: parameters.projectNo,
      // R-02 (finding 3): the read plan's own objects PLUS any the source system's server-side config
      // adds behind it. `req` is required only to scope that config read — armed-only, one extra
      // credential-free platform read, and a dormant deployment returns above without doing it.
      sourceObjects: await b2aTableActionSourceObjects(req, action, { tenantId: tenantScope }),
      purpose,
      runId,
      now: Date.now(),
    })
  }

  /**
   * The object list a stock-preparation table action's read WILL touch. See `resolveB2aSourceObjects`
   * — the plan's declarative objects, widened by a config-bound lookup object when the source kind
   * can carry one, and refused fail-closed when such a kind's config cannot be resolved.
   */
  async function b2aTableActionSourceObjects(req, action, scope = {}) {
    return resolveB2aSourceObjects({
      sourceObjects: readPlanSourceObjects(action.source.readPlan),
      sourceSystemType: action.source.kind,
      loadSourceSystemConfig: b2aSourceSystemConfigLoader(req, action.source.externalSystemId, {
        ...scope,
        ...(action.source.workspaceId ? { workspaceId: action.source.workspaceId } : {}),
      }),
    })
  }

  async function loadTableActionSourceAdapter(req, action, options = {}) {
    const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
      ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
      : externalSystems.getExternalSystem.bind(externalSystems)
    const sourceScope = { id: action.source.externalSystemId }
    if (options.tenantId) sourceScope.tenantId = options.tenantId
    if (action.source.workspaceId) sourceScope.workspaceId = action.source.workspaceId
    const system = await loadSystem(scopedAdapterInput(req, sourceScope))
    if (options.requireActive === true && (!system || system.status !== 'active')) {
      throw new HttpRouteError(409, 'TABLE_ACTION_SOURCE_NOT_ACTIVE', 'configured table action source is not active')
    }
    if (!system || system.kind !== action.source.kind) {
      throw new HttpRouteError(422, 'TABLE_ACTION_SOURCE_INVALID', `table action source must be ${action.source.kind}`, {
        actionId: action.actionId,
        sourceSystemId: action.source.externalSystemId,
        actualKind: system && system.kind,
      })
    }
    const principal = Object.prototype.hasOwnProperty.call(options, 'principal')
      ? options.principal
      : requestPrincipal(req)
    // W-5: forwards the B2a authorization stanza the caller already computed (dormant/unauthorized
    // omits it entirely — no key at all, not even `undefined` — so a factory that doesn't know this
    // dep sees exactly the same `deps` object it always has). Only `data-source:sql-readonly`
    // interprets it (see its factory); every other adapter kind ignores the extra key.
    return adapterRegistry.createAdapter(system, {
      principal,
      ...(options.b2aAuthorization ? { b2aAuthorization: options.b2aAuthorization } : {}),
    })
  }

  /**
   * 工作台里选源 — the #5401 join, as a Map of externalSystemId -> boolean|undefined.
   *
   * `true`  — the host's `dataSources.describe` resolved it for THIS principal, i.e. they own it.
   * `false` — the facade refused. Owner mismatch and deleted row are indistinguishable by design
   *           (`assertAccess` throws the same wording for both), so this leaks no existence.
   * absent  — the question does not apply (a `self-contained` kind such as the legacy SQL bridge
   *           carries its own connection and no core data-source reference) OR the host predates the
   *           descriptor seam. Both mean "undecided", and `sourceBindingRefusalReason` treats only an
   *           explicit `false` as disqualifying — a host without the seam must not silently empty the
   *           picker, which would look exactly like "you own nothing".
   *
   * Why the DATA-PLANE check and not an admin one: `assertAccess` has no admin bypass on the data
   * plane, so being an integration admin does not make a colleague's connection yours. Binding is
   * upstream of a read that will run as this same principal, so admitting a source they cannot read
   * would only schedule a later refusal — the "visible but not actionable" failure again.
   */
  async function resolveDataSourceAccessibility(req, systems) {
    const directory = context && context.api && context.api.dataSources
    if (!directory || typeof directory.describe !== 'function') return null
    const principal = requestPrincipal(req)
    const rows = (Array.isArray(systems) ? systems : []).filter(isPlainObject)
    const accessibility = new Map()
    await Promise.all(rows.map(async (system) => {
      if (describeConnectorKind(system.kind).connectionModel !== 'data-source') return
      const dataSourceId = firstString(
        system.connectionId,
        isPlainObject(system.config) ? system.config.dataSourceId : null,
      )
      if (!dataSourceId) return
      try {
        const described = await directory.describe(dataSourceId, principal)
        accessibility.set(system.id, Boolean(described && typeof described === 'object'))
      } catch {
        // Uniform refusal — see the note above. Never re-thrown: one unreadable candidate must not
        // fail the whole picker.
        accessibility.set(system.id, false)
      }
    }))
    return accessibility
  }

  function applyPermissionForUser(user) {
    return isAdmin(user) ? 'admin' : 'write'
  }

  function getOptionalRunLogger() {
    if (
      typeof pipelineRegistry.createPipelineRun !== 'function' ||
      typeof pipelineRegistry.updatePipelineRun !== 'function'
    ) {
      return null
    }
    return createRunLogger({ pipelineRegistry })
  }

  function externalWriteApplyMetrics(result = {}) {
    const counts = result.counts || {}
    return {
      rowsRead: counts.sourceRows || 0,
      rowsCleaned: counts.planned || 0,
      rowsWritten: counts.written || 0,
      rowsFailed: counts.failed || 0,
    }
  }

  function externalWriteRunStatus(status) {
    if (status === 'succeeded') return 'succeeded'
    if (status === 'partial') return 'partial'
    return 'failed'
  }

  function publicExternalWriteApplyResult(result, run) {
    const { provenanceEvents: _provenanceEvents, ...safe } = result
    if (run) {
      safe.run = {
        id: run.id,
        status: run.status,
        provenanceEventsPersisted: Array.isArray(run.provenanceEvents) ? run.provenanceEvents.length : null,
      }
    }
    return safe
  }

  const handlers = {
    async status(req, res) {
      requireAccess(req, 'read')
      return sendOk(res, {
        adapters: adapterRegistry.listAdapterKinds(),
        routes: ROUTES.map(([method, path]) => ({ method, path })),
      })
    },

    async k3WiseCallAudit(req, res) {
      // Internal operational evidence only. The snapshot is process-local and
      // values-free, but still reveals connector activity, so keep it admin-only
      // and reuse the existing tenant boundary before selecting its partition.
      requireAccess(req, 'admin')
      const tenantId = resolveTenantId(req, requestQuery(req))
      return sendOk(res, getK3WiseCallAuditSnapshot({ tenantId }))
    },

    async adaptersList(req, res) {
      requireAccess(req, 'read')
      const describe = typeof adapterRegistry.getAdapterMetadata === 'function'
        ? (kind) => describeAdapterKind(kind, adapterRegistry.getAdapterMetadata(kind))
        : (kind) => describeAdapterKind(kind)
      return sendOk(res, adapterRegistry.listAdapterKinds().map(describe))
    },

    // ---------------------------------------------------------------------
    // 对接总览 (GET /api/integration/hub/overview)
    //
    // GATE: `requireAccess(req, 'read')` — the integration READ tier, which `hasPermission`
    // defines as `integration:read` OR `integration:write` OR (`role:admin` / `integration:admin`).
    // Note the tier is a UNION, not a ladder: a write-only principal is INSIDE it, so there is no
    // "writer below read" to refuse here. What is refused is a principal holding NONE of those four
    // codes — including a stock-prep principal, whose vocabulary owns its own namespace and never
    // falls through to integration:* (see the R-11 comment on `hasPermission`).
    //
    // Every underlying read is one this principal can already do individually at the read tier
    // (external-systems / pipelines / read-source-configs / read-source-compositions). This route
    // adds no authority; it adds the JOIN. It writes nothing, and it never constructs an adapter,
    // opens a connection, consumes a token or reloads a credential.
    // ---------------------------------------------------------------------
    async integrationHubOverview(req, res) {
      requireAccess(req, 'read')
      const scope = scopedInput(req, {})
      const listScope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId }

      const [systems, pipelines, approvedReadSourceConfigs, approvedCompositions] = await Promise.all([
        externalSystems.listExternalSystems({ ...listScope, limit: HUB_OVERVIEW_SYSTEM_LIMIT }),
        pipelineRegistry.listPipelines({ ...listScope, limit: HUB_OVERVIEW_CONSUMER_LIMIT }),
        readSourceConfigs.list({ ...listScope, status: 'approved', limit: HUB_OVERVIEW_CONSUMER_LIMIT }),
        readSourceCompositions.list({ ...listScope, status: 'approved', limit: HUB_OVERVIEW_CONSUMER_LIMIT }),
      ])

      // The stock-prep table-action binding is SERVER-HELD — the deploy-time config plus, since
      // 工作台里选源, this scope's persisted override. Neither is a request input: the override is
      // looked up by the registry under the tenant/workspace the route already resolved, and the
      // body/query cannot name a source at all.
      //
      // SCOPED, deliberately. This used to pass only `{ actionId }`, which was harmless while the
      // source could only come from process env — there was one answer for the whole process. It is
      // no longer harmless: an unscoped lookup would make this card report the ENV DEFAULT while
      // every actual read used the tenant's bound source, i.e. the 对接总览 would quietly disagree
      // with the runtime about which system 备料 reads. `listScope` is the same tenant/workspace the
      // five reads above are already authorized under.
      //
      // An unconfigured deployment throws TABLE_ACTION_NOT_CONFIGURED — that is the "unplugged"
      // state, and it must render as "no consumer", not as a 5xx on the whole overview.
      const tableActionBindings = []
      try {
        const action = await tableActions.getTableAction({ ...listScope, actionId: PLM_STOCK_PREPARATION_ACTION_ID })
        const externalSystemId = action && action.source ? action.source.externalSystemId : null
        if (typeof externalSystemId === 'string' && externalSystemId.trim()) {
          tableActionBindings.push({ actionId: action.actionId, externalSystemId: externalSystemId.trim() })
        }
      } catch {
        // Not configured / not resolvable -> the 备料 action simply does not appear as a consumer.
      }

      // The data_sources DISPLAY join. `context.api.dataSources.describe` is the host's narrow,
      // principal-gated descriptor seam: it returns {id,name,type,status} and NOTHING else, and it
      // neither connects nor decrypts. A deployment whose host predates the seam resolves nothing
      // and the screen says so honestly (directory_unavailable) instead of implying ownership.
      const dataSourceDirectory = context && context.api && context.api.dataSources
      const dataSourceDirectoryAvailable = Boolean(dataSourceDirectory && typeof dataSourceDirectory.describe === 'function')
      const dataSourceDescriptors = new Map()
      if (dataSourceDirectoryAvailable) {
        const principal = requestPrincipal(req)
        const pointers = collectDataSourcePointers(systems)
        await Promise.all(pointers.map(async (dataSourceId) => {
          try {
            const described = await dataSourceDirectory.describe(dataSourceId, principal)
            if (!described || typeof described !== 'object') return
            dataSourceDescriptors.set(dataSourceId, {
              resolved: true,
              name: described.name,
              type: described.type,
              status: described.status,
            })
          } catch {
            // Owner mismatch, deleted row, or any facade fault: indistinguishable ON PURPOSE (the
            // host's assertAccess refuses both with the same wording, so no existence leaks here
            // either). The card renders 连接:已配置(他人管理).
          }
        }))
      }

      return sendOk(res, buildIntegrationHubOverview({
        systems,
        pipelines,
        readSourceConfigs: approvedReadSourceConfigs,
        compositions: approvedCompositions,
        tableActionBindings,
        dataSourceDescriptors,
        dataSourceDirectoryAvailable,
      }))
    },

    async externalSystemsList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      return sendOk(res, await externalSystems.listExternalSystems(scopedInput(req, {
        kind: query.kind,
        status: query.status,
        limit: asListLimit(query.limit),
        offset: asListOffset(query.offset),
      })))
    },

    async externalSystemsUpsert(req, res) {
      requireAccess(req, 'write')
      const body = requestBody(req)
      // P2-A: the registry validates a config.dataSourceId binding against the AUTHENTICATED
      // principal (owner-only, same as every facade read) and stamps attribution server-side —
      // so the principal comes from the request user, never the body (spread order overrides).
      const withPrincipal = { ...body, principal: requestPrincipal(req), runAs: 'user' }
      if (hasPrivateConfigMutation(body.kind, body.config)) {
        requireAccess(req, 'admin')
        return sendOk(res, await externalSystems.upsertExternalSystem(scopedAuthenticatedWriteInput(req, withPrincipal)), 201)
      }
      // A canonical Connection reference does not reveal or mutate its credentials, so the existing
      // integration:write authoring tier remains sufficient. It is still a tenant-authority write:
      // derive tenant from the authenticated principal only, and reject request-body steering.
      if (body.kind === 'data-source:sql-readonly') {
        return sendOk(res, await externalSystems.upsertExternalSystem(scopedAuthenticatedWriteInput(req, withPrincipal)), 201)
      }
      return sendOk(res, await externalSystems.upsertExternalSystem(scopedInput(req, withPrincipal)), 201)
    },

    async externalSystemsGet(req, res) {
      requireAccess(req, 'read')
      return sendOk(res, await externalSystems.getExternalSystem(scopedInput(req, { id: requestParams(req).id })))
    },

    async externalSystemsDelete(req, res) {
      requireAccess(req, 'write')
      return sendOk(res, await externalSystems.deleteExternalSystem(scopedInput(req, { id: requestParams(req).id })))
    },

    async externalSystemsTest(req, res) {
      requireAccess(req, 'write')
      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const system = await loadSystem(scopedAdapterInput(req, { id: requestParams(req).id }))
      const adapter = adapterRegistry.createAdapter(system, { principal: requestPrincipal(req) })
      let result
      try {
        result = normalizeTestConnectionResult(await adapter.testConnection(requestBody(req)))
      } catch (error) {
        result = testConnectionErrorResult(error)
      }
      const updatedSystem = await persistExternalSystemTestResult(externalSystems, req, system, result)
      return sendOk(res, {
        ...result,
        system: redactSystemForTest(updatedSystem),
      })
    },

    // #1709 follow-up: generic read-smoke preset route. Built-in preset catalog ONLY — no
    // user/request-supplied preset. Read-only: forced single-record detail read or the C3 customer-gated,
    // bounded LIST preset; no request-supplied pagination/filtering, no BOM/resolver, no Save/Submit/Audit,
    // no production write. Loads credentials via the backend getExternalSystemForAdapter context (never the
    // public, credential-stripped response) and never modifies the system's role/config. Evidence is
    // values-free.
    async externalSystemReadSmoke(req, res) {
      // Requires WRITE access: although the operation is read-only, this is an active credentialed outbound
      // probe of K3 and returns an existence signal (recordPresent) a read user could enumerate against keys.
      // Per the conservative discipline it is a connection/probe action → operator/integration-write only.
      requireAccess(req, 'write')
      // C2: normalize the contract via the C1 normalizer — accepts the shipped { presetId, key } subset AND
      // the forward { presetId, intent:{ object, mode, key } } shape, normalizing both to one output. The
      // normalizer is fail-closed + values-free: a raw path/method/payload/config can never ride in, and an
      // unknown preset/object/mode is rejected before any system load or adapter creation.
      let contract
      try {
        contract = normalizeReadSmokeContract(requestBody(req))
      } catch (error) {
        // Map to a 400 with a coarse, values-free reason only (never the key or submitted values).
        throw new HttpRouteError(400, 'READ_SMOKE_CONTRACT_INVALID', 'read-smoke contract is invalid', { reason: error && typeof error.reason === 'string' ? error.reason : 'invalid' })
      }
      const preset = getReadSmokePreset(contract.presetId)
      // Backend credential context — NOT the public, credential-stripped system response.
      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const system = await loadSystem(scopedAdapterInput(req, { id: requestParams(req).id }))
      // Kind must match the preset (fail-closed). Read-only: the system role/config is never modified here.
      if (!system || system.kind !== preset.requiredKind) {
        throw new HttpRouteError(409, 'READ_SMOKE_KIND_MISMATCH', 'external system kind does not match the preset')
      }
      const adapterSystem = applyReadSmokePresetOverlay(system, preset)
      const adapter = adapterRegistry.createAdapter(adapterSystem, { principal: requestPrincipal(req) })
      // Preset-owned read only; values-free evidence on success or failure (never key/raw/values/credentials).
      try {
        const result = await adapter.read(buildReadSmokeRequest(preset, contract))
        return sendOk(res, readSmokeSuccessEvidence(preset, result, contract))
      } catch (error) {
        return sendOk(res, readSmokeErrorEvidence(preset, error, contract))
      }
    },

    // S2-b (#1709 self-service): fixed locate-container probe route — the line's first live outbound read.
    // S1-validated config ONLY (the S2-a normalizer fail-closes any raw path/method/response/credential),
    // registered-system resolution ONLY (backend getExternalSystemForAdapter credential context; the URL :id
    // must name the config's systemId), probe-time re-run of isSafeRelativeReadPath inside the runtime,
    // platform-fixed timeout/row-cap, and values-free S2-a evidence on success AND failure. No persistence,
    // no system mutation, no write path.
    async externalSystemReadSourceProbe(req, res) {
      // Same conservative tier as read-smoke (S2 design-lock lock 10): an active credentialed outbound
      // probe is a connection/probe action → operator/integration-write only, never end-user reachable.
      requireAccess(req, 'write')
      let probe
      try {
        probe = prepareReadSourceProbe(requestBody(req))
      } catch (error) {
        // Coarse, values-free reason only (never the submitted config, path, key, or values).
        throw new HttpRouteError(400, 'READ_SOURCE_PROBE_CONTRACT_INVALID', 'read-source probe contract is invalid', { reason: error && typeof error.reason === 'string' ? error.reason : 'invalid' })
      }
      // Fail-closed: the URL :id and the config's systemId must name the same registered system.
      if (requestParams(req).id !== probe.plan.systemId) {
        throw new HttpRouteError(409, 'READ_SOURCE_PROBE_SYSTEM_MISMATCH', 'probe config does not reference this external system')
      }
      // Backend credential context — NOT the public, credential-stripped system response.
      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const system = await loadSystem(scopedAdapterInput(req, { id: requestParams(req).id }))
      if (!system || system.kind !== probe.plan.requiredKind) {
        throw new HttpRouteError(409, 'READ_SOURCE_PROBE_KIND_MISMATCH', 'external system kind does not match the probe config')
      }
      try {
        const evidence = await executeReadSourceProbe(probe, {
          system,
          createAdapter: (adapterSystem) => adapterRegistry.createAdapter(adapterSystem, { principal: requestPrincipal(req) }),
        })
        return sendOk(res, evidence)
      } catch (error) {
        if (error instanceof ReadSourceProbeRuntimeError) {
          throw new HttpRouteError(409, 'READ_SOURCE_PROBE_KIND_MISMATCH', 'external system kind does not match the probe config')
        }
        throw error
      }
    },

    // S2-c (#1709 self-service): consultant-tier persistence routes. Save is content-keyed idempotent
    // (identical config → the existing version, 200; new content → next version, 201). Status lifecycle
    // draft → approved → retired is fail-closed. Errors are values-free: the S1 validator's
    // { code, field, reason } tuples or a coarse status conflict — never the submitted config or a path.
    async readSourceConfigsSave(req, res) {
      // Consultant/admin tier (S2 design-lock lock 10): minting a persisted version is config-time
      // trust — integration write only, never end-user reachable.
      requireAccess(req, 'write')
      const body = requestBody(req)
      try {
        const saved = await readSourceConfigs.saveVersion(scopedInput(req, {
          config: body.config,
          actor: requestPrincipal(req),
        }))
        return sendOk(res, saved, saved.reused ? 200 : 201)
      } catch (error) {
        throw mapReadSourceConfigError(error)
      }
    },

    async readSourceConfigsList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      try {
        return sendOk(res, await readSourceConfigs.list(scopedInput(req, {
          systemId: query.systemId,
          status: query.status,
          limit: asListLimit(query.limit),
          offset: asListOffset(query.offset),
        })))
      } catch (error) {
        throw mapReadSourceConfigError(error)
      }
    },

    async readSourceConfigsGet(req, res) {
      requireAccess(req, 'read')
      try {
        return sendOk(res, await readSourceConfigs.get(scopedInput(req, { id: requestParams(req).id })))
      } catch (error) {
        throw mapReadSourceConfigError(error)
      }
    },

    async readSourceConfigsAudit(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      try {
        return sendOk(res, await readSourceConfigs.listAudit(scopedInput(req, {
          configId: requestParams(req).id,
          limit: asListLimit(query.limit),
          offset: asListOffset(query.offset),
        })))
      } catch (error) {
        throw mapReadSourceConfigError(error)
      }
    },

    async readSourceConfigsApprove(req, res) {
      requireAccess(req, 'write')
      try {
        return sendOk(res, await readSourceConfigs.approve(scopedInput(req, {
          id: requestParams(req).id,
          actor: requestPrincipal(req),
        })))
      } catch (error) {
        throw mapReadSourceConfigError(error)
      }
    },

    async readSourceConfigsRetire(req, res) {
      requireAccess(req, 'write')
      try {
        return sendOk(res, await readSourceConfigs.retire(scopedInput(req, {
          id: requestParams(req).id,
          actor: requestPrincipal(req),
        })))
      } catch (error) {
        throw mapReadSourceConfigError(error)
      }
    },

    // S3-2 (#1709 self-service): runtime-tier configured read — the end-user/cleansing tier consumes an
    // ALREADY-APPROVED read-source config version and supplies ONLY the preset-declared named key input.
    // No raw endpoint/filter/body/response-path can enter: the stored config is S1-normalized and the
    // request body is a strict {inputs} allowlist. The data plane (fieldMap-mapped values) flows to the
    // authorized caller under the S0 two-tier model; evidence stays values-free. requireAccess('read') IS
    // the designed runtime tier: config-time surfaces (save/approve/probe) stay write-tier, and an
    // approved preset + key-only body is exactly the end-user surface S0 defines.
    async readSourceConfigsRead(req, res) {
      requireAccess(req, 'read')
      const body = requestBody(req)
      // Strict body allowlist BEFORE anything else: only { inputs } may ride in from the runtime request.
      if (body !== undefined && body !== null) {
        if (typeof body !== 'object' || Array.isArray(body)) {
          throw new HttpRouteError(400, 'READ_SOURCE_READ_CONTRACT_INVALID', 'configured read request is invalid', { reason: 'not_object' })
        }
        const unexpected = Object.keys(body).filter((key) => key !== 'inputs' && key !== 'rowSource')
        if (unexpected.length > 0) {
          throw new HttpRouteError(400, 'READ_SOURCE_READ_CONTRACT_INVALID', 'configured read request is invalid', { reason: 'unexpected_field' })
        }
      }
      // #3889: WHICH PLANE the approved config is mapped over. The stock-preparation feeder ingests the
      // adapter's own record plane (normalized, flattened, paged rows); this route — the only surface that
      // returns MAPPED VALUES for an approved config, and therefore the only way to see what a config
      // actually produces — used to be able to run the raw plane only. That made the config an operator
      // verifies and the config the feeder executes two different things: a fieldMap that resolves
      // perfectly here could resolve NOWHERE there (a BOM tree's flattened lines, a PLM alias the wrapper
      // normalizes away) and be written as null on every row. It also left data-source:sql-readonly with no
      // usable surface at all — that adapter emits no raw payload, so the raw plane can only ever answer
      // RESPONSE_UNRECOGNIZED. Same closed enum the runtime validates; the default is unchanged.
      const rowSource = body && body.rowSource !== undefined ? body.rowSource : undefined
      if (rowSource !== undefined && rowSource !== 'raw_containers' && rowSource !== 'adapter_records') {
        throw new HttpRouteError(400, 'READ_SOURCE_READ_CONTRACT_INVALID', 'configured read request is invalid', { reason: 'execution_row_source_invalid' })
      }
      let row
      try {
        row = await readSourceConfigs.getForRuntime(scopedInput(req, { id: requestParams(req).id }))
      } catch (error) {
        throw mapReadSourceConfigError(error)
      }
      let prepared
      try {
        prepared = prepareConfiguredRead({ config: row.config, inputs: body ? body.inputs : undefined })
      } catch (error) {
        // Coarse, values-free reason only (never the stored config, key, or values).
        throw new HttpRouteError(400, 'READ_SOURCE_READ_CONTRACT_INVALID', 'configured read request is invalid', { reason: error && typeof error.reason === 'string' ? error.reason : 'invalid' })
      }
      // Backend credential context via the stored systemId reference — resolution stays dynamic (lock 5).
      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const system = await loadSystem(scopedAdapterInput(req, { id: row.systemId }))
      if (!system || system.kind !== prepared.plan.requiredKind) {
        throw new HttpRouteError(409, 'READ_SOURCE_READ_KIND_MISMATCH', 'external system kind does not match the approved config')
      }
      try {
        const { evidence, data } = await executeConfiguredRead(
          prepared,
          {
            system,
            createAdapter: (adapterSystem) => adapterRegistry.createAdapter(adapterSystem, { principal: requestPrincipal(req) }),
          },
          rowSource === undefined ? undefined : { rowSource },
        )
        return sendOk(res, { evidence, data })
      } catch (error) {
        // Defense-in-depth only: the route pre-checks kind above, so the executor's own kind re-check
        // (same guard, second layer) is unreachable here unless the runtime module changes.
        if (error instanceof ReadSourceProbeRuntimeError) {
          throw new HttpRouteError(409, 'READ_SOURCE_READ_KIND_MISMATCH', 'external system kind does not match the approved config')
        }
        // The record plane is one flat page of rows: it cannot express the header/lines split of
        // detail_with_lines, and resolver_lookup owns its own evaluator.
        if (error instanceof ReadSourceProbeContractError) {
          throw new HttpRouteError(400, 'READ_SOURCE_READ_CONTRACT_INVALID', 'configured read request is invalid', {
            reason: typeof error.reason === 'string' ? error.reason : 'invalid',
          })
        }
        throw error
      }
    },

    // C-R4-1 (#1709 composition): the composition HTTP surface. Authoring routes (save/list/get/audit/
    // approve/retire) are config-time (write/read tier) mirrors of the read-source-config routes; the run
    // route is the runtime tier — approved-only, key-only, values-free, read-only.
    async readSourceCompositionsSave(req, res) {
      // Consultant/admin tier: minting a persisted composition version is config-time trust.
      requireAccess(req, 'write')
      const body = requestBody(req)
      try {
        const saved = await readSourceCompositions.saveVersion(scopedInput(req, {
          config: body.config,
          actor: requestPrincipal(req),
        }))
        return sendOk(res, saved, saved.reused ? 200 : 201)
      } catch (error) {
        throw mapReadSourceCompositionConfigError(error)
      }
    },

    async readSourceCompositionsList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      try {
        return sendOk(res, await readSourceCompositions.list(scopedInput(req, {
          status: query.status,
          limit: asListLimit(query.limit),
          offset: asListOffset(query.offset),
        })))
      } catch (error) {
        throw mapReadSourceCompositionConfigError(error)
      }
    },

    async readSourceCompositionsGet(req, res) {
      requireAccess(req, 'read')
      try {
        return sendOk(res, await readSourceCompositions.get(scopedInput(req, { id: requestParams(req).id })))
      } catch (error) {
        throw mapReadSourceCompositionConfigError(error)
      }
    },

    async readSourceCompositionsAudit(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      try {
        return sendOk(res, await readSourceCompositions.listAudit(scopedInput(req, {
          configId: requestParams(req).id,
          limit: asListLimit(query.limit),
          offset: asListOffset(query.offset),
        })))
      } catch (error) {
        throw mapReadSourceCompositionConfigError(error)
      }
    },

    async readSourceCompositionsApprove(req, res) {
      requireAccess(req, 'write')
      try {
        return sendOk(res, await readSourceCompositions.approve(scopedInput(req, {
          id: requestParams(req).id,
          actor: requestPrincipal(req),
        })))
      } catch (error) {
        throw mapReadSourceCompositionConfigError(error)
      }
    },

    async readSourceCompositionsRetire(req, res) {
      requireAccess(req, 'write')
      try {
        return sendOk(res, await readSourceCompositions.retire(scopedInput(req, {
          id: requestParams(req).id,
          actor: requestPrincipal(req),
        })))
      } catch (error) {
        throw mapReadSourceCompositionConfigError(error)
      }
    },

    // C-R4-1 run route: the runtime tier for an approved composition chain. read-tier + key-only body
    // ({ inputs: { key } }) — exactly the S3-2 single-read surface, extended to a chain. Approved-only is
    // a DOUBLE gate: the composition config AND each referenced step read config are loaded via their
    // stores' getForRuntime (throws NOT_APPROVED for a non-approved version), and the C-R2 planner
    // re-validates the bundle inside the executor. Intermediate keys are derived by the platform; no raw
    // endpoint/filter/body/response-path or per-hop key can enter. Evidence stays values-free; chain data
    // is only the last hop's single resolver output.
    async readSourceCompositionsRun(req, res) {
      requireAccess(req, 'read')
      const body = requestBody(req)
      // Strict body allowlist BEFORE any store access: only { inputs } may ride in (the deep
      // { inputs: { key } } bound is enforced by the executor's own normalizer below).
      if (body !== undefined && body !== null) {
        if (typeof body !== 'object' || Array.isArray(body)) {
          throw new HttpRouteError(400, 'READ_SOURCE_COMPOSITION_RUN_CONTRACT_INVALID', 'composition run request is invalid', { reason: 'not_object' })
        }
        const unexpected = Object.keys(body).filter((key) => key !== 'inputs')
        if (unexpected.length > 0) {
          throw new HttpRouteError(400, 'READ_SOURCE_COMPOSITION_RUN_CONTRACT_INVALID', 'composition run request is invalid', { reason: 'unexpected_field' })
        }
      }

      // Load the approved composition config (approved-only gate #1).
      let composition
      try {
        composition = await readSourceCompositions.getForRuntime(scopedInput(req, { id: requestParams(req).id }))
      } catch (error) {
        throw mapReadSourceCompositionConfigError(error)
      }

      // Resolve each referenced step: its approved read config (approved-only gate #2 — getForRuntime
      // throws NOT_APPROVED) + its backend system (dynamic credential context via the stored systemId
      // reference). The bundle carries status:'approved' by construction (getForRuntime only returns
      // approved rows); the C-R2 planner re-validates it as defense-in-depth.
      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const steps = composition && composition.config && Array.isArray(composition.config.steps)
        ? composition.config.steps
        : []
      const stepConfigsById = {}
      for (const step of steps) {
        if (!step || typeof step.readSourceConfigId !== 'string' || Object.prototype.hasOwnProperty.call(stepConfigsById, step.readSourceConfigId)) {
          continue
        }
        let row
        try {
          row = await readSourceConfigs.getForRuntime(scopedInput(req, { id: step.readSourceConfigId }))
        } catch (error) {
          throw mapReadSourceConfigError(error)
        }
        const system = await loadSystem(scopedAdapterInput(req, { id: row.systemId }))
        stepConfigsById[step.readSourceConfigId] = { status: 'approved', config: row.config, system }
      }

      try {
        const { evidence, data } = await executeReadSourceComposition(composition.config, body || {}, {
          stepConfigsById,
          createAdapter: (adapterSystem) => adapterRegistry.createAdapter(adapterSystem, { principal: requestPrincipal(req) }),
        })
        return sendOk(res, { evidence, data })
      } catch (error) {
        // Only a client-supplied runtime-request contract violation throws; coarse, values-free reason.
        if (error instanceof ReadSourceCompositionRuntimeError) {
          throw new HttpRouteError(400, 'READ_SOURCE_COMPOSITION_RUN_CONTRACT_INVALID', 'composition run request is invalid', { reason: error && typeof error.reason === 'string' ? error.reason : 'invalid' })
        }
        throw error
      }
    },

    // BA-APPLY-2a (design-lock docs/development/bridge-agent-controlled-apply-design-lock-20260708.md
    // §2 形态 B): consultant/operator-tier persistence for a submitted, values-free implementation
    // checklist (BA-APPLY-1's `{ schemaVersion, operations }` artifact). Save is content-keyed
    // idempotent (identical checklist -> the existing version, 200; new content -> next version,
    // 201). Status lifecycle draft -> approved -> retired is fail-closed. Errors are values-free: the
    // contract validator's { code, field, reason } tuples (field is always a structural path) or a
    // coarse status conflict — NEVER the submitted checklist content. This route (and every route
    // below) never contacts the Bridge Agent — there is no apply here.
    async bridgeAgentChecklistsSave(req, res) {
      // Config-time trust (mirrors read-source-config save, lock 10): integration write only, never
      // end-user reachable.
      requireAccess(req, 'write')
      const body = requestBody(req)
      try {
        const saved = await bridgeAgentChecklists.saveVersion(scopedInput(req, {
          checklist: body.checklist,
          actor: requestPrincipal(req),
        }))
        return sendOk(res, saved, saved.reused ? 200 : 201)
      } catch (error) {
        throw mapBridgeAgentChecklistError(error)
      }
    },

    // Approval gate (design-lock "审批门", hard lock): only an APPROVED checklist is fetchable here —
    // this IS the apply-consumer surface (a human/ops-script fetches the approved, values-free
    // checklist and applies it locally per the existing runbook; NOTHING here calls the Agent, writes
    // a local config file, or invokes scripts/ops/bridge-agent-readonly.ps1). Draft/retired fail
    // closed with a coarse status-only 409 — never the checklist content.
    async bridgeAgentChecklistsGet(req, res) {
      requireAccess(req, 'read')
      try {
        return sendOk(res, await bridgeAgentChecklists.getForApply(scopedInput(req, { id: requestParams(req).id })))
      } catch (error) {
        throw mapBridgeAgentChecklistError(error)
      }
    },

    async bridgeAgentChecklistsApprove(req, res) {
      requireAccess(req, 'write')
      try {
        return sendOk(res, await bridgeAgentChecklists.approve(scopedInput(req, {
          id: requestParams(req).id,
          actor: requestPrincipal(req),
        })))
      } catch (error) {
        throw mapBridgeAgentChecklistError(error)
      }
    },

    async bridgeAgentChecklistsRetire(req, res) {
      requireAccess(req, 'write')
      try {
        return sendOk(res, await bridgeAgentChecklists.retire(scopedInput(req, {
          id: requestParams(req).id,
          actor: requestPrincipal(req),
        })))
      } catch (error) {
        throw mapBridgeAgentChecklistError(error)
      }
    },

    async externalSystemObjects(req, res) {
      requireAccess(req, 'read')
      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const system = await loadSystem(scopedAdapterInput(req, { id: requestParams(req).id }))
      const adapter = adapterRegistry.createAdapter(system, { principal: requestPrincipal(req) })
      const adapterObjects = typeof adapter.listObjects === 'function'
        ? await adapter.listObjects()
        : []
      const documentTemplateObjects = listDocumentTemplates(system)
      const objects = [
        ...(Array.isArray(adapterObjects) ? adapterObjects : []),
        ...documentTemplateObjects,
      ]
      return sendOk(res, sanitizeIntegrationPayload(objects, {
        maxArrayItems: EXTERNAL_SYSTEM_OBJECTS_MAX_ITEMS,
      }))
    },

    async externalSystemSchema(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      const object = firstString(query.object, query.name)
      if (!object) {
        throw new HttpRouteError(400, 'OBJECT_REQUIRED', 'object is required')
      }
      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const system = await loadSystem(scopedAdapterInput(req, { id: requestParams(req).id }))
      const template = findDocumentTemplate(system, object)
      if (template) {
        return sendOk(res, sanitizeIntegrationPayload({
          object: template.object,
          fields: template.schema,
          template: template.template,
        }))
      }
      const adapter = adapterRegistry.createAdapter(system, { principal: requestPrincipal(req) })
      const schema = typeof adapter.getSchema === 'function'
        ? await adapter.getSchema({ object })
        : { object, fields: [] }
      return sendOk(res, sanitizeIntegrationPayload(schema))
    },

    async pipelinesList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      return sendOk(res, await pipelineRegistry.listPipelines(scopedInput(req, {
        status: query.status,
        sourceSystemId: query.sourceSystemId,
        targetSystemId: query.targetSystemId,
        limit: asListLimit(query.limit),
        offset: asListOffset(query.offset),
      })))
    },

    async pipelinesUpsert(req, res) {
      requireAccess(req, 'write')
      const user = getUser(req)
      const body = requestBody(req)
      return sendOk(res, await pipelineRegistry.upsertPipeline(scopedInput(req, {
        ...body,
        createdBy: user && (user.id || user.email),
      })), 201)
    },

    async pipelinesGet(req, res) {
      requireAccess(req, 'read')
      const includeFieldMappings = requestQuery(req).includeFieldMappings !== 'false'
      return sendOk(res, await pipelineRegistry.getPipeline(scopedInput(req, {
        id: requestParams(req).id,
        includeFieldMappings,
      })))
    },

    // S3-1: first-class integration-template object CRUD (declarative; no instantiation).
    async templatesList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      return sendOk(res, await templateRegistry.listTemplates(scopedInput(req, {
        status: query.status,
        targetKind: query.targetKind,
        limit: asListLimit(query.limit),
        offset: asListOffset(query.offset),
      })))
    },

    // S3-3: read-only catalog of opt-in reference (example) templates. Values-free constants; the
    // operator copies a chosen one (with their scope) through POST /templates upsert — NOT auto-seeded.
    async templatesReferences(req, res) {
      requireAccess(req, 'read')
      return sendOk(res, listReferenceIntegrationTemplates())
    },

    async templatesUpsert(req, res) {
      requireAccess(req, 'write')
      const user = getUser(req)
      const body = requestBody(req)
      return sendOk(res, await templateRegistry.upsertTemplate(scopedInput(req, {
        ...body,
        createdBy: user && (user.id || user.email),
      })), 201)
    },

    async templatesGet(req, res) {
      requireAccess(req, 'read')
      return sendOk(res, await templateRegistry.getTemplate(scopedInput(req, {
        id: requestParams(req).id,
      })))
    },

    async templatesDelete(req, res) {
      requireAccess(req, 'write')
      return sendOk(res, await templateRegistry.deleteTemplate(scopedInput(req, {
        id: requestParams(req).id,
      })))
    },

    // S3-2: instantiate a template into a live pipeline, BINDING to caller-supplied source/target
    // systems (kind-validated, fail-closed). Body is a closed allowlist — credentials / write profile
    // are NEVER request-sourced. 404 (template) / 422 (bind) / 409 (name conflict) map via error.status.
    async templatesInstantiate(req, res) {
      requireAccess(req, 'write')
      const user = getUser(req)
      const body = normalizeTemplateInstantiateBody(requestBody(req))
      const created = await templateRegistry.instantiateTemplate(scopedInput(req, {
        tenantId: body.tenantId,
        workspaceId: body.workspaceId,
        templateId: requestParams(req).id,
        targetSystemId: body.targetSystemId,
        sourceSystemId: body.sourceSystemId,
        pipelineName: body.pipelineName,
        createdBy: user && (user.id || user.email),
      }))
      return sendOk(res, created, 201)
    },

    async pipelinesRun(req, res) {
      requireAccess(req, 'write')
      const body = requestBody(req)
      // B2a entry point (3) + E3-01. `pipelinesRun` never forwards `dryRun` (see `publicRunInput`),
      // so this route is unconditionally the non-dry one.
      const pipelineRunB2aRunId = b2aRunId('pipeline-run')
      await assertPipelineRunAllowed(req, {
        pipelineId: requestParams(req).id,
        dryRun: false,
        runId: pipelineRunB2aRunId,
      })
      const pipelineRunInput = scopedInput(req, {
        ...publicRunInput(body),
        pipelineId: requestParams(req).id,
        triggeredBy: 'api',
        runAs: 'user',
      })
      // W-2: hand the runner's own fence the run this route already claimed under, so the two guards
      // share ONE operation. Attached only when ARMED — a dormant deployment passes the runner the
      // exact object it passed before, with no extra key of any kind.
      if (b2aTrialRegistry) pipelineRunInput[B2A_AUTHORIZED_RUN_ID] = pipelineRunB2aRunId
      // R-wave (finding 4): THE GOVERNED WRITE SURFACE. This route is a live write, and the marker
      // says so with authority: it is attached only HERE, only after `requireAccess(req, 'write')`
      // and only after `assertPipelineRunAllowed` above ran the E3-01 write fence and the B2a read
      // authorization for this very pipeline. The runner refuses a markerless live write, which is
      // what closes the cross-plugin door (`index.cjs` strips the marker off that input).
      //
      // ARMED-ONLY, exactly like the run marker one line above and for the same reason: the fence it
      // feeds is armed-scoped, and a dormant deployment must hand the runner the object it always
      // handed it — no extra key, not even one that is ignored.
      if (b2aTrialRegistry) pipelineRunInput[C6_WRITE_LIFECYCLE_CONTEXT] = true
      return sendOk(res, await runner.runPipeline(pipelineRunInput), 202)
    },

    async pipelinesDryRun(req, res) {
      requireAccess(req, 'write')
      const body = requestBody(req)
      // B2a entry point (3): a dry run still READS the source, so it is gated. The E3-01 write
      // fence does not apply — the dry path calls `previewUpsert`, never `upsert`.
      const pipelineDryRunB2aRunId = b2aRunId('pipeline-dry-run')
      await assertPipelineRunAllowed(req, {
        pipelineId: requestParams(req).id,
        dryRun: true,
        runId: pipelineDryRunB2aRunId,
      })
      const pipelineDryRunInput = scopedInput(req, {
        ...publicRunInput(body),
        pipelineId: requestParams(req).id,
        triggeredBy: 'api',
        dryRun: true,
        runAs: 'user',
      })
      // W-2: same shared-run marker as the live route above; armed-only, for the same reason.
      if (b2aTrialRegistry) pipelineDryRunInput[B2A_AUTHORIZED_RUN_ID] = pipelineDryRunB2aRunId
      return sendOk(res, await runner.runPipeline(pipelineDryRunInput), 200)
    },

    async pipelinesExternalWriteDryRun(req, res) {
      requireAccess(req, 'read')
      const body = normalizeC6WriteDryRunBody(requestBody(req))
      const scope = scopedInput(req, {
        id: requestParams(req).id,
        tenantId: body.tenantId,
        workspaceId: body.workspaceId,
        includeFieldMappings: true,
      })
      const pipeline = await pipelineRegistry.getPipeline(scope)
      if (pipeline.status && pipeline.status !== 'active') {
        throw new HttpRouteError(422, 'PIPELINE_INACTIVE', 'pipeline must be active for C6 external-write dry-run', {
          pipelineId: pipeline.id,
          status: pipeline.status,
        })
      }
      const ownerPrincipal = firstString(pipeline.createdBy)
      if (!ownerPrincipal) {
        throw new HttpRouteError(422, 'C6_WRITE_OWNER_PRINCIPAL_REQUIRED', 'pipeline.createdBy is required for C6 external-write dry-run', {
          pipelineId: pipeline.id,
        })
      }
      // B2a ENTRY POINT (2). Here, not lower: the very next statement decrypts the source system's
      // credentials, and the contract puts the fence before any external/source connect, credential
      // reload or source query. `sourceSystemKind` is deliberately null — it is not knowable until
      // after that decrypt, so a registration for this purpose may not pin an adapter kind. Stated
      // rather than faked.
      await assertB2aPipelineReadAuthorized(req, pipeline, {
        tenantScope: scope.tenantId,
        purpose: B2A_PURPOSE_C6_EXTERNAL_WRITE_DRY_RUN,
        runId: b2aRunId('c6-external-write-dry-run'),
      })
      const loadSourceSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const sourceSystem = await loadSourceSystem(scopedAdapterInput(req, {
        id: pipeline.sourceSystemId,
        tenantId: body.tenantId,
        workspaceId: body.workspaceId,
      }, ownerPrincipal))
      // `getExternalSystem` is the credential-STRIPPED public accessor. The SOURCE has always used
      // the adapter-capable one (a few lines above); the TARGET never did — so an adapter-backed
      // target (K3) arrived with NO credentials and the C6 dry-run died with
      // K3_WISE_CREDENTIALS_MISSING before a single wire call. Reproduced against the real
      // registry: flipping this one accessor makes the whole lifecycle pass.
      //
      // Peek first, then re-load WITH credentials only for kinds that actually build a target
      // adapter. Kinds served by dataSourceWrites keep the config-only load they were designed
      // for, so this does not widen credential exposure for them.
      const targetSystemScope = scopedInput(req, {
        id: pipeline.targetSystemId,
        tenantId: body.tenantId,
        workspaceId: body.workspaceId,
      })
      let targetSystem = await externalSystems.getExternalSystem(targetSystemScope)
      if (
        targetSystem
        && ADAPTER_BACKED_C6_TARGET_KINDS.has(targetSystem.kind)
        && typeof externalSystems.getExternalSystemForAdapter === 'function'
      ) {
        targetSystem = await externalSystems.getExternalSystemForAdapter(targetSystemScope)
      }
      if (!sourceSystem) {
        throw new HttpRouteError(404, 'SOURCE_SYSTEM_NOT_FOUND', 'source external system not found')
      }
      if (!targetSystem) {
        throw new HttpRouteError(404, 'TARGET_SYSTEM_NOT_FOUND', 'target external system not found')
      }
      if (sourceSystem.status && sourceSystem.status !== 'active') {
        throw new HttpRouteError(422, 'SOURCE_SYSTEM_INACTIVE', 'source external system must be active', {
          sourceSystemId: sourceSystem.id,
          status: sourceSystem.status,
        })
      }
      if (targetSystem.status && targetSystem.status !== 'active') {
        throw new HttpRouteError(422, 'TARGET_SYSTEM_INACTIVE', 'target external system must be active', {
          targetSystemId: targetSystem.id,
          status: targetSystem.status,
        })
      }
      const sourceAdapter = adapterRegistry.createAdapter(sourceSystem, {
        role: 'source',
        principal: ownerPrincipal,
      })
      const c6 = resolveC6WritePlanInputs({ targetSystem, pipeline, context, adapterRegistry, ownerPrincipal, readSourceConfigs,
        getExternalSystem: (input) => externalSystems.getExternalSystem(input),
        instanceDigestOf: typeof externalSystems.getExternalSystemInstanceDigest === 'function'
          ? (input) => externalSystems.getExternalSystemInstanceDigest(input)
          : undefined })
      return sendOk(res, await dryRunExternalWrite({
        pipeline,
        sourceSystem,
        targetSystem: c6.planTargetSystem,
        sourceAdapter,
        dataSourceWrites: c6.dataSourceWrites,
        targetWriteProfile: c6.targetWriteProfile,
        tokenStore: context.storage,
        dryRunUser: requestPrincipal(req),
        dataSourceOwnerPrincipal: ownerPrincipal,
        // K3 targets (review #4761 P3): the profile's frozen cap is a CEILING — a caller may
        // narrow below it, never widen above it. The token stores the effective maxRows, and
        // the apply recompute reads it from the token, so the fence stays symmetric.
        maxRows: c6.enforcedMaxRows !== undefined
          ? (typeof body.maxRows === 'number' && body.maxRows >= 1 && body.maxRows < c6.enforcedMaxRows
            ? body.maxRows
            : c6.enforcedMaxRows)
          : body.maxRows,
        testFailureInjection: context && context.config && context.config.c6TestFailureInjection,
      }))
    },

    async pipelinesExternalWriteApply(req, res) {
      requireAccess(req, 'write')
      if (c6WriteApplyDisabled()) {
        throw new HttpRouteError(403, 'C6_WRITE_APPLY_DISABLED', 'C6 external-write Apply is disabled for this deployment')
      }
      resolveAuthenticatedWriteTenantId(req)
      const body = normalizeC6WriteApplyBody(requestBody(req))
      const scope = scopedAuthenticatedWriteInput(req, {
        id: requestParams(req).id,
        tenantId: body.tenantId,
        workspaceId: body.workspaceId,
        includeFieldMappings: true,
      })
      const pipeline = await pipelineRegistry.getPipeline(scope)
      if (pipeline.status && pipeline.status !== 'active') {
        throw new HttpRouteError(422, 'PIPELINE_INACTIVE', 'pipeline must be active for C6 external-write apply', {
          pipelineId: pipeline.id,
          status: pipeline.status,
        })
      }
      const ownerPrincipal = firstString(pipeline.createdBy)
      if (!ownerPrincipal) {
        throw new HttpRouteError(422, 'C6_WRITE_OWNER_PRINCIPAL_REQUIRED', 'pipeline.createdBy is required for C6 external-write apply', {
          pipelineId: pipeline.id,
        })
      }
      // `getExternalSystem` is the credential-STRIPPED public accessor. The SOURCE has always used
      // the adapter-capable one (below); the TARGET never did — so an adapter-backed target (K3)
      // arrived with NO credentials and the C6 dry-run died with K3_WISE_CREDENTIALS_MISSING
      // before a single wire call. Reproduced against the real registry: flipping this one
      // accessor makes the whole lifecycle pass.
      //
      // Peek first, then re-load WITH credentials only for kinds that actually build a target
      // adapter. Kinds served by dataSourceWrites keep the config-only load they were designed
      // for, so this does not widen credential exposure for them.
      const targetSystemScope = scopedAuthenticatedWriteInput(req, {
        id: pipeline.targetSystemId,
        tenantId: body.tenantId,
        workspaceId: body.workspaceId,
      })
      let targetSystem = await externalSystems.getExternalSystem(targetSystemScope)
      // ===== E4 LAYER 1 of FOUR — the outermost independent fence (HG v1.2 §10.2.1) =======
      // The credential-STRIPPED peek above is hoisted ahead of the source load ON PURPOSE: it is
      // the cheapest fact that identifies the target, and this refusal must land before the
      // request can cost anything. At this point NOTHING has happened yet — no source system has
      // been loaded with credentials, no adapter-backed credential RELOAD has run (that is the
      // block just below), no source adapter exists, no run has been opened in the run logger,
      // and `applyExternalWrite` — which is what consumes the single-use dry-run token — has not
      // been called. A refused apply therefore burns NOTHING: a token minted before this fence
      // shipped is still unconsumed after the refusal, and stays presentable until its own TTL
      // expires. That property is witnessed, not asserted, in the fence suite.
      //
      // The three deeper fences (layer 2 `applyExternalWrite`, layer 3 the K3 write source, layer 4
      // the K3 WebAPI adapter) do not depend on this one — a caller that skips HTTP entirely still
      // cannot reach a K3 Save. Acceptance E4-01.
      assertK3ExternalWriteRefused(
        (status, code, message, details) => new HttpRouteError(status, code, message, details),
        targetSystem,
      )
      // ===================================================================================
      // B2a ENTRY POINT (2), apply half — placed AFTER the E4 layer-1 fence ON PURPOSE:
      // a doomed K3 apply must not consume the registration's single-use operation claim. Apply RE-RUNS the planner and therefore RE-READS the
      // source, so it is a source-read Run in its own right and is gated in its own right — it does
      // not inherit the dry-run's authorization through the token.
      await assertB2aPipelineReadAuthorized(req, pipeline, {
        tenantScope: scope.tenantId,
        purpose: B2A_PURPOSE_C6_EXTERNAL_WRITE_DRY_RUN,
        runId: b2aRunId('c6-external-write-apply'),
      })
      const loadSourceSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const sourceSystem = await loadSourceSystem(scopedAuthenticatedWriteInput(req, {
        id: pipeline.sourceSystemId,
        tenantId: body.tenantId,
        workspaceId: body.workspaceId,
        principal: ownerPrincipal,
        runAs: 'user',
      }))
      if (
        targetSystem
        && ADAPTER_BACKED_C6_TARGET_KINDS.has(targetSystem.kind)
        && typeof externalSystems.getExternalSystemForAdapter === 'function'
      ) {
        targetSystem = await externalSystems.getExternalSystemForAdapter(targetSystemScope)
      }
      if (!sourceSystem) {
        throw new HttpRouteError(404, 'SOURCE_SYSTEM_NOT_FOUND', 'source external system not found')
      }
      if (!targetSystem) {
        throw new HttpRouteError(404, 'TARGET_SYSTEM_NOT_FOUND', 'target external system not found')
      }
      if (sourceSystem.status && sourceSystem.status !== 'active') {
        throw new HttpRouteError(422, 'SOURCE_SYSTEM_INACTIVE', 'source external system must be active', {
          sourceSystemId: sourceSystem.id,
          status: sourceSystem.status,
        })
      }
      if (targetSystem.status && targetSystem.status !== 'active') {
        throw new HttpRouteError(422, 'TARGET_SYSTEM_INACTIVE', 'target external system must be active', {
          targetSystemId: targetSystem.id,
          status: targetSystem.status,
        })
      }
      const sourceAdapter = adapterRegistry.createAdapter(sourceSystem, {
        role: 'source',
        principal: ownerPrincipal,
      })
      const runLogger = getOptionalRunLogger()
      let run = null
      if (runLogger) {
        run = await runLogger.startRun({
          tenantId: pipeline.tenantId,
          workspaceId: pipeline.workspaceId,
          pipelineId: pipeline.id,
          mode: 'manual',
          triggeredBy: 'api',
          details: {
            c6ExternalWrite: true,
            targetKind: targetSystem.kind,
          },
        })
      }
      try {
        // SAME resolution as dry-run (server-side, by target kind) so the apply recompute
        // reproduces the dry-run revision; the multitable write-source writes own sheets only.
        const c6 = resolveC6WritePlanInputs({ targetSystem, pipeline, context, adapterRegistry, ownerPrincipal, readSourceConfigs,
        getExternalSystem: (input) => externalSystems.getExternalSystem(input),
        instanceDigestOf: typeof externalSystems.getExternalSystemInstanceDigest === 'function'
          ? (input) => externalSystems.getExternalSystemInstanceDigest(input)
          : undefined })
        const result = await applyExternalWrite({
          pipeline,
          sourceSystem,
          targetSystem: c6.planTargetSystem,
          sourceAdapter,
          dataSourceWrites: c6.dataSourceWrites,
          targetWriteProfile: c6.targetWriteProfile,
          tokenStore: context.storage,
          deadLetterStore: deadLetters,
          dryRunToken: body.confirm.dryRunToken,
          applyUser: requestPrincipal(req),
          dataSourceOwnerPrincipal: ownerPrincipal,
          runId: run && run.id,
          testFailureInjection: context && context.config && context.config.c6TestFailureInjection,
        })
        if (runLogger && run) {
          run = await runLogger.finishRun(run, externalWriteApplyMetrics(result), externalWriteRunStatus(result.status), {
            provenanceEvents: result.provenanceEvents,
            details: {
              c6ExternalWrite: true,
              dryRunRevision: result.dryRunRevision,
              status: result.status,
              counts: result.counts,
              deadLetters: result.deadLetters,
            },
          })
        }
        return sendOk(res, publicExternalWriteApplyResult(result, run))
      } catch (error) {
        if (runLogger && run) {
          await runLogger.failRun(run, error, { rowsFailed: 1 }, {
            details: {
              c6ExternalWrite: true,
              status: 'failed',
              errorCode: error && (error.code || error.name) ? String(error.code || error.name) : 'C6_WRITE_APPLY_FAILED',
            },
          })
        }
        throw error
      }
    },

    async tableActionsList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      return sendOk(res, await tableActions.listTableActions(scopedInput(req, {
        actionId: query.actionId,
      })))
    },

    // 一线自己拉数据: the legacy `integration:read` tier is unchanged; a stock-prep operator
    // (operate ∧ read) is additionally admitted, for the pull-bom action id ONLY. Nothing below this
    // line differs by which branch admitted the caller — the tenant resolution, the B2a fence and
    // the plan are identical, so an operator's dry run is the same dry run it always was.
    async tableActionDryRun(req, res) {
      // The action id is read from the route params FIRST because the gate is scoped to it — but it
      // is a pure param read, so the 401/403 still precedes every other validation and every IO.
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      requireTableActionAccess(req, actionId, 'read')
      const body = normalizeTableActionBody(requestBody(req))
      const action = assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      const dryRunTenantId = resolveTenantId(req, {})
      const dryRunB2aRunId = b2aRunId('table-action-dry-run')
      // B2a entry point (1), ahead of the credential reload inside the adapter load below.
      const dryRunB2aAuthorization = await assertB2aStockPreparationReadAuthorized(action, body.parameters, {
        req,
        tenantScope: dryRunTenantId,
        purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
        runId: dryRunB2aRunId,
      })
      // W-5: same stanza, forwarded so a `data-source:sql-readonly` source enforces its two SQL
      // Server read floors for this run (see loadTableActionSourceAdapter / the adapter's read()).
      const sourceAdapter = await loadTableActionSourceAdapter(req, action, { b2aAuthorization: dryRunB2aAuthorization })
      return sendOk(res, await dryRunStockPreparationAction({
        action,
        parameters: body.parameters,
        sourceAdapter,
        recordsApi: getMultitableRecordsApi(),
        tokenStore: context.storage,
        policyStore: context.storage,
        conflictPolicyReview: body.conflictPolicyReview,
        // Pack-aware bands, from the install ledger + a live per-field read. undefined (no ledger,
        // no pack, or a read failure) omits the parameter and the planner takes its legacy path.
        // The apply route below resolves it the SAME way so the two agree on the plan revision.
        installedFieldProperties: await resolveInstalledFieldProperties(req, action),
        // The source->`ext_` mapping, from server config. null when unconfigured, which
        // `computeDryRun` treats as absent — no `ext_` key is produced and the plan is what it was.
        // Configured: the SAME object the apply route passes, so both routes expand the same rows
        // and agree on the dry-run revision. It is never request-influenced.
        extFieldMapping: stockPreparationExtFieldMapping,
        // Confirmation-ledger readback (first cut). Server-resolved, see the factory above.
        confirmationDecisionResolver: confirmationDecisionResolverForRequest(req),
        // B2a. `tenantId` is resolved the SAME way `loadTableActionSourceAdapter` scoped the
        // external-system lookup a line above (`scopedInput` -> `resolveTenantId`), so the tenant the
        // gate checks and the tenant whose source is about to be read are one value, not two that
        // could disagree.
        b2aTrialRegistry,
        b2aClaimStore: context.storage,
        b2aOperationClaim,
        b2aRunId: dryRunB2aRunId,
        tenantId: dryRunTenantId,
        now: Date.now(),
      }))
    },

    // B-stage ledger WRITE: repeat the readonly table-action plan server-side and persist ONLY
    // values-free manual-confirm decision metadata (duplicate_expanded_key class, first cut). No
    // plan row is applied, no request-supplied plan/value payload is accepted, and the canonical
    // sheet is untouched by construction (the ledger module holds no capability toward it).
    async tableActionConfirmationDecisionsReconcile(req, res) {
      const user = requireAccess(req, 'admin')
      const audit = requireStockPreparationAudit()
      const reconcileLease = requireConfirmationDecisionReconcileLease()
      const body = normalizeTableActionBody(
        requestBody(req),
        VALID_TABLE_ACTION_CONFIRMATION_DECISION_RECONCILE_BODY_KEYS,
      )
      const tenantId = resolveAuthUserTenantId(req)
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const action = assertStockPreparationTargetReady(await tableActions.getTableAction({ tenantId, actionId }))
      // B2a entry point (1), RECONCILE half — the gap W-2 closes at this layer.
      //
      // This route re-runs the readonly table-action plan server-side, which means it expands the
      // customer's BOM off the external source exactly as the dry-run route does. Every other
      // stock-prep read entry got this fence in PR-C; this one was missed, and unlike the dry-run /
      // apply / MVP-persist paths its handoff (`prepareStockPreparationConfirmationDecisions`) carries
      // no wrapper-level guard either — so before this line the reconcile path reached
      // `loadTableActionSourceAdapter`, and therefore `getExternalSystemForAdapter`'s credential
      // DECRYPT, with nothing standing in the way on an armed deployment.
      //
      // Placed here for the same reason the other three are: `loadTableActionSourceAdapter` is the
      // credential reload, and §13 PR-C puts the fence ahead of it. Its purpose is the shared
      // `stock-preparation.table-action` one — reconcile reads the same source, for the same
      // customer-facing refresh line, as the dry-run it repeats; it is not a second consumer.
      //
      // NO DOUBLE BURN: the prepare handoff below holds no B2a guard of its own, so this route's
      // claim is the only one taken on the path.
      const reconcileB2aAuthorization = await assertB2aStockPreparationReadAuthorized(action, body.parameters, {
        req,
        tenantScope: tenantId,
        purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
        runId: b2aRunId('table-action-confirmation-decisions-reconcile'),
      })
      // MERGE-TRAIN (W-2 x W-5). W-5 enforces the two armed SQL-Server read floors inside
      // `data-source:sql-readonly` ONLY when the caller forwards its authorization stanza — the
      // floors are opt-in, not fail-closed, so a source-read path that omits it reads with the floors
      // silently off. This route is a B2a-gated source read that W-5 could not forward from because
      // W-2 added it; without this line it would be the ONE armed stock-prep read escaping them.
      const sourceAdapter = await loadTableActionSourceAdapter(req, action, {
        tenantId,
        requireActive: true,
        b2aAuthorization: reconcileB2aAuthorization,
      })
      const prepared = await prepareStockPreparationConfirmationDecisions({
        action,
        parameters: body.parameters,
        conflictPolicyReview: body.conflictPolicyReview,
        sourceAdapter,
        recordsApi: getMultitableRecordsApi(),
        policyStore: context.storage,
        installedFieldProperties: await resolveInstalledFieldProperties(req, action),
        extFieldMapping: stockPreparationExtFieldMapping,
      })
      // The audit table's action vocabulary is migration-frozen (9 actions). Decision-candidate
      // generation is a generation run with a fixed operation subtype, not a new action. Audit the
      // intent BEFORE the multitable write so an audit-store refusal cannot leave a committed
      // ledger row behind a failed HTTP response.
      await audit.append({
        tenantId,
        action: 'generation_run',
        subjectId: action.actionId,
        mode: 'confirmation_reconcile_requested',
        actor: user.id || user.email,
        detail: { operation: 'confirmation_decisions_reconcile' },
      })
      const result = await reconcileConfirmationDecisions({
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        permission: 'admin',
        projectNo: prepared.parameters.projectNo,
        plan: prepared.plan,
        sourceRevision: prepared.revision,
        reconcileLease,
      })
      return sendOk(res, result, result.counts.created > 0 ? 201 : 200)
    },

    // Re-run the approved readonly table action and commit its expansion directly
    // into the MetaSheet-internal MVP snapshot tables. Raw rows stay in-process;
    // this route never calls the table-action Apply writer or any external writer.
    async tableActionMvpPersist(req, res) {
      requireAccess(req, 'admin')
      if (!stockPreparationTableActionMvpPersistEnabled()) {
        throw new HttpRouteError(
          403,
          'STOCK_PREPARATION_TABLE_ACTION_MVP_PERSIST_DISABLED',
          'table-action MVP persistence is disabled',
        )
      }
      assertStockPreparationTableActionMvpPersistNoSteering(req)
      const tenantId = resolveAuthUserTenantId(req)
      const body = normalizeTableActionBody(requestBody(req), VALID_TABLE_ACTION_MVP_PERSIST_BODY_KEYS)
      const parameters = normalizeActionParameters(body.parameters)
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const action = assertStockPreparationTargetReady(await tableActions.getTableAction({ tenantId, actionId }))
      const mvpPersistB2aRunId = b2aRunId('table-action-mvp-persist')
      // B2a entry point (1), MVP-persist half — its OWN purpose, because committing a customer's BOM
      // into the internal snapshot tables is a different consumer from an interactive refresh.
      const mvpPersistB2aAuthorization = await assertB2aStockPreparationReadAuthorized(action, body.parameters, {
        req,
        tenantScope: tenantId,
        purpose: B2A_PURPOSE_STOCK_PREPARATION_MVP_PERSIST,
        runId: mvpPersistB2aRunId,
      })
      // W-5: same stanza, forwarded — see the dry-run route above for why.
      const sourceAdapter = await loadTableActionSourceAdapter(req, action, {
        tenantId,
        requireActive: true,
        b2aAuthorization: mvpPersistB2aAuthorization,
      })
      const prepared = await prepareStockPreparationMvpSnapshot({
        action,
        parameters,
        sourceAdapter,
        recordsApi: getMultitableRecordsApi(),
        // B2a. `tenantId` here is the authenticated-user tenant this route already resolved and
        // already scoped the adapter load with — never a query/body carrier.
        b2aTrialRegistry,
        b2aClaimStore: context.storage,
        b2aOperationClaim,
        b2aRunId: mvpPersistB2aRunId,
        tenantId,
        now: Date.now(),
      })
      const targetProjectId = resolveIntegrationStagingProjectId(tenantId, undefined)
      const stableScope = `${tenantId}\n${action.actionId}\n${prepared.parameters.projectNo}`
      const projectId = `stockprep_${crypto.createHash('sha256').update(stableScope).digest('hex').slice(0, 32)}`
      const batchScope = `${stableScope}\n${prepared.revision}`
      const batchDigest = crypto.createHash('sha256').update(batchScope).digest('hex').slice(0, 32)
      // 备料 BATCH IDENTITY. The owner's rule is that the material CREATION HOUR separates a
      // project's batches; shipped code separated them by this content-revision digest plus the
      // persist-time monotonic `snapshotVersion`. The rule is now implemented, and DECLARED per
      // deployment on the read plan (batchIdentity.mode) rather than switched on for everyone —
      // the batch id is the persist idempotency key, so changing which pulls count as one batch is
      // a behaviour change a running install must opt into. Absent => `snapshot_<digest>`, exactly
      // as before. A deployment that asks for the hour rule but whose source carries no usable
      // creation time falls back to the same id and SAYS SO in the evidence below.
      //
      // `syncRunId` stays revision-derived on purpose: under the hour rule a second pull in the same
      // hour with CHANGED content then lands on the same batch id with a different run, which the
      // persist replay check refuses with a coded idempotency conflict — fail closed, never a silent
      // overwrite of a batch the operator believes is that hour's.
      //
      // An UNKNOWN declared mode is a deploy-time typo. It refuses with a coded 422 rather than
      // quietly meaning "legacy", because a deployment that believes it turned the rule on and did
      // not would batch by the wrong rule with nothing on the response to show for it.
      let batchIdentityMode
      try {
        batchIdentityMode = readStockPreparationBatchIdentityMode(action.source.readPlan)
      } catch (error) {
        if (error instanceof StockPreparationBatchIdentityError) {
          throw new HttpRouteError(
            422,
            'STOCK_PREPARATION_BATCH_IDENTITY_MODE_INVALID',
            'source.readPlan.batchIdentity.mode is not a known batch-identity mode',
            { field: error.details && error.details.field },
          )
        }
        throw error
      }
      const batchIdentity = mintStockPreparationBatchIdentity({
        mode: batchIdentityMode,
        projectNo: prepared.parameters.projectNo,
        rows: prepared.expansionResult,
        legacyBatchId: `snapshot_${batchDigest}`,
      })
      const result = await persistStockPreparationSyncRun({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId,
        lockTenantId: tenantId,
        projectId,
        syncRunId: `sync_${batchDigest}`,
        snapshotBatchId: batchIdentity.batchId,
        allocateSnapshotVersion: true,
        sourceSystem: action.source.kind,
        sourceProjectNo: prepared.parameters.projectNo,
        expansionResult: prepared.expansionResult,
        readPlan: action.source.readPlan,
      })
      return sendOk(res, {
        status: result.persisted ? 'created' : 'skipped_existing',
        persisted: result.persisted === true,
        created: result.created,
        source: prepared.evidence,
        // Values-free: counts, the effective mode and a coded reason. A deployment that asked for
        // the hour rule and silently got the legacy id would be exactly the failure this reports.
        batchIdentity: batchIdentity.evidence,
        evidence: result.evidence,
      }, result.persisted ? 201 : 200)
    },

    // 一线自己拉数据: same split as the dry run above — the legacy `integration:write` tier is
    // unchanged, and a stock-prep operator is additionally admitted for the pull-bom action ONLY.
    // The dry-run TOKEN is still the thing that authorizes what gets written, so an operator cannot
    // apply anything they did not just plan.
    async tableActionApply(req, res) {
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const user = requireTableActionAccess(req, actionId, 'write')
      const body = normalizeTableActionBody(requestBody(req), VALID_TABLE_ACTION_APPLY_BODY_KEYS)
      const action = assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      const applyTenantId = resolveTenantId(req, {})
      const applyB2aRunId = b2aRunId('table-action-apply')
      // B2a entry point (1), apply half — ahead of the credential reload AND of the token consume,
      // so a refusal never burns a single-use dry-run token.
      const applyB2aAuthorization = await assertB2aStockPreparationReadAuthorized(action, body.parameters, {
        req,
        tenantScope: applyTenantId,
        purpose: B2A_PURPOSE_STOCK_PREPARATION_TABLE_ACTION,
        runId: applyB2aRunId,
      })
      // W-5: same stanza, forwarded — see the dry-run route above for why.
      const sourceAdapter = await loadTableActionSourceAdapter(req, action, { b2aAuthorization: applyB2aAuthorization })
      const confirm = isPlainObject(body.confirm) ? body.confirm : {}
      return sendOk(res, await applyStockPreparationAction({
        action,
        parameters: body.parameters,
        dryRunToken: confirm.dryRunToken,
        acceptManualConfirmHold: confirm.acceptManualConfirmHold === true,
        acceptDuplicateResolution: confirm.acceptDuplicateResolution === true,
        permission: applyPermissionForUser(user),
        sourceAdapter,
        // Same projection the dry-run route resolved, resolved the same way: apply recomputes the
        // plan and compares revisions, so the two routes must read the bands from one seam.
        installedFieldProperties: await resolveInstalledFieldProperties(req, action),
        // Same mapping the dry-run route used, for the same reason: apply RE-EXPANDS the source and
        // compares its revision against the token. A mapping on one route and not the other would
        // make every apply fail TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH.
        extFieldMapping: stockPreparationExtFieldMapping,
        // Same ledger readback the dry-run route consulted, for the same token-parity reason. A
        // decision confirmed/superseded between dry-run and apply changes the recomputed revision
        // and fails the token check — fail-closed. Production Apply remains off this line entirely
        // (sandbox/production gates above are untouched).
        confirmationDecisionResolver: confirmationDecisionResolverForRequest(req),
        recordsApi: getMultitableRecordsApi(),
        tokenStore: context.storage,
        policyStore: context.storage,
        // FOS-4b-3 P0 sandbox gate: explicit config OR env (STOCK_PREP_SANDBOX_MODE + allowlist).
        // Absent (e.g. prod default) → undefined → apply fail-closed.
        sandboxPolicy: resolveStockPrepApplySandboxPolicy(context.config),
        // FOS-4b-3-prod P2: production policy is SERVER-CONFIG-ONLY (dormant by default). Absent → undefined
        // → sandbox gate (canonical rejected). Request body never supplies it.
        productionPolicy: resolveStockPrepApplyProductionPolicy(context.config),
        // B2a, on the same registry and the same tenant resolution the dry-run route used. Apply
        // RE-EXPANDS the source, so it is a source read in its own right and is gated in its own
        // right — it does not inherit the dry-run's authorization through the token.
        b2aTrialRegistry,
        b2aClaimStore: context.storage,
        b2aOperationClaim,
        b2aRunId: applyB2aRunId,
        tenantId: applyTenantId,
        now: Date.now(),
      }))
    },

    async tableActionLargeBomExpansionJobStart(req, res) {
      requireAccess(req, 'read')
      const body = normalizeTableActionBody(requestBody(req), VALID_TABLE_ACTION_LARGE_BOM_START_BODY_KEYS)
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const routeScope = largeBomJobScope(req, { actionId })
      const action = assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      const parameters = normalizeActionParameters(body.parameters)
      const job = await createLargeBomBackgroundExpansionJob({
        storage: context.storage,
        ...routeScope,
        action,
        parameters,
        principal: requestPrincipal(req),
      })
      return sendOk(res, largeBomJobResponse(publicBackgroundExpansionJob(job)), 202)
    },

    async tableActionLargeBomExpansionJobGet(req, res) {
      requireAccess(req, 'read')
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      const routeScope = largeBomJobScope(req, { actionId })
      const job = await loadLargeBomBackgroundExpansionJob({
        storage: context.storage,
        ...routeScope,
        actionId,
        jobId: firstString(requestParams(req).jobId),
      })
      return sendOk(res, largeBomJobResponse(publicBackgroundExpansionJob(job)))
    },

    async tableActionLargeBomExpansionJobRun(req, res) {
      requireAccess(req, 'read')
      normalizeTableActionBody(requestBody(req), VALID_EMPTY_REQUEST_KEYS)
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const jobId = firstString(requestParams(req).jobId)
      const routeScope = largeBomJobScope(req, { actionId })
      const queuedJob = await loadLargeBomBackgroundExpansionJob({
        storage: context.storage,
        ...routeScope,
        actionId,
        jobId,
      })
      const action = assertStockPreparationTargetReady(queuedJob.actionSnapshot)
      // B2a — the FOURTH and last call site of `loadTableActionSourceAdapter`, and the only one
      // gated at the route rather than inside a table-action wrapper. It has to be: this path does
      // not go through `dryRunStockPreparationAction`, it drives `runLargeBomBackgroundExpansionJob`
      // off a STORED job. Both halves of the scope come from that stored artifact — the action
      // snapshot's source binding and the `projectNo` that `normalizeActionParameters` validated
      // when the job was created — so the gate reads exactly what the expansion is about to read.
      //
      // Gated BEFORE the adapter is loaded, so a refusal on this path costs not even an
      // external-system registry lookup. Its own purpose: a large-BOM background expansion is a
      // different consumer from an interactive refresh, and a `forbidReuse` registration says so.
      const largeBomB2aAuthorization = await assertB2aReadAuthorization({
        registry: b2aTrialRegistry,
        store: context.storage,
        operationClaim: b2aOperationClaim,
        tenantScope: routeScope.tenantId,
        sourceSystemType: action.source.kind,
        sourceBindingRef: action.source.externalSystemId,
        dataScopeRef: queuedJob.parameters && queuedJob.parameters.projectNo,
        // R-02 (finding 3), same widening as the other four stock-prep entries — but computed under
        // an explicit ARMED test, because unlike them this call site has no dormant short-circuit
        // above it: `assertB2aReadAuthorization` returns null for a null registry only AFTER its
        // arguments are evaluated, and a dormant deployment must not spend even the one extra
        // credential-free platform read the resolver makes.
        sourceObjects: b2aTrialRegistry
          ? await b2aTableActionSourceObjects(req, action, { tenantId: routeScope.tenantId })
          : readPlanSourceObjects(action.source.readPlan),
        purpose: B2A_PURPOSE_STOCK_PREPARATION_LARGE_BOM,
        // The JOB ID is the Run identity here, deliberately: re-running the SAME stored job
        // continues on the claim it already holds (bounded paging inside one operation), while a
        // NEW job is a new Run and needs its own registration.
        runId: `large-bom:${jobId}`,
        now: Date.now(),
      })
      // W-5: same stanza, forwarded — see the dry-run route above for why.
      const sourceAdapter = await loadTableActionSourceAdapter(req, action, {
        principal: queuedJob.principal,
        b2aAuthorization: largeBomB2aAuthorization,
      })
      const job = await runLargeBomBackgroundExpansionJob({
        storage: context.storage,
        ...routeScope,
        actionId,
        jobId,
        sourceAdapter,
        expansionOptions: {
          ...largeBomExpansionOptionsForAction(action),
          // E3-02's 断游标 half on the background path. ARMED ONLY: a page that reports `done: false`
          // and offers no cursor stops being a silent truncation and becomes a failed expansion —
          // which on THIS path already means `authoritative: false`, and therefore no plan, because
          // `tableActionLargeBomExpansionJobPlan` refuses a non-authoritative artifact before it
          // builds one. The other half of E3-02 (maxRows/maxPages/read_time_limit) needs no guard
          // here for the same reason: every bounded expansion sets `valid: false`.
          requireCompleteBatch: Boolean(largeBomB2aAuthorization),
        },
      })
      return sendOk(res, largeBomJobResponse(publicBackgroundExpansionJob(job)))
    },

    async tableActionLargeBomExpansionJobPlan(req, res) {
      requireAccess(req, 'read')
      const body = normalizeTableActionBody(requestBody(req), VALID_TABLE_ACTION_LARGE_BOM_PLAN_BODY_KEYS)
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const jobId = firstString(requestParams(req).jobId)
      const routeScope = largeBomJobScope(req, { actionId })
      const job = await loadLargeBomBackgroundExpansionJob({
        storage: context.storage,
        ...routeScope,
        actionId,
        jobId,
      })
      assertAuthoritativeLargeBomExpansion(job)
      const action = assertStockPreparationTargetReady(job.actionSnapshot)
      const projectNo = job.parameters && job.parameters.projectNo
      const existingRows = await tableActionInternals.readExistingStockPreparationRows(
        getMultitableRecordsApi(),
        action.target,
        projectNo,
      )
      const diagnostics = duplicateExpandedKeyDiagnosticsForRows(
        job.artifact && Array.isArray(job.artifact.rows) ? job.artifact.rows : [],
      )
      const conflictPolicyReview = buildConflictPolicyReview({
        diagnostics,
        runOnlyReview: normalizeRunOnlyConflictPolicyReview(body.conflictPolicyReview),
        tableScopeReview: await loadTableScopeConflictPolicies({
          action,
          policyStore: context.storage,
        }),
      })
      const planned = await planLargeBomBackgroundExpansionJob({
        storage: context.storage,
        ...routeScope,
        actionId,
        jobId,
        existingRows,
        conflictPolicyReview,
      })
      return sendOk(res, largeBomJobResponse(publicBackgroundExpansionJob(planned)))
    },

    async tableActionLargeBomApplyJobStart(req, res) {
      const user = requireAccess(req, 'write')
      const body = normalizeTableActionBody(requestBody(req), VALID_TABLE_ACTION_LARGE_BOM_APPLY_START_BODY_KEYS)
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const jobId = firstString(requestParams(req).jobId)
      const routeScope = largeBomJobScope(req, { actionId })
      assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      const confirm = isPlainObject(body.confirm) ? body.confirm : {}
      const job = await createLargeBomCheckpointApplyJob({
        storage: context.storage,
        ...routeScope,
        actionId,
        jobId,
        principal: requestPrincipal(req),
        permission: applyPermissionForUser(user),
        acceptManualConfirmHold: confirm.acceptManualConfirmHold === true,
      })
      return sendOk(res, largeBomJobResponse(publicCheckpointApplyJob(job)), 202)
    },

    async tableActionLargeBomApplyJobGet(req, res) {
      requireAccess(req, 'read')
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const jobId = firstString(requestParams(req).jobId)
      const routeScope = largeBomJobScope(req, { actionId })
      assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      const job = await loadLargeBomCheckpointApplyJob({
        storage: context.storage,
        ...routeScope,
        actionId,
        applyJobId: firstString(requestParams(req).applyJobId),
      })
      assertApplyJobMatchesExpansion(job, jobId)
      return sendOk(res, largeBomJobResponse(publicCheckpointApplyJob(job)))
    },

    async tableActionLargeBomApplyJobRun(req, res) {
      requireAccess(req, 'write')
      normalizeTableActionBody(requestBody(req), VALID_EMPTY_REQUEST_KEYS)
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const jobId = firstString(requestParams(req).jobId)
      const routeScope = largeBomJobScope(req, { actionId })
      assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      const pendingJob = await loadLargeBomCheckpointApplyJob({
        storage: context.storage,
        ...routeScope,
        actionId,
        applyJobId: firstString(requestParams(req).applyJobId),
      })
      assertApplyJobMatchesExpansion(pendingJob, jobId)
      // FOS-4b-3-prod P2: the large-BOM checkpoint apply funnels through here. Shared apply gate before any
      // write — no production policy → sandbox gate (canonical rejected, fail-closed); a configured
      // production policy may authorize the canonical (large route) per the controlled exception.
      const applyGate = assertStockPrepApplyAllowed(pendingJob.target, {
        sandboxPolicy: resolveStockPrepApplySandboxPolicy(context.config),
        productionPolicy: resolveStockPrepApplyProductionPolicy(context.config),
        now: Date.now(),
        route: 'large',
        actionId,
      })
      // FOS-4b-3-prod P2: post-plan production bound. The plan's clean (add/update) row count is fixed across
      // chunked runs, so checking it on each chunk consistently rejects an over-bound run before any write.
      const planDecisions = (pendingJob && pendingJob.plan && Array.isArray(pendingJob.plan.decisions)) ? pendingJob.plan.decisions : []
      const largeBomCleanRowCount = planDecisions.filter((d) => d && (d.decision === 'add' || d.decision === 'update')).length
      assertProductionCleanRowsWithinBound(applyGate, largeBomCleanRowCount)
      // C4 large-BOM apply: same pre-mapped contract as the small route — the apply writer maps payload
      // keys through the operator-configured target.fieldIdMap, so the scoped API must not remap (#4160).
      const scopedRecordsApi = await createTargetScopedRecordsApi(getMultitableRecordsApi(), pendingJob.target, { fieldIdTranslation: 'pre_mapped' })
      const job = await runLargeBomCheckpointApplyJobChunk({
        storage: context.storage,
        ...routeScope,
        actionId,
        applyJobId: pendingJob.jobId,
        recordsApi: scopedRecordsApi,
      })
      return sendOk(res, largeBomJobResponse(publicCheckpointApplyJob(job)))
    },

    async tableActionLargeBomExpansionJobCancel(req, res) {
      requireAccess(req, 'write')
      normalizeTableActionBody(requestBody(req), VALID_EMPTY_REQUEST_KEYS)
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      const routeScope = largeBomJobScope(req, { actionId })
      const job = await cancelLargeBomBackgroundExpansionJob({
        storage: context.storage,
        ...routeScope,
        actionId,
        jobId: firstString(requestParams(req).jobId),
        principal: requestPrincipal(req),
      })
      return sendOk(res, largeBomJobResponse(publicBackgroundExpansionJob(job)))
    },

    async tableActionConflictPoliciesList(req, res) {
      requireAccess(req, 'read')
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const action = assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      return sendOk(res, await loadTableScopeConflictPolicies({
        action,
        policyStore: context.storage,
      }))
    },

    async tableActionConflictPoliciesSave(req, res) {
      requireAccess(req, 'admin')
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const action = assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      return sendOk(res, await saveTableScopeConflictPolicies({
        action,
        policyStore: context.storage,
        request: requestBody(req),
        approver: requestPrincipal(req),
      }))
    },

    async tableActionConflictPoliciesDelete(req, res) {
      requireAccess(req, 'admin')
      const actionId = firstString(requestParams(req).actionId) || PLM_STOCK_PREPARATION_ACTION_ID
      const action = assertStockPreparationTargetReady(await tableActions.getTableAction(scopedInput(req, { actionId })))
      return sendOk(res, await deleteTableScopeConflictPolicies({
        action,
        policyStore: context.storage,
        request: requestBody(req),
      }))
    },

    // DEPLOYMENT PREFLIGHT — the one call that replaces four readiness polls plus the tribal
    // knowledge none of them carried.
    //
    // Two real incidents on the first customer deployment are the reason it exists: an operator
    // inventing a sandbox objectId and being refused without being told the namespace, and two
    // people configuring the same instance in parallel onto DIFFERENT sandbox objectIds so the
    // installed pack declared one target while the table that existed carried another. The second
    // is why the declared-target check reads `targetObjectId` off the pack and quotes it in the fix.
    //
    // READ TIER, on purpose. The response is values-free evidence and fix INSTRUCTIONS; running any
    // of them still needs the admin gate the ensure/install routes already carry. Handing the
    // diagnosis to the operator who has to act on it is the whole deliverable.
    //
    // ZERO WRITES: every check delegates to an inspection function (findObjectSheet /
    // resolveFieldIds) or reads server config. Nothing here ensures, installs or provisions.
    async stockPreparationPreflight(req, res) {
      requireAccess(req, STOCK_PREP_READ)
      const input = normalizeStockPreparationConfirmBody(
        requestQuery(req),
        VALID_STOCK_PREPARATION_PREFLIGHT_QUERY_KEYS,
        'STOCK_PREPARATION_PREFLIGHT_REQUEST_INVALID',
      )
      const tenantId = resolveTenantId(req, input)
      return sendOk(res, await computeStockPreparationPreflight({
        context,
        projectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        // The SAME server-held objects the pack/refresh routes were handed at registration, so what
        // the preflight reports and what those routes actually do cannot drift.
        packCatalog: customerPackCatalog,
        extFieldMapping: stockPreparationExtFieldMapping,
        config: context && context.config,
        b2aTrialRegistry,
        // The SAME registry the carry/apply/dry-run routes resolve their bound target through, so
        // the binding this reports on and the binding those routes actually write through are one
        // object, not two readings of a config file.
        tableActions,
        tenantId,
        actionId: PLM_STOCK_PREPARATION_ACTION_ID,
        env: process.env,
      }))
    },

    // 源就绪预检 + 拓扑自测 — SOURCE PREFLIGHT.
    //
    // The deployment preflight above and this one are the two halves of "can we run": that one
    // inspects OUR managed tables, packs and env allowlists; this one MEASURES the customer's source.
    // It exists because the first live customer session lost a day to two failures nothing detected:
    // a read plan that ASSUMED the order-module bridge against a catalog whose real BOM lived
    // elsewhere (so the expansion returned zero rows and reported success), and a test catalog with
    // no business rows in it at all that nobody noticed for many steps.
    //
    // WHAT THIS HANDLER DOES, AND DELIBERATELY DOES NOT DO. It resolves two server-held things — the
    // configured read plan and a registered external system — hands the probe ONE capability
    // (`adapter.read`, the same seam the BOM expansion itself reads through), and returns what the
    // probe measured. It builds no SQL, opens no second connection path, persists nothing, and holds
    // nothing it could write with. The `externalSystemId` query key SELECTS a registered row inside
    // the caller's own tenant scope; it is never a connection, and the row's credentials are resolved
    // server-side by the same `getExternalSystemForAdapter` every other route uses.
    //
    // The read plan is taken from the CONFIGURED table action when there is one, because the whole
    // point of check 7 is to compare the source against what this deployment will actually run. An
    // unconfigured deployment falls back to the shipped default plan and still gets a useful answer —
    // reachability, data presence and detected shape do not depend on the comparison.
    async stockPreparationSourcePreflight(req, res) {
      requireAccess(req, 'read')
      const input = normalizeStockPreparationConfirmBody(
        requestQuery(req),
        VALID_STOCK_PREPARATION_SOURCE_PREFLIGHT_QUERY_KEYS,
        'STOCK_PREPARATION_SOURCE_PREFLIGHT_REQUEST_INVALID',
      )

      // Server config, never a request input. An unconfigured deployment throws here — that is the
      // "not plugged in yet" state, and it must degrade to the default plan rather than 5xx the whole
      // check, exactly as the hub overview treats the same throw.
      let action = null
      try {
        action = await tableActions.getTableAction({ actionId: PLM_STOCK_PREPARATION_ACTION_ID })
      } catch {
        action = null
      }
      const configuredSystemId = action && action.source ? firstString(action.source.externalSystemId) : undefined
      const externalSystemId = firstString(input.externalSystemId) || configuredSystemId
      if (!externalSystemId) {
        throw new HttpRouteError(
          409,
          'SOURCE_PREFLIGHT_NO_SOURCE',
          'no data source to check: name one with externalSystemId, or configure the stock-preparation table action',
        )
      }

      // Closed vocabulary, refused AT THE EDGE rather than quietly ignored downstream: an operator who
      // mistypes the bridge must be told, not handed a report that silently measured instead.
      // `firstString` yields null for an absent OR blank key, so "not supplied" and "supplied as
      // whitespace" collapse here — both mean no declaration, and neither is an error.
      const declaredBridge = firstString(input.declaredBridge)
      const declarationSupplied = Object.prototype.hasOwnProperty.call(input, 'declaredBridge')
      if (declarationSupplied && !DECLARABLE_BRIDGES.includes(declaredBridge)) {
        throw new HttpRouteError(
          400,
          'STOCK_PREPARATION_SOURCE_PREFLIGHT_REQUEST_INVALID',
          'declaredBridge must name one of the two bridge candidates',
          { field: 'declaredBridge', allowed: [...DECLARABLE_BRIDGES] },
        )
      }

      const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
        ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
        : externalSystems.getExternalSystem.bind(externalSystems)
      const system = await loadSystem(scopedAdapterInput(req, { id: externalSystemId }))
      const adapter = adapterRegistry.createAdapter(system, { principal: requestPrincipal(req) })
      if (!adapter || typeof adapter.read !== 'function') {
        throw new HttpRouteError(422, 'SOURCE_PREFLIGHT_KIND_UNSUPPORTED', 'this data source kind cannot be read', {
          externalSystemId,
        })
      }

      try {
        return sendOk(res, await runStockPreparationSourcePreflight({
          // The ONE capability the probe is handed. Bounded per call by the probe's own constant.
          readObject: (request) => adapter.read(request),
          readPlan: action && action.source ? action.source.readPlan : undefined,
          externalSystemId,
          declaredBridge,
        }))
      } catch (error) {
        if (error instanceof SourcePreflightError) {
          // Coarse and values-free. `error.details` on the values-free self-check carries a path, a
          // length and a mask by construction — never the value that tripped it — but the refusal is
          // still reported as a REASON CODE only, so a future detail field cannot become an exfil
          // channel just by existing.
          throw new HttpRouteError(500, 'SOURCE_PREFLIGHT_FAILED', 'source preflight could not complete', {
            reason: error.message,
          })
        }
        throw error
      }
    },

    async stockPreparationTargetReadiness(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationTargetInput(req, requestQuery(req))
      const result = await inspectStockPreparationCanonicalTarget({
        context,
        projectId: input.projectId,
        permission: 'admin',
      })
      return sendOk(res, publicStockPreparationTargetResult(result))
    },

    async stockPreparationTargetEnsure(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationTargetWriteInput(req, requestBody(req))
      const result = await ensureStockPreparationCanonicalTarget({
        context,
        projectId: input.projectId,
        baseId: input.baseId,
        permission: 'admin',
      })
      return sendOk(res, publicStockPreparationTargetResult(result), result.mode === 'canonical_create' ? 201 : 200)
    },

    async stockPreparationSandboxTargetReadiness(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationSandboxTargetInput(req, requestQuery(req))
      try {
        const result = await inspectStockPreparationSandboxTarget({
          context,
          projectId: input.projectId,
          objectId: input.objectId,
          label: input.label,
          permission: 'admin',
        })
        return sendOk(res, publicStockPreparationSandboxTargetResult(result))
      } catch (error) {
        throw sandboxTargetRouteError(error)
      }
    },

    async stockPreparationSandboxTargetEnsure(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationSandboxTargetWriteInput(req, requestBody(req))
      try {
        // Ordering rationale: validate (alias + sandbox objectId + option key/source) catches bad inputs
        // BEFORE ensure, so no provisioning happens on bad input. A sync failure AFTER ensure leaves a
        // structure-only sandbox target, which is acceptable: this is sandbox-only and ensure+sync is
        // idempotent on retry.
        validateStockPreparationSandboxOptionSeedInput(input)
        const result = await ensureStockPreparationSandboxTarget({
          context,
          projectId: input.projectId,
          baseId: input.baseId,
          objectId: input.objectId,
          label: input.label,
          permission: 'admin',
        })
        const optionSync = await syncStockPreparationSandboxOptions({
          context,
          projectId: input.projectId,
          objectId: input.objectId,
          label: input.label,
          permission: 'admin',
          optionSets: input.optionSets,
        })
        result.optionSync = {
          ok: optionSync.ok === true,
          target: optionSync.target,
          evidence: optionSync.evidence,
        }
        return sendOk(res, publicStockPreparationSandboxTargetResult(result), result.mode === 'sandbox_create' ? 201 : 200)
      } catch (error) {
        throw sandboxTargetRouteError(error)
      }
    },

    async stockPreparationOptionsSync(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationOptionSyncInput(req, requestBody(req))
      const result = await syncStockPreparationOptions({
        context,
        projectId: input.projectId,
        permission: 'admin',
        optionSets: input.optionSets,
      })
      return sendOk(res, result)
    },

    // ---------------------------------------------------------------------------------------
    // CUSTOMER PACK — the executable surface. Four routes, one authorization posture:
    //   admin gate (requireAccess 'admin', mirroring plugin-after-sales' hasInstallAdminAccess)
    // + SERVER-HELD pack allowlist (mirroring ALLOWED_TEMPLATE_IDS; the pack is never in the body).
    // The tenant project is auth-derived (resolveAuthUserTenantId -> staging project id), so a
    // request cannot steer the install at another tenant's sheet.
    // ---------------------------------------------------------------------------------------

    // What this server is allowed to install. Values-free evidence summaries (ids, types, ownership
    // tokens, counts) — never an option value or a label.
    async stockPreparationCustomerPackList(req, res) {
      requireAccess(req, 'admin')
      return sendOk(res, {
        packCount: customerPackCatalog.size,
        packs: customerPackCatalog.list(),
      })
    },

    // The ledger read. Answers "what is installed on this sheet, by which pack, in which band".
    async stockPreparationCustomerPackInstallList(req, res) {
      requireAccess(req, 'admin')
      const store = requireStockPreparationPackInstalls()
      const query = requestQuery(req)
      const tenantId = resolveTenantId(req, {})
      const projectId = resolveIntegrationStagingProjectId(tenantId, undefined)
      const objectId = firstString(query.objectId) || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
      const result = await store.listInstalls({
        tenantId,
        projectId,
        objectId,
        limit: asListLimit(query.limit),
      })
      return sendOk(res, {
        projectId,
        objectId,
        rowCount: result.rowCount,
        // Explicit projection rather than the raw row: it keeps a future ledger column from
        // reaching a response by accident, and everything here is an id, a token or a count.
        installs: result.entries.map((entry) => ({
          packId: entry.packId,
          packVersion: entry.packVersion,
          mode: entry.mode,
          status: entry.status,
          installedFields: entry.installedFields,
          fieldCount: Array.isArray(entry.installedFields) ? entry.installedFields.length : 0,
          summary: entry.summary,
          warnings: entry.warnings,
          lastInstallAt: entry.lastInstallAt,
        })),
      })
    },

    // DRY RUN — ZERO writes. It reuses the installer's own read-only pre-scan, so "what it reports"
    // and "what install does" cannot drift. It reports ownership conflicts instead of throwing on
    // them, because reviewing the conflict before it lands is the point (rehearsal report F5).
    async stockPreparationCustomerPackDryRun(req, res) {
      requireAccess(req, 'admin')
      normalizeCustomerPackBody(requestBody(req))
      const pack = customerPackCatalog.get(firstString(requestParams(req).packId))
      const tenantId = resolveAuthUserTenantId(req)
      const projectId = resolveIntegrationStagingProjectId(tenantId, undefined)
      const plan = await planCustomerPackInstall({
        provisioning: getCustomerPackProvisioning(),
        projectId,
        pack,
        // The SAME capability the install below is given. Without it a dry-run could say nothing at
        // all about the permission rows an install would write — the one step with no undo would be
        // the one step with no rehearsal. The port is used READ-ONLY here (the census + the role
        // pre-flight question); planCustomerPackInstall never reaches its write half.
        fieldPermissions: stockPreparationFieldPermissions,
      })
      return sendOk(res, { projectId, ...plan })
    },

    // INSTALL — additive only (the installer never calls ensureObject) and idempotent. The ledger is
    // REQUIRED here: an install nobody can enumerate afterwards is the gap this line closes.
    async stockPreparationCustomerPackInstall(req, res) {
      requireAccess(req, 'admin')
      const body = normalizeCustomerPackBody(requestBody(req), VALID_CUSTOMER_PACK_INSTALL_BODY_KEYS)
      const pack = customerPackCatalog.get(firstString(requestParams(req).packId))
      const store = requireStockPreparationPackInstalls()
      // Auth-derived, never request-supplied: a request tenantId/projectId would be a steering
      // vector on a WRITE route (same discipline as the target-ensure route above).
      const tenantId = resolveAuthUserTenantId(req)
      const projectId = resolveIntegrationStagingProjectId(tenantId, undefined)
      const result = await installCustomerPack({
        provisioning: getCustomerPackProvisioning(),
        projectId,
        pack,
        logger: routeLogger || undefined,
        packInstallStore: store,
        tenantId,
        workspaceId: resolveWorkspaceId(req, {}),
        mode: body.mode === 'reinstall' ? 'reinstall' : 'install',
        fieldPermissions: stockPreparationFieldPermissions,
      })
      const created = Array.isArray(result.createdFields) ? result.createdFields.length : 0
      return sendOk(res, { projectId, ...result }, created > 0 ? 201 : 200)
    },

    // #3751 MVP: readiness of the 9 frozen MVP tables (or the objectIds subset). Admin-gated;
    // metadata-only inspection; values-free evidence. Delegates to the MVP provisioning module.
    async stockPreparationMvpReadiness(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationMvpTargetInput(req, requestQuery(req))
      const result = await inspectStockPreparationMvpTargets({
        context,
        projectId: input.projectId,
        permission: 'admin',
        objectIds: input.objectIds,
      })
      return sendOk(res, result)
    },

    // #3751 MVP: ensure (create) the MVP tables as MetaSheet-internal structure-only tables
    // (rows always []). No external/PLM/K3 write. 201 when any table was created, else 200.
    async stockPreparationMvpEnsure(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationMvpTargetWriteInput(req, requestBody(req))
      const result = await ensureStockPreparationMvpTargets({
        context,
        projectId: input.projectId,
        baseId: input.baseId,
        permission: 'admin',
        objectIds: input.objectIds,
      })
      const created = result.tables.some((table) => table.created)
      return sendOk(res, result, created ? 201 : 200)
    },

    // #3751 MVP: sync caller-supplied option sets onto the MVP tables' select fields (field
    // metadata only). Values-free evidence; a table with no option fields is a no-op.
    async stockPreparationMvpOptionsSync(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationMvpOptionSyncInput(req, requestBody(req))
      const result = await syncStockPreparationMvpOptions({
        context,
        projectId: input.projectId,
        permission: 'admin',
        objectIds: input.objectIds,
        optionSets: input.optionSets,
      })
      return sendOk(res, result)
    },

    // #3751 MVP: readonly BOM-snapshot sync-RUN PLAN. Admin-gated; composes the landed mapper + diff
    // engines into a values-free plan (batch + lines + run + diff + flags) from an already-produced
    // expansion result + optional prior batch. Persists NOTHING and touches NO records / write API —
    // structurally read-only. Returns 200 with the computed plan + values-free evidence.
    async stockPreparationMvpSyncPlan(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationMvpSyncPlanInput(requestBody(req))
      const result = planBomSnapshotSyncRun({
        permission: 'admin',
        projectId: input.projectId,
        syncRunId: input.syncRunId,
        snapshotBatchId: input.snapshotBatchId,
        snapshotVersion: input.snapshotVersion,
        sourceSystem: input.sourceSystem,
        expansionResult: input.expansionResult,
        previousSnapshotBatchId: input.previousSnapshotBatchId,
        previousLines: input.previousLines,
        readPlan: input.readPlan,
        defaultDesignUnit: input.defaultDesignUnit,
      })
      return sendOk(res, result)
    },

    // #3751 MVP: COMMIT a previewed BOM-snapshot sync-run PLAN — the FIRST slice that writes business
    // rows. Admin-gated; recomputes the SAME deterministic plan the admin previewed with /plan, then
    // persists the batch + line + run rows into the internal MVP tables through a TARGET-SCOPED records
    // API (createTargetScopedRecordsApi) bound to each resolved MVP sheet, so a write can never leave an
    // MVP sheet. Idempotent (an existing snapshotBatchId skips the whole commit) + immutable (createRecord
    // only; old snapshots are never overwritten). Values-free evidence. 201 when it actually created,
    // else 200 (skipped an already-persisted batch).
    async stockPreparationMvpSyncPersist(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationMvpSyncPersistInput(requestBody(req))
      // The MVP tables were provisioned under the INTERNAL staging project (the same derivation the
      // readiness/ensure routes use); the business `projectId` stays on the plan rows. Derive the staging
      // targetProjectId server-side from the auth tenant — never from the request body.
      const tenantId = resolveAuthUserTenantId(req)
      const targetProjectId = resolveIntegrationStagingProjectId(tenantId, undefined)
      const result = await persistStockPreparationSyncRun({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId,
        lockTenantId: tenantId,
        projectId: input.projectId,
        syncRunId: input.syncRunId,
        snapshotBatchId: input.snapshotBatchId,
        snapshotVersion: input.snapshotVersion,
        sourceSystem: input.sourceSystem,
        sourceProjectNo: input.sourceProjectNo,
        projectName: input.projectName,
        expansionResult: input.expansionResult,
        previousSnapshotBatchId: input.previousSnapshotBatchId,
        previousLines: input.previousLines,
        readPlan: input.readPlan,
        defaultDesignUnit: input.defaultDesignUnit,
      })
      return sendOk(res, result, result.persisted ? 201 : 200)
    },

    // #3889: execute an approved PLM readonly config and feed its mapped rows through the existing
    // pure intake contract. Dry-run/read only by default: no business-row write and no raw/value-
    // bearing result. T3b-1c: with MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED the SAME request
    // feeds the server-side intake through the pure bridge into the existing sync-run persist —
    // the business rows still never cross HTTP.
    async stockPreparationPlmBomSourceRun(req, res) {
      const user = requireAccess(req, 'admin')
      // T3b OD-2: with auto-persist ON the read gains a write side-effect, so tenant steering (and the
      // ambiguous query/params projectId carriers) are rejected with the DEDICATED code BEFORE the body
      // allowlist AND any I/O. The BODY projectId stays allowed — it is the required business project
      // key on the written rows, never a physical-target selector. Flag OFF never engages the guard.
      const autoPersistEnabled = stockPreparationPlmAutoPersistEnabled()
      if (autoPersistEnabled) assertStockPreparationPlmAutoPersistNoSteering(req)
      const input = normalizeStockPreparationSourceRunBody(
        requestBody(req),
        VALID_STOCK_PREPARATION_PLM_SOURCE_RUN_REQUEST_KEYS,
        'STOCK_PREPARATION_PLM_SOURCE_RUN_REQUEST_INVALID',
      )
      // OD-2: ON derives the tenant from the AUTHENTICATED principal only (resolveTenantId would honor
      // a request tenantId for admins); OFF keeps today's read-only resolution byte-for-byte.
      const tenantId = autoPersistEnabled ? resolveAuthUserTenantId(req) : resolveTenantId(req, input)
      const sourceRuntime = await loadStockPreparationReadonlySource(
        req,
        { ...input, tenantId },
        'STOCK_PREPARATION_PLM_SOURCE_RUN_REQUEST_INVALID',
      )
      // T3b OD-3 amendment (owner P2): the value-level status vocabulary cannot catch a COMBINED
      // mapping bypass (a config that maps some column onto the internal `missingChildBom` marker
      // while also mapping an explicit lineStatus), so the approved CONFIG itself is structurally
      // guarded here — after the config-store read that produced it, but BEFORE any source-adapter
      // creation/read, provisioning, or persist I/O. Only the auto-persist path engages it: flag OFF
      // keeps the read-only route byte-for-byte, including for configs this guard would reject.
      if (autoPersistEnabled) assertPlmAutoPersistSourceConfigSafe(sourceRuntime.config)
      const actor = user.id || user.email
      const result = await runPlmBomReadonlySource({
        permission: 'admin',
        projectId: input.projectId,
        sourceProjectNo: input.sourceProjectNo,
        projectName: input.projectName,
        syncRunId: input.syncRunId,
        snapshotBatchId: input.snapshotBatchId,
        snapshotVersion: input.snapshotVersion,
        actor,
        ...sourceRuntime,
      })
      const readProjection = publicReadonlySourceRunResult(result)
      if (!autoPersistEnabled) {
        // Flag OFF: the response is BYTE-FOR-BYTE today's read-only projection — no autoPersist field.
        return sendOk(res, readProjection)
      }
      // Flag ON: bridge the server-side intake into the EXISTING sync-run persist within this request
      // (OD-3 — the pure bridge is the only intake→persist projection; no direct cast/spread). The
      // physical target derives from the auth tenant's staging project exactly like the sibling MVP
      // persist route — the body projectId rides on the rows as a business key only (OD-2).
      const targetProjectId = resolveIntegrationStagingProjectId(tenantId, undefined)
      const persistInput = buildPlmSourcePersistInput({
        request: {
          projectId: input.projectId,
          sourceProjectNo: input.sourceProjectNo,
          syncRunId: input.syncRunId,
          snapshotBatchId: input.snapshotBatchId,
          snapshotVersion: input.snapshotVersion,
        },
        intake: result.intake,
      })
      const autoPersist = await persistStockPreparationSyncRun({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId,
        lockTenantId: tenantId,
        ...persistInput,
      })
      // OD-5: created overrides the read-only projector's fixed mode:'dry_run' / internalWriteExecuted:
      // false (a real write happened — the response may never report "not written"); an exact replay is
      // an internal NOOP and must say so (never a hard-coded internal-write claim just because the flag
      // is ON). `autoPersist` is the persist's existing values-free evidence. 201 iff a row landed.
      return sendOk(res, {
        ...readProjection,
        mode: autoPersist.persisted ? 'internal_persist' : 'internal_noop',
        evidence: { ...readProjection.evidence, internalWriteExecuted: autoPersist.persisted },
        autoPersist,
      }, autoPersist.persisted ? 201 : 200)
    },

    // #3889: approved ERP/K3 readonly config -> pure material-cache intake shape summary. There is no
    // internal or external write and no K3 Save/Submit/Audit path.
    async stockPreparationErpMaterialSourceRun(req, res) {
      const user = requireAccess(req, 'admin')
      // T3a OD-2: OFF stays readonly, but the shared resolver still confines a tenant-bound principal
      // to its authenticated tenant. ON gains a write side effect and therefore uses the stricter
      // request-independent resolver even for a tenantless platform admin.
      const autoPersistEnabled = stockPreparationErpAutoPersistEnabled()
      // Reject an explicit request tenant/projectId FAIL-CLOSED BEFORE the body allowlist AND any I/O, so a
      // steering attempt always gets the DEDICATED steering code — projectId is not in the source-run
      // allowlist, so if this ran after normalize a body projectId would 400 with the generic invalid-key
      // code instead of the steering code.
      if (autoPersistEnabled) assertStockPreparationErpAutoPersistNoSteering(req)
      const input = normalizeStockPreparationSourceRunBody(
        requestBody(req),
        VALID_STOCK_PREPARATION_ERP_SOURCE_RUN_REQUEST_KEYS,
        'STOCK_PREPARATION_ERP_SOURCE_RUN_REQUEST_INVALID',
      )
      const tenantId = autoPersistEnabled ? resolveAuthUserTenantId(req) : resolveTenantId(req, input)
      const sourceRuntime = await loadStockPreparationReadonlySource(
        req,
        { ...input, tenantId },
        'STOCK_PREPARATION_ERP_SOURCE_RUN_REQUEST_INVALID',
      )
      const actor = user.id || user.email
      // An empty intake (zero mapped rows) already threw SOURCE_RUN_EMPTY (422) inside here via
      // assertIntakeReady — so past this line there is always >= 1 mapped row.
      const result = await runErpMaterialReadonlySource({
        permission: 'admin',
        syncRunId: input.syncRunId,
        actor,
        ...sourceRuntime,
      })
      const readProjection = publicReadonlySourceRunResult(result)
      if (!autoPersistEnabled) {
        // Flag OFF: the response is BYTE-FOR-BYTE today's read-only projection — no autoPersist field added.
        return sendOk(res, readProjection)
      }
      // Flag ON (OD-1): feed the source-run's INTERNAL intake.erpMaterials straight into T2's persist WITHIN
      // THIS REQUEST — the normalized business rows never cross HTTP. Boundary: internal MVP tables via T2's
      // scoped records API only; externalWrite stays false; targetProjectId from the auth tenant, no request
      // projectId (identical to the T2 route).
      const targetProjectId = resolveIntegrationStagingProjectId(tenantId, undefined)
      const autoPersist = await persistStockPreparationErpMaterialSync({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId,
        syncRunId: input.syncRunId,
        erpMaterials: result.intake.erpMaterials,
      })
      // The read-only projector fixes mode:'dry_run' + evidence.internalWriteExecuted:false — BOTH false now
      // that a real internal write happened. Override them so the response can never report "not written".
      // `autoPersist` is T2's values-free evidence (persisted/mode/created/patched/skipped/runStatus/
      // evidence.targets — counts/modes/statuses/objectIds only, no raw rows). 201 iff a row actually landed.
      return sendOk(res, {
        ...readProjection,
        mode: 'internal_persist',
        evidence: { ...readProjection.evidence, internalWriteExecuted: true },
        autoPersist,
      }, autoPersist.persisted ? 201 : 200)
    },

    // T2: COMMIT already-normalized ERP/K3 material-master rows into the internal erp_material_master
    // CACHE (upsert by the frozen template's own key field; every field is plm_system, so a re-sync
    // fully refreshes a row). NOT project-scoped — targetProjectId is the tenant-level STAGING project,
    // derived server-side exactly like every sibling MVP route (never request-sourced). Own
    // 'erp_material_sync' run record (create-if-absent / patch-status-if-changed). Internal-only,
    // admin-gated, values-free; no audit-trail requirement (this is a system cache-refresh commit, the
    // same category as /mvp/sync/persist — parity with that route, which likewise does not audit;
    // audit coverage is reserved for the human confirm/generation/resolve write family, #3890).
    async stockPreparationErpMaterialSync(req, res) {
      requireAccess(req, 'admin')
      const input = normalizeStockPreparationConfirmBody(
        requestBody(req),
        VALID_STOCK_PREPARATION_ERP_MATERIAL_SYNC_REQUEST_KEYS,
        'STOCK_PREPARATION_ERP_MATERIAL_SYNC_REQUEST_INVALID',
      )
      // Tenant is derived from the AUTHENTICATED user only (not resolveTenantId, which would honor a
      // request tenantId for admins) — the write cannot be steered to another tenant's staging project.
      const tenantId = resolveAuthUserTenantId(req)
      const targetProjectId = resolveIntegrationStagingProjectId(tenantId, undefined)
      const result = await persistStockPreparationErpMaterialSync({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId,
        syncRunId: input.syncRunId,
        erpMaterials: input.erpMaterials,
      })
      return sendOk(res, result, result.persisted ? 201 : 200)
    },

    // #4163 T1: values-free project LIST — backs FE view 1 (project workspace / selector), the
    // deep-link entry point into views 2-6. read-gated (broader than the rest of this admin-only
    // module — the project selector is meant for any integration:read/write/admin caller to light up
    // the in-UI chain, not just admins). queryRecords-only; projectName / sourceProjectNo NEVER cross
    // (OWNER-GATED OD-W3-1, not opened by this slice).
    async stockPreparationProjectList(req, res) {
      requireAccess(req, 'read')
      const input = stockPreparationProjectListInput(req, requestQuery(req))
      const provisioning = context && context.api && context.api.multitable
        ? context.api.multitable.provisioning
        : undefined
      if (!provisioning) {
        throw new HttpRouteError(501, 'PROJECT_READS_PROVISIONING_API_UNAVAILABLE', 'multitable provisioning API is not available')
      }
      const result = await listStockPreparationProjects({
        recordsApi: getMultitableRecordsApi(),
        provisioning,
        targetProjectId: input.targetProjectId,
        permission: 'read',
      })
      return sendOk(res, result)
    },

    // #3751 MVP view 2: readonly LIST of the immutable BOM snapshot batches for a business project.
    // Admin-gated; queryRecords-only (never a write); values-free. Uses the TWO-project split:
    // findObjectSheet under the STAGING targetProjectId, row filter by the business projectId.
    async stockPreparationSnapshotBatchList(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationSnapshotBatchListInput(req, requestQuery(req))
      const provisioning = context && context.api && context.api.multitable
        ? context.api.multitable.provisioning
        : undefined
      if (!provisioning) {
        throw new HttpRouteError(501, 'SNAPSHOT_READS_PROVISIONING_API_UNAVAILABLE', 'multitable provisioning API is not available')
      }
      const result = await listSnapshotBatches({
        recordsApi: getMultitableRecordsApi(),
        provisioning,
        targetProjectId: input.targetProjectId,
        businessProjectId: input.businessProjectId,
        permission: 'admin',
      })
      return sendOk(res, result)
    },

    // #3751 MVP view 2: readonly values-free DIFF of a snapshot batch vs its immutable predecessor.
    // Admin-gated; queryRecords-only; the batch id comes from the PATH. Predecessor + business project
    // are derived from the batch row; sheets located under the STAGING targetProjectId.
    async stockPreparationSnapshotDiff(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationSnapshotDiffInput(req, requestQuery(req))
      const provisioning = context && context.api && context.api.multitable
        ? context.api.multitable.provisioning
        : undefined
      if (!provisioning) {
        throw new HttpRouteError(501, 'SNAPSHOT_READS_PROVISIONING_API_UNAVAILABLE', 'multitable provisioning API is not available')
      }
      const result = await getSnapshotDiff({
        recordsApi: getMultitableRecordsApi(),
        provisioning,
        targetProjectId: input.targetProjectId,
        businessProjectId: input.businessProjectId,
        snapshotBatchId: input.snapshotBatchId,
        baseSnapshotBatchId: input.baseSnapshotBatchId,
        permission: 'admin',
      })
      return sendOk(res, result)
    },

    // #3751 MVP W3: values-free PER-ROW diff browse (view 2 rows: diffType / changeTypes /
    // reviewStatus per row). Same read flow + base semantics as the counts diff; closed 11-key
    // projection; optional enum filters; capped fail-closed.
    async stockPreparationSnapshotDiffRows(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationSnapshotDiffRowsInput(req, requestQuery(req))
      const provisioning = context && context.api && context.api.multitable
        ? context.api.multitable.provisioning
        : undefined
      if (!provisioning) {
        throw new HttpRouteError(501, 'SNAPSHOT_READS_PROVISIONING_API_UNAVAILABLE', 'multitable provisioning API is not available')
      }
      const result = await listSnapshotDiffRows({
        recordsApi: getMultitableRecordsApi(),
        provisioning,
        targetProjectId: input.targetProjectId,
        businessProjectId: input.businessProjectId,
        snapshotBatchId: input.snapshotBatchId,
        baseSnapshotBatchId: input.baseSnapshotBatchId,
        reviewStatus: input.reviewStatus,
        diffType: input.diffType,
        permission: 'admin',
      })
      return sendOk(res, result)
    },

    // #3751 MVP W3: values-free material-mapping confirmation summary (FE view 3 header).
    async stockPreparationMaterialMappingSummary(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationConfirmReadInput(req, requestQuery(req), VALID_STOCK_PREPARATION_MAPPING_SUMMARY_QUERY_KEYS, 'STOCK_PREPARATION_MAPPING_SUMMARY_REQUEST_INVALID')
      const provisioning = context && context.api && context.api.multitable
        ? context.api.multitable.provisioning
        : undefined
      if (!provisioning) {
        throw new HttpRouteError(501, 'CONFIRM_READS_PROVISIONING_API_UNAVAILABLE', 'multitable provisioning API is not available')
      }
      const result = await getMaterialMappingSummary({
        recordsApi: getMultitableRecordsApi(),
        provisioning,
        targetProjectId: input.targetProjectId,
        permission: 'admin',
      })
      return sendOk(res, result)
    },

    // #3751 MVP W3: values-free mapping review queue (handle + enums + booleans + confidence only).
    async stockPreparationMaterialMappingCandidates(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationConfirmReadInput(req, requestQuery(req), VALID_STOCK_PREPARATION_MAPPING_CANDIDATES_QUERY_KEYS, 'STOCK_PREPARATION_MAPPING_CANDIDATES_REQUEST_INVALID')
      if (input.matchStatus && !Object.values(STOCK_PREPARATION_MATCH_STATUSES).includes(input.matchStatus)) {
        throw new HttpRouteError(400, 'STOCK_PREPARATION_MAPPING_CANDIDATES_REQUEST_INVALID', 'matchStatus must be one of the match-status vocabulary', { field: 'matchStatus' })
      }
      const provisioning = context && context.api && context.api.multitable
        ? context.api.multitable.provisioning
        : undefined
      if (!provisioning) {
        throw new HttpRouteError(501, 'CONFIRM_READS_PROVISIONING_API_UNAVAILABLE', 'multitable provisioning API is not available')
      }
      const result = await listMaterialMappingCandidates({
        recordsApi: getMultitableRecordsApi(),
        provisioning,
        targetProjectId: input.targetProjectId,
        matchStatus: input.matchStatus,
        permission: 'admin',
      })
      return sendOk(res, result)
    },

    // #3751 MVP W3: values-free unit-conversion confirmation summary (FE view 4 header). The pending
    // unit-line count is COMPUTED over the latest complete batch of the business project.
    async stockPreparationUnitConversionSummary(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationConfirmReadInput(req, requestQuery(req), VALID_STOCK_PREPARATION_UNIT_SUMMARY_QUERY_KEYS, 'STOCK_PREPARATION_UNIT_SUMMARY_REQUEST_INVALID')
      const provisioning = context && context.api && context.api.multitable
        ? context.api.multitable.provisioning
        : undefined
      if (!provisioning) {
        throw new HttpRouteError(501, 'CONFIRM_READS_PROVISIONING_API_UNAVAILABLE', 'multitable provisioning API is not available')
      }
      const result = await getUnitConversionSummary({
        recordsApi: getMultitableRecordsApi(),
        provisioning,
        targetProjectId: input.targetProjectId,
        projectId: input.projectId,
        permission: 'admin',
      })
      return sendOk(res, result)
    },

    // #3751 MVP W3: COMPUTED unit-rule candidate list (values stripped — only hasCandidate crosses;
    // a candidate is confirmable via the unit-conversions/confirm fingerprint mode).
    async stockPreparationUnitConversionCandidates(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationConfirmReadInput(req, requestQuery(req), VALID_STOCK_PREPARATION_UNIT_CANDIDATES_QUERY_KEYS, 'STOCK_PREPARATION_UNIT_CANDIDATES_REQUEST_INVALID')
      const provisioning = context && context.api && context.api.multitable
        ? context.api.multitable.provisioning
        : undefined
      if (!provisioning) {
        throw new HttpRouteError(501, 'CONFIRM_READS_PROVISIONING_API_UNAVAILABLE', 'multitable provisioning API is not available')
      }
      const result = await listUnitConversionCandidates({
        recordsApi: getMultitableRecordsApi(),
        provisioning,
        targetProjectId: input.targetProjectId,
        projectId: input.projectId,
        snapshotBatchId: input.snapshotBatchId,
        permission: 'admin',
      })
      return sendOk(res, result)
    },

    // #3751 MVP W3: run the landed candidate ladder over a COMPLETE snapshot batch and CREATE-ONLY
    // persist the NEW pending mapping rows (existing ids skipped; human_preserved fields structurally
    // stripped). Admin-gated; staging targetProjectId is server-derived, never request-trusted;
    // defaultVersionPolicy is REQUIRED per request (OD2: no server default). 201 only when it created.
    async stockPreparationMaterialMappingCandidatesSync(req, res) {
      const user = requireAccess(req, 'admin')
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(requestBody(req), VALID_STOCK_PREPARATION_MAPPING_CANDIDATES_SYNC_REQUEST_KEYS, 'STOCK_PREPARATION_MAPPING_CANDIDATES_SYNC_REQUEST_INVALID')
      const tenantId = resolveAuthUserTenantId(req)
      const result = await syncMaterialMappingCandidates({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        projectId: input.projectId,
        snapshotBatchId: input.snapshotBatchId,
        defaultVersionPolicy: input.defaultVersionPolicy,
      })
      await audit.append({
        tenantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        action: 'mapping_candidates_sync',
        subjectId: result.snapshotBatchId,
        mode: result.mode,
        actor: user.id || user.email,
        detail: { created: result.created.mappings, skippedExisting: result.skipped.existing, skippedMatched: result.skipped.matched, status: result.status },
      })
      return sendOk(res, result, result.persisted ? 201 : 200)
    },

    // #3751 MVP W3: human mapping confirm — XOR body modes (mappingId = stamp an existing candidate
    // matched / mapping = create a fully operator-specified confirmed row). confirmedBy is the ROUTE
    // user identity; confirmedAt is stamped in the module — the body can carry neither.
    async stockPreparationMaterialMappingConfirm(req, res) {
      const user = requireAccess(req, 'admin')
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(requestBody(req), VALID_STOCK_PREPARATION_MAPPING_CONFIRM_REQUEST_KEYS, 'STOCK_PREPARATION_MAPPING_CONFIRM_REQUEST_INVALID')
      const tenantId = resolveAuthUserTenantId(req)
      const result = await confirmMaterialMapping({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        mappingId: input.mappingId,
        mapping: input.mapping,
        notes: input.notes,
        confirmedBy: user.id || user.email,
      })
      await audit.append({
        tenantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        action: 'mapping_confirm',
        subjectId: result.mappingId,
        mode: result.mode,
        actor: user.id || user.email,
        detail: { persisted: result.persisted },
      })
      return sendOk(res, result, result.mode === 'created' ? 201 : 200)
    },

    // #3751 MVP W3: retire a mapping (patch EXACTLY isActive:false) — the recovery path for a wrong
    // confirm. Audit-trail coverage is the Wave-5 role/audit slice.
    async stockPreparationMaterialMappingRetire(req, res) {
      const user = requireAccess(req, 'admin')
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(requestBody(req), VALID_STOCK_PREPARATION_MAPPING_RETIRE_REQUEST_KEYS, 'STOCK_PREPARATION_MAPPING_RETIRE_REQUEST_INVALID')
      const tenantId = resolveAuthUserTenantId(req)
      const result = await retireMaterialMapping({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        mappingId: input.mappingId,
      })
      await audit.append({
        tenantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        action: 'mapping_retire',
        subjectId: result.mappingId,
        mode: result.mode,
        actor: user.id || user.email,
        detail: { persisted: result.persisted },
      })
      return sendOk(res, result)
    },

    // #3751 MVP W3: human unit-rule confirm — tri-XOR body modes (conversionRuleId = stamp an existing
    // manual rule / contextFingerprint = persist the server-derived 1:1 candidate / rule = fully
    // user-entered values per OD3/OD4). Same server-stamp discipline as the mapping confirm.
    async stockPreparationUnitConversionConfirm(req, res) {
      const user = requireAccess(req, 'admin')
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(requestBody(req), VALID_STOCK_PREPARATION_UNIT_CONFIRM_REQUEST_KEYS, 'STOCK_PREPARATION_UNIT_CONFIRM_REQUEST_INVALID')
      const tenantId = resolveAuthUserTenantId(req)
      const result = await confirmUnitConversionRule({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        projectId: input.projectId,
        conversionRuleId: input.conversionRuleId,
        contextFingerprint: input.contextFingerprint,
        snapshotBatchId: input.snapshotBatchId,
        rule: input.rule,
        confirmedBy: user.id || user.email,
      })
      await audit.append({
        tenantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        action: 'unit_confirm',
        subjectId: result.conversionRuleId,
        mode: result.mode,
        actor: user.id || user.email,
        detail: { persisted: result.persisted },
      })
      return sendOk(res, result, result.mode === 'created' ? 201 : 200)
    },

    // #3751 MVP W3: retire a unit rule (patch EXACTLY isActive:false) — required before re-creating a
    // same-scope rule with a different factor (two active same-scope rules fail closed as a conflict).
    async stockPreparationUnitConversionRetire(req, res) {
      const user = requireAccess(req, 'admin')
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(requestBody(req), VALID_STOCK_PREPARATION_UNIT_RETIRE_REQUEST_KEYS, 'STOCK_PREPARATION_UNIT_RETIRE_REQUEST_INVALID')
      const tenantId = resolveAuthUserTenantId(req)
      const result = await retireUnitConversionRule({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        conversionRuleId: input.conversionRuleId,
      })
      await audit.append({
        tenantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        action: 'unit_retire',
        subjectId: result.conversionRuleId,
        mode: result.mode,
        actor: user.id || user.email,
        detail: { persisted: result.persisted },
      })
      return sendOk(res, result)
    },

    // W4b (execution-plan W4a/W4b; adjudication Layer 3): the K2 carry confirm — mirror of
    // stockPreparationMaterialMappingConfirm. The human confirms a CARRY_VIA_CONFIRM proposal;
    // the carry EXECUTOR (confirm-writes.applyCarryViaConfirm) copies the inactive predecessor's
    // human fields onto the re-keyed row IN THE BOUND TARGET TABLE (see the target resolution in
    // the handler): admin-gated, closed body allowlist (the body can carry NO stamp and NO table —
    // carriedBy is the route identity, carriedAt is module-stamped, the sheet is the bound action's),
    // no-overwrite, values-free audit. When the body names the matching carry LEDGER row
    // (decisionId + inputFingerprint, both or neither), the row is closed with the reserved
    // carry token AFTER the apply; a ledger-close refusal is reported honestly beside the
    // applied carry instead of faking either a clean success or a failed carry.
    async stockPreparationCarryConfirm(req, res) {
      const user = requireAccess(req, 'admin')
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(requestBody(req), VALID_STOCK_PREPARATION_CARRY_CONFIRM_REQUEST_KEYS, 'STOCK_PREPARATION_CARRY_CONFIRM_REQUEST_INVALID')
      const decisionId = firstString(input.decisionId)
      const inputFingerprint = firstString(input.inputFingerprint)
      if (Boolean(decisionId) !== Boolean(inputFingerprint)) {
        throw new HttpRouteError(400, 'STOCK_PREPARATION_CARRY_CONFIRM_REQUEST_INVALID', 'decisionId and inputFingerprint must be provided together', { fields: ['decisionId', 'inputFingerprint'] })
      }
      // WHOSE CARRY IS THIS — established before anything else, from the AUTHENTICATED principal.
      //
      // Deliberately NOT `resolveAuthUserTenantId`: that helper reads `user.tenantId`, which the host
      // auth middleware fills from the `x-tenant-id` REQUEST HEADER whenever the token carries no
      // tenant claim (packages/core-backend/src/auth/jwt-middleware.ts hydrateAuthenticatedUser). For
      // a write whose destination sheet is decided by the tenant string, a header-fillable tenant is
      // a steering vector. `resolveOperatorValueScope` (#5445) prefers the VERIFIED claim, refuses a
      // carried tenant that contradicts it, refuses a principal with no tenant of its own, refuses
      // any request-carried tenant that tries to steer, and makes the HOST vouch for the (principal,
      // tenant) pairing. Every refusal it raises is decided from the principal plus the request's own
      // tenant carriers, so all of them cost ZERO records and ZERO provisioning work.
      const scope = await resolveOperatorValueScope({
        user,
        authenticatedTenantId: req.authenticatedTenantId,
        explicitTenantIds: collectExplicitTenantIds(req, input),
        tenantPrincipalDirectory,
      })
      const tenantId = scope.tenantId
      const targetProjectId = resolveIntegrationStagingProjectId(tenantId, undefined)
      // WRITE THE TABLE APPLY WROTE. Resolved through the SAME seam every other stock-prep route
      // uses to reach its target — getTableAction + assertStockPreparationTargetReady — so the carry
      // cannot pick a different sheet from the writer and the export. The first cut hardcoded the
      // canonical objectId inside the executor and resolved it through provisioning, which is empty
      // on every default install: apply is sandbox-only unless an owner configured a production
      // policy, so the operator's rows are in the sandbox twin and the carry either refused or wrote
      // a table nobody reads. See stock-preparation-confirm-writes.cjs's carry header, and #5446 for
      // the same fix on the export (read) side.
      //
      // DERIVED SERVER-SIDE, exactly as the export route derives it: the actionId is the module
      // constant, the tenant comes from the authenticated principal, and the body allowlist below is
      // UNCHANGED — the client still cannot name a table, an action, or a sheet.
      //
      // Resolved BEFORE the ledger pre-flight so a deployment with no configured stock-prep action
      // refuses ahead of any host IO rather than after a read.
      const carryAction = assertStockPreparationTargetReady(
        await tableActions.getTableAction({ tenantId, actionId: PLM_STOCK_PREPARATION_ACTION_ID }),
      )
      // ...AND IT MUST BE THE SHEET OF THE CALLER'S OWN TENANT.
      //
      // The binding above answers "which sheet does this DEPLOYMENT write". It cannot answer "is that
      // sheet the caller's", because `getTableAction` is keyed by actionId ALONE — the config map is
      // deploy-global (stock-preparation-table-actions.cjs) and `applyPersistedSourceBinding`
      // overrides only `externalSystemId`, never `target`. So the binding on its own hands EVERY
      // tenant the same sheet. Before this check a foreign-tenant admin's carry returned 200 and
      // patched it, where the earlier canonical-objectId version had refused precisely because it
      // resolved the sheet under the CALLER's staging project.
      //
      // This restores that wall without giving the executor a way to resolve a sheet of its own: the
      // bound sheet must be the one provisioning holds for the caller's `${tenantId}:integration-core`
      // project under the target's own objectId. That is exactly how a correctly-derived binding is
      // produced — scripts/ops/stock-preparation-derive-target-binding.mjs computes
      // sheet_ + sha1(`${tenantId}:integration-core:${objectId}`), canonical and sandbox twin alike —
      // so a sanctioned config passes and a config pointing anywhere else is refused rather than
      // written to. One provisioning read, no records IO, and it runs BEFORE the ledger pre-flight so
      // approval bookkeeping in the caller's project is never consulted for a write into another
      // tenant's sheet.
      await assertCarryTargetBelongsToTenant({
        // The RAW host surface, not `getMultitableProvisioning()`: that helper throws its own generic
        // 503 when provisioning is absent or lacks `findObjectSheet`, which would mask this check's
        // own typed 501 about the ownership port it actually needs.
        provisioning: context && context.api && context.api.multitable && context.api.multitable.provisioning,
        targetProjectId,
        target: carryAction.target,
      })
      // PRE-FLIGHT BIND, BEFORE the carry write (the P1 fix). `decision`, `decisionId` and
      // `inputFingerprint` arrive as three independent client fields; until they are proven to be
      // ONE approved pair, nothing may be written. Refusing only at the ledger close would leave the
      // carried row written with no approval record — the same defect wearing a different mask.
      if (decisionId) {
        await assertCarryConfirmDecisionBinding({
          recordsApi: getMultitableRecordsApi(),
          provisioning: getMultitableProvisioning(),
          targetProjectId,
          permission: 'admin',
          decisionId,
          inputFingerprint,
          decision: input.decision,
        })
      }
      // No provisioning and no targetProjectId: the executor has no way to resolve a sheet of its
      // own, and the bound target is the only thing that tells it where to write.
      const result = await applyCarryViaConfirm({
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        target: carryAction.target,
        decision: input.decision,
        // The SAME principal handle the scope was resolved under, so the row stamp, the audit actor
        // and the tenant wall all name one identity rather than three independently-derived ones.
        confirmedBy: scope.actorId,
      })
      // Ledger close, AFTER the apply: the carry is the substantive act; the ledger row is its
      // bookkeeping. A typed ledger refusal (e.g. the row was superseded by a newer reconcile)
      // travels beside the applied result as a closed code — never silently swallowed, never
      // allowed to misreport the carry itself as failed.
      const CARRY_APPLIED_MODES = ['carried', 'skipped_already_carried']
      let ledger
      if (decisionId) {
        if (!CARRY_APPLIED_MODES.includes(result.mode)) {
          // Defence in depth: only an actually-applied (or already-applied) carry may close a hold.
          // The executor throws on every other path today, so this is unreachable — which is the
          // point: if a future mode is added, it closes nothing until someone decides it should.
          ledger = { ok: false, code: 'CARRY_NOT_APPLIED' }
        } else {
          try {
            ledger = await confirmCarryConfirmationDecision({
              recordsApi: getMultitableRecordsApi(),
              provisioning: getMultitableProvisioning(),
              targetProjectId,
              permission: 'admin',
              decisionId,
              inputFingerprint,
              // The bind is re-asserted inside the close, over the SAME decision that was applied.
              decision: input.decision,
              confirmedBy: user.id || user.email,
            })
          } catch (error) {
            if (!(error instanceof StockPreparationConfirmationDecisionError)) throw error
            ledger = { ok: false, code: error.code }
          }
        }
      }
      // The audit vocabulary is migration-frozen; a carry confirm resolves a planner exception, so
      // it rides exception_resolve with a fixed operation subtype — the same precedent the
      // confirmation-decision confirm route set. Values-free: counts, mode tokens, booleans.
      await audit.append({
        tenantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        action: 'exception_resolve',
        subjectId: decisionId || undefined,
        mode: result.mode,
        actor: user.id || user.email,
        detail: {
          operation: 'stock_preparation_carry_confirm',
          persisted: result.persisted,
          carriedFieldCount: result.carriedFields.length,
          alreadyCarriedFieldCount: result.alreadyCarriedFields.length,
          ...(ledger ? { ledgerConfirmed: ledger.ok === true } : {}),
        },
      })
      return sendOk(res, { ...result, ...(ledger ? { ledger } : {}) })
    },

    // #3751 MVP W4: generation run — engine over confirmed inputs; draft prep lines UPSERT; blocking
    // exceptions create-only (human resolution preserved); run record create-only. `ready` is the
    // server-computed invariant verdict (engine ready AND zero unresolved blocking exceptions).
    async stockPreparationGenerationRun(req, res) {
      const user = requireAccess(req, 'admin')
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(requestBody(req), VALID_STOCK_PREPARATION_GENERATION_RUN_REQUEST_KEYS, 'STOCK_PREPARATION_GENERATION_RUN_REQUEST_INVALID')
      const tenantId = resolveAuthUserTenantId(req)
      const result = await runStockPreparationGeneration({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        projectId: input.projectId,
        snapshotBatchId: input.snapshotBatchId,
      })
      await audit.append({
        tenantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        action: 'generation_run',
        subjectId: result.snapshotBatchId,
        mode: result.mode,
        actor: user.id || user.email,
        detail: {
          status: result.status,
          ready: result.ready,
          unresolvedBlocking: result.unresolvedBlockingExceptionCount,
          linesCreated: result.created.lines,
          linesPatched: result.patched.lines,
          exceptionsCreated: result.created.exceptions,
        },
      })
      return sendOk(res, result, result.created && (result.created.lines + result.created.exceptions + result.created.run) > 0 ? 201 : 200)
    },

    // #3751 MVP W4: single exception resolve — patch EXACTLY the resolution quartet, server-stamped.
    async stockPreparationExceptionResolve(req, res) {
      const user = requireAccess(req, 'admin')
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(requestBody(req), VALID_STOCK_PREPARATION_EXCEPTION_RESOLVE_REQUEST_KEYS, 'STOCK_PREPARATION_EXCEPTION_RESOLVE_REQUEST_INVALID')
      const tenantId = resolveAuthUserTenantId(req)
      const result = await resolveStockPreparationException({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        exceptionId: input.exceptionId,
        resolutionAction: input.resolutionAction,
        resolvedBy: user.id || user.email,
      })
      await audit.append({
        tenantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        action: 'exception_resolve',
        subjectId: result.exceptionId,
        mode: result.mode,
        actor: user.id || user.email,
        detail: { resolutionAction: input.resolutionAction, persisted: result.persisted },
      })
      return sendOk(res, result)
    },

    // #3751 MVP W4: bulk exception resolve — SAME-REASON gate (#3890) refuses mixed exceptionTypes
    // before any patch; bounded id list.
    async stockPreparationExceptionBulkResolve(req, res) {
      const user = requireAccess(req, 'admin')
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(requestBody(req), VALID_STOCK_PREPARATION_EXCEPTION_BULK_RESOLVE_REQUEST_KEYS, 'STOCK_PREPARATION_EXCEPTION_BULK_RESOLVE_REQUEST_INVALID')
      const tenantId = resolveAuthUserTenantId(req)
      const result = await bulkResolveStockPreparationExceptions({
        context,
        permission: 'admin',
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        exceptionIds: input.exceptionIds,
        resolutionAction: input.resolutionAction,
        resolvedBy: user.id || user.email,
      })
      await audit.append({
        tenantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        action: 'exception_bulk_resolve',
        mode: result.mode,
        actor: user.id || user.email,
        detail: { resolutionAction: input.resolutionAction, resolved: result.resolved, skipped: result.skipped, exceptionType: result.exceptionType },
      })
      return sendOk(res, result)
    },

    // #3751 MVP W5: values-free exception queue for view 6 (message text never crosses).
    async stockPreparationExceptionList(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationConfirmReadInput(req, requestQuery(req), VALID_STOCK_PREPARATION_EXCEPTION_LIST_QUERY_KEYS, 'STOCK_PREPARATION_EXCEPTION_LIST_REQUEST_INVALID')
      const provisioning = context && context.api && context.api.multitable
        ? context.api.multitable.provisioning
        : undefined
      if (!provisioning) {
        throw new HttpRouteError(501, 'CONFIRM_READS_PROVISIONING_API_UNAVAILABLE', 'multitable provisioning API is not available')
      }
      const result = await listStockPreparationExceptions({
        recordsApi: getMultitableRecordsApi(),
        provisioning,
        targetProjectId: input.targetProjectId,
        projectId: input.projectId,
        snapshotBatchId: input.snapshotBatchId,
        status: input.status,
        exceptionType: input.exceptionType,
        severity: input.severity,
        permission: 'admin',
      })
      return sendOk(res, result)
    },

    // #3751 MVP W5: values-free prep-line summary for view 5 (value-bearing detail stays owner-gated).
    async stockPreparationPrepLineList(req, res) {
      requireAccess(req, 'admin')
      const input = stockPreparationConfirmReadInput(req, requestQuery(req), VALID_STOCK_PREPARATION_PREP_LINE_LIST_QUERY_KEYS, 'STOCK_PREPARATION_PREP_LINE_LIST_REQUEST_INVALID')
      const provisioning = context && context.api && context.api.multitable
        ? context.api.multitable.provisioning
        : undefined
      if (!provisioning) {
        throw new HttpRouteError(501, 'CONFIRM_READS_PROVISIONING_API_UNAVAILABLE', 'multitable provisioning API is not available')
      }
      const result = await listStockPreparationPrepLines({
        recordsApi: getMultitableRecordsApi(),
        provisioning,
        targetProjectId: input.targetProjectId,
        projectId: input.projectId,
        snapshotBatchId: input.snapshotBatchId,
        prepStatus: input.prepStatus,
        permission: 'admin',
      })
      return sendOk(res, result)
    },

    // #3751 MVP W5b (#3890): values-free audit trail read — entries are values-free BY CONSTRUCTION
    // (the store's structural gate refused anything else at append time).
    async stockPreparationAuditList(req, res) {
      requireAccess(req, 'admin')
      const rawQuery = requestQuery(req)
      if (!isPlainObject(rawQuery)) {
        throw new HttpRouteError(400, 'STOCK_PREPARATION_AUDIT_LIST_REQUEST_INVALID', 'request must be an object')
      }
      for (const key of Object.keys(rawQuery)) {
        if (!VALID_STOCK_PREPARATION_AUDIT_LIST_QUERY_KEYS.has(key)) {
          throw new HttpRouteError(400, 'STOCK_PREPARATION_AUDIT_LIST_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
        }
      }
      const tenantId = resolveTenantId(req, { tenantId: firstString(rawQuery.tenantId) })
      const audit = requireStockPreparationAudit()
      const result = await audit.list({
        tenantId,
        workspaceId: firstString(rawQuery.workspaceId),
        projectId: firstString(rawQuery.projectId),
        action: firstString(rawQuery.action),
        limit: firstString(rawQuery.limit),
      })
      return sendOk(res, result)
    },

    // -------------------------------------------------------------------
    // 工作台里选源 — GET/POST /api/integration/stock-preparation/source-binding
    //
    // THE COST THESE TWO ROUTES REMOVE. `source.externalSystemId` was pinned in
    // INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON and read once at plugin activation, so
    // "read the customer's PLM instead of the demo source" meant an implementer with a shell editing
    // a deploy file and restarting the backend. It is now a name in a dropdown, it persists, and it
    // is resolved per request — the next dry-run reads the new source with no restart.
    //
    // GATE: `requireAccess(req, 'admin')` on BOTH legs — the integration ADMIN tier, which
    // `hasPermission` satisfies only from `role:admin` / `integration:admin` (an integration WRITER
    // is refused; line 661 returns false for every other code). The GET is at the same tier as the
    // POST on purpose: it does not merely report the current binding, it enumerates exactly the
    // choices whose Save would succeed, which is the POST's own authority stated in advance. Gating
    // it at the wider read tier would hand a read-only principal a list they cannot act on — R-11's
    // "visible but not actionable" — and the front end mirrors this by rendering the picker only for
    // an admin and giving everyone else the read-only explanation without calling either route.
    //
    // TENANT: the GET resolves through `scopedInput` (a read; a tenantless platform admin keeps its
    // existing cross-tenant capability). The POST is a WRITE and therefore uses
    // `scopedAuthenticatedWriteInput`, which derives the tenant from the authenticated principal
    // ONLY and refuses any mismatched carrier — a request-supplied tenant on this route would be a
    // steering vector at another tenant's source.
    //
    // VALUES-FREE: ids, connector kinds, status/role enums, operator-authored system names, and the
    // 对接总览's own plain-language kind labels. No config subtree (the public projection has already
    // deleted every private per-kind key), no credential, no fingerprint, no host, no business value.
    // -------------------------------------------------------------------

    /**
     * The eligible-source candidates, resolved against the caller's own visibility.
     *
     * TWO FILTERS, and both matter. `listExternalSystems` is already tenant/workspace scoped, and
     * `listEligibleSources` then keeps only the two BOM read kinds, active, non-target — so a write
     * connector (K3 WebAPI included) is not in the list because its kind is not on the allowlist,
     * not because a fence was consulted here.
     *
     * The #5401 join is the second filter. A `data-source:*` system carries only a REFERENCE to a
     * core data source, and the right to use that source belongs to its OWNER — `assertAccess` has
     * no admin bypass on the data plane, so being an integration admin does not make someone else's
     * connection yours. `dataSources.describe` is the host's narrow principal-gated seam (it returns
     * {id,name,type,status} and neither connects nor decrypts), and a refusal is deliberately
     * indistinguishable from a deleted row, so this leaks no existence either. A host that predates
     * the seam resolves nothing and every candidate stays undecided rather than being wrongly
     * dropped — the same honest degrade the 对接总览 card makes.
     */
    async stockPreparationSourceBindingGet(req, res) {
      requireAccess(req, 'admin')
      const scope = scopedInput(req, {})
      const listScope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId }
      const store = requireStockPreparationSourceBinding()

      const [binding, systems] = await Promise.all([
        store.get({ ...listScope, actionId: PLM_STOCK_PREPARATION_ACTION_ID }),
        externalSystems.listExternalSystems({ ...listScope, limit: SOURCE_BINDING_CANDIDATE_LIMIT }),
      ])

      const dataSourceAccessibility = await resolveDataSourceAccessibility(req, systems)
      const effective = await tableActions
        .getTableAction({ ...listScope, actionId: PLM_STOCK_PREPARATION_ACTION_ID })
        .then((action) => action.source, () => null)

      // THE ACTION'S OWN KIND IS THE PICKER'S FILTER, and this is the fix for the
      // accepted-yet-unreadable cross-kind bind. `source.kind` is frozen deploy-time config that the
      // binding deliberately does not move, and `loadTableActionSourceAdapter` refuses any system
      // whose kind differs. So a candidate of the other BOM read kind would save fine and then break
      // every read. Narrowing the list here means such a candidate is never offered at all; the POST
      // re-checks it anyway, because the picker is a convenience and the POST is the authority.
      //
      // No action resolvable -> no kind to require -> nothing is offered. That is honest: an
      // unconfigured action has no target, template or read plan either, so binding a source to it
      // could not make it work.
      const requiredKind = effective ? effective.kind : null
      const eligibleSources = requiredKind
        ? listEligibleSources(systems, { dataSourceAccessibility, requiredKind })
        : []

      // Is what the action reads TODAY actually usable? A deployment can arrive here with a broken
      // effective source in two ways this screen did not cause: an env default naming a system that
      // was deleted or deactivated, or a cross-kind row persisted before this check existed. Saying
      // "takes effect without a restart" over either would be a promise the next refresh breaks.
      const effectiveSystem = effective
        ? systems.find((system) => isPlainObject(system) && system.id === effective.externalSystemId) || null
        : null
      const effectiveSourceProblem = effective
        ? sourceBindingRefusalReason(effectiveSystem, {
            requiredKind,
            dataSourceAccessible: dataSourceAccessibility
              ? dataSourceAccessibility.get(effective.externalSystemId)
              : undefined,
          })
        : 'not_found'

      return sendOk(res, {
        actionId: PLM_STOCK_PREPARATION_ACTION_ID,
        // WHAT THE ACTION WILL ACTUALLY READ on the next request, resolved through the very same
        // registry seam a dry-run goes through — not recomputed here. `origin` is the whole point of
        // the screen: `persisted` means an admin chose it and it is live; `deploy_default` means
        // nothing is bound and the env value stands; `unconfigured` means neither exists.
        effectiveExternalSystemId: effective ? effective.externalSystemId : null,
        effectiveSourceKind: effective ? effective.kind : null,
        origin: binding ? 'persisted' : (effective ? 'deploy_default' : 'unconfigured'),
        persistedBinding: binding,
        // `null` when the current source is readable; otherwise the closed reason token saying why it
        // is not, so the screen can name the problem instead of leaving the admin to discover it on
        // the next failed refresh.
        effectiveSourceProblem,
        // COMPUTED, not fixed. The mechanism never needs a restart, but this flag is what the UI
        // renders as "saved and already live", so it must mean "a change made here will actually
        // work" — which is false while the current source cannot be read.
        takesEffectWithoutRestart: effectiveSourceProblem === null,
        eligibleSources,
      })
    },

    /**
     * Bind this scope's source. Validate FIRST, persist SECOND, audit THIRD — in that order and all
     * of it before any adapter, credential or connection is touched. Nothing here reads a source.
     */
    async stockPreparationSourceBindingSet(req, res) {
      requireAccess(req, 'admin')
      const rawBody = requestBody(req)
      if (!isPlainObject(rawBody)) {
        throw new HttpRouteError(400, 'SOURCE_BINDING_REQUEST_INVALID', 'request must be an object')
      }
      for (const key of Object.keys(rawBody)) {
        if (!VALID_SOURCE_BINDING_BODY_KEYS.has(key)) {
          throw new HttpRouteError(400, 'SOURCE_BINDING_REQUEST_INVALID', `unsupported request field: ${key}`, { field: key })
        }
      }
      // The body may name a SOURCE and nothing else. It cannot name a kind, a read plan, a target, a
      // workspace or an action — so a click in the workbench can move WHERE the action reads and
      // never WHAT it reads or HOW, and it cannot reach the B2a registration's matching inputs.
      const externalSystemId = firstString(rawBody.externalSystemId)
      if (!externalSystemId) {
        throw new HttpRouteError(400, 'SOURCE_BINDING_REQUEST_INVALID', 'externalSystemId is required', { field: 'externalSystemId' })
      }

      const scope = scopedAuthenticatedWriteInput(req, {})
      const listScope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId }
      const store = requireStockPreparationSourceBinding()
      const audit = requireStockPreparationAudit()

      // THE ACTION'S FROZEN KIND — resolved BEFORE the candidate is judged, because it is part of
      // what "eligible" means. The binding moves `externalSystemId` only, so `source.kind` stays at
      // its deploy-time value and `loadTableActionSourceAdapter` will refuse any system that does not
      // match it. Accepting a cross-kind bind here would persist a source that is unreadable by
      // construction: Save succeeds, the screen says "live", and every refresh afterwards fails with
      // an opaque TABLE_ACTION_SOURCE_INVALID the admin cannot connect to anything they did.
      //
      // An unresolvable action is REFUSED rather than bound blind: without a kind there is nothing to
      // check against, and binding into that gap is precisely how the footgun above is loaded.
      let requiredKind = null
      try {
        const action = await tableActions.getTableAction({ ...listScope, actionId: PLM_STOCK_PREPARATION_ACTION_ID })
        requiredKind = action.source.kind
      } catch (error) {
        if (error instanceof StockPreparationTableActionError) {
          throw new HttpRouteError(
            409,
            'SOURCE_BINDING_ACTION_UNRESOLVED',
            'the stock-preparation table action is not configured on this deployment, so a source cannot be bound to it',
            { actionId: PLM_STOCK_PREPARATION_ACTION_ID, reason: error.code },
          )
        }
        throw error
      }

      // Load through the caller's own tenant scope: an id in another tenant simply is not found, and
      // `assertBindableSource` reports that as a 404 identical to a typo's.
      const candidate = await externalSystems.getExternalSystem({ ...listScope, id: externalSystemId })
      const accessibility = await resolveDataSourceAccessibility(req, candidate ? [candidate] : [])
      assertBindableSource(candidate, {
        dataSourceAccessible: accessibility ? accessibility.get(externalSystemId) : undefined,
        requiredKind,
      })

      const { binding, previousExternalSystemId, changed } = await store.set({
        ...listScope,
        actionId: PLM_STOCK_PREPARATION_ACTION_ID,
        externalSystemId,
        actor: requestPrincipal(req),
      })

      // ACTOR + OLD/NEW, inside the closed values-free vocabulary (migration 080). `subject_id` is
      // the newly bound system — an internal row id, the same class of handle the existing nine
      // actions carry — and the id it replaced rides `detail`, where the store's structural gate
      // admits it as an enum-shaped handle. A rebind to the SAME source is still recorded, as
      // `mode: 'rebound'` with `changed: false`: someone re-confirmed the source, and that is a fact
      // a reviewer asking "who touched this" wants to see.
      await audit.append({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        action: 'source_binding_set',
        subjectId: binding.externalSystemId,
        mode: previousExternalSystemId ? 'rebound' : 'bound',
        actor: requestPrincipal(req),
        detail: {
          changed,
          ...(previousExternalSystemId ? { previousExternalSystemId } : {}),
          sourceKind: candidate.kind,
        },
      })

      return sendOk(res, {
        actionId: PLM_STOCK_PREPARATION_ACTION_ID,
        binding,
        changed,
        // Not decoration: the caller is told the change is live so the UI can say so without the
        // front end asserting a backend property on its own authority.
        takesEffectWithoutRestart: true,
      })
    },

    // B-stage confirmation-decision LEDGER surfaces (first cut) — all admin-gated; the staging
    // project is auth-derived and never request-steered on the write routes.

    async stockPreparationConfirmationDecisionsReadiness(req, res) {
      // O2 / R-11: queue READ tier. Values-free — provisioning state of the ledger target, no row
      // content. `permission: 'admin'` below is UNRELATED: it is the SERVER's own capability toward
      // the managed internal table (assertAdminPermission), not the caller's tier, and it stays.
      requireAccess(req, STOCK_PREP_READ)
      const input = normalizeStockPreparationConfirmBody(
        requestQuery(req),
        VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_READINESS_QUERY_KEYS,
        'CONFIRMATION_DECISION_READINESS_REQUEST_INVALID',
      )
      const tenantId = resolveTenantId(req, input)
      const result = await inspectConfirmationDecisionTarget({
        context,
        projectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        permission: 'admin',
      })
      return sendOk(res, result)
    },

    async stockPreparationConfirmationDecisionsEnsure(req, res) {
      requireAccess(req, 'admin')
      normalizeStockPreparationConfirmBody(
        requestBody(req),
        VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_ENSURE_BODY_KEYS,
        'CONFIRMATION_DECISION_ENSURE_REQUEST_INVALID',
      )
      const tenantId = resolveAuthUserTenantId(req)
      const result = await ensureConfirmationDecisionTarget({
        context,
        projectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        permission: 'admin',
      })
      return sendOk(res, result, result.created ? 201 : 200)
    },

    // THE authoritative exception queue (converged ruling): pending decisions with counts, ids,
    // hashes and status enums — NEVER a source cell value. Canonical filter views stay auxiliary.
    async stockPreparationConfirmationDecisionsList(req, res) {
      // O2 / R-11: queue READ tier — THE operator surface. Counts, ids, hashes and status enums
      // only (G8 leak canary), so it carries no value content and rides the broad read code.
      requireAccess(req, STOCK_PREP_READ)
      const input = normalizeStockPreparationConfirmBody(
        requestQuery(req),
        VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_LIST_QUERY_KEYS,
        'CONFIRMATION_DECISION_LIST_REQUEST_INVALID',
      )
      const projectNo = firstString(input.projectNo)
      if (!projectNo) {
        throw new HttpRouteError(400, 'CONFIRMATION_DECISION_LIST_REQUEST_INVALID', 'projectNo is required', { field: 'projectNo' })
      }
      const tenantId = resolveTenantId(req, input)
      const result = await listConfirmationDecisions({
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        permission: 'admin',
        projectNo,
        status: firstString(input.status),
      })
      return sendOk(res, result)
    },

    // O1' value unlock: the dedicated per-decision operator read — the ONLY surface where entered
    // resolvedValue/resolvedAuxValue/notes CONTENTS cross (the queue and all evidence stay
    // values-free). Admin-gated read; the module refuses a decisionId that does not resolve to
    // exactly one ledger row.
    async stockPreparationConfirmationDecisionsValueEntry(req, res) {
      // O2 / R-11 — the ONE content-bearing surface, deliberately placed on OPERATE, not READ.
      //
      // It rides the write code because it is the author's own readback: Q1-A/Q2-A give the human
      // direct authorship of these values, and withholding the readback from the principal who
      // entered them is incoherent. It must NOT ride READ, because READ is the broad queue-watcher
      // tier (supervisor, auditor, dashboard) and the O1' ruling re-drew the values-free boundary
      // around exactly this content: everyone who is not an author keeps seeing counts, fingerprints
      // and status enums, never a value. One notch tighter than the queue, one notch looser than
      // platform admin — which is what makes the workbench usable without widening the value face.
      const user = requireAccess(req, STOCK_PREP_OPERATE)
      const input = normalizeStockPreparationConfirmBody(
        requestQuery(req),
        VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_VALUE_ENTRY_QUERY_KEYS,
        'CONFIRMATION_DECISION_VALUE_ENTRY_REQUEST_INVALID',
      )
      const decisionId = firstString(input.decisionId)
      if (!decisionId) {
        throw new HttpRouteError(400, 'CONFIRMATION_DECISION_VALUE_ENTRY_REQUEST_INVALID', 'decisionId is required', { field: 'decisionId' })
      }
      // WHOSE VALUES ARE THESE — resolved by the operator value scope, NOT by `resolveTenantId`.
      //
      // This route was left on `resolveTenantId` when the operator project directory introduced the
      // scope module, even though the module's own header names this read as the same tier. That was
      // a real hole, not a stylistic gap: `auth/jwt-middleware.ts` copies the `x-tenant-id` REQUEST
      // HEADER onto `user.tenantId` when the verified token carries no tenant claim, and
      // `resolveTenantId` then compares the request's tenant against that same header-filled field —
      // header against header. A tenant-A operator sending `x-tenant-id: tenant-b` was served tenant
      // B's ENTERED VALUES with a 200. The scope below prefers the verified claim, refuses a carried
      // tenant that contradicts it, refuses a principal with no tenant of its own (the tenantless
      // platform admin `resolveTenantId` would have let steer), and makes the HOST vouch for the
      // (user, tenant) pairing — which is the only thing that can decide the claimless case.
      const scope = await resolveOperatorValueScope({
        user,
        authenticatedTenantId: req.authenticatedTenantId,
        explicitTenantIds: collectExplicitTenantIds(req, input),
        tenantPrincipalDirectory,
      })
      const result = await readConfirmationDecisionValueEntry({
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(scope.tenantId, undefined),
        permission: 'admin',
        decisionId,
      })
      return sendOk(res, result)
    },

    async stockPreparationConfirmationDecisionsConfirm(req, res) {
      // O2 / R-11: the OPERATE tier — the whole point of the operator role. Covers the frozen action
      // vocabulary (keep_multiple_rows / accept_current / manual_hold) and the O1'-A value-entry
      // fields. The audit append below still stamps the real principal, so a customer operator's
      // confirmations are attributable exactly as an admin's were.
      const user = requireAccess(req, STOCK_PREP_OPERATE)
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(
        requestBody(req),
        VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_CONFIRM_BODY_KEYS,
        'CONFIRMATION_DECISION_CONFIRM_REQUEST_INVALID',
      )
      const tenantId = resolveAuthUserTenantId(req)
      // A confirmation resolves a planner exception, so it rides the existing exception_resolve
      // audit action with a fixed operation subtype (the audit vocabulary is migration-frozen).
      // Record intent FIRST: if the SQL audit store is unavailable or refuses the payload, no
      // multitable patch may occur.
      await audit.append({
        tenantId,
        action: 'exception_resolve',
        subjectId: firstString(input.decisionId),
        mode: 'confirmation_decision_requested',
        actor: user.id || user.email,
        detail: {
          operation: 'confirmation_decision_confirm',
          // Enum-shaped when present; omitted (not undefined) when the request is malformed so the
          // audit row still lands and the module's own named validation error reaches the caller.
          ...(firstString(input.resolutionAction) ? { resolutionAction: firstString(input.resolutionAction) } : {}),
        },
      })
      const result = await confirmConfirmationDecision({
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        targetProjectId: resolveIntegrationStagingProjectId(tenantId, undefined),
        permission: 'admin',
        decisionId: input.decisionId,
        inputFingerprint: input.inputFingerprint,
        resolutionAction: input.resolutionAction,
        resolvedValue: input.resolvedValue,
        resolvedAuxValue: input.resolvedAuxValue,
        notes: input.notes,
        confirmedBy: user.id || user.email,
      })
      return sendOk(res, result)
    },

    // 按项目导出物料 Excel — 仓库/采购 take THIS PROJECT's material list after the approval chain
    // completes ("导出涉及的物料信息为 excel 到本地处理"). See the ROUTES-array comment and
    // stock-preparation-prep-line-export.cjs's header for the read-side contract (unknown project vs.
    // zero-active-rows, the column projection's source).
    //
    // GATE CHOICE: requireAccess(req, STOCK_PREP_OPERATE) — the SAME code that gates the ONE other
    // value-bearing stock-prep read in this file, stockPreparationConfirmationDecisionsValueEntry (the
    // per-decision value readback, O1' ruling). Every OTHER stock-prep GET in this family is
    // deliberately values-free (stock-prep:read queue-watcher tier: counts, enums, handles); this
    // route is the second, deliberate exception — it carries customer VALUES (material names,
    // quantities) — so it rides the SAME notch-tighter OPERATE tier rather than the broad READ tier,
    // for the identical reason the value-entry read does: the queue-watcher tier (supervisor, auditor,
    // dashboard) must keep seeing counts/enums only, never a value. See the PR body for the full
    // justification (including the alternatives considered and rejected).
    async stockPreparationPrepLineExport(req, res) {
      const user = requireAccess(req, STOCK_PREP_OPERATE)
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(
        requestQuery(req),
        VALID_STOCK_PREPARATION_PREP_LINE_EXPORT_QUERY_KEYS,
        'STOCK_PREPARATION_PREP_LINE_EXPORT_REQUEST_INVALID',
      )
      const projectNo = firstString(input.projectNo)
      if (!projectNo) {
        throw new HttpRouteError(400, 'STOCK_PREPARATION_PREP_LINE_EXPORT_REQUEST_INVALID', 'projectNo is required', { field: 'projectNo' })
      }
      // WHOSE MATERIALS ARE THESE — the same operator value scope the per-decision readback and the
      // project directory use, for the same reason and closing the same pre-existing hole: on a
      // deployment whose tokens carry no tenant claim, `resolveTenantId` compared the request's
      // tenant against a `user.tenantId` the auth middleware had filled from the `x-tenant-id`
      // HEADER, so a tenant-A operator sending `x-tenant-id: tenant-b` was served tenant B's
      // MATERIAL NAMES AND QUANTITIES with a 200. See the scope module's header for the whole
      // posture; the short version is that a value-bearing read must derive its tenant from the
      // AUTHENTICATED principal with the host vouching for the pairing, never from anything the
      // caller can set. Resolved BEFORE the table action below, so an unauthorized or cross-tenant
      // caller costs no action lookup either.
      const scope = await resolveOperatorValueScope({
        user,
        authenticatedTenantId: req.authenticatedTenantId,
        explicitTenantIds: collectExplicitTenantIds(req, input),
        tenantPrincipalDirectory,
      })
      const tenantId = scope.tenantId
      // READ THE TABLE APPLY WRITES. Resolved through the SAME seam every other stock-prep route
      // uses to reach its target — getTableAction + assertStockPreparationTargetReady — so the read
      // side cannot pick a different sheet from the write side. The first cut hardcoded the
      // canonical objectId and resolved it through provisioning, which is empty on every default
      // install: apply is sandbox-only unless an owner configured a production policy, so the rows
      // are in the sandbox twin and every project answered 404.
      //
      // NOTE, PRECISELY, WHAT THE VERIFIED TENANT DECIDES HERE. It keys the ACTION LOOKUP — and so
      // the persisted per-tenant SOURCE binding — and it keys the audit row, so a header-spoofed
      // tenant can no longer steer either of those. It does NOT decide the SHEET: `action.target` is
      // DEPLOY-TIME configuration shared by every tenant on the deployment, and the only row-level
      // scoping inside it is `projectNo`. That is a property of the table-action target model this
      // route adopted, not of this scope; it is written down here so nobody reads the scope as a
      // promise of per-tenant ROW isolation on this route the way it genuinely is on the other two
      // (value-entry and the directory both derive their sheet from the verified tenant's staging
      // project). Making this route's target tenant-scoped is a separate change.
      const action = assertStockPreparationTargetReady(
        await tableActions.getTableAction({ tenantId, actionId: PLM_STOCK_PREPARATION_ACTION_ID }),
      )
      const exportResult = await exportStockPreparationPrepLines({
        recordsApi: getMultitableRecordsApi(),
        target: action.target,
        projectNo,
        permission: 'admin',
      })
      // Record intent FIRST — the same "audit before the effect is observable" discipline the write
      // routes use: if the audit store is unavailable or refuses the payload, no workbook may be
      // streamed. Values-free: counts only, never a material name/quantity.
      await audit.append({
        tenantId,
        workspaceId: input.workspaceId,
        projectId: projectNo,
        action: 'prep_line_export',
        actor: user.id || user.email,
        mode: exportResult.activeRowCount > 0 ? 'export' : 'export_empty',
        detail: {
          operation: 'prep_line_export',
          totalRowCount: exportResult.totalRowCount,
          activeRowCount: exportResult.activeRowCount,
          columnCount: exportResult.headers.length,
        },
      })
      if (!stockPreparationXlsxExport || typeof stockPreparationXlsxExport.buildWorkbookBuffer !== 'function') {
        throw new HttpRouteError(501, 'PREP_LINE_EXPORT_XLSX_UNAVAILABLE', 'xlsx export capability is not available')
      }
      const buffer = await stockPreparationXlsxExport.buildWorkbookBuffer({
        sheetName: stockPreparationExportSheetName(projectNo),
        headers: exportResult.headers,
        rows: exportResult.rows,
      })
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="${stockPreparationExportFilename(projectNo)}"`)
      // Lets the front end tell "downloaded, but this project has zero active material rows right now"
      // apart from a normally populated export, without parsing the binary body — see the UI notice.
      res.setHeader('X-Stock-Prep-Export-Row-Count', String(exportResult.activeRowCount))
      return res.send(buffer)
    },

    // 一线看得见自己工厂的项目 — THE OPERATOR PROJECT DIRECTORY / WORKLIST.
    //
    // WHAT CHANGED, AND WHAT DID NOT. The values-free project list
    // (GET /stock-preparation/projects, `requireAccess(req, 'read')`) is UNTOUCHED — same gate, same
    // module, same byte-identical projection, still serving the platform/admin workspace with handles,
    // a closed enum and counts. This is a SIBLING route with its own manifest row, and it is the only
    // one that carries `projectNo` / `projectName`.
    //
    // THE POSTURE, ruled by the owner: the boundary is "WHOSE DATA IS IT", not "which screen is it".
    // The values-free stance exists to keep the PLATFORM/CONSULTANT side out of customer values — the
    // original design of this line said so in as many words ("The live UI may show business values to
    // authorized operators because the operator is working inside the tenant workspace. Issue/customer
    // evidence must remain values-free", data-factory-plm-project-bom-stock-preparation-design-
    // 20260604.md:282-284). A factory operator seeing their OWN tenant's project numbers and names is
    // that live UI, not the evidence channel.
    //
    // THE THREE GATES the H0 plane-boundary lock requires of any value-bearing read (三重门,缺一不可),
    // all present here:
    //   1. RBAC — `stock-prep:operate`, an independent value-read permission that is NOT
    //      `integration:read` (R-11's mapping is zero-automatic), and the SAME tier already carrying
    //      the only two other value-bearing stock-prep reads (value-entry, and the materials export
    //      which already ships material names and quantities).
    //   2. SERVER-SIDE FIELD WHITELIST — the projection is fixed in
    //      stock-preparation-operator-project-directory.cjs. Two value fields, named in code; the row
    //      is never spread into the response.
    //   3. AUDIT — appended below, and appended BEFORE the values reach the caller, so an audit store
    //      that refuses the row means no value-bearing body is ever sent (H3-0 ③, fail-closed).
    //
    // AND THE SCOPE, which is what makes gate 1 mean "their own": `resolveOperatorValueScope` derives
    // the tenant from the AUTHENTICATED principal, prefers the VERIFIED token claim over the
    // header-fillable `user.tenantId`, refuses any request-carried tenant that disagrees, refuses a
    // principal with no tenant of its own (which is where a tenantless platform admin lands — us), and
    // makes the host vouch for the (user, tenant) pairing. Deliberately NOT `resolveTenantId`: that
    // helper lets a tenantless platform admin steer `tenantId` from the request, which is exactly the
    // cross-tenant capability a value-bearing read must not inherit.
    async stockPreparationOperatorProjectDirectory(req, res) {
      const user = requireAccess(req, STOCK_PREP_OPERATE)
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(
        requestQuery(req),
        VALID_STOCK_PREPARATION_OPERATOR_PROJECT_DIRECTORY_QUERY_KEYS,
        'STOCK_PREPARATION_OPERATOR_PROJECT_DIRECTORY_REQUEST_INVALID',
      )
      // Establish WHOSE data may be shown before any IO. Every refusal this can raise is decided from
      // the principal plus the request's own tenant carriers, so an under-privileged, tenantless or
      // cross-tenant caller costs zero records/provisioning work.
      const scope = await resolveOperatorValueScope({
        user,
        authenticatedTenantId: req.authenticatedTenantId,
        explicitTenantIds: collectExplicitTenantIds(req, input),
        tenantPrincipalDirectory,
      })
      const result = await listOperatorProjectDirectory({
        recordsApi: getMultitableRecordsApi(),
        provisioning: getMultitableProvisioning(),
        // Derived from the VERIFIED scope, never from the request — there is no reachable input by
        // which tenant A's caller addresses tenant B's staging project.
        targetProjectId: resolveIntegrationStagingProjectId(scope.tenantId, undefined),
        scope,
      })
      // VALUES-FREE AUDIT over a value-bearing response. Counts, booleans and handles only: no
      // projectNo, no projectName, and no `projects` array — the row records THAT a directory read
      // happened and how big the answer was, never what was in it. Appended before the response so a
      // refusing audit store blocks the values (H3-0 ③).
      await audit.append({
        tenantId: scope.tenantId,
        workspaceId: input.workspaceId,
        action: 'project_directory_read',
        actor: scope.actorId,
        mode: result.pendingProjectCount > 0 ? 'operator_directory' : 'operator_directory_idle',
        detail: {
          operation: 'operator_project_directory',
          projectCount: result.projectCount,
          pendingProjectCount: result.pendingProjectCount,
          directoryReady: result.directoryReady,
          ledgerReady: result.ledgerReady,
          tenantClaimVerified: scope.tenantClaimVerified,
        },
      })
      return sendOk(res, result)
    },

    // 通知下一步 —— WHOSE TURN IS IT. The read half of the 备料 handoff.
    //
    // GATE CHOICE: requireAccess(req, STOCK_PREP_READ) — the broad queue-watcher tier, same as the
    // confirmation-decision queue beside it, because everything this returns is values-free: step
    // keys drawn from the closed handoff vocabulary, cursor integers, booleans, and handler COUNTS.
    // Handler IDENTITIES are deliberately NOT returned (projectHandoffSteps projects them to a
    // count): a supervisor watching the queue has no need for the personnel roster, and a values-free
    // surface that leaks a staff list is still a leak. The ONE identity-derived fact that does cross
    // is `isCurrentHandler` — a boolean about the CALLER's own turn, computed server-side so the
    // front end never has to hold a roster to decide whether to show the button.
    async stockPreparationHandoffStatus(req, res) {
      const user = requireAccess(req, STOCK_PREP_READ)
      const input = normalizeStockPreparationConfirmBody(
        requestQuery(req),
        VALID_STOCK_PREPARATION_HANDOFF_STATUS_QUERY_KEYS,
        'STOCK_PREPARATION_HANDOFF_REQUEST_INVALID',
      )
      const projectNo = firstString(input.projectNo)
      if (!projectNo) {
        throw new HttpRouteError(400, 'STOCK_PREPARATION_HANDOFF_REQUEST_INVALID', 'projectNo is required', { field: 'projectNo' })
      }
      // Same shape rule as the advance route below — see there for why a projectNo is a HANDLE. The
      // read has a smaller blast radius (it writes nothing and composes no message body, it only
      // echoes the handle back), but one route accepting a shape its sibling refuses is how the two
      // drift apart, and the echo is itself a reflection surface.
      if (!isValidStockPrepProjectNo(projectNo)) {
        throw new HttpRouteError(
          400,
          'STOCK_PREPARATION_HANDOFF_PROJECT_NO_INVALID',
          'projectNo must be a business project handle: alphanumeric, then alphanumerics and . _ - / only, at most 80 characters',
          { field: 'projectNo' },
        )
      }
      // RC2 — THE TENANT COMES FROM THE PRINCIPAL THE HOST VOUCHES FOR, NEVER FROM A HEADER.
      //
      // This read used to call `resolveTenantId(req, input)`, i.e. `user.tenantId` — and
      // `hydrateAuthenticatedUser` copies the x-tenant-id REQUEST HEADER onto that field whenever the
      // verified token carries no tenant claim (a perfectly ordinary state: `resolveSessionTenantId`
      // omits the claim for any account with zero or two-plus org memberships). One header therefore
      // decided whose cursor this route reported.
      //
      // It now goes through the SAME #5445 resolver the value-bearing reads use, at its OWN tier: the
      // payload here is values-free (step keys, cursor integers, booleans, handler counts), so it
      // stays on the broad queue-watcher READ tier — a supervisor is meant to see whose turn it is —
      // while the tenant is still derived from the verified claim, refused when a carried tenant
      // contradicts it, refused for a principal with no tenant of its own, and vouched for by the host.
      const scope = await resolveOperatorValueScope({
        user,
        authenticatedTenantId: req.authenticatedTenantId,
        explicitTenantIds: collectExplicitTenantIds(req, input),
        tenantPrincipalDirectory,
        requiredTier: STOCK_PREP_READ,
      })
      const tenantId = scope.tenantId
      const chain = loadStockPreparationHandoffChain()
      // RC7: a chain bound to ANOTHER tenant is, from here, no chain at all — the workbench renders
      // nothing rather than a turn signal this tenant may not act on.
      if (!chain.configured || (chain.tenantId && chain.tenantId !== tenantId)) {
        // NOT an error. An unconfigured deployment asking "whose turn is it" gets a truthful "there
        // is no chain here", 200, so the workbench can render nothing without treating the absence of
        // an optional feature as a failure of the page it lives on.
        return sendOk(res, {
          configured: false,
          projectNo,
          steps: [],
          stepCount: 0,
          stepIndex: null,
          currentStepKey: null,
          terminal: false,
          completed: false,
          isCurrentHandler: false,
          notifiedStepIndex: null,
          // J5: every key the configured branch returns appears here too, at its inert value. The TS
          // interface declares them required, and a client reading `undefined` where the type promises
          // `false` is a bug waiting for its first reader — the two branches drifted once already,
          // which is why the suite pins this literal field-for-field.
          notificationsConfigured: false,
          resendableStepKey: null,
          lostStepKeys: [],
        })
      }
      const store = requireStockPreparationHandoffStore()
      // RC3: no `workspaceId`. The turn is a fact about a PROJECT, and the scope key that used to
      // carry a caller-supplied workspace is the same key the at-most-once notification claim rides —
      // see the store and migration 084. `workspaceId` stays in the query allowlist for shape
      // compatibility with the rest of this family (the workbench spreads one scope object into every
      // call) and is deliberately NOT read here.
      const persisted = await store.get({ tenantId, projectNo })
      // No row == never handed off == the chain is at step 0. Absence and zero are the same state.
      const stepIndex = persisted ? persisted.stepIndex : 0
      const completed = stepIndex >= chain.steps.length
      const currentStep = completed ? null : chain.steps[stepIndex]
      const notified = persisted ? persisted.notifiedStepIndex : null
      const notificationsConfigured = chainHasDestinationForHop(chain, false) || chainHasDestinationForHop(chain, true)

      // J1(a) — IS THE TAIL HOP STILL RESENDABLE, BY THIS CALLER? Four conditions, each load-bearing:
      //   * there IS a tail hop (`stepIndex >= 1`) — at step 0 nothing has been handed off yet;
      //   * it is unclaimed. `notified === null` means nothing was ever claimed, which leaves the tail
      //     resendable only when the tail IS hop 0; otherwise the tail is unclaimed exactly when the
      //     max sits one below it (`notified === stepIndex - 2`);
      //   * the chain actually sends something for that hop — otherwise there is nothing to resend;
      //   * and the caller is its configured handler, because `planStockPreparationHandoffAdvance`
      //     checks the roster of the step being REPLAYED. Inviting anybody else to click would be
      //     inviting them into a 403.
      const tailStepIndex = stepIndex - 1
      const tailUnclaimed = notified === null ? stepIndex === 1 : notified === stepIndex - 2
      const resendableStepKey = (
        tailStepIndex >= 0
        && tailUnclaimed
        && chainHasDestinationForHop(chain, tailStepIndex === chain.steps.length - 1)
        && isHandlerOfStep(chain, tailStepIndex, scope.actorId)
      )
        ? chain.steps[tailStepIndex].key
        : null

      // J1(b) — WHICH HOPS ARE GONE FOR GOOD. Read from the trail, not inferred from the cursor: the
      // advance route writes one `notification_lost` row per hop at the moment it becomes
      // irreversible, and that row is the ONLY representation of an interior gap that exists.
      //
      // Fail-soft on purpose: this is a display hint on a values-free read, so a missing or unhappy
      // audit store costs the banner, never the turn signal. Bounded, and scoped to this project.
      let lostStepKeys = []
      const auditForLost = (services && services.stockPreparationAuditStore) || null
      if (notificationsConfigured && auditForLost && typeof auditForLost.list === 'function') {
        try {
          const trail = await auditForLost.list({
            tenantId,
            projectId: projectNo,
            action: 'handoff_advance',
            limit: STOCK_PREPARATION_HANDOFF_LOST_LOOKBACK,
          })
          const seen = new Set()
          for (const entry of (trail && trail.entries) || []) {
            if (!entry || entry.mode !== 'notification_lost') continue
            const lost = entry.detail && Number(entry.detail.lostStepIndex)
            if (!Number.isInteger(lost) || lost < 0 || lost >= chain.steps.length) continue
            if (seen.has(lost)) continue
            seen.add(lost)
            lostStepKeys.push(chain.steps[lost].key)
          }
        } catch (error) {
          if (routeLogger && typeof routeLogger.warn === 'function') {
            routeLogger.warn('[plugin-integration-core] stock-prep handoff: could not read the lost-notification trail; the turn signal is unaffected')
          }
          lostStepKeys = []
        }
      }
      return sendOk(res, {
        configured: true,
        projectNo,
        steps: projectHandoffSteps(chain),
        stepCount: chain.steps.length,
        stepIndex,
        currentStepKey: currentStep ? currentStep.key : null,
        terminal: !completed && stepIndex === chain.steps.length - 1,
        completed,
        isCurrentHandler: !completed && isHandlerOfStep(chain, stepIndex, scope.actorId),
        notifiedStepIndex: notified,
        // G6: whether this chain notifies at all. Without it the workbench cannot tell a hop whose
        // notice was LOST from a turn-state-only deployment, whose `notifiedStepIndex` is null
        // forever and correctly so.
        notificationsConfigured,
        // J1 — THE TWO STATES, CARRIED SEPARATELY, BECAUSE THE COLUMN CANNOT TELL THEM APART.
        //
        // `notified_step_index` is a monotonic MAX. From it alone exactly one thing is derivable:
        // whether the TAIL hop (the one just completed, `stepIndex - 1`) has been claimed. An
        // INTERIOR unclaimed hop — one below the max — is not representable at all, because a later
        // claim raises the max straight past it.
        //
        // G6 read that column and got both answers backwards. Its predicate fired on the tail hop,
        // which is precisely the hop RC1 makes RECOVERABLE by the same handler's next click, and told
        // the operator it could never be resent — copy that discourages the one action that fixes it.
        // And it stayed silent for the superseded hop, which really is gone. So:
        //
        //   resendableStepKey — the tail hop, unclaimed, and YOU are its handler: press again.
        //   lostStepKeys      — read back from the `notification_lost` audit rows the advance route
        //                       writes, because that trail is the only place an interior gap exists.
        resendableStepKey,
        lostStepKeys,
      })
    },

    // 通知下一步 —— I'M DONE, TELL THE NEXT ONE. The write half.
    //
    // GATE CHOICE: requireAccess(req, STOCK_PREP_OPERATE) — the same notch as
    // stockPreparationConfirmationDecisionsConfirm, and for the same reason: this mutates durable
    // state AND has an effect outside the system (a DingTalk message that makes someone's phone
    // buzz). It must not ride the broad READ tier that the status read above uses, because that tier
    // is the queue-WATCHER tier (supervisor, auditor, dashboard) and a watcher must not be able to
    // move somebody else's work along.
    //
    // The permission is necessary but NOT sufficient: planStockPreparationHandoffAdvance additionally
    // requires the caller to be a configured handler of the step being handed off. Platform admins
    // are NOT exempted from that — an admin advancing someone else's step would make the audit trail
    // say a person handed off when they did not.
    //
    // ORDER OF OPERATIONS, chosen deliberately and pinned by the suite:
    //   1. gate, parse, VALIDATE the projectNo's shape, load the chain — nothing observable yet
    //   2. resolve the tenant from the VERIFIED principal, host-vouched  — RC2
    //   2b. probe the audit vocabulary, under that tenant                — F2 (a write; never before 2)
    //   3. plan the advance against the persisted cursor                 — the handler gate, RC6
    //   4. prove the project EXISTS in the bound target                  — a 404 before any write
    //   5. COMMIT the turn (compare-and-set, cursor only)
    //   6. AUDIT what actually happened
    //   7. CLAIM the notification (its own compare-and-set)              — RC1
    //   8. SEND it, best effort
    //
    // STEP 3 IS BEFORE STEP 4, and that is RC6. The existence probe used to run first, so a caller the
    // route was about to refuse could still tell 404 (that project number is real) from 403 (it is
    // not) — a project-number oracle for anyone holding stock-prep:operate, costing a records query
    // per guess and leaving no audit row behind. Planning first refuses a non-handler with ONE answer
    // for every project number, real or invented, before any records IO. The handler's own 404 is
    // unchanged: the check did not go away, it moved behind the gate.
    //
    // STEPS 5-7 ARE THREE WRITES, NOT ONE, and that is RC1. See the store's `claimNotification`.
    //
    // STEP 6 IS AFTER STEP 5, and that is a correction rather than the original design. The first cut
    // audited the INTENT first — the same "record intent FIRST" discipline the rest of this family
    // uses — and it was wrong HERE for a reason specific to this route: the store's compare-and-set
    // can REFUSE (a concurrent advance won the row), and the pre-written row said `mode: 'advanced'`
    // for a handoff that never happened. An append-only trail cannot take that back. So the trail
    // now records outcomes it has SEEN: a refusal from the planner or the store leaves NO row, and
    // every row on this trail describes a cursor move that really landed.
    //
    // THAT FIX HAD A MIRROR IMAGE, AND STEP 7 IS WHERE IT IS ANSWERED (RC1). While the notification
    // claim was stamped inside step 5's transaction, an audit append that FAILED left a hop whose
    // cursor had moved and whose claim was already spent — the next click is a replay, a replay could
    // not re-claim, and nobody was ever told. So the claim is now its own compare-and-set, taken
    // AFTER the trail row lands. Every one of the three writes is idempotent and the next click
    // resumes whichever of them did not happen; the CAS is what keeps "resumable" from meaning
    // "twice".
    //
    // What the old ordering bought is kept by other means: `requireStockPreparationAudit()` still
    // runs FIRST, so an unavailable audit store is a 501 before anything is read or written — and
    // `requireStockPreparationAuditVocabulary`, once the tenant is known, additionally refuses by name
    // and with the migration number a database whose CHECK constraint does not yet know this action.
    //
    // Step 6 is AFTER step 4 on purpose, and a failure there does NOT roll anything back. The turn is
    // the durable business fact — 张三 really did finish — and a DingTalk outage must not silently
    // un-finish it, leaving the workbench claiming it is still his step. The caller is told the truth
    // instead (`notified: false`, `notifyOutcome: 'failed'`) and the UI says so in words, so a human
    // can go and tell the next person. See the store for why this is at-most-once rather than
    // at-least-once.
    async stockPreparationHandoffAdvance(req, res) {
      const user = requireAccess(req, STOCK_PREP_OPERATE)
      // F2: the audit STORE is required here — a wiring check, no IO — but the VOCABULARY PROBE is
      // not. The probe is a real write-transaction (INSERT into the audit table, then roll back), and
      // running it before the tenant is established meant every refused tenant-steering caller caused
      // one. It now runs immediately after the scope resolves, still before any write it is meant to
      // protect. See requireStockPreparationAuditVocabulary.
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(
        requestBody(req),
        VALID_STOCK_PREPARATION_HANDOFF_ADVANCE_BODY_KEYS,
        'STOCK_PREPARATION_HANDOFF_REQUEST_INVALID',
      )
      const projectNo = firstString(input.projectNo)
      if (!projectNo) {
        throw new HttpRouteError(400, 'STOCK_PREPARATION_HANDOFF_REQUEST_INVALID', 'projectNo is required', { field: 'projectNo' })
      }
      // THE SHAPE CHECK, and it is not decoration. This string is about to be written verbatim into
      // an append-only audit row's `project_id`, into a durable cursor row, and — uniquely on this
      // route — INTERPOLATED INTO A DINGTALK MARKDOWN BODY that a person reads on their phone
      // (`项目 ${project} …`). Free text there is an injection surface and an unbounded-write
      // surface at once. The refusal names the field and NEVER echoes the value, so a hostile
      // projectNo cannot even reach the caller by way of the error it caused.
      if (!isValidStockPrepProjectNo(projectNo)) {
        throw new HttpRouteError(
          400,
          'STOCK_PREPARATION_HANDOFF_PROJECT_NO_INVALID',
          'projectNo must be a business project handle: alphanumeric, then alphanumerics and . _ - / only, at most 80 characters',
          { field: 'projectNo' },
        )
      }
      const fromStepKey = firstString(input.fromStepKey)
      if (!fromStepKey) {
        throw new HttpRouteError(400, 'STOCK_PREPARATION_HANDOFF_REQUEST_INVALID', 'fromStepKey is required', { field: 'fromStepKey' })
      }
      // J4 — SCOPE BEFORE CHAIN, SO BOTH ROUTES REFUSE IN THE SAME ORDER.
      //
      // The chain check used to run first here while the status route resolved the scope first, and
      // the two therefore disagreed for every caller whose scope cannot resolve: a tenantless admin
      // got 501 NOT_CONFIGURED on a deployment with no chain and 403 TENANT_REQUIRED on one that has
      // one — telling them, by the difference alone, that a 备料 chain exists here. Same one-bit
      // disclosure G7 closed on the binding, reached by ordering instead. The refusal a caller is not
      // entitled to pass now comes first on both routes.
      // RC2 — A WRITE DERIVES ITS TENANT FROM THE PRINCIPAL THE HOST VOUCHES FOR.
      //
      // This used to be `resolveAuthUserTenantId(req)`, i.e. `user.tenantId` — which the auth
      // middleware fills from the x-tenant-id REQUEST HEADER whenever the verified token carries no
      // tenant claim. One header therefore decided whose cursor was advanced, whose audit row was
      // written, and which project number went into which DingTalk group. It is the same hole #5445
      // closed for the value-bearing reads three routes above, and this route — which writes AND
      // speaks outside the system — has strictly more reason to close it.
      const scope = await resolveOperatorValueScope({
        user,
        authenticatedTenantId: req.authenticatedTenantId,
        explicitTenantIds: collectExplicitTenantIds(req, input),
        tenantPrincipalDirectory,
        requiredTier: STOCK_PREP_OPERATE,
      })
      const tenantId = scope.tenantId
      const actor = scope.actorId
      // Chain BEFORE store: an unconfigured deployment must refuse without ever reaching the database,
      // which is what makes "absent config = byte-identical behaviour" true rather than merely likely.
      const chain = requireConfiguredStockPreparationHandoffChain()
      const store = requireStockPreparationHandoffStore()
      // Refuse to write or announce on behalf of a tenant this deployment's chain is not for.
      requireStockPreparationHandoffChainForTenant(chain, tenantId)
      // F2 — THE VOCABULARY PROBE, NOW THAT WE KNOW WHOSE WRITE THIS IS. Still before every write it
      // exists to protect, and now probing under the RESOLVED tenant rather than a '__probe__'
      // placeholder, so the row it inserts and rolls back belongs to the tenant being cleared.
      await requireStockPreparationAuditVocabulary(audit, 'handoff_advance', '085', tenantId)

      // RC6 — THE HANDLER GATE COMES FIRST, BEFORE ANY RECORDS IO. `store.get` is a single indexed
      // read on a tenant-scoped table; the planner then refuses a non-handler with one 403 that is
      // identical for a real project number and an invented one. Only a caller who has passed that
      // gate gets to learn whether the project exists.
      // RC3: no `workspaceId` in the scope — the turn is a project-level fact; see the store.
      const persisted = await store.get({ tenantId, projectNo })
      const plan = planStockPreparationHandoffAdvance({
        chain,
        currentStepIndex: persisted ? persisted.stepIndex : 0,
        fromStepKey,
        actorId: actor,
      })
      const fromStepIndex = plan.fromStepIndex
      const terminal = fromStepIndex === chain.steps.length - 1

      // THE PROJECT MUST EXIST BEFORE ANYTHING IS WRITTEN. A well-shaped handle for a project nobody
      // has is still not a project, and starting a handoff chain on a typo would put a permanent row
      // in the audit trail, a permanent row in the cursor table, and a DingTalk ping about a project
      // the recipients cannot find. Resolved through the SAME seam the export read uses
      // (getTableAction + assertStockPreparationTargetReady), so this route cannot come to a
      // different opinion about where stock-prep rows live than the writer does.
      const action = assertStockPreparationTargetReady(
        await tableActions.getTableAction({ tenantId, actionId: PLM_STOCK_PREPARATION_ACTION_ID }),
      )
      const projectExists = await stockPreparationProjectHasMainRows({
        recordsApi: getMultitableRecordsApi(),
        target: action.target,
        projectNo,
        permission: 'admin',
      })
      if (!projectExists) {
        throw new HttpRouteError(
          404,
          'STOCK_PREPARATION_HANDOFF_PROJECT_NOT_FOUND',
          'no stock-preparation rows exist for this project',
          { field: 'projectNo' },
        )
      }

      // STEP 5 — THE TURN. Cursor only: the notification claim is taken separately, after the trail
      // row lands, so that a failing audit cannot leave a hop permanently unnotifiable (RC1).
      const applied = await store.advance({
        tenantId,
        projectNo,
        expectedStepIndex: fromStepIndex,
        toStepIndex: plan.toStepIndex,
        actor,
      })

      // DOES THIS HOP STILL OWE A NOTIFICATION? Asked of the STORE, not of the plan, because the two
      // can disagree in exactly the case that matters: a replay whose original request died between
      // the cursor move and the claim. Such a click finds the claim unspent and completes the hop.
      //
      // DO NOT SPEND THE CLAIM ON A HOP THAT HAS NOWHERE TO SEND. Once claimed for a step, that hop
      // can never be notified again; claiming it for a chain that names no destination would mean a
      // deployment adding one tomorrow finds yesterday's hops permanently silent. With the strict
      // config parse this is only reachable for the deliberate turn-state-only chain (neither
      // `notify` nor `terminal` declared) — a typo can no longer land here — but the guard stays,
      // because the cost of being wrong is an unnotifiable step and the cost of the guard is a
      // boolean.
      // J3 — AND THE SEAM COUNTS AS A DESTINATION. This asked the CHAIN CONFIG only, so on a
      // deployment whose host wired no notifier — which the seam's own contract calls optional — the
      // claim CAS fired, the dispatcher answered without attempting anything, and the hop became
      // permanently unnotifiable with no trace: `applied.changed` is true, so the lost-row loop below
      // (which only covers hops BEFORE this one) never saw it either. A claim may only be spent on a
      // hop something could actually have been sent for.
      const notifierWired = Boolean(
        stockPreparationHandoffNotifier && typeof stockPreparationHandoffNotifier.sendToDestinations === 'function',
      )
      const hopHasDestination = notifierWired && chainHasDestinationForHop(chain, terminal)
      if (!notifierWired && chainHasDestinationForHop(chain, terminal) && routeLogger && typeof routeLogger.warn === 'function') {
        routeLogger.warn(
          '[plugin-integration-core] stock-prep handoff: the chain names a destination but no notifier seam is wired; the hop is left UNCLAIMED so a deployment that wires one later can still announce it',
        )
      }

      // STEP 6 — RECORD WHAT HAPPENED, now that the store has confirmed it.
      //
      // RC5: `mode` is the STORE's committed verdict, never the planner's intent. A step may have
      // more than one configured handler, and when a co-handler commits the same hop between this
      // request's plan and its commit the store correctly writes nothing — a trail that took its mode
      // from the plan then said THIS actor advanced a step somebody else advanced, giving a reviewer
      // asking 「谁交接的」 two answers for one cursor move.
      //
      // G5 — THE ROW RECORDS WHAT THIS REQUEST OBSERVED, NOT WHAT IT HOPES TO DO. The first cut put a
      // `resumed` boolean here, computed from state read inside the advance transaction and written
      // twenty lines BEFORE the claim was attempted — the exact intent-vs-verdict bug RC5 had just
      // fixed for `mode`, in the same detail object. Two concurrent resume clicks wrote two rows both
      // saying they had completed the owed hop, for one notification.
      //
      // The append cannot simply move below the claim: that ordering is what RC1 exists to prevent
      // (an audit failure after a spent claim loses the ping forever, unrecoverably). So the two
      // facts are separated by what each can honestly assert at the moment it is written:
      //
      //   detail.notificationOwed  — an OBSERVATION, true at append time: the cursor had already
      //                              moved and this hop's notification was still unclaimed.
      //   response.resumed         — the committed VERDICT, set from `claim.claimed` below, which is
      //                              what the workbench renders ("之前没发出去的通知,这次补发了").
      //
      // And the case where the owed hop can never be sent at all gets its own row — see the
      // notification_lost append after this one.
      const notificationOwed = !applied.changed && hopHasDestination
        && (applied.handoff.notifiedStepIndex === null || applied.handoff.notifiedStepIndex < fromStepIndex)
      await audit.append({
        tenantId,
        projectId: projectNo,
        action: 'handoff_advance',
        subjectId: fromStepKey,
        mode: applied.changed ? (terminal ? 'completed' : 'advanced') : 'replayed',
        actor,
        detail: {
          operation: 'handoff_advance',
          fromStepIndex,
          toStepIndex: plan.toStepIndex,
          stepCount: chain.steps.length,
          terminal,
          notificationOwed,
        },
      })

      // G6 — A HOP WHOSE NOTICE CAN NEVER BE SENT LEAVES A RECORD.
      //
      // RC1's recovery is real but NARROW, and the prose used to state it without scope: it needs the
      // SAME handler, before the chain moves on. When a co-handler advances first, their claim moves
      // `notified_step_index` past the owed hop, the claim is monotonic, and that ping can never be
      // sent by anyone. Nothing recorded it, so 「谁该被通知却没被通知」 was unanswerable afterwards.
      //
      // Detected here because this is the moment it becomes irreversible: this advance is about to
      // claim `fromStepIndex`, so every hop strictly between the last claimed one and this one is now
      // permanently unnotifiable. Values-free: a step key from the closed vocabulary plus integers.
      if (applied.changed && hopHasDestination) {
        const lastClaimed = applied.handoff.notifiedStepIndex
        const firstUnclaimed = lastClaimed === null ? 0 : lastClaimed + 1
        for (let lost = firstUnclaimed; lost < fromStepIndex; lost += 1) {
          if (!chainHasDestinationForHop(chain, lost === chain.steps.length - 1)) continue
          await audit.append({
            tenantId,
            projectId: projectNo,
            action: 'handoff_advance',
            subjectId: chain.steps[lost].key,
            mode: 'notification_lost',
            actor,
            detail: {
              operation: 'handoff_notification_lost',
              lostStepIndex: lost,
              stepCount: chain.steps.length,
            },
          })
        }
      }

      // STEP 7 — THE CLAIM, its own compare-and-set. `claimed: false` means somebody already has it
      // (an earlier click, or a concurrent writer who is sending right now), which is a 'skipped',
      // never an error: the turn really did move.
      const claim = hopHasDestination
        ? await store.claimNotification({ tenantId, projectNo, stepIndex: fromStepIndex })
        : { claimed: false }

      // 'skipped' and 'not_configured' are DIFFERENT ANSWERS and the workbench renders them in
      // different words — "已经交给下一步,这次没有发群消息" versus "这个部署还没有配置备料接力的步骤".
      // 'skipped' is for a hop that HAS a destination and whose at-most-once claim was already spent
      // (a replay). The claim guard above must not silently downgrade the other case to it: before
      // that guard existed the claim was always made, `dispatchStockPreparationHandoffNotification`
      // saw an empty destination list and answered 'not_configured', and the turn-state-only chain
      // must keep getting that same honest answer now that it no longer spends a claim to reach it.
      let notifyOutcome = hopHasDestination ? 'skipped' : 'no_destination'
      if (claim.claimed) {
        const notification = buildStockPreparationHandoffNotification({
          chain,
          projectNo,
          fromStepIndex,
          // The APPROVER IS NAMED IN THE BODY and the message is sent by the SYSTEM. This is the
          // relaxed form of "issued in the name of the last approver": no impersonation is attempted,
          // because true send-as-a-person delegation needs DingTalk-side authorization and a security
          // review that is out of this change's scope.
          actorLabel: actor,
          terminal,
        })
        notifyOutcome = await dispatchStockPreparationHandoffNotification(notification)
      }

      const completed = applied.handoff.stepIndex >= chain.steps.length
      const currentStep = completed ? null : chain.steps[applied.handoff.stepIndex]
      return sendOk(res, {
        projectNo,
        fromStepKey,
        currentStepKey: currentStep ? currentStep.key : null,
        stepIndex: completed ? null : applied.handoff.stepIndex,
        stepCount: chain.steps.length,
        changed: applied.changed,
        terminal,
        notified: notifyOutcome === 'sent',
        // J8: a value outside the closed vocabulary is a value the workbench has no words for. The
        // guard that pairs outcomes with copy used to derive them by reading this file's text, which
        // one indirection escaped; the vocabulary is a frozen constant now, and this is the wire's
        // last line of defence against a member that never joined it.
        notifyOutcome: assertStockPreparationHandoffNotifyOutcome(notifyOutcome),
        // G1/G5: the COMMITTED verdict — this request found the hop already moved and its notification
        // still owed, and took the claim. The workbench needs it because `changed:false` alone can no
        // longer mean "nothing needed sending": since RC1 a replay is exactly how an interrupted hop
        // gets finished.
        resumed: !applied.changed && claim.claimed === true,
      })
    },

    // 项目备料页 — ONE PROJECT'S BOARD. The read behind the operator's single page.
    //
    // THE SAME GATE AND THE SAME TENANCY AS THE DIRECTORY ABOVE, deliberately and literally: this is
    // the FOURTH value-bearing stock-prep read, and the operator-scope module's header instructs a
    // fourth to JOIN the list rather than invent a fourth way to decide tenancy. So the tenant is
    // derived from the AUTHENTICATED principal via `resolveOperatorValueScope` — never
    // `resolveTenantId`, which lets a tenantless platform admin steer `tenantId` from the request —
    // and every refusal that scope can raise is decided before any records/provisioning work.
    //
    // WHY THE PROJECT NUMBER IS A PATH PARAM AND WHAT THAT COSTS. The board IS one project, so the
    // number addresses the resource. It is the caller's own input echoed back in the response (which
    // is fine — it is theirs) and it reaches NO audit row (which is the point: see below).
    //
    // THE 404 IS NOT AN EXISTENCE ORACLE. `readOperatorProjectBoard` looks the number up in the
    // caller's OWN directory, so "another tenant's project" is not a branch — it is simply absent,
    // and takes the identical path an unknown number takes to an identical, detail-free 404. There is
    // no reading of the response, the status or the timing from which a tenant-A operator learns
    // that a number exists in tenant B.
    //
    // MULTITABLE ENFORCES ACCESS ON LANDING. The `fillTarget` in the response is a HANDLE, not a
    // permission decision. This plugin has no user-aware multitable ACL seam — the read runs on the
    // service-account records API with the plugin's own authority — so it CANNOT pre-check whether
    // this operator may open that sheet, and this route makes no such claim. What it does guarantee
    // is that the handle names a sheet that EXISTS; whether the operator may see it is multitable's
    // answer, given when they land.
    async stockPreparationOperatorProjectBoard(req, res) {
      const user = requireAccess(req, STOCK_PREP_OPERATE)
      const audit = requireStockPreparationAudit()
      const input = normalizeStockPreparationConfirmBody(
        requestQuery(req),
        VALID_STOCK_PREPARATION_OPERATOR_PROJECT_BOARD_QUERY_KEYS,
        'STOCK_PREPARATION_PROJECT_BOARD_REQUEST_INVALID',
      )
      const projectNo = firstString(requestParams(req).projectNo)
      const scope = await resolveOperatorValueScope({
        user,
        authenticatedTenantId: req.authenticatedTenantId,
        explicitTenantIds: collectExplicitTenantIds(req, input),
        tenantPrincipalDirectory,
      })
      let outcome
      try {
        outcome = await readOperatorProjectBoard({
          recordsApi: getMultitableRecordsApi(),
          provisioning: getMultitableProvisioning(),
          // Derived from the VERIFIED scope, never from the request — there is no reachable input by
          // which tenant A's caller addresses tenant B's staging project.
          targetProjectId: resolveIntegrationStagingProjectId(scope.tenantId, undefined),
          scope,
          projectNo,
          audit,
          workspaceId: input.workspaceId,
        })
      } catch (error) {
        // A MISS IS STILL A READ, and it is audited as one — values-free, so the trail cannot become
        // the oracle the response refuses to be. Anything that is not the miss is rethrown untouched.
        if (error instanceof StockPreparationProjectBoardError && error.status === 404) {
          await audit.append({
            tenantId: scope.tenantId,
            workspaceId: input.workspaceId,
            action: STOCK_PREPARATION_PROJECT_BOARD_AUDIT_ACTION,
            actor: scope.actorId,
            mode: STOCK_PREPARATION_PROJECT_BOARD_MODES[1],
            detail: {
              operation: 'operator_project_board',
              found: false,
              projectCount: Number.isInteger(error.projectCount) ? error.projectCount : 0,
              tenantClaimVerified: scope.tenantClaimVerified,
            },
          })
        }
        throw error
      }
      // VALUES-FREE AUDIT over a value-bearing response, appended BEFORE the values reach the caller
      // so a refusing audit store means no board is ever sent (H3-0 ③, fail-closed). project_id stays
      // NULL and the projectNo appears nowhere: migration 083 says why that matters most here, on the
      // one route that is ABOUT a single project.
      await audit.append({
        tenantId: scope.tenantId,
        workspaceId: input.workspaceId,
        action: STOCK_PREPARATION_PROJECT_BOARD_AUDIT_ACTION,
        actor: scope.actorId,
        mode: STOCK_PREPARATION_PROJECT_BOARD_MODES[0],
        detail: {
          operation: 'operator_project_board',
          found: true,
          projectCount: outcome.projectCount,
          pendingDecisionCount: outcome.board.pendingDecisionCount,
          fillTargetPresent: outcome.board.fillTarget !== null,
          tenantClaimVerified: scope.tenantClaimVerified,
        },
      })
      return sendOk(res, outcome.board)
    },

    // FOS-2: generic, preset-driven field-option-sync. Admin-gated; resolves a FOS preset from the
    // FOS-1 catalog; validates operator option sets against the preset's source keys; patches each
    // mapped field's options + generic `fieldOptionSync` metadata through the SAME kernel stock-prep
    // uses. Metadata-only (no business-row write, no external system, no K3); values-free evidence.
    // 列映射副驾 PROPOSE — gather the schema signals, ask the governed boundary (dataClass:'business',
    // local-only) to PROPOSE per-column meaning, cross-check against the deterministic discovery. The
    // result is ADVISORY (`authoritativePreset` is always null) and fail-open: an absent / unavailable
    // boundary degrades to manual mapping (aiAvailable:false, manualFallback:true) rather than erroring.
    async schemaMappingCopilotPropose(req, res) {
      requireAccess(req, 'admin')
      const body = requestBody(req)
      const rawSignals = body && typeof body.signals === 'object' && body.signals !== null ? body.signals : body
      let signals
      try {
        signals = schemaMappingCopilot.gatherSchemaSignals({
          tableNames: rawSignals && rawSignals.tableNames,
          columns: rawSignals && rawSignals.columns,
          dictionaryRows: rawSignals && rawSignals.dictionaryRows,
          // Server-held catalog only — the request never supplies preset structure.
          presetCatalog: loadVendorPresetCatalog(),
        })
      } catch (error) {
        if (error instanceof schemaMappingCopilot.SchemaMappingCopilotError) {
          throw new HttpRouteError(400, error.code, error.message, error.details || {})
        }
        throw error
      }
      const tenantId = resolveTenantId(req, body)
      const proposal = await schemaMappingCopilot.proposeColumnMappings({
        governedAi,
        signals,
        env: process.env,
        ...(tenantId ? { meterKey: `tenant:${tenantId}` } : {}),
      })
      return sendOk(res, proposal)
    },

    // 列映射副驾 CONFIRM — take the HUMAN-confirmed semantics and write a DETERMINISTIC vendor preset
    // (the #5385 schema), validated by validateVendorPreset. THIS is the authoritative artifact, NOT the
    // AI text. confirmedBy is SERVER-STAMPED (never request-supplied); the base skeleton is loaded from
    // the server catalog by presetId (never trusted from the request). A confirmed mapping that fails
    // deterministic validation is refused (422) — a confirmation can never write an invalid preset.
    async schemaMappingCopilotConfirm(req, res) {
      const user = requireAccess(req, 'admin')
      const body = requestBody(req)
      // Provenance is server-stamped: reject any request-supplied identity/artifact fields.
      for (const forbidden of ['confirmedBy', 'confirmedAt', 'preset', 'basePreset']) {
        if (body && body[forbidden] !== undefined) {
          throw new HttpRouteError(400, 'SCHEMA_MAPPING_COPILOT_FORBIDDEN_FIELD', `${forbidden} is server-controlled and must not be supplied`, { field: forbidden })
        }
      }
      const presetId = firstString(body && body.presetId)
      if (!presetId) {
        throw new HttpRouteError(400, 'SCHEMA_MAPPING_COPILOT_PRESET_ID_REQUIRED', 'presetId (the detected vendor family) is required', { field: 'presetId' })
      }
      const basePreset = loadVendorPresetCatalog().find((preset) => preset && preset.presetId === presetId)
      if (!basePreset) {
        throw new HttpRouteError(422, 'SCHEMA_MAPPING_COPILOT_PRESET_UNKNOWN', 'presetId is not a known vendor family in the catalog', { presetId })
      }
      const actor = firstString(user.id, user.email)
      if (!actor) {
        throw new HttpRouteError(403, 'SCHEMA_MAPPING_COPILOT_ACTOR_REQUIRED', 'an authenticated actor identity is required to confirm')
      }
      let confirmed
      try {
        confirmed = schemaMappingCopilot.confirmColumnMappingPreset({
          basePreset,
          confirmedSemantics: body && body.confirmedSemantics,
          confirmedBy: actor,
          now: new Date().toISOString(),
        })
      } catch (error) {
        if (error instanceof schemaMappingCopilot.SchemaMappingCopilotError) {
          const status = error.code === schemaMappingCopilot.COPILOT_ERROR_CODES.CONFIRM_PRESET_INVALID ? 422 : 400
          throw new HttpRouteError(status, error.code, error.message, error.details || {})
        }
        throw error
      }
      return sendOk(res, confirmed, 201)
    },

    async fieldOptionsSync(req, res) {
      requireAccess(req, 'admin')
      const input = fieldOptionSyncInput(req, requestBody(req))
      const preset = resolveFieldOptionSyncPreset(input.presetId)
      const provisioning = getFieldOptionSyncProvisioning()
      const optionFields = fieldOptionSyncKernelFields(preset)

      // FOS-4: readiness gate bound per TARGET (not per preset id). Any preset targeting the canonical
      // stock-prep table reuses that table's readiness inspection — so BOTH the v1 (replace) preset and
      // the disable-missing prove-the-path preset are covered without enumerating preset ids. Parity with
      // the stock-prep route: never patch an unprovisioned target (avoids a partial patch / opaque
      // FIELD_PATCH_FAILED). Presets targeting a DIFFERENT table still fail closed until they declare
      // their own readiness binding (a later slice).
      if (preset.targetTable === STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId) {
        const readiness = await inspectStockPreparationCanonicalTarget({ context, projectId: input.projectId, permission: 'admin' })
        if (readiness.ready !== true) {
          throw new HttpRouteError(422, 'FIELD_OPTION_SYNC_TARGET_NOT_READY', 'field-option-sync target is not ready', {
            presetId: preset.presetId,
            targetObjectId: preset.targetTable,
          })
        }
      } else {
        throw new HttpRouteError(422, 'FIELD_OPTION_SYNC_PRESET_NO_READINESS', 'preset target has no readiness binding (presets for other tables are gated to a later slice)', {
          presetId: preset.presetId,
          targetObjectId: preset.targetTable,
        })
      }

      // Reject any operator option-set key the preset does not declare (mirrors stock-prep).
      const allowedSourceKeys = new Set(optionFields.map((field) => field.optionSource.key))
      const unknownSourceKey = Object.keys(input.optionSets).find((key) => !allowedSourceKeys.has(key))
      if (unknownSourceKey) {
        throw new HttpRouteError(422, 'FIELD_OPTION_SYNC_UNKNOWN_SOURCE', 'option set source key is not declared by the preset', {
          presetId: preset.presetId,
          sourceKey: unknownSourceKey,
        })
      }

      // FOS-4b-2: action bindings are DRY-RUN-ONLY. The generic route accepts them ONLY when dryRun:true,
      // and even then NOTHING is written or executed — each binding is validated as a REFERENCE against the
      // registry ∩ preset.permittedActionIds (FOS-4b-1) and previewed. Apply/execute is a separate, later,
      // owner-gated sub-slice. Non-dry-run + action bindings → fail-closed (no write).
      const actionBindingPreview = []
      for (const [sourceKey, rawOptions] of Object.entries(input.optionSets)) {
        if (!Array.isArray(rawOptions)) continue
        for (const option of rawOptions) {
          if (!isPlainObject(option)) continue
          const bindings = Array.isArray(option.actionBindings)
            ? option.actionBindings
            : (Array.isArray(option.actions) ? option.actions : null)
          if (!bindings || bindings.length === 0) continue
          if (!input.dryRun) {
            throw new HttpRouteError(422, 'FIELD_OPTION_SYNC_ACTIONS_DRY_RUN_ONLY', 'action bindings are dry-run-only (set dryRun:true); apply is not yet enabled', {
              presetId: preset.presetId,
              sourceKey,
            })
          }
          for (const binding of bindings) {
            // validates registry-membership + preset-permission + param allowlist; throws (fail-closed) on any miss.
            const normalized = normalizeFieldOptionActionBinding(binding, {
              field: `${sourceKey}.actionBindings`,
              permittedActionIds: preset.permittedActionIds,
            })
            actionBindingPreview.push({
              sourceKey,
              actionId: normalized.actionId,
              kind: normalized.kind,
              requiresDryRun: normalized.requiresDryRun,
              requiredPermission: normalized.requiredPermission,
              parameterBindingCount: Object.keys(normalized.parameterBindings).length,
            })
          }
        }
      }

      // Reuse the per-option safety normalization (executable-key / secret / placeholder rejection,
      // color/order/label/disabled, dedup, max-options). Throws OPTION_SYNC_* (422, values-free).
      // dry-run strips action bindings first (actions are validated above via the FOS-4b-1 registry, not
      // the stock-prep path); non-dry-run uses the raw input unchanged (zero-drift).
      const optionSets = optionSetsFromInput(
        input.dryRun ? stripActionBindingsFromOptionSets(input.optionSets) : input.optionSets,
      )

      // FOS-4b-2: dry-run mode validates everything (options above + action references) and PREVIEWS what
      // WOULD sync — writing NOTHING (no patchObjectFieldProperty). Apply is a separate gated sub-slice.
      if (input.dryRun) {
        return sendOk(res, {
          ok: true,
          dryRun: true,
          written: false,
          target: { presetId: preset.presetId, targetTable: preset.targetTable },
          preview: {
            fields: optionFields
              .filter((field) => optionSets[field.optionSource.key])
              .map((field) => ({
                field: field.id,
                sourceKey: field.optionSource.key,
                optionCount: optionSets[field.optionSource.key].options.length,
              })),
            actionBindings: actionBindingPreview, // values-free: actionId/kind/gating/param-count only
          },
        })
      }

      const { synced, skipped, held } = await syncFieldOptions({
        provisioning,
        projectId: input.projectId,
        targetObjectId: preset.targetTable,
        optionFields,
        optionSets,
        // FOS-2b: drive the preset's sync semantics. replace + update_from_source = the FOS-2 fast path
        // (no read, no merge). Other modes read current options via the (read-only) getObjectField.
        syncMode: preset.syncMode,
        conflictPolicy: preset.conflictPolicy,
        readCurrentOptions: async (field) => {
          const current = await provisioning.getObjectField({
            projectId: input.projectId,
            objectId: preset.targetTable,
            fieldId: field.id,
          })
          return current && current.property && Array.isArray(current.property.options)
            ? current.property.options
            : []
        },
        buildPropertyPatch: (field, set) => ({
          options: set.options.map((option) => {
            const out = { value: option.value }
            if (option.label) out.label = option.label
            if (option.color) out.color = option.color
            if (option.disabled) out.disabled = true
            return out
          }),
          fieldOptionSync: {
            presetId: preset.presetId,
            sourceKey: field.optionSource.key,
            optionCount: set.options.length,
          },
        }),
        resolveSkipReason: () => 'source_not_supplied',
        errorFactory: {
          patchFailed: ({ field, sourceKey, error }) =>
            new HttpRouteError(422, 'FIELD_OPTION_SYNC_FIELD_PATCH_FAILED', 'failed to patch field option metadata', {
              presetId: preset.presetId,
              field,
              sourceKey,
              errorCode: (error && (error.code || error.name)) || 'FIELD_PATCH_FAILED',
            }),
          noFieldsSynced: ({ skipped: skippedEntries }) =>
            new HttpRouteError(422, 'FIELD_OPTION_SYNC_NO_FIELDS', 'no preset option fields were synchronized', {
              presetId: preset.presetId,
              skipped: skippedEntries.map((entry) => ({ field: entry.field, reason: entry.reason })),
            }),
        },
      })

      return sendOk(res, {
        ok: true,
        // FOS-2b: manual_confirm produces a values-free preview (held) and writes NOTHING.
        held: held.length > 0,
        target: {
          presetId: preset.presetId,
          targetTable: preset.targetTable,
          fieldCount: synced.length,
          heldFieldCount: held.length,
        },
        evidence: summarizeFieldOptionSyncEvidence({ preset, synced, skipped }),
        // held entries are values-free: { field, optionSource:{key,type}, wouldAdd, wouldUpdate, wouldDisable }
        heldEvidence: held,
      })
    },

    async templatesPreview(req, res) {
      requireAccess(req, 'write')
      const body = requestBody(req)
      // DF-T3b-2b: when the request names referenceMappingSources, LIVE bulk-read each domain's mapping
      // sheet via the staging source-adapter (read-only) and feed the #2063 referenceMappingIndexes seam,
      // so from_reference_table resolves per-material in the preview. No sources → unchanged behavior.
      const sources = normalizeReferenceMappingSources(body.referenceMappingSources)
      let previewOptions = {}
      if (sources.length > 0) {
        const loadSystem = typeof externalSystems.getExternalSystemForAdapter === 'function'
          ? externalSystems.getExternalSystemForAdapter.bind(externalSystems)
          : externalSystems.getExternalSystem.bind(externalSystems)
        const referenceMappingIndexes = {}
        const adapterBySystem = new Map()
        for (const source of sources) {
          let adapter = adapterBySystem.get(source.systemId)
          if (!adapter) {
            const system = await loadSystem(scopedAdapterInput(req, { id: source.systemId }))
            // P1: fail-closed BEFORE createAdapter — ONLY a metasheet:staging source may back a mapping
            // sheet. Otherwise the preview becomes an arbitrary-adapter read() entry point: a caller
            // pointing at a K3 / other external system would trigger an external read instead of a
            // read-only workspace mapping-sheet read (the slice's whole boundary).
            if (!system || system.kind !== 'metasheet:staging') {
              throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `referenceMappingSources must reference a metasheet:staging system (systemId ${source.systemId} is ${(system && system.kind) || 'unknown'})`, { field: 'referenceMappingSources' })
            }
            adapter = adapterRegistry.createAdapter(system)
            adapterBySystem.set(source.systemId, adapter)
          }
          const template = K3_REFERENCE_MAPPING_TEMPLATES.find((t) => t.domain === source.domain)
          if (!template) {
            throw new HttpRouteError(400, 'INVALID_TEMPLATE_PREVIEW', `unknown reference mapping domain: ${source.domain}`, { field: 'referenceMappingSources' })
          }
          Object.assign(referenceMappingIndexes, await buildReferenceMappingIndexes(adapter, [{ domain: source.domain, object: source.object, template }]))
        }
        previewOptions = { referenceMappingIndexes }
      }
      return sendOk(res, buildTemplatePreview(body, previewOptions))
    },

    // DF-T2c: read-only derive — run the DF-T2a helper on an operator-supplied (raw, operator-local)
    // payloadTemplate and return the draft { payloadTemplate, fieldRules, gatedFields }. Pure compute:
    // no external call, no write, no K3. Fails closed (400) on a redaction marker / unfilled
    // placeholder / secret-shaped value / outer {Data:…} envelope — the DF-T2a guards.
    async templatesDerive(req, res) {
      requireAccess(req, 'read')
      const body = requestBody(req)
      if (!isPlainObject(body.payloadTemplate)) {
        throw new HttpRouteError(400, 'PAYLOAD_TEMPLATE_REQUIRED', 'payloadTemplate (an object) is required')
      }
      try {
        const draft = deriveK3MaterialTemplateDraft(body.payloadTemplate)
        // P1: do NOT echo the raw payloadTemplate (operator-local customer values) in the response.
        // Return the rules + gated field names + a VALUES-FREE evidence summary only.
        return sendOk(res, {
          fieldRules: draft.fieldRules,
          gatedFields: draft.gatedFields,
          evidence: summarizeTemplateForEvidence(draft),
        })
      } catch (error) {
        if (error instanceof TemplateDeriveError) {
          throw new HttpRouteError(400, 'TEMPLATE_DERIVE_REJECTED', error.message, {
            reason: error.details && error.details.reason,
          })
        }
        throw error
      }
    },

    async stagingDescriptors(req, res) {
      requireAccess(req, 'read')
      return sendOk(res, await stagingInstaller.listStagingDescriptors())
    },

    async stagingInstall(req, res) {
      requireAccess(req, 'write')
      const body = requestBody(req)
      const query = requestQuery(req)
      // GHSA-m6qv-2rpf-q7mh step-1 follow-up: staging-install is a tenant-scoped STRUCTURE write (it
      // installs the staging sheets), so it must derive tenant/target SERVER-SIDE, never from the request
      // — a tenantless platform admin may explicitly select a read tenant, but no write may inherit that
      // request-selected scope; resolveIntegrationStagingProjectId also returns a request projectId verbatim,
      // and an explicit baseId is the third axis (host writes base_id with no ownership check). Reject an
      // explicit baseId (body OR query) fail-closed BEFORE provisioning.
      assertNoRequestBaseId(body)
      assertNoRequestBaseId(query)
      const tenantId = resolveAuthUserTenantId(req)
      const projectId = resolveIntegrationStagingProjectId(tenantId, undefined)
      return sendOk(res, await stagingInstaller.installStaging(scopedInput(req, {
        tenantId,
        workspaceId: body.workspaceId,
        projectId,
      })), 201)
    },

    async stockPreparationSqlServerSealedSnapshotRun(req, res) {
      const user = requireAccess(req, 'admin')
      if (
        !stockPreparationSqlServerRuntime
        || typeof stockPreparationSqlServerRuntime.run !== 'function'
      ) {
        throw new HttpRouteError(
          404,
          'STOCK_PREPARATION_SQLSERVER_SEALED_SNAPSHOT_DISABLED',
          'stock-preparation sealed-snapshot runtime is not enabled',
        )
      }
      const input = stockPreparationSqlServerRunInput(req)
      const actor = firstString(user.id, user.email)
      if (!actor) {
        throw new HttpRouteError(
          403,
          'STOCK_PREPARATION_SQLSERVER_SEALED_SNAPSHOT_ACTOR_REQUIRED',
          'an authenticated actor identity is required',
        )
      }
      const sealedSnapshotTenantId = resolveAuthUserTenantId(req)
      // B2a ENTRY POINT (4): the sealed-snapshot SQL Server session.
      //
      // Gated at the ROUTE, before `run(...)`, which is the last point outside the sealed-export
      // tree. Everything after this line — loading the active binding, decrypting its credentials,
      // opening the mssql pool — happens inside `lib/sealed-export/stock-preparation-runtime-core`,
      // so a fence there would be a change to a digest-pinned module with its own manifest to
      // re-pin.
      //
      // THIS GUARD IS WEAKER THAN THE OTHER THREE, and the weakness is named rather than papered
      // over: the runtime resolves its OWN active binding internally, so at this point the route
      // cannot know which external system the session will open. `sourceBindingRef` is therefore a
      // SENTINEL, and a registration for this purpose authorizes the SESSION for a tenant, purpose
      // and data scope without pinning the binding instance. Closing that gap means threading the
      // registry into the runtime's validated dep list inside the pinned sealed-export tree — a
      // change with its own blast radius, deliberately not ridden along here.
      //
      // The `operationId` IS the Run identity, which is the right boundary: the sealed-snapshot
      // runtime already treats one operation as one capture, so re-driving the same operation
      // continues on its claim while a new operation needs its own registration.
      await assertB2aReadAuthorization({
        registry: b2aTrialRegistry,
        store: context.storage,
        operationClaim: b2aOperationClaim,
        tenantScope: sealedSnapshotTenantId,
        // Pinned by the sealed-snapshot authority module, which refuses any other kind.
        sourceSystemType: 'data-source:sql-readonly',
        sourceBindingRef: SEALED_SNAPSHOT_BINDING_REF,
        dataScopeRef: SEALED_SNAPSHOT_OBJECT_KEY,
        sourceObjects: [SEALED_SNAPSHOT_OBJECT_KEY],
        purpose: B2A_PURPOSE_SEALED_SNAPSHOT_SQLSERVER,
        runId: `sealed-snapshot:${input.operationId}`,
        now: Date.now(),
      })
      return sendOk(res, await stockPreparationSqlServerRuntime.run({
        actor,
        operationId: input.operationId,
        tenantId: sealedSnapshotTenantId,
        workspaceId: null,
      }))
    },

    async runsList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      return sendOk(res, await pipelineRegistry.listPipelineRuns(scopedInput(req, {
        pipelineId: query.pipelineId,
        status: query.status,
        limit: asListLimit(query.limit),
        offset: asListOffset(query.offset),
      })))
    },

    // DF-N2-2c: read-only by-rowId provenance timeline (cross-run). Reads the
    // migration-060 view via pipelineRegistry.listProvenanceByRow. No write/replay.
    // listProvenanceByRow is intentionally NOT in requireService (optional-method 501,
    // like deadLettersReplay) so older host wiring isn't broken silently.
    async provenanceByRow(req, res) {
      requireAccess(req, 'read')
      if (typeof pipelineRegistry.listProvenanceByRow !== 'function') {
        throw new HttpRouteError(501, 'PROVENANCE_READ_NOT_IMPLEMENTED', 'Provenance read is not implemented')
      }
      const query = requestQuery(req)
      const rowId = firstString(query.rowId)
      if (!rowId) {
        throw new HttpRouteError(400, 'ROW_ID_REQUIRED', 'rowId is required')
      }
      return sendOk(res, await pipelineRegistry.listProvenanceByRow(scopedInput(req, {
        rowId,
        pipelineId: query.pipelineId,
        from: query.from,
        to: query.to,
        limit: asListLimit(query.limit),
        offset: asListOffset(query.offset),
      })))
    },

    async deadLettersList(req, res) {
      requireAccess(req, 'read')
      const query = requestQuery(req)
      const fullPayload = isAdmin(getUser(req)) && query.includePayload === 'true'
      const rows = await deadLetters.listDeadLetters(scopedInput(req, {
        pipelineId: query.pipelineId,
        runId: query.runId,
        status: query.status,
        limit: asListLimit(query.limit),
        offset: asListOffset(query.offset),
      }))
      return sendOk(res, rows.map((row) => redactDeadLetter(row, fullPayload)))
    },

    async deadLettersReplay(req, res) {
      requireAccess(req, 'write')
      if (typeof runner.replayDeadLetter !== 'function') {
        throw new HttpRouteError(501, 'REPLAY_NOT_IMPLEMENTED', 'Dead-letter replay is not implemented')
      }
      const body = requestBody(req)
      // H-4 (external review finding 4): on an armed deployment a live artifact replay is refused
      // outright. §6.1's `artifactReplayLimit` defaults to 0 and this cut refuses any non-zero value at
      // config load, so no registration permits replaying a stored artifact — the one-shot claim the
      // read fence would take is on the source-read OPERATION, never on the artifact, which is the
      // finding. This SHADOWS the read/E3-01 write fences the ordinary run route runs for replay: an
      // armed replay never reaches a source read, a claim, a marker or the runner, so none of that is
      // set up here. The runner's own `replayDeadLetter` re-asserts it (the cross-plugin door). Refused
      // FIRST, before the dead-letter row read, so nothing is spent. Dormant is byte-identical: the
      // replay proceeds with no markers, exactly as it did before any B2a fence existed.
      if (b2aTrialRegistry) {
        refuseB2aArtifactReplayNotAuthorized()
      }
      const replayInput = scopedInput(req, {
        tenantId: body.tenantId,
        workspaceId: body.workspaceId,
        mode: body.mode,
        id: requestParams(req).id,
        triggeredBy: 'api',
        runAs: 'user',
      })
      return sendOk(res, await runner.replayDeadLetter(replayInput), 202)
    },
  }

  return handlers
}

function registerIntegrationRoutes({ context, services, logger } = {}) {
  if (!context || !context.api || !context.api.http || typeof context.api.http.addRoute !== 'function') {
    throw new Error('registerIntegrationRoutes: context.api.http.addRoute is required')
  }
  const handlers = createHandlers(services || {}, { context, logger })
  const registered = []
  const routeDefinitions = services
    && services.stockPreparationSqlServerRuntime
    ? [...ROUTES, STOCK_PREPARATION_SQLSERVER_RUNTIME_ROUTE]
    : ROUTES
  for (const [method, path, handlerName] of routeDefinitions) {
    const handler = handlers[handlerName]
    context.api.http.addRoute(method, path, async (req, res) => {
      try {
        return await handler(req, res)
      } catch (error) {
        if (logger && typeof logger.warn === 'function' && !(error instanceof HttpRouteError)) {
          logger.warn(`[plugin-integration-core] route failed: ${method} ${path}`)
        }
        return sendError(res, error)
      }
    })
    registered.push(`${method} ${path}`)
  }
  return registered
}

module.exports = {
  ROUTES,
  STOCK_PREPARATION_SQLSERVER_RUNTIME_ROUTE,
  HttpRouteError,
  MAX_LIST_LIMIT,
  MAX_LIST_OFFSET,
  MAX_SAMPLE_LIMIT,
  createHandlers,
  registerIntegrationRoutes,
  VALID_USER_RUN_MODES,
  __internals: {
    buildTemplatePreview,
    buildTargetPayloadPreview,
    hasPermission,
    requireAccess,
    resolveTenantId,
    resolveAuthUserTenantId,
    resolveAuthenticatedWriteTenantId,
    scopedAuthenticatedWriteInput,
    scopedInput,
    sendError,
    inferHttpStatus,
    publicRunInput,
    redactDeadLetter,
    asSampleLimit,
    asListOffset,
    asListLimit,
    asPositiveInt,
    redactSecretText,
    sanitizeTestConnectionResult,
    stockPreparationExportFilename,
    stockPreparationExportSheetName,
    stockPreparationExportSafeToken,
    stockPreparationExportTimestamp,
  },
}
