'use strict'

// D1 material-reconciliation frozen-contract tests. Plain node test (throws on
// failure). Pins identity/reservation constants, closed vocabularies, one-way
// transition maps, the nine frozen templates, the schema-only/values-free
// boundary, and structural independence from the stock-prep domain (charter §3).

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB_PATH = path.join(__dirname, '..', 'lib', 'material-reconciliation-templates.cjs')
const mod = require(LIB_PATH)

const {
  MATERIAL_RECONCILIATION_MANIFEST_ID,
  MATERIAL_RECONCILIATION_ROUTE_NAMESPACE,
  MATERIAL_RECONCILIATION_FLAG_ENV,
  MATERIAL_RECONCILIATION_PERMISSIONS,
  isMaterialReconciliationFlagValueEnabled,
  MR_FIELD_TYPES,
  MR_ROLES,
  MR_RUN_STATES,
  MR_RUN_TERMINAL_STATES,
  MR_RUN_TRANSITIONS,
  MR_BINDING_STATUSES,
  MR_BINDING_TRANSITIONS,
  MR_DIFF_BUCKETS,
  MR_FAILURE_CLASSES,
  MR_FAILURE_REASONS,
  MR_FAILURE_REASON_CODES,
  MR_CONSISTENCY_PROOF_MECHANISMS,
  MR_WRITE_DISCIPLINES,
  MR_BINDING_AUDIT_ACTIONS,
  MR_IDENTITY_KEY_CLASSES,
  MR_SELECT_VOCABULARIES,
  MATERIAL_RECONCILIATION_TEMPLATES,
  MATERIAL_RECONCILIATION_OBJECT_IDS,
  MaterialReconciliationTemplateError,
  normalizeMaterialReconciliationTemplate,
  buildSheetStructureFromMaterialReconciliationTemplate,
  summarizeMaterialReconciliationEvidence,
  __internals,
} = mod

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function assertThrowsTemplateError(fn, message) {
  assert.throws(fn, MaterialReconciliationTemplateError, message)
}

