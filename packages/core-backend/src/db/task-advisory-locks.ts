/**
 * Task-domain advisory locks. I/O lives here; key text comes from task-lock-keys.
 * Declaration form: export async function (lock §6.4).
 */
import {
  taskProjectionLockKey,
  taskStructureLockKey,
  tasksSchedulerLeaderLockKey,
} from '../tasks/task-lock-keys'

export type TaskAdvisoryQuery = (sql: string, params?: unknown[]) => Promise<unknown>

export async function acquireTaskStructureLock(
  query: TaskAdvisoryQuery,
  orgId: string,
): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
}

export async function acquireTaskProjectionLock(
  query: TaskAdvisoryQuery,
  listId: string,
  taskId: string,
): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskProjectionLockKey(listId, taskId)])
}

export async function acquireTasksSchedulerLeaderLock(query: TaskAdvisoryQuery): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [tasksSchedulerLeaderLockKey()])
}

// ── Lock-order wrapper ──
//
// RULED(2026-10-09): [S09] every task-domain transaction takes its locks through one
// `withTaskLockOrder(query)` instance: structure = rank 1, the canonical fence step = rank 2 (not
// wired yet), projection = rank 3. Taking a lock whose rank is lower than one this instance already
// holds throws `TaskLockOrderViolation` before any statement is sent.
// ASSUMPTION(task-m5a): [a-36] the scheduler leader lock has no rank and is exclusive: taking it
// while the instance holds any ranked lock, or taking a ranked lock while it holds the leader lock,
// throws. Lock §6.4: the leader never shares a transaction with the other two task locks.
// A request counts from the moment it is admitted, before its statement is sent, so calls on one
// instance that run concurrently are ordered too; a request whose helper failed still counts.
//
// The three helpers above are called unchanged. A lock is recorded only after its helper returns;
// an error the helper throws reaches the caller unchanged and is not recorded (the scheduler tick
// reads the lock timeout SQLSTATE from it to know it is a follower). This section sends no
// statement of its own.

/** Ranks of the ordered task-domain locks (lock §6.4: structure, then canonical fence, then projection). */
export const TASK_LOCK_RANKS = { structure: 1, fence: 2, projection: 3 } as const

/** A lock the wrapper can take today. `fence` gets its method when the projection work wires it. */
export type TaskLockOrderLock = 'structure' | 'projection' | 'leader'

export class TaskLockOrderViolation extends Error {
  readonly code = 'TASK_LOCK_ORDER_VIOLATION'
  readonly held: readonly TaskLockOrderLock[]
  readonly requested: TaskLockOrderLock

  constructor(held: readonly TaskLockOrderLock[], requested: TaskLockOrderLock) {
    super(`task lock order violation: ${requested} requested after ${held.join(', ')}`)
    this.name = 'TaskLockOrderViolation'
    this.held = [...held]
    this.requested = requested
  }
}

export interface TaskLockOrder {
  structure(orgId: string): Promise<void>
  projection(listId: string, taskId: string): Promise<void>
  schedulerLeader(): Promise<void>
}

/** Test-only: called once per lock a wrapper instance has taken, in order, with the instance number. */
export type TaskLockOrderRecorder = (instance: number, lock: TaskLockOrderLock) => void

let lockOrderRecorder: TaskLockOrderRecorder | null = null
let lockOrderInstances = 0

/** Test-only recording hook. Production code never sets it; `null` removes it. */
export function setTaskLockOrderRecorderForTests(recorder: TaskLockOrderRecorder | null): void {
  lockOrderRecorder = recorder
}

function rankOf(lock: TaskLockOrderLock): number | null {
  return lock === 'leader' ? null : TASK_LOCK_RANKS[lock]
}

export function withTaskLockOrder(query: TaskAdvisoryQuery): TaskLockOrder {
  lockOrderInstances += 1
  const instance = lockOrderInstances
  // Every lock this instance has admitted, in order, including one whose helper has not returned
  // yet or has failed: two calls started before either returns are checked against each other.
  const requested: TaskLockOrderLock[] = []

  const admit = (lock: TaskLockOrderLock): void => {
    const rank = rankOf(lock)
    if (rank === null) {
      if (requested.some((h) => h !== 'leader')) throw new TaskLockOrderViolation(requested, lock)
    } else {
      if (requested.includes('leader')) throw new TaskLockOrderViolation(requested, lock)
      // Keys of one rank are not ordered here: each transaction takes one structure lock today. A
      // transaction that takes several keys of one rank takes them in one fixed order.
      const highest = Math.max(0, ...requested.map((h) => rankOf(h) ?? 0))
      if (rank < highest) throw new TaskLockOrderViolation(requested, lock)
    }
    requested.push(lock)
  }
  const record = (lock: TaskLockOrderLock): void => {
    if (lockOrderRecorder !== null) lockOrderRecorder(instance, lock)
  }

  return {
    async structure(orgId: string): Promise<void> {
      admit('structure')
      await acquireTaskStructureLock(query, orgId)
      record('structure')
    },
    async projection(listId: string, taskId: string): Promise<void> {
      admit('projection')
      await acquireTaskProjectionLock(query, listId, taskId)
      record('projection')
    },
    async schedulerLeader(): Promise<void> {
      admit('leader')
      await acquireTasksSchedulerLeaderLock(query)
      record('leader')
    },
  }
}
