#!/usr/bin/env node
/**
 * stock-preparation-migrate-legacy-operator-role.mjs — move the demo server's legacy floor role
 * `stock-prep-operator` (hyphen) onto the built-in `stock-prep_frontline` (ADR
 * adr-stock-prep-project-sheets-20261008 §11.2-1, §8 step 3; decision register R-39).
 *
 * WHY. The legacy id does not match `stock-prep_…`, so a `stock-prep_admin` (the delegated admin of
 * the `stock-prep` namespace) can neither see nor assign it (`roleIdMatchesNamespace`). The S5a
 * migration (zzzz20261010124500_seed_stock_prep_role_templates) creates `stock-prep_frontline`; this
 * script moves the people and the table grants across. Owner ruling 2026-10-12 (R-39): the two
 * floor roles are merged at the R66 deploy (not at switch-on; R65 = 6d4e9fc38 shipped without this
 * merge), and the built-in role is shown as 「操作人员」 (migration zzzz20261012090000; the id stays `stock-prep_frontline`).
 *
 * OWNER ACTION. Running this script against ANY server database — with or without `--apply` — is an
 * owner action (先批后动). It only ever reads or writes the database named by DATABASE_URL; it makes
 * no network call of its own.
 *
 * WHAT `--apply` DOES, in ONE transaction (all or nothing):
 *   0. only with `--split-extra-codes-to-role <roleId>` (ADR §8 step 3, option ①, automated): THE
 *      SPLIT STEP below runs first, inside the same transaction;
 *   1. every `user_roles` row of `stock-prep-operator` is re-pointed to `stock-prep_frontline`
 *      (one statement: DELETE … RETURNING feeds INSERT … ON CONFLICT DO NOTHING, so the set removed
 *      is exactly the set added — a member already in the target is simply not duplicated);
 *   2. every `spreadsheet_permissions` row whose subject is the ROLE `stock-prep-operator` is
 *      re-pointed to the role `stock-prep_frontline` the same way (same sheet, same level, same
 *      created_at). Rows with a user or member-group subject, and rows of any other role, are never
 *      written;
 *   3. with the separate, exact flag `--delete-empty-old-role` only: if, re-read after the move in the
 *      same transaction, the old role has zero `user_roles` rows, zero role-subject rows in
 *      `spreadsheet_permissions` and in the four tables of UNMOVED_ROLE_SUBJECT_TABLES, zero active
 *      role-typed approval seats, zero role-typed approval seats in any state and zero role-targeted
 *      approval CC records (both matched by role id or display name, as the approval read check
 *      matches them) and zero pending `user_invites` rows naming it, its `role_permissions` rows and
 *      its `roles` row are deleted. Without that flag the (empty) old role stays.
 * Without `--apply` nothing is written: the dry run opens a READ ONLY transaction, prints counts and
 * the verdict `--apply` would reach, and rolls back; it takes no lock.
 * LOCK BOUND: every `--apply` transaction first runs `SET LOCAL lock_timeout = '5s'`, with or without
 * the split, so neither the `FOR UPDATE` row locks of the census nor the split step's table locks
 * wait longer than 5 s for another session (a DingTalk sync or an admin writing `user_roles`). A
 * longer wait fails with SQLSTATE 55P03: exit 1, the transaction is rolled back, nothing is written —
 * rerun later.
 *
 * THE SPLIT STEP (`--split-extra-codes-to-role <roleId>` [`--split-role-name <name>`], exact flags;
 * the name defaults to DEFAULT_SPLIT_ROLE_NAME 「审批与提交」). The EXTRA CODES are the old role's
 * `role_permissions` codes that `stock-prep_frontline` does not hold — read from the database, never
 * assumed (the demo server was recorded holding three platform codes there). The built-in target
 * never receives them (ruled out in fix round 2: a `stock-prep_admin` delegate could hand them out
 * through it). With `--apply`, after `LOCK TABLE user_roles, role_permissions IN SHARE MODE` (bounded
 * by the 5 s `lock_timeout` above; no other session can change a membership or a role's codes until
 * this transaction ends) and before the move:
 *   a. the split role is created with exactly the extra codes — or an existing one is reused, only if
 *      its codes EQUAL the extra codes;
 *   b. every member of the old role is added to it (`ON CONFLICT DO NOTHING`);
 *   c. the extra codes are removed from the old role;
 *   d. the census is read AGAIN and every refusal below is evaluated on it (so the 'old role holds
 *      codes the target lacks' check passes only because the codes were split), plus two post-split
 *      checks (the split role holds exactly the extra codes; every old-role member is in it); any
 *      refusal rolls the split back (savepoint) and nothing is written.
 * Every member's effective permission set is therefore unchanged — proved on a real database against
 * `rbac/service.ts#listUserPermissions` (elearning-role-templates.db.test.ts), members who also hold
 * other roles included.
 * THE SPLIT ROLE ID must be: well-formed exactly as POST /api/roles requires (`isWellFormedNewRoleId`:
 * non-empty, its own trim, no Cc / Cf character) and, stricter, ASCII `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}`;
 * not `admin`, the old or the target id; not a delegated-admin id (`deriveDelegatedAdminNamespace`:
 * no `_admin` suffix); its LEADING segment (the text before the first `_`, or the whole id) must be a
 * platform resource that is NOT admission-controlled (`approvals`, `multitable`, …;
 * `isNamespaceAdmissionControlledResource`), so no `<segment>_admin` role can ever make it assignable
 * by a namespace delegate — `stock-prep_*`, `attendance_*`, `plugin_*`, `operator_*` are refused; and
 * none of its longer candidate namespaces (`roleIdMatchesNamespace` matches the id itself and every
 * prefix ending before a `_`) may be admission-controlled AND either delegated by a role id already in
 * the database (`*_admin` in `roles` / `user_roles` / `role_permissions`) or the namespace of a
 * permission code in the database. RECOMMENDED_SPLIT_ROLE_ID `approvals_operator` passes on a fresh
 * install. The helpers mirror the server's (namespace-admission.ts, role-assignment.ts,
 * routes/roles.ts); tests/unit/stock-prep-operator-merge-parity.test.ts pins them equal.
 * THE SPLIT REFUSES (exit 2, nothing written) when: an extra code is ADMIN-LEVEL
 * (`isAdminLevelPermissionCode`: `<r>:admin`, `<r>:*`, `*:<a>`, `admin:<a>` — a platform
 * administrator handles that by hand); the id falls in such a namespace; an existing split role's
 * codes differ from the extra codes, or `--split-role-name` names it differently; an absent split
 * role id still has leftover `user_roles` / `role_permissions` rows, or another role already carries
 * the split name; an existing split role's display name is RESERVED (see THE SPLIT ROLE NAME); the
 * split role (by id, and by id or display name for approval seats / CC records)
 * is the subject of role-subject grant rows, active role approvals, role-typed approval seats or
 * role-targeted CC records while old-role members not yet in it would be added (they would GAIN them).
 * The dry run prints the split census and the verdict, and writes nothing.
 * THE SPLIT ROLE NAME (`--split-role-name`, refused at parse time before connecting, never echoed)
 * must be non-empty, its own trim, at most SPLIT_ROLE_NAME_MAX printable characters, and not
 * RESERVED: its comparison form (`canonicalRoleName`, a copy of stock-preparation-members.ts
 * `canonicalStockPrepRoleName`: NFKC, spaces / format characters dropped, lower-cased, a trailing
 * 「（内置）」 / "(built-in)" marker dropped) may not be `admin` — a role whose trimmed display name is
 * `admin` makes its members approval administrators (approval-record-link-txn-auth.ts and
 * multitable/automation-approval-template-access.ts test `roles.has('admin')` over role ids AND
 * display names) — nor one of the built-in stock-prep display names (STOCK_PREP_BUILTIN_ROLE_DISPLAY_NAMES,
 * a copy of the server's S8 list, pinned equal by the parity test), so the split role cannot pose as
 * 「操作人员」 / 「一线填写」 or another built-in in 角色管理 and in every appoint list.
 *
 * WHEN `--apply` REFUSES (exit 2, nothing written). These are the ONLY checks. Each compares the two
 * roles, not each member's effective permissions through their other roles, so it can refuse a move
 * that a member's other roles would have made harmless:
 *   - `stock-prep_frontline` does not exist (the S5a migration has not run yet);
 *   - the old role holds permission codes the target role does not, while it still has members (they
 *     would LOSE those codes — e.g. approval codes granted to the old role by hand). The only
 *     supported resolution (ADR §8 step 3, option ①): in 角色管理, create a separate platform role
 *     holding those codes, give it to the same members, then remove the codes from the old role;
 *   - the old role still has members and is named by role-typed approval seats in ANY state
 *     (`approval_assignments`, `assignment_type = 'role'`) or by role-targeted approval CC records
 *     (`approval_records`, `action = 'cc'`, `metadata->>'targetType' = 'role'`), matched by role id
 *     or trimmed display name — the members read those approval instances through the role
 *     (approval-instance-readability.ts `canReadApprovalInstance`, `is_active`-insensitive) and
 *     would LOSE that read access; this script moves neither seats nor CC records;
 *   - the target role holds what the old role does not — permission codes; role-subject rows in
 *     `spreadsheet_permissions` (compared per sheet AND level) or in the four UNMOVED tables; active
 *     role-assigned approval tasks; role-typed approval seats in any state or role-targeted approval
 *     CC records reachable through the target's id / display name but not the old role's — while
 *     old-role members not already in the target would move (they would GAIN all of that). A freshly
 *     seeded `stock-prep_frontline` holds nothing beyond `read` + `operate` and no such row, so this
 *     only fires once the target was widened;
 *   - the old role is the subject of rows in `meta_view_permissions`, `field_permissions`,
 *     `record_permissions` or `meta_history_audit_grants` (role id match) — moving the members would
 *     drop those rows' effect for them;
 *   - the old role has ACTIVE role-assigned approval tasks (role id match) — moving the members would
 *     strand them;
 *   - the target role already has members who are not in the old role while there are table grants
 *     to move — the moved grants would extend to them;
 *   - with `--delete-empty-old-role`: a pending `user_invites` row still names the old role (the
 *     invite list would point at a deleted role), or role-typed approval seats / role-targeted CC
 *     records still name it (they stay after the move; a role re-created later under that id or
 *     display name would read those instances). The dry run prints each count.
 *
 * COUNTED, NOT CHANGED (resolve by hand before `--apply`):
 *   - approval template versions (`approval_template_versions.approval_graph`) and published
 *     definitions (`approval_published_definitions.runtime_graph`) whose graph names the old role
 *     (id or trimmed display name) in exactly these five places: a role approver / handler
 *     (`assigneeType = 'role'` + `assigneeIds`, `assigneeSources[kind = static_role].roleIds`), an
 *     empty-assignee fallback (`emptyAssigneeFallback.roleIds`), a role CC target (`targetType =
 *     'role'` + `targetIds`), or a 提交人自选 role scope (`assigneeSources[kind = requester_choice]
 *     .scope` with `type = 'role'` + `roleIds` — checked at submit against `user_roles` by role id,
 *     ApprovalProductService requester-choice validation, so after the move nobody can be chosen and
 *     submit answers 422). Future instances started from them would still seat, CC or scope the old
 *     role, which has nobody in it after the move. Re-point them in the approval designer;
 *   - approval templates whose visibility scope is role-typed (`approval_templates.visibility_scope`,
 *     `type = 'role'` + `ids`), matched like the server matches it — a user's role ids AND trimmed
 *     display names (automation-approval-template-access.ts `loadApprovalTemplateReader`) — so it
 *     gates 记录送审 and the approval.completed automation creator path: templates visible through the
 *     old role but not through the role(s) the members end up in (LOSS: moved members stop seeing
 *     them, 403 RECORD_APPROVAL_TEMPLATE_FORBIDDEN), and templates visible through the target role —
 *     and, with the split, the split role — but not through the old role (GAIN: moved members newly
 *     see them). Widen or narrow those visibility lists by hand.
 *   Every run prints these counts as census lines; none of them is a refusal.
 * NOT CHECKED, NOT CHANGED:
 *   - the `requester.role` ROUTING predicate of approval graphs (conditions on the requester's
 *     `approval_usable` roles) and any graph shape other than the five above are not read;
 *   - `roles.approval_usable` is PRINTED for the old role, the target and the split role (census
 *     lines `approval_usable — …`), never copied: a split role this script creates gets the column
 *     default (false, migration zzzz20260627150000), and the owner decides whether it should be
 *     usable in requester-role routing;
 *   - pending `user_invites` rows naming the old role are not re-pointed (the membership itself is a
 *     `user_roles` row written when the user is created, and moves like any other). They block only
 *     `--delete-empty-old-role`;
 *   - any other table or setting that refers to a role by id or name is not read — the census is
 *     exactly the tables named above;
 *   - TIMING: a role assignment, a role edit or a grant committed by another session between this
 *     script's census and its move statements (`assignUserRoles` inserts into `user_roles` without
 *     locking the role row) is not seen by the checks above — a small window, but run `--apply` in a
 *     maintenance window with nobody editing roles or approvals.
 *
 * VALUES-FREE OUTPUT: role ids (this file's own literals, and the split role id, which must pass the
 * ASCII shape above), table names, counts, permission codes and namespaces (platform vocabulary), and
 * the split role's display name only when it is the default. Never a user id, a name, a sheet id, a host or a credential. Database errors
 * are reported by their code (SQLSTATE / errno) only, because PostgreSQL error text can quote row
 * values; an unknown argument is reported by position, never echoed. No audit row is written — the
 * printed counts are the record of the run.
 *
 * Usage:
 *   DATABASE_URL=… node scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs            # dry run
 *   DATABASE_URL=… node scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs --apply    # owner action
 *   … --apply --delete-empty-old-role                                                            # owner action
 *   … --split-extra-codes-to-role approvals_operator                                             # dry run of option ①
 *   … --apply --split-extra-codes-to-role approvals_operator [--split-role-name <name>]          # owner action
 *   --root <install root>  load `pg` from <root>/packages/core-backend and, if DATABASE_URL is not
 *                          set, read it from <root>/docker/app.env (never printed)
 *
 * The first line printed on stdout once the arguments and DATABASE_URL are accepted — BEFORE `pg` is
 * loaded or a connection is opened — is `OWNER ACTION (R-39): …`. A run without that line never
 * reached the database (usage error, no DATABASE_URL — or the file was not run as the entry module;
 * see `isEntryPoint`).
 *
 * Exit codes: 0 done (dry run, apply, or nothing to do) · 2 refused · 1 usage or execution failure:
 * an unknown / inexact argument, no DATABASE_URL, `pg` not loadable (MODULE_NOT_FOUND — a wrong
 * `--root`), a database error such as 55P03 (a lock wait over 5 s; rerun later) — each reported by
 * argument position or by code only.
 * Permission caches: the backend caches effective permissions for up to 60 s; a moved member sees
 * the change after that, on page refresh.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const OLD_ROLE_ID = 'stock-prep-operator'
export const TARGET_ROLE_ID = 'stock-prep_frontline'
export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_REFUSED = 2

/** Role-subject tables this script does NOT move. Any row of the old role there blocks --apply. */
export const UNMOVED_ROLE_SUBJECT_TABLES = Object.freeze([
  'meta_view_permissions',
  'field_permissions',
  'record_permissions',
  'meta_history_audit_grants',
])

