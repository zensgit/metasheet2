/**
 * Registry of every writer of a privilege-classifier input and of its cascade parents.
 *
 * The registry is the closed world of the static write scan (`tests/unit/authorization-input-
 * writers.guard.test.ts`): for production source and the repository's plugins, the scan's per-file,
 * per-table, per-verb literal write counts must equal the sums registered here; every dynamic write
 * target must be an exemption with a reachable table set that excludes the inputs and their
 * cascade parents; migrations that write an input are frozen by path; script trees are classified
 * by path pattern. Each entry carries a ratchet: `pending` means the writer is registered but does
 * not yet run inside a contract transaction; `converted` means its enclosing function takes the
 * branded transaction and every registered statement is issued on it, which the guard checks on
 * the syntax tree. A status only moves from `pending` to `converted` together with the regression
 * that proves the conversion.
 *
 * Classes: `U+` user-level write that may raise the written user's class; `U0` user-level write
 * that cannot; `U-` user-level write that only lowers; `W+`/`W0` role content write that may or may
 * not add a class-raising code (decided under the role row lock); `X` cascade parent delete; `B`
 * birth (user row and its inputs created in one transaction); `B0` birth of a user row only, with
 * a literal `'user'` role and no admin or permission column; `D` dynamic target; `P` content write
 * on a cascade parent that is not a delete; `C` permission catalogue insert that grants nothing.
 *
 * Paths are relative to the repository root.
 */
import type { AuthorizationInputIntent } from './authorization-input-lock'

export type AuthorizationInputWriteVerb = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'MERGE' | 'COPY'

export type AuthorizationInputWriterClass = 'U+' | 'U0' | 'U-' | 'W+' | 'W0' | 'X' | 'B' | 'B0' | 'D' | 'P' | 'C'

export type AuthorizationInputWriterStatus = 'pending' | 'converted'

export type AuthorizationInputWriterStatement = Readonly<{ table: string; verb: AuthorizationInputWriteVerb; count: number }>

/**
 * How a write target that cannot be read is written. The first four forms are found by the write
 * scan in every tree. The last two are found by the migration judgment only: a table argument of a
 * migration helper that is neither a literal nor a constant of its file, and a dynamically executed
 * statement that is not one literal.
 */
export type AuthorizationInputDynamicForm = 'template_substitution' | 'concatenation' | 'query_builder_non_literal' | 'users_update_dynamic_set' | 'helper_table_argument' | 'dynamic_statement'

export type AuthorizationInputWriterEntry = Readonly<{
  id: string
  file: string
  /** The function that issues the statements; `callback:<callee>` names a callback passed to that callee. */
  symbol: string
  intent: AuthorizationInputIntent | null
  class: AuthorizationInputWriterClass
  statements: readonly AuthorizationInputWriterStatement[]
  status: AuthorizationInputWriterStatus
  slice: string
  /** `D` entries: the dynamic form and the number of sites it stands for. */
  dynamic?: Readonly<{ form: AuthorizationInputDynamicForm; count: number }>
}>

const SRC = 'packages/core-backend/src'

const st = (table: string, verb: AuthorizationInputWriteVerb, count = 1): AuthorizationInputWriterStatement => Object.freeze({ table, verb, count })

function entry(fields: Omit<AuthorizationInputWriterEntry, 'status'> & { status?: AuthorizationInputWriterStatus }): AuthorizationInputWriterEntry {
  return Object.freeze({ status: 'pending', ...fields, statements: Object.freeze(fields.statements.map((s) => Object.freeze({ ...s }))) })
}

