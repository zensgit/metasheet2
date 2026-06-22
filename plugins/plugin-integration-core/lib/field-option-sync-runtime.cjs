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
  // FOS-2b: sync-mode runtime. Defaults reproduce the pre-FOS-2b behavior EXACTLY (replace +
  // update_from_source = full overwrite, no read, no merge) so stock-prep stays byte-identical.
  syncMode = 'replace',
  conflictPolicy = 'update_from_source',
  // readCurrentOptions(field) => Promise<optionObject[]|null> — required ONLY for non-default modes
  // (append / disable_missing / keep_existing / manual_confirm), wired by the caller to getObjectField.
  readCurrentOptions,
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
  // ZERO-DRIFT fast path: replace + update_from_source = the exact pre-FOS-2b behavior (no read, no
  // merge). stock-prep stays here. Any other mode reads current options + merges.
  const isDefaultMode = syncMode === 'replace' && conflictPolicy === 'update_from_source'
  if (!isDefaultMode && typeof readCurrentOptions !== 'function') {
    throw new TypeError('syncFieldOptions: non-default syncMode/conflictPolicy requires readCurrentOptions(field)')
  }
  const synced = []
  const skipped = []
  const held = []

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

    let effectiveSet = set
    if (!isDefaultMode) {
      const current = (await readCurrentOptions(field)) || []
      const sourceOptions = Array.isArray(set.options) ? set.options : []
      // manual_confirm NEVER writes: collect values-free held evidence (counts only) of what would change.
      if (conflictPolicy === 'manual_confirm') {
        held.push({
          field: field.id,
          optionSource: { ...field.optionSource },
          ...diffOptionCounts(current, sourceOptions, syncMode),
        })
        continue
      }
      effectiveSet = { ...set, options: mergeFieldOptions(current, sourceOptions, syncMode, conflictPolicy) }
    }

    let propertyPatch
    try {
      propertyPatch = buildPropertyPatch(field, effectiveSet)
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
      set: effectiveSet,
    })
  }

  // A manual_confirm preview (held > 0) is a valid no-write outcome, not "nothing synced".
  if (synced.length === 0 && held.length === 0) {
    throw errorFactory.noFieldsSynced({ targetObjectId, skipped })
  }

  return { synced, skipped, held }
}

// FOS-2b: merge current + source options per syncMode × conflictPolicy. Pure function (no I/O).
// - append: keep all current, add new-from-source (NOTHING removed).
// - disable_missing: source set + current-not-in-source marked disabled (NEVER removed/deleted).
// - replace (only reached with a non-default conflictPolicy): source set; current-not-in-source
//   dropped (replace semantics). (replace + update_from_source never reaches here — fast path.)
// conflictPolicy for overlapping values: keep_existing preserves the CURRENT option's fields
// (human label/color/etc.); update_from_source takes the source option.
function mergeFieldOptions(current, source, syncMode, conflictPolicy) {
  const cur = Array.isArray(current) ? current : []
  const src = Array.isArray(source) ? source : []
  const curByValue = new Map(cur.map((o) => [o.value, o]))
  const srcByValue = new Map(src.map((o) => [o.value, o]))
  const resolveOverlap = (c, s) => (conflictPolicy === 'keep_existing' ? { ...c } : { ...s })

  if (syncMode === 'append') {
    const out = []
    const seen = new Set()
    for (const c of cur) {
      const s = srcByValue.get(c.value)
      out.push(s ? resolveOverlap(c, s) : { ...c })
      seen.add(c.value)
    }
    for (const s of src) {
      if (!seen.has(s.value)) out.push({ ...s })
    }
    return out
  }

  if (syncMode === 'disable_missing') {
    const out = []
    const seen = new Set()
    for (const s of src) {
      const c = curByValue.get(s.value)
      out.push(c ? resolveOverlap(c, s) : { ...s })
      seen.add(s.value)
    }
    for (const c of cur) {
      if (!seen.has(c.value)) out.push({ ...c, disabled: true }) // disable, NEVER delete
    }
    return out
  }

  // replace with a non-default conflictPolicy (e.g. replace + keep_existing).
  return src.map((s) => {
    const c = curByValue.get(s.value)
    return c ? resolveOverlap(c, s) : { ...s }
  })
}

// FOS-2b: values-free diff counts for manual_confirm held evidence (counts only — no values/labels).
function diffOptionCounts(current, source, syncMode) {
  const curValues = new Set((Array.isArray(current) ? current : []).map((o) => o.value))
  const srcValues = new Set((Array.isArray(source) ? source : []).map((o) => o.value))
  let wouldAdd = 0
  let wouldUpdate = 0
  let wouldDisable = 0
  for (const v of srcValues) {
    if (curValues.has(v)) wouldUpdate += 1
    else wouldAdd += 1
  }
  if (syncMode === 'disable_missing') {
    for (const v of curValues) if (!srcValues.has(v)) wouldDisable += 1
  }
  return { wouldAdd, wouldUpdate, wouldDisable }
}

module.exports = {
  syncFieldOptions,
  mergeFieldOptions,
  diffOptionCounts,
}
