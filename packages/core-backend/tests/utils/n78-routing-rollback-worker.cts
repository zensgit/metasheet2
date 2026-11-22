// Executed only by the direct-Node rehearsal driver, using each checkout's own loader/dependencies.
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

async function main() {
  const [root, action] = process.argv.slice(2)
  if (process.env.EXPECT_DB !== '1' || !/^\/n78_08a_rollback_synthetic_pg(14|15|16|17)$/.test(new URL(process.env.DATABASE_URL ?? '').pathname)) throw new Error('SYNTHETIC_DATABASE_REQUIRED')
  const requireCheckout = createRequire(resolve(root, 'packages/core-backend/package.json'))
  const { Pool } = requireCheckout('pg') as typeof import('pg')
  const { Kysely, PostgresDialect, Migrator } = requireCheckout('kysely') as typeof import('kysely')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 300000 })
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
  const C = 'zzzz20261122151000_create_notification_topic_policies'
  const D = 'zzzz20261122151100_create_task_notification_decisions'
  const policy = 'org_notification_topic_policies', decisions = 'task_notification_delivery_decisions'
  const known = new Set(['AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE', 'NOTIFICATION_ROUTING_DOWN_BLOCKED'])
  const requireTrue = (condition: unknown, code: string) => { if (!condition) throw Object.assign(new Error(code), { code }) }
  const scalar = async (sql: string) => (await pool.query(sql)).rows[0]
  const ledger = async () => (await pool.query('SELECT name FROM kysely_migration ORDER BY name')).rows.map(row => String(row.name))
  const present = async () => scalar(`SELECT to_regclass('public.${policy}') IS NOT NULL AS policy, to_regclass('public.${decisions}') IS NOT NULL AS decisions`)
  const snapshot = async () => {
    // Full table contents are hashed in the isolated synthetic database, never exported.
    const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows
    const rows = []
    for (const { tablename } of tables) {
      const quoted = '"' + String(tablename).replace(/"/g, '""') + '"'
      rows.push([tablename, (await pool.query(`SELECT row_to_json(t)::text AS row FROM public.${quoted} t ORDER BY row_to_json(t)::text`)).rows])
    }
    const catalog = (await pool.query(`SELECT c.relname, a.attname, a.atttypid::text, a.attnotnull
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`)).rows
    const constraints = (await pool.query(`SELECT c.relname, f.conname, pg_get_constraintdef(f.oid) AS definition
      FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' ORDER BY c.relname,f.conname`)).rows
    return createHash('sha256').update(JSON.stringify({ rows, catalog, constraints })).digest('hex')
  }
  let result: Record<string, unknown> = { code: 'OK' }
  try {
    if (action === 'empty') {
      const row = await scalar("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")
      requireTrue(row.n === 0, 'DATABASE_NOT_EMPTY')
      const settings = await scalar("SELECT current_setting('server_version_num') AS version, current_setting('server_encoding') AS encoding, current_setting('lc_collate') AS collate")
      const major = Number(new URL(process.env.DATABASE_URL!).pathname.match(/pg(\d+)$/)![1])
      requireTrue(Math.floor(Number(settings.version) / 10000) === major && settings.encoding === 'UTF8' && settings.collate === 'C', 'DATABASE_PROFILE_MISMATCH')
      result.settings = settings
    } else if (action === 'readiness') {
      const fence = requireCheckout(resolve(root, 'packages/core-backend/src/admin/authorization-operation-fence.ts')) as typeof import('../../src/admin/authorization-operation-fence')
      const { AUTHORIZATION_INPUT_STATEMENTS } = requireCheckout(resolve(root, 'packages/core-backend/src/rbac/authorization-input-lock.ts')) as typeof import('../../src/rbac/authorization-input-lock')
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await client.query("SET LOCAL lock_timeout='5s'")
        await client.query("SET LOCAL statement_timeout='10s'")
        requireTrue(await fence.assertAuthorizationOperationReadReady((sql, params) => client.query(sql, params), AUTHORIZATION_INPUT_STATEMENTS.worldSharedTry), 'READINESS_BUSY')
      } catch (error) {
        if ((error as { code?: string }).code !== 'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE') throw error
        result = { code: 'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE', status: (error as { status?: number }).status }
        requireTrue(result.status === 503, 'WRONG_REFUSAL_STATUS')
      } finally { await client.query('ROLLBACK'); client.release() }
    } else if (action === 'snapshot') {
      result.snapshot = await snapshot()
    } else if (action === 'seed-policy') {
      requireTrue((await scalar(`SELECT count(*)::int AS n FROM ${policy}`)).n === 0, 'POLICY_NOT_EMPTY')
      await pool.query(`INSERT INTO ${policy}(org_id,topic,state,created_by,updated_by)
        VALUES ('n78_rehearsal_synthetic','synthetic','paused','synthetic','synthetic')`)
      result.rows = 1
    } else if (action === 'final') {
      requireTrue((await ledger()).slice(-2).join(',') === [C, D].join(','), 'MIGRATION_TIP_MISMATCH')
      requireTrue((await scalar(`SELECT count(*)::int AS n FROM ${policy} WHERE org_id='n78_rehearsal_synthetic' AND topic='synthetic' AND state='paused'`)).n === 1, 'SYNTHETIC_POLICY_LOST')
      requireTrue((await scalar(`SELECT count(*)::int AS n FROM ${decisions}`)).n === 0, 'DECISIONS_NOT_EMPTY')
      result.snapshot = await snapshot()
    } else {
      const { createCoreBackendMigrationProvider } = requireCheckout(resolve(root, 'packages/core-backend/src/db/migration-provider.ts')) as typeof import('../../src/db/migration-provider')
      const migrator = new Migrator({ db, allowUnorderedMigrations: true, provider: createCoreBackendMigrationProvider({ runtimeDir: resolve(root, 'packages/core-backend/src/db') }) })
      const all = await migrator.getMigrations()
      requireTrue(all.slice(-2).map(item => item.name).join(',') === [C, D].join(','), 'PROVIDER_TIP_MISMATCH')
      if (action === 'latest') {
        const migrated = await migrator.migrateToLatest()
        if (migrated.error) throw migrated.error
        requireTrue((await ledger()).slice(-2).join(',') === [C, D].join(','), 'MIGRATION_TIP_MISMATCH')
        requireTrue(Object.values(await present()).every(Boolean), 'ROUTING_TABLE_MISSING')
        result.migrations = migrated.results
      } else {
        requireTrue(['down-decisions', 'down-policy', 'down-policy-blocked'].includes(action), 'UNKNOWN_ACTION')
        const target = action === 'down-decisions' ? D : C
        requireTrue((await ledger()).at(-1) === target, 'ROLLBACK_TIP_MISMATCH')
        const down = await migrator.migrateDown()
        if (action === 'down-policy-blocked') {
          requireTrue(down.error instanceof Error && down.error.message === 'NOTIFICATION_ROUTING_DOWN_BLOCKED', 'EXPECTED_DOWN_REFUSAL_MISSING')
          requireTrue((await ledger()).at(-1) === C && (await present()).policy, 'REFUSED_DOWN_CHANGED_LEDGER')
          result.code = 'NOTIFICATION_ROUTING_DOWN_BLOCKED'
        } else {
          if (down.error) throw down.error
          requireTrue(down.results?.length === 1 && down.results[0].migrationName === target && down.results[0].status === 'Success', 'WRONG_MIGRATION_REMOVED')
          const state = await present()
          requireTrue(!state.decisions && (action === 'down-decisions' ? state.policy : !state.policy), 'WRONG_TABLE_STATE')
          result.migrations = down.results
        }
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code
    const allowed = /^(DATABASE_NOT_EMPTY|DATABASE_PROFILE_MISMATCH|READINESS_BUSY|WRONG_REFUSAL_STATUS|POLICY_NOT_EMPTY|MIGRATION_TIP_MISMATCH|SYNTHETIC_POLICY_LOST|DECISIONS_NOT_EMPTY|PROVIDER_TIP_MISMATCH|ROUTING_TABLE_MISSING|UNKNOWN_ACTION|ROLLBACK_TIP_MISMATCH|EXPECTED_DOWN_REFUSAL_MISSING|REFUSED_DOWN_CHANGED_LEDGER|WRONG_MIGRATION_REMOVED|WRONG_TABLE_STATE)$/
    result = { code: code && (known.has(code) || allowed.test(code)) ? code : 'WORKER_FAILED', sqlstate: code && /^[0-9A-Z]{5}$/.test(code) ? code : null }
    process.exitCode = 1
  } finally { await db.destroy() }
  process.stdout.write('N78_RESULT=' + JSON.stringify(result) + '\n', () => process.exit(process.exitCode ?? 0))
}
main().catch(() => { process.stdout.write('N78_RESULT={"code":"WORKER_START_FAILED"}\n'); process.exitCode = 1 })
