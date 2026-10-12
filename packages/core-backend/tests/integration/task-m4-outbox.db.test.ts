import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { newTaskListId } from '../../src/services/task-ids-runtime'
import { setTaskListArchived } from '../../src/services/task-list-records'
import { enqueueTaskEventNotifications } from '../../src/services/task-notification-producer'
import { completeTask, createTask, reopenTask, withOrgStructure } from '../../src/services/task-records'
import {
  addAssignee,
  addComment,
  addFollower,
  deleteTaskById,
  leaveTask,
  removeAssignee,
  removeFollower,
  switchCompletionMode,
} from '../../src/services/task-structure'
import { TASK_NOTIFICATION_CHANNEL_DINGTALK } from '../../src/tasks/task-notifications'
import {
  dropTaskM4Fixtures,
  runSourceMutant,
  seedOrgDingTalkIntegration,
  seedOrgMembers,
  seedOutboxRow,
  seedTaskActor,
} from '../helpers/task-m4-fixtures'
import { rawRequest, startTasksListener, type TasksListener } from '../helpers/tasks-http-harness'

/**
 * M4 PR-3b S2 (design task-m4-pr3b-backend-design-20261001.md §5, §11.2, §11.3; candidate rows
 * M4-a outbox idempotency and shape, M4-b recipients — candidates, not scored).
 *
 * The producer writes `task_notification_deliveries` rows in the transaction of the write that
 * produced the event. RULED(2026-10-07): [R05] [D13] the trigger set, the four recipient roles and
 * their priority, the actor's exclusion, list members of every list holding the task (archived
 * lists included), the list archive notifying the list's creator. ASSUMPTION(task-m4):
 * [own-3b-01] no row while any of the three switches is not exactly 'true'; [own-3b-13] a row only
 * for an org that has an active DingTalk integration row of its own.
 *
 * The touchpoints are called through the services (one cell goes through the router); fixtures
 * that are not under test (followers, lists, list members, integrations) are seeded with SQL. The
 * switches are process environment read on every producer call; this file sets them per cell and
 * the lane runs each file in its own process.
 */

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m4-outbox.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m4outbox_'
const CHANNEL = TASK_NOTIFICATION_CHANNEL_DINGTALK
const seededUsers: string[] = []
const seededRoles: string[] = []

const RECORDS_FILE = new URL('../../src/services/task-records.ts', import.meta.url).pathname
const LIST_ACCESS_FILE = new URL('../../src/tasks/task-list-access.ts', import.meta.url).pathname
const POOL_FILE = new URL('../../src/integration/db/connection-pool.ts', import.meta.url).pathname

const SWITCHES = [
  'TASKS_SCHEDULER_ENABLED',
  'TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED',
  'TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED',
] as const
type SwitchState = Partial<Record<(typeof SWITCHES)[number], string>>
const ALL_ON: SwitchState = {
  TASKS_SCHEDULER_ENABLED: 'true',
  TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true',
  TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true',
}