/** Production writers (`packages/core-backend/src`, repository plugins). */
export const AUTHORIZATION_INPUT_WRITERS: readonly AuthorizationInputWriterEntry[] = Object.freeze([
  entry({ id: 'W-01', file: `${SRC}/rbac/role-assignment.ts`, symbol: 'assignUserRoles', intent: 'GRANT_ROLE', class: 'U+', statements: [st('user_roles', 'INSERT')], slice: 'AIS-2a' }),
  entry({ id: 'W-02', file: `${SRC}/rbac/role-assignment.ts`, symbol: 'unassignUserRoles', intent: 'REVOKE_ROLE', class: 'U-', statements: [st('user_roles', 'DELETE')], slice: 'AIS-2a' }),
  entry({ id: 'W-03', file: `${SRC}/rbac/role-assignment.ts`, symbol: 'clearDelegatedAdminScopesWhereNamespaceLost', intent: 'REVOKE_ROLE', class: 'U-', statements: [st('delegated_role_admin_scopes', 'DELETE'), st('delegated_role_admin_member_groups', 'DELETE')], slice: 'AIS-2a' }),
  entry({ id: 'W-04', file: `${SRC}/routes/permissions.ts`, symbol: 'callback:r.post', intent: 'GRANT_DIRECT', class: 'U+', statements: [st('user_permissions', 'INSERT')], slice: 'AIS-2a' }),
  entry({ id: 'W-05', file: `${SRC}/routes/permissions.ts`, symbol: 'callback:r.post', intent: 'REVOKE_DIRECT', class: 'U-', statements: [st('user_permissions', 'DELETE')], slice: 'AIS-2a' }),
  entry({ id: 'W-06', file: `${SRC}/routes/permissions.ts`, symbol: 'callback:r.post', intent: 'GRANT_DIRECT', class: 'U+', statements: [st('user_permissions', 'INSERT')], slice: 'AIS-2a' }),
  entry({ id: 'W-07a', file: `${SRC}/auth/AuthService.ts`, symbol: 'createUserInTransaction', intent: 'BIRTH', class: 'B', statements: [st('user_permissions', 'INSERT')], slice: 'AIS-2a' }),
  entry({ id: 'W-07b', file: `${SRC}/routes/admin-users.ts`, symbol: 'callback:transaction', intent: 'BIRTH', class: 'B', statements: [st('user_permissions', 'INSERT')], slice: 'AIS-2c' }),
  // One statement serves both directions: its `enabled` argument is a runtime boolean, so the same UPDATE is U+ when it is true and U- when it is false.
  entry({ id: 'W-08', file: `${SRC}/routes/admin-users.ts`, symbol: 'syncLegacyAdminProfile', intent: 'SET_ADMIN_PROFILE', class: 'U+', statements: [st('users', 'UPDATE')], slice: 'AIS-2c' }),
  entry({ id: 'W-10', file: `${SRC}/routes/admin-user-batch.ts`, symbol: 'callback:transaction', intent: 'SET_ADMIN_PROFILE', class: 'U+', statements: [st('users', 'UPDATE')], slice: 'AIS-2c' }),
  entry({ id: 'W-11', file: `${SRC}/admin/user-recycle.ts`, symbol: 'applyRecyclePurge', intent: 'PURGE', class: 'U-', statements: [st('user_permissions', 'DELETE'), st('users', 'UPDATE')], slice: 'AIS-2a' }),
  entry({ id: 'W-12', file: `${SRC}/routes/admin-users.ts`, symbol: 'callback:transaction', intent: 'SET_DELEGATED_SCOPE', class: 'U+', statements: [st('delegated_role_admin_scopes', 'INSERT'), st('delegated_role_admin_scopes', 'DELETE')], slice: 'AIS-2c' }),
  entry({ id: 'W-13', file: `${SRC}/routes/admin-users.ts`, symbol: 'callback:transaction', intent: 'SET_DELEGATED_SCOPE', class: 'U+', statements: [st('delegated_role_admin_member_groups', 'INSERT'), st('delegated_role_admin_member_groups', 'DELETE')], slice: 'AIS-2c' }),
  entry({ id: 'W-14', file: `${SRC}/routes/admin-users.ts`, symbol: 'callback:transaction', intent: 'SET_DELEGATED_SCOPE', class: 'U+', statements: [st('delegated_role_admin_scopes', 'DELETE'), st('delegated_role_admin_member_groups', 'DELETE'), st('delegated_role_admin_scopes', 'INSERT'), st('delegated_role_admin_member_groups', 'INSERT')], slice: 'AIS-2c' }),
  entry({ id: 'W-15', file: `${SRC}/rbac/namespace-admission.ts`, symbol: 'grantNamespaceAdmissions', intent: 'SET_ADMISSION', class: 'U0', statements: [st('user_namespace_admissions', 'INSERT')], slice: 'AIS-2a' }),
  entry({ id: 'W-16', file: `${SRC}/rbac/namespace-admission.ts`, symbol: 'writeUserNamespaceAdmission', intent: 'SET_ADMISSION', class: 'U0', statements: [st('user_namespace_admissions', 'INSERT')], slice: 'AIS-2c' }),
  entry({ id: 'W-17', file: `${SRC}/rbac/namespace-admission.ts`, symbol: 'disableNamespaceAdmissionsWithoutRoles', intent: 'SET_ADMISSION', class: 'U0', statements: [st('user_namespace_admissions', 'INSERT')], slice: 'AIS-2a' }),
  entry({ id: 'W-18', file: `${SRC}/directory/directory-sync.ts`, symbol: 'applyDirectoryProjectedMemberGroupGovernanceInTransaction', intent: 'SET_ADMISSION', class: 'U0', statements: [st('user_namespace_admissions', 'INSERT')], slice: 'AIS-2b' }),
  entry({ id: 'W-19', file: `${SRC}/routes/roles.ts`, symbol: 'callback:transaction', intent: 'EDIT_ROLE_CONTENT', class: 'W+', statements: [st('roles', 'INSERT'), st('role_permissions', 'INSERT')], slice: 'AIS-3a' }),
  entry({ id: 'W-20', file: `${SRC}/routes/roles.ts`, symbol: 'callback:transaction', intent: 'EDIT_ROLE_CONTENT', class: 'W+', statements: [st('roles', 'UPDATE', 2), st('role_permissions', 'DELETE'), st('role_permissions', 'INSERT')], slice: 'AIS-3a' }),
  entry({ id: 'W-21', file: `${SRC}/routes/roles.ts`, symbol: 'callback:transaction', intent: 'DELETE_ROLE', class: 'X', statements: [st('role_permissions', 'DELETE'), st('roles', 'DELETE')], slice: 'AIS-3a' }),
  entry({ id: 'W-22', file: `${SRC}/services/PluginRbacProvisioningService.ts`, symbol: 'applyRoleMatrix', intent: 'EDIT_ROLE_CONTENT', class: 'W+', statements: [st('roles', 'INSERT'), st('role_permissions', 'INSERT')], slice: 'AIS-3a' }),
  entry({ id: 'W-23', file: `${SRC}/services/stock-preparation-members.ts`, symbol: 'callback:runLockedWrite', intent: 'EDIT_ROLE_CONTENT', class: 'W+', statements: [st('roles', 'INSERT'), st('roles', 'UPDATE'), st('role_permissions', 'INSERT', 2), st('role_permissions', 'DELETE')], slice: 'AIS-3a' }),
  entry({ id: 'W-24', file: `${SRC}/routes/attendance-admin.ts`, symbol: 'ensureAttendanceRoleTemplates', intent: 'EDIT_ROLE_CONTENT', class: 'W+', statements: [st('role_permissions', 'INSERT')], slice: 'AIS-3a' }),
  entry({ id: 'W-25', file: `${SRC}/routes/admin-routes.ts`, symbol: 'callback:router.put', intent: 'SET_ADMIN_PROFILE', class: 'D', statements: [], dynamic: { form: 'query_builder_non_literal', count: 1 }, slice: 'AIS-2a' }),
  entry({ id: 'X-03', file: `${SRC}/routes/admin-routes.ts`, symbol: 'callback:router.delete', intent: 'PURGE', class: 'D', statements: [], dynamic: { form: 'query_builder_non_literal', count: 1 }, slice: 'AIS-2a' }),
  entry({ id: 'X-02', file: `${SRC}/directory/controlled-handover.ts`, symbol: 'callback:transaction', intent: 'CASCADE_PARENT_DELETE', class: 'X', statements: [st('directory_departments', 'DELETE')], slice: 'AIS-3a' }),
  entry({ id: 'B-01', file: `${SRC}/auth/AuthService.ts`, symbol: 'createUserInTransaction', intent: 'BIRTH', class: 'B', statements: [st('users', 'INSERT')], slice: 'AIS-2a' }),
  entry({ id: 'B-02', file: `${SRC}/auth/dingtalk-oauth.ts`, symbol: 'callback:transaction', intent: null, class: 'B0', statements: [st('users', 'INSERT')], slice: 'none' }),
  entry({ id: 'B-03', file: `${SRC}/directory/directory-sync.ts`, symbol: 'createDirectoryAdmittedUserInTransaction', intent: 'PROJECTION_GRANT', class: 'B', statements: [st('users', 'INSERT')], slice: 'AIS-2b' }),
  entry({ id: 'B-04', file: `${SRC}/routes/admin-users.ts`, symbol: 'callback:transaction', intent: 'BIRTH', class: 'B', statements: [st('users', 'INSERT')], slice: 'AIS-2c' }),
  entry({ id: 'B-05', file: `${SRC}/routes/admin-user-batch.ts`, symbol: 'callback:transaction', intent: 'BIRTH', class: 'B', statements: [st('users', 'INSERT')], slice: 'AIS-2c' }),
  // Permission catalogue inserts: they register codes and grant them to nobody.
  entry({ id: 'C-01', file: `${SRC}/services/PluginRbacProvisioningService.ts`, symbol: 'applyRoleMatrix', intent: null, class: 'C', statements: [st('permissions', 'INSERT')], slice: 'none' }),
  entry({ id: 'C-02', file: `${SRC}/routes/attendance-admin.ts`, symbol: 'ensureAttendanceRoleTemplates', intent: null, class: 'C', statements: [st('permissions', 'INSERT')], slice: 'none' }),
  // Content writes on cascade parents that are not deletes: they cannot remove an input row.
  entry({ id: 'P-01', file: `${SRC}/directory/controlled-handover.ts`, symbol: 'callback:transaction', intent: null, class: 'P', statements: [st('directory_departments', 'INSERT')], slice: 'none' }),
  entry({ id: 'P-02', file: `${SRC}/directory/directory-sync.ts`, symbol: 'callback:transaction', intent: null, class: 'P', statements: [st('directory_departments', 'INSERT'), st('directory_departments', 'UPDATE')], slice: 'none' }),
  entry({ id: 'P-03', file: `${SRC}/directory/directory-sync.ts`, symbol: 'syncProjectedDepartmentMemberGroupsInTransaction', intent: null, class: 'P', statements: [st('platform_member_groups', 'INSERT'), st('platform_member_groups', 'UPDATE')], slice: 'none' }),
  entry({ id: 'P-04', file: `${SRC}/directory/local-directory-org.ts`, symbol: 'callback:withLocalAnchorTransaction', intent: null, class: 'P', statements: [st('directory_departments', 'INSERT'), st('directory_departments', 'UPDATE', 2)], slice: 'none' }),
  entry({ id: 'P-05', file: `${SRC}/routes/admin-users.ts`, symbol: 'callback:r.post', intent: null, class: 'P', statements: [st('platform_member_groups', 'INSERT')], slice: 'none' }),
])

