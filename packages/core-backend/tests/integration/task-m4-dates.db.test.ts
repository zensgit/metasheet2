import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import jwt from 'jsonwebtoken'
import { acquireTaskStructureLock } from '../../src/db/task-advisory-locks'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createTask } from '../../src/services/task-records'
import { viewerNextMidnight } from '../../src/tasks/task-dates'
import { TASK_DESCRIPTION_MAX_CODEPOINTS } from '../../src/tasks/task-edit'
import { dropTaskM4Fixtures, runSourceMutant, seedOrgMembers, seedTaskActor, signTaskToken, type SeededTaskActor } from '../helpers/task-m4-fixtures'
import { startTasksListener, tasksClient, type TasksClient, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M4 PR-3a S4 (design task-m4-pr3a-backend-design-20260930.md §5, §10.5, §10.6).
 * RULED(2026-10-07): [R03] POST accepts the date keys, `timeZone` and `remindAt`;
 * `PATCH /api/tasks/:id` edits them with a required `expectedVersion` (stale ⇒ 409 with
 * `currentVersion`); complete / reopen answer with `version`; the stored zone is the canonical name.
 * ASSUMPTION(task-m4): [own-05] [own-06] [own-07] [own-08] [own-18] [own-29] [own-30] [own-31]
 * [own-38] are the values the cells below pin.
 * The gate 8 cells are candidates for the `M4|8` row (design §10.0), not scored.
 * HTTP goes through `tasksRouter()` on one express listener per file (tests/helpers/tasks-http-harness.ts;
 * setup.integration.ts, RBAC_TOKEN_TRUST='true').
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-dates.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4dates_'
const seededUsers: string[] = []
const seededRoles: string[] = []

const req = createRequire(import.meta.url)
const EXPRESS_PATH = req.resolve('express')
const SUPERTEST_PATH = req.resolve('supertest')
const ROUTES_FILE = new URL('../../src/routes/tasks.ts', import.meta.url).pathname
const ACCESS_FILE = new URL('../../src/tasks/task-access.ts', import.meta.url).pathname

const SHANGHAI = 'Asia/Shanghai'

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function orgOf(label: string, stamp: string): string {
  return `${ORG_PREFIX}${label}_${stamp}`
}

async function actor(label: string, stamp: string, orgId: string): Promise<SeededTaskActor> {
  const seeded = await seedTaskActor({ label, stamp, orgId, codes: ['tasks:read', 'tasks:write'], admission: true })
  seededUsers.push(seeded.userId)
  seededRoles.push(seeded.roleId)
  return seeded
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

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return (value instanceof Date ? value : new Date(String(value))).toISOString()
}

/** The editable columns plus what a write would move, instants as ISO text. */
async function taskRow(taskId: string): Promise<Record<string, unknown>> {
  const result = await poolManager.get().query(
    `SELECT title, description, status, version,
            due_date::text AS due_date, due_time::text AS due_time,
            start_date::text AS start_date, start_time::text AS start_time,
            time_zone, due_at, remind_at, updated_at, deleted_at
     FROM tasks WHERE id = $1`,
    [taskId],
  )
  const row = result.rows[0] as Record<string, unknown>
  return {
    ...row,
    due_at: iso(row.due_at),
    remind_at: iso(row.remind_at),
    updated_at: iso(row.updated_at),
    deleted_at: iso(row.deleted_at),
  }
}

interface EventRow { type: string; actor: string; payload: unknown; at: string | null }

async function events(taskId: string): Promise<EventRow[]> {
  const result = await poolManager.get().query(
    `SELECT event_type, actor_id, payload, occurred_at FROM task_events WHERE task_id = $1 ORDER BY occurred_at, event_type`,
    [taskId],
  )
  return result.rows.map((row) => ({
    type: String(row.event_type), actor: String(row.actor_id), payload: row.payload, at: iso(row.occurred_at),
  }))
}

/** Task row and its events, for "nothing was written" assertions. */
async function snapshot(taskId: string): Promise<string> {
  return JSON.stringify({ row: await taskRow(taskId), events: await events(taskId) })
}

async function orgTaskCount(orgId: string): Promise<number> {
  const result = await poolManager.get().query(`SELECT count(*)::int AS n FROM tasks WHERE org_id = $1`, [orgId])
  return Number(result.rows[0].n)
}

interface Fixture { me: SeededTaskActor; orgId: string; stamp: string; id: string; server: TasksClient }

/** One actor and one task it created over HTTP (so the creator is also its assignee). */
async function fixture(label: string, body: Record<string, unknown> = {}): Promise<Fixture> {
  const stamp = stampOf()
  const orgId = orgOf(label, stamp)
  const me = await actor(label, stamp, orgId)
  const server = app()
  const created = await server.post('/api/tasks').set(auth(me.bearer)).send({ title: '备料复核', ...body })
  if (created.status !== 200) throw new Error(`fixture create failed: ${created.status} ${created.text}`)
  return { me, orgId, stamp, id: created.body.id, server }
}

/** A scheduled task: 2031-03-15 10:00 Asia/Shanghai, default reminder 09:30. */
const SCHEDULED = { dueDate: '2031-03-15', dueTime: '10:00', timeZone: SHANGHAI }
const SCHEDULED_DUE_AT = '2031-03-15T02:00:00.000Z'
const SCHEDULED_REMIND_AT = '2031-03-15T01:30:00.000Z'

/** Design §5.1 step 1. Each entry is merged with a valid zone. */
const TYPE_GATE: Array<[string, Record<string, unknown>]> = [
  ["dueTime ''", { dueDate: '2031-03-15', dueTime: '' }],
  ['dueTime 0', { dueDate: '2031-03-15', dueTime: 0 }],
  ['dueTime false', { dueDate: '2031-03-15', dueTime: false }],
  ["startTime ''", { startDate: '2031-03-15', startTime: '' }],
  ['startTime 0', { startDate: '2031-03-15', startTime: 0 }],
  ['startTime false', { startDate: '2031-03-15', startTime: false }],
  ["dueDate ['2031-03-15']", { dueDate: ['2031-03-15'] }],
  ['dueDate 20310315', { dueDate: 20310315 }],
  ['dueDate {}', { dueDate: {} }],
  ["startDate ['2031-03-15']", { startDate: ['2031-03-15'] }],
  ["dueDate ''", { dueDate: '' }],
]

afterAll(async () => {
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  await listener?.close()
})

// ---------------------------------------------------------------------------------------------
// POST /api/tasks with dates (design §5.2, §10.6).
// ---------------------------------------------------------------------------------------------

describe('POST /api/tasks dates', () => {
  it('m4dates|post|an all-day task is due at the local 23:59:59.999 and the body is { id, version: 1 }', async () => {
    const stamp = stampOf()
    const orgId = orgOf('pallday', stamp)
    const me = await actor('pallday', stamp, orgId)
    const response = await app().post('/api/tasks').set(auth(me.bearer)).send({ title: '备料复核', dueDate: '2031-03-15', timeZone: SHANGHAI })
    expect(response.status).toBe(200)
    expect(Object.keys(response.body).sort()).toEqual(['id', 'version'])
    expect(response.body.version).toBe(1)
    expect(await taskRow(response.body.id)).toMatchObject({
      version: 1, due_date: '2031-03-15', due_time: null, start_date: null, start_time: null,
      time_zone: SHANGHAI, due_at: '2031-03-15T15:59:59.999Z', description: null,
    })
  })

  it('m4dates|post|a scheduled task is due at that wall time in its zone; start fields and HH:MM are stored canonically', async () => {
    const f = await fixture('ptimed', { ...SCHEDULED, startDate: '2031-03-14', startTime: '08:30:15' })
    expect(await taskRow(f.id)).toMatchObject({
      due_date: '2031-03-15', due_time: '10:00:00', start_date: '2031-03-14', start_time: '08:30:15',
      time_zone: SHANGHAI, due_at: SCHEDULED_DUE_AT,
    })
    const detail = await f.server.get(`/api/tasks/${f.id}`).set(auth(f.me.bearer))
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({
      dueDate: '2031-03-15', dueTime: '10:00:00', timeZone: SHANGHAI, dueAt: SCHEDULED_DUE_AT,
      description: null, startDate: '2031-03-14', startTime: '08:30:15', remindAt: SCHEDULED_REMIND_AT, version: 1,
    })
  })

  it('m4dates|post|description is not a create field: it is ignored', async () => {
    const f = await fixture('pdesc', { description: '说明' })
    expect((await taskRow(f.id)).description).toBeNull()
  })

  const invalid: Array<[string, string, Record<string, unknown>]> = [
    ['a date without a zone', 'TIME_ZONE_REQUIRED', { dueDate: '2031-03-15' }],
    ['a start date with timeZone null', 'TIME_ZONE_REQUIRED', { startDate: '2031-03-15', timeZone: null }],
    ["a date with timeZone ''", 'TIME_ZONE_REQUIRED', { dueDate: '2031-03-15', timeZone: '' }],
    ['a time without its date', 'INVALID_DATE', { dueTime: '10:00', timeZone: SHANGHAI }],
    ['a start time without its date', 'INVALID_DATE', { startTime: '10:00', timeZone: SHANGHAI }],
    ['2031-02-30', 'INVALID_DATE', { dueDate: '2031-02-30', timeZone: SHANGHAI }],
    ['25:00', 'INVALID_DATE', { dueDate: '2031-03-15', dueTime: '25:00', timeZone: SHANGHAI }],
    ['a date with U+0000', 'INVALID_DATE', { dueDate: '2031-03-15\u0000', timeZone: SHANGHAI }],
    ['a time with a lone surrogate', 'INVALID_DATE', { dueDate: '2031-03-15', dueTime: '10:00\uD800', timeZone: SHANGHAI }],
    ['timeZone Not/AZone', 'INVALID_TIME_ZONE', { dueDate: '2031-03-15', timeZone: 'Not/AZone' }],
    ['timeZone +08:00', 'INVALID_TIME_ZONE', { dueDate: '2031-03-15', timeZone: '+08:00' }],
    ['timeZone 8', 'INVALID_TIME_ZONE', { dueDate: '2031-03-15', timeZone: 8 }],
    ['timeZone with U+0000', 'INVALID_TIME_ZONE', { dueDate: '2031-03-15', timeZone: 'Asia/Shanghai\u0000' }],
    ['timeZone with a lone surrogate', 'INVALID_TIME_ZONE', { timeZone: '\uDC00' }],
    ['remindAt without a zone', 'INVALID_REMIND_AT', { remindAt: '2031-03-15T10:00:00' }],
    ['remindAt 5', 'INVALID_REMIND_AT', { remindAt: 5 }],
    ['remindAt with U+0000', 'INVALID_REMIND_AT', { remindAt: '2031-03-15T10:00:00Z\u0000' }],
    // ASSUMPTION(task-m4): [own-38] the derived due instant stays inside years 0001–9999.
    ['a due instant after year 9999 (9999-12-31 all day, America/New_York)', 'INVALID_DATE', { dueDate: '9999-12-31', timeZone: 'America/New_York' }],
    ['a due instant after year 9999 (9999-12-31 23:00, America/Los_Angeles)', 'INVALID_DATE', { dueDate: '9999-12-31', dueTime: '23:00', timeZone: 'America/Los_Angeles' }],
    ...TYPE_GATE.map(([label, body]): [string, string, Record<string, unknown>] => [`type gate ${label}`, 'INVALID_DATE', { ...body, timeZone: SHANGHAI }]),
  ]

  it.each(invalid)('m4dates|post|%s is 422 %s and no row is created', async (label, code, body) => {
    const stamp = stampOf()
    const orgId = orgOf('pbad', stamp)
    const me = await actor('pbad', stamp, orgId)
    const response = await app().post('/api/tasks').set(auth(me.bearer)).send({ title: '备料复核', ...body })
    expect(response.status, label).toBe(422)
    expect(response.body).toEqual({ error: { code } })
    expect(await orgTaskCount(orgId)).toBe(0)
  })

  it('m4dates|gate8|post: the same body with Asia/Shanghai is 200, and a case variant is stored under the canonical name', async () => {
    const stamp = stampOf()
    const orgId = orgOf('pzone', stamp)
    const me = await actor('pzone', stamp, orgId)
    const server = app()
    const bad = await server.post('/api/tasks').set(auth(me.bearer)).send({ title: '备料复核', dueDate: '2031-03-15', timeZone: 'Not/AZone' })
    expect(bad.status).toBe(422)
    expect(bad.body).toEqual({ error: { code: 'INVALID_TIME_ZONE' } })
    expect(await orgTaskCount(orgId)).toBe(0)
    const good = await server.post('/api/tasks').set(auth(me.bearer)).send({ title: '备料复核', dueDate: '2031-03-15', timeZone: SHANGHAI })
    expect(good.status).toBe(200)
    const variant = await server.post('/api/tasks').set(auth(me.bearer)).send({ title: '备料复核', dueDate: '2031-03-15', timeZone: 'asia/shanghai' })
    expect(variant.status).toBe(200)
    expect((await taskRow(variant.body.id)).time_zone).toBe(SHANGHAI)
    expect((await taskRow(variant.body.id)).due_at).toBe((await taskRow(good.body.id)).due_at)
  })
})

describe('create-time remind_at (lock §4.4 default)', () => {
  it('m4dates|remind|scheduled: due_at minus thirty minutes, and only a `created` event', async () => {
    const f = await fixture('rtimed', SCHEDULED)
    expect((await taskRow(f.id)).remind_at).toBe(SCHEDULED_REMIND_AT)
    expect((await events(f.id)).map((event) => event.type)).toEqual(['created'])
  })

  it('m4dates|remind|all-day: 18:00 in the task zone, whatever the viewer header says', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rallday', stamp)
    const me = await actor('rallday', stamp, orgId)
    const server = app()
    const body = { title: '备料复核', dueDate: '2031-03-15', timeZone: SHANGHAI }
    const plain = await server.post('/api/tasks').set(auth(me.bearer)).send(body)
    const viewed = await server.post('/api/tasks').set(auth(me.bearer)).set('x-viewer-time-zone', 'America/New_York').send(body)
    expect(plain.status).toBe(200)
    expect(viewed.status).toBe(200)
    expect((await taskRow(plain.body.id)).remind_at).toBe('2031-03-15T10:00:00.000Z')
    expect((await taskRow(viewed.body.id)).remind_at).toBe('2031-03-15T10:00:00.000Z')
  })

  it('m4dates|remind|a 00:10 due time puts the reminder on the previous local day', async () => {
    const f = await fixture('rearly', { dueDate: '2031-03-15', dueTime: '00:10', timeZone: SHANGHAI })
    expect(await taskRow(f.id)).toMatchObject({ due_at: '2031-03-14T16:10:00.000Z', remind_at: '2031-03-14T15:40:00.000Z' })
  })

  it('m4dates|remind|policy none: NULL; the policy is the creator\'s own row in this org', async () => {
    const stamp = stampOf()
    const orgId = orgOf('rnone', stamp)
    const me = await actor('rnone', stamp, orgId)
    const peer = await actor('rnonep', stamp, orgId)
    const server = app()
    const set = await server.patch('/api/task-settings').set(auth(me.bearer)).send({ defaultRemindPolicy: { mode: 'none' } })
    expect(set.status).toBe(200)
    const mine = await server.post('/api/tasks').set(auth(me.bearer)).send({ title: '备料复核', ...SCHEDULED })
    const theirs = await server.post('/api/tasks').set(auth(peer.bearer)).send({ title: '备料复核', ...SCHEDULED })
    // Same user, another org: that org has no settings row, so the default policy applies there.
    const elsewhere = await server.post('/api/tasks')
      .set(auth(signTaskToken(me.userId, me.roleId, orgOf('rnoneB', stamp))))
      .send({ title: '备料复核', ...SCHEDULED })
    expect(elsewhere.status).toBe(200)
    expect((await taskRow(mine.body.id)).remind_at).toBeNull()
    expect((await taskRow(theirs.body.id)).remind_at).toBe(SCHEDULED_REMIND_AT)
    expect((await taskRow(elsewhere.body.id)).remind_at).toBe(SCHEDULED_REMIND_AT)
  })

  it('m4dates|remind|explicit null is NULL, an explicit instant is stored as sent (a past one too), no due date is NULL', async () => {
    const explicitNull = await fixture('rnull', { ...SCHEDULED, remindAt: null })
    expect((await taskRow(explicitNull.id)).remind_at).toBeNull()
    const instant = await fixture('rinst', { ...SCHEDULED, remindAt: '2020-01-01T08:00:00+08:00' })
    expect((await taskRow(instant.id)).remind_at).toBe('2020-01-01T00:00:00.000Z')
    const undated = await fixture('rundated', { remindAt: '2031-03-01T00:00:00Z' })
    expect(await taskRow(undated.id)).toMatchObject({ remind_at: '2031-03-01T00:00:00.000Z', due_at: null, time_zone: null })
    const nothing = await fixture('rnothing')
    expect((await taskRow(nothing.id)).remind_at).toBeNull()
    for (const f of [explicitNull, instant, undated, nothing]) {
      expect((await events(f.id)).map((event) => event.type)).toEqual(['created'])
    }
  })
})

