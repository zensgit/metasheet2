/**
 * P3-1 CSV export — route-level wiring (contract §5) — fix round P2-1 (gate-3 finding).
 *
 * Gate 3's finding: `tests/unit/approval-export-row-cap.test.ts` gates `APPROVAL_EXPORT_ROW_CAP`'s
 * VALUE and `resolveApprovalExportLimit`'s own clamping behavior, but neither of those is the same
 * as gating the ROUTE'S USE of that function. Gate 3 mutated ONLY the call site inside the
 * `?format=csv` branch of `GET /api/approvals` (`src/routes/approvals.ts`) — replacing
 * `resolveApprovalExportLimit(req.query.limit)` with the inlined
 * `parsePaging(req.query.limit, 5000, 5000)`, i.e. a call that never touches
 * `APPROVAL_EXPORT_ROW_CAP` or `resolveApprovalExportLimit` at all — and got 204 tests passed,
 * zero reds: `approval-export-row-cap.test.ts` imports and calls `resolveApprovalExportLimit`
 * directly, so it cannot see a regression at a DIFFERENT call site that stops calling it, and the
 * one suite that DOES exercise the real route (`tests/integration/approval-export-csv.db.test.ts`)
 * runs only in the advisory (non-required) `approval-realdb-export-csv` GitHub Actions lane.
 *
 * This file closes that gap the way `tests/unit/approvals-routes.test.ts` and
 * `tests/unit/approvals-bridge-routes.test.ts` already close equivalent gaps for their own routes:
 * an Express app built from the real `approvalsRouter()`, a fake `pg` pool (mocked at
 * `../../src/db/pg`, the same seam those two files use), mocked `authenticate`/`rbacGuard` so the
 * route body itself runs, and `supertest` over `usePinnedServer()` (this repo's #4154-safe
 * transport). The pool is stubbed to answer every query with an empty result set — sufficient
 * because `ApprovalBridgeService.listApprovals` degrades gracefully to `{ data: [], total: 0 }` on
 * an empty pool (verified: `total = parseInt(countResult.rows[0]?.count || '0', 10)` and every
 * downstream branch is guarded by `rows.length > 0` / `data.length > 0`), and the CSV branch's own
 * per-row admission loop (`canReadApprovalInstance`) never executes when `result.data` is empty —
 * so this test drives the FULL branch, from route entry to the header line, without needing to
 * also stand up the multi-query fixture `canReadApprovalInstance` would otherwise require.
 *
 * What this asserts, and why it is what gate 3 needed: the `X-Approval-Export-Row-Limit` response
 * header is the route's own effective-limit computation MADE OBSERVABLE (`src/routes/approvals.ts`
 * sets it from the same `limit` value used to build the query). Asserting it across three shapes —
 * absent `?limit=`, a `?limit=` far above the cap, and a `?limit=` at/under the cap — pins the ROUTE
 * CALL SITE's wiring to `resolveApprovalExportLimit`/`APPROVAL_EXPORT_ROW_CAP`, not merely the
 * function's own behavior in isolation. Gate 3's exact mutation is re-run against this file as part
 * of this fix round's verification (see the PR/report — not reproduced here as a test, since a
 * mutation is a manual verification step, not a permanent assertion).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const authState = vi.hoisted(() => ({
  user: {
    id: 'user-1',
    tenantId: 'tenant-a',
    name: 'Owner One',
    permissions: ['*:*'],
  } as Record<string, unknown> | null,
}))

const pgState = vi.hoisted(() => ({
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
  query: pgState.pool.query,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!authState.user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.user = authState.user as never
    next()
  },
}))

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  rbacGuardAny: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

const pinned = usePinnedServer()

describe('GET /api/approvals?format=csv — route-level row-limit wiring (P2-1, gate-3 fix)', () => {
  let app: Express

  beforeEach(async () => {
    vi.resetModules()
    authState.user = {
      id: 'user-1',
      tenantId: 'tenant-a',
      name: 'Owner One',
      permissions: ['*:*'],
    }
    pgState.pool.query.mockReset()
    pgState.pool.connect.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    // Every query answers empty — sufficient for this file's purpose (see module docblock): the
    // route's row-limit computation and header emission run regardless of how many rows come back,
    // and an empty `result.data` means the CSV branch's per-row admission loop never executes, so
    // this fake pool never needs to answer `canReadApprovalInstance`'s own queries.
    pgState.pool.query.mockResolvedValue({ rows: [], rowCount: 0 })
    pgState.pool.connect.mockResolvedValue(pgState.client)

    const { approvalsRouter } = await import('../../src/routes/approvals')
    app = express()
    app.use(express.json())
    app.use(approvalsRouter())
  })

  it('an absent ?limit= reports the effective limit as the full cap (500)', async () => {
    pinned.setApp(app)
    const response = await request(pinned.url()).get('/api/approvals?format=csv')

    expect(response.status).toBe(200)
    expect(response.headers['x-approval-export-row-limit']).toBe('500')
    expect(response.headers['x-approval-export-row-cap']).toBe('500')
    expect(response.headers['content-type']).toContain('text/csv')
  })

  it('a ?limit= far above the cap is clamped: the reported effective limit is still 500, never 5000', () => {
    pinned.setApp(app)
    return request(pinned.url())
      .get('/api/approvals?format=csv&limit=999999999')
      .then((response) => {
        expect(response.status).toBe(200)
        // THE ASSERTION THAT CATCHES GATE 3'S MUTATION: a call site that bypasses
        // `resolveApprovalExportLimit`/`APPROVAL_EXPORT_ROW_CAP` in favor of an inlined
        // `parsePaging(req.query.limit, 5000, 5000)` clamps this same request to 5000, not 500 —
        // this header is the only place that difference becomes observable at the route level.
        expect(response.headers['x-approval-export-row-limit']).toBe('500')
      })
  })

  it('a ?limit= under the cap is honored verbatim (not silently forced up to the cap)', async () => {
    pinned.setApp(app)
    const response = await request(pinned.url()).get('/api/approvals?format=csv&limit=10')

    expect(response.status).toBe(200)
    expect(response.headers['x-approval-export-row-limit']).toBe('10')
    // The hard ceiling itself is a SEPARATE, constant header — unaffected by the caller's smaller ask.
    expect(response.headers['x-approval-export-row-cap']).toBe('500')
  })

  it('a zero-row export (this file\'s fake pool) is a successful empty CSV, not an error', async () => {
    pinned.setApp(app)
    const response = await request(pinned.url()).get('/api/approvals?format=csv')

    expect(response.status).toBe(200)
    expect(response.headers['x-approval-export-row-count']).toBe('0')
    expect(response.headers['content-disposition']).toContain('attachment')
    // `text/csv` is decoded as text by supertest, so the UTF-8 BOM this route prepends
    // (`Buffer.from('﻿', 'utf8')`) round-trips as the literal U+FEFF character at position 0
    // — proof the CSV branch actually built and sent a body (BOM + sanitized header row + CRLF),
    // not merely set headers on an empty response.
    expect(response.text.charCodeAt(0)).toBe(0xfeff)
    expect(response.text).toContain('\r\n')
  })
})
