// stock-preparation-migrate-legacy-operator-role.test.mjs — the legacy floor-role move (R-39, ADR
// adr-stock-prep-project-sheets-20261008 §11.2-1 / §8 step 3), driven in-process against a FAKE pg
// client. No database, no network. One test runs the script as a subprocess through a directory
// junction / symbolic link (the entry check), on a throwaway copy under the OS temp directory, and
// stops before any connection (its `--root` has no `pg`).
//
// THE FAKE IS STRICT. It answers only the statements written out below as golden text (whitespace-
// normalised) and throws on anything else, so an edit to the script's SQL — a dropped `subject_type =
// 'role'`, a widened WHERE, an extra statement — cannot pass by being silently "understood". Each
// golden statement is implemented over in-memory tables using the BOUND PARAMETERS, so a swapped or
// widened parameter changes the resulting state and the state assertions catch it. Transactions are
// modelled (BEGIN snapshots, ROLLBACK restores, READ ONLY rejects writes) so "the dry run writes
// nothing" is checked twice: no write statement is ever issued, and the state is identical after.
//
// The SQL itself is exercised against real PostgreSQL in CI by the S5a case appended to
// packages/core-backend/tests/integration/elearning-role-templates.db.test.ts.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT_PATH = path.join(ROOT_DIR, 'scripts', 'ops', 'stock-preparation-migrate-legacy-operator-role.mjs')
const {
  main, run, OLD_ROLE_ID, TARGET_ROLE_ID, EXIT_OK, EXIT_FAILURE, EXIT_REFUSED,
  RECOMMENDED_SPLIT_ROLE_ID, DEFAULT_SPLIT_ROLE_NAME, parseArgs, splitRoleIdProblem, splitRoleNameProblem,
  STOCK_PREP_BUILTIN_ROLE_DISPLAY_NAMES, isEntryPoint, databaseUrlFromAppEnvText,
  SQL, JS_TRIM_CODE_POINTS, JS_TRIM_SET_SQL,
} = await import(pathToFileURL(SCRIPT_PATH).href)

const OLD = 'stock-prep-operator'
const TARGET = 'stock-prep_frontline'
const OTHER = 'stock-prep_puller'

const norm = (text) => text.replace(/\s+/g, ' ').trim()

// The second argument of every SQL btrim (#6348 follow-up): the code points String.prototype.trim
// strips, written out by hand so a change to the script's set fails the goldens too.
const TRIM_GOLDEN = "U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF'"

// ── golden statements ──────────────────────────────────────────────────────────────────────────
const ROLE_KEYS_GOLDEN = `WITH role_keys AS ( SELECT k.role_key FROM ( SELECT btrim($1::text, ${TRIM_GOLDEN}) AS role_key UNION SELECT btrim(r.name, ${TRIM_GOLDEN}) FROM roles r WHERE r.id = $1 AND r.name IS NOT NULL ) k WHERE k.role_key <> '' )`
const GRAPH_PATHS_GOLDEN = [
  '$.nodes[*].config ? (@.assigneeType == "role").assigneeIds[*] ? (@ == $k)',
  '$.nodes[*].config.assigneeSources[*] ? (@.kind == "static_role").roleIds[*] ? (@ == $k)',
  '$.nodes[*].config.emptyAssigneeFallback.roleIds[*] ? (@ == $k)',
  '$.nodes[*].config ? (@.targetType == "role").targetIds[*] ? (@ == $k)',
  '$.nodes[*].config.assigneeSources[*] ? (@.kind == "requester_choice").scope ? (@.type == "role").roleIds[*] ? (@ == $k)',
]
const graphGolden = (column) => `( ${GRAPH_PATHS_GOLDEN.map((p) => `jsonb_path_exists(${column}, '${p}', jsonb_build_object('k', k.role_key))`).join(' OR ')} )`
const G = {
  begin: 'BEGIN',
  readOnly: 'SET TRANSACTION READ ONLY',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  tableExists: "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1",
  columnExists: 'SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
  rolesRead: 'SELECT id FROM roles WHERE id IN ($1, $2) ORDER BY id',
  roleApprovalUsable: 'SELECT id, approval_usable FROM roles WHERE id = ANY($1::text[]) ORDER BY id',
  rolesLock: 'SELECT id FROM roles WHERE id IN ($1, $2) ORDER BY id FOR UPDATE',
  oldMembers: 'SELECT count(*)::int AS count FROM user_roles WHERE role_id = $1',
  sharedMembers: 'SELECT count(*)::int AS count FROM user_roles o WHERE o.role_id = $1 AND EXISTS (SELECT 1 FROM user_roles t WHERE t.role_id = $2 AND t.user_id = o.user_id)',
  targetOnlyMembers: 'SELECT count(*)::int AS count FROM user_roles t WHERE t.role_id = $2 AND NOT EXISTS (SELECT 1 FROM user_roles o WHERE o.role_id = $1 AND o.user_id = t.user_id)',
  oldCodesMissingOnTarget: 'SELECT o.permission_code FROM role_permissions o WHERE o.role_id = $1 AND NOT EXISTS (SELECT 1 FROM role_permissions t WHERE t.role_id = $2 AND t.permission_code = o.permission_code) ORDER BY o.permission_code',
  oldCodeCount: 'SELECT count(*)::int AS count FROM role_permissions WHERE role_id = $1',
  targetCodesMissingOnOld: 'SELECT t.permission_code FROM role_permissions t WHERE t.role_id = $2 AND NOT EXISTS (SELECT 1 FROM role_permissions o WHERE o.role_id = $1 AND o.permission_code = t.permission_code) ORDER BY t.permission_code',
  targetSheetGrantsMissingOnOld: "SELECT count(*)::int AS count FROM spreadsheet_permissions t WHERE t.subject_type = 'role' AND t.subject_id = $2 AND NOT EXISTS ( SELECT 1 FROM spreadsheet_permissions o WHERE o.subject_type = 'role' AND o.subject_id = $1 AND o.sheet_id = t.sheet_id AND o.perm_code = t.perm_code )",
  pendingOldRoleInvites: "SELECT count(*)::int AS count FROM user_invites WHERE role_id = $1 AND status = 'pending'",
  oldSheetGrants: "SELECT count(*)::int AS count FROM spreadsheet_permissions WHERE subject_type = 'role' AND subject_id = $1",
  sharedSheetGrants: "SELECT count(*)::int AS count FROM spreadsheet_permissions o WHERE o.subject_type = 'role' AND o.subject_id = $1 AND EXISTS ( SELECT 1 FROM spreadsheet_permissions t WHERE t.subject_type = 'role' AND t.subject_id = $2 AND t.sheet_id = o.sheet_id AND t.perm_code = o.perm_code )",
  activeRoleApprovals: "SELECT count(*)::int AS count FROM approval_assignments WHERE assignment_type = 'role' AND assignee_id = $1 AND is_active = TRUE",
  // Approval READ through a role: no is_active filter (the read arm is is_active-insensitive); keys
  // are the role id and its trimmed display name, minus what the other role of the pair carries.
  approvalRoleSeats: `WITH role_read_keys AS ( SELECT k.role_key FROM ( SELECT btrim($1::text, ${TRIM_GOLDEN}) AS role_key UNION SELECT btrim(r.name, ${TRIM_GOLDEN}) FROM roles r WHERE r.id = $1 AND r.name IS NOT NULL ) k WHERE k.role_key <> '' AND k.role_key <> btrim($2::text, ${TRIM_GOLDEN}) AND NOT EXISTS (SELECT 1 FROM roles t WHERE t.id = $2 AND btrim(t.name, ${TRIM_GOLDEN}) = k.role_key) ) SELECT count(*)::int AS count FROM approval_assignments a WHERE a.assignment_type = 'role' AND a.assignee_id IN (SELECT role_key FROM role_read_keys)`,
  approvalRoleCcRecords: `WITH role_read_keys AS ( SELECT k.role_key FROM ( SELECT btrim($1::text, ${TRIM_GOLDEN}) AS role_key UNION SELECT btrim(r.name, ${TRIM_GOLDEN}) FROM roles r WHERE r.id = $1 AND r.name IS NOT NULL ) k WHERE k.role_key <> '' AND k.role_key <> btrim($2::text, ${TRIM_GOLDEN}) AND NOT EXISTS (SELECT 1 FROM roles t WHERE t.id = $2 AND btrim(t.name, ${TRIM_GOLDEN}) = k.role_key) ) SELECT count(*)::int AS count FROM approval_records rec WHERE rec.action = 'cc' AND rec.metadata->>'targetType' = 'role' AND rec.metadata->>'targetId' IN (SELECT role_key FROM role_read_keys)`,
  moveMembers: 'WITH moved AS ( DELETE FROM user_roles WHERE role_id = $1 RETURNING user_id ), inserted AS ( INSERT INTO user_roles (user_id, role_id) SELECT user_id, $2 FROM moved ON CONFLICT DO NOTHING RETURNING 1 ) SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM inserted)::int AS inserted',
  moveSheetGrants: "WITH moved AS ( DELETE FROM spreadsheet_permissions WHERE subject_type = 'role' AND subject_id = $1 RETURNING sheet_id, perm_code, created_at ), inserted AS ( INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code, created_at) SELECT sheet_id, NULL, 'role', $2, perm_code, created_at FROM moved ON CONFLICT (sheet_id, subject_type, subject_id, perm_code) DO NOTHING RETURNING 1 ) SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM inserted)::int AS inserted",
  deleteOldRoleCodes: 'DELETE FROM role_permissions WHERE role_id = $1',
  deleteOldRole: 'DELETE FROM roles WHERE id = $1',
  // ── approval designer census (owner 2026-10-12) ──
  approvalTemplateVersionsNamingRole: `${ROLE_KEYS_GOLDEN} SELECT count(*)::int AS count, count(DISTINCT v.template_id)::int AS templates FROM approval_template_versions v WHERE EXISTS (SELECT 1 FROM role_keys k WHERE ${graphGolden('v.approval_graph')})`,
  approvalPublishedDefinitionsNamingRole: `${ROLE_KEYS_GOLDEN} SELECT count(*)::int AS count, count(*) FILTER (WHERE d.is_active)::int AS active FROM approval_published_definitions d WHERE EXISTS (SELECT 1 FROM role_keys k WHERE ${graphGolden('d.runtime_graph')})`,
  // ── template visibility census (fix round 1): role-scoped visibility lists, keys in / keys out ──
  approvalTemplatesVisibleThrough: `WITH keys_in AS ( SELECT btrim(k, ${TRIM_GOLDEN}) AS role_key FROM unnest($1::text[]) AS k UNION SELECT btrim(r.name, ${TRIM_GOLDEN}) FROM roles r WHERE r.id = ANY($1::text[]) AND r.name IS NOT NULL UNION SELECT btrim(n, ${TRIM_GOLDEN}) FROM unnest($2::text[]) AS n ), keys_out AS ( SELECT btrim(k, ${TRIM_GOLDEN}) AS role_key FROM unnest($3::text[]) AS k UNION SELECT btrim(r.name, ${TRIM_GOLDEN}) FROM roles r WHERE r.id = ANY($3::text[]) AND r.name IS NOT NULL UNION SELECT btrim(n, ${TRIM_GOLDEN}) FROM unnest($4::text[]) AS n ) SELECT count(*)::int AS count FROM approval_templates t WHERE t.visibility_scope->>'type' = 'role' AND EXISTS ( SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.visibility_scope->'ids', '[]'::jsonb)) AS v(id) WHERE v.id IN (SELECT role_key FROM keys_in WHERE role_key <> '') ) AND NOT EXISTS ( SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.visibility_scope->'ids', '[]'::jsonb)) AS v(id) WHERE v.id IN (SELECT role_key FROM keys_out WHERE role_key <> '') )`,
  // ── the option ① split step ──
  lockTimeout: "SET LOCAL lock_timeout = '5s'",
  lockRoleTables: 'LOCK TABLE user_roles, role_permissions IN SHARE MODE',
  splitRoleRead: 'SELECT id, name FROM roles WHERE id = $1',
  splitRoleLock: 'SELECT id, name FROM roles WHERE id = $1 FOR UPDATE',
  roleCodes: 'SELECT permission_code FROM role_permissions WHERE role_id = $1 ORDER BY permission_code',
  splitNameTaken: `SELECT count(*)::int AS count FROM roles WHERE id <> $1 AND btrim(name, ${TRIM_GOLDEN}) = btrim($2::text, ${TRIM_GOLDEN})`,
  splitApprovalSeats: `SELECT count(*)::int AS count FROM approval_assignments WHERE assignment_type = 'role' AND assignee_id IN (btrim($1::text, ${TRIM_GOLDEN}), btrim($2::text, ${TRIM_GOLDEN}))`,
  splitApprovalCcRecords: `SELECT count(*)::int AS count FROM approval_records WHERE action = 'cc' AND metadata->>'targetType' = 'role' AND metadata->>'targetId' IN (btrim($1::text, ${TRIM_GOLDEN}), btrim($2::text, ${TRIM_GOLDEN}))`,
  delegatedAdminRoleIds: `SELECT DISTINCT btrim(r.role_id, ${TRIM_GOLDEN}) AS id FROM (SELECT id AS role_id FROM roles UNION SELECT role_id FROM user_roles UNION SELECT role_id FROM role_permissions) r WHERE right(btrim(r.role_id, ${TRIM_GOLDEN}), 6) = '_admin'`,
  catalogueCodes: 'SELECT DISTINCT code AS code FROM permissions',
  roleCodesAll: 'SELECT DISTINCT permission_code AS code FROM role_permissions',
  userCodesAll: 'SELECT DISTINCT permission_code AS code FROM user_permissions',
  savepoint: 'SAVEPOINT stock_prep_operator_split',
  rollbackToSavepoint: 'ROLLBACK TO SAVEPOINT stock_prep_operator_split',
  releaseSavepoint: 'RELEASE SAVEPOINT stock_prep_operator_split',
  insertSplitRole: 'INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id',
  insertSplitCodes: 'INSERT INTO role_permissions (role_id, permission_code) SELECT $1, code FROM unnest($2::text[]) AS code ON CONFLICT (role_id, permission_code) DO NOTHING RETURNING 1',
  addSplitMembers: 'INSERT INTO user_roles (user_id, role_id) SELECT user_id, $2 FROM user_roles WHERE role_id = $1 ON CONFLICT DO NOTHING RETURNING 1',
  removeExtraCodes: 'DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = ANY($2::text[]) RETURNING permission_code',
}
const UNMOVED_TABLES = ['meta_view_permissions', 'field_permissions', 'record_permissions', 'meta_history_audit_grants']
const unmovedGolden = (table) => `SELECT count(*)::int AS count FROM ${table} WHERE subject_type = 'role' AND subject_id = $1`
const WRITE_KEYS = new Set(['moveMembers', 'moveSheetGrants', 'deleteOldRoleCodes', 'deleteOldRole', 'insertSplitRole', 'insertSplitCodes', 'addSplitMembers', 'removeExtraCodes'])
const LOCK_KEYS = new Set(['lockTimeout', 'lockRoleTables'])

