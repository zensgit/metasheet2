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

// Shared by both describes below. Every query answers empty — sufficient for this file's purpose
// (see module docblock): the route's row-limit computation and header emission run regardless of how
// many rows come back, and an empty `result.data` means the CSV branch's per-row admission loop never
// executes, so this fake pool never needs to answer `canReadApprovalInstance`'s own queries.
async function buildApp(): Promise<Express> {
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
  pgState.pool.query.mockResolvedValue({ rows: [], rowCount: 0 })
  pgState.pool.connect.mockResolvedValue(pgState.client)

  const { approvalsRouter } = await import('../../src/routes/approvals')
  const built = express()
  built.use(express.json())
  built.use(approvalsRouter())
  return built
}

describe('GET /api/approvals?format=csv — route-level row-limit wiring (P2-1, gate-3 fix)', () => {
  let app: Express

  beforeEach(async () => {
    app = await buildApp()
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

/**
 * T1 (tester report 20261008, item 1) — `?header=label|code` and `?lang=zh|en` on the CSV export,
 * driven through the REAL route (same harness as above: real `approvalsRouter()`, fake empty pool).
 * A zero-row export is still a full CSV response whose first line is the header row, which is all
 * the header-mode contract needs; row-level words are covered in
 * `approval-export-csv-labels.test.ts` (pure serializer) and `approval-export-csv.db.test.ts`
 * (real rows through the real route).
 *
 * Every expected line below is HAND-TYPED, never built by calling the code under test: a mutation
 * that guts the label table would change the route's output and a derived expectation together and
 * stay green.
 */
describe('GET /api/approvals?format=csv — header=label|code and lang (T1)', () => {
  const CODE_ROW = 'id,sourceSystem,externalApprovalId,workflowKey,businessKey,requestNo,title,status,requesterId,requesterName,subject,currentStep,totalSteps,templateId,templateVersionId,currentNodeKey,formSnapshot,createdAt,updatedAt'
  const ZH_ROW = '审批实例ID,来源系统,外部审批ID,流程标识,业务标识,审批编号,标题,状态,发起人ID,发起人,审批对象,当前步骤,总步骤数,审批表单ID,审批表单版本ID,当前节点标识,表单信息,发起时间（UTC）,更新时间（UTC）'
  const EN_ROW = 'Instance ID,Source system,External approval ID,Workflow key,Business key,Request no.,Title,Status,Requester ID,Requester,Subject,Current step,Total steps,Form ID,Form version ID,Current node key,Form details,Submitted (UTC),Updated (UTC)'

  let app: Express

  beforeEach(async () => {
    app = await buildApp()
    pinned.setApp(app)
  })

  /** First CSV line, after the body-level UTF-8 BOM (supertest decodes `text/csv` as text). */
  function firstLine(text: string): string {
    return text.replace(/^\uFEFF/, '').split('\r\n')[0]
  }

  async function exportFirstLine(qs: string): Promise<string> {
    const response = await request(pinned.url()).get(`/api/approvals?format=csv${qs}`)
    expect(response.status, response.text).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.headers['x-approval-export-row-count']).toBe('0')
    return firstLine(response.text)
  }

  it('no header / lang: the first line is the 19 keys, exactly as before this change (the shipped default)', async () => {
    expect(await exportFirstLine('')).toBe(CODE_ROW)
  })

  it('header=code is the same as the default; lang is not read in code mode', async () => {
    expect(await exportFirstLine('&header=code')).toBe(CODE_ROW)
    expect(await exportFirstLine('&header=code&lang=en')).toBe(CODE_ROW)
    expect(await exportFirstLine('&header=code&lang=zh')).toBe(CODE_ROW)
    // `lang` alone does not switch to labels: the mode is `header`'s to choose.
    expect(await exportFirstLine('&lang=en')).toBe(CODE_ROW)
  })

  it('header=label writes the zh labels, and zh is the default language when lang is absent', async () => {
    expect(await exportFirstLine('&header=label')).toBe(ZH_ROW)
    expect(await exportFirstLine('&header=label&lang=zh')).toBe(ZH_ROW)
  })

  it('header=label&lang=en writes the en labels', async () => {
    expect(await exportFirstLine('&header=label&lang=en')).toBe(EN_ROW)
  })

  it('the other tab / filter parameters ride along unchanged with the new ones', async () => {
    expect(await exportFirstLine('&tab=completed&sourceSystem=platform&header=label&lang=en')).toBe(EN_ROW)
  })

  describe('invalid values are a 400 (exact literals; no trimming, no case-folding, no quiet fallback)', () => {
    const cases: Array<[string, string, 'APPROVAL_EXPORT_HEADER_INVALID' | 'APPROVAL_EXPORT_LANG_INVALID']> = [
      ['capitalised literal', '&header=Label', 'APPROVAL_EXPORT_HEADER_INVALID'],
      ['upper-case literal', '&header=LABEL', 'APPROVAL_EXPORT_HEADER_INVALID'],
      ['unknown word', '&header=bogus', 'APPROVAL_EXPORT_HEADER_INVALID'],
      ['empty value', '&header=', 'APPROVAL_EXPORT_HEADER_INVALID'],
      ['padded literal (no trimming)', '&header=%20label', 'APPROVAL_EXPORT_HEADER_INVALID'],
      ['repeated parameter', '&header=label&header=code', 'APPROVAL_EXPORT_HEADER_INVALID'],
      ['bracket form', '&header[]=label', 'APPROVAL_EXPORT_HEADER_INVALID'],
      ['unknown language', '&header=label&lang=fr', 'APPROVAL_EXPORT_LANG_INVALID'],
      ['upper-case language', '&header=label&lang=ZH', 'APPROVAL_EXPORT_LANG_INVALID'],
      ['locale-tag language', '&header=label&lang=zh-CN', 'APPROVAL_EXPORT_LANG_INVALID'],
      ['empty language', '&header=label&lang=', 'APPROVAL_EXPORT_LANG_INVALID'],
      ['repeated language', '&header=label&lang=zh&lang=en', 'APPROVAL_EXPORT_LANG_INVALID'],
      ['a bad language is refused in code mode too', '&header=code&lang=fr', 'APPROVAL_EXPORT_LANG_INVALID'],
      ['a bad language is refused with no header at all', '&lang=fr', 'APPROVAL_EXPORT_LANG_INVALID'],
      ['both bad: the header is reported first', '&header=bogus&lang=bogus', 'APPROVAL_EXPORT_HEADER_INVALID'],
    ]

    it.each(cases)('%s → 400', async (_name, qs, code) => {
      const response = await request(pinned.url()).get(`/api/approvals?format=csv${qs}`)
      expect(response.status).toBe(400)
      expect(response.headers['content-type']).toMatch(/^application\/json/)
      expect(response.body.ok).toBe(false)
      expect(response.body.error.code).toBe(code)
      // A refusal never looks like an export: no attachment, none of the export headers.
      expect(response.headers['content-disposition']).toBeUndefined()
      expect(response.headers['x-approval-export-row-count']).toBeUndefined()
    })

    it('is decided BEFORE any query runs, and the message never echoes the received value', async () => {
      const response = await request(pinned.url()).get('/api/approvals?format=csv&header=SECRET-VALUE-123')
      expect(response.status).toBe(400)
      expect(pgState.pool.query).not.toHaveBeenCalled()
      expect(pgState.pool.connect).not.toHaveBeenCalled()
      expect(JSON.stringify(response.body)).not.toContain('SECRET-VALUE-123')
    })

    it('POSITIVE CONTROL: the same requests with valid values are 200 CSV, so the 400s above are the values, not the route', async () => {
      for (const qs of ['&header=label', '&header=code', '&header=label&lang=zh', '&header=label&lang=en']) {
        const response = await request(pinned.url()).get(`/api/approvals?format=csv${qs}`)
        expect(response.status, qs).toBe(200)
        expect(response.headers['content-type']).toContain('text/csv')
      }
    })
  })

  describe('the JSON list is untouched: both parameters are accepted-and-ignored there (contract §5)', () => {
    it.each([
      ['no format', '/api/approvals?header=bogus&lang=bogus'],
      ['format=json', '/api/approvals?format=json&header=bogus&lang=bogus'],
      ['a non-literal format (CSV)', '/api/approvals?format=CSV&header=bogus&lang=bogus'],
      ['valid values on the JSON list', '/api/approvals?header=label&lang=en'],
    ])('%s → 200 JSON, not 400 and not CSV', async (_name, url) => {
      const response = await request(pinned.url()).get(url)
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toMatch(/^application\/json/)
      expect(response.body).toMatchObject({ data: [], total: 0 })
      expect(response.headers['content-disposition']).toBeUndefined()
    })
  })
})
