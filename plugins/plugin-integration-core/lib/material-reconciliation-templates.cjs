'use strict'

// D1: dual-source material master reconciliation — frozen contract (charter
// docs/development/stock-preparation-v2-material-master-reconciliation-charter-20260719.md,
// §2.2/§2.3/§3/§4.1/§4.4/§4.5/§4.6/§5, OD-V2-3/5/6/7).
// Schema-only and latent: provisions no sheet, reads no data, writes no rows,
// exposes no runtime route. This module declares identity/reservation constants,
// closed vocabularies with one-way transition maps, and the nine frozen object
// templates for the second scenario. It is structurally independent of the
// stock-prep domain (charter §3): it depends only on ./payload-redaction.cjs and
// node builtins, and no object/field/template id reuses the stock-prep prefixes.
// The feature flag is declared by NAME only — no environment read happens here;
// runtime slices enable only on the literal string 'true' (OD-V2-6).

const { scrubSecretStringValue } = require('./payload-redaction.cjs')

// --- A. Identity + reservation constants -----------------------------------

const MATERIAL_RECONCILIATION_MANIFEST_ID = 'material.reconciliation.v1'
// RESERVED namespace; no routes are registered in D1.
const MATERIAL_RECONCILIATION_ROUTE_NAMESPACE = '/api/material-reconciliation'
// Default-OFF; only the literal 'true' enables (OD-V2-6). Name declared only.
const MATERIAL_RECONCILIATION_FLAG_ENV = 'MULTITABLE_MATERIAL_RECONCILIATION_ENABLED'
const MATERIAL_RECONCILIATION_PERMISSIONS = Object.freeze([
  'material-reconciliation:read',
  'material-reconciliation:operate',
  'material-reconciliation:admin',
])

const MATERIAL_RECONCILIATION_TEMPLATE_ID_PREFIX = 'material.reconciliation.'
const MATERIAL_RECONCILIATION_OBJECT_ID_PREFIX = 'material_reconciliation_'

// Pure predicate (OD-V2-6): callers pass the flag VALUE; this module never
// reads the environment itself.
function isMaterialReconciliationFlagValueEnabled(value) {
  return value === 'true'
}

// --- B. Closed vocabularies -------------------------------------------------

const MR_FIELD_TYPES = Object.freeze(['string', 'number', 'boolean', 'date', 'select'])
const MR_FIELD_TYPE_SET = new Set(MR_FIELD_TYPES)

const MR_TEMPLATE_FAMILIES = Object.freeze(['data', 'binding', 'claim'])
const MR_TEMPLATE_FAMILY_SET = new Set(MR_TEMPLATE_FAMILIES)

// §2.3 — V1 has exactly two roles.
const MR_ROLES = Object.freeze(['engineering_material_master', 'enterprise_material_master'])
const MR_ROLE_SET = new Set(MR_ROLES)

// §5 — run state machine. NO pending-style state (rev-5 deleted it): a blocked
// loser either becomes the winner (claim released in the holder's failing txn)
// or lands in terminal `deduplicated` against a COMMITTED holder.
const MR_RUN_STATES = Object.freeze([
  'planned',
  'reading_sources',
  'snapshots_complete',
  'compared',
  'complete',
  'deduplicated',
  'failed',
])
const MR_RUN_STATE_SET = new Set(MR_RUN_STATES)
const MR_RUN_TERMINAL_STATES = Object.freeze(['complete', 'deduplicated', 'failed'])
const MR_RUN_TERMINAL_STATE_SET = new Set(MR_RUN_TERMINAL_STATES)
const MR_RUN_TRANSITIONS = Object.freeze({
  planned: Object.freeze(['reading_sources', 'failed']),
  reading_sources: Object.freeze(['snapshots_complete', 'failed']),
  snapshots_complete: Object.freeze(['compared', 'failed']),
  compared: Object.freeze(['complete', 'deduplicated', 'failed']),
  complete: Object.freeze([]),
  deduplicated: Object.freeze([]),
  failed: Object.freeze([]),
})

// §4.1/§4.5 — deliberately WITHOUT 'active': "active" is the derived predicate
// "pointed at by the scenario's active_binding_version_id pointer", never a
// stored status.
const MR_BINDING_STATUSES = Object.freeze([
  'draft_candidate',
  'preflight_passed',
  'approved',
  'superseded',
  'revoked',
])
const MR_BINDING_STATUS_SET = new Set(MR_BINDING_STATUSES)
const MR_BINDING_TRANSITIONS = Object.freeze({
  draft_candidate: Object.freeze(['preflight_passed']),
  preflight_passed: Object.freeze(['approved']),
  approved: Object.freeze(['superseded', 'revoked']),
  superseded: Object.freeze([]),
  revoked: Object.freeze([]),
})

