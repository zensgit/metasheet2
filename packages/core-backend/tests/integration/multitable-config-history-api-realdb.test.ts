/**
 * T9-R3: config/schema-change history READ API — real DB. The load-bearing property is the PER-ENTITY-TYPE gate
 * (read-gate ≡ write-gate), applied IN the WHERE clause: field/field-perm → canManageFields(=manage-schema),
 * view/view-perm → canManageViews(=write), sheet_config/sheet-perm → canManageSheetAccess(=share). Caps:
 * field = multitable:manage-schema (since the schema/record-write split — src/multitable/manage-schema-permission.ts),
 * view = multitable:write, sheet-config/sheet-access = multitable:share (independent), so the meaningful DENY case
 * here is write+manage-schema-but-not-share.
 * Tests BOTH allow and deny (not allow-only). Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_ch_${TS}`
const SHEET = `sheet_ch_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let currentActor: { id: string; roles: string[]; perms: string[] }
const ADMIN = { id: `u_admin_${TS}`, roles: ['admin'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }
// canManageFields now requires multitable:manage-schema (src/multitable/manage-schema-permission.ts)
const WRITER = { id: `u_writer_${TS}`, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:manage-schema'] } // NOT share
const SHARER = { id: `u_sharer_${TS}`, roles: ['member'], perms: ['multitable:read', 'multitable:share'] } // NOT write
const READER = { id: `u_reader_${TS}`, roles: ['member'], perms: ['multitable:read'] } // no manage caps
const NAMED_ACTOR = `u_config_history_named_${TS}`
const HIDDEN_ACTOR = `u_config_history_hidden_${TS}`
const UNKNOWN_ACTOR = `u_config_history_unknown_${TS}`

const list = (as: typeof ADMIN, qs = '') => { currentActor = as; return request(app).get(`/api/multitable/sheets/${SHEET}/config-history${qs}`) }
const ids = (res: { body?: any }) => (res.body?.data?.items ?? []).map((i: { entityId: string }) => i.entityId)

// Insert one revision of a given entity_type/entity_id (the R3 read API reads the table; recording is R2's goldens).
const seedRev = (entityType: string, entityId: string, actorId = ADMIN.id) => q(
  `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, after, changed_keys, actor_id)
   VALUES ($1,$2,$3,'create','{}'::jsonb, ARRAY['x']::text[], $4)`,
  [SHEET, entityType, entityId, actorId],
)

describeIfDatabase('multitable config-history read API — T9-R3 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentActor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'CH Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'CH Sheet'])
    await q(
      `INSERT INTO users (id, email, name, password_hash)
       VALUES ($1, $2, $3, 'x'), ($4, $5, $6, 'x')
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
      [NAMED_ACTOR, `${NAMED_ACTOR}@example.test`, 'Config History Actor', HIDDEN_ACTOR, `${HIDDEN_ACTOR}@example.test`, 'Hidden Config Actor'],
    )
    // one revision per gated bucket
    await seedRev('field', 'fld_ch', NAMED_ACTOR)
    await seedRev('view', 'view_ch', UNKNOWN_ACTOR)
    await seedRev('sheet_config', SHEET, HIDDEN_ACTOR)
    await seedRev('permission', `field:["fld_ch","user","s1"]`)
    await seedRev('permission', `view:["view_ch","user","s1"]`)
    await seedRev('permission', `sheet:["user","s1"]`, HIDDEN_ACTOR)
  })
  afterAll(async () => {
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[NAMED_ACTOR, HIDDEN_ACTOR]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('admin sees ALL six revisions, deterministic order (created_at DESC, id DESC)', async () => {
    const res = await list(ADMIN)
    expect(res.status).toBe(200)
    expect(res.body?.data?.items?.length).toBe(6)
    // most-recent first: the seeds were inserted in order, so the last (sheet-perm) is first
    expect(ids(res)[0]).toBe('sheet:["user","s1"]')
  })

  test('enriches returned actors by display name and keeps an unknown actor null', async () => {
    const res = await list(ADMIN)
    const items = res.body?.data?.items ?? []
    expect(items.find((item: { entityId: string }) => item.entityId === 'fld_ch')).toMatchObject({ actorId: NAMED_ACTOR, actorName: 'Config History Actor' })
    expect(items.find((item: { entityId: string }) => item.entityId === 'view_ch')).toMatchObject({ actorId: UNKNOWN_ACTOR, actorName: null })
  })

  test('DENY: a write-but-not-share actor sees field/view (+ their perms) but NOT sheet_config / sheet-perm', async () => {
    const res = await list(WRITER)
    expect(res.status).toBe(200)
    const seen = ids(res)
    expect(seen).toContain('fld_ch') // field
    expect(seen).toContain('view_ch') // view
    expect(seen).toContain('field:["fld_ch","user","s1"]') // field-perm
    expect(seen).toContain('view:["view_ch","user","s1"]') // view-perm
    expect(seen).not.toContain(SHEET) // sheet_config DENIED
    expect(seen).not.toContain('sheet:["user","s1"]') // sheet-perm DENIED
    expect(seen.length).toBe(4)
    expect(JSON.stringify(res.body)).not.toContain('Hidden Config Actor')
  })

  test('inverse DENY: a share-but-not-write actor sees sheet_config / sheet-perm but NOT field / view', async () => {
    const res = await list(SHARER)
    const seen = ids(res)
    expect(seen).toContain(SHEET) // sheet_config
    expect(seen).toContain('sheet:["user","s1"]') // sheet-perm
    expect(seen).not.toContain('fld_ch')
    expect(seen).not.toContain('view_ch')
    expect(seen).not.toContain('field:["fld_ch","user","s1"]')
    expect(seen.length).toBe(2)
  })

  test('a read-only actor (manages no config) gets an empty list, not a leak', async () => {
    const res = await list(READER)
    expect(res.status).toBe(200)
    expect(res.body?.data?.items).toEqual([])
    expect(JSON.stringify(res.body)).not.toContain('Config History Actor')
    expect(JSON.stringify(res.body)).not.toContain('Hidden Config Actor')
  })

  test('entityType filter narrows within the allowed set (writer ?entityType=field → only the field rev)', async () => {
    const res = await list(WRITER, '?entityType=field')
    expect(ids(res)).toEqual(['fld_ch'])
  })

  test('entityType filter cannot bypass the gate (writer ?entityType=sheet_config → still empty)', async () => {
    const res = await list(WRITER, '?entityType=sheet_config')
    expect(res.body?.data?.items).toEqual([]) // gate is in the WHERE; the filter only narrows within it
  })

  test('pagination is honored (limit/offset on the gated set)', async () => {
    const first = await list(ADMIN, '?limit=2&offset=0')
    const second = await list(ADMIN, '?limit=2&offset=2')
    expect(first.body?.data?.items?.length).toBe(2)
    expect(second.body?.data?.items?.length).toBe(2)
    expect(ids(first)).not.toEqual(ids(second)) // distinct pages, gated in the WHERE (no short pages)
  })
})