/** ADR §8 step 3 option ①: the separate platform role that takes the old role's extra codes. */
export const RECOMMENDED_SPLIT_ROLE_ID = 'approvals_operator'
export const DEFAULT_SPLIT_ROLE_NAME = '审批与提交'
export const SPLIT_ROLE_NAME_MAX = 64
/** Stricter than the server's `isWellFormedNewRoleId`, so the id is safe to print. */
const SPLIT_ROLE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

// ── mirrors of the server's role-id / permission-code predicates ─────────────────────────────────
// A plain-node ops script cannot import the backend's TypeScript, so these are copies, pinned equal
// to the originals by packages/core-backend/tests/unit/stock-prep-operator-merge-parity.test.ts.

const PLATFORM_ADMIN_ROLE_ID = 'admin'
const DELEGATED_ADMIN_ROLE_SUFFIX = '_admin'

/** rbac/namespace-admission.ts NON_NAMESPACED_PERMISSION_RESOURCES. */
export const NON_NAMESPACED_PERMISSION_RESOURCES = Object.freeze([
  'admin', 'approvals', 'audit', 'auth', 'cache', 'comments', 'demo', 'events', 'files', 'health', 'meta',
  'metrics', 'multitable', 'notification', 'notifications', 'permission', 'permissions', 'role', 'roles',
  'session', 'sessions', 'snapshot', 'snapshots', 'spreadsheet', 'spreadsheets', 'workflow',
])
const NON_NAMESPACED = new Set(NON_NAMESPACED_PERMISSION_RESOURCES)

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

/** rbac/namespace-admission.ts deriveDelegatedAdminNamespace. */
export function deriveDelegatedAdminNamespace(roleId) {
  const normalizedRoleId = normalizeString(roleId)
  if (!normalizedRoleId || normalizedRoleId === PLATFORM_ADMIN_ROLE_ID) return null
  if (!normalizedRoleId.endsWith(DELEGATED_ADMIN_ROLE_SUFFIX)) return null
  const namespace = normalizedRoleId.slice(0, -DELEGATED_ADMIN_ROLE_SUFFIX.length).trim()
  return namespace || null
}

/** rbac/namespace-admission.ts roleIdMatchesNamespace. */
export function roleIdMatchesNamespace(roleId, namespace) {
  const normalizedRoleId = normalizeString(roleId)
  const normalizedNamespace = normalizeString(namespace)
  if (!normalizedRoleId || !normalizedNamespace) return false
  return normalizedRoleId === normalizedNamespace || normalizedRoleId.startsWith(`${normalizedNamespace}_`)
}

/** rbac/namespace-admission.ts isNamespaceAdmissionControlledResource. */
export function isNamespaceAdmissionControlledResource(resource) {
  const normalizedResource = normalizeString(resource)
  if (!normalizedResource || normalizedResource === '*') return false
  return !NON_NAMESPACED.has(normalizedResource)
}

/** rbac/namespace-admission.ts derivePermissionNamespace. */
export function derivePermissionNamespace(permissionCode) {
  const normalizedCode = normalizeString(permissionCode)
  if (!normalizedCode || normalizedCode === '*:*') return null
  const separatorIndex = normalizedCode.indexOf(':')
  if (separatorIndex <= 0) return null
  const resource = normalizedCode.slice(0, separatorIndex).trim() || null
  return isNamespaceAdmissionControlledResource(resource) ? resource : null
}

/** rbac/role-assignment.ts isAdminLevelPermissionCode. */
export function isAdminLevelPermissionCode(code) {
  const normalized = typeof code === 'string' ? code.trim().toLowerCase() : ''
  const separatorIndex = normalized.indexOf(':')
  if (separatorIndex <= 0) return false
  const resource = normalized.slice(0, separatorIndex).trim()
  const action = normalized.slice(separatorIndex + 1).trim()
  if (resource === '*' || resource === 'admin') return true
  return action === 'admin' || action === '*'
}

/** routes/roles.ts isWellFormedNewRoleId (the POST /api/roles rule). */
export function isWellFormedNewRoleId(id) {
  if (!id || id !== id.trim()) return false
  return !/[\p{Cc}\p{Cf}]/u.test(id)
}

/**
 * Every namespace `roleIdMatchesNamespace(roleId, ns)` is true for: the id itself and each prefix
 * that ends right before a `_`. Shortest first.
 */
export function candidateNamespaces(roleId) {
  const id = normalizeString(roleId)
  const out = []
  for (let index = id.indexOf('_'); index > 0; index = id.indexOf('_', index + 1)) out.push(id.slice(0, index))
  if (id) out.push(id)
  return [...new Set(out)].filter((namespace) => roleIdMatchesNamespace(id, namespace))
}

/**
 * Why `roleId` may not be the split role, judged WITHOUT the database (null = acceptable). Never
 * echoes the id: an argument may be anything.
 */