// §2.2/§5 — first-version diff vocabulary is frozen to the six buckets.
const MR_DIFF_BUCKETS = Object.freeze([
  'only_in_engineering',
  'only_in_enterprise',
  'matched_consistent',
  'matched_divergent',
  'ambiguous',
  'identity_invalid',
])
const MR_DIFF_BUCKET_SET = new Set(MR_DIFF_BUCKETS)

// §4.4 rev-6 / §5 — failure reason closed vocabulary with retryable vs
// fail_closed classification at the reason level.
const MR_FAILURE_CLASSES = Object.freeze(['retryable', 'fail_closed'])
const MR_FAILURE_CLASS_SET = new Set(MR_FAILURE_CLASSES)
const MR_FAILURE_REASONS = Object.freeze([
  Object.freeze({ reason: 'RUN_IDENTITY_CLAIM_BUSY', class: 'retryable' }),
  Object.freeze({ reason: 'READ_UNPROVABLE', class: 'fail_closed' }),
  Object.freeze({ reason: 'SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE', class: 'fail_closed' }),
])
const MR_FAILURE_REASON_CODES = Object.freeze(MR_FAILURE_REASONS.map((entry) => entry.reason))
const MR_FAILURE_REASON_CODE_SET = new Set(MR_FAILURE_REASON_CODES)

// §4.6 rev-4/5 — the ONLY admissible snapshot-consistency proof mechanisms.
// DUAL_SWEEP_DIGEST_MATCH is deliberately NOT a member and must never become
// one: a matching double sweep is stability evidence, not a consistency proof.
const MR_CONSISTENCY_PROOF_MECHANISMS = Object.freeze([
  'SOURCE_SNAPSHOT_TXN',
  'IMMUTABLE_SNAPSHOT_TOKEN',
  'MONOTONIC_VERSION_PIN',
])
const MR_CONSISTENCY_PROOF_MECHANISM_SET = new Set(MR_CONSISTENCY_PROOF_MECHANISMS)

const MR_WRITE_DISCIPLINES = Object.freeze([
  'state_machine_only',
  'create_only',
  'pointer_cas_only',
  'append_only_values_free',
  'claim_only',
])
const MR_WRITE_DISCIPLINE_SET = new Set(MR_WRITE_DISCIPLINES)

const MR_BINDING_AUDIT_ACTIONS = Object.freeze([
  'candidate_created',
  'preflight_passed',
  'approved',
  'activated',
  'superseded',
  'revoked',
  'pointer_cleared',
  'pointer_switched',
])
const MR_BINDING_AUDIT_ACTION_SET = new Set(MR_BINDING_AUDIT_ACTIONS)

// §4.6 rev-3 — identity-key classification for snapshot rows / diff entries.
const MR_IDENTITY_KEY_CLASSES = Object.freeze(['valid', 'identity_invalid'])
const MR_IDENTITY_KEY_CLASS_SET = new Set(MR_IDENTITY_KEY_CLASSES)

// Registry of exported vocab names usable by select fields. Select fields carry
// a vocab NAME (schema reference), never inline option values.
const MR_SELECT_VOCABULARIES = Object.freeze({
  MR_ROLES,
  MR_RUN_STATES,
  MR_BINDING_STATUSES,
  MR_DIFF_BUCKETS,
  MR_FAILURE_CLASSES,
  MR_FAILURE_REASON_CODES,
  MR_CONSISTENCY_PROOF_MECHANISMS,
  MR_BINDING_AUDIT_ACTIONS,
  MR_IDENTITY_KEY_CLASSES,
})

// --- C. Schema-only boundary ------------------------------------------------

// The stock-prep 12 content keys PLUS credentials/secret/token: system-identity
// or credential material must never enter a schema manifest.
const FORBIDDEN_CONTENT_KEYS = Object.freeze([
  'rows',
  'records',
  'data',
  'values',
  'content',
  'sample',
  'payload',
  'payloadTemplate',
  'rawSql',
  'sql',
  'query',
  'storedProcedure',
  'credentials',
  'secret',
  'token',
])

class MaterialReconciliationTemplateError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'MaterialReconciliationTemplateError'
    this.details = details
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MaterialReconciliationTemplateError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new MaterialReconciliationTemplateError(`${field} must be a string`, { field })
  }
  return value.trim()
}

function requiredBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new MaterialReconciliationTemplateError(`${field} must be a boolean`, { field })
  }
  return value
}

function isSecretShaped(str) {
  return scrubSecretStringValue(str) !== str
}

function assertSafeSchemaString(value, field) {
  const str = requiredString(value, field)
  if (isSecretShaped(str)) {
    throw new MaterialReconciliationTemplateError(`${field} must not be secret-shaped`, { field })
  }
  return str
}

