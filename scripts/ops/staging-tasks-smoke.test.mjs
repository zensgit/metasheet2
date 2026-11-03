import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  KNOWN_TASK_ID_TABLES,
  M4_TASK_TABLES,
  STAMP_PATTERN,
  isStampedId,
  jwtSubject,
  assertNotAdminRoleId,
  roleIdForStamp,
  memberIdForStamp,
  outsiderIdForStamp,
  outsiderRoleIdForStamp,
  quoteIdent,
  resolveEnvConfig,
} from './staging-tasks-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'staging-tasks-smoke.mjs')

test('node --check parses the smoke script', () => {
  const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
  assert.equal(result.status, 0, `node --check failed: ${result.stderr}`)
})

test('tasks env contract: BASE_URL/DATABASE_URL/DEPLOY_SHA required, STAMP regex-locked, defaults applied', () => {
  const missing = resolveEnvConfig({})
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some((msg) => msg.includes('BASE_URL and DATABASE_URL')))
  assert.ok(missing.errors.some((msg) => msg.includes('DEPLOY_SHA is required')))

  const placeholder = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: '<fill-from-staging-build>',
  })
  assert.equal(placeholder.ok, false)
  assert.ok(placeholder.errors.some((msg) => msg.includes('DEPLOY_SHA is required')))

  const good = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082/',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
  })
  assert.equal(good.ok, true)
  assert.equal(good.config.baseUrl, 'http://127.0.0.1:8082', 'trailing slash stripped')
  assert.equal(good.config.orgId, 'default', 'org defaults to the SAME deterministic org every other window smoke uses')
  assert.match(good.config.stamp, STAMP_PATTERN)
  assert.ok(good.config.stamp.startsWith('tasks-smoke-'))

  const badStamp = resolveEnvConfig({
    BASE_URL: 'http://127.0.0.1:8082',
    DATABASE_URL: 'postgresql://u@127.0.0.1:5432/metasheet',
    DEPLOY_SHA: 'abc123def456',
    STAMP: 'mp6-smoke-wrong-family',
  })
  assert.equal(badStamp.ok, false)
  assert.ok(badStamp.errors.some((msg) => msg.includes('STAMP must match')))
})

test('STAMP_PATTERN only accepts the tasks-smoke- family', () => {
  assert.match('tasks-smoke-gh123456789a1', STAMP_PATTERN)
  assert.doesNotMatch('mp6-smoke-gh123456789a1', STAMP_PATTERN)
  assert.doesNotMatch('tasks-smoke-', STAMP_PATTERN)
  assert.doesNotMatch("tasks-smoke-a'b", STAMP_PATTERN)
  assert.doesNotMatch('xtasks-smoke-a', STAMP_PATTERN)
  assert.doesNotMatch('tasks-smoke-a b', STAMP_PATTERN)
})

test('isStampedId requires the exact prefix plus a nonempty suffix', () => {
  assert.equal(isStampedId('tasks-smoke-gh1a1', 'tasks-smoke-'), true)
  assert.equal(isStampedId('tasks-smoke-', 'tasks-smoke-'), false)
  assert.equal(isStampedId('other-gh1a1', 'tasks-smoke-'), false)
  assert.equal(isStampedId(null, 'tasks-smoke-'), false)
})

test('jwtSubject reads id/sub/userId out of an unsigned-inspection JWT payload', () => {
  const payload = Buffer.from(JSON.stringify({ id: 'tasks-smoke-gh1a1' })).toString('base64url')
  const token = `header.${payload}.sig`
  assert.equal(jwtSubject(token), 'tasks-smoke-gh1a1')
  assert.equal(jwtSubject('not-a-jwt'), null)
  assert.equal(jwtSubject(''), null)
})

test('jwtSubject uses the backend claim order (userId, then id, then sub)', () => {
  const tok = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
  assert.equal(jwtSubject(tok({ userId: 'u1', id: 'i1', sub: 's1' })), 'u1')
  assert.equal(jwtSubject(tok({ id: 'i1', sub: 's1' })), 'i1')
  assert.equal(jwtSubject(tok({ sub: 's1' })), 's1')
  assert.equal(jwtSubject(tok({ userId: '', id: 'i1' })), 'i1')
})

test('assertNotAdminRoleId refuses a role id ending "_admin" — the exact escalation shape namespace-admission.ts treats as implicit delegated-admin control', () => {
  assert.equal(assertNotAdminRoleId('tasks-smoke-gh1a1-role'), 'tasks-smoke-gh1a1-role')
  assert.throws(() => assertNotAdminRoleId('tasks_admin'), /refusing to use a role id ending "_admin"/)
  assert.throws(() => assertNotAdminRoleId('tasks-smoke-gh1a1_admin'), /refusing to use a role id ending "_admin"/)
})

test('identity wiring: every identity and role id is stamp-derived, and both role ids pass assertNotAdminRoleId', () => {
  assert.equal(roleIdForStamp('tasks-smoke-gh1a1'), 'tasks-smoke-gh1a1-role')
  assert.equal(memberIdForStamp('tasks-smoke-gh1a1'), 'tasks-smoke-gh1a1-member')
  assert.equal(outsiderIdForStamp('tasks-smoke-gh1a1'), 'tasks-smoke-gh1a1-outsider')
  assert.equal(outsiderRoleIdForStamp('tasks-smoke-gh1a1'), 'tasks-smoke-gh1a1-outsider-role')
  for (const roleId of [roleIdForStamp('tasks-smoke-gh1a1'), outsiderRoleIdForStamp('tasks-smoke-gh1a1')]) {
    assert.equal(assertNotAdminRoleId(roleId), roleId)
  }
  const source = readFileSync(script, 'utf8')
  assert.match(source, /^const USER_ID = STAMP$/m, 'the subject is the stamp itself')
  assert.match(source, /^const ROLE_ID = roleIdForStamp\(STAMP\)$/m, 'ROLE_ID must be computed through roleIdForStamp')
  assert.match(source, /^const MEMBER_ID = memberIdForStamp\(STAMP\)$/m)
  assert.match(source, /^const OUTSIDER_ID = outsiderIdForStamp\(STAMP\)$/m)
  assert.match(source, /^const OUTSIDER_ROLE_ID = outsiderRoleIdForStamp\(STAMP\)$/m)
  assert.match(source, /^const SEEDED_USER_IDS = \[USER_ID, MEMBER_ID, OUTSIDER_ID\]$/m)
  assert.match(source, /^const SEEDED_ROLE_IDS = \[ROLE_ID, OUTSIDER_ROLE_ID\]$/m)
})

test('quoteIdent wraps an identifier in double quotes and doubles embedded quotes', () => {
  assert.equal(quoteIdent('task_comments'), '"task_comments"')
  assert.equal(quoteIdent('odd"name'), '"odd""name"')
})


// --- executable runtime harness ---------------------------------------------------------------
//
// Runs the real smoke script as a child process against a fake `pg` package (resolved from a
// temp node_modules next to a copy of the script; ESM ignores NODE_PATH) and a stateful local
// HTTP stub of the tasks routes. The stub keys every request by method and path shape (a step
// sent with the wrong method or path is `unknown`, 404), enforces the row-level abilities the
// backend enforces (view/edit/delete), and answers with the backend's response shapes.
// The path shape says nothing about WHICH task a request names: a never-created id gets the same
// 404 NOT_FOUND as a row-level denial, which is exactly what the outsider and deleted-task checks
// accept. So the stub also traces every request as {method, key, task id, sub id}, and the tests
// compare that trace with EXPECTED_TRACE, in which every call names its target (the stub's ids
// are deterministic: parent tsk_1, child tsk_2, comment tcmt_3; the member for the assignee and
// follower sub ids). The stub further lists every request that names a task or comment id it
// never issued, or a member sub that is not a seeded identity; runSmoke requires that list to be
// empty in every test. A test can replace every answer of one route key (`overrides`), or change
// the honest answer of exactly ONE call of the expected sequence (`at`, keyed by the call's index
// in CALLS; the request at that index must have the expected method, key, task id and sub id).

const STAMP = 'tasks-smoke-t1'
const OUTSIDER = `${STAMP}-outsider`
const MEMBER = `${STAMP}-member`

const ROLE = `${STAMP}-role`
const OUTSIDER_ROLE = `${STAMP}-outsider-role`
const SEEDED_USERS = [STAMP, MEMBER, OUTSIDER]
const SEEDED_ROLES = [ROLE, OUTSIDER_ROLE]
const TASK_IDS = ['tsk_1', 'tsk_2']
// The stub's deterministic ids (one counter for tasks and comments): the run's first create is the
// parent, its second the child, and its one comment comes third.
const [PARENT, CHILD] = TASK_IDS
const COMMENT = 'tcmt_3'

// The `pg` package the smoke loads in the harness: a small row store that understands exactly the
// statement shapes the smoke issues and throws on anything else. A WHERE clause is either
// `<col> IN (SELECT id FROM <table> WHERE <clause>)`, evaluated against the store when the
// statement runs, or parts joined all by OR or all by AND, each part `<col> = ANY($n::text[])` or
// `<col> = $n`. FAKE_PG_THROW_ON makes every statement that starts with it throw. Rows carry an
// origin:
//   foreign      another identity's rows, present from the start; cleanup must never delete them
//   preexisting  rows for this stamp present before the run; the preflight must refuse
//   seed         the smoke's own INSERTs
//   run          rows the API writes during the run, and the role row token verification adds;
//                stored together with the first seed INSERT
//   planted      rows that survive cleanup; stored right after the first cleanup DELETE pass
// The store answers the to_regclass and residue queries from the aliases and WHERE clauses the
// query itself names, so a dropped or narrowed count changes the answer. Every statement, every
// deleted row and (on end()) every remaining row is logged.
function fakePg(appendFileSync) {
  const env = process.env
  const log = (entry) => appendFileSync(env.FAKE_PG_LOG, `${JSON.stringify(entry)}\n`)
  const rowsFrom = (name) => JSON.parse(env[name] || '[]')
  const store = new Map()
  const rowsOf = (name) => {
    if (!store.has(name)) store.set(name, [])
    return store.get(name)
  }
  const add = (rows, origin) => {
    for (const { table, row } of rows) rowsOf(table).push({ ...row, origin })
  }
  add(rowsFrom('FAKE_PG_FOREIGN_ROWS'), 'foreign')
  add(rowsFrom('FAKE_PG_PREEXISTING_ROWS'), 'preexisting')
  let runRowsStored = false
  let plantedStored = false
  let deletes = 0

  function matcher(clauses, params) {
    const sub = clauses.match(/^"?(\w+)"? IN \(SELECT id FROM (\w+) WHERE (.+)\)$/)
    if (sub) {
      const ids = new Set(rowsOf(sub[2]).filter(matcher(sub[3], params)).map((row) => String(row.id)))
      return (row) => ids.has(String(row[sub[1]]))
    }
    const joiner = clauses.includes(' AND ') ? ' AND ' : ' OR '
    const parsed = clauses.split(joiner).map((clause) => {
      const any = clause.match(/^"?(\w+)"?(?:::text)? = ANY\(\$(\d+)::text\[\]\)$/)
      if (any) {
        const values = params[Number(any[2]) - 1]
        return (row) => Array.isArray(values) && values.includes(String(row[any[1]]))
      }
      const scalar = clause.match(/^(\w+) = \$(\d+)$/)
      if (scalar) {
        const value = String(params[Number(scalar[2]) - 1])
        return (row) => row[scalar[1]] !== undefined && String(row[scalar[1]]) === value
      }
      throw new Error(`fake pg: unsupported WHERE clause: ${clause}`)
    })
    return joiner === ' AND ' ? (row) => parsed.every((test) => test(row)) : (row) => parsed.some((test) => test(row))
  }
  const count = (table, clauses, params) => rowsOf(table).filter(matcher(clauses, params)).length

  function insert(table, columns, valuesText, params) {
    const names = columns.split(',').map((name) => name.trim())
    const tuples = []
    let i = 0
    while (valuesText[i] === '(') {
      const elements = []
      let depth = 0
      let quoted = false
      let start = i + 1
      let j = i
      for (; j < valuesText.length; j += 1) {
        const c = valuesText[j]
        if (quoted) {
          if (c === "'") quoted = false
        } else if (c === "'") {
          quoted = true
        } else if (c === '(') {
          depth += 1
        } else if (c === ')') {
          depth -= 1
          if (depth === 0) {
            elements.push(valuesText.slice(start, j).trim())
            break
          }
        } else if (c === ',' && depth === 1) {
          elements.push(valuesText.slice(start, j).trim())
          start = j + 1
        }
      }
      tuples.push(elements)
      i = j + 1
      while (valuesText[i] === ',' || valuesText[i] === ' ') i += 1
    }
    const value = (expression) => {
      const param = expression.match(/^\$(\d+)$/)
      if (param) return String(params[Number(param[1]) - 1])
      const literal = expression.match(/^'([^']*)'(?:::\w+)?$/)
      return literal ? literal[1] : expression
    }
    for (const tuple of tuples) {
      if (tuple.length !== names.length) throw new Error(`fake pg: INSERT tuple does not match its columns: ${table}`)
      rowsOf(table).push({ ...Object.fromEntries(names.map((name, k) => [name, value(tuple[k])])), origin: 'seed' })
    }
  }

  async function query(text, params = []) {
    const flat = String(text).replace(/\s+/g, ' ').trim()
    log({ text: flat, params })
    if (env.FAKE_PG_THROW_ON && flat.startsWith(env.FAKE_PG_THROW_ON)) throw new Error(`fake failure on: ${env.FAKE_PG_THROW_ON}`)
    let m
    if (flat.startsWith('SELECT to_regclass(')) {
      const aliases = [...flat.matchAll(/ AS (\w+)/g)].map((match) => match[1])
      return { rows: [Object.fromEntries(aliases.map((alias) => [alias, alias !== env.FAKE_PG_MISSING_TABLE]))] }
    }
    if (flat.startsWith('SELECT count(*)::int AS n FROM permissions WHERE code IN ')) {
      return { rows: [{ n: Number(env.FAKE_PG_PERMISSIONS || 2) }] }
    }
    if (flat.startsWith('SELECT (SELECT count(*)::int FROM ')) {
      if (deletes > 0 && !plantedStored) {
        plantedStored = true
        add(rowsFrom('FAKE_PG_PLANTED_ROWS'), 'planted')
      }
      const parts = [...flat.matchAll(/\(SELECT count\(\*\)::int FROM (\w+) WHERE (.+?)\) AS (\w+)/g)]
      if (`SELECT ${parts.map((part) => part[0]).join(', ')}` !== flat) throw new Error(`fake pg: unsupported residue query: ${flat}`)
      return { rows: [Object.fromEntries(parts.map(([, table, clauses, alias]) => [alias, count(table, clauses, params)]))] }
    }
    if (flat.includes(' FROM information_schema.columns ')) {
      return { rows: (env.FAKE_PG_TASK_TABLES || '').split(',').filter(Boolean).map((table_name) => ({ table_name })) }
    }
    if ((m = flat.match(/^SELECT count\(\*\)::int AS n FROM (?:public\."(\w+)"|(\w+)) WHERE (.+)$/))) {
      return { rows: [{ n: count(m[1] || m[2], m[3], params) }] }
    }
    if ((m = flat.match(/^SELECT id FROM (\w+) WHERE (.+)$/))) {
      return { rows: rowsOf(m[1]).filter(matcher(m[2], params)).map((row) => ({ id: row.id })) }
    }
    if ((m = flat.match(/^DELETE FROM (\w+) WHERE (.+)$/))) {
      deletes += 1
      const match = matcher(m[2], params)
      const kept = []
      for (const row of rowsOf(m[1])) {
        if (match(row)) log({ deleted: { table: m[1], ...row } })
        else kept.push(row)
      }
      const removed = rowsOf(m[1]).length - kept.length
      store.set(m[1], kept)
      return { rows: [], rowCount: removed }
    }
    if ((m = flat.match(/^INSERT INTO (\w+) \(([^)]*)\) VALUES (.+)$/))) {
      if (!runRowsStored) {
        runRowsStored = true
        add(rowsFrom('FAKE_PG_RUN_ROWS'), 'run')
      }
      insert(m[1], m[2], m[3], params)
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`fake pg: unsupported statement: ${flat}`)
  }

  async function end() {
    log({ remaining: [...store.entries()].flatMap(([table, rows]) => rows.map((row) => ({ table, ...row }))) })
  }
  return { query, end }
}

