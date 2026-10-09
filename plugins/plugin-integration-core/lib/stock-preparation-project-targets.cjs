'use strict'

// 一个项目一张备料表 — PROVISIONING + RESOLUTION (S1 of ADR adr-stock-prep-project-sheets-20261008,
// §2 / §3 / §8). The registry row itself lives in stock-preparation-project-target-store.cjs; this
// module is everything AROUND it:
//
//   * THE SWITCH. `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED` is read PER CALL and is on only for
//     the exact literal 'true' — no trim, no case folding — so a stray space or `TRUE` is OFF. Off
//     means every S1 route answers 404 DISABLED without IO and the table-action registry resolves
//     the env target byte for byte as before S1 (ADR §8).
//   * THE SHEET IDENTITY. objectId = `plm_stock_preparation_sandbox_p_` + the first 24 hex of
//     sha256(`${tenantId}:${projectNo}`). The raw project number never enters an identifier or a
//     refusal detail (the tenant wall quotes objectIds). This digest is NOT a secrecy measure — a
//     caller who can see it already knows which project they asked about — it is an identifier
//     shape the sandbox namespace guard and the preflight filter accept (own-base.cjs holds the
//     rule). Sheet id and field ids are then derived by the host from (staging project, objectId),
//     which is what makes "one project, one sheet" structural rather than a convention.
//   * PROVISIONING reuses the ONE existing create path (`ensureStockPreparationCanonicalTarget` →
//     `ensureStockPreparationTarget`) with a template stamped for this object, so a project sheet
//     gets exactly the frozen columns, the default view and the 备料填写视图 every managed table
//     gets — plus the 待填写 view (O1) that only project sheets carry. The template is frozen; the
//     request body is an EMPTY closed allowlist; base, names and fields are never caller-supplied.
//   * RESOLUTION is the overlay the table-action registry applies after the persisted source
//     binding: active → the project sheet's binding; archived → 409 on a write purpose, the sheet
//     (read-only) on a read purpose; absent → 409. Source-only lookups and readiness probes are
//     never overlaid.
//   * G1 is a CALL into the host's narrow grant port (plugin-scope `grantSheetRoleWrite`), with the
//     role list from server config — never from the request. Absent config = no grant = G2 (an admin
//     grants by hand); absent port (older host) = reported, never a failure of the create.
//
// VALUES-FREE: identifiers, enums, counts and booleans only. The project number appears in the
// sheet's display name (that is its purpose — the operator must find their project) and nowhere
// else this module emits.

const crypto = require('node:crypto')

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')
const {
  StockPreparationTargetProvisioningError,
  ensureStockPreparationCanonicalTarget,
  ensureStockPreparationTodoView,
  STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID,
} = require('./stock-preparation-target-provisioning.cjs')
const {
  STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PREFIX,
  STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN,
  isStockPreparationProjectSheetObjectId,
} = require('./stock-preparation-own-base.cjs')
const { STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID } = require('./stock-preparation-templates.cjs')

const PROJECT_SHEETS_ENABLED_ENV = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
// G1: comma-separated role ids that receive `spreadsheet:write` on every project sheet at create
// time. Each id must sit in the `stock-prep` role namespace (`stock-prep` or `stock-prep_…`); the
// HOST enforces that (and that the role exists) — this module only parses the list.
const PROJECT_SHEET_GRANT_ROLE_IDS_ENV = 'MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS'
const PROJECT_SHEET_OBJECT_ID_DIGEST_LENGTH = 24
// ADR §2: at most this many registry rows per tenant, archived INCLUDED (§6: an archived sheet is a
// live sheet). A bound on how many managed tables a puller can create, not a business limit.
const MAX_PROJECT_TARGETS_PER_TENANT = 200

const PROJECT_TARGET_PURPOSES = Object.freeze(['write', 'read', 'source', 'readiness'])

class StockPreparationProjectTargetError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationProjectTargetError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationProjectTargetError(400, 'STOCK_PREPARATION_PROJECT_NO_REQUIRED', `${field} is required`, { field })
  }
  return normalized
}

/** EXACT literal 'true'. `' true'`, `'TRUE'`, `'1'` are all OFF. Read per call, never captured. */
function stockPreparationProjectSheetsEnabled(env = process.env) {
  return Boolean(env) && env[PROJECT_SHEETS_ENABLED_ENV] === 'true'
}

