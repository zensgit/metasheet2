import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createAttendanceApprovedCorrectionTargetsV1 } = require('../../../../plugins/plugin-attendance/lib/attendance-approved-correction-targets.cjs')
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
describe('approved correction A plugin contract', () => {
  it('preserves absent legacy metadata and refuses missing/legacy explicit execution', () => {
    const api = createAttendanceApprovedCorrectionTargetsV1(null, HttpError)
    expect(api.decisionMeta({})).toBeNull()
    expect(api.decisionMeta({ metadata: { reasonCode: 'legacy' } })).toEqual({ reasonCode: 'legacy' })
    expect(() => api.assertExecution({ metadata: {} }, {})).not.toThrow()
    expect(() => api.assertExecution({ metadata: { correctionTargets: {} } }, {}))
      .toThrow('ATTENDANCE_CORRECTION_OPERATION_REQUIRED')
    expect(() => api.assertExecution({ metadata: { correctionTargets: {} } },
      { operationId: 'stable', acceptedWritePosture: 'legacy_projection_only' }))
      .toThrow('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
    expect(api.decisionMeta({ expectedSnapshotVersion: 3, expectedSnapshotFingerprint: 'f'.repeat(64) }))
      .toEqual({ correctionRequestSnapshot: { version: 3, fingerprint: 'f'.repeat(64) } })
    expect(() => api.decisionMeta({ expectedSnapshotVersion: 3 }))
      .toThrow('ATTENDANCE_CORRECTION_DECISION_CONTEXT_REQUIRED')
  })
  it('attaches OCC only to the exact already-authorized displayed v2 pending payload', async () => {
    const api = createAttendanceApprovedCorrectionTargetsV1(null, HttpError)
    const item = { id: 'request', org_id: 'org', status: 'pending', metadata: { correctionTargets: {} } }
    const row = { id: 'request', approval_instance_id: 'approval', approval_version: 2, current_node_key: 'attendance_request_step_1',
      snapshot_version: 4, payload_fingerprint: 'f'.repeat(64) }
    const query = async () => [row]
    expect(await api.enrichDecisionContexts({ query }, 'org', [item], () => 'f'.repeat(64))).toEqual([{
      ...item, decisionContext: { schemaVersion: 1, requestId: 'request', approvalInstanceId: 'approval',
        expectedApprovalVersion: 2, expectedApprovalNode: 'attendance_request_step_1',
        expectedSnapshotVersion: 4, expectedSnapshotFingerprint: 'f'.repeat(64) },
    }])
    expect(await api.enrichDecisionContexts({ query }, 'org', [item], () => 'e'.repeat(64))).toEqual([item])
    expect(await api.enrichDecisionContexts({ query: async () => [{ ...row, current_node_key: null }] },
      'org', [item], () => 'f'.repeat(64))).toEqual([item])
    const noQuery = { query: async () => { throw new Error('LEGACY_OR_FOREIGN_MUST_NOT_QUERY') } }
    expect(await api.enrichDecisionContexts(noQuery, 'foreign', [item], () => '')).toEqual([item])
    const legacy = { ...item, metadata: {} }
    expect(await api.enrichDecisionContexts(noQuery, 'org', [legacy], () => '')).toEqual([legacy])
  })
})