const FAKE_PG = `import { appendFileSync } from 'node:fs'
const fakePg = ${fakePg.toString()}
const { query, end } = fakePg(appendFileSync)
class Pool {
  query(text, params) { return query(text, params) }
  end() { return end() }
}
export default { Pool }
`

// Another identity's rows in every table the smoke touches: cleanup must leave all of them. The
// foreign task sits in the smoke's org with the smoke parent's title, so only its creator tells it
// apart from the task the run creates first; it has a child task of its own.
const FOREIGN_ROWS = [
  { table: 'users', row: { id: 'someone-else' } },
  { table: 'user_orgs', row: { user_id: 'someone-else', org_id: 'default' } },
  { table: 'user_roles', row: { user_id: 'someone-else', role_id: 'attendance_employee' } },
  { table: 'user_namespace_admissions', row: { user_id: 'someone-else', namespace: 'tasks' } },
  { table: 'roles', row: { id: 'attendance_employee' } },
  { table: 'role_permissions', row: { role_id: 'attendance_employee', permission_code: 'attendance:read' } },
  { table: 'tasks', row: { id: 'tsk_foreign', created_by: 'someone-else', title: STAMP, org_id: 'default' } },
  { table: 'tasks', row: { id: 'tsk_foreign_child', created_by: 'someone-else', title: 'someone else child', org_id: 'default', parent_id: 'tsk_foreign' } },
  { table: 'task_assignees', row: { task_id: 'tsk_foreign', user_id: 'someone-else' } },
  { table: 'task_followers', row: { task_id: 'tsk_foreign', user_id: 'someone-else' } },
  { table: 'task_comments', row: { id: 'tcmt_foreign', task_id: 'tsk_foreign', author_id: 'someone-else' } },
  { table: 'task_events', row: { task_id: 'tsk_foreign', actor_id: 'someone-else' } },
]

// What a run writes through the API (both tasks, their assignee/follower/comment/event rows) and
// what token verification adds under PRODUCT_MODE=platform (a self-service role row for every
// identity that authenticates). Cleanup must remove every one of them.
const RUN_ROWS = [
  { table: 'tasks', row: { id: 'tsk_1', created_by: STAMP, title: STAMP, org_id: 'default' } },
  { table: 'tasks', row: { id: 'tsk_2', created_by: STAMP, title: `${STAMP} child`, org_id: 'default' } },
  { table: 'task_assignees', row: { task_id: 'tsk_1', user_id: STAMP } },
  { table: 'task_assignees', row: { task_id: 'tsk_2', user_id: STAMP } },
  { table: 'task_followers', row: { task_id: 'tsk_1', user_id: MEMBER } },
  { table: 'task_comments', row: { id: 'tcmt_3', task_id: 'tsk_1', author_id: STAMP } },
  { table: 'task_events', row: { task_id: 'tsk_1', actor_id: STAMP } },
  { table: 'task_events', row: { task_id: 'tsk_2', actor_id: STAMP } },
  { table: 'task_events', row: { task_id: 'tsk_1', actor_id: MEMBER } },
  { table: 'user_roles', row: { user_id: STAMP, role_id: 'attendance_employee' } },
  { table: 'user_roles', row: { user_id: MEMBER, role_id: 'attendance_employee' } },
  { table: 'user_roles', row: { user_id: OUTSIDER, role_id: 'attendance_employee' } },
]

function tokenFor(userId) {
  return `h.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.s`
}

function callerOf(req) {
  const segment = String(req.headers.authorization || '').replace(/^Bearer /, '').split('.')[1] || ''
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')).userId || ''
  } catch {
    return ''
  }
}

const NOT_FOUND = { status: 404, body: { error: { code: 'NOT_FOUND' } } }
const FORBIDDEN = { status: 403, body: { error: 'Insufficient permissions' } }
const INTERNAL = { error: { code: 'INTERNAL' } }

// `<METHOD> <path shape>` -> route key. :id is the task id, :sub the nested member or comment id.
const ROUTE_KEYS = new Map([
  ['GET context', 'context'],
  ['GET /', 'list'],
  ['POST /', 'create'],
  ['GET :id', 'detail'],
  ['DELETE :id', 'delete'],
  ['POST :id/complete', 'complete'],
  ['POST :id/reopen', 'reopen'],
  ['PATCH :id/parent', 'parent'],
  ['GET :id/parent-candidates', 'candidates'],
  ['PATCH :id/completion-mode', 'mode'],
  ['POST :id/assignees', 'assignee.add'],
  ['DELETE :id/assignees/:sub', 'assignee.remove'],
  ['POST :id/followers', 'follower.add'],
  ['DELETE :id/followers/:sub', 'follower.remove'],
  ['POST :id/leave', 'leave'],
  ['GET :id/comments', 'comment.list'],
  ['POST :id/comments', 'comment.create'],
  ['PATCH :id/comments/:sub', 'comment.update'],
  ['DELETE :id/comments/:sub', 'comment.delete'],
])

// Route key for a request, used for overrides and for the call trace. Calls made with another
// identity's token carry its prefix (`outsider.`, `member.`).
function routeKey(method, pathname, caller) {
  const prefix = caller === OUTSIDER ? 'outsider.' : caller === MEMBER ? 'member.' : ''
  const [empty, api, tasks, id, segment, sub, ...rest] = pathname.split('/')
  let shape = null
  if (empty === '' && api === 'api' && tasks === 'tasks' && rest.length === 0) {
    if (id === undefined) shape = '/'
    else if (id === 'context' && segment === undefined) shape = 'context'
    else if (segment === undefined) shape = ':id'
    else if (sub === undefined) shape = `:id/${segment}`
    else shape = `:id/${segment}/:sub`
  }
  return `${prefix}${(shape !== null && ROUTE_KEYS.get(`${method} ${shape}`)) || 'unknown'}`
}

// Routes whose path carries no task id, and the routes whose :sub is a comment id or a member id.
const ROUTES_WITHOUT_TASK_ID = new Set(['context', 'list', 'create'])
const COMMENT_SUB_ROUTES = new Set(['comment.update', 'comment.delete'])
const MEMBER_SUB_ROUTES = new Set(['assignee.remove', 'follower.remove'])

