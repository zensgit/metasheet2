'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料分批拉取第一期 step 3 PR B — PILOT READINESS (plan §3.1 (4) 目标表就绪, §7 G1–G10, §9.5 U05).
//
// "Code deployed" is not "pilot enabled": a project may be marked pilot only while EVERY check below
// passes, and the list is deliberately longer than what this PR can satisfy. Several checks ask for
// things later PRs land (the step-4 stores, the continuation-aware planner, the generic-writer probe);
// until they do, those checks FAIL CLOSED and the enable route answers 409 STOCK_PREP_PILOT_NOT_READY
// listing their ids — so enabling is impossible on a real deployment before the whole phase is on the
// build (step-4 design D-21 / D-22). That is intended, not a gap.
//
// VALUES-FREE: a readiness answer is `{ version, ready, checks: [{ id, ok }], failing: [id] }` — check
// ids from the closed list below, booleans, one integer. No sheet id, field name, lease id, pipeline
// name or table name leaves this module in an answer.
//
// EVERY CHECK IS ONE PROBE THAT CAN ONLY ANSWER TRUE BY POSITIVE EVIDENCE: a probe that throws, a host
// surface that is absent, a read that degrades to "computed" instead of "from the database" all read
// as NOT ok. Nothing here writes.
//
// THE LIST (PILOT_READINESS_VERSION 3 — version 1 was the first fifteen; the pre-enable hardening of step-4
// design §23.4 F-3 / F-5 added the three marked ★ (version 2); version 3 (#6324 S1/N4) makes
// spec_read_plan_slot also require the effective online plan's slot while online read plans are ON. Every
// version change only ever refuses more):
//   registry_row_active            the registry row exists, is active and names this sheet / objectId
//   sheet_present                  the host finds the sheet for (staging project, objectId) and it IS this sheet
//   target_fields_present          every template column resolves on the sheet, from the database (not computed)
//   plm_column_lock                every plm_system column carries humanWriteLock 'plm_system' (read-only check)
//   contract_option_sets           every contract select column carries a non-empty option list
//   views_present                  the fill view and the to-fill view exist
//   single_project_on_sheet        no other project's active rows sit on the sheet (foreign-project guard)
// ★ no_two_copy_component          no component of the project is held on the sheet BOTH as an active root row
//                                  (blank parentSourceId) AND as an active nested row (non-blank parentSourceId):
//                                  such a "two-copy" sheet goes through the step-6 repair first (O-6). "Active"
//                                  and "root" are the continuation core's own predicates (active !== false — the
//                                  wider reading; refuses more than the fill view's), keyless rows included
//   write_lock_store_readable      the sheet write lock row can be read (migration 100 present)
//   write_lock_free                no LIVE lease on the sheet (an expired one is cleared by the enable's bump)
// ★ no_open_large_job              no checkpoint-apply job that targets this sheet is still OPEN (queued, paused,
//                                  failed, running, or any status that is not terminal) and none is
//                                  unattributable; the job store must answer (F-3). A job half-landed across an
//                                  enablement can be neither resumed (the pilot gate refuses the large lane) nor
//                                  closed (there is no apply-job cancel) — runbook 旧作业处置
//   export_closure_port            the host offers closeSheetGridExport + getSheetGridExportClosure (#6507)
//                                  and can READ this sheet's closure (so a stamp can land where the resolvers look)
//   continuation_store_readable    the step-4 continuation table is readable      ← step 4 PR-2
//   refresh_state_store_readable   the step-4 refresh-state table is readable     ← step 4 PR-2
//   spec_read_plan_slot            server config declares the 规格 column not applicable, or EVERY read plan the
//                                  project can execute declares it: the deployment plan and, with online read
//                                  plans ON, the effective one (`specSlotReadPlans`; S1 N4 — only refuses more)
//                                  (never guessed)                                  ← step-4 refuter B-M8
// ★ pack_columns_installed         EITHER the action declares at least one `ext_` column (`extensionFieldIds`)
//                                  and EVERY declared column is installed on THIS sheet — listed live by the
//                                  pack-install ledger for (tenant, staging project, objectId) AND present on the
//                                  host (the same two facts the planner's `installedFieldProperties` is built
//                                  from) — OR server config declares the customer pack not applicable
//                                  (`stockPreparationPilot.customerPack: 'not_applicable'`), the action declares
//                                  no `ext_` column and the ledger lists no live pack column on the sheet. Never
//                                  guessed; both reads must answer (O-8: a declared pack column installed after a
//                                  continuation is confirmed would leave it evidence_incomplete with no confirm)
//   no_generic_writer_names_sheet  no external-system object config and no pipeline's erp-feedback option
//                                  names this sheet or objectId (and both registries answered) ← step 4 PR-6
//   continuation_support_version   the plugin build recognises continuations    ← flipped by the LAST PR of the
//                                  D-22 set (PR-3a, PR-3b, PR-4, PR-5, PR-6, PR-8, step 6); still 0 after PR-3b
// ---------------------------------------------------------------------------------------------------

