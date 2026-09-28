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
// WHAT IT DOES. For each managed table this deployment has that CARRIES agreed Chinese labels — the
// canonical main table, the confirmation ledger, and every SANDBOX named by server config — it asks
// the host to rename each column (and the sheet) from its English TEMPLATE label to its Chinese one:
//
//   * TARGETS COME FROM THE TEMPLATE, NOT FROM THE REQUEST. `pickTemplateLabel(…, 'zh-CN')` — the
//     same one function every create path uses — picks the target; the expected current name is the
//     template's own English `label`. A request can neither name a table nor supply a name.
//   * COMPARE-AND-SET. A column is renamed only while its current name is EXACTLY that English label.
//     A column a person already renamed is reported and left alone; a target name another column on
//     the sheet already carries is reported and skipped, because `meta_fields` has no unique
//     (sheet_id, name) index to stop a duplicate. SHEET names are checked across the WHOLE plan: two
//     tables with the same template name (two sandboxes created with the default name) cannot both
//     preview as renamed to one target — the second previews as `skipped_name_taken`.
//   * DRY RUN BY DEFAULT, AND THE APPLY IS BOUND TO IT. Only `apply === true` writes, and only with
//     the `planDigest` the dry run answered: the apply recomputes the whole plan first (no writes) and
//     refuses on any difference, then hands each table's digest to the host, which re-checks it under
//     its own row locks. Nothing is ever written that was not in the preview the admin confirmed.
//   * DEFAULT OFF. The write leg runs only when MULTITABLE_MANAGED_TABLE_RELABEL_ENABLED is exactly
//     'true' on the server — an operator decision, because it renames the customer's production
//     tables. Off, the dry run still works and answers `applyEnabled: false`; the host primitive
//     enforces the same switch independently.
//   * AUDITED. Every rename is written by the host with one `meta_config_revisions` row. FIELD renames
//     can be reverted from the config history; SHEET renames are recorded there but CANNOT be reverted
//     from it (sheet_config reverts are gated) — the way back is renaming the sheet by hand. Nothing
//     here touches a field's id, type, property, order or permissions.
//   * TENANT-SCOPED. The caller's route derives ONE staging project from the verified tenant claim;
//     the host refuses any object the plugin object registry does not bind to that project.
//
// WHAT IT DOES NOT COVER, said out loud rather than discovered:
//   * the nine MVP support tables (snapshot batch / line, material master, …) carry NO agreed Chinese
//     labels, so there is nothing to rename them TO. They are listed in the answer as `outOfScope`
//     (the UI shows the list). A template that later gains `labelZh` joins the targets automatically.
//   * a sandbox created ad hoc through /sandbox-target/ensure under an objectId that NO configured
//     customer pack declares and the sandbox allowlist does not list cannot be discovered — the plugin
//     has no way to enumerate the object registry — and is not relabelled.
//
// VALUES-FREE. The plan carries logical field ids, status codes, digests and the TEMPLATE's own two
// labels (deployment-authored vocabulary, not customer content). It never carries a column's CURRENT
// name — a name a person typed is customer content — nor a sheet id, a physical field id or a project
// id. A sandbox objectId travels hashed.

const crypto = require('node:crypto')

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  pickTemplateLabel,
} = require('./stock-preparation-templates.cjs')
const {
  sandboxStockPreparationTemplate,
  isSandboxNamespaceObjectId,
  hashEvidenceValue,
} = require('./stock-preparation-target-provisioning.cjs')

const RELABEL_TARGET_LOCALE = 'zh-CN'

// The ONE operator switch, byte-identical to the host's (packages/core-backend/src/multitable/
// object-display-name-relabel.ts MANAGED_TABLE_RELABEL_ENABLED_ENV) and registered in
// scripts/ops/global-history-flag-manifest.mjs. A plugin suite pins the three against each other.
const MANAGED_TABLE_RELABEL_ENABLED_ENV = 'MULTITABLE_MANAGED_TABLE_RELABEL_ENABLED'

// THE ONE plan-digest shape on the plugin side: the route's request normalizer (http-routes.cjs)
// imports this very constant. The host keeps its own copy (RELABEL_PLAN_DIGEST_PATTERN in
// object-display-name-relabel.ts — a TS host module a CJS plugin cannot import), and the plugin suite
// pins the two byte-equal.
const PLAN_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

const RELABEL_TABLE_KINDS = Object.freeze(['main', 'ledger', 'sandbox', 'mvp'])

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
//   absent             no such table under THIS tenant's staging project (it may exist elsewhere —
//                      e.g. under another tenant — which this tool deliberately cannot see)
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