// ── the fake ───────────────────────────────────────────────────────────────────────────────────
// The target is a freshly seeded stock-prep_frontline (read + operate, no grant row, no approval
// task), so moving the old role's members gains them nothing; the gains tests widen it.
function baseState() {
  return {
    tables: new Set(['roles', 'user_roles', 'role_permissions', 'spreadsheet_permissions', ...UNMOVED_TABLES, 'approval_assignments', 'approval_records', 'user_invites', 'permissions', 'user_permissions', 'approval_template_versions', 'approval_published_definitions', 'approval_templates']),
    // `roles.approval_usable` exists (zzzz20260627150000); a role without the field reads as the
    // column default, false.
    approvalUsableColumn: true,
    roles: [
      { id: OLD, name: 'legacy floor' },
      { id: TARGET, name: '一线填写' },
      { id: OTHER, name: 'puller' },
      { id: 'unrelated', name: 'unrelated' },
    ],
    rolePermissions: [
      { role_id: OLD, permission_code: 'stock-prep:operate' },
      { role_id: OLD, permission_code: 'stock-prep:read' },
      { role_id: TARGET, permission_code: 'stock-prep:operate' },
      { role_id: TARGET, permission_code: 'stock-prep:read' },
      { role_id: OTHER, permission_code: 'stock-prep:pull' },
      { role_id: 'unrelated', permission_code: 'approvals:read' },
    ],
    userRoles: [
      { user_id: 'user-a', role_id: OLD },
      { user_id: 'user-b', role_id: OLD },
      { user_id: 'user-b', role_id: TARGET },
      { user_id: 'user-c', role_id: OTHER },
      { user_id: 'user-a', role_id: 'unrelated' },
    ],
    sheetGrants: [
      { sheet_id: 'sheet-legacy', user_id: null, subject_type: 'role', subject_id: OLD, perm_code: 'spreadsheet:write', created_at: 't1' },
      { sheet_id: 'sheet-legacy', user_id: 'user-z', subject_type: 'user', subject_id: 'user-z', perm_code: 'spreadsheet:write', created_at: 't2' },
      { sheet_id: 'sheet-legacy', user_id: null, subject_type: 'member-group', subject_id: OLD, perm_code: 'spreadsheet:read', created_at: 't3' },
      { sheet_id: 'sheet-project', user_id: null, subject_type: 'role', subject_id: OTHER, perm_code: 'spreadsheet:write', created_at: 't4' },
    ],
    unmoved: Object.fromEntries(UNMOVED_TABLES.map((table) => [table, [{ subject_type: 'role', subject_id: OTHER }]])),
    // None of these gives a member of OLD or TARGET approval read access through the role: another
    // role's seats, a USER seat and a source_queue seat that merely carry the old id as assignee.
    approvalAssignments: [
      { assignment_type: 'role', assignee_id: 'unrelated', is_active: false },
      { assignment_type: 'role', assignee_id: OTHER, is_active: true },
      { assignment_type: 'user', assignee_id: OLD, is_active: true },
      { assignment_type: 'source_queue', assignee_id: OLD, is_active: false },
    ],
    // Likewise: a CC to another role, a CC to a USER carrying the old id, a non-CC record.
    approvalRecords: [
      { action: 'cc', metadata: { targetType: 'role', targetId: OTHER } },
      { action: 'cc', metadata: { targetType: 'user', targetId: OLD } },
      { action: 'approve', metadata: { targetType: 'role', targetId: OLD } },
    ],
    // Only a PENDING invite naming the old role blocks the delete: accepted / revoked ones and other
    // roles' pending ones do not.
    invites: [
      { role_id: OLD, status: 'accepted' },
      { role_id: OLD, status: 'revoked' },
      { role_id: OTHER, status: 'pending' },
    ],
    // The permission catalogue and direct user codes (read only by the split step's namespace check).
    catalogue: ['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull', 'stock-prep:admin', 'approvals:read', 'approvals:write', 'approvals:admin', 'multitable:submit-approval', 'attendance:read'],
    userPermissions: [{ user_id: 'user-c', permission_code: 'approvals:read' }],
    // Approval designer graphs (census only). None of these names the old role as a ROLE target.
    templateVersions: [
      { template_id: 'tpl-1', approval_graph: { nodes: [{ key: 'n', type: 'approval', config: { assigneeType: 'user', assigneeIds: [OLD] } }] } },
      { template_id: 'tpl-1', approval_graph: { nodes: [{ key: 'n', type: 'cc', config: { targetType: 'group', targetIds: [OLD] } }] } },
      { template_id: 'tpl-2', approval_graph: { nodes: [{ key: 'n', type: 'approval', config: { assigneeType: 'role', assigneeIds: [OTHER] } }] } },
    ],
    publishedDefinitions: [
      { is_active: true, runtime_graph: { nodes: [{ key: 'n', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: [OLD] }] } }] } },
    ],
    // Approval templates' visibility scopes (census only). None is a ROLE-typed list naming the old
    // role, the target or the split role: 'all', a dept / user list carrying the old id, another role.
    templates: [
      { visibility_scope: { type: 'all', ids: [] } },
      { visibility_scope: { type: 'dept', ids: [OLD, TARGET] } },
      { visibility_scope: { type: 'user', ids: [OLD] } },
      { visibility_scope: { type: 'role', ids: [OTHER] } },
    ],
  }
}

const clone = (state) => ({ ...structuredClone({ ...state, tables: [...state.tables] }), tables: new Set(state.tables) })
const snapshot = (state) => JSON.stringify({ ...state, tables: [...state.tables].sort() })
const countRows = (n) => ({ rows: [{ count: n }] })

function makeFakeClient(state, { failOn = null, afterWrite = null } = {}) {
  const calls = []
  let saved = null
  let savepoint = null
  let readOnly = false
  const handlers = new Map()
  const on = (text, fn) => handlers.set(norm(text), fn)

  on(G.begin, () => { saved = clone(state); readOnly = false; return { rows: [] } })
  on(G.readOnly, () => { readOnly = true; return { rows: [] } })
  on(G.commit, () => { saved = null; readOnly = false; return { rows: [] } })
  on(G.rollback, () => {
    if (saved) Object.assign(state, saved)
    saved = null
    readOnly = false
    return { rows: [] }
  })
  on(G.tableExists, ([table]) => countRows(state.tables.has(table) ? 1 : 0))
  on(G.columnExists, ([table, column]) => countRows(table === 'roles' && column === 'approval_usable' && state.approvalUsableColumn ? 1 : 0))
  on(G.roleApprovalUsable, ([ids]) => {
    if (!state.approvalUsableColumn) throw new Error('FAKE_PG: column roles.approval_usable does not exist')
    return { rows: state.roles.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, approval_usable: r.approval_usable === true })).sort((x, y) => x.id.localeCompare(y.id)) }
  })
  const rolesIn = ([a, b]) => ({ rows: state.roles.filter((r) => r.id === a || r.id === b).map((r) => ({ id: r.id })).sort((x, y) => x.id.localeCompare(y.id)) })
  on(G.rolesRead, rolesIn)
  on(G.rolesLock, rolesIn)
  const membersOf = (role) => state.userRoles.filter((r) => r.role_id === role).map((r) => r.user_id)
  on(G.oldMembers, ([old]) => countRows(membersOf(old).length))
  on(G.sharedMembers, ([old, target]) => countRows(membersOf(old).filter((u) => membersOf(target).includes(u)).length))
  on(G.targetOnlyMembers, ([old, target]) => countRows(membersOf(target).filter((u) => !membersOf(old).includes(u)).length))
  const codesOf = (role) => state.rolePermissions.filter((r) => r.role_id === role).map((r) => r.permission_code)
  on(G.oldCodesMissingOnTarget, ([old, target]) => ({ rows: codesOf(old).filter((c) => !codesOf(target).includes(c)).sort().map((permission_code) => ({ permission_code })) }))
  on(G.oldCodeCount, ([old]) => countRows(codesOf(old).length))
  on(G.targetCodesMissingOnOld, ([old, target]) => ({ rows: codesOf(target).filter((c) => !codesOf(old).includes(c)).sort().map((permission_code) => ({ permission_code })) }))
  const roleGrants = (role) => state.sheetGrants.filter((g) => g.subject_type === 'role' && g.subject_id === role)
  on(G.oldSheetGrants, ([old]) => countRows(roleGrants(old).length))
  on(G.sharedSheetGrants, ([old, target]) => countRows(roleGrants(old).filter((o) => roleGrants(target).some((t) => t.sheet_id === o.sheet_id && t.perm_code === o.perm_code)).length))
  on(G.targetSheetGrantsMissingOnOld, ([old, target]) => countRows(roleGrants(target).filter((t) => !roleGrants(old).some((o) => o.sheet_id === t.sheet_id && o.perm_code === t.perm_code)).length))
  on(G.pendingOldRoleInvites, ([old]) => countRows(state.invites.filter((i) => i.role_id === old && i.status === 'pending').length))
  for (const table of UNMOVED_TABLES) {
    on(unmovedGolden(table), ([old]) => countRows(state.unmoved[table].filter((r) => r.subject_type === 'role' && r.subject_id === old).length))
  }
  on(G.activeRoleApprovals, ([old]) => countRows(state.approvalAssignments.filter((a) => a.assignment_type === 'role' && a.assignee_id === old && a.is_active === true).length))
  // role_read_keys: the subject role's id and trimmed name, minus the other role's id and name.
  const readKeys = ([subject, other]) => {
    const keys = new Set([subject.trim()])
    const role = state.roles.find((r) => r.id === subject)
    if (role && role.name != null) keys.add(role.name.trim())
    const otherRole = state.roles.find((r) => r.id === other)
    return [...keys].filter((k) => k !== '' && k !== other.trim() && !(otherRole && otherRole.name != null && otherRole.name.trim() === k))
  }
  on(G.approvalRoleSeats, (params) => {
    const keys = readKeys(params)
    return countRows(state.approvalAssignments.filter((a) => a.assignment_type === 'role' && keys.includes(a.assignee_id)).length)
  })
  on(G.approvalRoleCcRecords, (params) => {
    const keys = readKeys(params)
    return countRows(state.approvalRecords.filter((r) => r.action === 'cc' && r.metadata?.targetType === 'role' && keys.includes(r.metadata?.targetId)).length)
  })
  on(G.moveMembers, ([old, target]) => {
    const moved = state.userRoles.filter((r) => r.role_id === old)
    state.userRoles = state.userRoles.filter((r) => r.role_id !== old)
    let inserted = 0
    for (const { user_id } of moved) {
      if (state.userRoles.some((r) => r.user_id === user_id && r.role_id === target)) continue
      state.userRoles.push({ user_id, role_id: target })
      inserted += 1
    }
    return { rows: [{ moved: moved.length, inserted }] }
  })
  on(G.moveSheetGrants, ([old, target]) => {
    const moved = state.sheetGrants.filter((g) => g.subject_type === 'role' && g.subject_id === old)
    state.sheetGrants = state.sheetGrants.filter((g) => !(g.subject_type === 'role' && g.subject_id === old))
    let inserted = 0
    for (const { sheet_id, perm_code, created_at } of moved) {
      if (state.sheetGrants.some((g) => g.sheet_id === sheet_id && g.subject_type === 'role' && g.subject_id === target && g.perm_code === perm_code)) continue
      state.sheetGrants.push({ sheet_id, user_id: null, subject_type: 'role', subject_id: target, perm_code, created_at })
      inserted += 1
    }
    return { rows: [{ moved: moved.length, inserted }] }
  })
  on(G.deleteOldRoleCodes, ([old]) => { state.rolePermissions = state.rolePermissions.filter((r) => r.role_id !== old); return { rows: [] } })
  on(G.deleteOldRole, ([old]) => { state.roles = state.roles.filter((r) => r.id !== old); return { rows: [] } })

  // ── approval designer census: the role's id and trimmed display name as ROLE targets ──
  const roleKeys = (roleId) => {
    const keys = new Set([roleId.trim()])
    const role = state.roles.find((r) => r.id === roleId)
    if (role && role.name != null) keys.add(role.name.trim())
    return [...keys].filter((k) => k !== '')
  }
  const graphNamesRole = (graph, keys) => (graph?.nodes ?? []).some((node) => {
    const c = node?.config ?? {}
    const has = (list) => Array.isArray(list) && list.some((value) => keys.includes(value))
    return (c.assigneeType === 'role' && has(c.assigneeIds))
      || (Array.isArray(c.assigneeSources) && c.assigneeSources.some((source) => source?.kind === 'static_role' && has(source.roleIds)))
      || has(c.emptyAssigneeFallback?.roleIds)
      || (c.targetType === 'role' && has(c.targetIds))
      || (Array.isArray(c.assigneeSources) && c.assigneeSources.some((source) => source?.kind === 'requester_choice' && source.scope?.type === 'role' && has(source.scope.roleIds)))
  })
  on(G.approvalTemplateVersionsNamingRole, ([roleId]) => {
    const keys = roleKeys(roleId)
    const hits = state.templateVersions.filter((v) => graphNamesRole(v.approval_graph, keys))
    return { rows: [{ count: hits.length, templates: new Set(hits.map((v) => v.template_id)).size }] }
  })
  on(G.approvalPublishedDefinitionsNamingRole, ([roleId]) => {
    const keys = roleKeys(roleId)
    const hits = state.publishedDefinitions.filter((d) => graphNamesRole(d.runtime_graph, keys))
    return { rows: [{ count: hits.length, active: hits.filter((d) => d.is_active).length }] }
  })

  // keys: the given role ids, the trimmed display names of the roles under them, the extra names.
  const visibilityKeys = (ids, names) => {
    const keys = new Set([...ids.map((id) => id.trim()), ...names.map((name) => name.trim())])
    for (const role of state.roles) if (ids.includes(role.id) && role.name != null) keys.add(role.name.trim())
    return [...keys].filter((k) => k !== '')
  }
  on(G.approvalTemplatesVisibleThrough, ([idsIn, namesIn, idsOut, namesOut]) => {
    const keysIn = visibilityKeys(idsIn, namesIn)
    const keysOut = visibilityKeys(idsOut, namesOut)
    return countRows(state.templates.filter((t) => t.visibility_scope?.type === 'role'
      && (t.visibility_scope.ids ?? []).some((id) => keysIn.includes(id))
      && !(t.visibility_scope.ids ?? []).some((id) => keysOut.includes(id))).length)
  })

  // ── the split step ──
  on(G.lockTimeout, () => ({ rows: [] }))
  on(G.lockRoleTables, () => ({ rows: [] }))
  const roleRow = ([id]) => ({ rows: state.roles.filter((r) => r.id === id).map((r) => ({ id: r.id, name: r.name })) })
  on(G.splitRoleRead, roleRow)
  on(G.splitRoleLock, roleRow)
  on(G.roleCodes, ([id]) => ({ rows: codesOf(id).sort().map((permission_code) => ({ permission_code })) }))
  on(G.splitNameTaken, ([id, name]) => countRows(state.roles.filter((r) => r.id !== id && (r.name ?? '').trim() === name.trim()).length))
  on(G.splitApprovalSeats, ([id, name]) => countRows(state.approvalAssignments.filter((a) => a.assignment_type === 'role' && [id.trim(), name.trim()].includes(a.assignee_id)).length))
  on(G.splitApprovalCcRecords, ([id, name]) => countRows(state.approvalRecords.filter((r) => r.action === 'cc' && r.metadata?.targetType === 'role' && [id.trim(), name.trim()].includes(r.metadata?.targetId)).length))
  on(G.delegatedAdminRoleIds, () => {
    const ids = new Set([...state.roles.map((r) => r.id), ...state.userRoles.map((r) => r.role_id), ...state.rolePermissions.map((r) => r.role_id)].map((id) => id.trim()).filter((id) => id.endsWith('_admin')))
    return { rows: [...ids].map((id) => ({ id })) }
  })
  on(G.catalogueCodes, () => ({ rows: [...new Set(state.catalogue)].map((code) => ({ code })) }))
  on(G.roleCodesAll, () => ({ rows: [...new Set(state.rolePermissions.map((r) => r.permission_code))].map((code) => ({ code })) }))
  on(G.userCodesAll, () => ({ rows: [...new Set(state.userPermissions.map((r) => r.permission_code))].map((code) => ({ code })) }))
  on(G.savepoint, () => { savepoint = clone(state); return { rows: [] } })
  on(G.rollbackToSavepoint, () => { if (savepoint) Object.assign(state, clone(savepoint)); return { rows: [] } })
  on(G.releaseSavepoint, () => { savepoint = null; return { rows: [] } })
  on(G.insertSplitRole, ([id, name]) => {
    if (state.roles.some((r) => r.id === id)) return { rows: [] }
    state.roles.push({ id, name })
    return { rows: [{ id }] }
  })
  on(G.insertSplitCodes, ([id, codes]) => {
    const rows = []
    for (const code of codes) {
      if (state.rolePermissions.some((r) => r.role_id === id && r.permission_code === code)) continue
      state.rolePermissions.push({ role_id: id, permission_code: code })
      rows.push({ '?column?': 1 })
    }
    return { rows }
  })
  on(G.addSplitMembers, ([old, splitId]) => {
    const rows = []
    for (const userId of membersOf(old)) {
      if (state.userRoles.some((r) => r.user_id === userId && r.role_id === splitId)) continue
      state.userRoles.push({ user_id: userId, role_id: splitId })
      rows.push({ '?column?': 1 })
    }
    return { rows }
  })
  on(G.removeExtraCodes, ([old, codes]) => {
    const removed = state.rolePermissions.filter((r) => r.role_id === old && codes.includes(r.permission_code))
    state.rolePermissions = state.rolePermissions.filter((r) => !(r.role_id === old && codes.includes(r.permission_code)))
    return { rows: removed.map((r) => ({ permission_code: r.permission_code })) }
  })

  const keyOf = new Map([...Object.entries(G)].map(([key, text]) => [norm(text), key]))
  const client = {
    calls,
    connected: false,
    ended: false,
    async connect() { this.connected = true },
    async end() { this.ended = true },
    async query(text, params = []) {
      const normalized = norm(text)
      const handler = handlers.get(normalized)
      if (!handler) throw new Error(`FAKE_PG_UNKNOWN_STATEMENT: ${normalized.slice(0, 120)}`)
      const key = keyOf.get(normalized) ?? 'unmovedRoleRows'
      calls.push({ key, sql: normalized, params: [...params] })
      if (failOn === key) {
        const error = new Error(`duplicate key value violates unique constraint; Key (user_id)=(user-a) already exists`)
        error.code = '23505'
        throw error
      }
      if (readOnly && (WRITE_KEYS.has(key) || LOCK_KEYS.has(key))) {
        const error = new Error('cannot execute statement in a read-only transaction')
        error.code = '25006'
        throw error
      }
      const result = handler(params)
      // A write another session commits between two of our statements (READ COMMITTED).
      if (afterWrite && WRITE_KEYS.has(key)) afterWrite(key, state)
      return result
    },
  }
  return client
}

