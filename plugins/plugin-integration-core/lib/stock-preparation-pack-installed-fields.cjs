'use strict'

// THE READ-BACK SEAM — how a pack-aware refresh learns which `ext_` columns a sheet carries.
//
// THE SPLIT THAT MAKES THIS SAFE:
//   * the LEDGER supplies CANDIDATES + PROVENANCE — "these ids were installed by pack X".
//   * the HOST supplies LIVE TRUTH — readObjectFieldsContent returns the actual
//     {name, type, property, order} for the ids that still exist.
// Neither half is trusted for the other's job. A column deleted in the UI after the install simply
// drops out of the host's response and is gone from the projection: staleness is solved by the
// shape, not by an invalidation protocol. A ledger row can never resurrect a column, and the host
// can never tell us which pack a column came from.
//
// WHY THERE IS NO NEW HOST PRIMITIVE HERE. The plugin provisioning surface has no list-fields call —
// every read is keyed by ids the caller must already hold. Adding one would be a real plugin-API
// contract change handing EVERY plugin whole-schema enumeration of a tenant's sheets, and it still
// would not answer the question this seam answers, because a bare field list carries no pack
// provenance. The ledger is the cheaper and the more truthful of the two.
//
// AND NO PLANNER EDIT. derivePackAwarePlmWritableFields already takes `installedFieldProperties` as
// an OPTIONAL input whose omission is byte-identical to the legacy bands. This module produces
// exactly that input, or `undefined`.
//
// DEGRADATION IS DELIBERATELY TOWARD LEGACY, and that is the safe direction, not a compromise:
// without the projection the planner returns the frozen-template bands, which contain NO `ext_`
// column at all. A pack column is then neither writable nor in the payload — the refresh writes
// strictly FEWER columns, never more. Failing the whole refresh instead would take the refresh path
// down for every tenant the moment this ledger is unavailable (an unapplied migration, say), which
// is a bigger hazard than a narrower write. So: a read failure logs a values-free warning and
// returns undefined.
//
// Values-free: logical ids in, {fieldId, property} out. Nothing here reads or logs a cell.

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function warn(logger, message) {
  const sink = logger && typeof logger.warn === 'function' ? logger : null
  if (sink) sink.warn(`[plugin-integration-core] ${message}`)
}

/**
 * Project what is ACTUALLY installed on one stock-preparation sheet, ready to hand to
 * derivePackAwarePlmWritableFields / the apply writer as `installedFieldProperties`.
 *
 *   packInstallStore — optional; absent (or without listInstalledFieldIds) → undefined → legacy.
 *   provisioning     — host multitable provisioning; needs only readObjectFieldsContent.
 *   tenantId / projectId / objectId — the ledger scope.
 *   logger           — optional; values-free warnings only.
 *
 * @returns {Promise<Array<{fieldId: string, property: object}>|undefined>} undefined means
 *          "no pack-aware information available" — the caller must then omit the parameter entirely
 *          so the planner takes its legacy path.
 */
async function loadPackInstalledFieldProperties({
  packInstallStore,
  provisioning,
  tenantId,
  projectId,
  objectId,
  logger,
} = {}) {
  if (!packInstallStore || typeof packInstallStore.listInstalledFieldIds !== 'function') return undefined
  if (!provisioning || typeof provisioning.readObjectFieldsContent !== 'function') return undefined
  const tenant = optionalString(tenantId)
  const project = optionalString(projectId)
  const object = optionalString(objectId)
  if (!tenant || !project || !object) return undefined

  let candidates
  try {
    candidates = await packInstallStore.listInstalledFieldIds({
      tenantId: tenant,
      projectId: project,
      objectId: object,
    })
  } catch (error) {
    warn(logger, `pack install ledger read failed; refresh falls back to template bands (${(error && error.code) || 'LEDGER_READ_FAILED'})`)
    return undefined
  }

  const fieldIds = candidates && Array.isArray(candidates.fieldIds) ? candidates.fieldIds : []
  // No pack installed on this sheet is not a degradation — it is the accurate answer, and the
  // accurate answer is legacy bands. Returning [] instead would flip the planner into packAware
  // mode with nothing to classify, which reports a different (and misleading) posture.
  if (fieldIds.length === 0) return undefined

  let content
  try {
    content = await provisioning.readObjectFieldsContent({
      projectId: project,
      objectId: object,
      fieldIds,
    })
  } catch (error) {
    warn(logger, `installed field read failed; refresh falls back to template bands (${(error && error.code) || 'FIELD_READ_FAILED'})`)
    return undefined
  }

  const byLogicalId = isPlainObject(content) ? content : {}
  const installed = []
  for (const fieldId of fieldIds) {
    const live = byLogicalId[fieldId]
    // LIVENESS: absent from the host's response == the column is not on the sheet any more (deleted
    // in the UI, or never created because the install failed before this id). It drops out here and
    // the planner never sees it. This is the entire staleness story.
    if (!isPlainObject(live)) continue
    installed.push({
      fieldId,
      // The planner reads property.stockPreparation; passing the WHOLE property (not a pre-chewed
      // stanza) keeps the host's response the single source of classification, including the
      // malformed-stanza case the planner is written to fail closed on.
      property: isPlainObject(live.property) ? live.property : {},
    })
  }

  // Every candidate is gone: the sheet no longer carries any pack column, which is legacy again.
  if (installed.length === 0) return undefined
  return installed
}