function decodePathPart(part) {
  if (part === undefined || part === '') return null
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

function startStub({ overrides = {}, at = {}, devTokens = true } = {}) {
  // trace: {method, key, id, sub} of every tasks request, in order. unissued: every request that
  // names a task or comment id the stub never issued, or a member sub that is not a seeded
  // identity (issued ids are recorded by the create handlers, before any `at` change).
  const state = {
    seq: 0, tasks: new Map(), comments: new Map(), subjectContextCalls: 0, calls: [], trace: [], unissued: [],
    issuedTasks: new Set(), issuedComments: new Set(), mismatches: [], mints: [],
  }
  const live = (id) => {
    const task = state.tasks.get(id)
    return task && !task.deleted ? task : null
  }
  const liveChildren = (id) => [...state.tasks.values()].filter((task) => !task.deleted && task.parentId === id)
  // Row-level abilities (task-access.ts): view/comment = creator, assignee or follower; edit =
  // creator or assignee; delete = creator; leave = follower. Anything else is 404 NOT_FOUND, like
  // the backend.
  const can = (task, caller, ability) => {
    const creator = task.createdBy === caller
    const assignee = task.assignees.includes(caller)
    const follower = task.followers.includes(caller)
    if (ability === 'view' || ability === 'comment') return creator || assignee || follower
    if (ability === 'edit') return creator || assignee
    if (ability === 'delete') return creator
    if (ability === 'leave') return follower
    return false
  }
  const descendantsOf = (id) => liveChildren(id).flatMap((child) => [child.id, ...descendantsOf(child.id)])
  // tasks:write is granted to the subject and the member (the subject's role); the outsider's role
  // is tasks:read.
  const writers = new Set([STAMP, MEMBER])
  const membership = (task) => ({
    id: task.id,
    status: task.status,
    completionMode: task.mode,
    assignees: task.assignees.map((userId) => ({ userId, completedAt: null })),
  })
  const detail = (task) => ({
    ...membership(task),
    title: task.title,
    createdBy: task.createdBy,
    followers: [...task.followers],
    parentId: task.parentId,
    depth: task.parentId ? 1 : 0,
    children: liveChildren(task.id).map((child) => ({ id: child.id, title: child.title, status: child.status, completionMode: child.mode, depth: 1 })),
  })

  function handle(key, method, parts, body, caller) {
    const route = key.replace(/^(outsider|member)\./, '')
    if (route === 'unknown') return NOT_FOUND
    if (!caller) return { status: 401, body: { error: 'Unauthorized' } }
    // The subject is admitted to the tasks namespace only after its first context call was refused.
    if (caller === STAMP && state.subjectContextCalls === 0 && route !== 'context') return FORBIDDEN
    if (method !== 'GET' && !writers.has(caller)) return FORBIDDEN
    const id = parts[3] === undefined ? undefined : decodeURIComponent(parts[3])
    const sub = parts[5] === undefined ? undefined : decodeURIComponent(parts[5])
    const task = id === undefined ? null : live(id)
    const allowed = (ability) => task !== null && can(task, caller, ability)
    switch (route) {
      case 'context':
        if (caller === STAMP) {
          state.subjectContextCalls += 1
          if (state.subjectContextCalls === 1) return FORBIDDEN
        }
        return { status: 200, body: { orgId: 'default' } }
      case 'create': {
        state.seq += 1
        const newId = `tsk_${state.seq}`
        state.tasks.set(newId, { id: newId, title: body.title, createdBy: caller, parentId: null, mode: 'all', status: 'open', assignees: [caller], followers: [], deleted: false })
        state.issuedTasks.add(newId)
        return { status: 200, body: { id: newId } }
      }
      case 'list':
        return { status: 200, body: { items: [...state.tasks.values()].filter((t) => !t.deleted && t.createdBy === caller).map((t) => ({ id: t.id })) } }
      case 'complete':
        if (!allowed('edit')) return NOT_FOUND
        task.status = 'done'
        return { status: 200, body: { done: true } }
      case 'reopen':
        if (!allowed('edit')) return NOT_FOUND
        task.status = 'open'
        return { status: 200, body: { ok: true } }
      case 'detail':
        return allowed('view') ? { status: 200, body: detail(task) } : NOT_FOUND
      case 'parent':
        if (!allowed('edit')) return NOT_FOUND
        if (body.parentId === null) task.parentId = null
        else if (live(body.parentId) && can(live(body.parentId), caller, 'edit')) task.parentId = body.parentId
        else return NOT_FOUND
        return { status: 200, body: { id: task.id, parentId: task.parentId, depth: task.parentId ? 1 : 0 } }
      case 'candidates': {
        if (!allowed('edit')) return NOT_FOUND
        const excluded = new Set([task.id, ...descendantsOf(task.id)])
        const items = [...state.tasks.values()]
          .filter((other) => !other.deleted && !excluded.has(other.id) && can(other, caller, 'edit'))
          .map((other) => ({ id: other.id, title: other.title }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        return { status: 200, body: { items } }
      }
      case 'assignee.add':
        if (!allowed('edit')) return NOT_FOUND
        if (!task.assignees.includes(body.userId)) task.assignees.push(body.userId)
        return { status: 200, body: membership(task) }
      case 'assignee.remove':
        if (!allowed('edit')) return NOT_FOUND
        task.assignees = task.assignees.filter((userId) => userId !== sub)
        return { status: 200, body: membership(task) }
      case 'follower.add':
        if (!allowed('edit')) return NOT_FOUND
        if (!task.followers.includes(body.userId)) task.followers.push(body.userId)
        return { status: 200, body: { id: task.id, followers: [...task.followers] } }
      case 'follower.remove':
        if (!allowed('edit')) return NOT_FOUND
        task.followers = task.followers.filter((userId) => userId !== sub)
        return { status: 200, body: { id: task.id, followers: [...task.followers] } }
      case 'leave':
        if (!allowed('leave')) return NOT_FOUND
        task.followers = task.followers.filter((userId) => userId !== caller)
        return { status: 200, body: { id: task.id, followers: [...task.followers] } }
      case 'mode':
        if (!allowed('edit')) return NOT_FOUND
        task.mode = body.completionMode
        return { status: 200, body: membership(task) }
      case 'comment.create': {
        if (!allowed('comment')) return NOT_FOUND
        state.seq += 1
        const comment = { id: `tcmt_${state.seq}`, taskId: task.id, authorId: caller, body: body.body, deleted: false, createdAt: new Date(0).toISOString() }
        state.comments.set(comment.id, comment)
        state.issuedComments.add(comment.id)
        return { status: 200, body: { ...comment } }
      }
      case 'comment.update': {
        const comment = state.comments.get(sub)
        if (!allowed('comment') || !comment || comment.taskId !== task.id || comment.deleted || comment.authorId !== caller) return NOT_FOUND
        comment.body = body.body
        return { status: 200, body: { ...comment } }
      }
      case 'comment.delete': {
        const comment = state.comments.get(sub)
        if (!allowed('comment') || !comment || comment.taskId !== task.id || comment.deleted || comment.authorId !== caller) return NOT_FOUND
        comment.deleted = true
        comment.body = null
        return { status: 200, body: { ...comment } }
      }
      case 'comment.list': {
        if (!allowed('view')) return NOT_FOUND
        const items = [...state.comments.values()].filter((comment) => comment.taskId === task.id).map((comment) => ({ ...comment }))
        return { status: 200, body: { items, total: items.length } }
      }
      case 'delete':
        if (!allowed('delete')) return NOT_FOUND
        if (liveChildren(task.id).length > 0) return { status: 409, body: { error: { code: 'HAS_CHILDREN' } } }
        task.deleted = true
        return { status: 200, body: { id: task.id, deleted: true } }
      default:
        return NOT_FOUND
    }
  }

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const url = new URL(req.url, 'http://stub')
      if (req.method === 'GET' && url.pathname === '/api/auth/dev-token') {
        // The dev-token route the smoke falls back to when no token is supplied (non-production).
        state.mints.push(Object.fromEntries(url.searchParams))
        const minted = devTokens ? { status: 200, body: { token: tokenFor(url.searchParams.get('userId')) } } : NOT_FOUND
        res.writeHead(minted.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(minted.body))
        return
      }
      const parts = url.pathname.split('/')
      const caller = callerOf(req)
      const key = routeKey(req.method, url.pathname, caller)
      let body = {}
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} } catch { body = {} }
      const route = key.replace(/^(outsider|member)\./, '')
      const traced = {
        method: req.method,
        key,
        id: ROUTES_WITHOUT_TASK_ID.has(route) ? null : decodePathPart(parts[3]),
        sub: decodePathPart(parts[5]),
      }
      const index = state.trace.length
      state.calls.push(key)
      state.trace.push(traced)
      if (route !== 'unknown' && traced.id !== null && !state.issuedTasks.has(traced.id)) {
        state.unissued.push({ index, ...traced, never: 'task id' })
      }
      if (COMMENT_SUB_ROUTES.has(route) && !state.issuedComments.has(traced.sub)) {
        state.unissued.push({ index, ...traced, never: 'comment id' })
      }
      if (MEMBER_SUB_ROUTES.has(route) && !SEEDED_USERS.includes(traced.sub)) {
        state.unissued.push({ index, ...traced, never: 'seeded member' })
      }
      let picked
      if (overrides[key]) {
        picked = overrides[key]
      } else {
        picked = handle(key, req.method, parts, body, caller)
        const target = at[index]
        if (target) {
          const expected = { method: target.method, key: target.key, id: target.id ?? null, sub: target.sub ?? null }
          if (JSON.stringify(expected) !== JSON.stringify(traced)) state.mismatches.push({ index, expected, actual: traced })
          picked = target.change(JSON.parse(JSON.stringify(picked)))
        }
      }
      res.writeHead(picked.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(picked.body))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state })))
}

async function runSmoke({ overrides = {}, at = {}, pgEnv = {}, env = {}, devTokens = true } = {}) {
  // realpath: the smoke's IS_MAIN check compares import.meta.url with argv[1], and macOS tmpdir()
  // is a /var -> /private/var symlink, so an unresolved path would silently skip main().
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tasks-smoke-harness-'))
  mkdirSync(join(dir, 'scripts', 'ops'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'pg'), { recursive: true })
  copyFileSync(script, join(dir, 'scripts', 'ops', 'staging-tasks-smoke.mjs'))
  writeFileSync(join(dir, 'node_modules', 'pg', 'package.json'), JSON.stringify({ name: 'pg', type: 'module', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', 'pg', 'index.js'), FAKE_PG)
  const log = join(dir, 'pg.log')
  writeFileSync(log, '')
  const { server, state } = await startStub({ overrides, at, devTokens })
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(dir, 'scripts', 'ops', 'staging-tasks-smoke.mjs')], {
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          BASE_URL: `http://127.0.0.1:${server.address().port}`,
          DATABASE_URL: 'postgresql://fake',
          DEPLOY_SHA: 'abc123',
          STAMP,
          SUBJECT_TOKEN: tokenFor(STAMP),
          MEMBER_TOKEN: tokenFor(MEMBER),
          OUTSIDER_TOKEN: tokenFor(OUTSIDER),
          FAKE_PG_LOG: log,
          FAKE_PG_TASK_TABLES: KNOWN_TASK_ID_TABLES.join(','),
          FAKE_PG_FOREIGN_ROWS: JSON.stringify(FOREIGN_ROWS),
          FAKE_PG_RUN_ROWS: JSON.stringify(RUN_ROWS),
          ...pgEnv,
          ...env,
        },
      })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      child.on('close', (code) => resolve({ code, out }))
    })
    const entries = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const sql = entries.filter((entry) => 'text' in entry)
    const deleted = entries.filter((entry) => entry.deleted).map((entry) => entry.deleted)
    const remaining = entries.find((entry) => entry.remaining)?.remaining ?? null
    // Every test: no request named a task or comment id the stub never issued, or a member sub
    // that is not a seeded identity (such a read gets the same 404 a row-level denial gets).
    assert.deepEqual(state.unissued, [], `a request named an id the stub never issued\n${result.out}`)
    return { ...result, sql, deleted, remaining, calls: state.calls, trace: state.trace, mismatches: state.mismatches, mints: state.mints }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

const issued = (sql, prefix) => sql.some((entry) => entry.text.startsWith(prefix))

// The exact normalized SQL the smoke issues. A widened or narrowed WHERE clause, a dropped count or
// a changed parameter list fails these pins.
const IDENTITY_RESIDUE_COUNTS = [
  ['users', 'users', 'id = ANY($1::text[])'],
  ['user_orgs', 'user_orgs', 'user_id = ANY($1::text[])'],
  ['user_roles', 'user_roles', 'user_id = ANY($1::text[]) OR role_id = ANY($2::text[])'],
  ['admissions', 'user_namespace_admissions', 'user_id = ANY($1::text[])'],
  ['roles', 'roles', 'id = ANY($2::text[])'],
  ['role_permissions', 'role_permissions', 'role_id = ANY($2::text[])'],
  ['tasks_by_creator', 'tasks', 'created_by = ANY($1::text[])'],
  ['task_assignees_by_user', 'task_assignees', 'user_id = ANY($1::text[])'],
  ['task_followers_by_user', 'task_followers', 'user_id = ANY($1::text[])'],
  ['task_comments_by_author', 'task_comments', 'author_id = ANY($1::text[])'],
  ['task_events_by_actor', 'task_events', 'actor_id = ANY($1::text[])'],
]
const REGCLASS_TABLES = [
  ['users', 'users_ok'], ['user_orgs', 'user_orgs_ok'], ['roles', 'roles_ok'], ['role_permissions', 'role_permissions_ok'],
  ['user_roles', 'user_roles_ok'], ['permissions', 'permissions_ok'], ['user_namespace_admissions', 'admissions_ok'],
  ['tasks', 'tasks_ok'], ['task_assignees', 'task_assignees_ok'], ['task_followers', 'task_followers_ok'],
  ['task_events', 'task_events_ok'], ['task_comments', 'task_comments_ok'],
]
const SQL = {
  regclass: `SELECT ${REGCLASS_TABLES.map(([table, alias]) => `to_regclass('public.${table}') IS NOT NULL AS ${alias}`).join(', ')}`,
  m4Regclass: `SELECT ${M4_TASK_TABLES.map((table) => `to_regclass('public.${table}') IS NOT NULL AS ${table}_ok`).join(', ')}`,
  permissions: "SELECT count(*)::int AS n FROM permissions WHERE code IN ('tasks:read', 'tasks:write')",
  identityResidue: `SELECT ${IDENTITY_RESIDUE_COUNTS.map(([alias, table, where]) => `(SELECT count(*)::int FROM ${table} WHERE ${where}) AS ${alias}`).join(', ')}`,
  roles: 'INSERT INTO roles (id, name) VALUES ($1, $1), ($2, $2) ON CONFLICT (id) DO NOTHING',
  rolePermissions: "INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'tasks:read'), ($1, 'tasks:write'), ($2, 'tasks:read') ON CONFLICT DO NOTHING",
  users: "INSERT INTO users ( id, email, name, password_hash, role, permissions, is_active, activation_status, local_password_set, must_change_password ) VALUES ($1, $2, $3, 'no-login', 'user', '[]'::jsonb, TRUE, 'activated', TRUE, FALSE) ON CONFLICT (id) DO UPDATE SET is_active = true, email = EXCLUDED.email, name = EXCLUDED.name",
  userRoles: 'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $2), ($4, $5) ON CONFLICT DO NOTHING',
  userOrgs: 'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE) ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true',
  admission: "INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source, granted_by, updated_by, created_at, updated_at) VALUES ($1, 'tasks', TRUE, 'staging_window_runner_smoke', $1, $1, now(), now()) ON CONFLICT (user_id, namespace) DO UPDATE SET enabled = TRUE, updated_at = now()",
  owned: 'SELECT count(*)::int AS n FROM tasks WHERE id = $1 AND created_by = $2 AND title = $3 AND org_id = $4',
  collect: 'SELECT id FROM tasks WHERE created_by = ANY($1::text[])',
  enumerate: "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE c.table_schema = 'public' AND c.column_name = 'task_id' AND t.table_type = 'BASE TABLE' ORDER BY c.table_name",
  taskIdCount: (table) => `SELECT count(*)::int AS n FROM public."${table}" WHERE "task_id"::text = ANY($1::text[])`,
  tasksById: 'SELECT count(*)::int AS n FROM tasks WHERE id = ANY($1::text[])',
}
// FK-safe cleanup order; each DELETE with the parameter lists it is bound to. Every task DELETE
// selects its rows by the seeded creators in the statement itself: none is bound to a task id.
const OWN_TASKS = 'SELECT id FROM tasks WHERE created_by = ANY($1::text[])'
const CLEANUP_DELETES = [
  [`DELETE FROM task_comments WHERE task_id IN (${OWN_TASKS})`, 'users'],
  [`DELETE FROM task_events WHERE task_id IN (${OWN_TASKS})`, 'users'],
  [`DELETE FROM task_followers WHERE task_id IN (${OWN_TASKS})`, 'users'],
  [`DELETE FROM task_assignees WHERE task_id IN (${OWN_TASKS})`, 'users'],
  ['DELETE FROM tasks WHERE created_by = ANY($1::text[])', 'users'],
  ['DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', 'users'],
  ['DELETE FROM user_roles WHERE user_id = ANY($1::text[]) OR role_id = ANY($2::text[])', 'users+roles'],
  ['DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', 'users'],
  ['DELETE FROM users WHERE id = ANY($1::text[])', 'users'],
  ['DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', 'roles'],
  ['DELETE FROM roles WHERE id = ANY($1::text[])', 'roles'],
]

