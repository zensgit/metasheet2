#!/usr/bin/env node
'use strict'

// DERIVE a stock-preparation table-action `target` block, OFFLINE.
//
// WHY THIS EXISTS. `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`
// carries `target.fieldIdMap` — the logical-id -> physical-id binding the apply
// writer resolves every column through. The completeness gate
// (`assertTargetFieldMapCompleteness`) refuses an action whose map is missing a
// plm_system column or a declared `ext_` one, so a deployer must produce the
// whole map before the first dry-run. There was no supported producer for it:
// the canonical route (`ensureStockPreparationCanonicalTarget`) returns a map
// only for the CANONICAL object, which is precisely the object apply refuses.
// For the sandbox object — the only target that may be applied to — the map had
// to be hand-copied out of the database. This script is that missing producer.
//
// IT NEEDS NO DATABASE AND NO API, because these ids are not allocated, they are
// COMPUTED. `stableMetaId` (packages/core-backend/src/multitable/provisioning.ts)
// is a pure function of the tuple:
//
//     fld_  +  sha1(`${projectId}:${objectId}:${fieldId}`).hex.slice(0, 24)
//     sheet_+  sha1(`${projectId}:${objectId}`).hex.slice(0, 24)
//
// and the project id the plugin's routes always use is
// `${tenantId}:integration-core` (resolveIntegrationStagingProjectId,
// plugins/plugin-integration-core/lib/http-routes.cjs). So the whole binding is
// derivable from (tenantId, objectId) plus the pack that declares the `ext_`
// columns. Deriving beats reading: an offline derivation cannot pick up a
// half-migrated row, and it can be run before the sheet exists.
//
// THE FIELD VOCABULARY IS NOT RESTATED HERE. The 25 canonical ids and the key
// field are imported from the plugin's own frozen template and provisioning
// modules, so this script cannot drift from the schema it binds. Only the hash
// itself is re-implemented (it lives in TypeScript and this script must run
// under plain node); its colocated test pins the algorithm against the
// TypeScript source AND against a known-good id triple.
//
// USAGE
//   node scripts/ops/stock-preparation-derive-target-binding.mjs \
//     --tenant-id tenant-dev \
//     --object-id plm_stock_preparation_sandbox_m0 \
//     [--pack <packs.json>] [--pack-id <id>] \
//     [--project-id <explicit project id>] \
//     [--action-fragment] [--compact]
//
//   --pack             the deploy-time pack file (the same JSON
//                      INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH
//                      names: an object keyed by packId, or a single bare pack).
//                      Its `ext_` columns are added to the map.
//   --action-fragment  print `{ target, extensionFieldIds }` instead of the bare
//                      target block — the two halves an action config needs.
//   --compact          single-line JSON (for embedding in an env var).
//
// Values-free: schema ids only. It reads no rows and prints no cell.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins', 'plugin-integration-core', 'lib')

const require = createRequire(import.meta.url)

const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(PLUGIN_LIB, 'stock-preparation-templates.cjs'))
const { CANONICAL_KEY_FIELD } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs'))
const { normalizeCustomerPack } = require(path.join(PLUGIN_LIB, 'stock-preparation-customer-pack.cjs'))

export class DeriveTargetBindingError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DeriveTargetBindingError'
    this.code = code
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// The host's id algorithm. Mirrored, and pinned by the colocated test against
// packages/core-backend/src/multitable/provisioning.ts so a change there cannot
// leave this script quietly producing ids that address nothing.
// ---------------------------------------------------------------------------
export const META_ID_HASH = 'sha1'
export const META_ID_HEX_LENGTH = 24
export const META_ID_MAX_LENGTH = 50

export function stableMetaId(prefix, ...parts) {
  const digest = crypto.createHash(META_ID_HASH).update(parts.join(':')).digest('hex').slice(0, META_ID_HEX_LENGTH)
  return `${prefix}_${digest}`.slice(0, META_ID_MAX_LENGTH)
}

export function getObjectSheetId(projectId, objectId) {
  return stableMetaId('sheet', projectId, objectId)
}

export function getObjectFieldId(projectId, objectId, fieldId) {
  return stableMetaId('fld', projectId, objectId, fieldId)
}

/**
 * The project id every integration-core route resolves to for a tenant.
 * Mirrors resolveIntegrationStagingProjectId in the plugin's http-routes.
 */
export function integrationCoreProjectId(tenantId) {
  return `${tenantId}:integration-core`
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DeriveTargetBindingError('INPUT_INVALID', `${field} is required`, { field })
  }
  return value.trim()
}

/**
 * Pull the `ext_` ids out of a deploy-time pack file.
 *
 * The file may be either shape the runtime accepts: an object keyed by packId
 * (what INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH names) or a
 * single bare pack. Every pack is run through the REAL normalizer, so this
 * script refuses exactly what the server would refuse — a malformed pack cannot
 * yield a binding that the plugin would then reject at activation.
 */
