'use strict'

// ONE fake `stockPreparationFieldPermissions` port, over ONE in-memory `field_permissions` table,
// implementing THE INVARIANT exactly once.
//
// WHY THIS EXISTS AS A SHARED MODULE. Before this, two plugin suites each carried their own fake
// port with its own hand-rolled ownership rule, and the host service carried a third in TypeScript.
// Three implementations of one rule is three chances to disagree, and round-2's adversarial pass
// found the installer and the port disagreeing about the same row in five different ways. The rule
// now appears ONCE per language: here for the CommonJS plugin suites, and in
// `packages/core-backend/src/services/stock-preparation-field-permissions.ts` for the host.
//
// AND THE TIE BETWEEN THE TWO IS NOT THIS FILE'S WORD. A fake that endorses itself proves nothing,
// so the correspondence is held by two things outside it:
//   * `packages/core-backend/tests/unit/stock-preparation-field-permissions.test.ts` runs the REAL
//     `classifyRoleWriteScopeRows` and the REAL SQL (decoded positionally from the statement text)
//     over the same scenarios; and
//   * `packages/core-backend/tests/integration/stock-preparation-fieldperm-write-gate-realdb.test.ts`
//     runs the REAL statements against real Postgres in CI.
// This file exists so the INSTALLER's behaviour can be exercised without a database — it is a
// stand-in for the host, never evidence about the host.
//
// THE ROW SHAPE IS THE REAL ONE, including the shape nobody likes: `createdBy` may be `null`, which
// is exactly what `routes/univer-meta.ts` wrote for every operator decision before it started
// stamping `operator:<actorId>`. Fixtures that only ever seed a tidy `operator:` string rehearse a
// world that does not exist yet (round-2 findings 14 and 16), so both shapes are first-class here.

const BASE_MARKER = 'plugin:plugin-integration-core/stock-preparation'
const OPERATOR_PREFIX = 'operator:'
const OPERATOR_ROUTE_MARKER = 'operator:univer-meta-authoring-route'

const markerFor = (packId) => `${BASE_MARKER}#${packId}`

/** The host's `parseStockPreparationFieldPermissionCreatedBy`, in the plugin's language. */
function parseCreatedBy(createdBy) {
  if (typeof createdBy !== 'string') return { isPluginRow: false, packId: null }
  if (createdBy === BASE_MARKER) return { isPluginRow: true, packId: null }
  const prefix = `${BASE_MARKER}#`
  if (createdBy.startsWith(prefix) && createdBy.length > prefix.length) {
    return { isPluginRow: true, packId: createdBy.slice(prefix.length) }
  }
  return { isPluginRow: false, packId: null }
}

const byPair = (left, right) => (left.fieldId === right.fieldId
  ? left.roleId.localeCompare(right.roleId)
  : left.fieldId.localeCompare(right.fieldId))

const keyOf = (row) => `${row.fieldId} ${row.roleId}`

/**
 * THE OWNER LADDER — five members, closed, in the host's own order. Everything else in this file is
 * a filter over its output.
 */
function classifyRows({ packId, entries, region, legacyAdoptable, rows }) {
  const fieldIds = new Set(region.fieldIds)
  const roleIds = new Set(region.roleIds)
  const declaredKeys = new Set(entries.map(keyOf))

  const out = {
    willRetire: [],
    packConflicts: [],
    legacyUnattributed: [],
    operatorHeldInRegion: [],
    governedByOtherPacks: [],
    operatorMustClear: [],
  }
  for (const row of rows) {
    const parsed = parseCreatedBy(row.createdBy)
    let owner
    if (!parsed.isPluginRow) owner = 'operator'
    else if (parsed.packId === null) owner = legacyAdoptable ? 'legacy_adoptable' : 'legacy_unattributed'
    else if (parsed.packId === packId) owner = 'this_pack'
    else owner = 'other_pack'

    const declared = declaredKeys.has(keyOf(row))
    const inRegion = fieldIds.has(row.fieldId) && roleIds.has(row.roleId)
    const pair = { fieldId: row.fieldId, roleId: row.roleId }

    if (!inRegion) {
      if ((owner === 'this_pack' || owner === 'legacy_adoptable') && row.readOnly === true && !declared) {
        out.operatorMustClear.push({ ...pair, packId: parsed.packId })
      }
      continue
    }
    if (owner === 'operator') {
      out.operatorHeldInRegion.push({
        ...pair,
        createdBy: typeof row.createdBy === 'string' ? row.createdBy : null,
        declared,
        visible: row.visible !== false,
        readOnly: row.readOnly === true,
      })
    } else if (owner === 'legacy_unattributed') {
      out.legacyUnattributed.push(pair)
    } else if (owner === 'other_pack') {
      if (declared) out.packConflicts.push({ ...pair, packId: parsed.packId })
      else out.governedByOtherPacks.push({ ...pair, packId: parsed.packId })
    } else if (!declared && row.readOnly === true) {
      out.willRetire.push(pair)
    }
  }
  for (const list of Object.values(out)) list.sort(byPair)
  return out
}