async function runMain(argv, state, options = {}) {
  const out = []
  const err = []
  let client = null
  const code = await main(argv, { DATABASE_URL: 'postgres://fake' }, {
    createClient: async () => {
      client = makeFakeClient(state, options)
      return client
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out, err, client, writes: client ? client.calls.filter((c) => WRITE_KEYS.has(c.key)) : [] }
}

function assertValuesFree(lines) {
  const text = lines.join('\n')
  for (const value of ['user-a', 'user-b', 'user-c', 'user-z', 'sheet-legacy', 'sheet-project', 'postgres://fake', 'legacy floor', 'OPM custom split name']) {
    assert.ok(!text.includes(value), `output must not carry the value ${value}`)
  }
}

// ── tests ──────────────────────────────────────────────────────────────────────────────────────

test('the role ids are the ADR literals', () => {
  assert.equal(OLD_ROLE_ID, OLD)
  assert.equal(TARGET_ROLE_ID, TARGET)
})

test('usage: unknown or inexact flags, a lone --delete-empty-old-role and a missing DATABASE_URL all exit 1 without connecting', async () => {
  for (const argv of [['--apply=true'], ['--APPLY'], ['--delete-empty-old-role'], ['postgres://secret-in-argv']]) {
    let connected = false
    const err = []
    const code = await main(argv, { DATABASE_URL: 'postgres://fake' }, { createClient: async () => { connected = true; return makeFakeClient(baseState()) }, out: () => {}, err: (line) => err.push(line) })
    assert.equal(code, EXIT_FAILURE, `argv ${argv.length} item(s) must be a usage error`)
    assert.equal(connected, false)
    assert.ok(!err.join('\n').includes('secret-in-argv'), 'an unknown argument is never echoed')
  }
  let connected = false
  const code = await main([], {}, { createClient: async () => { connected = true; return makeFakeClient(baseState()) }, out: () => {}, err: () => {} })
  assert.equal(code, EXIT_FAILURE)
  assert.equal(connected, false)
})

test('dry run: zero write statements, READ ONLY transaction, rolled back, state byte-identical, values-free counts', async () => {
  const state = baseState()
  const before = snapshot(state)
  const { code, out, client, writes } = await runMain([], state)
  assert.equal(code, EXIT_OK)
  assert.deepEqual(writes, [])
  assert.deepEqual(client.calls.slice(0, 2).map((c) => c.key), ['begin', 'readOnly'])
  assert.equal(client.calls.at(-1).key, 'rollback')
  assert.ok(!client.calls.some((c) => c.key === 'commit'))
  assert.ok(!client.calls.some((c) => c.key === 'rolesLock'), 'no FOR UPDATE in a read-only run')
  assert.equal(snapshot(state), before)
  assert.ok(out.some((line) => line.includes('--apply would move 2 membership(s) and 1 table grant(s)')))
  assert.ok(out.some((line) => line === 'dry run: nothing written'))
  // a freshly seeded target: the dry run shows the gains, all zero, and who they would reach
  for (const line of [
    `gains — codes on ${TARGET} not held by ${OLD}: 0`,
    `gains — role-subject table grants of ${TARGET} not held by ${OLD}: 0`,
    ...UNMOVED_TABLES.map((table) => `gains — role-subject rows of ${TARGET} in ${table}: 0`),
    `gains — active role-assigned approval tasks of ${TARGET}: 0`,
    `gains — role-typed approval seats of ${TARGET} in any state, not reachable through ${OLD}: 0`,
    `gains — role-targeted approval CC records of ${TARGET}, not reachable through ${OLD}: 0`,
    `gains — members who would gain them (in ${OLD}, not yet in ${TARGET}): 1`,
    // the approval read access the old role carries: none in the base state (only decoys)
    `approval read through ${OLD} — role-typed seats in any state (by role id or display name): 0`,
    `approval read through ${OLD} — role-targeted CC records (by role id or display name): 0`,
    `pending invites naming ${OLD}: 0`,
    `dry run: with --apply --delete-empty-old-role, ${OLD} would then be deleted`,
  ]) assert.ok(out.includes(line), `dry-run output must carry: ${line}`)
  assertValuesFree(out)
  assert.equal(client.ended, true)
})

test('apply: moves exactly the old role\'s memberships and ROLE-subject table grants, nothing else', async () => {
  const state = baseState()
  const before = baseState()
  const { code, out, client, writes } = await runMain(['--apply'], state)
  assert.equal(code, EXIT_OK)
  assert.deepEqual(writes.map((w) => w.key), ['moveMembers', 'moveSheetGrants'])
  for (const write of writes) assert.deepEqual(write.params, [OLD, TARGET], 'a move binds only the two literal role ids')
  assert.equal(client.calls.at(-1).key, 'commit')
  assert.ok(client.calls.some((c) => c.key === 'rolesLock'), 'apply locks both role rows')

  // memberships: old emptied, target = union, every other role untouched
  assert.deepEqual(state.userRoles.filter((r) => r.role_id === OLD), [])
  assert.deepEqual(state.userRoles.filter((r) => r.role_id === TARGET).map((r) => r.user_id).sort(), ['user-a', 'user-b'])
  assert.deepEqual(state.userRoles.filter((r) => r.role_id !== OLD && r.role_id !== TARGET), before.userRoles.filter((r) => r.role_id !== OLD && r.role_id !== TARGET))

  // grants: the one role-subject row moved (same sheet, level, created_at); user / member-group / other-role rows identical
  assert.deepEqual(state.sheetGrants.filter((g) => g.subject_type === 'role' && g.subject_id === OLD), [])
  assert.deepEqual(
    state.sheetGrants.find((g) => g.sheet_id === 'sheet-legacy' && g.subject_type === 'role'),
    { sheet_id: 'sheet-legacy', user_id: null, subject_type: 'role', subject_id: TARGET, perm_code: 'spreadsheet:write', created_at: 't1' },
  )
  const untouched = (g) => !(g.subject_type === 'role' && (g.subject_id === OLD || (g.subject_id === TARGET && g.sheet_id === 'sheet-legacy')))
  assert.deepEqual(state.sheetGrants.filter(untouched), before.sheetGrants.filter(untouched))
  assert.ok(state.sheetGrants.some((g) => g.subject_type === 'member-group' && g.subject_id === OLD), 'a member-group subject that happens to share the id is not a role subject')

  // roles and codes: nothing deleted or changed without --delete-empty-old-role
  assert.deepEqual(state.roles, before.roles)
  assert.deepEqual(state.rolePermissions, before.rolePermissions)
  assert.ok(out.some((line) => line.includes(`moved 2 membership(s) and 1 table grant(s); ${OLD} kept`)))
  assertValuesFree(out)
})

test('rerun after apply is a no-op: zero write statements, state unchanged', async () => {
  const state = baseState()
  assert.equal((await runMain(['--apply'], state)).code, EXIT_OK)
  const afterFirst = snapshot(state)
  const second = await runMain(['--apply'], state)
  assert.equal(second.code, EXIT_OK)
  assert.deepEqual(second.writes, [])
  assert.equal(snapshot(state), afterFirst)
  assert.ok(second.out.some((line) => line === 'apply: nothing to move; nothing written'))
})

test('refuses (exit 2, nothing written) while stock-prep_frontline does not exist — before the S5a migration', async () => {
  for (const argv of [[], ['--apply'], ['--apply', '--delete-empty-old-role']]) {
    const state = baseState()
    state.roles = state.roles.filter((r) => r.id !== TARGET)
    const before = snapshot(state)
    const { code, out, writes } = await runMain(argv, state)
    assert.equal(code, EXIT_REFUSED)
    assert.deepEqual(writes, [])
    assert.equal(snapshot(state), before)
    assert.ok(out.some((line) => line.includes(`${TARGET} does not exist`)))
  }
})

test('refuses when the old role holds codes the target lacks while it has members (they would lose them)', async () => {
  const state = baseState()
  state.rolePermissions.push({ role_id: OLD, permission_code: 'approvals:write' }, { role_id: OLD, permission_code: 'approvals:read' })
  const before = snapshot(state)
  const { code, out, writes } = await runMain(['--apply'], state)
  assert.equal(code, EXIT_REFUSED)
  assert.deepEqual(writes, [])
  assert.equal(snapshot(state), before)
  const lossLine = out.find((line) => line.includes('holds 2 code(s)') && line.includes('approvals:read, approvals:write'))
  assert.ok(lossLine)
  // ADR §8 step 3: option ① (a separate platform role) is the only supported resolution; the
  // message never suggests widening the built-in target with platform codes.
  assert.ok(lossLine.includes('option ①') && lossLine.includes('create a separate platform role'))
  assert.ok(!lossLine.includes('grant them to the target role'))
  assert.ok(lossLine.includes(`never add them to ${TARGET}`))
  assertValuesFree(out)
  // once the target holds them too, the same move proceeds
  state.rolePermissions.push({ role_id: TARGET, permission_code: 'approvals:write' }, { role_id: TARGET, permission_code: 'approvals:read' })
  assert.equal((await runMain(['--apply'], state)).code, EXIT_OK)
})

test('refuses when the old role is the subject of rows the script does not move, or of active role approvals', async () => {
  for (const table of UNMOVED_TABLES) {
    const state = baseState()
    state.unmoved[table].push({ subject_type: 'role', subject_id: OLD })
    const before = snapshot(state)
    const { code, out, writes } = await runMain(['--apply'], state)
    assert.equal(code, EXIT_REFUSED, table)
    assert.deepEqual(writes, [])
    assert.equal(snapshot(state), before)
    assert.ok(out.some((line) => line.includes(`1 row(s) in ${table}`)))
  }
  const state = baseState()
  state.approvalAssignments.push({ assignment_type: 'role', assignee_id: OLD, is_active: true })
  const { code, writes } = await runMain(['--apply'], state)
  assert.equal(code, EXIT_REFUSED)
  assert.deepEqual(writes, [])
})

// ── approval READ access through the old role (fix round 2) ─────────────────────────────────────
// canReadApprovalInstance admits a viewer through a role-typed seat in ANY state and through a
// role-targeted CC record; neither is moved, so members who leave the old role lose that read.

const SEAT_LINE = `approval read through ${OLD} — role-typed seats in any state (by role id or display name): `
const CC_LINE = `approval read through ${OLD} — role-targeted CC records (by role id or display name): `

async function assertApprovalReadLossRefused(state, { seats, cc }) {
  const before = snapshot(state)
  const dry = await runMain([], state)
  assert.equal(dry.code, EXIT_REFUSED, 'the dry run reaches the refusal too')
  assert.deepEqual(dry.writes, [])
  assert.ok(dry.out.includes(`${SEAT_LINE}${seats}`), `dry run prints the seat count ${seats}`)
  assert.ok(dry.out.includes(`${CC_LINE}${cc}`), `dry run prints the CC count ${cc}`)
  assert.ok(dry.out.some((line) => line.startsWith('--apply would refuse') && line.includes('would lose that read access')))
  const applied = await runMain(['--apply'], state)
  assert.equal(applied.code, EXIT_REFUSED)
  assert.deepEqual(applied.writes, [], 'refused before any move')
  assert.equal(snapshot(state), before)
  const refusal = applied.out.find((line) => line.startsWith('REFUSED') && line.includes('would lose that read access'))
  assert.ok(refusal, 'an approval-read refusal is printed')
  assert.ok(refusal.includes(`named by ${seats} role-typed approval seat(s)`) && refusal.includes(`and ${cc} role-targeted approval CC record(s)`))
  assert.ok(refusal.includes(`its 2 member(s)`))
  assertValuesFree([...dry.out, ...applied.out])
}

test('refuses while a role-typed approval seat in ANY state names the old role and it has members — an INACTIVE seat too (they would lose read access); the dry run prints the count', async () => {
  for (const isActive of [false, true]) {
    const state = baseState()
    state.approvalAssignments.push({ assignment_type: 'role', assignee_id: OLD, is_active: isActive })
    await assertApprovalReadLossRefused(state, { seats: 1, cc: 0 })
  }
})

test('refuses while a role-targeted approval CC record names the old role and it has members (they would lose read access); the dry run prints the count', async () => {
  const state = baseState()
  state.approvalRecords.push({ action: 'cc', metadata: { targetType: 'role', targetId: OLD } })
  await assertApprovalReadLossRefused(state, { seats: 0, cc: 1 })
})

test('approval read is matched by the old role\'s display NAME too (viewerRoles carries ids and names); a name the target also carries is kept by the move and does not count', async () => {
  const byName = baseState()
  byName.approvalAssignments.push({ assignment_type: 'role', assignee_id: 'legacy floor', is_active: false })
  byName.approvalRecords.push({ action: 'cc', metadata: { targetType: 'role', targetId: 'legacy floor' } })
  await assertApprovalReadLossRefused(byName, { seats: 1, cc: 1 })

  // the old role carries the target's display name: members keep that key through the target
  const shared = baseState()
  shared.roles.find((r) => r.id === OLD).name = ' 一线填写 '
  shared.approvalAssignments.push({ assignment_type: 'role', assignee_id: '一线填写', is_active: false })
  shared.approvalRecords.push({ action: 'cc', metadata: { targetType: 'role', targetId: '一线填写' } })
  const { code, out, writes } = await runMain(['--apply'], shared)
  assert.equal(code, EXIT_OK)
  assert.deepEqual(writes.map((w) => w.key), ['moveMembers', 'moveSheetGrants'])
  assert.ok(out.includes(`${SEAT_LINE}0`) && out.includes(`${CC_LINE}0`))
  assert.ok(out.includes(`gains — role-typed approval seats of ${TARGET} in any state, not reachable through ${OLD}: 0`))
})

test('--delete-empty-old-role refuses before any write while approval seats / CC records still name the old role (even with no member left); the post-move re-check catches one committed meanwhile', async () => {
  for (const [label, add] of [
    ['inactive seat', (s) => s.approvalAssignments.push({ assignment_type: 'role', assignee_id: OLD, is_active: false })],
    ['CC record', (s) => s.approvalRecords.push({ action: 'cc', metadata: { targetType: 'role', targetId: OLD } })],
  ]) {
    // no member and no grant left to move: the move itself has nothing to refuse
    const state = baseState()
    state.userRoles = state.userRoles.filter((r) => r.role_id !== OLD)
    state.sheetGrants = state.sheetGrants.filter((g) => !(g.subject_type === 'role' && g.subject_id === OLD))
    add(state)
    const before = snapshot(state)
    const plain = await runMain(['--apply'], state)
    assert.equal(plain.code, EXIT_OK, `${label}: without members nobody loses read access`)
    assert.deepEqual(plain.writes, [])
    const refused = await runMain(['--apply', '--delete-empty-old-role'], state)
    assert.equal(refused.code, EXIT_REFUSED, label)
    assert.deepEqual(refused.writes, [], `${label}: refused before any statement writes`)
    assert.equal(snapshot(state), before)
    assert.ok(refused.out.some((line) => line.startsWith('REFUSED: --delete-empty-old-role') && line.includes('role-targeted approval CC record(s) still name')), label)
    const dry = await runMain([], state)
    assert.equal(dry.code, EXIT_OK)
    const [seats, cc] = label === 'CC record' ? [0, 1] : [1, 0]
    assert.ok(dry.out.includes(`dry run: --apply --delete-empty-old-role would refuse: ${seats} role-typed approval seat(s) (any state) and ${cc} role-targeted approval CC record(s) still name ${OLD}`), label)
    assert.ok(!dry.out.some((line) => line.includes('would then be deleted')), label)
    assert.ok(state.roles.some((r) => r.id === OLD))

    // committed by another session between the pre-check and the delete: the re-read refuses
    const raced = baseState()
    const rawBefore = snapshot(raced)
    const late = (key, current) => {
      if (key === 'moveSheetGrants') add(current)
    }
    const run2 = await runMain(['--apply', '--delete-empty-old-role'], raced, { afterWrite: late })
    assert.equal(run2.code, EXIT_REFUSED, `${label} (late)`)
    assert.deepEqual(run2.writes.map((w) => w.key), ['moveMembers', 'moveSheetGrants'], `${label}: no delete statement is issued`)
    assert.equal(run2.client.calls.at(-1).key, 'rollback')
    assert.equal(snapshot(raced), rawBefore)
    assert.ok(run2.out.some((line) => line.includes('is not empty after the move')), label)
  }
})

test('refuses when role-typed approval seats (any state) or role-targeted CC records reach the target but not the old role (moved members would GAIN read access)', async () => {
  for (const [label, add] of [
    ['inactive seat on the target id', (s) => s.approvalAssignments.push({ assignment_type: 'role', assignee_id: TARGET, is_active: false })],
    ['seat on the target display name', (s) => s.approvalAssignments.push({ assignment_type: 'role', assignee_id: '一线填写', is_active: false })],
    ['CC to the target id', (s) => s.approvalRecords.push({ action: 'cc', metadata: { targetType: 'role', targetId: TARGET } })],
  ]) {
    const state = baseState()
    add(state)
    const before = snapshot(state)
    const { code, out, writes } = await runMain(['--apply'], state)
    assert.equal(code, EXIT_REFUSED, label)
    assert.deepEqual(writes, [], label)
    assert.equal(snapshot(state), before)
    const isCc = label.startsWith('CC')
    assert.ok(out.includes(`gains — role-typed approval seats of ${TARGET} in any state, not reachable through ${OLD}: ${isCc ? 0 : 1}`), label)
    assert.ok(out.includes(`gains — role-targeted approval CC records of ${TARGET}, not reachable through ${OLD}: ${isCc ? 1 : 0}`), label)
    const refusal = out.find((line) => line.startsWith('REFUSED') && line.includes('would gain'))
    assert.ok(refusal && refusal.includes(`${isCc ? 0 : 1} role-typed approval seat(s) in any state and ${isCc ? 1 : 0} role-targeted approval CC record(s)`), label)
  }
})

test('refuses to move table grants onto a target role that already has members outside the old role', async () => {
  const state = baseState()
  state.userRoles.push({ user_id: 'user-d', role_id: TARGET })
  const before = snapshot(state)
  const { code, out, writes } = await runMain(['--apply'], state)
  assert.equal(code, EXIT_REFUSED)
  assert.deepEqual(writes, [])
  assert.equal(snapshot(state), before)
  assert.ok(out.some((line) => line.includes('1 member(s) outside')))
})

test('refuses when the target holds a code and a table grant the old role lacks (moved members would GAIN them); the dry run shows them', async () => {
  // The verifier's scenario: the seeded target was widened since — an extra stock-prep:pull and a
  // table grant on a sheet the old role has no grant on.
  const widen = (state) => {
    state.rolePermissions.push({ role_id: TARGET, permission_code: 'stock-prep:pull' })
    state.sheetGrants.push({ sheet_id: 'sheet-other', user_id: null, subject_type: 'role', subject_id: TARGET, perm_code: 'spreadsheet:write', created_at: 't6' })
  }
  for (const argv of [['--apply'], ['--apply', '--delete-empty-old-role']]) {
    const state = baseState()
    widen(state)
    const before = snapshot(state)
    const { code, out, writes } = await runMain(argv, state)
    assert.equal(code, EXIT_REFUSED, argv.join(' '))
    assert.deepEqual(writes, [])
    assert.equal(snapshot(state), before)
    const refusal = out.find((line) => line.startsWith('REFUSED') && line.includes('would gain'))
    assert.ok(refusal, 'a gains refusal is printed')
    assert.ok(refusal.includes('1 code(s) (stock-prep:pull)'))
    assert.ok(refusal.includes('1 role-subject grant row(s)'))
    assert.ok(refusal.includes(`1 member(s) of ${OLD} not already in ${TARGET}`), 'user-b is already in the target and gains nothing')
    assertValuesFree(out)
  }
  const state = baseState()
  widen(state)
  const before = snapshot(state)
  const dry = await runMain([], state)
  assert.equal(dry.code, EXIT_REFUSED)
  assert.deepEqual(dry.writes, [])
  assert.equal(snapshot(state), before)
  assert.ok(dry.out.includes(`gains — codes on ${TARGET} not held by ${OLD}: 1 (stock-prep:pull)`))
  assert.ok(dry.out.includes(`gains — role-subject table grants of ${TARGET} not held by ${OLD}: 1`))
  assert.ok(dry.out.some((line) => line.startsWith('--apply would refuse') && line.includes('would gain')))
  assertValuesFree(dry.out)
  // each widening alone refuses too: the extra code only, the extra table grant only
  const codeOnly = baseState()
  codeOnly.rolePermissions.push({ role_id: TARGET, permission_code: 'stock-prep:pull' })
  const grantOnly = baseState()
  grantOnly.sheetGrants.push({ sheet_id: 'sheet-other', user_id: null, subject_type: 'role', subject_id: TARGET, perm_code: 'spreadsheet:write', created_at: 't6' })
  for (const [label, single] of [['code only', codeOnly], ['table grant only', grantOnly]]) {
    const { code, writes } = await runMain(['--apply'], single)
    assert.equal(code, EXIT_REFUSED, label)
    assert.deepEqual(writes, [], label)
  }
})

test('refuses when the target is the subject of view / field / record / history-audit rows or of active role approvals the old role lacks', async () => {
  for (const table of UNMOVED_TABLES) {
    const state = baseState()
    state.unmoved[table].push({ subject_type: 'role', subject_id: TARGET })
    const before = snapshot(state)
    const { code, out, writes } = await runMain(['--apply'], state)
    assert.equal(code, EXIT_REFUSED, table)
    assert.deepEqual(writes, [])
    assert.equal(snapshot(state), before)
    assert.ok(out.includes(`gains — role-subject rows of ${TARGET} in ${table}: 1`), table)
    assert.ok(out.some((line) => line.startsWith('REFUSED') && line.includes('1 role-subject grant row(s)')), table)
  }
  const state = baseState()
  state.approvalAssignments.push({ assignment_type: 'role', assignee_id: TARGET, is_active: true })
  const { code, out, writes } = await runMain(['--apply'], state)
  assert.equal(code, EXIT_REFUSED)
  assert.deepEqual(writes, [])
  assert.ok(out.some((line) => line.startsWith('REFUSED') && line.includes('1 active role-assigned approval task(s)')))
})

test('gains do not refuse when every old-role member is already in the target (nobody gains anything)', async () => {
  const state = baseState()
  state.userRoles = state.userRoles.filter((r) => !(r.user_id === 'user-a' && r.role_id === OLD))
  state.rolePermissions.push({ role_id: TARGET, permission_code: 'stock-prep:pull' })
  const { code, out, writes } = await runMain(['--apply'], state)
  assert.equal(code, EXIT_OK)
  assert.deepEqual(writes.map((w) => w.key), ['moveMembers', 'moveSheetGrants'])
  assert.ok(out.includes(`gains — members who would gain them (in ${OLD}, not yet in ${TARGET}): 0`))
  assert.deepEqual(state.userRoles.filter((r) => r.role_id === TARGET).map((r) => r.user_id), ['user-b'])
})

test('--delete-empty-old-role refuses (nothing written) while a pending invite still names the old role; the dry run reports the count', async () => {
  const state = baseState()
  state.invites.push({ role_id: OLD, status: 'pending' })
  const before = snapshot(state)
  const refused = await runMain(['--apply', '--delete-empty-old-role'], state)
  assert.equal(refused.code, EXIT_REFUSED)
  assert.deepEqual(refused.writes, [], 'refused before any move, not after')
  assert.equal(snapshot(state), before)
  assert.ok(refused.out.some((line) => line.startsWith('REFUSED') && line.includes('1 pending invite(s) still name')))
  assertValuesFree(refused.out)

  const dry = await runMain([], state)
  assert.equal(dry.code, EXIT_OK)
  assert.ok(dry.out.includes(`pending invites naming ${OLD}: 1`))
  assert.ok(dry.out.includes(`dry run: --apply --delete-empty-old-role would refuse: 1 pending invite(s) still name ${OLD}`))
  assert.ok(!dry.out.some((line) => line.includes('would then be deleted')))

  // the move alone is not blocked by an invite; the old role stays
  const moved = await runMain(['--apply'], state)
  assert.equal(moved.code, EXIT_OK)
  assert.deepEqual(moved.writes.map((w) => w.key), ['moveMembers', 'moveSheetGrants'])
  assert.ok(state.roles.some((r) => r.id === OLD))
})

test('--delete-empty-old-role re-checks invites after the move: one created meanwhile refuses the delete and rolls everything back', async () => {
  const state = baseState()
  const before = snapshot(state)
  const late = (key, current) => {
    if (key === 'moveSheetGrants') current.invites.push({ role_id: OLD, status: 'pending' })
  }
  const { code, out, client, writes } = await runMain(['--apply', '--delete-empty-old-role'], state, { afterWrite: late })
  assert.equal(code, EXIT_REFUSED)
  assert.deepEqual(writes.map((w) => w.key), ['moveMembers', 'moveSheetGrants'], 'no delete statement is issued')
  assert.equal(client.calls.at(-1).key, 'rollback')
  assert.equal(snapshot(state), before)
  assert.ok(out.some((line) => line.includes('is not empty after the move')))
})

test('--delete-empty-old-role deletes only the emptied old role and its codes; a rerun is a no-op', async () => {
  const state = baseState()
  const before = baseState()
  const { code, writes } = await runMain(['--apply', '--delete-empty-old-role'], state)
  assert.equal(code, EXIT_OK)
  assert.deepEqual(writes.map((w) => w.key), ['moveMembers', 'moveSheetGrants', 'deleteOldRoleCodes', 'deleteOldRole'])
  assert.deepEqual(writes.slice(2).map((w) => w.params), [[OLD], [OLD]])
  assert.deepEqual(state.roles.map((r) => r.id), before.roles.map((r) => r.id).filter((id) => id !== OLD))
  assert.deepEqual(state.rolePermissions, before.rolePermissions.filter((r) => r.role_id !== OLD))
  const again = await runMain(['--apply', '--delete-empty-old-role'], state)
  assert.equal(again.code, EXIT_OK)
  assert.deepEqual(again.writes, [])
})

test('--delete-empty-old-role re-checks after the move: a membership committed meanwhile refuses the delete and rolls everything back', async () => {
  const state = baseState()
  const before = snapshot(state)
  const late = (key, current) => {
    if (key === 'moveSheetGrants') current.userRoles.push({ user_id: 'user-late', role_id: OLD })
  }
  const { code, out, client, writes } = await runMain(['--apply', '--delete-empty-old-role'], state, { afterWrite: late })
  assert.equal(code, EXIT_REFUSED)
  assert.deepEqual(writes.map((w) => w.key), ['moveMembers', 'moveSheetGrants'], 'no delete statement is issued')
  assert.equal(client.calls.at(-1).key, 'rollback')
  assert.equal(snapshot(state), before)
  assert.ok(out.some((line) => line.includes('is not empty after the move')))
})

test('without --delete-empty-old-role an already-empty old role is never deleted', async () => {
  const state = baseState()
  state.userRoles = state.userRoles.filter((r) => r.role_id !== OLD)
  state.sheetGrants = state.sheetGrants.filter((g) => !(g.subject_type === 'role' && g.subject_id === OLD))
  const { code, writes } = await runMain(['--apply'], state)
  assert.equal(code, EXIT_OK)
  assert.deepEqual(writes, [])
  assert.ok(state.roles.some((r) => r.id === OLD))
})

test('a database error rolls back and is reported by code only, never by its (value-bearing) text', async () => {
  const state = baseState()
  const before = snapshot(state)
  const { code, out, err, client } = await runMain(['--apply'], state, { failOn: 'moveSheetGrants' })
  assert.equal(code, EXIT_FAILURE)
  assert.equal(client.calls.at(-1).key, 'rollback')
  assert.equal(snapshot(state), before, 'the membership move already issued is rolled back with the failed grant move')
  assert.ok(err.some((line) => line.includes('code 23505')))
  assertValuesFree([...out, ...err])
})

test('run() inside a caller transaction issues no BEGIN / COMMIT / ROLLBACK of its own', async () => {
  const state = baseState()
  const client = makeFakeClient(state)
  const summary = await run({ client, apply: true, manageTransaction: false })
  assert.equal(summary.exitCode, EXIT_OK)
  assert.equal(summary.membersMoved, 2)
  assert.equal(summary.sheetGrantsMoved, 1)
  assert.ok(!client.calls.some((c) => ['begin', 'commit', 'rollback', 'readOnly'].includes(c.key)))
})

// ── option ① split step (owner 2026-10-12, R-39) ────────────────────────────────────────────────
// `--split-extra-codes-to-role <roleId>`: the old role's codes the target lacks go to a separate
// platform role given to the same members, in the same transaction, BEFORE the move. The built-in
// target never receives them. Its real-database proof (every member's effective permission set
// unchanged, through rbac/service.ts) is in elearning-role-templates.db.test.ts.

const SPLIT = 'approvals_operator'
const EXTRA = ['approvals:read', 'approvals:write', 'multitable:submit-approval']
const SPLIT_WRITES = ['insertSplitRole', 'insertSplitCodes', 'addSplitMembers', 'removeExtraCodes']

/** The demo-server shape: the old role carries three platform codes the built-in target lacks. */
function splitState() {
  const state = baseState()
  for (const code of EXTRA) state.rolePermissions.push({ role_id: OLD, permission_code: code })
  return state
}

const codesOfRole = (state, roleId) => state.rolePermissions.filter((r) => r.role_id === roleId).map((r) => r.permission_code).sort()
const membersOfRole = (state, roleId) => state.userRoles.filter((r) => r.role_id === roleId).map((r) => r.user_id).sort()

test('split usage: the id and name are validated before connecting and never echoed; the recommended id passes', async () => {
  assert.equal(RECOMMENDED_SPLIT_ROLE_ID, SPLIT)
  assert.equal(DEFAULT_SPLIT_ROLE_NAME, '审批与提交')
  assert.equal(splitRoleIdProblem(SPLIT), null)
  assert.equal(splitRoleIdProblem('multitable_floor'), null)
  const refusedIds = [
    ' approvals_operator', 'approvals_operator ', 'approvals_​operator', 'approvals_op\u0007', 'approvals_操作', '', '-approvals',
    'admin', OLD, TARGET,
    'approvals_x_admin', 'operator_admin',
    'stock-prep_c_deadbeef', 'stock-prep_split', 'attendance_split', 'plugin_elearning_split', 'operator_approvals', 'elearning_split',
  ]
  for (const id of refusedIds) {
    assert.notEqual(splitRoleIdProblem(id), null, `refused: ${JSON.stringify(id)}`)
  }
  const usage = [
    ['--split-extra-codes-to-role'],
    ['--split-extra-codes-to-role', '--apply'],
    ['--split-extra-codes-to-role', SPLIT, '--split-extra-codes-to-role', SPLIT],
    ['--split-role-name', 'x'],
    ['--split-extra-codes-to-role', SPLIT, '--split-role-name', ' padded '],
    ['--split-extra-codes-to-role', SPLIT, '--split-role-name', ''],
    ['--split-extra-codes-to-role', SPLIT, '--split-role-name', 'x'.repeat(65)],
    ['--split-extra-codes-to-role', SPLIT, '--split-role-name', 'a\u0000b'],
    ...refusedIds.map((id) => ['--split-extra-codes-to-role', id]),
  ]
  for (const argv of usage) {
    let connected = false
    const err = []
    const code = await main(argv, { DATABASE_URL: 'postgres://fake' }, { createClient: async () => { connected = true; return makeFakeClient(splitState()) }, out: () => {}, err: (line) => err.push(line) })
    assert.equal(code, EXIT_FAILURE, JSON.stringify(argv))
    assert.equal(connected, false, JSON.stringify(argv))
    const text = err.join('\n')
    for (const value of argv.filter((a) => !a.startsWith('--') && a.length > 3 && !a.includes(SPLIT) && ![OLD, TARGET, 'admin'].includes(a))) assert.ok(!text.includes(value), `never echoed: ${JSON.stringify(value)}`)
  }
  assert.deepEqual(parseArgs(['--split-extra-codes-to-role', SPLIT, '--split-role-name', 'OPM custom split name']), {
    apply: false, deleteEmptyOldRole: false, root: null, help: false, splitRoleId: SPLIT, splitRoleName: 'OPM custom split name',
  })
})

test('split dry run: READ ONLY, no lock, zero writes, state identical; prints the extra codes as the database holds them and the plan', async () => {
  const state = splitState()
  const before = snapshot(state)
  const { code, out, client, writes } = await runMain(['--split-extra-codes-to-role', SPLIT], state)
  assert.equal(code, EXIT_OK)
  assert.deepEqual(writes, [])
  assert.deepEqual(client.calls.slice(0, 2).map((c) => c.key), ['begin', 'readOnly'])
  assert.ok(!client.calls.some((c) => LOCK_KEYS.has(c.key) || c.key === 'savepoint'))
  assert.equal(client.calls.at(-1).key, 'rollback')
  assert.equal(snapshot(state), before)
  for (const line of [
    `split: extra codes (on ${OLD}, not on ${TARGET}): 3 (approvals:read, approvals:write, multitable:submit-approval)`,
    `split: role ${SPLIT} absent; its codes: 0; its members: 0`,
    `split: members of ${OLD} already in ${SPLIT}: 0`,
    `split: delegable namespaces ${SPLIT} falls in: 0`,
    `split: display name for a new ${SPLIT}: 审批与提交; taken by another role: no`,
    `dry run: --apply first does the split: create role ${SPLIT} with 3 code(s) (approvals:read, approvals:write, multitable:submit-approval), add 2 member(s) of ${OLD} to it, remove those 3 code(s) from ${OLD}`,
    'dry run: --apply would move 2 membership(s) and 1 table grant(s)',
  ]) assert.ok(out.includes(line), `dry-run output must carry: ${line}`)
  // without the split the same database is refused (loss), and the message names the flag
  const plain = await runMain([], splitState())
  assert.equal(plain.code, EXIT_REFUSED)
  assert.ok(plain.out.some((line) => line.includes('would lose them') && line.includes(`--split-extra-codes-to-role ${SPLIT}`)))
  // a custom display name is never printed
  const custom = await runMain(['--split-extra-codes-to-role', SPLIT, '--split-role-name', 'OPM custom split name'], splitState())
  assert.equal(custom.code, EXIT_OK)
  assert.ok(custom.out.includes(`split: display name for a new ${SPLIT}: (custom, as given); taken by another role: no`))
  assertValuesFree([...out, ...custom.out])
})

test('split apply: lock first, then create + bind + add members + remove extra codes, re-check, move — exactly these writes, exactly these parameters', async () => {
  const state = splitState()
  const before = splitState()
  const { code, out, client, writes } = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
  assert.equal(code, EXIT_OK)
  assert.deepEqual(client.calls.slice(0, 3).map((c) => c.key), ['begin', 'lockTimeout', 'lockRoleTables'], 'the role tables are locked before the census')
  assert.deepEqual(writes.map((w) => w.key), [...SPLIT_WRITES, 'moveMembers', 'moveSheetGrants'])
  assert.deepEqual(writes.slice(0, 4).map((w) => w.params), [[SPLIT, '审批与提交'], [SPLIT, EXTRA], [OLD, SPLIT], [OLD, EXTRA]])
  const keys = client.calls.map((c) => c.key)
  assert.ok(keys.indexOf('savepoint') < keys.indexOf('insertSplitRole') && keys.indexOf('releaseSavepoint') > keys.indexOf('removeExtraCodes'))
  assert.ok(keys.lastIndexOf('splitRoleLock') > keys.indexOf('removeExtraCodes'), 'the census is read again after the split')
  assert.ok(!keys.includes('rollbackToSavepoint'))
  assert.equal(keys.at(-1), 'commit')

  assert.deepEqual(state.roles.find((r) => r.id === SPLIT), { id: SPLIT, name: '审批与提交' })
  assert.deepEqual(codesOfRole(state, SPLIT), EXTRA)
  assert.deepEqual(membersOfRole(state, SPLIT), ['user-a', 'user-b'])
  assert.deepEqual(codesOfRole(state, OLD), ['stock-prep:operate', 'stock-prep:read'])
  assert.deepEqual(codesOfRole(state, TARGET), codesOfRole(before, TARGET), 'the built-in target never receives the extra codes')
  assert.deepEqual(membersOfRole(state, TARGET), ['user-a', 'user-b'])
  assert.deepEqual(membersOfRole(state, OLD), [])
  // every old member's role-derived code set is unchanged
  const roleCodes = (s, userId) => [...new Set(s.userRoles.filter((r) => r.user_id === userId).flatMap((r) => codesOfRole(s, r.role_id)))].sort()
  for (const userId of ['user-a', 'user-b', 'user-c']) assert.deepEqual(roleCodes(state, userId), roleCodes(before, userId), userId)
  assert.ok(out.includes(`apply: split — created role ${SPLIT} with 3 extra code(s), added 2 member(s) of ${OLD} to it, removed 3 code(s) from ${OLD}`))
  assertValuesFree(out)

  // rerun: nothing left to split or move
  const again = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
  assert.equal(again.code, EXIT_OK)
  assert.deepEqual(again.writes, [])
  assert.ok(again.out.includes('split: extra codes (on stock-prep-operator, not on stock-prep_frontline): 0'))
})

test('split refuses an ADMIN-LEVEL extra code before any write (a platform administrator handles it by hand)', async () => {
  for (const adminCode of ['approvals:admin', 'attendance:*']) {
    const state = splitState()
    state.rolePermissions.push({ role_id: OLD, permission_code: adminCode })
    const before = snapshot(state)
    const { code, out, writes } = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
    assert.equal(code, EXIT_REFUSED, adminCode)
    assert.deepEqual(writes, [], adminCode)
    assert.equal(snapshot(state), before)
    assert.ok(out.some((line) => line.startsWith('REFUSED: split: 1 of the extra code(s) are admin-level') && line.includes(adminCode)), adminCode)
  }
})

test('split refuses an id inside a namespace a delegate controls or could be given (role ids and permission codes in the database); a non-admission-controlled match does not refuse', async () => {
  for (const [label, widen] of [
    ['a role deriving the namespace', (s) => s.roles.push({ id: `${SPLIT}_admin`, name: 'delegate' })],
    ['an orphan membership deriving it', (s) => s.userRoles.push({ user_id: 'user-x', role_id: ` ${SPLIT}_admin ` })],
    ['a catalogue code of that namespace', (s) => s.catalogue.push(`${SPLIT}:read`)],
    ['a direct user code of that namespace', (s) => s.userPermissions.push({ user_id: 'user-x', permission_code: `${SPLIT}:read` })],
  ]) {
    const state = splitState()
    widen(state)
    const before = snapshot(state)
    const { code, out, writes } = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
    assert.equal(code, EXIT_REFUSED, label)
    assert.deepEqual(writes, [], label)
    assert.equal(snapshot(state), before, label)
    assert.ok(out.includes(`split: delegable namespaces ${SPLIT} falls in: 1 (${SPLIT})`), label)
    assert.ok(out.some((line) => line.startsWith(`REFUSED: split: role ${SPLIT} falls inside 1 namespace(s)`)), label)
  }
  // `approvals` is not admission-controlled: an `approvals_admin` role delegates nothing.
  const state = splitState()
  state.roles.push({ id: 'approvals_admin', name: 'x' })
  const ok = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
  assert.equal(ok.code, EXIT_OK)
})

test('split reuses an existing role only when its codes EQUAL the extra codes (and its name, if one is given); otherwise refuses before any write', async () => {
  const exact = splitState()
  exact.roles.push({ id: SPLIT, name: 'site-made' })
  for (const code of EXTRA) exact.rolePermissions.push({ role_id: SPLIT, permission_code: code })
  exact.userRoles.push({ user_id: 'user-b', role_id: SPLIT })
  const reused = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], exact)
  assert.equal(reused.code, EXIT_OK)
  assert.deepEqual(reused.writes.map((w) => w.key), ['addSplitMembers', 'removeExtraCodes', 'moveMembers', 'moveSheetGrants'])
  assert.deepEqual(membersOfRole(exact, SPLIT), ['user-a', 'user-b'])
  assert.deepEqual(exact.roles.find((r) => r.id === SPLIT), { id: SPLIT, name: 'site-made' }, 'an existing role keeps its name')
  assert.ok(reused.out.includes(`split: members of ${OLD} already in ${SPLIT}: 1`))
  assert.ok(reused.out.includes(`apply: split — reused role ${SPLIT}, which holds exactly the extra code(s), added 1 member(s) of ${OLD} to it, removed 3 code(s) from ${OLD}`))
  assertValuesFree(reused.out.filter((line) => !line.includes('site-made')))
  assert.ok(!reused.out.join('\n').includes('site-made'), 'an existing role name is never printed')

  for (const [label, codes] of [['a subset', EXTRA.slice(0, 2)], ['a superset', [...EXTRA, 'stock-prep:read']], ['none', []]]) {
    const state = splitState()
    state.roles.push({ id: SPLIT, name: 'site-made' })
    for (const code of codes) state.rolePermissions.push({ role_id: SPLIT, permission_code: code })
    const before = snapshot(state)
    const { code, out, writes } = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
    assert.equal(code, EXIT_REFUSED, label)
    assert.deepEqual(writes, [], label)
    assert.equal(snapshot(state), before, label)
    assert.ok(out.some((line) => line.startsWith(`REFUSED: split: role ${SPLIT} already exists and its codes are not exactly the extra codes`)), label)
  }
  const named = splitState()
  named.roles.push({ id: SPLIT, name: 'site-made' })
  for (const code of EXTRA) named.rolePermissions.push({ role_id: SPLIT, permission_code: code })
  const renamed = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT, '--split-role-name', 'OPM custom split name'], named)
  assert.equal(renamed.code, EXIT_REFUSED)
  assert.deepEqual(renamed.writes, [])
  assert.ok(renamed.out.some((line) => line.includes('already exists under another display name')))
  // the same name given explicitly is fine
  const sameName = splitState()
  sameName.roles.push({ id: SPLIT, name: ' 审批与提交 ' })
  for (const code of EXTRA) sameName.rolePermissions.push({ role_id: SPLIT, permission_code: code })
  assert.equal((await runMain(['--apply', '--split-extra-codes-to-role', SPLIT, '--split-role-name', '审批与提交'], sameName)).code, EXIT_OK)
})

