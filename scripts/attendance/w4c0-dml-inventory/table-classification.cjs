'use strict'

// #4556 W4C-0 Stage D — closed attendance-owned table -> bucket classification.
//
// Design-lock anchor: docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md
// section 8.4 (source, effect, and result mechanical bypass guard).
//
// Every table this collector can see DML against must appear here. A table that shows up in a
// scanned file but is NOT in this map is "unclassified" and the collector fails CI for it (§8.4:
// "an unclassified table or new write symbol fails CI"). This is intentionally a closed set, not
// a heuristic (`attendance_*` prefix alone is not sufficient — some `attendance_*` tables are
// reference/configuration data, not source/effect/result truth, and must be argued into a bucket
// by a human, not inferred).
//
// Buckets:
//   - "business":      source/effect/result tables that carry calculation truth. Every DML site
//                       against a business-bucket table must resolve to a curated P0x debt entry
//                       (see curated-debt-entries.cjs) or fail as new/unclassified debt.
//   - "schedule_fact":  schedule-fact writers (§8.3: shift-swap/schedule-dispatch/publication/
//                       onboarding-default-assignment) — governs which shift/rotation applies to a
//                       work date, so it is tracked exactly like "business" (curated P0x match
//                       required); kept as a distinct bucket only for reporting clarity.
//   - "shared_hook":    tables shared with non-attendance products (approval_* , leave/comp-time/
//                       overtime ledgers). §8.4 requires an attendance discriminator/hook before
//                       terminal DML; tracked like "business" (curated P0x match required) because
//                       CI cannot globally ban writes to a shared table.
//   - "operational":    import token/preview/job bookkeeping, staging tables, notification
//                       delivery bookkeeping (§8.4/P25). Allowlisted at the bucket level — these
//                       tables cannot mint evidence or claim/complete an operation, so individual
//                       sites are not required to carry a P0x debt ID.
//   - "reference":      org configuration/reference data (shift/rule/holiday/payroll definitions,
//                       group membership *definitions* as opposed to calculation truth). Not part
//                       of the source/effect/result chain at all; allowlisted at the bucket level.
//   - "w4_canonical":   W4 durable source/effect/result and concurrency-authority tables. DML
//                       against these is allowed ONLY from inside the canonical adapter path
//                       prefixes named below; a hit from any other path is a hard failure
//                       (ATTENDANCE_W4C0_DML_OUTSIDE_CANONICAL_BOUNDARY), never silently allowed
//                       by table membership alone.
//
// Adding a table here is a reviewable, explicit act — this file is the single point where a new
// attendance-owned table gets a bucket. It is not auto-derived from a naming convention.

const TABLE_BUCKETS = Object.freeze({
  // --- business: calculation source/effect/result -----------------------------------------
  attendance_events: 'business',
  attendance_records: 'business',
  attendance_requests: 'business',
  attendance_record_result_edits: 'business',
  attendance_import_batches: 'business',
  attendance_import_items: 'business',

  // --- schedule_fact: which shift/rotation governs a work date ----------------------------
  attendance_shift_assignments: 'schedule_fact',
  attendance_rotation_assignments: 'schedule_fact',
  attendance_schedule_dispatch_requests: 'schedule_fact',
  attendance_shift_swap_requests: 'schedule_fact',
  attendance_auto_shift_auto_write_runs: 'schedule_fact',
  attendance_auto_shift_auto_write_run_items: 'schedule_fact',

  // --- shared_hook: non-attendance-owned tables shared across products ---------------------
  approval_instances: 'shared_hook',
  approval_records: 'shared_hook',
  approval_assignments: 'shared_hook',
  attendance_leave_balances: 'shared_hook',
  attendance_leave_balance_events: 'shared_hook',
  attendance_leave_manual_adjustments: 'shared_hook',
  attendance_leave_accrual_runs: 'shared_hook',
  attendance_leave_accrual_run_items: 'shared_hook',

  // --- operational: cannot mint evidence, no per-site debt ID required ---------------------
  attendance_import_tokens: 'operational',
  attendance_import_template_prefs: 'operational',
  attendance_import_jobs: 'operational',
  attendance_import_items_stage: 'operational',
  attendance_import_records_stage: 'operational',
  attendance_notification_deliveries: 'operational',
  attendance_integrations: 'operational',
  attendance_integration_runs: 'operational',
  attendance_unscheduled_reminder_dispatch: 'operational',
  attendance_import_upload_cleanup_commands: 'operational',

  // --- reference: org configuration/reference data, not calculation truth ------------------
  attendance_groups: 'reference',
  attendance_group_members: 'reference',
  attendance_group_managers: 'reference',
  attendance_schedule_groups: 'reference',
  attendance_schedule_group_members: 'reference',
  attendance_holidays: 'reference',
  attendance_rules: 'reference',
  attendance_rule_sets: 'reference',
  attendance_rule_template_library: 'reference',
  attendance_rule_template_versions: 'reference',
  attendance_rotation_rules: 'reference',
  attendance_overtime_rules: 'reference',
  attendance_payroll_cycles: 'reference',
  attendance_payroll_templates: 'reference',
  attendance_payroll_cycle_settlements: 'reference',
  attendance_approval_flows: 'reference',
  attendance_scheduler_scopes: 'reference',
  attendance_shifts: 'reference',
  attendance_shift_segments: 'reference',
  attendance_leave_types: 'reference',
  attendance_calculation_group_memberships: 'reference',
  attendance_calculation_group_membership_operations: 'reference',

  // --- w4_canonical: Stage A durable-storage tables, canonical-boundary-only ---------------
  attendance_record_calculations: 'w4_canonical',
  attendance_record_segments: 'w4_canonical',
  attendance_result_operations: 'w4_canonical',
  attendance_result_operation_batches: 'w4_canonical',
  attendance_result_event_outbox: 'w4_canonical',
  attendance_request_calculation_snapshots: 'w4_canonical',
  attendance_import_rollback_closures: 'w4_canonical',
  attendance_calculation_rollout_state: 'w4_canonical',
  attendance_calculation_rollout_events: 'w4_canonical',

  // --- w4_canonical: W4C-2 P1-2 scheduled-run tables (#4556, PR #4617 amendment §1.1/§1.1.1,
  // RATIFIED bundle A). Written only by the canonical scheduled-run module
  // (packages/core-backend/src/attendance/w4c2-scheduled-run.ts) and the P1-2 migration —
  // both already covered by W4_CANONICAL_PATH_PREFIXES below; adding the tables here closes
  // the classification set the Stage D collector enforces fail-closed. -----------------------
  attendance_scheduled_runs: 'w4_canonical',
  attendance_scheduled_run_targets: 'w4_canonical',
  attendance_scheduled_run_target_outcomes: 'w4_canonical',

  // --- w4_canonical: W4C-3a durable frozen plan, result, and revision authorities ---------
  attendance_import_legacy_execution_plans: 'w4_canonical',
  attendance_import_legacy_execution_plan_chunks: 'w4_canonical',
  attendance_import_legacy_terminal_responses: 'w4_canonical',
  attendance_import_rollback_commands: 'w4_canonical',
  attendance_import_rollback_restore_witnesses: 'w4_canonical',
  attendance_record_target_revisions: 'w4_canonical',
  attendance_group_effect_revisions: 'w4_canonical',
})

