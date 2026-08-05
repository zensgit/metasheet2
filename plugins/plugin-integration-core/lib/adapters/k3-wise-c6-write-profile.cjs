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
const { resolveEffectiveK3WiseObjects } = require('./k3-wise-webapi-adapter.cjs')

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
  // Review #4761 P1: the Save body is composed from the EFFECTIVE merged schema (profile merge
  // + operator overlay — an FE overlay REPLACES the schema array wholly), not from the profile
  // literal. A field allowed by the literal but absent from the effective schema would be
  // previewed and FINGERPRINTED by the dry-run yet silently dropped from the actual Save —
  // the human would approve content that is not what gets written. The allowlist is therefore
  // the INTERSECTION: profile-sanctioned (literal) AND Save-composable (effective). The
  // intersection also keeps deliberately-omitted fields out (FBaseUnitID broke the M1 dry-run;
  // an operator overlay carrying it must not smuggle it back in).
  const effectiveObjects = resolveEffectiveK3WiseObjects(system.config)
  const effectiveMaterial = effectiveObjects && effectiveObjects.material
  const effectiveNames = new Set(
    (effectiveMaterial && Array.isArray(effectiveMaterial.schema) ? effectiveMaterial.schema : [])
      .map((field) => field && field.name)
      .filter((name) => typeof name === 'string' && name.length > 0),
  )
  const keySet = new Set([keyField])
  const seen = new Set()
  const writableFields = []
  for (const mapping of Array.isArray(fieldMappings) ? fieldMappings : []) {
    const target = mapping && (mapping.targetField || mapping.target)
    if (typeof target !== 'string' || target.length === 0) continue
    if (keySet.has(target) || seen.has(target)) continue
    if (!SCHEMA_FIELD_NAMES.has(target) || !effectiveNames.has(target)) {
      // Review #4761 P2: silence was the bug — an operator mapped a field this write cannot
      // carry, and a silent drop means the pipeline LOOKS configured while quietly writing
      // less. Fail closed with the field named (schema identifiers are structural, not
      // business values).
      throw new AdapterValidationError('K3 C6 write cannot carry a mapped target field', {
        code: 'K3_C6_UNSUPPORTED_TARGET_FIELD',
        field: target,
        profileSanctioned: SCHEMA_FIELD_NAMES.has(target),
        saveComposable: effectiveNames.has(target),
      })
    }
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

function createK3WiseC6WriteSource({ system, createAdapter, b4 } = {}) {
  if (typeof createAdapter !== 'function') {
    throw new AdapterValidationError('K3 C6 write source requires a createAdapter function', {
      field: 'createAdapter',
    })
  }
  // OWNER REVIEW (20260805): the C6 K3 lifecycle must CONSUME the approved B4 read binding —
  // not merely coexist with it. `b4` carries the read-source config store plus the scope the
  // binding is resolved in. TRUSTED server-side planner wiring only (same trust boundary as
  // targetWriteProfile itself).
  if (!b4 || typeof b4 !== 'object'
    || !b4.readSourceConfigs || typeof b4.readSourceConfigs.list !== 'function'
    || typeof b4.tenantId !== 'string' || b4.tenantId.length === 0
    || typeof b4.sourceSystemId !== 'string' || b4.sourceSystemId.length === 0) {
    throw new AdapterValidationError('K3 C6 write source requires the B4 binding scope (readSourceConfigs store + tenantId + sourceSystemId)', {
      field: 'b4',
    })
  }

  // Resolve THE approved B4 binding for (tenant, source system, material). Fail-closed both
  // ways: zero approved configs means the window's read binding does not exist on this
  // environment; more than one means the binding is ambiguous and no silent pick is allowed.
  async function resolveApprovedB4Binding() {
    const rows = await b4.readSourceConfigs.list({
      tenantId: b4.tenantId,
      workspaceId: b4.workspaceId ?? null,
      systemId: b4.sourceSystemId,
      status: 'approved',
    })
    const material = (Array.isArray(rows) ? rows : []).filter((row) => row && row.object === 'material')
    return material
  }
  let adapter = null
  function targetAdapter() {
    if (!adapter) adapter = createAdapter(system)
    return adapter
  }

  // Review #4761 P2: the Save side wraps scalars into reference shapes ({FNumber: v}) while
  // GetDetail returns the reference as an object — comparing them raw makes `skip` unreachable
  // (an unchanged material re-plans as `update` forever). Unwrap reference-shaped values from
  // the read record so classifyExisting compares scalar-to-scalar.
  const referenceFieldNames = (() => {
    const effective = resolveEffectiveK3WiseObjects(system && system.config)
    const schema = effective && effective.material && Array.isArray(effective.material.schema)
      ? effective.material.schema
      : []
    return new Set(schema.filter((f) => f && f.type === 'reference').map((f) => f.name))
  })()

  function unwrapReferenceShapes(record) {
    if (!record || typeof record !== 'object') return record
    const out = { ...record }
    for (const name of referenceFieldNames) {
      const value = out[name]
      if (value && typeof value === 'object' && !Array.isArray(value) && value.FNumber !== undefined) {
        out[name] = value.FNumber
      }
    }
    return out
  }

  function saveFailure() {
    const error = new Error('K3 WISE Save reported row failure')
    // Review #4761 P2: UNCONDITIONALLY the registered closed token. Passing through the
    // adapter's per-row code looked more informative, but K3's Code/ErrorCode strings are
    // arbitrary (not in SAFE_WRITE_ERROR_CODES -> they collapse to WRITE_FAILED, the opposite
    // of diagnosable) and are values-bearing. One closed token, always.
    error.code = 'K3_WISE_SAVE_FAILED'
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
      throw saveFailure()
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
      const bindings = await resolveApprovedB4Binding()
      const binding = bindings.length === 1 ? bindings[0] : null
      return {
        success: true,
        capabilityState: {
          customerProfileSelected: selectedProfileId(system) === CUSTOMER_PROFILE_ID,
          saveOnlyLocked: profile.lifecycle === 'save-only',
          applyRowCapped: Number.isInteger(profile.maxApplyRows) && profile.maxApplyRows > 0,
          // B4 CONSUMPTION: exactly one approved binding, and its identity triple rides the
          // capability state — which buildRevision hashes, so the dry-run token is CONTENT-
          // BOUND to the exact approved binding the human saw. Re-approving a changed config
          // between dry-run and apply is a 409, not a silent swap.
          b4BindingApproved: bindings.length === 1,
          b4BindingCount: bindings.length,
          b4ActionProfileVersion: binding ? String(binding.actionProfileVersion || '') : '',
          b4ApprovedConfigVersion: binding ? String(binding.version ?? '') : '',
          b4ConfigContentKey: binding ? String(binding.contentKey || '') : '',
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
        const records = Array.isArray(read && read.records) ? read.records : []
        return { data: records.map(unwrapReferenceShapes) }
      } catch (error) {
        const code = error && error.details && error.details.code
        if (code === 'K3_WISE_READ_BUSINESS_ERROR') {
          // DESIGN NOTE (first version, 1-3 rows, human-approved): K3 GetDetail reports a
          // NONEXISTENT material as a business-level failure — indistinguishable at the
          // adapter from other business refusals. We treat it as "absent" so planning a NEW
          // material (the primary use case) classifies as `add`. The Save at apply remains
          // the authority: if K3 was actually unhappy, the Save fails and is dead-lettered.
          // KNOWN BOUND (review #4761 P2): the same business-error class also covers a
          // material that EXISTS but whose GetDetail fails for another reason (permission,
          // wrong acctId/sub-org, locked record) — such a row previews as `add` though the
          // Save will in fact update. The WRITE outcome is identical either way (Save is
          // upsert, same body); only the preview label is off, and the 1-3 row human review
          // is the compensating control. Transport/login failures do NOT take this branch —
          // they rethrow and fail the dry-run closed.
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
      typeof state.applyRowCapped !== 'boolean' ||
      typeof state.b4BindingApproved !== 'boolean' ||
      !Number.isInteger(state.b4BindingCount) ||
      typeof state.b4ActionProfileVersion !== 'string' ||
      typeof state.b4ApprovedConfigVersion !== 'string' ||
      typeof state.b4ConfigContentKey !== 'string'
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
      b4BindingApproved: state.b4BindingApproved,
      b4BindingCount: state.b4BindingCount,
      b4ActionProfileVersion: state.b4ActionProfileVersion,
      b4ApprovedConfigVersion: state.b4ApprovedConfigVersion,
      b4ConfigContentKey: state.b4ConfigContentKey,
    }
  },
  assertSafeCapabilityState(state) {
    // Real safety property: the named customer profile ARMS the save-only lock and the frozen
    // row cap; the APPROVED B4 binding is the ratified read contract this write lifecycle is
    // certified against. Any of the four false -> fail closed. b4BindingCount surfaces the
    // absent-vs-ambiguous distinction in the same closed vocabulary.
    if (state.customerProfileSelected !== true || state.saveOnlyLocked !== true || state.applyRowCapped !== true) {
      throw new AdapterValidationError('K3 C6 write target is not customer-profile locked', {
        field: 'capabilityState',
      })
    }
    if (state.b4BindingApproved !== true) {
      throw new AdapterValidationError('K3 C6 write requires exactly one approved B4 read binding', {
        field: 'capabilityState',
        code: 'C6_WRITE_B4_BINDING_REQUIRED',
        bindingCount: state.b4BindingCount,
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
