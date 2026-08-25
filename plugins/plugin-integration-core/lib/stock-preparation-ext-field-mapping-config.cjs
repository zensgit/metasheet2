'use strict'

// SERVER-HELD source->`ext_` FIELD MAPPING — the entry point that makes the mapper reachable.
//
// stock-preparation-ext-field-mapping.cjs is the mapper: it validates a declarative
// "source column -> `ext_` logical id" object against a customer pack and turns legacy all-string
// cells into the types the pack declared. It is PURE and it takes the mapping as an argument.
// Nothing built it from server config, so `computeDryRun`'s `extFieldMapping` parameter had no
// producer and "no production code path produces an `ext_` value" stayed true after the mapper
// shipped (#5118). THIS module is the producer.
//
// WHY ITS OWN CONFIG KEY, and not the action config or the pack.
//
//   * NOT the action config. An action config is `cloneJson`-snapshotted into the large-BOM job row
//     (`actionSnapshot`) and hashed into dry-run revisions, so it may hold only JSON that survives
//     a round trip. A normalized mapping is a FROZEN, BRANDED object whose brand is deliberately
//     non-enumerable — it cannot survive `cloneJson`, and the raw form cannot be validated without
//     a pack, which the action config has no access to. The mapper's own header says it: the
//     mapping object "stays a runtime input and never enters this config". What the action config
//     does carry is `extensionFieldIds`, the durable half; the two are reconciled by
//     `assertExtFieldMappingAgreesWithAction`.
//   * NOT inside the pack. "A pack is schema and performs no value work" — the pack declares which
//     `ext_` columns exist and who owns them, and a deployment may install one pack while wiring
//     its sources in several revisions. Folding the mapping in would version the two together and
//     would put value-production rules inside a schema artifact.
//   * ITS OWN KEY, resolved exactly like the pack catalog
//     (stock-preparation-customer-pack-catalog.cjs + the
//     INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH file-path pattern in
//     packages/core-backend/src/plugin-runtime-config.ts): one server-config key, no env fallback,
//     built ONCE at route registration so a malformed deploy-time mapping fails at plugin
//     activation instead of on a deployer's first dry-run.
//
// BLAST RADIUS. This module runs inside `createHandlers`, so a throw here fails registration for the
// ENTIRE plugin, not merely the refresh routes. That is the right trade for a mapping that is
// present and wrong — a deployment that mis-declares which tenant columns a refresh writes should
// not serve — but it is why `false` is accepted as "switched off" rather than treated as malformed:
// the obvious kill switch must not be the one that takes everything down. See
// `resolveExtFieldMappingConfig` for the three states.
//
// FAIL-CLOSED AND INERT BY DEFAULT. Absent key -> `null` -> the routes omit `extFieldMapping`
// -> `rowFromPart` adds no key, not even an empty one, and the planner's bands are untouched. That
// is byte-identical to a deployment that never configured one. Present-but-malformed throws, at
// startup, with the mapper's own closed reason token attached — a typo must not look exactly like
// "no mapping configured", which is the same argument the pack catalog makes for its file reader.
//
// THE PACK IS RESOLVED FROM THE ALLOWLIST, NOT FROM THE MAPPING. The mapping names a `packId`; the
// pack itself comes from the server-held catalog. A mapping that could carry its own pack inline
// would be a second, unreviewed authority over which `ext_` columns exist and which band they are
// in — precisely what the catalog refuses to let a request do.

const {
  normalizeExtFieldMapping,
  StockPreparationExtFieldMappingError,
} = require('./stock-preparation-ext-field-mapping.cjs')

// The single server-config key. One mapping per server, matching the single configured table
// action (`createStockPreparationTableActionRegistry` accepts exactly one actionId,
// PLM_STOCK_PREPARATION_ACTION_ID). A map keyed by actionId would imply a plurality that the
// action registry does not have.
const EXT_FIELD_MAPPING_CONFIG_KEY = 'stockPreparationExtFieldMapping'

// `packId` is this module's key, not the mapper's: the mapper resolves targets against a pack it is
// HANDED and refuses every key it does not know (MAPPING_UNKNOWN_KEY). So the pack reference is
// peeled off here and the rest is passed through untouched — this module adds no vocabulary of its
// own to what a mapping may say.
const CONFIG_KEYS = Object.freeze(['packId', 'mappingId', 'mappingVersion', 'label', 'mappings'])

class StockPreparationExtFieldMappingConfigError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationExtFieldMappingConfigError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function fail(message, details) {
  throw new StockPreparationExtFieldMappingConfigError(
    500,
    'EXT_FIELD_MAPPING_CONFIG_INVALID',
    message,
    details || {},
  )
}

