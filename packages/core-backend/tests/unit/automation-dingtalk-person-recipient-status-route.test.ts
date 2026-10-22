/**
 * 客户反馈 2026-10-21 item 1 (review round 1, F1): the rule editor's DingTalk person-recipient preflight
 * `POST /api/multitable/sheets/:sheetId/automations/dingtalk-person-recipient-status`.
 *
 * Pinned here:
 *  - the gate is canManageAutomation on the PATH sheet (403 first — nothing is read), then liveness;
 *    a permission-resolution failure fails closed and never reads users;
 *  - the read is the SENDER's own query (same SQL constant the executor runs), with the parsed ids;
 *  - the answer is booleans only — no name, email, DingTalk userid or integration — and unknown ids are
 *    exists:false;
 *  - ids are validated, trimmed, deduped and capped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAutomationRoutes } from '../../src/routes/automation'
import {
  DINGTALK_PERSON_RECIPIENT_STATUS_MAX_IDS,
  DINGTALK_PERSON_RECIPIENT_STATUS_SQL,
  readDingTalkPersonRecipientStatuses,
} from '../../src/multitable/dingtalk-person-recipient-status'
import { usePinnedServer } from '../utils/pinned-server'

const resolveSheetCapabilities = vi.hoisted(() => vi.fn())
const poolQuery = vi.hoisted(() => vi.fn())
vi.mock('../../src/multitable/permission-service', () => ({ resolveSheetCapabilities }))
vi.mock('../../src/integration/db/connection-pool', () => {
  const client = { query: poolQuery, getInternalPool: () => null }
  return { poolManager: { get: () => client } }
})
vi.mock('../../src/guards/audit-integration', () => ({
  requireAdminRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}))

const PATH = '/api/multitable/sheets/sheet-a/automations/dingtalk-person-recipient-status'

function buildApp() {
  const app = express()
  app.use(express.json())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((req: any, _res, next) => { req.user = { id: 'author_1' }; next() })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/api/multitable', createAutomationRoutes({} as any))
  return app
}

// Rows as the sender's query returns them — including the columns the route must NOT pass on.
const ROWS = [
  { local_user_id: 'user_linked', local_user_active: true, dingtalk_user_id: 'dt_fake_1', integration_id: 'int_fake_1' },
  { local_user_id: 'user_unlinked', local_user_active: true, dingtalk_user_id: null, integration_id: null },
  { local_user_id: 'user_inactive', local_user_active: false, dingtalk_user_id: 'dt_fake_2', integration_id: 'int_fake_1' },
]

function usersQueries() {
  return poolQuery.mock.calls.filter(([sql]) => sql === DINGTALK_PERSON_RECIPIENT_STATUS_SQL)
}

const pinned = usePinnedServer()

describe('DingTalk person-recipient preflight route', () => {
  beforeEach(() => {
    resolveSheetCapabilities.mockReset()
    poolQuery.mockReset()
    poolQuery.mockResolvedValue({ rows: ROWS, rowCount: ROWS.length })
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true }, sheetLiveness: 'live' })
    pinned.setApp(buildApp())
  })

  it('403s a caller without canManageAutomation on the path sheet and reads no user', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: false }, sheetLiveness: 'live' })
    const res = await request(pinned.url()).post(PATH).send({ userIds: ['user_linked'] })

    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
    expect(resolveSheetCapabilities).toHaveBeenCalledWith(expect.anything(), expect.any(Function), 'sheet-a')
    expect(usersQueries()).toHaveLength(0)
  })

  it('a caller without the capability gets the same 403 for a deleted sheet (no liveness oracle)', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: false }, sheetLiveness: 'deleted' })
    const res = await request(pinned.url()).post(PATH).send({ userIds: ['user_linked'] })
    expect(res.status).toBe(403)
    expect(usersQueries()).toHaveLength(0)
  })

  it('refuses a soft-deleted sheet for an authorized caller and reads no user', async () => {
    resolveSheetCapabilities.mockResolvedValue({ capabilities: { canManageAutomation: true }, sheetLiveness: 'deleted' })
    const res = await request(pinned.url()).post(PATH).send({ userIds: ['user_linked'] })
    expect(res.status).toBe(404)
    expect(usersQueries()).toHaveLength(0)
  })

  it('fails closed when permissions cannot be resolved (values-free 500) and reads no user', async () => {
    resolveSheetCapabilities.mockRejectedValue(new Error('boom: internal detail'))
    const res = await request(pinned.url()).post(PATH).send({ userIds: ['user_linked'] })
    expect(res.status).toBe(500)
    expect(res.body?.error?.code).toBe('PERMISSION_CHECK_FAILED')
    expect(JSON.stringify(res.body)).not.toContain('internal detail')
    expect(usersQueries()).toHaveLength(0)
  })

  it('answers booleans only, per requested id, with the sender’s own query', async () => {
    const res = await request(pinned.url())
      .post(PATH)
      .send({ userIds: [' user_linked ', 'user_unlinked', 'user_inactive', 'user_fake_missing', 'user_linked'] })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      data: {
        items: [
          { userId: 'user_linked', exists: true, active: true, dingtalkLinked: true },
          { userId: 'user_unlinked', exists: true, active: true, dingtalkLinked: false },
          { userId: 'user_inactive', exists: true, active: false, dingtalkLinked: true },
          { userId: 'user_fake_missing', exists: false, active: false, dingtalkLinked: false },
        ],
      },
    })
    // Same SQL the sender runs, with the trimmed, deduped ids — once.
    expect(usersQueries()).toEqual([[DINGTALK_PERSON_RECIPIENT_STATUS_SQL, [['user_linked', 'user_unlinked', 'user_inactive', 'user_fake_missing']]]])
    // Nothing but the requested ids and booleans leaves the route.
    const text = JSON.stringify(res.body)
    for (const leaked of ['dt_fake_1', 'dt_fake_2', 'int_fake_1', 'local_user', 'integration', 'external']) {
      expect(text).not.toContain(leaked)
    }
  })

  it('rejects a missing, malformed or oversized id list before reading', async () => {
    for (const body of [{}, { userIds: [] }, { userIds: 'user_linked' }, { userIds: [42] }, { userIds: ['  '] }, { userIds: ['x'.repeat(257)] }, { userIds: ['bad\u0000id'] }]) {
      const res = await request(pinned.url()).post(PATH).send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    const tooMany = Array.from({ length: DINGTALK_PERSON_RECIPIENT_STATUS_MAX_IDS + 1 }, (_, i) => `user_fake_${i}`)
    const res = await request(pinned.url()).post(PATH).send({ userIds: tooMany })
    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('TOO_MANY_USER_IDS')
    expect(usersQueries()).toHaveLength(0)

    // Exactly the cap is fine, and duplicates do not count against it.
    const atCap = Array.from({ length: DINGTALK_PERSON_RECIPIENT_STATUS_MAX_IDS }, (_, i) => `user_fake_${i}`)
    const ok = await request(pinned.url()).post(PATH).send({ userIds: [...atCap, ...atCap] })
    expect(ok.status).toBe(200)
    expect(ok.body.data.items).toHaveLength(DINGTALK_PERSON_RECIPIENT_STATUS_MAX_IDS)
  })

  it('a failed user read is a values-free error', async () => {
    poolQuery.mockRejectedValue(new Error('secret driver text'))
    const res = await request(pinned.url()).post(PATH).send({ userIds: ['user_linked'] })
    expect(res.status).toBe(500)
    expect(res.body?.error?.code).toBe('RECIPIENT_STATUS_FAILED')
    expect(JSON.stringify(res.body)).not.toContain('secret driver text')
  })
})

describe('readDingTalkPersonRecipientStatuses', () => {
  it('reaches a user exactly when the sender would: exists, active and linked', async () => {
    const queryFn = vi.fn().mockResolvedValue({ rows: ROWS })
    const items = await readDingTalkPersonRecipientStatuses(queryFn, ['user_linked', 'user_unlinked', 'user_inactive', 'user_fake_missing'])
    const reachable = items.filter((item) => item.exists && item.active && item.dingtalkLinked).map((item) => item.userId)
    expect(reachable).toEqual(['user_linked'])
    for (const item of items) expect(Object.keys(item).sort()).toEqual(['active', 'dingtalkLinked', 'exists', 'userId'])
  })

  it('reads nothing for an empty list', async () => {
    const queryFn = vi.fn()
    expect(await readDingTalkPersonRecipientStatuses(queryFn, [])).toEqual([])
    expect(queryFn).not.toHaveBeenCalled()
  })
})

describe('the sender and the preflight share one query', () => {
  it('automation-executor.ts sends with DINGTALK_PERSON_RECIPIENT_STATUS_SQL, not a private copy', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(__dirname, '../../src/multitable/automation-executor.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect(source).toContain("import { DINGTALK_PERSON_RECIPIENT_STATUS_SQL } from './dingtalk-person-recipient-status'")
    expect(source).toMatch(/this\.deps\.queryFn\(\n(?:\s*\/\/[^\n]*\n)*\s*DINGTALK_PERSON_RECIPIENT_STATUS_SQL,\n\s*\[userIds\],/)
  })
})