// A role whose trimmed display name is `admin` makes its members approval administrators
// (approval-record-link-txn-auth.ts, multitable/automation-approval-template-access.ts); a built-in
// stock-prep display name would let the split role pose as that built-in (S8 reserved names).
const RESERVED_SPLIT_NAMES = [
  'admin', 'Admin', 'ADMIN', 'ａｄｍｉｎ', 'ad min', 'admin（内置）',
  '操作人员', 'Operator', 'operator', '一线填写', 'Floor operator', 'FLOOR  OPERATOR', '操作人员（内置）', '备料主管理员', 'Main administrator',
]

test('split usage: a split role name that is admin (any case / spacing) or a built-in stock-prep display name is refused before connecting, never echoed', async () => {
  assert.equal(STOCK_PREP_BUILTIN_ROLE_DISPLAY_NAMES.length, 10)
  for (const name of [...RESERVED_SPLIT_NAMES, ...STOCK_PREP_BUILTIN_ROLE_DISPLAY_NAMES]) {
    assert.notEqual(splitRoleNameProblem(name), null, `refused: ${JSON.stringify(name)}`)
    let connected = false
    const err = []
    const code = await main(['--split-extra-codes-to-role', SPLIT, '--split-role-name', name], { DATABASE_URL: 'postgres://fake' }, {
      createClient: async () => { connected = true; return makeFakeClient(splitState()) }, out: () => {}, err: (line) => err.push(line),
    })
    assert.equal(code, EXIT_FAILURE, name)
    assert.equal(connected, false, name)
    assert.ok(err.join('\n').includes('--split-role-name: the split role name may not be'), name)
    // The refusal names the fixed word admin itself, and the role ids / the script's file name contain
    // "operator"; no other given value may appear.
    const withoutIds = err.join('\n').replaceAll('migrate-legacy-operator-role', '').replaceAll(OLD, '').replaceAll(TARGET, '').replaceAll(SPLIT, '')
    if (name.length > 3 && name !== 'admin') assert.ok(!withoutIds.includes(name), `never echoed: ${JSON.stringify(name)}`)
  }
  for (const name of [DEFAULT_SPLIT_ROLE_NAME, 'administrator', 'admins', 'approvals admin', '审批管理', 'Operator 2', '操作人员甲']) {
    assert.equal(splitRoleNameProblem(name), null, `accepted: ${JSON.stringify(name)}`)
  }
})