function assertNoContentKeys(input, field) {
  if (!isPlainObject(input)) return
  for (const key of FORBIDDEN_CONTENT_KEYS) {
    if (key in input) {
      throw new MaterialReconciliationTemplateError(`${field} must not carry "${key}" (schema only)`, {
        field: field ? `${field}.${key}` : key,
      })
    }
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

// Business digests are internal/HMAC only, never a public bare SHA (charter
// §4.6). Any field id matching these shapes MUST be declared internalOnly.
const INTERNAL_ONLY_FIELD_ID_SUFFIXES = Object.freeze([
  '_digest',
  '_fingerprint',
  '_content_key',
  '_lineage_key',
])
const INTERNAL_ONLY_FIELD_IDS = Object.freeze([
  'run_identity_key',
  'identity_key_normalized',
  'projection_normalized',
])

function fieldIdRequiresInternalOnly(id) {
  if (INTERNAL_ONLY_FIELD_IDS.includes(id)) return true
  return INTERNAL_ONLY_FIELD_ID_SUFFIXES.some((suffix) => id.endsWith(suffix))
}

// --- D. Template normalizer -------------------------------------------------

function normalizeMaterialReconciliationSelect(input, field) {
  if (!isPlainObject(input)) {
    throw new MaterialReconciliationTemplateError(`${field} must be an object`, { field })
  }
  assertNoContentKeys(input, field)
  const vocab = assertSafeSchemaString(input.vocab, `${field}.vocab`)
  if (!Object.prototype.hasOwnProperty.call(MR_SELECT_VOCABULARIES, vocab)) {
    throw new MaterialReconciliationTemplateError(`${field}.vocab must name an exported closed vocabulary`, {
      field: `${field}.vocab`,
      value: vocab,
    })
  }
  return { vocab }
}

function normalizeMaterialReconciliationField(field, index) {
  const at = `fields[${index}]`
  if (!isPlainObject(field)) {
    throw new MaterialReconciliationTemplateError(`${at} must be an object`, { field: at })
  }
  assertNoContentKeys(field, at)
  for (const contentKey of ['value', 'default', 'options']) {
    if (contentKey in field) {
      throw new MaterialReconciliationTemplateError(`${at} must not carry ${contentKey} (schema only, no business values)`, {
        field: `${at}.${contentKey}`,
      })
    }
  }
  const id = assertSafeSchemaString(field.id, `${at}.id`)
  const label = assertSafeSchemaString(field.label || field.name || id, `${at}.label`)
  const type = assertSafeSchemaString(field.type, `${at}.type`)
  if (!MR_FIELD_TYPE_SET.has(type)) {
    throw new MaterialReconciliationTemplateError(`${at}.type must be one of ${MR_FIELD_TYPES.join(', ')}`, {
      field: `${at}.type`,
      value: type,
    })
  }
  const out = { id, label, type }
  if (field.required !== undefined) out.required = requiredBoolean(field.required, `${at}.required`)
  if (field.key !== undefined) out.key = requiredBoolean(field.key, `${at}.key`)
  if (field.internalOnly !== undefined) out.internalOnly = requiredBoolean(field.internalOnly, `${at}.internalOnly`)
  if (type === 'select') {
    if (field.select === undefined) {
      throw new MaterialReconciliationTemplateError(`${at}.select must name an exported vocabulary for select fields`, {
        field: `${at}.select`,
      })
    }
    out.select = normalizeMaterialReconciliationSelect(field.select, `${at}.select`)
  } else if (field.select !== undefined) {
    throw new MaterialReconciliationTemplateError(`${at}.select is only allowed on select fields`, {
      field: `${at}.select`,
    })
  }
  if (fieldIdRequiresInternalOnly(id) && out.internalOnly !== true) {
    throw new MaterialReconciliationTemplateError(
      `${at} (${id}) must be internalOnly: business digests/identity keys are internal, never public`,
      { field: `${at}.internalOnly`, id },
    )
  }
  return out
}

function normalizeMaterialReconciliationUniqueness(input, index, fieldIdSet) {
  const at = `uniqueness[${index}]`
  if (!isPlainObject(input)) {
    throw new MaterialReconciliationTemplateError(`${at} must be an object`, { field: at })
  }
  assertNoContentKeys(input, at)
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    throw new MaterialReconciliationTemplateError(`${at}.fields must be a non-empty array`, { field: `${at}.fields` })
  }
  const fields = input.fields.map((value, i) => assertSafeSchemaString(value, `${at}.fields[${i}]`))
  for (const fieldId of fields) {
    if (!fieldIdSet.has(fieldId)) {
      throw new MaterialReconciliationTemplateError(`${at}.fields references unknown field ${fieldId}`, {
        field: `${at}.fields`,
        missing: fieldId,
      })
    }
  }
  const out = { fields }
  const scope = optionalString(input.scope, `${at}.scope`)
  if (scope !== undefined) {
    if (scope !== 'tenant') {
      throw new MaterialReconciliationTemplateError(`${at}.scope must be tenant`, { field: `${at}.scope`, value: scope })
    }
    out.scope = scope
  }
  const partial = optionalString(input.partial, `${at}.partial`)
  if (partial !== undefined) out.partial = assertSafeSchemaString(partial, `${at}.partial`)
  return out
}

function normalizeMaterialReconciliationReference(input, index, fieldIdSet) {
  const at = `references[${index}]`
  if (!isPlainObject(input)) {
    throw new MaterialReconciliationTemplateError(`${at} must be an object`, { field: at })
  }
  assertNoContentKeys(input, at)
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    throw new MaterialReconciliationTemplateError(`${at}.fields must be a non-empty array`, { field: `${at}.fields` })
  }
  const fields = input.fields.map((value, i) => assertSafeSchemaString(value, `${at}.fields[${i}]`))
  for (const fieldId of fields) {
    if (!fieldIdSet.has(fieldId)) {
      throw new MaterialReconciliationTemplateError(`${at}.fields references unknown field ${fieldId}`, {
        field: `${at}.fields`,
        missing: fieldId,
      })
    }
  }
  const targetObjectId = assertSafeSchemaString(input.targetObjectId, `${at}.targetObjectId`)
  if (!targetObjectId.startsWith(MATERIAL_RECONCILIATION_OBJECT_ID_PREFIX)) {
    throw new MaterialReconciliationTemplateError(
      `${at}.targetObjectId must use the ${MATERIAL_RECONCILIATION_OBJECT_ID_PREFIX} prefix`,
      { field: `${at}.targetObjectId`, value: targetObjectId },
    )
  }
  if (!Array.isArray(input.targetFields) || input.targetFields.length !== fields.length) {
    throw new MaterialReconciliationTemplateError(`${at}.targetFields must match fields length`, {
      field: `${at}.targetFields`,
    })
  }
  const targetFields = input.targetFields.map((value, i) => assertSafeSchemaString(value, `${at}.targetFields[${i}]`))
  const out = { fields, targetObjectId, targetFields }
  if (input.composite !== undefined) out.composite = requiredBoolean(input.composite, `${at}.composite`)
  return out
}