/* ───────────────────────────── late role rows ───────────────────────────── */

/**
 * Callers of the role-membership writer whose plan does not name the role they grant: the role row
 * is not locked by the entry before the admission locks and the user rows, only by the write
 * itself. The set is closed. Once converted, a caller in it must grant only roles that do not raise
 * the class. Every other caller that holds an admission lock or a user row names the granted role
 * in its plan. An entry names a function, and every path through that function is covered by it:
 * `AuthService.insertUserRolesOnce` serves both the sign-in backfill and registration.
 */
export type AuthorizationInputLateRoleRowCaller = Readonly<{
  id: string
  file: string
  /** The function that calls the writer. */
  symbol: string
  callee: 'assignUserRoles'
  roleRows: 'late'
}>

export const AUTHORIZATION_INPUT_LATE_ROLE_ROW_CALLERS: readonly AuthorizationInputLateRoleRowCaller[] = Object.freeze([
  Object.freeze({ id: 'LR-01', file: `${SRC}/auth/AuthService.ts`, symbol: 'insertUserRolesOnce', callee: 'assignUserRoles', roleRows: 'late' } as const),
  Object.freeze({ id: 'LR-02', file: `${SRC}/directory/directory-sync.ts`, symbol: 'applyDirectoryProjectedMemberGroupGovernanceInTransaction', callee: 'assignUserRoles', roleRows: 'late' } as const),
])