test('split refuses to REUSE an existing role whose display name is admin or a built-in stock-prep name (old-role members would gain it), before any write', async () => {
  for (const name of [' admin ', 'Admin', '操作人员', 'Floor operator']) {
    const state = splitState()
    state.roles.push({ id: SPLIT, name })
    for (const code of EXTRA) state.rolePermissions.push({ role_id: SPLIT, permission_code: code })
    const before = snapshot(state)
    const { code, out, writes } = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
    assert.equal(code, EXIT_REFUSED, name)
    assert.deepEqual(writes, [], name)
    assert.equal(snapshot(state), before, name)
    assert.ok(out.some((line) => line.startsWith(`REFUSED: split: role ${SPLIT} already exists and its display name may not be`)), name)
    const printed = out.join('\n').replaceAll('migrate-legacy-operator-role', '').replaceAll(OLD, '').replaceAll(TARGET, '').replaceAll(SPLIT, '')
    if (name.trim().length > 3 && name.trim() !== 'admin') assert.ok(!printed.includes(name.trim()), `never printed: ${JSON.stringify(name)}`)
  }
})

test('split refuses an absent id that still has leftover rows, or a display name another role already carries', async () => {
  for (const [label, add, needle] of [
    ['leftover membership', (s) => s.userRoles.push({ user_id: 'user-x', role_id: SPLIT }), 'does not exist but 1 user_roles row(s) and 0 role_permissions row(s)'],
    ['leftover code', (s) => s.rolePermissions.push({ role_id: SPLIT, permission_code: 'approvals:read' }), 'does not exist but 0 user_roles row(s) and 1 role_permissions row(s)'],
    ['name taken', (s) => s.roles.push({ id: 'some-role', name: ' 审批与提交 ' }), 'another role already carries the display name'],
  ]) {
    const state = splitState()
    add(state)
    const before = snapshot(state)
    const { code, out, writes } = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
    assert.equal(code, EXIT_REFUSED, label)
    assert.deepEqual(writes, [], label)
    assert.equal(snapshot(state), before, label)
    assert.ok(out.some((line) => line.startsWith('REFUSED: split:') && line.includes(needle)), label)
  }
})

