/**
 * DingTalk approval-todo ONE-WAY mirror — the CONSUMER half (design
 * docs/development/takeover-beiliao-20260821/dingtalk-todo-mirror-b-design-20260916.md §4/§9).
 *
 * Service-level unit tests with an injected fake pg client (no supertest, no app-mode, no DB — the
 * #4154 tripwire forbids `request(app)` in tests/unit).
 *
 * THE FAKE IS A STATE MACHINE, NOT A CANNED rowCount (Q19 re-review). It keeps real rows plus a real
 * `approval_assignments` seat list, and it DERIVES ITS BEHAVIOUR FROM THE SQL TEXT it is handed:
 *   - the UNIQUE (org_id, source_key) index is simulated, so an INSERT without `ON CONFLICT DO NOTHING`
 *     raises SQLSTATE 23505 exactly as Postgres would;
 *   - the sweep's `NOT EXISTS (… approval_assignments …)` liveness arm is only applied when the
 *     statement actually contains it — delete the arm from the production SQL and the parallel-branch /
 *     redelivery / reassign tests below go RED instead of silently passing on a canned rowCount;
 *   - likewise the insert's `WHERE EXISTS (…)` seat gate and the sweep's recipient term.
 *
 * What is pinned here:
 *   - flag OFF  => ACK, ZERO queries, no rows (design §2.5);
 *   - duplicate task_created => exactly ONE ledger row (the idempotency contract);
 *   - a new node's activation retires the seats that are NO LONGER LIVE and never a live sibling
 *     (parallel gateway), never the current seat on an at-least-once REPLAY of an older event, and
 *     DOES retire a seat that was reassigned away inside the same round;
 *   - a terminal approval retires pending => skipped and created => completing with the outcome;
 *   - an instance with a NULL org_id writes NOTHING (tenancy);
 *   - every log line is values-free.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  applyTodoMirrorCompletion,
  applyTodoMirrorTaskCreated,
  createDingTalkTodoMirrorSink,
  subscribeDingTalkTodoMirrorBus,
  TODO_MIRROR_COMPLETION_EVENT_TYPES,
} from '../../src/services/dingtalk-todo-mirror-service'
import type { ApprovalCompletionEventV1 } from '../../src/services/ApprovalCompletionEvent'
import type { ApprovalTaskCreatedEventV1 } from '../../src/services/ApprovalTaskCreatedEvent'

const FLAG_ON = { DINGTALK_TODO_MIRROR_ENABLED: 'true' } as NodeJS.ProcessEnv
const FLAG_OFF = {} as NodeJS.ProcessEnv

type Call = { sql: string; params: unknown[] }

/** One `approval_assignments` row as far as this ledger cares. */
type Seat = { nodeKey: string; entryEpoch: number | null; userId: string; isActive: boolean }

type LedgerRow = {
  org_id: string
  instance_id: string
  node_key: string
  entry_epoch: number | null
  recipient_user_id: string
  source_key: string
  status: string
  complete_reason: string | null
}

const sameEpoch = (a: number | null, b: number | null) => a === b

function seat(nodeKey: string, entryEpoch: number | null, userId: string, isActive = true): Seat {
  return { nodeKey, entryEpoch, userId, isActive }
}

interface LedgerOptions {
  orgId?: string | null
  instanceMissing?: boolean
  seats?: Seat[]
  rows?: LedgerRow[]
}

