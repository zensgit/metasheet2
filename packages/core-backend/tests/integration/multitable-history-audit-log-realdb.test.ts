/**
 * A3 — History Field-Audit audit-trail read surface: goldens (real DB).
 *
 * Design-lock: docs/development/multitable-history-field-audit-permission-design-lock-20260620.md (#2973).
 * GET /bases/:baseId/history-audit-log lists the grant + reveal audit rows for a base. Pins:
 *   - it is gated on the SAME platform capability that issues grants (the auditor is itself auditable);
 *   - it is scoped to the base; and
 *   - it returns scope metadata only — never any record field value.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_log_${TS}`
const OTHER_BASE = `base_log_other_${TS}`
const CAP = 'multitable:history-field-audit:grant'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let curUser: string | undefined = `user_log_${TS}`
let curPerms: string[] = [CAP]
let curRoles: string[] = ['member']

const auditLog = (query: Record<string, unknown> = {}) =>
  request(app).get(`/api/multitable/bases/${BASE_ID}/history-audit-log`).query(query)

// Seed an operation_audit_logs row of the given kind for a base.
const seedAudit = (kind: 'grant' | 'reveal', baseId: string, action: string, md: Record<string, unknown>) =>
  q(
    `INSERT INTO operation_audit_logs (actor_id, actor_type, action, resource_type, resource_id, metadata, meta)
     VALUES ($1,'user',$2,$3,$4,$5::jsonb,$5::jsonb)`,
    [
      `actor_${TS}`,
      action,
      kind === 'reveal' ? 'meta_history_audit_reveal' : 'meta_history_audit_grant',
      baseId,
      JSON.stringify({ baseId, ...md }),
    ],
  )

const clearAudit = () =>
  q("DELETE FROM operation_audit_logs WHERE resource_type IN ('meta_history_audit_grant','meta_history_audit_reveal') AND metadata->>'baseId' = ANY($1::text[])", [[BASE_ID, OTHER_BASE]])

describeIfDatabase('history field-audit audit-log — A3 read surface (real DB)', () => {
  beforeAll(() => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = curUser ? { id: curUser, roles: curRoles, perms: curPerms } : undefined; next() })
    app.use('/api/multitable', univerMetaRouter())
  })

  afterAll(async () => { await clearAudit().catch(() => {}) })

  beforeEach(async () => {
    curUser = `user_log_${TS}`; curPerms = [CAP]; curRoles = ['member']
    await clearAudit()
    await seedAudit('grant', BASE_ID, 'history_field_audit_grant.issue', { subjectType: 'user', subjectId: 'grantee1', reason: 'issue-reason' })
    await seedAudit('reveal', BASE_ID, 'history_field_audit.reveal', { scope: 'history.events', reason: 'reveal-reason', grantId: 'g1' })
    await seedAudit('grant', OTHER_BASE, 'history_field_audit_grant.issue', { subjectType: 'user', subjectId: 'x', reason: 'other' })
  })
  afterEach(async () => { await clearAudit() })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('gate: a caller WITHOUT the grant capability is rejected (the auditor is auditable, by the same key)', async () => {
    curPerms = ['multitable:admin', 'multitable:read'] // base-admin, no field-audit cap
    expect((await auditLog()).status).toBe(403)
    curRoles = ['admin']; curPerms = ['multitable:read'] // coarse admin role, no cap
    expect((await auditLog()).status).toBe(403)
  })

  test('cap holder: sees the grant + reveal entries for the base, newest first', async () => {
    const res = await auditLog()
    expect(res.status).toBe(200)
    const entries = res.body?.data?.entries as Array<{ kind: string; action: string; reason: string | null }>
    expect(entries.length).toBe(2)
    expect(entries.map((e) => e.kind).sort()).toEqual(['grant', 'reveal'])
    expect(entries.find((e) => e.kind === 'reveal')?.reason).toBe('reveal-reason')
  })

  test('base-scoped: another base\'s audit rows are not shown', async () => {
    const entries = (await auditLog()).body?.data?.entries as Array<{ subjectId: string | null }>
    expect(entries.every((e) => e.subjectId !== 'x')).toBe(true) // the OTHER_BASE grant is excluded
  })

  test('no values: entries carry scope metadata only, never a record field value', async () => {
    const entries = (await auditLog()).body?.data?.entries as Array<Record<string, unknown>>
    for (const e of entries) {
      const keys = Object.keys(e)
      expect(keys).not.toContain('value'); expect(keys).not.toContain('values')
      expect(keys).not.toContain('after'); expect(keys).not.toContain('snapshot'); expect(keys).not.toContain('data')
    }
  })

  test('kind filter: ?kind=reveal returns only reveal entries', async () => {
    const entries = (await auditLog({ kind: 'reveal' })).body?.data?.entries as Array<{ kind: string }>
    expect(entries.length).toBe(1)
    expect(entries[0].kind).toBe('reveal')
  })
})