const { resolveFieldExistence } = require('./stock-preparation-target-provisioning.cjs')
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')
const { templateContractOptionFields } = require('./stock-preparation-option-sync.cjs')
const {
  projectSheetViewHandles,
  readProjectSheetPlmSystemColumnLock,
} = require('./stock-preparation-project-targets.cjs')

// THE CONTINUATION MARKER lives in its own module (read at evaluation time, see its header): the LAST PR of
// the D-22 set (step 4 PR-3a / PR-3b — the governance consult on every lane, the planner projection, whole-
// pull suspension, the large-lane refusal — plus PR-4, PR-5, PR-6, PR-8 and step 6) flips it to REQUIRED,
// never ahead. PR-3a and PR-3b leave it 0, so readiness still refuses every enable by construction (D-22).
const continuationSupport = require('./stock-preparation-continuation-support.cjs')
// O-6: the continuation core's own "active" / "root" predicates (see no_two_copy_component above).
const { __internals: { isActiveRow, isRootRow } } = require('./stock-preparation-continuation-pairing.cjs')

const PILOT_READINESS_VERSION = 3
const REQUIRED_CONTINUATION_SUPPORT_VERSION = 1

// The step-4 stores whose readability readiness probes (step-4 design §4.1 / §4.2). PR-2 names them;
// if it names them differently it updates these two literals with its migration.
const STEP4_STORE_TABLES = Object.freeze({
  continuation: 'integration_stock_prep_continuation',
  refreshState: 'integration_stock_prep_refresh_state',
})

// Server config (NOT an env flag): `stockPreparationPilot.specReadPlanSlot` with the exact literal
// 'not_applicable' declares that this deployment's source has no 规格 column to read. Anything else
// declares nothing.
const SPEC_READ_PLAN_SLOT_NOT_APPLICABLE = 'not_applicable'

// Server config (NOT an env flag), F-5 / O-8: `stockPreparationPilot.customerPack` with the exact literal
// 'not_applicable' declares that this deployment runs without a customer pack (no `ext_` columns). Anything
// else declares nothing.
const CUSTOMER_PACK_NOT_APPLICABLE = 'not_applicable'

const PILOT_READINESS_CHECK_IDS = Object.freeze([
  'registry_row_active',
  'sheet_present',
  'target_fields_present',
  'plm_column_lock',
  'contract_option_sets',
  'views_present',
  'single_project_on_sheet',
  'no_two_copy_component',
  'write_lock_store_readable',
  'write_lock_free',
  'no_open_large_job',
  'export_closure_port',
  'continuation_store_readable',
  'refresh_state_store_readable',
  'spec_read_plan_slot',
  'pack_columns_installed',
  'no_generic_writer_names_sheet',
  'continuation_support_version',
])

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function templateFieldIds() {
  return normalizeStockPreparationTemplate(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE).fields.map((field) => field.id)
}

/**
 * The generic configured writers of ANY sheet (step-4 design F41): external systems of kind
 * `metasheet:multitable` (object config names a sheetId per object) and pipelines whose erp-feedback
 * options name an objectId / staging sheet. Answered from the two registries for the tenant — the
 * tenant-wide (null-workspace) rows plus, when a workspace is given, that workspace's rows; the two
 * registries list the way their own routes list. `complete: false` when either registry is not wired or
 * fails: the check then refuses (fail closed) rather than claiming nobody writes the sheet.
 */