export function splitRoleIdProblem(roleId) {
  if (typeof roleId !== 'string' || !isWellFormedNewRoleId(roleId)) {
    return 'the split role id must be non-empty, equal to its own trim and free of control / format characters (the POST /api/roles rule)'
  }
  if (!SPLIT_ROLE_ID_SHAPE.test(roleId)) {
    return 'the split role id must be 1-64 ASCII characters [A-Za-z0-9_.-] starting with a letter or digit'
  }
  if (roleId === PLATFORM_ADMIN_ROLE_ID || roleId === OLD_ROLE_ID || roleId === TARGET_ROLE_ID) {
    return `the split role id may not be admin, ${OLD_ROLE_ID} or ${TARGET_ROLE_ID}`
  }
  if (deriveDelegatedAdminNamespace(roleId) !== null) {
    return 'the split role id may not end in _admin (its holders would become delegated admins)'
  }
  const leading = candidateNamespaces(roleId)[0]
  if (isNamespaceAdmissionControlledResource(leading)) {
    return 'the split role id must start with a platform resource that no namespace delegate controls '
      + `(e.g. approvals_…, multitable_…; recommended: ${RECOMMENDED_SPLIT_ROLE_ID}); `
      + 'an id like stock-prep_…, attendance_…, plugin_… or operator_… could be assigned by a namespace delegated admin'
  }
  return null
}

/**
 * services/stock-preparation-members.ts STOCK_PREP_BUILTIN_ROLE_DISPLAY_NAMES (the S8 reserved
 * names), copied; tests/unit/stock-prep-operator-merge-parity.test.ts pins it equal to the server's.
 */
export const STOCK_PREP_BUILTIN_ROLE_DISPLAY_NAMES = Object.freeze([
  '备料主管理员',
  '数据管理员（拉取人员）',
  '开发成员',
  '操作人员',
  '一线填写',
  'Main administrator',
  'Data manager (puller)',
  'Developer',
  'Operator',
  'Floor operator',
])

/** services/stock-preparation-members.ts `canonicalStockPrepRoleName`, copied (parity-pinned). */
export function canonicalRoleName(raw) {
  const folded = raw.normalize('NFKC').replace(/[\p{Z}\p{Cf}\s]+/gu, '').toLowerCase()
  return folded.replace(/[\p{Ps}\p{Pi}]?(?:内置|built-?in)[\p{Pe}\p{Pf}]?$/u, '')
}

const RESERVED_SPLIT_ROLE_NAMES = new Set(STOCK_PREP_BUILTIN_ROLE_DISPLAY_NAMES.map(canonicalRoleName))

/**
 * Why `name` may not be a split role's display name because of WHAT it says (null = acceptable):
 * `admin` in any case / spacing (a role displayed as admin makes its members approval
 * administrators) or a built-in stock-prep display name. Applied to the name this run would give a
 * new split role AND to the name of an existing role it would reuse. Never echoes the name.
 */
export function splitRoleNameReservedProblem(name) {
  const canonical = canonicalRoleName(String(name ?? ''))
  if (canonical === PLATFORM_ADMIN_ROLE_ID) {
    return 'the split role name may not be admin in any case or spacing (a role displayed as admin makes its members approval administrators)'
  }
  if (RESERVED_SPLIT_ROLE_NAMES.has(canonical)) {
    return 'the split role name may not be a built-in stock-prep role name (it would pose as that role in 角色管理 and every appoint list)'
  }
  return null
}

/** Why `name` may not be the split role's display name (null = acceptable). Never echoes the name. */
export function splitRoleNameProblem(name) {
  if (typeof name !== 'string' || name.length === 0 || name !== name.trim()) {
    return 'the split role name must be non-empty and equal to its own trim'
  }
  if ([...name].length > SPLIT_ROLE_NAME_MAX || /[\p{Cc}\p{Cf}]/u.test(name)) {
    return `the split role name must be 1-${SPLIT_ROLE_NAME_MAX} printable characters`
  }
  return splitRoleNameReservedProblem(name)
}

const HELP_TEXT = `stock-preparation-migrate-legacy-operator-role.mjs — move ${OLD_ROLE_ID} onto ${TARGET_ROLE_ID}.

OWNER ACTION: running this against any server database requires the owner's go-ahead (R-39).

Usage:
  node scripts/ops/stock-preparation-migrate-legacy-operator-role.mjs [--apply] [--delete-empty-old-role]
       [--split-extra-codes-to-role <roleId> [--split-role-name <name>]] [--root <install root>]

  (no flag)                 dry run: READ ONLY transaction, counts and verdict only, nothing written
  --apply                   move memberships and role-subject table grants in one transaction
  --delete-empty-old-role   with --apply: also delete ${OLD_ROLE_ID} once nothing names it (members, grant rows,
                            approval seats / CC records, pending invites)
  --split-extra-codes-to-role <roleId>
                            ADR §8 step 3 option ①, in the same transaction BEFORE the move: put the codes
                            ${OLD_ROLE_ID} holds and ${TARGET_ROLE_ID} lacks on the platform role <roleId>
                            (created, or reused only if its codes equal them), give it to every member of
                            ${OLD_ROLE_ID}, remove them from ${OLD_ROLE_ID}. Without --apply: dry run of it.
                            Recommended id: ${RECOMMENDED_SPLIT_ROLE_ID}
  --split-role-name <name>  display name of a split role this run creates (default: ${DEFAULT_SPLIT_ROLE_NAME})
  --root <install root>     load pg from <root>/packages/core-backend; DATABASE_URL fallback from <root>/docker/app.env
  --help                    this text

Reads DATABASE_URL from the environment. Exit: 0 done · 1 usage/execution failure · 2 refused.
`

// The role keys an approval-instance read check matches for a member of role $1 that the same member
// would NOT still hold as a member of role $2: the role id and the role's trimmed display name, as
// `viewerRoles` builds them (approval-instance-readability.ts `viewerRoles`: `user_roles.role_id` and
// `roles.name`, both trimmed), minus the id and name of role $2. Shared by the two statements below.
const ROLE_READ_KEYS = `role_read_keys AS (
  SELECT k.role_key
    FROM (
      SELECT btrim($1::text) AS role_key
      UNION
      SELECT btrim(r.name) FROM roles r WHERE r.id = $1 AND r.name IS NOT NULL
    ) k
   WHERE k.role_key <> ''
     AND k.role_key <> btrim($2::text)
     AND NOT EXISTS (SELECT 1 FROM roles t WHERE t.id = $2 AND btrim(t.name) = k.role_key)
)`

// The keys an approval graph can name role $1 by: its id and its trimmed display name.
const ROLE_KEYS = `role_keys AS (
  SELECT k.role_key
    FROM (
      SELECT btrim($1::text) AS role_key
      UNION
      SELECT btrim(r.name) FROM roles r WHERE r.id = $1 AND r.name IS NOT NULL
    ) k
   WHERE k.role_key <> ''
)`

// Whether the graph in `column` names `k.role_key` in one of exactly FIVE role-reference shapes of the
// approval graph types (types/approval-product.ts): an approval node's legacy `assigneeType = 'role'`
// + `assigneeIds`; an approval / handler node's `assigneeSources[kind = static_role].roleIds`; an
// approval node's `emptyAssigneeFallback.roleIds`; a cc node's `targetType = 'role'` + `targetIds`;
// a 提交人自选 source's `assigneeSources[kind = requester_choice].scope` with `type = 'role'` +
// `roleIds` (the server checks that scope by role id only; the census also counts a display-name
// match — over-counting is the safe side of a census). The `requester.role` routing predicate and any
// other shape are NOT read.
const GRAPH_NAMES_ROLE = (column) => `(
       jsonb_path_exists(${column}, '$.nodes[*].config ? (@.assigneeType == "role").assigneeIds[*] ? (@ == $k)', jsonb_build_object('k', k.role_key))
    OR jsonb_path_exists(${column}, '$.nodes[*].config.assigneeSources[*] ? (@.kind == "static_role").roleIds[*] ? (@ == $k)', jsonb_build_object('k', k.role_key))
    OR jsonb_path_exists(${column}, '$.nodes[*].config.emptyAssigneeFallback.roleIds[*] ? (@ == $k)', jsonb_build_object('k', k.role_key))
    OR jsonb_path_exists(${column}, '$.nodes[*].config ? (@.targetType == "role").targetIds[*] ? (@ == $k)', jsonb_build_object('k', k.role_key))
    OR jsonb_path_exists(${column}, '$.nodes[*].config.assigneeSources[*] ? (@.kind == "requester_choice").scope ? (@.type == "role").roleIds[*] ? (@ == $k)', jsonb_build_object('k', k.role_key))
  )`

