/**
 * Cross-base / link referential integrity — dangling-link repair (real DB). `meta_links.foreign_record_id` has
 * NO FK (record_id does: ON DELETE CASCADE), so an inbound edge to a since-deleted record DANGLES and would
 * surface as a GHOST foreign id on read.
 *   (i) repair-on-read: loadLinkValuesByRecord filters edges whose foreign record no longer exists —
 *       and (F21) edges whose foreign record lives in a SOFT-DELETED sheet.
 *   (ii) sheet delete: DELETE /sheets/:id is now a SOFT delete. It keeps the sheet's records and every
 *        inbound edge (so POST /sheets/:id/restore is complete) and relies on (i) to hide them.
 * Goldens: (a) a manually-inserted dangling edge is NOT surfaced as a ghost link id (repair-on-read; RED before);
 * (b) deleting the foreign sheet hides the inbound link from the source while the edge and records survive;
 * (c) restoring the sheet makes the link readable again.
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'
import { prepareSheetLinkDeleteFencePlan } from '../../src/multitable/link-writer-fence'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const ORIGINAL_FLAG = process.env[FLAG]
const TS = Date.now()
const BASE = `base_dl_${TS}`
const SA = `sheet_dl_a_${TS}` // source sheet (has the link field)
const SB = `sheet_dl_b_${TS}` // foreign target sheet (deleted in golden b)
const SC = `sheet_dl_c_${TS}` // configured outbound target of the deleted sheet
const SD = `sheet_dl_d_${TS}` // late inbound participant used by the drift golden
const FLD_LINK = `fld_dl_link_${TS}`
const FLD_B = `fld_dl_b_${TS}`
const FLD_OUT = `fld_dl_out_${TS}`
const FLD_LATE = `fld_dl_late_${TS}`
const RA = `rec_dl_a_${TS}`
const RB = `rec_dl_b_${TS}`
const RD = `rec_dl_d_${TS}`
const GHOST = `rec_dl_ghost_${TS}` // never inserted into meta_records → a dangling foreign_record_id
const U = `u_dl_${TS}`
const TRASH_ROLE = `role_dl_trash_${TS}`
const TRASH_GROUP = randomUUID()
const OTHER_BASE = `${BASE}_other`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const buildApp = (
  permissions: string[] | null = ['multitable:read', 'multitable:write', 'multitable:manage-schema'],
  roles = ['member'],
): Express => {
  const a = express(); a.use(express.json())
  // F21: deleting a sheet now takes SCHEMA authority (`canManageFields` = admin or
  // multitable:manage-schema), not the record-write tier — a write-only operator is refused
  // (pinned in tests/integration/multitable-context.api.test.ts). This suite is about link
  // referential integrity, not about the gate, so its actor holds the schema code.
  a.use((req, _res, next) => { if (permissions) (req as { user?: unknown }).user = { id: U, roles, perms: permissions, permissions }; next() })
  a.use('/api/multitable', univerMetaRouter()); return a
}
const linkValue = async (recId: string): Promise<unknown[]> => {
  const res = await request(buildApp()).get(`/api/multitable/records/${recId}`)
  expect(res.status).toBe(200)
  const v = res.body?.data?.record?.data?.[FLD_LINK]
  return Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : (x as { id?: string })?.id ?? x)) : []
}
const inboundEdgeCount = async (foreignId: string): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_links WHERE foreign_record_id=$1', [foreignId])).rows[0] as { n: number }).n)
// F21: `DELETE /sheets/:id` is now a SOFT delete (`deleted_at`), so the row survives on purpose —
// "deleted" is a deleted_at fact, not an absent row. Every product listing filters the same way.
const sheetIsLive = async (sheetId: string): Promise<boolean> =>
  (await q('SELECT 1 FROM meta_sheets WHERE id=$1 AND deleted_at IS NULL', [sheetId])).rows.length === 1
const sheetRowSurvives = async (sheetId: string): Promise<boolean> =>
  (await q('SELECT 1 FROM meta_sheets WHERE id=$1', [sheetId])).rows.length === 1
const recordCount = async (sheetId: string): Promise<number> =>
  Number(((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id=$1', [sheetId])).rows[0] as { n: number }).n)
const setBlock = (sheetId: string, state: 'applying' | null) =>
  q('UPDATE meta_sheets SET recovery_writer_state=$2 WHERE id=$1', [sheetId, state])
const trash = (app = buildApp(), query: Record<string, string | number> = {}, baseId = BASE) =>
  request(app).get(`/api/multitable/bases/${baseId}/trash`).query(query)
const sheetGrant = (sheetId: string, code: string, subjectType = 'user', subjectId = U) =>
  q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)', [sheetId, subjectType, subjectId, code])
const cleanupTrashFixtures = async () => {
  await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id IN (SELECT id FROM meta_sheets WHERE base_id = ANY($1::text[]))', [[BASE, OTHER_BASE]])
  await q('DELETE FROM spreadsheet_permissions WHERE sheet_id IN (SELECT id FROM meta_sheets WHERE base_id = ANY($1::text[]))', [[BASE, OTHER_BASE]])
  await q('DELETE FROM meta_sheets WHERE base_id = ANY($1::text[]) AND id <> ALL($2::text[])', [[BASE, OTHER_BASE], [SA, SB, SC, SD]])
  await q('DELETE FROM meta_bases WHERE id=$1', [OTHER_BASE])
  await q('DELETE FROM user_roles WHERE role_id=$1', [TRASH_ROLE])
  await q('DELETE FROM roles WHERE id=$1', [TRASH_ROLE])
  await q('DELETE FROM platform_member_group_members WHERE group_id=$1', [TRASH_GROUP])
  await q('DELETE FROM platform_member_groups WHERE id=$1', [TRASH_GROUP])
}

type Client = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  release: () => void
}
const connect = async (): Promise<Client> => {
  const internal = poolManager.get().getInternalPool()
  if (!internal) throw new Error('no internal pool')
  return await internal.connect() as unknown as Client
}
const waitForAdvisoryWaiter = async (blockerPid: number): Promise<void> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await q(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname=current_database()
          AND wait_event_type='Lock'
          AND wait_event='advisory'
          AND $1::int = ANY(pg_blocking_pids(pid))`,
      [blockerPid],
    )
    if (Number((result.rows[0] as { n: number }).n) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('sheet delete did not park on the canonical fence')
}
const settleWhileRowLockHeld = async <T>(promise: Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('sheet delete waited on an unfenced row lock')), 3_000)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })

describeIfDatabase('multitable dangling-link referential integrity (real DB)', () => {
  beforeEach(async () => {
    delete process.env[FLAG]
    await cleanupTrashFixtures()
    const sheets = [SA, SB, SC, SD]
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_LINK, FLD_OUT, FLD_LATE]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id=$1', [BASE]).catch(() => {})
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'DL Base'])
    for (const [sheetId, name] of [[SA, 'DL A'], [SB, 'DL B'], [SC, 'DL C'], [SD, 'DL D']] as const) {
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, BASE, name])
    }
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_B, SB, 'BF', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, SA, 'Link', 'link', JSON.stringify({ foreignSheetId: SB }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_OUT, SB, 'Outbound', 'link', JSON.stringify({ foreignSheetId: SC }), 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LATE, SD, 'Late', 'link', JSON.stringify({ foreignSheetId: SB }), 1])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [U])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [RB, SB, JSON.stringify({ [FLD_B]: 'b-val' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [RA, SA, JSON.stringify({ [FLD_LINK]: [RB] })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [RD, SD, '{}'])
    // authoritative edge RA → RB (meta_links is the source of truth, not data[FLD_LINK])
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_dl_real_${TS}`, FLD_LINK, RA, RB])
  })
  afterAll(async () => {
    if (ORIGINAL_FLAG === undefined) delete process.env[FLAG]
    else process.env[FLAG] = ORIGINAL_FLAG
    await cleanupTrashFixtures()
    const sheets = [SA, SB, SC, SD]
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_LINK, FLD_OUT, FLD_LATE]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheets]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id=$1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id=$1', [U]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  describe('sheet lifecycle trash list', () => {
    const forbidden = { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }
    const empty = { ok: true, data: { sheets: [], nextCursor: null } }
    const deletedAt = '2026-09-14T01:02:03.123456Z'
    const softDelete = (ids: string[]) => q('UPDATE meta_sheets SET deleted_at=$2::timestamptz WHERE id=ANY($1::text[])', [ids, deletedAt])

    test('lists only deleted sheets with an exact DTO, then existing restore preserves records and inbound links', async () => {
      await q('UPDATE meta_sheets SET description=$2 WHERE id=$1', [SB, 'Recoverable sheet'])
      expect((await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)).status).toBe(200)
      await softDelete([SB])
      const response = await trash()
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ ok: true, data: {
        sheets: [{ id: SB, baseId: BASE, name: 'DL B', description: 'Recoverable sheet', deletedAt }], nextCursor: null,
      } })
      expect((await request(buildApp()).post(`/api/multitable/sheets/${SB}/restore`)).status).toBe(200)
      expect((await trash()).body).toEqual(empty)
      expect(await recordCount(SB)).toBe(1)
      expect(await inboundEdgeCount(RB)).toBe(1)
      expect(await linkValue(RA)).toContain(RB)
      expect((await request(buildApp()).post(`/api/multitable/sheets/${SB}/restore`)).status).toBe(404)
    })

    test.each(['multitable:read', 'multitable:write', 'multitable:share'])('%s alone cannot list or enumerate bases', async (code) => {
      await softDelete([SB])
      for (const baseId of [BASE, `${BASE}_missing`]) {
        const response = await trash(buildApp([code]), {}, baseId)
        expect(response.status).toBe(403)
        expect(response.body).toEqual(forbidden)
      }
      expect((await trash()).body.data.sheets.map((sheet: { id: string }) => sheet.id)).toEqual([SB])
    })

    test.each(['spreadsheet:read', 'spreadsheet:write', 'spreadsheet:write-own'])('scoped %s is not lifecycle authority', async (code) => {
      await sheetGrant(SB, code)
      await softDelete([SB])
      const response = await trash(buildApp(['comments:read']))
      expect(response.status).toBe(403)
      expect(response.body).toEqual(forbidden)
      expect((await request(buildApp(['comments:read'])).post(`/api/multitable/sheets/${SB}/restore`)).status).toBe(403)
      expect(await sheetIsLive(SB)).toBe(false)
    })

    test('scoped admin recovers the last sheet but cannot enumerate another base or its hidden tail', async () => {
      await softDelete([SA, SB, SC, SD])
      await sheetGrant(SB, 'spreadsheet:admin')
      await sheetGrant(SC, 'spreadsheet:read')
      const app = buildApp(['comments:read'])
      const response = await trash(app, { limit: 1 })
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ ok: true, data: {
        sheets: [{ id: SB, baseId: BASE, name: 'DL B', description: null, deletedAt }], nextCursor: null,
      } })
      await q('INSERT INTO meta_bases (id,name) VALUES ($1,$2)', [OTHER_BASE, 'Other base'])
      expect((await trash(app, {}, OTHER_BASE)).body).toEqual(forbidden)
      expect((await trash(app, {}, `${BASE}_missing`)).body).toEqual(forbidden)
      expect((await request(app).post(`/api/multitable/sheets/${SB}/restore`)).status).toBe(200)
      expect((await trash(app)).body).toEqual(empty)
      expect((await request(app).post(`/api/multitable/sheets/${SC}/restore`)).status).toBe(403)
    })

    test('direct > group > role grant precedence is identical to restore authority', async () => {
      await softDelete([SA, SB, SC, SD])
      await q('INSERT INTO roles (id,name) VALUES ($1,$2)', [TRASH_ROLE, `Trash role ${TS}`])
      await q('INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)', [U, TRASH_ROLE])
      await q('INSERT INTO platform_member_groups (id,name) VALUES ($1,$2)', [TRASH_GROUP, `Trash group ${TS}`])
      await q('INSERT INTO platform_member_group_members (group_id,user_id) VALUES ($1,$2)', [TRASH_GROUP, U])
      for (const id of [SA, SB, SC, SD]) await sheetGrant(id, 'spreadsheet:admin', 'role', TRASH_ROLE)
      await sheetGrant(SA, 'spreadsheet:read')
      await sheetGrant(SB, 'spreadsheet:read', 'member-group', TRASH_GROUP)
      await sheetGrant(SC, 'spreadsheet:admin', 'member-group', TRASH_GROUP)
      await sheetGrant(SD, '\t\n') // blank direct grants do not override the inherited role
      const app = buildApp(['comments:read'])
      const response = await trash(app)
      expect(response.status).toBe(200)
      expect(response.body.data.sheets.map((sheet: { id: string }) => sheet.id)).toEqual([SC, SD])
      expect(response.body.data.nextCursor).toBeNull()
      for (const id of [SA, SB]) expect((await request(app).post(`/api/multitable/sheets/${id}/restore`)).status).toBe(403)
      expect((await request(app).post(`/api/multitable/sheets/${SC}/restore`)).status).toBe(200)
      expect((await request(app).post(`/api/multitable/sheets/${SD}/restore`)).status).toBe(200)
    })

    test('global schema authority does not bypass a sheet read-deny; role admin retains access', async () => {
      await softDelete([SA, SB])
      await sheetGrant(SA, 'spreadsheet:comment')
      const response = await trash()
      expect(response.status).toBe(200)
      expect(response.body.data.sheets.map((sheet: { id: string }) => sheet.id)).toEqual([SB])
      const admin = await trash(buildApp(['comments:read'], ['admin']))
      expect(admin.status).toBe(200)
      expect(admin.body.data.sheets.map((sheet: { id: string }) => sheet.id)).toEqual([SA, SB])
    })

    test('Unicode trim follows the shared resolver for blank overrides and wrapped admin grants', async () => {
      await softDelete([SA, SB])
      await q('INSERT INTO roles (id,name) VALUES ($1,$2)', [TRASH_ROLE, `Trash role ${TS}`])
      await q('INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)', [U, TRASH_ROLE])
      await sheetGrant(SA, 'spreadsheet:admin', 'role', TRASH_ROLE)
      await sheetGrant(SA, '\uFEFF\u00A0')
      await sheetGrant(SB, '\uFEFF\u2000spreadsheet:admin\u3000')
      const app = buildApp(['comments:read'])
      const response = await trash(app)
      expect(response.status).toBe(200)
      expect(response.body.data.sheets.map((sheet: { id: string }) => sheet.id)).toEqual([SA, SB])
      expect(response.body.data.nextCursor).toBeNull()
      expect((await request(app).post(`/api/multitable/sheets/${SA}/restore`)).status).toBe(200)
      expect((await request(app).post(`/api/multitable/sheets/${SB}/restore`)).status).toBe(200)
    })

    test('Unicode-wrapped legacy People sentinel is excluded before the pagination lookahead', async () => {
      await softDelete([SD])
      await q('INSERT INTO meta_sheets (id,base_id,name,description,deleted_at) VALUES ($1,$2,$3,$4,$5::timestamptz)',
        [`${SD}_people`, BASE, 'Hidden system table', '\uFEFF__metasheet_system:people__\uFEFF', deletedAt])
      const response = await trash(buildApp(['comments:read'], ['admin']), { limit: 1 })
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ ok: true, data: {
        sheets: [{ id: SD, baseId: BASE, name: 'DL D', description: null, deletedAt }], nextCursor: null,
      } })
    })

    test('default 20/max 100 pagination is bounded, keyset-stable and excludes hidden items before LIMIT', async () => {
      const ids = Array.from({ length: 105 }, (_, index) => `${SA}_${String(index).padStart(3, '0')}`)
      for (const id of ids) await q('INSERT INTO meta_sheets (id,base_id,name,deleted_at) VALUES ($1,$2,$3,$4::timestamptz)', [id, BASE, 'Trash sheet', deletedAt])
      await softDelete([SA, SB, SC, SD])
      for (const id of [SA, SB, SC, SD]) await sheetGrant(id, 'spreadsheet:comment')
      await q('INSERT INTO meta_bases (id,name) VALUES ($1,$2)', [OTHER_BASE, 'Other trash base'])
      await q('INSERT INTO meta_sheets (id,base_id,name,deleted_at) VALUES ($1,$2,$3,$4::timestamptz)', [`${SB}_other`, OTHER_BASE, 'Other trash sheet', deletedAt])
      const first = await trash()
      expect(first.status).toBe(200)
      expect(first.body.data.sheets.map((sheet: { id: string }) => sheet.id)).toEqual(ids.slice(0, 20))
      expect(typeof first.body.data.nextCursor).toBe('string')
      await q('UPDATE meta_sheets SET deleted_at=NULL WHERE id=$1', [ids[19]])
      const second = await trash(buildApp(), { limit: 100, cursor: first.body.data.nextCursor })
      expect(second.status).toBe(200)
      expect(second.body.data.sheets.map((sheet: { id: string }) => sheet.id)).toEqual(ids.slice(20))
      expect(second.body.data.nextCursor).toBeNull()
      const maximum = await trash(buildApp(), { limit: 100 })
      expect(maximum.body.data.sheets).toHaveLength(100)
      const final = await trash(buildApp(), { limit: 100, cursor: maximum.body.data.nextCursor })
      expect(final.body.data.sheets.map((sheet: { id: string }) => sheet.id)).toEqual(ids.slice(101))
      expect(final.body.data.nextCursor).toBeNull()
      const other = await trash(buildApp(), {}, OTHER_BASE)
      expect(other.status).toBe(200)
      expect(other.body).toEqual({ ok: true, data: {
        sheets: [{ id: `${SB}_other`, baseId: OTHER_BASE, name: 'Other trash sheet', description: null, deletedAt }], nextCursor: null,
      } })
    })

    test('rejects malformed limits/cursors and cross-base cursor replay with values-free errors', async () => {
      await softDelete([SA, SB])
      const cursor = (await trash(buildApp(), { limit: 1 })).body.data.nextCursor
      const invalid = [
        { limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: '2junk' },
        { limit: '-1' }, { cursor: '' }, { cursor: 'not_json' },
        { cursor: Buffer.from(JSON.stringify([1, OTHER_BASE, SA])).toString('base64url') },
      ]
      for (const query of invalid) {
        const response = await trash(buildApp(), query)
        expect(response.status).toBe(400)
        expect(response.body).toEqual({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid trash pagination' } })
      }
      expect((await trash(buildApp(), { cursor }, OTHER_BASE)).status).toBe(400)
      expect((await trash(buildApp(null))).status).toBe(401)
    })

    test('owner alone has no lifecycle authority; authorized empty bases work and soft-deleted bases stay hidden', async () => {
      await q('INSERT INTO meta_bases (id,name,owner_id) VALUES ($1,$2,$3)', [OTHER_BASE, 'Empty base', U])
      expect((await trash(buildApp(['comments:read']), {}, OTHER_BASE)).body).toEqual(forbidden)
      const ownerSchema = await trash(buildApp(['multitable:manage-schema']), {}, OTHER_BASE)
      expect(ownerSchema.status).toBe(200)
      expect(ownerSchema.body).toEqual(empty)
      expect((await trash(buildApp(['comments:read'], ['admin']), {}, OTHER_BASE)).body).toEqual(empty)
      await q('UPDATE meta_bases SET deleted_at=now() WHERE id=$1', [OTHER_BASE])
      const deleted = await trash(buildApp(['comments:read'], ['admin']), {}, OTHER_BASE)
      expect(deleted.status).toBe(403)
      expect(deleted.body).toEqual(forbidden)
    })

    test('People/system/plugin-managed sheets never enter the bin, including for role admin', async () => {
      await softDelete([SA, SB, SC, SD])
      await q('UPDATE meta_sheets SET description=$2 WHERE id=$1', [SA, '\t__metasheet_system:people__\n'])
      await q('UPDATE meta_sheets SET system_kind=$2 WHERE id=$1', [SB, 'approval_projection'])
      await q('INSERT INTO plugin_multitable_object_registry (sheet_id,project_id,object_id,plugin_name) VALUES ($1,$2,$3,$4)', [SC, `p_dl_${TS}`, `o_dl_${TS}`, 'plugin-integration-core'])
      await q('INSERT INTO meta_sheets (id,base_id,name,deleted_at) VALUES ($1,$2,$3,$4::timestamptz)', [`sht_el_stats_${TRASH_GROUP.replaceAll('-', '')}`, BASE, 'Legacy org projection', deletedAt])
      const response = await trash(buildApp(['comments:read'], ['admin']))
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ ok: true, data: {
        sheets: [{ id: SD, baseId: BASE, name: 'DL D', description: null, deletedAt }], nextCursor: null,
      } })
      await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id=$1', [SC])
    })

    test.each(['base_apr_projection', 'base_el_stats_' + 'a'.repeat(32), 'base_el_stats_' + 'b'.repeat(32)])('projection base %s is not admitted by the user bin', async (baseId) => {
      await softDelete([SB])
      const response = await trash(buildApp(['comments:read'], ['admin']), {}, baseId)
      expect(response.status).toBe(403)
      expect(response.body).toEqual(forbidden)
      expect((await trash()).body.data.sheets.map((sheet: { id: string }) => sheet.id)).toEqual([SB])
    })
  })

  test('sheet-delete plan is query-inert while the writer fence is off', async () => {
    let queries = 0
    const plan = await prepareSheetLinkDeleteFencePlan(async () => {
      queries += 1
      return { rows: [] }
    }, SB)
    expect(plan).toBeNull()
    expect(queries).toBe(0)
  })

  test('(a) repair-on-read: a dangling inbound edge (foreign record never existed) is NOT surfaced as a ghost link id', async () => {
    // foreign_record_id has no FK → a dangling edge is insertable; it must be filtered on read.
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_dl_ghost_${TS}`, FLD_LINK, RA, GHOST])
    const v = await linkValue(RA)
    expect(v).toContain(RB) // the real linked record still surfaces
    expect(v).not.toContain(GHOST) // the dangling edge is filtered (RED before the repair-on-read fix)
  })

  // F21 — this golden's MECHANISM changed deliberately; its OBSERVABLE contract did not.
  //
  // Before: the delete destroyed the sheet's records, so the inbound edge had to be destroyed too
  // (`foreign_record_id` carries no FK) or it would dangle and surface as a ghost.
  // Now: the delete is SOFT, so nothing is destroyed and there is nothing to dangle. The edge is KEPT
  // on purpose — that is what makes `POST /sheets/:sheetId/restore` complete — and the READ path hides
  // it instead (repair-on-read now also requires the foreign record's sheet to be live).
  //
  // So the assertion that MATTERS — "the source reads no ghost" — is unchanged and still enforced.
  // The row-level assertion is inverted, and its inversion is the recoverability guarantee.
  test('(b) sheet delete: the source reads no link into a deleted sheet, and the edge + records survive for a restore', async () => {
    expect(await inboundEdgeCount(RB)).toBe(1) // RA → RB edge exists pre-delete
    expect(await linkValue(RA)).toContain(RB) // ... and it is visible pre-delete (this leg is not vacuous)
    const del = await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)
    expect(del.status).toBe(200)
    expect(await linkValue(RA)).not.toContain(RB) // the source shows no link into the deleted sheet
    expect(await inboundEdgeCount(RB)).toBe(1) // the edge SURVIVES (soft delete — restorable)
    expect(await recordCount(SB)).toBeGreaterThan(0) // the records survive too
    expect(await sheetRowSurvives(SB)).toBe(true)
    expect(await sheetIsLive(SB)).toBe(false)
  })

  test('restore brings the sheet, its records and its inbound links back', async () => {
    expect((await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)).status).toBe(200)
    expect(await sheetIsLive(SB)).toBe(false)
    expect(await linkValue(RA)).not.toContain(RB)

    const restore = await request(buildApp()).post(`/api/multitable/sheets/${SB}/restore`)
    expect(restore.status).toBe(200)
    expect(restore.body.data.restored).toBe(SB)
    expect(await sheetIsLive(SB)).toBe(true)
    expect(await inboundEdgeCount(RB)).toBe(1)
    expect(await linkValue(RA)).toContain(RB) // the link is readable again — the restore is complete

    // Restoring a live sheet is not a no-op success: there is nothing to restore.
    const again = await request(buildApp()).post(`/api/multitable/sheets/${SB}/restore`)
    expect(again.status).toBe(404)
    expect(again.body.error.code).toBe('NOT_FOUND')
  })

  test('writer-fence ON preserves the successful sheet-delete contract when every participant is available', async () => {
    process.env[FLAG] = 'true'
    const response = await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, data: { deleted: SB } })
    expect(await sheetIsLive(SB)).toBe(false)
    // Soft delete: the edge is retained for the restore; the read path is what hides it.
    expect(await inboundEdgeCount(RB)).toBe(1)
    expect(await linkValue(RA)).not.toContain(RB)
  })

  test('sheet delete refuses a blocked inbound source before deleting the target or its edge', async () => {
    process.env[FLAG] = 'true'
    await setBlock(SA, 'applying')
    const response = await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'RECOVERY_IN_PROGRESS',
        message: 'Another recovery operation is in progress on this sheet; retry shortly.',
      },
    })
    expect(JSON.stringify(response.body)).not.toContain(SA)
    expect(JSON.stringify(response.body)).not.toContain(SB)
    expect(await sheetIsLive(SB)).toBe(true)
    expect(await inboundEdgeCount(RB)).toBe(1)
  })

  test('sheet delete refuses a blocked configured outbound target even when no edge exists yet', async () => {
    process.env[FLAG] = 'true'
    await setBlock(SC, 'applying')
    const response = await request(buildApp()).delete(`/api/multitable/sheets/${SB}`)
    expect(response.status).toBe(409)
    expect(response.body.error).toEqual({
      code: 'RECOVERY_IN_PROGRESS',
      message: 'Another recovery operation is in progress on this sheet; retry shortly.',
    })
    expect(await sheetIsLive(SB)).toBe(true)
    expect(await inboundEdgeCount(RB)).toBe(1)
  })

  test('sheet delete refuses its own durable block even when the sheet has no links', async () => {
    process.env[FLAG] = 'true'
    await setBlock(SC, 'applying')
    const response = await request(buildApp()).delete(`/api/multitable/sheets/${SC}`)
    expect(response.status).toBe(409)
    expect(response.body.error).toEqual({
      code: 'RECOVERY_IN_PROGRESS',
      message: 'Another recovery operation is in progress on this sheet; retry shortly.',
    })
    expect(await sheetIsLive(SC)).toBe(true)
  })

  test('sheet delete fails closed instead of waiting behind a concurrent sheet-row owner', async () => {
    process.env[FLAG] = 'true'
    const blocker = await connect()
    let responsePromise: ReturnType<typeof request> | null = null
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM meta_sheets WHERE id=$1 FOR UPDATE', [SB])
      responsePromise = request(buildApp()).delete(`/api/multitable/sheets/${SB}`)
      const response = await settleWhileRowLockHeld(responsePromise)
      expect(response.status).toBe(409)
      expect(response.body.error).toEqual({
        code: 'LINK_WRITER_FENCE_PLAN_CHANGED',
        message: 'Sheet link participants changed concurrently; retry the write',
      })
      expect(await sheetIsLive(SB)).toBe(true)
      expect(await inboundEdgeCount(RB)).toBe(1)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
      if (responsePromise) await responsePromise.catch(() => {})
    }
  })

  test('sheet delete rejects a newly committed inbound participant before any destruction', async () => {
    process.env[FLAG] = 'true'
    const blocker = await connect()
    try {
      await blocker.query('BEGIN')
      const blockerPid = Number(((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(SB)])

      const responsePromise = request(buildApp())
        .delete(`/api/multitable/sheets/${SB}`)
        .then((response) => response)
      await waitForAdvisoryWaiter(blockerPid)
      await q(
        'INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
        [`lnk_dl_late_${TS}`, FLD_LATE, RD, RB],
      )
      await blocker.query('COMMIT')

      const response = await responsePromise
      expect(response.status).toBe(409)
      expect(response.body.error).toEqual({
        code: 'LINK_WRITER_FENCE_PLAN_CHANGED',
        message: 'Sheet link participants changed concurrently; retry the write',
      })
      expect(JSON.stringify(response.body)).not.toContain(SB)
      expect(JSON.stringify(response.body)).not.toContain(SD)
      expect(await sheetIsLive(SB)).toBe(true)
      expect(await inboundEdgeCount(RB)).toBe(2)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })
})