/* ───────────────────────────── dynamic targets ───────────────────────────── */

export type AuthorizationInputDynamicExemption = Readonly<{
  id: string
  file: string
  form: AuthorizationInputDynamicForm
  count: number
  /**
   * Every table the dynamic expression can name; must not contain an input or a cascade parent,
   * however the name is spelled. An exemption of a migration names plain tables only: a pattern or
   * a placeholder sets no verdict of a migration aside.
   */
  reachableTables: readonly string[]
  reason: string
}>

const exemption = (fields: AuthorizationInputDynamicExemption): AuthorizationInputDynamicExemption => Object.freeze({ ...fields, reachableTables: Object.freeze([...fields.reachableTables]) })

/**
 * Dynamic write targets in production source, plugins and migrations that cannot be folded to a
 * literal. In a migration outside the pinned historical set, a dynamic target is accepted only when
 * an entry here names its file and form with the exact number of such targets in the file.
 */
export const AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS: readonly AuthorizationInputDynamicExemption[] = Object.freeze([
  exemption({ id: 'DX-01', file: `${SRC}/admin/user-recycle.ts`, form: 'template_substitution', count: 2, reachableTables: ['audit_logs', 'audit_logs_archive'], reason: 'audit table rotation; the table iterates the audit partitions' }),
  exemption({ id: 'DX-02', file: `${SRC}/attendance/w4c0-operation-registry.ts`, form: 'template_substitution', count: 1, reachableTables: ['attendance_result_operation_batches', 'attendance_result_operations'], reason: 'operation registry; the table is one of two operation tables chosen by kind' }),
  // DX-03…05: the reachable set is the configured external data source, which is configuration,
  // not code. The adapters are read-only by default and write only through `assertWritable`.
  exemption({ id: 'DX-03', file: `${SRC}/data-adapters/PostgresAdapter.ts`, form: 'template_substitution', count: 3, reachableTables: ['<external data source tables>'], reason: 'external data source adapter; default read-only and gated by assertWritable' }),
  exemption({ id: 'DX-04', file: `${SRC}/data-adapters/MySQLAdapter.ts`, form: 'template_substitution', count: 3, reachableTables: ['<external data source tables>'], reason: 'external data source adapter on another database engine' }),
  exemption({ id: 'DX-05', file: `${SRC}/data-adapters/MSSQLAdapter.ts`, form: 'template_substitution', count: 3, reachableTables: ['<external data source tables>'], reason: 'external data source adapter on another database engine' }),
  exemption({ id: 'DX-06', file: `${SRC}/multitable/config-restore.ts`, form: 'template_substitution', count: 1, reachableTables: ['meta_fields', 'meta_views', 'meta_sheets'], reason: 'the table comes from an internal entity-type mapping' }),
  exemption({ id: 'DX-07', file: `${SRC}/multitable/meta-revision-retention.ts`, form: 'template_substitution', count: 3, reachableTables: ['meta_record_revisions', 'meta_config_revisions'], reason: 'retention over the two revision tables named by same-file constants passed through a parameter' }),
  exemption({ id: 'DX-08', file: `${SRC}/services/dingtalk-todo-mirror-worker.ts`, form: 'template_substitution', count: 7, reachableTables: ['dingtalk_todo_mirrors'], reason: 'the table name is an imported constant' }),
  exemption({ id: 'DX-09', file: `${SRC}/services/elearning-stats-multitable-projection.ts`, form: 'template_substitution', count: 1, reachableTables: ['elearning_stats_multitable_sheets'], reason: 'the table name is an imported constant' }),
  exemption({ id: 'DX-10', file: 'plugins/plugin-integration-core/lib/db.cjs', form: 'template_substitution', count: 5, reachableTables: ['integration_*'], reason: 'generic helpers that validate the identifier and require the integration_ prefix' }),
  exemption({ id: 'DX-11', file: 'plugins/plugin-integration-core/scripts/run-gip-sqlserver-snapshot-page-sequence-executor.cjs', form: 'template_substitution', count: 1, reachableTables: ['<sqlserver snapshot fixture table>'], reason: 'fixture table on another database engine, named by an imported constant' }),
  exemption({ id: 'DX-12', file: `${SRC}/db/migrations/_patterns.ts`, form: 'query_builder_non_literal', count: 1, reachableTables: ['<migration helper parameter>'], reason: 'migration helper; callers are frozen migrations or pass a non-input table' }),
  exemption({ id: 'DX-13', file: `${SRC}/db/migrations/zzzz20260724120000_create_attendance_shift_segments.ts`, form: 'template_substitution', count: 1, reachableTables: ['attendance_shift_segments'], reason: 'same-file constant passed through sql.table()' }),
  exemption({ id: 'DX-14', file: `${SRC}/db/migrations/zzzz20260804120000_attendance_shift_flex_policy.ts`, form: 'template_substitution', count: 1, reachableTables: ['attendance_shifts'], reason: 'same-file constant passed through sql.table()' }),
])

