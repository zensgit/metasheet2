import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  enqueueTaskEventNotifications,
  enqueueTaskListEventNotifications,
  insertTaskNotificationDeliveries,
  resolveTaskDeliveryChannelsForOrg,
  type WrittenTaskEvent,
} from '../../src/services/task-notification-producer'
import type { Db, Row } from '../../src/services/task-records'
import { buildTaskListsOfTaskCondition } from '../../src/tasks/task-list-access'
import { TASK_NOTIFICATION_CHANNEL_DINGTALK, type TaskNotificationChannel } from '../../src/tasks/task-notifications'

/**
 * M4 PR-3b S2 (design task-m4-pr3b-backend-design-20261001.md §3.1, §5): the producer on a
 * recording `Db`. Pins the order of work (switches, notifying events, the org precondition, the
 * member read, one INSERT), that nothing is read while the pipeline is off, and the rows handed to
 * the INSERT. The rows themselves are the planners' (task-notifications.test.ts); the database
 * behaviour is task-m4-outbox.db.test.ts.
 */

const SWITCHES = [
  'TASKS_SCHEDULER_ENABLED',
  'TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED',
  'TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED',
] as const

const CHANNEL = TASK_NOTIFICATION_CHANNEL_DINGTALK

interface Recorded { sql: string; params: unknown[] }

interface FakeAnswers {
  dingTalkActive?: boolean
  members?: Array<{ member_kind: string; user_id: string }>
  /** How many rows the INSERT reports as new; defaults to every planned row. */
  inserted?: number
}

function fakeDb(answers: FakeAnswers = {}): { db: Db; calls: Recorded[] } {
  const calls: Recorded[] = []
  const db: Db = {
    query: async (sql, params = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      if (sql.includes('FROM directory_integrations')) return { rows: [{ dingtalk_active: answers.dingTalkActive ?? false }] }
      if (sql.includes('UNION ALL')) return { rows: (answers.members ?? []) as Row[] }
      if (sql.includes('INSERT INTO task_notification_deliveries')) {
        const planned = (params[0] as unknown[]).length
        const n = answers.inserted ?? planned
        return { rows: Array.from({ length: n }, (_, i) => ({ id: `row-${i}` })) }
      }
      throw new Error(`unexpected statement: ${sql}`)
    },
  }
  return { db, calls }
}

let saved: Record<string, string | undefined> = {}

