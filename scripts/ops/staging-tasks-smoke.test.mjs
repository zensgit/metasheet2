import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  STAMP_PATTERN,
  isStampedId,
  jwtSubject,
  assertNotAdminRoleId,
  roleIdForStamp,
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

test('roleIdForStamp is the exact wiring the smoke uses for ROLE_ID: "<stamp>-role", never an _admin id', () => {
  assert.equal(roleIdForStamp('tasks-smoke-gh1a1'), 'tasks-smoke-gh1a1-role')
  assert.ok(!roleIdForStamp('tasks-smoke-gh1a1').endsWith('_admin'))
  const source = readFileSync(script, 'utf8')
  assert.match(source, /^const ROLE_ID = roleIdForStamp\(STAMP\)$/m, 'ROLE_ID must be computed through roleIdForStamp')
})

// --- executable runtime harness ---------------------------------------------------------------
//
// Runs the real smoke script as a child process against a fake `pg` package (resolved from a
// temp node_modules next to a copy of the script; ESM ignores NODE_PATH) and a local HTTP stub.
// This exercises the runtime guards the source-level tests above cannot: the 403-before-admission
// gate, cleanup on the failure path (including a seed that fails partway), and the residue check.

const FAKE_PG = `import { appendFileSync } from 'node:fs'
const LOG = process.env.FAKE_PG_LOG
const THROW_ON = process.env.FAKE_PG_THROW_ON || ''
const RESIDUE = process.env.FAKE_PG_RESIDUE === '1'
const DIRTY_PREFLIGHT = process.env.FAKE_PG_DIRTY_PREFLIGHT === '1'
let residueQueries = 0
class Pool {
  async query(text) {
    const flat = String(text).replace(/\\s+/g, ' ').trim()
    appendFileSync(LOG, JSON.stringify(flat) + '\\n')
    if (THROW_ON && flat.includes(THROW_ON)) throw new Error('fake failure on: ' + THROW_ON)
    if (flat.includes('to_regclass(')) return { rows: [{ users_ok: true, tasks_ok: true }] }
    if (flat.includes('FROM permissions WHERE code IN')) return { rows: [{ n: 2 }] }
    if (flat.includes(' AS users,')) {
      residueQueries += 1
      const dirty = (DIRTY_PREFLIGHT && residueQueries === 1) || (RESIDUE && residueQueries > 1)
      return { rows: [{ users: dirty ? 1 : 0, roles: 0, tasks: 0 }] }
    }
    return { rows: [], rowCount: 0 }
  }
  async end() {}
}
export default { Pool }
`

const HAPPY = {
  contextBeforeAdmission: { status: 403, body: { error: 'forbidden' } },
  context: { status: 200, body: { orgId: 'default' } },
  create: { status: 200, body: { id: 'tsk_x' } },
  list: { status: 200, body: { items: [{ id: 'tsk_x' }] } },
  complete: { status: 200, body: { done: true } },
  reopen: { status: 200, body: { ok: true } },
  detail: { status: 200, body: { id: 'tsk_x' } },
}

function startStub(routes) {
  let contextCalls = 0
  const server = createServer((req, res) => {
    let picked
    const url = new URL(req.url, 'http://stub')
    if (url.pathname === '/api/tasks/context') {
      contextCalls += 1
      picked = contextCalls === 1 ? routes.contextBeforeAdmission : routes.context
    } else if (req.method === 'POST' && url.pathname === '/api/tasks') picked = routes.create
    else if (req.method === 'GET' && url.pathname === '/api/tasks') picked = routes.list
    else if (url.pathname.endsWith('/complete')) picked = routes.complete
    else if (url.pathname.endsWith('/reopen')) picked = routes.reopen
    else if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/')) picked = routes.detail
    else picked = { status: 404, body: { error: 'not found' } }
    req.resume()
    res.writeHead(picked.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(picked.body))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function runSmoke({ routes = HAPPY, pgEnv = {}, source = script } = {}) {
  // realpath: the smoke's IS_MAIN check compares import.meta.url with argv[1], and macOS tmpdir()
  // is a /var -> /private/var symlink, so an unresolved path would silently skip main().
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'tasks-smoke-harness-'))
  mkdirSync(join(dir, 'scripts', 'ops'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'pg'), { recursive: true })
  copyFileSync(source, join(dir, 'scripts', 'ops', 'staging-tasks-smoke.mjs'))
  writeFileSync(join(dir, 'node_modules', 'pg', 'package.json'), JSON.stringify({ name: 'pg', type: 'module', main: 'index.js' }))
  writeFileSync(join(dir, 'node_modules', 'pg', 'index.js'), FAKE_PG)
  const log = join(dir, 'pg.log')
  writeFileSync(log, '')
  const server = await startStub(routes)
  const stamp = 'tasks-smoke-t1'
  const token = `h.${Buffer.from(JSON.stringify({ userId: stamp })).toString('base64url')}.s`
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(dir, 'scripts', 'ops', 'staging-tasks-smoke.mjs')], {
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          BASE_URL: `http://127.0.0.1:${server.address().port}`,
          DATABASE_URL: 'postgresql://fake',
          DEPLOY_SHA: 'abc123',
          STAMP: stamp,
          SUBJECT_TOKEN: token,
          FAKE_PG_LOG: log,
          ...pgEnv,
        },
      })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      child.on('close', (code) => resolve({ code, out }))
    })
    const sql = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    return { ...result, sql }
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
}