/**
 * Two table allowlists in one route module are pinned item for item until that route's writer is
 * converted: any addition or removal is a guard failure.
 */
export const AUTHORIZATION_INPUT_TABLE_ALLOWLIST_RATCHET = Object.freeze({
  file: `${SRC}/routes/admin-routes.ts`,
  identifier: 'validTables',
  occurrences: 2,
  items: Object.freeze([
    'users', 'cells', 'formulas', 'tables', 'data_sources',
    'snapshots', 'snapshot_items', 'protection_rules', 'views',
    'view_states', 'table_rows', 'event_subscriptions',
  ]),
  status: 'pending' as AuthorizationInputWriterStatus,
})

/* ───────────────────────────── migrations ───────────────────────────── */

const MIG = `${SRC}/db/migrations`

/**
 * Applied migrations that write an input table or a cascade parent, frozen by path. The guard pins
 * this list's length and the timestamp ceiling of its entries, so the list cannot absorb a later
 * migration. A migration outside this list that writes an input table must contain the bounded try
 * form of the exclusive world lock inside a statement literal, and every one of its writes must be
 * judged `safe` by the rules below: a write that raises a class and a write the rules cannot read
 * are both failures.
 */
export const AUTHORIZATION_INPUT_FROZEN_MIGRATIONS: readonly string[] = Object.freeze([
  'packages/core-backend/migrations/054_create_users_table.sql',
  `${MIG}/20250924190000_create_rbac_tables.ts`,
  `${MIG}/zzzz20260117090000_add_attendance_permissions.ts`,
  `${MIG}/zzzz20260208100000_create_roles_table.ts`,
  `${MIG}/zzzz20260318110000_add_multitable_bases_and_permissions.ts`,
  `${MIG}/zzzz20260320150000_add_spreadsheet_permissions_and_cell_versions.ts`,
  `${MIG}/zzzz20260320163000_add_comment_permissions.ts`,
  `${MIG}/zzzz20260406113000_add_multitable_share_permission.ts`,
  `${MIG}/zzzz20260411120000_create_user_namespace_admissions.ts`,
  `${MIG}/zzzz20260515130000_add_jump_action_to_approval_records.ts`,
  `${MIG}/zzzz20260630090000_add_approvals_analytics_permission.ts`,
  `${MIG}/zzzz20260702110000_add_approval_reassign_and_admin_scopes.ts`,
  `${MIG}/zzzz20260824121000_add_elearning_permissions.ts`,
  `${MIG}/zzzz20260826140000_add_elearning_role_templates.ts`,
  `${MIG}/zzzz20260830100000_add_stock_prep_permissions.ts`,
  `${MIG}/zzzz20260830160000_add_multitable_manage_schema_permission.ts`,
  `${MIG}/zzzz20260915121000_add_multitable_submit_approval_permission.ts`,
  `${MIG}/zzzz20260920130000_add_approval_product_permissions.ts`,
  `${MIG}/zzzz20260926120100_add_task_permissions.ts`,
  `${MIG}/zzzz20260927120000_update_stock_prep_admin_permission_description.ts`,
  `${MIG}/zzzz20261008120000_add_stock_prep_pull_permission.ts`,
  `${MIG}/zzzz20261009120000_update_stock_prep_admin_permission_description_project_sheets.ts`,
  `${MIG}/zzzz20261010120000_add_approval_write_act_template_manage_permissions.ts`,
  `${MIG}/zzzz20261010124500_seed_stock_prep_role_templates.ts`,
  `${MIG}/zzzz20261012090000_rename_stock_prep_frontline_display_name.ts`,
])