// ---------------------------------------------------------------------------------------------
// PATCH /api/tasks/:id (design §5.3, §10.6).
// ---------------------------------------------------------------------------------------------

describe('PATCH /api/tasks/:id version', () => {
  it.each([
    ['missing', {}],
    ['a numeric string', { expectedVersion: '1' }],
    ['zero', { expectedVersion: 0 }],
    ['a fraction', { expectedVersion: 1.5 }],
    ['null', { expectedVersion: null }],
    ['an array body', [{ expectedVersion: 1 }]],
  ])('m4dates|patch|expectedVersion %s is 422 INVALID_VERSION and nothing is written', async (_label, body) => {
    const f = await fixture('vbad', SCHEDULED)
    const before = await snapshot(f.id)
    const response = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send(body as object)
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code: 'INVALID_VERSION' } })
    expect(await snapshot(f.id)).toBe(before)
  })

  it('m4dates|patch|a stale expectedVersion is 409 with the stored currentVersion, before any field check', async () => {
    const f = await fixture('vstale', SCHEDULED)
    const first = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, title: '第二版' })
    expect(first.status).toBe(200)
    expect(first.body).toEqual({ id: f.id, version: 2 })
    const before = await snapshot(f.id)
    for (const body of [
      { expectedVersion: 1, title: '第三版' },
      { expectedVersion: 3, title: '第三版' },
      { expectedVersion: 1, title: null, dueDate: 0 },
    ]) {
      const stale = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send(body)
      expect(stale.status).toBe(409)
      expect(stale.body).toEqual({ error: { code: 'VERSION_CONFLICT' }, currentVersion: 2 })
    }
    expect((await taskRow(f.id)).version).toBe(2)
    expect(await snapshot(f.id)).toBe(before)
  })

  it('m4dates|patch|replaying a successful request is 409; a request equal to the stored values is a no-op', async () => {
    const f = await fixture('vreplay', SCHEDULED)
    const body = { expectedVersion: 1, title: '第二版' }
    expect((await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send(body)).status).toBe(200)
    const replay = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send(body)
    expect(replay.status).toBe(409)
    expect(replay.body).toEqual({ error: { code: 'VERSION_CONFLICT' }, currentVersion: 2 })
    const before = await snapshot(f.id)
    const same = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({
      expectedVersion: 2, title: ' 第二版 ', dueDate: '2031-03-15', dueTime: '10:00', timeZone: 'asia/shanghai',
      remindAt: '2031-03-15T09:30:00+08:00', description: '', unknownKey: { nested: true },
    })
    expect(same.status).toBe(200)
    expect(same.body).toEqual({ id: f.id, version: 2 })
    expect(await snapshot(f.id)).toBe(before)
    const empty = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 2 })
    expect(empty.status).toBe(200)
    expect(empty.body).toEqual({ id: f.id, version: 2 })
    expect(await snapshot(f.id)).toBe(before)
  })

  it('m4dates|patch|three fields in one request: version moves by exactly one, one event per changed surface, actor is the caller', async () => {
    const f = await fixture('vthree', SCHEDULED)
    const before = await taskRow(f.id)
    const response = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({
      expectedVersion: 1, title: '第二版', description: '  说明\n第二行  ', dueDate: '2031-03-20', timeZone: SHANGHAI,
    })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ id: f.id, version: 2 })
    const after = await taskRow(f.id)
    expect(after).toMatchObject({
      title: '第二版', description: '  说明\n第二行  ', version: 2, due_date: '2031-03-20', due_time: '10:00:00',
      due_at: '2031-03-20T02:00:00.000Z', time_zone: SHANGHAI, remind_at: SCHEDULED_REMIND_AT,
    })
    expect(String(after.updated_at) > String(before.updated_at)).toBe(true)
    const written = (await events(f.id)).filter((event) => event.type !== 'created')
    expect(written.map((event) => event.type).sort()).toEqual(['description_changed', 'due_changed', 'title_changed'])
    expect(new Set(written.map((event) => event.actor))).toEqual(new Set([f.me.userId]))
    expect(new Set(written.map((event) => event.at)).size).toBe(1)
    for (const event of written) expect(event.payload).toEqual({})
  })

  it('m4dates|patch|updated_at and the events are one clock reading taken after the structure lock: later than a write that committed while the PATCH waited', async () => {
    const f = await fixture('vstamp', SCHEDULED)
    const db = poolManager.get()
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    let holderAt = ''
    try {
      await holder.query('BEGIN')
      await acquireTaskStructureLock((sql, params) => holder.query(sql, params), f.orgId)
      const pending = f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, title: '第二版' }).then((res) => res)
      const deadline = Date.now() + 15000
      for (;;) {
        const waiting = await db.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)
        if (waiting.rows[0].n > 0) break
        if (Date.now() > deadline) throw new Error('the PATCH never queued on the structure lock')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      holderAt = String((await holder.query('SELECT clock_timestamp()::text AS at')).rows[0].at)
      await holder.query('COMMIT')
      const response = await pending
      expect(response.body).toEqual({ id: f.id, version: 2 })
    } finally {
      await holder.end()
    }
    const stamps = await db.query(
      `SELECT t.updated_at > $2::timestamptz AS after_holder,
              bool_and(e.occurred_at = t.updated_at) AS events_share_it,
              count(*)::int AS n
         FROM tasks t JOIN task_events e ON e.task_id = t.id AND e.event_type <> 'created'
        WHERE t.id = $1
        GROUP BY t.updated_at`,
      [f.id, holderAt],
    )
    expect(stamps.rows).toEqual([{ after_holder: true, events_share_it: true, n: 1 }])
  }, 60000)

  it('m4dates|patch|two concurrent requests with the same expectedVersion: exactly one 200 and one 409', async () => {
    const f = await fixture('vrace', SCHEDULED)
    const send = (title: string) => f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, title })
    const [left, right] = await Promise.all([send('甲'), send('乙')])
    expect([left.status, right.status].sort()).toEqual([200, 409])
    const winner = left.status === 200 ? left : right
    const loser = left.status === 200 ? right : left
    expect(winner.body).toEqual({ id: f.id, version: 2 })
    expect(loser.body).toEqual({ error: { code: 'VERSION_CONFLICT' }, currentVersion: 2 })
    const row = await taskRow(f.id)
    expect(row.version).toBe(2)
    expect(row.title).toBe(left.status === 200 ? '甲' : '乙')
    expect((await events(f.id)).map((event) => event.type).sort()).toEqual(['created', 'title_changed'])
  })
})