function expectedCleanup() {
  const bound = { users: [SEEDED_USERS], 'users+roles': [SEEDED_USERS, SEEDED_ROLES], roles: [SEEDED_ROLES] }
  return [{ text: SQL.collect, params: [SEEDED_USERS] }, ...CLEANUP_DELETES.map(([text, kind]) => ({ text, params: bound[kind] }))]
}

// The ownership check of one created task: its id, the subject, the title the run sent, the org.
const ownedCheck = (taskId, title) => ({ text: SQL.owned, params: [taskId, STAMP, title, 'default'] })

function expectedResidue(taskIds = TASK_IDS, tables = KNOWN_TASK_ID_TABLES) {
  return [
    { text: SQL.identityResidue, params: [SEEDED_USERS, SEEDED_ROLES] },
    { text: SQL.enumerate, params: [] },
    ...tables.map((table) => ({ text: SQL.taskIdCount(table), params: [taskIds] })),
    { text: SQL.tasksById, params: [taskIds] },
  ]
}

const expectedPreflight = () => [
  { text: SQL.regclass, params: [] },
  { text: SQL.m4Regclass, params: [] },
  { text: SQL.permissions, params: [] },
  { text: SQL.identityResidue, params: [SEEDED_USERS, SEEDED_ROLES] },
]

const FOREIGN_TASK_IDS = FOREIGN_ROWS.filter(({ table }) => table === 'tasks').map(({ row }) => row.id)

// Cleanup is the collect query plus every DELETE, exact text and parameters, once, or twice when
// main() cleaned up before failing on its recorded assertions. Each pass is followed by the
// residue queries over the run's task ids: the tasks the seeded identities created, as collected
// so far (the second pass adds the tasks it collects by creator then, so `secondPassTaskIds` may
// be longer). No other DELETE is issued, no cleanup or residue statement is bound to a foreign
// task's id, cleanup removes no row this run did not write, and no row this run wrote is left.
function assertFullCleanup(r, label, { taskIds = TASK_IDS, secondPassTaskIds = taskIds } = {}) {
  const starts = r.sql.flatMap((entry, index) => (entry.text === SQL.collect ? [index] : []))
  assert.ok(starts.length === 1 || starts.length === 2, `${label}: cleanup runs once or twice, ran ${starts.length} times`)
  for (const [pass, start] of starts.entries()) {
    const expected = [...expectedCleanup(), ...expectedResidue(pass === 0 ? taskIds : secondPassTaskIds)]
    assert.deepEqual(r.sql.slice(start, start + expected.length), expected, `${label}: cleanup and residue statements, text and parameters`)
  }
  assert.equal(r.sql.filter((entry) => entry.text.startsWith('DELETE')).length, starts.length * CLEANUP_DELETES.length, `${label}: no other DELETE`)
  const boundToForeign = r.sql.slice(starts[0]).filter((entry) => FOREIGN_TASK_IDS.some((id) => JSON.stringify(entry.params).includes(JSON.stringify(id))))
  assert.deepEqual(boundToForeign, [], `${label}: a cleanup or residue statement is bound to a foreign task's id`)
  assert.deepEqual(r.deleted.filter((row) => row.origin === 'foreign' || row.origin === 'preexisting'), [], `${label}: cleanup deleted a row this run did not write`)
  assert.ok(Array.isArray(r.remaining), `${label}: the pool must be ended`)
  assert.deepEqual(r.remaining.filter((row) => row.origin === 'seed' || row.origin === 'run'), [], `${label}: a row this run wrote is left`)
  assert.equal(r.remaining.filter((row) => row.origin === 'foreign').length, FOREIGN_ROWS.length, `${label}: every foreign row survives`)
}

// Rows keyed by one seeded user (or role) in every table the identity residue counts.
function rowsForUser(userId) {
  return [
    { table: 'users', row: { id: userId } },
    { table: 'user_orgs', row: { user_id: userId, org_id: 'default' } },
    { table: 'user_roles', row: { user_id: userId, role_id: 'attendance_employee' } },
    { table: 'user_namespace_admissions', row: { user_id: userId, namespace: 'tasks' } },
    { table: 'tasks', row: { id: `tsk_by_${userId}`, created_by: userId } },
    { table: 'task_assignees', row: { task_id: 'tsk_foreign', user_id: userId } },
    { table: 'task_followers', row: { task_id: 'tsk_foreign', user_id: userId } },
    { table: 'task_comments', row: { id: `tcmt_by_${userId}`, task_id: 'tsk_foreign', author_id: userId } },
    { table: 'task_events', row: { task_id: 'tsk_foreign', actor_id: userId } },
  ]
}
function rowsForRole(roleId) {
  return [
    { table: 'roles', row: { id: roleId } },
    { table: 'role_permissions', row: { role_id: roleId, permission_code: 'tasks:read' } },
    { table: 'user_roles', row: { user_id: 'someone-else', role_id: roleId } },
  ]
}
const ZERO_RESIDUE = Object.fromEntries(IDENTITY_RESIDUE_COUNTS.map(([alias]) => [alias, 0]))
const USER_RESIDUE = { ...ZERO_RESIDUE, users: 1, user_orgs: 1, user_roles: 1, admissions: 1, tasks_by_creator: 1, task_assignees_by_user: 1, task_followers_by_user: 1, task_comments_by_author: 1, task_events_by_actor: 1 }
const ROLE_RESIDUE = { ...ZERO_RESIDUE, user_roles: 1, roles: 1, role_permissions: 1 }
const nonZero = (counts) => Object.fromEntries(Object.entries(counts).filter(([, value]) => value !== 0))

// Every HTTP call of a passing run, in order: [route key, step name, task id, sub id]. The task id
// and sub id are the call's target (absent: the path carries none). The step names are what the
// wrong-shape cells below target.
const CALLS = [
  ['context', 'subject context before admission'],
  ['context', 'subject context after admission'],
  ['create', 'create parent'],
  ['list', 'view=created list'],
  ['complete', 'complete', PARENT],
  ['reopen', 'reopen', PARENT],
  ['detail', 'P0-A read', PARENT],
  ['create', 'create child'],
  ['candidates', "child's parent candidates", CHILD],
  ['parent', 'set-parent', CHILD],
  ['detail', 'child after set-parent', CHILD],
  ['detail', 'parent after set-parent', PARENT],
  ['candidates', "parent's candidates with its child set", PARENT],
  ['parent', 'clear-parent', CHILD],
  ['detail', 'child after clear-parent', CHILD],
  ['detail', 'parent after clear-parent', PARENT],
  ['parent', 'set-parent again', CHILD],
  ['detail', 'child after the second set-parent', CHILD],
  ['assignee.add', 'add-assignee', PARENT],
  ['detail', 'after add-assignee', PARENT],
  ['assignee.remove', 'remove-assignee', PARENT, MEMBER],
  ['detail', 'after remove-assignee', PARENT],
  ['follower.add', 'add-follower', PARENT],
  ['detail', 'after add-follower', PARENT],
  ['follower.remove', 'remove-follower', PARENT, MEMBER],
  ['detail', 'after remove-follower', PARENT],
  ['follower.add', 'add-follower again', PARENT],
  ['member.leave', 'member leaves', PARENT],
  ['detail', 'after the member left', PARENT],
  ['mode', "completion-mode 'any'", PARENT],
  ['detail', "after completion-mode 'any'", PARENT],
  ['mode', "completion-mode 'all'", PARENT],
  ['detail', "after completion-mode 'all'", PARENT],
  ['comment.create', 'comment create', PARENT],
  ['comment.update', 'comment edit', PARENT, COMMENT],
  ['comment.list', 'comment list after the edit', PARENT],
  ['comment.delete', 'comment delete', PARENT, COMMENT],
  ['comment.list', 'comment list after the delete', PARENT],
  ['outsider.context', 'outsider context'],
  ['outsider.detail', 'outsider read', PARENT],
  ['delete', 'delete parent with a live child', PARENT],
  ['delete', 'delete child', CHILD],
  ['delete', 'delete parent', PARENT],
  ['detail', 'read deleted parent', PARENT],
  ['detail', 'read deleted child', CHILD],
]
// The method each route key is registered under (ROUTE_KEYS is `<METHOD> <shape>` -> key).
const METHOD_OF = new Map([...ROUTE_KEYS].map(([methodAndShape, key]) => [key, methodAndShape.split(' ')[0]]))
// The trace a passing run must produce: every call's method, route key, task id and sub id.
const EXPECTED_TRACE = CALLS.map(([key, , id = null, sub = null]) => ({ method: METHOD_OF.get(key.replace(/^(outsider|member)\./, '')), key, id, sub }))

// An `at` entry that changes the honest answer of one step; the request at that index must be the
// step's own call (method, key, task id, sub id), or the run records a mismatch.
function atStep(step, change) {
  const index = stepIndex(step)
  return { [index]: { ...EXPECTED_TRACE[index], change } }
}

// Every assertion the smoke makes on a passing run (its `Assertions passed:` line).
const HAPPY_PATH_ASSERTIONS = 100

test('HARNESS happy path: gate, P0-A and every M3 step in order, residue enumerated over every task_id table, zero residue, PASS line', async () => {
  const r = await runSmoke()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /TASKS_API_DB_SMOKE_PASS deploy=abc123 stamp=tasks-smoke-t1 org=default task=tsk_1 residue=0/)
  assert.match(r.out, new RegExp(`^Assertions passed: ${HAPPY_PATH_ASSERTIONS}$`, 'm'), 'every assertion of a passing run is counted; a deleted assertion changes the count')
  assert.doesNotMatch(r.out, /FAIL/)
  assert.deepEqual(r.trace, EXPECTED_TRACE, 'gate, P0-A and every M3 step, in order, each with its method, key, task id and sub id')
  assert.match(r.out, /  PASS  cleanup residue is zero across 16 counts/)
  // Every statement, in order, with its parameters: the preflight, the seed (the member and the
  // outsider are admitted at seed time, the subject only after the 403 check), the ownership
  // check of each created task, cleanup of both smoke tasks and every identity, then the residue
  // counts.
  assert.deepEqual(r.sql, [
    ...expectedPreflight(),
    { text: SQL.roles, params: SEEDED_ROLES },
    { text: SQL.rolePermissions, params: SEEDED_ROLES },
    ...SEEDED_USERS.map((userId) => ({ text: SQL.users, params: [userId, `${userId}@example.test`, userId] })),
    { text: SQL.userRoles, params: [STAMP, ROLE, MEMBER, OUTSIDER, OUTSIDER_ROLE] },
    ...SEEDED_USERS.map((userId) => ({ text: SQL.userOrgs, params: [userId, 'default'] })),
    { text: SQL.admission, params: [MEMBER] },
    { text: SQL.admission, params: [OUTSIDER] },
    { text: SQL.admission, params: [STAMP] },
    ownedCheck('tsk_1', STAMP),
    ownedCheck('tsk_2', `${STAMP} child`),
    ...expectedCleanup(),
    ...expectedResidue(),
  ])
  assertFullCleanup(r, 'happy path')
  assert.deepEqual(r.remaining.map(({ origin }) => origin), FOREIGN_ROWS.map(() => 'foreign'), 'only the foreign rows remain')
})