function normalizeMaterialReconciliationTemplate(input) {
  if (!isPlainObject(input)) {
    throw new MaterialReconciliationTemplateError('template must be a plain object')
  }
  assertNoContentKeys(input, 'template')
  const id = assertSafeSchemaString(input.id, 'id')
  if (!id.startsWith(MATERIAL_RECONCILIATION_TEMPLATE_ID_PREFIX) || !id.endsWith('.v1') || id === `${MATERIAL_RECONCILIATION_TEMPLATE_ID_PREFIX}v1`) {
    throw new MaterialReconciliationTemplateError(
      `id must match ${MATERIAL_RECONCILIATION_TEMPLATE_ID_PREFIX}<name>.v1`,
      { field: 'id', value: id },
    )
  }
  const objectId = assertSafeSchemaString(input.objectId, 'objectId')
  if (!objectId.startsWith(MATERIAL_RECONCILIATION_OBJECT_ID_PREFIX) || objectId === MATERIAL_RECONCILIATION_OBJECT_ID_PREFIX) {
    throw new MaterialReconciliationTemplateError(
      `objectId must use the ${MATERIAL_RECONCILIATION_OBJECT_ID_PREFIX} prefix`,
      { field: 'objectId', value: objectId },
    )
  }
  const version = optionalString(input.version, 'version') || 'v1'
  if (version !== 'v1') {
    throw new MaterialReconciliationTemplateError('version must be v1', { field: 'version', value: version })
  }
  const family = assertSafeSchemaString(input.family, 'family')
  if (!MR_TEMPLATE_FAMILY_SET.has(family)) {
    throw new MaterialReconciliationTemplateError(`family must be one of ${MR_TEMPLATE_FAMILIES.join(', ')}`, {
      field: 'family',
      value: family,
    })
  }
  const writeDiscipline = assertSafeSchemaString(input.writeDiscipline, 'writeDiscipline')
  if (!MR_WRITE_DISCIPLINE_SET.has(writeDiscipline)) {
    throw new MaterialReconciliationTemplateError(
      `writeDiscipline must be one of ${MR_WRITE_DISCIPLINES.join(', ')}`,
      { field: 'writeDiscipline', value: writeDiscipline },
    )
  }
  const fields = Array.isArray(input.fields) ? input.fields.map(normalizeMaterialReconciliationField) : []
  if (fields.length === 0) {
    throw new MaterialReconciliationTemplateError('fields must be a non-empty array', { field: 'fields' })
  }
  const byId = new Map(fields.map((field) => [field.id, field]))
  if (byId.size !== fields.length) {
    throw new MaterialReconciliationTemplateError('field ids must be unique', { field: 'fields' })
  }
  const fieldIdSet = new Set(byId.keys())
  if (!Array.isArray(input.keyFields) || input.keyFields.length === 0) {
    throw new MaterialReconciliationTemplateError('keyFields must be a non-empty array', { field: 'keyFields' })
  }
  const keyFields = input.keyFields.map((value, index) => assertSafeSchemaString(value, `keyFields[${index}]`))
  for (const keyField of keyFields) {
    const field = byId.get(keyField)
    if (!field || field.key !== true) {
      throw new MaterialReconciliationTemplateError(`keyFields entry ${keyField} must exist as a key:true field`, {
        field: 'keyFields',
        missing: keyField,
      })
    }
  }
  for (const field of fields) {
    if (field.key === true && !keyFields.includes(field.id)) {
      throw new MaterialReconciliationTemplateError(`key field ${field.id} must be listed in keyFields`, {
        field: 'keyFields',
        missing: field.id,
      })
    }
  }
  const out = {
    id,
    objectId,
    label: assertSafeSchemaString(input.label || input.name || id, 'label'),
    version,
    family,
    writeDiscipline,
    keyFields,
    fields,
  }
  if (input.uniqueness !== undefined) {
    if (!Array.isArray(input.uniqueness)) {
      throw new MaterialReconciliationTemplateError('uniqueness must be an array', { field: 'uniqueness' })
    }
    out.uniqueness = input.uniqueness.map((entry, index) => normalizeMaterialReconciliationUniqueness(entry, index, fieldIdSet))
  }
  if (input.references !== undefined) {
    if (!Array.isArray(input.references)) {
      throw new MaterialReconciliationTemplateError('references must be an array', { field: 'references' })
    }
    out.references = input.references.map((entry, index) => normalizeMaterialReconciliationReference(entry, index, fieldIdSet))
  }
  return deepFreeze(out)
}