/**
 * Build the port.
 *
 *   rows              — a Map keyed `"<fieldId> <roleId>"`; values are
 *                       `{ fieldId, roleId, sheetId, visible, readOnly, createdBy }`.
 *   supportsReconcile — false models an OLDER host: it accepts `reconcile`, IGNORES it, returns no
 *                       `removed`, and (correctly) does not declare the capability marker. The
 *                       installer must refuse such a host rather than degrade against it.
 *   withClassify      — false models a host whose port predates the classifier entirely.
 *   withRoleCheck /
 *   withFieldCheck    — false models a host predating the matching pre-flight question.
 *   knownRoleIds /
 *   knownFieldIds     — null means "everything exists".
 */
function createWriteScopePort({
  supportsReconcile = true,
  withClassify = true,
  withRoleCheck = true,
  withFieldCheck = true,
  knownRoleIds = null,
  knownFieldIds = null,
  rows = new Map(),
} = {}) {
  const liveRows = (sheetId) => [...rows.values()].filter((row) => row.sheetId === sheetId)

  const port = {
    rows,
    applyCalls: [],
    classifyCalls: [],
    async applyRoleWriteScopes({ sheetId, entries, packId, reconcile, legacyAdoptable }) {
      this.applyCalls.push({ sheetId, entries, packId, reconcile, legacyAdoptable })
      // The host refuses an unattributable reconcile before it touches anything; so does this.
      if (reconcile && !packId) {
        throw fieldPermissionsError('ENTRIES_INVALID', 'reconcile requires a packId')
      }
      const createdBy = typeof packId === 'string' && packId ? markerFor(packId) : BASE_MARKER

      let classification = null
      let writeEntries = entries
      if (reconcile) {
        classification = classifyRows({
          packId,
          entries,
          region: reconcile,
          legacyAdoptable: legacyAdoptable === true,
          rows: liveRows(sheetId),
        })
        // THE TWO REFUSALS, before the first write — same order as the host.
        if (classification.packConflicts.length > 0) {
          throw fieldPermissionsError(
            'PACK_CONFLICT', 'another pack governs a declared pair', [], classification.packConflicts,
          )
        }
        if (classification.legacyUnattributed.length > 0) {
          throw fieldPermissionsError(
            'LEGACY_UNATTRIBUTED', 'unattributable pack-less rows in region', [],
            classification.legacyUnattributed,
          )
        }
        // OPERATOR DECISIONS WIN: the pair never reaches the upsert.
        const held = new Set(classification.operatorHeldInRegion.filter((r) => r.declared).map(keyOf))
        if (held.size > 0) writeEntries = entries.filter((entry) => !held.has(keyOf(entry)))
      }

      for (const entry of writeEntries) {
        const key = keyOf(entry)
        const existing = rows.get(key)
        if (existing) {
          // ALL THREE columns share ONE ownership guard, exactly as the DO UPDATE does. A row this
          // port does not own keeps its provenance AND its two permission dimensions.
          const owned = existing.createdBy === createdBy || existing.createdBy === BASE_MARKER
          rows.set(key, owned
            ? { ...existing, visible: true, readOnly: true, createdBy }
            : { ...existing })
        } else {
          rows.set(key, { ...entry, sheetId, visible: true, readOnly: true, createdBy })
        }
      }

      if (!supportsReconcile || !reconcile) return { applied: writeEntries.length, entries: writeEntries }

      const removed = []
      for (const pair of classification.willRetire) {
        rows.delete(keyOf(pair))
        removed.push({ ...pair })
      }
      return {
        applied: writeEntries.length,
        entries: writeEntries,
        removed,
        operatorHeld: classification.operatorHeldInRegion
          .filter((row) => row.declared)
          .map((row) => ({ fieldId: row.fieldId, roleId: row.roleId })),
        governedByOtherPacks: classification.governedByOtherPacks.map((row) => ({ ...row })),
      }
    },
    async listRoleWriteScopes({ sheetId }) {
      const entries = []
      const foreignEntries = []
      for (const row of liveRows(sheetId)) {
        if (row.readOnly !== true) continue
        const parsed = parseCreatedBy(row.createdBy)
        if (parsed.isPluginRow) {
          entries.push({
            fieldId: row.fieldId, roleId: row.roleId, createdBy: row.createdBy, packId: parsed.packId,
          })
        } else {
          foreignEntries.push({
            fieldId: row.fieldId,
            roleId: row.roleId,
            createdBy: typeof row.createdBy === 'string' ? row.createdBy : null,
          })
        }
      }
      entries.sort(byPair)
      foreignEntries.sort(byPair)
      return { sheetId, entries, foreignEntries }
    },
  }
  if (supportsReconcile) port.supportsWriteScopeReconcile = true
  if (withClassify) {
    port.classifyRoleWriteScopeRegion = async function classify({
      sheetId, entries, packId, reconcile, legacyAdoptable,
    }) {
      this.classifyCalls.push({ sheetId, entries, packId, reconcile, legacyAdoptable })
      return {
        sheetId,
        packId,
        legacyAdoptable: legacyAdoptable === true,
        ...classifyRows({
          packId,
          entries: entries || [],
          region: reconcile,
          legacyAdoptable: legacyAdoptable === true,
          rows: liveRows(sheetId),
        }),
      }
    }
  }
  if (withRoleCheck) {
    port.findMissingRoleIds = async ({ roleIds }) => ({
      missing: knownRoleIds === null
        ? []
        : [...new Set(roleIds)].filter((id) => !knownRoleIds.includes(id)).sort(),
    })
  }
  if (withFieldCheck) {
    port.findMissingFieldIds = async ({ fieldIds }) => ({
      missing: knownFieldIds === null
        ? []
        : [...new Set(fieldIds)].filter((id) => !knownFieldIds.includes(id)).sort(),
    })
  }
  return port
}