// --- wrong-shaped answers: one cell per assertion (and per clause of a compound assertion) -----
//
// Each cell changes the honest answer of exactly one call (its `step`) and names the assertion
// that must catch it (`fail`, the smoke's own label). Every cell must end with: a nonzero exit,
// no PASS line, its own `  FAIL  <label>` line (or `message` for a guard that throws without an
// assertion line), full cleanup and a clean residue recheck. A cell marked `stops` must also end
// the HTTP flow at its step (the smoke throws there); any other cell must let the run carry on to
// the end with exactly one failed assertion, its own.

const withStatus = (code) => (res) => ({ status: code, body: res.body })
const withBody = (patch) => (res) => ({ status: res.status, body: { ...res.body, ...patch } })
const mapBody = (fn) => (res) => ({ status: res.status, body: fn(res.body) })
const answer = (code, body) => () => ({ status: code, body })
const dropAssignee = (userId) => mapBody((body) => ({ ...body, assignees: body.assignees.filter((row) => row.userId !== userId) }))
const addAssignee = (userId) => mapBody((body) => ({ ...body, assignees: [...body.assignees, { userId, completedAt: null }] }))
const commentRow = (patch) => mapBody((body) => ({ ...body, items: body.items.map((item) => ({ ...item, ...patch })) }))
const OWNED = 'the DB holds the created task as the subject\'s, with the title it sent, in org default'
const notOwned = (id) => `POST /api/tasks answered id "${id}", which the DB does not hold as a task ${STAMP} created in org default with the title this run sent`