export function extensionFieldIdsFromPack(packFileContent, { packId, objectId } = {}) {
  let parsed
  try {
    parsed = JSON.parse(packFileContent)
  } catch (error) {
    throw new DeriveTargetBindingError('PACK_FILE_INVALID', 'pack file is not valid JSON', { cause: error.message })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DeriveTargetBindingError('PACK_FILE_INVALID', 'pack file must be a JSON object', {})
  }

  // A bare pack declares `packId`; a catalog file maps packId -> pack.
  const candidates = typeof parsed.packId === 'string'
    ? { [parsed.packId]: parsed }
    : parsed

  const entries = Object.entries(candidates)
  if (entries.length === 0) {
    throw new DeriveTargetBindingError('PACK_FILE_INVALID', 'pack file declares no packs', {})
  }

  let chosen
  if (packId) {
    if (!Object.prototype.hasOwnProperty.call(candidates, packId)) {
      throw new DeriveTargetBindingError('PACK_NOT_FOUND', `pack file does not declare packId "${packId}"`, {
        packId,
        availablePackIds: entries.map(([key]) => key).sort(),
      })
    }
    chosen = [packId, candidates[packId]]
  } else if (entries.length === 1) {
    chosen = entries[0]
  } else {
    throw new DeriveTargetBindingError('PACK_ID_REQUIRED', 'pack file declares several packs; name one with --pack-id', {
      availablePackIds: entries.map(([key]) => key).sort(),
    })
  }

  let normalized
  try {
    normalized = normalizeCustomerPack(chosen[1])
  } catch (error) {
    throw new DeriveTargetBindingError('PACK_INVALID', 'pack file does not carry a valid customer pack', {
      packId: chosen[0],
      reason: error && error.reason ? error.reason : 'UNKNOWN',
    })
  }

  // AGREEMENT, not assumption. A pack that declares a sandbox target while the
  // caller derives a binding for a different object would produce a map of ids
  // that address columns the install never created — the exact disjoint-sets
  // failure this whole line of work exists to remove. Refuse instead.
  if (objectId && normalized.targetObjectId !== objectId) {
    throw new DeriveTargetBindingError(
      'PACK_TARGET_MISMATCH',
      'the pack installs onto a different object than the binding is being derived for',
      { packTargetObjectId: normalized.targetObjectId, requestedObjectId: objectId },
    )
  }

  return {
    packId: normalized.packId,
    packVersion: normalized.packVersion,
    targetObjectId: normalized.targetObjectId,
    extensionFieldIds: normalized.extensionFields.map((field) => field.id),
  }
}

/**
 * Derive the complete `target` block: every frozen-template column plus every
 * `ext_` id supplied, all bound to their deterministic physical ids.
 */
export function deriveTargetBinding({ tenantId, objectId, projectId, extensionFieldIds = [] } = {}) {
  const resolvedObjectId = requiredString(objectId, 'objectId')
  const resolvedProjectId = projectId
    ? requiredString(projectId, 'projectId')
    : integrationCoreProjectId(requiredString(tenantId, 'tenantId'))

  const templateFieldIds = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id)

  const seen = new Set()
  const logicalIds = []
  for (const fieldId of templateFieldIds.concat(extensionFieldIds)) {
    if (seen.has(fieldId)) continue
    seen.add(fieldId)
    logicalIds.push(fieldId)
  }

  const fieldIdMap = {}
  for (const fieldId of logicalIds) {
    fieldIdMap[fieldId] = getObjectFieldId(resolvedProjectId, resolvedObjectId, fieldId)
  }

  return {
    projectId: resolvedProjectId,
    target: {
      sheetId: getObjectSheetId(resolvedProjectId, resolvedObjectId),
      objectId: resolvedObjectId,
      keyField: CANONICAL_KEY_FIELD,
      fieldIdMap,
    },
    extensionFieldIds: [...extensionFieldIds],
    counts: {
      templateFields: templateFieldIds.length,
      extensionFields: extensionFieldIds.length,
      bound: logicalIds.length,
    },
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      throw new DeriveTargetBindingError('INPUT_INVALID', `unexpected argument: ${arg}`, {})
    }
    const key = arg.slice(2)
    if (key === 'action-fragment' || key === 'compact' || key === 'help') {
      out[key] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new DeriveTargetBindingError('INPUT_INVALID', `--${key} needs a value`, { field: key })
    }
    out[key] = value
    index += 1
  }
  return out
}

const USAGE = `derive a stock-preparation table-action target binding (offline)

  --tenant-id <id>        tenant; projectId becomes <tenantId>:integration-core
  --project-id <id>       explicit projectId (overrides --tenant-id)
  --object-id <id>        the target objectId (e.g. plm_stock_preparation_sandbox_m0)
  --pack <file>           deploy-time pack JSON; its ext_ columns join the map
  --pack-id <id>          which pack in the file (required when it holds several)
  --action-fragment       print { target, extensionFieldIds }
  --compact               single-line JSON
`

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }

  let extensionFieldIds = []
  let packInfo = null
  if (args.pack) {
    const content = fs.readFileSync(args.pack, 'utf8')
    packInfo = extensionFieldIdsFromPack(content, {
      packId: args['pack-id'],
      objectId: args['object-id'],
    })
    extensionFieldIds = packInfo.extensionFieldIds
  }

  const derived = deriveTargetBinding({
    tenantId: args['tenant-id'],
    projectId: args['project-id'],
    objectId: args['object-id'],
    extensionFieldIds,
  })

  const payload = args['action-fragment']
    ? { target: derived.target, extensionFieldIds: derived.extensionFieldIds }
    : derived.target

  process.stdout.write(JSON.stringify(payload, null, args.compact ? 0 : 2))
  process.stdout.write('\n')

  // Diagnostics go to stderr so stdout stays a clean JSON pipe.
  process.stderr.write(
    `[derive-target-binding] projectId=${derived.projectId} objectId=${derived.target.objectId}`
    + ` sheetId=${derived.target.sheetId} template=${derived.counts.templateFields}`
    + ` ext=${derived.counts.extensionFields} bound=${derived.counts.bound}`
    + (packInfo ? ` pack=${packInfo.packId}@v${packInfo.packVersion}` : '')
    + '\n',
  )
  return 0
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    process.exit(main())
  } catch (error) {
    if (error instanceof DeriveTargetBindingError) {
      process.stderr.write(`[derive-target-binding] ${error.code}: ${error.message}\n`)
      if (Object.keys(error.details).length) {
        process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`)
      }
      process.exit(2)
    }
    throw error
  }
}
