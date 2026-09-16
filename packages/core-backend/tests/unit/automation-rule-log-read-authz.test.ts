/**
 * #5779 — authorization for the rule-addressed automation READS.
 *
 *   GET /api/multitable/sheets/:sheetId/automations/:ruleId/logs
 *   GET /api/multitable/sheets/:sheetId/automations/:ruleId/stats
 *
 * THE GAP: both routes were registered with a single handler and NO middleware. The handler read
 * only `:ruleId` — the `:sheetId` segment was decorative — the log service filters on `rule_id`
 * alone, and `multitable_automation_executions` has no tenant column. The only layer in front was
 * the global session JWT gate, which AUTHENTICATES but does not AUTHORIZE, so any logged-in caller
 * holding a rule id could read another sheet's execution history, including the raw `steps`,
 * `triggerEvent` and `ruleSnapshot` blobs.
 *
 * WHAT THIS SUITE PROVES (and why it is not self-fulfilling): the permission service is NOT mocked.
 * `resolveSheetCapabilities` runs for real against a stubbed pool; the caller's authority comes from
 * the request's own token claims, exactly as in production. The only fakes are the pool (so no DB is
 * needed), the automation service, and the admin guard on the unrelated cross-rule runs route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAutomationRoutes } from '../../src/routes/automation'
import { usePinnedServer } from '../utils/pinned-server'

const poolQuery = vi.hoisted(() => vi.fn())
// NOTE: '../../src/multitable/permission-service' is deliberately NOT mocked.
vi.mock('../../src/integration/db/connection-pool', () => {
  const client = { query: poolQuery, getInternalPool: () => null }
  return { poolManager: { get: () => client } }
})
// The cross-rule runs route (not under test here) mounts an RBAC guard; keep it a pass-through so
// mounting the router costs nothing.
vi.mock('../../src/guards/audit-integration', () => ({
  requireAdminRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}))
// The /test route's sample-record reader pulls the (very large) univer-meta module; this suite never
// touches that route.
vi.mock('../../src/routes/univer-meta', () => ({ requireRecordReadable: vi.fn() }))

/**
 * Token claims of the caller under test. `perms` is the same channel a production JWT uses, and a
 * non-empty list short-circuits the RBAC DB lookup in resolveRequestAccess — so the capability the
 * route sees is derived by the REAL deriveCapabilities() from these codes.
 *   workflow:write   → canManageAutomation = true
 *   multitable:read  → canRead only; canManageAutomation = false
 */
let currentUser: Record<string, unknown> = {}

/** sheetId → deleted_at (null = live). A sheet id absent from this map does not exist at all. */
const sheets = new Map<string, Date | null>()

function buildApp(service: unknown) {
  const app = express()
  app.use(express.json())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((req: any, _res, next) => { req.user = currentUser; next() })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/api/multitable', createAutomationRoutes(service as any))
  return app
}

const SAMPLE_EXECUTION = {
  id: 'exec-1',
  ruleId: 'rule-1',
  sheetId: 'sheet-a',
  triggeredBy: 'event',
  triggeredAt: '2026-09-15T00:00:00.000Z',
  status: 'success',
  // The fields the rule log panel renders (MetaAutomationLogViewer.vue) — these must survive.
  steps: [{ actionType: 'send_notification', status: 'success', durationMs: 12, output: { delivered: 1 } }],
  duration: 12,
  // The two governance blobs that must NOT survive. The markers are fabricated for this fixture —
  // no real value, no credential.
  triggerEvent: { marker: 'TRIGGER-EVENT-MARKER-NOT-A-SECRET' },
  ruleSnapshot: { id: 'rule-1', actions: [{ config: { marker: 'RULE-SNAPSHOT-MARKER-NOT-A-SECRET' } }] },
}

function makeService(rule: { id: string; sheet_id: string } | null) {
  return {
    getRule: vi.fn().mockResolvedValue(rule),
    testRun: vi.fn(),
    logs: {
      getByRule: vi.fn().mockResolvedValue([{ ...SAMPLE_EXECUTION }]),
      getStats: vi.fn().mockResolvedValue({ total: 3, success: 2, failed: 1, skipped: 0, avgDuration: 12 }),
      getById: vi.fn(),
    },
  }
}

const pinned = usePinnedServer()