// P25 is a classification contract in addition to a table bucket.  In particular, the
// durable legacy plan tables remain inside the canonical path boundary for storage integrity,
// but their values are still transport/compatibility state.  They cannot become calculation,
// source, result, promotion, rollback, authorization, or operation-claim evidence.
const P25_FORBIDDEN_AUTHORITY_ROLES = Object.freeze([
  'calculation_source',
  'calculation_result',
  'business_evidence',
  'business_state',
  'promotion_evidence',
  'rollback_authority',
  'authorization_evidence',
  'operation_claim',
])

const P25_ALLOWED_NON_AUTHORITY_ROLES = Object.freeze([
  'transport',
  'compatibility_transport',
  'audit_attempt',
  'concurrency_control',
  'retryable_job_identity_claim',
  'identity_transport',
  'operational_status',
  'configuration_maintenance',
  'schema_migration',
  'tooling_cleanup',
])

function p25Spec(family, authorityClass, options = {}) {
  return Object.freeze({
    family,
    authorityClass,
    forbiddenAuthorityRoles: P25_FORBIDDEN_AUTHORITY_ROLES,
    reservedIdentityTransport: options.reservedIdentityTransport === true,
    allowedIdentityAdapters: Object.freeze(options.allowedIdentityAdapters || []),
  })
}

// This is the closed P25 import/integration inventory.  A newly in-scope table must be added here
// with a family and authority posture; adding it only to TABLE_BUCKETS would make the generated
// census green while leaving the correctness contract implicit. Notification delivery and W4
// concurrency-revision tables are intentionally outside this set.
const P25_OPERATIONAL_TABLE_SPECS = Object.freeze({
  attendance_import_tokens: p25Spec('import_token', 'operational_transport'),
  attendance_import_jobs: p25Spec('import_job', 'operational_transport', {
    reservedIdentityTransport: true,
    allowedIdentityAdapters: ['enqueue', 'private_worker'],
  }),
  attendance_import_template_prefs: p25Spec('template_preference', 'operational_configuration'),
  attendance_import_items_stage: p25Spec('temporary_staging', 'operational_transport'),
  attendance_import_records_stage: p25Spec('temporary_staging', 'operational_transport'),
  attendance_import_upload_cleanup_commands: p25Spec('upload_lifecycle', 'operational_transport'),
  attendance_integrations: p25Spec('integration_configuration_watermark', 'operational_transport'),
  attendance_integration_runs: p25Spec('integration_audit_attempt', 'audit_only'),

  // These tables are stored inside the canonical boundary, but OD-W4C-56 explicitly keeps the
  // plan/manifest/chunk/terminal values out of W4 authority.  The classification therefore
  // distinguishes storage boundary from semantic authority.
  attendance_import_legacy_execution_plans: p25Spec('durable_legacy_plan', 'compatibility_transport', {
    reservedIdentityTransport: true,
    allowedIdentityAdapters: ['enqueue', 'private_worker'],
  }),
  attendance_import_legacy_execution_plan_chunks: p25Spec('durable_legacy_plan', 'compatibility_transport', {
    reservedIdentityTransport: true,
    allowedIdentityAdapters: ['enqueue', 'private_worker'],
  }),
  attendance_import_legacy_terminal_responses: p25Spec('durable_legacy_terminal', 'compatibility_transport', {
    reservedIdentityTransport: true,
    allowedIdentityAdapters: ['private_worker'],
  }),
})

