/**
 * P1a — 通用备料系统 substrate 证明(real DB)。
 *
 * 证 `general-prep-system-on-multitable-feasibility-20260721.md` 的地基断言 + Fable5 审阅 P2-1 的边界:
 *   正例 1  provision 出的备料 sheet 是真 multitable sheet(meta_bases/meta_sheets/meta_fields),
 *           插件 records 写入落 meta_records(source='plugin' revision)。
 *   正例 2  字段权限真绑在该 sheet 上(field_permissions 行可写可读回)。
 *   正例 3  durable-delivery ON 时,同事务 enqueue 会往 meta_automation_outbox 落一行(机制存在)。
 *   负例 ★  同 flag ON、同库,插件写路径 records.createRecord **不**产出任何 automation outbox 事件——
 *           这是审阅 P2-1 揭示的真边界:自动化事件只在网格路由层发射,插件写(refresh/apply/sync/confirm
 *           在生产里的主写入方)不发。P1a 若忽略此点、只测网格路径,会把一个生产写路径不具备的性质当已具备。
 *
 * 共享库纪律:唯一 RUN 前缀防夹具冲突;afterAll 清自己的行。DATABASE_URL-gated(无库则 skip)。
 */
import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRecord } from '../../src/multitable/records'
import { enqueueRecordEventIfDurable } from '../../src/multitable/automation-producer-emit'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

// A single-connection query fn (records.createRecord's MultitableRecordsQueryFn); createRecord runs its
// whole body on ONE handle (index.ts wraps each plugin-SDK create in a txn), and enqueueRecordEventIfDurable's
// xid probe rejects a pool handle — so both must ride a dedicated client inside BEGIN/COMMIT.
type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

describeDb('P1a stock-prep substrate proof (real DB)', () => {
  const RUN = randomUUID().replace(/-/g, '').slice(0, 12)
  const baseId = `base_p1a_${RUN}`
  const sheetId = `sheet_p1a_${RUN}`
  const fieldId = `fld_p1a_${RUN}`
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    // A REAL multitable sheet: base + sheet + one text field (system_kind marks it a provisioned
    // stock-prep-style target; the record/permission/event primitives below are sheet-agnostic, which is
    // exactly the substrate claim — they act on ordinary meta_sheets).
    await pool.query(`INSERT INTO meta_bases (id, name) VALUES ($1, $2)`, [baseId, `P1A ${RUN}`])
    await pool.query(
      `INSERT INTO meta_sheets (id, name, base_id, system_kind) VALUES ($1, $2, $3, $4)`,
      [sheetId, `P1A prep ${RUN}`, baseId, 'plm_stock_preparation_main'],
    )
    await pool.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property) VALUES ($1, $2, $3, 'text', '{}'::jsonb)`,
      [fieldId, sheetId, 'componentCode'],
    )
  })

  afterAll(async () => {
    // Clean up only our own rows (shared DB).
    await pool.query(`DELETE FROM meta_automation_outbox WHERE event_id LIKE $1`, [`evt_p1a_${RUN}%`]).catch(() => {})
    await pool.query(`DELETE FROM meta_records WHERE sheet_id = $1`, [sheetId]).catch(() => {})
    await pool.query(`DELETE FROM field_permissions WHERE sheet_id = $1`, [sheetId]).catch(() => {})
    await pool.query(`DELETE FROM meta_fields WHERE sheet_id = $1`, [sheetId]).catch(() => {})
    await pool.query(`DELETE FROM meta_sheets WHERE id = $1`, [sheetId]).catch(() => {})
    await pool.query(`DELETE FROM meta_bases WHERE id = $1`, [baseId]).catch(() => {})
    await pool.end()
  })

  it('正例1: 插件 records.createRecord 落 meta_records(真 multitable 写路径)', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const query: QueryFn = (sql, params) => client.query(sql, params as unknown[])
      const created = await createRecord({ query, sheetId, data: { [fieldId]: 'GB-001' } })
      await client.query('COMMIT')
      expect(created.id).toMatch(/^rec_/)
      const { rows } = await pool.query(`SELECT data FROM meta_records WHERE id = $1`, [created.id])
      expect(rows).toHaveLength(1)
      expect((rows[0] as { data: Record<string, unknown> }).data[fieldId]).toBe('GB-001')
    } finally {
      client.release()
    }
  })

  it('正例2: 字段权限真绑在该 sheet 上(field_permissions 可写可读回)', async () => {
    await pool.query(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
       VALUES ($1, $2, 'role', $3, true, true)`,
      [sheetId, fieldId, `procurement_${RUN}`],
    )
    const { rows } = await pool.query(
      `SELECT read_only FROM field_permissions WHERE sheet_id = $1 AND field_id = $2 AND subject_id = $3`,
      [sheetId, fieldId, `procurement_${RUN}`],
    )
    expect(rows).toHaveLength(1)
    expect((rows[0] as { read_only: boolean }).read_only).toBe(true)
  })

  it('正例3: durable ON 时同事务 enqueue 往 outbox 落一行(机制存在)', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // enqueueRecordEventIfDurable's xid probe calls trx.query(...) as a METHOD (pg-transaction-guard),
      // so hand it a client-backed { query } object, not a bare fn.
      const trx = { query: (sql: string, params?: unknown[]) => client.query(sql, params as unknown[]) } as never
      const eventId = `evt_p1a_${RUN}_enqueue`
      const enqueued = await enqueueRecordEventIfDurable(
        trx,
        'multitable.record.created',
        { _eventId: eventId, _automationDepth: 0, sheetId },
        { ...process.env, AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' },
      )
      await client.query('COMMIT')
      expect(enqueued).toBe(true)
      const { rows } = await pool.query(`SELECT event_type FROM meta_automation_outbox WHERE event_id = $1`, [eventId])
      expect(rows).toHaveLength(1)
    } finally {
      client.release()
    }
  })

  it('负例★: durable ON 时插件 createRecord 不产出任何 automation outbox 事件(审阅 P2-1 边界)', async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM meta_automation_outbox`)
    const n0 = (before.rows[0] as { n: number }).n

    const client = await pool.connect()
    let createdId = ''
    try {
      await client.query('BEGIN')
      const query: QueryFn = (sql, params) => client.query(sql, params as unknown[])
      // durable flag ON in the process env for the whole create — if the plugin path emitted, it would enqueue.
      const prev = process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
      process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
      try {
        const created = await createRecord({ query, sheetId, data: { [fieldId]: 'GB-negative' } })
        createdId = created.id
      } finally {
        if (prev === undefined) delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
        else process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = prev
      }
      await client.query('COMMIT')
    } finally {
      client.release()
    }

    expect(createdId).toMatch(/^rec_/)
    const after = await pool.query(`SELECT count(*)::int AS n FROM meta_automation_outbox`)
    const n1 = (after.rows[0] as { n: number }).n
    // The plugin write path emits NO automation event: outbox count unchanged. This is the real gap —
    // refresh/apply/sync/confirm (the production writers of the 9 stock-prep sheets) go through this path,
    // so "batch refresh → notify dept" cannot be expressed by current automation without a new emit seam.
    expect(n1).toBe(n0)
  })
})
