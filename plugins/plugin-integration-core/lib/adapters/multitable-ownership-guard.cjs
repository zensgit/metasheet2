'use strict'

// ---------------------------------------------------------------------------
// Multitable ownership write-guard - plugin-integration-core
//
// The GENERIC metasheet:multitable target adapter writes whatever a Data Factory
// pipeline hands it. That is correct for a plain cleansed-output sheet, and WRONG
// for an ownership-tagged sheet: the stock-preparation landing table carries columns
// a human owns (decisions, notes, overrides). A pipeline refresh that patched those
// back to the upstream value would destroy work with no trace.
//
// The stock-prep line's OWN writers already have that wall
// (stock-preparation-apply-writer.cjs assertNoHumanFields, which rejects a fixed
// vocabulary of human field ids). This guard is the generic equivalent: it does not
// know any field vocabulary, it reads the ownership tag off the target sheet's own
// field metadata, so ANY sheet that carries the tag is protected against ANY pipeline.
//
// Ownership metadata lives in the multitable field `property` (jsonb) under two
// namespaces, both honored here:
//   property.stockPreparation    - canonical target provisioning, and the customer-pack
//                                  installer's extension fields (same namespace, plus
//                                  extension/packId/packVersion keys this guard ignores)
//   property.stockPreparationMvp - MVP provisioning
// A field is PROTECTED when either namespace says ownership === 'human_preserved'
// OR preserveOnRefresh === true. Either one alone is enough.
//
// Posture:
//   - reader present, metadata read OK  -> protected fields stripped from the write
//                                          payload; a payload that becomes empty
//                                          BECAUSE of stripping is skipped, not failed.
//   - reader present, metadata read FAILS-> typed refusal. The guard cannot tell a
//                                          protected sheet from a plain one, and a
//                                          silent clobber is the worst outcome.
//   - reader ABSENT (legacy construction)-> behave exactly as before + warn once per
//                                          run. Hard-failing every pre-existing
//                                          pipeline on day one is a rollout hazard;
//                                          the warn is what creates migration pressure.
//   - sheet with NO ownership metadata   -> nothing is protected, payloads are
//                                          byte-identical to the pre-guard adapter.
// ---------------------------------------------------------------------------

const OWNERSHIP_PROPERTY_NAMESPACES = Object.freeze(['stockPreparation', 'stockPreparationMvp'])
const HUMAN_PRESERVED_OWNERSHIP = 'human_preserved'

const OWNERSHIP_GUARD_UNVERIFIED = 'METASHEET_MULTITABLE_OWNERSHIP_UNVERIFIED'
const OWNERSHIP_GUARD_PROTECTED_KEY_FIELD = 'METASHEET_MULTITABLE_OWNERSHIP_PROTECTED_KEY_FIELD'

const GUARD_INACTIVE_NO_READER = 'no fields reader'
const GUARD_INACTIVE_NO_PROJECT_ID = 'target object has no projectId'