// Every statement this script can issue. Parameters: $1 is OLD_ROLE_ID and $2, where present, is
// TARGET_ROLE_ID — except that `unmovedRoleRows` and `activeRoleApprovals` are also run with
// TARGET_ROLE_ID alone as $1, and `approvalRoleSeats` / `approvalRoleCcRecords` with the pair
// reversed ($1 TARGET_ROLE_ID, $2 OLD_ROLE_ID), to count what the target holds (the gains check).
// The split step (only with --split-extra-codes-to-role) also binds the validated split role id, its
// display name and the extra-code array, as each statement's comment says, and runs `oldMembers`,
// `oldSheetGrants`, `unmovedRoleRows` and `activeRoleApprovals` with the split role id as $1 and
// `sharedMembers` with ($1 OLD_ROLE_ID, $2 split role id). `approvalTemplatesVisibleThrough` binds
// four text arrays built from those same role ids and the split role's intended display name.
// `columnExists` binds a literal table and column name; `roleApprovalUsable` binds a text array of
// the old role id, the target id and (with the split) the split role id. Nothing else is ever bound.
export const SQL = Object.freeze({
  begin: 'BEGIN',
  readOnly: 'SET TRANSACTION READ ONLY',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  tableExists: `SELECT count(*)::int AS count
  FROM information_schema.tables
 WHERE table_schema = current_schema()
   AND table_name = $1`,
  columnExists: `SELECT count(*)::int AS count
  FROM information_schema.columns
 WHERE table_schema = current_schema()
   AND table_name = $1
   AND column_name = $2`,
  rolesRead: `SELECT id FROM roles WHERE id IN ($1, $2) ORDER BY id`,
  // $1 text[]: the old role, the target and (with the split) the split role id. Printed, never copied.
  roleApprovalUsable: `SELECT id, approval_usable FROM roles WHERE id = ANY($1::text[]) ORDER BY id`,
  rolesLock: `SELECT id FROM roles WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`,
  oldMembers: `SELECT count(*)::int AS count FROM user_roles WHERE role_id = $1`,
  sharedMembers: `SELECT count(*)::int AS count
  FROM user_roles o
 WHERE o.role_id = $1
   AND EXISTS (SELECT 1 FROM user_roles t WHERE t.role_id = $2 AND t.user_id = o.user_id)`,
  targetOnlyMembers: `SELECT count(*)::int AS count
  FROM user_roles t
 WHERE t.role_id = $2
   AND NOT EXISTS (SELECT 1 FROM user_roles o WHERE o.role_id = $1 AND o.user_id = t.user_id)`,
  oldCodesMissingOnTarget: `SELECT o.permission_code
  FROM role_permissions o
 WHERE o.role_id = $1
   AND NOT EXISTS (SELECT 1 FROM role_permissions t WHERE t.role_id = $2 AND t.permission_code = o.permission_code)
 ORDER BY o.permission_code`,
  oldCodeCount: `SELECT count(*)::int AS count FROM role_permissions WHERE role_id = $1`,
  targetCodesMissingOnOld: `SELECT t.permission_code
  FROM role_permissions t
 WHERE t.role_id = $2
   AND NOT EXISTS (SELECT 1 FROM role_permissions o WHERE o.role_id = $1 AND o.permission_code = t.permission_code)
 ORDER BY t.permission_code`,
  targetSheetGrantsMissingOnOld: `SELECT count(*)::int AS count
  FROM spreadsheet_permissions t
 WHERE t.subject_type = 'role'
   AND t.subject_id = $2
   AND NOT EXISTS (
     SELECT 1 FROM spreadsheet_permissions o
      WHERE o.subject_type = 'role' AND o.subject_id = $1
        AND o.sheet_id = t.sheet_id AND o.perm_code = t.perm_code
   )`,
  pendingOldRoleInvites: `SELECT count(*)::int AS count
  FROM user_invites
 WHERE role_id = $1
   AND status = 'pending'`,
  oldSheetGrants: `SELECT count(*)::int AS count
  FROM spreadsheet_permissions
 WHERE subject_type = 'role'
   AND subject_id = $1`,
  sharedSheetGrants: `SELECT count(*)::int AS count
  FROM spreadsheet_permissions o
 WHERE o.subject_type = 'role'
   AND o.subject_id = $1
   AND EXISTS (
     SELECT 1 FROM spreadsheet_permissions t
      WHERE t.subject_type = 'role' AND t.subject_id = $2
        AND t.sheet_id = o.sheet_id AND t.perm_code = o.perm_code
   )`,
  unmovedRoleRows: (table) => `SELECT count(*)::int AS count FROM ${table} WHERE subject_type = 'role' AND subject_id = $1`,
  activeRoleApprovals: `SELECT count(*)::int AS count
  FROM approval_assignments
 WHERE assignment_type = 'role'
   AND assignee_id = $1
   AND is_active = TRUE`,
  // Approval-instance READ access held through the role (approval-instance-readability.ts
  // `canReadApprovalInstance` arms 2 and 4; the list scope in ApprovalBridgeService.ts
  // `buildApprovalListScopeCondition` matches the same two): a role-typed seat in ANY state — the
  // read arm is `is_active`-insensitive — and a role-targeted CC record. Neither is moved by this
  // script, so a member who leaves the role loses read access to those instances.
  approvalRoleSeats: `WITH ${ROLE_READ_KEYS}
SELECT count(*)::int AS count
  FROM approval_assignments a
 WHERE a.assignment_type = 'role'
   AND a.assignee_id IN (SELECT role_key FROM role_read_keys)`,
  approvalRoleCcRecords: `WITH ${ROLE_READ_KEYS}
SELECT count(*)::int AS count
  FROM approval_records rec
 WHERE rec.action = 'cc'
   AND rec.metadata->>'targetType' = 'role'
   AND rec.metadata->>'targetId' IN (SELECT role_key FROM role_read_keys)`,
  // ONE statement per move: the DELETE's RETURNING set IS the inserted set, so a membership or a
  // grant committed concurrently between two statements cannot be deleted without being moved.
  moveMembers: `WITH moved AS (
  DELETE FROM user_roles WHERE role_id = $1 RETURNING user_id
), inserted AS (
  INSERT INTO user_roles (user_id, role_id)
  SELECT user_id, $2 FROM moved
  ON CONFLICT DO NOTHING
  RETURNING 1
)
SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM inserted)::int AS inserted`,
  moveSheetGrants: `WITH moved AS (
  DELETE FROM spreadsheet_permissions
   WHERE subject_type = 'role'
     AND subject_id = $1
  RETURNING sheet_id, perm_code, created_at
), inserted AS (
  INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code, created_at)
  SELECT sheet_id, NULL, 'role', $2, perm_code, created_at FROM moved
  ON CONFLICT (sheet_id, subject_type, subject_id, perm_code) DO NOTHING
  RETURNING 1
)
SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM inserted)::int AS inserted`,
  deleteOldRoleCodes: `DELETE FROM role_permissions WHERE role_id = $1`,
  deleteOldRole: `DELETE FROM roles WHERE id = $1`,
  // ── approval designer census (read-only; $1 = OLD_ROLE_ID): template versions / published
  // definitions whose graph names the role (id or trimmed display name) as a role approver / handler
  // or a role CC target. Never a refusal, never changed.
  approvalTemplateVersionsNamingRole: `WITH ${ROLE_KEYS}
SELECT count(*)::int AS count, count(DISTINCT v.template_id)::int AS templates
  FROM approval_template_versions v
 WHERE EXISTS (SELECT 1 FROM role_keys k WHERE ${GRAPH_NAMES_ROLE('v.approval_graph')})`,
  approvalPublishedDefinitionsNamingRole: `WITH ${ROLE_KEYS}
SELECT count(*)::int AS count, count(*) FILTER (WHERE d.is_active)::int AS active
  FROM approval_published_definitions d
 WHERE EXISTS (SELECT 1 FROM role_keys k WHERE ${GRAPH_NAMES_ROLE('d.runtime_graph')})`,
  // ── template visibility census (read-only): templates whose ROLE-typed visibility list names a key
  // of the "in" roles — role ids $1 plus their trimmed display names, plus extra names $2 — and no key
  // of the "out" roles ($3 / $4 likewise). The visibility arm compares each list entry exactly against
  // a user's trimmed role ids and names (ApprovalProductService visibility condition). Never a refusal.
  approvalTemplatesVisibleThrough: `WITH keys_in AS (
  SELECT btrim(k) AS role_key FROM unnest($1::text[]) AS k
  UNION
  SELECT btrim(r.name) FROM roles r WHERE r.id = ANY($1::text[]) AND r.name IS NOT NULL
  UNION
  SELECT btrim(n) FROM unnest($2::text[]) AS n
), keys_out AS (
  SELECT btrim(k) AS role_key FROM unnest($3::text[]) AS k
  UNION
  SELECT btrim(r.name) FROM roles r WHERE r.id = ANY($3::text[]) AND r.name IS NOT NULL
  UNION
  SELECT btrim(n) FROM unnest($4::text[]) AS n
)
SELECT count(*)::int AS count
  FROM approval_templates t
 WHERE t.visibility_scope->>'type' = 'role'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.visibility_scope->'ids', '[]'::jsonb)) AS v(id)
      WHERE v.id IN (SELECT role_key FROM keys_in WHERE role_key <> '')
   )
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.visibility_scope->'ids', '[]'::jsonb)) AS v(id)
      WHERE v.id IN (SELECT role_key FROM keys_out WHERE role_key <> '')
   )`,
  // Every --apply transaction, before its first lock (FOR UPDATE / LOCK TABLE); never in a dry run.
  lockTimeout: `SET LOCAL lock_timeout = '5s'`,
  // ── the split step (option ①). $1 is the split role id unless stated.
  lockRoleTables: 'LOCK TABLE user_roles, role_permissions IN SHARE MODE',
  splitRoleRead: 'SELECT id, name FROM roles WHERE id = $1',
  splitRoleLock: 'SELECT id, name FROM roles WHERE id = $1 FOR UPDATE',
  roleCodes: 'SELECT permission_code FROM role_permissions WHERE role_id = $1 ORDER BY permission_code',
  // $1 split role id, $2 its (intended) display name: another role already carrying that name.
  splitNameTaken: 'SELECT count(*)::int AS count FROM roles WHERE id <> $1 AND btrim(name) = btrim($2::text)',
  // $1 split role id, $2 its (intended) display name: the approval read keys a new member would gain.
  splitApprovalSeats: `SELECT count(*)::int AS count
  FROM approval_assignments
 WHERE assignment_type = 'role'
   AND assignee_id IN (btrim($1::text), btrim($2::text))`,
  splitApprovalCcRecords: `SELECT count(*)::int AS count
  FROM approval_records
 WHERE action = 'cc'
   AND metadata->>'targetType' = 'role'
   AND metadata->>'targetId' IN (btrim($1::text), btrim($2::text))`,
  // No parameter: every role id that derives a delegated-admin namespace, wherever it appears.
  delegatedAdminRoleIds: `SELECT DISTINCT btrim(r.role_id) AS id
  FROM (SELECT id AS role_id FROM roles UNION SELECT role_id FROM user_roles UNION SELECT role_id FROM role_permissions) r
 WHERE right(btrim(r.role_id), 6) = '_admin'`,
  // No parameter: every permission code the database knows (catalogue, role codes, direct codes).
  catalogueCodes: 'SELECT DISTINCT code AS code FROM permissions',
  roleCodesAll: 'SELECT DISTINCT permission_code AS code FROM role_permissions',
  userCodesAll: 'SELECT DISTINCT permission_code AS code FROM user_permissions',
  savepoint: 'SAVEPOINT stock_prep_operator_split',
  rollbackToSavepoint: 'ROLLBACK TO SAVEPOINT stock_prep_operator_split',
  releaseSavepoint: 'RELEASE SAVEPOINT stock_prep_operator_split',
  // $1 split role id, $2 display name.
  insertSplitRole: 'INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
  // $1 split role id, $2 text[] of the extra codes.
  insertSplitCodes: `INSERT INTO role_permissions (role_id, permission_code)
SELECT $1, code FROM unnest($2::text[]) AS code
ON CONFLICT (role_id, permission_code) DO NOTHING
RETURNING 1`,
  // $1 OLD_ROLE_ID, $2 split role id: every current member of the old role joins the split role.
  addSplitMembers: `INSERT INTO user_roles (user_id, role_id)
SELECT user_id, $2 FROM user_roles WHERE role_id = $1
ON CONFLICT DO NOTHING
RETURNING 1`,
  // $1 OLD_ROLE_ID, $2 text[] of the extra codes.
  removeExtraCodes: `DELETE FROM role_permissions
 WHERE role_id = $1
   AND permission_code = ANY($2::text[])
RETURNING permission_code`,
})

