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
//   - "w4_canonical":   the nine new W4C-0 durable-storage tables (Stage A). DML against these is
//                       allowed ONLY from inside the canonical adapter path prefix
//                       (packages/core-backend/src/attendance/w4c0-*.ts or the W4C-0 migration
//                       file itself); a hit from any other path is a hard failure
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
})

// Buckets whose DML sites require an individual curated P0x (or later-slice) debt-ID match.
const TRACKED_BUCKETS = Object.freeze(['business', 'schedule_fact', 'shared_hook'])

// Buckets allowlisted purely by table membership (no per-site debt ID required).
const BUCKET_ALLOWLISTED_BUCKETS = Object.freeze(['operational', 'reference'])

// Canonical-boundary path prefixes: DML against a w4_canonical-bucket table is legal only when
// the scanned file's repo-relative path starts with one of these. Anything else is a hard fail.
const W4_CANONICAL_PATH_PREFIXES = Object.freeze([
  'packages/core-backend/src/attendance/w4c0-',
  'packages/core-backend/src/db/migrations/zzzz20260725120000_w4c0_',
])

function classifyTable(tableName) {
  return TABLE_BUCKETS[tableName] || null
}

module.exports = {
  TABLE_BUCKETS,
  TRACKED_BUCKETS,
  BUCKET_ALLOWLISTED_BUCKETS,
  W4_CANONICAL_PATH_PREFIXES,
  classifyTable,
}
