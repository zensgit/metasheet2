import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { bootstrapPlmIngressTestDb } from '../plm-record-ingress/bootstrap'
import {
  provisionPlmRecordBinding,
  disablePlmRecordBinding,
  type PlmPool,
} from '../../src/multitable/plm-record-ingress-binding'
import { receivePlmRecordEvent } from '../../src/multitable/plm-record-ingress-service'
import { down, up } from '../../src/db/migrations/zzzz20261015030000_create_plm_record_ingress'
import fixtures from '../fixtures/plm-record-event-v1-fixtures.json'
import { acquireRecordLinkRowAuthLockOnQuery } from '../../src/services/approval-record-link-row-auth-lock'

if (!process.env.DATABASE_URL)
  throw new Error(
    'DATABASE_URL required: isolated disposable database only (EXPECT_DB must not skip-green)',
  )
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
const tx: PlmPool = {
  async transaction(fn) {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      const r = await fn({ query: c.query.bind(c) })
      await c.query('COMMIT')
      return r
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }
  },
}
const config = {
  id: fixtures.cases[0].event.binding_id,
  version: 1,
  token_id: 'token-1',
  source: {
    connection_id: 'fixture-yuantus',
    tenant_id: 'fixture-tenant',
    org_id: 'fixture-org',
    part_id: 'fixture-part',
  },
  sheet_id: 'sheet-1',
  fields: { quantity: 'f-q', uom: 'f-u', find_num: 'f-n', refdes: 'f-r' },
}
const audit = {
  tokenId: 'token-1',
  actorId: 'writer',
  operation: 'upsert' as const,
  scope: 'records:write',
}
const event = (seq = 1, line = 'fixture-line') => ({
  ...fixtures.cases[0].event,
  event_id: randomUUID(),
  source_sequence: seq,
  source: { ...fixtures.cases[0].event.source, bom_line_id: line },
})
async function counts() {
  const tables = [
    'meta_records',
    'meta_plm_record_inbox',
    'meta_plm_record_rows',
    'meta_record_revisions',
    'meta_record_history_operations',
    'oapi_write_audit',
    'meta_automation_outbox',
    'meta_automation_outbox_consumer',
  ]
  return Promise.all(
    tables.map(async (t) => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n),
  )
}

beforeAll(async () => {
  process.env.PLM_RECORD_INGRESS_ENABLED = 'true'
  process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
  process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
  await bootstrapPlmIngressTestDb(pool)
  const migrationDb = new Kysely({ dialect: new PostgresDialect({ pool }) })
  await down(migrationDb)
  await up(migrationDb)
  await pool.query(`INSERT INTO users VALUES('writer',true,'user','activated',true,ARRAY['multitable:read','multitable:write']);
   INSERT INTO meta_bases(id,owner_id) VALUES('base-1','writer');INSERT INTO meta_sheets(id,base_id) VALUES('sheet-1','base-1');
   INSERT INTO meta_fields(id,sheet_id,type,property) SELECT x,'sheet-1','string','{"readOnly":true}'::jsonb FROM unnest(ARRAY['f-q','f-u','f-n','f-r']) x;
   INSERT INTO multitable_api_tokens(id,created_by,scopes,base_ids,sheet_ids) VALUES('token-1','writer','["records:write"]',ARRAY['base-1'],ARRAY['sheet-1'])`)
  await provisionPlmRecordBinding(tx, config, { apply: true })
})
afterAll(async () => {
  await pool.end()
})

