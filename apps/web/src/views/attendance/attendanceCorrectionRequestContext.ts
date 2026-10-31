export interface CorrectionRequestRow {
  id: string; status: string; user_id?: string | null; work_date: string; request_type: string
  requested_in_at: string | null; requested_out_at: string | null; reason?: string | null
  metadata?: Record<string, unknown>; decisionContext?: unknown
}
export interface CorrectionDecisionContext {
  schemaVersion: 1; requestId: string; approvalInstanceId: string
  expectedApprovalVersion: number; expectedApprovalNode: string
  expectedSnapshotVersion: number; expectedSnapshotFingerprint: string
}
export function correctionDecisionContext(row: CorrectionRequestRow): CorrectionDecisionContext | null {
  const value = row.decisionContext
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const d = value as Record<string, unknown>
  const keys = ['schemaVersion', 'requestId', 'approvalInstanceId', 'expectedApprovalVersion', 'expectedApprovalNode', 'expectedSnapshotVersion', 'expectedSnapshotFingerprint']
  if (Object.keys(d).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(d, key))
    || d.schemaVersion !== 1 || d.requestId !== row.id || typeof d.approvalInstanceId !== 'string' || !d.approvalInstanceId
    || !Number.isSafeInteger(d.expectedApprovalVersion) || Number(d.expectedApprovalVersion) < 0
    || typeof d.expectedApprovalNode !== 'string' || !d.expectedApprovalNode || d.expectedApprovalNode.length > 128
    || !Number.isSafeInteger(d.expectedSnapshotVersion) || Number(d.expectedSnapshotVersion) < 1
    || typeof d.expectedSnapshotFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(d.expectedSnapshotFingerprint)) return null
  return { schemaVersion: 1, requestId: row.id, approvalInstanceId: d.approvalInstanceId,
    expectedApprovalVersion: Number(d.expectedApprovalVersion), expectedApprovalNode: d.expectedApprovalNode,
    expectedSnapshotVersion: Number(d.expectedSnapshotVersion), expectedSnapshotFingerprint: d.expectedSnapshotFingerprint }
}
export function correctionDecisionBody(context: CorrectionDecisionContext) {
  return { expectedApprovalVersion: context.expectedApprovalVersion, expectedApprovalNode: context.expectedApprovalNode,
    expectedSnapshotVersion: context.expectedSnapshotVersion, expectedSnapshotFingerprint: context.expectedSnapshotFingerprint }
}
