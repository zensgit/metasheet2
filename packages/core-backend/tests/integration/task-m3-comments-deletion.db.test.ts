/**
 * M3 (P0-B) comments CRUD (§3.6) and soft delete (§3.7).
 */
import '../helpers/assert-rbac-optional-off'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { completeTask, createTask, getTask, reopenTask } from '../../src/services/task-records'
import {
  addAssignee,
  addComment,
  deleteComment,
  deleteTaskById,
  listComments,
  removeAssignee,
  setTaskParent,
  switchCompletionMode,
  updateComment,
} from '../../src/services/task-structure'
import { taskStructureLockKey } from '../../src/tasks/task-lock-keys'
import {
  createActorFixture,
  rawRequest,
  startTasksListener,
  tasksClient,
  type TasksListener,
} from '../helpers/tasks-http-harness'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m3-comments-deletion.db.test.ts requires EXPECT_DB=1')
}

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('task-m3-comments-deletion.db.test.ts requires JWT_SECRET')
}

const ORG_PREFIX = 'org_tasks_m3cd_'

function ids(label: string): { orgId: string; userA: string; userB: string; outsider: string } {
  const stamp = randomUUID()
  return {
    orgId: `${ORG_PREFIX}${label}_${stamp}`,
    userA: `usrA_${label}_${stamp}`,
    userB: `usrB_${label}_${stamp}`,
    outsider: `usrO_${label}_${stamp}`,
  }
}

/** Same technique as `task-m3-tree.db.test.ts`'s helper of the same name:
 * force genuine contention (a real Postgres wait), not incidental Promise
 * scheduling, before releasing the holder. */