describe('actual PostgreSQL ingress transaction and protection', () => {
  it('dry-run, immutable idempotent binding, and no secret config', async () => {
    expect((await provisionPlmRecordBinding(tx, config, { apply: false })).id).toBe(config.id)
    await expect(
      provisionPlmRecordBinding(tx, { ...config, version: 2 }, { apply: true }),
    ).rejects.toMatchObject({ code: 'binding_conflict' })
    expect(
      (await pool.query('SELECT count(*)::int n FROM meta_plm_record_bindings')).rows[0].n,
    ).toBe(1)
  })
  it('commits all components and concurrent/replayed lost-ACK delivery has exactly one effect', async () => {
    const e = event()
    const before = await counts()
    const receipts = await Promise.all([
      receivePlmRecordEvent(tx, e, audit),
      receivePlmRecordEvent(tx, e, audit),
    ])
    expect(receipts[0]).toEqual(receipts[1])
    const after = await counts()
    expect(after.map((n, i) => n - before[i])).toEqual([1, 1, 1, 1, 1, 1, 1, 2])
    expect(await receivePlmRecordEvent(tx, e, audit)).toEqual(receipts[0])
    expect(await counts()).toEqual(after)
    await expect(
      receivePlmRecordEvent(tx, { ...e, cells: { ...e.cells, quantity: 'altered' } }, audit),
    ).rejects.toMatchObject({ code: 'event_conflict' })
    const wire = (
      await pool.query('SELECT payload FROM meta_automation_outbox ORDER BY created_at LIMIT 1')
    ).rows[0].payload
    expect(wire._origin).toBe('plm_domain_event')
    expect(wire._automationDepth).toBe(0)
  })
  it.each([
    ['writer', 'other', true], ['other', 'writer', true], ['other', 'unrelated', false],
  ])('uses native record lock policy: owner=%s locker=%s allowed=%s', async (owner, locker, allowed) => {
    const line = randomUUID()
    const first = await receivePlmRecordEvent(tx, event(1, line), audit)
    await pool.query("INSERT INTO users(id,is_active) VALUES('other',true) ON CONFLICT DO NOTHING")
    await pool.query('UPDATE meta_records SET created_by=$2,locked=true,locked_by=$3 WHERE id=$1', [first.record_id, owner, locker])
    const before = await counts()
    const next = receivePlmRecordEvent(tx, event(2, line), audit)
    if (allowed) await expect(next).resolves.toMatchObject({ record_id: first.record_id, source_sequence: 2 })
    else {
      await expect(next).rejects.toMatchObject({ status: 403, code: 'forbidden' })
      expect(await counts()).toEqual(before)
    }
  })

  it('sequence gap refuses then both accepted and local fields survive', async () => {
    const a = event(1, 'ordered'),
      b = event(2, 'ordered')
    b.cells = { ...b.cells, quantity: '9007199254740993123456789' }
    const before = await counts()
    await expect(receivePlmRecordEvent(tx, b, audit)).rejects.toMatchObject({
      code: 'sequence_gap',
    })
    expect(await counts()).toEqual(before)
    const r = await receivePlmRecordEvent(tx, a, audit)
    await pool.query(`UPDATE meta_records SET data=data || '{"local-note":"keep"}' WHERE id=$1`, [
      r.record_id,
    ])
    await receivePlmRecordEvent(tx, b, audit)
    expect(
      (await pool.query('SELECT data FROM meta_records WHERE id=$1', [r.record_id])).rows[0].data,
    ).toMatchObject({ 'f-q': b.cells.quantity, 'local-note': 'keep' })
    await expect(receivePlmRecordEvent(tx, event(1, 'ordered'), audit)).rejects.toMatchObject({
      code: 'sequence_conflict',
    })
  })
  it.each([
    'oapi_write_audit',
    'meta_record_revisions',
    'meta_record_history_operations',
    'meta_automation_outbox',
  ])('SQL failure at %s rolls back every component', async (table) => {
    await pool.query(
      `CREATE FUNCTION reject_test_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER reject_test BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_test_insert()`,
    )
    const before = await counts()
    try {
      await expect(receivePlmRecordEvent(tx, event(1, table), audit)).rejects.toThrow()
      expect(await counts()).toEqual(before)
    } finally {
      await pool.query(`DROP TRIGGER reject_test ON ${table};DROP FUNCTION reject_test_insert()`)
    }
  })
  it.each([
    'PLM_RECORD_INGRESS_ENABLED',
    'AUTOMATION_DURABLE_DELIVERY_ENABLED',
    'MULTITABLE_ENABLE_WRITER_FENCE',
  ])('required gate %s fails closed', async (key) => {
    const before = await counts()
    process.env[key] = 'false'
    try {
      await expect(receivePlmRecordEvent(tx, event(), audit)).rejects.toMatchObject({
        code: 'ingress_unavailable',
      })
      expect(await counts()).toEqual(before)
    } finally {
      process.env[key] = 'true'
    }
  })
  it('a committed phantom deny wins when the permission writer holds the row-auth lock first', async () => {
    const initial = await receivePlmRecordEvent(tx, event(1, 'deny-first'), audit)
    const before = await counts()
    const writer = await pool.connect()
    let receiving: Promise<unknown> | undefined
    let receiverPid = 0
    try {
      await writer.query('BEGIN')
      await acquireRecordLinkRowAuthLockOnQuery(
        writer.query.bind(writer),
        'sheet-1',
        initial.record_id,
      )
      await writer.query(
        "INSERT INTO record_permissions(sheet_id,record_id,subject_type,subject_id,access_level) VALUES('sheet-1',$1,'user','writer','none')",
        [initial.record_id],
      )
      const observed: PlmPool = {
        transaction: (fn) =>
          tx.transaction(async ({ query }) => {
            receiverPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid
            return fn({ query })
          }),
      }
      receiving = receivePlmRecordEvent(observed, event(2, 'deny-first'), audit).then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      let blocked = false
      for (let i = 0; i < 200; i++) {
        const result = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND wait_event='advisory'",
          [receiverPid],
        )
        if (result.rowCount) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await writer.query('COMMIT')
      const outcome = await receiving
      expect.soft(blocked).toBe(true)
      expect.soft(outcome).toMatchObject({ error: { status: 403, code: 'forbidden' } })
      expect.soft(await counts()).toEqual(before)
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
      if (receiving) await receiving
    }
  })
  it('a phantom deny insertion waits for receiver commit, then blocks the next occurrence', async () => {
    const initial = await receivePlmRecordEvent(tx, event(1, 'receiver-first'), audit)
    let signal!: () => void, release!: () => void
    const reached = new Promise<void>((resolve) => {
      signal = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const paused: PlmPool = {
      transaction: (fn) =>
        tx.transaction(({ query }) =>
          fn({
            query: async (sql, args) => {
              const result = await query(sql, args)
              if (sql.includes('FROM record_permissions rp')) {
                signal()
                await barrier
              }
              return result
            },
          }),
        ),
    }
    const receiving = receivePlmRecordEvent(paused, event(2, 'receiver-first'), audit)
    await reached
    const writer = await pool.connect()
    let deny: Promise<void> | undefined
    try {
      await writer.query('BEGIN')
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      deny = (async () => {
        await acquireRecordLinkRowAuthLockOnQuery(
          writer.query.bind(writer),
          'sheet-1',
          initial.record_id,
        )
        await writer.query(
          "INSERT INTO record_permissions(sheet_id,record_id,subject_type,subject_id,access_level) VALUES('sheet-1',$1,'user','writer','none')",
          [initial.record_id],
        )
        await writer.query('COMMIT')
      })()
      let blocked = false
      for (let i = 0; i < 200; i++) {
        const result = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND wait_event='advisory'",
          [pid],
        )
        if (result.rowCount) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      release()
      await receiving
      await deny
      expect(blocked).toBe(true)
      const before = await counts()
      await expect(
        receivePlmRecordEvent(tx, event(3, 'receiver-first'), audit),
      ).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      })
      expect(await counts()).toEqual(before)
    } finally {
      release()
      await receiving
      if (deny) await deny
      await writer.query('ROLLBACK')
      writer.release()
    }
  })
  it('rechecks token and creator current state, including replay', async () => {
    const e = event(1, 'revocation')
    await receivePlmRecordEvent(tx, e, audit)
    const before = await counts()
    await pool.query("UPDATE multitable_api_tokens SET revoked=true WHERE id='token-1'")
    try {
      await expect(receivePlmRecordEvent(tx, e, audit)).rejects.toMatchObject({
        code: 'invalid_token',
      })
    } finally {
      await pool.query("UPDATE multitable_api_tokens SET revoked=false WHERE id='token-1'")
    }
    await pool.query("UPDATE users SET is_active=false WHERE id='writer'")
    try {
      await expect(receivePlmRecordEvent(tx, e, audit)).rejects.toMatchObject({
        code: 'invalid_token',
      })
    } finally {
      await pool.query("UPDATE users SET is_active=true WHERE id='writer'")
    }
    await pool.query("UPDATE users SET permissions='{}' WHERE id='writer'")
    try {
      await expect(receivePlmRecordEvent(tx, e, audit)).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      await pool.query(
        "UPDATE users SET permissions=ARRAY['multitable:read','multitable:write'] WHERE id='writer'",
      )
    }
    expect(await counts()).toEqual(before)
  })
  it('rejects mismatched scope/token and malicious ordinary origin', async () => {
    const e = event()
    await expect(
      receivePlmRecordEvent(tx, { ...e, source: { ...e.source, tenant_id: 'other' } }, audit),
    ).rejects.toMatchObject({ code: 'binding_unavailable' })
    await expect(
      receivePlmRecordEvent(tx, e, { ...audit, tokenId: 'other' }),
    ).rejects.toMatchObject({ code: 'binding_unavailable' })
    await expect(
      receivePlmRecordEvent(tx, { ...e, origin: 'plm_domain_event' }, audit),
    ).rejects.toThrow()
  })
  it('ordinary direct-SQL writers and restore cannot overwrite, remove-null, delete or move protected data', async () => {
    const r = await receivePlmRecordEvent(tx, event(1, 'protected'), audit)
    const attacks = [
      `UPDATE meta_records SET data=data || '{"f-q":"bad"}' WHERE id=$1`,
      `UPDATE meta_records SET data=data-'f-r' WHERE id=$1`,
      `DELETE FROM meta_records WHERE id=$1`,
      `UPDATE meta_records SET id='moved' WHERE id=$1`,
    ]
    for (const sql of attacks)
      await expect(pool.query(sql, [r.record_id])).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query(
        `INSERT INTO meta_records(id,sheet_id,data) VALUES('forged','sheet-1','{"f-q":"bad"}')`,
      ),
    ).rejects.toMatchObject({ code: '23514' })
    await pool.query(`UPDATE meta_records SET data=data || '{"local":"yes"}' WHERE id=$1`, [
      r.record_id,
    ])
    expect(
      (await pool.query('SELECT data FROM meta_records WHERE id=$1', [r.record_id])).rows[0].data
        .local,
    ).toBe('yes')
  })
  it('schema/delete/truncate/restore cannot remove source protection', async () => {
    for (const sql of [
      `UPDATE meta_fields SET property='{}' WHERE id='f-q'`,
      `UPDATE meta_fields SET type='number' WHERE id='f-q'`,
      `DELETE FROM meta_fields WHERE id='f-q'`,
      `DELETE FROM meta_sheets WHERE id='sheet-1'`,
      `UPDATE meta_sheets SET deleted_at=now() WHERE id='sheet-1'`,
      `TRUNCATE meta_records`,
      `DELETE FROM meta_plm_record_bindings`,
    ])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '23514' })
  })
  it('unrelated ordinary fields, records and sheets retain delete behavior', async () => {
    await pool.query(
      `INSERT INTO meta_sheets(id,base_id) VALUES('unrelated','base-1');INSERT INTO meta_fields VALUES('unrelated-field','unrelated','string','{}');INSERT INTO meta_records(id,sheet_id) VALUES('unrelated-record','unrelated');DELETE FROM meta_records WHERE id='unrelated-record';DELETE FROM meta_fields WHERE id='unrelated-field';DELETE FROM meta_sheets WHERE id='unrelated'`,
    )
    expect((await pool.query("SELECT id FROM meta_sheets WHERE id='unrelated'")).rows).toHaveLength(
      0,
    )
  })
  it('transaction-local source authority cannot change local cells or another record and expires at commit', async () => {
    const first = await receivePlmRecordEvent(tx, event(1, 'limited'), audit)
    await pool.query(`UPDATE meta_records SET data=data || '{"local":"keep"}' WHERE id=$1`, [
      first.record_id,
    ])
    const next = event(2, 'limited')
    next.cells = { ...next.cells, quantity: 'next' }
    const before = await counts()
    const malicious: PlmPool = {
      transaction: (fn) =>
        tx.transaction(async ({ query }) => {
          const result = await fn({ query })
          await query(
            `UPDATE meta_records SET data=data || '{"f-q":"wrong","local":"lost"}' WHERE id=$1`,
            [first.record_id],
          )
          return result
        }),
    }
    await expect(receivePlmRecordEvent(malicious, next, audit)).rejects.toMatchObject({
      code: '23514',
    })
    expect(await counts()).toEqual(before)
    await receivePlmRecordEvent(tx, next, audit)
    await expect(
      pool.query(`UPDATE meta_records SET data=data || '{"f-q":"later-forged"}' WHERE id=$1`, [
        first.record_id,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  })
  it('provision holds source field locks until commit and a competing deletion cannot remove the binding field', async () => {
    await pool.query(
      `INSERT INTO meta_sheets(id,base_id) VALUES('race-sheet','base-1');INSERT INTO meta_fields(id,sheet_id,type,property) SELECT x,'race-sheet','string','{"readOnly":true}'::jsonb FROM unnest(ARRAY['r-q','r-u','r-n','r-r']) x`,
    )
    await pool.query(
      "UPDATE multitable_api_tokens SET sheet_ids=ARRAY['sheet-1','race-sheet'] WHERE id='token-1'",
    )
    let signal!: () => void, release!: () => void
    const reached = new Promise<void>((r) => {
        signal = r
      }),
      barrier = new Promise<void>((r) => {
        release = r
      })
    const held: PlmPool = {
      transaction: (fn) =>
        tx.transaction(async (t) => {
          const result = await fn(t)
          signal()
          await barrier
          return result
        }),
    }
    const provisioning = provisionPlmRecordBinding(
      held,
      {
        ...config,
        id: randomUUID(),
        sheet_id: 'race-sheet',
        fields: { quantity: 'r-q', uom: 'r-u', find_num: 'r-n', refdes: 'r-r' },
      },
      { apply: true },
    )
    await reached
    const deleteOutcome = pool.query("DELETE FROM meta_fields WHERE id='r-q'").then(
      () => null,
      (e) => e,
    )
    try {
      let blocked = false
      for (let i = 0; i < 200; i++) {
        const waiting = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query=$1",
          ["DELETE FROM meta_fields WHERE id='r-q'"],
        )
        if (waiting.rows.length) {
          blocked = true
          break
        }
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(blocked).toBe(true)
    } finally {
      release()
    }
    await provisioning
    expect(await deleteOutcome).toMatchObject({ code: '23514' })
  })
  it('receipt replay refuses absent ledger schema rather than acknowledging a degraded runtime', async () => {
    const e = event(1, 'schema')
    await receivePlmRecordEvent(tx, e, audit)
    await pool.query(
      'ALTER TABLE meta_record_history_operations RENAME TO fixture_hidden_operations',
    )
    try {
      await expect(receivePlmRecordEvent(tx, e, audit)).rejects.toMatchObject({
        code: 'ingress_unavailable',
      })
    } finally {
      await pool.query(
        'ALTER TABLE fixture_hidden_operations RENAME TO meta_record_history_operations',
      )
    }
  })
  it('disable preserves protections, refuses receipts and rollback migration keeps evidence', async () => {
    await disablePlmRecordBinding(tx, config.id)
    await expect(receivePlmRecordEvent(tx, event(), audit)).rejects.toMatchObject({
      code: 'binding_unavailable',
    })
    await expect(
      pool.query(`UPDATE meta_records SET data=data || '{"f-q":"bad"}' WHERE sheet_id='sheet-1'`),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(down(new Kysely({ dialect: new PostgresDialect({ pool }) }))).rejects.toThrow(
      'plm_source_evidence_present',
    )
  })
})


describe('empty downgrade versus concurrent provisioning', () => {
  it('cannot drop a binding committed after its empty preflight', async () => {
    const schema = `plm_downgrade_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE SCHEMA "${schema}"`)
    const isolated = new Pool({ connectionString: process.env.DATABASE_URL, max: 6, options: `-csearch_path=${schema} -clock_timeout=5000` })
    const migrationDb = new Kysely({ dialect: new PostgresDialect({ pool: isolated }) })
    let blocker: Awaited<ReturnType<Pool['connect']>> | undefined
    let dropping: Promise<unknown> | undefined, provisioning: Promise<unknown> | undefined
    try {
      await bootstrapPlmIngressTestDb(isolated)
      await isolated.query(`INSERT INTO users VALUES('writer',true,'user','activated',true,ARRAY['multitable:read','multitable:write']);
        INSERT INTO meta_bases(id,owner_id) VALUES('base-1','writer');
        INSERT INTO meta_sheets(id,base_id) VALUES('sheet-1','base-1');
        INSERT INTO meta_fields(id,sheet_id,type,property) SELECT x,'sheet-1','string','{"readOnly":true}'::jsonb FROM unnest(ARRAY['f-q','f-u','f-n','f-r']) x;
        INSERT INTO multitable_api_tokens(id,created_by,scopes,base_ids,sheet_ids) VALUES('token-1','writer','["records:write"]',ARRAY['base-1'],ARRAY['sheet-1'])`)
      blocker = await isolated.connect()
      await blocker.query('BEGIN')
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query('SELECT id FROM meta_records FOR SHARE')
      let downgradeResult: { dropped?: boolean; error?: { code?: string } } | undefined
      dropping = down(migrationDb).then(() => (downgradeResult = { dropped: true }), error => (downgradeResult = { error }))
      let downgradePid: number | undefined
      for (let i = 0; i < 200; i++) {
        const active = await pool.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [blockerPid])
        if (active.rows.length) { downgradePid = active.rows[0].pid; break }
        if (downgradeResult) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(downgradePid !== undefined || downgradeResult?.error?.code === '55P03').toBe(true)
      let writerPid: number | undefined, committed = false
      const otherTx: PlmPool = { async transaction(fn) {
        const client = await isolated.connect()
        try {
          await client.query('BEGIN')
          writerPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
          const value = await fn({ query: client.query.bind(client) })
          await client.query('COMMIT'); committed = true; return value
        } catch (error) { await client.query('ROLLBACK'); throw error }
        finally { client.release() }
      } }
      provisioning = provisionPlmRecordBinding(otherTx, config, { apply: true }).catch(error => ({ error }))
      await provisioning
      await blocker.query('COMMIT'); blocker.release(); blocker = undefined
      await dropping
      expect(downgradeResult?.error).toMatchObject({ code: '55P03' })
      expect(committed).toBe(true)
      expect(Number((await isolated.query('SELECT count(*) AS n FROM meta_plm_record_bindings')).rows[0].n)).toBe(1)
    } finally {
      if (blocker) { await blocker.query('ROLLBACK'); blocker.release() }
      await Promise.allSettled([dropping, provisioning].filter(Boolean))
      await isolated.end()
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    }
  })
})
