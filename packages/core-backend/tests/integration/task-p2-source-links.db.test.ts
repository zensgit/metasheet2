import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createTask } from '../../src/services/task-records'
import {
  dropTaskM4Fixtures,
  seedOrgMembers,
  seedTaskActor,
  signTaskToken,
  whileStructureLockHeld,
  type SeededTaskActor,
} from '../helpers/task-m4-fixtures'
import { rawRequest, startTasksListener, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * A task dispatched from a multitable record (POST /api/tasks with `source` and `dispatchKey`), on a
 * real database through the real router: the record read gate for the caller, the stored link, the
 * view and base checks, the dispatch key (a resend answers with the task the first send made, in the
 * same org and for the same dispatcher only), the order of the key lookup against the member and task
 * access tests, and the link in the task detail.
 *
 * Each cell uses its own org and its own users. The multitable rows (one base, sheets, a view and
 * records) are shared by the file and removed in `afterAll`; a dispatcher who may read them holds
 * `multitable:read` from before their first request (the permission read is memoised per user).
 * The record's own list of tasks is a separate route and is not exercised here.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-p2-source-links.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_p2src_'
const seededUsers: string[] = []
const seededRoles: string[] = []

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function orgOf(label: string, stamp: string): string {
  return `${ORG_PREFIX}${label}_${stamp}`
}

const FILE_STAMP = stampOf()
const BASE = `bas_p2src_${FILE_STAMP}`
const OTHER_BASE = `bas_p2src_o_${FILE_STAMP}`
const SHEET = `sht_p2src_${FILE_STAMP}`
const OTHER_SHEET = `sht_p2src_o_${FILE_STAMP}`
const DELETED_SHEET = `sht_p2src_d_${FILE_STAMP}`
const VIEW = `viw_p2src_${FILE_STAMP}`
const OTHER_VIEW = `viw_p2src_o_${FILE_STAMP}`
const REC_1 = `rec_p2src_1_${FILE_STAMP}`
const REC_2 = `rec_p2src_2_${FILE_STAMP}`
const REC_OTHER = `rec_p2src_o_${FILE_STAMP}`
const REC_DELETED = `rec_p2src_d_${FILE_STAMP}`
const REC_MISSING = `rec_p2src_missing_${FILE_STAMP}`
const SHEETS = [SHEET, OTHER_SHEET, DELETED_SHEET]

const TITLE = '备料复核'
const NOT_READABLE_TEXT = JSON.stringify({ error: { code: 'SOURCE_NOT_READABLE' } })
const INVALID_SOURCE_TEXT = JSON.stringify({ error: { code: 'INVALID_SOURCE' } })
const INVALID_KEY_TEXT = JSON.stringify({ error: { code: 'INVALID_DISPATCH_KEY' } })

type Reply = { status: number; body: unknown; text: string }

const pool = () => poolManager.get()

let listener: TasksListener | undefined

beforeAll(async () => {
  const db = pool()
  await db.query(
    `INSERT INTO permissions (code, name, description) VALUES ('multitable:read', 'Multitable Read', 'read')
     ON CONFLICT (code) DO NOTHING`,
  )
  await db.query('INSERT INTO meta_bases (id, name) VALUES ($1, $2), ($3, $4)', [BASE, 'P2 source base', OTHER_BASE, 'P2 other base'])
  await db.query(
    `INSERT INTO meta_sheets (id, base_id, name, description) VALUES ($1, $2, 'P2 source', ''), ($3, $4, 'P2 other', ''), ($5, $2, 'P2 deleted', '')`,
    [SHEET, BASE, OTHER_SHEET, OTHER_BASE, DELETED_SHEET],
  )
  await db.query(
    `INSERT INTO meta_views (id, sheet_id, name, type) VALUES ($1, $2, 'P2 grid', 'grid'), ($3, $4, 'P2 other grid', 'grid')`,
    [VIEW, SHEET, OTHER_VIEW, OTHER_SHEET],
  )
  await db.query(
    `INSERT INTO meta_records (id, sheet_id, data, version) VALUES
       ($1, $2, '{}'::jsonb, 1), ($3, $2, '{}'::jsonb, 1), ($4, $5, '{}'::jsonb, 1), ($6, $7, '{}'::jsonb, 1)`,
    [REC_1, SHEET, REC_2, REC_OTHER, OTHER_SHEET, REC_DELETED, DELETED_SHEET],
  )
  await db.query('UPDATE meta_sheets SET deleted_at = now() WHERE id = $1', [DELETED_SHEET])
  listener = await startTasksListener()
})

afterAll(async () => {
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  const db = pool()
  await db.query('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [SHEETS]).catch(() => undefined)
  await db.query('DELETE FROM meta_views WHERE sheet_id = ANY($1::text[])', [SHEETS]).catch(() => undefined)
  await db.query('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [SHEETS]).catch(() => undefined)
  await db.query('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE, OTHER_BASE]]).catch(() => undefined)
  await listener?.close()
})

function port(): number {
  if (!listener) throw new Error('tasks listener not started')
  return listener.port
}

function post(path: string, bearer: string, body: unknown): Promise<Reply> {
  return rawRequest(port(), 'POST', path, bearer, body)
}

function get(path: string, bearer: string): Promise<Reply> {
  return rawRequest(port(), 'GET', path, bearer)
}

function del(path: string, bearer: string): Promise<Reply> {
  return rawRequest(port(), 'DELETE', path, bearer)
}

/** A dispatcher: both task codes with task access enabled, and `multitable:read` unless `read` is
 * false, granted before their first request. */
async function dispatcher(label: string, stamp: string, orgId: string, opts: { read?: boolean } = {}): Promise<SeededTaskActor> {
  const seeded = await seedTaskActor({
    label, stamp, orgId, codes: ['tasks:read', 'tasks:write'], admission: true,
    direct: opts.read === false ? [] : ['multitable:read'],
  })
  seededUsers.push(seeded.userId)
  seededRoles.push(seeded.roleId)
  return seeded
}

/** An active member of `orgId` with task access, who can be named as an assignee. */
async function assignable(userId: string, orgId: string): Promise<string> {
  await seedOrgMembers(orgId, [userId])
  seededUsers.push(userId)
  return userId
}

function sourced(source: Record<string, unknown>, dispatchKey?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { title: TITLE, ...extra, source, ...(dispatchKey === undefined ? {} : { dispatchKey }) }
}

const newKey = (): string => randomUUID()

function idOf(reply: Reply): string {
  return String((reply.body as { id: string }).id)
}

/** The org's task, assignee, event, link and outbox rows, for "nothing was written". */
async function orgState(orgId: string): Promise<string> {
  const tasks = await pool().query(
    `SELECT id, status, version, deleted_at, updated_at FROM tasks WHERE org_id = $1 ORDER BY id`,
    [orgId],
  )
  const assignees = await pool().query(
    `SELECT a.task_id, a.user_id, a.completed_at FROM task_assignees a JOIN tasks t ON t.id = a.task_id
     WHERE t.org_id = $1 ORDER BY a.task_id, a.user_id`,
    [orgId],
  )
  const events = await pool().query(
    `SELECT e.id, e.event_type FROM task_events e JOIN tasks t ON t.id = e.task_id
     WHERE t.org_id = $1 ORDER BY e.id`,
    [orgId],
  )
  const links = await linksOf(orgId)
  const outbox = await pool().query(
    `SELECT id FROM task_notification_deliveries WHERE org_id = $1 ORDER BY id`,
    [orgId],
  )
  return JSON.stringify({ tasks: tasks.rows, assignees: assignees.rows, events: events.rows, links, outbox: outbox.rows })
}

async function linksOf(orgId: string): Promise<Record<string, unknown>[]> {
  const result = await pool().query(
    `SELECT task_id, org_id, source_type, sheet_id, record_id, view_id, base_id, created_by, dispatch_key
     FROM task_source_links WHERE org_id = $1 ORDER BY task_id`,
    [orgId],
  )
  return result.rows
}

async function taskCount(orgId: string): Promise<number> {
  const result = await pool().query('SELECT count(*)::int AS n FROM tasks WHERE org_id = $1', [orgId])
  return Number(result.rows[0]?.n ?? 0)
}

async function createdEvents(taskId: string): Promise<number> {
  const result = await pool().query(
    `SELECT count(*)::int AS n FROM task_events WHERE task_id = $1 AND event_type = 'created'`,
    [taskId],
  )
  return Number(result.rows[0]?.n ?? 0)
}

/**
 * Runs `start()` while this file's own connection holds ACCESS EXCLUSIVE on `table` (the outbox
 * file's lock-and-watch). A statement that reads the table queues on the lock and shows up in
 * pg_locks of this database (`read` true); a request that never reads it finishes while the lock is
 * held (`read` false).
 */
async function readsTable<T>(table: string, start: () => Promise<T>): Promise<{ read: boolean; result: T }> {
  const holder = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await holder.connect()
  let open = false
  try {
    await holder.query('BEGIN')
    open = true
    await holder.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`)
    let settled = false
    const pending = start()
    pending.then(() => { settled = true }, () => { settled = true })
    let read = false
    const deadline = Date.now() + 15000
    while (!settled) {
      const waiting = await holder.query(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'relation' AND relation = $1::regclass AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        [table],
      )
      if (Number(waiting.rows[0]?.n ?? 0) > 0) {
        read = true
        break
      }
      if (Date.now() > deadline) throw new Error(`readsTable: the request neither finished nor queued on ${table}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await holder.query('COMMIT')
    open = false
    return { read, result: await pending }
  } finally {
    if (open) await holder.query('ROLLBACK').catch(() => undefined)
    await holder.end()
  }
}

describe('a create with a source stores the link and answers sourceLinked', () => {
  it('P1 / S-ack: one link with the task org, the ids as sent and the creator; the answer and the detail say so; a create without a source is unchanged', async () => {
    const stamp = stampOf()
    const orgId = orgOf('p1', stamp)
    const me = await dispatcher('p1', stamp, orgId)
    const key = newKey()
    const created = await post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_1 }, key))
    expect(created.status, created.text).toBe(200)
    const taskId = idOf(created)
    expect(created.text).toBe(JSON.stringify({ id: taskId, version: 1, sourceLinked: true }))
    expect(await linksOf(orgId)).toEqual([{
      task_id: taskId, org_id: orgId, source_type: 'multitable_record', sheet_id: SHEET, record_id: REC_1,
      view_id: null, base_id: null, created_by: me.userId, dispatch_key: key,
    }])
    const detail = await get(`/api/tasks/${taskId}`, me.bearer)
    expect(detail.status, detail.text).toBe(200)
    expect((detail.body as { source?: unknown }).source).toEqual({
      kind: 'multitable_record', sheetId: SHEET, recordId: REC_1, viewId: null, baseId: null,
    })

    // A source without a key is stored with a null key.
    const unkeyed = await post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_2 }))
    expect(unkeyed.status, unkeyed.text).toBe(200)
    expect(unkeyed.text).toBe(JSON.stringify({ id: idOf(unkeyed), version: 1, sourceLinked: true }))
    expect((await linksOf(orgId)).find((row) => row.task_id === idOf(unkeyed))?.dispatch_key).toBeNull()

    // No source: the answer is exactly { id, version }, nothing is linked and the detail has no source key.
    const plain = await post('/api/tasks', me.bearer, { title: TITLE })
    expect(plain.status, plain.text).toBe(200)
    expect(Object.keys(plain.body as object).sort()).toEqual(['id', 'version'])
    expect((await linksOf(orgId)).some((row) => row.task_id === idOf(plain))).toBe(false)
    const plainDetail = await get(`/api/tasks/${idOf(plain)}`, me.bearer)
    expect(plainDetail.status).toBe(200)
    expect(Object.prototype.hasOwnProperty.call(plainDetail.body, 'source')).toBe(false)
  })

  it('P7: a view and a base of the sheet are stored and returned', async () => {
    const stamp = stampOf()
    const orgId = orgOf('p7', stamp)
    const me = await dispatcher('p7', stamp, orgId)
    const created = await post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_1, viewId: VIEW, baseId: BASE }, newKey()))
    expect(created.status, created.text).toBe(200)
    const [link] = await linksOf(orgId)
    expect([link?.view_id, link?.base_id]).toEqual([VIEW, BASE])
    const detail = await get(`/api/tasks/${idOf(created)}`, me.bearer)
    expect((detail.body as { source?: unknown }).source).toEqual({
      kind: 'multitable_record', sheetId: SHEET, recordId: REC_1, viewId: VIEW, baseId: BASE,
    })
  })
})

