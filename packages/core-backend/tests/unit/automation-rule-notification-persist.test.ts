/**
 * F9b — automation RULE `send_notification` writes to the Notification Centre.
 *
 * GAP this pins: the rule path used to ONLY `eventBus.emit('automation.notification', …)` and the repo
 * has NO listener for that event, so "test run succeeded" never produced a visible notification. The
 * button route (routes/multitable-button.ts) was already durable; this suite asserts the rule path now
 * shares the SAME write seam (`insertRecordSubscriptionNotifications`) and the SAME recipient口径
 * (`loadSheetMemberUserIdSet`), with the write strictly BEFORE the legacy emit.
 *
 * Every assertion here is on the executor's ONLY outbound seam for this action: `deps.queryFn`.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AutomationExecutor,
  AUTOMATION_NO_RECIPIENTS_ERROR,
  AUTOMATION_NOTIFICATION_SINK_UNAVAILABLE_ERROR,
  AUTOMATION_RECIPIENT_NOT_AUTHORIZED_ERROR,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'

const SHEET_ID = 'sheet_f9b'
const RECORD_ID = 'rec_f9b'
const ACTOR_ID = 'actor_1'
const NOTIFICATION_TABLE = 'meta_record_subscription_notifications'

const MEMBER_ROSTER_SQL = /WITH user_candidates AS/i
const MEMBER_ELIGIBILITY_SQL = /FROM user_permissions up/i
const NOTIFICATION_INSERT_SQL = new RegExp(`INSERT INTO ${NOTIFICATION_TABLE}`, 'i')

type RecordedCall = { sql: string; params?: unknown[] }

interface Harness {
  deps: AutomationDeps
  calls: RecordedCall[]
  order: string[]
  emit: ReturnType<typeof vi.spyOn>
  insertCalls: () => RecordedCall[]
  insertedRows: () => Array<Record<string, unknown>>
}

function makeHarness(options: { members?: string[]; insertError?: Error } = {}): Harness {
  const members = options.members ?? ['u1', 'u2']
  const calls: RecordedCall[] = []
  const order: string[] = []
  const eventBus = new EventBus()

  const queryFn = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    if (MEMBER_ROSTER_SQL.test(sql)) {
      return {
        rows: members.map((id) => ({
          subject_type: 'user',
          subject_id: id,
          user_name: id,
          user_email: `${id}@members.test`,
          user_is_active: true,
          permission_codes: ['multitable:read'],
        })),
        rowCount: members.length,
      }
    }
    if (MEMBER_ELIGIBILITY_SQL.test(sql)) {
      return {
        rows: members.map((id) => ({ user_id: id, permission_code: 'multitable:read' })),
        rowCount: members.length,
      }
    }
    if (NOTIFICATION_INSERT_SQL.test(sql)) {
      order.push('insert')
      if (options.insertError) throw options.insertError
      return { rows: [], rowCount: members.length }
    }
    if (/FROM meta_sheets/i.test(sql)) return { rows: [{ base_id: 'base_f9b' }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })

  const emit = vi.spyOn(eventBus, 'emit').mockImplementation(((event: string, payload: unknown) => {
    if (event === 'automation.notification') order.push('emit')
    return EventBus.prototype.emit.call(eventBus, event as never, payload as never)
  }) as never)

  const insertCalls = () => calls.filter((call) => NOTIFICATION_INSERT_SQL.test(call.sql))
  const insertedRows = () => {
    const call = insertCalls()[0]
    if (!call) return []
    return JSON.parse(String((call.params ?? [])[0] ?? '[]')) as Array<Record<string, unknown>>
  }

  return { deps: { eventBus, queryFn }, calls, order, emit, insertCalls, insertedRows }
}

function notifyRule(config: Record<string, unknown>): AutomationRule {
  return {
    id: 'rule_f9b',
    name: 'F9b notify',
    sheetId: SHEET_ID,
    trigger: { type: 'record.updated', config: {} },
    actions: [{ type: 'send_notification', config }],
    enabled: true,
    createdBy: 'user_author',
    createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}

const TRIGGER = { recordId: RECORD_ID, data: { status: 'done' }, actorId: ACTOR_ID }

describe('F9b — rule send_notification persists to the notification centre', () => {
  it('writes ONE notification.sent row per recipient through the shared seam (message/actor/sheet/record intact)', async () => {
    const h = makeHarness({ members: ['u1', 'u2'] })
    const execution = await new AutomationExecutor(h.deps).execute(
      notifyRule({ userIds: ['u1', 'u2'], message: 'Ping' }),
      TRIGGER,
    )

    expect(execution.status).toBe('success')
    expect(execution.steps[0].status).toBe('success')
    expect(execution.steps[0].simulated).toBeUndefined()

    // The write really happened, on the executor's injected queryFn, into the ONE durable table.
    expect(h.insertCalls()).toHaveLength(1)
    const rows = h.insertedRows()
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.user_id)).toEqual(['u1', 'u2'])
    for (const row of rows) {
      expect(row.event_type).toBe('notification.sent')
      expect(row.message).toBe('Ping')
      expect(row.actor_id).toBe(ACTOR_ID)
      expect(row.sheet_id).toBe(SHEET_ID)
      expect(row.record_id).toBe(RECORD_ID)
    }
    expect(h.emit).toHaveBeenCalledWith(
      'automation.notification',
      expect.objectContaining({ userIds: ['u1', 'u2'], message: 'Ping' }),
    )
  })

  it('EMIT HAPPENS AFTER THE WRITE — never a phantom notification announced before it is durable', async () => {
    const h = makeHarness({ members: ['u1'] })
    await new AutomationExecutor(h.deps).execute(notifyRule({ userIds: ['u1'], message: 'Ping' }), TRIGGER)
    expect(h.order).toEqual(['insert', 'emit'])
  })

  it('a NON-MEMBER recipient fails the WHOLE step: no row for anyone, no emit (no partial delivery)', async () => {
    const h = makeHarness({ members: ['u1'] }) // u_outsider is not a member
    const execution = await new AutomationExecutor(h.deps).execute(
      notifyRule({ userIds: ['u1', 'u_outsider'], message: 'Ping' }),
      TRIGGER,
    )

    expect(execution.status).toBe('failed')
    expect(execution.steps[0].status).toBe('failed')
    expect(execution.steps[0].error).toBe(AUTOMATION_RECIPIENT_NOT_AUTHORIZED_ERROR)
    expect(execution.steps[0].error).toContain('RECIPIENT_NOT_AUTHORIZED')
    // No INSERT was issued at all (the membership read is the only queryFn traffic).
    expect(h.insertCalls()).toHaveLength(0)
    expect(h.emit).not.toHaveBeenCalledWith('automation.notification', expect.anything())
    // Values-free: the rejection text never leaks the rejected ids.
    expect(execution.steps[0].error).not.toContain('u_outsider')
  })

  it('an UNRESOLVABLE member set is the EMPTY set — fail-closed, not fail-open', async () => {
    const h = makeHarness({ members: [] })
    const execution = await new AutomationExecutor(h.deps).execute(
      notifyRule({ userIds: ['u1'], message: 'Ping' }),
      TRIGGER,
    )
    expect(execution.steps[0].status).toBe('failed')
    expect(execution.steps[0].error).toContain('RECIPIENT_NOT_AUTHORIZED')
    expect(h.insertCalls()).toHaveLength(0)
  })

  it('SIMULATE (test run) writes nothing and emits nothing', async () => {
    const h = makeHarness({ members: ['u1'] })
    const execution = await new AutomationExecutor(h.deps).execute(
      notifyRule({ userIds: ['u1'], message: 'Ping' }),
      TRIGGER,
      undefined,
      undefined,
      'simulate',
    )

    expect(execution.status).toBe('success')
    expect(execution.steps[0].simulated).toBe(true)
    expect(h.insertCalls()).toHaveLength(0)
    expect(h.order).toEqual([])
    expect(h.emit).not.toHaveBeenCalledWith('automation.notification', expect.anything())
  })

  it('a FAILING insert fails the step and suppresses the emit (no "sent" without a row)', async () => {
    const h = makeHarness({ members: ['u1'], insertError: new Error('insert exploded') })
    const execution = await new AutomationExecutor(h.deps).execute(
      notifyRule({ userIds: ['u1'], message: 'Ping' }),
      TRIGGER,
    )

    expect(execution.status).toBe('failed')
    expect(execution.steps[0].error).toContain('send_notification durable write failed')
    expect(h.emit).not.toHaveBeenCalledWith('automation.notification', expect.anything())
    expect(h.order).toEqual(['insert']) // attempted, threw, and NOTHING was emitted after it
  })

  it('a MISSING table is NOT swallowed as "0 rows delivered" — the step fails loudly', async () => {
    const undefinedTable = Object.assign(
      new Error(`relation "${NOTIFICATION_TABLE}" does not exist`),
      { code: '42P01' },
    )
    const h = makeHarness({ members: ['u1'], insertError: undefinedTable })
    const execution = await new AutomationExecutor(h.deps).execute(
      notifyRule({ userIds: ['u1'], message: 'Ping' }),
      TRIGGER,
    )

    expect(execution.status).toBe('failed')
    expect(execution.steps[0].status).toBe('failed')
    expect(execution.steps[0].error).toContain('does not exist')
    expect(h.emit).not.toHaveBeenCalledWith('automation.notification', expect.anything())
  })

  it('NO SINK (deps.queryFn absent) fails closed instead of degrading to an eventBus-only phantom', async () => {
    const eventBus = new EventBus()
    const emit = vi.spyOn(eventBus, 'emit')
    const execution = await new AutomationExecutor({ eventBus } as unknown as AutomationDeps).execute(
      notifyRule({ userIds: ['u1'], message: 'Ping' }),
      TRIGGER,
    )

    expect(execution.status).toBe('failed')
    expect(execution.steps[0].error).toBe(AUTOMATION_NOTIFICATION_SINK_UNAVAILABLE_ERROR)
    expect(execution.steps[0].error).toContain('notification sink unavailable')
    expect(emit).not.toHaveBeenCalledWith('automation.notification', expect.anything())
  })

  it('no recipients still fails explicitly (F9 line held) with zero queryFn traffic and no emit', async () => {
    const h = makeHarness()
    const execution = await new AutomationExecutor(h.deps).execute(
      notifyRule({ userIds: [], message: 'Ping' }),
      TRIGGER,
    )
    expect(execution.steps[0].error).toBe(AUTOMATION_NO_RECIPIENTS_ERROR)
    expect(h.calls).toHaveLength(0)
    expect(h.emit).not.toHaveBeenCalledWith('automation.notification', expect.anything())
  })

  it('blank-only recipients are rejected as NO_RECIPIENTS (they never become a zero-row "success")', async () => {
    const h = makeHarness()
    const execution = await new AutomationExecutor(h.deps).execute(
      notifyRule({ userIds: ['  ', ''], message: 'Ping' }),
      TRIGGER,
    )
    expect(execution.steps[0].error).toBe(AUTOMATION_NO_RECIPIENTS_ERROR)
    expect(h.insertCalls()).toHaveLength(0)
  })

  it('DUPLICATE SEMANTICS, STATED: the rule path has no dedup ledger — two runs write two sets of rows', async () => {
    const h = makeHarness({ members: ['u1'] })
    const executor = new AutomationExecutor(h.deps)
    const rule = notifyRule({ userIds: ['u1'], message: 'Ping' })
    await executor.execute(rule, TRIGGER)
    await executor.execute(rule, TRIGGER) // e.g. a whole-execution retry replays step 0
    expect(h.insertCalls()).toHaveLength(2)
    expect(h.order).toEqual(['insert', 'emit', 'insert', 'emit'])
  })
})
