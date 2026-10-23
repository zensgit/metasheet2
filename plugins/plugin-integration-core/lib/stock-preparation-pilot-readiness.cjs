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
// THE LIST (PILOT_READINESS_VERSION 1):
//   registry_row_active            the registry row exists, is active and names this sheet / objectId
//   sheet_present                  the host finds the sheet for (staging project, objectId) and it IS this sheet
//   target_fields_present          every template column resolves on the sheet, from the database (not computed)
//   plm_column_lock                every plm_system column carries humanWriteLock 'plm_system' (read-only check)
//   contract_option_sets           every contract select column carries a non-empty option list
//   views_present                  the fill view and the to-fill view exist
//   single_project_on_sheet        no other project's active rows sit on the sheet (foreign-project guard)
//   write_lock_store_readable      the sheet write lock row can be read (migration 100 present)
//   write_lock_free                no LIVE lease on the sheet (an expired one is cleared by the enable's bump)
//   export_closure_port            the host offers closeSheetGridExport + getSheetGridExportClosure (#6507)
//                                  and can READ this sheet's closure (so a stamp can land where the resolvers look)
//   continuation_store_readable    the step-4 continuation table is readable      ← step 4 PR-2
//   refresh_state_store_readable   the step-4 refresh-state table is readable     ← step 4 PR-2
//   spec_read_plan_slot            the read plan declares the 规格 column, or server config declares it
//                                  not applicable (never guessed)                   ← step-4 refuter B-M8
//   no_generic_writer_names_sheet  no external-system object config and no pipeline's erp-feedback option
//                                  names this sheet or objectId (and both registries answered) ← step 4 PR-6
//   continuation_support_version   the plugin build recognises continuations    ← step 4 PR-3 flips the marker
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

// THE CONTINUATION MARKER lives in its own module (read at evaluation time, see its header): a later PR
// (step 4 PR-3: the governance consult on every lane, the planner projection, whole-pull suspension)
// flips it to REQUIRED when the build really recognises persisted continuations on every lane. Until
// then readiness refuses by construction (D-22).
const continuationSupport = require('./stock-preparation-continuation-support.cjs')

const PILOT_READINESS_VERSION = 1
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

const PILOT_READINESS_CHECK_IDS = Object.freeze([
  'registry_row_active',
  'sheet_present',
  'target_fields_present',
  'plm_column_lock',
  'contract_option_sets',
  'views_present',
  'single_project_on_sheet',
  'write_lock_store_readable',
  'write_lock_free',
  'export_closure_port',
  'continuation_store_readable',
  'refresh_state_store_readable',
  'spec_read_plan_slot',
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
  spec_read_plan_slot(deps) {
    const readPlan = deps.action && isPlainObject(deps.action.source) ? deps.action.source.readPlan : null
    const declared = isPlainObject(readPlan) && isPlainObject(readPlan.part) && nonEmptyString(readPlan.part.specField) !== null
    if (declared) return true
    return deps.specReadPlanSlotDeclaration === SPEC_READ_PLAN_SLOT_NOT_APPLICABLE
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
 *   assertTargetSheetHoldsNoForeignActiveRows, lock, writeScope, probeTableReadable,
 *   specReadPlanSlotDeclaration, collectGenericWriterTargets
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
  STEP4_STORE_TABLES,
  collectGenericWriterTargets,
  evaluatePilotReadiness,
}
