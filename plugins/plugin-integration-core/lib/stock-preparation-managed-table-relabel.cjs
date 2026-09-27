'use strict'

// 「把系统表的英文表头改成中文」 — RELABEL THE STOCK-PREPARATION MANAGED TABLES THAT ALREADY EXIST.
//
// WHY THIS EXISTS (客户反馈 2026-09-24 #4a). Every managed table's human names are chosen exactly
// once, when the table is created: `pickTemplateLabel` reads the deployment's display language in
// `buildSheetStructureFromTemplate` / `buildSheetStructureFromMvpTableTemplate`
// (stock-preparation-templates.cjs), and an existing table is never re-described (the ledger's
// ensure returns "already ready" before any write — stock-preparation-confirmation-decisions.cjs —
// and so does the main table's). So a deployment whose tables were created in English keeps
// "Decision ID / Status / Conflict Type…" forever, even though every one of those columns carries a
// Chinese `labelZh` in its template.
//
// WHAT IT DOES. For each managed table this deployment actually has — the canonical main table, the
// confirmation ledger, and every SANDBOX a configured customer pack declares — it asks the host to
// rename each column (and the sheet) from its English TEMPLATE label to its Chinese one:
//
//   * TARGETS COME FROM THE TEMPLATE, NOT FROM THE REQUEST. `pickTemplateLabel(…, 'zh-CN')` — the
//     same one function every create path uses — picks the target; the expected current name is the
//     template's own English `label`. A request can neither name a table nor supply a name.
//   * COMPARE-AND-SET. A column is renamed only while its current name is EXACTLY that English label.
//     A column a person already renamed (the first deployment renamed 66 by hand) is reported and
//     left alone; a target name another column on the sheet already carries is reported and skipped,
//     because `meta_fields` has no unique (sheet_id, name) index to stop a duplicate.
//   * DRY RUN BY DEFAULT. Only `apply === true` writes. The dry run returns the same values-free plan
//     the apply would execute, computed by the same host code against the same live state.
//   * AUDITED. Every rename is written by the host with one `meta_config_revisions` row (the sheet's
//     config history), so it is visible and revertible there like a rename made in the grid. Nothing
//     here touches a field's id, type, property, order or permissions — the plugin, its views and
//     every automation condition address fields by id.
//   * TENANT-SCOPED. The caller's route derives ONE staging project from the verified tenant claim;
//     the host refuses any object the plugin object registry does not bind to that project.
//
// VALUES-FREE. The plan carries logical field ids, status codes and the TEMPLATE's own two labels
// (deployment-authored vocabulary, not customer content). It never carries a column's CURRENT name —
// a name a person typed is customer content — nor a sheet id, a physical field id or a project id.

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
  pickTemplateLabel,
} = require('./stock-preparation-templates.cjs')
const {
  sandboxStockPreparationTemplate,
  isSandboxNamespaceObjectId,
  hashEvidenceValue,
} = require('./stock-preparation-target-provisioning.cjs')

const RELABEL_TARGET_LOCALE = 'zh-CN'

const RELABEL_TABLE_KINDS = Object.freeze(['main', 'ledger', 'sandbox'])

// The host's per-entity vocabulary (packages/core-backend/src/multitable/object-display-name-relabel.ts).
const RELABEL_ENTITY_STATUSES = Object.freeze([
  'renamed',
  'would_rename',
  'already_target',
  'skipped_name_changed',
  'skipped_name_taken',
  'missing',
])

// Per-table outcomes this module adds on top of the host's.
//   present            the host evaluated the table (its per-entity statuses are in the plan)
//   absent             this deployment has no such table — nothing to relabel, nothing to report
//   scope_unavailable  the table exists but the plugin object registry does not bind it to this
//                      tenant's project (a hand-made or dump-restored sheet). Refused, never guessed.
const RELABEL_TABLE_STATUSES = Object.freeze(['present', 'absent', 'scope_unavailable'])

class StockPreparationManagedTableRelabelError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationManagedTableRelabelError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * The rename requests for ONE template: every column whose Chinese label differs from its English
 * one, plus the sheet name. Pure; exported for its own witnesses.
 */