/** The statement form a new migration must contain before it writes an input table (bounded try, never a blocking request). */
export const AUTHORIZATION_INPUT_MIGRATION_LOCK_FORM = 'pg_try_advisory_xact_lock(20261106, 1)'

/**
 * Marks that must accompany the try form inside the same statement literal: a retry loop that
 * sleeps between tries and raises the lock-not-available SQLSTATE once its budget is spent.
 */
export const AUTHORIZATION_INPUT_MIGRATION_LOCK_BLOCK_MARKS: readonly string[] = Object.freeze(['LOOP', 'pg_sleep', 'RAISE', '55P03'])

/**
 * How a migration statement that touches an input table is judged. The judgment is total and its
 * default is `unreadable`: a statement kind, a table and verb, a statement form or an operand that
 * these tables do not name is never `safe`.
 */
export type AuthorizationInputMigrationVerdict = 'safe' | 'raising' | 'unreadable'

/**
 * `by_column`: decided by the values written to the judged columns. `forbidden`: the table is not
 * written by a migration at all, whichever the verb.
 */
export type AuthorizationInputMigrationTableRule = AuthorizationInputMigrationVerdict | 'by_column' | 'forbidden'

const LOWERING_ONLY = Object.freeze({ DELETE: 'safe', TRUNCATE: 'safe' } as const)
const NO_MIGRATION_WRITE = Object.freeze({ INSERT: 'forbidden', UPDATE: 'forbidden', DELETE: 'forbidden', TRUNCATE: 'forbidden', MERGE: 'forbidden', COPY: 'forbidden' } as const)

