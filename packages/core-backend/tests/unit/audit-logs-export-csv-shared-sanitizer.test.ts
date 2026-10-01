/**
 * CSV shared-sanitizer migration (owner-scoped hygiene slice, chore/csv-shared-sanitizer).
 *
 * GET /api/audit-logs?format=csv used to hand-roll its own per-cell escape. This asserts the
 * migrated output against the shared `csv-cell.ts` sanitizer (`sanitizeCsvRow`) it now delegates
 * to, on TWO axes:
 *
 *   1. Byte-for-byte parity for plain/RFC-4180-special cells — column order, the static header
 *      line, and the '\n' row terminator are unchanged from the pre-migration hand-rolled escape.
 *   2. Positive controls for the two INTENTIONAL additions the shared helper brings to this
 *      endpoint: (a) a cell starting with a formula-injection lead character now gets a
 *      defensive leading apostrophe, and (b) a cell containing a bare CR (no LF) is now RFC-4180
 *      quoted the same way a CR+LF pair already was.
 *
 * `occurred_at` (P1-2 audit, csv-helper gate): `operation_audit_logs.occurred_at` is TIMESTAMPTZ
 * NOT NULL (`zzzz20260209100000_fix_operation_audit_logs_schema.ts:17,31`), so pg hands this a
 * real `Date` at runtime, not a string. The fixtures below use `new Date(...)` — a real runtime
 * Date, not a string stand-in — to exercise the actual shape. This endpoint's
 * `r.occurred_at.toISOString?.() || r.occurred_at` conversion (unchanged by this migration; it
 * runs BEFORE `sanitizeCsvRow` sees the value either way) already produces a clean ISO string for
 * a real Date, so — unlike `admin-users.ts` (P1-2) — there is no Date-shape regression here; these
 * fixtures pin that this endpoint stays correct rather than merely convenient-to-mock.
 */
import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const poolMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  pool: { query: poolMocks.query },
}))

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

import { auditLogsRouter } from '../../src/routes/audit-logs'

function makeApp() {
  const app = express()
  app.use(auditLogsRouter())
  return app
}

const pinned = usePinnedServer()

describe('GET /api/audit-logs?format=csv — shared csv-cell.ts sanitizer migration', () => {
  beforeEach(() => {
    poolMocks.query.mockReset()
    pinned.setApp(makeApp())
  })

  it('produces byte-identical output for plain and RFC-4180-special cells', async () => {
    poolMocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          occurred_at: new Date('2026-01-01T00:00:00.000Z'),
          actor_id: 'user-1',
          actor_type: 'user',
          action: 'create',
          resource_type: 'doc',
          resource_id: 'doc-1',
          request_id: 'req-1',
          ip: '127.0.0.1',
          user_agent: 'UA, with "quote"',
          meta: { a: 1 },
        },
      ],
    })

    const response = await request(pinned.url()).get('/api/audit-logs').query({ format: 'csv' })

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.text).toBe(
      [
        'id,occurred_at,actor_id,actor_type,action,resource_type,resource_id,request_id,ip,user_agent,meta',
        '1,2026-01-01T00:00:00.000Z,user-1,user,create,doc,doc-1,req-1,127.0.0.1,"UA, with ""quote""","{""a"":1}"',
        '',
      ].join('\n'),
    )
  })

  it('positive control: neutralizes formula-injection lead chars and correctly quotes a bare CR', async () => {
    poolMocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 2,
          occurred_at: new Date('2026-01-02T00:00:00.000Z'),
          actor_id: 'user-2',
          actor_type: 'user',
          action: '=cmd|/C calc',
          resource_type: 'doc',
          resource_id: 'doc-2',
          request_id: 'req\rid',
          ip: '10.0.0.1',
          user_agent: 'UA2',
          meta: {},
        },
      ],
    })

    const response = await request(pinned.url()).get('/api/audit-logs').query({ format: 'csv' })

    expect(response.status).toBe(200)
    expect(response.text).toBe(
      [
        'id,occurred_at,actor_id,actor_type,action,resource_type,resource_id,request_id,ip,user_agent,meta',
        "2,2026-01-02T00:00:00.000Z,user-2,user,'=cmd|/C calc,doc,doc-2,\"req\rid\",10.0.0.1,UA2,{}",
        '',
      ].join('\n'),
    )
  })
})
