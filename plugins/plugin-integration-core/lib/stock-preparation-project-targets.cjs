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

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')
const {
  StockPreparationTargetProvisioningError,
  ensureStockPreparationCanonicalTarget,
  ensureStockPreparationTodoView,
  resolveFieldExistence,
  STOCK_PREPARATION_TODO_VIEW_LOGICAL_ID,
} = require('./stock-preparation-target-provisioning.cjs')
const {
  STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PREFIX,
  STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN,
  isStockPreparationProjectSheetObjectId,
  deriveStockPreparationProjectSheetObjectId,
} = require('./stock-preparation-own-base.cjs')
const { STOCK_PREPARATION_FILL_VIEW_LOGICAL_ID } = require('./stock-preparation-templates.cjs')
// S2 (ADR §2 「客户包」): the deployment's customer pack, re-placed onto each project sheet. The
// installer is the ONE path that lands a pack (additive, never `ensureObject`); this module only
// decides WHICH packs and WHERE, and refuses before any write when they cannot cover the action.
const { retargetCustomerPack } = require('./stock-preparation-customer-pack.cjs')
const {
  installCustomerPack,
  preflightCustomerPackInstallCapabilities,
} = require('./stock-preparation-customer-pack-installer.cjs')
const { LIVE_STATUSES: PACK_INSTALL_LIVE_STATUSES } = require('./stock-preparation-pack-install-store.cjs')

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
  // The ONE derivation lives in own-base.cjs (S2 fix round 1) so the customer-pack module can bind a
  // re-placed pack to the same (tenant, project) without a load cycle.
  return deriveStockPreparationProjectSheetObjectId(tenant, project)
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