function sqlStateOf(error) {
  const code = error && typeof error.code === 'string' ? error.code : ''
  return /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}

function readFailed(operation, error) {
  const sqlState = sqlStateOf(error)
  return Object.freeze({ state: 'read_failed', operation, ...(sqlState ? { sqlState } : {}) })
}

/**
 * THE STRICT READ (batch-refresh step 4 PR-3a, TD-22 / refuter R-2) — the same projection as
 * `loadPackInstalledFieldProperties`, for a GOVERNED computation only. There the band is not a write-width
 * preference: it decides the content-trigger list and `nameAndSpecDeclared` (pairing.cjs
 * prepareGovernedPlanning), the seven items a continuation is verified on, and the machine band the
 * settlement digest covers. A band GUESSED from a failed read would verify a valid continuation as
 * `evidence_changed` (sticky) and settle over the wrong columns, so this reader NEVER degrades: it answers a
 * state, and the lane turns `read_failed` into 503 and `unavailable` into 501 before any source read.
 *
 *   { state: 'installed', installedFieldProperties }    the live projection (exactly the loader's)
 *   { state: 'no_pack' }                                 the accurate legacy answer: nothing installed, or
 *                                                        every installed column is gone from the sheet
 *   { state: 'unavailable', reason }                     'pack_install_ledger' (no ledger to ask) or
 *                                                        'pack_field_read' (candidates, but no host read)
 *   { state: 'read_failed', operation, sqlState? }       'ledger_read' / 'field_read' threw or answered
 *                                                        something that is not an answer
 *
 * Never throws for IO. Values-free: a SQLSTATE class code at most — no message, no id, no field name.
 * The fail-open loader above is UNCHANGED and stays the not-governed path (its warnings byte for byte).
 */
async function readPackInstalledFieldPropertiesStrict({
  packInstallStore,
  provisioning,
  tenantId,
  projectId,
  objectId,
} = {}) {
  if (!packInstallStore || typeof packInstallStore.listInstalledFieldIds !== 'function') {
    return Object.freeze({ state: 'unavailable', reason: 'pack_install_ledger' })
  }
  const tenant = optionalString(tenantId)
  const project = optionalString(projectId)
  const object = optionalString(objectId)
  if (!tenant || !project || !object) return Object.freeze({ state: 'unavailable', reason: 'pack_install_ledger' })

  let candidates
  try {
    candidates = await packInstallStore.listInstalledFieldIds({ tenantId: tenant, projectId: project, objectId: object })
  } catch (error) {
    return readFailed('ledger_read', error)
  }
  if (!isPlainObject(candidates) || !Array.isArray(candidates.fieldIds) || !candidates.fieldIds.every((fieldId) => typeof fieldId === 'string' && fieldId.trim() !== '')) {
    return readFailed('ledger_read', null)
  }
  const fieldIds = candidates.fieldIds
  if (fieldIds.length === 0) return Object.freeze({ state: 'no_pack' })

  if (!provisioning || typeof provisioning.readObjectFieldsContent !== 'function') {
    return Object.freeze({ state: 'unavailable', reason: 'pack_field_read' })
  }
  let content
  try {
    content = await provisioning.readObjectFieldsContent({ projectId: project, objectId: object, fieldIds })
  } catch (error) {
    return readFailed('field_read', error)
  }
  if (!isPlainObject(content)) return readFailed('field_read', null)

  const installed = []
  for (const fieldId of fieldIds) {
    const live = content[fieldId]
    if (!isPlainObject(live)) continue
    installed.push({ fieldId, property: isPlainObject(live.property) ? live.property : {} })
  }
  if (installed.length === 0) return Object.freeze({ state: 'no_pack' })
  return Object.freeze({ state: 'installed', installedFieldProperties: installed })
}

module.exports = {
  loadPackInstalledFieldProperties,
  readPackInstalledFieldPropertiesStrict,
}