// Typed refusal. Distinct from AdapterValidationError on purpose: a per-row validation
// failure is itemized and the run continues, while an unverifiable ownership state must
// stop the whole write. Details carry counts and LOGICAL field key names only - never a
// cell value, host, or credential. The underlying cause rides Error `cause`, which is
// non-enumerable and therefore never lands in a serialized (values-free) evidence blob.
class MultitableOwnershipGuardError extends Error {
  constructor(message, details = {}, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MultitableOwnershipGuardError'
    this.code = details.code || OWNERSHIP_GUARD_UNVERIFIED
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// Protected := ownership 'human_preserved' OR preserveOnRefresh === true, in EITHER
// namespace. preserveOnRefresh alone is enough on purpose: a plm_system column may still
// be pinned by a human decision, and that pin is exactly what a refresh must not undo.
function isProtectedFieldProperty(property) {
  if (!isPlainObject(property)) return false
  for (const namespace of OWNERSHIP_PROPERTY_NAMESPACES) {
    const meta = property[namespace]
    if (!isPlainObject(meta)) continue
    if (meta.ownership === HUMAN_PRESERVED_OWNERSHIP) return true
    if (meta.preserveOnRefresh === true) return true
  }
  return false
}

// The fields reader is NOT a new host surface: it is the same DB-backed field-content read
// (`{logicalFieldId: {name, type, property, order}}`) the stock-preparation provisioning
// modules use for their before/after mutation snapshots. Discovering it off the context the
// adapter already receives keeps every existing construction working unchanged - a host or
// test double that predates it simply has no `readObjectFieldsContent`, which is the
// legacy/inactive case.
function resolveFieldsReader(context) {
  const provisioning = context && context.api && context.api.multitable && context.api.multitable.provisioning
  if (!provisioning || typeof provisioning.readObjectFieldsContent !== 'function') return null
  return (input) => provisioning.readObjectFieldsContent(input)
}

const INACTIVE_SHIELD = Object.freeze({
  active: false,
  isProtected() { return false },
  strip(payload) { return { data: payload, stripped: 0, skip: false } },
})

function createMultitableOwnershipGuard({ context, logger, fieldsReader } = {}) {
  const reader = typeof fieldsReader === 'function' ? fieldsReader : resolveFieldsReader(context)
  const warnTarget = logger && typeof logger.warn === 'function'
    ? logger
    : (context && context.logger && typeof context.logger.warn === 'function' ? context.logger : console)

  // Per (run, target sheet) cache: the adapter/write-source instance IS the run scope, the
  // same scope the existing logical->physical fieldMapCache uses. The reader is called once
  // for the whole candidate field set, not once per row.
  const objectStates = new Map()
  const warnedReasons = new Set()
  let guardActive = false
  let protectedFieldsStripped = 0
  let rowsSkippedEmptyAfterStrip = 0

  function warnOnce(reason) {
    if (warnedReasons.has(reason)) return
    warnedReasons.add(reason)
    if (warnTarget && typeof warnTarget.warn === 'function') {
      warnTarget.warn(`[plugin-integration-core] metasheet:multitable ownership guard inactive: ${reason}`)
    }
  }

  async function fetchInto(state, objectId, projectId, fieldIds) {
    let content
    try {
      content = await reader({ projectId, objectId, fieldIds })
    } catch (error) {
      throw new MultitableOwnershipGuardError(
        'metasheet:multitable ownership guard could not read target field ownership metadata',
        { code: OWNERSHIP_GUARD_UNVERIFIED, object: objectId, reason: 'fields_read_failed', fieldCount: fieldIds.length },
        error,
      )
    }
    if (!isPlainObject(content)) {
      throw new MultitableOwnershipGuardError(
        'metasheet:multitable ownership guard received malformed field ownership metadata',
        { code: OWNERSHIP_GUARD_UNVERIFIED, object: objectId, reason: 'fields_read_malformed', fieldCount: fieldIds.length },
      )
    }
    for (const fieldId of fieldIds) state.inspected.add(fieldId)
    // A field absent from the response does not physically exist on the sheet, so it carries
    // no ownership tag and nothing can be clobbered through it.
    for (const [fieldId, entry] of Object.entries(content)) {
      if (isProtectedFieldProperty(entry && entry.property)) state.protectedFields.add(fieldId)
    }
  }

  function stateFor(objectId) {
    let state = objectStates.get(objectId)
    if (!state) {
      state = { inspected: new Set(), protectedFields: new Set(), queue: Promise.resolve() }
      objectStates.set(objectId, state)
    }
    return state
  }

  // Resolves the per-object shield. `candidateFields` is the set of LOGICAL field names the
  // caller is about to write; only those can be clobbered, so only those are looked up.
  async function forObject(objectConfig, candidateFields = []) {
    const objectId = optionalString(objectConfig && objectConfig.objectId)
    if (!reader || !objectId) {
      warnOnce(GUARD_INACTIVE_NO_READER)
      return INACTIVE_SHIELD
    }
    const projectId = optionalString(objectConfig && objectConfig.projectId)
    if (!projectId) {
      // The reader is keyed by (projectId, objectId); without a projectId it cannot be called
      // at all. That is the same class of gap as an absent reader - a legacy construction, not
      // a failed read - so it takes the same warn-and-passthrough posture rather than failing
      // every projectId-less pipeline closed on day one. Any ownership-tagged target is
      // provisioned under a projectId, so a protected sheet does not land here.
      warnOnce(GUARD_INACTIVE_NO_PROJECT_ID)
      return INACTIVE_SHIELD
    }

    guardActive = true
    const state = stateFor(objectId)
    const wanted = Array.from(new Set(
      (Array.isArray(candidateFields) ? candidateFields : [])
        .map((field) => optionalString(field))
        .filter(Boolean),
    ))
    // Serialize through the object's own queue so a re-entrant call cannot issue a second
    // read for fields the first call is already fetching.
    state.queue = state.queue.then(async () => {
      const pending = wanted.filter((field) => !state.inspected.has(field))
      if (pending.length === 0) return
      await fetchInto(state, objectId, projectId, pending)
    })
    await state.queue

    return {
      active: true,
      isProtected(field) {
        return state.protectedFields.has(field)
      },
      // Returns the payload to WRITE. `skip` is true only when stripping is what emptied the
      // payload - an already-empty payload keeps its pre-guard behavior.
      strip(payload) {
        if (!isPlainObject(payload)) return { data: payload, stripped: 0, skip: false }
        const kept = {}
        let stripped = 0
        for (const [field, value] of Object.entries(payload)) {
          if (state.protectedFields.has(field)) {
            stripped += 1
            continue
          }
          kept[field] = value
        }
        if (stripped === 0) return { data: payload, stripped: 0, skip: false }
        protectedFieldsStripped += stripped
        const skip = Object.keys(kept).length === 0
        if (skip) rowsSkippedEmptyAfterStrip += 1
        return { data: kept, stripped, skip }
      },
    }
  }

  // A protected KEY field cannot simply be stripped: the create path would then write a row
  // with no key, and the next refresh would look it up, miss, and create a duplicate. That is
  // a target misconfiguration, so it fails the whole operation closed instead.
  function assertKeyFieldsWritable(shield, objectId, keyFields = []) {
    if (!shield || shield.active !== true) return
    const blocked = keyFields.filter((field) => shield.isProtected(field))
    if (blocked.length === 0) return
    throw new MultitableOwnershipGuardError(
      'metasheet:multitable upsert key field is owned by a human and cannot be written',
      { code: OWNERSHIP_GUARD_PROTECTED_KEY_FIELD, object: objectId, fields: blocked },
    )
  }

  return {
    forObject,
    assertKeyFieldsWritable,
    // Values-free run summary: counts plus one boolean, no field values of any kind.
    summary() {
      return {
        guardActive,
        protectedFieldsStripped,
        rowsSkippedEmptyAfterStrip,
      }
    },
  }
}

module.exports = {
  HUMAN_PRESERVED_OWNERSHIP,
  OWNERSHIP_PROPERTY_NAMESPACES,
  OWNERSHIP_GUARD_UNVERIFIED,
  OWNERSHIP_GUARD_PROTECTED_KEY_FIELD,
  MultitableOwnershipGuardError,
  createMultitableOwnershipGuard,
  __internals: {
    isProtectedFieldProperty,
    resolveFieldsReader,
  },
}