function setSwitches(state: SwitchState): void {
  for (const key of SWITCHES) {
    const value = state[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function stampOf(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

function orgOf(label: string, stamp: string): string {
  return `${ORG_PREFIX}${label}_${stamp}`
}

/** Active members of `orgId` (`users` + `user_orgs`), recorded for cleanup. */
async function members(orgId: string, ...userIds: string[]): Promise<void> {
  await seedOrgMembers(orgId, userIds)
  seededUsers.push(...userIds)
}

async function follow(taskId: string, ...userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [taskId, userId])
  }
}

async function seedList(
  orgId: string,
  createdBy: string,
  listMembers: Array<[string, 'read' | 'edit' | 'owner']>,
  taskIds: string[],
  opts: { archived?: boolean } = {},
): Promise<string> {
  const db = poolManager.get()
  const listId = newTaskListId()
  await db.query(
    `INSERT INTO task_lists (id, org_id, name, created_by, archived_at) VALUES ($1, $2, $3, $4, $5)`,
    [listId, orgId, '备料复核', createdBy, opts.archived ? new Date() : null],
  )
  for (const [userId, role] of listMembers) {
    await db.query('INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, $3)', [listId, userId, role])
  }
  for (const taskId of taskIds) {
    await db.query('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listId, taskId, orgId])
  }
  return listId
}

interface OutboxRow {
  id: string
  org_id: string
  source_type: string
  source_id: string
  source_key: string
  recipient_user_id: string
  recipient_role: string
  channel: string
  status: string
  attempt_count: number
  next_attempt_at: Date | null
  last_attempt_at: Date | null
  claimed_at: Date | null
  claim_expires_at: Date | null
  claim_worker_id: string | null
  delivered_at: Date | null
  last_error: string | null
  payload: Record<string, unknown>
  payload_text: string
  redelivery_safe: boolean
  created_at: Date
  updated_at: Date
}

/** Every outbox row of one source (task or list), by recipient then key. */
async function outboxOf(sourceId: string): Promise<OutboxRow[]> {
  const result = await poolManager.get().query<OutboxRow>(
    `SELECT id::text AS id, org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel,
            status, attempt_count, next_attempt_at, last_attempt_at, claimed_at, claim_expires_at, claim_worker_id,
            delivered_at, last_error, payload, payload::text AS payload_text, redelivery_safe, created_at, updated_at
       FROM task_notification_deliveries
      WHERE left(org_id, length($2)) = $2 AND source_id = $1
      ORDER BY recipient_user_id COLLATE "C", source_key COLLATE "C"`,
    [sourceId, ORG_PREFIX],
  )
  return result.rows
}

/** `[recipient, role, event]` of every row of one source. */
async function recipientsOf(sourceId: string): Promise<Array<[string, string, string]>> {
  return (await outboxOf(sourceId)).map((row) => [row.recipient_user_id, row.recipient_role, String(row.payload.event)])
}

async function eventIdOf(taskId: string, type: string): Promise<string> {
  const result = await poolManager.get().query<{ id: string }>(
    'SELECT id FROM task_events WHERE task_id = $1 AND event_type = $2',
    [taskId, type],
  )
  expect(result.rows, `${type} event of ${taskId}`).toHaveLength(1)
  return result.rows[0].id
}

/**
 * A fresh org with an active DingTalk integration (unless `integration` says otherwise), a creator,
 * two assignees and a follower, and an `all`-mode task. The creator is not an assignee.
 */
async function fixture(label: string, opts: { integration?: 'active' | 'inactive' | 'none'; mode?: 'all' | 'any' } = {}): Promise<{
  orgId: string
  creator: string
  a: string
  b: string
  follower: string
  taskId: string
}> {
  const stamp = stampOf()
  const orgId = orgOf(label, stamp)
  const creator = `usrC_${label}_${stamp}`
  const a = `usrA_${label}_${stamp}`
  const b = `usrB_${label}_${stamp}`
  const follower = `usrF_${label}_${stamp}`
  await members(orgId, creator, a, b, follower)
  const integration = opts.integration ?? 'active'
  if (integration !== 'none') await seedOrgDingTalkIntegration(orgId, { status: integration })
  const task = await createTask({ orgId, creatorId: creator, title: '备料复核', assignees: [a, b], completionMode: opts.mode ?? 'all' })
  await follow(task.id, follower)
  return { orgId, creator, a, b, follower, taskId: task.id }
}

/**
 * Runs `start()` while this file's own connection holds ACCESS EXCLUSIVE on `table`. A statement
 * that reads the table queues on that lock and shows up in pg_locks of this database (`read` true);
 * a request that never reads it finishes while the lock is held (`read` false).
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

let listener: TasksListener | undefined

beforeAll(async () => {
  listener = await startTasksListener()
})

beforeEach(() => {
  setSwitches(ALL_ON)
})

afterAll(async () => {
  setSwitches({})
  await dropTaskM4Fixtures({ orgPrefix: ORG_PREFIX, userIds: seededUsers, roleIds: seededRoles })
  await listener?.close()
})

describe('M4-a: the outbox row', () => {
  it('a completion writes one pending row per recipient: ids and enum values only, under the id of the completed event', async () => {
    const f = await fixture('shape')
    await completeTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId })
    expect(await outboxOf(f.taskId)).toEqual([])
    await completeTask({ orgId: f.orgId, actorId: f.b, taskId: f.taskId })
    const eventId = await eventIdOf(f.taskId, 'completed')
    const rows = await outboxOf(f.taskId)
    expect(rows.map((row) => [row.recipient_user_id, row.recipient_role])).toEqual([
      [f.a, 'assignee'],
      [f.creator, 'creator'],
      [f.follower, 'follower'],
    ].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
    for (const row of rows) {
      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(row).toMatchObject({
        org_id: f.orgId,
        source_type: 'task_event',
        source_id: f.taskId,
        source_key: `task_event:${f.taskId}:${eventId}:recipient:${row.recipient_user_id}:channel:${CHANNEL}`,
        channel: CHANNEL,
        status: 'pending',
        attempt_count: 0,
        last_attempt_at: null,
        claimed_at: null,
        claim_expires_at: null,
        claim_worker_id: null,
        delivered_at: null,
        last_error: null,
        redelivery_safe: false,
      })
      expect(row.next_attempt_at).toBeInstanceOf(Date)
      expect(row.payload).toEqual({ kind: 'task_event', event: 'completed', taskId: f.taskId, eventId, actorId: f.b })
      expect(row.payload_text.includes('备料复核')).toBe(false)
    }
  })

  it('idempotent: the producer called again for the same event writes nothing and returns 0; a new event id writes again', async () => {
    const f = await fixture('idem')
    await completeTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId })
    await completeTask({ orgId: f.orgId, actorId: f.b, taskId: f.taskId })
    const eventId = await eventIdOf(f.taskId, 'completed')
    const before = await outboxOf(f.taskId)
    expect(before).toHaveLength(3)
    const again = await withOrgStructure(f.orgId, (db) => enqueueTaskEventNotifications(db, {
      orgId: f.orgId,
      taskId: f.taskId,
      createdBy: f.creator,
      events: [{ id: eventId, type: 'completed', actorId: f.b, occurredAt: null }],
    }))
    expect(again).toBe(0)
    expect(await outboxOf(f.taskId)).toEqual(before)
    const fresh = await withOrgStructure(f.orgId, (db) => enqueueTaskEventNotifications(db, {
      orgId: f.orgId,
      taskId: f.taskId,
      createdBy: f.creator,
      events: [{ id: `tev_${stampOf()}`, type: 'completed', actorId: f.b, occurredAt: null }],
    }))
    expect(fresh).toBe(3)
    expect(await outboxOf(f.taskId)).toHaveLength(6)
  })

  it('a row already stored under the same key is left exactly as it is (no update); only the missing rows are added', async () => {
    const f = await fixture('keep')
    const eventId = `tev_${stampOf()}`
    const key = `task_event:${f.taskId}:${eventId}:recipient:${f.creator}:channel:${CHANNEL}`
    const deliveredAt = new Date('2031-03-15T02:00:00.000Z')
    const kept = await seedOutboxRow({
      orgId: f.orgId,
      sourceType: 'task_event',
      sourceId: f.taskId,
      sourceKey: key,
      recipientUserId: f.creator,
      recipientRole: 'creator',
      channel: CHANNEL,
      status: 'sent',
      attemptCount: 1,
      payload: { kind: 'task_event', event: 'commented', taskId: f.taskId, eventId, actorId: f.follower },
      deliveredAt,
    })
    const before = (await outboxOf(f.taskId)).find((row) => row.id === kept)
    const written = await withOrgStructure(f.orgId, (db) => enqueueTaskEventNotifications(db, {
      orgId: f.orgId,
      taskId: f.taskId,
      createdBy: f.creator,
      events: [{ id: eventId, type: 'commented', actorId: f.follower, occurredAt: null }],
    }))
    expect(written).toBe(2)
    const rows = await outboxOf(f.taskId)
    expect(rows.find((row) => row.id === kept)).toEqual(before)
    expect(rows.filter((row) => row.id !== kept).map((row) => [row.recipient_user_id, row.status]).sort()).toEqual(
      [[f.a, 'pending'], [f.b, 'pending']].sort(),
    )
  })

  it('same transaction: when the completing transaction fails at commit, the outbox rows it had written are gone with it', async () => {
    const f = await fixture('rollback')
    await completeTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId })
    expect(f.taskId).toMatch(/^[a-z0-9_]+$/)
    const name = `tasks_m4_outbox_fail_${stampOf()}`
    const db = poolManager.get()
    // Fires at COMMIT, after the producer has written; reports how many outbox rows the failing
    // transaction itself could see, then aborts it.
    await db.query(`
      CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'outbox rows at commit: %',
          (SELECT count(*) FROM task_notification_deliveries WHERE source_id = NEW.task_id);
      END
      $fn$`)
    try {
      await db.query(`
        CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON task_events
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
          WHEN (NEW.task_id = '${f.taskId}' AND NEW.event_type = 'completed')
          EXECUTE FUNCTION ${name}()`)
      await expect(completeTask({ orgId: f.orgId, actorId: f.b, taskId: f.taskId }))
        .rejects.toThrow('outbox rows at commit: 3')
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ${name} ON task_events`)
      await db.query(`DROP FUNCTION IF EXISTS ${name}()`)
    }
    expect(await outboxOf(f.taskId)).toEqual([])
    const task = await db.query('SELECT status FROM tasks WHERE id = $1', [f.taskId])
    expect(task.rows[0].status).toBe('open')
    const completed = await db.query(`SELECT count(*)::int AS n FROM task_events WHERE task_id = $1 AND event_type = 'completed'`, [f.taskId])
    expect(completed.rows[0].n).toBe(0)
    // The same completion without the trigger writes the rows.
    await completeTask({ orgId: f.orgId, actorId: f.b, taskId: f.taskId })
    expect(await outboxOf(f.taskId)).toHaveLength(3)
  })
})

describe('M4-a: the switches (ASSUMPTION(task-m4): [own-3b-01])', () => {
  const offStates: Array<[string, SwitchState]> = [
    ['all unset', {}],
    ['scheduler off', { ...ALL_ON, TASKS_SCHEDULER_ENABLED: undefined }],
    ['worker off', { ...ALL_ON, TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'false' }],
    ['channel off', { ...ALL_ON, TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: undefined }],
    ['channel TRUE', { ...ALL_ON, TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'TRUE' }],
  ]

  /** Completes, comments on and deletes one task, and archives one list, under `state`. */
  async function fourWrites(label: string, state: SwitchState): Promise<{ taskId: string; listId: string }> {
    const f = await fixture(label)
    const editor = `usrE_${label}_${stampOf()}`
    await members(f.orgId, editor)
    const listId = await seedList(f.orgId, f.creator, [[f.creator, 'owner'], [editor, 'edit']], [f.taskId])
    setSwitches(state)
    await completeTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId })
    await completeTask({ orgId: f.orgId, actorId: f.b, taskId: f.taskId })
    await addComment({ orgId: f.orgId, actorId: f.follower, taskId: f.taskId, body: { body: '已核对' } })
    await deleteTaskById({ orgId: f.orgId, actorId: f.creator, taskId: f.taskId })
    await setTaskListArchived({ orgId: f.orgId, actorId: editor, listId, archived: true })
    return { taskId: f.taskId, listId }
  }

  it('any switch not exactly true: completing, commenting, deleting and archiving write no row', async () => {
    for (const [label, state] of offStates) {
      const { taskId, listId } = await fourWrites(`off${offStates.findIndex(([l]) => l === label)}`, state)
      expect(await outboxOf(taskId), label).toEqual([])
      expect(await outboxOf(listId), label).toEqual([])
    }
  })

  it('all three exactly true: the same four writes write rows (positive control)', async () => {
    const { taskId, listId } = await fourWrites('on', ALL_ON)
    const events = new Set((await outboxOf(taskId)).map((row) => row.payload.event))
    expect([...events].sort()).toEqual(['commented', 'completed', 'deleted'])
    expect(await recipientsOf(listId)).toHaveLength(1)
  })

  it('with a switch off nothing is read: the completion never touches the integration table; with all on it does', async () => {
    const off = await fixture('noread')
    setSwitches({ ...ALL_ON, TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: undefined })
    const quiet = await readsTable('directory_integrations', async () => {
      await completeTask({ orgId: off.orgId, actorId: off.a, taskId: off.taskId })
      return completeTask({ orgId: off.orgId, actorId: off.b, taskId: off.taskId })
    })
    expect(quiet.read).toBe(false)
    expect(quiet.result.done).toBe(true)
    const on = await fixture('read')
    setSwitches(ALL_ON)
    await completeTask({ orgId: on.orgId, actorId: on.a, taskId: on.taskId })
    const loud = await readsTable('directory_integrations', () => completeTask({ orgId: on.orgId, actorId: on.b, taskId: on.taskId }))
    expect(loud.read).toBe(true)
    expect(loud.result.done).toBe(true)
    expect(await outboxOf(on.taskId)).toHaveLength(3)
  })
})