const BOTH = Object.freeze([OLD_ROLE_ID, TARGET_ROLE_ID])
const REVERSED = Object.freeze([TARGET_ROLE_ID, OLD_ROLE_ID])
const OLD = Object.freeze([OLD_ROLE_ID])
const TARGET = Object.freeze([TARGET_ROLE_ID])

export class UsageError extends Error {}
/** A refusal or precondition stated in this file's own values-free words. */
export class ScriptError extends Error {}

export function parseArgs(argv) {
  const flags = { apply: false, deleteEmptyOldRole: false, root: null, help: false, splitRoleId: null, splitRoleName: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') flags.apply = true
    else if (arg === '--delete-empty-old-role') flags.deleteEmptyOldRole = true
    else if (arg === '--help') flags.help = true
    else if (arg === '--root') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new UsageError('--root needs a directory')
      flags.root = value
      index += 1
    } else if (arg === '--split-extra-codes-to-role') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError('--split-extra-codes-to-role needs a role id')
      if (flags.splitRoleId !== null) throw new UsageError('--split-extra-codes-to-role is given twice')
      const problem = splitRoleIdProblem(value)
      if (problem) throw new UsageError(`--split-extra-codes-to-role: ${problem}`)
      flags.splitRoleId = value
      index += 1
    } else if (arg === '--split-role-name') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError('--split-role-name needs a name')
      if (flags.splitRoleName !== null) throw new UsageError('--split-role-name is given twice')
      const problem = splitRoleNameProblem(value)
      if (problem) throw new UsageError(`--split-role-name: ${problem}`)
      flags.splitRoleName = value
      index += 1
    } else {
      // The argument itself is not echoed: a mistyped invocation could carry a connection string.
      throw new UsageError(`unknown argument at position ${index + 1} (flags are exact; see --help)`)
    }
  }
  if (flags.deleteEmptyOldRole && !flags.apply) {
    throw new UsageError('--delete-empty-old-role only acts together with --apply')
  }
  if (flags.splitRoleName !== null && flags.splitRoleId === null) {
    throw new UsageError('--split-role-name only acts together with --split-extra-codes-to-role')
  }
  return flags
}

/** The split request `run()` takes, from the parsed flags (null when no split was asked for). */
export function splitRequestFromFlags(flags) {
  if (flags.splitRoleId === null) return null
  return {
    roleId: flags.splitRoleId,
    roleName: flags.splitRoleName ?? DEFAULT_SPLIT_ROLE_NAME,
    roleNameGiven: flags.splitRoleName !== null,
  }
}

async function count(client, text, params) {
  const result = await client.query(text, params)
  return Number(result.rows[0]?.count ?? 0)
}

async function tableExists(client, table) {
  return (await count(client, SQL.tableExists, [table])) > 0
}

/** Everything the decision needs, read inside the caller's transaction. Never writes. */
export async function readCensus(client, { lock, split = null }) {
  for (const table of ['roles', 'user_roles', 'role_permissions']) {
    if (!(await tableExists(client, table))) throw new ScriptError(`required table missing: ${table}`)
  }
  const roleRows = await client.query(lock ? SQL.rolesLock : SQL.rolesRead, BOTH)
  const ids = new Set(roleRows.rows.map((row) => row.id))
  const census = {
    oldRoleExists: ids.has(OLD_ROLE_ID),
    targetRoleExists: ids.has(TARGET_ROLE_ID),
    approvalUsable: await readApprovalUsable(client, split),
    oldMembers: await count(client, SQL.oldMembers, OLD),
    sharedMembers: await count(client, SQL.sharedMembers, BOTH),
    targetOnlyMembers: await count(client, SQL.targetOnlyMembers, BOTH),
    oldCodeCount: await count(client, SQL.oldCodeCount, OLD),
    oldCodesMissingOnTarget: (await client.query(SQL.oldCodesMissingOnTarget, BOTH)).rows.map((row) => row.permission_code),
    oldSheetGrants: 0,
    sharedSheetGrants: 0,
    unmoved: {},
    activeRoleApprovals: 0,
    // Approval-instance read access through the old role (any seat state; CC): never moved.
    approvalRoleSeats: 0,
    approvalRoleCcRecords: 0,
    // What the target holds beyond the old role — the moved members would gain it.
    gains: {
      codes: (await client.query(SQL.targetCodesMissingOnOld, BOTH)).rows.map((row) => row.permission_code),
      sheetGrants: 0,
      unmoved: {},
      activeRoleApprovals: 0,
      approvalRoleSeats: 0,
      approvalRoleCcRecords: 0,
    },
    pendingInvites: 0,
  }
  if (await tableExists(client, 'spreadsheet_permissions')) {
    census.oldSheetGrants = await count(client, SQL.oldSheetGrants, OLD)
    census.sharedSheetGrants = await count(client, SQL.sharedSheetGrants, BOTH)
    census.gains.sheetGrants = await count(client, SQL.targetSheetGrantsMissingOnOld, BOTH)
  }
  for (const table of UNMOVED_ROLE_SUBJECT_TABLES) {
    const present = await tableExists(client, table)
    census.unmoved[table] = present ? await count(client, SQL.unmovedRoleRows(table), OLD) : 0
    census.gains.unmoved[table] = present ? await count(client, SQL.unmovedRoleRows(table), TARGET) : 0
  }
  if (await tableExists(client, 'approval_assignments')) {
    census.activeRoleApprovals = await count(client, SQL.activeRoleApprovals, OLD)
    census.gains.activeRoleApprovals = await count(client, SQL.activeRoleApprovals, TARGET)
    census.approvalRoleSeats = await count(client, SQL.approvalRoleSeats, BOTH)
    census.gains.approvalRoleSeats = await count(client, SQL.approvalRoleSeats, REVERSED)
  }
  if (await tableExists(client, 'approval_records')) {
    census.approvalRoleCcRecords = await count(client, SQL.approvalRoleCcRecords, BOTH)
    census.gains.approvalRoleCcRecords = await count(client, SQL.approvalRoleCcRecords, REVERSED)
  }
  if (await tableExists(client, 'user_invites')) {
    census.pendingInvites = await count(client, SQL.pendingOldRoleInvites, OLD)
  }
  // The approval designer census: counted, never a refusal, never changed.
  census.approvalDesigner = { templateVersions: 0, templates: 0, publishedDefinitions: 0, activePublishedDefinitions: 0 }
  if (await tableExists(client, 'approval_template_versions')) {
    const row = (await client.query(SQL.approvalTemplateVersionsNamingRole, OLD)).rows[0] ?? {}
    census.approvalDesigner.templateVersions = Number(row.count ?? 0)
    census.approvalDesigner.templates = Number(row.templates ?? 0)
  }
  if (await tableExists(client, 'approval_published_definitions')) {
    const row = (await client.query(SQL.approvalPublishedDefinitionsNamingRole, OLD)).rows[0] ?? {}
    census.approvalDesigner.publishedDefinitions = Number(row.count ?? 0)
    census.approvalDesigner.activePublishedDefinitions = Number(row.active ?? 0)
  }
  if (split) census.split = await readSplitCensus(client, split, { lock })
  // Template visibility: before the move a member sees templates through the old role; after it,
  // through the target and — when the split step will run (decideSplit: both roles exist and the old
  // role holds a code the target lacks) — the split role. A split role not yet created contributes
  // the display name it would be created with.
  census.templateVisibility = { lost: 0, gained: 0 }
  if (await tableExists(client, 'approval_templates')) {
    const splitRuns = split !== null && census.oldRoleExists && census.targetRoleExists && census.oldCodesMissingOnTarget.length > 0
    const afterIds = splitRuns ? [TARGET_ROLE_ID, split.roleId] : [TARGET_ROLE_ID]
    const afterNames = splitRuns && !census.split.exists ? [split.roleName] : []
    census.templateVisibility.afterRoles = afterIds
    census.templateVisibility.lost = await count(client, SQL.approvalTemplatesVisibleThrough, [[OLD_ROLE_ID], [], afterIds, afterNames])
    census.templateVisibility.gained = await count(client, SQL.approvalTemplatesVisibleThrough, [afterIds, afterNames, [OLD_ROLE_ID], []])
  }
  return census
}

/**
 * `roles.approval_usable` of the old role, the target and the split role: `{ column: false }` when
 * the column does not exist, else `{ column: true, roles: { <id>: true | false | null } }` (null = no
 * such role). Printed by the census, never copied, never a refusal.
 */
async function readApprovalUsable(client, split) {
  if ((await count(client, SQL.columnExists, ['roles', 'approval_usable'])) === 0) return { column: false, roles: {} }
  const roleIds = split ? [OLD_ROLE_ID, TARGET_ROLE_ID, split.roleId] : [OLD_ROLE_ID, TARGET_ROLE_ID]
  const found = new Map((await client.query(SQL.roleApprovalUsable, [roleIds])).rows.map((row) => [row.id, row.approval_usable === true]))
  return { column: true, roles: Object.fromEntries(roleIds.map((id) => [id, found.has(id) ? found.get(id) : null])) }
}

/** The namespaces of `roleId` a delegate controls now or could be given, read from the database. */
async function matchedDelegableNamespaces(client, roleId) {
  const delegated = new Set()
  for (const row of (await client.query(SQL.delegatedAdminRoleIds)).rows) {
    const namespace = deriveDelegatedAdminNamespace(row.id)
    if (namespace) delegated.add(namespace)
  }
  const codeNamespaces = new Set()
  const codeStatements = [['permissions', SQL.catalogueCodes], ['role_permissions', SQL.roleCodesAll], ['user_permissions', SQL.userCodesAll]]
  for (const [table, text] of codeStatements) {
    if (!(await tableExists(client, table))) continue
    for (const row of (await client.query(text)).rows) {
      const namespace = derivePermissionNamespace(row.code)
      if (namespace) codeNamespaces.add(namespace)
    }
  }
  return candidateNamespaces(roleId)
    .filter((namespace) => isNamespaceAdmissionControlledResource(namespace))
    .filter((namespace) => delegated.has(namespace) || codeNamespaces.has(namespace))
}

