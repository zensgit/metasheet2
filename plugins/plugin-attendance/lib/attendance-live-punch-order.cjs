'use strict'

// Validate the final daily projection, after append and optional in/out merge.
// Single-sided punches and equal instants retain the existing live contract.
function hasReversedLivePunchOrder(record) {
  if (!record?.first_in_at || !record?.last_out_at) return false
  return new Date(record.last_out_at).getTime() < new Date(record.first_in_at).getTime()
}

module.exports = { hasReversedLivePunchOrder }
