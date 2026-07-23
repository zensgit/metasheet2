/**
 * W2 — 模板演进 rung 核心原语真库证(ensureMissingObjectFields, additive-only).
 *
 * linchpin 断言:`ensureMissingObjectFields` 用 ON CONFLICT DO NOTHING,故
 *   (a) 缺失字段被新增;
 *   (b) 既有字段被 SKIP,且其 property(如 option-sync 写入的选项集)逐键不变——
 *       这正是 `ensureFields`(DO UPDATE)会砸掉、而本原语构造性守住的东西。
 * 若把 DO NOTHING 换 DO UPDATE(变异),(b) 立即红。
 */
import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ensureMissingObjectFields, ensureObject } from '../../src/multitable/provisioning'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

describeDb('W2 ensureMissingObjectFields (additive-only, real DB)', () => {
  const RUN = randomUUID().replace(/-/g, '').slice(0, 12)
  const projectId = `w2_${RUN}`
  const objectId = `w2obj_${RUN}`
  let pool: Pool
  let sheetId = ''

  const q = (client: { query: QueryFn }): QueryFn => (sql, params) => client.query(sql, params)

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    // Provision a v1 object with ONE field (existingField), through the real ensureObject path.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const res = await ensureObject({
        query: q(client) as never,
        projectId,
        descriptor: {
          id: objectId,
          name: `W2 ${RUN}`,
          fields: [{ id: 'existingField', name: 'Existing', type: 'text' }],
        } as never,
      })
      sheetId = res.sheet.id
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    // Simulate an option-sync-style property write on the existing field, so a DO UPDATE
    // would visibly clobber it.
    await pool.query(
      `UPDATE meta_fields SET property = '{"options":["A","B"]}'::jsonb
       WHERE sheet_id = $1 AND name = 'Existing'`,
      [sheetId],
    )
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM meta_fields WHERE sheet_id = $1`, [sheetId]).catch(() => {})
    await pool.query(`DELETE FROM meta_sheets WHERE id = $1`, [sheetId]).catch(() => {})
    await pool.end()
  })

  it('adds the missing field, skips the existing one, and does NOT overwrite its property', async () => {
    const client = await pool.connect()
    let result: { addedFieldIds: string[]; skippedExistingFieldIds: string[] }
    try {
      await client.query('BEGIN')
      result = await ensureMissingObjectFields({
        query: q(client) as never,
        projectId,
        objectId,
        // template evolved: existingField (already there) + newField (missing)
        fields: [
          { id: 'existingField', name: 'Existing RENAMED', type: 'text' } as never,
          { id: 'newField', name: 'New', type: 'date' } as never,
        ],
      })
      await client.query('COMMIT')
    } finally {
      client.release()
    }

    expect(result.addedFieldIds).toHaveLength(1)
    expect(result.skippedExistingFieldIds).toHaveLength(1)

    // (b) the existing field's option-sync property survived untouched (DO NOTHING),
    // AND its name was NOT overwritten to "Existing RENAMED".
    const existing = await pool.query(
      `SELECT name, property FROM meta_fields WHERE sheet_id = $1 AND type = 'text'`,
      [sheetId],
    )
    expect(existing.rows).toHaveLength(1)
    const row = existing.rows[0] as { name: string; property: { options?: string[] } }
    expect(row.name).toBe('Existing') // NOT clobbered to the evolved name
    expect(row.property.options).toEqual(['A', 'B']) // option-sync property intact

    // (a) the new field physically exists and is writable.
    const added = await pool.query(
      `SELECT name, type FROM meta_fields WHERE sheet_id = $1 AND type = 'date'`,
      [sheetId],
    )
    expect(added.rows).toHaveLength(1)
    expect((added.rows[0] as { name: string }).name).toBe('New')
  })

  it('re-run is idempotent: all fields now skipped, none added', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await ensureMissingObjectFields({
        query: q(client) as never,
        projectId,
        objectId,
        fields: [
          { id: 'existingField', name: 'Existing', type: 'text' } as never,
          { id: 'newField', name: 'New', type: 'date' } as never,
        ],
      })
      await client.query('COMMIT')
      expect(result.addedFieldIds).toHaveLength(0)
      expect(result.skippedExistingFieldIds).toHaveLength(2)
    } finally {
      client.release()
    }
  })
})
