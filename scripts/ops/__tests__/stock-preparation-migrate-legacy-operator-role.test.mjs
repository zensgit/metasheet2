// stock-preparation-migrate-legacy-operator-role.test.mjs — the legacy floor-role move (R-39, ADR
// adr-stock-prep-project-sheets-20261008 §11.2-1 / §8 step 3), driven in-process against a FAKE pg
// client. No database, no network, no subprocess.
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
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT_PATH = path.join(ROOT_DIR, 'scripts', 'ops', 'stock-preparation-migrate-legacy-operator-role.mjs')
const { main, run, OLD_ROLE_ID, TARGET_ROLE_ID, EXIT_OK, EXIT_FAILURE, EXIT_REFUSED } = await import(pathToFileURL(SCRIPT_PATH).href)

const OLD = 'stock-prep-operator'
const TARGET = 'stock-prep_frontline'
const OTHER = 'stock-prep_puller'

const norm = (text) => text.replace(/\s+/g, ' ').trim()

// ── golden statements ──────────────────────────────────────────────────────────────────────────
const G = {
  begin: 'BEGIN',
  readOnly: 'SET TRANSACTION READ ONLY',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  tableExists: "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1",
  rolesRead: 'SELECT id FROM roles WHERE id IN ($1, $2) ORDER BY id',
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
  moveMembers: 'WITH moved AS ( DELETE FROM user_roles WHERE role_id = $1 RETURNING user_id ), inserted AS ( INSERT INTO user_roles (user_id, role_id) SELECT user_id, $2 FROM moved ON CONFLICT DO NOTHING RETURNING 1 ) SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM inserted)::int AS inserted',
  moveSheetGrants: "WITH moved AS ( DELETE FROM spreadsheet_permissions WHERE subject_type = 'role' AND subject_id = $1 RETURNING sheet_id, perm_code, created_at ), inserted AS ( INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code, created_at) SELECT sheet_id, NULL, 'role', $2, perm_code, created_at FROM moved ON CONFLICT (sheet_id, subject_type, subject_id, perm_code) DO NOTHING RETURNING 1 ) SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM inserted)::int AS inserted",
  deleteOldRoleCodes: 'DELETE FROM role_permissions WHERE role_id = $1',
  deleteOldRole: 'DELETE FROM roles WHERE id = $1',
}
const UNMOVED_TABLES = ['meta_view_permissions', 'field_permissions', 'record_permissions', 'meta_history_audit_grants']
const unmovedGolden = (table) => `SELECT count(*)::int AS count FROM ${table} WHERE subject_type = 'role' AND subject_id = $1`
const WRITE_KEYS = new Set(['moveMembers', 'moveSheetGrants', 'deleteOldRoleCodes', 'deleteOldRole'])

// ── the fake ───────────────────────────────────────────────────────────────────────────────────
// The target is a freshly seeded stock-prep_frontline (read + operate, no grant row, no approval
// task), so moving the old role's members gains them nothing; the gains tests widen it.
function baseState() {
  return {
    tables: new Set(['roles', 'user_roles', 'role_permissions', 'spreadsheet_permissions', ...UNMOVED_TABLES, 'approval_assignments', 'user_invites']),
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
    approvalAssignments: [
      { assignment_type: 'role', assignee_id: OLD, is_active: false },
      { assignment_type: 'role', assignee_id: OTHER, is_active: true },
      { assignment_type: 'user', assignee_id: OLD, is_active: true },
    ],
    // Only a PENDING invite naming the old role blocks the delete: accepted / revoked ones and other
    // roles' pending ones do not.
    invites: [
      { role_id: OLD, status: 'accepted' },
      { role_id: OLD, status: 'revoked' },
      { role_id: OTHER, status: 'pending' },
    ],
  }
}

const clone = (state) => ({ ...structuredClone({ ...state, tables: [...state.tables] }), tables: new Set(state.tables) })
const snapshot = (state) => JSON.stringify({ ...state, tables: [...state.tables].sort() })
const countRows = (n) => ({ rows: [{ count: n }] })

function makeFakeClient(state, { failOn = null, afterWrite = null } = {}) {
  const calls = []
  let saved = null
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
      if (readOnly && WRITE_KEYS.has(key)) {
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
  for (const value of ['user-a', 'user-b', 'user-c', 'user-z', 'sheet-legacy', 'sheet-project', 'postgres://fake', 'legacy floor']) {
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
    `gains — members who would gain them (in ${OLD}, not yet in ${TARGET}): 1`,
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
  assert.ok(out.some((line) => line.includes('holds 2 code(s)') && line.includes('approvals:read, approvals:write')))
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
