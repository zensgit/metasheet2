const crypto = require('node:crypto')
const { z } = require('zod')

const MAX_REASON_LENGTH = 500

async function readAttendanceCleaningReviewDescriptor({ orgId, settings, provisioning, authorize }) {
  if (settings.attendanceMultitableCleaningPolicy?.enabled !== true
    || settings.attendanceResultEditPolicy?.enabled === false) return { enabled: false }
  try {
    await authorize()
    const projectId = `${orgId}:attendance`
    const objectId = 'attendance_report_records'
    const sheet = await provisioning.findObjectSheet({ projectId, objectId })
    if (!sheet || !await provisioning.isSheetOwnedByProject(sheet.id, projectId)) return { enabled: false }
    const fieldIds = Object.fromEntries(['cleaning_requested', 'cleaning_reason', 'employee_name', 'work_date']
      .map(code => [code, provisioning.getFieldId(projectId, objectId, code)]))
    if (Object.values(fieldIds).some(id => typeof id !== 'string' || !id.startsWith('fld_'))) return { enabled: false }
    return { enabled: true, orgId, sheetId: sheet.id, fieldIds }
  } catch { return { enabled: false } }
}

function normalizeAttendanceMultitableCleaningPolicy(value) {
  return { enabled: value?.enabled === true }
}

function buildAttendanceCleaningProposal(data) {
  if (!data || typeof data !== 'object' || data.cleaning_requested !== true) return null
  const reason = typeof data.cleaning_reason === 'string' ? data.cleaning_reason.trim() : ''
  if (!reason || reason.length > MAX_REASON_LENGTH) return null
  return { requested: true, reason, targetStatus: 'normal' }
}

function buildAttendanceCleaningProposalDigest(input) {
  if (!input || typeof input !== 'object' || !input.proposal?.requested || input.proposal.targetStatus !== 'normal') {
    throw new Error('ATTENDANCE_CLEANING_PROPOSAL_INVALID')
  }
  const values = [input.orgId, input.projectionRecordId, input.sourceFingerprint, input.proposal.reason]
  if (values.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new Error('ATTENDANCE_CLEANING_PROPOSAL_INVALID')
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify(['attendance-cleaning-proposal-v1', ...values, true, 'normal']))
    .digest('hex')
}

function buildAttendanceCleaningProposalCleanup() {
  return {
    cleaning_requested: false,
    cleaning_reason: null,
  }
}

function buildAttendanceCleaningOperationIdentity(input) {
  const proposalDigest = buildAttendanceCleaningProposalDigest(input)
  const operationId = attendanceCleaningOperationIdFromDigest(proposalDigest)
  const sourceDigest = crypto.createHash('sha256')
    .update(JSON.stringify(['attendance-cleaning-source-v1', input.orgId, input.projectionRecordId]))
    .digest('hex')
  return {
    proposalDigest,
    operationId,
    sourceRef: `attendance-cleaning-source-v1:${sourceDigest}`,
    reviewedProposalRef: `attendance-cleaning-proposal-v1:${proposalDigest}`,
  }
}

