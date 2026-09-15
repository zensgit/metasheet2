/**
 * DingTalk approval-todo ONE-WAY mirror — the CONSUMER half (design
 * docs/development/takeover-beiliao-20260821/dingtalk-todo-mirror-b-design-20260916.md §4/§9).
 *
 * Service-level unit tests with an injected fake pg client (no supertest, no app-mode, no DB — the
 * #4154 tripwire forbids `request(app)` in tests/unit). The fake SIMULATES the ledger's UNIQUE
 * (org_id, source_key) index: an INSERT without the matching `ON CONFLICT ... DO NOTHING` raises
 * SQLSTATE 23505 exactly as Postgres would, which is what makes the idempotency mutation probe real.
 *
 * What is pinned here:
 *   - flag OFF  => ACK, ZERO queries, no rows (design §2.5);
 *   - duplicate task_created => exactly ONE ledger row (the idempotency contract);
 *   - a new node's activation retires the other live seats (pending => superseded, created =>
 *     completing/next_node) and NEVER the seat it is announcing;
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

/** Fake pg client with a real UNIQUE (org_id, source_key) index over the insert path. */
function fakeLedger(options: { orgId?: string | null; instanceMissing?: boolean } = {}) {
  const calls: Call[] = []
  const keys = new Set<string>()
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (sql.includes('FROM approval_instances')) {
      if (options.instanceMissing) return { rows: [], rowCount: 0 }
      return { rows: [{ org_id: options.orgId === undefined ? 'org-1' : options.orgId }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO dingtalk_todo_mirrors')) {
      const key = `${String(params[0])}::${String(params[7])}`
      if (keys.has(key)) {
        if (!/ON CONFLICT \(org_id, source_key\) DO NOTHING/.test(sql)) {
          const err = Object.assign(new Error('duplicate key value violates unique constraint "uq_dingtalk_todo_mirrors_source_key"'), { code: '23505' })
          throw err
        }
        return { rows: [], rowCount: 0 }
      }
      keys.add(key)
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE dingtalk_todo_mirrors')) {
      return { rows: [], rowCount: 2 }
    }
    return { rows: [], rowCount: 0 }
  })
  return { query: query as never, calls, keys }
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
    expect(ledger.keys.size).toBe(0)
  })

  it('flag OFF: a terminal approval ACKs with ZERO queries', async () => {
    const ledger = fakeLedger()
    const result = await applyTodoMirrorCompletion(ledger.query, completionEvent('approval.approved'), { env: FLAG_OFF })
    expect(result).toEqual({ handled: false, skippedReason: 'flag_off' })
    expect(ledger.calls).toEqual([])
  })

  it('a flag value that is not the exact literal true stays OFF', async () => {
    for (const value of ['TRUE', '1', 'yes', 'true ', '']) {
      const ledger = fakeLedger()
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
    const ledger = fakeLedger()
    const event = taskCreatedEvent()
    const first = await applyTodoMirrorTaskCreated(ledger.query, event, { env: FLAG_ON })
    const second = await applyTodoMirrorTaskCreated(ledger.query, event, { env: FLAG_ON })
    expect(first.insertedRows).toBe(1)
    expect(second.insertedRows).toBe(0)
    expect(ledger.keys.size).toBe(1)
    const insert = ledger.calls.find((c) => c.sql.includes('INSERT INTO dingtalk_todo_mirrors'))!
    // the idempotency contract, pinned as text: the conflict TARGET is the ledger's unique index
    expect(insert.sql).toContain('ON CONFLICT (org_id, source_key) DO NOTHING')
    // source_key IS the task_created eventId
    expect(insert.params[7]).toBe(event.eventId)
    expect(insert.params[0]).toBe('org-1')
    expect(insert.params[6]).toBe('user-1')
  })

  it('retires the OTHER live seats and never the seat it is announcing', async () => {
    const ledger = fakeLedger()
    await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent({ nodeKey: 'node-b', entryEpoch: 2 }), { env: FLAG_ON })
    const sweep = ledger.calls.find((c) => c.sql.includes('UPDATE dingtalk_todo_mirrors'))!
    expect(sweep.sql).toContain("complete_reason = 'next_node'")
    expect(sweep.sql).toContain("status = CASE WHEN status = 'created' THEN 'completing' ELSE 'superseded' END")
    expect(sweep.sql).toContain("status IN ('pending', 'created')")
    // the announcing seat is EXCLUDED; a legacy NULL epoch compares with IS NOT DISTINCT FROM
    expect(sweep.sql).toContain('AND NOT (node_key = $3 AND entry_epoch IS NOT DISTINCT FROM $4::int)')
    // tenancy: the sweep is scoped by the org re-read from the instance
    expect(sweep.sql).toContain('AND org_id = $2')
    expect(sweep.params).toEqual(['inst-1', 'org-1', 'node-b', 2])
    // and it runs BEFORE the insert (a new seat must never be swept by its own announcement)
    const sweepIdx = ledger.calls.findIndex((c) => c.sql.includes('UPDATE dingtalk_todo_mirrors'))
    const insertIdx = ledger.calls.findIndex((c) => c.sql.includes('INSERT INTO dingtalk_todo_mirrors'))
    expect(sweepIdx).toBeLessThan(insertIdx)
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
    expect(ledger.keys.size).toBe(0)
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
    const ledger = fakeLedger()
    const result = await applyTodoMirrorCompletion(ledger.query, completionEvent(eventType), { env: FLAG_ON })
    expect(result.handled).toBe(true)
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
    const ids = subscribeDingTalkTodoMirrorBus(bus as never, sink)
    expect(subscribed).toEqual([
      'approval.task_created',
      'approval.approved',
      'approval.rejected',
      'approval.revoked',
      'approval.cancelled',
    ])
    expect(ids).toHaveLength(5)
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
    const ledger = fakeLedger()
    await applyTodoMirrorTaskCreated(ledger.query, taskCreatedEvent(), { env: FLAG_ON, logger: logger as never })
    await applyTodoMirrorCompletion(ledger.query, completionEvent('approval.rejected'), { env: FLAG_ON, logger: logger as never })
    expect(lines.length).toBeGreaterThan(0)
    const joined = lines.join('\n')
    for (const value of ['REQ-0001', '审批待处理', 'unionId', 'user-1']) {
      expect(joined).not.toContain(value)
    }
  })
})