/** Exactly 'true' — no trim, no case folding (the charter's exact-literal rule, same as the host). */
function managedTableRelabelApplyEnabled(env = process.env) {
  return Boolean(env) && env[MANAGED_TABLE_RELABEL_ENABLED_ENV] === 'true'
}

function templateHasZhLabels(template) {
  if (typeof template.labelZh === 'string' && template.labelZh) return true
  return template.fields.some((field) => typeof field.labelZh === 'string' && field.labelZh)
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
 * Sandbox objectIds come from two server-held sources and nowhere else: the CONFIGURED customer
 * packs' declared `targetObjectId` (the single source the install run uses), and the deployment's
 * sandbox write allowlist (`resolveStockPrepApplySandboxPolicy`: server config, else
 * STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS). Each is re-checked against the sandbox namespace predicate,
 * so a canonical or foreign objectId can never be relabelled under the sandbox's names.
 */
function listManagedTableRelabelTargets({ packCatalog, sandboxObjectIds } = {}) {
  const targets = [
    { kind: 'main', objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId, template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE },
    {
      kind: 'ledger',
      objectId: STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE.objectId,
      template: STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
    },
  ]
  const sandboxCandidates = []
  const packIds = packCatalog && Array.isArray(packCatalog.packIds) ? packCatalog.packIds : []
  for (const packId of packIds) {
    const pack = packCatalog.get(packId)
    if (pack && typeof pack.targetObjectId === 'string') sandboxCandidates.push(pack.targetObjectId)
  }
  for (const objectId of Array.isArray(sandboxObjectIds) ? sandboxObjectIds : []) {
    if (typeof objectId === 'string') sandboxCandidates.push(objectId.trim())
  }
  const seen = new Set()
  for (const objectId of sandboxCandidates) {
    if (!objectId || seen.has(objectId) || !isSandboxNamespaceObjectId(objectId)) continue
    seen.add(objectId)
    targets.push({ kind: 'sandbox', objectId, template: sandboxStockPreparationTemplate({ objectId }) })
  }
  // An MVP support table joins only if its template carries agreed Chinese labels (none does today).
  for (const template of STOCK_PREPARATION_MVP_TABLE_TEMPLATES) {
    if (templateHasZhLabels(template)) targets.push({ kind: 'mvp', objectId: template.objectId, template })
  }
  return targets
}

/** The managed tables this tool cannot relabel, because no agreed Chinese names exist for them. */
function listManagedTableRelabelOutOfScope() {
  return STOCK_PREPARATION_MVP_TABLE_TEMPLATES
    .filter((template) => !templateHasZhLabels(template))
    .map((template) => ({ objectId: template.objectId, label: template.label }))
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

/**
 * The write leg's failures, re-cast to stable, values-free codes. `tablesApplied` says how many
 * tables were ALREADY committed before this one failed — each table is its own transaction, and the
 * failing one rolled back — so the admin knows a fresh preview will show the rest.
 */
function applyRouteError(error, tablesApplied) {
  const details = { tablesApplied }
  if (error && (error.name === 'MultitableRelabelPlanChangedError' || error.code === 'MULTITABLE_RELABEL_PLAN_CHANGED' || isRelabelScopeRefusal(error))) {
    return new StockPreparationManagedTableRelabelError(409, 'MANAGED_TABLE_RELABEL_PLAN_CHANGED', 'the tables changed since the preview; preview again before applying', { stage: 'apply', ...details })
  }
  if (error && (error.name === 'MultitableRelabelDisabledError' || error.code === 'MULTITABLE_RELABEL_APPLY_DISABLED')) {
    return new StockPreparationManagedTableRelabelError(409, 'MANAGED_TABLE_RELABEL_APPLY_DISABLED', 'managed-table relabel writes are disabled on this server', { enableWith: MANAGED_TABLE_RELABEL_ENABLED_ENV, ...details })
  }
  // The same stable code PATCH /fields and PATCH /sheets answer for a sheet a recovery holds.
  if (error && (error.name === 'SheetWriterBlockedError' || error.code === 'SHEET_WRITER_BLOCKED')) {
    return new StockPreparationManagedTableRelabelError(409, 'RECOVERY_IN_PROGRESS', 'another recovery operation is in progress on this table; retry shortly', details)
  }
  // PostgreSQL chose this transaction as the loser of a lock conflict (deadlock with a concurrent
  // field reorder, lock timeout, serialization failure). Nothing of THIS table was written; a re-run
  // is safe (compare-and-set).
  if (error && (error.code === '40P01' || error.code === '55P03' || error.code === '40001')) {
    return new StockPreparationManagedTableRelabelError(409, 'MANAGED_TABLE_RELABEL_CONCURRENT_CHANGE', 'a concurrent change to the same table won; preview again and retry', details)
  }
  return error
}

function emptyCounts() {
  return Object.fromEntries(RELABEL_ENTITY_STATUSES.map((status) => [status, 0]))
}

function tableIdentity(target) {
  // The canonical and MVP objectIds are constants of this plugin; a sandbox objectId is deployment
  // config and travels hashed, exactly as the sandbox readiness surface reports it.
  return target.kind === 'sandbox'
    ? { kind: target.kind, objectIdHash: hashEvidenceValue(target.objectId) }
    : { kind: target.kind, objectId: target.objectId, ...(target.kind === 'mvp' ? { label: target.template.label } : {}) }
}

function knownStatus(value) {
  return RELABEL_ENTITY_STATUSES.includes(value) ? value : null
}

function hostAnswerInvalid(target, extra) {
  return new StockPreparationManagedTableRelabelError(
    502,
    'MANAGED_TABLE_RELABEL_HOST_ANSWER_INVALID',
    'the host answered the relabel with an unknown or missing status or digest',
    { kind: target.kind, ...extra },
  )
}

/**
 * Project the host's answer onto the values-free plan. Every status is re-checked against the
 * closed vocabulary, so a host that answered something else fails loudly here instead of reaching
 * the admin's screen.
 */
function projectTable(target, requests, hostResult) {
  if (typeof hostResult.planDigest !== 'string' || !PLAN_DIGEST_PATTERN.test(hostResult.planDigest)) {
    throw hostAnswerInvalid(target, { field: 'planDigest' })
  }
  const counts = emptyCounts()
  const hostFields = new Map((Array.isArray(hostResult.fields) ? hostResult.fields : []).map((entry) => [entry.fieldId, entry.status]))
  const fields = requests.fields.map((request) => {
    const status = knownStatus(hostFields.get(request.fieldId))
    if (!status) throw hostAnswerInvalid(target, { fieldId: request.fieldId })
    counts[status] += 1
    return { fieldId: request.fieldId, from: request.expectedName, to: request.nextName, status }
  })
  let sheetName = null
  if (requests.sheetName) {
    const status = knownStatus(hostResult.sheetName && hostResult.sheetName.status)
    if (!status) throw hostAnswerInvalid(target, { entity: 'sheet' })
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

function tableHasRenames(report) {
  return report.status === 'present'
    && (report.counts.would_rename > 0 || Boolean(report.sheetName && report.sheetName.status === 'would_rename'))
}

/**
 * THE WHOLE-PLAN DIGEST: sha256 over every target, in order, with its table status and the host's
 * per-table digest (which covers exactly the renames that table would perform). It moves when a
 * table appears or disappears, and when anything a table would WRITE changes — and at no other time.
 */
function wholePlanDigest(planned) {
  const canonical = JSON.stringify(planned.map((item) => [
    item.target.kind,
    item.target.objectId,
    item.report.status,
    item.hostResult ? item.hostResult.planDigest : null,
  ]))
  return `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

/**
 * PHASE 1 — the plan, for dry run and apply alike. Writes nothing. Sheet-name collisions are
 * computed across the whole plan: a table whose Chinese sheet name an EARLIER table of this plan
 * (same base) is about to take is told so through `takenSheetNames`, and the host previews it as
 * `skipped_name_taken`.
 */
async function planManagedTables({ provisioning, projectId, targets, actorId }) {
  const planned = []
  const claimedSheetNamesByBase = new Map()
  for (const target of targets) {
    const requests = buildRelabelRequests(target.template)
    const sheet = await provisioning.findObjectSheet({ projectId, objectId: target.objectId })
    if (!sheet) {
      planned.push({ target, requests, hostArgs: null, hostResult: null, report: absentTable(target, 'absent') })
      continue
    }
    const baseKey = sheet.baseId === undefined || sheet.baseId === null ? '' : String(sheet.baseId)
    const claimed = claimedSheetNamesByBase.get(baseKey) || new Set()
    const hostArgs = {
      projectId,
      objectId: target.objectId,
      sheetName: requests.sheetName,
      fields: requests.fields,
      takenSheetNames: [...claimed],
      actorId: typeof actorId === 'string' && actorId ? actorId : null,
    }
    let hostResult
    try {
      hostResult = await provisioning.relabelObjectDisplayNames({ ...hostArgs, apply: false })
    } catch (error) {
      if (isRelabelScopeRefusal(error)) {
        planned.push({ target, requests, hostArgs: null, hostResult: null, report: absentTable(target, 'scope_unavailable') })
        continue
      }
      throw error
    }
    if (!hostResult || hostResult.present !== true) {
      planned.push({ target, requests, hostArgs: null, hostResult: null, report: absentTable(target, 'absent') })
      continue
    }
    const report = projectTable(target, requests, hostResult)
    if (report.sheetName && report.sheetName.status === 'would_rename') {
      claimed.add(report.sheetName.to)
      claimedSheetNamesByBase.set(baseKey, claimed)
    }
    planned.push({ target, requests, hostArgs, hostResult, report })
  }
  return planned
}

function summarize(mode, tables, planDigest, applyEnabled) {
  const totals = emptyCounts()
  let revisionCount = 0
  for (const table of tables) {
    for (const status of RELABEL_ENTITY_STATUSES) totals[status] += table.counts[status]
    if (table.sheetName) totals[table.sheetName.status] += 1
    revisionCount += table.revisionCount
  }
  return {
    mode,
    locale: RELABEL_TARGET_LOCALE,
    // The operator switch, reported so the page can say why 「确认执行」 is not offered.
    applyEnabled,
    enableWith: MANAGED_TABLE_RELABEL_ENABLED_ENV,
    planDigest,
    tables,
    totals,
    revisionCount,
    // What a dry run found to do. The UI offers 「确认执行」 only when this AND applyEnabled are true.
    hasPendingRenames: totals.would_rename > 0,
    outOfScope: listManagedTableRelabelOutOfScope(),
  }
}

/**
 * Run the relabel (dry run unless `apply === true`) over every managed table of ONE project.
 *
 * Each table is its own host transaction. A table that is absent or not registered to this project
 * is reported and skipped. On the write leg a failure stops the run with a stable 409 that says how
 * many tables were already committed; a re-run is safe (compare-and-set) after a fresh preview.
 */
async function runStockPreparationManagedTableRelabel({
  provisioning,
  projectId,
  packCatalog,
  sandboxObjectIds,
  apply,
  planDigest,
  actorId,
  env = process.env,
} = {}) {
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
  const applyEnabled = managedTableRelabelApplyEnabled(env)
  if (writes) {
    // The operator switch first: a disabled server asks the host nothing at all.
    if (!applyEnabled) {
      throw new StockPreparationManagedTableRelabelError(
        409,
        'MANAGED_TABLE_RELABEL_APPLY_DISABLED',
        'managed-table relabel writes are disabled on this server; the operator must enable them',
        { enableWith: MANAGED_TABLE_RELABEL_ENABLED_ENV },
      )
    }
    if (typeof planDigest !== 'string' || !PLAN_DIGEST_PATTERN.test(planDigest)) {
      throw new StockPreparationManagedTableRelabelError(400, 'MANAGED_TABLE_RELABEL_PLAN_DIGEST_REQUIRED', 'apply requires the planDigest of the preview being confirmed')
    }
  }
  const targets = listManagedTableRelabelTargets({ packCatalog, sandboxObjectIds })
  const planned = await planManagedTables({ provisioning, projectId, targets, actorId })
  const digest = wholePlanDigest(planned)
  if (!writes) return summarize('dry_run', planned.map((item) => item.report), digest, applyEnabled)

  // PREVIEW == APPLY, checked before the first write of the first table.
  if (digest !== planDigest) {
    throw new StockPreparationManagedTableRelabelError(409, 'MANAGED_TABLE_RELABEL_PLAN_CHANGED', 'the tables changed since the preview; preview again before applying', { stage: 'preview', tablesApplied: 0 })
  }
  const tables = []
  let tablesApplied = 0
  for (const item of planned) {
    if (!tableHasRenames(item.report)) {
      tables.push(item.report)
      continue
    }
    let hostResult
    try {
      // The host re-checks THIS table's digest under its own row locks and writes nothing if the
      // table moved since the plan above (the same takenSheetNames as the plan, so it classifies
      // exactly as the preview did).
      hostResult = await provisioning.relabelObjectDisplayNames({
        ...item.hostArgs,
        apply: true,
        expectedPlanDigest: item.hostResult.planDigest,
      })
    } catch (error) {
      throw applyRouteError(error, tablesApplied)
    }
    tables.push(projectTable(item.target, item.requests, hostResult))
    tablesApplied += 1
  }
  return summarize('apply', tables, digest, applyEnabled)
}

module.exports = {
  RELABEL_TARGET_LOCALE,
  RELABEL_TABLE_KINDS,
  RELABEL_ENTITY_STATUSES,
  RELABEL_TABLE_STATUSES,
  MANAGED_TABLE_RELABEL_ENABLED_ENV,
  PLAN_DIGEST_PATTERN,
  StockPreparationManagedTableRelabelError,
  managedTableRelabelApplyEnabled,
  buildRelabelRequests,
  listManagedTableRelabelTargets,
  listManagedTableRelabelOutOfScope,
  runStockPreparationManagedTableRelabel,
  __internals: {
    isRelabelScopeRefusal,
    applyRouteError,
    projectTable,
    wholePlanDigest,
    PLAN_DIGEST_PATTERN,
  },
}