function main() {
  // --- A. Identity + reservation constants ---------------------------------
  assert.equal(MATERIAL_RECONCILIATION_MANIFEST_ID, 'material.reconciliation.v1')
  assert.equal(MATERIAL_RECONCILIATION_ROUTE_NAMESPACE, '/api/material-reconciliation')
  assert.equal(MATERIAL_RECONCILIATION_FLAG_ENV, 'MULTITABLE_MATERIAL_RECONCILIATION_ENABLED')
  assert.deepStrictEqual([...MATERIAL_RECONCILIATION_PERMISSIONS], [
    'material-reconciliation:read',
    'material-reconciliation:operate',
    'material-reconciliation:admin',
  ])
  assert.ok(Object.isFrozen(MATERIAL_RECONCILIATION_PERMISSIONS))
  // OD-V2-6: only the literal 'true' enables.
  assert.equal(isMaterialReconciliationFlagValueEnabled('true'), true)
  for (const value of ['TRUE', '1', 'yes', 'on', '', undefined, null, true]) {
    assert.equal(isMaterialReconciliationFlagValueEnabled(value), false, `flag literal-only: ${String(value)}`)
  }

  // --- B. Closed vocabularies ----------------------------------------------
  assert.deepStrictEqual([...MR_FIELD_TYPES], ['string', 'number', 'boolean', 'date', 'select'])
  assert.deepStrictEqual([...MR_ROLES], ['engineering_material_master', 'enterprise_material_master'])
  assert.equal(MR_ROLES.length, 2, 'V1 has exactly two roles')

  assert.deepStrictEqual([...MR_RUN_STATES], [
    'planned',
    'reading_sources',
    'snapshots_complete',
    'compared',
    'complete',
    'deduplicated',
    'failed',
  ])
  assert.ok(MR_RUN_STATES.includes('deduplicated'), 'deduplicated terminal present')
  for (const state of MR_RUN_STATES) {
    assert.ok(!/pending/i.test(state), `no pending-style state (rev-5): ${state}`)
  }
  assert.deepStrictEqual([...MR_RUN_TERMINAL_STATES], ['complete', 'deduplicated', 'failed'])

  assert.deepStrictEqual([...MR_BINDING_STATUSES], [
    'draft_candidate',
    'preflight_passed',
    'approved',
    'superseded',
    'revoked',
  ])
  assert.equal(MR_BINDING_STATUSES.length, 5)
  assert.ok(!MR_BINDING_STATUSES.includes('active'), "'active' is the derived pointed-at predicate, never a stored status")

  assert.deepStrictEqual([...MR_DIFF_BUCKETS], [
    'only_in_engineering',
    'only_in_enterprise',
    'matched_consistent',
    'matched_divergent',
    'ambiguous',
    'identity_invalid',
  ])
  assert.equal(MR_DIFF_BUCKETS.length, 6)

  assert.deepStrictEqual([...MR_CONSISTENCY_PROOF_MECHANISMS], [
    'SOURCE_SNAPSHOT_TXN',
    'IMMUTABLE_SNAPSHOT_TOKEN',
    'MONOTONIC_VERSION_PIN',
  ])
  assert.ok(
    !MR_CONSISTENCY_PROOF_MECHANISMS.includes('DUAL_SWEEP_DIGEST_MATCH'),
    'DUAL_SWEEP_DIGEST_MATCH is stability evidence only, never a consistency proof',
  )

  assert.deepStrictEqual(clone(MR_FAILURE_REASONS), [
    { reason: 'RUN_IDENTITY_CLAIM_BUSY', class: 'retryable' },
    { reason: 'READ_UNPROVABLE', class: 'fail_closed' },
    { reason: 'SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE', class: 'fail_closed' },
  ])
  assert.equal(
    MR_FAILURE_REASONS.find((entry) => entry.reason === 'RUN_IDENTITY_CLAIM_BUSY').class,
    'retryable',
    'claim-busy is retryable (§4.4 rev-6)',
  )
  assert.deepStrictEqual([...MR_FAILURE_CLASSES], ['retryable', 'fail_closed'])
  assert.deepStrictEqual([...MR_FAILURE_REASON_CODES], [
    'RUN_IDENTITY_CLAIM_BUSY',
    'READ_UNPROVABLE',
    'SOURCE_SNAPSHOT_CONSISTENCY_UNPROVABLE',
  ])

  assert.deepStrictEqual([...MR_WRITE_DISCIPLINES], [
    'state_machine_only',
    'create_only',
    'create_only_status_one_way',
    'pointer_cas_only',
    'append_only_values_free',
    'claim_only',
  ])
  // Deep-review rulings: retention is a frozen per-object attribute; fail_phase
  // is the CLOSED state-machine-derived phase vocabulary.
  assert.deepStrictEqual([...mod.MR_RETENTION_POLICIES], ['permanent', 'released_on_failed'])
  assert.deepStrictEqual([...mod.MR_RUN_PHASES], ['planned', 'reading_sources', 'snapshots_complete', 'compared'])
  assert.deepStrictEqual(
    [...mod.MR_RUN_PHASES],
    MR_RUN_STATES.filter((state) => MR_RUN_TRANSITIONS[state].includes('failed')),
    'phases are EXACTLY the states with an X->failed transition (no invented phases)',
  )
  assert.deepStrictEqual([...MR_BINDING_AUDIT_ACTIONS], [
    'candidate_created',
    'preflight_passed',
    'approved',
    'activated',
    'superseded',
    'revoked',
    'pointer_cleared',
    'pointer_switched',
  ])
  assert.deepStrictEqual([...MR_IDENTITY_KEY_CLASSES], ['valid', 'identity_invalid'])

  // Vocab arrays are frozen.
  for (const vocab of [MR_RUN_STATES, MR_BINDING_STATUSES, MR_DIFF_BUCKETS, MR_FAILURE_REASONS, MR_CONSISTENCY_PROOF_MECHANISMS, MR_WRITE_DISCIPLINES, MR_BINDING_AUDIT_ACTIONS, MR_ROLES]) {
    assert.ok(Object.isFrozen(vocab), 'vocabularies are frozen')
  }

  // --- Transition maps are one-way (no re-entry; terminals empty) ----------
  assert.deepStrictEqual(Object.keys(MR_RUN_TRANSITIONS).sort(), [...MR_RUN_STATES].sort(), 'every run state has a transition entry')
  const runIndex = new Map(MR_RUN_STATES.map((state, index) => [state, index]))
  for (const [from, targets] of Object.entries(MR_RUN_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(MR_RUN_STATES.includes(to), `run transition target in vocab: ${from}->${to}`)
      assert.ok(runIndex.get(to) > runIndex.get(from), `run transitions never re-enter a previous state: ${from}->${to}`)
    }
  }
  for (const terminal of MR_RUN_TERMINAL_STATES) {
    assert.deepStrictEqual([...MR_RUN_TRANSITIONS[terminal]], [], `terminal ${terminal} has no outgoing transition`)
  }
  assert.deepStrictEqual([...MR_RUN_TRANSITIONS.planned], ['reading_sources', 'failed'])
  assert.deepStrictEqual([...MR_RUN_TRANSITIONS.reading_sources], ['snapshots_complete', 'failed'])
  assert.deepStrictEqual([...MR_RUN_TRANSITIONS.snapshots_complete], ['compared', 'failed'])
  assert.deepStrictEqual([...MR_RUN_TRANSITIONS.compared], ['complete', 'deduplicated', 'failed'])

  assert.deepStrictEqual(Object.keys(MR_BINDING_TRANSITIONS).sort(), [...MR_BINDING_STATUSES].sort(), 'every binding status has a transition entry')
  const bindingIndex = new Map(MR_BINDING_STATUSES.map((status, index) => [status, index]))
  for (const [from, targets] of Object.entries(MR_BINDING_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(MR_BINDING_STATUSES.includes(to), `binding transition target in vocab: ${from}->${to}`)
      assert.ok(bindingIndex.get(to) > bindingIndex.get(from), `binding transitions never re-enter a previous status: ${from}->${to}`)
    }
  }
  assert.deepStrictEqual([...MR_BINDING_TRANSITIONS.draft_candidate], ['preflight_passed'])
  assert.deepStrictEqual([...MR_BINDING_TRANSITIONS.preflight_passed], ['approved'])
  assert.deepStrictEqual([...MR_BINDING_TRANSITIONS.approved], ['superseded', 'revoked'])
  assert.deepStrictEqual([...MR_BINDING_TRANSITIONS.superseded], [])
  assert.deepStrictEqual([...MR_BINDING_TRANSITIONS.revoked], [])

  // --- Frozen object-id list: exactly the nine, structural prefixes --------
  assert.deepStrictEqual([...MATERIAL_RECONCILIATION_OBJECT_IDS], [
    'material_reconciliation_run',
    'material_reconciliation_source_snapshot',
    'material_reconciliation_source_snapshot_row',
    'material_reconciliation_diff',
    'material_reconciliation_scenario',
    'material_reconciliation_binding_version',
    'material_reconciliation_binding_member',
    'material_reconciliation_binding_audit',
    'material_reconciliation_run_identity_claim',
  ])
  assert.equal(MATERIAL_RECONCILIATION_TEMPLATES.length, 9, 'exactly nine templates')
  assert.ok(Object.isFrozen(MATERIAL_RECONCILIATION_TEMPLATES))
  assert.ok(Object.isFrozen(MATERIAL_RECONCILIATION_OBJECT_IDS))

  for (const template of MATERIAL_RECONCILIATION_TEMPLATES) {
    assert.ok(Object.isFrozen(template), `${template.objectId} frozen`)
    assert.ok(template.objectId.startsWith('material_reconciliation_'), `${template.objectId} objectId prefix`)
    assert.ok(!template.objectId.includes('plm_stock_preparation_'), `${template.objectId} no stock-prep objectId prefix`)
    assert.ok(template.id.startsWith('material.reconciliation.'), `${template.id} template id prefix`)
    assert.ok(template.id.endsWith('.v1'), `${template.id} versioned template id`)
    assert.ok(!template.id.includes('plm.stock-preparation'), `${template.id} no stock-prep template id prefix`)
    assert.equal(template.version, 'v1')
    for (const field of template.fields) {
      assert.ok(!field.id.includes('plm_stock_preparation_'), `${template.objectId}.${field.id} no stock-prep field prefix`)
      assert.ok(Object.isFrozen(field), `${template.objectId}.${field.id} frozen`)
    }
  }

  // --- Per-template family/discipline/keys/select/internalOnly -------------
  const byObjectId = Object.fromEntries(MATERIAL_RECONCILIATION_TEMPLATES.map((t) => [t.objectId, t]))
  const EXPECTED_SHAPE = {
    material_reconciliation_run: { family: 'data', writeDiscipline: 'state_machine_only', retention: 'permanent', keyFields: ['attempt_id'] },
    material_reconciliation_source_snapshot: { family: 'data', writeDiscipline: 'create_only', retention: 'permanent', keyFields: ['snapshot_id'] },
    material_reconciliation_source_snapshot_row: { family: 'data', writeDiscipline: 'create_only', retention: 'permanent', keyFields: ['row_id'] },
    material_reconciliation_diff: { family: 'data', writeDiscipline: 'create_only', retention: 'permanent', keyFields: ['diff_id'] },
    material_reconciliation_scenario: { family: 'binding', writeDiscipline: 'pointer_cas_only', retention: 'permanent', keyFields: ['scenario_id'] },
    material_reconciliation_binding_version: { family: 'binding', writeDiscipline: 'create_only_status_one_way', retention: 'permanent', keyFields: ['binding_version_id'] },
    material_reconciliation_binding_member: { family: 'binding', writeDiscipline: 'create_only', retention: 'permanent', keyFields: ['member_id'] },
    material_reconciliation_binding_audit: { family: 'binding', writeDiscipline: 'append_only_values_free', retention: 'permanent', keyFields: ['audit_id'] },
    material_reconciliation_run_identity_claim: { family: 'claim', writeDiscipline: 'claim_only', retention: 'released_on_failed', keyFields: ['tenant_id', 'run_identity_key'] },
  }
  for (const [objectId, expected] of Object.entries(EXPECTED_SHAPE)) {
    const template = byObjectId[objectId]
    assert.ok(template, `template exists: ${objectId}`)
    assert.equal(template.family, expected.family, `${objectId} family`)
    assert.equal(template.writeDiscipline, expected.writeDiscipline, `${objectId} write discipline`)
    assert.equal(template.retention, expected.retention, `${objectId} retention policy`)
    assert.deepStrictEqual([...template.keyFields], expected.keyFields, `${objectId} key fields`)
    const fieldById = Object.fromEntries(template.fields.map((field) => [field.id, field]))
    for (const keyField of template.keyFields) {
      assert.equal(fieldById[keyField]?.key, true, `${objectId}.${keyField} exists as key:true`)
    }
    for (const field of template.fields) {
      // Select fields resolve to exported closed vocabularies.
      if (field.type === 'select') {
        const vocabName = field.select?.vocab
        assert.ok(vocabName, `${objectId}.${field.id} select names a vocab`)
        assert.ok(Array.isArray(mod[vocabName]), `${objectId}.${field.id} vocab ${vocabName} is exported`)
        assert.equal(MR_SELECT_VOCABULARIES[vocabName], mod[vocabName], `${objectId}.${field.id} vocab registered`)
        assert.ok(mod[vocabName].length > 0, `${objectId}.${field.id} vocab non-empty`)
      } else {
        assert.equal(field.select, undefined, `${objectId}.${field.id} non-select carries no vocab`)
      }
      // Digest/fingerprint/content-key/lineage/identity/projection fields are
      // internalOnly (internal/HMAC only, never public bare SHA).
      const requiresInternal =
        field.id.endsWith('_digest') ||
        field.id.endsWith('_fingerprint') ||
        field.id.endsWith('_content_key') ||
        field.id.endsWith('_lineage_key') ||
        ['run_identity_key', 'identity_key_normalized', 'projection_normalized'].includes(field.id)
      if (requiresInternal) {
        assert.equal(field.internalOnly, true, `${objectId}.${field.id} must be internalOnly`)
      }
      assert.equal(requiresInternal, __internals.fieldIdRequiresInternalOnly(field.id), `${objectId}.${field.id} suffix rule agrees`)
    }
  }

  // Run template: 058-precedent partial-unique on the semantic identity key.
  const run = byObjectId.material_reconciliation_run
  assert.ok(Array.isArray(run.uniqueness) && run.uniqueness.length === 1, 'run declares one uniqueness constraint')
  assert.deepStrictEqual(clone(run.uniqueness[0]), {
    fields: ['run_identity_key'],
    scope: 'tenant',
    partial: 'run_identity_key IS NOT NULL',
  })
  assert.ok(run.uniqueness[0].partial.includes('IS NOT NULL'), 'partial unique excludes NULL identity keys')
  const runFieldById = Object.fromEntries(run.fields.map((field) => [field.id, field]))
  assert.equal(runFieldById.state.select.vocab, 'MR_RUN_STATES')
  // Deep review: fail_class is NOT stored (reason->class binding lives in
  // MR_FAILURE_REASONS; a stored class could contradict the reason).
  assert.equal(runFieldById.fail_class, undefined, 'run must NOT store fail_class')
  assert.equal(runFieldById.fail_reason.select.vocab, 'MR_FAILURE_REASON_CODES')
  assert.equal(runFieldById.fail_phase.select.vocab, 'MR_RUN_PHASES', 'fail_phase is the closed phase vocabulary')
  // §5 failed-record contract: values-free per-side read-progress counts.
  for (const countField of ['engineering_pages_read', 'enterprise_pages_read', 'engineering_rows_read', 'enterprise_rows_read']) {
    assert.equal(runFieldById[countField].type, 'number', `run carries ${countField}`)
  }
  assert.equal(runFieldById.run_identity_key.internalOnly, true)
  assert.equal(runFieldById.run_identity_key.required, undefined, 'run identity key is NULL until claim-winning commit')
  assert.equal(runFieldById.superseded_at_commit.type, 'boolean')
  assert.equal(runFieldById.winner_attempt_id.type, 'string', 'winner reference is an opaque handle')

  // Snapshot template: role + proof mechanism required selects.
  const snapshot = byObjectId.material_reconciliation_source_snapshot
  const snapshotFieldById = Object.fromEntries(snapshot.fields.map((field) => [field.id, field]))
  assert.equal(snapshotFieldById.role.select.vocab, 'MR_ROLES')
  assert.equal(snapshotFieldById.role.required, true)
  assert.equal(snapshotFieldById.consistency_proof_mechanism.select.vocab, 'MR_CONSISTENCY_PROOF_MECHANISMS')
  assert.equal(snapshotFieldById.consistency_proof_mechanism.required, true)
  assert.equal(snapshotFieldById.row_count.type, 'number')

  // Diff template: snapshot/row HANDLES only — no projected value fields.
  const diff = byObjectId.material_reconciliation_diff
  const diffFieldIds = diff.fields.map((field) => field.id)
  for (const forbiddenFieldId of ['value', 'content', 'projection_normalized']) {
    assert.ok(!diffFieldIds.includes(forbiddenFieldId), `diff carries no ${forbiddenFieldId} field (handles only)`)
  }
  assert.ok(diffFieldIds.includes('engineering_row_id') && diffFieldIds.includes('enterprise_row_id'), 'diff references row handles')
  const diffFieldById = Object.fromEntries(diff.fields.map((field) => [field.id, field]))
  assert.equal(diffFieldById.bucket.select.vocab, 'MR_DIFF_BUCKETS')
  assert.equal(diffFieldById.multiplicity_engineering.type, 'number')
  assert.equal(diffFieldById.multiplicity_enterprise.type, 'number')

  // Scenario: composite FK pins the active pointer to THIS scenario's binding.
  const scenario = byObjectId.material_reconciliation_scenario
  assert.ok(Array.isArray(scenario.references) && scenario.references.length === 1, 'scenario declares one reference')
  assert.deepStrictEqual(clone(scenario.references[0]), {
    fields: ['scenario_id', 'active_binding_version_id'],
    targetObjectId: 'material_reconciliation_binding_version',
    targetFields: ['scenario_id', 'binding_version_id'],
    composite: true,
  })
  const scenarioFieldById = Object.fromEntries(scenario.fields.map((field) => [field.id, field]))
  assert.equal(scenarioFieldById.active_binding_version_id.required, undefined, 'active pointer is nullable')

  // Binding version: status select over statuses WITHOUT active.
  const bindingVersion = byObjectId.material_reconciliation_binding_version
  const bindingVersionFieldById = Object.fromEntries(bindingVersion.fields.map((field) => [field.id, field]))
  assert.equal(bindingVersionFieldById.status.select.vocab, 'MR_BINDING_STATUSES')
  assert.equal(bindingVersionFieldById.contract_version.required, true)
  assert.equal(bindingVersionFieldById.binding_fingerprint.internalOnly, true)
  assert.equal(bindingVersionFieldById.baseline_lineage_key.internalOnly, true)

  // Binding member: pinned content key single-track (rev-4), internal only.
  const member = byObjectId.material_reconciliation_binding_member
  const memberFieldById = Object.fromEntries(member.fields.map((field) => [field.id, field]))
  assert.equal(memberFieldById.system_content_key.required, true)
  assert.equal(memberFieldById.system_content_key.internalOnly, true)
  assert.equal(memberFieldById.role.select.vocab, 'MR_ROLES')
  assert.ok(!('system_config_version_id' in memberFieldById), 'content-key single-track: no parallel version-id field')

  // Binding audit: values-free by construction — closed action vocab, NO
  // free-text field.
  const audit = byObjectId.material_reconciliation_binding_audit
  const auditFieldIds = audit.fields.map((field) => field.id)
  assert.equal(Object.fromEntries(audit.fields.map((f) => [f.id, f])).action.select.vocab, 'MR_BINDING_AUDIT_ACTIONS')
  for (const freeTextId of ['notes', 'message', 'detail', 'description', 'comment', 'reason_text', 'free_text']) {
    assert.ok(!auditFieldIds.includes(freeTextId), `audit has no free-text field ${freeTextId}`)
  }
  for (const field of audit.fields) {
    assert.ok(field.type !== 'string' || field.id.endsWith('_id'), `audit string fields are opaque handles only: ${field.id}`)
  }

  // Claim table: PK exactly (tenant_id, run_identity_key).
  const claim = byObjectId.material_reconciliation_run_identity_claim
  assert.deepStrictEqual([...claim.keyFields], ['tenant_id', 'run_identity_key'])
  assert.equal(claim.fields.length, 3, 'claim table stores no business values')
  const claimFieldById = Object.fromEntries(claim.fields.map((field) => [field.id, field]))
  assert.equal(claimFieldById.run_identity_key.key, true)
  assert.equal(claimFieldById.run_identity_key.internalOnly, true)
  assert.equal(claimFieldById.winner_attempt_id.required, true)

  // --- E. Structure builder + values-free evidence -------------------------
  for (const template of MATERIAL_RECONCILIATION_TEMPLATES) {
    const structure = buildSheetStructureFromMaterialReconciliationTemplate(template)
    assert.equal(structure.objectId, template.objectId)
    assert.deepStrictEqual(structure.rows, [], `${template.objectId} structure carries no rows`)
    assert.equal(structure.fields.length, template.fields.length)
    assert.deepStrictEqual(structure.keyFields, [...template.keyFields])
    for (const [order, structureField] of structure.fields.entries()) {
      assert.equal(structureField.order, order)
    }
  }

  const evidence = summarizeMaterialReconciliationEvidence()
  assert.equal(evidence.templateCount, 9)
  assert.deepStrictEqual(evidence.objectIds, [...MATERIAL_RECONCILIATION_OBJECT_IDS])
  const evidenceJson = JSON.stringify(evidence)
  assert.ok(!evidenceJson.includes('projection'), 'evidence has no projection values or field ids')
  assert.ok(!evidenceJson.includes('digest'), 'evidence has no digest field ids or values')
  assert.ok(!evidenceJson.includes('k1') && !evidenceJson.includes('row-a'), 'evidence has no fixture tokens')
  for (const entry of evidence.templates) {
    assert.ok(!('rows' in entry), 'evidence carries no rows')
    assert.equal(typeof entry.fieldCount, 'number')
    assert.equal(typeof entry.internalOnlyFieldCount, 'number')
  }
  assert.equal(evidence.vocabularySizes.runStates, 7)
  assert.equal(evidence.vocabularySizes.bindingStatuses, 5)
  assert.equal(evidence.vocabularySizes.diffBuckets, 6)
  assert.equal(evidence.vocabularySizes.consistencyProofMechanisms, 3)

  // --- Forbidden-content negatives -----------------------------------------
  const { FORBIDDEN_CONTENT_KEYS } = __internals
  assert.deepStrictEqual([...FORBIDDEN_CONTENT_KEYS], [
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
  const baseTemplate = clone(byObjectId.material_reconciliation_run)
  for (const contentKey of FORBIDDEN_CONTENT_KEYS) {
    // Template root injection.
    assertThrowsTemplateError(
      () => normalizeMaterialReconciliationTemplate({ ...clone(baseTemplate), [contentKey]: [{ k1: 'row-a' }] }),
      `top-level ${contentKey} rejected`,
    )
    // Field-level injection.
    const withBadField = clone(baseTemplate)
    withBadField.fields[0] = { ...withBadField.fields[0], [contentKey]: 'k1' }
    assertThrowsTemplateError(
      () => normalizeMaterialReconciliationTemplate(withBadField),
      `field-level ${contentKey} rejected`,
    )
    // Uniqueness- and reference-descriptor injections.
    const withBadUniqueness = clone(baseTemplate)
    withBadUniqueness.uniqueness[0] = { ...withBadUniqueness.uniqueness[0], [contentKey]: 'k1' }
    assertThrowsTemplateError(
      () => normalizeMaterialReconciliationTemplate(withBadUniqueness),
      `uniqueness-level ${contentKey} rejected`,
    )
    const withBadReference = clone(byObjectId.material_reconciliation_scenario)
    withBadReference.references[0] = { ...withBadReference.references[0], [contentKey]: 'k1' }
    assertThrowsTemplateError(
      () => normalizeMaterialReconciliationTemplate(withBadReference),
      `reference-level ${contentKey} rejected`,
    )
  }
  // Field value/default/options are also rejected (schema only).
  for (const contentKey of ['value', 'default', 'options']) {
    const withBadField = clone(baseTemplate)
    withBadField.fields[1] = { ...withBadField.fields[1], [contentKey]: 'k1' }
    assertThrowsTemplateError(
      () => normalizeMaterialReconciliationTemplate(withBadField),
      `field ${contentKey} rejected`,
    )
  }

  // --- Normalizer fail-closed negatives ------------------------------------
  // Wrong objectId prefix.
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate({ ...clone(baseTemplate), objectId: 'other_run' }),
    'foreign objectId prefix rejected',
  )
  // Wrong template id prefix.
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate({ ...clone(baseTemplate), id: 'other.run.v1' }),
    'foreign template id prefix rejected',
  )
  // Unknown write discipline / family.
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate({ ...clone(baseTemplate), writeDiscipline: 'free_write' }),
    'unknown write discipline rejected',
  )
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate({ ...clone(baseTemplate), family: 'runtime' }),
    'unknown family rejected',
  )
  // keyField that is not key:true.
  const keylessKey = clone(baseTemplate)
  keylessKey.fields = keylessKey.fields.map((field) => (field.id === 'attempt_id' ? { ...field, key: false } : field))
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate(keylessKey),
    'keyFields entry must be key:true',
  )
  // Duplicate field ids.
  const duplicated = clone(baseTemplate)
  duplicated.fields = duplicated.fields.concat({ ...duplicated.fields[1] })
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate(duplicated),
    'duplicate field id rejected',
  )
  // Digest-shaped field without internalOnly.
  const bareDigest = clone(baseTemplate)
  bareDigest.fields = bareDigest.fields.map((field) =>
    field.id === 'run_identity_key' ? { ...field, internalOnly: false } : field,
  )
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate(bareDigest),
    'identity key without internalOnly rejected',
  )
  const bareSuffixDigest = clone(baseTemplate)
  bareSuffixDigest.fields = bareSuffixDigest.fields.concat({ id: 'k1_digest', label: 'k1', type: 'string' })
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate(bareSuffixDigest),
    'digest-suffixed field without internalOnly rejected',
  )
  // Select field with unknown vocab.
  const badVocab = clone(baseTemplate)
  badVocab.fields = badVocab.fields.map((field) =>
    field.id === 'state' ? { ...field, select: { vocab: 'NOT_A_VOCAB' } } : field,
  )
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate(badVocab),
    'unknown select vocab rejected',
  )
  // Uniqueness referencing a missing field.
  const badUniqueness = clone(baseTemplate)
  badUniqueness.uniqueness = [{ scope: 'tenant', fields: ['k1'], partial: 'k1 IS NOT NULL' }]
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate(badUniqueness),
    'uniqueness on unknown field rejected',
  )
  // Reference targeting a foreign-prefix object.
  const badReference = clone(byObjectId.material_reconciliation_scenario)
  badReference.references = [
    {
      fields: ['scenario_id', 'active_binding_version_id'],
      targetObjectId: 'other_binding_version',
      targetFields: ['scenario_id', 'binding_version_id'],
      composite: true,
    },
  ]
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate(badReference),
    'foreign reference target rejected',
  )

  // --- Structural independence (charter §3) --------------------------------
  const source = fs.readFileSync(LIB_PATH, 'utf8')
  assert.ok(!source.includes("require('./stock-preparation"), 'module does not require stock-preparation modules')
  assert.ok(!source.includes('bom-mapper'), 'module does not touch the BOM mapper')
  assert.ok(!source.includes('classifiers'), 'module does not touch classifier modules')
  assert.ok(!source.includes('persist-unit-of-work'), 'module does not touch persist-unit-of-work')
  assert.ok(!source.includes('plm_stock_preparation_'), 'module never mentions the stock-prep objectId prefix')
  assert.ok(!source.includes('process.env'), 'D1 declares the flag NAME only; no environment read')
  const requireCalls = source.match(/require\((?:'|")[^'"]+(?:'|")\)/g) || []
  assert.deepStrictEqual(requireCalls, ["require('./payload-redaction.cjs')"], 'only allowed dependency is payload-redaction')

  // --- Set mirrors must equal their frozen arrays (review P2-1) ------------
  // Object.freeze cannot protect a Set (Set.prototype.add still works), so the
  // ONLY possible guard for the charter-closed vocabularies' membership
  // vehicles is exact parity with the frozen arrays.
  const setPairs = [
    [mod.MR_FIELD_TYPES, mod.MR_FIELD_TYPE_SET, 'MR_FIELD_TYPE_SET'],
    [mod.MR_TEMPLATE_FAMILIES, mod.MR_TEMPLATE_FAMILY_SET, 'MR_TEMPLATE_FAMILY_SET'],
    [mod.MR_ROLES, mod.MR_ROLE_SET, 'MR_ROLE_SET'],
    [mod.MR_RUN_STATES, mod.MR_RUN_STATE_SET, 'MR_RUN_STATE_SET'],
    [mod.MR_RUN_TERMINAL_STATES, mod.MR_RUN_TERMINAL_STATE_SET, 'MR_RUN_TERMINAL_STATE_SET'],
    [mod.MR_BINDING_STATUSES, mod.MR_BINDING_STATUS_SET, 'MR_BINDING_STATUS_SET'],
    [mod.MR_DIFF_BUCKETS, mod.MR_DIFF_BUCKET_SET, 'MR_DIFF_BUCKET_SET'],
    [mod.MR_FAILURE_CLASSES, mod.MR_FAILURE_CLASS_SET, 'MR_FAILURE_CLASS_SET'],
    [mod.MR_FAILURE_REASON_CODES, mod.MR_FAILURE_REASON_CODE_SET, 'MR_FAILURE_REASON_CODE_SET'],
    [mod.MR_CONSISTENCY_PROOF_MECHANISMS, mod.MR_CONSISTENCY_PROOF_MECHANISM_SET, 'MR_CONSISTENCY_PROOF_MECHANISM_SET'],
    [mod.MR_WRITE_DISCIPLINES, mod.MR_WRITE_DISCIPLINE_SET, 'MR_WRITE_DISCIPLINE_SET'],
    [mod.MR_BINDING_AUDIT_ACTIONS, mod.MR_BINDING_AUDIT_ACTION_SET, 'MR_BINDING_AUDIT_ACTION_SET'],
    [mod.MR_IDENTITY_KEY_CLASSES, mod.MR_IDENTITY_KEY_CLASS_SET, 'MR_IDENTITY_KEY_CLASS_SET'],
  ]
  for (const [array, set, name] of setPairs) {
    assert.ok(array && set, `${name} pair exported`)
    assert.deepStrictEqual([...set].sort(), [...array].sort(), `${name} must mirror its frozen array exactly`)
  }

  // --- Transition maps, terminal list, and select-vocab registry are frozen
  //     freezes themselves (review P2-2) ------------------------------------
  const frozenStructures = [
    [mod.MR_RUN_TRANSITIONS, 'MR_RUN_TRANSITIONS'],
    [mod.MR_BINDING_TRANSITIONS, 'MR_BINDING_TRANSITIONS'],
    [mod.MR_RUN_TERMINAL_STATES, 'MR_RUN_TERMINAL_STATES'],
    [mod.MR_SELECT_VOCABULARIES, 'MR_SELECT_VOCABULARIES'],
    [mod.MR_FAILURE_REASONS, 'MR_FAILURE_REASONS'],
  ]
  for (const [structure, name] of frozenStructures) {
    assert.ok(Object.isFrozen(structure), `${name} must be frozen`)
    for (const [innerKey, innerValue] of Object.entries(structure)) {
      if (innerValue && typeof innerValue === 'object') {
        assert.ok(Object.isFrozen(innerValue), `${name}.${innerKey} must be frozen`)
      }
    }
  }
  // The transition maps ARE the §5/§4.5 state machines — cover every state.
  assert.deepStrictEqual(Object.keys(mod.MR_RUN_TRANSITIONS).sort(), [...mod.MR_RUN_STATES].sort(), 'run transitions cover every run state')
  assert.deepStrictEqual(Object.keys(mod.MR_BINDING_TRANSITIONS).sort(), [...mod.MR_BINDING_STATUSES].sort(), 'binding transitions cover every status')

  // --- Select-level forbidden-content enforcement (review P3) --------------
  const selectInjection = clone(byObjectId.material_reconciliation_run)
  selectInjection.fields = selectInjection.fields.map((field) =>
    field.type === 'select' ? { ...field, select: { ...field.select, rawSql: 'x' } } : field,
  )
  assert.ok(
    selectInjection.fields.some((field) => field.select && field.select.rawSql),
    'fixture actually injected a forbidden key into a select descriptor',
  )
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate(selectInjection),
    'forbidden key inside select descriptor rejected',
  )

  // --- Deep-review round: template-contract pins ---------------------------
  // Diff carries NO key material (ruling: DROP identity_key_normalized — keys
  // are recoverable via the stored row handles; handles-only per §3).
  const diffTemplate = byObjectId.material_reconciliation_diff
  for (const forbiddenFieldId of ['value', 'content', 'projection_normalized', 'identity_key_normalized']) {
    assert.ok(
      !diffTemplate.fields.some((field) => field.id === forbiddenFieldId),
      `diff must not carry ${forbiddenFieldId} (handles only)`,
    )
  }

  // Frozen uniqueness set (deep-review P2/P3): member one-per-role, snapshot
  // one-per-side-per-attempt, binding_version pair backing the composite FK.
  assert.deepStrictEqual(clone(byObjectId.material_reconciliation_binding_member.uniqueness), [
    { fields: ['binding_version_id', 'role'] },
  ])
  assert.deepStrictEqual(clone(byObjectId.material_reconciliation_source_snapshot.uniqueness), [
    { fields: ['attempt_id', 'role'] },
  ])
  assert.deepStrictEqual(clone(byObjectId.material_reconciliation_binding_version.uniqueness), [
    { fields: ['scenario_id', 'binding_version_id'] },
  ])

  // Charter-unconditional fields are required (deep-review P3).
  const requiredPins = [
    ['material_reconciliation_source_snapshot', 'snapshot_content_digest'],
    ['material_reconciliation_source_snapshot', 'source_read_evidence_digest'],
    ['material_reconciliation_source_snapshot_row', 'canonical_row_digest'],
    ['material_reconciliation_source_snapshot_row', 'projection_normalized'],
    ['material_reconciliation_source_snapshot_row', 'identity_key_class'],
    ['material_reconciliation_binding_version', 'binding_fingerprint'],
    ['material_reconciliation_binding_version', 'baseline_lineage_key'],
  ]
  for (const [objectId, fieldId] of requiredPins) {
    const pinned = byObjectId[objectId].fields.find((field) => field.id === fieldId)
    assert.equal(pinned.required, true, `${objectId}.${fieldId} must be required`)
  }
  // identity_key_normalized on the ROW stays optional: NULL exactly for
  // identity_invalid rows (the empty sentinel).
  assert.equal(
    byObjectId.material_reconciliation_source_snapshot_row.fields.find((f) => f.id === 'identity_key_normalized').required,
    undefined,
  )

  // Mutation-killing negatives (deep-review survived mutants T1/T2):
  // composite-FK arity mismatch must throw…
  const arityMismatch = clone(byObjectId.material_reconciliation_scenario)
  arityMismatch.references = [
    {
      fields: ['scenario_id', 'active_binding_version_id'],
      targetObjectId: 'material_reconciliation_binding_version',
      targetFields: ['scenario_id'],
      composite: true,
    },
  ]
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate(arityMismatch),
    'composite reference arity mismatch rejected',
  )
  // …and the uniqueness scope vocabulary is closed (only 'tenant').
  const badScope = clone(byObjectId.material_reconciliation_run)
  badScope.uniqueness = [{ scope: 'global', fields: ['run_identity_key'], partial: 'run_identity_key IS NOT NULL' }]
  assertThrowsTemplateError(
    () => normalizeMaterialReconciliationTemplate(badScope),
    'uniqueness scope outside the closed set rejected',
  )
  // Retention is required and closed.
  const noRetention = clone(byObjectId.material_reconciliation_run)
  delete noRetention.retention
  assertThrowsTemplateError(() => normalizeMaterialReconciliationTemplate(noRetention), 'missing retention rejected')
  const badRetention = { ...clone(byObjectId.material_reconciliation_run), retention: 'forever' }
  assertThrowsTemplateError(() => normalizeMaterialReconciliationTemplate(badRetention), 'unknown retention rejected')

  // Set-mirror parity for the new vocabularies.
  assert.deepStrictEqual([...mod.MR_RETENTION_POLICY_SET].sort(), [...mod.MR_RETENTION_POLICIES].sort())
  assert.deepStrictEqual([...mod.MR_RUN_PHASE_SET].sort(), [...mod.MR_RUN_PHASES].sort())
  assert.ok(Object.isFrozen(mod.MR_RETENTION_POLICIES) && Object.isFrozen(mod.MR_RUN_PHASES))

  console.log('material-reconciliation-templates.test.cjs OK')
}

main()