function buildRelabelRequests(template) {
  const sheetTarget = pickTemplateLabel(template, RELABEL_TARGET_LOCALE)
  const sheetName = sheetTarget && sheetTarget !== template.label
    ? { expectedName: template.label, nextName: sheetTarget }
    : null
  const fields = []
  for (const field of template.fields) {
    const nextName = pickTemplateLabel(field, RELABEL_TARGET_LOCALE)
    if (!nextName || nextName === field.label) continue
    fields.push({ fieldId: field.id, expectedName: field.label, nextName })
  }
  return { sheetName, fields }
}

/**
 * THE TABLES THIS TOOL MAY TOUCH — server-held, never request-supplied.
 *
 * The sandbox objectIds come off the CONFIGURED customer packs' declared `targetObjectId`, the same
 * single source the install run uses ("never invented, never from env, never from the operator"),
 * and each is re-checked against the sandbox namespace predicate so a canonical or foreign objectId
 * can never be relabelled under the sandbox's names.
 */
function listManagedTableRelabelTargets({ packCatalog } = {}) {
  const targets = [
    { kind: 'main', objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId, template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE },
    {
      kind: 'ledger',
      objectId: STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE.objectId,
      template: STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
    },
  ]
  const seen = new Set()
  const packIds = packCatalog && Array.isArray(packCatalog.packIds) ? packCatalog.packIds : []
  for (const packId of packIds) {
    const pack = packCatalog.get(packId)
    const objectId = pack && typeof pack.targetObjectId === 'string' ? pack.targetObjectId : ''
    if (!objectId || seen.has(objectId) || !isSandboxNamespaceObjectId(objectId)) continue
    seen.add(objectId)
    targets.push({ kind: 'sandbox', objectId, template: sandboxStockPreparationTemplate({ objectId }) })
  }
  return targets
}

/**
 * The host's refusal for an object this plugin never claimed, from EITHER layer: the plugin-scope
 * wrapper's MultitableObjectScopeError, or the host primitive's own registry binding. Matched by
 * name/code — the classes live in the host. Neither is ever forwarded: the scope wrapper's message
 * names the tenant's project id.
 */
function isRelabelScopeRefusal(error) {
  if (!error) return false
  return error.name === 'MultitableObjectScopeError'
    || error.code === 'MULTITABLE_OBJECT_SCOPE_FORBIDDEN'
    || error.name === 'MultitableRelabelScopeError'
    || error.code === 'MULTITABLE_RELABEL_SCOPE_FORBIDDEN'
}

function emptyCounts() {
  return Object.fromEntries(RELABEL_ENTITY_STATUSES.map((status) => [status, 0]))
}

function tableIdentity(target) {
  // The two canonical objectIds are constants of this plugin; a sandbox objectId is deployment
  // config and travels hashed, exactly as the sandbox readiness surface reports it.
  return target.kind === 'sandbox'
    ? { kind: target.kind, objectIdHash: hashEvidenceValue(target.objectId) }
    : { kind: target.kind, objectId: target.objectId }
}

function knownStatus(value) {
  return RELABEL_ENTITY_STATUSES.includes(value) ? value : null
}

/**
 * Project the host's answer onto the values-free plan. Every status is re-checked against the
 * closed vocabulary, so a host that answered something else fails loudly here instead of reaching
 * the admin's screen.
 */