// --- E. Structure builder + values-free evidence ----------------------------

function buildSheetStructureFromMaterialReconciliationTemplate(template) {
  const normalized = normalizeMaterialReconciliationTemplate(template)
  return {
    objectId: normalized.objectId,
    label: normalized.label,
    keyFields: normalized.keyFields.slice(),
    fields: normalized.fields.map((field, order) => {
      const out = {
        id: field.id,
        name: field.label,
        type: field.type,
        order,
      }
      if (field.required) out.property = { validation: [{ type: 'required' }] }
      return out
    }),
    rows: [],
  }
}

// Values-free by construction: objectIds, counts, discipline names and vocab
// sizes only — no field ids, no labels, no business values.
function summarizeMaterialReconciliationEvidence(templates) {
  const list = templates || MATERIAL_RECONCILIATION_TEMPLATES
  // Normalize BEFORE projecting anything: objectIds must come from validated
  // templates only, so a caller-supplied list can never place unvalidated
  // strings on the evidence surface.
  const normalizedList = list.map((template) => normalizeMaterialReconciliationTemplate(template))
  return {
    manifestId: MATERIAL_RECONCILIATION_MANIFEST_ID,
    templateCount: normalizedList.length,
    objectIds: normalizedList.map((template) => template.objectId),
    templates: normalizedList.map((normalized) => {
      return {
        objectId: normalized.objectId,
        family: normalized.family,
        writeDiscipline: normalized.writeDiscipline,
        keyFieldCount: normalized.keyFields.length,
        fieldCount: normalized.fields.length,
        internalOnlyFieldCount: normalized.fields.filter((field) => field.internalOnly === true).length,
        selectFieldCount: normalized.fields.filter((field) => field.type === 'select').length,
        uniquenessCount: normalized.uniqueness ? normalized.uniqueness.length : 0,
        referenceCount: normalized.references ? normalized.references.length : 0,
      }
    }),
    vocabularySizes: {
      runStates: MR_RUN_STATES.length,
      bindingStatuses: MR_BINDING_STATUSES.length,
      diffBuckets: MR_DIFF_BUCKETS.length,
      failureReasons: MR_FAILURE_REASONS.length,
      consistencyProofMechanisms: MR_CONSISTENCY_PROOF_MECHANISMS.length,
      roles: MR_ROLES.length,
      writeDisciplines: MR_WRITE_DISCIPLINES.length,
      bindingAuditActions: MR_BINDING_AUDIT_ACTIONS.length,
    },
  }
}

// --- D (cont). The NINE frozen templates (charter §3 complete object list) --

function field(id, label, type, extra = {}) {
  return { id, label, type, ...extra }
}

