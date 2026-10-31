const TYPES = ['missed_check_in', 'missed_check_out', 'time_correction']

function createAttendanceApprovedCorrectionTargetsV1(port, HttpError) {
  const fail = (status, code) => { throw new HttpError(status, code, code) }
  const call = async (method, ...args) => {
    if (typeof port?.[method] !== 'function') fail(503, 'ATTENDANCE_CORRECTION_UNAVAILABLE')
    try { return await port[method](...args) }
    catch (error) {
      if (typeof error?.code === 'string' && error.code.startsWith('ATTENDANCE_CORRECTION_')) {
        fail(Number.isInteger(error.httpStatus) ? error.httpStatus : 422, error.code)
      }
      throw error
    }
  }
  return {
    async enrichDecisionContexts(trx, orgId, items, fingerprintForRow) {
      const ids = items.filter(item => item.org_id === orgId && item.status === 'pending'
        && item.metadata?.correctionTargets !== undefined).map(item => item.id)
      if (ids.length === 0) return items
      const rows = await trx.query(
        `SELECT r.id, a.id AS approval_instance_id, a.version AS approval_version, a.current_node_key,
                s.version AS snapshot_version, s.payload_fingerprint
           FROM attendance_requests r JOIN approval_instances a ON a.id = r.approval_instance_id
           JOIN LATERAL (SELECT version, payload_fingerprint, payload, subject_user_id, request_type
              FROM attendance_request_calculation_snapshots
              WHERE org_id = r.org_id AND request_id = r.id ORDER BY version DESC LIMIT 1) s ON true
          WHERE r.org_id = $1 AND r.id = ANY($2::uuid[]) AND r.status = 'pending' AND a.status = 'pending'
            AND s.payload->>'schemaVersion' = '2' AND s.subject_user_id = r.user_id
            AND s.request_type = r.request_type`, [orgId, ids])
      const original = new Map(items.map(item => [item.id, item]))
      const contexts = new Map(rows.filter(row => original.has(row.id)
        && fingerprintForRow(original.get(row.id)) === row.payload_fingerprint
        && Number.isSafeInteger(Number(row.approval_version))
        && Number(row.approval_version) >= 0 && Number.isSafeInteger(Number(row.snapshot_version))
        && Number(row.snapshot_version) >= 1 && typeof row.current_node_key === 'string'
        && row.current_node_key.length > 0 && /^[0-9a-f]{64}$/.test(row.payload_fingerprint))
        .map(row => [row.id, {
          schemaVersion: 1, requestId: row.id, approvalInstanceId: row.approval_instance_id,
          expectedApprovalVersion: Number(row.approval_version), expectedApprovalNode: row.current_node_key,
          expectedSnapshotVersion: Number(row.snapshot_version), expectedSnapshotFingerprint: row.payload_fingerprint,
        }]))
      return items.map(item => contexts.has(item.id) ? { ...item, decisionContext: contexts.get(item.id) } : item)
    },
    decisionMeta(body) {
      if (body.expectedSnapshotVersion === undefined && body.expectedSnapshotFingerprint === undefined) return body.metadata ?? null
      if (body.expectedSnapshotVersion === undefined || body.expectedSnapshotFingerprint === undefined) {
        fail(400, 'ATTENDANCE_CORRECTION_DECISION_CONTEXT_REQUIRED')
      }
      return { ...(body.metadata ?? {}), correctionRequestSnapshot: {
        version: body.expectedSnapshotVersion, fingerprint: body.expectedSnapshotFingerprint,
      } }
    },
    read: (trx, subject) => call('readTargets', trx, subject),
    async freeze(trx, body, existing, draft, subject, operation) {
      const value = body.correctionTargets === undefined ? existing?.correctionTargets : body.correctionTargets
      if (value === undefined) return null
      if (!TYPES.includes(draft.requestType)) fail(422, 'ATTENDANCE_CORRECTION_REQUEST_TYPE_INVALID')
      return call('freezeTargets', trx, { ...subject, workDate: draft.workDate,
        requestedInAt: draft.requestedInAt, requestedOutAt: draft.requestedOutAt }, value, operation)
    },
    assertExecution(draft, operation) {
      if (draft.metadata?.correctionTargets === undefined) return
      if (!operation?.operationId) fail(400, 'ATTENDANCE_CORRECTION_OPERATION_REQUIRED')
      if (!['shadow', 'authoritative'].includes(operation.acceptedWritePosture)) {
        fail(422, 'ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
      }
    },
    validate: (trx, identity, operation) => call('validatePending', trx, identity, operation),
    append: (trx, identity, operation) => call('appendApproved', trx, identity, operation),
  }
}
module.exports = { createAttendanceApprovedCorrectionTargetsV1 }