/** A declared `ext_` band as a clean id list: strings only, de-duplicated, order kept. */
function extensionFieldIdList(extensionFieldIds) {
  if (!Array.isArray(extensionFieldIds)) return []
  const out = []
  for (const id of extensionFieldIds) {
    if (typeof id === 'string' && id && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * The table-action TARGET for a project sheet: sheetId + objectId from the registry row, the key
 * field the canonical writer keys on, and a FULL logical→physical field map resolved for THIS
 * objectId. `resolveFieldIds` is compute-only on the host (a pure derivation, no IO), which is why
 * the registry stores no map (ADR §2 「登记表存什么」).
 *
 * S2: the map ALSO covers the action's declared `extensionFieldIds`. The env target's explicit map
 * names its `ext_` columns, and `assertTargetFieldMapCompleteness` requires every declared one to be
 * bound — a project binding without them answered 422 TARGET_SCHEMA_INCOMPLETE ("fieldIdMap is
 * missing") on every dry-run of a pack deployment, before the field-existence probe was even
 * reached. A derived id for a column the sheet does not carry is still caught: the DB-backed
 * existence probe judges the same ids (`assertTargetFieldsExist`). With no declared band the map is
 * the template's alone, byte-identical to S1.
 */
async function buildProjectTargetBinding({ provisioning, projectId, target, extensionFieldIds }) {
  if (!provisioning || typeof provisioning.resolveFieldIds !== 'function') {
    throw new StockPreparationProjectTargetError(503, 'STOCK_PREPARATION_PROJECT_TARGET_PROVISIONING_UNAVAILABLE', 'resolving a project sheet requires multitable.provisioning.resolveFieldIds', { requiredMethods: ['resolveFieldIds'] })
  }
  const templateIds = templateFieldIds(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const extensionIds = extensionFieldIdList(extensionFieldIds).filter((id) => !templateIds.includes(id))
  const fieldIdMap = await provisioning.resolveFieldIds({
    projectId,
    objectId: target.objectId,
    fieldIds: templateIds.concat(extensionIds),
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
  // S2: the looked-up action's declared `ext_` band (server config, threaded by the registry) — the
  // binding resolves those columns too; see `buildProjectTargetBinding`.
  extensionFieldIds,
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
  const target = await buildProjectTargetBinding({ provisioning, projectId, target: row, extensionFieldIds })
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

// ── S2: the deployment's customer pack, re-placed onto the project sheet (ADR §2 「客户包」) ─────────
//
// WHY. `ensureObject` builds the frozen template's columns and nothing else, so a fresh project
// sheet carries no `ext_` column. A deployment whose pull action declares `extensionFieldIds` (the
// columns its customer pack added to the env sheet) would then answer its FIRST dry-run on the new
// sheet with 422 TARGET_SCHEMA_INCOMPLETE. The fix the ADR names: re-install the SAME pack — `ext_`
// columns, option sets, role views, column write scopes — onto the new objectId.
//
// WHICH PACKS. The install ledger (migration 076, keyed (tenant, project, object, pack)) is the
// record of what the deployment installed on its env target object; the server-held catalog is the
// only place a pack body comes from. Neither is request input.
//
// ORDER (R-36): PLAN → PRE-FLIGHT → PROVISION → INSTALL → REGISTER, with two different guarantees:
//   * EVERY REFUSAL DECIDABLE WITHOUT THE SHEET runs before provisioning (S2 fix round 1, the cap
//     boundary): the band coverage (`planProjectSheetCustomerPacks`), the installer's own
//     sheet-independent pre-flight per pack — provisioning surface, field-permission port, reconcile
//     support, declared roles — and the tenant-claim requirement for packs that govern column write
//     scopes (`preflightProjectSheetCustomerPacks`). A host that would refuse every install refuses
//     before the first table exists, so a repeating refusal cannot leave one unregistered managed
//     table per project number behind.
//   * A GENUINE MID-INSTALL FAILURE (the host failing a write) still happens after provisioning. It
//     leaves no registered row, and the provisioned sheet is ensure-if-absent by its DERIVED objectId,
//     so the retry — the same POST — reuses that one table; the same project number can never own two.
//     Such a sheet is not counted by the 200 cap until it is registered.
// An already registered sheet (the 200 replay) is HEALED by the same install: when its own ledger
// lacks the pack at the catalog's version, OR when the DB-backed field-existence probe the dry-run
// uses says a declared `ext_` column is gone.

const PROJECT_SHEET_PACK_INSTALL_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const PROJECT_SHEET_TENANT_CLAIM_REQUIRED_CODE = 'STOCK_PREPARATION_PROJECT_TARGET_TENANT_CLAIM_REQUIRED'

/**
 * The admin pack-install route refuses a claimless principal (403 TENANT_CLAIM_REQUIRED) because
 * the install's write-scope reconcile issues a bounded DELETE on `field_permissions`. The create
 * route reaches the same installer at the PULL tier, so the same door applies whenever a pack that
 * governs column write scopes is about to be installed: the host-vouched membership alone is not
 * enough for a delete. Tighten-only; values-free.
 */
function assertTenantClaimForWriteScopes(tenantClaimVerified, writeScopePackCount) {
  if (writeScopePackCount > 0 && tenantClaimVerified !== true) {
    throw new StockPreparationProjectTargetError(
      403,
      PROJECT_SHEET_TENANT_CLAIM_REQUIRED_CODE,
      'this deployment’s customer pack governs column write permissions; installing it onto a project sheet requires a login whose verified token carries the tenant claim',
      { writeScopePackCount },
    )
  }
}

/**
 * Reads only. Which catalog packs the new sheet must carry, or a 409 when they cannot cover the
 * action's declared `ext_` band. Values-free: pack ids (deployment slugs) and logical field ids.
 */
async function planProjectSheetCustomerPacks({
  tenantId,
  projectId,
  deploymentObjectId,
  extensionFieldIds,
  packCatalog,
  packInstallStore,
} = {}) {
  const declared = extensionFieldIdList(extensionFieldIds)
  const deploymentObject = optionalString(deploymentObjectId)
  let ledgerPackIds = []
  if (deploymentObject && packInstallStore && typeof packInstallStore.listInstalledFieldIds === 'function') {
    // LIVE rows only ('installed' / 'partial'): a failed attempt on the env sheet is not a pack the
    // deployment carries.
    const live = await packInstallStore.listInstalledFieldIds({ tenantId, projectId, objectId: deploymentObject })
    ledgerPackIds = Array.isArray(live && live.packIds) ? live.packIds.filter((id) => typeof id === 'string' && id) : []
  }
  const packs = []
  const notInCatalog = []
  const covered = new Set()
  for (const packId of [...new Set(ledgerPackIds)].sort()) {
    if (!packCatalog || typeof packCatalog.has !== 'function' || !packCatalog.has(packId)) {
      // A ledger row for a pack this server no longer holds: it cannot be re-installed from here.
      // Not a refusal by itself — the completeness check below decides whether its absence matters.
      notInCatalog.push(packId)
      continue
    }
    const pack = packCatalog.get(packId)
    packs.push(pack)
    for (const field of pack.extensionFields) covered.add(field.id)
  }
  const missing = declared.filter((id) => !covered.has(id))
  if (missing.length > 0) {
    throw new StockPreparationProjectTargetError(
      409,
      'STOCK_PREPARATION_PROJECT_TARGET_PACK_INCOMPLETE',
      'this deployment declares extension columns that no installed customer pack can re-create on a project sheet; install the customer pack on the deployment target first',
      {
        missingExtensionFields: missing,
        declaredExtensionFieldCount: declared.length,
        ledgerPackCount: ledgerPackIds.length,
        notInCatalogPackCount: notInCatalog.length,
      },
    )
  }
  return {
    packs,
    notInCatalogPackIds: notInCatalog,
    declaredExtensionFieldCount: declared.length,
    writeScopePackCount: packs.filter((pack) => pack.fieldWritePolicies.length > 0).length,
  }
}

/**
 * Reads only, BEFORE PROVISIONING (the create leg). Every planned pack through the installer's own
 * sheet-independent pre-flight (same assertions, same codes), then the tenant-claim door for packs
 * that govern column write scopes. A refusal here means no table was created.
 */
async function preflightProjectSheetCustomerPacks({
  plan,
  provisioning,
  fieldPermissions,
  tenantClaimVerified,
} = {}) {
  const planned = plan && Array.isArray(plan.packs) ? plan.packs : []
  for (const pack of planned) {
    try {
      await preflightCustomerPackInstallCapabilities({ provisioning, fieldPermissions, pack })
    } catch (error) {
      throw wrapPackInstallError(error, pack.packId)
    }
  }
  assertTenantClaimForWriteScopes(tenantClaimVerified, plan ? plan.writeScopePackCount : 0)
}

/** One typed code for every installer refusal, with the pack id and the installer's own code. */
function wrapPackInstallError(error, packId) {
  if (error instanceof StockPreparationProjectTargetError) return error
  const status = error && Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500
  const code = error && typeof error.code === 'string' && PROJECT_SHEET_PACK_INSTALL_CODE_PATTERN.test(error.code) ? error.code : 'CUSTOMER_PACK_INSTALL_FAILED'
  const wrapped = new StockPreparationProjectTargetError(
    status,
    'STOCK_PREPARATION_PROJECT_TARGET_PACK_INSTALL_FAILED',
    'the deployment’s customer pack could not be installed on this project sheet; nothing was registered by this request and the same request can be retried',
    { packId, installCode: code },
  )
  wrapped.cause = error
  return wrapped
}

/**
 * Does the project object still carry every `ext_` column this pack declares? Asked through the SAME
 * DB-backed probe the dry-run uses (`resolveFieldExistence`). Only a `db` verdict can say "missing";
 * an older host (compute-only) cannot, so the ledger is trusted there.
 */
async function packColumnsPresent({ provisioning, projectId, objectId, pack }) {
  const fieldIds = pack.extensionFields.map((field) => field.id)
  if (fieldIds.length === 0 || !provisioning || typeof provisioning.resolveFieldIds !== 'function') return true
  let verdict
  try {
    verdict = await resolveFieldExistence({ provisioning, projectId, objectId, fieldIds })
  } catch (error) {
    // S3 carry-over (S4 review): the probe degrades an OBJECT-SCOPE refusal itself, so anything that
    // escapes it is the host failing the read (a pool error, a half-migrated table). The readiness
    // path answers that with a typed, values-free 503 TARGET_SCHEMA_UNAVAILABLE; the replay must do
    // the same rather than let a raw host error surface as an opaque 500 off a 200-replay POST.
    if (error instanceof StockPreparationProjectTargetError || error instanceof StockPreparationTargetProvisioningError) throw error
    const wrapped = new StockPreparationProjectTargetError(
      503,
      'TARGET_SCHEMA_UNAVAILABLE',
      'the project sheet\'s column probe could not be read; retry the same request once the host answers',
      { objectId, packId: pack.packId },
    )
    wrapped.cause = error
    throw wrapped
  }
  if (verdict.fieldExistenceMode !== 'db') return true
  const resolved = verdict.resolved || {}
  return fieldIds.every((id) => typeof resolved[id] === 'string' && resolved[id].length > 0)
}

/**
 * Writes. Install every planned pack onto THIS project sheet. A pack is SKIPPED only when the project
 * object's own ledger row is live at the catalog's version AND its declared `ext_` columns are still
 * on the sheet; otherwise it is (re)installed — the installer is additive, so a reinstall adds what
 * is missing and changes nothing else. A failure is one typed code with the pack id and the
 * installer's own code.
 *
 * THE BINDING TO THIS PROJECT is enforced once, by `retargetCustomerPack` (it refuses any objectId
 * that is not the one derived for this tenant and project), before any host call for the pack. The
 * earlier shape check that sat here repeated a weaker form of that rule and was deleted in S2 fix
 * round 1; with no planned pack this function makes no host call at all.
 */
async function installProjectSheetCustomerPacks({
  plan,
  provisioning,
  projectId,
  tenantId,
  projectNo,
  objectId,
  packInstallStore,
  fieldPermissions,
  tenantClaimVerified,
  logger,
} = {}) {
  const planned = plan && Array.isArray(plan.packs) ? plan.packs : []
  const outcomes = []
  for (const sourcePack of planned) {
    let pack
    try {
      pack = retargetCustomerPack(sourcePack, { tenantId, projectNo, targetObjectId: objectId })
    } catch (error) {
      throw new StockPreparationProjectTargetError(
        500,
        'STOCK_PREPARATION_PROJECT_TARGET_PACK_TARGET_INVALID',
        'a customer pack may only be re-installed onto the sheet derived for this tenant and project',
        { packId: sourcePack.packId, reason: error && error.details ? error.details.provisioningReason || null : null },
      )
    }
    let mode = 'install'
    if (packInstallStore && typeof packInstallStore.getInstall === 'function') {
      const existing = await packInstallStore.getInstall({ tenantId, projectId, objectId, packId: pack.packId })
      // The ledger column is TEXT (migration 076: `pack_version TEXT`; the store stringifies on the
      // way in), the catalog's version an integer — compared as the ledger stores it, or a replay
      // would never recognise its own install and re-run the installer every time.
      if (existing && PACK_INSTALL_LIVE_STATUSES.includes(existing.status)) {
        mode = 'reinstall'
        if (String(existing.packVersion) === String(pack.packVersion)
          && await packColumnsPresent({ provisioning, projectId, objectId, pack })) {
          outcomes.push({ packId: pack.packId, packVersion: pack.packVersion, outcome: 'already_installed', createdFieldCount: 0, stampedFieldCount: 0 })
          continue
        }
      }
    }
    // The claim door, per pack, at the moment an install that may DELETE write scopes is about to run
    // (the replay leg reaches here without the create leg's pre-flight).
    assertTenantClaimForWriteScopes(tenantClaimVerified, pack.fieldWritePolicies.length > 0 ? 1 : 0)
    let summary
    try {
      summary = await installCustomerPack({
        provisioning,
        projectId,
        pack,
        logger: logger || undefined,
        packInstallStore: packInstallStore || undefined,
        tenantId,
        // No workspace dimension on project sheets (ADR §1.2), the same as the registry itself.
        workspaceId: null,
        mode,
        fieldPermissions: fieldPermissions || undefined,
      })
    } catch (error) {
      throw wrapPackInstallError(error, pack.packId)
    }
    outcomes.push({
      packId: pack.packId,
      packVersion: pack.packVersion,
      outcome: mode === 'reinstall' ? 'reinstalled' : 'installed',
      createdFieldCount: Array.isArray(summary && summary.createdFields) ? summary.createdFields.length : 0,
      stampedFieldCount: Array.isArray(summary && summary.stampedExistingFields) ? summary.stampedExistingFields.length : 0,
    })
  }
  return {
    packs: outcomes,
    installedPackCount: outcomes.filter((entry) => entry.outcome === 'installed').length,
    reinstalledPackCount: outcomes.filter((entry) => entry.outcome === 'reinstalled').length,
    alreadyInstalledPackCount: outcomes.filter((entry) => entry.outcome === 'already_installed').length,
    notInCatalogPackCount: plan && Array.isArray(plan.notInCatalogPackIds) ? plan.notInCatalogPackIds.length : 0,
    declaredExtensionFieldCount: plan && Number.isInteger(plan.declaredExtensionFieldCount) ? plan.declaredExtensionFieldCount : 0,
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
  PROJECT_SHEET_TENANT_CLAIM_REQUIRED_CODE,
  planProjectSheetCustomerPacks,
  preflightProjectSheetCustomerPacks,
  installProjectSheetCustomerPacks,
  projectSheetViewHandles,
}