async function collectGenericWriterTargets({ externalSystemRegistry, pipelineRegistry, tenantId, workspaceId } = {}) {
  const sheetIds = new Set()
  const objectIds = new Set()
  const tenant = nonEmptyString(tenantId)
  if (!tenant || !externalSystemRegistry || typeof externalSystemRegistry.listExternalSystems !== 'function'
    || !pipelineRegistry || typeof pipelineRegistry.listPipelines !== 'function') {
    return { complete: false, sheetIds, objectIds }
  }
  const workspace = nonEmptyString(workspaceId)
  const scopes = workspace ? [{ tenantId: tenant, workspaceId: workspace }, { tenantId: tenant }] : [{ tenantId: tenant }]
  try {
    for (const scope of scopes) {
      const systems = await externalSystemRegistry.listExternalSystems({ ...scope, kind: 'metasheet:multitable', limit: 10000 })
      for (const system of Array.isArray(systems) ? systems : []) {
        const objects = system && isPlainObject(system.config) && isPlainObject(system.config.objects) ? system.config.objects : {}
        for (const [objectId, objectEntry] of Object.entries(objects)) {
          if (nonEmptyString(objectId)) objectIds.add(objectId.trim())
          if (isPlainObject(objectEntry) && nonEmptyString(objectEntry.sheetId)) sheetIds.add(objectEntry.sheetId.trim())
        }
      }
      const pipelines = await pipelineRegistry.listPipelines({ ...scope, limit: 10000 })
      for (const pipeline of Array.isArray(pipelines) ? pipelines : []) {
        if (!isPlainObject(pipeline)) continue
        const feedback = isPlainObject(pipeline.options) && isPlainObject(pipeline.options.erpFeedback) ? pipeline.options.erpFeedback : {}
        for (const candidate of [pipeline.stagingObjectId, feedback.objectId, feedback.stagingObjectId, pipeline.targetObject]) {
          if (nonEmptyString(candidate)) objectIds.add(candidate.trim())
        }
        if (nonEmptyString(pipeline.stagingSheetId)) sheetIds.add(pipeline.stagingSheetId.trim())
      }
    }
  } catch (error) {
    return { complete: false, sheetIds, objectIds }
  }
  return { complete: true, sheetIds, objectIds }
}

/**
 * O-6: how many components the project holds on the sheet BOTH as an active root row and as an active nested
 * row. Rows are the project-scoped read's logical rows; a row without a non-blank string componentSourceId
 * cannot be grouped and is skipped. Values-free: one integer.
 */
function countTwoCopyComponents(rows) {
  const roots = new Set()
  const nested = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isActiveRow(row)) continue
    const component = row && typeof row.componentSourceId === 'string' && row.componentSourceId.trim() !== '' ? row.componentSourceId : null
    if (!component) continue
    if (isRootRow(row)) roots.add(component)
    else nested.add(component)
  }
  let count = 0
  for (const component of roots) if (nested.has(component)) count += 1
  return count
}

/**
 * O-8: the pack facts for ONE sheet, read STRICTLY — unlike loadPackInstalledFieldProperties, which degrades
 * every failure to "no pack" by design (the refresh falls back to legacy bands), a readiness probe must not
 * read a failure as an answer. Throws when the ledger or the host cannot answer.
 *   declared  the action's `extensionFieldIds` (null when the config value is not a list of strings)
 *   ledger    the ledger's live field ids and pack ids for (tenant, staging project, objectId)
 *   live      the subset of `declared` the host returns a field for on this sheet
 */
async function readPackColumnFacts({ action, packInstallStore, provisioning, tenantId, projectId, objectId } = {}) {
  const raw = isPlainObject(action) && action.extensionFieldIds !== undefined ? action.extensionFieldIds : []
  const declared = Array.isArray(raw) && raw.every((id) => nonEmptyString(id) !== null) ? raw.map((id) => id.trim()) : null
  if (!packInstallStore || typeof packInstallStore.listInstalledFieldIds !== 'function') throw new Error('pack install ledger unavailable')
  const ledger = await packInstallStore.listInstalledFieldIds({ tenantId, projectId, objectId })
  if (!isPlainObject(ledger) || !Array.isArray(ledger.fieldIds) || !Array.isArray(ledger.packIds)) throw new Error('pack install ledger answered no lists')
  const live = new Set()
  if (declared && declared.length > 0) {
    if (!provisioning || typeof provisioning.readObjectFieldsContent !== 'function') throw new Error('host field read unavailable')
    const content = await provisioning.readObjectFieldsContent({ projectId, objectId, fieldIds: [...declared] })
    if (!isPlainObject(content)) throw new Error('host field read answered no map')
    for (const fieldId of declared) if (isPlainObject(content[fieldId])) live.add(fieldId)
  }
  return { declared, ledgerFieldIds: new Set(ledger.fieldIds), ledgerPackCount: ledger.packIds.length, live }
}