const issued = (sql, prefix) => sql.some((text) => text.startsWith(prefix))

test('HARNESS happy path: 403 before admission, 200 after, full create/list/complete/reopen/read, zero residue, PASS line', async () => {
  const r = await runSmoke()
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /TASKS_API_DB_SMOKE_PASS deploy=abc123 stamp=tasks-smoke-t1/)
  assert.ok(issued(r.sql, 'INSERT INTO user_namespace_admissions'), 'admission must be granted after the 403 check')
  assert.ok(issued(r.sql, 'DELETE FROM users WHERE id = $1'))
})

test('HARNESS 200 before the admission row exists is a SECURITY failure: nonzero exit, no PASS line, cleanup still runs', async () => {
  const r = await runSmoke({ routes: { ...HAPPY, contextBeforeAdmission: { status: 200, body: { orgId: 'default' } } } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /SECURITY: expected 403 without a user_namespace_admissions row, got 200/)
  assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/)
  assert.ok(!issued(r.sql, 'INSERT INTO user_namespace_admissions'), 'must stop before granting the admission row')
  for (const table of ['users', 'roles', 'user_roles', 'role_permissions', 'user_namespace_admissions']) {
    assert.ok(issued(r.sql, `DELETE FROM ${table} WHERE`), `cleanup must delete ${table}`)
  }
})

test('HARNESS an HTTP step failing after the seed still runs cleanup and exits nonzero', async () => {
  const r = await runSmoke({ routes: { ...HAPPY, create: { status: 500, body: { error: 'boom' } } } })
  assert.notEqual(r.code, 0)
  assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/)
  for (const table of ['users', 'roles', 'user_roles', 'role_permissions', 'user_orgs']) {
    assert.ok(issued(r.sql, `DELETE FROM ${table} WHERE`), `cleanup must delete ${table}`)
  }
})

test('HARNESS a seed INSERT failing partway still cleans up the rows written before it', async () => {
  const r = await runSmoke({ pgEnv: { FAKE_PG_THROW_ON: 'INSERT INTO users' } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /fake failure on: INSERT INTO users/)
  assert.ok(issued(r.sql, 'DELETE FROM roles WHERE id = $1'), 'the role written before the failure must be deleted')
  assert.ok(issued(r.sql, 'DELETE FROM role_permissions WHERE role_id = $1'), 'the role grants written before the failure must be deleted')
})

test('HARNESS nonzero residue after cleanup fails the run with no PASS line', async () => {
  const r = await runSmoke({ pgEnv: { FAKE_PG_RESIDUE: '1' } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /residue not zero/)
  assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/)
})

test('HARNESS a non-throwing assertion failure (created task missing from view=created) still fails the run', async () => {
  const r = await runSmoke({ routes: { ...HAPPY, list: { status: 200, body: { items: [] } } } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /FAIL {2}created task is visible under view=created/)
  assert.match(r.out, /had 1 failed assertion/)
  assert.doesNotMatch(r.out, /TASKS_API_DB_SMOKE_PASS/)
})

test('HARNESS pre-existing rows for the stamp: the smoke refuses before writing anything and deletes nothing', async () => {
  const r = await runSmoke({ pgEnv: { FAKE_PG_DIRTY_PREFLIGHT: '1' } })
  assert.notEqual(r.code, 0)
  assert.match(r.out, /pre-existing residue found for tasks-smoke-t1/)
  assert.ok(!r.sql.some((text) => text.startsWith('INSERT')), 'no seed row may be written')
  assert.ok(!r.sql.some((text) => text.startsWith('DELETE')), 'cleanup must not touch rows this run did not write')
})