/**
 * Read the configured mapping off server config. Absent -> `undefined` -> no mapping at all.
 *
 * THREE STATES, and the middle one exists because of the blast radius. This module is called from
 * `createHandlers`, so anything it throws takes down registration for the WHOLE plugin — pipelines,
 * read-source, sealed-export, connectors — not just the refresh routes.
 *
 *   * absent / `null` / `undefined` / `false` -> INERT. `false` is the obvious way to write "leave
 *     it switched off", and an operator who reaches for it must not take the plugin down with it.
 *     It is an explicit statement of intent, not a malformed value.
 *   * a plain object -> validated, and any fault in it is fatal at registration.
 *   * anything else (a string, an array, a number, `true`) -> FATAL. "There is no mapping" and "the
 *     mapping is the wrong kind of thing" are different deployments and only the first may be inert;
 *     degrading the second to silence is how a typo becomes a refresh that quietly writes nothing.
 *
 * The pack catalog is more tolerant here only because it can afford to be: coercing a malformed
 * value to `{}` still yields a catalog that refuses every packId. An empty MAPPING would instead
 * mean "the refresh writes nothing extra", which is indistinguishable from success.
 */
function resolveExtFieldMappingConfig(config) {
  if (!config || !Object.prototype.hasOwnProperty.call(config, EXT_FIELD_MAPPING_CONFIG_KEY)) {
    return undefined
  }
  const raw = config[EXT_FIELD_MAPPING_CONFIG_KEY]
  if (raw === undefined || raw === null || raw === false) return undefined
  if (!isPlainObject(raw)) {
    fail(
      `${EXT_FIELD_MAPPING_CONFIG_KEY} must be an object, or false to leave the mapper switched off`,
      { field: EXT_FIELD_MAPPING_CONFIG_KEY },
    )
  }
  return raw
}

/**
 * Build the ONE normalized mapping this server will apply, or `null` when none is configured.
 *
 * @param {object} options.config      server config (`context.config`)
 * @param {object} options.packCatalog the server-held pack allowlist (createCustomerPackCatalog)
 * @returns {object|null} a branded, frozen mapping — the only thing `computeDryRun` accepts.
 */
function createConfiguredExtFieldMapping({ config, packCatalog } = {}) {
  const raw = resolveExtFieldMappingConfig(config)
  if (raw === undefined) return null

  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.includes(key)) {
      fail(`${EXT_FIELD_MAPPING_CONFIG_KEY}.${key} is not a supported key`, {
        field: `${EXT_FIELD_MAPPING_CONFIG_KEY}.${key}`,
      })
    }
  }

  const packId = typeof raw.packId === 'string' ? raw.packId.trim() : ''
  if (!packId) {
    fail(`${EXT_FIELD_MAPPING_CONFIG_KEY}.packId must name a configured customer pack`, {
      field: `${EXT_FIELD_MAPPING_CONFIG_KEY}.packId`,
    })
  }
  if (!packCatalog || typeof packCatalog.get !== 'function') {
    fail('ext field mapping requires the server-held customer pack catalog', { field: 'packCatalog' })
  }

  // Unlisted packId -> the catalog's own 403. Re-thrown as a CONFIG error because at registration
  // there is no request to refuse: this is a deployment that named a pack it did not configure.
  let pack
  try {
    pack = packCatalog.get(packId)
  } catch {
    fail(`${EXT_FIELD_MAPPING_CONFIG_KEY}.packId is not in the server-held customer pack allowlist`, {
      field: `${EXT_FIELD_MAPPING_CONFIG_KEY}.packId`,
      packId,
    })
  }

  // Everything except the pack reference is the mapper's own vocabulary, handed over unchanged.
  const mappingInput = {}
  for (const key of Object.keys(raw)) {
    if (key === 'packId') continue
    mappingInput[key] = raw[key]
  }
  try {
    return normalizeExtFieldMapping(mappingInput, { pack })
  } catch (error) {
    if (error instanceof StockPreparationExtFieldMappingError) {
      // The mapper's closed `.reason` vocabulary is carried through verbatim: a deployer reading a
      // startup failure gets TARGET_HUMAN_OWNED or SOURCE_COLUMN_DUPLICATE, not prose.
      fail(`${EXT_FIELD_MAPPING_CONFIG_KEY} is not a valid source->ext_ field mapping`, {
        packId,
        reason: error.reason || 'UNKNOWN',
        field: error.details && error.details.field ? error.details.field : undefined,
      })
    }
    throw error
  }
}

module.exports = {
  EXT_FIELD_MAPPING_CONFIG_KEY,
  StockPreparationExtFieldMappingConfigError,
  createConfiguredExtFieldMapping,
  resolveExtFieldMappingConfig,
}