function projectTable(target, requests, hostResult) {
  const counts = emptyCounts()
  const hostFields = new Map((Array.isArray(hostResult.fields) ? hostResult.fields : []).map((entry) => [entry.fieldId, entry.status]))
  const fields = requests.fields.map((request) => {
    const status = knownStatus(hostFields.get(request.fieldId))
    if (!status) {
      throw new StockPreparationManagedTableRelabelError(
        502,
        'MANAGED_TABLE_RELABEL_HOST_ANSWER_INVALID',
        'the host answered the relabel with an unknown or missing field status',
        { kind: target.kind, fieldId: request.fieldId },
      )
    }
    counts[status] += 1
    return { fieldId: request.fieldId, from: request.expectedName, to: request.nextName, status }
  })
  let sheetName = null
  if (requests.sheetName) {
    const status = knownStatus(hostResult.sheetName && hostResult.sheetName.status)
    if (!status) {
      throw new StockPreparationManagedTableRelabelError(
        502,
        'MANAGED_TABLE_RELABEL_HOST_ANSWER_INVALID',
        'the host answered the relabel with an unknown or missing sheet-name status',
        { kind: target.kind },
      )
    }
    sheetName = { from: requests.sheetName.expectedName, to: requests.sheetName.nextName, status }
  }
  return {
    ...tableIdentity(target),
    status: 'present',
    sheetName,
    fields,
    counts,
    revisionCount: Number.isInteger(hostResult.revisionCount) ? hostResult.revisionCount : 0,
  }
}

function absentTable(target, status) {
  return { ...tableIdentity(target), status, sheetName: null, fields: [], counts: emptyCounts(), revisionCount: 0 }
}

/**
 * Run the relabel (dry run unless `apply === true`) over every managed table of ONE project.
 *
 * Each table is its own host transaction. A table that is absent or not registered to this project
 * is reported and skipped; any other host failure propagates, and a re-run is safe because every
 * rename is compare-and-set (a table that already went through answers `already_target`).
 */
async function runStockPreparationManagedTableRelabel({ provisioning, projectId, packCatalog, apply, actorId } = {}) {
  if (!provisioning || typeof provisioning.relabelObjectDisplayNames !== 'function' || typeof provisioning.findObjectSheet !== 'function') {
    throw new StockPreparationManagedTableRelabelError(
      501,
      'MANAGED_TABLE_RELABEL_API_UNAVAILABLE',
      'this server cannot relabel managed tables: the host has no audited display-name relabel',
      { requiredMethods: ['findObjectSheet', 'relabelObjectDisplayNames'] },
    )
  }
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new StockPreparationManagedTableRelabelError(500, 'MANAGED_TABLE_RELABEL_PROJECT_REQUIRED', 'a project is required')
  }
  const writes = apply === true
  const tables = []
  for (const target of listManagedTableRelabelTargets({ packCatalog })) {
    const requests = buildRelabelRequests(target.template)
    const sheet = await provisioning.findObjectSheet({ projectId, objectId: target.objectId })
    if (!sheet) {
      tables.push(absentTable(target, 'absent'))
      continue
    }
    let hostResult
    try {
      hostResult = await provisioning.relabelObjectDisplayNames({
        projectId,
        objectId: target.objectId,
        sheetName: requests.sheetName,
        fields: requests.fields,
        apply: writes,
        actorId: typeof actorId === 'string' && actorId ? actorId : null,
      })
    } catch (error) {
      if (isRelabelScopeRefusal(error)) {
        tables.push(absentTable(target, 'scope_unavailable'))
        continue
      }
      throw error
    }
    if (!hostResult || hostResult.present !== true) {
      tables.push(absentTable(target, 'absent'))
      continue
    }
    tables.push(projectTable(target, requests, hostResult))
  }
  const totals = emptyCounts()
  let revisionCount = 0
  for (const table of tables) {
    for (const status of RELABEL_ENTITY_STATUSES) totals[status] += table.counts[status]
    if (table.sheetName) totals[table.sheetName.status] += 1
    revisionCount += table.revisionCount
  }
  return {
    mode: writes ? 'apply' : 'dry_run',
    locale: RELABEL_TARGET_LOCALE,
    tables,
    totals,
    revisionCount,
    // What a dry run found to do. The UI offers 「确认执行」 only when this is true.
    hasPendingRenames: totals.would_rename > 0,
  }
}

module.exports = {
  RELABEL_TARGET_LOCALE,
  RELABEL_TABLE_KINDS,
  RELABEL_ENTITY_STATUSES,
  RELABEL_TABLE_STATUSES,
  StockPreparationManagedTableRelabelError,
  buildRelabelRequests,
  listManagedTableRelabelTargets,
  runStockPreparationManagedTableRelabel,
  __internals: {
    isRelabelScopeRefusal,
    projectTable,
  },
}
