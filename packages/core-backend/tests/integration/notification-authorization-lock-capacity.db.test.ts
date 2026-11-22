import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveEffectiveNotificationCapabilityForBackground } from '../../src/integrations/integration-capability-resolve-background'
import { AUTHORIZATION_OPERATION_FENCE_LOCK_SQL, AUTHORIZATION_OPERATION_FENCE_TABLES } from '../../src/admin/authorization-operation-fence'
import { withAuthorizationInputTransaction, type AuthorizationInputTransactionRunner } from '../../src/rbac/authorization-input-lock'
import { assignUserRoles } from '../../src/rbac/role-assignment'
import { deriveUserAccessLockKey } from '../../src/auth/user-access-lock'
import { observeNotificationQueries } from '../utils/notification-lock-evidence'

// No vi.mock, SQL replacement, schema clone or alternative resolver: every business call is real.
const url = process.env.DATABASE_URL
const suite = url ? describe : describe.skip
if (process.env.EXPECT_DB === '1') it('N78-L00: required database lane is armed', () => expect(url).toBeTruthy())
const output = resolve(process.env.N78_LOCK_EVIDENCE_JSON ?? '../../artifacts/n78-08a-lock-capacity.json')
const evidence: Record<string, unknown> = { format: 1, status: 'not_run', scope: 'synthetic-current-build', entrypoints: [
  'src/integrations/integration-capability-resolve-background.ts:resolveEffectiveNotificationCapabilityForBackground',
  'src/rbac/authorization-input-lock.ts:withAuthorizationInputTransaction',
  'src/rbac/role-assignment.ts:assignUserRoles',
], cases: [] }
const cases = evidence.cases as Array<Record<string, unknown>>
const save = () => { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n') }
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
function gate() { let open!: () => void; const promise = new Promise<void>(done => { open = done }); return { promise, open } }

suite('notification background and authorization lock evidence', () => {
  let pool: Pool
  let children: Set<string>
  const prefix = `n78_lock_${randomUUID()}`
  const actor = `${prefix}_actor`, role = `${prefix}_role`
  const orgs = [0, 1].map(n => `${prefix}_org_${n}`)
  const users = Array.from({ length: 16 }, (_, n) => `${prefix}_user_${n}`)
  const connections = Array.from({ length: 4 }, (_, n) => ({ id: randomUUID(), org: orgs[n % orgs.length] }))
  const observations: ReturnType<typeof observeNotificationQueries>[] = []
  let record: Record<string, unknown>
  const authorizationStatements: Array<{ fence: boolean; digest: string; code: string }> = []
  evidence.authorizationStatements = authorizationStatements

  const observer = (client: PoolClient, location: string) => {
    const observed = observeNotificationQueries((sql, params) => client.query(sql, params), children, location)
    observations.push(observed)
    return observed
  }
  const pid = async (client: PoolClient) => Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  async function locks(pids: number[]) {
    return (await pool.query(`SELECT l.pid, l.locktype, c.relname AS relation, l.mode, l.granted,
      l.classid::text, l.objid::text, l.objsubid, l.transactionid::text,
      pg_blocking_pids(l.pid) AS blockers
      FROM pg_locks l LEFT JOIN pg_class c ON c.oid=l.relation
      WHERE l.pid=ANY($1::int[]) ORDER BY l.pid,l.locktype,c.relname,l.mode`, [pids])).rows
  }
  async function waiting(waiter: number, holder: number) {
    const end = performance.now() + 1500
    while (performance.now() < end) {
      const snapshot = await locks([waiter, holder])
      if (snapshot.some(row => row.pid === waiter && !row.granted && row.blockers.includes(holder))) return snapshot
      await sleep(10)
    }
    throw new Error('N78_WAITER_WITNESS_MISSING')
  }
  async function begin(client: PoolClient) {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await client.query("SET LOCAL lock_timeout='2s'")
    await client.query("SET LOCAL statement_timeout='4s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'")
  }
  const input = { integrationId: connections[0].id, eventOrgId: connections[0].org }
  const operation = () => ({ intent: 'AUTHORIZATION_OPERATION' as const,
    operation: { actorId: actor, clientOperationId: randomUUID() }, userIds: [actor], admissionUserIds: [actor], roleIds: [role] })
  const runner = (onPid?: (value: number) => void): AuthorizationInputTransactionRunner => async handler => {
    const client = await pool.connect()
    try {
      onPid?.(await pid(client))
      await begin(client)
      const result = await handler({ query: async (sql, params) => {
        const entry = { fence: sql === AUTHORIZATION_OPERATION_FENCE_LOCK_SQL, digest: createHash('sha256').update(sql).digest('hex'), code: 'pending' }
        authorizationStatements.push(entry)
        try { const result = await client.query(sql, params); entry.code = 'OK'; return result }
        catch (error) { entry.code = String((error as { code?: string }).code ?? 'QUERY_FAILED'); throw error }
      }, __rawClient: client })
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  async function recover() {
    const started = performance.now()
    const client = await pool.connect()
    try {
      await begin(client)
      expect(await resolveEffectiveNotificationCapabilityForBackground(observer(client, 'recovery'), input))
        .toMatchObject({ effective: true, orgSource: 'background_event_row' })
      await client.query('ROLLBACK')
    } finally { client.release() }
    expect(await withAuthorizationInputTransaction(operation(), async () => 'OK', { transaction: runner() })).toBe('OK')
    const elapsedMs = performance.now() - started
    expect(elapsedMs).toBeLessThan(6000)
    record.recovery = { background: 'effective', authorization: 'OK', elapsedMs }
  }

  beforeAll(async () => {
    expect(process.env.EXPECT_DB).toBe('1')
    vi.stubEnv('DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED', 'true')
    pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 3000, statement_timeout: 10000 })
    evidence.status = 'running'
    save()
    evidence.settings = (await pool.query(`SELECT current_setting('server_version_num') AS version,
      current_setting('max_locks_per_transaction') AS max_locks_per_transaction,
      current_setting('max_connections') AS max_connections,
      current_setting('max_prepared_transactions') AS max_prepared_transactions`)).rows[0]
    children = new Set((await pool.query(`SELECT DISTINCT c.relname FROM pg_constraint f
      JOIN pg_class c ON c.oid=f.conrelid WHERE f.contype='f' AND f.confrelid='public.users'::regclass`)).rows.map(row => row.relname))
    evidence.usersForeignKeyChildren = [...children].sort()
    await pool.query('INSERT INTO roles(id,name) VALUES ($1,$1)', [role])
    for (const user of [actor, ...users]) {
      await pool.query(`INSERT INTO users(id,email,name,password_hash,role,is_admin,is_active,activation_status)
        VALUES ($1,$2,'Synthetic','synthetic','user',false,true,'activated')`, [user, `${user}@example.test`])
    }
    for (const [n, connection] of connections.entries()) {
      await pool.query(`INSERT INTO directory_integrations(id,org_id,provider,name,status,corp_id,config)
        VALUES ($1,$2,'dingtalk','Synthetic','active',$3,$4::jsonb)`, [connection.id, connection.org, prefix, JSON.stringify({ appKey: prefix })])
      await pool.query(`INSERT INTO directory_integration_capabilities(integration_id,bound_provider,bound_org_id,
        notification_enabled,notification_bound_tenant,notification_bound_app_scope,revision,created_by,updated_by)
        VALUES ($1,'dingtalk',$2,true,$3,$3,1,'synthetic','synthetic')`, [connection.id, connection.org, prefix])
      for (const user of users.slice(n * 4, n * 4 + 4)) {
        await pool.query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES ($1,$2,true)', [user, connection.org])
        const account = randomUUID()
        await pool.query(`INSERT INTO directory_accounts(id,integration_id,provider,corp_id,external_user_id,external_key,name,is_active)
          VALUES ($1,$2,'dingtalk',$3,$4,$4,'Synthetic',true)`, [account, connection.id, prefix, user])
        await pool.query(`INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status) VALUES ($1,$2,'linked')`, [account, user])
      }
    }
  }, 30000)

  beforeEach(() => {
    if (evidence.status === 'failed') throw new Error('N78_STOP_AFTER_FAILURE')
  })
  afterEach(context => {
    if (record) record.status = context.task.result?.state === 'fail' ? 'failed' : 'passed'
    evidence.observations = observations.map(item => ({ statements: item.statements, violations: item.violations }))
    evidence.status = cases.some(item => item.status === 'failed') ? 'failed' : 'running'
    save()
  })
  afterAll(async () => {
    // Only this suite's synthetic rows. Failure evidence survives cleanup.
    try {
      if (pool) {
        await pool.query('DELETE FROM user_roles WHERE user_id=ANY($1::text[])', [[actor, ...users]])
        await pool.query('DELETE FROM directory_account_links WHERE local_user_id=ANY($1::text[])', [users])
        await pool.query('DELETE FROM directory_accounts WHERE integration_id=ANY($1::uuid[])', [connections.map(c => c.id)])
        await pool.query('DELETE FROM directory_integration_capabilities WHERE integration_id=ANY($1::uuid[])', [connections.map(c => c.id)])
        await pool.query('DELETE FROM directory_integrations WHERE id=ANY($1::uuid[])', [connections.map(c => c.id)])
        await pool.query('DELETE FROM user_orgs WHERE user_id=ANY($1::text[])', [users])
        await pool.query('DELETE FROM users WHERE id=ANY($1::text[])', [[actor, ...users]])
        await pool.query('DELETE FROM roles WHERE id=$1', [role])
      }
      evidence.status = cases.length === 3 && cases.every(item => item.status === 'passed') ? 'passed' : 'failed'
    } catch (error) { evidence.status = 'failed'; evidence.cleanupCode = 'CLEANUP_FAILED'; throw error }
    finally { save(); vi.unstubAllEnvs(); await pool?.end() }
  })

  it('N78-L01: real background FOR SHARE makes authorization NOWAIT busy, witnessed and recoverable', async () => {
    record = { name: 'background-first', status: 'running' }; cases.push(record)
    const reader = await pool.connect(), waiter = await pool.connect()
    let update: Promise<unknown> | undefined
    let operationPid = 0
    try {
      await begin(reader); await begin(waiter)
      const readerPid = await pid(reader), waiterPid = await pid(waiter)
      expect(vi.isMockFunction(resolveEffectiveNotificationCapabilityForBackground)).toBe(false)
      expect(vi.isMockFunction(withAuthorizationInputTransaction)).toBe(false)
      const decision = await resolveEffectiveNotificationCapabilityForBackground(observer(reader, 'background-first'), input)
      expect(decision).toMatchObject({ effective: true, orgSource: 'background_event_row' })
      const held = await locks([readerPid])
      record.heldBeforeNowait = held
      expect(held).toEqual(expect.arrayContaining([
        expect.objectContaining({ relation: 'directory_integrations', mode: 'RowShareLock', granted: true }),
        expect.objectContaining({ relation: 'directory_integration_capabilities', mode: 'RowShareLock', granted: true }),
      ]))
      const start = performance.now()
      await expect(withAuthorizationInputTransaction(operation(), async () => { throw new Error('N78_UNEXPECTED_WORK') },
        { transaction: runner(value => { operationPid = value }) })).rejects.toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', status: 409 })
      record.elapsedMs = performance.now() - start
      expect(record.elapsedMs).toBeLessThan(1500)
      expect(authorizationStatements.some(row => row.fence && row.code === '55P03')).toBe(true)
      record.result = { code: 'AUTHORIZATION_INPUT_BUSY', status: 409, sqlstate: '55P03' }
      record.afterNowait = await locks([operationPid])
      expect((record.afterNowait as Array<{ granted: boolean }>).some(row => !row.granted)).toBe(false)
      // A row updater is only the witness for FOR SHARE, not a substitute for either entry point.
      update = waiter.query('UPDATE directory_integrations SET name=name WHERE id=$1', [input.integrationId])
        .then(() => 'OK', error => String(error.code))
      record.waiter = await waiting(waiterPid, readerPid)
      await reader.query('ROLLBACK')
      expect(await update).toBe('OK')
      await waiter.query('ROLLBACK')
    } finally {
      await reader.query('ROLLBACK'); await update; await waiter.query('ROLLBACK')
      reader.release(); waiter.release()
    }
    await recover()
  })

  it('N78-L02: real authorization fence blocks background, bounded read_failed then recovery', async () => {
    record = { name: 'authorization-first', status: 'running' }; cases.push(record)
    const entered = gate(), release = gate()
    let holderPid = 0
    const holder = withAuthorizationInputTransaction(operation(), async () => { entered.open(); await release.promise; return 'OK' },
      { transaction: runner(value => { holderPid = value }) })
    // Surface setup failure immediately, without leaving the waiter hung on a barrier.
    const reader = await pool.connect()
    try {
      await Promise.race([entered.promise, holder.then(() => { throw new Error('N78_HOLDER_ENDED_EARLY') })])
      await begin(reader)
      const readerPid = await pid(reader)
      const observed = observer(reader, 'authorization-first')
      const start = performance.now()
      const pending = resolveEffectiveNotificationCapabilityForBackground(observed, input)
      record.waiter = await waiting(readerPid, holderPid)
      const held = (record.waiter as Array<{ pid: number; mode: string; relation: string; locktype: string }>).filter(row => row.pid === holderPid && row.locktype === 'relation' && row.mode === 'ExclusiveLock')
      expect(held.map(row => row.relation).sort()).toEqual([...AUTHORIZATION_OPERATION_FENCE_TABLES])
      expect(authorizationStatements.some(row => row.fence && row.code === 'OK')).toBe(true)
      expect(await pending).toEqual({ effective: false, reason: 'read_failed' })
      record.elapsedMs = performance.now() - start
      expect(record.elapsedMs).toBeLessThan(4000)
      expect(observed.statements.some(row => row.code === '55P03')).toBe(true)
      record.result = { code: 'read_failed', sqlstate: '55P03' }
      await reader.query('ROLLBACK')
    } finally { release.open(); await holder; await reader.query('ROLLBACK'); reader.release() }
    await recover()
  })

  it('N78-L03: organization and connection scans overlap real role batch and record capacity', async () => {
    record = { name: 'capacity', status: 'running', organizations: [], connections: [] }; cases.push(record)
    const entered = gate(), release = gate()
    let batchPid = 0
    const started = performance.now()
    const batch = withAuthorizationInputTransaction({ intent: 'GRANT_ROLE', userIds: users, admissionUserIds: users, roleIds: [role] }, async tx => {
      const result = await assignUserRoles({ userIds: users, roleId: role, assignmentSource: 'manual', scope: { kind: 'fixed', roleIds: [role] }, executor: tx })
      entered.open(); await release.promise; return result
    }, { transaction: runner(value => { batchPid = value }) })
    const scan = await pool.connect()
    try {
      await Promise.race([entered.promise, batch.then(() => { throw new Error('N78_BATCH_ENDED_EARLY') })])
      await begin(scan)
      const trace = observer(scan, 'capacity-scan')
      const orgUsers: string[] = [], connectionUsers: string[] = []
      const scanPid = await pid(scan)
      for (const org of orgs) {
        const start = performance.now()
        const rows = (await trace.query('SELECT user_id FROM user_orgs WHERE org_id=$1 AND user_id=ANY($2::text[]) AND is_active ORDER BY user_id', [org, users])).rows
        const ids = rows.map(row => String(row.user_id))
        orgUsers.push(...ids)
        const keys = new Set(ids.map(deriveUserAccessLockKey))
        expect(ids.length).toBeGreaterThan(0); expect(keys.size).toBeLessThanOrEqual(ids.length)
        ;(record.organizations as unknown[]).push({ users: ids.length, prospectiveUserKeys: keys.size, elapsedMs: performance.now() - start })
      }
      for (const connection of connections) {
        const start = performance.now()
        const rows = (await trace.query(`SELECT DISTINCT l.local_user_id FROM directory_account_links l
          JOIN directory_accounts a ON a.id=l.directory_account_id WHERE a.integration_id=$1
          AND l.local_user_id=ANY($2::text[]) AND l.link_status='linked' ORDER BY l.local_user_id`, [connection.id, users])).rows
        const ids = rows.map(row => String(row.local_user_id))
        connectionUsers.push(...ids)
        const decision = await resolveEffectiveNotificationCapabilityForBackground(trace, { integrationId: connection.id, eventOrgId: connection.org })
        expect(decision).toMatchObject({ effective: true, orgSource: 'background_event_row' })
        expect(ids.length).toBeGreaterThan(0)
        ;(record.connections as unknown[]).push({ users: ids.length, prospectiveUserKeys: new Set(ids.map(deriveUserAccessLockKey)).size, elapsedMs: performance.now() - start })
      }
      expect(orgUsers.sort()).toEqual([...users].sort())
      expect(connectionUsers.sort()).toEqual([...users].sort())
      const snapshot = await locks([scanPid, batchPid])
      record.locks = snapshot
      expect(snapshot.some(row => row.pid === batchPid && row.relation === 'user_roles' && row.mode === 'RowExclusiveLock' && row.granted)).toBe(true)
      expect(snapshot.some(row => row.pid === scanPid && row.relation === 'directory_integrations' && row.mode === 'RowShareLock' && row.granted)).toBe(true)
      record.lockHolders = snapshot.length
      record.advisoryHolders = snapshot.filter(row => row.locktype === 'advisory').length
      record.advisoryObjects = new Set(snapshot.filter(row => row.locktype === 'advisory').map(row => `${row.classid}/${row.objid}/${row.objsubid}`)).size
      expect(record.advisoryObjects).toBeLessThanOrEqual(record.advisoryHolders as number)
      expect(trace.violations).toEqual([])
      await scan.query('ROLLBACK')
    } finally { release.open(); await scan.query('ROLLBACK'); scan.release(); await batch }
    const result = await batch
    expect([...result.affectedUserIds].sort()).toEqual([...users].sort())
    expect((await pool.query('SELECT user_id FROM user_roles WHERE role_id=$1 ORDER BY user_id', [role])).rows.map(row => row.user_id)).toEqual([...users].sort())
    record.batch = { code: 'OK', rows: result.rowCount, elapsedMs: performance.now() - started }
    expect(observations.every(item => item.violations.length === 0)).toBe(true)
    await recover()
  })
})