// The host's typed failure, in the shape `isFieldPermissionsError` recognises (name + reason).
function fieldPermissionsError(reason, message, offending = [], pairs = []) {
  const error = new Error(message)
  error.name = 'StockPreparationFieldPermissionsError'
  error.reason = reason
  error.offending = offending
  error.pairs = pairs
  return error
}

/** A row the given pack owns — the post-#5455, post-backfill shape. */
const packRow = (sheetId, fieldId, roleId, packId) => ({
  fieldId, roleId, sheetId, visible: true, readOnly: true, createdBy: markerFor(packId),
})

/** A row from before the marker carried a pack id. Adoptable ONLY against a proven sole pack. */
const legacyRow = (sheetId, fieldId, roleId) => ({
  fieldId, roleId, sheetId, visible: true, readOnly: true, createdBy: BASE_MARKER,
})

/**
 * A row a HUMAN authored. `createdBy` defaults to `null` — the shape the authoring route actually
 * wrote on every host in the field until this change — rather than to the tidy marker string.
 */
const operatorRow = (sheetId, fieldId, roleId, overrides = {}) => ({
  fieldId,
  roleId,
  sheetId,
  visible: true,
  readOnly: true,
  createdBy: null,
  ...overrides,
})

const seedRows = (...entries) => new Map(entries.map((row) => [keyOf(row), row]))

module.exports = {
  BASE_MARKER,
  OPERATOR_PREFIX,
  OPERATOR_ROUTE_MARKER,
  markerFor,
  parseCreatedBy,
  classifyRows,
  createWriteScopePort,
  fieldPermissionsError,
  packRow,
  legacyRow,
  operatorRow,
  seedRows,
  keyOf,
}