function fakeLedger(options: LedgerOptions = {}) {
  const calls: Call[] = []
  const rows: LedgerRow[] = options.rows ?? []
  const seats: Seat[] = options.seats ?? []
  const isSeatLive = (nodeKey: string, epoch: number | null, userId: string) =>
    seats.some((s) => s.isActive && s.nodeKey === nodeKey && sameEpoch(s.entryEpoch, epoch) && s.userId === userId)

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })

    if (sql.includes('FROM approval_instances')) {
      if (options.instanceMissing) return { rows: [], rowCount: 0 }
      return { rows: [{ org_id: options.orgId === undefined ? 'org-1' : options.orgId }], rowCount: 1 }
    }

    if (sql.includes('INSERT INTO dingtalk_todo_mirrors')) {
      const [orgId, instanceId, , , nodeKey, epoch, userId, sourceKey] = params as [
        string, string, string | null, string | null, string, number | null, string, string,
      ]
      // the seat gate, applied ONLY if the statement carries it
      const seatGated = /WHERE EXISTS\s*\(\s*SELECT 1 FROM approval_assignments/.test(sql)
      if (seatGated && !isSeatLive(nodeKey, epoch, userId)) return { rows: [], rowCount: 0 }
      const existing = rows.find((r) => r.org_id === orgId && r.source_key === sourceKey)
      if (existing) {
        if (!/ON CONFLICT \(org_id, source_key\) DO NOTHING/.test(sql)) {
          throw Object.assign(
            new Error('duplicate key value violates unique constraint "uq_dingtalk_todo_mirrors_source_key"'),
            { code: '23505' },
          )
        }
        return { rows: [], rowCount: 0 }
      }
      rows.push({
        org_id: orgId,
        instance_id: instanceId,
        node_key: nodeKey,
        entry_epoch: epoch,
        recipient_user_id: userId,
        source_key: sourceKey,
        status: 'pending',
        complete_reason: null,
      })
      return { rows: [], rowCount: 1 }
    }

    if (sql.includes('UPDATE dingtalk_todo_mirrors')) {
      // the task_created sweep and the terminal sweep differ by their non-created branch
      const isTaskCreatedSweep = sql.includes("ELSE 'superseded' END")
      const excludesAnnouncer = sql.includes('AND NOT (d.node_key = $3')
      const excludeCarriesRecipient = sql.includes('d.recipient_user_id = $5')
      const livenessGated = /NOT EXISTS\s*\(\s*SELECT 1 FROM approval_assignments/.test(sql)
      let touched = 0
      if (isTaskCreatedSweep) {
        const [instanceId, orgId, nodeKey, epoch, recipient] = params as [string, string, string, number | null, string]
        for (const row of rows) {
          if (row.instance_id !== instanceId || row.org_id !== orgId) continue
          if (row.status !== 'pending' && row.status !== 'created') continue
          const isAnnouncer = row.node_key === nodeKey
            && sameEpoch(row.entry_epoch, epoch)
            && (!excludeCarriesRecipient || row.recipient_user_id === recipient)
          if (excludesAnnouncer && isAnnouncer) continue
          if (livenessGated && isSeatLive(row.node_key, row.entry_epoch, row.recipient_user_id)) continue
          row.status = row.status === 'created' ? 'completing' : 'superseded'
          row.complete_reason = 'next_node'
          touched += 1
        }
      } else {
        const [instanceId, orgId, reason] = params as [string, string, string]
        for (const row of rows) {
          if (row.instance_id !== instanceId || row.org_id !== orgId) continue
          if (row.status !== 'pending' && row.status !== 'created') continue
          row.status = row.status === 'created' ? 'completing' : 'skipped'
          row.complete_reason = reason
          touched += 1
        }
      }
      return { rows: [], rowCount: touched }
    }

    return { rows: [], rowCount: 0 }
  })

  const snapshot = () => rows.map((r) => `${r.node_key}/${r.recipient_user_id}=${r.status}`)
  return { query: query as never, calls, rows, seats, snapshot }
}

function taskCreatedEvent(over: Partial<{ instanceId: string; nodeKey: string; entryEpoch: number | null; assignee: string; eventId: string }> = {}): ApprovalTaskCreatedEventV1 {
  const instanceId = over.instanceId ?? 'inst-1'
  const nodeKey = over.nodeKey ?? 'node-a'
  const entryEpoch = over.entryEpoch === undefined ? 1 : over.entryEpoch
  const assignee = over.assignee ?? 'user-1'
  return {
    version: 1,
    eventId: over.eventId ?? `approval-task:${instanceId}:${nodeKey}:${String(entryEpoch)}:${assignee}`,
    eventType: 'approval.task_created',
    occurredAt: '2026-09-16T00:00:00.000Z',
    source: 'approval-product',
    approval: {
      instanceId,
      requestNo: 'REQ-0001',
      templateId: 'tpl-1',
      templateVersionId: null,
      publishedDefinitionId: null,
      businessKey: null,
      workflowKey: null,
    },
    task: { nodeKey, entryEpoch, assigneeUserId: assignee, sourceStep: 1 },
    requester: { id: 'user-0' },
  }
}