describe('PATCH /api/tasks/:id dates and reminder', () => {
  it('m4dates|patch|changing the due date without timeZone is 422 TIME_ZONE_REQUIRED; with it, 200', async () => {
    const f = await fixture('dzone', SCHEDULED)
    const before = await snapshot(f.id)
    for (const body of [{ dueDate: '2031-03-20' }, { dueTime: '11:00' }, { startDate: '2031-03-14' }, { dueDate: '2031-03-20', timeZone: null }, { dueDate: '2031-03-20', timeZone: '' }]) {
      const response = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, ...body })
      expect(response.status, JSON.stringify(body)).toBe(422)
      expect(response.body).toEqual({ error: { code: 'TIME_ZONE_REQUIRED' } })
    }
    expect(await snapshot(f.id)).toBe(before)
    const ok = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, dueDate: '2031-03-20', timeZone: SHANGHAI })
    expect(ok.status).toBe(200)
  })

  it('m4dates|patch|moving the due date without remindAt leaves remind_at where it was and writes no remind_changed', async () => {
    const f = await fixture('dremind', SCHEDULED)
    const response = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, dueDate: '2031-04-01', dueTime: '18:00', timeZone: SHANGHAI })
    expect(response.status).toBe(200)
    expect(await taskRow(f.id)).toMatchObject({ due_at: '2031-04-01T10:00:00.000Z', remind_at: SCHEDULED_REMIND_AT, version: 2 })
    expect((await events(f.id)).map((event) => event.type).sort()).toEqual(['created', 'due_changed'])
  })

  it('m4dates|patch|remindAt: an instant sets it, null clears it, each writes one remind_changed; the same instant is a no-op', async () => {
    const f = await fixture('dremset', SCHEDULED)
    const set = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, remindAt: '2031-03-14T20:00:00+08:00' })
    expect(set.body).toEqual({ id: f.id, version: 2 })
    expect(await taskRow(f.id)).toMatchObject({ remind_at: '2031-03-14T12:00:00.000Z', due_at: SCHEDULED_DUE_AT })
    const same = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 2, remindAt: '2031-03-14T12:00:00Z' })
    expect(same.body).toEqual({ id: f.id, version: 2 })
    const cleared = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 2, remindAt: null })
    expect(cleared.body).toEqual({ id: f.id, version: 3 })
    expect((await taskRow(f.id)).remind_at).toBeNull()
    const written = await events(f.id)
    expect(written.map((event) => event.type).sort()).toEqual(['created', 'remind_changed', 'remind_changed'])
    expect(written.every((event) => event.actor === f.me.userId)).toBe(true)
  })

  it('m4dates|patch|a timeZone-only request recomputes due_at and writes due_changed', async () => {
    const f = await fixture('dzonly', SCHEDULED)
    const response = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, timeZone: 'utc' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ id: f.id, version: 2 })
    expect(await taskRow(f.id)).toMatchObject({
      due_date: '2031-03-15', due_time: '10:00:00', time_zone: 'UTC', due_at: '2031-03-15T10:00:00.000Z', remind_at: SCHEDULED_REMIND_AT,
    })
    expect((await events(f.id)).map((event) => event.type).sort()).toEqual(['created', 'due_changed'])
  })

  it('m4dates|patch|a timeZone-only request on a task with no dates moves version and writes no event', async () => {
    const f = await fixture('dznodate')
    const response = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, timeZone: SHANGHAI })
    expect(response.body).toEqual({ id: f.id, version: 2 })
    expect(await taskRow(f.id)).toMatchObject({ time_zone: SHANGHAI, due_at: null, version: 2 })
    expect((await events(f.id)).map((event) => event.type)).toEqual(['created'])
  })

  it('m4dates|patch|clearing: a date alone is 422 while its time is stored; date and time together clear due_at and keep the zone; removing the zone from a dated task is 422', async () => {
    const f = await fixture('dclear', { ...SCHEDULED, startDate: '2031-03-14' })
    const before = await snapshot(f.id)
    const alone = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, dueDate: null, timeZone: SHANGHAI })
    expect(alone.status).toBe(422)
    expect(alone.body).toEqual({ error: { code: 'INVALID_DATE' } })
    const noZone = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, timeZone: null })
    expect(noZone.status).toBe(422)
    expect(noZone.body).toEqual({ error: { code: 'TIME_ZONE_REQUIRED' } })
    expect(await snapshot(f.id)).toBe(before)
    const both = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, dueDate: null, dueTime: null, timeZone: SHANGHAI })
    expect(both.body).toEqual({ id: f.id, version: 2 })
    expect(await taskRow(f.id)).toMatchObject({
      due_date: null, due_time: null, due_at: null, start_date: '2031-03-14', time_zone: SHANGHAI, remind_at: SCHEDULED_REMIND_AT,
    })
    const rest = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 2, startDate: null, timeZone: null })
    expect(rest.body).toEqual({ id: f.id, version: 3 })
    expect(await taskRow(f.id)).toMatchObject({ start_date: null, time_zone: null, due_at: null })
    expect((await events(f.id)).map((event) => event.type).sort()).toEqual(['created', 'due_changed', 'start_changed'])
  })

  // S4-T2 / S4-T3: an absent key keeps the stored column.
  it('m4dates|patch|absent keys keep the stored columns: a description-only PATCH, then a title-only PATCH, change only that column', async () => {
    const f = await fixture('dkeep', { ...SCHEDULED, startDate: '2031-03-14', startTime: '08:30', remindAt: '2031-03-14T20:00:00+08:00' })
    const strip = (row: Record<string, unknown>, ...keys: string[]) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)))
    const before = await taskRow(f.id)
    expect(before).toMatchObject({
      due_time: '10:00:00', start_date: '2031-03-14', start_time: '08:30:00', remind_at: '2031-03-14T12:00:00.000Z', description: null,
    })
    const first = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, description: '说明' })
    expect(first.body).toEqual({ id: f.id, version: 2 })
    const afterDescription = await taskRow(f.id)
    expect(afterDescription.description).toBe('说明')
    expect(strip(afterDescription, 'description', 'version', 'updated_at')).toEqual(strip(before, 'description', 'version', 'updated_at'))
    const second = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 2, title: '第二版' })
    expect(second.body).toEqual({ id: f.id, version: 3 })
    const afterTitle = await taskRow(f.id)
    expect(afterTitle.title).toBe('第二版')
    expect(strip(afterTitle, 'title', 'version', 'updated_at')).toEqual(strip(afterDescription, 'title', 'version', 'updated_at'))
    expect((await events(f.id)).map((event) => event.type).sort()).toEqual(['created', 'description_changed', 'title_changed'])
  })

  // ASSUMPTION(task-m4): [own-38]
  it('m4dates|patch|the last date east of UTC is 200; a zone change that moves its due instant past year 9999 is 422 and the row is unchanged', async () => {
    const f = await fixture('dlast', { dueDate: '9999-12-31', timeZone: 'Asia/Tokyo' })
    expect(await taskRow(f.id)).toMatchObject({
      due_date: '9999-12-31', time_zone: 'Asia/Tokyo', due_at: '9999-12-31T14:59:59.999Z', remind_at: '9999-12-31T09:00:00.000Z',
    })
    const before = await snapshot(f.id)
    const moved = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, timeZone: 'America/New_York' })
    expect(moved.status).toBe(422)
    expect(moved.body).toEqual({ error: { code: 'INVALID_DATE' } })
    expect(await snapshot(f.id)).toBe(before)
  })

  it("m4dates|patch|description: stored as sent, '' and null store NULL, the bound is in code points", async () => {
    const f = await fixture('ddesc')
    const limit = '😀'.repeat(TASK_DESCRIPTION_MAX_CODEPOINTS)
    const set = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, description: limit })
    expect(set.body).toEqual({ id: f.id, version: 2 })
    expect((await taskRow(f.id)).description).toBe(limit)
    const before = await snapshot(f.id)
    const over = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 2, description: `${limit}a` })
    expect(over.status).toBe(422)
    expect(over.body).toEqual({ error: { code: 'INVALID_DESCRIPTION' } })
    expect(await snapshot(f.id)).toBe(before)
    const emptied = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 2, description: '' })
    expect(emptied.body).toEqual({ id: f.id, version: 3 })
    expect((await taskRow(f.id)).description).toBeNull()
    const again = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 3, description: null })
    expect(again.body).toEqual({ id: f.id, version: 3 })
    const detail = await f.server.get(`/api/tasks/${f.id}`).set(auth(f.me.bearer))
    expect(detail.body).toMatchObject({ description: null, startDate: null, startTime: null, remindAt: null, version: 3 })
  })

  it('m4dates|patch|the detail returns the four added keys after an edit', async () => {
    const f = await fixture('ddetail')
    const response = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({
      expectedVersion: 1, description: '说明', startDate: '2031-03-14', startTime: '08:30', timeZone: SHANGHAI, remindAt: '2031-03-14T00:00:00Z',
    })
    expect(response.body).toEqual({ id: f.id, version: 2 })
    const detail = await f.server.get(`/api/tasks/${f.id}`).set(auth(f.me.bearer))
    expect(detail.body).toMatchObject({
      description: '说明', startDate: '2031-03-14', startTime: '08:30:00', remindAt: '2031-03-14T00:00:00.000Z',
      dueDate: null, dueAt: null, timeZone: SHANGHAI, version: 2,
    })
    expect((await events(f.id)).map((event) => event.type).sort()).toEqual(['created', 'description_changed', 'remind_changed', 'start_changed'])
  })
})