describe('the dispatch key', () => {
  it('P2 / S-ack: the same key twice is one task, one link and one created event; the resend is answered reused and writes nothing', async () => {
    const stamp = stampOf()
    const orgId = orgOf('p2', stamp)
    const me = await dispatcher('p2', stamp, orgId)
    const body = sourced({ sheetId: SHEET, recordId: REC_1 }, newKey())
    const first = await post('/api/tasks', me.bearer, body)
    expect(first.status, first.text).toBe(200)
    const before = await orgState(orgId)
    const again = await post('/api/tasks', me.bearer, body)
    expect(again.status, again.text).toBe(200)
    expect(again.text).toBe(JSON.stringify({ id: idOf(first), version: 1, reused: true, sourceLinked: true }))
    expect(await orgState(orgId)).toBe(before)
    expect(await taskCount(orgId)).toBe(1)
    expect(await linksOf(orgId)).toHaveLength(1)
    expect(await createdEvents(idOf(first))).toBe(1)
  })

  it('P3: another key on the same record is a second task with its own link', async () => {
    const stamp = stampOf()
    const orgId = orgOf('p3', stamp)
    const me = await dispatcher('p3', stamp, orgId)
    const first = await post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_1 }, newKey()))
    const second = await post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_1 }, newKey()))
    expect([first.status, second.status]).toEqual([200, 200])
    expect(idOf(second)).not.toBe(idOf(first))
    expect(Object.prototype.hasOwnProperty.call(second.body, 'reused')).toBe(false)
    const links = await linksOf(orgId)
    expect(links.map((row) => row.task_id).sort()).toEqual([idOf(first), idOf(second)].sort())
    expect(links.every((row) => row.record_id === REC_1 && row.created_by === me.userId)).toBe(true)
  })

  it('P6: a resend after an assignee stopped being an active member, or lost task access, is the task already made; a new key with the same body is refused', async () => {
    const stamp = stampOf()
    const orgId = orgOf('p6', stamp)
    const me = await dispatcher('p6', stamp, orgId)
    const leaver = await assignable(`usrL_p6_${stamp}`, orgId)
    const revoked = await assignable(`usrR_p6_${stamp}`, orgId)

    const toLeaver = sourced({ sheetId: SHEET, recordId: REC_1 }, newKey(), { assignees: [me.userId, leaver] })
    const first = await post('/api/tasks', me.bearer, toLeaver)
    expect(first.status, first.text).toBe(200)
    await pool().query('UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2', [leaver, orgId])
    let before = await orgState(orgId)
    const resend = await post('/api/tasks', me.bearer, toLeaver)
    expect(resend.status, resend.text).toBe(200)
    expect(resend.text).toBe(JSON.stringify({ id: idOf(first), version: 1, reused: true, sourceLinked: true }))
    expect(await orgState(orgId)).toBe(before)
    const fresh = await post('/api/tasks', me.bearer, { ...toLeaver, dispatchKey: newKey() })
    expect(fresh.status).toBe(422)
    expect(fresh.text).toBe(JSON.stringify({ error: { code: 'INACTIVE_ORG_MEMBER' } }))
    expect(await orgState(orgId)).toBe(before)

    const toRevoked = sourced({ sheetId: SHEET, recordId: REC_2 }, newKey(), { assignees: [me.userId, revoked] })
    const second = await post('/api/tasks', me.bearer, toRevoked)
    expect(second.status, second.text).toBe(200)
    await pool().query(`UPDATE user_namespace_admissions SET enabled = false WHERE user_id = $1 AND namespace = 'tasks'`, [revoked])
    before = await orgState(orgId)
    const resent = await post('/api/tasks', me.bearer, toRevoked)
    expect(resent.status, resent.text).toBe(200)
    expect(resent.text).toBe(JSON.stringify({ id: idOf(second), version: 1, reused: true, sourceLinked: true }))
    expect(await orgState(orgId)).toBe(before)
    const freshAgain = await post('/api/tasks', me.bearer, { ...toRevoked, dispatchKey: newKey() })
    expect(freshAgain.status).toBe(422)
    expect(freshAgain.text).toBe(JSON.stringify({ error: { code: 'ASSIGNEE_TASK_ACCESS_REQUIRED' } }))
    expect(await orgState(orgId)).toBe(before)
  })

  it('N8: two creates with one key sent together are one task: the structure lock queues them, the second finds the first', async () => {
    const stamp = stampOf()
    const orgId = orgOf('n8', stamp)
    const me = await dispatcher('n8', stamp, orgId)
    const body = sourced({ sheetId: SHEET, recordId: REC_1 }, newKey())
    const { result } = await whileStructureLockHeld(
      orgId,
      () => Promise.all([post('/api/tasks', me.bearer, body), post('/api/tasks', me.bearer, body)]),
      undefined,
      2,
    )
    expect(result.map((reply) => reply.status)).toEqual([200, 200])
    expect(new Set(result.map(idOf)).size).toBe(1)
    expect(result.filter((reply) => (reply.body as { reused?: boolean }).reused === true)).toHaveLength(1)
    expect(await taskCount(orgId)).toBe(1)
    expect(await linksOf(orgId)).toHaveLength(1)
  })

  it('N9: a soft-deleted task keeps its link, and a resend of its key is still that task', async () => {
    const stamp = stampOf()
    const orgId = orgOf('n9', stamp)
    const me = await dispatcher('n9', stamp, orgId)
    const body = sourced({ sheetId: SHEET, recordId: REC_1 }, newKey())
    const created = await post('/api/tasks', me.bearer, body)
    expect(created.status, created.text).toBe(200)
    const removed = await del(`/api/tasks/${idOf(created)}`, me.bearer)
    expect(removed.status, removed.text).toBe(200)
    expect((await linksOf(orgId)).map((row) => row.task_id)).toEqual([idOf(created)])
    const version = Number((await pool().query('SELECT version FROM tasks WHERE id = $1', [idOf(created)])).rows[0]?.version)
    const resend = await post('/api/tasks', me.bearer, body)
    expect(resend.status, resend.text).toBe(200)
    expect(resend.text).toBe(JSON.stringify({ id: idOf(created), version, reused: true, sourceLinked: true }))
    expect(await taskCount(orgId)).toBe(1)
  })

  it('N14: a resend whose body fails a body check answers that check and keeps the first task', async () => {
    const stamp = stampOf()
    const orgId = orgOf('n14', stamp)
    const me = await dispatcher('n14', stamp, orgId)
    const key = newKey()
    const first = await post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_1 }, key))
    expect(first.status, first.text).toBe(200)
    const before = await orgState(orgId)
    const blank = await post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_1 }, key, { title: '   ' }))
    expect(blank.status).toBe(422)
    expect(blank.text).toBe(JSON.stringify({ error: { code: 'INVALID_TITLE' } }))
    expect(await orgState(orgId)).toBe(before)
    expect(await linksOf(orgId)).toHaveLength(1)
  })

  it('N15: a key first used for one record is refused for another record of the sheet, and nothing is written', async () => {
    const stamp = stampOf()
    const orgId = orgOf('n15', stamp)
    const me = await dispatcher('n15', stamp, orgId)
    const key = newKey()
    const first = await post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_1 }, key))
    expect(first.status, first.text).toBe(200)
    const before = await orgState(orgId)
    const other = await post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_2 }, key))
    expect(other.status).toBe(422)
    expect(other.text).toBe(INVALID_KEY_TEXT)
    expect(await orgState(orgId)).toBe(before)
    expect(await taskCount(orgId)).toBe(1)
    expect(await createdEvents(idOf(first))).toBe(1)
  })

  it('N16: the key is matched for the same dispatcher in the same org only', async () => {
    const stamp = stampOf()
    const orgA = orgOf('n16a', stamp)
    const orgB = orgOf('n16b', stamp)
    const a = await dispatcher('n16a', stamp, orgA)
    const b = await dispatcher('n16b', stamp, orgA)
    const key = newKey()
    const body = sourced({ sheetId: SHEET, recordId: REC_1 }, key)

    const mine = await post('/api/tasks', a.bearer, body)
    expect(mine.status, mine.text).toBe(200)
    const theirs = await post('/api/tasks', b.bearer, body)
    expect(theirs.status, theirs.text).toBe(200)
    expect(idOf(theirs)).not.toBe(idOf(mine))
    expect(Object.prototype.hasOwnProperty.call(theirs.body, 'reused')).toBe(false)

    await pool().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [a.userId, orgB])
    const elsewhere = await post('/api/tasks', signTaskToken(a.userId, a.roleId, orgB), body)
    expect(elsewhere.status, elsewhere.text).toBe(200)
    expect([idOf(mine), idOf(theirs)]).not.toContain(idOf(elsewhere))
    expect(Object.prototype.hasOwnProperty.call(elsewhere.body, 'reused')).toBe(false)

    const back = await post('/api/tasks', a.bearer, body)
    expect(back.status, back.text).toBe(200)
    expect(back.text).toBe(JSON.stringify({ id: idOf(mine), version: 1, reused: true, sourceLinked: true }))
    expect(await taskCount(orgA)).toBe(2)
    expect(await taskCount(orgB)).toBe(1)
  })
})

