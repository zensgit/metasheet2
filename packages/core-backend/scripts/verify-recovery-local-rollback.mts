/** Test-only ordinary-server flag-OFF witness for the owned APFS backup driver. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import type { Pool } from 'pg'

const require = createRequire(import.meta.url)

export interface ManualRollbackInput {
  readonly databaseName: string
  readonly identity: { readonly sheetId: string; readonly actorId: string }
  readonly password: string
  readonly generationId: string
}

export interface ManualRollbackResult {
  readonly responses: Readonly<Record<'catalog' | 'preview', { status: number; body: unknown }>>
  readonly tableCount: number
}

async function snapshot(pool: Pool, sheetId: string) {
  const tables = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public'
       AND left(tablename, length('meta_recovery_'))='meta_recovery_' ORDER BY tablename`,
  )
  const names = tables.rows.map(row => row.tablename)
  for (const required of ['meta_recovery_archives', 'meta_recovery_archive_jobs',
    'meta_recovery_archive_job_chunks', 'meta_recovery_archive_nonce_reservations']) {
    assert.ok(names.includes(required), 'RECOVERY_LOCAL_ROLLBACK_TABLE_MISSING')
  }
  const result: Array<{ table: string; count: number; digest: string }> = []
  for (const table of [...names, 'meta_records', 'meta_record_revisions']) {
    assert.match(table, /^meta_[a-z0-9_]+$/)
    const scoped = table === 'meta_records' || table === 'meta_record_revisions'
    const rows = await pool.query(
      `SELECT to_jsonb(entry) AS value FROM public."${table}" entry
        ${scoped ? 'WHERE sheet_id=$1' : ''} ORDER BY to_jsonb(entry)::text`,
      scoped ? [sheetId] : [],
    )
    result.push({ table, count: rows.rows.length,
      digest: createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex') })
  }
  return result
}

async function run(input: ManualRollbackInput): Promise<ManualRollbackResult> {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED, 'false')
  assert.equal(process.env.MULTITABLE_ENABLE_WRITER_FENCE, 'false')
  const { Pool: PgPool } = require('pg') as typeof import('pg')
  const pool = new PgPool({ connectionString: process.env.DATABASE_URL, max: 2,
    application_name: 'tm_local_rollback' })
  let server: import('../src/index').MetaSheetServer | undefined
  try {
    assert.deepEqual((await pool.query('SELECT current_database() AS name')).rows,
      [{ name: input.databaseName }], 'RECOVERY_LOCAL_ROLLBACK_DATABASE_MISMATCH')
    const before = await snapshot(pool, input.identity.sheetId)
    const { MetaSheetServer } = require('../src/index.ts') as typeof import('../src/index')
    server = new MetaSheetServer({ host: '127.0.0.1', port: 0, manageProcessSignals: false })
    await server.start()
    const address = server.getAddress()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const login = await fetch(`${origin}/api/auth/login`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${input.identity.actorId}@example.test`, password: input.password }),
    })
    assert.equal(login.status, 200, 'RECOVERY_LOCAL_ROLLBACK_LOGIN_FAILED')
    const loginBody = await login.json() as { data?: { token?: unknown } }
    assert.equal(typeof loginBody.data?.token, 'string')
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${loginBody.data.token}` }
    const route = `${origin}/api/multitable/sheets/${encodeURIComponent(input.identity.sheetId)}/recovery-archive`
    const catalog = await fetch(`${route}/catalog?limit=1`, { headers, signal: AbortSignal.timeout(30_000) })
    const preview = await fetch(`${route}/preview`, {
      method: 'POST', headers, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ generationId: input.generationId, mode: 'revert', scope: { kind: 'whole_sheet' } }),
    })
    const responses = {
      catalog: { status: catalog.status, body: await catalog.json() },
      preview: { status: preview.status, body: await preview.json() },
    }
    assert.deepEqual(responses, {
      catalog: { status: 503, body: { ok: false, error: {
        code: 'RECOVERY_ARCHIVE_CATALOG_DISABLED', message: 'Archive recovery is disabled.',
      } } },
      preview: { status: 503, body: { ok: false, error: {
        code: 'RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE', message: 'Archive recovery runtime is unavailable.',
      } } },
    }, 'RECOVERY_LOCAL_ROLLBACK_HTTP_MISMATCH')
    await server.stop('RECOVERY_LOCAL_ROLLBACK_COMPLETE')
    assert.equal(server.getAddress(), null, 'RECOVERY_LOCAL_ROLLBACK_LISTENER_RETAINED')
    const listening = await new Promise<boolean>(resolve => {
      const socket = connect({ host: '127.0.0.1', port: address.port })
      const done = (value: boolean) => { socket.destroy(); resolve(value) }
      socket.setTimeout(500, () => done(false))
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
    })
    assert.equal(listening, false, 'RECOVERY_LOCAL_ROLLBACK_LISTENER_RESIDUE')
    assert.deepEqual(await snapshot(pool, input.identity.sheetId), before,
      'RECOVERY_LOCAL_ROLLBACK_UNEXPECTED_WRITE')
    return { responses, tableCount: before.length }
  } finally {
    try { await server?.stop('RECOVERY_LOCAL_ROLLBACK_CLEANUP') }
    finally { await pool.end() }
  }
}

process.once('disconnect', () => process.exit(1))
process.once('message', (input: ManualRollbackInput) => {
  void run(input).then(
    result => { process.send?.({ kind: 'flag-off-done', result }, undefined, undefined, () => process.exit(0)) },
    error => {
      const code = error instanceof Error ? error.message.match(/^RECOVERY_[A-Z0-9_]+(?=$|\s)/)?.[0] : undefined
      const frames = error instanceof Error
        ? [...(error.stack ?? '').matchAll(/verify-recovery-local-rollback\.mts:(\d+)/g)]
          .map(match => `verify-recovery-local-rollback.mts:${match[1]}`) : []
      process.send?.({ kind: 'flag-off-error', code: code ?? 'RECOVERY_LOCAL_ROLLBACK_FAILED', frames },
        undefined, undefined, () => process.exit(1))
    },
  )
})
