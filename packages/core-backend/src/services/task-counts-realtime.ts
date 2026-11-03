/**
 * Task badge realtime invalidation (M4 PR-3c; design task-m4-pr3c-backend-design-20261008.md §4).
 *
 * RULED(2026-10-07): [R16] when a committed task write changed an input of the pending predicate,
 * every user who was an assignee before or after the write gets one `tasks:counts-updated` message
 * on their authenticated user room; followers get none. The message only tells the client to
 * fetch `/api/tasks/pending-count` again: it carries no count (the badge depends on the viewer's
 * own time zone, which the server does not know here) and no task field. The message is sent only
 * after the write's transaction committed; a write that rolls back sends nothing ([D10] states the
 * same constraint).
 *
 * Shape of a write (design §4.2):
 *
 *   const counts = taskCountsSignal()
 *   const result = await withOrgStructure(orgId, async (db) => {
 *     ... rows read under the structure lock, pure functions, writes ...
 *     if (changed) counts.note({ before, after })
 *     return ...
 *   })
 *   counts.publish()
 *
 * `note` only records; nothing is sent from inside the transaction. The transaction promise
 * resolves after COMMIT returned and rejects on a failed handler or COMMIT, so `publish` runs only
 * for a committed write, provided the handler never swallows a statement error (design §4.2): a
 * failed statement aborts the transaction, and when the handler still returns normally the COMMIT
 * is answered with a rollback and no error, so the promise resolves for a write that did not
 * commit. Rule: in the writers' callbacks, and in every task module they run, every path out of a
 * `catch` throws, and no construct swallows a statement error; `sendOne` below, which runs after
 * the transaction, is the one exception. A unit cell in task-counts-touchpoints.test.ts pins it.
 */
import { Logger } from '../core/logger'
import { countsUpdateRecipients } from '../tasks/task-realtime'
import { buildAuthenticatedUserRoom } from './CollabService'

export const TASK_COUNTS_UPDATED_EVENT = 'tasks:counts-updated'

/** ASSUMPTION(task-m4): [own-3c-01] the payload is a new empty object on every send. */
export type TaskCountsPayload = Record<string, never>

export type TaskCountsBroadcaster = (room: string, event: string, payload: TaskCountsPayload) => void

const noBroadcast: TaskCountsBroadcaster = () => {}

let broadcaster: TaskCountsBroadcaster = noBroadcast

/**
 * ASSUMPTION(task-m4): [own-3c-06] set once in production, by the server constructor (index.ts),
 * to the server's websocket API, which looks the collaboration service up on every send.
 */
export function setTaskCountsBroadcaster(next: TaskCountsBroadcaster): void {
  broadcaster = next
}

/** Restores the default, which sends nothing. */
export function resetTaskCountsBroadcasterForTests(): void {
  broadcaster = noBroadcast
}

const logger = new Logger('TaskCountsRealtime')

/**
 * ASSUMPTION(task-m4): [own-3c-10] the failure log line is a fixed message and the fixed code
 * TASK_COUNTS_SEND_FAILED, nothing else. Nothing is read from the error: its message, stack, code
 * and name can carry values, and reading a property can itself throw.
 */
function warnSendFailed(): void {
  logger.warn('task counts signal not sent', { code: 'TASK_COUNTS_SEND_FAILED' })
}

/**
 * One send to one user. ASSUMPTION(task-m4): [own-3c-10] a failure is logged and dropped: never
 * rethrown, never retried, never queued. A returned promise's rejection is caught the same way.
 */
function sendOne(userId: string): void {
  try {
    const outcome: unknown = broadcaster(buildAuthenticatedUserRoom(userId), TASK_COUNTS_UPDATED_EVENT, {})
    if (outcome && typeof (outcome as PromiseLike<unknown>).then === 'function') {
      (outcome as PromiseLike<unknown>).then(undefined, warnSendFailed)
    }
  } catch {
    warnSendFailed()
  }
}

export interface TaskCountsSignal {
  /**
   * Inside the write's transaction, after the rows were read under the structure lock: the
   * assignee user ids before the write and after it. Called only when the write changed an input
   * of the pending predicate (design §3); a later call adds to the earlier ones.
   */
  note(input: { before: readonly string[]; after: readonly string[] }): void
  /**
   * After the transaction committed: one send per user in the union of every `before` and
   * `after` noted. Nothing when nothing was noted; nothing on a second call. Never throws.
   */
  publish(): void
}

/** One collector per write. */
export function taskCountsSignal(): TaskCountsSignal {
  const before: string[] = []
  const after: string[] = []
  let noted = false
  let published = false
  return {
    note(input) {
      noted = true
      before.push(...input.before)
      after.push(...input.after)
    },
    publish() {
      if (!noted || published) return
      published = true
      for (const userId of countsUpdateRecipients(before, after)) sendOne(userId)
    },
  }
}