test('split refuses when old-role members would GAIN what the split role is the subject of (grant rows, approval tasks, seats / CC by id or name); not when they are all in it already', async () => {
  for (const [label, add] of [
    ['table grant', (s) => s.sheetGrants.push({ sheet_id: 'sheet-split', user_id: null, subject_type: 'role', subject_id: SPLIT, perm_code: 'spreadsheet:read', created_at: 't9' })],
    ...UNMOVED_TABLES.map((table) => [table, (s) => s.unmoved[table].push({ subject_type: 'role', subject_id: SPLIT })]),
    ['active approval task', (s) => s.approvalAssignments.push({ assignment_type: 'role', assignee_id: SPLIT, is_active: true })],
    ['inactive seat by display name', (s) => s.approvalAssignments.push({ assignment_type: 'role', assignee_id: '审批与提交', is_active: false })],
    ['CC record by id', (s) => s.approvalRecords.push({ action: 'cc', metadata: { targetType: 'role', targetId: SPLIT } })],
  ]) {
    const state = splitState()
    add(state)
    const before = snapshot(state)
    const { code, out, writes } = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
    assert.equal(code, EXIT_REFUSED, label)
    assert.deepEqual(writes, [], label)
    assert.equal(snapshot(state), before, label)
    assert.ok(out.some((line) => line.startsWith(`REFUSED: split: role ${SPLIT} is the subject of`) && line.includes('2 member(s) of stock-prep-operator not yet in it would gain them')), label)
  }
  // every old member already holds the (exact) split role: nobody gains anything
  const state = splitState()
  state.roles.push({ id: SPLIT, name: '审批与提交' })
  for (const code of EXTRA) state.rolePermissions.push({ role_id: SPLIT, permission_code: code })
  state.userRoles.push({ user_id: 'user-a', role_id: SPLIT }, { user_id: 'user-b', role_id: SPLIT })
  state.approvalRecords.push({ action: 'cc', metadata: { targetType: 'role', targetId: SPLIT } })
  const ok = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
  assert.equal(ok.code, EXIT_OK)
  assert.deepEqual(ok.writes.map((w) => w.key), ['addSplitMembers', 'removeExtraCodes', 'moveMembers', 'moveSheetGrants'])
})

test('with the split, every OTHER refusal still fires — before any write', async () => {
  const cases = [
    ['unmoved row of the old role', (s) => s.unmoved.field_permissions.push({ subject_type: 'role', subject_id: OLD }), '1 row(s) in field_permissions'],
    ['active approval of the old role', (s) => s.approvalAssignments.push({ assignment_type: 'role', assignee_id: OLD, is_active: true }), 'would lose that read access'],
    ['target widened', (s) => s.rolePermissions.push({ role_id: TARGET, permission_code: 'stock-prep:pull' }), 'would gain them'],
    ['target has outside members', (s) => s.userRoles.push({ user_id: 'user-d', role_id: TARGET }), 'outside stock-prep-operator'],
    ['target absent', (s) => { s.roles = s.roles.filter((r) => r.id !== TARGET) }, 'does not exist'],
  ]
  for (const [label, add, needle] of cases) {
    const state = splitState()
    add(state)
    const before = snapshot(state)
    const { code, out, writes } = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
    assert.equal(code, EXIT_REFUSED, label)
    assert.deepEqual(writes, [], label)
    assert.equal(snapshot(state), before, label)
    assert.ok(out.some((line) => line.startsWith('REFUSED') && line.includes(needle)), label)
  }
})

