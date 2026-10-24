import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { usePinnedServer } from '../utils/pinned-server'

const pinned = usePinnedServer()
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: { user?: { id: string }; apiTokenId?: string }, _res: unknown, next: () => void) => {
    req.user = { id: 'owner' }
    next()
  },
}))

import { createPlmCollaborationSnapshotsRouter } from '../../src/routes/plm-collaboration-snapshots'
import {
  EcoCollaborationSnapshotError,
  EcoCollaborationSnapshotService,
} from '../../src/multitable/plm-collaboration-snapshot-service'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function app(
  before?: express.RequestHandler,
  pool: { transaction: (...args: any[]) => any } = { transaction: vi.fn() },
) {
  const server = express()
  server.use(express.json())
  if (before) server.use(before)
  server.use('/api/plm-collaboration-snapshots', createPlmCollaborationSnapshotsRouter({
    pool,
    dataSourceManager: {} as never,
  }))
  pinned.setApp(server)
  return pool
}

const readinessBindingId = '11111111-1111-4111-8111-111111111111'

function normalizeSelectorSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

// Exact readonly authority statements issued for an authorized foreign readiness
// selector after authorizeSheet. Whitespace is collapsed. Any other statement throws.
const SELECTOR_AUTHORITY_READS: ReadonlyArray<readonly [string, 'base' | 'sheet' | 'role' | 'empty']> = [
  ['SELECT id FROM meta_bases WHERE id = $1 FOR SHARE', 'base'],
  ['SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE', 'sheet'],
  ['SELECT role_id FROM user_roles WHERE user_id = $1 FOR SHARE', 'role'],
  ['SELECT id, name FROM roles WHERE id = ANY($1::text[]) FOR SHARE', 'empty'],
  ['SELECT role_id, permission_code FROM role_permissions WHERE role_id = ANY($1::text[]) FOR SHARE', 'empty'],
  ['SELECT permission_code FROM user_permissions WHERE user_id = $1 FOR SHARE', 'empty'],
  ['SAVEPOINT record_link_actor_groups', 'empty'],
  ['SELECT group_id FROM platform_member_group_members WHERE user_id = $1 FOR SHARE', 'empty'],
  ['RELEASE SAVEPOINT record_link_actor_groups', 'empty'],
  ["SELECT sheet_id FROM spreadsheet_permissions WHERE sheet_id = $1 AND ( (subject_type = 'user' AND subject_id = $2) OR (subject_type = 'role' AND subject_id = ANY($3::text[])) OR (subject_type = 'member-group' AND subject_id = ANY($4::text[])) ) FOR SHARE", 'empty'],
  ['SELECT DISTINCT permission_code AS code FROM ( SELECT up.permission_code FROM user_permissions up WHERE up.user_id = $1 UNION ALL SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1 ) t', 'empty'],
  ["SELECT sp.sheet_id, sp.perm_code, sp.subject_type FROM spreadsheet_permissions sp WHERE sp.sheet_id = ANY($2::text[]) AND ( (sp.subject_type = 'user' AND sp.subject_id = $1) OR ( sp.subject_type = 'member-group' AND EXISTS ( SELECT 1 FROM platform_member_group_members pgm WHERE pgm.user_id = $1 AND pgm.group_id::text = sp.subject_id ) ) OR ( sp.subject_type = 'role' AND EXISTS ( SELECT 1 FROM user_roles ur WHERE ur.user_id = $1 AND ur.role_id = sp.subject_id ) ) )", 'empty'],
]

function selectorAuthorityAnswer(
  sql: string,
  binding: { base_id: string; sheet_id: string },
): { rows: unknown[]; rowCount: number } | null {
  const kind = SELECTOR_AUTHORITY_READS.find(([statement]) => statement === normalizeSelectorSql(sql))?.[1]
  if (!kind) return null
  if (kind === 'base') return { rows: [{ id: binding.base_id }], rowCount: 1 }
  if (kind === 'sheet') return { rows: [{ id: binding.sheet_id }], rowCount: 1 }
  if (kind === 'role') return { rows: [{ role_id: 'admin' }], rowCount: 1 }
  return { rows: [], rowCount: 0 }
}

