/**
 * P2 durable-delivery P1#2e — the SHARED `collectLiveApprovalTaskCreatedEvents` core.
 *
 * This collector is used by BOTH task_created delivery legs (flag-OFF post-commit `pool.query` + flag-ON in-txn
 * client), so its filtering CANNOT drift between them. These no-DB unit tests pin the load-bearing filters with
 * a fake query fn:
 *   - the `is_active` RECHECK: a task whose assignment row is NOT returned by the active-assignments SELECT
 *     (i.e. deactivated / never durably active) is DROPPED. This is the precise catch for the "skip the
 *     is_active recheck" mutation — passing all tasks through would leak the deactivated one and redden here.
 *     (The real-DB auto-approve golden cannot exercise this, because the current pure cascade removes the
 *     entry assignment BEFORE it is ever inserted, so `createdTaskEvents` is empty there — see F1-G3.)
 *   - within-batch DEDUP: a duplicate `(nodeKey:entryEpoch:assigneeUserId)` fires once.
 *   - eventId BYTE-EQUALITY to the legacy quad formula (the T2-6 dedup ledger key).
 */
import { describe, expect, test } from 'vitest'

import {
  collectLiveApprovalTaskCreatedEvents,
  type ApprovalTaskCreatedQueryFn,
  type ApprovalTaskCreatedTaskSnapshot,
} from '../../src/services/ApprovalTaskCreatedEvent'

const INSTANCE_ID = 'inst_9'
const NODE = 'approval_1'

/** A fake query fn: the active-assignments SELECT returns `activeRows`; the instance SELECT returns one row. */
function fakeQuery(activeRows: Array<{ node_key: string; assignee_id: string; entry_epoch: number | null }>): ApprovalTaskCreatedQueryFn {
  return async (sql: string) => {
    if (sql.includes('approval_assignments')) return { rows: activeRows as unknown as Array<Record<string, unknown>> }
    if (sql.includes('approval_instances')) {
      return {
        rows: [
          {
            id: INSTANCE_ID,
            request_no: 'RQ-9',
            template_id: 'tpl_9',
            template_version_id: 'ver_9',
            published_definition_id: 'def_9',
            business_key: 'bk_9',
            workflow_key: 'wf_9',
            requester_snapshot: { id: 'req_9' },
          },
        ] as Array<Record<string, unknown>>,
      }
    }
    return { rows: [] }
  }
}

const task = (assignee: string, entryEpoch: number | null): ApprovalTaskCreatedTaskSnapshot => ({
  nodeKey: NODE,
  entryEpoch,
  assigneeUserId: assignee,
  sourceStep: 0,
})

describe('collectLiveApprovalTaskCreatedEvents — the shared recheck+dedup+build core', () => {
  test('is_active RECHECK: a task whose assignment is NOT active is dropped (mutation catch)', async () => {
    // Two tasks entered the txn, but only uX survives as an active assignment; uY was deactivated.
    const tasks = [task('uX', 1), task('uY', 1)]
    const events = await collectLiveApprovalTaskCreatedEvents(
      fakeQuery([{ node_key: NODE, assignee_id: 'uX', entry_epoch: 1 }]),
      INSTANCE_ID,
      tasks,
    )
    expect(events.map((e) => e.task.assigneeUserId)).toEqual(['uX'])
    // Skipping the is_active filter (passing all tasks) would yield ['uX','uY'] here — the mutation reddens.
  })

  test('within-batch DEDUP: an identical (node:epoch:assignee) task fires exactly once', async () => {
    const tasks = [task('uX', 1), task('uX', 1)]
    const events = await collectLiveApprovalTaskCreatedEvents(
      fakeQuery([{ node_key: NODE, assignee_id: 'uX', entry_epoch: 1 }]),
      INSTANCE_ID,
      tasks,
    )
    expect(events).toHaveLength(1)
  })

  test('eventId is BYTE-EQUAL to the legacy quad formula', async () => {
    const events = await collectLiveApprovalTaskCreatedEvents(
      fakeQuery([{ node_key: NODE, assignee_id: 'uX', entry_epoch: 5 }]),
      INSTANCE_ID,
      [task('uX', 5)],
    )
    expect(events[0].eventId).toBe(`approval-task:${INSTANCE_ID}:${NODE}:5:uX`)
    expect(events[0].eventType).toBe('approval.task_created')
    expect(events[0].approval.instanceId).toBe(INSTANCE_ID)
  })

  test('legacy NULL epoch serializes as the literal "null" segment (dedupe-stable)', async () => {
    const events = await collectLiveApprovalTaskCreatedEvents(
      fakeQuery([{ node_key: NODE, assignee_id: 'uX', entry_epoch: null }]),
      INSTANCE_ID,
      [task('uX', null)],
    )
    expect(events[0].eventId).toBe(`approval-task:${INSTANCE_ID}:${NODE}:null:uX`)
  })

  test('empty inputs short-circuit: no tasks, or no surviving tasks, returns []', async () => {
    expect(await collectLiveApprovalTaskCreatedEvents(fakeQuery([]), INSTANCE_ID, [])).toEqual([])
    // tasks present but NONE active → [] (and the instance SELECT is never reached)
    expect(await collectLiveApprovalTaskCreatedEvents(fakeQuery([]), INSTANCE_ID, [task('uX', 1)])).toEqual([])
  })
})
