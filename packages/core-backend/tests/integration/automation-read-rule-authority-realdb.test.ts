/**
 * Actual helper SQL and the actual 122000 nonce migration on an owned random
 * schema. The fixture supplies current consumed base/sheet/rule columns only.
 * Actor admission, full host port, HTTP/JWT and source IO are outside this proof.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { down, up } from '../../src/db/migrations/zzzz20261001122000_automation_rule_authority_revision'
import { canonicalizeConfig } from '../../src/multitable/automation-action-idempotency'
import { AutomationRuleAuthorityError, lockAutomationReadRule } from '../../src/integration/automation-read-rule-authority'

const describeDatabase = process.env.DATABASE_URL ? describe : describe.skip
const expectDatabase = process.env.EXPECT_DB === '1' ? it : it.skip
expectDatabase('EXPECTED_DB must actually provide a database', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const scope = { actorId: 'synthetic-actor', ruleId: 'synthetic-rule', sheetId: 'synthetic-sheet', baseId: 'synthetic-base' }
const timestamp = '2026-10-01T00:00:00.123456Z'
const initial = {
  id: scope.ruleId, sheet_id: scope.sheetId, name: 'Synthetic rule', trigger_type: 'record.created',
  trigger_config: { field: 'synthetic-field' }, action_type: 'notify', action_config: { message: 'synthetic-private-config' },
  enabled: true, created_at: timestamp, updated_at: timestamp, created_by: scope.actorId,
  conditions: { all: [] }, actions: [{ type: 'notify', config: { message: 'synthetic-private-config' } }], execution_mode: null,
}

describeDatabase('Automation read rule prerequisite: real PostgreSQL transactions and locks', () => {
  const schema = `automation_read_rule_${randomBytes(8).toString('hex')}`
  let pool: Pool
  let admin: PoolClient
  let reader: PoolClient
  let writer: PoolClient
  let observer: PoolClient
  let db: Kysely<unknown>

  async function migrate(direction: 'up' | 'down'): Promise<void> {
    await db.transaction().execute(transaction => (direction === 'up' ? up : down)(transaction))
  }

  async function insertRule(suppliedRevision: string | null = null): Promise<void> {
    await admin.query(`INSERT INTO automation_rules
      (id, sheet_id, name, trigger_type, trigger_config, action_type, action_config, enabled,
       created_at, updated_at, created_by, conditions, actions, execution_mode, integration_authority_revision)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,true,$8,$8,$9,$10::jsonb,$11::jsonb,NULL,$12)`,
    [initial.id, initial.sheet_id, initial.name, initial.trigger_type, JSON.stringify(initial.trigger_config),
      initial.action_type, JSON.stringify(initial.action_config), timestamp, initial.created_by,
      JSON.stringify(initial.conditions), JSON.stringify(initial.actions), suppliedRevision])
  }

  async function capture(input = scope) {
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try { return await lockAutomationReadRule(reader, input) } finally { await reader.query('ROLLBACK') }
  }

  async function waitForBlock(blockedPid: number, blockerPid: number, done: () => boolean): Promise<void> {
    const until = Date.now() + 3000
    while (Date.now() < until) {
      const result = await observer.query(`SELECT $2::int = ANY(pg_blocking_pids(pid)) AS blocked
        FROM pg_stat_activity WHERE pid = $1`, [blockedPid, blockerPid])
      if (result.rows[0]?.blocked === true) return
      expect(done()).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    expect.fail('Expected PostgreSQL to report the held rule prerequisite lock')
  }

  async function pid(client: PoolClient): Promise<number> {
    return Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
  }

  beforeAll(async () => {
    if (!/^automation_read_rule_[a-f0-9]{16}$/.test(schema)) throw new Error('Invalid owned schema')
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    admin = await pool.connect()
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query(`CREATE TABLE meta_bases (id text PRIMARY KEY, deleted_at timestamptz);
      CREATE TABLE meta_sheets (id text PRIMARY KEY, base_id text NOT NULL, deleted_at timestamptz);
      CREATE TABLE users (id text PRIMARY KEY);
      CREATE TABLE automation_rules (
        id text PRIMARY KEY, sheet_id text NOT NULL, name text, trigger_type text NOT NULL,
        trigger_config jsonb DEFAULT '{}', action_type text NOT NULL, action_config jsonb DEFAULT '{}',
        enabled boolean DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), created_by text, conditions jsonb, actions jsonb,
        execution_mode text
      )`)
    const migrationPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1,
      options: `-c search_path=${schema}` })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: migrationPool }) })
    reader = await pool.connect()
    writer = await pool.connect()
    observer = await pool.connect()
    for (const client of [admin, reader, writer, observer]) {
      await client.query(`SET search_path TO "${schema}"`)
      await client.query("SET statement_timeout = '8s'")
    }
    await migrate('up')
  })

  afterAll(async () => {
    for (const client of [reader, writer, observer]) {
      if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
    }
    await db?.destroy()
    if (admin) {
      await admin.query('ROLLBACK').catch(() => {})
      // Only the validated random schema this suite created; no public/customer tables.
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
      admin.release()
    }
    await pool?.end()
  })

  beforeEach(async () => {
    for (const client of [admin, reader, writer, observer]) await client.query('ROLLBACK')
    await admin.query('TRUNCATE automation_rules, meta_sheets, meta_bases, users')
    await admin.query('INSERT INTO meta_bases (id) VALUES ($1)', [scope.baseId])
    await admin.query('INSERT INTO meta_sheets (id, base_id) VALUES ($1,$2)', [scope.sheetId, scope.baseId])
    await admin.query('INSERT INTO users (id) VALUES ($1)', [scope.actorId])
    await insertRule()
  })

  it('uses the migrated nonce and exact microsecond raw-row digest across different session timezones', async () => {
    const first = await capture()
    expect(first.authorityRevision).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    expect(first.fingerprint).toBe(createHash('sha256').update(canonicalizeConfig({
      ...initial, integration_authority_revision: first.authorityRevision,
    })).digest('hex'))
    expect(first.actions).toEqual(initial.actions)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.actions)).toBe(true)
    try {
      await reader.query("SET TIME ZONE 'Asia/Singapore'")
      expect((await capture()).fingerprint).toBe(first.fingerprint)
      await reader.query("SET TIME ZONE 'America/New_York'")
      expect((await capture()).fingerprint).toBe(first.fingerprint)
    } finally { await reader.query("SET TIME ZONE 'UTC'") }
  })

  const rawEdits = [
    ['name', "name = 'Synthetic changed rule'"],
    ['trigger_type', "trigger_type = 'record.updated'"],
    ['trigger_config', `trigger_config = '{"field":"other-synthetic-field"}'::jsonb`],
    ['action_type', "action_type = 'update_field'"],
    ['action_config', `action_config = '{"field":"other-synthetic-field"}'::jsonb`],
    ['conditions', `conditions = '{"any":[]}'::jsonb`],
    ['actions', `actions = '[{"type":"update_field","config":{}}]'::jsonb`],
    ['execution_mode', "execution_mode = 'workflow_job_v1'"],
    ['created_at', "created_at = created_at + INTERVAL '1 microsecond'"],
    ['updated_at', "updated_at = updated_at + INTERVAL '1 microsecond'"],
  ] as const
  it.each(rawEdits)('detects actual persisted %s changes in both nonce and full-row fingerprint', async (_column, edit) => {
    const first = await capture()
    await admin.query(`UPDATE automation_rules SET ${edit}, integration_authority_revision = $1 WHERE id = $2`,
      [first.authorityRevision, scope.ruleId])
    const next = await capture()
    expect(next.authorityRevision).not.toBe(first.authorityRevision)
    expect(next.fingerprint).not.toBe(first.fingerprint)
  })

  it.each(['created_at', 'updated_at'] as const)('preserves %s microseconds in the digest independently of nonce rotation', async column => {
    const first = await capture()
    // Owned fixture only: hold the nonce fixed to isolate the helper SQL's precision.
    await admin.query('ALTER TABLE automation_rules DISABLE TRIGGER automation_rule_authority_revision')
    try {
      await admin.query(`UPDATE automation_rules SET ${column} = ${column} + INTERVAL '1 microsecond'`)
      const next = await capture()
      expect(next.authorityRevision).toBe(first.authorityRevision)
      expect(next.fingerprint).not.toBe(first.fingerprint)
    } finally { await admin.query('ALTER TABLE automation_rules ENABLE TRIGGER automation_rule_authority_revision') }
  })

  it('fingerprints future raw columns and preserves JSON key-order equivalence', async () => {
    await admin.query('ALTER TABLE automation_rules ADD COLUMN future_rule_authority text')
    try {
      const first = await capture()
      await admin.query("UPDATE automation_rules SET future_rule_authority = 'synthetic-future-value'")
      expect((await capture()).fingerprint).not.toBe(first.fingerprint)
      await admin.query(`UPDATE automation_rules SET action_config = '{"a":1,"b":2}'::jsonb`)
      const ordered = await capture()
      await admin.query(`UPDATE automation_rules SET action_config = '{"b":2,"a":1}'::jsonb`)
      expect(await capture()).toEqual(ordered)
    } finally { await admin.query('ALTER TABLE automation_rules DROP COLUMN future_rule_authority') }
  })

  it('cannot recover old authority through disable/enable ABA or same-ID delete/recreate', async () => {
    const first = await capture()
    await admin.query('UPDATE automation_rules SET enabled = false')
    await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_DENIED' })
    await admin.query('UPDATE automation_rules SET enabled = true')
    const restored = await capture()
    expect(restored.authorityRevision).not.toBe(first.authorityRevision)
    expect(restored.fingerprint).not.toBe(first.fingerprint)
    await admin.query('DELETE FROM automation_rules')
    await insertRule(first.authorityRevision)
    const recreated = await capture()
    expect(recreated.authorityRevision).not.toBe(first.authorityRevision)
    expect(recreated.fingerprint).not.toBe(first.fingerprint)
    expect(recreated.actions).toEqual(first.actions)
  })

  const deniedEdits = [
    ['deleted base', 'UPDATE meta_bases SET deleted_at = now()'],
    ['missing base', 'DELETE FROM meta_bases'],
    ['deleted sheet', 'UPDATE meta_sheets SET deleted_at = now()'],
    ['missing sheet', 'DELETE FROM meta_sheets'],
    ['moved sheet', "UPDATE meta_sheets SET base_id = 'other-base'"],
    ['moved rule', "UPDATE automation_rules SET sheet_id = 'other-sheet'"],
    ['different creator', "UPDATE automation_rules SET created_by = 'other-actor'"],
    ['null creator', 'UPDATE automation_rules SET created_by = NULL'],
    ['disabled rule', 'UPDATE automation_rules SET enabled = false'],
    ['null enabled', 'UPDATE automation_rules SET enabled = NULL'],
    ['missing rule', 'DELETE FROM automation_rules'],
  ] as const
  it.each(deniedEdits)('rejects committed %s before returning a snapshot', async (_name, statement) => {
    await admin.query(statement)
    await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_DENIED' })
  })

  it('rejects different supplied actor/base/sheet/rule identities without adopting persisted hints', async () => {
    for (const field of ['actorId', 'baseId', 'sheetId', 'ruleId'] as const) {
      await expect(capture({ ...scope, [field]: `other-${field}` }))
        .rejects.toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_DENIED' })
    }
  })

  it('fails closed when the revision migration is absent, with no raw SQL cause', async () => {
    await migrate('down')
    try {
      await expect(capture()).rejects.toMatchObject({
        code: 'AUTOMATION_RULE_AUTHORITY_UNAVAILABLE', message: 'Automation rule authority is unavailable',
      })
    } finally { await migrate('up') }
  })

  it('rejects a null persisted revision even if schema integrity was bypassed', async () => {
    await admin.query(`ALTER TABLE automation_rules DISABLE TRIGGER automation_rule_authority_revision;
      ALTER TABLE automation_rules ALTER COLUMN integration_authority_revision DROP NOT NULL;
      UPDATE automation_rules SET integration_authority_revision = NULL`)
    try {
      await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_DENIED' })
    } finally {
      await admin.query('UPDATE automation_rules SET integration_authority_revision = $1', [randomUUID()])
      await admin.query(`ALTER TABLE automation_rules ALTER COLUMN integration_authority_revision SET NOT NULL;
        ALTER TABLE automation_rules ENABLE TRIGGER automation_rule_authority_revision`)
    }
  })

  it('rejects a real autocommit client and a forged transaction marker', async () => {
    await expect(lockAutomationReadRule(reader, scope)).rejects.toMatchObject({ code: 'AUTOMATION_RULE_TRANSACTION_REQUIRED' })
    const forged = { query: reader.query.bind(reader), isTransaction: true as const }
    await expect(lockAutomationReadRule(forged, scope)).rejects.toMatchObject({ code: 'AUTOMATION_RULE_TRANSACTION_REQUIRED' })
  })

  it.each(['REPEATABLE READ', 'SERIALIZABLE', 'READ UNCOMMITTED'])('rejects actual %s transactions', async isolation => {
    await reader.query(`BEGIN ISOLATION LEVEL ${isolation}`)
    try {
      await expect(lockAutomationReadRule(reader, scope)).rejects.toMatchObject({ code: 'AUTOMATION_RULE_TRANSACTION_REQUIRED' })
    } finally { await reader.query('ROLLBACK') }
  })

  const rows = [
    ['base', 'meta_bases', scope.baseId, 'deleted_at = now()'],
    ['sheet', 'meta_sheets', scope.sheetId, 'deleted_at = now()'],
    ['rule', 'automation_rules', scope.ruleId, 'enabled = false'],
  ] as const

  it.each(rows)('fails NOWAIT on a concurrently held %s write lock without leaking SQL details', async (_label, table, id, edit) => {
    await writer.query('BEGIN')
    await writer.query(`UPDATE ${table} SET ${edit} WHERE id = $1`, [id])
    try {
      const started = Date.now()
      try {
        await capture()
        expect.fail('Busy rule prerequisite must reject')
      } catch (error) {
        expect(error).toBeInstanceOf(AutomationRuleAuthorityError)
        expect(error).toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_UNAVAILABLE', message: 'Automation rule authority is unavailable' })
        expect(error).not.toHaveProperty('cause')
        expect(String(error)).not.toContain(table)
        expect(Date.now() - started).toBeLessThan(2000)
      }
    } finally { await writer.query('ROLLBACK') }
  })

  const mutations = rows.flatMap(([label, table, id, edit]) => [
    [`${label} update`, `UPDATE ${table} SET ${edit} WHERE id = $1`, id],
    [`${label} delete`, `DELETE FROM ${table} WHERE id = $1`, id],
  ])
  it.each(mutations)('holds %s until the caller releases its real transaction', async (_label, statement, id) => {
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const locked = await lockAutomationReadRule(reader, scope)
    await writer.query('BEGIN')
    const readerPid = await pid(reader), writerPid = await pid(writer)
    let done = false
    const pending = writer.query(statement, [id]).then(result => { done = true; return result })
    void pending.catch(() => {})
    try {
      await waitForBlock(writerPid, readerPid, () => done)
      expect(done).toBe(false)
      expect((await lockAutomationReadRule(reader, scope)).fingerprint).toBe(locked.fingerprint)
      await reader.query('COMMIT')
      expect((await pending).rowCount).toBe(1)
      await writer.query('COMMIT')
      await expect(capture()).rejects.toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_DENIED' })
    } finally {
      await reader.query('ROLLBACK')
      await pending.catch(() => {})
      await writer.query('ROLLBACK')
    }
  })

  it('breaks a real base -> actor / actor -> base wait cycle with NOWAIT', async () => {
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    // The caller owns the actor lock before entering this prerequisite.
    await reader.query('SELECT id FROM users WHERE id = $1 FOR SHARE', [scope.actorId])
    await writer.query('BEGIN')
    await writer.query('SELECT id FROM meta_bases WHERE id = $1 FOR UPDATE', [scope.baseId])
    const readerPid = await pid(reader), writerPid = await pid(writer)
    let done = false
    const pending = writer.query('UPDATE users SET id = id WHERE id = $1', [scope.actorId])
      .then(result => { done = true; return result })
    void pending.catch(() => {})
    try {
      await waitForBlock(writerPid, readerPid, () => done)
      const started = Date.now()
      await expect(lockAutomationReadRule(reader, scope)).rejects.toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_UNAVAILABLE' })
      expect(Date.now() - started).toBeLessThan(2000)
      await reader.query('ROLLBACK')
      expect((await pending).rowCount).toBe(1)
    } finally {
      await reader.query('ROLLBACK')
      await pending.catch(() => {})
      await writer.query('ROLLBACK')
    }
  })
})