const MATERIAL_RECONCILIATION_TEMPLATES = Object.freeze([
  // 1. Run attempt: state machine only; runIdentityKey NULL until the
  // claim-winning commit (opaque internal handle, not a content key).
  normalizeMaterialReconciliationTemplate({
    id: 'material.reconciliation.run.v1',
    objectId: 'material_reconciliation_run',
    label: 'Material Reconciliation Run',
    version: 'v1',
    family: 'data',
    writeDiscipline: 'state_machine_only',
    keyFields: ['attempt_id'],
    fields: [
      field('attempt_id', 'Attempt ID', 'string', { required: true, key: true }),
      field('tenant_id', 'Tenant ID', 'string', { required: true }),
      field('scenario_instance_id', 'Scenario Instance ID', 'string', { required: true }),
      field('binding_version_id', 'Binding Version ID', 'string', { required: true }),
      field('state', 'Run State', 'select', { required: true, select: { vocab: 'MR_RUN_STATES' } }),
      field('run_identity_key', 'Run Identity Key (NULL until claim-winning commit)', 'string', { internalOnly: true }),
      field('fail_class', 'Failure Class', 'select', { select: { vocab: 'MR_FAILURE_CLASSES' } }),
      field('fail_reason', 'Failure Reason', 'select', { select: { vocab: 'MR_FAILURE_REASON_CODES' } }),
      field('fail_phase', 'Failure Phase', 'string'),
      field('superseded_at_commit', 'Superseded At Commit', 'boolean'),
      field('winner_attempt_id', 'Winner Attempt ID (opaque handle)', 'string'),
      field('engineering_snapshot_id', 'Engineering Snapshot ID', 'string'),
      field('enterprise_snapshot_id', 'Enterprise Snapshot ID', 'string'),
      field('created_at', 'Created At', 'date'),
      field('completed_at', 'Completed At', 'date'),
    ],
    // §4.4 — 058-precedent partial unique: only claim-winning runs carry the
    // identity key; losers stay NULL forever.
    uniqueness: [
      { scope: 'tenant', fields: ['run_identity_key'], partial: 'run_identity_key IS NOT NULL' },
    ],
  }),
  // 2. Immutable snapshot header for one role side.
  normalizeMaterialReconciliationTemplate({
    id: 'material.reconciliation.source-snapshot.v1',
    objectId: 'material_reconciliation_source_snapshot',
    label: 'Material Reconciliation Source Snapshot',
    version: 'v1',
    family: 'data',
    writeDiscipline: 'create_only',
    keyFields: ['snapshot_id'],
    fields: [
      field('snapshot_id', 'Snapshot ID', 'string', { required: true, key: true }),
      field('tenant_id', 'Tenant ID', 'string', { required: true }),
      field('attempt_id', 'Attempt ID', 'string', { required: true }),
      field('role', 'Source Role', 'select', { required: true, select: { vocab: 'MR_ROLES' } }),
      field('consistency_proof_mechanism', 'Consistency Proof Mechanism', 'select', {
        required: true,
        select: { vocab: 'MR_CONSISTENCY_PROOF_MECHANISMS' },
      }),
      field('snapshot_content_digest', 'Snapshot Content Digest', 'string', { internalOnly: true }),
      field('source_read_evidence_digest', 'Source Read Evidence Digest', 'string', { internalOnly: true }),
      field('row_count', 'Row Count', 'number'),
      field('page_count', 'Page Count', 'number'),
      field('read_started_at', 'Read Started At', 'date'),
      field('read_completed_at', 'Read Completed At', 'date'),
    ],
  }),
  // 3. Normalized snapshot row (frozen projection); digests internal only.
  normalizeMaterialReconciliationTemplate({
    id: 'material.reconciliation.source-snapshot-row.v1',
    objectId: 'material_reconciliation_source_snapshot_row',
    label: 'Material Reconciliation Source Snapshot Row',
    version: 'v1',
    family: 'data',
    writeDiscipline: 'create_only',
    keyFields: ['row_id'],
    fields: [
      field('row_id', 'Row ID', 'string', { required: true, key: true }),
      field('snapshot_id', 'Snapshot ID', 'string', { required: true }),
      field('row_index', 'Row Index', 'number', { required: true }),
      field('identity_key_class', 'Identity Key Class', 'select', { select: { vocab: 'MR_IDENTITY_KEY_CLASSES' } }),
      field('identity_key_normalized', 'Identity Key (Normalized)', 'string', { internalOnly: true }),
      field('canonical_row_digest', 'Canonical Row Digest', 'string', { internalOnly: true }),
      field('projection_normalized', 'Projection (Normalized)', 'string', { internalOnly: true }),
    ],
  }),
  // 4. Deterministic diff between the two complete snapshots — references
  // snapshot/row HANDLES only (§3); no projected business values.
  normalizeMaterialReconciliationTemplate({
    id: 'material.reconciliation.diff.v1',
    objectId: 'material_reconciliation_diff',
    label: 'Material Reconciliation Diff',
    version: 'v1',
    family: 'data',
    writeDiscipline: 'create_only',
    keyFields: ['diff_id'],
    fields: [
      field('diff_id', 'Diff ID', 'string', { required: true, key: true }),
      field('tenant_id', 'Tenant ID', 'string', { required: true }),
      field('attempt_id', 'Attempt ID', 'string', { required: true }),
      field('bucket', 'Diff Bucket', 'select', { required: true, select: { vocab: 'MR_DIFF_BUCKETS' } }),
      field('identity_key_class', 'Identity Key Class', 'select', { select: { vocab: 'MR_IDENTITY_KEY_CLASSES' } }),
      field('identity_key_normalized', 'Identity Key (Normalized)', 'string', { internalOnly: true }),
      field('engineering_snapshot_id', 'Engineering Snapshot ID', 'string'),
      field('enterprise_snapshot_id', 'Enterprise Snapshot ID', 'string'),
      field('engineering_row_id', 'Engineering Row ID', 'string'),
      field('enterprise_row_id', 'Enterprise Row ID', 'string'),
      field('multiplicity_engineering', 'Multiplicity (Engineering)', 'number'),
      field('multiplicity_enterprise', 'Multiplicity (Enterprise)', 'number'),
    ],
  }),
  // 5. Scenario instance: the active_binding_version_id pointer is the SOLE
  // authority for "active" (§4.1); composite FK pins the pointer to a binding
  // version of THIS scenario.
  normalizeMaterialReconciliationTemplate({
    id: 'material.reconciliation.scenario.v1',
    objectId: 'material_reconciliation_scenario',
    label: 'Material Reconciliation Scenario',
    version: 'v1',
    family: 'binding',
    writeDiscipline: 'pointer_cas_only',
    keyFields: ['scenario_id'],
    fields: [
      field('scenario_id', 'Scenario ID', 'string', { required: true, key: true }),
      field('tenant_id', 'Tenant ID', 'string', { required: true }),
      field('title', 'Title', 'string'),
      field('active_binding_version_id', 'Active Binding Version ID (nullable pointer)', 'string'),
      field('created_at', 'Created At', 'date'),
    ],
    references: [
      {
        fields: ['scenario_id', 'active_binding_version_id'],
        targetObjectId: 'material_reconciliation_binding_version',
        targetFields: ['scenario_id', 'binding_version_id'],
        composite: true,
      },
    ],
  }),
  // 6. Binding version: rows create-only; status one-way per
  // MR_BINDING_TRANSITIONS; no stored 'active' status (derived predicate).
  normalizeMaterialReconciliationTemplate({
    id: 'material.reconciliation.binding-version.v1',
    objectId: 'material_reconciliation_binding_version',
    label: 'Material Reconciliation Binding Version',
    version: 'v1',
    family: 'binding',
    writeDiscipline: 'create_only',
    keyFields: ['binding_version_id'],
    fields: [
      field('binding_version_id', 'Binding Version ID', 'string', { required: true, key: true }),
      field('scenario_id', 'Scenario ID', 'string', { required: true }),
      field('tenant_id', 'Tenant ID', 'string', { required: true }),
      field('status', 'Binding Status', 'select', { required: true, select: { vocab: 'MR_BINDING_STATUSES' } }),
      field('contract_version', 'Contract Version', 'string', { required: true }),
      field('binding_fingerprint', 'Binding Fingerprint', 'string', { internalOnly: true }),
      field('baseline_lineage_key', 'Baseline Lineage Key', 'string', { internalOnly: true }),
      field('created_at', 'Created At', 'date'),
      field('superseded_at', 'Superseded At', 'date'),
      field('revoked_at', 'Revoked At', 'date'),
    ],
  }),
  // 7. Binding member: role -> approved config version + pinned content key
  // (rev-4 content-key single-track, no version id).
  normalizeMaterialReconciliationTemplate({
    id: 'material.reconciliation.binding-member.v1',
    objectId: 'material_reconciliation_binding_member',
    label: 'Material Reconciliation Binding Member',
    version: 'v1',
    family: 'binding',
    writeDiscipline: 'create_only',
    keyFields: ['member_id'],
    fields: [
      field('member_id', 'Member ID', 'string', { required: true, key: true }),
      field('binding_version_id', 'Binding Version ID', 'string', { required: true }),
      field('role', 'Source Role', 'select', { required: true, select: { vocab: 'MR_ROLES' } }),
      field('approved_config_version_id', 'Approved Config Version ID', 'string', { required: true }),
      field('system_content_key', 'System Content Key', 'string', { required: true, internalOnly: true }),
      field('connector_capability_version', 'Connector Capability Version', 'string'),
      field('consistency_proof_mechanism', 'Consistency Proof Mechanism', 'select', {
        select: { vocab: 'MR_CONSISTENCY_PROOF_MECHANISMS' },
      }),
    ],
  }),
  // 8. Binding lifecycle audit: append-only and values-free by construction —
  // closed action vocabulary, opaque handles, NO free-text field.
  normalizeMaterialReconciliationTemplate({
    id: 'material.reconciliation.binding-audit.v1',
    objectId: 'material_reconciliation_binding_audit',
    label: 'Material Reconciliation Binding Audit',
    version: 'v1',
    family: 'binding',
    writeDiscipline: 'append_only_values_free',
    keyFields: ['audit_id'],
    fields: [
      field('audit_id', 'Audit ID', 'string', { required: true, key: true }),
      field('tenant_id', 'Tenant ID', 'string', { required: true }),
      field('scenario_id', 'Scenario ID', 'string', { required: true }),
      field('binding_version_id', 'Binding Version ID', 'string'),
      field('action', 'Audit Action', 'select', { required: true, select: { vocab: 'MR_BINDING_AUDIT_ACTIONS' } }),
      field('actor_id', 'Actor ID', 'string'),
      field('at', 'At', 'date'),
    ],
  }),
  // 9. Semantic-key claim table (§4.4 rev-6 claim-first): first write of the
  // commit txn under SET LOCAL lock_timeout; winner keeps, failed releases in
  // its own txn, complete never releases. No business values.
  normalizeMaterialReconciliationTemplate({
    id: 'material.reconciliation.run-identity-claim.v1',
    objectId: 'material_reconciliation_run_identity_claim',
    label: 'Material Reconciliation Run Identity Claim',
    version: 'v1',
    family: 'claim',
    writeDiscipline: 'claim_only',
    keyFields: ['tenant_id', 'run_identity_key'],
    fields: [
      field('tenant_id', 'Tenant ID', 'string', { required: true, key: true }),
      field('run_identity_key', 'Run Identity Key', 'string', { required: true, key: true, internalOnly: true }),
      field('winner_attempt_id', 'Winner Attempt ID', 'string', { required: true }),
    ],
  }),
])

