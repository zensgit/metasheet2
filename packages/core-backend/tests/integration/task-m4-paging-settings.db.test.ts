import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import request from 'supertest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { MetaSheetServer } from '../../src/index'
import { completeTask, countPendingList, countTasks, createTask } from '../../src/services/task-records'
import { dropTaskM4Fixtures, runSourceMutant, seedOrgMembers, seedTaskActor, type SeededTaskActor } from '../helpers/task-m4-fixtures'
import { startTasksListener, tasksClient, type TasksClient, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M4 PR-3a S3 (design task-m4-pr3a-backend-design-20260930.md §7, §8, §3.6, §10.7 gate 13).
 * RULED(2026-10-07): [R15] limit 1..100 default 100, offset >= 0, `{ items, total }`, invalid
 * forms 422 INVALID_LIMIT / INVALID_OFFSET (the M3 comment list keeps its own INVALID_PAGE, Q8).
 * RULED(2026-10-07): [R02] settings routes and badge_scope on /pending-count.
 * ASSUMPTION(task-m4): [D5] [own-11] the answer for badge_scope 'off'.
 * ASSUMPTION(task-m4): [own-39] a settings PATCH reads only a JSON body.
 * HTTP goes through `tasksRouter()` on one express listener per file (tests/helpers/tasks-http-harness.ts;
 * setup.integration.ts, RBAC_TOKEN_TRUST='true');
 * the gate 13 cells use the real MetaSheetServer.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-paging-settings.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4page_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const req = createRequire(import.meta.url)
const SUPERTEST_PATH = req.resolve('supertest')
const ROUTES_FILE = new URL('../../src/routes/tasks.ts', import.meta.url).pathname
const INDEX_FILE = new URL('../../src/index.ts', import.meta.url).pathname

const DEFAULT_SETTINGS = {
  badgeScope: 'overdue',
  dailyReminderEnabled: false,
  defaultRemindPolicy: { mode: 'default' },
  timeZone: null,
}

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function orgOf(label: string, stamp: string): string {
  return `${ORG_PREFIX}${label}_${stamp}`
}

async function actor(label: string, stamp: string, orgId: string, codes = ['tasks:read', 'tasks:write']): Promise<SeededTaskActor> {
  const seeded = await seedTaskActor({ label, stamp, orgId, codes, admission: true })
  seededUsers.push(seeded.userId)
  seededRoles.push(seeded.roleId)
  return seeded
}

/** Same user and role, token without a tenant claim (org missing). */
function orgLessBearer(who: SeededTaskActor): string {
  return jwt.sign({
    userId: who.userId,
    sub: who.userId,
    email: `${who.userId}@tasks-m4.test`,
    role: 'user',
    roles: [who.roleId],
  }, String(process.env.JWT_SECRET), { expiresIn: '1h' })
}

/** Same user and role, token for another org the user also belongs to. */
function bearerFor(who: SeededTaskActor, orgId: string): string {
  return jwt.sign({
    userId: who.userId,
    sub: who.userId,
    email: `${who.userId}@tasks-m4.test`,
    role: 'user',
    roles: [who.roleId],
    tenantId: orgId,
  }, String(process.env.JWT_SECRET), { expiresIn: '1h' })
}

let listener: TasksListener | undefined

beforeAll(async () => {
  listener = await startTasksListener()
})

/** The file's one listener (tests/helpers/tasks-http-harness.ts): `Connection: close`, no keep-alive. */
function app(): TasksClient {
  return tasksClient(listener?.baseUrl ?? '')
}

function auth(bearer: string): { Authorization: string } {
  return { Authorization: `Bearer ${bearer}` }
}

async function createdTasks(orgId: string, creatorId: string, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i += 1) {
    const created = await createTask({ orgId, creatorId, title: `备料复核 ${i}`, assignees: [], completionMode: 'all' })
    ids.push(created.id)
  }
  return ids
}

async function idsInSqlOrder(ids: string[], orderBy: string): Promise<string[]> {
  const result = await poolManager.get().query(`SELECT id FROM tasks WHERE id = ANY($1::text[]) ORDER BY ${orderBy}`, [ids])
  return result.rows.map((row) => String(row.id))
}