const SHAPE_CELLS = [
  // gate
  { step: 'subject context before admission', what: '404 (flag off)', change: answer(404, { error: 'Not Found' }), message: 'GET /api/tasks/context -> 404: TASKS_ENABLED is not live', stops: true },
  { step: 'subject context before admission', what: '401', change: answer(401, { error: 'Unauthorized' }), message: "GET /api/tasks/context -> 401: this smoke's own auth/tenant seed is wrong", stops: true },
  { step: 'subject context before admission', what: '200 before admission', change: answer(200, { orgId: 'default' }), fail: 'GET /api/tasks/context is 403 BEFORE the namespace admission row exists (role_permissions+user_roles alone must be insufficient)', message: 'SECURITY: expected 403 without a user_namespace_admissions row, got 200', stops: true },
  { step: 'subject context after admission', what: 'status 500', change: withStatus(500), fail: 'GET /api/tasks/context -> 200 (status 500)' },
  { step: 'subject context after admission', what: 'another org', change: withBody({ orgId: 'other-org' }), fail: 'context orgId resolves to the tenant claim (default)' },
  // P0-A
  { step: 'create parent', what: 'status 500', change: answer(500, INTERNAL), fail: 'POST /api/tasks -> 200 (status 500)', message: 'POST /api/tasks did not return an id', stops: true },
  { step: 'create parent', what: 'status 201', change: withStatus(201), fail: 'POST /api/tasks -> 200 (status 201)' },
  { step: 'create parent', what: 'empty id', change: withBody({ id: '' }), fail: 'created task carries an id', message: 'POST /api/tasks did not return an id', stops: true },
  { step: 'create parent', what: 'non-string id', change: withBody({ id: ['tsk_1'] }), fail: 'created task carries an id', message: 'POST /api/tasks did not return an id', stops: true },
  // The id of another identity's task (same org, same title): only the creator tells it apart.
  { step: 'create parent', what: "a foreign task's id", change: withBody({ id: 'tsk_foreign' }), fail: OWNED, message: notOwned('tsk_foreign'), stops: true },
  { step: 'view=created list', what: 'status 202', change: withStatus(202), fail: 'GET /api/tasks?view=created -> 200 (status 202)' },
  { step: 'view=created list', what: 'task missing', change: withBody({ items: [] }), fail: 'created task is visible under view=created' },
  { step: 'complete', what: 'status 202', change: withStatus(202), fail: 'POST /api/tasks/:id/complete -> 200 (status 202)' },
  { step: 'complete', what: 'not done', change: withBody({ done: false }), fail: 'complete transitions the single-assignee task to done' },
  { step: 'reopen', what: 'status 202', change: withStatus(202), fail: "POST /api/tasks/:id/reopen {scope:'self'} -> 200 (status 202)" },
  { step: 'reopen', what: 'not acknowledged', change: withBody({ ok: false }), fail: 'reopen acknowledges' },
  { step: 'P0-A read', what: 'status 203', change: withStatus(203), fail: 'GET /api/tasks/:id -> 200 (status 203)' },
  { step: 'P0-A read', what: 'another id', change: withBody({ id: 'tsk_other' }), fail: 'read-back id matches the created task' },
  { step: 'P0-A read', what: 'still done', change: withBody({ status: 'done' }), fail: 'the reopened task reads back open' },
  // subtask
  { step: 'create child', what: 'status 201', change: withStatus(201), fail: 'POST /api/tasks -> 200 (status 201)' },
  { step: 'create child', what: 'empty id', change: withBody({ id: '' }), fail: 'created task carries an id', message: 'POST /api/tasks did not return an id', stops: true },
  { step: 'create child', what: "a foreign task's id", change: withBody({ id: 'tsk_foreign' }), fail: OWNED, message: notOwned('tsk_foreign'), stops: true },
  // The run's own parent: created by the subject in the org, but not with the title just sent.
  { step: 'create child', what: "the parent's id", change: withBody({ id: 'tsk_1' }), fail: OWNED, message: notOwned('tsk_1'), stops: true },
  { step: "child's parent candidates", what: 'status 500', change: answer(500, INTERNAL), fail: 'GET /api/tasks/:id/parent-candidates (child) -> 200 (status 500)', stops: true },
  { step: "child's parent candidates", what: 'no items list', change: answer(200, { results: [{ id: 'tsk_1', title: STAMP }] }), fail: "the child's parent candidates are exactly the parent {id, title}" },
  { step: "child's parent candidates", what: 'empty', change: withBody({ items: [] }), fail: "the child's parent candidates are exactly the parent {id, title}" },
  { step: "child's parent candidates", what: 'an extra task', change: mapBody((body) => ({ items: [...body.items, { id: 'tsk_foreign', title: 'someone else' }] })), fail: "the child's parent candidates are exactly the parent {id, title}" },
  { step: "child's parent candidates", what: 'another task', change: withBody({ items: [{ id: 'tsk_foreign', title: STAMP }] }), fail: "the child's parent candidates are exactly the parent {id, title}" },
  { step: "child's parent candidates", what: 'another title', change: withBody({ items: [{ id: 'tsk_1', title: 'other title' }] }), fail: "the child's parent candidates are exactly the parent {id, title}" },
  { step: 'set-parent', what: 'status 500', change: answer(500, INTERNAL), fail: 'PATCH /api/tasks/:id/parent (set) -> 200 (status 500)', stops: true },
  { step: 'set-parent', what: 'another id', change: withBody({ id: 'tsk_other' }), fail: 'set-parent answers {id, parentId: parent, depth: 1}' },
  { step: 'set-parent', what: "a foreign task's id", change: withBody({ id: 'tsk_foreign' }), fail: 'set-parent answers {id, parentId: parent, depth: 1}' },
  { step: 'set-parent', what: 'another parent', change: withBody({ parentId: 'tsk_other' }), fail: 'set-parent answers {id, parentId: parent, depth: 1}' },
  { step: 'set-parent', what: 'depth 0', change: withBody({ depth: 0 }), fail: 'set-parent answers {id, parentId: parent, depth: 1}' },
  { step: 'child after set-parent', what: 'status 500', change: answer(500, INTERNAL), fail: 'GET /api/tasks/:id (child after set-parent) -> 200 (status 500)', stops: true },
  { step: 'child after set-parent', what: 'parentId null', change: withBody({ parentId: null }), fail: 'the child reads back parentId = parent and depth 1' },
  { step: 'child after set-parent', what: 'depth 0', change: withBody({ depth: 0 }), fail: 'the child reads back parentId = parent and depth 1' },
  { step: 'parent after set-parent', what: 'no children', change: withBody({ children: [] }), fail: 'the parent reads back the child under children with depth 1' },
  { step: 'parent after set-parent', what: 'no children list', change: withBody({ children: null }), fail: 'the parent reads back the child under children with depth 1' },
  // The child is looked up by its id and its depth is read: another task listed at depth 1, or the
  // child listed at depth 0, is not the child under its parent.
  { step: 'parent after set-parent', what: 'another child', change: withBody({ children: [{ id: 'tsk_other', depth: 1 }] }), fail: 'the parent reads back the child under children with depth 1' },
  { step: 'parent after set-parent', what: 'child at depth 0', change: withBody({ children: [{ id: 'tsk_2', depth: 0 }] }), fail: 'the parent reads back the child under children with depth 1' },
  { step: "parent's candidates with its child set", what: 'status 500', change: answer(500, INTERNAL), fail: 'GET /api/tasks/:id/parent-candidates (parent with its child set) -> 200 (status 500)', stops: true },
  { step: "parent's candidates with its child set", what: 'no items list', change: answer(200, {}), fail: "the parent's candidates leave out itself and its own child, so none are left" },
  { step: "parent's candidates with its child set", what: 'its own child', change: withBody({ items: [{ id: 'tsk_2', title: `${STAMP} child` }] }), fail: "the parent's candidates leave out itself and its own child, so none are left" },
  { step: 'clear-parent', what: 'another id', change: withBody({ id: 'tsk_other' }), fail: 'clear-parent answers {id, parentId: null, depth: 0}' },
  { step: 'clear-parent', what: 'parent kept', change: withBody({ parentId: 'tsk_1' }), fail: 'clear-parent answers {id, parentId: null, depth: 0}' },
  { step: 'clear-parent', what: 'depth 1', change: withBody({ depth: 1 }), fail: 'clear-parent answers {id, parentId: null, depth: 0}' },
  { step: 'child after clear-parent', what: 'parent kept', change: withBody({ parentId: 'tsk_1' }), fail: 'the child reads back parentId null and depth 0' },
  { step: 'child after clear-parent', what: 'depth 1', change: withBody({ depth: 1 }), fail: 'the child reads back parentId null and depth 0' },
  { step: 'parent after clear-parent', what: 'child still listed', change: withBody({ children: [{ id: 'tsk_2', depth: 1 }] }), fail: 'the parent no longer lists the child' },
  { step: 'parent after clear-parent', what: 'no children list', change: withBody({ children: null }), fail: 'the parent no longer lists the child' },
  { step: 'set-parent again', what: 'parentId null', change: withBody({ parentId: null }), fail: 'set-parent again answers depth 1' },
  { step: 'set-parent again', what: 'depth 0', change: withBody({ depth: 0 }), fail: 'set-parent again answers depth 1' },
  { step: 'child after the second set-parent', what: 'parentId null', change: withBody({ parentId: null }), fail: 'the child reads back the parent again' },
  { step: 'child after the second set-parent', what: 'depth 0', change: withBody({ depth: 0 }), fail: 'the child reads back the parent again' },
  // assignees
  { step: 'add-assignee', what: 'status 500', change: answer(500, INTERNAL), fail: 'POST /api/tasks/:id/assignees (member) -> 200 (status 500)', stops: true },
  { step: 'add-assignee', what: 'another id', change: withBody({ id: 'tsk_other' }), fail: 'add-assignee answers the open task' },
  { step: 'add-assignee', what: 'done', change: withBody({ status: 'done' }), fail: 'add-assignee answers the open task' },
  { step: 'add-assignee', what: 'member missing', change: dropAssignee(MEMBER), fail: 'add-assignee answers both the subject and the member as assignees' },
  { step: 'add-assignee', what: 'subject missing', change: dropAssignee(STAMP), fail: 'add-assignee answers both the subject and the member as assignees' },
  { step: 'add-assignee', what: 'no assignees list', change: withBody({ assignees: null }), fail: 'add-assignee answers both the subject and the member as assignees' },
  { step: 'after add-assignee', what: 'member missing', change: dropAssignee(MEMBER), fail: 'the task reads back the member as an assignee' },
  { step: 'after add-assignee', what: 'no assignees list', change: withBody({ assignees: null }), fail: 'the task reads back the member as an assignee' },
  { step: 'remove-assignee', what: 'status 500', change: answer(500, INTERNAL), fail: 'DELETE /api/tasks/:id/assignees/:userId (member) -> 200 (status 500)', stops: true },
  { step: 'remove-assignee', what: 'member kept', change: addAssignee(MEMBER), fail: 'remove-assignee answers the subject without the member' },
  { step: 'remove-assignee', what: 'subject gone', change: dropAssignee(STAMP), fail: 'remove-assignee answers the subject without the member' },
  { step: 'remove-assignee', what: 'done', change: withBody({ status: 'done' }), fail: 'remove-assignee leaves the task open (the remaining assignee has not completed)' },
  { step: 'after remove-assignee', what: 'member kept', change: addAssignee(MEMBER), fail: 'the task no longer reads back the member as an assignee' },
  { step: 'after remove-assignee', what: 'no assignees list', change: withBody({ assignees: null }), fail: 'the task no longer reads back the member as an assignee' },
  // followers
  { step: 'add-follower', what: 'status 500', change: answer(500, INTERNAL), fail: 'POST /api/tasks/:id/followers (member) -> 200 (status 500)', stops: true },
  { step: 'add-follower', what: 'another id', change: withBody({ id: 'tsk_other' }), fail: 'add-follower answers the member among the followers' },
  { step: 'add-follower', what: 'member missing', change: withBody({ followers: [] }), fail: 'add-follower answers the member among the followers' },
  { step: 'add-follower', what: 'no followers list', change: withBody({ followers: null }), fail: 'add-follower answers the member among the followers' },
  { step: 'after add-follower', what: 'member missing', change: withBody({ followers: [] }), fail: 'the task reads back the member as a follower' },
  { step: 'after add-follower', what: 'no followers list', change: withBody({ followers: null }), fail: 'the task reads back the member as a follower' },
  { step: 'remove-follower', what: 'status 500', change: answer(500, INTERNAL), fail: 'DELETE /api/tasks/:id/followers/:userId (member) -> 200 (status 500)', stops: true },
  { step: 'remove-follower', what: 'another id', change: withBody({ id: 'tsk_other' }), fail: 'remove-follower answers the followers without the member' },
  { step: 'remove-follower', what: 'member kept', change: withBody({ followers: [MEMBER] }), fail: 'remove-follower answers the followers without the member' },
  { step: 'remove-follower', what: 'no followers list', change: withBody({ followers: null }), fail: 'remove-follower answers the followers without the member' },
  { step: 'after remove-follower', what: 'member kept', change: withBody({ followers: [MEMBER] }), fail: 'the task no longer reads back the member as a follower' },
  { step: 'after remove-follower', what: 'no followers list', change: withBody({ followers: null }), fail: 'the task no longer reads back the member as a follower' },
  // follower self-leave
  { step: 'add-follower again', what: 'status 500', change: answer(500, INTERNAL), fail: 'POST /api/tasks/:id/followers (member, again) -> 200 (status 500)', stops: true },
  { step: 'add-follower again', what: 'another id', change: withBody({ id: 'tsk_other' }), fail: 'add-follower again answers the member among the followers' },
  { step: 'add-follower again', what: 'member missing', change: withBody({ followers: [] }), fail: 'add-follower again answers the member among the followers' },
  { step: 'add-follower again', what: 'no followers list', change: withBody({ followers: null }), fail: 'add-follower again answers the member among the followers' },
  { step: 'member leaves', what: '404 (not a follower)', change: answer(404, { error: { code: 'NOT_FOUND' } }), fail: 'POST /api/tasks/:id/leave (member) -> 200 (status 404)', stops: true },
  { step: 'member leaves', what: 'another id', change: withBody({ id: 'tsk_other' }), fail: "the member's leave answers the followers without the member" },
  { step: 'member leaves', what: 'member kept', change: withBody({ followers: [MEMBER] }), fail: "the member's leave answers the followers without the member" },
  { step: 'member leaves', what: 'no followers list', change: withBody({ followers: null }), fail: "the member's leave answers the followers without the member" },
  { step: 'after the member left', what: 'status 500', change: answer(500, INTERNAL), fail: 'GET /api/tasks/:id (after the member left) -> 200 (status 500)', stops: true },
  { step: 'after the member left', what: 'member kept', change: withBody({ followers: [MEMBER] }), fail: 'after the member leaves, the task no longer reads back the member as a follower' },
  { step: 'after the member left', what: 'no followers list', change: withBody({ followers: null }), fail: 'after the member leaves, the task no longer reads back the member as a follower' },
  // completion mode
  { step: "completion-mode 'any'", what: 'status 500', change: answer(500, INTERNAL), fail: 'PATCH /api/tasks/:id/completion-mode (any) -> 200 (status 500)', stops: true },
  { step: "completion-mode 'any'", what: 'another id', change: withBody({ id: 'tsk_other' }), fail: "completion-mode switch answers completionMode 'any'" },
  { step: "completion-mode 'any'", what: "answers 'all'", change: withBody({ completionMode: 'all' }), fail: "completion-mode switch answers completionMode 'any'" },
  { step: "completion-mode 'any'", what: 'done', change: withBody({ status: 'done' }), fail: "the switch to 'any' leaves the task open (no assignee has completed)" },
  { step: "after completion-mode 'any'", what: "reads 'all'", change: withBody({ completionMode: 'all' }), fail: "the task reads back completionMode 'any'" },
  { step: "completion-mode 'all'", what: 'status 500', change: answer(500, INTERNAL), fail: 'PATCH /api/tasks/:id/completion-mode (all) -> 200 (status 500)', stops: true },
  { step: "completion-mode 'all'", what: "answers 'any'", change: withBody({ completionMode: 'any' }), fail: "completion-mode switch answers completionMode 'all'" },
  { step: "completion-mode 'all'", what: 'done', change: withBody({ status: 'done' }), fail: "the switch to 'all' leaves the task open (no assignee has completed)" },
  { step: "after completion-mode 'all'", what: "reads 'any'", change: withBody({ completionMode: 'any' }), fail: "the task reads back completionMode 'all'" },
  // comments
  { step: 'comment create', what: 'status 500', change: answer(500, INTERNAL), fail: 'POST /api/tasks/:id/comments -> 200 (status 500)', stops: true },
  { step: 'comment create', what: 'non-string id', change: withBody({ id: 42 }), fail: 'the new comment answers its id, task, author and body', message: 'POST /api/tasks/:id/comments did not return an id', stops: true },
  { step: 'comment create', what: 'another task', change: withBody({ taskId: 'tsk_other' }), fail: 'the new comment answers its id, task, author and body' },
  { step: 'comment create', what: "a foreign task's id", change: withBody({ taskId: 'tsk_foreign' }), fail: 'the new comment answers its id, task, author and body' },
  { step: 'comment create', what: 'another author', change: withBody({ authorId: 'someone-else' }), fail: 'the new comment answers its id, task, author and body' },
  { step: 'comment create', what: 'another body', change: withBody({ body: 'other text' }), fail: 'the new comment answers its id, task, author and body' },
  { step: 'comment create', what: 'deleted', change: withBody({ deleted: true }), fail: 'the new comment answers its id, task, author and body' },
  { step: 'comment edit', what: 'status 500', change: answer(500, INTERNAL), fail: 'PATCH /api/tasks/:id/comments/:commentId -> 200 (status 500)', stops: true },
  { step: 'comment edit', what: 'another id', change: withBody({ id: 'tcmt_other' }), fail: 'the edited comment answers the new body' },
  { step: 'comment edit', what: 'old body', change: withBody({ body: `${STAMP} comment` }), fail: 'the edited comment answers the new body' },
  { step: 'comment edit', what: 'deleted', change: withBody({ deleted: true }), fail: 'the edited comment answers the new body' },
  { step: 'comment list after the edit', what: 'status 500', change: answer(500, INTERNAL), fail: 'GET /api/tasks/:id/comments (after the edit) -> 200 (status 500)', stops: true },
  { step: 'comment list after the edit', what: 'old body', change: commentRow({ body: `${STAMP} comment` }), fail: 'the edited comment reads back with the new body' },
  { step: 'comment list after the edit', what: 'row deleted', change: commentRow({ deleted: true }), fail: 'the edited comment reads back with the new body' },
  { step: 'comment list after the edit', what: 'row removed', change: answer(200, { items: [], total: 1 }), fail: 'the edited comment reads back with the new body' },
  { step: 'comment list after the edit', what: 'items not a list', change: answer(200, { items: {}, total: 1 }), fail: 'the edited comment reads back with the new body' },
  // A decoy with the new body under another id: the row must be found by its own id.
  { step: 'comment list after the edit', what: 'another comment with the new body', change: answer(200, { items: [{ id: 'tcmt_other', body: `${STAMP} comment edited`, deleted: false }], total: 1 }), fail: 'the edited comment reads back with the new body' },
  { step: 'comment delete', what: 'status 500', change: answer(500, INTERNAL), fail: 'DELETE /api/tasks/:id/comments/:commentId -> 200 (status 500)', stops: true },
  { step: 'comment delete', what: 'another id', change: withBody({ id: 'tcmt_other' }), fail: 'the deleted comment answers the tombstone shape (deleted: true, body: null)' },
  { step: 'comment delete', what: 'not deleted', change: withBody({ deleted: false }), fail: 'the deleted comment answers the tombstone shape (deleted: true, body: null)' },
  { step: 'comment delete', what: 'body kept', change: withBody({ body: 'still here' }), fail: 'the deleted comment answers the tombstone shape (deleted: true, body: null)' },
  { step: 'comment list after the delete', what: 'status 500', change: answer(500, INTERNAL), fail: 'GET /api/tasks/:id/comments (after the delete) -> 200 (status 500)', stops: true },
  { step: 'comment list after the delete', what: 'row removed', change: answer(200, { items: [], total: 1 }), fail: 'the deleted comment reads back as a tombstone' },
  { step: 'comment list after the delete', what: 'row not deleted', change: commentRow({ deleted: false }), fail: 'the deleted comment reads back as a tombstone' },
  { step: 'comment list after the delete', what: 'row keeps its body', change: commentRow({ body: 'still here' }), fail: 'the deleted comment reads back as a tombstone' },
  { step: 'comment list after the delete', what: 'total 0', change: withBody({ total: 0 }), fail: 'the tombstone still counts in total' },
  { step: 'comment list after the delete', what: 'items not a list', change: answer(200, { items: {}, total: 1 }), fail: 'the deleted comment reads back as a tombstone' },
  // Another comment's tombstone: the deleted comment must be found by its own id.
  { step: 'comment list after the delete', what: 'another comment as the tombstone', change: answer(200, { items: [{ id: 'tcmt_other', deleted: true, body: null }], total: 1 }), fail: 'the deleted comment reads back as a tombstone' },
  // outsider
  { step: 'outsider context', what: 'status 500', change: answer(500, INTERNAL), fail: 'outsider GET /api/tasks/context -> 200 (status 500)', stops: true },
  { step: 'outsider context', what: '403 (not admitted)', change: answer(403, { error: 'Insufficient permissions' }), message: 'outsider GET /api/tasks/context -> 403: the outsider is not admitted to the tasks namespace', stops: true },
  { step: 'outsider context', what: 'org null', change: withBody({ orgId: null }), fail: "the outsider's tenant claim resolves to default", message: 'outsider context orgId is null, not default', stops: true },
  { step: 'outsider read', what: '200', change: answer(200, { id: 'tsk_1' }), message: 'SECURITY: an admitted tasks:read user with no relation to the task read it (200)', stops: true },
  { step: 'outsider read', what: '403', change: answer(403, { error: 'Insufficient permissions' }), message: 'outsider GET /api/tasks/:id -> 403: the RBAC gate refused the admitted outsider', stops: true },
  { step: 'outsider read', what: '404 with another code', change: answer(404, { error: { code: 'GONE' } }), fail: 'an admitted tasks:read user with no relation to the task gets 404 NOT_FOUND' },
  { step: 'outsider read', what: '500 with NOT_FOUND', change: answer(500, { error: { code: 'NOT_FOUND' } }), fail: 'an admitted tasks:read user with no relation to the task gets 404 NOT_FOUND', message: 'outsider GET /api/tasks/:id: expected 404, got 500', stops: true },
  // delete
  { step: 'delete parent with a live child', what: '409 with another code', change: answer(409, { error: { code: 'CONFLICT' } }), fail: 'DELETE of the parent while its child is live is 409 HAS_CHILDREN' },
  { step: 'delete parent with a live child', what: '500 with HAS_CHILDREN', change: answer(500, { error: { code: 'HAS_CHILDREN' } }), fail: 'DELETE of the parent while its child is live is 409 HAS_CHILDREN', message: 'DELETE parent with a live child: expected 409 HAS_CHILDREN, got 500', stops: true },
  { step: 'delete parent with a live child', what: 'not refused', change: answer(200, { id: 'tsk_1', deleted: true }), fail: 'DELETE of the parent while its child is live is 409 HAS_CHILDREN', message: 'DELETE parent with a live child: expected 409 HAS_CHILDREN, got 200', stops: true },
  { step: 'delete child', what: 'status 500', change: answer(500, INTERNAL), fail: 'DELETE /api/tasks/:id (child) -> 200 (status 500)', stops: true },
  { step: 'delete child', what: 'another id', change: withBody({ id: 'tsk_other' }), fail: 'deleting the child answers {id, deleted: true}' },
  { step: 'delete child', what: "a foreign task's id", change: withBody({ id: 'tsk_foreign' }), fail: 'deleting the child answers {id, deleted: true}' },
  { step: 'delete child', what: 'not deleted', change: withBody({ deleted: false }), fail: 'deleting the child answers {id, deleted: true}' },
  { step: 'delete parent', what: 'status 500', change: answer(500, INTERNAL), fail: 'DELETE /api/tasks/:id (parent) -> 200 (status 500)', stops: true },
  { step: 'delete parent', what: 'not deleted', change: withBody({ deleted: false }), fail: 'deleting the parent answers {id, deleted: true}' },
  { step: 'read deleted parent', what: '404 with another code', change: answer(404, { error: { code: 'GONE' } }), fail: 'reading the deleted parent is 404 NOT_FOUND' },
  { step: 'read deleted parent', what: '500 with NOT_FOUND', change: answer(500, { error: { code: 'NOT_FOUND' } }), fail: 'reading the deleted parent is 404 NOT_FOUND', message: 'GET deleted parent: expected 404, got 500', stops: true },
  { step: 'read deleted child', what: '404 with another code', change: answer(404, { error: { code: 'GONE' } }), fail: 'reading the deleted child is 404 NOT_FOUND' },
  { step: 'read deleted child', what: '200', change: answer(200, { id: 'tsk_2' }), fail: 'reading the deleted child is 404 NOT_FOUND', message: 'GET deleted child: expected 404, got 200', stops: true },
]