describe('M4-a: the org precondition (ASSUMPTION(task-m4): [own-3b-13])', () => {
  it('an org without a DingTalk integration, or with an inactive one only, gets no row; an org with an active one does', async () => {
    // Another org's active integration exists while the first two run: it never counts.
    const elsewhere = orgOf('elsewhere', stampOf())
    await seedOrgDingTalkIntegration(elsewhere)
    const outcomes: Record<string, number> = {}
    for (const integration of ['none', 'inactive', 'active'] as const) {
      const f = await fixture(`pre${integration}`, { integration })
      const listId = await seedList(f.orgId, f.creator, [[f.creator, 'owner'], [f.a, 'edit']], [f.taskId])
      await completeTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId })
      await completeTask({ orgId: f.orgId, actorId: f.b, taskId: f.taskId })
      await addComment({ orgId: f.orgId, actorId: f.follower, taskId: f.taskId, body: { body: '已核对' } })
      await setTaskListArchived({ orgId: f.orgId, actorId: f.a, listId, archived: true })
      outcomes[integration] = (await outboxOf(f.taskId)).length + (await outboxOf(listId)).length
    }
    // completed: creator, assignee A, follower; commented: creator, assignees A and B; archived:
    // the list's creator.
    expect(outcomes).toEqual({ none: 0, inactive: 0, active: 3 + 3 + 1 })
  })
})