describe('PATCH /api/tasks/:id 422 cells', () => {
  const invalid: Array<[string, string, Record<string, unknown>]> = [
    ...TYPE_GATE.map(([label, body]): [string, string, Record<string, unknown>] => [`type gate ${label}`, 'INVALID_DATE', { ...body, timeZone: SHANGHAI }]),
    ['2031-02-30', 'INVALID_DATE', { dueDate: '2031-02-30', timeZone: SHANGHAI }],
    ['25:00', 'INVALID_DATE', { dueTime: '25:00', timeZone: SHANGHAI }],
    ['a start time without its date', 'INVALID_DATE', { startTime: '08:00', timeZone: SHANGHAI }],
    ['a date with U+0000', 'INVALID_DATE', { dueDate: '2031-03-20\u0000', timeZone: SHANGHAI }],
    ['a date with a lone surrogate', 'INVALID_DATE', { dueDate: '2031-03-20\uD800', timeZone: SHANGHAI }],
    ['timeZone Not/AZone', 'INVALID_TIME_ZONE', { timeZone: 'Not/AZone' }],
    ['timeZone +08:00', 'INVALID_TIME_ZONE', { timeZone: '+08:00' }],
    ['timeZone 8', 'INVALID_TIME_ZONE', { timeZone: 8 }],
    ['timeZone with U+0000', 'INVALID_TIME_ZONE', { timeZone: 'Asia/Shanghai\u0000' }],
    ['timeZone with a lone surrogate', 'INVALID_TIME_ZONE', { timeZone: 'Asia/\uD800' }],
    ['title null', 'INVALID_TITLE', { title: null }],
    ['title blank', 'INVALID_TITLE', { title: ' 　 ' }],
    ['title 5', 'INVALID_TITLE', { title: 5 }],
    ['title with U+0000', 'INVALID_TITLE', { title: '备料\u0000复核' }],
    ['title with a lone surrogate', 'INVALID_TITLE', { title: '备料\uD83D复核' }],
    ['description 5', 'INVALID_DESCRIPTION', { description: 5 }],
    ['description with U+0000', 'INVALID_DESCRIPTION', { description: '说明\u0000' }],
    ['description with a lone surrogate', 'INVALID_DESCRIPTION', { description: '\uDE00说明' }],
    ['remindAt without a zone', 'INVALID_REMIND_AT', { remindAt: '2031-03-15T10:00:00' }],
    ['remindAt 5', 'INVALID_REMIND_AT', { remindAt: 5 }],
    ['remindAt 2031-02-30', 'INVALID_REMIND_AT', { remindAt: '2031-02-30T10:00:00Z' }],
    ['remindAt with U+0000', 'INVALID_REMIND_AT', { remindAt: '2031-03-15T10:00:00Z\u0000' }],
    // ASSUMPTION(task-m4): [own-38]
    ['a due instant after year 9999 (9999-12-31 23:30, America/New_York)', 'INVALID_DATE', { dueDate: '9999-12-31', dueTime: '23:30', timeZone: 'America/New_York' }],
  ]

  it.each(invalid)('m4dates|patch|%s is 422 %s, not 500, and the row is unchanged', async (label, code, body) => {
    const f = await fixture('xbad', SCHEDULED)
    const before = await snapshot(f.id)
    const response = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, ...body })
    expect(response.status, label).toBe(422)
    expect(response.body).toEqual({ error: { code } })
    expect(await snapshot(f.id)).toBe(before)
  })

  it('m4dates|gate8|patch: Not/AZone is 422 with the row unchanged; Asia/Shanghai is 200; a case variant is stored under the canonical name', async () => {
    const f = await fixture('xzone')
    const before = await snapshot(f.id)
    const bad = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, dueDate: '2031-03-15', timeZone: 'Not/AZone' })
    expect(bad.status).toBe(422)
    expect(bad.body).toEqual({ error: { code: 'INVALID_TIME_ZONE' } })
    expect(await snapshot(f.id)).toBe(before)
    const good = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, dueDate: '2031-03-15', timeZone: SHANGHAI })
    expect(good.status).toBe(200)
    expect((await taskRow(f.id)).time_zone).toBe(SHANGHAI)
    const g = await fixture('xzonev')
    const variant = await g.server.patch(`/api/tasks/${g.id}`).set(auth(g.me.bearer)).send({ expectedVersion: 1, dueDate: '2031-03-15', timeZone: 'asia/shanghai' })
    expect(variant.status).toBe(200)
    expect(await taskRow(g.id)).toMatchObject({ time_zone: SHANGHAI, due_at: '2031-03-15T15:59:59.999Z' })
  })
})