function attendanceCleaningOperationIdFromDigest(proposalDigest) {
  if (!/^[0-9a-f]{64}$/.test(proposalDigest)) throw new Error('ATTENDANCE_CLEANING_CONFLICT')
  // RFC 4122 URL namespace; the versioned name binds the fresh W4 operation to
  // the normalized proposal, independently of record CAS version/custom columns.
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')
  const bytes = crypto.createHash('sha1').update(namespace)
    .update(`urn:metasheet:attendance-cleaning:v1:${proposalDigest}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function verifyAttendanceCleaningCompletedRecovery({ input, operation, audit }) {
  const conflict = () => { throw Object.assign(new Error('ATTENDANCE_CLEANING_CONFLICT'), { code: 'ATTENDANCE_CLEANING_CONFLICT' }) }
  try {
    const created = new Date(operation.created_at).getTime()
    const anchored = new Date(input.anchorCreatedAt).getTime()
    if (input.proposal?.requested !== true || input.proposal.targetStatus !== 'normal'
      || !input.actorId || input.actorId !== input.tokenSubjectUserId
      || operation.org_id !== input.orgId || operation.actor_id !== input.actorId
      || operation.token_subject_user_id !== input.tokenSubjectUserId
      || !['attendance_admin', 'platform_admin'].includes(operation.actor_posture)
      || operation.identity_source_kind !== 'direct_manual_edit'
      || operation.source_ref !== input.sourceRef || operation.entrypoint !== 'manual_edit'
      || operation.capability !== 'manual_edit' || operation.state !== 'completed'
      || operation.resolved_record_id !== input.canonicalRecordId
      || typeof input.selectedCalculationId !== 'string' || !input.selectedCalculationId
      || operation.resolved_calculation_id !== input.selectedCalculationId
      || operation.anchor_epoch_matches !== true
      || !Number.isFinite(created) || !Number.isFinite(anchored) || created < anchored
      || audit.org_id !== input.orgId || audit.record_id !== input.canonicalRecordId
      || audit.actor_user_id !== input.actorId || audit.idempotency_key !== operation.operation_id
      || audit.reason !== input.proposal.reason || !Array.isArray(audit.evidence)
      || audit.evidence.length !== 1 || audit.evidence[0]?.type !== 'text') conflict()
    const reference = audit.evidence[0].text
    if (typeof reference !== 'string' || !/^attendance-cleaning-proposal-v1:[0-9a-f]{64}$/.test(reference)) conflict()
    const proposalDigest = reference.slice('attendance-cleaning-proposal-v1:'.length)
    if (attendanceCleaningOperationIdFromDigest(proposalDigest) !== operation.operation_id) conflict()
    return { operationId: operation.operation_id, proposalDigest,
      sourceRef: input.sourceRef, reviewedProposalRef: reference }
  } catch { conflict() }
}

function assertAttendanceCleaningFreshSource(input) {
  const conflict = () => { throw Object.assign(new Error('ATTENDANCE_CLEANING_CONFLICT'), { code: 'ATTENDANCE_CLEANING_CONFLICT' }) }
  try {
    const { locked, seed } = input
    const { anchor, selected, record, projection, fieldIds } = locked
    if (projection.id !== input.projectionRecordId || projection.version !== input.expectedVersion
      || record.org_id !== input.orgId || anchor.org_id !== input.orgId
      || record.canonical_record_id !== anchor.canonical_record_id
      || seed.canonicalRecordId !== anchor.canonical_record_id
      || !['late', 'early_leave', 'late_early', 'partial', 'absent'].includes(record.status)
      || locked.canonicalSourceDigest !== anchor.canonical_source_digest
      || input.computedFingerprint !== anchor.source_fingerprint
      || input.storedFingerprint !== anchor.source_fingerprint
      || seed.sourceFingerprint !== anchor.source_fingerprint
      || selected.selector !== anchor.source_selector
      || selected.calculation.id !== anchor.source_calculation_id
      || selected.calculation.version !== anchor.source_calculation_version
      || seed.sourceCalculationId !== selected.calculation.id
      || seed.sourceCalculationVersion !== selected.calculation.version) conflict()
    const proposal = buildAttendanceCleaningProposal({
      cleaning_requested: projection.data[fieldIds.requested],
      cleaning_reason: projection.data[fieldIds.reason],
    })
    if (!proposal) conflict()
    const identity = buildAttendanceCleaningOperationIdentity({ orgId: input.orgId,
      projectionRecordId: projection.id, sourceFingerprint: anchor.source_fingerprint, proposal })
    for (const field of ['operationId', 'proposalDigest', 'sourceRef', 'reviewedProposalRef']) {
      if (identity[field] !== input.identity[field]) conflict()
    }
    return { proposal, identity }
  } catch { conflict() }
}

function createAttendanceCleaningOperationAdapter(deps) {
  const refuse = (code) => { throw Object.assign(new Error(code), { code }) }
  const readRecovery = async (trx, input, selectedCalculationId = input.seed.selectedCalculationId) => {
    const candidates = await deps.authority.readCompletedInTransaction(trx, { ...input, sourceRef: input.identity.sourceRef })
    if (candidates.length !== 1) refuse('ATTENDANCE_CLEANING_CONFLICT')
    const candidate = candidates[0]
    const identity = verifyAttendanceCleaningCompletedRecovery({ input: {
      ...input, sourceRef: input.identity.sourceRef, canonicalRecordId: input.seed.canonicalRecordId,
      anchorCreatedAt: input.seed.anchorCreatedAt, selectedCalculationId,
    }, operation: candidate.operation, audit: candidate.audit })
    if (identity.operationId !== input.identity.operationId) refuse('ATTENDANCE_CLEANING_CONFLICT')
    return candidate
  }
  const manualInput = async (trx, input) => {
    const settings = await deps.loadSettings(trx)
    if (settings.attendanceMultitableCleaningPolicy?.enabled !== true
      || settings.attendanceResultEditPolicy?.enabled === false) refuse('ATTENDANCE_CLEANING_DISABLED')
    return {
      orgId: input.orgId, actorId: input.actorId, tokenSubjectUserId: input.tokenSubjectUserId,
      recordId: input.seed.canonicalRecordId,
      expectedCalculationId: input.seed.sourceCalculationId,
      expectedCalculationVersion: input.seed.sourceCalculationVersion,
      targetStatus: 'normal', overrideMetrics: null, reason: input.proposal.reason,
      evidence: [{ type: 'text', text: input.identity.reviewedProposalRef }],
      idempotencyKey: input.identity.operationId,
      editWindowDays: settings.attendanceResultEditPolicy.editWindowDays,
      notifyAffectedEmployee: false,
    }
  }
  return {
    prepareAttendanceCleaningFence: async input => ({ orgId: input.orgId, projectionRecordId: input.projectionRecordId }),
    async prepareIdentity(trx, input) {
      const routeInput = await manualInput(trx, input)
      const prepared = await deps.manualEditAdapter.prepareIdentity(trx, routeInput)
      if (input.recovery) {
        const candidate = await readRecovery(trx, input)
        const calculation = candidate.calculation
        const override = calculation?.manual_override_snapshot
        const provenance = calculation?.input_provenance
        if (!candidate.prior_calculation_id || !Number.isSafeInteger(candidate.prior_calculation_version)
          || candidate.prior_calculation_version < 1 || !Array.isArray(override?.operations)
          || override.editId !== candidate.operation.operation_id
          || provenance?.priorCalculationId !== candidate.prior_calculation_id
          || provenance.reason !== candidate.audit.reason
          || JSON.stringify(provenance.evidence?.items) !== JSON.stringify(candidate.audit.evidence)) refuse('ATTENDANCE_CLEANING_CONFLICT')
        return { ...prepared, attendanceCleaningReplay: 'require-completed', commandPayload: {
          recordId: input.seed.canonicalRecordId,
          expectedCalculationId: candidate.prior_calculation_id,
          expectedCalculationVersion: candidate.prior_calculation_version,
          operations: override.operations, reason: candidate.audit.reason, evidence: provenance.evidence,
        } }
      }
      // Recovery above must reuse the original completed operation. A source
      // appearing after the route pre-read cannot mint a second canonical effect.
      const prior = await trx.query(`SELECT operation_id FROM attendance_result_operations
        WHERE org_id = $1 AND source_ref = $2 LIMIT 1`, [input.orgId, input.identity.sourceRef])
      if (prior.length !== 0) refuse('ATTENDANCE_CLEANING_CONFLICT')
      return { ...prepared, attendanceCleaningReplay: 'allow-new' }
    },
    async prepare(trx, input) {
      const locked = await deps.authority.lockSource(trx, input, input.seed)
      const fingerprints = await deps.readManagedFingerprint(trx, locked)
      assertAttendanceCleaningFreshSource({ ...input, locked, ...fingerprints })
      const prepared = await deps.manualEditAdapter.prepare(trx, await manualInput(trx, input))
      return { ...prepared, attendanceCleaningReplay: 'allow-new' }
    },
    execute: (trx, prepared, operation) => deps.manualEditAdapter.execute(trx, prepared, operation),
    async prepareLockedAttendanceCleaningReplay(trx, input, operation, response) {
      await manualInput(trx, input)
      const locked = await deps.authority.lockSource(trx, input, input.seed)
      const proposal = buildAttendanceCleaningProposal({ cleaning_requested: locked.projection.data[locked.fieldIds.requested],
        cleaning_reason: locked.projection.data[locked.fieldIds.reason] })
      if (!proposal || operation.operationId !== input.identity.operationId) refuse('ATTENDANCE_CLEANING_CONFLICT')
      await readRecovery(trx, { ...input, proposal }, locked.selected.calculation.id)
      await deps.authority.cleanupProposal(trx, input, input.seed, proposal.reason)
      return { ...response, data: { ...response?.data, cleaningState: 'consumed' } }
    },
  }
}

function createAttendanceCleaningFingerprintReader(deps) {
  return async (trx, locked) => {
    const conflict = () => { throw Object.assign(new Error('ATTENDANCE_CLEANING_CONFLICT'), { code: 'ATTENDANCE_CLEANING_CONFLICT' }) }
    const orgId = locked.record.org_id
    const physical = (objectId, code) => {
      const id = deps.fieldId(orgId, objectId, code)
      if (typeof id !== 'string' || !id.startsWith('fld_')) conflict()
      return id
    }
    const catalogIds = Object.fromEntries(deps.catalogFieldCodes.map(code => [code, physical('attendance_report_field_catalog', code)]))
    const codes = new Set()
    const catalog = locked.catalog.map(row => {
      // Strip logical/raw-ID aliases before calling the existing permissive
      // catalog reader. ACP accepts only the provisioner's physical mapping.
      const data = Object.fromEntries(Object.values(catalogIds)
        .filter(id => Object.hasOwn(row.data, id)).map(id => [id, row.data[id]]))
      const code = typeof data[catalogIds.field_code] === 'string' ? data[catalogIds.field_code].trim() : ''
      if (code && codes.has(code)) conflict()
      if (code) codes.add(code)
      return { id: row.id, data }
    })
    const dynamic = await deps.loadDynamic(trx, orgId)
    if (dynamic.degraded) conflict()
    const items = deps.mergeCatalog(catalog, catalogIds, { rawAliasesAllowed: false, extraSystemDefinitions: dynamic.definitions })
    const managedCodes = ['row_key', 'org_id', 'user_id', 'employee_name', 'department', 'attendance_group', 'work_date',
      ...deps.buildColumns(items).map(column => column.id)]
    const logical = {}
    for (const code of managedCodes) {
      const id = physical('attendance_report_records', code)
      if (!Object.hasOwn(locked.projection.data, id)) conflict()
      logical[code] = locked.projection.data[id]
    }
    return {
      computedFingerprint: deps.fingerprint(logical, { overtimeSegmentation: deps.extras(locked.record) }),
      storedFingerprint: locked.projection.data[physical('attendance_report_records', 'source_fingerprint')],
    }
  }
}

function createAttendanceCleaningApplyHandler(deps) {
  const requestSchema = z.object({ expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()
  const reject = (res, status, code) => res.status(status).json({ ok: false, error: { code, message: code } })
  return async (req, res) => {
    const parsed = requestSchema.safeParse(req.body)
    const projectionRecordId = req.params?.recordId
    if (!parsed.success || typeof projectionRecordId !== 'string'
      || !/^rec_[A-Za-z0-9_-]{1,240}$/.test(projectionRecordId)) {
      return reject(res, 400, 'ATTENDANCE_CLEANING_REQUEST_INVALID')
    }
    const actorId = deps.getUserId(req)
    const tokenSubjectUserId = deps.getTokenSubject(req)
    if (!actorId || !tokenSubjectUserId || actorId !== tokenSubjectUserId) {
      return reject(res, 401, 'ATTENDANCE_CLEANING_UNAUTHORIZED')
    }
    try {
      const settings = await deps.loadSettings()
      if (settings.attendanceMultitableCleaningPolicy?.enabled !== true
        || settings.attendanceResultEditPolicy?.enabled === false) {
        return reject(res, 403, 'ATTENDANCE_CLEANING_DISABLED')
      }
      const authority = deps.getAuthority()
      const boundary = deps.getBoundary()
      if (!authority?.readSeed || !authority?.readCompleted || !boundary?.executeAttendanceCleaning) {
        return reject(res, 503, 'ATTENDANCE_CLEANING_UNAVAILABLE')
      }
      const input = { orgId: deps.getOrgId(req), actorId, tokenSubjectUserId,
        projectionRecordId, expectedVersion: parsed.data.expectedVersion }
      const seed = await authority.readSeed(input)
      const proposal = buildAttendanceCleaningProposal({ cleaning_requested: seed.requested, cleaning_reason: seed.reason })
      if (!proposal) return reject(res, 409, 'ATTENDANCE_CLEANING_CONFLICT')
      let identity = buildAttendanceCleaningOperationIdentity({ ...input, sourceFingerprint: seed.sourceFingerprint, proposal })
      const candidates = await authority.readCompleted({ ...input, sourceRef: identity.sourceRef })
      if (!Array.isArray(candidates) || candidates.length > 1) return reject(res, 409, 'ATTENDANCE_CLEANING_CONFLICT')
      const recovery = candidates[0] ?? null
      if (recovery) identity = verifyAttendanceCleaningCompletedRecovery({ input: { ...input, proposal,
        sourceRef: identity.sourceRef, canonicalRecordId: seed.canonicalRecordId, anchorCreatedAt: seed.anchorCreatedAt,
        selectedCalculationId: seed.selectedCalculationId }, operation: recovery.operation, audit: recovery.audit })
      const outcome = await boundary.executeAttendanceCleaning({
        kind: 'manual_edit', operationId: identity.operationId, sourceRef: identity.sourceRef,
        correlationId: `attendance-cleaning:${crypto.randomUUID()}`,
        routeInput: { ...input, seed, proposal, identity, recovery: recovery !== null },
      })
      if (outcome.kind === 'replay') return res.status(200).json(outcome.response)
      // Canonical commit has completed. A separate require-completed operation
      // may now clean the proposal; failure cannot roll back or repeat apply.
      try {
        const cleanupSeed = await authority.readSeed(input)
        const cleanupProposal = buildAttendanceCleaningProposal({ cleaning_requested: cleanupSeed.requested, cleaning_reason: cleanupSeed.reason })
        if (!cleanupProposal || cleanupProposal.reason !== proposal.reason) throw new Error('ATTENDANCE_CLEANING_CONFLICT')
        const completed = await authority.readCompleted({ ...input, sourceRef: identity.sourceRef })
        if (completed.length !== 1) throw new Error('ATTENDANCE_CLEANING_CONFLICT')
        const recovered = verifyAttendanceCleaningCompletedRecovery({ input: { ...input, proposal: cleanupProposal,
          sourceRef: identity.sourceRef, canonicalRecordId: cleanupSeed.canonicalRecordId, anchorCreatedAt: cleanupSeed.anchorCreatedAt,
          selectedCalculationId: cleanupSeed.selectedCalculationId }, operation: completed[0].operation, audit: completed[0].audit })
        if (recovered.operationId !== identity.operationId) throw new Error('ATTENDANCE_CLEANING_CONFLICT')
        const cleanup = await boundary.executeAttendanceCleaning({ kind: 'manual_edit', operationId: identity.operationId,
          sourceRef: identity.sourceRef, correlationId: `attendance-cleaning:${crypto.randomUUID()}`,
          routeInput: { ...input, seed: cleanupSeed, proposal: cleanupProposal, identity: recovered, recovery: true },
        })
        return res.status(200).json(cleanup.response)
      } catch {
        return res.status(200).json({ ok: true, data: { cleaningState: 'applied_pending_cleanup' } })
      }
    } catch (error) {
      // A shadow calculation appended after this SERIALIZABLE snapshot can
      // collide at the version insert. The boundary has rolled back the entire
      // operation; this exact constraint is a source conflict, not an outage.
      if (error?.code === '23505' && error?.constraint === 'uq_arc_record_version') {
        return reject(res, 409, 'ATTENDANCE_CLEANING_CONFLICT')
      }
      const known = {
        ATTENDANCE_CLEANING_DISABLED: 403,
        ATTENDANCE_CLEANING_FORBIDDEN: 403,
        ATTENDANCE_CLEANING_CONFLICT: 409,
        ATTENDANCE_CLEANING_BUSY: 409,
        ATTENDANCE_CLEANING_OUTCOME_UNKNOWN: 503,
        ATTENDANCE_CLEANING_UNAVAILABLE: 503,
      }
      const code = Object.hasOwn(known, error?.code) ? error.code
        : error?.message === 'ATTENDANCE_CLEANING_FORBIDDEN' ? 'ATTENDANCE_CLEANING_FORBIDDEN'
          : 'ATTENDANCE_CLEANING_UNAVAILABLE'
      return reject(res, known[code], code)
    }
  }
}

module.exports = {
  readAttendanceCleaningReviewDescriptor,
  createAttendanceCleaningFingerprintReader,
  verifyAttendanceCleaningCompletedRecovery,
  createAttendanceCleaningOperationAdapter,
  assertAttendanceCleaningFreshSource,
  createAttendanceCleaningApplyHandler,
  buildAttendanceCleaningProposal,
  buildAttendanceCleaningProposalCleanup,
  buildAttendanceCleaningProposalDigest,
  buildAttendanceCleaningOperationIdentity,
  normalizeAttendanceMultitableCleaningPolicy,
}