async function settingsRow(userId: string, orgId: string): Promise<Record<string, unknown> | undefined> {
  const result = await poolManager.get().query(
    `SELECT badge_scope, daily_reminder_enabled, default_remind_policy, time_zone, updated_at
     FROM task_user_settings WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId],
  )
  return result.rows[0]
}

afterAll(async () => {
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  await listener?.close()
})

// ---------------------------------------------------------------------------------------------
// §7 R15 pagination on GET /api/tasks and GET /api/tasks/pending.
// ---------------------------------------------------------------------------------------------

describe('R15 pagination', () => {
  it('paging|default limit is 100 (the former cap) and total counts every row', async () => {
    const stamp = stampOf()
    const orgId = orgOf('dflt', stamp)
    const me = await actor('dflt', stamp, orgId)
    const ids = await createdTasks(orgId, me.userId, 101)
    const server = app()
    const first = await server.get('/api/tasks').query({ view: 'created' }).set(auth(me.bearer))
    expect(first.status).toBe(200)
    expect(Object.keys(first.body).sort()).toEqual(['items', 'total'])
    expect(first.body.items).toHaveLength(100)
    expect(first.body.total).toBe(101)
    expect(Object.keys(first.body.items[0]).sort()).toEqual(['completion_mode', 'created_by', 'due_at', 'id', 'status', 'title'])
    const rest = await server.get('/api/tasks').query({ view: 'created', offset: '100' }).set(auth(me.bearer))
    expect(rest.status).toBe(200)
    expect(rest.body.items).toHaveLength(1)
    expect(rest.body.total).toBe(101)
    const seen = [...first.body.items, ...rest.body.items].map((row: { id: string }) => row.id)
    expect(new Set(seen).size).toBe(101)
    expect([...seen].sort()).toEqual([...ids].sort())
    expect(await countTasks({ orgId, actorId: me.userId, view: 'created' })).toBe(101)
  }, 60000)

  it('paging|boundaries: limit 1 and 100, offset 0, offset past the end, offset at the safe-integer maximum', async () => {
    const stamp = stampOf()
    const orgId = orgOf('bnd', stamp)
    const me = await actor('bnd', stamp, orgId)
    await createdTasks(orgId, me.userId, 3)
    const server = app()
    const get = (query: Record<string, string>) => server.get('/api/tasks').query({ view: 'created', ...query }).set(auth(me.bearer))
    const one = await get({ limit: '1' })
    expect([one.status, one.body.items.length, one.body.total]).toEqual([200, 1, 3])
    const hundred = await get({ limit: '100', offset: '0' })
    expect([hundred.status, hundred.body.items.length, hundred.body.total]).toEqual([200, 3, 3])
    const past = await get({ offset: '3' })
    expect(past.status).toBe(200)
    expect(past.body).toEqual({ items: [], total: 3 })
    const max = await get({ offset: '9007199254740991' })
    expect(max.status).toBe(200)
    expect(max.body).toEqual({ items: [], total: 3 })
  })

  const INVALID: Array<[string, string]> = [
    ['limit=0', 'INVALID_LIMIT'],
    ['limit=101', 'INVALID_LIMIT'],
    ['limit=-1', 'INVALID_LIMIT'],
    ['limit=1.5', 'INVALID_LIMIT'],
    ['limit=1e2', 'INVALID_LIMIT'],
    ['limit=%201', 'INVALID_LIMIT'],
    ['limit=%2B1', 'INVALID_LIMIT'],
    ['limit=01', 'INVALID_LIMIT'],
    ['limit=', 'INVALID_LIMIT'],
    ['limit=abc', 'INVALID_LIMIT'],
    ['limit=1&limit=2', 'INVALID_LIMIT'],
    ['limit[a]=1', 'INVALID_LIMIT'],
    ['offset=-1', 'INVALID_OFFSET'],
    ['offset=1.5', 'INVALID_OFFSET'],
    ['offset=00', 'INVALID_OFFSET'],
    ['offset=', 'INVALID_OFFSET'],
    ['offset=x', 'INVALID_OFFSET'],
    ['offset=1&offset=2', 'INVALID_OFFSET'],
    ['offset[a]=1', 'INVALID_OFFSET'],
    ['offset=9007199254740992', 'INVALID_OFFSET'],
    ['limit=0&offset=-1', 'INVALID_LIMIT'],
  ]
  const INVALID_CELLS = INVALID.flatMap(([query, code]) => [
    { path: '/api/tasks', query, code },
    { path: '/api/tasks/pending', query, code },
  ])

  it.each(INVALID_CELLS)('paging|$path?$query is 422 $code, never clamped', async ({ path, query, code }) => {
    const stamp = stampOf()
    const orgId = orgOf('bad', stamp)
    const me = await actor('bad', stamp, orgId)
    const response = await app().get(`${path}?${query}`).set(auth(me.bearer))
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code } })
  })

  it('paging|two pages neither repeat nor skip; equal updated_at is ordered by id DESC across the boundary', async () => {
    const stamp = stampOf()
    const orgId = orgOf('tie', stamp)
    const me = await actor('tie', stamp, orgId)
    const ids = await createdTasks(orgId, me.userId, 5)
    await poolManager.get().query(
      `UPDATE tasks SET updated_at = timestamptz '2026-09-01T00:00:00Z' WHERE id = ANY($1::text[])`,
      [ids],
    )
    // Precondition: physical (insertion) order must differ from the id tiebreak, otherwise a
    // missing tiebreak could pass by accident. Add rows until it does.
    let expected = await idsInSqlOrder(ids, 'id DESC')
    while (JSON.stringify(expected) === JSON.stringify(ids) || JSON.stringify(expected) === JSON.stringify([...ids].reverse())) {
      const [extra] = await createdTasks(orgId, me.userId, 1)
      await poolManager.get().query(`UPDATE tasks SET updated_at = timestamptz '2026-09-01T00:00:00Z' WHERE id = $1`, [extra])
      ids.push(extra)
      expected = await idsInSqlOrder(ids, 'id DESC')
    }
    const server = app()
    const pages: string[] = []
    for (let offset = 0; offset < ids.length; offset += 2) {
      const page = await server.get('/api/tasks').query({ view: 'created', limit: '2', offset: String(offset) }).set(auth(me.bearer))
      expect(page.status).toBe(200)
      expect(page.body.total).toBe(ids.length)
      pages.push(...page.body.items.map((row: { id: string }) => row.id))
    }
    expect(pages).toEqual(expected)
    // Distinct updated_at: newest first.
    await poolManager.get().query(`UPDATE tasks SET updated_at = timestamptz '2026-09-02T00:00:00Z' WHERE id = $1`, [expected[expected.length - 1]])
    const head = await server.get('/api/tasks').query({ view: 'created', limit: '1' }).set(auth(me.bearer))
    expect(head.body.items.map((row: { id: string }) => row.id)).toEqual([expected[expected.length - 1]])
  })

  it('paging|/pending pages the all_open list, total counts it, item shape unchanged', async () => {
    const stamp = stampOf()
    const orgId = orgOf('pend', stamp)
    const me = await actor('pend', stamp, orgId)
    const other = `usrO_pend_${stamp}`
    const open: string[] = []
    for (let i = 0; i < 3; i += 1) {
      open.push((await createTask({ orgId, creatorId: other, title: `待办 ${i}`, assignees: [me.userId], completionMode: 'all' })).id)
    }
    const done = await createTask({ orgId, creatorId: other, title: '已完成', assignees: [me.userId], completionMode: 'all' })
    await completeTask({ orgId, actorId: me.userId, taskId: done.id })
    const server = app()
    const first = await server.get('/api/tasks/pending').query({ limit: '2' }).set(auth(me.bearer))
    const second = await server.get('/api/tasks/pending').query({ limit: '2', offset: '2' }).set(auth(me.bearer))
    expect(first.status).toBe(200)
    expect(Object.keys(first.body).sort()).toEqual(['items', 'total'])
    expect(first.body.total).toBe(3)
    expect(second.body.total).toBe(3)
    const seen = [...first.body.items, ...second.body.items].map((row: { id: string }) => row.id)
    expect(seen).toEqual(await idsInSqlOrder(open, 'updated_at DESC, id DESC'))
    expect(Object.keys(first.body.items[0]).sort()).toEqual(['href', 'id', 'source', 'title', 'updatedAt'])
    expect(await countPendingList({ orgId, actorId: me.userId })).toBe(3)
  })

  // M4G1T-03 / S3-PAGE-1: `total` is the unpaged count of the same view condition as `items`.
  it('paging|total counts the requested view only: in a mixed org each view and /pending see a different subset', async () => {
    const stamp = stampOf()
    const orgId = orgOf('mix', stamp)
    const me = await actor('mix', stamp, orgId)
    const other = `usrO_mix_${stamp}`
    // RULED(2026-10-07): [N2] `other` is written as an assignee by me, so it must be an active org member.
    await seedOrgMembers(orgId, [other])
    seededUsers.push(other)
    const own = await createTask({ orgId, creatorId: me.userId, title: '自建', assignees: [], completionMode: 'all' })
    const delegated = await createTask({ orgId, creatorId: me.userId, title: '委派', assignees: [other], completionMode: 'all' })
    const assigned = await createTask({ orgId, creatorId: other, title: '指派', assignees: [me.userId], completionMode: 'all' })
    const followed = await createTask({ orgId, creatorId: other, title: '关注', assignees: [other], completionMode: 'all' })
    await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [followed.id, me.userId])
    await createTask({ orgId, creatorId: other, title: '无关', assignees: [other], completionMode: 'all' })
    const expected: Record<string, string[]> = {
      assigned: [assigned.id],
      created: [own.id, delegated.id],
      following: [followed.id],
      delegated: [delegated.id],
      any_role: [own.id, delegated.id, assigned.id, followed.id],
    }
    for (const [view, ids] of Object.entries(expected)) {
      const all = await app().get('/api/tasks').query({ view }).set(auth(me.bearer))
      expect(all.status, view).toBe(200)
      expect(all.body.items.map((row: { id: string }) => row.id).sort(), view).toEqual([...ids].sort())
      expect(all.body.total, view).toBe(ids.length)
      const first = await app().get('/api/tasks').query({ view, limit: '1' }).set(auth(me.bearer))
      expect(first.body.total, view).toBe(ids.length)
      expect(await countTasks({ orgId, actorId: me.userId, view }), view).toBe(ids.length)
    }
    // /pending: the caller's own open assigned task only; the other open tasks of the org are not counted.
    const pending = await app().get('/api/tasks/pending').set(auth(me.bearer))
    expect(pending.body.items.map((row: { id: string }) => row.id)).toEqual([assigned.id])
    expect(pending.body.total).toBe(1)
    expect(await countPendingList({ orgId, actorId: me.userId })).toBe(1)
  })

  it('paging|degraded bodies carry no total; a missing org degrades before the page is parsed; a bad page beats a bad view', async () => {
    const stamp = stampOf()
    const orgId = orgOf('deg', stamp)
    const me = await actor('deg', stamp, orgId)
    const server = app()
    const bare = orgLessBearer(me)
    for (const path of ['/api/tasks', '/api/tasks/pending']) {
      const plain = await server.get(path).set(auth(bare))
      expect(plain.body).toEqual({ items: [], degraded: true, reason: 'org_missing' })
      const badPage = await server.get(`${path}?limit=0`).set(auth(bare))
      expect(badPage.status).toBe(200)
      expect(badPage.body).toEqual({ items: [], degraded: true, reason: 'org_missing' })
    }
    const badView = await server.get('/api/tasks').query({ view: 'not-a-view', limit: '5' }).set(auth(me.bearer))
    expect(badView.status).toBe(200)
    expect(badView.body).toEqual({ items: [], degraded: true, reason: 'predicate_error' })
    const both = await server.get('/api/tasks').query({ view: 'not-a-view', limit: '0' }).set(auth(me.bearer))
    expect(both.status).toBe(422)
    expect(both.body).toEqual({ error: { code: 'INVALID_LIMIT' } })
  })
})

// ---------------------------------------------------------------------------------------------
// §3.6 settings routes.
// ---------------------------------------------------------------------------------------------

describe('settings routes', () => {
  it('settings|GET without a row returns the defaults and writes nothing', async () => {
    const stamp = stampOf()
    const orgId = orgOf('sget', stamp)
    const me = await actor('sget', stamp, orgId, ['tasks:read'])
    const response = await app().get('/api/task-settings').set(auth(me.bearer))
    expect(response.status).toBe(200)
    expect(response.body).toEqual(DEFAULT_SETTINGS)
    expect(await settingsRow(me.userId, orgId)).toBeUndefined()
  })

  it('settings|PATCH merges a subset, stores canonical zone names, ignores unknown keys, replays as a no-op', async () => {
    const stamp = stampOf()
    const orgId = orgOf('spat', stamp)
    const me = await actor('spat', stamp, orgId)
    const server = app()
    const first = await server.patch('/api/task-settings').set(auth(me.bearer)).send({ badgeScope: 'off', unknownKey: 1 })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ ...DEFAULT_SETTINGS, badgeScope: 'off' })
    const zone = await server.patch('/api/task-settings').set(auth(me.bearer))
      .send({ timeZone: 'asia/shanghai', dailyReminderEnabled: true, defaultRemindPolicy: { mode: 'none' } })
    expect(zone.status).toBe(200)
    const expected = { badgeScope: 'off', dailyReminderEnabled: true, defaultRemindPolicy: { mode: 'none' }, timeZone: 'Asia/Shanghai' }
    expect(zone.body).toEqual(expected)
    const read = await server.get('/api/task-settings').set(auth(me.bearer))
    expect(read.body).toEqual(expected)
    const row = await settingsRow(me.userId, orgId)
    expect({ ...row, updated_at: undefined }).toEqual({
      badge_scope: 'off', daily_reminder_enabled: true, default_remind_policy: { mode: 'none' }, time_zone: 'Asia/Shanghai', updated_at: undefined,
    })
    const replay = await server.patch('/api/task-settings').set(auth(me.bearer))
      .send({ timeZone: 'Asia/Shanghai', dailyReminderEnabled: true, defaultRemindPolicy: { mode: 'none' } })
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(expected)
    const after = await settingsRow(me.userId, orgId)
    expect((after?.updated_at as Date).getTime()).toBe((row?.updated_at as Date).getTime())
    const cleared = await server.patch('/api/task-settings').set(auth(me.bearer)).send({ dailyReminderEnabled: false, timeZone: null })
    expect(cleared.body).toEqual({ ...expected, dailyReminderEnabled: false, timeZone: null })
  })

  const INVALID_BODIES: Array<[string, string, unknown]> = [
    ['array body', 'INVALID_SETTINGS', [1]],
    ['badgeScope all_open', 'INVALID_BADGE_SCOPE', { badgeScope: 'all_open' }],
    ['badgeScope null', 'INVALID_BADGE_SCOPE', { badgeScope: null }],
    ['badgeScope number', 'INVALID_BADGE_SCOPE', { badgeScope: 5 }],
    ['dailyReminderEnabled string', 'INVALID_DAILY_REMINDER_ENABLED', { dailyReminderEnabled: 'true' }],
    ['policy unknown mode', 'INVALID_POLICY', { defaultRemindPolicy: { mode: 'x' } }],
    ['policy null', 'INVALID_POLICY', { defaultRemindPolicy: null }],
    ['policy extra key', 'INVALID_POLICY', { defaultRemindPolicy: { mode: 'none', extra: 1 } }],
    ['timeZone unknown', 'INVALID_TIME_ZONE', { timeZone: 'Not/AZone' }],
    ['timeZone number', 'INVALID_TIME_ZONE', { timeZone: 5 }],
    ['daily reminder without zone', 'DAILY_REMINDER_REQUIRES_TIME_ZONE', { dailyReminderEnabled: true }],
    ['daily reminder with zone cleared', 'DAILY_REMINDER_REQUIRES_TIME_ZONE', { dailyReminderEnabled: true, timeZone: null }],
  ]

  it.each(INVALID_BODIES)('settings|PATCH %s is 422 %s and leaves no row', async (label, code, body) => {
    const stamp = stampOf()
    const orgId = orgOf('sbad', stamp)
    const me = await actor(`sbad${INVALID_BODIES.findIndex((row) => row[0] === label)}`, stamp, orgId)
    const response = await app().patch('/api/task-settings').set(auth(me.bearer)).send(body as object)
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code } })
    expect(await settingsRow(me.userId, orgId)).toBeUndefined()
  })

  it('settings|a 422 against an existing row leaves the row unchanged (merged-row rule)', async () => {
    const stamp = stampOf()
    const orgId = orgOf('smrg', stamp)
    const me = await actor('smrg', stamp, orgId)
    const server = app()
    await server.patch('/api/task-settings').set(auth(me.bearer)).send({ timeZone: 'UTC', dailyReminderEnabled: true })
    const before = await settingsRow(me.userId, orgId)
    const response = await server.patch('/api/task-settings').set(auth(me.bearer)).send({ timeZone: null, badgeScope: 'off' })
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code: 'DAILY_REMINDER_REQUIRES_TIME_ZONE' } })
    expect(await settingsRow(me.userId, orgId)).toEqual(before)
  })

  it('settings|missing org: GET is 404 NOT_FOUND, PATCH is 422 ORG_MISSING before the body is read', async () => {
    const stamp = stampOf()
    const orgId = orgOf('snoorg', stamp)
    const me = await actor('snoorg', stamp, orgId)
    const bare = orgLessBearer(me)
    const server = app()
    const read = await server.get('/api/task-settings').set(auth(bare))
    expect(read.status).toBe(404)
    expect(read.body).toEqual({ error: { code: 'NOT_FOUND' } })
    const write = await server.patch('/api/task-settings').set(auth(bare)).send([1])
    expect(write.status).toBe(422)
    expect(write.body).toEqual({ error: { code: 'ORG_MISSING' } })
    const rows = await poolManager.get().query('SELECT count(*)::int AS n FROM task_user_settings WHERE user_id = $1', [me.userId])
    expect(rows.rows[0].n).toBe(0)
  })

  it('settings|the row is per user and per org', async () => {
    const stamp = stampOf()
    const orgA = orgOf('siso_a', stamp)
    const orgB = orgOf('siso_b', stamp)
    const me = await actor('siso', stamp, orgA)
    const neighbour = await actor('sisn', stamp, orgA)
    await poolManager.get().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [me.userId, orgB])
    // The neighbour has one overdue task (all day, UTC, three days ago) and no settings row.
    const due = String((await poolManager.get().query(`SELECT ((now() AT TIME ZONE 'UTC')::date - 3)::text AS d`)).rows[0].d)
    await createTask({ orgId: orgA, creatorId: `usrO_siso_${stamp}`, title: '逾期', assignees: [neighbour.userId], completionMode: 'all', dueDate: due, timeZone: 'UTC' })
    const server = app()
    const set = await server.patch('/api/task-settings').set(auth(me.bearer)).send({ badgeScope: 'off' })
    expect(set.status).toBe(200)
    const inB = await server.get('/api/task-settings').set(auth(bearerFor(me, orgB)))
    expect(inB.body).toEqual(DEFAULT_SETTINGS)
    const neighbourRead = await server.get('/api/task-settings').set(auth(neighbour.bearer))
    expect(neighbourRead.body).toEqual(DEFAULT_SETTINGS)
    const countA = await server.get('/api/tasks/pending-count').set(auth(me.bearer))
    const countB = await server.get('/api/tasks/pending-count').set(auth(bearerFor(me, orgB)))
    expect(countA.body).toEqual({ count: 0, badgeScope: 'off' })
    expect(countB.body).toEqual({ count: 0 })
    // Another user's 'off' is not the neighbour's: the neighbour's badge counts its own task.
    const neighbourCount = await server.get('/api/tasks/pending-count').set(auth(neighbour.bearer)).set('x-viewer-time-zone', 'UTC')
    expect(neighbourCount.body).toEqual({ count: 1 })
  })

  // M4G1T-04: a PATCH writes the caller's row of the token's org only.
  it('settings|a PATCH in one org leaves the same user\'s row in another org as it was', async () => {
    const stamp = stampOf()
    const orgA = orgOf('sxo_a', stamp)
    const orgB = orgOf('sxo_b', stamp)
    const me = await actor('sxo', stamp, orgA)
    await poolManager.get().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [me.userId, orgB])
    const server = app()
    const inB = await server.patch('/api/task-settings').set(auth(bearerFor(me, orgB))).send({ badgeScope: 'overdue_or_today', timeZone: 'UTC' })
    expect(inB.status).toBe(200)
    const rowB = await settingsRow(me.userId, orgB)
    const inA = await server.patch('/api/task-settings').set(auth(me.bearer)).send({ badgeScope: 'off', timeZone: 'Asia/Shanghai' })
    expect(inA.status).toBe(200)
    expect(await settingsRow(me.userId, orgB)).toEqual(rowB)
    const readB = await server.get('/api/task-settings').set(auth(bearerFor(me, orgB)))
    expect(readB.body).toEqual({ ...DEFAULT_SETTINGS, badgeScope: 'overdue_or_today', timeZone: 'UTC' })
    expect((await settingsRow(me.userId, orgA))?.badge_scope).toBe('off')
  })

  // M4G1T-06: each field alone is a change that is stored.
  it('settings|a PATCH that changes only defaultRemindPolicy, or only dailyReminderEnabled, is stored', async () => {
    const stamp = stampOf()
    const orgId = orgOf('sone', stamp)
    const me = await actor('sone', stamp, orgId)
    const server = app()
    const policy = await server.patch('/api/task-settings').set(auth(me.bearer)).send({ defaultRemindPolicy: { mode: 'none' } })
    expect(policy.body).toEqual({ ...DEFAULT_SETTINGS, defaultRemindPolicy: { mode: 'none' } })
    expect((await settingsRow(me.userId, orgId))?.default_remind_policy).toEqual({ mode: 'none' })
    expect((await server.patch('/api/task-settings').set(auth(me.bearer)).send({ timeZone: 'UTC' })).status).toBe(200)
    const on = await server.patch('/api/task-settings').set(auth(me.bearer)).send({ dailyReminderEnabled: true })
    expect(on.body.dailyReminderEnabled).toBe(true)
    expect((await settingsRow(me.userId, orgId))?.daily_reminder_enabled).toBe(true)
    const off = await server.patch('/api/task-settings').set(auth(me.bearer)).send({ dailyReminderEnabled: false })
    expect(off.body.dailyReminderEnabled).toBe(false)
    expect((await settingsRow(me.userId, orgId))?.daily_reminder_enabled).toBe(false)
    const read = await server.get('/api/task-settings').set(auth(me.bearer))
    expect(read.body).toEqual({ badgeScope: 'overdue', dailyReminderEnabled: false, defaultRemindPolicy: { mode: 'none' }, timeZone: 'UTC' })
  })

  // ASSUMPTION(task-m4): [own-39]
  it('settings|a PATCH whose body is not JSON is 422 INVALID_SETTINGS and leaves no row', async () => {
    const stamp = stampOf()
    const orgId = orgOf('snj', stamp)
    const me = await actor('snj', stamp, orgId)
    const server = app()
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const response = await server.patch('/api/task-settings').set(auth(me.bearer)).set('Content-Type', type).send('badgeScope=off')
      expect(response.status, type).toBe(422)
      expect(response.body).toEqual({ error: { code: 'INVALID_SETTINGS' } })
    }
    const bare = await server.patch('/api/task-settings').set(auth(me.bearer))
    expect(bare.status).toBe(422)
    expect(bare.body).toEqual({ error: { code: 'INVALID_SETTINGS' } })
    expect(await settingsRow(me.userId, orgId)).toBeUndefined()
    // A missing org is still answered first.
    const orgLess = await server.patch('/api/task-settings').set(auth(orgLessBearer(me))).set('Content-Type', 'text/plain').send('x')
    expect(orgLess.body).toEqual({ error: { code: 'ORG_MISSING' } })
  })

  it('settings|GET needs tasks:read and PATCH needs tasks:write: the other code alone is 403 and writes nothing', async () => {
    const stamp = stampOf()
    const orgId = orgOf('scode', stamp)
    const reader = await actor('scoder', stamp, orgId, ['tasks:read'])
    const writer = await actor('scodew', stamp, orgId, ['tasks:write'])
    const server = app()
    const denied = { error: 'Insufficient permissions' }
    const patch = await server.patch('/api/task-settings').set(auth(reader.bearer)).send({ badgeScope: 'off' })
    expect(patch.status).toBe(403)
    expect(patch.body).toEqual(denied)
    expect(await settingsRow(reader.userId, orgId)).toBeUndefined()
    const read = await server.get('/api/task-settings').set(auth(writer.bearer))
    expect(read.status).toBe(403)
    expect(read.body).toEqual(denied)
    expect((await server.get('/api/task-settings').set(auth(reader.bearer))).status).toBe(200)
    expect((await server.patch('/api/task-settings').set(auth(writer.bearer)).send({ badgeScope: 'off' })).status).toBe(200)
  })

  it('settings|a PATCH that meets another writer on the row merges onto that committed write', async () => {
    const stamp = stampOf()
    const orgId = orgOf('slock', stamp)
    const me = await actor('slock', stamp, orgId)
    const server = app()
    await server.patch('/api/task-settings').set(auth(me.bearer)).send({})
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM task_user_settings WHERE user_id = $1 AND org_id = $2 FOR UPDATE', [me.userId, orgId])
      await holder.query(`UPDATE task_user_settings SET badge_scope = 'off' WHERE user_id = $1 AND org_id = $2`, [me.userId, orgId])
      const pending = server.patch('/api/task-settings').set(auth(me.bearer)).send({ timeZone: 'UTC' }).then((res) => res)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await holder.query('COMMIT')
      const response = await pending
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ ...DEFAULT_SETTINGS, badgeScope: 'off', timeZone: 'UTC' })
    } finally {
      await holder.end()
    }
    const row = await settingsRow(me.userId, orgId)
    expect([row?.badge_scope, row?.time_zone]).toEqual(['off', 'UTC'])
  })

  it('settings|a PATCH waits for a key-share lock on the row (it takes a row lock before reading)', async () => {
    const stamp = stampOf()
    const orgId = orgOf('skey', stamp)
    const me = await actor('skey', stamp, orgId)
    const server = app()
    await server.patch('/api/task-settings').set(auth(me.bearer)).send({})
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let settled = false
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM task_user_settings WHERE user_id = $1 AND org_id = $2 FOR KEY SHARE', [me.userId, orgId])
      const pending = server.patch('/api/task-settings').set(auth(me.bearer)).send({ badgeScope: 'overdue_or_today' })
        .then((res) => { settled = true; return res })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(settled).toBe(false)
      await holder.query('COMMIT')
      const response = await pending
      expect(response.status).toBe(200)
      expect(response.body.badgeScope).toBe('overdue_or_today')
    } finally {
      await holder.end()
    }
  })
})

// ---------------------------------------------------------------------------------------------
// §8 badge_scope on /pending-count; /pending ignores it.
// ---------------------------------------------------------------------------------------------

describe('badge_scope', () => {
  async function overdueAndToday(label: string): Promise<{ me: SeededTaskActor; orgId: string; ids: string[] }> {
    // The badge cells count against one UTC date: the fixture is written at least a minute before
    // 00:00 UTC, or after it (it waits when it starts inside that minute), never skipped.
    const untilMidnight = Number((await poolManager.get().query(
      `SELECT (extract(epoch FROM (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') - (now() AT TIME ZONE 'UTC')) * 1000)::bigint AS ms`,
    )).rows[0].ms)
    if (untilMidnight < 60000) await new Promise((resolve) => setTimeout(resolve, untilMidnight + 2000))
    const stamp = stampOf()
    const orgId = orgOf(label, stamp)
    const me = await actor(label, stamp, orgId)
    const other = `usrO_${label}_${stamp}`
    const overdue = await createTask({ orgId, creatorId: other, title: '逾期', assignees: [me.userId], completionMode: 'all' })
    const today = await createTask({ orgId, creatorId: other, title: '今天', assignees: [me.userId], completionMode: 'all' })
    await poolManager.get().query(
      `UPDATE tasks SET due_date = ((now() AT TIME ZONE 'UTC')::date - 3), due_time = NULL, due_at = NULL, time_zone = 'UTC' WHERE id = $1`,
      [overdue.id],
    )
    await poolManager.get().query(
      `UPDATE tasks SET due_date = (now() AT TIME ZONE 'UTC')::date, due_time = NULL, due_at = NULL, time_zone = 'UTC' WHERE id = $1`,
      [today.id],
    )
    return { me, orgId, ids: [overdue.id, today.id] }
  }

  function count(server: TasksClient, who: SeededTaskActor) {
    return server.get('/api/tasks/pending-count').set(auth(who.bearer)).set('x-viewer-time-zone', 'UTC')
  }

  it('badge|no row counts overdue only and the body is exactly { count }', async () => {
    const { me } = await overdueAndToday('bnone')
    const response = await count(app(), me)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ count: 1 })
  }, 120000)

  it('badge|overdue_or_today (set through PATCH) also counts today; the body is exactly { count }', async () => {
    const { me } = await overdueAndToday('btoday')
    const server = app()
    await server.patch('/api/task-settings').set(auth(me.bearer)).send({ badgeScope: 'overdue_or_today' })
    const response = await count(server, me)
    expect(response.body).toEqual({ count: 2 })
    await server.patch('/api/task-settings').set(auth(me.bearer)).send({ badgeScope: 'overdue' })
    expect((await count(server, me)).body).toEqual({ count: 1 })
  }, 120000)

  it('badge|off answers { count: 0, badgeScope: off } while /pending still lists every open task', async () => {
    const { me, ids } = await overdueAndToday('boff')
    const server = app()
    await server.patch('/api/task-settings').set(auth(me.bearer)).send({ badgeScope: 'off' })
    const response = await count(server, me)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ count: 0, badgeScope: 'off' })
    const pending = await server.get('/api/tasks/pending').set(auth(me.bearer))
    expect(pending.body.total).toBe(2)
    expect(pending.body.items.map((row: { id: string }) => row.id).sort()).toEqual([...ids].sort())
  }, 120000)

  it('badge|a missing org keeps the M2 degraded body', async () => {
    const stamp = stampOf()
    const orgId = orgOf('bdeg', stamp)
    const me = await actor('bdeg', stamp, orgId)
    const response = await app().get('/api/tasks/pending-count').set(auth(orgLessBearer(me)))
    expect(response.body).toEqual({ count: 0, degraded: true, reason: 'org_missing' })
  })
})

