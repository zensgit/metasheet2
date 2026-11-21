import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyReviewedBackfill, checkPlan, type ReviewedBackfill } from '../../scripts/dingtalk-corp-backfill'

const db = process.env.DATABASE_URL
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip
itIfExpectDb('sentinel: real DB expected', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

;(db ? describe : describe.skip)('reviewed DingTalk identity repair', () => {
  let pool: Pool
  let client: PoolClient
  let control: PoolClient
  let writer: PoolClient
  let plan: ReviewedBackfill
  let ids: string[]
  let userId: string
  let connectionId: string
  let accountId: string

  beforeAll(() => { pool = new Pool({ connectionString: db, max: 6 }) })
  beforeEach(async () => {
    client = await pool.connect()
    control = await pool.connect()
    writer = await pool.connect()
    userId = 'backfill-' + randomUUID()
    connectionId = randomUUID()
    accountId = randomUUID()
    ids = [randomUUID()]
    const corp = 'backfill-' + randomUUID()
    const openId = 'open-' + randomUUID()
    await pool.query("INSERT INTO users(id,password_hash) VALUES($1,'fixture')", [userId])
    await pool.query(`INSERT INTO directory_integrations(id,org_id,provider,name,status,corp_id)
      VALUES ($1,'backfill-test','dingtalk','backfill-test','active',$2)`, [connectionId, corp])
    await pool.query(`INSERT INTO directory_accounts(id,integration_id,provider,corp_id,external_user_id,external_key,open_id,name,is_active)
      VALUES ($1,$2,'dingtalk',$3,$4,$4,$4,'backfill-test',true)`, [accountId, connectionId, corp, openId])
    await pool.query(`INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status)
      VALUES ($1,$2,'linked')`, [accountId, userId])
    const identity = await pool.query(`INSERT INTO user_external_identities(id,provider,external_key,local_user_id,provider_open_id)
      VALUES ($1,'dingtalk',$2,$3,$2) RETURNING xmin::text AS version`, [ids[0], openId, userId])
    const target = (await pool.query(`SELECT system_identifier::text AS system, current_database() AS db,
      current_schema() AS schema, session_user AS operator FROM pg_control_system()`)).rows[0]
    plan = { systemIdentifier: target.system, database: target.db, schema: target.schema, operator: target.operator, corpId: corp,
      rows: [{ identityId: ids[0], userId, rowVersion: identity.rows[0].version, oldKey: openId, connectionId, accountId }] }
  })
  afterEach(async () => {
    for (const c of [client, control, writer]) { await c.query('ROLLBACK'); c.release() }
    await pool.query('DELETE FROM user_external_identities WHERE id=ANY($1::uuid[])', [ids])
    await pool.query('DELETE FROM directory_account_links WHERE directory_account_id=$1', [accountId])
    await pool.query('DELETE FROM directory_accounts WHERE id=$1', [accountId])
    await pool.query('DELETE FROM directory_integrations WHERE id=$1', [connectionId])
    await pool.query('DELETE FROM users WHERE id=$1', [userId])
  })
  afterAll(async () => { await pool.end() })

  function apply() { return applyReviewedBackfill(client, plan, ids, plan.corpId) }
  async function identityState() {
    return (await pool.query('SELECT corp_id, external_key FROM user_external_identities WHERE id=$1', [ids[0]])).rows[0]
  }
  async function audits() {
    return (await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE event_type='DINGTALK_CORP_BACKFILL'")).rows[0].n
  }
  async function pid(c: PoolClient): Promise<number> { return (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid }
  async function waitForBlock(holder: number, blocked: number): Promise<void> {
    const until = Date.now() + 3000
    while (Date.now() < until) {
      const probe = await pool.query('SELECT $1::integer=ANY(pg_blocking_pids($2)) AS blocked', [holder, blocked])
      if (probe.rows[0].blocked === true) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('fixture did not reach the expected lock wait')
  }

  it('requires the entire reviewed allowlist, current identity version, original key, relational evidence and operating environment', async () => {
    expect(() => checkPlan(plan, [randomUUID()], plan.corpId)).toThrow()
    const n = await audits()
    const row = plan.rows[0]
    for (const changed of [
      { ...plan, database: 'different-db' }, { ...plan, operator: 'different-operator' },
      { ...plan, rows: [{ ...row, rowVersion: '0' }] }, { ...plan, rows: [{ ...row, oldKey: 'different' }] },
      { ...plan, rows: [{ ...row, accountId: randomUUID() }] },
    ]) {
      await expect(applyReviewedBackfill(client, changed, ids, plan.corpId)).rejects.toThrow()
      expect(await identityState()).toEqual({ corp_id: null, external_key: row.oldKey })
    }
    expect(await audits()).toBe(n)
  })

  it('rolls back identity and audit together when the audit table cannot be written', async () => {
    const n = await audits()
    await control.query('BEGIN')
    await control.query('LOCK TABLE audit_logs IN SHARE MODE')
    try { await expect(apply()).rejects.toMatchObject({ code: '55P03' }) }
    finally { await control.query('ROLLBACK') }
    expect(await identityState()).toEqual({ corp_id: null, external_key: plan.rows[0].oldKey })
    expect(await audits()).toBe(n)
  })

  it('commits the exact reviewed identity and audit before a contending first scope insert can proceed', async () => {
    const n = await audits()
    const controlPid = await pid(control)
    const repairPid = await pid(client)
    const scopePid = await pid(writer)
    await control.query('BEGIN')
    await control.query('LOCK TABLE audit_logs IN SHARE MODE')
    await writer.query('BEGIN')
    await writer.query("SET LOCAL lock_timeout='5s'")
    const repair = apply()
    repair.catch(() => {})
    try {
      await waitForBlock(controlPid, repairPid)
      const scope = writer.query('INSERT INTO directory_connection_login_scope(connection_id,command_id) VALUES ($1,$2)', [connectionId, randomUUID()])
      scope.catch(() => {})
      try {
        await waitForBlock(repairPid, scopePid)
        await control.query('COMMIT')
        await expect(repair).resolves.toBe(1)
        await expect(scope).resolves.toMatchObject({ rowCount: 1 })
      } finally { await control.query('ROLLBACK'); await scope.catch(() => {}) }
    } finally { await control.query('ROLLBACK'); await writer.query('ROLLBACK'); await repair.catch(() => {}) }
    expect(await identityState()).toEqual({ corp_id: plan.corpId, external_key: plan.corpId + ':' + plan.rows[0].oldKey })
    expect(await audits()).toBe(n + 1)
    await expect(apply()).rejects.toThrow()
    expect(await audits()).toBe(n + 1)
  })

  it('refuses the whole repair when a first scope insertion has already taken its table lock', async () => {
    await control.query('BEGIN')
    await control.query('INSERT INTO directory_connection_login_scope(connection_id,command_id) VALUES ($1,$2)', [connectionId, randomUUID()])
    const n = await audits()
    try { await expect(apply()).rejects.toMatchObject({ code: '55P03' }) }
    finally { await control.query('ROLLBACK') }
    expect(await identityState()).toEqual({ corp_id: null, external_key: plan.rows[0].oldKey })
    expect(await audits()).toBe(n)
  })
})
