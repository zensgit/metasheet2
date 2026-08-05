'use strict'

// K3WriteDecision (owner, 20260805): REQUIRE_NAMED_PROFILE_MAX3_AND_CONTENT_BOUND_APPROVAL —
// the content-bound half. This module gives the K3 WISE connector the C6 dry-run -> single-use
// token -> apply lifecycle that external-write-dry-run.cjs already provides for
// data-source:sql-write-gated and metasheet:multitable. Its own comment at :246 planned this
// exact slot: "an opt-in target (S1b-2 multitable, S2 K3) supplies its own profile".
//
// Three pieces, mirroring the multitable precedent (metasheet-multitable-target-adapter.cjs):
//   1. deriveK3WiseC6PlannerTargetConfig — flattens the K3 target into the planner's
//      {dataSourceId, object, keyFields, writableFields} shape, fail-closed on anything but
//      the named customer profile.
//   2. createK3WiseC6WriteSource — the dataSourceWrites facade (test/lookupByKey/insertRows/
//      updateRows) backed by the K3 adapter. Save-only and the maxApplyRows cap are the
//      adapter's own locks; this facade adds the content-bound approval plumbing on top.
//   3. K3_WISE_C6_WRITE_PROFILE — {kind, normalizeCapabilityState, assertSafeCapabilityState}.
//      The safety property is REAL, not a rubber stamp: the named customer profile must be
//      selected (which arms the save-only lifecycle lock) and the profile literal must carry
//      a positive row cap. A config that skipped the profile fails closed here, before any
//      row is even read.
//
// VALUES-FREE: everything this module reports upward is a closed-set code or a count.

const { AdapterValidationError } = require('../contracts.cjs')
const { K3_WISE_MATERIAL_PROFILES } = require('./k3-wise-document-templates.cjs')

const K3_WISE_C6_WRITE_TARGET_KIND = 'erp:k3-wise-webapi'
const CUSTOMER_PROFILE_ID = 'material-k3wise-customer-profile-v1'

const CUSTOMER_PROFILE = K3_WISE_MATERIAL_PROFILES[CUSTOMER_PROFILE_ID]
if (!CUSTOMER_PROFILE) {
  // Load-time, not call-time: if the named profile ever disappears the plugin fails to load,
  // which is the loudest possible tripwire.
  throw new Error(`K3 C6 write profile requires the named customer profile: ${CUSTOMER_PROFILE_ID}`)
}

// Single source: the plan-level row bound IS the profile literal's cap (frozen by S2).
// Reading it here instead of repeating `3` keeps exactly one record point for the number.
const K3_WISE_C6_MAX_APPLY_ROWS = CUSTOMER_PROFILE.maxApplyRows

const SCHEMA_FIELD_NAMES = new Set(
  (Array.isArray(CUSTOMER_PROFILE.schema) ? CUSTOMER_PROFILE.schema : [])
    .map((field) => field && field.name)
    .filter((name) => typeof name === 'string' && name.length > 0),
)

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdapterValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function selectedProfileId(system) {
  const objects = system && system.config && system.config.objects
  const material = objects && typeof objects === 'object' ? objects.material : undefined
  return material && typeof material === 'object' ? material.profile : undefined
}

// --- 1. planner target config ---------------------------------------------------------------

function deriveK3WiseC6PlannerTargetConfig({ system, object, fieldMappings = [] } = {}) {
  const objectId = requiredString(object, 'object')
  if (objectId !== 'material') {
    // First-version boundary: Material only. BOM write stays OFF (owner boundary), and there
    // is no named BOM customer profile to arm the locks with.
    throw new AdapterValidationError('K3 C6 write supports only the material object', { object: objectId })
  }
  if (selectedProfileId(system) !== CUSTOMER_PROFILE_ID) {
    // Fail-closed: without the named profile the save-only lifecycle lock and the row cap are
    // NOT armed in the adapter — planning a C6 write against such a config would borrow a
    // safety posture the target does not actually have.
    throw new AdapterValidationError(
      `K3 C6 write requires config.objects.material.profile = ${CUSTOMER_PROFILE_ID}`,
      { field: 'config.objects.material.profile' },
    )
  }
  const keyField = requiredString(CUSTOMER_PROFILE.keyField, 'profile.keyField')
  const keySet = new Set([keyField])
  const seen = new Set()
  const writableFields = []
  for (const mapping of Array.isArray(fieldMappings) ? fieldMappings : []) {
    const target = mapping && (mapping.targetField || mapping.target)
    if (typeof target !== 'string' || target.length === 0) continue
    if (keySet.has(target) || seen.has(target)) continue
    // Only fields the customer profile schema actually knows — an unmapped invented column
    // must not silently ride into the Save body.
    if (!SCHEMA_FIELD_NAMES.has(target)) continue
    seen.add(target)
    writableFields.push(target)
  }
  if (writableFields.length === 0) {
    throw new AdapterValidationError('K3 C6 write requires at least one mapped non-key writable field', {
      object: objectId,
    })
  }
  return {
    dataSourceId: requiredString(system && system.id, 'system.id'), // opaque identity token for the facade
    object: objectId,
    keyFields: [keyField],
    writableFields,
  }
}

// --- 2. the dataSourceWrites facade ---------------------------------------------------------

