/**
 * A TUNNELLED DELETE MUST BE FINDABLE IN THE ATTENDANCE AUDIT TRAIL — and one row must describe
 * one verb.
 *
 * `attendanceAuditMiddleware` is mounted ABOVE `methodOverrideMiddleware` (src/index.ts) on purpose:
 * the limiter below it has to see the verb that actually arrived on the wire. The consequence is
 * that the audit row's `action` and `meta.request.method` are captured as `POST` for a tunnelled
 * delete. Refuter finding, CONFIRMED red before the fix:
 *
 *   1. No marker: an investigator querying operation_audit_logs for deletes of attendance data
 *      (shifts, groups, holidays, payroll runs — all of which the web app really deletes) found
 *      NOTHING, because every one of them was recorded as an ordinary POST.
 *   2. Split verb: `operation` was resolved inside `res.on('finish')` from the LIVE `req.method`,
 *      i.e. AFTER the rewrite, while `action`/`method` in the same row came from the wire verb. The
 *      two fields of one row disagreed.
 *
 * DB-free: `../../src/db/pg` is replaced by a spy so the INSERT parameters can be read directly.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn(async () => ({ rows: [] as unknown[] }))
vi.mock('../../src/db/pg', () => ({
  query: (...args: unknown[]) => queryMock(...(args as [])),
  getPool: () => ({}),
}))

import { usePinnedServer } from '../utils/pinned-server'
import { attendanceAuditMiddleware } from '../../src/middleware/attendance-production'
import { methodOverrideMiddleware } from '../../src/middleware/method-override'

const GOOD = 'Bearer good-token'
const SHIFT_PATH = '/api/attendance/shifts/sh_1'
const PUNCH_PATH = '/api/attendance/punch'

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  // Stand-in for the global JWT gate.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization !== GOOD) return res.status(401).json({ ok: false })
    req.user = { id: 'u1', tenantId: 't1' }
    next()
  })
  // REAL relative order, exactly as src/index.ts mounts them.
  app.use(attendanceAuditMiddleware())
  app.use(methodOverrideMiddleware)
  app.delete('/api/attendance/shifts/:id', (_req, res) => { res.json({ ok: true }) })
  app.post(PUNCH_PATH, (_req, res) => { res.json({ ok: true }) })
  app.delete(PUNCH_PATH, (_req, res) => { res.json({ ok: true }) })
  return app
}

const pinned = usePinnedServer()

/** The `meta` jsonb of the single audit INSERT this request produced. */
async function auditMeta(): Promise<Record<string, unknown>> {
  // The insert is awaited inside a `res.on('finish')` handler, so it can land a tick after the
  // response. Poll briefly rather than sleeping a fixed amount.
  for (let i = 0; i < 50 && queryMock.mock.calls.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const inserts = queryMock.mock.calls.filter((call) => String(call[0]).includes('operation_audit_logs'))
  expect(inserts).toHaveLength(1)
  const params = inserts[0][1] as unknown[]
  return { action: params[2], meta: JSON.parse(String(params[11])) }
}

beforeEach(() => {
  queryMock.mockClear()
  pinned.setApp(buildApp())
})

describe('attendance audit row for a tunnelled DELETE', () => {
  it('records the wire verb AND the values-free methodOverride marker, so the delete is findable', async () => {
    const res = await request(pinned.url())
      .post(SHIFT_PATH)
      .set('Authorization', GOOD)
      .set('X-HTTP-Method-Override', 'DELETE')
    expect(res.status).toBe(200)

    const { action, meta } = await auditMeta() as { action: string; meta: Record<string, any> }
    // Unchanged by design: the row keeps the verb that arrived (the limiter's contract).
    expect(action).toBe('attendance_http:POST:/api/attendance/shifts/sh_1')
    expect(meta.request.method).toBe('POST')
    // THE FIX: without this field the row is indistinguishable from an ordinary POST.
    expect(meta.request.methodOverride).toBe('DELETE')
    // Values-free: the marker is a verb name, nothing else is added.
    expect(JSON.stringify(meta)).not.toContain('good-token')
  })

  it('does NOT mark an ordinary POST (the marker discriminates, it is not always-on)', async () => {
    const res = await request(pinned.url()).post(PUNCH_PATH).set('Authorization', GOOD)
    expect(res.status).toBe(200)

    const { meta } = await auditMeta() as { meta: Record<string, any> }
    expect(meta.request.method).toBe('POST')
    expect(meta.request).not.toHaveProperty('methodOverride')
    // Positive control for the label mechanism itself: this route IS labelled for POST.
    expect(meta.operation).toBe('punch')
  })

  it('resolves `operation` from the SAME verb the row claims, not from the rewritten req.method', async () => {
    // POST + override to a route that is labelled for POST and also has a DELETE handler. Before the
    // fix `resolveAttendanceOperation` read the live `req.method` at finish — 'DELETE' — and bucketed
    // this row as 'other' while `action`/`method` in the very same row said POST.
    const res = await request(pinned.url())
      .post(PUNCH_PATH)
      .set('Authorization', GOOD)
      .set('X-HTTP-Method-Override', 'DELETE')
    expect(res.status).toBe(200)

    const { action, meta } = await auditMeta() as { action: string; meta: Record<string, any> }
    expect(action).toBe('attendance_http:POST:/api/attendance/punch')
    expect(meta.request.method).toBe('POST')
    expect(meta.request.methodOverride).toBe('DELETE')
    // One row, one verb: the label agrees with `action` and `meta.request.method`.
    expect(meta.operation).toBe('punch')
  })
})
