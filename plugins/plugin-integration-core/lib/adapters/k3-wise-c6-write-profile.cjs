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
const {
  K3WISE_MATERIAL_LIST_ACTION_PROFILE_VERSION,
  K3WISE_MATERIAL_LIST_B4_TEMPLATE,
} = require('../read-source-k3-material-list-b4-contract.cjs')

const K3_WISE_C6_WRITE_TARGET_KIND = 'erp:k3-wise-webapi'
const CUSTOMER_PROFILE_ID = 'material-k3wise-customer-profile-v1'

const CUSTOMER_PROFILE = K3_WISE_MATERIAL_PROFILES[CUSTOMER_PROFILE_ID]
if (!CUSTOMER_PROFILE) {
  // Load-time, not call-time: if the named profile ever disappears the plugin fails to load,
  // which is the loudest possible tripwire.
  throw new Error(`K3 C6 write profile requires the named customer profile: ${CUSTOMER_PROFILE_ID}`)
}

// Single source: the plan-level row bound IS the profile literal's cap (frozen by S2).
const K3_WISE_C6_MAX_APPLY_ROWS = CUSTOMER_PROFILE.maxApplyRows

const SCHEMA_FIELD_NAMES = new Set(
  (Array.isArray(CUSTOMER_PROFILE.schema) ? CUSTOMER_PROFILE.schema : [])
    .map((field) => field && field.name)
    .filter((name) => typeof name === 'string' && name.length > 0),
)

// REVIEW P2-D2 / P2-E4: matching only actionProfileVersion made the gate SELF-CERTIFYING (that
// field carries syntax validation and nothing else). My first answer compared the template's
// OWN keys — a one-directional projection: keyField, headerContainerPaths, lineContainerPaths,
// multiplicityRuleField and requiredKind all validate, PERSIST, and were invisible to it. It
// was also JSON.stringify key-order sensitive against a JSONB column.
//
// The correct comparator already exists and is already carried on the row: `contentKey` is the
// store's own sha256 over a stable stringify of the WHOLE normalized config — order-insensitive
// and, being full-config, not a projection. The gate recomputes what the ratified content WOULD
// key to for this row's systemId and requires equality.
// REVIEW P2-5 (round 7): this used to destructure `__internals.contentKeyFor`. Two problems, both
// already ruled on in this package (`read-source-config.cjs:18-22`, review B1a-1 P2): a LIVE
// fail-closed gate must not bind to another module's private/test surface, and destructuring it
// at require time turns an upstream rename into a module-load TypeError rather than a graceful
// fail-closed. `contentKeyFor` is now a supported export, bound by its public name.
const { contentKeyFor: readSourceContentKeyFor } = require('../read-source-config-store.cjs')
const { normalizeReadSourceConfig } = require('../read-source-config.cjs')

function ratifiedB4ContentKeyFor(systemId) {
  return readSourceContentKeyFor(normalizeReadSourceConfig({
    ...K3WISE_MATERIAL_LIST_B4_TEMPLATE,
    systemId,
  }))
}

function b4RowMatchesRatifiedContract(row) {
  const config = row && row.config && typeof row.config === 'object' ? row.config : null
  if (!config) return false
  if (config.actionProfileVersion !== K3WISE_MATERIAL_LIST_ACTION_PROFILE_VERSION) return false
  if (typeof row.contentKey !== 'string' || row.contentKey.length === 0) return false
  const systemId = typeof config.systemId === 'string' ? config.systemId : ''
  if (!systemId) return false
  // TWO comparisons, both required:
  //   (a) the row's key is SELF-CONSISTENT with the row's own config — the same discipline the
  //       GIP approved-binding resolution path applies (RESOLVER_CONFIG_CONTENT_KEY_MISMATCH).
  //       Without it, a row whose key says "ratified" while its config says otherwise would
  //       pass, and a test constructing exactly that row proved it.
  //       (Deliberately NOT spelling that module's filename: B1a-3's latency gate greps the tree
  //       for it as plain TEXT, so a prose mention in a non-allowlisted lib file turns the
  //       required `integration-guard` check RED. Naming it cost one red round already.)
  //   (b) that key equals what the RATIFIED content would key to for this systemId.
  let selfKey
  try { selfKey = readSourceContentKeyFor(normalizeReadSourceConfig(config)) } catch { return false }
  if (row.contentKey !== selfKey) return false
  let expected
  try { expected = ratifiedB4ContentKeyFor(systemId) } catch { return false }
  return row.contentKey === expected
}