/** Table and verb to rule, for every input table. A verb that is not listed is `unreadable`. */
export const AUTHORIZATION_INPUT_MIGRATION_TABLE_RULES: Readonly<Record<string, Readonly<Partial<Record<AuthorizationInputWriteVerb, AuthorizationInputMigrationTableRule>>>>> = Object.freeze({
  users: Object.freeze({ INSERT: 'by_column', UPDATE: 'by_column', ...LOWERING_ONLY }),
  // Memberships change through the contract entry or the maintenance tool: whether a membership
  // raises a class depends on what the role holds when the statement runs, and a removal has
  // consequences a statement cannot show.
  user_roles: NO_MIGRATION_WRITE,
  user_permissions: Object.freeze({ INSERT: 'by_column', UPDATE: 'by_column', ...LOWERING_ONLY }),
  role_permissions: Object.freeze({ INSERT: 'by_column', UPDATE: 'by_column', ...LOWERING_ONLY }),
  user_namespace_admissions: Object.freeze({ INSERT: 'safe', UPDATE: 'safe', ...LOWERING_ONLY }),
  delegated_role_admin_scopes: Object.freeze({ INSERT: 'raising', UPDATE: 'raising', ...LOWERING_ONLY }),
  delegated_role_admin_member_groups: Object.freeze({ INSERT: 'raising', UPDATE: 'raising', ...LOWERING_ONLY }),
})

/**
 * How a judged column is read. `permission_code` and `role_id` go through the class predicates;
 * `false_only` accepts the keyword FALSE alone; `permission_array` is a JSON array of codes;
 * `never_in_set` is unreadable whenever an UPDATE or an upsert action assigns it.
 */
export type AuthorizationInputMigrationColumnRule = 'permission_code' | 'role_id' | 'false_only' | 'permission_array' | 'never_in_set'

export const AUTHORIZATION_INPUT_MIGRATION_JUDGED_COLUMNS: Readonly<Record<string, Readonly<Record<string, AuthorizationInputMigrationColumnRule>>>> = Object.freeze({
  role_permissions: Object.freeze({ permission_code: 'permission_code', role_id: 'never_in_set' }),
  user_permissions: Object.freeze({ permission_code: 'permission_code', user_id: 'never_in_set' }),
  users: Object.freeze({ role: 'role_id', is_admin: 'false_only', permissions: 'permission_array', id: 'never_in_set' }),
})

/** Columns the classifier reads; `'*'` is the whole table. Schema changes that touch one are `unreadable`. */
export const AUTHORIZATION_INPUT_MIGRATION_SENSITIVE_COLUMNS: Readonly<Record<string, readonly string[] | '*'>> = Object.freeze({
  users: Object.freeze(['role', 'is_admin', 'permissions']),
  user_roles: Object.freeze(['user_id', 'role_id']),
  user_permissions: Object.freeze(['user_id', 'permission_code']),
  role_permissions: Object.freeze(['role_id', 'permission_code']),
  user_namespace_admissions: Object.freeze([]),
  delegated_role_admin_scopes: '*',
  delegated_role_admin_member_groups: '*',
})

/** Key columns of the cascade parents that a foreign key of an input table may reference. */
export const AUTHORIZATION_INPUT_MIGRATION_PARENT_KEY_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  roles: Object.freeze(['id']),
  permissions: Object.freeze(['code']),
  directory_departments: Object.freeze(['id']),
  platform_member_groups: Object.freeze(['id']),
})

/**
 * The exported functions of the migration helper module with their parameter names in order. A
 * call of one of them is judged as the statement it issues; the guard pins this map to the helper
 * module's exports.
 */
export const AUTHORIZATION_INPUT_MIGRATION_HELPER_MODULE = `${MIG}/_patterns.ts`
export const AUTHORIZATION_INPUT_MIGRATION_HELPERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  checkColumnExists: Object.freeze(['db', 'tableName', 'columnName']),
  checkTableExists: Object.freeze(['db', 'tableName']),
  addColumnIfNotExists: Object.freeze(['db', 'tableName', 'columnName', 'columnType', 'options']),
  dropColumnIfExists: Object.freeze(['db', 'tableName', 'columnName']),
  createIndexIfNotExists: Object.freeze(['db', 'indexName', 'tableName', 'columns', 'options']),
  dropIndexIfExists: Object.freeze(['db', 'indexName']),
  renameColumnIfExists: Object.freeze(['db', 'tableName', 'oldColumnName', 'newColumnName']),
  migrateDataSafely: Object.freeze(['db', 'tableName', 'transformFn', 'options']),
  createTableWithDefaults: Object.freeze(['db', 'tableName', 'buildColumns', 'options']),
  createUpdatedAtTrigger: Object.freeze(['db', 'tableName']),
  addForeignKeyIfNotExists: Object.freeze(['db', 'constraintName', 'tableName', 'columnName', 'refTable', 'refColumn', 'options']),
})

/* ───────────────────────────── scripts and workflows ───────────────────────────── */

export type AuthorizationInputScriptClass = 'FIXTURE' | 'BOOTSTRAP' | 'TOOL' | 'OPS_MJS'