describe('refusals: nothing is written', () => {
  it('N1: a record the caller cannot read and a missing record are the same 422', async () => {
    const stamp = stampOf()
    const orgId = orgOf('n1', stamp)
    const cannot = await dispatcher('n1n', stamp, orgId, { read: false })
    const reader = await dispatcher('n1r', stamp, orgId)
    const before = await orgState(orgId)
    const unreadable = await post('/api/tasks', cannot.bearer, sourced({ sheetId: SHEET, recordId: REC_1 }, newKey()))
    const missing = await post('/api/tasks', reader.bearer, sourced({ sheetId: SHEET, recordId: REC_MISSING }, newKey()))
    for (const reply of [unreadable, missing]) {
      expect(reply.status).toBe(422)
      expect(reply.text).toBe(NOT_READABLE_TEXT)
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('N2: a malformed id is 422 INVALID_SOURCE before the sheet is read', async () => {
    const stamp = stampOf()
    const orgId = orgOf('n2', stamp)
    const me = await dispatcher('n2', stamp, orgId)
    const before = await orgState(orgId)
    const bad = ['.', '..', 'a\u0001b', 'x'.repeat(256), 'a/b', 'a?b', 'a#b', 'a%b', 'a\\b']
    const sources: Record<string, unknown>[] = [
      ...bad.map((id) => ({ sheetId: id, recordId: REC_1 })),
      ...bad.map((id) => ({ sheetId: SHEET, recordId: id })),
      { sheetId: SHEET, recordId: REC_1, viewId: 'a/b' },
      { sheetId: SHEET, recordId: REC_1, baseId: '..' },
    ]
    for (const source of sources) {
      const reply = await post('/api/tasks', me.bearer, sourced(source, newKey()))
      expect(reply.status, JSON.stringify(source)).toBe(422)
      expect(reply.text, JSON.stringify(source)).toBe(INVALID_SOURCE_TEXT)
    }
    const watched = await readsTable('meta_sheets', () => post('/api/tasks', me.bearer, sourced({ sheetId: 'a/b', recordId: REC_1 }, newKey())))
    expect(watched.result.text).toBe(INVALID_SOURCE_TEXT)
    expect(watched.read).toBe(false)
    expect(await orgState(orgId)).toBe(before)
    // The control: a well-formed source does read the sheet.
    const control = await readsTable('meta_sheets', () => post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_1 }, newKey())))
    expect(control.read).toBe(true)
    expect(control.result.status, control.result.text).toBe(200)
  })

  it('N3: a key without a source, or of another shape, is 422 INVALID_DISPATCH_KEY', async () => {
    const stamp = stampOf()
    const orgId = orgOf('n3', stamp)
    const me = await dispatcher('n3', stamp, orgId)
    const before = await orgState(orgId)
    const bodies: Record<string, unknown>[] = [
      { title: TITLE, dispatchKey: newKey() },
      sourced({ sheetId: SHEET, recordId: REC_1 }, 'short'),
      sourced({ sheetId: SHEET, recordId: REC_1 }, 'k'.repeat(65)),
      sourced({ sheetId: SHEET, recordId: REC_1 }, 'key with space 01'),
      { ...sourced({ sheetId: SHEET, recordId: REC_1 }), dispatchKey: null },
    ]
    for (const body of bodies) {
      const reply = await post('/api/tasks', me.bearer, body)
      expect(reply.status, JSON.stringify(body)).toBe(422)
      expect(reply.text, JSON.stringify(body)).toBe(INVALID_KEY_TEXT)
    }
    const watched = await readsTable('meta_sheets', () => post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_1 }, 'short')))
    expect(watched.read).toBe(false)
    expect(await orgState(orgId)).toBe(before)
  })

  it('N11: without read on the sheet the answer is the same bytes for a live, a deleted and an absent sheet and a missing record; with read, a deleted sheet is the same 422', async () => {
    const stamp = stampOf()
    const orgId = orgOf('n11', stamp)
    const cannot = await dispatcher('n11n', stamp, orgId, { read: false })
    const reader = await dispatcher('n11r', stamp, orgId)
    const before = await orgState(orgId)
    const targets = [
      { sheetId: SHEET, recordId: REC_1 },
      { sheetId: DELETED_SHEET, recordId: REC_DELETED },
      { sheetId: `sht_p2src_absent_${stamp}`, recordId: REC_1 },
      { sheetId: SHEET, recordId: REC_MISSING },
    ]
    const texts = new Set<string>()
    for (const source of targets) {
      const reply = await post('/api/tasks', cannot.bearer, sourced(source, newKey()))
      expect(reply.status, JSON.stringify(source)).toBe(422)
      texts.add(reply.text)
    }
    expect([...texts]).toEqual([NOT_READABLE_TEXT])
    for (const source of [{ sheetId: DELETED_SHEET, recordId: REC_DELETED }, { sheetId: `sht_p2src_absent_${stamp}`, recordId: REC_1 }]) {
      const reply = await post('/api/tasks', reader.bearer, sourced(source, newKey()))
      expect(reply.status, JSON.stringify(source)).toBe(422)
      expect(reply.text).toBe(NOT_READABLE_TEXT)
    }
    expect(await orgState(orgId)).toBe(before)
  })

  it('N13: a view of another sheet, an absent view and another base are the same 422; a refused caller never reads the views', async () => {
    const stamp = stampOf()
    const orgId = orgOf('n13', stamp)
    const reader = await dispatcher('n13r', stamp, orgId)
    const cannot = await dispatcher('n13n', stamp, orgId, { read: false })
    const before = await orgState(orgId)
    const sources = [
      { sheetId: SHEET, recordId: REC_1, viewId: OTHER_VIEW },
      { sheetId: SHEET, recordId: REC_1, viewId: `viw_p2src_absent_${stamp}` },
      { sheetId: SHEET, recordId: REC_1, baseId: OTHER_BASE },
      { sheetId: SHEET, recordId: REC_1, viewId: VIEW, baseId: OTHER_BASE },
    ]
    for (const source of sources) {
      const reply = await post('/api/tasks', reader.bearer, sourced(source, newKey()))
      expect(reply.status, JSON.stringify(source)).toBe(422)
      expect(reply.text, JSON.stringify(source)).toBe(NOT_READABLE_TEXT)
    }
    const refused = await readsTable('meta_views', () => post('/api/tasks', cannot.bearer, sourced({ sheetId: SHEET, recordId: REC_1, viewId: VIEW }, newKey())))
    expect(refused.result.text).toBe(NOT_READABLE_TEXT)
    expect(refused.read).toBe(false)
    const passed = await readsTable('meta_views', () => post('/api/tasks', reader.bearer, sourced({ sheetId: SHEET, recordId: REC_1, viewId: OTHER_VIEW }, newKey())))
    expect(passed.read).toBe(true)
    expect(passed.result.text).toBe(NOT_READABLE_TEXT)
    expect(await orgState(orgId)).toBe(before)
  })
})

