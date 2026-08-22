'use strict'

// SERVER-HELD CUSTOMER-PACK CATALOG — the allowlist the pack routes gate on.
//
// A customer pack is DEPLOY-TIME DATA (see lib/customer-packs/*.cjs: a real deployment loads its
// pack from an uncommitted local file, because the dictionaries are the customer's). That makes the
// entry-point question "which packs may this server install?", and the answer must be SERVER-HELD.
//
// So the request never carries a pack. It carries a packId, which is looked up in a catalog built
// from SERVER CONFIG ONLY — the same posture as resolveStockPrepApplyProductionPolicy: dormant by
// default, no env switch, and an unlisted id is refused. A request-supplied pack body would let any
// admin-authenticated caller define arbitrary `ext_` columns and their ownership bands on the
// canonical sheet, which is a schema-authoring capability, not a config one.
//
// Mirrors plugin-after-sales' ALLOWED_TEMPLATE_IDS (index.cjs:815) in intent and tightens it in
// mechanism: after-sales allowlists ids against a compiled-in blueprint, while here the allowlist
// IS the configured pack set, so "listed" and "loadable" cannot drift apart.
//
// EVERY PACK IS NORMALIZED AT CATALOG-BUILD TIME. A malformed deploy-time pack therefore fails at
// plugin activation with the normalizer's own error, not on the deployer's first install call.
//
// Values-free: `list()` returns the evidence summary (ids, types, ownership tokens, counts) that
// summarizeCustomerPackForEvidence already guarantees is free of option values and labels.

const {
  normalizeCustomerPack,
  summarizeCustomerPackForEvidence,
  StockPreparationCustomerPackError,
} = require('./stock-preparation-customer-pack.cjs')

// The single server-config key. Deliberately one key with no env fallback: an environment variable
// cannot carry a pack, and a half-configured catalog should be an empty one, not a partial one.
const CUSTOMER_PACK_CONFIG_KEY = 'stockPreparationCustomerPacks'

class StockPreparationCustomerPackCatalogError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationCustomerPackCatalogError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Read the configured pack map off server config. Absent / malformed → {} → an EMPTY catalog, which
 * refuses every packId. Fail-closed by construction: there is no "allow everything" state.
 */
function resolveCustomerPackCatalogConfig(config) {
  if (config && isPlainObject(config[CUSTOMER_PACK_CONFIG_KEY])) {
    return config[CUSTOMER_PACK_CONFIG_KEY]
  }
  return {}
}

/**
 * Build the catalog. `packs` is `{ [packId]: pack }` — raw or already normalized, normalized here
 * either way.
 *
 * The map KEY must equal the pack's own declared packId. Allowing them to differ would make the
 * allowlist say one thing and the installed provenance stamp another, and the ledger keys on packId.
 */
function createCustomerPackCatalog({ packs } = {}) {
  const entries = new Map()
  const source = isPlainObject(packs) ? packs : {}
  for (const [key, rawPack] of Object.entries(source)) {
    let normalized
    try {
      normalized = normalizeCustomerPack(rawPack)
    } catch (error) {
      if (error instanceof StockPreparationCustomerPackError) {
        throw new StockPreparationCustomerPackCatalogError(
          500,
          'CUSTOMER_PACK_CATALOG_INVALID',
          `configured customer pack "${key}" is not a valid pack`,
          { packId: key, reason: error.reason || error.code || 'invalid_pack' },
        )
      }
      throw error
    }
    if (normalized.packId !== key) {
      throw new StockPreparationCustomerPackCatalogError(
        500,
        'CUSTOMER_PACK_CATALOG_INVALID',
        'configured customer pack key must equal the pack\'s own packId',
        { packId: key, declaredPackId: normalized.packId },
      )
    }
    entries.set(normalized.packId, normalized)
  }

  function has(packId) {
    return typeof packId === 'string' && entries.has(packId)
  }

  /**
   * Resolve an allowlisted pack. An unlisted id is a 403, not a 404: whether a pack exists anywhere
   * is not something an unauthorized caller gets to probe, and "not allowed here" is the accurate
   * statement either way. The error names the id the caller supplied and nothing else.
   */
  function get(packId) {
    const id = typeof packId === 'string' ? packId.trim() : ''
    if (!id || !entries.has(id)) {
      throw new StockPreparationCustomerPackCatalogError(
        403,
        'CUSTOMER_PACK_NOT_ALLOWED',
        'packId is not in the server-held customer pack allowlist',
        { packId: id || null, allowedPackCount: entries.size },
      )
    }
    return entries.get(id)
  }

  function list() {
    return [...entries.keys()].sort().map((packId) => summarizeCustomerPackForEvidence(entries.get(packId)))
  }

  return { has, get, list, size: entries.size, packIds: [...entries.keys()].sort() }
}

module.exports = {
  CUSTOMER_PACK_CONFIG_KEY,
  StockPreparationCustomerPackCatalogError,
  createCustomerPackCatalog,
  resolveCustomerPackCatalogConfig,
}