describe('#5779 — rule-scoped automation log/stat reads are authorized', () => {
  beforeEach(() => {
    poolQuery.mockReset()
    sheets.clear()
    sheets.set('sheet-a', null) // live
    poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      // Sheet liveness — the only row this suite varies.
      if (sql.includes('deleted_at') && sql.includes('meta_sheets')) {
        const id = String(params?.[0] ?? '')
        if (!sheets.has(id)) return { rows: [], rowCount: 0 }
        return { rows: [{ deleted_at: sheets.get(id) }], rowCount: 1 }
      }
      // No per-sheet permission grants, no approval/e-learning projection rows: the caller's authority
      // is exactly what its token carries.
      return { rows: [], rowCount: 0 }
    })
    currentUser = { id: 'u_author', perms: ['workflow:write'] }
  })

  // ── /logs ────────────────────────────────────────────────────────────────

  it('GET /logs → 403 for a caller WITHOUT canManageAutomation, and reads nothing', async () => {
    currentUser = { id: 'u_reader', perms: ['multitable:read'] }
    const svc = makeService({ id: 'rule-1', sheet_id: 'sheet-a' })

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/logs')

    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
    // THE point of the gate: the history was never fetched, and the rule was never probed.
    expect(svc.logs.getByRule).not.toHaveBeenCalled()
    expect(svc.getRule).not.toHaveBeenCalled()
  })

  it('GET /logs → 404 when the rule belongs to ANOTHER sheet, values-free, and reads nothing', async () => {
    // Authorized on sheet-a — and only on sheet-a. The rule is owned by a sheet this caller never
    // passed a capability check for; `getRule(ruleId)` is not sheet-bound, so the route must refuse.
    const svc = makeService({ id: 'rule-1', sheet_id: 'sheet-other' })

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/logs')

    expect(res.status).toBe(404)
    expect(res.body?.error?.code).toBe('NOT_FOUND')
    expect(svc.logs.getByRule).not.toHaveBeenCalled()
    // The refusal must not become an oracle for the owning sheet.
    expect(JSON.stringify(res.body)).not.toContain('sheet-other')
  })

  it('GET /logs → 404 when the rule does not exist at all (same refusal as the cross-sheet case)', async () => {
    const svc = makeService(null)

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/logs')

    expect(res.status).toBe(404)
    expect(res.body?.error?.code).toBe('NOT_FOUND')
    expect(svc.logs.getByRule).not.toHaveBeenCalled()
  })

  it('GET /logs → 404 when the sheet is soft-deleted, even for an authorized caller', async () => {
    sheets.set('sheet-a', new Date('2026-09-01T00:00:00.000Z'))
    const svc = makeService({ id: 'rule-1', sheet_id: 'sheet-a' })

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/logs')

    expect(res.status).toBe(404)
    expect(res.body?.error?.code).toBe('SHEET_DELETED')
    expect(svc.logs.getByRule).not.toHaveBeenCalled()
  })

  it('GET /logs → 200 with the pinned { executions: [...] } shape, WITHOUT ruleSnapshot/triggerEvent', async () => {
    const svc = makeService({ id: 'rule-1', sheet_id: 'sheet-a' })

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/logs')

    expect(res.status).toBe(200)
    // Pinned shape (apps/web/src/multitable/api/client.ts parseJson<{ executions: AutomationExecution[] }>)
    expect(Array.isArray(res.body.executions)).toBe(true)
    expect(res.body.executions).toHaveLength(1)
    expect(res.body.logs).toBeUndefined()
    expect(res.body.data).toBeUndefined()

    const [row] = res.body.executions
    // Everything the rule log panel renders survives, in the LEGACY status vocabulary it filters on.
    expect(row.id).toBe('exec-1')
    expect(row.status).toBe('success')
    expect(row.triggeredBy).toBe('event')
    expect(row.triggeredAt).toBe('2026-09-15T00:00:00.000Z')
    expect(row.duration).toBe(12)
    expect(row.steps[0].actionType).toBe('send_notification')
    expect(row.steps[0].durationMs).toBe(12)

    // …and the two governance blobs do not.
    expect(row).not.toHaveProperty('ruleSnapshot')
    expect(row).not.toHaveProperty('triggerEvent')
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('RULE-SNAPSHOT-MARKER-NOT-A-SECRET')
    expect(serialized).not.toContain('TRIGGER-EVENT-MARKER-NOT-A-SECRET')
  })

  // ── /stats ───────────────────────────────────────────────────────────────

  it('GET /stats → 403 for a caller WITHOUT canManageAutomation, and reads nothing', async () => {
    currentUser = { id: 'u_reader', perms: ['multitable:read'] }
    const svc = makeService({ id: 'rule-1', sheet_id: 'sheet-a' })

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/stats')

    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
    expect(svc.logs.getStats).not.toHaveBeenCalled()
    expect(svc.getRule).not.toHaveBeenCalled()
  })

  it('GET /stats → 404 when the rule belongs to ANOTHER sheet, values-free, and reads nothing', async () => {
    const svc = makeService({ id: 'rule-1', sheet_id: 'sheet-other' })

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/stats')

    expect(res.status).toBe(404)
    expect(res.body?.error?.code).toBe('NOT_FOUND')
    expect(svc.logs.getStats).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body)).not.toContain('sheet-other')
  })

  it('GET /stats → 200 with the pinned flat AutomationStats shape', async () => {
    const svc = makeService({ id: 'rule-1', sheet_id: 'sheet-a' })

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/stats')

    expect(res.status).toBe(200)
    // Flat — client does parseJson<AutomationStats>(res); an envelope would blank the stats bar.
    expect(res.body).toEqual({ total: 3, success: 2, failed: 1, skipped: 0, avgDuration: 12 })
    expect(res.body.data).toBeUndefined()
    expect(svc.logs.getStats).toHaveBeenCalledWith('rule-1')
  })

  // ── fail-closed ──────────────────────────────────────────────────────────

  it('fails CLOSED (values-free) when capability resolution throws — never an ungated read', async () => {
    poolQuery.mockRejectedValue(new Error('Connection terminated to db.internal.host:5432 as user pg_app'))
    const svc = makeService({ id: 'rule-1', sheet_id: 'sheet-a' })

    pinned.setApp(buildApp(svc))
    const res = await request(pinned.url())
      .get('/api/multitable/sheets/sheet-a/automations/rule-1/logs')

    expect(res.status).toBe(503)
    expect(res.body?.error?.code).toBe('DB_NOT_READY')
    expect(JSON.stringify(res.body)).not.toMatch(/db\.internal\.host|5432|pg_app/)
    expect(svc.logs.getByRule).not.toHaveBeenCalled()
  })
})