const MATERIAL_RECONCILIATION_OBJECT_IDS = Object.freeze(
  MATERIAL_RECONCILIATION_TEMPLATES.map((template) => template.objectId),
)

module.exports = {
  MATERIAL_RECONCILIATION_MANIFEST_ID,
  MATERIAL_RECONCILIATION_ROUTE_NAMESPACE,
  MATERIAL_RECONCILIATION_FLAG_ENV,
  MATERIAL_RECONCILIATION_PERMISSIONS,
  MATERIAL_RECONCILIATION_TEMPLATE_ID_PREFIX,
  MATERIAL_RECONCILIATION_OBJECT_ID_PREFIX,
  isMaterialReconciliationFlagValueEnabled,
  MR_FIELD_TYPES,
  MR_FIELD_TYPE_SET,
  MR_TEMPLATE_FAMILIES,
  MR_TEMPLATE_FAMILY_SET,
  MR_ROLES,
  MR_ROLE_SET,
  MR_RUN_STATES,
  MR_RUN_STATE_SET,
  MR_RUN_TERMINAL_STATES,
  MR_RUN_TERMINAL_STATE_SET,
  MR_RUN_TRANSITIONS,
  MR_BINDING_STATUSES,
  MR_BINDING_STATUS_SET,
  MR_BINDING_TRANSITIONS,
  MR_DIFF_BUCKETS,
  MR_DIFF_BUCKET_SET,
  MR_FAILURE_CLASSES,
  MR_FAILURE_CLASS_SET,
  MR_FAILURE_REASONS,
  MR_FAILURE_REASON_CODES,
  MR_FAILURE_REASON_CODE_SET,
  MR_CONSISTENCY_PROOF_MECHANISMS,
  MR_CONSISTENCY_PROOF_MECHANISM_SET,
  MR_WRITE_DISCIPLINES,
  MR_WRITE_DISCIPLINE_SET,
  MR_BINDING_AUDIT_ACTIONS,
  MR_BINDING_AUDIT_ACTION_SET,
  MR_IDENTITY_KEY_CLASSES,
  MR_IDENTITY_KEY_CLASS_SET,
  MR_SELECT_VOCABULARIES,
  MATERIAL_RECONCILIATION_TEMPLATES,
  MATERIAL_RECONCILIATION_OBJECT_IDS,
  MaterialReconciliationTemplateError,
  normalizeMaterialReconciliationTemplate,
  buildSheetStructureFromMaterialReconciliationTemplate,
  summarizeMaterialReconciliationEvidence,
  __internals: {
    FORBIDDEN_CONTENT_KEYS,
    INTERNAL_ONLY_FIELD_ID_SUFFIXES,
    INTERNAL_ONLY_FIELD_IDS,
    fieldIdRequiresInternalOnly,
    isPlainObject,
    isSecretShaped,
    assertNoContentKeys,
    assertSafeSchemaString,
    deepFreeze,
    normalizeMaterialReconciliationField,
    normalizeMaterialReconciliationSelect,
    normalizeMaterialReconciliationUniqueness,
    normalizeMaterialReconciliationReference,
  },
}