// Two K3 external-system records are the SAME PHYSICAL K3 when their baseUrls share an origin.
// Compared at ORIGIN level on purpose: the read record and the write record legitimately differ
// in PATH (the armed one is pinned to its own endpoints), so a raw string compare would reject
// the very topology step 0-b requires. An unparseable or absent baseUrl is NOT a match —
// fail-closed, because "cannot tell" must never read as "same".
function sameK3Instance(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

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
    || !Array.isArray(b4.pipelineSystemIds) || b4.pipelineSystemIds.length === 0) {
    throw new AdapterValidationError('K3 C6 write source requires the B4 binding scope (readSourceConfigs store + tenantId + pipelineSystemIds)', {
      field: 'b4',
    })
  }
  const PIPELINE_SYSTEM_IDS = new Set(b4.pipelineSystemIds.filter((id) => typeof id === 'string' && id.length > 0))

  // ADVERSARIAL REVIEW P1-2 (20260805): the first version resolved by `systemId`, and which
  // system that is turned out to be genuinely ambiguous — the B4 binding is a K3 READ contract,
  // so an operator may mint it on the pipeline's source system OR on the K3 system that is also
  // the write target (both are erp:k3-wise-webapi in the first-version chain). A reviewer proved
  // the shipped choice resolved to zero rows, i.e. the feature was dead on arrival; and that the
  // filter never checked the row IS the B4 contract, so an unrelated approved material config
  // would have satisfied the gate.
  //
  // Both defects share one root: system id is the wrong key. The binding is identified by the
  // RATIFIED CONTRACT IDENTITY it carries — actionProfileVersion, imported from the contract
  // module (never a second copy of the literal). System id drops out of the query entirely.
  //
  // Scope stays EXACT (tenant + workspace, null-distinct) — fail-closed, and the mint and the
  // pipeline live in the same scope by construction.
  //
  // ADVERSARIAL P2-B1 (round 3): dropping systemId entirely went too far — a reviewer proved a
  // binding approved on an UNRELATED K3 system satisfied the gate, i.e. one system's read
  // contract vouching for another system's write: the same defect the round-2 fix removed,
  // rotated onto a different axis. The relation is restored, but to THIS PIPELINE rather than
  // to a guessed role: the binding's own systemId must be one of the pipeline's endpoints.
  // That keeps both legitimate mint placements working (the K3 system may be the pipeline's
  // source, its target, or both) while an unrelated system's binding is invisible — which also
  // resolves the two-K3-systems hard-block the reviewer found, since the unrelated one no
  // longer counts toward ambiguity.
  // A page this full cannot be proven complete; see the refusal below.
  const B4_BINDING_PAGE_LIMIT = 500

  async function resolveApprovedB4Binding() {
    const rows = await b4.readSourceConfigs.list({
      tenantId: b4.tenantId,
      workspaceId: b4.workspaceId ?? null,
      status: 'approved',
      // list() defaults to a page (review P3): a bounded page could hide a second approved
      // binding and defeat the ambiguity check — ask for more than the gate can ever accept.
      limit: B4_BINDING_PAGE_LIMIT,
    })
    const page = Array.isArray(rows) ? rows : []
    // REVIEW P3-2 (round 8): `list()` gives no ordering guarantee, so a FULL page means the set
    // may be truncated — and a truncated set can hide the second approved binding that the
    // ambiguity check exists to catch, turning a fail-closed refusal into a silent pass. A full
    // page is therefore itself a refusal: it is indistinguishable from "there might be more".
    if (page.length >= B4_BINDING_PAGE_LIMIT) {
      throw new AdapterValidationError(
        'too many approved read-source configs to establish B4 binding uniqueness',
        { code: 'K3_C6_B4_BINDING_PAGE_EXHAUSTED', field: 'b4.readSourceConfigs' },
      )
    }
    return page.filter((row) => {
      if (!row || row.object !== 'material') return false
      // The binding must belong to a system THIS pipeline actually uses.
      const boundSystemId = row.config && typeof row.config === 'object' ? row.config.systemId : undefined
      if (typeof boundSystemId !== 'string' || !PIPELINE_SYSTEM_IDS.has(boundSystemId)) return false
      // Full-config, order-insensitive equality via the store's own content key. (The nesting
      // note that used to sit here bound a local that nothing read — the check itself lives in
      // b4RowMatchesRatifiedContract, which reads row.config directly.)
      return b4RowMatchesRatifiedContract(row)
    })
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
      // SAME-INSTANCE CHECK. `binding` may legitimately name a DIFFERENT external-system record
      // than the write target: the B4 contract is the material-LIST read contract, and a
      // profile-armed record cannot hold list-read config (#4769 strips every readList* key,
      // even from the frozen first-party preset), so the customer runs two K3 records. Binding
      // to the target record is what satisfies the relation check — but that is only TRUE while
      // both records address the same physical K3.
      //
      // Without this, "bind to the target" silently permits one K3's read contract to certify a
      // DIFFERENT K3's write: the round-3 defect, reopened one level down. Fail-closed by
      // construction — it can only reject bindings the relation check already accepted.
      if (binding && typeof b4.loadSystemById === 'function') {
        const boundSystemId = binding.config && binding.config.systemId
        const targetBaseUrl = typeof b4.targetBaseUrl === 'string' ? b4.targetBaseUrl : ''
        let boundBaseUrl = null
        try {
          const boundSystem = await b4.loadSystemById(boundSystemId)
          boundBaseUrl = boundSystem && boundSystem.config ? boundSystem.config.baseUrl : null
        } catch {
          boundBaseUrl = null
        }
        if (!sameK3Instance(boundBaseUrl, targetBaseUrl)) {
          throw new AdapterValidationError(
            'the approved B4 binding names a different K3 instance than the write target',
            { code: 'K3_C6_B4_BINDING_INSTANCE_MISMATCH', field: 'capabilityState' },
          )
        }
      }
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
          b4ActionProfileVersion: binding && binding.config ? String(binding.config.actionProfileVersion || '') : '',
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
  // Test surface only. `sameK3Instance`'s fail-closed catch branch had no coverage — flipping it
  // to `return true` left the whole suite green, i.e. "cannot tell" silently became "same
  // instance". A guard whose failure mode is invisible is not a guard.
  __internals: { sameK3Instance },
}