function stepIndex(step) {
  const index = CALLS.findIndex(([, name]) => name === step)
  assert.notEqual(index, -1, `unknown step: ${step}`)
  return index
}

test('HARNESS cell table: every step it names exists, and every cell names what must catch it', () => {
  const names = new Set()
  for (const cell of SHAPE_CELLS) {
    stepIndex(cell.step)
    assert.ok(cell.fail || cell.message, `${cell.step} / ${cell.what}: a cell must name a FAIL label or a message`)
    const name = `${cell.step} / ${cell.what}`
    assert.ok(!names.has(name), `duplicate cell: ${name}`)
    names.add(name)
  }
  for (const [, step] of CALLS) {
    assert.ok(SHAPE_CELLS.some((cell) => cell.step === step), `step "${step}" has no wrong-shape cell`)
  }
})

test('HARNESS wrong-shaped answers: each one fails the run on its own assertion, prints no PASS line and still cleans up', { concurrency: 8 }, async (t) => {
  await Promise.all(SHAPE_CELLS.map((cell) => t.test(`${cell.step} / ${cell.what}`, async () => {
    const index = stepIndex(cell.step)
    const r = await runSmoke({ at: atStep(cell.step, cell.change) })
    assert.deepEqual(r.mismatches, [], 'the change must land on its own step')
    assert.notEqual(r.code, 0, `must exit nonzero\n${r.out}`)
    assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/, 'no PASS line')
    if (cell.fail) assert.ok(r.out.includes(`  FAIL  ${cell.fail}`), `expected the line "  FAIL  ${cell.fail}"\n${r.out}`)
    if (cell.message) assert.ok(r.out.includes(cell.message), `expected "${cell.message}"\n${r.out}`)
    if (cell.stops) {
      assert.deepEqual(r.trace, EXPECTED_TRACE.slice(0, index + 1), 'the run must stop at this step, every call so far on its own target')
    } else {
      assert.deepEqual(r.trace, EXPECTED_TRACE, 'a content failure is recorded and the run carries on to the end, every call on its own target')
      assert.ok(r.out.includes(`tasks API/DB smoke had 1 failed assertion(s): ${cell.fail}\n`), `exactly this one assertion fails\n${r.out}`)
    }
    assert.match(r.out, /Residue after best-effort cleanup: \{\} \(clean=true\)/, 'residue is recomputed after cleanup')
    assertFullCleanup(r, `${cell.step} / ${cell.what}`)
  })))
})