const P25_IMPORT_INTEGRATION_TABLES = Object.freeze(Object.keys(P25_OPERATIONAL_TABLE_SPECS).sort())

function classifyP25Use({ table, role, adapter = null, dryRun = false }) {
  const spec = P25_OPERATIONAL_TABLE_SPECS[table]
  if (!spec) return { allowed: true, table, role, classification: 'not_p25_operational' }

  if (table === 'attendance_integration_runs' && role === 'business_state') {
    return {
      allowed: false,
      code: dryRun ? 'ATTENDANCE_P25_DRY_RUN_AUDIT_NOT_BUSINESS_STATE' : 'ATTENDANCE_P25_AUDIT_NOT_BUSINESS_STATE',
      table,
      role,
      family: spec.family,
    }
  }

  if (spec.forbiddenAuthorityRoles.includes(role)) {
    return {
      allowed: false,
      code: 'ATTENDANCE_P25_OPERATIONAL_AUTHORITY_FORBIDDEN',
      table,
      role,
      family: spec.family,
    }
  }

  if (
    spec.reservedIdentityTransport &&
    ['transport', 'compatibility_transport', 'retryable_job_identity_claim', 'identity_transport'].includes(role) &&
    (typeof adapter !== 'string' || !spec.allowedIdentityAdapters.includes(adapter))
  ) {
    return {
      allowed: false,
      code: 'ATTENDANCE_P25_NON_WORKER_JOB_IDENTITY_FORBIDDEN',
      table,
      role,
      adapter,
      family: spec.family,
    }
  }

  if (!P25_ALLOWED_NON_AUTHORITY_ROLES.includes(role)) {
    return {
      allowed: false,
      code: 'ATTENDANCE_P25_UNKNOWN_USAGE_ROLE',
      table,
      role,
      family: spec.family,
    }
  }

  return {
    allowed: true,
    table,
    role,
    family: spec.family,
    authorityClass: spec.authorityClass,
  }
}

function assertP25Use(input) {
  const result = classifyP25Use(input)
  if (!result.allowed) {
    const error = new Error(`${result.code}: ${result.table} cannot be used as ${result.role}`)
    error.code = result.code
    throw error
  }
  return result
}

// Buckets whose DML sites require an individual curated P0x (or later-slice) debt-ID match.
const TRACKED_BUCKETS = Object.freeze(['business', 'schedule_fact', 'shared_hook'])

// Buckets allowlisted purely by table membership (no per-site debt ID required).
const BUCKET_ALLOWLISTED_BUCKETS = Object.freeze(['operational', 'reference'])

// Canonical-boundary path prefixes: DML against a w4_canonical-bucket table is legal only when
// the scanned file's repo-relative path starts with one of these. Anything else is a hard fail.
const W4_CANONICAL_PATH_PREFIXES = Object.freeze([
  'packages/core-backend/src/attendance/w4c0-',
  // W4C-2 (#4556 lock §8.1): the canonical live/scheduled write boundary and the durable
  // outbox dispatcher are canonical-boundary modules — they are the ONLY non-w4c0 writers of
  // the w4_canonical tables (shadow calculations/segments, outbox claim/deliver flips).
  'packages/core-backend/src/attendance/w4c2-',
  'packages/core-backend/src/attendance/w4c3a-',
  'packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_',
  // W4C-2 P1-2 (#4556, PR #4617 amendment, RATIFIED): the scheduled-run identity + outbox
  // discriminated-union migration's own backfill DML (UPDATE attendance_result_event_outbox
  // SET identity_kind = 'operation' ...), same precedent as the W4C-0 migration file above.
  'packages/core-backend/src/db/migrations/zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union',
  'packages/core-backend/src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan.ts',
  'packages/core-backend/src/db/migrations/zzzz20260731120000_w4c3a_import_rollback_foundation.ts',
])

function classifyTable(tableName) {
  return TABLE_BUCKETS[tableName] || null
}

module.exports = {
  TABLE_BUCKETS,
  P25_FORBIDDEN_AUTHORITY_ROLES,
  P25_IMPORT_INTEGRATION_TABLES,
  P25_OPERATIONAL_TABLE_SPECS,
  TRACKED_BUCKETS,
  BUCKET_ALLOWLISTED_BUCKETS,
  W4_CANONICAL_PATH_PREFIXES,
  classifyTable,
  classifyP25Use,
  assertP25Use,
}
