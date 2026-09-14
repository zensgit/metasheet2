'use strict'

// ---------------------------------------------------------------------------
// B3 — the stock-preparation OWN BASE (方案 ③).
//
// WHY. `createSheet` puts every plugin table created without a baseId into the shared
// `base_legacy` (owner/workspace NULL, listed for everyone), which is how a customer came to
// see the attendance plugin's field catalog inside their 备料 base. The stock-preparation
// write routes REFUSE a request baseId by owner decision A (assertNoRequestBaseId — the host
// writes base_id verbatim with no ownership check), so the only sound source for a base is
// one the plugin derives itself, from the AUTHENTICATED tenant, and creates through the
// host's `ensureSystemBase` (prefix-checked by plugin-scope, fail-closed on adoption).
//
// WHAT THIS MODULE IS. One pure derivation, one env gate, one resolver shared by the main
// table and the confirmation ledger so the two can never be resolved differently. It never
// sees req / body / query and never parses a projectId: the tenant is an explicit argument
// the ROUTE passes from `resolveAuthUserTenantId(req)`, and nothing else.
//
// RESOLUTION ORDER (spec design 4), strictly:
//   1. gate off                      -> today's value (explicit || null), source 'disabled'
//   2. explicit baseId               -> verbatim, source 'explicit'  (sandbox / MVP / staging)
//   3. anchor (ledger only): the main table already EXISTS -> ITS sheet.baseId, source 'anchor',
//                                       and ensureSystemBase is NEVER called (222 lands here)
//   4. host lacks ensureSystemBase   -> null (legacy), source 'api_unavailable'  (version skew)
//   5. no tenant                     -> 400 STOCK_PREPARATION_OWN_BASE_TENANT_REQUIRED (fail-closed,
//                                       never legacy)
//   6. derive + ensureSystemBase     -> derived id, source 'derived'
// The MAIN TABLE's own "already exists" case is decided by its caller BEFORE this resolver runs
// (the inspect branch returns ready long before the create path), so a main table that exists
// never reaches step 6 either.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto')

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  pickOwnBaseName,
} = require('./stock-preparation-templates.cjs')

const STOCK_PREP_OWN_BASE_ENV = 'MULTITABLE_STOCK_PREP_OWN_BASE'
// Unset = ON (the owner asked for this behaviour; existing installs are unchanged through step
// 3 / the main table's ready branch). Trimmed + lower-cased membership, the `batchKeyLookupDisabled`
// precedent — a superset of the spec's `false`.
const STOCK_PREP_OWN_BASE_OFF_VALUES = Object.freeze(new Set(['false', '0', 'off', 'no']))
// `base_<pluginSlug>_` for plugin-integration-core, plus this line's own `sp_` segment. Must stay
// under the prefix plugin-scope enforces (`getPluginBaseIdPrefix('plugin-integration-core')`).
const STOCK_PREPARATION_OWN_BASE_ID_PREFIX = 'base_integration-core_sp_'
const STOCK_PREPARATION_OWN_BASE_DIGEST_LENGTH = 24
// The ledger anchors to the MAIN TABLE. The objectId lives HERE, not in the ledger module: the
// ledger's G1 structural guard forbids it from naming the canonical object at all.
const STOCK_PREPARATION_OWN_BASE_ANCHOR_OBJECT_ID = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId

const OWN_BASE_SOURCES = Object.freeze(['disabled', 'explicit', 'anchor', 'api_unavailable', 'derived'])

// `StockPreparationTargetProvisioningError` lives in the target-provisioning module, which
// REQUIRES this one — a top-level require here would be a load cycle and hand back an empty
// partial export. Resolved lazily, at throw time, when both modules are fully loaded.
function ProvisioningError() {
  return require('./stock-preparation-target-provisioning.cjs').StockPreparationTargetProvisioningError
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stockPreparationOwnBaseEnabled(env = process.env) {
  const raw = env ? env[STOCK_PREP_OWN_BASE_ENV] : undefined
  if (raw === undefined || raw === null) return true
  return !STOCK_PREP_OWN_BASE_OFF_VALUES.has(String(raw).trim().toLowerCase())
}

// Deterministic, tenant-opaque (sha1 hex, never the tenant string), and by construction under the
// plugin's own prefix. A blank tenant is a 400, the same status `TENANT_REQUIRED` gives the same
// condition one layer up — never a silent fall-back to the shared base.
function deriveStockPreparationBaseId(tenantId) {
  const normalized = optionalString(tenantId)
  if (!normalized) {
    throw new (ProvisioningError())(
      400,
      'STOCK_PREPARATION_OWN_BASE_TENANT_REQUIRED',
      'authenticated tenant context is required to derive the stock-preparation base',
      {},
    )
  }
  const digest = crypto
    .createHash('sha1')
    .update(`${normalized}:stock-preparation`, 'utf8')
    .digest('hex')
    .slice(0, STOCK_PREPARATION_OWN_BASE_DIGEST_LENGTH)
  return `${STOCK_PREPARATION_OWN_BASE_ID_PREFIX}${digest}`
}

async function resolveStockPreparationOwnBase({
  provisioning,
  projectId,
  tenantId,
  explicitBaseId,
  anchorToMainTable = false,
  locale,
  env,
} = {}) {
  const explicit = optionalString(explicitBaseId)
  if (!stockPreparationOwnBaseEnabled(env)) {
    return { baseId: explicit, source: 'disabled' }
  }
  if (explicit) {
    return { baseId: explicit, source: 'explicit' }
  }
  if (anchorToMainTable === true) {
    const sheet = await provisioning.findObjectSheet({
      projectId,
      objectId: STOCK_PREPARATION_OWN_BASE_ANCHOR_OBJECT_ID,
    })
    if (sheet) {
      // The main table exists: the ledger follows it, whatever base that is (a non-string
      // baseId is the legacy null). Never derive next to an existing main table.
      return { baseId: typeof sheet.baseId === 'string' ? sheet.baseId : null, source: 'anchor' }
    }
  }
  if (!provisioning || typeof provisioning.ensureSystemBase !== 'function') {
    return { baseId: null, source: 'api_unavailable' }
  }
  const baseId = deriveStockPreparationBaseId(tenantId)
  const ensured = await provisioning.ensureSystemBase({ baseId, name: pickOwnBaseName({ locale }) })
  return { baseId, source: 'derived', created: Boolean(ensured && ensured.created === true) }
}

module.exports = {
  STOCK_PREP_OWN_BASE_ENV,
  STOCK_PREP_OWN_BASE_OFF_VALUES,
  STOCK_PREPARATION_OWN_BASE_ID_PREFIX,
  STOCK_PREPARATION_OWN_BASE_ANCHOR_OBJECT_ID,
  OWN_BASE_SOURCES,
  stockPreparationOwnBaseEnabled,
  deriveStockPreparationBaseId,
  resolveStockPreparationOwnBase,
}