test('HARNESS the stub traces each request\'s method, key, task id and sub id, lists every id it never issued, and an `at` change must match the whole target', async () => {
  const swap = { method: 'GET', key: 'detail', id: CHILD, sub: null, change: (res) => res }
  const { server, state } = await startStub({ at: { 2: swap } })
  const base = `http://127.0.0.1:${server.address().port}`
  const send = async (method, pathname, { token = tokenFor(STAMP), body } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    await res.text()
  }
  try {
    await send('GET', '/api/tasks/context')
    await send('POST', '/api/tasks', { body: { title: STAMP } })
    await send('GET', `/api/tasks/${PARENT}`)
    await send('GET', `/api/tasks/${STAMP}`)
    await send('GET', '/api/tasks/parent', { token: tokenFor(OUTSIDER) })
    await send('DELETE', `/api/tasks/${PARENT}/comments/tcmt_9`)
    await send('DELETE', `/api/tasks/${PARENT}/assignees/someone-else`)
    await send('DELETE', `/api/tasks/${PARENT}/followers/${encodeURIComponent(MEMBER)}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  assert.deepEqual(state.trace, [
    { method: 'GET', key: 'context', id: null, sub: null },
    { method: 'POST', key: 'create', id: null, sub: null },
    { method: 'GET', key: 'detail', id: PARENT, sub: null },
    { method: 'GET', key: 'detail', id: STAMP, sub: null },
    { method: 'GET', key: 'outsider.detail', id: 'parent', sub: null },
    { method: 'DELETE', key: 'comment.delete', id: PARENT, sub: 'tcmt_9' },
    { method: 'DELETE', key: 'assignee.remove', id: PARENT, sub: 'someone-else' },
    { method: 'DELETE', key: 'follower.remove', id: PARENT, sub: MEMBER },
  ])
  assert.deepEqual(state.unissued, [
    { index: 3, method: 'GET', key: 'detail', id: STAMP, sub: null, never: 'task id' },
    { index: 4, method: 'GET', key: 'outsider.detail', id: 'parent', sub: null, never: 'task id' },
    { index: 5, method: 'DELETE', key: 'comment.delete', id: PARENT, sub: 'tcmt_9', never: 'comment id' },
    { index: 6, method: 'DELETE', key: 'assignee.remove', id: PARENT, sub: 'someone-else', never: 'seeded member' },
  ], 'the issued parent and a seeded member are not listed; the stamp, a label, an unknown comment and an unseeded user are')
  assert.deepEqual(state.mismatches, [{ index: 2, expected: { method: 'GET', key: 'detail', id: CHILD, sub: null }, actual: { method: 'GET', key: 'detail', id: PARENT, sub: null } }], 'an `at` change that lands on the right route but another task is a mismatch')
})

test('HARNESS a missing env refuses with exit 2 before any request or query', async () => {
  const r = await runSmoke({ env: { BASE_URL: '' } })
  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /FAIL: BASE_URL and DATABASE_URL are required\./)
  assert.deepEqual(r.trace, [])
  assert.deepEqual(r.sql, [])
})

test('HARNESS a new task_id table in the database is picked up by the residue enumeration, and its leftover row fails the run', async () => {
  const tables = [...KNOWN_TASK_ID_TABLES, 'task_widgets']
  const clean = await runSmoke({ pgEnv: { FAKE_PG_TASK_TABLES: tables.join(',') } })
  assert.equal(clean.code, 0, clean.out)
  assert.match(clean.out, /  PASS  cleanup residue is zero across 17 counts/)
  assert.deepEqual(clean.sql.slice(-expectedResidue(TASK_IDS, tables).length), expectedResidue(TASK_IDS, tables), 'the enumerated table is counted by the run task ids')

  const dirty = await runSmoke({ pgEnv: { FAKE_PG_TASK_TABLES: tables.join(','), FAKE_PG_PLANTED_ROWS: JSON.stringify([{ table: 'task_widgets', row: { task_id: 'tsk_1' } }]) } })
  assert.notEqual(dirty.code, 0)
  assert.match(dirty.out, /residue not zero: \{"task_widgets\.task_id":1\}/)
  assert.match(dirty.out, /  FAIL  cleanup residue is zero across 17 counts/)
  assert.doesNotMatch(dirty.out, /TASKS_API_DB_SMOKE_PASS/)
})

test('HARNESS a row left in any task table under a run task id, or a tasks row with a run id, fails the residue check', async () => {
  const planted = [
    ...KNOWN_TASK_ID_TABLES.map((table) => ({ table, row: { id: `left_${table}`, task_id: 'tsk_1', user_id: 'someone-else', author_id: 'someone-else', actor_id: 'someone-else' } })),
    { table: 'tasks', row: { id: 'tsk_2', created_by: 'someone-else' } },
  ]
  const r = await runSmoke({ pgEnv: { FAKE_PG_PLANTED_ROWS: JSON.stringify(planted) } })
  const left = JSON.stringify({ 'task_assignees.task_id': 1, 'task_comments.task_id': 1, 'task_events.task_id': 1, 'task_followers.task_id': 1, 'tasks.id': 1 })
  assert.notEqual(r.code, 0)
  assert.ok(r.out.includes(`residue not zero: ${left}`), r.out)
  assert.match(r.out, /  FAIL  cleanup residue is zero across 16 counts/)
  assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/)
  assertFullCleanup(r, 'task rows left')
  // Cleanup never deletes by a remembered task id. These rows appear once the run's own tasks are
  // gone, and another identity wrote them (the tasks row is another creator's), so the second pass
  // deletes none of them and the residue keeps reporting them.
  assert.deepEqual(r.deleted.filter((row) => row.origin === 'planted'), [], 'cleanup deleted a row another identity wrote under a run task id')
  assert.ok(r.out.includes(`Residue after best-effort cleanup: ${left} (clean=false)`), r.out)
})

test('HARNESS a created task the DB holds in another org fails its ownership check: the run stops at the create and cleans up', async () => {
  const runRows = RUN_ROWS.map((entry) => (entry.table === 'tasks' && entry.row.id === 'tsk_1' ? { table: 'tasks', row: { ...entry.row, org_id: 'other-org' } } : entry))
  const r = await runSmoke({ pgEnv: { FAKE_PG_RUN_ROWS: JSON.stringify(runRows) } })
  assert.notEqual(r.code, 0)
  assert.ok(r.out.includes(`  FAIL  ${OWNED}`), r.out)
  assert.ok(r.out.includes(notOwned('tsk_1')), r.out)
  assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/)
  assert.deepEqual(r.trace, EXPECTED_TRACE.slice(0, stepIndex('create parent') + 1), 'the run stops at the create')
  assert.match(r.out, /Residue after best-effort cleanup: \{\} \(clean=true\)/)
  assertFullCleanup(r, 'task in another org')
})

test('HARNESS the residue still counts the run\'s own tasks when an answer was not used: a row left under the task a create made, whatever id it answered, or under a verified task when the collect query fails', async () => {
  // A table with a task_id column and no FK to tasks (like bpmn_audit_log or
  // dingtalk_approval_card_deliveries on staging): cleanup never deletes from it, residue counts it.
  const tables = [...KNOWN_TASK_ID_TABLES, 'task_widgets'].join(',')
  const widgetRow = JSON.stringify([{ table: 'task_widgets', row: { task_id: 'tsk_1' } }])
  const left = JSON.stringify({ 'task_widgets.task_id': 1 })

  // The create answered a foreign task's id: the task it really made (tsk_1) is never verified, so
  // only the collect query (by creator, before the DELETEs) puts it among the run's task ids.
  const answered = await runSmoke({
    at: atStep('create parent', withBody({ id: 'tsk_foreign' })),
    pgEnv: { FAKE_PG_TASK_TABLES: tables, FAKE_PG_PLANTED_ROWS: widgetRow },
  })
  assert.notEqual(answered.code, 0)
  assert.ok(answered.out.includes(notOwned('tsk_foreign')), answered.out)
  assert.ok(answered.out.includes(`Residue after best-effort cleanup: ${left} (clean=false)`), answered.out)

  // The collect query fails: the verified creates alone are the run's task ids.
  const collectFailed = await runSmoke({ pgEnv: { FAKE_PG_THROW_ON: SQL.collect, FAKE_PG_TASK_TABLES: tables, FAKE_PG_PLANTED_ROWS: widgetRow } })
  assert.notEqual(collectFailed.code, 0)
  assert.ok(collectFailed.out.includes(`residue not zero: ${left}`), collectFailed.out)
  assert.doesNotMatch(collectFailed.out, /TASKS_API_DB_SMOKE_PASS/)
})

test('HARNESS a failing collect query: every task DELETE still selects the seeded identities\' tasks itself, and the residue counts the verified task ids', async () => {
  const r = await runSmoke({ pgEnv: { FAKE_PG_THROW_ON: SQL.collect } })
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes(`  WARN  cleanup statement failed: collect task ids: fake failure on: ${SQL.collect}`), r.out)
  assert.match(r.out, /TASKS_API_DB_SMOKE_PASS/)
  assertFullCleanup(r, 'collect query failed')
})

test('HARNESS an enumeration that misses a known task table refuses a residue verdict', async () => {
  const r = await runSmoke({ pgEnv: { FAKE_PG_TASK_TABLES: 'task_events' } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /residue enumeration did not see the task tables task_assignees, task_comments, task_followers/)
  assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/)
})

test('HARNESS a MEMBER_TOKEN for another subject is refused after seeding, with cleanup', async () => {
  const r = await runSmoke({ env: { MEMBER_TOKEN: tokenFor(STAMP) } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /MEMBER_TOKEN subject "tasks-smoke-t1" does not equal its identity "tasks-smoke-t1-member"/)
  assert.deepEqual(r.trace, [], 'no request is made with a mismatched token')
  assertFullCleanup(r, 'member token mismatch')
})

test('HARNESS an OUTSIDER_TOKEN for another subject is refused after seeding, with cleanup', async () => {
  const r = await runSmoke({ env: { OUTSIDER_TOKEN: tokenFor('tasks-smoke-other') } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /OUTSIDER_TOKEN subject "tasks-smoke-other" does not equal its identity "tasks-smoke-t1-outsider"/)
  assert.deepEqual(r.trace, [], 'no request is made with a mismatched token')
  assertFullCleanup(r, 'outsider token mismatch')
})

test('HARNESS 200 before the admission row exists is a SECURITY failure: nonzero exit, no PASS line, cleanup still runs', async () => {
  const r = await runSmoke({ overrides: { context: { status: 200, body: { orgId: 'default' } } } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /SECURITY: expected 403 without a user_namespace_admissions row, got 200/)
  assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/)
  const admissionGrants = r.sql.filter((entry) => entry.text.startsWith('INSERT INTO user_namespace_admissions')).map((entry) => entry.params[0])
  assert.deepEqual(admissionGrants, [MEMBER, OUTSIDER], 'must stop before granting the subject its admission row')
  assertFullCleanup(r, 'subject admitted too early')
})

// The seed INSERTs in the order the smoke issues them. Cleanup is armed before the first one, so a
// failure at ANY of them must still run the full cleanup; the tables written before the failing
// INSERT are the ones whose seed rows must be deleted.
const SEED_INSERT_TABLES = ['roles', 'role_permissions', 'users', 'user_roles', 'user_orgs', 'user_namespace_admissions']

test('HARNESS a seed INSERT failing at any table still runs the full cleanup and deletes the rows written before it', async (t) => {
  for (const [position, table] of SEED_INSERT_TABLES.entries()) {
    await t.test(`INSERT INTO ${table} fails`, async () => {
      // The trailing ` (` keeps one table's prefix from matching another's INSERT.
      const prefix = `INSERT INTO ${table} (`
      const r = await runSmoke({ pgEnv: { FAKE_PG_THROW_ON: prefix } })
      assert.notEqual(r.code, 0, r.out)
      assert.ok(r.out.includes(`fake failure on: ${prefix}`), `the failure is the seed INSERT\n${r.out}`)
      assert.deepEqual(r.trace, [], 'no request is made before seeding completes')
      assert.match(r.out, /Residue after best-effort cleanup: \{\} \(clean=true\)/, 'residue is recomputed after cleanup')
      // The fake store adds the run's rows (both tasks among them) with the first INSERT that goes
      // through, so when the very first INSERT fails no task exists and the residue counts no ids.
      assertFullCleanup(r, `seed INSERT into ${table} failed`, { taskIds: position === 0 ? [] : TASK_IDS })
      const written = SEED_INSERT_TABLES.slice(0, position)
      for (const before of written) {
        assert.ok(r.deleted.some((row) => row.table === before && row.origin === 'seed'), `the ${before} rows written before the failure are deleted`)
      }
      assert.deepEqual([...new Set(r.deleted.filter((row) => row.origin === 'seed').map((row) => row.table))].sort(), [...written].sort(), 'only seed rows written before the failure exist to delete')
    })
  }
})

test('HARNESS nonzero identity residue after cleanup fails the run with no PASS line', async () => {
  const r = await runSmoke({ pgEnv: { FAKE_PG_PLANTED_ROWS: JSON.stringify([{ table: 'users', row: { id: STAMP } }]) } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /residue not zero: \{"users":1\}/)
  assert.match(r.out, /  FAIL  cleanup residue is zero across 16 counts/)
  assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/)
})

test('HARNESS residue is counted per seeded identity: a row left for any one seeded user or role, in any table, fails the run', async () => {
  const cases = [
    ...SEEDED_USERS.map((userId) => ({ id: userId, rows: rowsForUser(userId), expected: USER_RESIDUE })),
    ...SEEDED_ROLES.map((roleId) => ({ id: roleId, rows: rowsForRole(roleId), expected: ROLE_RESIDUE })),
  ]
  for (const { id, rows, expected } of cases) {
    const r = await runSmoke({ pgEnv: { FAKE_PG_PLANTED_ROWS: JSON.stringify(rows) } })
    assert.notEqual(r.code, 0, `${id}: ${r.out}`)
    assert.ok(r.out.includes(`residue not zero: ${JSON.stringify(nonZero(expected))}`), `${id}: every row left for this identity is counted\n${r.out}`)
    assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/)
    const createdByIdentity = rows.filter(({ table }) => table === 'tasks').map(({ row }) => row.id)
    assertFullCleanup(r, `rows left for ${id}`, { secondPassTaskIds: [...TASK_IDS, ...createdByIdentity] })
  }
})

test('HARNESS pre-existing rows for the stamp: the smoke refuses before writing anything and deletes nothing', async () => {
  const r = await runSmoke({ pgEnv: { FAKE_PG_PREEXISTING_ROWS: JSON.stringify([{ table: 'users', row: { id: STAMP } }]) } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /pre-existing residue found for tasks-smoke-t1/)
  assert.ok(r.out.includes(`  FAIL  no pre-existing rows for any identity of this stamp - ${JSON.stringify({ ...ZERO_RESIDUE, users: 1 })}`), r.out)
  assert.deepEqual(r.trace, [], 'no request is made')
  assert.deepEqual(r.sql, expectedPreflight(), 'the preflight covers every identity and role, and nothing is written or deleted')
  assert.deepEqual(r.deleted, [])
})

test('HARNESS the preflight counts every seeded user and role in every identity table before seeding', async () => {
  const cases = [
    ...SEEDED_USERS.map((userId) => ({ id: userId, rows: rowsForUser(userId), expected: USER_RESIDUE })),
    ...SEEDED_ROLES.map((roleId) => ({ id: roleId, rows: rowsForRole(roleId), expected: ROLE_RESIDUE })),
  ]
  for (const { id, rows, expected } of cases) {
    const r = await runSmoke({ pgEnv: { FAKE_PG_PREEXISTING_ROWS: JSON.stringify(rows) } })
    assert.notEqual(r.code, 0, `${id}: ${r.out}`)
    assert.ok(r.out.includes(`  FAIL  no pre-existing rows for any identity of this stamp - ${JSON.stringify(expected)}`), `${id}: the preflight reports every row of this identity\n${r.out}`)
    assert.deepEqual(r.sql, expectedPreflight(), `${id}: nothing is written or deleted`)
    assert.deepEqual(r.deleted, [], `${id}: nothing is deleted`)
  }
})

test('HARNESS a missing task or RBAC table refuses before writing anything', async () => {
  const r = await runSmoke({ pgEnv: { FAKE_PG_MISSING_TABLE: 'task_comments_ok' } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /  FAIL  DB assertion channel reachable and the P0-A and M3 task tables exist/)
  assert.match(r.out, /staging DB is missing task tables/)
  assert.deepEqual(r.sql, expectedPreflight().slice(0, 1), 'nothing is queried after the refusal, nothing is written or deleted')
  assert.deepEqual(r.trace, [])
})

test('HARNESS a permission catalog without tasks:read/tasks:write refuses before writing anything', async () => {
  const r = await runSmoke({ pgEnv: { FAKE_PG_PERMISSIONS: '1' } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /  FAIL  permission catalog carries tasks:read and tasks:write \(role_permissions FK precondition\)/)
  assert.match(r.out, /permissions table is missing tasks:read\/tasks:write/)
  assert.deepEqual(r.sql, expectedPreflight().slice(0, 3), 'nothing is queried after the refusal, nothing is written or deleted')
  assert.deepEqual(r.trace, [])
})

test('HARNESS without supplied tokens the smoke mints dev tokens for each identity (non-production fallback) and passes', async () => {
  const r = await runSmoke({ env: { SUBJECT_TOKEN: '', MEMBER_TOKEN: '', OUTSIDER_TOKEN: '' } })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /TASKS_API_DB_SMOKE_PASS/)
  assert.deepEqual(r.mints, [
    { userId: STAMP, roles: 'user', perms: 'tasks:read,tasks:write', tenantId: 'default' },
    { userId: MEMBER, roles: 'user', perms: 'tasks:read,tasks:write', tenantId: 'default' },
    { userId: OUTSIDER, roles: 'user', perms: 'tasks:read', tenantId: 'default' },
  ])
})

test('HARNESS without supplied tokens and without a dev-token route the smoke refuses after seeding, with cleanup', async () => {
  const r = await runSmoke({ env: { SUBJECT_TOKEN: '', MEMBER_TOKEN: '', OUTSIDER_TOKEN: '' }, devTokens: false })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /could not mint dev-token for tasks-smoke-t1 \(status 404\)/)
  assert.deepEqual(r.trace, [], 'no tasks request is made without a token')
  assertFullCleanup(r, 'no dev-token route')
})

// M4 PR-3a (design §9.2): the task routes of this image read three M4 tables, so a database
// without the M4 migration must fail preflight by name, before any seed row is written.
test('preflight lists exactly the three M4 tables the task routes read', () => {
  assert.deepEqual([...M4_TASK_TABLES], ['task_list_items', 'task_list_members', 'task_user_settings'])
  const source = readFileSync(script, 'utf8')
  for (const table of M4_TASK_TABLES) {
    assert.ok(source.includes(`to_regclass('public.${table}') IS NOT NULL AS ${table}_ok`), `preflight must probe ${table}`)
  }
})

for (const table of ['task_list_items', 'task_list_members', 'task_user_settings']) {
  test(`HARNESS a database without ${table} fails preflight naming the M4 migration; nothing is written or deleted`, async () => {
    const r = await runSmoke({ pgEnv: { FAKE_PG_MISSING_TABLE: `${table}_ok` } })
    assert.notEqual(r.code, 0)
    assert.match(r.out, new RegExp(`M4 task tables do not exist \\(${table}\\): the task routes in this image need the M4 migration`))
    assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/)
    assert.ok(!r.sql.some((entry) => entry.text.startsWith('INSERT')), 'no seed row may be written')
    assert.ok(!r.sql.some((entry) => entry.text.startsWith('DELETE')), 'cleanup must not touch rows this run did not write')
    assert.deepEqual(r.sql, expectedPreflight().slice(0, 2), 'nothing is queried after the refusal')
    assert.deepEqual(r.trace, [])
  })
}