describe('M4-b: recipients (RULED(2026-10-07): [R05] [D13])', () => {
  it('the follower gets completed and nothing for self_completed; the actor never gets a row', async () => {
    const f = await fixture('follower')
    await completeTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId })
    expect(await eventIdOf(f.taskId, 'self_completed')).toBeTruthy()
    expect(await outboxOf(f.taskId)).toEqual([])
    await completeTask({ orgId: f.orgId, actorId: f.b, taskId: f.taskId })
    const rows = await recipientsOf(f.taskId)
    expect(rows).toContainEqual([f.follower, 'follower', 'completed'])
    expect(rows.map(([user]) => user)).not.toContain(f.b)
  })

  it('a list read member gets commented as list_member, a member of an archived list too; the commenter gets nothing', async () => {
    const f = await fixture('lists')
    const reader = `usrR_lists_${stampOf()}`
    const archivedEditor = `usrR2_lists_${stampOf()}`
    await members(f.orgId, reader, archivedEditor)
    await seedList(f.orgId, f.creator, [[f.creator, 'owner'], [reader, 'read']], [f.taskId])
    await seedList(f.orgId, f.creator, [[f.creator, 'owner'], [archivedEditor, 'edit']], [f.taskId], { archived: true })
    await addComment({ orgId: f.orgId, actorId: f.follower, taskId: f.taskId, body: { body: '已核对' } })
    const expected: Array<[string, string, string]> = [
      [f.a, 'assignee', 'commented'],
      [f.b, 'assignee', 'commented'],
      [f.creator, 'creator', 'commented'],
      [reader, 'list_member', 'commented'],
      [archivedEditor, 'list_member', 'commented'],
    ]
    expect(await recipientsOf(f.taskId)).toEqual(expected.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
  })

  it('one person who is the creator, a follower and a list member gets one row, as creator', async () => {
    const f = await fixture('dedupe')
    await follow(f.taskId, f.creator)
    await seedList(f.orgId, f.a, [[f.a, 'owner'], [f.creator, 'read']], [f.taskId])
    await addComment({ orgId: f.orgId, actorId: f.a, taskId: f.taskId, body: { body: '已核对' } })
    const mine = (await recipientsOf(f.taskId)).filter(([user]) => user === f.creator)
    expect(mine).toEqual([[f.creator, 'creator', 'commented']])
  })

  // ASSUMPTION(task-m4): [own-37] the composite foreign keys refuse an item whose list and task are
  // in different orgs; the item below gets past them only because its seeding connection runs with
  // `session_replication_role = replica`. Such a list still contributes no member.
  it('a list of another org that holds the task gives its members no row; the list of the task org does; negative control: an always-true list org clause gives them one', async () => {
    const f = await fixture('xorg')
    const orgB = orgOf('xorgB', stampOf())
    await seedOrgDingTalkIntegration(orgB)
    const memberA = `usrMA_xorg_${stampOf()}`
    const memberB = `usrMB_xorg_${stampOf()}`
    await members(f.orgId, memberA)
    await members(orgB, memberB)
    const second = await createTask({ orgId: f.orgId, creatorId: f.creator, title: '备料复核', assignees: [f.a], completionMode: 'all' })
    await seedList(f.orgId, f.creator, [[f.creator, 'owner'], [memberA, 'read']], [f.taskId, second.id])
    const listB = await seedList(orgB, memberB, [[memberB, 'owner']], [])
    const db = poolManager.get()
    await expect(db.query('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listB, f.taskId, f.orgId]))
      .rejects.toMatchObject({ code: '23503', constraint: 'task_list_items_list_fk' })
    const seeder = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await seeder.connect()
    try {
      const su = await seeder.query(`SELECT current_setting('is_superuser') AS su`)
      if (su.rows[0].su !== 'on') throw new Error('the cross-org seed needs a superuser connection (session_replication_role)')
      await seeder.query('SET session_replication_role = replica')
      for (const taskId of [f.taskId, second.id]) {
        await seeder.query('INSERT INTO task_list_items (list_id, task_id, org_id) VALUES ($1, $2, $3)', [listB, taskId, f.orgId])
      }
      await seeder.query('RESET session_replication_role')
    } finally {
      await seeder.end()
    }
    await addComment({ orgId: f.orgId, actorId: f.follower, taskId: f.taskId, body: { body: '已核对' } })
    const users = (await recipientsOf(f.taskId)).map(([user]) => user)
    expect(users).toContain(memberA)
    expect(users).not.toContain(memberB)

    runSourceMutant(LIST_ACCESS_FILE, '(task_lists.org_id = ${ORG_PLACEHOLDER}) AND ', '(${ORG_PLACEHOLDER}::text IS NOT NULL) AND ', `
      process.env.TASKS_SCHEDULER_ENABLED = 'true'
      process.env.TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED = 'true'
      process.env.TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED = 'true'
      const { completeTask } = await import(${JSON.stringify(RECORDS_FILE)})
      const { poolManager } = await import(${JSON.stringify(POOL_FILE)})
      await completeTask({ orgId: ${JSON.stringify(f.orgId)}, actorId: ${JSON.stringify(f.a)}, taskId: ${JSON.stringify(second.id)} })
      const rows = await poolManager.get().query('SELECT recipient_user_id FROM task_notification_deliveries WHERE source_id = $1', [${JSON.stringify(second.id)}])
      const ids = rows.rows.map((row) => row.recipient_user_id)
      console.log(JSON.stringify({ ncListOrg: 'red', ids }))
      process.exit(ids.includes(${JSON.stringify(memberB)}) && ids.includes(${JSON.stringify(memberA)}) ? 0 : 1)
    `, {}, { unique: true })
  }, 180000)
})

describe('M4-b: each touchpoint', () => {
  it('reopen writes reopened; reopening only the actor’s own row (self_reopened) writes nothing', async () => {
    const f = await fixture('reopen')
    await completeTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId })
    await reopenTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId, scope: 'self' })
    expect(await eventIdOf(f.taskId, 'self_reopened')).toBeTruthy()
    expect(await outboxOf(f.taskId)).toEqual([])
    await completeTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId })
    await completeTask({ orgId: f.orgId, actorId: f.b, taskId: f.taskId })
    await reopenTask({ orgId: f.orgId, actorId: f.b, taskId: f.taskId, scope: 'all' })
    const reopened = (await recipientsOf(f.taskId)).filter(([, , event]) => event === 'reopened')
    expect(reopened.map(([user, role]) => [user, role])).toEqual(
      [[f.a, 'assignee'], [f.creator, 'creator'], [f.follower, 'follower']].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    )
  })

  it('switching all → any with one row complete writes completed_by_any', async () => {
    const f = await fixture('mode')
    await completeTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId })
    await switchCompletionMode({ orgId: f.orgId, actorId: f.creator, taskId: f.taskId, body: { completionMode: 'any' } })
    const eventId = await eventIdOf(f.taskId, 'completed_by_any')
    const rows = await outboxOf(f.taskId)
    expect(rows.map((row) => row.recipient_user_id).sort()).toEqual([f.a, f.b, f.follower].sort())
    for (const row of rows) expect(row.payload).toMatchObject({ event: 'completed_by_any', eventId, actorId: f.creator })
  })

  it('a deletion writes deleted for the members of the soft-deleted task', async () => {
    const f = await fixture('delete')
    await deleteTaskById({ orgId: f.orgId, actorId: f.creator, taskId: f.taskId })
    const eventId = await eventIdOf(f.taskId, 'deleted')
    const rows = await outboxOf(f.taskId)
    expect(rows.map((row) => [row.recipient_user_id, row.recipient_role]).sort()).toEqual(
      [[f.a, 'assignee'], [f.b, 'assignee'], [f.follower, 'follower']].sort(),
    )
    for (const row of rows) expect(row.payload).toEqual({ kind: 'task_event', event: 'deleted', taskId: f.taskId, eventId, actorId: f.creator })
  })

  it('archiving by a member who is not the creator writes one row for the creator; the creator archiving and unarchiving write none', async () => {
    const f = await fixture('archive')
    const listId = await seedList(f.orgId, f.creator, [[f.creator, 'owner'], [f.a, 'edit']], [])
    await setTaskListArchived({ orgId: f.orgId, actorId: f.a, listId, archived: true })
    const archived = await poolManager.get().query<{ id: string }>(
      `SELECT id FROM task_list_events WHERE list_id = $1 AND event_type = 'archived'`,
      [listId],
    )
    expect(await outboxOf(listId)).toMatchObject([{
      org_id: f.orgId,
      source_type: 'task_list_event',
      source_id: listId,
      source_key: `task_list_event:${listId}:${archived.rows[0].id}:recipient:${f.creator}:channel:${CHANNEL}`,
      recipient_user_id: f.creator,
      recipient_role: 'list_member',
      channel: CHANNEL,
      status: 'pending',
      payload: { kind: 'task_list_event', event: 'archived', listId, eventId: archived.rows[0].id, actorId: f.a },
    }])
    await setTaskListArchived({ orgId: f.orgId, actorId: f.a, listId, archived: false })
    await setTaskListArchived({ orgId: f.orgId, actorId: f.creator, listId, archived: true })
    expect(await outboxOf(listId)).toHaveLength(1)
  })

  it('RULED(2026-10-07): [R05] adding or removing an assignee without a status change, and follower changes, write no row', async () => {
    const f = await fixture('quiet')
    const extra = `usrX_quiet_${stampOf()}`
    await members(f.orgId, extra)
    await addAssignee({ orgId: f.orgId, actorId: f.creator, taskId: f.taskId, body: { userId: extra } })
    await removeAssignee({ orgId: f.orgId, actorId: f.creator, taskId: f.taskId, userId: extra })
    await addFollower({ orgId: f.orgId, actorId: f.creator, taskId: f.taskId, body: { userId: extra } })
    await removeFollower({ orgId: f.orgId, actorId: f.creator, taskId: f.taskId, userId: extra })
    await leaveTask({ orgId: f.orgId, actorId: f.follower, taskId: f.taskId })
    expect(await outboxOf(f.taskId)).toEqual([])
  })

  it('through the router: POST /api/tasks/:id/complete writes the rows', async () => {
    const stamp = stampOf()
    const orgId = orgOf('http', stamp)
    const actor = await seedTaskActor({ label: 'http', stamp, orgId, codes: ['tasks:read', 'tasks:write'], admission: true })
    seededUsers.push(actor.userId)
    seededRoles.push(actor.roleId)
    const creator = `usrC_http_${stamp}`
    const follower = `usrF_http_${stamp}`
    await members(orgId, creator, follower)
    await seedOrgDingTalkIntegration(orgId)
    const task = await createTask({ orgId, creatorId: creator, title: '备料复核', assignees: [actor.userId], completionMode: 'all' })
    await follow(task.id, follower)
    if (!listener) throw new Error('tasks listener not started')
    const reply = await rawRequest(listener.port, 'POST', `/api/tasks/${task.id}/complete`, actor.bearer, {})
    expect(reply.status).toBe(200)
    expect((await recipientsOf(task.id)).map(([user, role]) => [user, role]).sort()).toEqual([[creator, 'creator'], [follower, 'follower']].sort())
  })
})