describe('PATCH /api/tasks/:id row-level 404', () => {
  /** Bodies that would be 200, 409 and 422 on a task the caller can edit. */
  const BODIES: object[] = [
    { expectedVersion: 1, title: '第二版' },
    { expectedVersion: 9, title: '第二版' },
    { title: null, dueDate: 0 },
    {},
  ]

  async function expectMissing(server: TasksClient, bearer: string, taskId: string, stamp: string): Promise<void> {
    for (const body of BODIES) {
      const response = await server.patch(`/api/tasks/${taskId}`).set(auth(bearer)).send(body)
      const absent = await server.patch(`/api/tasks/tsk_missing_${stamp}`).set(auth(bearer)).send(body)
      expect(response.status, JSON.stringify(body)).toBe(404)
      expect(absent.status).toBe(404)
      expect(response.text).toBe(absent.text)
      expect(response.body).toEqual({ error: { code: 'NOT_FOUND' } })
    }
  }

  it('m4dates|patch|a same-org user with no role, and a follower, get the missing-id 404 for every body; the row is unchanged', async () => {
    const f = await fixture('nrole', SCHEDULED)
    const stranger = await actor('nroles', f.stamp, f.orgId)
    const follower = await actor('nrolef', f.stamp, f.orgId)
    await poolManager.get().query(`INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)`, [f.id, follower.userId])
    const before = await snapshot(f.id)
    await expectMissing(f.server, stranger.bearer, f.id, f.stamp)
    await expectMissing(f.server, follower.bearer, f.id, f.stamp)
    expect(await snapshot(f.id)).toBe(before)
    const detail = await f.server.get(`/api/tasks/${f.id}`).set(auth(follower.bearer))
    expect(detail.status).toBe(200)
    expect(detail.body.canEdit).toBe(false)
  })

  it('m4dates|patch|an assignee who is not the creator can edit (positive control)', async () => {
    const stamp = stampOf()
    const orgId = orgOf('nassg', stamp)
    const assignee = await actor('nassg', stamp, orgId)
    const created = await createTask({ orgId, creatorId: `usrO_nassg_${stamp}`, title: '备料复核', assignees: [assignee.userId] })
    const response = await app().patch(`/api/tasks/${created.id}`).set(auth(assignee.bearer)).send({ expectedVersion: created.version, title: '第二版' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ id: created.id, version: 2 })
    expect((await events(created.id)).filter((event) => event.type === 'title_changed').map((event) => event.actor)).toEqual([assignee.userId])
  })

  it('m4dates|patch|second tenant: the creator with a token for org A gets 404 on the org B task and the row is unchanged; the org B token edits it', async () => {
    const stamp = stampOf()
    const orgA = orgOf('ntenA', stamp)
    const orgB = orgOf('ntenB', stamp)
    const me = await actor('nten', stamp, orgA)
    const inA = await createTask({ orgId: orgA, creatorId: me.userId, title: '备料复核', assignees: [] })
    const inB = await createTask({ orgId: orgB, creatorId: me.userId, title: '备料复核', assignees: [] })
    const server = app()
    const before = await snapshot(inB.id)
    await expectMissing(server, me.bearer, inB.id, stamp)
    expect(await snapshot(inB.id)).toBe(before)
    const own = await server.patch(`/api/tasks/${inA.id}`).set(auth(me.bearer)).send({ expectedVersion: 1, title: '甲' })
    expect(own.status).toBe(200)
    const other = await server.patch(`/api/tasks/${inB.id}`).set(auth(signTaskToken(me.userId, me.roleId, orgB))).send({ expectedVersion: 1, title: '乙' })
    expect(other.status).toBe(200)
    expect((await taskRow(inA.id)).title).toBe('甲')
    expect((await taskRow(inB.id)).title).toBe('乙')
  })

  it('m4dates|patch|a soft-deleted task is the missing-id 404 and stays as it was', async () => {
    const f = await fixture('ndel', SCHEDULED)
    await poolManager.get().query(`UPDATE tasks SET deleted_at = now() WHERE id = $1`, [f.id])
    const before = await snapshot(f.id)
    await expectMissing(f.server, f.me.bearer, f.id, f.stamp)
    expect(await snapshot(f.id)).toBe(before)
  })

  it('m4dates|patch|a path id outside the printable set is the missing-id 404, not 500', async () => {
    const f = await fixture('nid', SCHEDULED)
    const absent = await f.server.patch(`/api/tasks/tsk_missing_${f.stamp}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, title: '第二版' })
    expect(absent.status).toBe(404)
    for (const raw of ['tsk_%00', `${f.id}%00`, 'tsk%20a', '%E5%A4%87%E6%96%99']) {
      const response = await f.server.patch(`/api/tasks/${raw}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, title: '第二版' })
      expect(response.status, raw).toBe(404)
      expect(response.text).toBe(absent.text)
    }
    expect((await taskRow(f.id)).version).toBe(1)
  })

  it('m4dates|patch|a token without an org is 422 ORG_MISSING and nothing is written', async () => {
    const f = await fixture('norg', SCHEDULED)
    const orgLess = jwt.sign({
      userId: f.me.userId, sub: f.me.userId, email: `${f.me.userId}@tasks-m4.test`, role: 'user', roles: [f.me.roleId],
    }, String(process.env.JWT_SECRET), { expiresIn: '1h' })
    const before = await snapshot(f.id)
    const response = await f.server.patch(`/api/tasks/${f.id}`).set(auth(orgLess)).send({ expectedVersion: 1, title: '第二版' })
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ error: { code: 'ORG_MISSING' } })
    expect(await snapshot(f.id)).toBe(before)
  })
})