/** The split role as the database holds it, inside the caller's transaction. Never writes. */
async function readSplitCensus(client, split, { lock }) {
  const id = [split.roleId]
  const roleRow = (await client.query(lock ? SQL.splitRoleLock : SQL.splitRoleRead, id)).rows[0] ?? null
  const exists = roleRow !== null
  const name = exists ? normalizeString(roleRow.name) : split.roleName
  const s = {
    roleId: split.roleId,
    exists,
    // The CALLER's name is checked against an existing role; an existing role's name is never printed.
    existingNameMatchesRequest: exists ? normalizeString(roleRow.name) === split.roleName : null,
    // An existing role's name is judged like a given one (admin / reserved); only the reason is printed.
    existingNameProblem: exists ? splitRoleNameReservedProblem(normalizeString(roleRow.name)) : null,
    codes: (await client.query(SQL.roleCodes, id)).rows.map((row) => row.permission_code),
    members: await count(client, SQL.oldMembers, id),
    oldMembersAlreadyIn: await count(client, SQL.sharedMembers, [OLD_ROLE_ID, split.roleId]),
    nameTaken: exists ? 0 : await count(client, SQL.splitNameTaken, [split.roleId, split.roleName]),
    sheetGrants: 0,
    unmoved: {},
    activeRoleApprovals: 0,
    approvalSeats: 0,
    approvalCcRecords: 0,
    namespaces: await matchedDelegableNamespaces(client, split.roleId),
  }
  if (await tableExists(client, 'spreadsheet_permissions')) s.sheetGrants = await count(client, SQL.oldSheetGrants, id)
  for (const table of UNMOVED_ROLE_SUBJECT_TABLES) {
    s.unmoved[table] = (await tableExists(client, table)) ? await count(client, SQL.unmovedRoleRows(table), id) : 0
  }
  if (await tableExists(client, 'approval_assignments')) {
    s.activeRoleApprovals = await count(client, SQL.activeRoleApprovals, id)
    s.approvalSeats = await count(client, SQL.splitApprovalSeats, [split.roleId, name])
  }
  if (await tableExists(client, 'approval_records')) {
    s.approvalCcRecords = await count(client, SQL.splitApprovalCcRecords, [split.roleId, name])
  }
  return s
}

/** Old-role members not already in the target: the people a move would actually change. */
function movingNewMembers(census) {
  return Math.max(0, census.oldMembers - census.sharedMembers)
}

function gainedGrantRows(census) {
  return census.gains.sheetGrants + Object.values(census.gains.unmoved).reduce((sum, rows) => sum + rows, 0)
}

function hasGains(census) {
  return census.gains.codes.length > 0
    || gainedGrantRows(census) > 0
    || census.gains.activeRoleApprovals > 0
    || census.gains.approvalRoleSeats > 0
    || census.gains.approvalRoleCcRecords > 0
}

/** Approval-instance read access the old role carries that no statement of this script moves. */
function oldRoleApprovalReads(census) {
  return census.approvalRoleSeats + census.approvalRoleCcRecords
}

/** What still names the old role after a successful move and so blocks `--delete-empty-old-role`. */
function deleteBlockers(census) {
  const blockers = []
  if (census.pendingInvites > 0) blockers.push(`${census.pendingInvites} pending invite(s)`)
  if (oldRoleApprovalReads(census) > 0) {
    blockers.push(`${census.approvalRoleSeats} role-typed approval seat(s) (any state) and ${census.approvalRoleCcRecords} role-targeted approval CC record(s)`)
  }
  return blockers
}

/**
 * The verdict `--apply` (with `--delete-empty-old-role` when `deleteEmptyOldRole`) reaches on this
 * census. Pure.
 */
export function decide(census, { deleteEmptyOldRole = false } = {}) {
  const refusals = []
  if (!census.targetRoleExists) {
    refusals.push(`${TARGET_ROLE_ID} does not exist — run the S5a migration (the upgrade) first`)
    return { refusals, moveMembers: false, moveSheetGrants: false }
  }
  if (census.oldMembers > 0 && census.oldCodesMissingOnTarget.length > 0) {
    refusals.push(
      `${OLD_ROLE_ID} holds ${census.oldCodesMissingOnTarget.length} code(s) ${TARGET_ROLE_ID} does not `
      + `(${census.oldCodesMissingOnTarget.join(', ')}); its ${census.oldMembers} member(s) would lose them — `
      + 'in 角色管理 first create a separate platform role holding these codes, give it to the same members, '
      + `then remove the codes from ${OLD_ROLE_ID} (ADR §8 step 3, option ①; never add them to ${TARGET_ROLE_ID}) — `
      + `or let this script do exactly that: --split-extra-codes-to-role ${RECOMMENDED_SPLIT_ROLE_ID}`,
    )
  }
  if (census.oldMembers > 0 && oldRoleApprovalReads(census) > 0) {
    refusals.push(
      `${OLD_ROLE_ID} is named by ${census.approvalRoleSeats} role-typed approval seat(s) (any state, by role id or `
      + `display name) and ${census.approvalRoleCcRecords} role-targeted approval CC record(s); its ${census.oldMembers} `
      + 'member(s) read those approval instances through the role and would lose that read access — this script '
      + 'does not move approval seats or CC records; the owner decides before --apply (ADR §8 step 3)',
    )
  }
  const gainers = movingNewMembers(census)
  if (gainers > 0 && hasGains(census)) {
    refusals.push(
      `${TARGET_ROLE_ID} holds what ${OLD_ROLE_ID} does not — ${census.gains.codes.length} code(s)`
      + `${census.gains.codes.length > 0 ? ` (${census.gains.codes.join(', ')})` : ''}, `
      + `${gainedGrantRows(census)} role-subject grant row(s), ${census.gains.activeRoleApprovals} active role-assigned approval task(s), `
      + `${census.gains.approvalRoleSeats} role-typed approval seat(s) in any state and ${census.gains.approvalRoleCcRecords} `
      + 'role-targeted approval CC record(s) (read access to those approval instances); '
      + `${gainers} member(s) of ${OLD_ROLE_ID} not already in ${TARGET_ROLE_ID} would gain them — `
      + `decide in 角色管理 first (a freshly seeded ${TARGET_ROLE_ID} holds none of these)`,
    )
  }
  for (const [table, rows] of Object.entries(census.unmoved)) {
    if (rows > 0) refusals.push(`${OLD_ROLE_ID} is the subject of ${rows} row(s) in ${table}, which this script does not move`)
  }
  if (census.activeRoleApprovals > 0) {
    refusals.push(`${OLD_ROLE_ID} has ${census.activeRoleApprovals} active role-assigned approval task(s)`)
  }
  if (census.oldSheetGrants > 0 && census.targetOnlyMembers > 0) {
    refusals.push(
      `${TARGET_ROLE_ID} already has ${census.targetOnlyMembers} member(s) outside ${OLD_ROLE_ID}; `
      + `moving ${census.oldSheetGrants} table grant(s) would extend them to those members`,
    )
  }
  if (deleteEmptyOldRole && census.oldRoleExists && census.pendingInvites > 0) {
    refusals.push(
      `--delete-empty-old-role: ${census.pendingInvites} pending invite(s) still name ${OLD_ROLE_ID}; `
      + 'resend them with another role or revoke them first (or run without --delete-empty-old-role)',
    )
  }
  if (deleteEmptyOldRole && census.oldRoleExists && oldRoleApprovalReads(census) > 0) {
    refusals.push(
      `--delete-empty-old-role: ${census.approvalRoleSeats} role-typed approval seat(s) (any state) and `
      + `${census.approvalRoleCcRecords} role-targeted approval CC record(s) still name ${OLD_ROLE_ID} and stay after `
      + 'the move; a role later re-created under that id or display name would read those approval instances — '
      + 'keep the old role (run without --delete-empty-old-role)',
    )
  }
  return { refusals, moveMembers: census.oldMembers > 0, moveSheetGrants: census.oldSheetGrants > 0 }
}

function sumValues(record) {
  return Object.values(record).reduce((sum, rows) => sum + rows, 0)
}

/**
 * The split step's own verdict on a census read WITH the split request (option ①). Pure. `plan.work`
 * is false when there is nothing to split (no old role, or it holds no code the target lacks).
 */
export function decideSplit(census, split) {
  const s = census.split
  const extraCodes = [...census.oldCodesMissingOnTarget]
  const refusals = []
  const plan = { work: false, create: false, roleId: split.roleId, roleName: split.roleName, extraCodes, membersToAdd: 0 }
  if (!census.targetRoleExists || !census.oldRoleExists || extraCodes.length === 0) return { refusals, plan }

  const adminLevel = extraCodes.filter((code) => isAdminLevelPermissionCode(code))
  if (adminLevel.length > 0) {
    refusals.push(
      `split: ${adminLevel.length} of the extra code(s) are admin-level (${adminLevel.join(', ')}); `
      + 'this script never moves an admin-level code onto another role — a platform administrator handles them by hand in 角色管理',
    )
  }
  if (s.namespaces.length > 0) {
    refusals.push(
      `split: role ${s.roleId} falls inside ${s.namespaces.length} namespace(s) a namespace delegated admin controls or could be given `
      + `(${s.namespaces.join(', ')}); choose an id outside every delegable namespace (recommended: ${RECOMMENDED_SPLIT_ROLE_ID})`,
    )
  }
  if (s.exists) {
    const sameCodes = s.codes.length === extraCodes.length && extraCodes.every((code) => s.codes.includes(code))
    if (!sameCodes) {
      refusals.push(
        `split: role ${s.roleId} already exists and its codes are not exactly the extra codes (it holds ${s.codes.length}, `
        + `the extra codes are ${extraCodes.length}); an existing role is reused only on an exact match — choose another id`,
      )
    }
    if (split.roleNameGiven && s.existingNameMatchesRequest === false) {
      refusals.push(`split: role ${s.roleId} already exists under another display name; an existing role is reused as found (drop --split-role-name or choose another id)`)
    }
    if (s.existingNameProblem) {
      refusals.push(`split: role ${s.roleId} already exists and ${s.existingNameProblem.replace(/^the split role name/, 'its display name')}; choose another id`)
    }
  } else {
    if (s.members > 0 || s.codes.length > 0) {
      refusals.push(
        `split: role ${s.roleId} does not exist but ${s.members} user_roles row(s) and ${s.codes.length} role_permissions row(s) `
        + 'still name that id (left behind by a deleted role); creating it would hand them its codes — choose another id',
      )
    }
    if (s.nameTaken > 0) {
      refusals.push(`split: another role already carries the display name the split role would get; give --split-role-name a free name`)
    }
  }
  const membersToAdd = Math.max(0, census.oldMembers - s.oldMembersAlreadyIn)
  const gainedRows = s.sheetGrants + sumValues(s.unmoved)
  if (membersToAdd > 0 && (gainedRows > 0 || s.activeRoleApprovals > 0 || s.approvalSeats > 0 || s.approvalCcRecords > 0)) {
    refusals.push(
      `split: role ${s.roleId} is the subject of ${gainedRows} role-subject grant row(s), ${s.activeRoleApprovals} active role-assigned `
      + `approval task(s), ${s.approvalSeats} role-typed approval seat(s) and ${s.approvalCcRecords} role-targeted approval CC record(s) `
      + `(by its id, or by id or display name for seats / CC); the ${membersToAdd} member(s) of ${OLD_ROLE_ID} not yet in it would gain them — choose another id`,
    )
  }
  return { refusals, plan: { ...plan, work: true, create: !s.exists, membersToAdd } }
}