function completionEvent(eventType: string, instanceId = 'inst-1'): ApprovalCompletionEventV1 {
  return {
    version: 1,
    eventId: `approval:${instanceId}:2:${eventType}`,
    eventType: eventType as ApprovalCompletionEventV1['eventType'],
    occurredAt: '2026-09-16T00:01:00.000Z',
    source: 'approval-product',
    approval: {
      instanceId,
      requestNo: 'REQ-0001',
      templateId: 'tpl-1',
      templateVersionId: null,
      publishedDefinitionId: null,
      businessKey: null,
      workflowKey: null,
    },
    transition: { fromStatus: 'pending', toStatus: 'approved', toVersion: 2 } as ApprovalCompletionEventV1['transition'],
    actor: null,
    requester: { id: 'user-0' },
  }
}

describe('todo mirror consumer — the DINGTALK_TODO_MIRROR_ENABLED gate', () => {
  it('flag OFF: task_created ACKs with ZERO queries and ZERO rows', async () => {
    const ledger = fakeLedger()
    const result = await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent(), { env: FLAG_OFF })
    expect(result).toEqual({ handled: false, skippedReason: 'flag_off' })
    expect(ledger.calls).toEqual([])
    expect(ledger.rows).toEqual([])
  })

  it('flag OFF: a terminal approval ACKs with ZERO queries', async () => {
    const ledger = fakeLedger()
    const result = await applyTodoMirrorCompletion(ledger.query, completionEvent('approval.approved'), { env: FLAG_OFF })
    expect(result).toEqual({ handled: false, skippedReason: 'flag_off' })
    expect(ledger.calls).toEqual([])
  })

  it('a flag value that is not the exact literal true stays OFF', async () => {
    for (const value of ['TRUE', '1', 'yes', 'true ', '']) {
      const ledger = fakeLedger({ seats: [seat('node-a', 1, 'user-1')] })
      const env = { DINGTALK_TODO_MIRROR_ENABLED: value } as NodeJS.ProcessEnv
      const result = await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent(), { env })
      // ' true ' trims to 'true' by design (an env file with trailing whitespace must still work);
      // everything else is OFF.
      if (value.trim().toLowerCase() === 'true') {
        expect(result.handled).toBe(true)
      } else {
        expect(result).toEqual({ handled: false, skippedReason: 'flag_off' })
        expect(ledger.calls).toEqual([])
      }
    }
  })
})

