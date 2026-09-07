const crypto = require('node:crypto')

const MAX_REASON_LENGTH = 500

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
  // RFC 4122 URL namespace; the versioned name binds the fresh W4 operation to
  // the normalized proposal, independently of record CAS version/custom columns.
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')
  const bytes = crypto.createHash('sha1').update(namespace)
    .update(`urn:metasheet:attendance-cleaning:v1:${proposalDigest}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
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

module.exports = {
  buildAttendanceCleaningProposal,
  buildAttendanceCleaningProposalCleanup,
  buildAttendanceCleaningProposalDigest,
  buildAttendanceCleaningOperationIdentity,
  normalizeAttendanceMultitableCleaningPolicy,
}