// M4 PR-3b S3 (design §5.5, §11.3). RULED(2026-10-07): [N1] in `all` mode, an assignee change that
// flips the task's status records `completed` / `reopened` in the same transaction, by the
// operator; the producer notifies it like any other completion or reopen. Recipients are the
// post-write sets (design §4.3, §13-Q22).
describe('M4-b: N1', () => {
  it('removing the only incomplete assignee completes the task: the operator’s completed reaches the follower and the remaining assignee, not the removed one', async () => {
    const f = await fixture('n1remove')
    await completeTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId })
    expect(await outboxOf(f.taskId)).toEqual([])
    await removeAssignee({ orgId: f.orgId, actorId: f.creator, taskId: f.taskId, userId: f.b })
    const status = await poolManager.get().query('SELECT status FROM tasks WHERE id = $1', [f.taskId])
    expect(status.rows[0].status).toBe('done')
    const eventId = await eventIdOf(f.taskId, 'completed')
    const rows = await outboxOf(f.taskId)
    expect(rows.map((row) => [row.recipient_user_id, row.recipient_role]).sort()).toEqual([[f.a, 'assignee'], [f.follower, 'follower']].sort())
    for (const row of rows) {
      expect(row.payload).toEqual({ kind: 'task_event', event: 'completed', taskId: f.taskId, eventId, actorId: f.creator })
    }
  })

  it('adding an assignee to a done task reopens it: the operator’s reopened reaches the follower, the assignees and the added assignee', async () => {
    const f = await fixture('n1add')
    const added = `usrX_n1add_${stampOf()}`
    await members(f.orgId, added)
    await completeTask({ orgId: f.orgId, actorId: f.a, taskId: f.taskId })
    await completeTask({ orgId: f.orgId, actorId: f.b, taskId: f.taskId })
    await addAssignee({ orgId: f.orgId, actorId: f.creator, taskId: f.taskId, body: { userId: added } })
    const status = await poolManager.get().query('SELECT status FROM tasks WHERE id = $1', [f.taskId])
    expect(status.rows[0].status).toBe('open')
    const eventId = await eventIdOf(f.taskId, 'reopened')
    const reopened = (await outboxOf(f.taskId)).filter((row) => row.payload.event === 'reopened')
    expect(reopened.map((row) => [row.recipient_user_id, row.recipient_role]).sort()).toEqual(
      [[f.a, 'assignee'], [f.b, 'assignee'], [added, 'assignee'], [f.follower, 'follower']].sort(),
    )
    for (const row of reopened) {
      expect(row.payload).toEqual({ kind: 'task_event', event: 'reopened', taskId: f.taskId, eventId, actorId: f.creator })
    }
  })

  it('no status flip, no status event and no row: a done all task losing a completed row, a done any task gaining an assignee', async () => {
    const all = await fixture('n1quietall')
    await completeTask({ orgId: all.orgId, actorId: all.a, taskId: all.taskId })
    await completeTask({ orgId: all.orgId, actorId: all.b, taskId: all.taskId })
    const before = await outboxOf(all.taskId)
    expect(before).toHaveLength(3)
    await removeAssignee({ orgId: all.orgId, actorId: all.creator, taskId: all.taskId, userId: all.a })
    expect(await outboxOf(all.taskId)).toEqual(before)
    const completed = await poolManager.get().query(
      `SELECT count(*)::int AS n FROM task_events WHERE task_id = $1 AND event_type = 'completed'`,
      [all.taskId],
    )
    expect(completed.rows[0].n).toBe(1)

    const any = await fixture('n1quietany', { mode: 'any' })
    const added = `usrX_n1quietany_${stampOf()}`
    await members(any.orgId, added)
    await completeTask({ orgId: any.orgId, actorId: any.a, taskId: any.taskId })
    const anyBefore = await outboxOf(any.taskId)
    await addAssignee({ orgId: any.orgId, actorId: any.creator, taskId: any.taskId, body: { userId: added } })
    expect(await outboxOf(any.taskId)).toEqual(anyBefore)
    const reopened = await poolManager.get().query(
      `SELECT count(*)::int AS n FROM task_events WHERE task_id = $1 AND event_type = 'reopened'`,
      [any.taskId],
    )
    expect(reopened.rows[0].n).toBe(0)
  })
})