describe('todo mirror consumer — task_created', () => {
  it('inserts exactly ONE pending seat and is IDEMPOTENT under a duplicate delivery', async () => {
    const ledger = fakeLedger({ seats: [seat('node-a', 1, 'user-1')] })
    const event = taskCreatedEvent()
    const first = await applyTodoMirrorTaskCreated(ledger.query, event, { env: FLAG_ON })
    const second = await applyTodoMirrorTaskCreated(ledger.query, event, { env: FLAG_ON })
    expect(first.insertedRows).toBe(1)
    expect(second.insertedRows).toBe(0)
    expect(ledger.rows).toHaveLength(1)
    const insert = ledger.calls.find((c) => c.sql.includes('INSERT INTO dingtalk_todo_mirrors'))!
    // the idempotency contract, pinned as text: the conflict TARGET is the ledger's unique index
    expect(insert.sql).toContain('ON CONFLICT (org_id, source_key) DO NOTHING')
    // source_key IS the task_created eventId
    expect(insert.params[7]).toBe(event.eventId)
    expect(insert.params[0]).toBe('org-1')
    expect(insert.params[6]).toBe('user-1')
  })

  it('retires the seats that are no longer live and never the seat it is announcing', async () => {
    const ledger = fakeLedger({
      seats: [seat('node-a', 1, 'user-1', false), seat('node-b', 2, 'user-2')],
      rows: [{
        org_id: 'org-1', instance_id: 'inst-1', node_key: 'node-a', entry_epoch: 1,
        recipient_user_id: 'user-1', source_key: 'approval-task:inst-1:node-a:1:user-1',
        status: 'created', complete_reason: null,
      }],
    })
    const result = await applyTodoMirrorTaskCreated(
      ledger.query,
      taskCreatedEvent({ nodeKey: 'node-b', entryEpoch: 2, assignee: 'user-2' }),
      { env: FLAG_ON },
    )
    expect(result.supersededRows).toBe(1)
    expect(ledger.snapshot()).toEqual(['node-a/user-1=completing', 'node-b/user-2=pending'])
    const sweep = ledger.calls.find((c) => c.sql.includes('UPDATE dingtalk_todo_mirrors'))!
    expect(sweep.sql).toContain("complete_reason = 'next_node'")
    expect(sweep.sql).toContain("status = CASE WHEN d.status = 'created' THEN 'completing' ELSE 'superseded' END")
    expect(sweep.sql).toContain("d.status IN ('pending', 'created')")
    // the announcing seat is EXCLUDED by node + epoch + RECIPIENT; a legacy NULL epoch compares with
    // IS NOT DISTINCT FROM
    expect(sweep.sql).toContain('AND NOT (d.node_key = $3 AND d.entry_epoch IS NOT DISTINCT FROM $4::int AND d.recipient_user_id = $5)')
    // and retirement is driven by the PLATFORM's liveness, not by "everything that is not me"
    expect(sweep.sql).toContain('AND NOT EXISTS (')
    expect(sweep.sql).toContain('FROM approval_assignments a')
    expect(sweep.sql).toContain('AND a.is_active = TRUE')
    // tenancy: the sweep is scoped by the org re-read from the instance
    expect(sweep.sql).toContain('AND d.org_id = $2')
    expect(sweep.params).toEqual(['inst-1', 'org-1', 'node-b', 2, 'user-2'])
    // and it runs BEFORE the insert (a new seat must never be swept by its own announcement)
    const sweepIdx = ledger.calls.findIndex((c) => c.sql.includes('UPDATE dingtalk_todo_mirrors'))
    const insertIdx = ledger.calls.findIndex((c) => c.sql.includes('INSERT INTO dingtalk_todo_mirrors'))
    expect(sweepIdx).toBeLessThan(insertIdx)
  })

  /**
   * REGRESSION (Q19 refuter, major): a parallel gateway inserts BOTH branches' assignments in one call
   * under ONE epoch, so two task_created events carry the same epoch on different nodes. Defining
   * "superseded" as "every row that is not me" retired the sibling branch — the other approver either
   * never got a todo (pending => superseded) or had their LIVE todo marked done (created => completing).
   */
  it('a PARALLEL branch sibling keeps its todo: both seats are live, so neither announcement retires the other', async () => {
    const ledger = fakeLedger({ seats: [seat('branch-a', 7, 'user-a'), seat('branch-b', 7, 'user-b')] })
    await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent({ nodeKey: 'branch-a', entryEpoch: 7, assignee: 'user-a' }), { env: FLAG_ON })
    const second = await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent({ nodeKey: 'branch-b', entryEpoch: 7, assignee: 'user-b' }), { env: FLAG_ON })
    expect(second.supersededRows).toBe(0)
    expect(ledger.snapshot()).toEqual(['branch-a/user-a=pending', 'branch-b/user-b=pending'])
  })

  it('a parallel branch whose todo was already CREATED is not completed by the other branch announcing', async () => {
    const ledger = fakeLedger({
      seats: [seat('branch-a', 7, 'user-a'), seat('branch-b', 7, 'user-b')],
      rows: [{
        org_id: 'org-1', instance_id: 'inst-1', node_key: 'branch-a', entry_epoch: 7,
        recipient_user_id: 'user-a', source_key: 'approval-task:inst-1:branch-a:7:user-a',
        status: 'created', complete_reason: null,
      }],
    })
    await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent({ nodeKey: 'branch-b', entryEpoch: 7, assignee: 'user-b' }), { env: FLAG_ON })
    expect(ledger.snapshot()).toEqual(['branch-a/user-a=created', 'branch-b/user-b=pending'])
  })

  /**
   * REGRESSION (Q19 refuter, major): durable delivery is at-least-once, so an OLD task_created can be
   * replayed after the approval has moved on. `ON CONFLICT DO NOTHING` made the INSERT half a no-op but
   * the SWEEP half had no ordering or idempotence guard, so the replay retired the CURRENT seat.
   */
  it('an at-least-once REPLAY of an older task_created leaves the CURRENT seat untouched', async () => {
    const ledger = fakeLedger({
      seats: [seat('node-a', 1, 'user-1', false), seat('node-b', 2, 'user-2')],
      rows: [
        {
          org_id: 'org-1', instance_id: 'inst-1', node_key: 'node-a', entry_epoch: 1,
          recipient_user_id: 'user-1', source_key: 'approval-task:inst-1:node-a:1:user-1',
          status: 'completing', complete_reason: 'next_node',
        },
        {
          org_id: 'org-1', instance_id: 'inst-1', node_key: 'node-b', entry_epoch: 2,
          recipient_user_id: 'user-2', source_key: 'approval-task:inst-1:node-b:2:user-2',
          status: 'created', complete_reason: null,
        },
      ],
    })
    const replay = await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent({ nodeKey: 'node-a', entryEpoch: 1, assignee: 'user-1' }), { env: FLAG_ON })
    expect(replay.supersededRows).toBe(0)
    expect(replay.insertedRows).toBe(0)
    expect(ledger.snapshot()).toEqual(['node-a/user-1=completing', 'node-b/user-2=created'])
  })

  /**
   * REGRESSION (Q19 refuter): a replay whose row was never inserted (first delivery died before the
   * insert, flag flipped on in between) must not mint a pending seat for an approval that is over —
   * nothing would ever retire it, because the terminal sweep already ran and no further event is coming.
   */
  it('a task_created whose seat is already DEAD inserts nothing (no todo for a finished approval)', async () => {
    const ledger = fakeLedger({ seats: [seat('node-a', 1, 'user-1', false)] })
    const result = await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent(), { env: FLAG_ON })
    expect(result.insertedRows).toBe(0)
    expect(ledger.rows).toEqual([])
    const insert = ledger.calls.find((c) => c.sql.includes('INSERT INTO dingtalk_todo_mirrors'))!
    expect(insert.sql).toContain('FROM approval_assignments a')
    expect(insert.sql).toContain('AND a.is_active = TRUE')
  })

  /**
   * REGRESSION (Q19 refuter): reassign / transfer / sequential-queue-head keep the node's PRESERVED
   * epoch, so the departed assignee's row matched the old "(node, epoch) ≠ mine" exclusion and kept a
   * live, actionable todo next to the new assignee's one.
   */
  it('a SAME-ROUND reassign retires the seat that was taken away (same node + epoch, other recipient)', async () => {
    const ledger = fakeLedger({
      seats: [seat('node-a', 1, 'user-old', false), seat('node-a', 1, 'user-new')],
      rows: [{
        org_id: 'org-1', instance_id: 'inst-1', node_key: 'node-a', entry_epoch: 1,
        recipient_user_id: 'user-old', source_key: 'approval-task:inst-1:node-a:1:user-old',
        status: 'created', complete_reason: null,
      }],
    })
    const result = await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent({ assignee: 'user-new' }), { env: FLAG_ON })
    expect(result.supersededRows).toBe(1)
    expect(ledger.snapshot()).toEqual(['node-a/user-old=completing', 'node-a/user-new=pending'])
  })

  it('a NULL org_id instance writes NOTHING (never guesses a tenant)', async () => {
    const ledger = fakeLedger({ orgId: null })
    const result = await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent(), { env: FLAG_ON })
    expect(result).toEqual({ handled: false, skippedReason: 'no_org' })
    expect(ledger.calls.map((c) => c.sql.split('\n')[0].trim())).toEqual(['SELECT org_id FROM approval_instances WHERE id = $1 LIMIT 1'])
  })

  it('a vanished instance writes NOTHING', async () => {
    const ledger = fakeLedger({ instanceMissing: true })
    const result = await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent(), { env: FLAG_ON })
    expect(result.skippedReason).toBe('no_org')
    expect(ledger.rows).toEqual([])
  })

  it('a malformed payload ACKs without touching the database', async () => {
    const ledger = fakeLedger()
    const broken = { ...taskCreatedEvent(), task: { nodeKey: '', entryEpoch: null, assigneeUserId: '', sourceStep: 0 } } as ApprovalTaskCreatedEventV1
    const result = await applyTodoMirrorTaskCreated(ledger.query, broken, { env: FLAG_ON })
    expect(result).toEqual({ handled: false, skippedReason: 'malformed_event' })
    expect(ledger.calls).toEqual([])
  })
})

