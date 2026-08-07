/**
 * Attendance Windows-native QA v2 — synthetic identity INPUTS (static, no secrets, no minted ids).
 *
 * Draft/HOLD. Synthetic data only. No deployment/staging authorization.
 * Pinned product SOURCE_SHA: 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b (unchanged by QA tooling).
 *
 * ── What lives here vs. what is minted at runtime (owner gate 1) ──────────────────────────────
 * `POST /api/admin/users` (packages/core-backend/src/routes/admin-users.ts:3446) mints the user id
 * with `crypto.randomUUID()` and does NOT accept a caller-specified id. "fixed synthetic UUIDs" and
 * "create via the product path" are therefore mutually exclusive for USERS. So this file holds only
 * the deterministic INPUTS (email/username/name + the permissions the operator must grant); the
 * provisioner (`provision-synth-directory.mjs`) creates each user through the product creation
 * primitive `AuthService.createUser`, which is called with a freshly minted `crypto.randomUUID()`
 * (the exact mint `AuthService.register` does), and captures the RETURNED id into `qa-identities.json`.
 * Every fixture + harness reads ids ONLY from `qa-identities.json` — never from a literal here.
 *
 * ORGs are different by product design: `packages/core-backend/src/directory/local-directory-org.ts:22`
 * — "Every exported function takes `orgId` as an explicit, required parameter supplied by the caller"
 * — org identity is NEVER minted; there is no product path that could return an org UUID to capture.
 * So org keys are deterministic synthetic UUIDs in a reserved all-zero namespace, supplied to the
 * product anchor `getOrCreateLocalIntegration(orgId)`. The provisioner still writes them THROUGH
 * `qa-identities.json` so gate 1(e) ("no hardcoded ids anywhere") holds literally for readers.
 *
 * ── No secrets here (owner security boundary) ────────────────────────────────────────────────
 * There is NO password or hash in this file or in `qa-identities.json`. The synthetic login
 * password is an operator-set value read at provisioning time from env `QA_SYNTH_PASSWORD` (or the
 * local, gitignored evidence dir). The provisioner hashes it with the product's own bcryptjs and
 * passes it to `createUser`; the plaintext/hash never enter Git.
 */

// Reserved synthetic ORG UUID namespace prefix (deterministic org keys; see header). Version nibble
// '4' (index 14) and variant '8' (index 19) make each pass UUID_SYNTAX (w4c0-identity.ts:118).
// gen_random_uuid() never emits this all-zero prefix, so no real org can collide with it.
export const QA_SYNTH_ORG_UUID_PREFIX = '00000000-0000-4000-8000-'

// Legacy text marker kept ONLY as an extra residue-check safety net; nothing writes it any more.
export const QA_SYNTH_LEGACY_TEXT_PREFIX = 'qa_synth_'

// Deterministic synthetic ORG keys (explicit-by-design; supplied to getOrCreateLocalIntegration).
// `orgB` is the DEDICATED cross-org target for PQA-07's P3 probe: it gets a directory anchor but NO
// user membership (see provision-synth-directory.MEMBERSHIPS), so `u1` is provably NOT a member and
// the cross-org 403 has a valid, turnkey target — the earlier `$orgB = orgLegacy` had `u1` in it.
export const QA_SYNTH_ORGS = Object.freeze({
  orgA: '00000000-0000-4000-8000-0000000000a1',
  orgShadow: '00000000-0000-4000-8000-0000000000a2',
  orgLegacy: '00000000-0000-4000-8000-0000000000a3',
  orgB: '00000000-0000-4000-8000-0000000000a4',
})