// Each check: (deps) => boolean | Promise<boolean>. A throw is `ok: false`.
const CHECKS = Object.freeze({
  registry_row_active(deps) {
    const row = deps.row
    return Boolean(row && row.status === 'active'
      && nonEmptyString(row.sheetId) && row.sheetId === deps.sheetId
      && nonEmptyString(row.objectId) && row.objectId === deps.objectId)
  },
  async sheet_present(deps) {
    const provisioning = deps.provisioning
    if (!provisioning || typeof provisioning.findObjectSheet !== 'function') return false
    const sheet = await provisioning.findObjectSheet({ projectId: deps.projectId, objectId: deps.objectId })
    return Boolean(sheet && nonEmptyString(sheet.id) && sheet.id === deps.sheetId)
  },
  async target_fields_present(deps) {
    const provisioning = deps.provisioning
    if (!provisioning || typeof provisioning.resolveExistingObjectFieldIds !== 'function') return false
    const fieldIds = templateFieldIds()
    const verdict = await resolveFieldExistence({ provisioning, projectId: deps.projectId, objectId: deps.objectId, fieldIds })
    if (!verdict || verdict.fieldExistenceMode !== 'db' || !isPlainObject(verdict.resolved)) return false
    return fieldIds.every((fieldId) => nonEmptyString(verdict.resolved[fieldId]) !== null)
  },
  async plm_column_lock(deps) {
    const lock = await readProjectSheetPlmSystemColumnLock({ provisioning: deps.provisioning, projectId: deps.projectId, objectId: deps.objectId })
    return Boolean(lock && lock.readBeforeWrite === true && lock.fieldCount > 0 && lock.marked === lock.fieldCount && lock.missing === 0)
  },
  async contract_option_sets(deps) {
    const provisioning = deps.provisioning
    if (!provisioning || typeof provisioning.getObjectField !== 'function') return false
    const template = normalizeStockPreparationTemplate(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
    const fields = templateContractOptionFields(template)
    if (fields.length === 0) return false
    for (const field of fields) {
      const current = await provisioning.getObjectField({ projectId: deps.projectId, objectId: deps.objectId, fieldId: field.id })
      const options = current && isPlainObject(current.property) ? current.property.options : null
      if (!Array.isArray(options) || options.length === 0) return false
    }
    return true
  },
  views_present(deps) {
    const handles = projectSheetViewHandles({ provisioning: deps.provisioning, projectId: deps.projectId, objectId: deps.objectId })
    return Boolean(handles && nonEmptyString(handles.viewId) && nonEmptyString(handles.todoViewId))
  },
  async single_project_on_sheet(deps) {
    if (typeof deps.assertTargetSheetHoldsNoForeignActiveRows !== 'function' || !deps.recordsApi || !deps.target) return false
    await deps.assertTargetSheetHoldsNoForeignActiveRows(deps.recordsApi, deps.target, deps.projectNo)
    return true
  },
  async no_two_copy_component(deps) {
    // The project-scoped read the planner itself plans from (same page bounds; past them it throws ⇒ false).
    if (typeof deps.readExistingStockPreparationRows !== 'function' || !deps.recordsApi || !deps.target || !nonEmptyString(deps.projectNo)) return false
    const rows = await deps.readExistingStockPreparationRows(deps.recordsApi, deps.target, deps.projectNo)
    if (!Array.isArray(rows)) return false
    return countTwoCopyComponents(rows) === 0
  },
  async write_lock_store_readable(deps) {
    if (!deps.lock || typeof deps.lock.readState !== 'function' || !nonEmptyString(deps.writeScope)) return false
    const state = await deps.lock.readState(deps.writeScope)
    return Boolean(state)
  },
  async write_lock_free(deps) {
    if (!deps.lock || typeof deps.lock.readState !== 'function' || !nonEmptyString(deps.writeScope)) return false
    const state = await deps.lock.readState(deps.writeScope)
    return Boolean(state) && state.leaseLive !== true
  },
  async no_open_large_job(deps) {
    // `countOpenLargeJobs` = the large-BOM job store's own scan for this sheet
    // (countOpenLargeBomCheckpointApplyJobsForSheet); an unreadable store throws ⇒ false.
    if (typeof deps.countOpenLargeJobs !== 'function') return false
    const scan = await deps.countOpenLargeJobs()
    return isPlainObject(scan) && scan.open === 0 && scan.unattributed === 0
  },
  async export_closure_port(deps) {
    const provisioning = deps.provisioning
    if (!provisioning || typeof provisioning.closeSheetGridExport !== 'function' || typeof provisioning.getSheetGridExportClosure !== 'function') return false
    const closure = await provisioning.getSheetGridExportClosure({ projectId: deps.projectId, sheetId: deps.sheetId, objectId: deps.objectId })
    return Boolean(closure && closure.present === true && closure.sheetId === deps.sheetId)
  },
  async continuation_store_readable(deps) {
    if (typeof deps.probeTableReadable !== 'function') return false
    const probe = await deps.probeTableReadable(STEP4_STORE_TABLES.continuation)
    return Boolean(probe && probe.readable === true)
  },
  async refresh_state_store_readable(deps) {
    if (typeof deps.probeTableReadable !== 'function') return false
    const probe = await deps.probeTableReadable(STEP4_STORE_TABLES.refreshState)
    return Boolean(probe && probe.readable === true)
  },
  async spec_read_plan_slot(deps) {
    // The explicit not-applicable declaration answers first, without asking for any plan.
    if (deps.specReadPlanSlotDeclaration === SPEC_READ_PLAN_SLOT_NOT_APPLICABLE) return true
    // Without the optional `specSlotReadPlans` the deployment action's own plan decides, as it always did.
    const plans = typeof deps.specSlotReadPlans === 'function'
      ? await deps.specSlotReadPlans()
      : [deps.action && isPlainObject(deps.action.source) ? deps.action.source.readPlan : null]
    return Array.isArray(plans) && plans.length > 0
      && plans.every((readPlan) => isPlainObject(readPlan) && isPlainObject(readPlan.part) && nonEmptyString(readPlan.part.specField) !== null)
  },
  async pack_columns_installed(deps) {
    const facts = await readPackColumnFacts({
      action: deps.action,
      packInstallStore: deps.packInstallStore,
      provisioning: deps.provisioning,
      tenantId: deps.tenantId,
      projectId: deps.projectId,
      objectId: deps.objectId,
    })
    if (!facts.declared) return false
    if (deps.customerPackDeclaration === CUSTOMER_PACK_NOT_APPLICABLE) {
      // Declared not applicable: only true while the facts agree — nothing declared, nothing installed.
      return facts.declared.length === 0 && facts.ledgerFieldIds.size === 0 && facts.ledgerPackCount === 0
    }
    if (facts.declared.length === 0) return false
    return facts.declared.every((fieldId) => facts.ledgerFieldIds.has(fieldId) && facts.live.has(fieldId))
  },
  async no_generic_writer_names_sheet(deps) {
    if (typeof deps.collectGenericWriterTargets !== 'function') return false
    const targets = await deps.collectGenericWriterTargets()
    if (!targets || targets.complete !== true) return false
    return !targets.sheetIds.has(deps.sheetId) && !targets.objectIds.has(deps.objectId)
  },
  continuation_support_version() {
    const version = continuationSupport.CONTINUATION_SUPPORT_VERSION
    return Number.isInteger(version) && version >= REQUIRED_CONTINUATION_SUPPORT_VERSION
  },
})

/**
 * Run every check; never throws. `deps` (all server-held, nothing from a request):
 *   row, sheetId, objectId, projectId, projectNo, tenantId, action, target, recordsApi, provisioning,
 *   assertTargetSheetHoldsNoForeignActiveRows, readExistingStockPreparationRows, lock, writeScope,
 *   countOpenLargeJobs, probeTableReadable, specReadPlanSlotDeclaration, packInstallStore,
 *   customerPackDeclaration, collectGenericWriterTargets
 * and, optionally, specSlotReadPlans: `async () => [readPlan, ...]` — every read plan spec_read_plan_slot must find
 * the 规格 column in (absent: the action's own plan; a throw or an empty list is not ok).
 */
async function evaluatePilotReadiness(deps = {}) {
  const checks = []
  for (const id of PILOT_READINESS_CHECK_IDS) {
    let ok = false
    try {
      ok = (await CHECKS[id](deps)) === true
    } catch (error) {
      ok = false
    }
    checks.push(Object.freeze({ id, ok }))
  }
  const failing = checks.filter((check) => !check.ok).map((check) => check.id)
  return Object.freeze({
    version: PILOT_READINESS_VERSION,
    ready: failing.length === 0,
    checks: Object.freeze(checks),
    failing: Object.freeze(failing),
  })
}

module.exports = {
  PILOT_READINESS_VERSION,
  PILOT_READINESS_CHECK_IDS,
  REQUIRED_CONTINUATION_SUPPORT_VERSION,
  SPEC_READ_PLAN_SLOT_NOT_APPLICABLE,
  CUSTOMER_PACK_NOT_APPLICABLE,
  STEP4_STORE_TABLES,
  collectGenericWriterTargets,
  evaluatePilotReadiness,
  __internals: {
    countTwoCopyComponents,
    readPackColumnFacts,
  },
}
