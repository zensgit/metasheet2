import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import type { Pool, PoolClient } from 'pg'
import ts from 'typescript'
import { expect, it } from 'vitest'

type CacheEntry = { orgId: string; userId: string; expiresAt: number }
type Database = { query(sql: string, params?: unknown[]): Promise<unknown[]> }
type Consumer = (token: string, input: { db: Database | null; orgId: string; userId: string }) => Promise<boolean>
const pluginPath = fileURLToPath(new URL('../../../../plugins/plugin-attendance/index.cjs', import.meta.url))
const pluginRequire = createRequire(pluginPath)

// Execute exact production declarations with isolated process-local caches and real SQL.
// This proves the private consumer contract, not HTTP/RBAC or deployed business duplication.
function consumer(enforced: boolean, entries: Array<[string, CacheEntry]> = []) {
  const source = readFileSync(pluginPath, 'utf8')
  const ast = ts.createSourceFile(pluginPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const named = (name: string) => {
    const nodes = ast.statements.filter(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name)
    expect(nodes).toHaveLength(1)
    return nodes[0].getText(ast)
  }
  const imports = ast.statements.filter(node => ts.isVariableStatement(node) &&
    node.getText(ast).includes("require('./lib/attendance-import-token-consumer.cjs')"))
  expect(imports.length).toBeLessThanOrEqual(1)
  const context = vm.createContext({ Date, Map, require: pluginRequire, requireImportCommitToken: enforced,
    importCommitTokens: new Map(entries) })
  vm.runInContext([...imports.map(node => node.getText(ast)), named('HttpError'), named('isDatabaseSchemaError'),
    named('pruneImportCommitTokens'), named('pruneImportCommitTokensDb'), named('consumeImportCommitToken'),
    'globalThis.consume = consumeImportCommitToken'].join('\n'), context)
  return context.consume as Consumer
}
const facade = (client: Pool | PoolClient): Database => ({ async query(sql, params) {
  return (await client.query(sql, params)).rows
} })
async function fixture(pool: Pool, expired = false) {
  const orgId = randomUUID(), userId = randomUUID(), token = randomUUID()
  const expiresAt = Date.now() + (expired ? -60000 : 120000)
  await pool.query('INSERT INTO attendance_import_tokens (token,org_id,user_id,expires_at,created_at) VALUES ($1,$2,$3,$4,now())',
    [token, orgId, userId, new Date(expiresAt)])
  return { orgId, userId, token, expiresAt,
    row: async () => (await pool.query('SELECT token,org_id,user_id,expires_at FROM attendance_import_tokens WHERE token=$1', [token])).rows,
    cleanup: async () => { await pool.query('DELETE FROM attendance_import_tokens WHERE org_id=$1', [orgId]) } }
}

export function registerImportTokenConcurrencyNativeCases(getPool: () => Pool) {
  it.each(['cold', 'cached', 'mixed'] as const)('PSP02_TOKEN_RACE_%s: two isolated consumers admit exactly one contender after native lock contention', async (cacheMode) => {
    const pool = getPool(), f = await fixture(pool)
    const clients: PoolClient[] = [], pending: Array<Promise<boolean>> = []
    try {
      for (let i = 0; i < 3; i++) clients.push(await pool.connect())
      const [locker, first, second] = clients
      const pids = await Promise.all(clients.map(async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number))
      expect(new Set(pids).size).toBe(3)
      await locker.query('BEGIN')
      await locker.query('SELECT token FROM attendance_import_tokens WHERE token=$1 FOR UPDATE', [f.token])
      const cache: Array<[string, CacheEntry]> = [[f.token, { orgId: f.orgId, userId: f.userId, expiresAt: f.expiresAt }]]
      pending.push(consumer(true, cacheMode === 'cold' ? [] : cache)(f.token, { ...f, db: facade(first) }))
      pending.push(consumer(true, cacheMode === 'cached' ? cache : [])(f.token, { ...f, db: facade(second) }))
      for (const p of pending) p.catch(() => {})
      let blocked = false
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const result = await pool.query<{ a: number[]; b: number[] }>('SELECT pg_blocking_pids($1::int) AS a,pg_blocking_pids($2::int) AS b', pids.slice(1))
        const { a, b } = result.rows[0]
        if (a.length && b.length && [...a, ...b].includes(pids[0]) && [...a, ...b].every(pid => pids.includes(pid))) {
          blocked = true; break
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(blocked, 'PSP02_NATIVE_BOTH_CONTENDERS_BLOCKED').toBe(true)
      await locker.query('COMMIT')
      const accepted = await Promise.all(pending)
      expect(accepted.filter(Boolean), 'PSP02_SINGLE_DURABLE_CONSUMER').toHaveLength(1)
      expect(accepted.filter(v => !v)).toHaveLength(1)
      expect(await f.row()).toEqual([])
      console.log('PSP02_NATIVE_RECEIPT ' + JSON.stringify({ cacheMode, isolatedCaches: 2,
        nativeBlockedContenders: 2, accepted: 1, rejected: 1, tokenRowsRemaining: 0, publicHttpProof: false }))
    } finally {
      if (clients[0]) await clients[0].query('ROLLBACK')
      await Promise.allSettled(pending)
      for (const c of clients) c.release()
      await f.cleanup()
    }
  }, 120000)

  it('PSP02_TOKEN_SCOPE: wrong organization and requester preserve the token; owner consumes once', async () => {
    const pool = getPool(), f = await fixture(pool)
    try {
      const initial = await f.row(), run = consumer(true)
      expect(await run(f.token, { db: facade(pool), orgId: randomUUID(), userId: f.userId })).toBe(false)
      expect(await f.row()).toEqual(initial)
      expect(await run(f.token, { db: facade(pool), orgId: f.orgId, userId: randomUUID() })).toBe(false)
      expect(await f.row()).toEqual(initial)
      expect(await run(f.token, { ...f, db: facade(pool) })).toBe(true)
      expect(await run(f.token, { ...f, db: facade(pool) })).toBe(false)
      expect(await f.row()).toEqual([])
    } finally { await f.cleanup() }
  })
  it('PSP02_TOKEN_STALE_CACHE: an unexpired local cache cannot revive a deleted durable token', async () => {
    const pool = getPool(), f = await fixture(pool)
    try {
      const run = consumer(true, [[f.token, f]])
      await pool.query('DELETE FROM attendance_import_tokens WHERE token=$1', [f.token])
      expect(await run(f.token, { ...f, db: facade(pool) })).toBe(false)
      expect(await f.row()).toEqual([])
    } finally { await f.cleanup() }
  })
  it('PSP02_TOKEN_EXPIRED: stale cached and uncached tokens both refuse expired durable authority', async () => {
    const pool = getPool(), f = await fixture(pool, true)
    try {
      expect(await consumer(true, [[f.token, { ...f, expiresAt: Date.now() + 120000 }]])(f.token, { ...f, db: facade(pool) })).toBe(false)
      expect(await consumer(true)(f.token, { ...f, db: facade(pool) })).toBe(false)
    } finally { await f.cleanup() }
  })
  it('PSP02_TOKEN_STORAGE: enforcement requires available storage and propagates native SQL failure', async () => {
    const pool = getPool(), f = await fixture(pool), client = await pool.connect()
    try {
      const run = consumer(true, [[f.token, f]])
      await expect(run(f.token, { ...f, db: null })).rejects.toMatchObject({ status: 503, code: 'DB_NOT_READY' })
      await client.query('BEGIN')
      await client.query('SET LOCAL search_path=pg_catalog')
      await expect(run(f.token, { ...f, db: facade(client) })).rejects.toMatchObject({ status: 503, code: 'DB_NOT_READY' })
      await client.query('ROLLBACK')
      const initial = await f.row()
      await expect(run(f.token, { ...f, db: { async query() { return (await client.query('SELECT 1/0')).rows } } })).rejects.toMatchObject({ code: '22012' })
      expect(await f.row()).toEqual(initial)
      await client.query('BEGIN')
      await expect(client.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' })
      await expect(run(f.token, { ...f, db: facade(client) })).rejects.toMatchObject({ code: '25P02' })
      await client.query('ROLLBACK')
      expect(await f.row()).toEqual(initial)
      expect(await run(f.token, { ...f, db: facade(client) })).toBe(true)
    } finally { await client.query('ROLLBACK'); await client.query('RESET search_path'); client.release(); await f.cleanup() }
  })
  it('PSP02_TOKEN_EXPIRY_AT_DELETE: expiry immediately before the native query refuses the atomic deletion', async () => {
    const pool = getPool(), f = await fixture(pool)
    let expiredBeforeDelete = false
    const db: Database = { async query(sql, params) {
      if (!expiredBeforeDelete) {
        await pool.query("UPDATE attendance_import_tokens SET expires_at=clock_timestamp()-interval '1 minute' WHERE token=$1", [f.token])
        expiredBeforeDelete = true
      }
      return (await pool.query(sql, params)).rows
    } }
    try {
      expect(await consumer(true, [[f.token, f]])(f.token, { ...f, db }), 'PSP02_ATOMIC_EXPIRY_PREDICATE').toBe(false)
      expect(expiredBeforeDelete).toBe(true)
      expect(await f.row()).toHaveLength(1)
    } finally { await f.cleanup() }
  })
  it('PSP02_TOKEN_ROLLBACK: caller rollback restores consumed authority and permits a later committed owner', async () => {
    const pool = getPool(), f = await fixture(pool), client = await pool.connect()
    try {
      const original = await f.row(), run = consumer(true, [[f.token, f]])
      await client.query('BEGIN')
      expect(await run(f.token, { ...f, db: facade(client) })).toBe(true)
      expect((await client.query('SELECT token FROM attendance_import_tokens WHERE token=$1', [f.token])).rows).toEqual([])
      await client.query('ROLLBACK')
      expect(await f.row()).toEqual(original)
      expect(await run(f.token, { ...f, db: facade(pool) })).toBe(true)
      expect(await f.row()).toEqual([])
    } finally { await client.query('ROLLBACK'); client.release(); await f.cleanup() }
  })
  it('PSP02_TOKEN_DISABLED: legacy no-database cache behavior remains unchanged', async () => {
    const token = randomUUID(), orgId = randomUUID(), userId = randomUUID()
    const run = consumer(false, [[token, { orgId, userId, expiresAt: Date.now() + 120000 }]])
    expect(await run(token, { db: null, orgId: randomUUID(), userId })).toBe(false)
    expect(await run(token, { db: null, orgId, userId })).toBe(true)
    expect(await run(token, { db: null, orgId, userId })).toBe(false)
  })
}