/** The census as it will read once the split step has run (the codes it removes from the old role). */
function projectSplit(census, plan) {
  if (!plan.work) return census
  return {
    ...census,
    oldCodeCount: Math.max(0, census.oldCodeCount - plan.extraCodes.length),
    oldCodesMissingOnTarget: census.oldCodesMissingOnTarget.filter((code) => !plan.extraCodes.includes(code)),
  }
}

/** The two post-split invariants, on the census re-read after the split statements. */
function postSplitProblems(after, plan) {
  const problems = []
  const s = after.split
  const exact = s.exists && s.codes.length === plan.extraCodes.length && plan.extraCodes.every((code) => s.codes.includes(code))
  if (!exact) problems.push(`split: role ${plan.roleId} does not hold exactly the ${plan.extraCodes.length} extra code(s) after the split`)
  if (s.oldMembersAlreadyIn !== after.oldMembers) {
    problems.push(`split: ${after.oldMembers - s.oldMembersAlreadyIn} member(s) of ${OLD_ROLE_ID} are not in role ${plan.roleId} after the split`)
  }
  return problems
}

function describeSplit(census, split, plan, write) {
  const s = census.split
  write(`split: extra codes (on ${OLD_ROLE_ID}, not on ${TARGET_ROLE_ID}): ${plan.extraCodes.length}${plan.extraCodes.length > 0 ? ` (${plan.extraCodes.join(', ')})` : ''}`)
  write(`split: role ${s.roleId} ${s.exists ? 'exists' : 'absent'}; its codes: ${s.codes.length}${s.codes.length > 0 ? ` (${s.codes.join(', ')})` : ''}; its members: ${s.members}`)
  write(`split: members of ${OLD_ROLE_ID} already in ${s.roleId}: ${s.oldMembersAlreadyIn}`)
  write(`split: delegable namespaces ${s.roleId} falls in: ${s.namespaces.length}${s.namespaces.length > 0 ? ` (${s.namespaces.join(', ')})` : ''}`)
  write(`split: role-subject grant rows of ${s.roleId}: ${s.sheetGrants + sumValues(s.unmoved)}; active role-assigned approval tasks: ${s.activeRoleApprovals}; `
    + `role-typed approval seats (by id or display name): ${s.approvalSeats}; role-targeted approval CC records (by id or display name): ${s.approvalCcRecords}`)
  if (!s.exists) {
    write(`split: display name for a new ${s.roleId}: ${split.roleNameGiven ? '(custom, as given)' : DEFAULT_SPLIT_ROLE_NAME}; taken by another role: ${s.nameTaken > 0 ? 'yes' : 'no'}`)
  }
}

function describePlan(plan) {
  if (!plan.work) return 'split: nothing to split'
  return `split: ${plan.create ? `create role ${plan.roleId} with` : `reuse role ${plan.roleId}, which holds exactly`} `
    + `${plan.extraCodes.length} code(s) (${plan.extraCodes.join(', ')}), add ${plan.membersToAdd} member(s) of ${OLD_ROLE_ID} to it, `
    + `remove those ${plan.extraCodes.length} code(s) from ${OLD_ROLE_ID}`
}

function oldRoleIsEmpty(census) {
  return census.oldMembers === 0
    && census.oldSheetGrants === 0
    && census.activeRoleApprovals === 0
    && census.approvalRoleSeats === 0
    && census.approvalRoleCcRecords === 0
    && census.pendingInvites === 0
    && Object.values(census.unmoved).every((rows) => rows === 0)
}

function describeApprovalUsable(census, write) {
  const usable = census.approvalUsable
  if (!usable || !usable.column) {
    write('approval_usable — column roles.approval_usable absent; nothing to compare')
    return
  }
  const show = (value) => (value === null ? 'role absent' : String(value))
  write(`approval_usable — ${Object.entries(usable.roles).map(([id, value]) => `${id}: ${show(value)}`).join('; ')}`)
  const splitId = Object.keys(usable.roles).find((id) => id !== OLD_ROLE_ID && id !== TARGET_ROLE_ID) ?? RECOMMENDED_SPLIT_ROLE_ID
  write('approval_usable — NOT copied by this script (a role it creates starts with the default, false); '
    + `the owner decides whether ${splitId} should get it`)
}

function describeCensus(census, write) {
  write(`roles: ${OLD_ROLE_ID} ${census.oldRoleExists ? 'exists' : 'absent'}; ${TARGET_ROLE_ID} ${census.targetRoleExists ? 'exists' : 'absent'}`)
  describeApprovalUsable(census, write)
  write(`members of ${OLD_ROLE_ID}: ${census.oldMembers} (already also in ${TARGET_ROLE_ID}: ${census.sharedMembers})`)
  write(`members only in ${TARGET_ROLE_ID}: ${census.targetOnlyMembers}`)
  write(`codes on ${OLD_ROLE_ID}: ${census.oldCodeCount}; not held by ${TARGET_ROLE_ID}: ${census.oldCodesMissingOnTarget.length}`)
  write(`role-subject table grants of ${OLD_ROLE_ID}: ${census.oldSheetGrants} (already on ${TARGET_ROLE_ID}: ${census.sharedSheetGrants})`)
  for (const [table, rows] of Object.entries(census.unmoved)) write(`role-subject rows in ${table}: ${rows}`)
  write(`active role-assigned approval tasks: ${census.activeRoleApprovals}`)
  write(`approval read through ${OLD_ROLE_ID} — role-typed seats in any state (by role id or display name): ${census.approvalRoleSeats}`)
  write(`approval read through ${OLD_ROLE_ID} — role-targeted CC records (by role id or display name): ${census.approvalRoleCcRecords}`)
  // The gains: what moved members not already in the target would newly hold.
  const gainedCodes = census.gains.codes
  write(`gains — codes on ${TARGET_ROLE_ID} not held by ${OLD_ROLE_ID}: ${gainedCodes.length}${gainedCodes.length > 0 ? ` (${gainedCodes.join(', ')})` : ''}`)
  write(`gains — role-subject table grants of ${TARGET_ROLE_ID} not held by ${OLD_ROLE_ID}: ${census.gains.sheetGrants}`)
  for (const [table, rows] of Object.entries(census.gains.unmoved)) write(`gains — role-subject rows of ${TARGET_ROLE_ID} in ${table}: ${rows}`)
  write(`gains — active role-assigned approval tasks of ${TARGET_ROLE_ID}: ${census.gains.activeRoleApprovals}`)
  write(`gains — role-typed approval seats of ${TARGET_ROLE_ID} in any state, not reachable through ${OLD_ROLE_ID}: ${census.gains.approvalRoleSeats}`)
  write(`gains — role-targeted approval CC records of ${TARGET_ROLE_ID}, not reachable through ${OLD_ROLE_ID}: ${census.gains.approvalRoleCcRecords}`)
  write(`gains — members who would gain them (in ${OLD_ROLE_ID}, not yet in ${TARGET_ROLE_ID}): ${movingNewMembers(census)}`)
  write(`pending invites naming ${OLD_ROLE_ID}: ${census.pendingInvites}`)
  const designer = census.approvalDesigner
  write(`approval designer — template versions naming ${OLD_ROLE_ID} as a role approver / handler / CC target (by role id or display name): `
    + `${designer.templateVersions} (templates: ${designer.templates}); NOT changed by this script`)
  write(`approval designer — published definitions naming ${OLD_ROLE_ID} the same way: ${designer.publishedDefinitions} `
    + `(active: ${designer.activePublishedDefinitions}); NOT changed by this script — re-point them in the approval designer`)
  const afterRoles = (census.templateVisibility.afterRoles ?? [TARGET_ROLE_ID]).join(' or ')
  write(`approval template visibility — role-scoped templates visible through ${OLD_ROLE_ID} but not through ${afterRoles} `
    + `(by role id or display name): ${census.templateVisibility.lost}; moved members would stop seeing them (记录送审); NOT changed by this script`)
  write(`approval template visibility — role-scoped templates visible through ${afterRoles} but not through ${OLD_ROLE_ID} `
    + `(by role id or display name): ${census.templateVisibility.gained}; moved members would newly see them; NOT changed by this script`)
}

/**
 * One run against an open client. `manageTransaction: false` runs inside the CALLER's transaction
 * (the real-database test wraps a run in its own BEGIN … ROLLBACK); the CLI always manages its own.
 */