test('after the split the census is read again: a change that slips in refuses, rolls the split back to the savepoint and moves nothing', async () => {
  for (const [label, afterKey, change, needle] of [
    ['old role gains a code the target lacks', 'removeExtraCodes', (s) => s.rolePermissions.push({ role_id: OLD, permission_code: 'attendance:read' }), 'holds 1 code(s)'],
    ['a new old-role member is not in the split role', 'addSplitMembers', (s) => s.userRoles.push({ user_id: 'user-late', role_id: OLD }), `1 member(s) of ${OLD} are not in role ${SPLIT} after the split`],
    ['the split role does not hold exactly the extra codes', 'insertSplitCodes', (s) => { s.rolePermissions = s.rolePermissions.filter((r) => !(r.role_id === SPLIT && r.permission_code === 'approvals:write')) }, `does not hold exactly the 3 extra code(s)`],
  ]) {
    const state = splitState()
    const before = snapshot(state)
    const { code, out, client, writes } = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state, {
      afterWrite: (key, current) => { if (key === afterKey) change(current) },
    })
    assert.equal(code, EXIT_REFUSED, label)
    assert.ok(!writes.some((w) => w.key === 'moveMembers' || w.key === 'moveSheetGrants'), `${label}: nothing moved`)
    assert.ok(client.calls.some((c) => c.key === 'rollbackToSavepoint'), `${label}: split rolled back`)
    assert.equal(client.calls.at(-1).key, 'rollback', label)
    assert.equal(snapshot(state), before, label)
    assert.ok(out.some((line) => line.startsWith('REFUSED (after the split step') && line.includes(needle)), `${label}: ${needle}`)
  }
})

test('split inside a caller transaction: the savepoint, never BEGIN / COMMIT / ROLLBACK; a post-split refusal is undone by the savepoint', async () => {
  const state = splitState()
  const client = makeFakeClient(state)
  const split = { roleId: SPLIT, roleName: DEFAULT_SPLIT_ROLE_NAME, roleNameGiven: false }
  const summary = await run({ client, apply: true, split, manageTransaction: false })
  assert.equal(summary.exitCode, EXIT_OK)
  assert.deepEqual(summary.split, { roleCreated: true, codesBound: 3, membersAdded: 2, codesRemoved: 3 })
  assert.ok(!client.calls.some((c) => ['begin', 'commit', 'rollback', 'readOnly'].includes(c.key)))

  const raced = splitState()
  const before = snapshot(raced)
  const racedClient = makeFakeClient(raced, { afterWrite: (key, current) => { if (key === 'removeExtraCodes') current.rolePermissions.push({ role_id: OLD, permission_code: 'attendance:read' }) } })
  const refused = await run({ client: racedClient, apply: true, split, manageTransaction: false })
  assert.equal(refused.exitCode, EXIT_REFUSED)
  assert.deepEqual(refused.split, { roleCreated: false, codesBound: 0, membersAdded: 0, codesRemoved: 0 })
  assert.equal(snapshot(raced), before, 'the savepoint undid the split in the caller transaction')
})

test('split with nothing to split (the old role holds no code the target lacks): no split write, the plain move runs', async () => {
  const state = baseState()
  const { code, out, writes } = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
  assert.equal(code, EXIT_OK)
  assert.deepEqual(writes.map((w) => w.key), ['moveMembers', 'moveSheetGrants'])
  assert.ok(!state.roles.some((r) => r.id === SPLIT))
  const dry = await runMain(['--split-extra-codes-to-role', SPLIT], baseState())
  assert.ok(dry.out.includes('dry run: --apply first does the split: nothing to split'))
  assert.ok(out.includes('split: extra codes (on stock-prep-operator, not on stock-prep_frontline): 0'))
})

test('the approval designer census counts template versions / published definitions naming the old role as a ROLE target (id or display name) and never refuses; the template-visibility LOSS refuses (#6348 follow-up); nothing is written', async () => {
  const state = baseState()
  const graph = (type, config) => ({ nodes: [{ key: 'n', type, config }] })
  // Template visibility (fix round 1): role-typed lists, matched exactly against role ids and trimmed
  // display names. Lost = through the old role, not through the role(s) members end up in.
  const visibilityTemplates = () => [
    { visibility_scope: { type: 'role', ids: [OLD] } }, // lost
    { visibility_scope: { type: 'role', ids: ['x', 'legacy floor'] } }, // lost: by display name
    { visibility_scope: { type: 'role', ids: [' legacy floor'] } }, // neither: the entry is compared exactly
    { visibility_scope: { type: 'role', ids: [OLD, TARGET] } }, // neither: seen before and after
    { visibility_scope: { type: 'role', ids: [OLD, SPLIT] } }, // lost without the split; kept with it
    { visibility_scope: { type: 'role', ids: ['一线填写'] } }, // gained: the target's display name
    { visibility_scope: { type: 'role', ids: [TARGET] } }, // gained
    { visibility_scope: { type: 'role', ids: [SPLIT] } }, // gained only with the split
    { visibility_scope: { type: 'role', ids: ['审批与提交'] } }, // gained only with the split (the name it would be created with)
  ]
  state.templates.push(...visibilityTemplates())
  state.templateVersions.push(
    { template_id: 'tpl-6', approval_graph: graph('approval', { assigneeSources: [{ kind: 'requester_choice', mode: 'single', scope: { type: 'role', roleIds: [OLD] } }] }) },
    { template_id: 'tpl-6', approval_graph: graph('approval', { assigneeSources: [{ kind: 'requester_choice', mode: 'multi', scope: { type: 'members', userIds: [OLD] } }] }) },
    { template_id: 'tpl-7', approval_graph: graph('approval', { assigneeSources: [{ kind: 'requester_choice', mode: 'single', scope: { type: 'company' } }] }) },
  )
  state.templateVersions.push(
    { template_id: 'tpl-3', approval_graph: graph('approval', { assigneeType: 'role', assigneeIds: [OLD] }) },
    { template_id: 'tpl-3', approval_graph: graph('approval', { assigneeSources: [{ kind: 'static_role', roleIds: ['legacy floor'] }] }) },
    { template_id: 'tpl-4', approval_graph: graph('handler', { assigneeSources: [{ kind: 'static_role', roleIds: [OLD] }] }) },
    { template_id: 'tpl-4', approval_graph: graph('approval', { emptyAssigneeFallback: { roleIds: [OLD] } }) },
    { template_id: 'tpl-5', approval_graph: graph('cc', { targetType: 'role', targetIds: [OLD] }) },
  )
  state.publishedDefinitions.push(
    { is_active: true, runtime_graph: graph('cc', { targetType: 'role', targetIds: ['legacy floor'] }) },
    { is_active: false, runtime_graph: graph('approval', { assigneeType: 'role', assigneeIds: [OLD] }) },
  )
  const before = snapshot(state)
  for (const argv of [[], ['--apply']]) {
    const s = argv.length === 0 ? state : structuredClone({ ...state, tables: [] })
    if (argv.length > 0) s.tables = new Set(state.tables)
    const { code, out, writes } = await runMain(argv, s)
    assert.equal(code, EXIT_REFUSED, argv.join(' '))
    assert.ok(out.includes(`${argv.length === 0 ? '--apply would refuse' : 'REFUSED'}: ${OLD} makes 3 role-scoped approval template(s) visible (by role id or display name) that ${TARGET} do(es) not; its 2 member(s) would stop seeing them (记录送审 / approval.completed automation answer 403 RECORD_APPROVAL_TEMPLATE_FORBIDDEN) — this script does not change visibility lists; add ${TARGET} to those templates' visibility first`), argv.join(' '))
    assert.equal(out.filter((line) => line.startsWith('--apply would refuse') || line.startsWith('REFUSED')).length, 1, 'the designer census and the GAIN count do not refuse')
    assert.ok(out.includes(`approval designer — template versions naming ${OLD} as a role approver / handler / CC target (by role id or display name): 6 (templates: 4); NOT changed by this script`), argv.join(' '))
    assert.ok(out.includes(`approval designer — published definitions naming ${OLD} the same way: 2 (active: 1); NOT changed by this script — re-point them in the approval designer`), argv.join(' '))
    assert.ok(out.includes(`approval template visibility — role-scoped templates visible through ${OLD} but not through ${TARGET} (by role id or display name): 3; moved members would stop seeing them (记录送审); NOT changed by this script — --apply refuses while this is above 0 and the old role has members`), argv.join(' '))
    assert.ok(out.includes(`approval template visibility — role-scoped templates visible through ${TARGET} but not through ${OLD} (by role id or display name): 2; moved members would newly see them; NOT changed by this script`), argv.join(' '))
    assert.deepEqual(writes, [], argv.join(' '))
    assertValuesFree(out)
  }
  assert.equal(snapshot(state), before, 'the dry run wrote nothing')

  // With the split step the members also end up in the split role: its id and the name it would be
  // created with count on the "after" side. With nothing to split (no extra code) they do not.
  const lostLine = (after, n) => `approval template visibility — role-scoped templates visible through ${OLD} but not through ${after} (by role id or display name): ${n}; moved members would stop seeing them (记录送审); NOT changed by this script — --apply refuses while this is above 0 and the old role has members`
  const gainedLine = (after, n) => `approval template visibility — role-scoped templates visible through ${after} but not through ${OLD} (by role id or display name): ${n}; moved members would newly see them; NOT changed by this script`
  const withSplit = splitState()
  withSplit.templates.push(...visibilityTemplates())
  const split = await runMain(['--split-extra-codes-to-role', SPLIT], withSplit)
  assert.equal(split.code, EXIT_REFUSED)
  assert.ok(split.out.includes(lostLine(`${TARGET} or ${SPLIT}`, 2)), split.out.join('\n'))
  assert.ok(split.out.includes(gainedLine(`${TARGET} or ${SPLIT}`, 4)), split.out.join('\n'))
  const nothingToSplit = baseState()
  nothingToSplit.templates.push(...visibilityTemplates())
  const idle = await runMain(['--split-extra-codes-to-role', SPLIT], nothingToSplit)
  assert.equal(idle.code, EXIT_REFUSED)
  assert.ok(idle.out.includes(lostLine(TARGET, 3)) && idle.out.includes(gainedLine(TARGET, 2)), idle.out.join('\n'))
  assertValuesFree([...split.out, ...idle.out])
})

// ── #6348 follow-ups (2026-10-14) ────────────────────────────────────────────────────────────────

test('#6348 follow-up (d): a template-visibility LOSS refuses --apply (exit 2, nothing written) while the old role has members; no member, a GAIN alone, or a list that also names the after role does not; the split role stays on the after side on the post-split re-read', async () => {
  const lossRefusal = (prefix, after, n, members) => `${prefix}: ${OLD} makes ${n} role-scoped approval template(s) visible (by role id or display name) that ${after} do(es) not; its ${members} member(s) would stop seeing them`
  // by id, and by the old role's trimmed display name
  for (const ids of [[OLD], ['legacy floor']]) {
    const state = baseState()
    state.templates.push({ visibility_scope: { type: 'role', ids } })
    const before = snapshot(state)
    const dry = await runMain([], state)
    assert.equal(dry.code, EXIT_REFUSED, JSON.stringify(ids))
    assert.ok(dry.out.some((line) => line.startsWith(lossRefusal('--apply would refuse', TARGET, 1, 2))), dry.out.join('\n'))
    const applied = await runMain(['--apply'], state)
    assert.equal(applied.code, EXIT_REFUSED, JSON.stringify(ids))
    assert.deepEqual(applied.writes, [])
    assert.ok(applied.out.some((line) => line.startsWith(lossRefusal('REFUSED', TARGET, 1, 2))), applied.out.join('\n'))
    assert.equal(snapshot(state), before)
    assertValuesFree([...dry.out, ...applied.out])
  }
  // no member left in the old role (and no table grant to move): nobody loses anything -> no refusal
  const empty = baseState()
  empty.userRoles = empty.userRoles.filter((r) => r.role_id !== OLD)
  empty.sheetGrants = empty.sheetGrants.filter((g) => !(g.subject_type === 'role' && g.subject_id === OLD))
  empty.templates.push({ visibility_scope: { type: 'role', ids: [OLD] } })
  const emptyRun = await runMain([], empty)
  assert.equal(emptyRun.code, EXIT_OK, emptyRun.out.join('\n'))
  // the list also names the target (or its display name), and a GAIN-only list: no refusal, the move runs
  const kept = baseState()
  kept.templates.push({ visibility_scope: { type: 'role', ids: [OLD, TARGET] } }, { visibility_scope: { type: 'role', ids: [OLD, '一线填写'] } }, { visibility_scope: { type: 'role', ids: [TARGET] } })
  const keptRun = await runMain(['--apply'], kept)
  assert.equal(keptRun.code, EXIT_OK, keptRun.out.join('\n'))
  assert.deepEqual(keptRun.writes.map((w) => w.key), ['moveMembers', 'moveSheetGrants'])
  // with the split: a list naming the old role and the split role (id, or the name it is created with)
  // is kept — on the dry run AND on the census re-read after the split statements (the old role then
  // holds no extra code any more, yet the split role must still count on the after side)
  for (const ids of [[OLD, SPLIT], [OLD, '审批与提交']]) {
    const state = splitState()
    state.templates.push({ visibility_scope: { type: 'role', ids } })
    const dry = await runMain(['--split-extra-codes-to-role', SPLIT], state)
    assert.equal(dry.code, EXIT_OK, `${JSON.stringify(ids)}\n${dry.out.join('\n')}`)
    const applied = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
    assert.equal(applied.code, EXIT_OK, `${JSON.stringify(ids)}\n${applied.out.join('\n')}`)
    assert.deepEqual(applied.writes.map((w) => w.key), [...SPLIT_WRITES, 'moveMembers', 'moveSheetGrants'])
    assert.ok(!applied.client.calls.some((c) => c.key === 'rollbackToSavepoint'))
  }
  // …while a list naming the old role only refuses with the split too, before any write
  const splitLoss = splitState()
  splitLoss.templates.push({ visibility_scope: { type: 'role', ids: [OLD] } })
  const splitLossRun = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], splitLoss)
  assert.equal(splitLossRun.code, EXIT_REFUSED)
  assert.deepEqual(splitLossRun.writes, [])
  assert.ok(splitLossRun.out.some((line) => line.startsWith(lossRefusal('REFUSED', `${TARGET} or ${SPLIT}`, 1, 2))), splitLossRun.out.join('\n'))
})