export type AuthorizationInputScriptClassEntry = Readonly<{
  id: string
  class: AuthorizationInputScriptClass
  /** Path prefixes or exact paths, relative to the repository root. */
  paths: readonly string[]
  /** Verbs the class may issue; omitted means any. */
  verbs?: readonly AuthorizationInputWriteVerb[]
  /** `OPS_MJS` and `TOOL`: whether the script already satisfies its class contract. */
  status?: AuthorizationInputWriterStatus
}>

/**
 * Script trees are classified by path. Fixtures, smoke runs and clean-ups run only against test
 * environments; bootstraps write births into an empty system (their birth statement may carry an
 * upsert action so a re-run is idempotent, and no other UPDATE); tools are production-capable and,
 * when they write an input table, must use the contract entry or contain the migration lock form;
 * the `.mjs` tool class must prove that no user's class changes across its apply step.
 */
export const AUTHORIZATION_INPUT_SCRIPT_CLASSES: readonly AuthorizationInputScriptClassEntry[] = Object.freeze([
  Object.freeze({
    id: 'SCRIPT-FIXTURE',
    class: 'FIXTURE' as const,
    paths: Object.freeze([
      'scripts/ops/staging-',
      'scripts/attendance/acceptance/',
      'scripts/ops/readonly-inventory-20260916/',
      'scripts/ops/multitable-l1-battery.mjs',
      'scripts/ops/create-l1-battery-admin-on-staging.sh',
      'scripts/ops/dingtalk-lifecycle-staging-canary-remote.sh',
      'scripts/ops/attendance-staging-window-runner-remote.sh',
      'scripts/ops/stock-preparation-synth-large-bom.mjs',
      'scripts/ops/run-sealed-export-s2-sqlserver-evidence.cjs',
      'packages/core-backend/scripts/verify-',
      'packages/core-backend/scripts/cleanup-attendance-test-users.mjs',
    ]),
  }),
  Object.freeze({
    id: 'SCRIPT-BOOTSTRAP',
    class: 'BOOTSTRAP' as const,
    paths: Object.freeze(['packages/core-backend/scripts/seed-rbac.ts', 'scripts/ops/attendance-onprem-bootstrap-admin.sh', 'scripts/ops/multitable-onprem-bootstrap-admin.ps1']),
    verbs: Object.freeze(['INSERT' as const]),
  }),
  Object.freeze({
    id: 'SCRIPT-TOOL-DINGTALK-SECRETS',
    class: 'TOOL' as const,
    paths: Object.freeze(['packages/core-backend/scripts/encrypt-dingtalk-integration-secrets.ts']),
  }),
  Object.freeze({
    id: 'SCRIPT-OPS-MJS-STOCK-PREP-OPERATOR-ROLE',
    class: 'OPS_MJS' as const,
    paths: Object.freeze(['scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs']),
    status: 'pending' as const,
  }),
])

/** Dynamic write targets in script trees outside the fixture class. */
export const AUTHORIZATION_INPUT_SCRIPT_DYNAMIC_EXEMPTIONS: readonly AuthorizationInputDynamicExemption[] = Object.freeze([
  exemption({ id: 'SDX-01', file: 'packages/core-backend/scripts/encrypt-dingtalk-integration-secrets.ts', form: 'template_substitution', count: 1, reachableTables: ['directory_integrations', 'attendance_integrations'], reason: 'secret re-encryption over the two integration tables' }),
])

/** Workflow files whose shell steps write an input table (test fixtures). */
export const AUTHORIZATION_INPUT_WORKFLOW_FIXTURES: readonly Readonly<{ file: string; statements: readonly AuthorizationInputWriterStatement[] }>[] = Object.freeze([
  Object.freeze({ file: '.github/workflows/yjs-staging-validation.yml', statements: Object.freeze([st('roles', 'INSERT'), st('user_roles', 'INSERT')]) }),
])

/* ───────────────────────────── derived views ───────────────────────────── */

/** `file|table|verb` → registered count over the production writers. */
export function registeredWriteCounts(): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const writer of AUTHORIZATION_INPUT_WRITERS) {
    for (const statement of writer.statements) {
      const key = `${writer.file}|${statement.table}|${statement.verb}`
      counts.set(key, (counts.get(key) ?? 0) + statement.count)
    }
  }
  return counts
}

/** Whether any convertible writer entry is still `pending` (while one is, the contract's prerequisite literal stays `false`). */
export function hasPendingWriters(): boolean {
  return AUTHORIZATION_INPUT_WRITERS.some((writer) => writer.status === 'pending' && writer.class !== 'B0' && writer.class !== 'C' && writer.class !== 'P')
}
