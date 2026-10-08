import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Test report 2026-10-08 — the tab read-state badge endpoints' switch gate, without a database.
 *
 * Each badge is ONE predicate read in two places: its count route's gate and the session feature
 * the web reads to decide whether to ask. This file pins (a) the predicate's truth table (exact
 * literal 'true' only), (b) that the route answers 404 with its OWN code exactly when the predicate
 * is false — before any query — and gets past the gate exactly when it is true, and (c) that the
 * session payload emits the same predicate. The counting itself is real-DB territory
 * (tests/integration/approval-notify-badges.db.test.ts).
 */

const poolState = vi.hoisted(() => ({
  query: vi.fn(async () => {
    throw new Error('no query may run in this file')
  }),
}))

vi.mock('../../src/db/pg', () => ({
  pool: { query: poolState.query, connect: () => { throw new Error('no connection may be taken in this file') } },
}))

const authState = vi.hoisted(() => ({ userId: 'badge-viewer' as string | null }))
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      ...(authState.userId ? { id: authState.userId, sub: authState.userId } : {}),
      permissions: ['*:*'],
      roles: ['admin'],
    } as never
    next()
  },
}))

import { approvalsRouter } from '../../src/routes/approvals'
import {
  isApprovalCcUnreadBadgeEnabled,
  isApprovalMineOutcomeBadgeEnabled,
} from '../../src/services/approval-notify-badge-flags'

const CASES: ReadonlyArray<readonly [string, string | undefined, boolean]> = [
  ['unset', undefined, false],
  ['empty', '', false],
  ['TRUE', 'TRUE', false],
  ['1', '1', false],
  ['leading space', ' true', false],
  ['trailing space', 'true ', false],
  ['false', 'false', false],
  ['exact true', 'true', true],
]

const SWITCHES = [
  {
    env: 'APPROVAL_CC_UNREAD_BADGE_ENABLED',
    path: '/api/approvals/cc-unread-count',
    disabledCode: 'APPROVAL_CC_UNREAD_BADGE_DISABLED',
    predicate: isApprovalCcUnreadBadgeEnabled,
    payloadLine: 'approvalCcUnreadBadge: isApprovalCcUnreadBadgeEnabled(),',
  },
  {
    env: 'APPROVAL_MINE_OUTCOME_BADGE_ENABLED',
    path: '/api/approvals/mine-outcomes/unseen-count',
    disabledCode: 'APPROVAL_MINE_OUTCOME_BADGE_DISABLED',
    predicate: isApprovalMineOutcomeBadgeEnabled,
    payloadLine: 'approvalMineOutcomeBadge: isApprovalMineOutcomeBadgeEnabled(),',
  },
] as const

function createApp() {
  const app = express()
  app.use(express.json())
  app.use(approvalsRouter())
  return app
}

describe('tab read-state badge switches (test report 2026-10-08)', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const sw of SWITCHES) saved[sw.env] = process.env[sw.env]
    poolState.query.mockClear()
    authState.userId = 'badge-viewer'
  })

  afterEach(() => {
    for (const sw of SWITCHES) {
      if (saved[sw.env] === undefined) delete process.env[sw.env]
      else process.env[sw.env] = saved[sw.env]
    }
  })

  for (const sw of SWITCHES) {
    describe(sw.env, () => {
      it.each(CASES)('%s (%j): the predicate and the route gate agree (%s)', async (_label, value, expected) => {
        expect(sw.predicate(value === undefined ? {} : { [sw.env]: value })).toBe(expected)
        if (value === undefined) delete process.env[sw.env]
        else process.env[sw.env] = value
        expect(sw.predicate()).toBe(expected)

        // An unknown sourceSystem is refused right after the gate, before any query: 404 ⇔ gate
        // closed, 400 ⇔ gate open. Either way no query runs.
        const response = await request(createApp()).get(`${sw.path}?sourceSystem=elsewhere`)
        if (expected) {
          expect(response.status).toBe(400)
          expect(response.body?.error?.code).toBe('APPROVAL_SOURCE_SYSTEM_INVALID')
        } else {
          expect(response.status).toBe(404)
          expect(response.body?.error?.code).toBe(sw.disabledCode)
        }
        expect(poolState.query).not.toHaveBeenCalled()
      })

      it('switched on: an unknown sourceSystem is a 400 before any query', async () => {
        process.env[sw.env] = 'true'
        const response = await request(createApp()).get(`${sw.path}?sourceSystem=elsewhere`)
        expect(response.status).toBe(400)
        expect(response.body?.error?.code).toBe('APPROVAL_SOURCE_SYSTEM_INVALID')
        expect(poolState.query).not.toHaveBeenCalled()
      })

      it('switched on: a request without a user id is a 401 before any query', async () => {
        process.env[sw.env] = 'true'
        authState.userId = null
        const response = await request(createApp()).get(`${sw.path}?sourceSystem=all`)
        expect(response.status).toBe(401)
        expect(poolState.query).not.toHaveBeenCalled()
      })

      it('the session feature payload emits the same predicate', () => {
        const authSource = readFileSync(join(__dirname, '../../src/routes/auth.ts'), 'utf8')
        expect(authSource).toContain(sw.payloadLine)
      })
    })
  }
})