function setSwitches(values: Partial<Record<(typeof SWITCHES)[number], string | undefined>>): void {
  for (const key of SWITCHES) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function pipelineOn(): void {
  setSwitches({
    TASKS_SCHEDULER_ENABLED: 'true',
    TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true',
    TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true',
  })
}

beforeEach(() => {
  saved = Object.fromEntries(SWITCHES.map((key) => [key, process.env[key]]))
  setSwitches({})
})

afterEach(() => {
  setSwitches(saved)
})

function event(type: string, actorId: string, id = `tevt_${type}`): WrittenTaskEvent {
  return { id, type, actorId, occurredAt: null }
}

const TASK = { orgId: 'org_a', taskId: 'tsk_1', createdBy: 'usr_creator' }

/** The rows the INSERT was given, one object per row, payload parsed. */
function insertedRows(call: Recorded): Array<Record<string, unknown>> {
  const columns = ['org_id', 'source_type', 'source_id', 'source_key', 'recipient_user_id', 'recipient_role', 'channel', 'payload']
  const arrays = call.params as unknown[][]
  expect(arrays).toHaveLength(columns.length)
  const n = arrays[0].length
  for (const array of arrays) expect(array).toHaveLength(n)
  return Array.from({ length: n }, (_, i) => Object.fromEntries(columns.map((column, c) => [
    column,
    column === 'payload' ? JSON.parse(String(arrays[c][i])) : arrays[c][i],
  ])))
}

describe('task notification producer: nothing is read while the pipeline is off', () => {
  // Every combination of the three switches except all three exactly 'true', plus near-miss values.
  const offStates: Array<Partial<Record<(typeof SWITCHES)[number], string>>> = []
  for (let mask = 0; mask < 7; mask += 1) {
    offStates.push(Object.fromEntries(SWITCHES.filter((_, i) => (mask >> i) & 1).map((key) => [key, 'true'])))
  }
  offStates.push(
    { TASKS_SCHEDULER_ENABLED: 'TRUE', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true', TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true' },
    { TASKS_SCHEDULER_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: ' true', TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true' },
    { TASKS_SCHEDULER_ENABLED: 'true', TASKS_NOTIFICATION_DELIVERY_WORKER_ENABLED: 'true', TASKS_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: '1' },
  )

  it('the event producer sends no statement and writes nothing for every state that is not all three switches on', async () => {
    expect(offStates).toHaveLength(10)
    for (const state of offStates) {
      setSwitches(state)
      const { db, calls } = fakeDb({ dingTalkActive: true, members: [{ member_kind: 'follower', user_id: 'usr_f' }] })
      await expect(enqueueTaskEventNotifications(db, { ...TASK, events: [event('completed', 'usr_a')] })).resolves.toBe(0)
      expect(calls, JSON.stringify(state)).toEqual([])
    }
  })

  it('the list producer sends no statement and writes nothing for every state that is not all three switches on', async () => {
    for (const state of offStates) {
      setSwitches(state)
      const { db, calls } = fakeDb({ dingTalkActive: true })
      await expect(enqueueTaskListEventNotifications(db, {
        orgId: 'org_a', listId: 'tlst_1', listCreatorId: 'usr_creator', actorId: 'usr_a', event: { id: 'tlev_1', type: 'archived' },
      })).resolves.toBe(0)
      expect(calls, JSON.stringify(state)).toEqual([])
    }
  })

  it('TASKS_ENABLED is not part of the predicate: the three switches alone turn the producer on', async () => {
    pipelineOn()
    const previous = process.env.TASKS_ENABLED
    delete process.env.TASKS_ENABLED
    try {
      const { db, calls } = fakeDb({ dingTalkActive: false })
      await enqueueTaskEventNotifications(db, { ...TASK, events: [event('completed', 'usr_a')] })
      expect(calls).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.TASKS_ENABLED
      else process.env.TASKS_ENABLED = previous
    }
  })
})

describe('task notification producer: events that do not notify', () => {
  it('RULED(2026-10-07): [R05] [D13] with the pipeline on, a batch without a notifying event sends no statement', async () => {
    pipelineOn()
    const quiet = [
      'assignee_added', 'assignee_removed', 'self_completed', 'self_reopened', 'completion_mode_changed',
      'follower_added', 'follower_removed', 'left', 'created', 'remind_changed', 'parent_changed',
      'list_added', 'list_removed', 'group_changed', 'attachment_added', 'archived', '',
    ]
    for (const type of quiet) {
      const { db, calls } = fakeDb({ dingTalkActive: true, members: [{ member_kind: 'follower', user_id: 'usr_f' }] })
      await expect(enqueueTaskEventNotifications(db, { ...TASK, events: [event(type, 'usr_a')] })).resolves.toBe(0)
      expect(calls, type).toEqual([])
    }
    const { db, calls } = fakeDb({ dingTalkActive: true })
    await expect(enqueueTaskEventNotifications(db, { ...TASK, events: [] })).resolves.toBe(0)
    expect(calls).toEqual([])
  })

  it('the list producer: only archived notifies; every other list event sends no statement', async () => {
    pipelineOn()
    for (const type of ['created', 'renamed', 'unarchived', 'member_added', 'member_removed', 'item_added', 'group_created', 'completed', '']) {
      const { db, calls } = fakeDb({ dingTalkActive: true })
      await expect(enqueueTaskListEventNotifications(db, {
        orgId: 'org_a', listId: 'tlst_1', listCreatorId: 'usr_creator', actorId: 'usr_a', event: { id: 'tlev_1', type },
      })).resolves.toBe(0)
      expect(calls, type).toEqual([])
    }
  })

  it('the list producer: the creator archiving their own list has no recipient, so nothing is read', async () => {
    pipelineOn()
    const { db, calls } = fakeDb({ dingTalkActive: true })
    await expect(enqueueTaskListEventNotifications(db, {
      orgId: 'org_a', listId: 'tlst_1', listCreatorId: 'usr_creator', actorId: 'usr_creator', event: { id: 'tlev_1', type: 'archived' },
    })).resolves.toBe(0)
    expect(calls).toEqual([])
  })
})

describe('task notification producer: the org precondition', () => {
  it('ASSUMPTION(task-m4): [own-3b-13] the check is one EXISTS on an active DingTalk integration of the same org', async () => {
    const { db, calls } = fakeDb({ dingTalkActive: true })
    await expect(resolveTaskDeliveryChannelsForOrg(db, 'org_a', [CHANNEL])).resolves.toEqual([CHANNEL])
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toBe(
      "SELECT EXISTS ( SELECT 1 FROM directory_integrations WHERE org_id = $1 AND provider = 'dingtalk' AND status = 'active' ) AS dingtalk_active",
    )
    expect(calls[0].params).toEqual(['org_a'])
  })

  it('no active integration ⇒ no channel; no channel asked ⇒ no query; an unknown channel name is dropped', async () => {
    const inactive = fakeDb({ dingTalkActive: false })
    await expect(resolveTaskDeliveryChannelsForOrg(inactive.db, 'org_a', [CHANNEL])).resolves.toEqual([])
    const none = fakeDb({ dingTalkActive: true })
    await expect(resolveTaskDeliveryChannelsForOrg(none.db, 'org_a', [])).resolves.toEqual([])
    expect(none.calls).toEqual([])
    const unknown = fakeDb({ dingTalkActive: true })
    await expect(resolveTaskDeliveryChannelsForOrg(unknown.db, 'org_a', ['mail' as TaskNotificationChannel, CHANNEL])).resolves.toEqual([CHANNEL])
  })

  it('without an active integration the event producer stops after the check: no member read, no INSERT', async () => {
    pipelineOn()
    const { db, calls } = fakeDb({ dingTalkActive: false, members: [{ member_kind: 'follower', user_id: 'usr_f' }] })
    await expect(enqueueTaskEventNotifications(db, { ...TASK, events: [event('completed', 'usr_a')] })).resolves.toBe(0)
    expect(calls.map((call) => call.sql.slice(0, 15))).toEqual(['SELECT EXISTS ('])
    expect(calls[0].params).toEqual(['org_a'])
  })

  it('without an active integration the list producer stops after the check', async () => {
    pipelineOn()
    const { db, calls } = fakeDb({ dingTalkActive: false })
    await expect(enqueueTaskListEventNotifications(db, {
      orgId: 'org_b', listId: 'tlst_1', listCreatorId: 'usr_creator', actorId: 'usr_a', event: { id: 'tlev_1', type: 'archived' },
    })).resolves.toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toEqual(['org_b'])
  })
})

describe('task notification producer: members, recipients and the INSERT', () => {
  const members = [
    { member_kind: 'assignee', user_id: 'usr_a' },
    { member_kind: 'assignee', user_id: 'usr_b' },
    { member_kind: 'follower', user_id: 'usr_f' },
    { member_kind: 'follower', user_id: 'usr_a' },
    { member_kind: 'list_member', user_id: 'usr_l' },
    { member_kind: 'list_member', user_id: 'usr_f' },
    { member_kind: 'list_member', user_id: 'usr_creator' },
  ]

  it('order of work: the check, one member read on the task id and org, then one INSERT', async () => {
    pipelineOn()
    const { db, calls } = fakeDb({ dingTalkActive: true, members })
    await enqueueTaskEventNotifications(db, { ...TASK, events: [event('completed', 'usr_a')] })
    expect(calls).toHaveLength(3)
    expect(calls[0].sql.startsWith('SELECT EXISTS ( SELECT 1 FROM directory_integrations')).toBe(true)
    const lists = buildTaskListsOfTaskCondition({ taskIdParam: 'tsk_1', orgParam: 'org_a' })
    expect(calls[1].sql).toBe(
      "SELECT 'assignee' AS member_kind, ta.user_id FROM task_assignees ta WHERE ta.task_id = $1 " +
      "UNION ALL SELECT 'follower' AS member_kind, tf.user_id FROM task_followers tf WHERE tf.task_id = $1 " +
      "UNION ALL SELECT 'list_member' AS member_kind, tlm.user_id FROM task_lists " +
      `JOIN task_list_members tlm ON tlm.list_id = task_lists.id WHERE ${lists.sql}`,
    )
    expect(calls[1].params).toEqual(['tsk_1', 'org_a'])
    expect(calls[2].sql.startsWith('INSERT INTO task_notification_deliveries')).toBe(true)
    expect(calls.some((call) => /FROM tasks\b/.test(call.sql))).toBe(false)
  })

  it('RULED(2026-10-07): [R05] [D13] one row per recipient at the highest role; the actor gets none', async () => {
    pipelineOn()
    const { db, calls } = fakeDb({ dingTalkActive: true, members })
    await expect(enqueueTaskEventNotifications(db, { ...TASK, events: [event('completed', 'usr_a', 'tevt_9')] })).resolves.toBe(4)
    const rows = insertedRows(calls[2])
    expect(rows.map((row) => [row.recipient_user_id, row.recipient_role])).toEqual([
      ['usr_b', 'assignee'],
      ['usr_creator', 'creator'],
      ['usr_f', 'follower'],
      ['usr_l', 'list_member'],
    ])
    for (const row of rows) {
      expect(row).toMatchObject({
        org_id: 'org_a',
        source_type: 'task_event',
        source_id: 'tsk_1',
        channel: CHANNEL,
        source_key: `task_event:tsk_1:tevt_9:recipient:${String(row.recipient_user_id)}:channel:${CHANNEL}`,
      })
      expect(row.payload).toEqual({ kind: 'task_event', event: 'completed', taskId: 'tsk_1', eventId: 'tevt_9', actorId: 'usr_a' })
    }
  })

  it('the INSERT: eight columns from arrays, ON CONFLICT (org_id, source_key) DO NOTHING, RETURNING id', async () => {
    pipelineOn()
    const { db, calls } = fakeDb({ dingTalkActive: true, members })
    await enqueueTaskEventNotifications(db, { ...TASK, events: [event('commented', 'usr_f')] })
    expect(calls[2].sql).toBe(
      'INSERT INTO task_notification_deliveries (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload) ' +
      'SELECT r.org_id, r.source_type, r.source_id, r.source_key, r.recipient_user_id, r.recipient_role, r.channel, r.payload::jsonb ' +
      'FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) ' +
      'AS r(org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload) ' +
      'ON CONFLICT (org_id, source_key) DO NOTHING RETURNING id',
    )
    // No status, attempt or schedule column is written: those are the column defaults.
    expect(calls[2].sql.includes('status')).toBe(false)
    expect(calls[2].sql.includes('next_attempt_at')).toBe(false)
    const rows = insertedRows(calls[2])
    expect(rows.map((row) => row.recipient_user_id)).toEqual(['usr_a', 'usr_b', 'usr_creator', 'usr_l'])
  })

  it('the return value is the number of rows the INSERT reports as new', async () => {
    pipelineOn()
    const { db } = fakeDb({ dingTalkActive: true, members, inserted: 1 })
    await expect(enqueueTaskEventNotifications(db, { ...TASK, events: [event('reopened', 'usr_b')] })).resolves.toBe(1)
  })

  it('only the notifying events of a batch get rows, each under its own event id, in one INSERT', async () => {
    pipelineOn()
    const { db, calls } = fakeDb({ dingTalkActive: true, members: [{ member_kind: 'follower', user_id: 'usr_f' }] })
    await enqueueTaskEventNotifications(db, {
      ...TASK,
      events: [event('assignee_removed', 'usr_a', 'tevt_1'), event('completed', 'usr_a', 'tevt_2'), event('commented', 'usr_a', 'tevt_3')],
    })
    expect(calls.filter((call) => call.sql.startsWith('INSERT'))).toHaveLength(1)
    const rows = insertedRows(calls[2])
    expect(rows.map((row) => [row.recipient_user_id, (row.payload as { eventId: string }).eventId, (row.payload as { event: string }).event])).toEqual([
      ['usr_creator', 'tevt_2', 'completed'],
      ['usr_f', 'tevt_2', 'completed'],
      ['usr_creator', 'tevt_3', 'commented'],
      ['usr_f', 'tevt_3', 'commented'],
    ])
  })

  it('every candidate is the actor: the members are read, nothing is inserted', async () => {
    pipelineOn()
    const { db, calls } = fakeDb({ dingTalkActive: true, members: [{ member_kind: 'assignee', user_id: 'usr_creator' }] })
    await expect(enqueueTaskEventNotifications(db, { ...TASK, events: [event('deleted', 'usr_creator')] })).resolves.toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls.some((call) => call.sql.startsWith('INSERT'))).toBe(false)
  })

  it('a member row of an unknown kind is ignored', async () => {
    pipelineOn()
    const { db, calls } = fakeDb({ dingTalkActive: true, members: [{ member_kind: 'observer', user_id: 'usr_o' }] })
    await enqueueTaskEventNotifications(db, { ...TASK, events: [event('commented', 'usr_a')] })
    expect(insertedRows(calls[2]).map((row) => row.recipient_user_id)).toEqual(['usr_creator'])
  })

  it('the list producer: the list creator, as list_member, under the list event id, in one INSERT after the check', async () => {
    pipelineOn()
    const { db, calls } = fakeDb({ dingTalkActive: true })
    await expect(enqueueTaskListEventNotifications(db, {
      orgId: 'org_a', listId: 'tlst_1', listCreatorId: 'usr_creator', actorId: 'usr_a', event: { id: 'tlev_7', type: 'archived' },
    })).resolves.toBe(1)
    expect(calls).toHaveLength(2)
    expect(insertedRows(calls[1])).toEqual([{
      org_id: 'org_a',
      source_type: 'task_list_event',
      source_id: 'tlst_1',
      source_key: `task_list_event:tlst_1:tlev_7:recipient:usr_creator:channel:${CHANNEL}`,
      recipient_user_id: 'usr_creator',
      recipient_role: 'list_member',
      channel: CHANNEL,
      payload: { kind: 'task_list_event', event: 'archived', listId: 'tlst_1', eventId: 'tlev_7', actorId: 'usr_a' },
    }])
  })

  it('insertTaskNotificationDeliveries with no row sends nothing', async () => {
    const { db, calls } = fakeDb()
    await expect(insertTaskNotificationDeliveries(db, [])).resolves.toBe(0)
    expect(calls).toEqual([])
  })
})
