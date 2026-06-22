'use strict'

// FOS-2: generic field-option-sync runtime kernel.
//
// This is the SINGLE place option-field metadata is written through the scoped multitable
// provisioning API. It writes only target field metadata; it never writes business rows, never
// reads PLM, never calls K3, and never accepts SQL/JS/function bodies from the browser.
//
// Stock-preparation is now a THIN WRAPPER over this kernel (lib/stock-preparation-option-sync.cjs):
// it supplies its template-derived optionFields, its exact `{options, stockPreparation:{…}}`
// buildPropertyPatch, its skip-reason vocabulary, and its OPTION_SYNC_* error factory. The generic
// route (POST /api/integration/field-options/sync) supplies a FOS-preset-derived optionFields, a
// generic `{options, fieldOptionSync:{…}}` buildPropertyPatch, and a generic error factory. The
// loop / skip / patch / error-if-none semantics live ONLY here, so the two callers cannot diverge.
//
// The kernel makes NO assumptions about the option-set shape beyond `{ options: [...] }`: the
// caller's buildPropertyPatch owns the exact patch body, and the caller builds its own evidence
// from the returned { synced, skipped } pieces.

// Run the generic option-sync loop.
//
//   provisioning      — scoped multitable provisioning API (must expose patchObjectFieldProperty)
//   projectId         — already-resolved, validated project id
//   targetObjectId    — the canonical object id patches are written against
//   optionFields      — [{ id, optionSource: { key, type } }] (field id ↔ source key mapping)
//   optionSets        — { [sourceKey]: { options: [...], ... } } (caller-normalized)
//   buildPropertyPatch(field, set) — returns the EXACT propertyPatch body for this caller
//   resolveSkipReason(field)       — returns the caller's skip reason for an absent source key
//   errorFactory      — { patchFailed({ field, sourceKey, error }), noFieldsSynced({ targetObjectId, skipped }) }
//
// Returns { synced, skipped } where each synced entry = { field, optionSource, set } and each
// skipped entry = { field, optionSource, reason }. Callers summarize their own values-free evidence.
async function syncFieldOptions({
  provisioning,
  projectId,
  targetObjectId,
  optionFields,
  optionSets,
  buildPropertyPatch,
  resolveSkipReason,
  errorFactory,
} = {}) {
  if (!provisioning || typeof provisioning.patchObjectFieldProperty !== 'function') {
    throw new TypeError('syncFieldOptions requires provisioning.patchObjectFieldProperty')
  }
  if (typeof buildPropertyPatch !== 'function') {
    throw new TypeError('syncFieldOptions requires a buildPropertyPatch(field, set) function')
  }
  if (typeof resolveSkipReason !== 'function') {
    throw new TypeError('syncFieldOptions requires a resolveSkipReason(field) function')
  }
  if (
    !errorFactory ||
    typeof errorFactory.patchFailed !== 'function' ||
    typeof errorFactory.noFieldsSynced !== 'function'
  ) {
    throw new TypeError('syncFieldOptions requires errorFactory.patchFailed and errorFactory.noFieldsSynced')
  }

  const fields = Array.isArray(optionFields) ? optionFields : []
  const sets = optionSets && typeof optionSets === 'object' ? optionSets : {}
  const synced = []
  const skipped = []

  for (const field of fields) {
    const sourceKey = field.optionSource.key
    const set = sets[sourceKey]
    if (!set) {
      skipped.push({
        field: field.id,
        optionSource: { ...field.optionSource },
        reason: resolveSkipReason(field),
      })
      continue
    }
    let propertyPatch
    try {
      propertyPatch = buildPropertyPatch(field, set)
      await provisioning.patchObjectFieldProperty({
        projectId,
        objectId: targetObjectId,
        fieldId: field.id,
        propertyPatch,
      })
    } catch (error) {
      throw errorFactory.patchFailed({ field: field.id, sourceKey, error })
    }
    synced.push({
      field: field.id,
      optionSource: { ...field.optionSource },
      set,
    })
  }

  if (synced.length === 0) {
    throw errorFactory.noFieldsSynced({ targetObjectId, skipped })
  }

  return { synced, skipped }
}

module.exports = {
  syncFieldOptions,
}