function selectorPool(sqlLog: string[]) {
  const binding = {
    id: readinessBindingId,
    creator_id: 'owner',
    data_source_id: 'source-b',
    source_kind: 'readiness',
    native_tenant_id: 'tenant-w23',
    native_org_id: 'org-w23',
    item_id: 'item-root',
    current_version_id: null,
    source_fingerprint: 'fp-1',
    base_id: 'base-w23',
    sheet_id: 'sheet-w23',
    view_id: 'view-w23',
    name: 'Readiness',
    source_fields: { item_id: 'fld_item_id' },
    local_fields: { collaboration_owner: 'fld_owner' },
    version: 2,
    status: 'active',
    last_failure_code: null,
    last_failure_at: null,
  }
  return {
    transaction: vi.fn(async (fn: (tx: { query: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }> }) => Promise<unknown>) => fn({
      query: async (sql: string) => {
        sqlLog.push(sql)
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
        if (sql.includes('to_regclass') || sql.includes('meta_plm_collaboration_readiness_request_id')) {
          return { rows: [{ ready: true }], rowCount: 1 }
        }
        if (sql.includes('FROM users')) {
          return {
            rows: [{ is_active: true, role: 'member', activation_status: 'activated', local_password_set: true }],
            rowCount: 1,
          }
        }
        if (sql.includes('FROM meta_plm_collaboration_bindings')) return { rows: [binding], rowCount: 1 }
        if (normalizeSelectorSql(sql) === 'SELECT s.id FROM meta_sheets s JOIN meta_bases b ON b.id=s.base_id WHERE s.id=$1 AND s.base_id=$2 AND s.deleted_at IS NULL AND b.deleted_at IS NULL') return { rows: [{ id: binding.sheet_id }], rowCount: 1 }
        if (normalizeSelectorSql(sql) === 'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1') return { rows: [{ ok: 1 }], rowCount: 1 }
        const authority = selectorAuthorityAnswer(sql, binding)
        if (authority) return authority
        throw new Error(`selector query continued past the refusal: ${normalizeSelectorSql(sql)}`)
      },
    })),
  }
}

const token = jwt.sign({ userId: 'owner' }, 'synthetic')