export async function run({ client, apply = false, deleteEmptyOldRole = false, split = null, manageTransaction = true, write = () => {} }) {
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    exitCode: EXIT_OK,
    refusals: [],
    membersMoved: 0,
    sheetGrantsMoved: 0,
    oldRoleDeleted: false,
    split: split ? { roleCreated: false, codesBound: 0, membersAdded: 0, codesRemoved: 0 } : null,
  }
  if (manageTransaction) {
    await client.query(SQL.begin)
    if (!apply) await client.query(SQL.readOnly)
  }
  let committed = false
  try {
    // Every apply: no lock below (the census FOR UPDATE, the split's LOCK TABLE) waits more than 5 s;
    // a longer wait is SQLSTATE 55P03 -> exit 1, rolled back. A dry run takes no lock and skips it.
    if (apply) await client.query(SQL.lockTimeout)
    if (apply && split) {
      // No other session may change a membership or a role's codes between this census and the
      // commit: the split adds the old role's members to the split role, then moves them.
      await client.query(SQL.lockRoleTables)
    }
    let census = await readCensus(client, { lock: apply, split })
    summary.census = census
    describeCensus(census, write)
    let verdict
    let splitPlan = null
    if (split) {
      const splitVerdict = decideSplit(census, split)
      splitPlan = splitVerdict.plan
      describeSplit(census, split, splitPlan, write)
      // Every other refusal is judged on the census the split step will leave behind.
      verdict = decide(projectSplit(census, splitPlan), { deleteEmptyOldRole: apply && deleteEmptyOldRole })
      verdict = { ...verdict, refusals: [...splitVerdict.refusals, ...verdict.refusals] }
    } else {
      verdict = decide(census, { deleteEmptyOldRole: apply && deleteEmptyOldRole })
    }
    summary.refusals = verdict.refusals
    if (verdict.refusals.length > 0) {
      for (const reason of verdict.refusals) write(`${apply ? 'REFUSED' : '--apply would refuse'}: ${reason}`)
      summary.exitCode = EXIT_REFUSED
      return summary
    }
    if (!apply) {
      if (splitPlan) write(`dry run: --apply first does the ${describePlan(splitPlan)}`)
      const nothingToMove = !verdict.moveMembers && !verdict.moveSheetGrants
      write(nothingToMove ? 'dry run: nothing to move' : `dry run: --apply would move ${census.oldMembers} membership(s) and ${census.oldSheetGrants} table grant(s)`)
      if (census.oldRoleExists) {
        const blockers = deleteBlockers(census)
        write(blockers.length > 0
          ? `dry run: --apply --delete-empty-old-role would refuse: ${blockers.join('; ')} still name ${OLD_ROLE_ID}`
          : `dry run: with --apply --delete-empty-old-role, ${OLD_ROLE_ID} would then be deleted`)
      }
      write('dry run: nothing written')
      return summary
    }

    if (splitPlan && splitPlan.work) {
      // THE SPLIT STEP (option ①), then the census again: every refusal is re-judged on what the
      // database now holds, and the savepoint undoes the split if anything refuses.
      await client.query(SQL.savepoint)
      let splitRefusals = []
      if (splitPlan.create) {
        const created = await client.query(SQL.insertSplitRole, [splitPlan.roleId, splitPlan.roleName])
        if (created.rows.length === 0) {
          splitRefusals = [`split: role ${splitPlan.roleId} was created by another session meanwhile; nothing was changed`]
        } else {
          summary.split.roleCreated = true
          const bound = await client.query(SQL.insertSplitCodes, [splitPlan.roleId, splitPlan.extraCodes])
          summary.split.codesBound = bound.rows.length
        }
      }
      if (splitRefusals.length === 0) {
        const added = await client.query(SQL.addSplitMembers, [OLD_ROLE_ID, splitPlan.roleId])
        summary.split.membersAdded = added.rows.length
        const removed = await client.query(SQL.removeExtraCodes, [OLD_ROLE_ID, splitPlan.extraCodes])
        summary.split.codesRemoved = removed.rows.length
        census = await readCensus(client, { lock: true, split })
        verdict = decide(census, { deleteEmptyOldRole })
        splitRefusals = [...postSplitProblems(census, splitPlan), ...verdict.refusals]
      }
      if (splitRefusals.length > 0) {
        await client.query(SQL.rollbackToSavepoint)
        summary.split = { roleCreated: false, codesBound: 0, membersAdded: 0, codesRemoved: 0 }
        summary.refusals = splitRefusals
        for (const reason of splitRefusals) write(`REFUSED (after the split step; the split was rolled back, nothing was written): ${reason}`)
        summary.exitCode = EXIT_REFUSED
        return summary
      }
      await client.query(SQL.releaseSavepoint)
      write(`apply: split — ${summary.split.roleCreated ? `created role ${splitPlan.roleId} with ${summary.split.codesBound}` : `reused role ${splitPlan.roleId}, which holds exactly the`} `
        + `extra code(s), added ${summary.split.membersAdded} member(s) of ${OLD_ROLE_ID} to it, removed ${summary.split.codesRemoved} code(s) from ${OLD_ROLE_ID}`)
    }

    const nothingToMove = !verdict.moveMembers && !verdict.moveSheetGrants
    if (verdict.moveMembers) {
      const moved = await client.query(SQL.moveMembers, BOTH)
      summary.membersMoved = Number(moved.rows[0]?.moved ?? 0)
    }
    if (verdict.moveSheetGrants) {
      const moved = await client.query(SQL.moveSheetGrants, BOTH)
      summary.sheetGrantsMoved = Number(moved.rows[0]?.moved ?? 0)
    }

    if (deleteEmptyOldRole && census.oldRoleExists) {
      // Re-read after the move, under the same transaction: delete only what is provably empty now.
      const after = await readCensus(client, { lock: true })
      if (!oldRoleIsEmpty(after)) {
        summary.refusals = [`${OLD_ROLE_ID} is not empty after the move; nothing was changed`]
        write(`REFUSED: ${summary.refusals[0]}`)
        summary.exitCode = EXIT_REFUSED
        return summary
      }
      await client.query(SQL.deleteOldRoleCodes, OLD)
      await client.query(SQL.deleteOldRole, OLD)
      summary.oldRoleDeleted = true
    }

    if (manageTransaction) {
      await client.query(SQL.commit)
      committed = true
    }
    const splitWrote = Boolean(splitPlan && splitPlan.work)
    write(nothingToMove && !summary.oldRoleDeleted && !splitWrote
      ? 'apply: nothing to move; nothing written'
      : `apply: moved ${summary.membersMoved} membership(s) and ${summary.sheetGrantsMoved} table grant(s); ${OLD_ROLE_ID} ${summary.oldRoleDeleted ? 'deleted' : 'kept'}`)
    return summary
  } finally {
    if (manageTransaction && !committed) {
      try {
        await client.query(SQL.rollback)
      } catch {
        // The connection is already gone; PostgreSQL discards the open transaction with it.
      }
    }
  }
}

/**
 * DATABASE_URL from the text of an app.env, parsed the way the backend's PM2 config loads that file
 * (ecosystem.config.cjs `loadOnPremEnvFile`, :24-49; the upgrade wrapper's `Import-AppEnvFile`,
 * scripts/ops/multitable-onprem-package-upgrade-inplace.ps1 :1414-1455, splits lines the same way):
 * a line is split at its FIRST `=`, the key is trimmed — String.prototype.trim also removes U+FEFF,
 * so a leading BOM, leading spaces and `DATABASE_URL = v` all count, exactly as in
 * ecosystem.config.cjs —, the value is trimmed and one layer of matching quotes stripped. Their
 * whole-line trim and `#` / blank skips select nothing more for this one key: a comment line's key
 * starts with `#`, a blank line has no `=`. The first DATABASE_URL line wins (ecosystem.config.cjs
 * never overrides a key already set).
 */
export function databaseUrlFromAppEnvText(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq < 0 || line.slice(0, eq).trim() !== 'DATABASE_URL') continue
    return line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return ''
}

function readDatabaseUrlFromAppEnv(root) {
  const envPath = path.join(root, 'docker', 'app.env')
  if (!fs.existsSync(envPath)) return ''
  return databaseUrlFromAppEnvText(fs.readFileSync(envPath, 'utf8'))
}

function loadPg(root) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const backendDir = root ? path.join(path.resolve(root), 'packages', 'core-backend') : path.resolve(here, '..', '..', 'packages', 'core-backend')
  return createRequire(path.join(backendDir, 'package.json'))('pg')
}

export async function main(argv, env, { createClient, out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`) } = {}) {
  let flags
  try {
    flags = parseArgs(argv)
  } catch (error) {
    err(error instanceof UsageError ? error.message : 'invalid arguments')
    err(HELP_TEXT)
    return EXIT_FAILURE
  }
  if (flags.help) {
    out(HELP_TEXT)
    return EXIT_OK
  }
  const databaseUrl = env.DATABASE_URL || (flags.root ? readDatabaseUrlFromAppEnv(flags.root) : '')
  if (!databaseUrl) {
    err('DATABASE_URL is required (environment, or --root <install root> with docker/app.env)')
    return EXIT_FAILURE
  }
  out(`OWNER ACTION (R-39): ${flags.apply ? 'APPLY' : 'dry run'} — ${OLD_ROLE_ID} → ${TARGET_ROLE_ID}${flags.splitRoleId ? ` (extra codes split to ${flags.splitRoleId} first)` : ''}`)

  let client
  try {
    client = createClient
      ? await createClient(databaseUrl)
      : new (loadPg(flags.root).Client)({ connectionString: databaseUrl })
    if (typeof client.connect === 'function') await client.connect()
    const summary = await run({ client, apply: flags.apply, deleteEmptyOldRole: flags.deleteEmptyOldRole, split: splitRequestFromFlags(flags), write: out })
    return summary.exitCode
  } catch (error) {
    if (error instanceof ScriptError) {
      err(`failed: ${error.message}; nothing was written`)
      return EXIT_FAILURE
    }
    // PostgreSQL error text can quote row values; only the SQLSTATE / errno code is printed.
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'unknown'
    err(`failed (code ${code}); the transaction was rolled back and nothing was written`)
    return EXIT_FAILURE
  } finally {
    if (client && typeof client.end === 'function') await client.end().catch(() => undefined)
  }
}

/**
 * Whether the file at `argv1` (process.argv[1]) is this module (`moduleUrl`). ESM resolves the entry
 * module to its REAL path while process.argv[1] keeps the path as typed, so a script reached through
 * a junction or a symbolic link has a URL different from its argv; compared as URLs alone, that run
 * printed nothing, did nothing and exited 0. The real paths of both are compared as well.
 */
export function isEntryPoint(argv1, moduleUrl, realpath = fs.realpathSync.native) {
  if (!argv1) return false
  if (moduleUrl === pathToFileURL(argv1).href) return true
  try {
    return realpath(argv1) === realpath(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code
  })
}