describe('todo mirror consumer — terminal approvals', () => {
  it.each(TODO_MIRROR_COMPLETION_EVENT_TYPES)('%s retires pending => skipped and created => completing', async (eventType) => {
    const ledger = fakeLedger({
      rows: [
        {
          org_id: 'org-1', instance_id: 'inst-1', node_key: 'node-a', entry_epoch: 1,
          recipient_user_id: 'user-1', source_key: 'k1', status: 'pending', complete_reason: null,
        },
        {
          org_id: 'org-1', instance_id: 'inst-1', node_key: 'node-b', entry_epoch: 1,
          recipient_user_id: 'user-2', source_key: 'k2', status: 'created', complete_reason: null,
        },
      ],
    })
    const result = await applyTodoMirrorCompletion(ledger.query, completionEvent(eventType), { env: FLAG_ON })
    expect(result.handled).toBe(true)
    expect(ledger.snapshot()).toEqual(['node-a/user-1=skipped', 'node-b/user-2=completing'])
    const sweep = ledger.calls.find((c) => c.sql.includes('UPDATE dingtalk_todo_mirrors'))!
    expect(sweep.sql).toContain("status = CASE WHEN status = 'created' THEN 'completing' ELSE 'skipped' END")
    expect(sweep.sql).toContain("status IN ('pending', 'created')")
    expect(sweep.sql).toContain('AND org_id = $2')
    expect(sweep.params).toEqual(['inst-1', 'org-1', eventType.replace('approval.', '')])
  })

  it('an unrelated event type ACKs without writing', async () => {
    const ledger = fakeLedger()
    const result = await applyTodoMirrorCompletion(ledger.query, completionEvent('approval.somethingelse'), { env: FLAG_ON })
    expect(result).toEqual({ handled: false, skippedReason: 'malformed_event' })
    expect(ledger.calls).toEqual([])
  })
})