test('#6348 follow-up (c): every SQL trim uses exactly the String.prototype.trim set (U+3000, NBSP, …) — PostgreSQL one-argument btrim strips U+0020 only', async () => {
  const stripped = []
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    if (String.fromCodePoint(cp).trim() === '') stripped.push(cp)
  }
  assert.deepEqual([...JS_TRIM_CODE_POINTS], stripped, 'JS_TRIM_CODE_POINTS is exactly what .trim() strips')
  assert.ok(JS_TRIM_CODE_POINTS.includes(0x3000) && JS_TRIM_CODE_POINTS.includes(0x00a0) && JS_TRIM_CODE_POINTS.includes(0xfeff))
  const literal = /^U&'((?:\\[0-9A-F]{4})+)'$/.exec(JS_TRIM_SET_SQL)
  assert.ok(literal, JS_TRIM_SET_SQL)
  assert.deepEqual(literal[1].split('\\').slice(1).map((hex) => Number.parseInt(hex, 16)), stripped)
  assert.equal(JS_TRIM_SET_SQL, TRIM_GOLDEN)
  let twoArgument = 0
  const statements = Object.entries(SQL).map(([key, value]) => [key, typeof value === 'function' ? value('meta_view_permissions') : value])
  for (const [key, text] of statements) {
    assert.ok(!/btrim\(\s*[^(),]+\)/.test(text), `${key}: a one-argument btrim`)
    twoArgument += text.split(`, ${JS_TRIM_SET_SQL})`).length - 1
    assert.equal(text.split('btrim(').length, text.split(`, ${JS_TRIM_SET_SQL})`).length, `${key}: every btrim carries the set`)
  }
  assert.ok(twoArgument >= 20, String(twoArgument))
  // The split name is compared trimmed on both sides: another role named 「审批与提交」 padded with
  // U+3000 / NBSP / U+FEFF carries the name; a --split-role-name so padded is refused before connecting.
  for (const padded of ['\u3000审批与提交', '审批与提交\u00a0', '\ufeff审批与提交\u2003']) {
    const state = splitState()
    state.roles.push({ id: 'some-role', name: padded })
    const { code, out, writes } = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
    assert.equal(code, EXIT_REFUSED, JSON.stringify(padded))
    assert.deepEqual(writes, [])
    assert.ok(out.some((line) => line.startsWith('REFUSED: split:') && line.includes('another role already carries the display name')), JSON.stringify(padded))
    assert.notEqual(splitRoleNameProblem(padded), null, JSON.stringify(padded))
  }
})

// ── fix round 4 (old-machine review of #6348) ──────────────────────────────────────────────────

test('every --apply bounds its locks: SET LOCAL lock_timeout = 5s right after BEGIN, before the census FOR UPDATE — with or without the split; never in a dry run', async () => {
  const plain = await runMain(['--apply'], baseState())
  assert.equal(plain.code, EXIT_OK)
  const keys = plain.client.calls.map((c) => c.key)
  assert.deepEqual(keys.slice(0, 2), ['begin', 'lockTimeout'], 'the plain move path sets the lock bound first')
  assert.equal(keys.filter((k) => k === 'lockTimeout').length, 1)
  assert.ok(keys.indexOf('lockTimeout') < keys.indexOf('rolesLock'), 'the bound precedes the first FOR UPDATE')
  assert.ok(!keys.includes('lockRoleTables'), 'the plain move takes no table lock')
  assert.equal(plain.client.calls[1].sql, "SET LOCAL lock_timeout = '5s'")

  const withDelete = await runMain(['--apply', '--delete-empty-old-role'], baseState())
  assert.deepEqual(withDelete.client.calls.slice(0, 2).map((c) => c.key), ['begin', 'lockTimeout'])

  const split = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], splitState())
  assert.deepEqual(split.client.calls.slice(0, 3).map((c) => c.key), ['begin', 'lockTimeout', 'lockRoleTables'])

  for (const argv of [[], ['--split-extra-codes-to-role', SPLIT]]) {
    const dry = await runMain(argv, argv.length ? splitState() : baseState())
    assert.ok(!dry.client.calls.some((c) => LOCK_KEYS.has(c.key) || c.key === 'rolesLock'), 'a dry run takes no lock and sets no bound')
  }

  // A lock wait past the bound (SQLSTATE 55P03) is exit 1, rolled back, reported by code only.
  const state = baseState()
  const before = snapshot(state)
  const timedOut = await (async () => {
    const out = []
    const err = []
    let client
    const code = await main(['--apply'], { DATABASE_URL: 'postgres://fake' }, {
      createClient: async () => {
        client = makeFakeClient(state)
        const query = client.query.bind(client)
        client.query = async (text, params) => {
          if (norm(text) === norm(G.rolesLock)) {
            const error = new Error('canceling statement due to lock timeout')
            error.code = '55P03'
            throw error
          }
          return query(text, params)
        }
        return client
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    })
    return { code, out, err, client }
  })()
  assert.equal(timedOut.code, EXIT_FAILURE)
  assert.ok(timedOut.err.includes('failed (code 55P03); the transaction was rolled back and nothing was written'), timedOut.err.join('\n'))
  assert.ok(!timedOut.err.join('\n').includes('canceling statement'), 'the error text is never printed')
  assert.equal(timedOut.client.calls.at(-1).key, 'rollback')
  assert.equal(snapshot(state), before)
})

test('the census prints approval_usable of the old role, the target and the split role, and says it is NOT copied (the owner decides); never a refusal, never a write', async () => {
  const state = splitState()
  state.roles.find((r) => r.id === OLD).approval_usable = true
  const before = snapshot(state)
  const dry = await runMain(['--split-extra-codes-to-role', SPLIT], state)
  assert.equal(dry.code, EXIT_OK)
  assert.deepEqual(dry.writes, [])
  assert.ok(dry.out.includes(`approval_usable — ${OLD}: true; ${TARGET}: false; ${SPLIT}: role absent`), dry.out.join('\n'))
  assert.ok(dry.out.includes(`approval_usable — NOT copied by this script (a role it creates starts with the default, false); the owner decides whether ${SPLIT} should get it`))
  const call = dry.client.calls.find((c) => c.key === 'roleApprovalUsable')
  assert.deepEqual(call.params, [[OLD, TARGET, SPLIT]], 'binds exactly the three role ids')
  assert.equal(snapshot(state), before)

  // the apply creates the split role WITHOUT copying the flag
  const applied = await runMain(['--apply', '--split-extra-codes-to-role', SPLIT], state)
  assert.equal(applied.code, EXIT_OK)
  assert.notEqual(state.roles.find((r) => r.id === SPLIT).approval_usable, true, 'approval_usable is never copied to the split role')
  assert.ok(applied.out.includes(`approval_usable — ${OLD}: true; ${TARGET}: false; ${SPLIT}: role absent`))

  // without the split: the two roles, and the note names the recommended split id
  const plain = await runMain([], baseState())
  assert.ok(plain.out.includes(`approval_usable — ${OLD}: false; ${TARGET}: false`), plain.out.join('\n'))
  assert.ok(plain.out.includes(`approval_usable — NOT copied by this script (a role it creates starts with the default, false); the owner decides whether ${SPLIT} should get it`))
  assert.deepEqual(plain.client.calls.find((c) => c.key === 'roleApprovalUsable').params, [[OLD, TARGET]])

  // an install without the column: said so, the per-role read is never issued
  const noColumn = baseState()
  noColumn.approvalUsableColumn = false
  const old = await runMain([], noColumn)
  assert.equal(old.code, EXIT_OK)
  assert.ok(old.out.includes('approval_usable — column roles.approval_usable absent; nothing to compare'))
  assert.ok(!old.client.calls.some((c) => c.key === 'roleApprovalUsable'))
  assertValuesFree([...dry.out, ...applied.out, ...plain.out, ...old.out])
})

test('app.env: DATABASE_URL is parsed like ecosystem.config.cjs loads app.env — BOM, leading space, KEY = v, CRLF, quotes, comments, first wins; --root reads it', async () => {
  const cases = [
    ['﻿DATABASE_URL=postgres://bom\n', 'postgres://bom'],
    ['  DATABASE_URL=postgres://indented\n', 'postgres://indented'],
    ['DATABASE_URL = postgres://spaced\n', 'postgres://spaced'],
    ['\tDATABASE_URL\t=\t"postgres://tabbed"  \r\n', 'postgres://tabbed'],
    ['A=1\r\nDATABASE_URL=postgres://crlf\r\n', 'postgres://crlf'],
    ["DATABASE_URL='postgres://single'\n", 'postgres://single'],
    ['# DATABASE_URL=postgres://commented\nDATABASE_URL=postgres://real\n', 'postgres://real'],
    ['   \n  # DATABASE_URL=postgres://indented-comment\n#DATABASE_URL=postgres://tight-comment\nDATABASE_URL=postgres://after\n', 'postgres://after'],
    ['DATABASE_URL=postgres://first\nDATABASE_URL=postgres://second\n', 'postgres://first'],
    ['DATABASE_URLX=postgres://other-key\nXDATABASE_URL=postgres://other-key\n', ''],
    ['DATABASE_URL=postgres://a=b?c=d\n', 'postgres://a=b?c=d'],
    ['=postgres://no-key\n', ''],
  ]
  for (const [text, expected] of cases) assert.equal(databaseUrlFromAppEnvText(text), expected, JSON.stringify(text))

  // end to end: --root <dir> with docker/app.env carrying a BOM, CRLF and a spaced key
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opm4-appenv-'))
  try {
    fs.mkdirSync(path.join(root, 'docker'))
    fs.writeFileSync(path.join(root, 'docker', 'app.env'), '﻿# comment\r\n  DATABASE_URL = "postgres://from-app-env"\r\nOTHER=1\r\n')
    let url = null
    const code = await main(['--root', root], {}, {
      createClient: async (databaseUrl) => { url = databaseUrl; return makeFakeClient(baseState()) },
      out: () => {},
      err: () => {},
    })
    assert.equal(code, EXIT_OK)
    assert.equal(url, 'postgres://from-app-env')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('entry check: a real-path match counts (junction / symlink), a different file does not; a realpath failure falls back to the URL comparison', () => {
  const real = path.join(os.tmpdir(), 'opm4-real', 'script.mjs')
  const linked = path.join(os.tmpdir(), 'opm4-link', 'script.mjs')
  const realUrl = pathToFileURL(real).href
  const resolve = (p) => (p === linked ? real : p)
  assert.equal(isEntryPoint(real, realUrl, resolve), true, 'the plain path')
  assert.equal(isEntryPoint(linked, realUrl, resolve), true, 'argv through a link resolves to the module')
  assert.equal(isEntryPoint(path.join(os.tmpdir(), 'opm4-other', 'script.mjs'), realUrl, resolve), false)
  assert.equal(isEntryPoint(undefined, realUrl, resolve), false)
  assert.equal(isEntryPoint(linked, realUrl, () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }), false)
  assert.equal(isEntryPoint(real, realUrl, () => { throw new Error('unused') }), true, 'the URL match needs no realpath')
})

test('run through a directory junction / symbolic link the script still runs: first stdout line is the OWNER ACTION banner; a --root without pg exits 1 with MODULE_NOT_FOUND before connecting', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'opm4-entry-'))
  const realDir = path.join(base, 'real')
  const linkDir = path.join(base, 'link')
  const emptyRoot = path.join(base, 'empty-root')
  try {
    fs.mkdirSync(realDir)
    fs.mkdirSync(emptyRoot)
    fs.copyFileSync(SCRIPT_PATH, path.join(realDir, path.basename(SCRIPT_PATH)))
    // 'junction' needs no privilege on Windows; elsewhere the type is ignored (a directory symlink).
    fs.symlinkSync(realDir, linkDir, 'junction')
    const viaLink = path.join(linkDir, path.basename(SCRIPT_PATH))
    assert.notEqual(fs.realpathSync.native(viaLink), viaLink, 'the argv path really goes through a link')
    for (const scriptPath of [path.join(realDir, path.basename(SCRIPT_PATH)), viaLink]) {
      const result = spawnSync(process.execPath, [scriptPath, '--root', emptyRoot], {
        env: { ...process.env, DATABASE_URL: 'postgres://never-connected' },
        encoding: 'utf8',
        timeout: 30000,
      })
      const firstLine = result.stdout.split(/\r?\n/)[0]
      assert.ok(firstLine.startsWith('OWNER ACTION (R-39):'), `${scriptPath === viaLink ? 'via link' : 'direct'}: first stdout line was ${JSON.stringify(firstLine)}`)
      assert.equal(result.status, EXIT_FAILURE)
      assert.ok(result.stderr.includes('failed (code MODULE_NOT_FOUND)'), result.stderr)
      assert.ok(!`${result.stdout}${result.stderr}`.includes('never-connected'), 'DATABASE_URL is never printed')
    }
  } finally {
    // Remove the link itself first (never recurse through it), then the throwaway copy.
    try { fs.unlinkSync(linkDir) } catch { try { fs.rmdirSync(linkDir) } catch { /* not created */ } }
    fs.rmSync(base, { recursive: true, force: true })
  }
})