// ---------------------------------------------------------------------------------------------
// §10.7 gate 13 for the settings routes: real MetaSheetServer, then the registration line
// commented out.
// ---------------------------------------------------------------------------------------------

describe('gate 13 (settings)', () => {
  const REGISTRATION = '  registerTaskSettingsRoutes(router)\n'

  function server(): express.Express {
    const instance = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [], manageProcessSignals: false })
    return (instance as unknown as { app: express.Express }).app
  }

  it('gate13|MetaSheetServer serves GET /api/task-settings to a non-admin; an unregistered sibling path is 404', async () => {
    const stamp = stampOf()
    const orgId = orgOf('g13p', stamp)
    const me = await actor('g13p', stamp, orgId, ['tasks:read'])
    const mounted = server()
    const settings = await request(mounted).get('/api/task-settings').set(auth(me.bearer))
    expect(settings.status).toBe(200)
    expect(settings.body).toEqual(DEFAULT_SETTINGS)
    const sibling = await request(mounted).get('/api/task-settings-not-a-route').set(auth(me.bearer))
    expect(sibling.status).toBe(404)
    // The registered route's own 404 (no org) is not the framework's: the negative control below can
    // tell the two apart.
    const orgLess = await request(mounted).get('/api/task-settings').set(auth(orgLessBearer(me)))
    expect(orgLess.status).toBe(404)
    const shape = (res: { text: string }, path: string) => res.text.split(path).join('<path>')
    expect(shape(orgLess, '/api/task-settings')).not.toBe(shape(sibling, '/api/task-settings-not-a-route'))
  })

  it('gate13|negative: with the registration line commented out the settings route is 404 and the router still mounts', async () => {
    const stamp = stampOf()
    const orgId = orgOf('g13n', stamp)
    const me = await actor('g13n', stamp, orgId, ['tasks:read'])
    runSourceMutant(ROUTES_FILE, REGISTRATION, `  // ${REGISTRATION.trimStart()}`, `
      const supertestMod = await import(${JSON.stringify(SUPERTEST_PATH)})
      const request = supertestMod.default ?? supertestMod
      const { MetaSheetServer } = await import(${JSON.stringify(INDEX_FILE)})
      const instance = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [], manageProcessSignals: false })
      const bearer = 'Bearer ' + process.env.G13_BEARER
      const settings = await request(instance.app).get('/api/task-settings').set('Authorization', bearer)
      const sibling = await request(instance.app).get('/api/task-settings-not-a-route').set('Authorization', bearer)
      const context = await request(instance.app).get('/api/tasks/context').set('Authorization', bearer)
      // The framework's 404 body names the path; with the path taken out it is the same for every
      // unregistered path, and differs from the route's own JSON 404.
      const shape = (res, path) => res.text.split(path).join('<path>')
      const unregistered = settings.status === 404 && shape(settings, '/api/task-settings') === shape(sibling, '/api/task-settings-not-a-route')
      const orgResolved = context.status === 200 && context.body.orgId === process.env.G13_ORG
      console.log(JSON.stringify({ gate13settings: 'red', settings: settings.status, unregistered, context: context.status, orgResolved }))
      process.exit(unregistered && orgResolved ? 0 : 1)
    `, { G13_BEARER: me.bearer, G13_ORG: orgId }, { unique: true, timeoutMs: 240000 })
  }, 300000)
})