describe('todo mirror consumer — wiring and log discipline', () => {
  it('the eventBus leg subscribes task_created PLUS the four completion families', () => {
    const subscribed: string[] = []
    const bus = { subscribe: (eventType: string) => { subscribed.push(eventType); return `sub-${subscribed.length}` } }
    const sink = createDingTalkTodoMirrorSink(fakeLedger().query)
    const subscription = subscribeDingTalkTodoMirrorBus(bus as never, sink)
    expect(subscribed).toEqual([
      'approval.task_created',
      'approval.approved',
      'approval.rejected',
      'approval.revoked',
      'approval.cancelled',
    ])
    expect(subscription.ids).toHaveLength(5)
  })

  it('returns the admitted sink promise, detaches exact ids, and drains it before shutdown completes', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const handlers = new Map<string, (payload: unknown) => void | Promise<void>>()
    const unsubscribe = vi.fn(() => true)
    const bus = {
      subscribe: (eventType: string, handler: (payload: unknown) => void | Promise<void>) => {
        handlers.set(eventType, handler)
        return `sub:${eventType}`
      },
      unsubscribe,
    }
    const sink = {
      handleApprovalTaskCreated: vi.fn(() => pending),
      handleApprovalCompletion: vi.fn(async () => undefined),
    }
    const subscription = subscribeDingTalkTodoMirrorBus(bus, sink)

    const admitted = handlers.get('approval.task_created')!(taskCreatedEvent())
    expect(admitted).toBeInstanceOf(Promise)
    subscription.detach()
    expect(unsubscribe.mock.calls.map(([id]) => id)).toEqual(subscription.ids)

    let drained = false
    const drain = subscription.drain().then(() => { drained = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(drained).toBe(false)
    await handlers.get('approval.task_created')!(taskCreatedEvent())
    expect(sink.handleApprovalTaskCreated).toHaveBeenCalledTimes(1)

    release()
    await admitted
    await drain
    expect(drained).toBe(true)
  })

  it('a sink failure is handed to onError and never thrown into the bus', async () => {
    const failing = vi.fn(async () => { throw new Error('db down') })
    const sink = createDingTalkTodoMirrorSink(failing as never, { env: FLAG_ON })
    const handlers = new Map<string, (p: unknown) => void>()
    const bus = { subscribe: (eventType: string, handler: (p: unknown) => void) => { handlers.set(eventType, handler); return eventType } }
    const errors: string[] = []
    subscribeDingTalkTodoMirrorBus(bus as never, sink, (eventType) => errors.push(eventType))
    expect(() => handlers.get('approval.task_created')!(taskCreatedEvent())).not.toThrow()
    await new Promise((resolve) => setImmediate(resolve))
    expect(errors).toEqual(['approval.task_created'])
  })

  it('logs are VALUES-FREE: no subject, no person name, no unionId, no request no', async () => {
    const lines: string[] = []
    const logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) }
    const ledger = fakeLedger({ seats: [seat('node-a', 1, 'user-1')] })
    await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent(), { env: FLAG_ON, logger: logger as never })
    await applyTodoMirrorCompletion(ledger.query, completionEvent('approval.rejected'), { env: FLAG_ON, logger: logger as never })
    expect(lines.length).toBeGreaterThan(0)
    const joined = lines.join('\n')
    for (const value of ['REQ-0001', '审批待处理', 'unionId', 'user-1']) {
      expect(joined).not.toContain(value)
    }
  })
})