describe('the link and the record', () => {
  it('N7: a create that fails at commit leaves no link and no outbox row', async () => {
    const stamp = stampOf()
    const orgId = orgOf('n7', stamp)
    const me = await dispatcher('n7', stamp, orgId)
    const name = `tasks_p2src_fail_${stampOf()}`
    const db = pool()
    // Fires at COMMIT, after the link was written; reports how many links the failing transaction
    // itself could see, then aborts it.
    await db.query(`
      CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'links at commit: %', (SELECT count(*) FROM task_source_links WHERE org_id = NEW.org_id);
      END
      $fn$`)
    const source = { sheetId: SHEET, recordId: REC_1, viewId: null, baseId: null }
    try {
      await db.query(`
        CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON task_source_links
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
          WHEN (NEW.org_id = '${orgId}')
          EXECUTE FUNCTION ${name}()`)
      await expect(createTask({ orgId, creatorId: me.userId, title: TITLE, assignees: undefined, source, dispatchKey: newKey() }))
        .rejects.toThrow('links at commit: 1')
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ${name} ON task_source_links`)
      await db.query(`DROP FUNCTION IF EXISTS ${name}()`)
    }
    expect(await linksOf(orgId)).toEqual([])
    expect(await taskCount(orgId)).toBe(0)
    const outbox = await db.query('SELECT count(*)::int AS n FROM task_notification_deliveries WHERE org_id = $1', [orgId])
    expect(outbox.rows[0]?.n).toBe(0)
    // The same create without the trigger writes its link.
    await createTask({ orgId, creatorId: me.userId, title: TITLE, assignees: undefined, source, dispatchKey: newKey() })
    expect(await linksOf(orgId)).toHaveLength(1)
  })

  it('N10: creating and completing a linked task leaves the record rows as they were', async () => {
    const stamp = stampOf()
    const orgId = orgOf('n10', stamp)
    const me = await dispatcher('n10', stamp, orgId)
    const records = async () => JSON.stringify((await pool().query(
      'SELECT id, version, updated_at, data FROM meta_records WHERE sheet_id = $1 ORDER BY id',
      [SHEET],
    )).rows)
    const before = await records()
    const created = await post('/api/tasks', me.bearer, sourced({ sheetId: SHEET, recordId: REC_1, viewId: VIEW, baseId: BASE }, newKey()))
    expect(created.status, created.text).toBe(200)
    const done = await post(`/api/tasks/${idOf(created)}/complete`, me.bearer, {})
    expect(done.status, done.text).toBe(200)
    expect(await records()).toBe(before)
  })
})
