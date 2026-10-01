'use strict'

// Values-free HTTP mapping for typed W4 boundary/registry/command/authorization errors
// (closed codes only; the raw caller value is never echoed). Returns true when handled.
//
// Extracted from plugins/plugin-attendance/index.cjs so the routes and the unit test
// call one function (#5992). AttendanceW4IdentityError (w4c0-identity.ts) carries the
// fail-closed W4C0_* codes and has no httpStatus of its own; without the name below,
// respondIfW4BoundaryError returned false and punch answered 500 INTERNAL_ERROR.

const W4_ERROR_NAMES = new Set([
  'AttendanceW4OperationError',
  'AttendanceW4RegistryError',
  'AttendanceW4CommandError',
  'AttendanceW4AuthorizationError',
  'AttendanceW4LiveScheduledBoundaryError',
  'AttendanceW4RequestBoundaryError',
  'ApprovedLeaveCancellationError',
  'AttendanceW4MergePolicyError',
  // W4C-2 caller cutover (owner ruling 2026-07-28, "(b-narrow)"): the
  // durable run-creation/resume/outcome/finalization machine's own
  // values-free error class (w4c2-scheduled-run.ts).
  'AttendanceW4ScheduledRunIdentityError',
  // W4C-3c manual / recompute / ops_retirement apply modules.
  'AttendanceW4ManualOverrideError',
  'AttendanceW4RecomputeError',
  'AttendanceW4OpsRetirementError',
  'AttendanceW4RecordBoundaryError',
  // Gate D2 (#4556/#4844): the authoritative result-write core's own product-coded errors
  // (VERSION_CONFLICT / REPLAY_CONFLICT / COMPLETED_SHAPE_INVALID / PREIMAGE_INVALID / …)
  // become caller-reachable the moment the live_punch authoritative branch calls the core.
  // Without this entry they would fall through to a raw 500 instead of their own typed
  // status — the exact "no raw SQLSTATE/untyped failure reaches the caller" doctrine this
  // core was built to satisfy.
  'AttendanceW4AuthoritativeCalculationError',
  // #5992: w4c0-identity.ts fail-closed codes (W4C0_DEFAULT_ORG_POSTURE_REJECTED,
  // W4C0_OPERATION_ID_REQUIRED, …). The class sets name and code and has no httpStatus,
  // so the responder below answers 422 with error.code equal to that closed code.
  'AttendanceW4IdentityError',
])

function respondIfW4BoundaryError(res, error) {
  if (!error || typeof error !== 'object' || !W4_ERROR_NAMES.has(error.name)) return false
  const code = typeof error.code === 'string' && error.code ? error.code : 'W4_OPERATION_FAILED'
  const status = Number.isInteger(error.httpStatus) ? error.httpStatus : 422
  res.status(status).json({ ok: false, error: { code, message: code } })
  return true
}

module.exports = {
  W4_ERROR_NAMES,
  respondIfW4BoundaryError,
}
