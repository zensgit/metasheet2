/**
 * 人工补充行 B2 — R-66 ① AS AMENDED (owner OQ2, 2026-10-30; ADR adr-stock-prep-manual-rows-20261030 §2.2 E, §3.5) on
 * the real DELETE / restore routes and the read paths, over the stateful fake Postgres.
 *
 *   D-01..08  DELETE /records/:recordId — E: a `manual:` prefix-key row WITH a creator is deletable (the manual row,
 *             and an unbound prefix row — on a project sheet AND on the env table); a prefix row without a creator (null,
 *             or whitespace only), a leading-space key (raw comparison), every PLM-keyed row stay refused for the writer
 *             AND the platform admin; key_column_missing still refuses every row; two key columns give no exemption.
 *   D-09..10  restore — unchanged: a deleted manual row comes back (no live row holds its unique key); a PLM row whose key
 *             a live row holds stays refused.
 *   D-11..14  the four display sites — GET /view (the delete block AND the `manualSupplement` mark through
 *             rowActionOverrides; the creator statement only for the page's prefix rows; a reader costs nothing),
 *             GET /records/:id, the form context (row identity only: the form is unchanged, OQ7).
 *   D-15      the sinks that hand NO row identity (plugin SDK / automation / reset) keep refusing a manual row.
 *
 * Mock pool, no DB; one pinned listener (#4154). Every value is synthetic.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'
import { MR_ENV_OBJECT, MR_PROJECT_NO, createManualRowsFakePool, type FakeSheet } from '../utils/stock-prep-manual-rows-fake-pg'
import {
  assertPlmRowDeletable,
  plmRowDeleteRefusedBody,
  plmRowDeleteRefusalReason,
  PlmRowDeleteRefusedError,
  RECORD_DELETE_REFUSED_PLM_ROW_CODE,
  RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE_CODE,
} from '../../src/multitable/plm-row-delete-guard'

const fake = createManualRowsFakePool()
const WRITER = { id: 'u_mrb2_del_writer', roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const ADMIN = { id: 'u_mrb2_del_admin', roles: ['admin'], perms: [] as string[] }
const READER = { id: 'u_mrb2_del_reader', roles: ['member'], perms: ['multitable:read'] }
let actor: { id: string; roles: string[]; perms: string[] } = WRITER
let app: Express

const P = (n: number) => `plm_stock_preparation_sandbox_p_${n.toString(16).padStart(24, '0')}`
const PLM_KEY = JSON.stringify({ projectNo: MR_PROJECT_NO, componentSourceId: 'SYN-PART-1', parentSourceId: null, path: '["SYN-PART-1"]' })

let PREG: FakeSheet
let ENV: FakeSheet
let NOKEY: FakeSheet
let TWOKEYS: FakeSheet

const ph = (sheet: FakeSheet, logical: string) => fake.phys(sheet, logical)
const keyed = (sheet: FakeSheet, id: string, key: unknown, createdBy: string | null) =>
  fake.addRecord(sheet, id, { projectNo: MR_PROJECT_NO, idempotencyKey: key, active: true, componentName: 'SYN', totalQuantity: 1 }, createdBy)

function seed() {
  fake.reset()
  PREG = fake.addSheet('PREG', { objectId: P(21) })
  ENV = fake.addSheet('ENV', { objectId: MR_ENV_OBJECT, target: null })
  // Registered with the stanza but no key:true column → key_column_missing.
  NOKEY = fake.addSheet('NOKEY', { objectId: P(22), omit: ['idempotencyKey'] })
  TWOKEYS = fake.addSheet('TWOKEYS', { objectId: P(23), secondKey: true })
  keyed(PREG, 'rec_mrb2_d_manual', 'manual:v1:rec_mrb2_d_manual', 'u_mrb2_person')
  keyed(PREG, 'rec_mrb2_d_unbound', 'manual:v1:rec_mrb2_somebody', 'u_mrb2_person')
  keyed(PREG, 'rec_mrb2_d_unbound_v2', 'manual:v2:rec_mrb2_d_unbound_v2', 'u_mrb2_person')
  keyed(PREG, 'rec_mrb2_d_nocreator', 'manual:v1:rec_mrb2_d_nocreator', null)
  keyed(PREG, 'rec_mrb2_d_wscreator', 'manual:v1:rec_mrb2_d_wscreator', '   ')
  keyed(PREG, 'rec_mrb2_d_leadingspace', ' manual:v1:rec_mrb2_d_leadingspace', 'u_mrb2_person')
  keyed(PREG, 'rec_mrb2_d_plm', PLM_KEY, null)
  keyed(PREG, 'rec_mrb2_d_plm_person', PLM_KEY.replace('SYN-PART-1', 'SYN-PART-2'), 'u_mrb2_person')
  keyed(PREG, 'rec_mrb2_d_keyless', '', 'u_mrb2_person')
  keyed(ENV, 'rec_mrb2_d_env_own', 'manual:v1:rec_mrb2_d_env_own', 'u_mrb2_person')
  keyed(ENV, 'rec_mrb2_d_env_nocreator', 'manual:v1:rec_mrb2_d_env_nocreator', null)
  fake.addRecord(NOKEY, 'rec_mrb2_d_nokey', { componentName: 'SYN' }, 'u_mrb2_person')
  keyed(TWOKEYS, 'rec_mrb2_d_twokeys', 'manual:v1:rec_mrb2_d_twokeys', 'u_mrb2_person')
}

async function buildApp(): Promise<Express> {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue(fake.pool as never)
  const built = express()
  built.use(express.json())
  built.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = actor
    next()
  })
  built.use('/api/multitable', univerMetaRouter())
  return built
}

const pinned = usePinnedServer()
const http = () => {
  pinned.setApp(app)
  return request(pinned.url())
}
const del = (recordId: string) => http().delete(`/api/multitable/records/${recordId}`)
const restore = (recordId: string) => http().post(`/api/multitable/records/${recordId}/restore`).send({})

beforeAll(async () => {
  app = await buildApp()
}, 120_000)

beforeEach(() => {
  seed()
  actor = WRITER
})

describe('D — DELETE /records/:recordId under the amended R-66 ①', () => {
  const deletable: Array<[string, string]> = [
    ['the manual supplementary row (own key, creator, project sheet)', 'rec_mrb2_d_manual'],
    ['an unbound prefix row with a creator (the key names another row)', 'rec_mrb2_d_unbound'],
    ['an unbound prefix row with a creator (another version tag)', 'rec_mrb2_d_unbound_v2'],
    ['a prefix row with a creator on the ENV table', 'rec_mrb2_d_env_own'],
    ['the keyless row (as before)', 'rec_mrb2_d_keyless'],
  ]
  for (const who of [WRITER, ADMIN]) {
    it.each(deletable)(`D-01 ${who === WRITER ? 'writer' : 'admin'}: %s is deleted and lands in the trash`, async (_label, id) => {
      actor = who
      const res = await del(id)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(fake.records.has(id)).toBe(false)
      expect([...fake.trash.values()].some((t) => t.record_id === id)).toBe(true)
    })
  }

  const refused: Array<[string, string]> = [
    ['a prefix row WITHOUT a creator', 'rec_mrb2_d_nocreator'],
    ['a prefix row whose creator is whitespace only', 'rec_mrb2_d_wscreator'],
    ['a key with a LEADING space (raw comparison: not the namespace)', 'rec_mrb2_d_leadingspace'],
    ['a PLM row', 'rec_mrb2_d_plm'],
    ['a PLM-keyed row a person made (a pre-#6598 copy)', 'rec_mrb2_d_plm_person'],
    ['a prefix row without a creator on the ENV table', 'rec_mrb2_d_env_nocreator'],
    ['a prefix row with a creator on a sheet with TWO key columns (no exemption)', 'rec_mrb2_d_twokeys'],
  ]
  for (const who of [WRITER, ADMIN]) {
    it.each(refused)(`D-02 ${who === WRITER ? 'writer' : 'admin'}: %s → 409 RECORD_DELETE_REFUSED_PLM_ROW, values-free, nothing written`, async (_label, id) => {
      actor = who
      const before = structuredClone(fake.records.get(id))
      const res = await del(id)
      expect(res.status).toBe(409)
      expect(res.body).toEqual(plmRowDeleteRefusedBody('plm_row'))
      expect(res.body.error.code).toBe(RECORD_DELETE_REFUSED_PLM_ROW_CODE)
      for (const value of [id, PREG.sheetId, ENV.sheetId]) expect(res.text).not.toContain(value)
      expect(fake.records.get(id)).toEqual(before)
      expect([...fake.trash.values()].some((t) => t.record_id === id)).toBe(false)
    })
  }

  it('D-03 key_column_missing still fails closed: every row of that sheet refused, for the admin too', async () => {
    actor = ADMIN
    const res = await del('rec_mrb2_d_nokey')
    expect(res.status).toBe(409)
    expect(res.body).toEqual(plmRowDeleteRefusedBody('key_column_missing'))
    expect(fake.records.has('rec_mrb2_d_nokey')).toBe(true)
  })

  it('D-04 a reader is refused by the capability gate first and learns nothing', async () => {
    actor = READER
    const res = await del('rec_mrb2_d_manual')
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).not.toBe(RECORD_DELETE_REFUSED_PLM_ROW_CODE)
    expect(fake.records.has('rec_mrb2_d_manual')).toBe(true)
  })
})

describe('D — restore is unchanged', () => {
  it('D-09 a deleted manual row is restored with its id and creator (no live row holds its unique key)', async () => {
    expect((await del('rec_mrb2_d_manual')).status).toBe(200)
    const res = await restore('rec_mrb2_d_manual')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const back = fake.records.get('rec_mrb2_d_manual')!
    expect(back.created_by).toBe('u_mrb2_person')
    expect(back.data[ph(PREG, 'idempotencyKey')]).toBe('manual:v1:rec_mrb2_d_manual')
  })

  it('D-10 a trashed PLM row whose key a live row holds stays refused (409 RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE)', async () => {
    fake.trash.set('trash_mrb2_live', {
      id: 'trash_mrb2_live', record_id: 'rec_mrb2_d_plm_trashed', sheet_id: PREG.sheetId, base_id: null,
      data: { [ph(PREG, 'idempotencyKey')]: PLM_KEY }, original_version: 1, created_by: null, deleted_by: 'u_x', deleted_at: '2026-10-30T00:00:00.000Z',
    })
    const res = await restore('rec_mrb2_d_plm_trashed')
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe(RECORD_RESTORE_REFUSED_PLM_KEY_ACTIVE_CODE)
  })
})

describe('D — the four display sites', () => {
  it.each([
    ['a writer', WRITER],
    ['a platform admin', ADMIN],
  ])('D-11 GET /view (%s): the manual row is deletable AND marked; an unbound row with a creator is deletable, unmarked; the rest as R-66 ① says', async (_label, who) => {
    actor = who
    const res = await http().get('/api/multitable/view').query({ sheetId: PREG.sheetId })
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
    const { rowActions, rowActionOverrides } = res.body.data.meta.permissions
    expect(rowActions.canDelete).toBe(true)
    expect(rowActionOverrides.rec_mrb2_d_manual).toEqual({ ...rowActions, manualSupplement: true })
    for (const id of ['rec_mrb2_d_unbound', 'rec_mrb2_d_unbound_v2', 'rec_mrb2_d_keyless']) expect(rowActionOverrides[id], id).toBeUndefined()
    const blocked = { ...rowActions, canDelete: false, deleteBlockedReason: 'plm_row' }
    for (const id of ['rec_mrb2_d_nocreator', 'rec_mrb2_d_wscreator', 'rec_mrb2_d_leadingspace', 'rec_mrb2_d_plm', 'rec_mrb2_d_plm_person']) {
      expect(rowActionOverrides[id], id).toEqual(blocked)
    }
  })

  it('D-12 GET /view loads creators for the page\'s `manual:` prefix rows ONLY (one statement), and a reader costs neither statement', async () => {
    await http().get('/api/multitable/view').query({ sheetId: PREG.sheetId })
    const creatorReads = fake.statements(/^SELECT id, created_by FROM meta_records WHERE sheet_id = \$1 AND id = ANY/)
    expect(creatorReads).toHaveLength(1)
    expect([...(creatorReads[0].params[1] as string[])].sort()).toEqual(['rec_mrb2_d_manual', 'rec_mrb2_d_nocreator', 'rec_mrb2_d_unbound', 'rec_mrb2_d_unbound_v2', 'rec_mrb2_d_wscreator'])
    fake.sqlLog.length = 0
    actor = READER
    const res = await http().get('/api/multitable/view').query({ sheetId: PREG.sheetId })
    expect(res.status).toBe(200)
    expect('rowActionOverrides' in res.body.data.meta.permissions).toBe(false)
    expect(fake.statements(/^SELECT plugin_name, object_id FROM plugin_multitable_object_registry/)).toEqual([])
    expect(fake.statements(/^SELECT id, created_by FROM meta_records/)).toEqual([])
  })

  it('D-13 GET /records/:id: the manual row carries canDelete + manualSupplement; the env-table prefix row is deletable but NOT marked ((a) fails); a PLM row is blocked', async () => {
    const get = (id: string, sheet: FakeSheet) => http().get(`/api/multitable/records/${id}`).query({ sheetId: sheet.sheetId })
    const manual = await get('rec_mrb2_d_manual', PREG)
    expect(manual.status).toBe(200)
    expect(manual.body.data.rowActions).toMatchObject({ canDelete: true, manualSupplement: true })
    const env = await get('rec_mrb2_d_env_own', ENV)
    expect(env.body.data.rowActions.canDelete).toBe(true)
    expect('manualSupplement' in env.body.data.rowActions).toBe(false)
    const plm = await get('rec_mrb2_d_plm', PREG)
    expect(plm.body.data.rowActions).toMatchObject({ canDelete: false, deleteBlockedReason: 'plm_row' })
    expect('manualSupplement' in plm.body.data.rowActions).toBe(false)
  })

  it('D-14 the form context passes the row identity (the manual row is deletable there too) and adds no mark (OQ7: the form is unchanged)', async () => {
    actor = ADMIN
    const manual = await http().get('/api/multitable/form-context').query({ sheetId: PREG.sheetId, recordId: 'rec_mrb2_d_manual' })
    expect(manual.status, JSON.stringify(manual.body).slice(0, 300)).toBe(200)
    expect(manual.body.data.rowActions.canDelete).toBe(true)
    expect('deleteBlockedReason' in manual.body.data.rowActions).toBe(false)
    expect('manualSupplement' in manual.body.data.rowActions).toBe(false)
    const nocreator = await http().get('/api/multitable/form-context').query({ sheetId: PREG.sheetId, recordId: 'rec_mrb2_d_nocreator' })
    expect(nocreator.body.data.rowActions).toMatchObject({ canDelete: false, deleteBlockedReason: 'plm_row' })
  })
})

describe('D — sinks that hand no row identity keep refusing (plugin SDK, automation, exact-anchor reset)', () => {
  const fields = () => PREG.fields
  it('D-15 assertPlmRowDeletable without a row: a manual row is refused; with its identity it passes', async () => {
    const data = fake.records.get('rec_mrb2_d_manual')!.data
    await expect(assertPlmRowDeletable(fake.pool.query as never, PREG.sheetId, fields(), data)).rejects.toBeInstanceOf(PlmRowDeleteRefusedError)
    await expect(assertPlmRowDeletable(fake.pool.query as never, PREG.sheetId, fields(), data, { id: 'rec_mrb2_d_manual', createdBy: 'u_mrb2_person' })).resolves.toBeUndefined()
  })
  it('D-16 the pure rule: the identity exempts only a prefix key with a non-blank creator, on a single-key profile', () => {
    const profile = { kind: 'plm' as const, keyFieldIds: ['k'], projectSheetObjectId: null }
    expect(plmRowDeleteRefusalReason(profile, { k: 'manual:v1:r1' }, { id: 'r1', createdBy: 'u' })).toBeNull()
    expect(plmRowDeleteRefusalReason(profile, { k: 'manual:anything' }, { id: 'r1', createdBy: 'u' })).toBeNull()
    expect(plmRowDeleteRefusalReason(profile, { k: 'manual:v1:r1' }, { id: 'r1', createdBy: null })).toBe('plm_row')
    expect(plmRowDeleteRefusalReason(profile, { k: 'manual:v1:r1' }, { id: 'r1', createdBy: ' \t' })).toBe('plm_row')
    expect(plmRowDeleteRefusalReason(profile, { k: 'manual:v1:r1' })).toBe('plm_row')
    expect(plmRowDeleteRefusalReason(profile, { k: 'MANUAL:v1:r1' }, { id: 'r1', createdBy: 'u' })).toBe('plm_row')
    expect(plmRowDeleteRefusalReason(profile, { k: PLM_KEY }, { id: 'r1', createdBy: 'u' })).toBe('plm_row')
    expect(plmRowDeleteRefusalReason(profile, { k: '' }, { id: 'r1', createdBy: null })).toBeNull()
    expect(plmRowDeleteRefusalReason({ kind: 'plm', keyFieldIds: ['k', 'k2'], projectSheetObjectId: null }, { k: 'manual:v1:r1' }, { id: 'r1', createdBy: 'u' })).toBe('plm_row')
    expect(plmRowDeleteRefusalReason({ kind: 'key_column_missing' }, { k: 'manual:v1:r1' }, { id: 'r1', createdBy: 'u' })).toBe('key_column_missing')
    expect(plmRowDeleteRefusalReason({ kind: 'not_plm' }, { k: PLM_KEY })).toBeNull()
  })
})
