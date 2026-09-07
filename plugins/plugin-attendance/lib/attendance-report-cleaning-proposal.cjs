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

module.exports = {
  buildAttendanceCleaningProposal,
  buildAttendanceCleaningProposalCleanup,
  buildAttendanceCleaningProposalDigest,
  normalizeAttendanceMultitableCleaningPolicy,
}