/** The configured G1 role ids: trimmed, de-duplicated, order kept. Unset / blank → [] → no grant. */
function resolveProjectSheetGrantRoleIds(env = process.env) {
  const raw = env ? env[PROJECT_SHEET_GRANT_ROLE_IDS_ENV] : undefined
  if (typeof raw !== 'string') return []
  const out = []
  for (const part of raw.split(',')) {
    const id = part.trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

function deriveProjectSheetObjectId(tenantId, projectNo) {
  const tenant = requiredString(tenantId, 'tenantId')
  const project = requiredString(projectNo, 'projectNo')
  const digest = crypto.createHash('sha256').update(`${tenant}:${project}`, 'utf8').digest('hex')
  return `${STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PREFIX}${digest.slice(0, PROJECT_SHEET_OBJECT_ID_DIGEST_LENGTH)}`
}

/**
 * The frozen main template, stamped for ONE project's sheet: the project objectId and a display
 * name that carries the project number (the one place it may appear — the operator must be able to
 * find their project in the sheet list). Columns, ownership bands and views are the template's.
 */
function projectSheetTemplate({ tenantId, projectNo }) {
  const objectId = deriveProjectSheetObjectId(tenantId, projectNo)
  const project = requiredString(projectNo, 'projectNo')
  return normalizeStockPreparationTemplate({
    ...STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
    id: `${STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.id}.p.${objectId.slice(-PROJECT_SHEET_OBJECT_ID_DIGEST_LENGTH)}`,
    objectId,
    label: `Stock prep ${project}`,
    labelZh: `备料-${project}`,
  })
}

function templateFieldIds(template) {
  return template.fields.map((field) => field.id)
}

/**
 * The table-action TARGET for a project sheet: sheetId + objectId from the registry row, the key
 * field the canonical writer keys on, and a FULL logical→physical field map resolved for THIS
 * objectId. `resolveFieldIds` is compute-only on the host (a pure derivation, no IO), which is why
 * the registry stores no map (ADR §2 「登记表存什么」).
 */
async function buildProjectTargetBinding({ provisioning, projectId, target }) {
  if (!provisioning || typeof provisioning.resolveFieldIds !== 'function') {
    throw new StockPreparationProjectTargetError(503, 'STOCK_PREPARATION_PROJECT_TARGET_PROVISIONING_UNAVAILABLE', 'resolving a project sheet requires multitable.provisioning.resolveFieldIds', { requiredMethods: ['resolveFieldIds'] })
  }
  const fieldIdMap = await provisioning.resolveFieldIds({
    projectId,
    objectId: target.objectId,
    fieldIds: templateFieldIds(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE),
  })
  return {
    sheetId: target.sheetId,
    objectId: target.objectId,
    keyField: 'idempotencyKey',
    fieldIdMap: { ...(fieldIdMap || {}) },
  }
}

/**
 * THE RESOLUTION SEAM (ADR §3). Called by the table-action registry for every lookup that is not a
 * source-only read or a readiness probe. Returns `{ status, target, projectNo }` or `null` (= no
 * overlay, env target stands — the switch is off).
 *
 *   active   → the project sheet, every purpose
 *   archived → 409 STOCK_PREPARATION_PROJECT_ARCHIVED on 'write'; the sheet on 'read' (§6 read-only)
 *   absent   → 409 STOCK_PREPARATION_PROJECT_ABSENT (both purposes — see the note below)
 *
 * ABSENT ON A READ IS A 409 HERE, not the route's own "not found" branch the ADR table sketched:
 * routing a read for an unregistered project at the env sheet would read the OLD mixed table (the
 * one Q3 says is 「不要了」), and routing it at a derived-but-never-created sheet would surface as a
 * host error from the records read. The code is tenant-bounded — the registry is keyed by the
 * caller's VERIFIED tenant — so it reveals only the caller's own tenant's state, which 项目备料页's
 * 404 already does. The board catches it and renders 「表还没建好」.
 */
async function resolveProjectTargetForAction({
  store,
  provisioning,
  projectId,
  tenantId,
  projectNo,
  targetPurpose,
  env = process.env,
} = {}) {
  if (!stockPreparationProjectSheetsEnabled(env)) return null
  const purpose = PROJECT_TARGET_PURPOSES.includes(targetPurpose) ? targetPurpose : 'write'
  if (purpose === 'source' || purpose === 'readiness') return null
  if (!store || typeof store.get !== 'function') {
    throw new StockPreparationProjectTargetError(501, 'STOCK_PREPARATION_PROJECT_TARGET_STORE_UNAVAILABLE', 'the project-sheet registry is not available; the switch is on but no target can be resolved')
  }
  const project = optionalString(projectNo)
  if (!project) {
    throw new StockPreparationProjectTargetError(400, 'STOCK_PREPARATION_PROJECT_NO_REQUIRED', 'projectNo is required while per-project stock-preparation sheets are enabled', { field: 'projectNo' })
  }
  const row = await store.get({ tenantId, projectNo: project })
  if (!row) {
    throw new StockPreparationProjectTargetError(409, 'STOCK_PREPARATION_PROJECT_ABSENT', 'this project has no registered stock-preparation sheet yet; a puller must create it first', { field: 'projectNo' })
  }
  if (row.status === 'archived' && purpose === 'write') {
    throw new StockPreparationProjectTargetError(409, 'STOCK_PREPARATION_PROJECT_ARCHIVED', 'this project\'s stock-preparation sheet is archived; restore it before writing', { field: 'projectNo' })
  }
  const target = await buildProjectTargetBinding({ provisioning, projectId, target: row })
  return { status: row.status, projectNo: project, target }
}

/**
 * CREATE THE SHEET for one project, through the one existing create path, in the pair's base, with
 * the default view, the fill view and the to-fill view. Idempotent at the host: an already-ready
 * object returns before any write, so a retry after a registry race costs no second table.
 *
 * `permission: 'admin'` is the module's server-side capability constant (target-provisioning.cjs
 * `REQUIRED_PERMISSION`), passed by the ROUTE after its own `stock-prep:pull` gate — it says nothing
 * about the caller's tier. The route is the named exception to R-11 (register R-35).
 */
async function provisionProjectSheet({ context, projectId, tenantId, projectNo, env = process.env, locale } = {}) {
  const template = projectSheetTemplate({ tenantId, projectNo })
  const ensured = await ensureStockPreparationCanonicalTarget({
    context,
    projectId,
    permission: 'admin',
    template,
    tenantId,
    resolveOwnBase: true,
    env,
    locale,
  })
  const provisioning = context && context.api && context.api.multitable && context.api.multitable.provisioning
  const sheetId = ensured && ensured.target && ensured.target.sheetId ? String(ensured.target.sheetId) : null
  if (!sheetId) {
    throw new StockPreparationProjectTargetError(500, 'STOCK_PREPARATION_PROJECT_TARGET_SHEET_UNKNOWN', 'the project sheet was ensured but no sheet id came back', { objectId: template.objectId })
  }
  // The to-fill view is written on the CREATE leg only — an already-ready sheet (a retry, or a
  // sheet a race partner just created) is left exactly as it is, hand-tuned views included.
  let todoView = { created: false, skipped: 'already_ready', viewId: null }
  if (ensured.mode === 'canonical_create') {
    try {
      todoView = await ensureStockPreparationTodoView({
        provisioning,
        projectId,
        objectId: template.objectId,
        sheetId,
        locale,
        template,
      })
    } catch (error) {
      if (error instanceof StockPreparationTargetProvisioningError) throw error
      todoView = { created: false, skipped: 'ensure_failed', viewId: null }
    }
  }
  return {
    created: ensured.mode === 'canonical_create',
    mode: ensured.mode,
    sheetId,
    objectId: template.objectId,
    fieldIdMap: ensured.target && ensured.target.fieldIdMap ? { ...ensured.target.fieldIdMap } : {},
    fillView: ensured.fillView || null,
    todoView,
    ownBaseSource: ensured.evidence ? ensured.evidence.ownBaseSource : null,
  }
}

/**
 * G1: ask the host to grant the configured roles `spreadsheet:write` on this project sheet.
 *
 * Returns a values-free summary. `skipped: 'no_roles_configured'` is G2 (the admin grants by hand);
 * `skipped: 'api_unavailable'` is an older host. Neither fails the create: the sheet exists and is
 * registered either way, and the GET target reports what happened. A host REFUSAL (a role outside
 * the namespace, an unknown role, a sheet the plugin does not own) PROPAGATES — those are
 * configuration faults the puller must see, not degrade around.
 */
async function grantProjectSheetRoles({ provisioning, projectId, sheetId, objectId, roleIds, actorId } = {}) {
  const roles = Array.isArray(roleIds) ? roleIds.filter((id) => typeof id === 'string' && id.trim()) : []
  if (roles.length === 0) return { attempted: false, skipped: 'no_roles_configured', roleCount: 0, granted: 0, alreadyGranted: 0 }
  if (!provisioning || typeof provisioning.grantSheetRoleWrite !== 'function') {
    return { attempted: false, skipped: 'api_unavailable', roleCount: roles.length, granted: 0, alreadyGranted: 0 }
  }
  const result = await provisioning.grantSheetRoleWrite({ projectId, sheetId, objectId, roleIds: roles, actorId: actorId || null })
  return {
    attempted: true,
    skipped: null,
    roleCount: roles.length,
    granted: Array.isArray(result && result.granted) ? result.granted.length : 0,
    alreadyGranted: Array.isArray(result && result.alreadyGranted) ? result.alreadyGranted.length : 0,
  }
}

/** The two deep-link handles a project sheet carries: the fill view and the to-fill view. */
function projectSheetViewHandles({ provisioning, projectId, objectId }) {
  if (!provisioning || typeof provisioning.getObjectViewId !== 'function') return { viewId: null, todoViewId: null }
  const viewId = provisioning.getObjectViewId(projectId, objectId, STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID)
  const todoViewId = provisioning.getObjectViewId(projectId, objectId, STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID)
  return {
    viewId: typeof viewId === 'string' && viewId ? viewId : null,
    todoViewId: typeof todoViewId === 'string' && todoViewId ? todoViewId : null,
  }
}

module.exports = {
  PROJECT_SHEETS_ENABLED_ENV,
  PROJECT_SHEET_GRANT_ROLE_IDS_ENV,
  MAX_PROJECT_TARGETS_PER_TENANT,
  PROJECT_TARGET_PURPOSES,
  STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PREFIX,
  STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN,
  StockPreparationProjectTargetError,
  isStockPreparationProjectSheetObjectId,
  stockPreparationProjectSheetsEnabled,
  resolveProjectSheetGrantRoleIds,
  deriveProjectSheetObjectId,
  projectSheetTemplate,
  buildProjectTargetBinding,
  resolveProjectTargetForAction,
  provisionProjectSheet,
  grantProjectSheetRoles,
  projectSheetViewHandles,
}