// Per-user deterministic INPUTS. `key` is the logical role used by fixtures/harnesses; the actual
// users.id is minted by the product and captured into qa-identities.json under this key.
// LOAD-BEARING: the `qa-synth-…@qa.invalid` email namespace is how residue-check.sql detects
// leftover synthetic USERS (their minted ids are random v4 UUIDs with no prefix). If you rename the
// email pattern here, update residue-check.sql's `email LIKE 'qa-synth-%@qa.invalid'` too, or it
// goes blind to synthetic users.
// `permissionsForOperator` are the strings the operator must grant via the product admin UI for the
// operator-verified HTTP/UI cases — QA tooling does NOT write RBAC state (it is read only by
// `withPermission` at the HTTP layer, the operator-verified surface).
export const QA_SYNTH_USER_INPUTS = Object.freeze({
  admin: Object.freeze({
    email: 'qa-synth-admin@qa.invalid',
    username: 'qa_synth_admin',
    name: 'QA Synth Admin',
    permissionsForOperator: ['attendance:admin'],
  }),
  u1: Object.freeze({
    email: 'qa-synth-u1@qa.invalid',
    username: 'qa_synth_u1',
    name: 'QA Synth U1',
    permissionsForOperator: ['attendance:write'],
  }),
  u2: Object.freeze({
    email: 'qa-synth-u2@qa.invalid',
    username: 'qa_synth_u2',
    name: 'QA Synth U2',
    permissionsForOperator: ['attendance:read'],
  }),
  u3: Object.freeze({
    email: 'qa-synth-u3@qa.invalid',
    username: 'qa_synth_u3',
    name: 'QA Synth U3',
    permissionsForOperator: ['attendance:read'],
  }),
})

// Env var the provisioner reads the operator-set synthetic password from (NEVER a committed value).
export const QA_SYNTH_PASSWORD_ENV = 'QA_SYNTH_PASSWORD'

// The ONLY accepted isolated database name (matches the pinned risk matrix isolatedDatabaseName).
export const QA_SYNTH_DB_NAME = 'metasheet_windows_qa'

// Golden migration-SET file (gate 2): reset-isolated-db.mjs asserts the recreated DB applied EXACTLY
// this set — NOT a count/last-name heuristic (unordered histories can drop a middle migration and
// still match a last name). See expected-migration-set.json for how it was captured.
export const EXPECTED_MIGRATION_SET_FILE = 'expected-migration-set.json'

// Gate 2(c): name-level confirmation of the two migrations that create the append-only tables the
// cases touch. A name check catches "tables missing" directly; a set/count check catches it by luck.
export const EXPECTED_MIGRATION_CONFIRM_NAMES = Object.freeze([
  'zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage',
  'zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union',
])

// Gate 2(d): the deny/append-only TRIGGERS that must exist AND be enabled (tgenabled <> 'D') in the
// recreated DB. A partial re-migrate that leaves these missing would ALSO show zero QA rows and read
// clean — so their presence (plus a live negative-control DELETE that must RAISE) is part of "HEAD
// reached". Names from the pinned migrations (durable_storage.ts:1258-1301, scheduled_run_...:218-368).
export const EXPECTED_DENY_TRIGGERS = Object.freeze([
  // append-only tables — BEFORE UPDATE OR DELETE
  { table: 'attendance_request_calculation_snapshots', trigger: 'trg_attendance_request_calculation_snapshots_deny_mutation' },
  { table: 'attendance_record_calculations', trigger: 'trg_attendance_record_calculations_deny_mutation' },
  { table: 'attendance_record_segments', trigger: 'trg_attendance_record_segments_deny_mutation' },
  { table: 'attendance_import_rollback_closures', trigger: 'trg_attendance_import_rollback_closures_deny_mutation' },
  { table: 'attendance_calculation_rollout_events', trigger: 'trg_attendance_calculation_rollout_events_deny_mutation' },
  // transactional outbox — deny DELETE (dispatcher only UPDATEs delivery_state; DELETE is refused)
  { table: 'attendance_result_event_outbox', trigger: 'trg_areo_deny_delete' },
  // operation registries + rollout state — deny DELETE
  { table: 'attendance_result_operation_batches', trigger: 'trg_attendance_result_operation_batches_deny_delete' },
  { table: 'attendance_result_operations', trigger: 'trg_attendance_result_operations_deny_delete' },
  { table: 'attendance_calculation_rollout_state', trigger: 'trg_acrs_deny_delete' },
  // scheduled-run union — deny DELETE / mutation
  { table: 'attendance_scheduled_runs', trigger: 'trg_asr_deny_delete' },
  { table: 'attendance_scheduled_run_targets', trigger: 'trg_asrt_deny_mutation' },
  { table: 'attendance_scheduled_run_target_outcomes', trigger: 'trg_asrto_deny_mutation' },
])