async function waitUntilBlocked(holderPid: number, min: number): Promise<void> {
  const deadline = Date.now() + 8000
  for (;;) {
    const result = await poolManager.get().query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND $1 = ANY (pg_blocking_pids(pid))`,
      [holderPid],
    )
    if (Number(result.rows[0]?.n ?? 0) >= min) return
    if (Date.now() > deadline) throw new Error(`expected ${min} backends blocked by ${holderPid}`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

/** Resolves with the promise's value, or rejects if it has not settled
 * within `ms`. */
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: still waiting after ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Granted advisory locks on the org's structure key (single-bigint form:
 * classid = high 32 bits, objid = low 32 bits, objsubid = 1). */
async function orgLockHolders(orgId: string): Promise<number> {
  const result = await poolManager.get().query<{ n: string }>(
    `SELECT count(*)::text AS n
     FROM pg_locks l, (SELECT hashtext($1)::bigint AS k) AS key
     WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND l.classid::bigint = ((key.k >> 32) & 4294967295)
       AND l.objid::bigint = (key.k & 4294967295)`,
    [taskStructureLockKey(orgId)],
  )
  return Number(result.rows[0]?.n ?? 0)
}

/** `SHOW statement_timeout` on every idle connection of the app pool. */
async function pooledStatementTimeouts(): Promise<string[]> {
  const pool = poolManager.get().getInternalPool()
  const clients: pg.PoolClient[] = []
  const total = (pool as unknown as { totalCount: number }).totalCount
  for (let i = 0; i < total; i += 1) clients.push(await pool.connect())
  try {
    const values = await Promise.all(clients.map((c) => c.query('SHOW statement_timeout').then((r) => String(r.rows[0].statement_timeout))))
    return [...new Set(values)].sort()
  } finally {
    for (const c of clients) c.release()
  }
}

/** Waits until at least `min` backends in this database wait on a lock, or
 * `done()` is true. */
async function waitForLockWaiters(min: number, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000
  for (;;) {
    if (done()) return
    const result = await poolManager.get().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    )
    if (Number(result.rows[0]?.n ?? 0) >= min) return
    if (Date.now() > deadline) throw new Error(`expected ${min} lock waiters`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

/** A comment id that satisfies task_comments_id_generated_chk. */
function commentId(tag: string, suffix: string): string {
  return `tcmt_${tag}_${randomUUID().replace(/-/g, '')}_${suffix}`
}

// One listener for the HTTP cells in this file, `Connection: close` on every
// request (M3R2-CONC-6); RBAC fixture rows removed in afterAll.
let listener: TasksListener | undefined
function http(): ReturnType<typeof tasksClient> {
  return tasksClient(listener?.baseUrl ?? '')
}
function listenerPort(): number {
  if (!listener) throw new Error('tasks listener not started')
  return listener.port
}
const actors = createActorFixture('tasks-m3cd.test', JWT_SECRET)

describe('tasks M3 comments and deletion real db', () => {
  beforeAll(async () => {
    listener = await startTasksListener()
  })

  afterAll(async () => {
    await poolManager.get().query('DELETE FROM tasks WHERE org_id LIKE $1', [`${ORG_PREFIX}%`])
    await actors.cleanup()
    await listener?.close()
  })

  describe('comments CRUD', () => {
    it('creates, lists, edits (stamping edited_at), and tombstones a comment; the tombstone stays in items and in total', async () => {
      const { orgId, userA } = ids('crud')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const created = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '第一条评论' } })
      expect(created.id.startsWith('tcmt_')).toBe(true)
      expect(created).toMatchObject({ taskId: task.id, authorId: userA, body: '第一条评论', deleted: false })
      const events = await poolManager.get().query<{ event_type: string; actor_id: string }>(
        `SELECT event_type, actor_id FROM task_events WHERE task_id = $1 AND event_type = 'commented'`,
        [task.id],
      )
      expect(events.rows).toEqual([{ event_type: 'commented', actor_id: userA }])

      const listed = await listComments({ orgId, actorId: userA, taskId: task.id, query: {} })
      expect(listed.total).toBe(1)
      expect(listed.items).toHaveLength(1)
      expect(listed.items[0]).toMatchObject({ id: created.id, body: '第一条评论', deleted: false })

      const edited = await updateComment({ orgId, actorId: userA, taskId: task.id, commentId: created.id, body: { body: '改过的评论' } })
      expect(edited).toMatchObject({ id: created.id, body: '改过的评论', deleted: false })
      // M3R2-TM-8 (S22): the edit stamps edited_at.
      const editedRow = await poolManager.get().query<{ body: string; edited_at: Date | null }>(
        'SELECT body, edited_at FROM task_comments WHERE id = $1',
        [created.id],
      )
      expect(editedRow.rows[0]?.body).toBe('改过的评论')
      expect(editedRow.rows[0]?.edited_at).toBeInstanceOf(Date)
      // PATCH does not write a task_events row.
      const afterEditEvents = await poolManager.get().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM task_events WHERE task_id = $1 AND event_type = 'commented'`,
        [task.id],
      )
      expect(afterEditEvents.rows[0]?.n).toBe('1')

      const deleted = await deleteComment({ orgId, actorId: userA, taskId: task.id, commentId: created.id })
      expect(deleted).toEqual({ id: created.id, taskId: task.id, authorId: userA, body: null, deleted: true, createdAt: deleted.createdAt })
      const listedAfterDelete = await listComments({ orgId, actorId: userA, taskId: task.id, query: {} })
      // Tombstones still show up in the list, and in total (M3R2-TM-7).
      expect(listedAfterDelete.items).toHaveLength(1)
      expect(listedAfterDelete.items[0]).toMatchObject({ deleted: true, body: null })
      expect(listedAfterDelete.total).toBe(1)
    })

    // Every failure on this path is the same 404, so which check fires first
    // is not observable here; what is asserted is that the comment cannot be
    // reached through another task's URL, by its author or by anyone else,
    // and stays unchanged in storage. The `task_id` binding in
    // loadCommentForTask and the `task_id = $2` predicate in the UPDATE each
    // block this on their own (see the verification doc's mutation table).
    it('a comment id from another task is 404 for its author and for a non-author, and the comment is unchanged', async () => {
      const { orgId, userA, userB } = ids('crosstask')
      const taskOne = await createTask({ orgId, creatorId: userA, title: '任务一', assignees: [userA] })
      // B can comment on task two but has no role on task one.
      const taskTwo = await createTask({ orgId, creatorId: userA, title: '任务二', assignees: [userA, userB] })
      const comment = await addComment({ orgId, actorId: userA, taskId: taskOne.id, body: { body: '属于任务一' } })
      for (const actorId of [userA, userB]) {
        await expect(updateComment({ orgId, actorId, taskId: taskTwo.id, commentId: comment.id, body: { body: '试图跨任务改' } }))
          .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
        await expect(deleteComment({ orgId, actorId, taskId: taskTwo.id, commentId: comment.id }))
          .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      }
      const stored = await poolManager.get().query<{ task_id: string; body: string | null; deleted_at: Date | null; edited_at: Date | null }>(
        'SELECT task_id, body, deleted_at, edited_at FROM task_comments WHERE id = $1',
        [comment.id],
      )
      expect(stored.rows).toEqual([{ task_id: taskOne.id, body: '属于任务一', deleted_at: null, edited_at: null }])
    })

    it('non-author edit/delete is 404', async () => {
      const { orgId, userA, userB } = ids('nonauthor')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA, userB] })
      const comment = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '作者的评论' } })
      await expect(updateComment({ orgId, actorId: userB, taskId: task.id, commentId: comment.id, body: { body: '别人想改' } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      await expect(deleteComment({ orgId, actorId: userB, taskId: task.id, commentId: comment.id }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    })

    // Sequential case: the author pre-check (canEditComment/canDeleteComment)
    // already sees the tombstone and 404s. The concurrent case, where only
    // the UPDATE's `deleted_at IS NULL` predicate stands between the write
    // and the tombstone CHECK, is the forced race under "concurrency races".
    it('editing or deleting an already-tombstoned comment is 404, not a 500', async () => {
      const { orgId, userA } = ids('tombstone')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const comment = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '将被删除' } })
      await deleteComment({ orgId, actorId: userA, taskId: task.id, commentId: comment.id })
      await expect(updateComment({ orgId, actorId: userA, taskId: task.id, commentId: comment.id, body: { body: '想复活它' } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      await expect(deleteComment({ orgId, actorId: userA, taskId: task.id, commentId: comment.id }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })

      const second = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '第二条' } })
      await poolManager.get().query('UPDATE task_comments SET deleted_at = now(), body = NULL WHERE id = $1', [second.id])
      await expect(updateComment({ orgId, actorId: userA, taskId: task.id, commentId: second.id, body: { body: '再次尝试' } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    })

    it('rejects blank and over-length bodies', async () => {
      const { orgId, userA } = ids('validate')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      await expect(addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '   ' } }))
        .rejects.toMatchObject({ status: 422, code: 'COMMENT_BLANK' })
      await expect(addComment({ orgId, actorId: userA, taskId: task.id, body: { body: 'x'.repeat(5001) } }))
        .rejects.toMatchObject({ status: 422, code: 'COMMENT_TOO_LONG' })
      const ok = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: 'x'.repeat(5000) } })
      expect(ok.body?.length).toBe(5000)
    })

    // M3R2-CF-3: PATCH runs the same body validation as POST (contract §3.6
    // step 4), and a rejected edit leaves the stored comment unchanged.
    it('PATCH rejects blank, over-length, non-string and U+0000 bodies with the POST codes, and the comment is unchanged', async () => {
      const { orgId, userA } = ids('patchvalidate')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const comment = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '原文' } })
      const cases: Array<[unknown, string]> = [
        [{ body: '   ' }, 'COMMENT_BLANK'],
        [{ body: '\u200b' }, 'COMMENT_BLANK'],
        [{ body: 123 }, 'COMMENT_BLANK'],
        [{ body: null }, 'COMMENT_BLANK'],
        [{ body: [] }, 'COMMENT_BLANK'],
        [{ body: {} }, 'COMMENT_BLANK'],
        [{}, 'COMMENT_BLANK'],
        [{ body: 'x'.repeat(5001) }, 'COMMENT_TOO_LONG'],
        [{ body: 'a\u0000b' }, 'COMMENT_INVALID_CHAR'],
      ]
      for (const [body, code] of cases) {
        await expect(updateComment({ orgId, actorId: userA, taskId: task.id, commentId: comment.id, body }), JSON.stringify(body).slice(0, 40))
          .rejects.toMatchObject({ status: 422, code })
      }
      const stored = await poolManager.get().query('SELECT body, edited_at, deleted_at FROM task_comments WHERE id = $1', [comment.id])
      expect(stored.rows).toEqual([{ body: '原文', edited_at: null, deleted_at: null }])
    })

    // M3R2-AUTHZ-4 family: U+0000 cannot be stored in `text`; it is a 422
    // with its own code, checked before any SQL, and nothing is written.
    it('POST rejects a body containing U+0000 as 422 COMMENT_INVALID_CHAR and writes nothing', async () => {
      const { orgId, userA } = ids('nulbody')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      for (const body of ['a\u0000b', '\u0000', ' \u0000 ']) {
        await expect(addComment({ orgId, actorId: userA, taskId: task.id, body: { body } }), JSON.stringify(body))
          .rejects.toMatchObject({ status: 422, code: 'COMMENT_INVALID_CHAR' })
      }
      const count = await poolManager.get().query<{ c: string; e: string }>(
        `SELECT (SELECT count(*) FROM task_comments WHERE task_id = $1)::text AS c,
                (SELECT count(*) FROM task_events WHERE task_id = $1 AND event_type = 'commented')::text AS e`,
        [task.id],
      )
      expect(count.rows[0]).toEqual({ c: '0', e: '0' })
    })

    // M3R2-CF-7/TM-3: a follower has view and comment (contract §2), and
    // author-only edit/delete still applies to them.
    it('a follower can list, post, edit and delete their own comment; a same-org outsider gets 404 on each', async () => {
      const { orgId, userA, outsider } = ids('followercomments')
      const follower = `usrF_followercomments_${randomUUID()}`
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [task.id, follower])
      const byA = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: 'A 的评论' } })

      const listed = await listComments({ orgId, actorId: follower, taskId: task.id, query: {} })
      expect(listed.items.map((item) => item.id)).toEqual([byA.id])
      const own = await addComment({ orgId, actorId: follower, taskId: task.id, body: { body: '关注人的评论' } })
      expect(own).toMatchObject({ authorId: follower, body: '关注人的评论', deleted: false })
      const edited = await updateComment({ orgId, actorId: follower, taskId: task.id, commentId: own.id, body: { body: '关注人改过' } })
      expect(edited).toMatchObject({ id: own.id, body: '关注人改过' })
      await expect(updateComment({ orgId, actorId: follower, taskId: task.id, commentId: byA.id, body: { body: '改别人的' } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      const removed = await deleteComment({ orgId, actorId: follower, taskId: task.id, commentId: own.id })
      expect(removed).toMatchObject({ id: own.id, deleted: true, body: null })

      await expect(listComments({ orgId, actorId: outsider, taskId: task.id, query: {} }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      await expect(addComment({ orgId, actorId: outsider, taskId: task.id, body: { body: '外人' } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      await expect(updateComment({ orgId, actorId: outsider, taskId: task.id, commentId: byA.id, body: { body: '外人改' } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      await expect(deleteComment({ orgId, actorId: outsider, taskId: task.id, commentId: byA.id }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      const stored = await poolManager.get().query('SELECT body, deleted_at FROM task_comments WHERE id = $1', [byA.id])
      expect(stored.rows).toEqual([{ body: 'A 的评论', deleted_at: null }])
    })

    it('is 404 for an outsider with no view ability, and for a different org', async () => {
      const { orgId, userA, outsider } = ids('outsider')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const comment = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '评论' } })
      await expect(listComments({ orgId, actorId: outsider, taskId: task.id, query: {} }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      await expect(addComment({ orgId, actorId: outsider, taskId: task.id, body: { body: '插一句' } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      const otherOrg = `${ORG_PREFIX}outsider_other_${randomUUID()}`
      await expect(updateComment({ orgId: otherOrg, actorId: userA, taskId: task.id, commentId: comment.id, body: { body: 'x' } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    })

    it('paginates with limit/offset, defaulting to 100 and rejecting out-of-range values', async () => {
      const { orgId, userA } = ids('page')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const createdIds: string[] = []
      for (let i = 0; i < 5; i += 1) {
        const c = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: `评论 ${i}` } })
        createdIds.push(c.id)
      }
      const page1 = await listComments({ orgId, actorId: userA, taskId: task.id, query: { limit: '2', offset: '0' } })
      expect(page1.total).toBe(5)
      expect(page1.items).toHaveLength(2)
      const page2 = await listComments({ orgId, actorId: userA, taskId: task.id, query: { limit: '2', offset: '2' } })
      expect(page2.items).toHaveLength(2)
      expect(page1.items.map((i) => i.id)).not.toEqual(page2.items.map((i) => i.id))
      const defaultPage = await listComments({ orgId, actorId: userA, taskId: task.id, query: {} })
      expect(defaultPage.items).toHaveLength(5)

      for (const bad of [
        { limit: '0' }, { limit: '101' }, { limit: 'abc' }, { offset: '-1' }, { offset: 'abc' },
        // M3-CF-1: a huge decimal offset used to reach `LIMIT $2 OFFSET $3` as
        // a raw bigint bind and fail with the driver's own SQLSTATE (a 500),
        // not the contract's 422 INVALID_PAGE. Also scientific notation (not
        // decimal digits) and the int4 boundary.
        { offset: '100000000000000000000' }, { offset: '1e3' }, { offset: '2147483648' }, { limit: '2147483648' },
      ]) {
        await expect(listComments({ orgId, actorId: userA, taskId: task.id, query: bad }))
          .rejects.toMatchObject({ status: 422, code: 'INVALID_PAGE' })
      }
      // Boundary: the largest accepted offset (2^31-1) does not itself 422 —
      // it is accepted (and legitimately returns zero rows, since there are
      // only 5 comments).
      const atBoundary = await listComments({ orgId, actorId: userA, taskId: task.id, query: { offset: '2147483647' } })
      expect(atBoundary.items).toEqual([])
      expect(atBoundary.total).toBe(5)

      // M3R2-CF-9: a repeated or bracketed parameter arrives as an array or
      // object and is 422, not "first value wins".
      for (const bad of [{ limit: ['5'] }, { limit: ['5', 'abc'] }, { offset: ['0'] }, { limit: { a: '1' } }]) {
        await expect(listComments({ orgId, actorId: userA, taskId: task.id, query: bad }), JSON.stringify(bad))
          .rejects.toMatchObject({ status: 422, code: 'INVALID_PAGE' })
      }
    })

    // M3R2-CF-1/TM-7: items are ordered by (created_at, id) across pages,
    // and total counts tombstones. Rows are inserted out of that order (and
    // the two tied rows in reverse id order), so a missing or reversed ORDER
    // BY, or one without the id tie-break, returns a different sequence.
    it('orders items by (created_at, id) across pages, and total counts tombstones before and after a delete', async () => {
      const { orgId, userA } = ids('order')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const t0 = Date.parse('2026-01-01T00:00:00.000Z')
      const at = (seconds: number): Date => new Date(t0 + seconds * 1000)
      const c0 = commentId('ord', 'c')
      const c1 = commentId('ord', 'c')
      const tieA = commentId('ord', 'a')
      const tieB = tieA.slice(0, -1) + 'b'
      const c3 = commentId('ord', 'c')
      const c4 = commentId('ord', 'c')
      const insertOrder: Array<[string, Date, boolean]> = [
        [c3, at(3), false], [c1, at(1), true], [tieB, at(2), false], [tieA, at(2), false], [c0, at(0), false], [c4, at(4), false],
      ]
      for (const [id, createdAt, tombstone] of insertOrder) {
        await poolManager.get().query(
          `INSERT INTO task_comments (id, task_id, author_id, body, created_at, updated_at, deleted_at)
           VALUES ($1, $2, $3, $4, $5, $5, $6)`,
          [id, task.id, userA, tombstone ? null : `评论 ${id}`, createdAt, tombstone ? createdAt : null],
        )
      }
      const expected = [c0, c1, tieA, tieB, c3, c4]
      const all = await listComments({ orgId, actorId: userA, taskId: task.id, query: {} })
      expect(all.items.map((item) => item.id)).toEqual(expected)
      expect(all.total).toBe(6)
      const paged: string[] = []
      for (const offset of ['0', '2', '4']) {
        const page = await listComments({ orgId, actorId: userA, taskId: task.id, query: { limit: '2', offset } })
        expect(page.total).toBe(6)
        paged.push(...page.items.map((item) => item.id))
      }
      expect(paged).toEqual(expected)
      await deleteComment({ orgId, actorId: userA, taskId: task.id, commentId: tieA })
      const afterDelete = await listComments({ orgId, actorId: userA, taskId: task.id, query: {} })
      expect(afterDelete.total).toBe(6)
      expect(afterDelete.items.map((item) => item.id)).toEqual(expected)
      expect(afterDelete.items.filter((item) => item.deleted).map((item) => item.id)).toEqual([c1, tieA])
    })
  })

  describe('comment routes over HTTP', () => {
    // M3R2-CF-2/TM-6: the exact loop the frontend runs (limit=100,
    // offset=rowsRead, stop when rowsRead >= total) over a thread of more
    // than 100 rows that includes tombstones.
    it('the frontend paging loop reads every row of a 205-comment thread with tombstones, in order', async () => {
      const { orgId, userA } = ids('httppaging')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const bearer = await actors.bearer(orgId, userA)
      const stamp = randomUUID().replace(/-/g, '')
      // Inserted newest-first so storage order differs from (created_at, id).
      // Every 10th row is a tombstone.
      await poolManager.get().query(
        `INSERT INTO task_comments (id, task_id, author_id, body, created_at, updated_at, deleted_at)
         SELECT 'tcmt_pg_' || $3 || '_' || lpad(i::text, 4, '0'), $1, $2,
                CASE WHEN i % 10 = 0 THEN NULL ELSE 'c' || i END,
                timestamptz '2026-01-01 00:00:00+00' + i * interval '1 second',
                timestamptz '2026-01-01 00:00:00+00' + i * interval '1 second',
                CASE WHEN i % 10 = 0 THEN timestamptz '2026-01-02 00:00:00+00' ELSE NULL END
         FROM generate_series(205, 1, -1) AS i`,
        [task.id, userA, stamp],
      )
      const expected = Array.from({ length: 205 }, (_, k) => `tcmt_pg_${stamp}_${String(k + 1).padStart(4, '0')}`)
      const seen: string[] = []
      const seenIds = new Set<string>()
      let rowsRead = 0
      let total = Number.POSITIVE_INFINITY
      let pages = 0
      while (rowsRead < total) {
        const res = await http().get(`/api/tasks/${task.id}/comments?limit=100&offset=${rowsRead}`).set('Authorization', `Bearer ${bearer}`)
        expect(res.status, `offset ${rowsRead}`).toBe(200)
        expect(Number.isInteger(res.body.total)).toBe(true)
        total = res.body.total
        const items = res.body.items as Array<{ id: string; deleted: boolean }>
        if (items.length === 0) break
        rowsRead += items.length
        for (const item of items) {
          if (!seenIds.has(item.id)) { seenIds.add(item.id); seen.push(item.id) }
        }
        pages += 1
        if (pages > 10) throw new Error('paging did not terminate')
      }
      expect(total).toBe(205)
      expect(pages).toBe(3)
      expect(seen).toEqual(expected)
    })

    it('GET comments?limit=1&offset=1 returns the second comment; POST returns and stores the posted body', async () => {
      const { orgId, userA } = ids('httpwiring')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const bearer = await actors.bearer(orgId, userA)
      const first = await http().post(`/api/tasks/${task.id}/comments`).set('Authorization', `Bearer ${bearer}`).send({ body: '第一条' })
      expect(first.status).toBe(200)
      expect(first.body).toMatchObject({ taskId: task.id, authorId: userA, body: '第一条', deleted: false })
      const second = await http().post(`/api/tasks/${task.id}/comments`).set('Authorization', `Bearer ${bearer}`).send({ body: '第二条' })
      expect(second.status).toBe(200)
      expect(second.body.body).toBe('第二条')
      const stored = await poolManager.get().query('SELECT body FROM task_comments WHERE id = $1', [second.body.id])
      expect(stored.rows).toEqual([{ body: '第二条' }])
      // Force distinct timestamps so the second row is second in order.
      await poolManager.get().query(`UPDATE task_comments SET created_at = created_at - interval '1 minute' WHERE id = $1`, [first.body.id])
      const page = await http().get(`/api/tasks/${task.id}/comments?limit=1&offset=1`).set('Authorization', `Bearer ${bearer}`)
      expect(page.status).toBe(200)
      expect(page.body.total).toBe(2)
      expect(page.body.items.map((item: { id: string }) => item.id)).toEqual([second.body.id])
      for (const query of ['limit=5&limit=abc', 'limit[]=5', 'offset=1&offset=0', 'limit=', 'offset=', 'limit=&offset=0']) {
        const bad = await http().get(`/api/tasks/${task.id}/comments?${query}`).set('Authorization', `Bearer ${bearer}`)
        expect(bad.status, query).toBe(422)
        expect(bad.body, query).toEqual({ error: { code: 'INVALID_PAGE' } })
      }
    })

    // M3R2-AUTHZ-4/CONC-3/CF-5/TM-5/MIG-1: U+0000 in a path id, a comment id
    // or a body never reaches Postgres. Ids ⇒ 404 (they can match no row);
    // bodies ⇒ 422. Paths are sent byte-exact with node:http.
    it('U+0000 in any task id, comment id or comment body is 404/422, never a 500 carrying a SQLSTATE', async () => {
      const { orgId, userA } = ids('nulhttp')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const bearer = await actors.bearer(orgId, userA)
      const comment = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '评论' } })
      const port = listenerPort()
      const nulId = `${task.id}%00`
      const pathCells: Array<[string, string, unknown]> = [
        ['GET', `/api/tasks/${nulId}`, undefined],
        ['POST', `/api/tasks/${nulId}/complete`, {}],
        ['POST', `/api/tasks/${nulId}/reopen`, {}],
        ['DELETE', `/api/tasks/${nulId}`, undefined],
        ['DELETE', `/api/tasks/a%00b`, undefined],
        ['PATCH', `/api/tasks/${nulId}/parent`, { parentId: null }],
        ['GET', `/api/tasks/${nulId}/parent-candidates`, undefined],
        ['POST', `/api/tasks/${nulId}/assignees`, { userId: userA }],
        ['DELETE', `/api/tasks/${nulId}/assignees/${userA}`, undefined],
        ['PATCH', `/api/tasks/${nulId}/completion-mode`, { completionMode: 'any' }],
        ['POST', `/api/tasks/${nulId}/followers`, { userId: userA }],
        ['DELETE', `/api/tasks/${nulId}/followers/${userA}`, undefined],
        ['POST', `/api/tasks/${nulId}/leave`, undefined],
        ['GET', `/api/tasks/%00/comments`, undefined],
        ['GET', `/api/tasks/${nulId}/comments`, undefined],
        ['POST', `/api/tasks/a%00b/comments`, { body: 'x' }],
        ['PATCH', `/api/tasks/${nulId}/comments/${comment.id}`, { body: 'x' }],
        ['DELETE', `/api/tasks/${nulId}/comments/${comment.id}`, undefined],
        ['PATCH', `/api/tasks/${task.id}/comments/a%00b`, { body: 'x' }],
        ['DELETE', `/api/tasks/${task.id}/comments/a%00b`, undefined],
        ['PATCH', `/api/tasks/${task.id}/comments/${comment.id}%00`, { body: 'x' }],
        ['DELETE', `/api/tasks/${task.id}/comments/${comment.id}%00`, undefined],
      ]
      for (const [method, path, body] of pathCells) {
        const res = await rawRequest(port, method, path, bearer, body)
        expect(res.status, `${method} ${path}`).toBe(404)
        expect(res.body, `${method} ${path}`).toEqual({ error: { code: 'NOT_FOUND' } })
      }
      const bodyCells: Array<[string, string, unknown, string]> = [
        ['POST', `/api/tasks/${task.id}/comments`, { body: 'a\u0000b' }, 'COMMENT_INVALID_CHAR'],
        ['PATCH', `/api/tasks/${task.id}/comments/${comment.id}`, { body: 'x\u0000y' }, 'COMMENT_INVALID_CHAR'],
        ['PATCH', `/api/tasks/${task.id}/parent`, { parentId: 'tsk_\u0000' }, 'INVALID_PARENT'],
      ]
      for (const [method, path, body, code] of bodyCells) {
        const res = await rawRequest(port, method, path, bearer, body)
        expect(res.status, `${method} ${path}`).toBe(422)
        expect(res.body, `${method} ${path}`).toEqual({ error: { code } })
      }
      const stored = await poolManager.get().query('SELECT body, edited_at, deleted_at FROM task_comments WHERE task_id = $1', [task.id])
      expect(stored.rows).toEqual([{ body: '评论', edited_at: null, deleted_at: null }])
      const row = await poolManager.get().query('SELECT deleted_at, parent_id FROM tasks WHERE id = $1', [task.id])
      expect(row.rows).toEqual([{ deleted_at: null, parent_id: null }])
    })

    // M3R3-IN-3 / M3R3-IN-4: a title Postgres cannot store exactly as sent
    // is 422 INVALID_TITLE, like a blank one. The sendError 500 fallback is
    // covered by tests/unit/tasks-route-errors.test.ts.
    it('POST /api/tasks with U+0000 or a lone surrogate in the title is 422 INVALID_TITLE and writes nothing', async () => {
      const { orgId, userA } = ids('badtitle')
      const bearer = await actors.bearer(orgId, userA)
      for (const title of ['a\u0000b', '\u0000', '\ud800', 'a\udc00b', 'x\ud83d', '\ude00y']) {
        const res = await http().post('/api/tasks').set('Authorization', `Bearer ${bearer}`).send({ title })
        expect(res.status, JSON.stringify(title)).toBe(422)
        expect(res.body, JSON.stringify(title)).toEqual({ error: { code: 'INVALID_TITLE' } })
      }
      const count = await poolManager.get().query<{ n: string }>('SELECT count(*)::text AS n FROM tasks WHERE org_id = $1', [orgId])
      expect(count.rows[0]?.n).toBe('0')
      // Positive control: a well-formed surrogate pair is stored exactly.
      const ok = await http().post('/api/tasks').set('Authorization', `Bearer ${bearer}`).send({ title: '任务 \ud83d\ude00' })
      expect(ok.status).toBe(200)
      const stored = await poolManager.get().query('SELECT title FROM tasks WHERE id = $1', [ok.body.id])
      expect(stored.rows).toEqual([{ title: '任务 \ud83d\ude00' }])
    })

    // M3R3-IN-4: lone surrogates in a comment body are the same 422 as U+0000.
    it('POST and PATCH comment reject a lone surrogate as 422 COMMENT_INVALID_CHAR; a surrogate pair is stored exactly', async () => {
      const { orgId, userA } = ids('surrogate')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const bearer = await actors.bearer(orgId, userA)
      const comment = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '评论' } })
      for (const body of ['\ud800', 'a\udc00b', 'x\ud83d', '\ude00y']) {
        const post = await http().post(`/api/tasks/${task.id}/comments`).set('Authorization', `Bearer ${bearer}`).send({ body })
        expect(post.status, `POST ${JSON.stringify(body)}`).toBe(422)
        expect(post.body, `POST ${JSON.stringify(body)}`).toEqual({ error: { code: 'COMMENT_INVALID_CHAR' } })
        const patch = await http().patch(`/api/tasks/${task.id}/comments/${comment.id}`).set('Authorization', `Bearer ${bearer}`).send({ body })
        expect(patch.status, `PATCH ${JSON.stringify(body)}`).toBe(422)
        expect(patch.body, `PATCH ${JSON.stringify(body)}`).toEqual({ error: { code: 'COMMENT_INVALID_CHAR' } })
      }
      const rows = await poolManager.get().query('SELECT id, body, edited_at FROM task_comments WHERE task_id = $1', [task.id])
      expect(rows.rows).toEqual([{ id: comment.id, body: '评论', edited_at: null }])
      const events = await poolManager.get().query<{ n: string }>(`SELECT count(*)::text AS n FROM task_events WHERE task_id = $1 AND event_type = 'commented'`, [task.id])
      expect(events.rows[0]?.n).toBe('1')
      const pair = '表情 \ud83d\ude00'
      const ok = await http().post(`/api/tasks/${task.id}/comments`).set('Authorization', `Bearer ${bearer}`).send({ body: pair })
      expect(ok.status).toBe(200)
      expect(ok.body.body).toBe(pair)
      const stored = await poolManager.get().query('SELECT body FROM task_comments WHERE id = $1', [ok.body.id])
      expect(stored.rows).toEqual([{ body: pair }])
    })
  })

  describe('task-level comment ability precondition (§3.6 step 1, M3-AUTHZ-3 / M3G-6)', () => {
    it('an author who has since lost access to the task cannot edit or delete their own comment', async () => {
      const { orgId, userA, userB } = ids('lostaccess')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA, userB] })
      const comment = await addComment({ orgId, actorId: userB, taskId: task.id, body: { body: 'B 的评论' } })
      // B is removed as assignee and holds no other role (not creator, not
      // follower), so B loses `comment` (and `view`) on the task — the same
      // role set, per §2's truth table.
      await removeAssignee({ orgId, actorId: userA, taskId: task.id, userId: userB })
      await expect(updateComment({ orgId, actorId: userB, taskId: task.id, commentId: comment.id, body: { body: '想改' } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      await expect(deleteComment({ orgId, actorId: userB, taskId: task.id, commentId: comment.id }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      const stillThere = await poolManager.get().query<{ body: string | null; deleted_at: string | null }>(
        'SELECT body, deleted_at FROM task_comments WHERE id = $1',
        [comment.id],
      )
      expect(stillThere.rows[0]).toMatchObject({ body: 'B 的评论', deleted_at: null })
    })
  })

  describe('concurrency races (M3-CONC-5, M3-CONC-6)', () => {
    type LivenessCase = {
      label: string
      run: (input: { orgId: string; actorId: string; taskId: string; commentId: string }) => Promise<unknown>
    }
    const livenessCases: LivenessCase[] = [
      { label: 'POST comment', run: ({ orgId, actorId, taskId }) => addComment({ orgId, actorId, taskId, body: { body: '竞态评论' } }) },
      { label: 'PATCH comment', run: ({ orgId, actorId, taskId, commentId }) => updateComment({ orgId, actorId, taskId, commentId, body: { body: '竞态编辑' } }) },
      { label: 'DELETE comment', run: ({ orgId, actorId, taskId, commentId }) => deleteComment({ orgId, actorId, taskId, commentId }) },
    ]

    // M3-CONC-6. The holder soft-deletes the task without committing, taking
    // the same row locks as `deleteTaskById` (FOR UPDATE, then the UPDATE).
    // The comment write's pre-checks are snapshot reads, so they still see
    // the task as live and pass; the write must then wait on the task row and,
    // once the delete commits, 404 without writing. The other ordering
    // (comment first, production delete waits) is the next cell.
    it.each(livenessCases)('$label waits behind a concurrent uncommitted soft delete of the task, then 404s without writing (M3-CONC-6, forced race)', async ({ label, run }) => {
      const { orgId, userA } = ids('concdelete')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const seeded = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '已有评论' } })
      const pool = poolManager.get().getInternalPool()
      const holder = await pool.connect()
      let pending: Promise<unknown> | undefined
      try {
        if (!holder.processID) throw new Error('holder pid missing')
        await holder.query('BEGIN')
        await holder.query('SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE', [task.id])
        await holder.query('UPDATE tasks SET deleted_at = now() WHERE id = $1', [task.id])

        pending = run({ orgId, actorId: userA, taskId: task.id, commentId: seeded.id })
        await waitUntilBlocked(holder.processID, 1)
        await holder.query('COMMIT')

        await expect(pending, label).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
        const rows = await poolManager.get().query<{ id: string; body: string | null; deleted_at: Date | null; edited_at: Date | null }>(
          `SELECT id, body, deleted_at, edited_at FROM task_comments WHERE task_id = $1`,
          [task.id],
        )
        // Only the seeded comment, untouched: no new row, no edit, no tombstone.
        expect(rows.rows, label).toEqual([{ id: seeded.id, body: '已有评论', deleted_at: null, edited_at: null }])
        const events = await poolManager.get().query<{ n: string }>(
          `SELECT count(*)::text AS n FROM task_events WHERE task_id = $1 AND event_type = 'commented'`,
          [task.id],
        )
        expect(events.rows[0]?.n, label).toBe('1')
      } finally {
        try { await holder.query('ROLLBACK') } catch { /* already committed */ }
        if (pending) await pending.catch(() => undefined)
        holder.release()
      }
    })

    /**
     * Parks a real updateComment inside its transaction: the holder locks the
     * comment row, so updateComment takes its task-row lock and then waits on
     * the comment row. Returns the pending edit and a release function.
     */
    async function parkCommentWrite(orgId: string, actorId: string, taskId: string, id: string) {
      const pool = poolManager.get().getInternalPool()
      const holder = await pool.connect()
      if (!holder.processID) throw new Error('holder pid missing')
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM task_comments WHERE id = $1 FOR UPDATE', [id])
      const edit = updateComment({ orgId, actorId, taskId, commentId: id, body: { body: '停在事务里的编辑' } })
      edit.catch(() => undefined)
      await waitUntilBlocked(holder.processID, 1)
      let released = false
      return {
        edit,
        release: async () => {
          if (released) return
          released = true
          try { await holder.query('COMMIT') } finally { holder.release() }
        },
      }
    }

    // M3R2-CONC-1, the other ordering, with the production delete: a comment
    // write that already holds its task-row lock makes deleteTaskById wait
    // (FOR UPDATE vs FOR KEY SHARE), so the edit lands before the delete.
    it('a comment write in flight makes the production deleteTaskById wait, then both succeed in that order', async () => {
      const { orgId, userA } = ids('commentfirst')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const seeded = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '已有评论' } })
      const parked = await parkCommentWrite(orgId, userA, task.id, seeded.id)
      let deleteSettled = false
      const pendingDelete = deleteTaskById({ orgId, actorId: userA, taskId: task.id }).finally(() => { deleteSettled = true })
      pendingDelete.catch(() => undefined)
      try {
        // The edit waits on the holder; the delete must wait on the edit.
        await waitForLockWaiters(2, () => deleteSettled)
        expect(deleteSettled, 'delete must wait for the in-flight comment write').toBe(false)
      } finally {
        await parked.release()
      }
      await expect(parked.edit).resolves.toMatchObject({ id: seeded.id, body: '停在事务里的编辑' })
      await expect(pendingDelete).resolves.toEqual({ id: task.id, deleted: true })
      const rows = await poolManager.get().query<{ edited_at: Date; deleted_at: Date }>(
        `SELECT c.edited_at, t.deleted_at FROM task_comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = $1`,
        [seeded.id],
      )
      expect(rows.rows[0]!.edited_at.getTime()).toBeLessThanOrEqual(rows.rows[0]!.deleted_at.getTime())
    })

    // M3R2-CONC-1: comment traffic does not make other task writes wait.
    // Every write below updates the tasks row while a comment write on the
    // same task holds its task-row lock.
    it('an in-flight comment write does not block complete, reopen, mode switch, membership, reparent or create on the same task and org', async () => {
      const { orgId, userA, userB } = ids('noblock')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA], completionMode: 'all' })
      const other = await createTask({ orgId, creatorId: userA, title: '另一个任务', assignees: [userA] })
      const seeded = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '已有评论' } })
      const parked = await parkCommentWrite(orgId, userA, task.id, seeded.id)
      try {
        const bound = 2000
        await within(completeTask({ orgId, actorId: userA, taskId: task.id }), bound, 'complete (open -> done)')
        await within(reopenTask({ orgId, actorId: userA, taskId: task.id, scope: 'all' }), bound, 'reopen (done -> open)')
        await within(completeTask({ orgId, actorId: userA, taskId: task.id }), bound, 'complete again')
        await within(addAssignee({ orgId, actorId: userA, taskId: task.id, body: { userId: userB } }), bound, 'add assignee (reopens)')
        await within(switchCompletionMode({ orgId, actorId: userA, taskId: task.id, body: { completionMode: 'any' } }), bound, 'mode switch (all -> any, completes)')
        await within(setTaskParent({ orgId, actorId: userA, taskId: task.id, body: { parentId: other.id } }), bound, 'reparent')
        await within(createTask({ orgId, creatorId: userA, title: '同 org 新任务', assignees: [userA] }), bound, 'create in the same org')
        const row = await poolManager.get().query('SELECT status, completion_mode, parent_id, version FROM tasks WHERE id = $1', [task.id])
        expect(row.rows).toEqual([{ status: 'done', completion_mode: 'any', parent_id: other.id, version: 6 }])
      } finally {
        await parked.release()
      }
      await expect(parked.edit).resolves.toMatchObject({ id: seeded.id })
    })

    // M3R2-CONC-1 / M3R3-LOCK-1: FOR KEY SHARE lockers are granted while a
    // FOR UPDATE waiter is queued, so the delete's row-lock statement is
    // bounded (3 s); past the bound it answers 409 TASK_BUSY and releases the
    // org structure lock. Upper bound 5000 ms (R3-TAM-6).
    it('deleteTaskById gives up with 409 TASK_BUSY when a comment write holds the task row too long, and the org is not held', async () => {
      const { orgId, userA } = ids('deletebusy')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const seeded = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '已有评论' } })
      const parked = await parkCommentWrite(orgId, userA, task.id, seeded.id)
      try {
        const started = Date.now()
        await expect(within(deleteTaskById({ orgId, actorId: userA, taskId: task.id }), 5000, 'bounded delete'))
          .rejects.toMatchObject({ status: 409, code: 'TASK_BUSY' })
        const elapsed = Date.now() - started
        expect(elapsed).toBeGreaterThanOrEqual(2500)
        expect(elapsed).toBeLessThan(5000)
        expect(await orgLockHolders(orgId)).toBe(0)
        await within(createTask({ orgId, creatorId: userA, title: '同 org 新任务', assignees: [userA] }), 2000, 'create after the busy delete')
        const row = await poolManager.get().query('SELECT deleted_at FROM tasks WHERE id = $1', [task.id])
        expect(row.rows).toEqual([{ deleted_at: null }])
        const events = await poolManager.get().query<{ n: string }>(`SELECT count(*)::text AS n FROM task_events WHERE task_id = $1 AND event_type = 'deleted'`, [task.id])
        expect(events.rows[0]?.n).toBe('0')
      } finally {
        await parked.release()
      }
      await expect(parked.edit).resolves.toMatchObject({ id: seeded.id })
      await expect(deleteTaskById({ orgId, actorId: userA, taskId: task.id })).resolves.toEqual({ id: task.id, deleted: true })
    }, 30000)

    // M3R3-LOCK-1 / M3R4-TAM-2 / M3R5-TST-1: a hand-off chain of short FOR
    // KEY SHARE holders never leaves the row free: holder i commits only
    // after holder i+1 has its lock granted (KEY SHARE is granted past a
    // queued FOR UPDATE), so each hand-off restarts the delete's per-lock
    // wait. How many hand-offs fit in the bound depends on the machine, so
    // the cell asserts only that at least two more holders were granted
    // while the delete was pending (the wait restarted at least once), not
    // a total. The bound applies to the whole statement, so the delete
    // still answers 409 within it, the org lock is released, and the pooled
    // connections keep their statement_timeout.
    it('under a stream of overlapping comment-write row locks the delete still gives up within the bound, releases the org lock, and leaves no timeout behind', async () => {
      const { orgId, userA } = ids('deletestream')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const baseline = await pooledStatementTimeouts()
      const streamPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
      let stop = false
      let handoffs = 0
      let firstGranted!: () => void
      const firstHeld = new Promise<void>((resolve) => { firstGranted = resolve })
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      // Hand-off chain: holder i+1 takes FOR KEY SHARE, and only then is
      // holder i allowed to COMMIT (after at least 400 ms). A new holder is
      // started every 400 ms for up to 9 s. The row is never free between
      // holders, whatever the scheduler does.
      const chain = (async () => {
        const until = Date.now() + 9000
        const holders: Promise<void>[] = []
        let releasePrevious: (() => void) | undefined
        while (!stop && Date.now() < until) {
          const client = await streamPool.connect()
          try {
            await client.query('BEGIN')
            await client.query('SELECT 1 FROM tasks WHERE id = $1 AND deleted_at IS NULL FOR KEY SHARE', [task.id])
          } catch {
            await client.query('ROLLBACK').catch(() => undefined)
            client.release()
            break
          }
          handoffs += 1
          if (handoffs === 1) firstGranted()
          releasePrevious?.()
          let release!: () => void
          const released = new Promise<void>((resolve) => { release = resolve })
          releasePrevious = release
          holders.push((async () => {
            try {
              await Promise.all([sleep(400), released])
              await client.query('COMMIT')
            } catch {
              await client.query('ROLLBACK').catch(() => undefined)
            } finally {
              client.release()
            }
          })())
          await sleep(400)
        }
        releasePrevious?.()
        await Promise.all(holders)
      })()
      chain.catch(() => undefined)
      try {
        await within(firstHeld, 5000, 'first holder')
        const started = Date.now()
        const handoffsBefore = handoffs
        const pendingDelete = deleteTaskById({ orgId, actorId: userA, taskId: task.id })
        // Hand-off count at the moment the delete settles, either way.
        const handoffsAtSettle = pendingDelete.then(() => handoffs, () => handoffs)
        // While it waits, the delete holds the org lock (positive control
        // for the zero-holder check below).
        await new Promise((resolve) => setTimeout(resolve, 1000))
        expect(await orgLockHolders(orgId)).toBe(1)
        await expect(within(pendingDelete, 5000 - (Date.now() - started), 'bounded delete under a stream'))
          .rejects.toMatchObject({ status: 409, code: 'TASK_BUSY' })
        const elapsed = Date.now() - started
        expect(elapsed).toBeGreaterThanOrEqual(2500)
        expect(elapsed).toBeLessThan(5000)
        // At least two more holders were granted while the delete was
        // pending, so at least one holder committed under the queued FOR
        // UPDATE: the bound was exercised against a restarted lock wait, not
        // against a single holder.
        expect((await handoffsAtSettle) - handoffsBefore).toBeGreaterThanOrEqual(2)
        expect(await orgLockHolders(orgId)).toBe(0)
        await within(createTask({ orgId, creatorId: userA, title: '同 org 新任务', assignees: [userA] }), 2000, 'create after the busy delete')
        const row = await poolManager.get().query('SELECT deleted_at FROM tasks WHERE id = $1', [task.id])
        expect(row.rows).toEqual([{ deleted_at: null }])
      } finally {
        stop = true
        await chain
        await streamPool.end()
      }
      expect(await pooledStatementTimeouts()).toEqual(baseline)
    }, 30000)

    // M3R4-DEL-1: after the bounded row-lock statement the prior
    // statement_timeout is restored for the rest of the transaction. Pinned
    // by making a post-lock statement (the UPDATE that stamps deleted_at)
    // take longer than the 3 s bound through a row-scoped trigger: it must
    // still succeed under the pool's own timeout. Without the restore the
    // UPDATE is cancelled at 3 s (57014).
    it('a post-lock statement that runs past the 3 s row-lock bound still succeeds: the prior statement_timeout is restored inside the transaction', async () => {
      const { orgId, userA } = ids('deleterestore')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const tag = randomUUID().replace(/-/g, '')
      const fn = `m3_slow_stamp_${tag}`
      const trg = `m3_slow_stamp_trg_${tag}`
      const db = poolManager.get()
      await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3.5); RETURN NEW; END $$`)
      await db.query(`CREATE TRIGGER ${trg} BEFORE UPDATE ON tasks FOR EACH ROW WHEN (NEW.id = '${task.id}' AND NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION ${fn}()`)
      try {
        const started = Date.now()
        await expect(within(deleteTaskById({ orgId, actorId: userA, taskId: task.id }), 8000, 'delete with a slow stamp'))
          .resolves.toEqual({ id: task.id, deleted: true })
        // Positive control: the trigger did run, so the UPDATE took > 3 s.
        expect(Date.now() - started).toBeGreaterThanOrEqual(3500)
        const row = await db.query('SELECT deleted_at IS NOT NULL AS deleted FROM tasks WHERE id = $1', [task.id])
        expect(row.rows).toEqual([{ deleted: true }])
      } finally {
        await db.query(`DROP TRIGGER IF EXISTS ${trg} ON tasks`)
        await db.query(`DROP FUNCTION IF EXISTS ${fn}()`)
      }
    }, 30000)

    // M3R3-IN-1 / M3R3-DOC-1 / M3R4-TAM-1: the delete ability is checked
    // before any lock, so a caller who cannot delete the task gets the
    // uniform 404 at once, even while the row is locked by a comment write
    // AND the org structure lock is held by another transaction — the same
    // response, in the same time, as for an id that does not exist. The
    // missing id is timed too: it must answer before the org lock as well.
    it('a same-org outsider, an assignee, and a missing id all get the same 404 at once while a comment write holds the row and the org structure lock is held', async () => {
      const { orgId, userA, userB, outsider } = ids('deleteprecheck')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA, userB] })
      const seeded = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '已有评论' } })
      const bearerB = await actors.bearer(orgId, userB)
      const bearerO = await actors.bearer(orgId, outsider)
      const missing = `tsk_missing_${randomUUID().replace(/-/g, '')}`
      const shape = (res: { status: number; text: string; headers: Record<string, string> }) => ({
        status: res.status, text: res.text, contentType: res.headers['content-type'], etag: res.headers.etag,
      })
      const parked = await parkCommentWrite(orgId, userA, task.id, seeded.id)
      const orgHolder = await poolManager.get().getInternalPool().connect()
      try {
        await orgHolder.query('BEGIN')
        await orgHolder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
        expect(await orgLockHolders(orgId)).toBe(1)
        for (const [label, bearer] of [['outsider', bearerO], ['assignee', bearerB]] as const) {
          const startedMissing = Date.now()
          const reference = shape(await within(http().delete(`/api/tasks/${missing}`).set('Authorization', `Bearer ${bearer}`), 5000, `${label} missing id`))
          expect(Date.now() - startedMissing, `${label} missing id`).toBeLessThan(1000)
          expect(reference.status, label).toBe(404)
          expect(JSON.parse(reference.text), label).toEqual({ error: { code: 'NOT_FOUND' } })
          const started = Date.now()
          const res = shape(await within(http().delete(`/api/tasks/${task.id}`).set('Authorization', `Bearer ${bearer}`), 5000, `${label} existing id`))
          const elapsed = Date.now() - started
          expect(res, label).toEqual(reference)
          expect(elapsed, label).toBeLessThan(1000)
        }
        // Service level, same callers, plus the missing id; each under 1 s.
        for (const [actorId, taskId] of [[outsider, task.id], [userB, task.id], [outsider, missing], [userB, missing], [userA, missing]] as const) {
          const started = Date.now()
          await expect(within(deleteTaskById({ orgId, actorId, taskId }), 5000, `service ${actorId} ${taskId}`)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
          expect(Date.now() - started).toBeLessThan(1000)
        }
        // Still exactly one holder: none of the 404s took the org lock.
        expect(await orgLockHolders(orgId)).toBe(1)
      } finally {
        try { await orgHolder.query('ROLLBACK') } catch { /* ignore */ }
        orgHolder.release()
        await parked.release()
      }
      await expect(parked.edit).resolves.toMatchObject({ id: seeded.id })
      const row = await poolManager.get().query('SELECT deleted_at FROM tasks WHERE id = $1', [task.id])
      expect(row.rows).toEqual([{ deleted_at: null }])
    }, 30000)

    // M3R2-CONC-5: the delete is stamped after its locks are held, so a
    // comment accepted while the delete was queued is not stored as later
    // than the deletion.
    it('a comment accepted while the delete waits for the structure lock is stored and evented before the deletion', async () => {
      const { orgId, userA } = ids('deletestamp')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const pool = poolManager.get().getInternalPool()
      const holder = await pool.connect()
      let pendingDelete: Promise<unknown> | undefined
      try {
        if (!holder.processID) throw new Error('holder pid missing')
        await holder.query('BEGIN')
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
        pendingDelete = deleteTaskById({ orgId, actorId: userA, taskId: task.id })
        pendingDelete.catch(() => undefined)
        await waitUntilBlocked(holder.processID, 1)
        await new Promise((resolve) => setTimeout(resolve, 50))
        await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '删除排队时的评论' } })
        await holder.query('COMMIT')
        await expect(pendingDelete).resolves.toEqual({ id: task.id, deleted: true })
      } finally {
        try { await holder.query('ROLLBACK') } catch { /* already committed */ }
        if (pendingDelete) await pendingDelete.catch(() => undefined)
        holder.release()
      }
      const stamps = await poolManager.get().query<{ created_at: Date; deleted_at: Date }>(
        `SELECT c.created_at, t.deleted_at FROM task_comments c JOIN tasks t ON t.id = c.task_id WHERE t.id = $1`,
        [task.id],
      )
      expect(stamps.rows).toHaveLength(1)
      expect(stamps.rows[0]!.created_at.getTime()).toBeLessThanOrEqual(stamps.rows[0]!.deleted_at.getTime())
      const events = await poolManager.get().query<{ event_type: string }>(
        `SELECT event_type FROM task_events WHERE task_id = $1 AND event_type IN ('commented', 'deleted') ORDER BY occurred_at, event_type`,
        [task.id],
      )
      expect(events.rows.map((r) => r.event_type)).toEqual(['commented', 'deleted'])
      // Compared in SQL, at microsecond precision (M3R3-LOCK-2, R3-TAM-3):
      // one stamp for deleted_at, updated_at and the event's occurred_at.
      const same = await poolManager.get().query<{ updated_same: boolean; event_same: boolean }>(
        `SELECT t.updated_at = t.deleted_at AS updated_same, e.occurred_at = t.deleted_at AS event_same
         FROM tasks t JOIN task_events e ON e.task_id = t.id AND e.event_type = 'deleted'
         WHERE t.id = $1`,
        [task.id],
      )
      expect(same.rows).toEqual([{ updated_same: true, event_same: true }])
    })

    // M3R2-CONC-7: the `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` at the
    // top of each comment write. Run in a child process whose connections
    // default to REPEATABLE READ (PGOPTIONS); there, a comment write that
    // waits behind an uncommitted soft delete still 404s instead of failing
    // with a serialization error.
    it('with the session default forced to REPEATABLE READ, the three comment writes still 404 behind a concurrent soft delete', async () => {
      const { orgId, userA } = ids('rrguard')
      const servicePath = new URL('../../src/services/task-structure.ts', import.meta.url).pathname
      const recordsPath = new URL('../../src/services/task-records.ts', import.meta.url).pathname
      const poolPath = new URL('../../src/integration/db/connection-pool.ts', import.meta.url).pathname
      const script = `/tmp/task-rr-guard-${randomUUID()}.mts`
      writeFileSync(script, `
        const { poolManager } = await import(${JSON.stringify(poolPath)})
        const { createTask } = await import(${JSON.stringify(recordsPath)})
        const { addComment, updateComment, deleteComment } = await import(${JSON.stringify(servicePath)})
        const orgId = ${JSON.stringify(orgId)}
        const actorId = ${JSON.stringify(userA)}
        const isolation = (await poolManager.get().query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation
        const results = []
        const writes = {
          post: (t, c) => addComment({ orgId, actorId, taskId: t, body: { body: 'rr' } }),
          patch: (t, c) => updateComment({ orgId, actorId, taskId: t, commentId: c, body: { body: 'rr' } }),
          delete: (t, c) => deleteComment({ orgId, actorId, taskId: t, commentId: c }),
        }
        for (const [label, run] of Object.entries(writes)) {
          const task = await createTask({ orgId, creatorId: actorId, title: 'rr', assignees: [actorId] })
          const seeded = await addComment({ orgId, actorId, taskId: task.id, body: { body: 'seed' } })
          const holder = await poolManager.get().getInternalPool().connect()
          await holder.query('BEGIN')
          await holder.query('SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE', [task.id])
          await holder.query('UPDATE tasks SET deleted_at = now() WHERE id = $1', [task.id])
          const pending = run(task.id, seeded.id).then(() => ({ ok: true }), (err) => ({ status: err.status ?? null, code: err.code ?? null }))
          const deadline = Date.now() + 8000
          for (;;) {
            const r = await poolManager.get().query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))', [holder.processID])
            if (r.rows[0].n >= 1) break
            if (Date.now() > deadline) throw new Error(label + ': write did not wait')
            await new Promise((resolve) => setTimeout(resolve, 40))
          }
          await holder.query('COMMIT')
          holder.release()
          results.push({ label, outcome: await pending })
        }
        console.log('RRGUARD ' + JSON.stringify({ isolation, results }))
        await poolManager.get().getInternalPool().end()
        process.exit(0)
      `)
      let output = ''
      try {
        const tsx = createRequire(import.meta.url).resolve('tsx/cli')
        output = execFileSync(process.execPath, [tsx, script], {
          cwd: servicePath.slice(0, servicePath.indexOf('/src/')),
          env: { ...process.env, PGOPTIONS: '-c default_transaction_isolation=repeatable\\ read' },
          encoding: 'utf8',
          timeout: 120000,
        })
      } finally {
        try { unlinkSync(script) } catch { /* not written */ }
      }
      const line = output.split('\n').find((l) => l.startsWith('RRGUARD '))
      expect(line, output.slice(-2000)).toBeDefined()
      const parsed = JSON.parse(line!.slice('RRGUARD '.length)) as { isolation: string; results: Array<{ label: string; outcome: unknown }> }
      // The environment really is REPEATABLE READ, else this cell proves nothing.
      expect(parsed.isolation).toBe('repeatable read')
      expect(parsed.results).toEqual([
        { label: 'post', outcome: { status: 404, code: 'NOT_FOUND' } },
        { label: 'patch', outcome: { status: 404, code: 'NOT_FOUND' } },
        { label: 'delete', outcome: { status: 404, code: 'NOT_FOUND' } },
      ])
    }, 180000)

    it('a concurrent tombstone makes an in-flight PATCH/DELETE 404 deterministically (row-lock forced race, M3-CONC-5)', async () => {
      const { orgId, userA } = ids('tombstonerace')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const pool = poolManager.get().getInternalPool()

      const comment = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '将被并发删除(PATCH)' } })
      const holder1 = await pool.connect()
      let pending1: Promise<unknown> | undefined
      try {
        if (!holder1.processID) throw new Error('holder pid missing')
        await holder1.query('BEGIN')
        await holder1.query('SELECT id FROM task_comments WHERE id = $1 FOR UPDATE', [comment.id])
        pending1 = updateComment({ orgId, actorId: userA, taskId: task.id, commentId: comment.id, body: { body: '尝试编辑' } })
        await waitUntilBlocked(holder1.processID, 1)
        // The row-lock holder tombstones the row itself and commits, so the
        // blocked UPDATE re-evaluates its WHERE (`deleted_at IS NULL`)
        // against the new row version once it wakes up (READ COMMITTED
        // EvalPlanQual), rather than ever writing `body` onto a tombstone.
        await holder1.query('UPDATE task_comments SET deleted_at = now(), body = NULL WHERE id = $1', [comment.id])
        await holder1.query('COMMIT')
        await expect(pending1).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      } finally {
        try { await holder1.query('ROLLBACK') } catch { /* already committed */ }
        if (pending1) await pending1.catch(() => undefined)
        holder1.release()
      }

      const second = await addComment({ orgId, actorId: userA, taskId: task.id, body: { body: '将被并发删除(DELETE)' } })
      const holder2 = await pool.connect()
      let pending2: Promise<unknown> | undefined
      try {
        if (!holder2.processID) throw new Error('holder pid missing')
        await holder2.query('BEGIN')
        await holder2.query('SELECT id FROM task_comments WHERE id = $1 FOR UPDATE', [second.id])
        pending2 = deleteComment({ orgId, actorId: userA, taskId: task.id, commentId: second.id })
        await waitUntilBlocked(holder2.processID, 1)
        await holder2.query('UPDATE task_comments SET deleted_at = now(), body = NULL WHERE id = $1', [second.id])
        await holder2.query('COMMIT')
        await expect(pending2).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      } finally {
        try { await holder2.query('ROLLBACK') } catch { /* already committed */ }
        if (pending2) await pending2.catch(() => undefined)
        holder2.release()
      }
    })
  })

  // M3R2-MIG-3: the task_comments DDL the contract §4 specifies — each
  // CHECK and the FK rejects a violating row, the FK cascades on a hard task
  // delete, and the index covers (task_id, created_at).
  describe('task_comments DDL', () => {
    async function insertError(values: { id: string; taskId: string; authorId: string; body: string | null; deletedAt: Date | null }): Promise<{ code?: string; constraint?: string }> {
      try {
        await poolManager.get().query(
          'INSERT INTO task_comments (id, task_id, author_id, body, deleted_at) VALUES ($1, $2, $3, $4, $5)',
          [values.id, values.taskId, values.authorId, values.body, values.deletedAt],
        )
      } catch (err) {
        const e = err as { code?: string; constraint?: string }
        return { code: e.code, constraint: e.constraint }
      }
      return {}
    }

    it('rejects rows that break each CHECK and the FK, cascades on task delete, and indexes (task_id, created_at)', async () => {
      const { orgId, userA } = ids('ddl')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      const ok = { id: commentId('ddl', 'x'), taskId: task.id, authorId: userA, body: 'b', deletedAt: null as Date | null }
      for (const id of ['tcmt__x', '_tcmt_x', 'tcmt_x_', 'tcmt x']) {
        expect(await insertError({ ...ok, id }), id).toEqual({ code: '23514', constraint: 'task_comments_id_generated_chk' })
      }
      expect(await insertError({ ...ok, id: commentId('ddl', 'a'), authorId: 'usr a' })).toEqual({ code: '23514', constraint: 'task_comments_author_printable_chk' })
      expect(await insertError({ ...ok, id: commentId('ddl', 'b'), body: null })).toEqual({ code: '23514', constraint: 'task_comments_tombstone_body_cleared_chk' })
      expect(await insertError({ ...ok, id: commentId('ddl', 'c'), deletedAt: new Date() })).toEqual({ code: '23514', constraint: 'task_comments_tombstone_body_cleared_chk' })
      expect(await insertError({ ...ok, id: commentId('ddl', 'd'), taskId: `tsk_missing_${randomUUID()}` })).toEqual({ code: '23503', constraint: 'task_comments_task_fk' })

      // Accepted row, then a hard delete of the task removes it (ON DELETE CASCADE).
      expect(await insertError(ok)).toEqual({})
      const fk = await poolManager.get().query<{ confdeltype: string; target: string }>(
        `SELECT confdeltype, confrelid::regclass::text AS target FROM pg_constraint
         WHERE conrelid = 'task_comments'::regclass AND conname = 'task_comments_task_fk'`,
      )
      expect(fk.rows).toEqual([{ confdeltype: 'c', target: 'tasks' }])
      await poolManager.get().query('DELETE FROM tasks WHERE id = $1', [task.id])
      const gone = await poolManager.get().query('SELECT id FROM task_comments WHERE id = $1', [ok.id])
      expect(gone.rows).toEqual([])

      const index = await poolManager.get().query<{ columns: string[] }>(
        `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE c.relname = 'idx_tcmt_task_time' AND i.indrelid = 'task_comments'::regclass
         GROUP BY c.relname`,
      )
      expect(index.rows).toEqual([{ columns: ['task_id', 'created_at'] }])
      const names = await poolManager.get().query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'task_comments'::regclass ORDER BY conname`,
      )
      expect(names.rows.map((r) => r.conname)).toEqual([
        'task_comments_author_printable_chk',
        'task_comments_id_generated_chk',
        'task_comments_pkey',
        'task_comments_task_fk',
        'task_comments_tombstone_body_cleared_chk',
      ])
    })
  })

  describe('DELETE /api/tasks/:id (soft delete)', () => {
    // M3R3-LOCK-2: the delete stamp is written from SQL and keeps its
    // microseconds. A value that went through a JS Date would end in 000
    // microseconds on every row; the chance that three real stamps all do is
    // about 1e-9.
    it('keeps sub-millisecond precision in deleted_at, and writes the same value to updated_at', async () => {
      const { orgId, userA } = ids('stampprecision')
      const timeoutsBefore = await pooledStatementTimeouts()
      const deletedIds: string[] = []
      for (let i = 0; i < 3; i += 1) {
        const task = await createTask({ orgId, creatorId: userA, title: `任务${i}`, assignees: [userA] })
        await deleteTaskById({ orgId, actorId: userA, taskId: task.id })
        deletedIds.push(task.id)
      }
      const rows = await poolManager.get().query<{ sub_ms: string; same: boolean }>(
        `SELECT (extract(microseconds FROM deleted_at)::bigint % 1000)::text AS sub_ms, updated_at = deleted_at AS same
         FROM tasks WHERE id = ANY($1::text[])`,
        [deletedIds],
      )
      expect(rows.rows).toHaveLength(3)
      expect(rows.rows.every((r) => r.same)).toBe(true)
      expect(rows.rows.some((r) => r.sub_ms !== '0')).toBe(true)
      // Successful deletes leave the pooled connections' statement_timeout as it was.
      expect(await pooledStatementTimeouts()).toEqual(timeoutsBefore)
    })

    it('rejects deleting a task that still has undeleted children (409 HAS_CHILDREN)', async () => {
      const { orgId, userA } = ids('haschildren')
      const parent = await createTask({ orgId, creatorId: userA, title: '父', assignees: [userA] })
      const child = await createTask({ orgId, creatorId: userA, title: '子', assignees: [userA] })
      await poolManager.get().query('UPDATE tasks SET parent_id = $2, depth = 1 WHERE id = $1', [child.id, parent.id])
      await expect(deleteTaskById({ orgId, actorId: userA, taskId: parent.id }))
        .rejects.toMatchObject({ status: 409, code: 'HAS_CHILDREN' })

      // Delete the child first, then the parent succeeds.
      const childDeleted = await deleteTaskById({ orgId, actorId: userA, taskId: child.id })
      expect(childDeleted).toEqual({ id: child.id, deleted: true })
      const parentDeleted = await deleteTaskById({ orgId, actorId: userA, taskId: parent.id })
      expect(parentDeleted).toEqual({ id: parent.id, deleted: true })
    })

    it('is creator-only (404 for a non-creator), writes a deleted_at + deleted event, and a second delete is 404', async () => {
      const { orgId, userA, userB } = ids('creatoronly')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA, userB] })
      await expect(deleteTaskById({ orgId, actorId: userB, taskId: task.id }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })

      const deleted = await deleteTaskById({ orgId, actorId: userA, taskId: task.id })
      expect(deleted).toEqual({ id: task.id, deleted: true })
      const row = await poolManager.get().query<{ deleted_at: string | null }>('SELECT deleted_at FROM tasks WHERE id = $1', [task.id])
      expect(row.rows[0]?.deleted_at).not.toBeNull()
      const events = await poolManager.get().query<{ event_type: string; actor_id: string }>(
        `SELECT event_type, actor_id FROM task_events WHERE task_id = $1 AND event_type = 'deleted'`,
        [task.id],
      )
      expect(events.rows).toEqual([{ event_type: 'deleted', actor_id: userA }])

      await expect(deleteTaskById({ orgId, actorId: userA, taskId: task.id }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      await expect(getTask({ orgId, actorId: userA, taskId: task.id }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    })
  })
})