describe('ECO collaboration snapshot routes', () => {
  it.each([
    undefined,
    'mst_token',
    jwt.sign({ userId: 'owner', type: 'invite' }, 'synthetic'),
    jwt.sign({ userId: 'owner', aud: 'embed' }, 'synthetic'),
    jwt.sign({ userId: 'owner', typ: 'access' }, 'synthetic'),
  ])('rejects a non-login bearer before the service (%s)', async (bearer) => {
    app()
    const spy = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'preview')
    let req = request(pinned.url()).post('/api/plm-collaboration-snapshots/preview')
    if (bearer) req = req.set('Authorization', `Bearer ${bearer}`)
    const response = await req.send({ sourceKind: 'eco' })
    expect(response.status).toBe(401)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({ ok: false, error: { code: 'UNAUTHORIZED' } })
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects an api token before the service', async () => {
    app((req, _res, next) => {
      ;(req as express.Request & { apiTokenId?: string }).apiTokenId = 'mst_1'
      next()
    })
    const spy = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'get')
    const response = await request(pinned.url())
      .get(`/api/plm-collaboration-snapshots/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('UNAUTHORIZED')
    expect(spy).not.toHaveBeenCalled()
  })

  it('uses the authenticated actor for preview and confirm and returns no-store', async () => {
    app()
    const preview = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'preview').mockResolvedValue({ previewId: 'p' } as never)
    const confirm = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'confirm').mockResolvedValue({ bindingId: 'b' } as never)
    const body = { sourceKind: 'eco', dataSourceId: 'ds' }
    const created = await request(pinned.url())
      .post('/api/plm-collaboration-snapshots/preview')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
    expect(created.status).toBe(200)
    expect(created.headers['cache-control']).toBe('no-store')
    expect(created.body).toEqual({ ok: true, data: { previewId: 'p' } })
    expect(preview).toHaveBeenCalledWith('owner', body)
    const confirmed = await request(pinned.url())
      .post('/api/plm-collaboration-snapshots/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ previewId: 'p' })
    expect(confirmed.body).toEqual({ ok: true, data: { bindingId: 'b' } })
    expect(confirm).toHaveBeenCalledWith('owner', { previewId: 'p' })
  })

  it('routes retained read, refresh, and disable without a review flag', async () => {
    const route = readFileSync(new URL('../../src/routes/plm-collaboration-snapshots.ts', import.meta.url), 'utf8')
    const mount = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
    expect(route).not.toContain('requireBomReview')
    expect(route).not.toContain('PLM_BOM_REVIEW_ENABLED')
    expect(mount).toContain("this.app.use('/api/plm-collaboration-snapshots', createPlmCollaborationSnapshotsRouter({")
    const mounted = mount.slice(mount.indexOf('const plmEnabled'), mount.indexOf('PLM workbench is disabled'))
    expect(mounted.indexOf('/api/plm-collaboration-snapshots')).toBeLessThan(mounted.indexOf('PLM_BOM_REVIEW_ENABLED'))
    app()
    const id = crypto.randomUUID()
    const read = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'get').mockResolvedValue({ id } as never)
    const refresh = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'refresh').mockResolvedValue({ id } as never)
    const disable = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'disable').mockResolvedValue({ id, status: 'disabled' } as never)
    const got = await request(pinned.url())
      .get(`/api/plm-collaboration-snapshots/${id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(got.status).toBe(200)
    expect(got.headers['cache-control']).toBe('no-store')
    expect(read).toHaveBeenCalledWith('owner', id, {})
    await request(pinned.url())
      .post(`/api/plm-collaboration-snapshots/${id}/refresh`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedVersion: 1, rowKey: ['a', 'b', 'c', 'd'] })
      .expect(200)
    expect(refresh).toHaveBeenCalledWith('owner', id, { expectedVersion: 1, rowKey: ['a', 'b', 'c', 'd'] })
    const stopped = await request(pinned.url())
      .post(`/api/plm-collaboration-snapshots/${id}/disable`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedVersion: 2 })
    expect(stopped.body.data).toEqual({ id, status: 'disabled' })
    expect(disable).toHaveBeenCalledWith('owner', id, { expectedVersion: 2 })
  })

  it('returns only the service code and no-store on failure', async () => {
    app()
    vi.spyOn(EcoCollaborationSnapshotService.prototype, 'preview').mockRejectedValue(
      new EcoCollaborationSnapshotError(403, 'ECO_SOURCE_MANAGED'),
    )
    const response = await request(pinned.url())
      .post('/api/plm-collaboration-snapshots/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(response.status).toBe(403)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({ ok: false, error: { code: 'ECO_SOURCE_MANAGED' } })
    expect(JSON.stringify(response.body)).not.toContain('stack')
  })

  it('passes one decoded readiness rowKey and keeps no-store', async () => {
    app()
    const id = crypto.randomUUID()
    const read = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'get').mockResolvedValue({ id } as never)
    const key = JSON.stringify(['source-b', 'tenant-w23', 'org-w23', 'item-root', 'ruleset-root'])
    const got = await request(pinned.url())
      .get(`/api/plm-collaboration-snapshots/${id}?rowKey=${encodeURIComponent(key)}`)
      .set('Authorization', `Bearer ${token}`)
    expect(got.status).toBe(200)
    expect(got.headers['cache-control']).toBe('no-store')
    expect(read).toHaveBeenCalledWith('owner', id, { rowKey: key })
  })

  it('keeps a readiness wire rejection and does not open a transaction', async () => {
    const pool = app()
    const response = await request(pinned.url())
      .post('/api/plm-collaboration-snapshots/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceKind: 'readiness',
        dataSourceId: ' ',
        baseId: 'base-w23',
        itemId: 'item-root',
        rulesetId: 'ruleset-root',
        currentVersionId: null,
        name: 'Readiness',
      })
    expect(response.status).toBe(422)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({ ok: false, error: { code: 'READINESS_SOURCE_INPUT_INVALID' } })
    expect(pool.transaction).not.toHaveBeenCalled()
  })

  it('rejects an extra refresh sourceKind before any query and a wrong-width key after the binding', async () => {
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const pool = app()
    const id = crypto.randomUUID()
    const extraKind = await request(pinned.url())
      .post(`/api/plm-collaboration-snapshots/${id}/refresh`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceKind: 'readiness',
        expectedVersion: 3,
        rowKey: ['source-b', 'tenant-w23', 'org-w23', 'item-root', 'ruleset-root'],
      })
    expect(extraKind.status).toBe(422)
    expect(extraKind.headers['cache-control']).toBe('no-store')
    expect(extraKind.body).toEqual({ ok: false, error: { code: 'ECO_REQUEST_INVALID' } })
    expect(pool.transaction).not.toHaveBeenCalled()

    const sql: string[] = []
    app(undefined, selectorPool(sql))
    const four = await request(pinned.url())
      .post(`/api/plm-collaboration-snapshots/${readinessBindingId}/refresh`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedVersion: 3, rowKey: ['source-b', 'tenant-w23', 'org-w23', 'item-root'] })
    expect(four.status).toBe(422)
    expect(four.body).toEqual({ ok: false, error: { code: 'ECO_REQUEST_INVALID' } })
    const foreign = await request(pinned.url())
      .post(`/api/plm-collaboration-snapshots/${readinessBindingId}/refresh`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        expectedVersion: 3,
        rowKey: ['other-source', 'tenant-w23', 'org-w23', 'item-root', 'ruleset-root'],
      })
    expect(foreign.status).toBe(409)
    expect(foreign.headers['cache-control']).toBe('no-store')
    expect(foreign.body).toEqual({ ok: false, error: { code: 'ROW_KEY_MISMATCH' } })
    expect(sql.some((statement) => statement.includes('ORDER BY record_id LIMIT 1'))).toBe(false)
  })

  it('returns 422 or 409 for a readiness selector and does not read an arbitrary row', async () => {
    const sql: string[] = []
    app(undefined, selectorPool(sql))
    const repeated = await request(pinned.url())
      .get(`/api/plm-collaboration-snapshots/${readinessBindingId}?rowKey=a&rowKey=b`)
      .set('Authorization', `Bearer ${token}`)
    expect(repeated.status).toBe(422)
    expect(repeated.headers['cache-control']).toBe('no-store')
    expect(repeated.body).toEqual({ ok: false, error: { code: 'ECO_REQUEST_INVALID' } })
    const four = await request(pinned.url())
      .get(`/api/plm-collaboration-snapshots/${readinessBindingId}?rowKey=${encodeURIComponent(JSON.stringify(['a', 'b', 'c', 'd']))}`)
      .set('Authorization', `Bearer ${token}`)
    expect(four.status).toBe(422)
    expect(four.body.error.code).toBe('ECO_REQUEST_INVALID')
    const beforeForeign = sql.length
    const foreign = await request(pinned.url())
      .get(`/api/plm-collaboration-snapshots/${readinessBindingId}?rowKey=${encodeURIComponent(JSON.stringify(['other-source', 'tenant-w23', 'org-w23', 'item-root', 'ruleset-root']))}`)
      .set('Authorization', `Bearer ${token}`)
    expect(foreign.status, sql.slice(beforeForeign).map(normalizeSelectorSql).join('\n')).toBe(409)
    expect(sql.slice(beforeForeign).some((statement) => statement.includes('role_id = $2'))).toBe(true)
    expect(foreign.headers['cache-control']).toBe('no-store')
    expect(foreign.body).toEqual({ ok: false, error: { code: 'ROW_KEY_MISMATCH' } })
    const named = await request(pinned.url())
      .get(`/api/plm-collaboration-snapshots/${readinessBindingId}?sourceKind=readiness`)
      .set('Authorization', `Bearer ${token}`)
    expect(named.status).toBe(422)
    expect(named.headers['cache-control']).toBe('no-store')
    expect(named.body).toEqual({ ok: false, error: { code: 'ECO_REQUEST_INVALID' } })
    const namedWithKey = await request(pinned.url())
      .get(`/api/plm-collaboration-snapshots/${readinessBindingId}?rowKey=${encodeURIComponent(JSON.stringify(['source-b', 'tenant-w23', 'org-w23', 'item-root', 'ruleset-root']))}&sourceKind=readiness`)
      .set('Authorization', `Bearer ${token}`)
    expect(namedWithKey.status).toBe(422)
    expect(namedWithKey.body).toEqual({ ok: false, error: { code: 'ECO_REQUEST_INVALID' } })
    expect(sql.some((statement) => statement.includes('ORDER BY record_id LIMIT 1'))).toBe(false)
    expect(sql.some((statement) => statement.includes('meta_plm_collaboration_readiness_request_id'))).toBe(true)
  })

  it('refuses unknown selector statements even when they resemble authority reads', async () => {
    for (const statement of [
      'SELECT root_fixture_unknown_query()',
      'SELECT root_fixture_unknown_query() FROM meta_sheets s JOIN meta_bases b ON b.id=s.base_id',
      'SELECT root_fixture_unknown_query() FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1',
    ]) {
      await expect(selectorPool([]).transaction(({ query }) => query(statement)))
        .rejects.toThrow('selector query continued past the refusal')
    }
  })

  it('maps an unknown failure to runtime unavailable', async () => {
    app()
    vi.spyOn(EcoCollaborationSnapshotService.prototype, 'preview').mockRejectedValue(new Error('boom'))
    const response = await request(pinned.url())
      .post('/api/plm-collaboration-snapshots/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceKind: 'eco' })
    expect(response.status).toBe(503)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({ ok: false, error: { code: 'ECO_RUNTIME_UNAVAILABLE' } })
  })
})