function createK3WiseC6WriteSource({ system, createAdapter } = {}) {
  if (typeof createAdapter !== 'function') {
    throw new AdapterValidationError('K3 C6 write source requires a createAdapter function', {
      field: 'createAdapter',
    })
  }
  let adapter = null
  function targetAdapter() {
    if (!adapter) adapter = createAdapter(system)
    return adapter
  }

  function saveFailure(result) {
    const first = Array.isArray(result && result.errors) && result.errors.length > 0 ? result.errors[0] : null
    const error = new Error('K3 WISE Save reported row failure')
    // valuesFreeErrorCode reads error.code first; keep it a closed-set token, never a message.
    error.code = (first && typeof first.code === 'string' && first.code) || 'K3_WISE_SAVE_FAILED'
    error.details = { code: error.code }
    return error
  }

  async function writeRows(object, rows, policy) {
    const result = await targetAdapter().upsert({
      object,
      records: rows,
      keyFields: policy.keyFields,
      // Explicit even though the save-only profile hard-locks them off — a reader of this
      // call site should not need the adapter internals to know no Submit/Audit happens.
      options: { autoSubmit: false, autoAudit: false },
    })
    if (!result || result.failed > 0 || result.written !== rows.length) {
      // The adapter COLLECTS row failures (returns counts) rather than throwing; the C6 apply
      // loop needs a throw to record the row error and dead-letter it. Convert here.
      throw saveFailure(result)
    }
    return result
  }

  return {
    // Capability state is CONFIG-derived, deliberately without a network probe: the property
    // being asserted is the safety posture (named profile selected -> save-only lock armed;
    // cap present), which lives in config. Connectivity is exercised by lookupByKey during
    // planning and fails the dry-run with its own transport codes — fail-closed either way.
    async test() {
      const profile = CUSTOMER_PROFILE
      return {
        success: true,
        capabilityState: {
          customerProfileSelected: selectedProfileId(system) === CUSTOMER_PROFILE_ID,
          saveOnlyLocked: profile.lifecycle === 'save-only',
          applyRowCapped: Number.isInteger(profile.maxApplyRows) && profile.maxApplyRows > 0,
        },
      }
    },

    async lookupByKey(dataSourceId, object, key, policy) {
      const keyField = policy.keyFields[0]
      try {
        const read = await targetAdapter().read({
          object,
          filters: { [keyField]: key[keyField] },
        })
        return { data: Array.isArray(read && read.records) ? read.records : [] }
      } catch (error) {
        const code = error && error.details && error.details.code
        if (code === 'K3_WISE_READ_BUSINESS_ERROR') {
          // DESIGN NOTE (first version, 1-3 rows, human-approved): K3 GetDetail reports a
          // NONEXISTENT material as a business-level failure — indistinguishable at the
          // adapter from other business refusals. We treat it as "absent" so planning a NEW
          // material (the primary use case) classifies as `add`. The Save at apply remains
          // the authority: if K3 was actually unhappy, the Save fails and is dead-lettered.
          // Transport/login failures do NOT take this branch — they rethrow and fail the
          // dry-run closed.
          return { data: [] }
        }
        throw error
      }
    },

    async insertRows(dataSourceId, object, rows, policy) {
      return writeRows(object, rows, policy)
    },

    async updateRows(dataSourceId, object, rows, policy) {
      // K3 Save IS upsert — add and update are the same endpoint with the same body. The
      // decision split still matters upstream (preview counts, fingerprints, provenance).
      return writeRows(object, rows, policy)
    },
  }
}

// --- 3. the profile -------------------------------------------------------------------------

const K3_WISE_C6_WRITE_PROFILE = {
  kind: K3_WISE_C6_WRITE_TARGET_KIND,
  normalizeCapabilityState(result) {
    const state = result && result.capabilityState
    if (
      !state || typeof state !== 'object' ||
      typeof state.customerProfileSelected !== 'boolean' ||
      typeof state.saveOnlyLocked !== 'boolean' ||
      typeof state.applyRowCapped !== 'boolean'
    ) {
      throw new AdapterValidationError('K3 C6 write target capability state is unavailable', {
        field: 'capabilityState',
      })
    }
    return {
      success: result.success === true,
      customerProfileSelected: state.customerProfileSelected,
      saveOnlyLocked: state.saveOnlyLocked,
      applyRowCapped: state.applyRowCapped,
    }
  },
  assertSafeCapabilityState(state) {
    // Real safety property: the named customer profile is what ARMS the adapter's save-only
    // lifecycle lock and carries the frozen row cap. Any of the three false -> the write
    // would run without the posture this lifecycle promises -> fail closed.
    if (state.customerProfileSelected !== true || state.saveOnlyLocked !== true || state.applyRowCapped !== true) {
      throw new AdapterValidationError('K3 C6 write target is not customer-profile locked', {
        field: 'capabilityState',
      })
    }
  },
}

module.exports = {
  K3_WISE_C6_WRITE_TARGET_KIND,
  K3_WISE_C6_MAX_APPLY_ROWS,
  K3_WISE_C6_WRITE_PROFILE,
  createK3WiseC6WriteSource,
  deriveK3WiseC6PlannerTargetConfig,
}