describe('PATCH /api/tasks/:id permission code', () => {
  // The caller is the task's creator, so only the route guard stands between it and the edit.
  it('m4dates|patch|the route requires tasks:write: a creator whose role holds only tasks:read gets the same 403 for its task and a missing id; nothing is written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('pcode', stamp)
    const reader = await seedTaskActor({ label: 'pcode', stamp, orgId, codes: ['tasks:read'], admission: true })
    seededUsers.push(reader.userId)
    seededRoles.push(reader.roleId)
    const created = await createTask({ orgId, creatorId: reader.userId, title: '备料复核', assignees: [] })
    const before = await snapshot(created.id)
    const body = { expectedVersion: 1, title: '第二版' }
    const real = await app().patch(`/api/tasks/${created.id}`).set(auth(reader.bearer)).send(body)
    const absent = await app().patch(`/api/tasks/tsk_missing_${stamp}`).set(auth(reader.bearer)).send(body)
    expect(real.status).toBe(403)
    expect(real.body).toEqual({ error: 'Insufficient permissions' })
    expect(real.text).toBe(absent.text)
    expect(await snapshot(created.id)).toBe(before)
    const detail = await app().get(`/api/tasks/${created.id}`).set(auth(reader.bearer))
    expect(detail.status).toBe(200)
    expect(detail.body.canEdit).toBe(true)
  })
})

describe('complete / reopen answer with version (design §5.4)', () => {
  it('m4dates|version|complete flips and answers version + 1; reopen flips back and answers + 1 again; the value is usable as expectedVersion', async () => {
    const f = await fixture('cver')
    const done = await f.server.post(`/api/tasks/${f.id}/complete`).set(auth(f.me.bearer)).send({})
    expect(done.body).toEqual({ done: true, version: 2 })
    const again = await f.server.post(`/api/tasks/${f.id}/complete`).set(auth(f.me.bearer)).send({})
    expect(again.body).toEqual({ done: true, version: 2 })
    const stale = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: 1, title: '第二版' })
    expect(stale.status).toBe(409)
    expect(stale.body).toEqual({ error: { code: 'VERSION_CONFLICT' }, currentVersion: 2 })
    const edited = await f.server.patch(`/api/tasks/${f.id}`).set(auth(f.me.bearer)).send({ expectedVersion: done.body.version, title: '第二版' })
    expect(edited.body).toEqual({ id: f.id, version: 3 })
    const reopened = await f.server.post(`/api/tasks/${f.id}/reopen`).set(auth(f.me.bearer)).send({ scope: 'all' })
    expect(reopened.body).toEqual({ ok: true, version: 4 })
    expect((await taskRow(f.id)).version).toBe(4)
  })

  it('m4dates|version|a completion that does not flip the task answers the unchanged version', async () => {
    const stamp = stampOf()
    const orgId = orgOf('cnoflip', stamp)
    const me = await actor('cnoflip', stamp, orgId)
    // RULED(2026-10-07): [N2] the second assignee must be an active org member.
    await seedOrgMembers(orgId, [`usrO_cnoflip_${stamp}`])
    seededUsers.push(`usrO_cnoflip_${stamp}`)
    const created = await createTask({ orgId, creatorId: me.userId, title: '备料复核', assignees: [me.userId, `usrO_cnoflip_${stamp}`], completionMode: 'all' })
    const response = await app().post(`/api/tasks/${created.id}/complete`).set(auth(me.bearer)).send({})
    expect(response.body).toEqual({ done: false, version: 1 })
    expect((await taskRow(created.id)).version).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
// Gate 8, branch A (design §10.5): an invalid or missing viewer zone falls back to the task's own
// zone, never to UTC. The database clock cannot be pinned, so the fixture's due instant is placed
// between the next Shanghai midnight and the next UTC midnight: whichever of the two comes first
// decides which answer is the right one, and the two fallbacks always disagree.
// ---------------------------------------------------------------------------------------------

describe('gate 8 branch A (viewer zone fallback)', () => {
  const FLIP_MARGIN_MS = 2 * 60 * 1000
  const CELL_TIMEOUT_MS = 9 * 60 * 1000

  interface Gate8Fixture { me: SeededTaskActor; taskFallback: number; utcFallback: number }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function databaseNow(): Promise<Date> {
    const result = await poolManager.get().query(`SELECT now() AS now`)
    return new Date(result.rows[0].now as Date)
  }

  function pad(n: number): string {
    return String(n).padStart(2, '0')
  }

  async function gate8Fixture(label: string): Promise<Gate8Fixture> {
    let now = await databaseNow()
    let shanghai = viewerNextMidnight(now, SHANGHAI)
    let utc = viewerNextMidnight(now, 'UTC')
    const untilFlip = Math.min(shanghai.getTime(), utc.getTime()) - now.getTime()
    if (untilFlip < FLIP_MARGIN_MS) {
      // Too close to a flip point (UTC 16:00 or 00:00): wait until it has passed, never skip.
      await sleep(untilFlip + 2000)
      now = await databaseNow()
      shanghai = viewerNextMidnight(now, SHANGHAI)
      utc = viewerNextMidnight(now, 'UTC')
    }
    const lo = Math.min(shanghai.getTime(), utc.getTime())
    const hi = Math.max(shanghai.getTime(), utc.getTime())
    const due = new Date(Math.floor((lo + hi) / 2000) * 1000)
    // Asia/Shanghai is UTC+8 all year: shift and read the UTC fields as the wall clock.
    const wall = new Date(due.getTime() + 8 * 3600 * 1000)
    const dueDate = `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`
    const dueTime = `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`

    const stamp = stampOf()
    const orgId = orgOf(label, stamp)
    const me = await actor(label, stamp, orgId)
    const server = app()
    const settings = await server.patch('/api/task-settings').set(auth(me.bearer)).send({ badgeScope: 'overdue_or_today' })
    expect(settings.status).toBe(200)
    const created = await server.post('/api/tasks').set(auth(me.bearer)).send({
      title: '备料复核', assignees: [me.userId], dueDate, dueTime, timeZone: SHANGHAI,
    })
    expect(created.status).toBe(200)
    expect((await taskRow(created.body.id)).due_at).toBe(due.toISOString())
    const taskFallback = due.getTime() < shanghai.getTime() ? 1 : 0
    const utcFallback = due.getTime() < utc.getTime() ? 1 : 0
    expect(taskFallback).not.toBe(utcFallback)
    return { me, taskFallback, utcFallback }
  }

  it('m4dates|gate8|A: an invalid header, no header and the task zone give byte-identical counts equal to the task-zone answer', async () => {
    const f = await gate8Fixture('g8p')
    const server = app()
    const invalid = await server.get('/api/tasks/pending-count').set(auth(f.me.bearer)).set('x-viewer-time-zone', 'Not/AZone')
    const absent = await server.get('/api/tasks/pending-count').set(auth(f.me.bearer))
    const explicit = await server.get('/api/tasks/pending-count').set(auth(f.me.bearer)).set('x-viewer-time-zone', SHANGHAI)
    const utc = await server.get('/api/tasks/pending-count').set(auth(f.me.bearer)).set('x-viewer-time-zone', 'UTC')
    expect(explicit.status).toBe(200)
    expect(explicit.body).toEqual({ count: f.taskFallback })
    expect(invalid.text).toBe(explicit.text)
    expect(absent.text).toBe(explicit.text)
    // The fixture discriminates: an explicit UTC viewer sees the other answer.
    expect(utc.body).toEqual({ count: f.utcFallback })
  }, CELL_TIMEOUT_MS)

  it("m4dates|gate8|A negative 1: with the route's validated header followed by a UTC default, invalid and missing headers give the UTC answer", async () => {
    const f = await gate8Fixture('g8r')
    const needle = "validateViewerTimeZoneHeader(req.header('x-viewer-time-zone'))"
    runSourceMutant(ROUTES_FILE, needle, `(${needle} ?? 'UTC')`, `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import(${JSON.stringify(EXPRESS_PATH)})).default
      const request = (await import(${JSON.stringify(SUPERTEST_PATH)})).default
      const { tasksRouter } = await import(${JSON.stringify(ROUTES_FILE)})
      const server = express()
      server.use(express.json())
      server.use(tasksRouter())
      const bearer = 'Bearer ' + ${JSON.stringify(f.me.bearer)}
      const count = async (zone) => {
        const pending = request(server).get('/api/tasks/pending-count').set('Authorization', bearer)
        const response = await (zone === null ? pending : pending.set('x-viewer-time-zone', zone))
        return response.status === 200 ? response.body.count : 'status ' + response.status
      }
      const explicit = await count('Asia/Shanghai')
      const invalid = await count('Not/AZone')
      const absent = await count(null)
      console.log(JSON.stringify({ gate8route: 'red', explicit, invalid, absent }))
      const red = explicit === ${f.taskFallback} && invalid === ${f.utcFallback} && absent === ${f.utcFallback}
      process.exit(red ? 0 : 1)
    `, {}, { all: true, count: 2 })
  }, CELL_TIMEOUT_MS)

  it('m4dates|gate8|A negative 2: with every viewer-zone fallback in the SQL set to UTC, the missing-header count flips', async () => {
    const f = await gate8Fixture('g8s')
    // eslint-disable-next-line no-template-curly-in-string
    const needle = 'COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone)'
    // eslint-disable-next-line no-template-curly-in-string
    const replacement = "COALESCE(${VIEWER_TZ_PLACEHOLDER}, 'UTC')"
    runSourceMutant(ACCESS_FILE, needle, replacement, `
      process.env.TASKS_ENABLED = 'true'
      const express = (await import(${JSON.stringify(EXPRESS_PATH)})).default
      const request = (await import(${JSON.stringify(SUPERTEST_PATH)})).default
      const { tasksRouter } = await import(${JSON.stringify(ROUTES_FILE)})
      const server = express()
      server.use(express.json())
      server.use(tasksRouter())
      const bearer = 'Bearer ' + ${JSON.stringify(f.me.bearer)}
      const count = async (zone) => {
        const pending = request(server).get('/api/tasks/pending-count').set('Authorization', bearer)
        const response = await (zone === null ? pending : pending.set('x-viewer-time-zone', zone))
        return response.status === 200 ? response.body.count : 'status ' + response.status
      }
      const explicit = await count('Asia/Shanghai')
      const invalid = await count('Not/AZone')
      const absent = await count(null)
      console.log(JSON.stringify({ gate8sql: 'red', explicit, invalid, absent }))
      const red = explicit === ${f.taskFallback} && invalid === ${f.utcFallback} && absent === ${f.utcFallback}
      process.exit(red ? 0 : 1)
    `, {}, { all: true, count: 4 })
  }, CELL_TIMEOUT_MS)
})
