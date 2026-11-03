/**
 * M3 (P0-B) subtree tree: set/clear/move parent, depth 0..4 boundary,
 * self/descendant rejection, both-ends `edit`, cross-org 404,
 * parent-candidates, and gate 6 (structure-lock serialization).
 */
import '../helpers/assert-rbac-optional-off'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createTask } from '../../src/services/task-records'
import { deleteTaskById, getParentCandidates, setTaskParent } from '../../src/services/task-structure'
import { taskStructureLockKey } from '../../src/tasks/task-lock-keys'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-m3-tree.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_m3tree_'

function ids(label: string): { orgId: string; userA: string; userB: string; outsider: string } {
  const stamp = randomUUID()
  return {
    orgId: `${ORG_PREFIX}${label}_${stamp}`,
    userA: `usrA_${label}_${stamp}`,
    userB: `usrB_${label}_${stamp}`,
    outsider: `usrO_${label}_${stamp}`,
  }
}

async function taskRow(taskId: string): Promise<{ parentId: string | null; depth: number }> {
  const result = await poolManager.get().query<{ parent_id: string | null; depth: number }>(
    'SELECT parent_id, depth FROM tasks WHERE id = $1',
    [taskId],
  )
  const row = result.rows[0]
  if (!row) throw new Error('task missing')
  return { parentId: row.parent_id, depth: Number(row.depth) }
}

async function follow(taskId: string, userId: string): Promise<void> {
  await poolManager.get().query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [taskId, userId])
}

describe('tasks M3 tree real db', () => {
  afterAll(async () => {
    await poolManager.get().query('DELETE FROM tasks WHERE org_id LIKE $1', [`${ORG_PREFIX}%`])
  })

  it('walks depth 0..4 one level at a time and rejects the 6th level as depth_exceeded', async () => {
    const { orgId, userA } = ids('depth')
    const root = await createTask({ orgId, creatorId: userA, title: '根任务', assignees: [userA] })
    const c1 = await createTask({ orgId, creatorId: userA, title: '一级', assignees: [userA] })
    const c2 = await createTask({ orgId, creatorId: userA, title: '二级', assignees: [userA] })
    const c3 = await createTask({ orgId, creatorId: userA, title: '三级', assignees: [userA] })
    const c4 = await createTask({ orgId, creatorId: userA, title: '四级', assignees: [userA] })
    const c5 = await createTask({ orgId, creatorId: userA, title: '五级(应拒绝)', assignees: [userA] })

    const r1 = await setTaskParent({ orgId, actorId: userA, taskId: c1.id, body: { parentId: root.id } })
    expect(r1).toEqual({ id: c1.id, parentId: root.id, depth: 1 })
    const r2 = await setTaskParent({ orgId, actorId: userA, taskId: c2.id, body: { parentId: c1.id } })
    expect(r2.depth).toBe(2)
    const r3 = await setTaskParent({ orgId, actorId: userA, taskId: c3.id, body: { parentId: c2.id } })
    expect(r3.depth).toBe(3)
    const r4 = await setTaskParent({ orgId, actorId: userA, taskId: c4.id, body: { parentId: c3.id } })
    expect(r4.depth).toBe(4)
    expect(await taskRow(c4.id)).toEqual({ parentId: c3.id, depth: 4 })

    await expect(setTaskParent({ orgId, actorId: userA, taskId: c5.id, body: { parentId: c4.id } }))
      .rejects.toMatchObject({ status: 422, code: 'DEPTH_EXCEEDED' })
    expect(await taskRow(c5.id)).toEqual({ parentId: null, depth: 0 })
  })

  it('rejects self and descendant as 422 INVALID_PARENT', async () => {
    const { orgId, userA } = ids('self')
    const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
    const child = await createTask({ orgId, creatorId: userA, title: '子', assignees: [userA] })
    await setTaskParent({ orgId, actorId: userA, taskId: child.id, body: { parentId: root.id } })

    await expect(setTaskParent({ orgId, actorId: userA, taskId: root.id, body: { parentId: root.id } }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_PARENT' })
    await expect(setTaskParent({ orgId, actorId: userA, taskId: root.id, body: { parentId: child.id } }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_PARENT' })
  })

  it('is a noop when set to the same parent, or clear on an already-root task', async () => {
    const { orgId, userA } = ids('noop')
    const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
    const child = await createTask({ orgId, creatorId: userA, title: '子', assignees: [userA] })
    await setTaskParent({ orgId, actorId: userA, taskId: child.id, body: { parentId: root.id } })
    const before = await poolManager.get().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM task_events WHERE task_id = $1`,
      [child.id],
    )
    const again = await setTaskParent({ orgId, actorId: userA, taskId: child.id, body: { parentId: root.id } })
    expect(again).toEqual({ id: child.id, parentId: root.id, depth: 1 })
    const clearNoop = await setTaskParent({ orgId, actorId: userA, taskId: root.id, body: { parentId: null } })
    expect(clearNoop).toEqual({ id: root.id, parentId: null, depth: 0 })
    const after = await poolManager.get().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM task_events WHERE task_id = $1`,
      [child.id],
    )
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
  })

  // M3R2-AUTHZ-1/TM-1: in every cell below only the task-itself (child-side)
  // edit check can reject — the actor can edit the new parent (it created
  // it), and the child has no current parent or one the actor can edit.
  describe('requires edit on the task itself, else 404 (child side only)', () => {
    it('an actor who can edit the new parent but only follows the task gets 404, and parent_id/depth are unchanged', async () => {
      const { orgId, userA, userB } = ids('childedit')
      const child = await createTask({ orgId, creatorId: userA, title: '子(B 只是关注人)', assignees: [userA] })
      await follow(child.id, userB)
      const ownParent = await createTask({ orgId, creatorId: userB, title: 'B 自己的任务', assignees: [userB] })
      await expect(setTaskParent({ orgId, actorId: userB, taskId: child.id, body: { parentId: ownParent.id } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(await taskRow(child.id)).toEqual({ parentId: null, depth: 0 })
    })

    it('an actor who can edit the new parent but has no role on the task gets 404, and parent_id/depth are unchanged', async () => {
      const { orgId, userA, outsider } = ids('childnorole')
      const child = await createTask({ orgId, creatorId: userA, title: '子(外人无角色)', assignees: [userA] })
      const ownParent = await createTask({ orgId, creatorId: outsider, title: '外人自己的任务', assignees: [outsider] })
      await expect(setTaskParent({ orgId, actorId: outsider, taskId: child.id, body: { parentId: ownParent.id } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(await taskRow(child.id)).toEqual({ parentId: null, depth: 0 })
    })

    it('clearing the parent of a root task is 404 for a follower and for an outsider, not a 200 no-op', async () => {
      const { orgId, userA, userB, outsider } = ids('childclear')
      const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
      await follow(root.id, userB)
      for (const actorId of [userB, outsider]) {
        await expect(setTaskParent({ orgId, actorId, taskId: root.id, body: { parentId: null } }))
          .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      }
      expect(await taskRow(root.id)).toEqual({ parentId: null, depth: 0 })
    })

    it('moving a child out from under a parent the actor can edit is 404 when the actor only follows the child', async () => {
      const { orgId, userA, userB } = ids('childmove')
      // B created the current parent and the new parent; A created the child
      // and B only follows it.
      const currentParent = await createTask({ orgId, creatorId: userB, title: 'B 的父', assignees: [userB] })
      const newParent = await createTask({ orgId, creatorId: userB, title: 'B 的新父', assignees: [userB] })
      const child = await createTask({ orgId, creatorId: userA, title: '子', assignees: [userA] })
      await poolManager.get().query('UPDATE tasks SET parent_id = $2, depth = 1 WHERE id = $1', [child.id, currentParent.id])
      await follow(child.id, userB)
      await expect(setTaskParent({ orgId, actorId: userB, taskId: child.id, body: { parentId: newParent.id } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      await expect(setTaskParent({ orgId, actorId: userB, taskId: child.id, body: { parentId: null } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      expect(await taskRow(child.id)).toEqual({ parentId: currentParent.id, depth: 1 })
    })

    it('a non-editor with an invalid body gets 404, not 422 (contract §3.1: the body is validated after the task-side checks)', async () => {
      const { orgId, userA, userB, outsider } = ids('childbadbody')
      const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
      await follow(task.id, userB)
      for (const actorId of [userB, outsider]) {
        for (const body of [{}, { parentId: 42 }, { parentId: 'a\u0000b' }, { parentId: '' }]) {
          await expect(setTaskParent({ orgId, actorId, taskId: task.id, body }), JSON.stringify(body))
            .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
        }
      }
    })
  })

  it('requires edit on the CURRENT parent, else 404 (move and clear)', async () => {
    const { orgId, userA } = ids('curparent')
    const other = `usrB_curparent_${randomUUID()}`
    // parent created by "other"; actor is only a follower of the parent (view, not edit).
    const parent = await createTask({ orgId, creatorId: other, title: '父(actor 只是关注人)', assignees: [other] })
    const child = await createTask({ orgId, creatorId: userA, title: '子(actor 可编辑)', assignees: [userA] })
    await follow(parent.id, userA)
    // Seed the parent link directly in the table (not through the route) so the
    // fixture is not itself gated by the thing under test.
    await poolManager.get().query('UPDATE tasks SET parent_id = $2, depth = 1 WHERE id = $1', [child.id, parent.id])

    const newParent = await createTask({ orgId, creatorId: userA, title: '新父(actor 可编辑)', assignees: [userA] })
    await expect(setTaskParent({ orgId, actorId: userA, taskId: child.id, body: { parentId: newParent.id } }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    await expect(setTaskParent({ orgId, actorId: userA, taskId: child.id, body: { parentId: null } }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })

  it('requires edit on the NEW parent, else 404', async () => {
    const { orgId, userA } = ids('newparent')
    const other = `usrB_newparent_${randomUUID()}`
    const child = await createTask({ orgId, creatorId: userA, title: '子', assignees: [userA] })
    const newParent = await createTask({ orgId, creatorId: other, title: '目标父(actor 不可编辑)', assignees: [other] })
    await follow(newParent.id, userA)
    await expect(setTaskParent({ orgId, actorId: userA, taskId: child.id, body: { parentId: newParent.id } }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })

  it('is 404 when the new parent is in a different org', async () => {
    const { orgId, userA } = ids('xorg')
    const otherOrg = `${ORG_PREFIX}xorg_other_${randomUUID()}`
    const child = await createTask({ orgId, creatorId: userA, title: '子', assignees: [userA] })
    const foreignParent = await createTask({ orgId: otherOrg, creatorId: userA, title: '他 org 的父', assignees: [userA] })
    await expect(setTaskParent({ orgId, actorId: userA, taskId: child.id, body: { parentId: foreignParent.id } }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })

  it('422 INVALID_PARENT on a missing or wrongly-typed parentId field', async () => {
    const { orgId, userA } = ids('badbody')
    const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
    await expect(setTaskParent({ orgId, actorId: userA, taskId: task.id, body: {} }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_PARENT' })
    await expect(setTaskParent({ orgId, actorId: userA, taskId: task.id, body: { parentId: 42 } }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_PARENT' })
  })

  // M3R2-AUTHZ-4 family: a parentId that is not a printable id (U+0000,
  // other control or non-ASCII characters, empty) is a malformed body for an
  // editor, 422 INVALID_PARENT, and never reaches a bind parameter.
  it('422 INVALID_PARENT on a parentId that is not a printable id, including U+0000; the row is unchanged', async () => {
    const { orgId, userA } = ids('nulparent')
    const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
    for (const parentId of ['a\u0000b', '\u0000', 'tsk_\u0000', '', 'tsk x', 'tsk_é']) {
      await expect(setTaskParent({ orgId, actorId: userA, taskId: task.id, body: { parentId } }), JSON.stringify(parentId))
        .rejects.toMatchObject({ status: 422, code: 'INVALID_PARENT' })
    }
    expect(await taskRow(task.id)).toEqual({ parentId: null, depth: 0 })
  })

  it('a task id containing U+0000 is 404 on setTaskParent and parent-candidates, before any SQL', async () => {
    const { orgId, userA } = ids('nultask')
    const task = await createTask({ orgId, creatorId: userA, title: '任务', assignees: [userA] })
    for (const taskId of ['a\u0000b', `${task.id}\u0000`]) {
      await expect(setTaskParent({ orgId, actorId: userA, taskId, body: { parentId: null } }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
      await expect(getParentCandidates({ orgId, actorId: userA, taskId }))
        .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    }
  })

  // M3R2-TM-8 (S4): only live nodes count toward the moved subtree's height.
  it('a task whose only descendants are soft-deleted moves as a leaf (soft-deleted nodes do not count toward depth)', async () => {
    const { orgId, userA } = ids('deadsubtree')
    const t = await createTask({ orgId, creatorId: userA, title: 't', assignees: [userA] })
    const d1 = await createTask({ orgId, creatorId: userA, title: 'd1', assignees: [userA] })
    const d2 = await createTask({ orgId, creatorId: userA, title: 'd2', assignees: [userA] })
    const d3 = await createTask({ orgId, creatorId: userA, title: 'd3', assignees: [userA] })
    const db = poolManager.get()
    await db.query('UPDATE tasks SET parent_id = $2, depth = 1, deleted_at = now() WHERE id = $1', [d1.id, t.id])
    await db.query('UPDATE tasks SET parent_id = $2, depth = 2, deleted_at = now() WHERE id = $1', [d2.id, d1.id])
    await db.query('UPDATE tasks SET parent_id = $2, depth = 3, deleted_at = now() WHERE id = $1', [d3.id, d2.id])
    // Target at depth 2: a live leaf lands at 3; counting the dead chain
    // (height 3) would give 2 + 1 + 3 = 6 > 4.
    const r = await createTask({ orgId, creatorId: userA, title: 'r', assignees: [userA] })
    const x = await createTask({ orgId, creatorId: userA, title: 'x', assignees: [userA] })
    const y = await createTask({ orgId, creatorId: userA, title: 'y', assignees: [userA] })
    await setTaskParent({ orgId, actorId: userA, taskId: x.id, body: { parentId: r.id } })
    await setTaskParent({ orgId, actorId: userA, taskId: y.id, body: { parentId: x.id } })
    const moved = await setTaskParent({ orgId, actorId: userA, taskId: t.id, body: { parentId: y.id } })
    expect(moved).toEqual({ id: t.id, parentId: y.id, depth: 3 })
    expect(await taskRow(t.id)).toEqual({ parentId: y.id, depth: 3 })
    // The soft-deleted rows are not rewritten.
    expect(await Promise.all([taskRow(d1.id), taskRow(d2.id), taskRow(d3.id)])).toEqual([
      { parentId: t.id, depth: 1 }, { parentId: d1.id, depth: 2 }, { parentId: d2.id, depth: 3 },
    ])
  })

  it('parent-candidates excludes self/descendants/depth-violators and filters to editable tasks', async () => {
    const { orgId, userA } = ids('candidates')
    const other = `usrB_candidates_${randomUUID()}`
    const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
    const c1 = await createTask({ orgId, creatorId: userA, title: '一级', assignees: [userA] })
    const c2 = await createTask({ orgId, creatorId: userA, title: '二级', assignees: [userA] })
    const c3 = await createTask({ orgId, creatorId: userA, title: '三级', assignees: [userA] })
    const c4 = await createTask({ orgId, creatorId: userA, title: '四级', assignees: [userA] })
    await setTaskParent({ orgId, actorId: userA, taskId: c1.id, body: { parentId: root.id } })
    await setTaskParent({ orgId, actorId: userA, taskId: c2.id, body: { parentId: c1.id } })
    await setTaskParent({ orgId, actorId: userA, taskId: c3.id, body: { parentId: c2.id } })
    await setTaskParent({ orgId, actorId: userA, taskId: c4.id, body: { parentId: c3.id } })
    const notEditable = await createTask({ orgId, creatorId: other, title: 'actor 不可编辑', assignees: [other] })
    await follow(notEditable.id, userA)

    const result = await getParentCandidates({ orgId, actorId: userA, taskId: root.id })
    const idsFound = result.items.map((item) => item.id)
    // root excludes itself and all its descendants (c1..c4 — c4 would push a
    // reattached subtree of height 4 past depth 4 anyway).
    expect(idsFound).not.toContain(root.id)
    expect(idsFound).not.toContain(c1.id)
    expect(idsFound).not.toContain(c2.id)
    expect(idsFound).not.toContain(c3.id)
    expect(idsFound).not.toContain(c4.id)
    expect(idsFound).not.toContain(notEditable.id)

    // A fresh leaf (height 0) can attach under anything at depth 0..3 (would land
    // at depth 1..4, still within TASK_MAX_DEPTH), but NOT under c4 itself
    // (depth 4): depthOf(c4)=4, so 4+1+0=5 > 4 — c4 is depth-excluded as a
    // candidate parent for ANY task, leaf or not.
    //
    // M3-AUTHZ-1: for `root`, `notEditable` is ALSO excluded by depth alone
    // (root's subtree height is 4, so every depth-0 node is depth-excluded
    // for it) — the earlier `not.toContain(notEditable.id)` assertion above
    // is therefore vacuous with respect to the per-candidate `edit` filter; a
    // mutant that weakens that filter to `'view'` (or drops it) still passes
    // it. `leaf` has height 0, so depth alone does NOT exclude a depth-0 node
    // like `notEditable` — only the edit filter does, which is what this
    // assertion is actually pinned on. A positive control (an editable task
    // at the SAME depth as `notEditable`) rules out "the edit filter dropped
    // every depth-0 candidate by accident".
    const leaf = await createTask({ orgId, creatorId: userA, title: '新叶子', assignees: [userA] })
    const editableSibling = await createTask({ orgId, creatorId: userA, title: 'actor 可编辑的同深度任务', assignees: [userA] })
    const forLeaf = await getParentCandidates({ orgId, actorId: userA, taskId: leaf.id })
    const forLeafIds = forLeaf.items.map((item) => item.id)
    expect(forLeafIds).toContain(root.id)
    expect(forLeafIds).toContain(c3.id)
    expect(forLeafIds).not.toContain(c4.id)
    expect(forLeafIds).not.toContain(notEditable.id)
    expect(forLeafIds).toContain(editableSibling.id)
  })

  it('parent-candidates excludes another org\'s tasks even when the same user created them (M3G-5 org predicate)', async () => {
    const { orgId, userA } = ids('candidatesorg')
    const otherOrg = `${ORG_PREFIX}candidatesorg_other_${randomUUID()}`
    const task = await createTask({ orgId, creatorId: userA, title: '本 org 任务', assignees: [userA] })
    const foreignTask = await createTask({ orgId: otherOrg, creatorId: userA, title: '他 org 任务(同一用户创建)', assignees: [userA] })
    const result = await getParentCandidates({ orgId, actorId: userA, taskId: task.id })
    const idsFound = result.items.map((item) => item.id)
    expect(idsFound).not.toContain(foreignTask.id)
  })

  it('moving a subtree under a deeper parent rewrites every descendant depth in storage, and writes one parent_set event (M3-CONC-4/M3G-4, M3-CONC-8/M3G-9)', async () => {
    const { orgId, userA } = ids('depthrewrite')
    const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
    const c1 = await createTask({ orgId, creatorId: userA, title: 'c1', assignees: [userA] })
    const c2 = await createTask({ orgId, creatorId: userA, title: 'c2', assignees: [userA] })
    await setTaskParent({ orgId, actorId: userA, taskId: c1.id, body: { parentId: root.id } })
    await setTaskParent({ orgId, actorId: userA, taskId: c2.id, body: { parentId: c1.id } })
    expect(await taskRow(c1.id)).toEqual({ parentId: root.id, depth: 1 })
    expect(await taskRow(c2.id)).toEqual({ parentId: c1.id, depth: 2 })

    // A second, independent tree one level deeper: r2 -> x (x at depth 1).
    // Moving c1 (with its child c2) under x is a NONZERO depth delta (c1: 1
    // -> 2, c2: 2 -> 3). Moving between two depth-0 roots (as every other
    // successful move in this file does) leaves every depth unchanged and
    // cannot catch a no-op descendant-rewrite mutant.
    const r2 = await createTask({ orgId, creatorId: userA, title: 'r2', assignees: [userA] })
    const x = await createTask({ orgId, creatorId: userA, title: 'x', assignees: [userA] })
    await setTaskParent({ orgId, actorId: userA, taskId: x.id, body: { parentId: r2.id } })
    expect(await taskRow(x.id)).toEqual({ parentId: r2.id, depth: 1 })

    const before = await poolManager.get().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM task_events WHERE task_id = $1 AND event_type = 'parent_set'`,
      [c1.id],
    )
    const moved = await setTaskParent({ orgId, actorId: userA, taskId: c1.id, body: { parentId: x.id } })
    expect(moved).toEqual({ id: c1.id, parentId: x.id, depth: 2 })
    expect(await taskRow(c1.id)).toEqual({ parentId: x.id, depth: 2 })
    expect(await taskRow(c2.id)).toEqual({ parentId: c1.id, depth: 3 })

    const events = await poolManager.get().query<{ event_type: string; actor_id: string }>(
      `SELECT event_type, actor_id FROM task_events WHERE task_id = $1 AND event_type = 'parent_set'`,
      [c1.id],
    )
    expect(events.rows).toHaveLength(Number(before.rows[0]?.n ?? 0) + 1)
    expect(events.rows[events.rows.length - 1]).toEqual({ event_type: 'parent_set', actor_id: userA })
  })

  // R3-TAM-1 / R3-TAM-3: a branching subtree a -> {b1 -> c, b2, b3} moved by
  // a nonzero depth delta. Descendant depths are 3, 4, 3, 3 with the deeper
  // node in one position only, so any mispairing of the id and depth arrays
  // (reversed, sorted, shifted) stores a wrong depth somewhere. Every
  // descendant's updated_at is the moved row's and has advanced.
  it('moving a branching subtree rewrites every descendant depth to its own value and stamps every row\'s updated_at', async () => {
    const { orgId, userA } = ids('branchrewrite')
    const mk = async (title: string) => (await createTask({ orgId, creatorId: userA, title, assignees: [userA] })).id
    const r = await mk('r')
    const a = await mk('a')
    const b1 = await mk('b1')
    const c = await mk('c')
    const b2 = await mk('b2')
    const b3 = await mk('b3')
    await setTaskParent({ orgId, actorId: userA, taskId: a, body: { parentId: r } })
    for (const child of [b1, b2, b3]) await setTaskParent({ orgId, actorId: userA, taskId: child, body: { parentId: a } })
    await setTaskParent({ orgId, actorId: userA, taskId: c, body: { parentId: b1 } })
    const r2 = await mk('r2')
    const x = await mk('x')
    await setTaskParent({ orgId, actorId: userA, taskId: x, body: { parentId: r2 } })
    const subtree = [a, b1, c, b2, b3]
    // Push every updated_at into the past so "advanced" is observable.
    await poolManager.get().query(`UPDATE tasks SET updated_at = updated_at - interval '1 hour' WHERE id = ANY($1::text[])`, [subtree])
    const before = await poolManager.get().query<{ id: string; updated_at: Date }>('SELECT id, updated_at FROM tasks WHERE id = ANY($1::text[])', [subtree])
    const beforeAt = new Map(before.rows.map((row) => [row.id, row.updated_at.getTime()]))

    // a: 1 -> 2 under x (depth 1), so every descendant moves down by one.
    const moved = await setTaskParent({ orgId, actorId: userA, taskId: a, body: { parentId: x } })
    expect(moved).toEqual({ id: a, parentId: x, depth: 2 })
    const rows = await poolManager.get().query<{ id: string; parent_id: string | null; depth: number; updated_at: Date }>(
      'SELECT id, parent_id, depth, updated_at FROM tasks WHERE id = ANY($1::text[])',
      [subtree],
    )
    const byId = new Map(rows.rows.map((row) => [row.id, row]))
    expect({
      a: [byId.get(a)!.parent_id, Number(byId.get(a)!.depth)],
      b1: [byId.get(b1)!.parent_id, Number(byId.get(b1)!.depth)],
      c: [byId.get(c)!.parent_id, Number(byId.get(c)!.depth)],
      b2: [byId.get(b2)!.parent_id, Number(byId.get(b2)!.depth)],
      b3: [byId.get(b3)!.parent_id, Number(byId.get(b3)!.depth)],
    }).toEqual({ a: [x, 2], b1: [a, 3], c: [b1, 4], b2: [a, 3], b3: [a, 3] })
    const movedAt = byId.get(a)!.updated_at.getTime()
    for (const id of subtree) {
      expect(byId.get(id)!.updated_at.getTime(), id).toBe(movedAt)
      expect(byId.get(id)!.updated_at.getTime(), id).toBeGreaterThan(beforeAt.get(id)!)
    }
  })

  it('clearing the parent of a mid-level node rewrites its own and its descendants\' depth, and writes one parent_cleared event (M3-CONC-4/M3G-4, M3-CONC-8/M3G-9)', async () => {
    const { orgId, userA } = ids('clearrewrite')
    const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
    const m = await createTask({ orgId, creatorId: userA, title: 'm', assignees: [userA] })
    const k = await createTask({ orgId, creatorId: userA, title: 'k', assignees: [userA] })
    await setTaskParent({ orgId, actorId: userA, taskId: m.id, body: { parentId: root.id } })
    await setTaskParent({ orgId, actorId: userA, taskId: k.id, body: { parentId: m.id } })
    expect(await taskRow(m.id)).toEqual({ parentId: root.id, depth: 1 })
    expect(await taskRow(k.id)).toEqual({ parentId: m.id, depth: 2 })

    const cleared = await setTaskParent({ orgId, actorId: userA, taskId: m.id, body: { parentId: null } })
    expect(cleared).toEqual({ id: m.id, parentId: null, depth: 0 })
    expect(await taskRow(m.id)).toEqual({ parentId: null, depth: 0 })
    expect(await taskRow(k.id)).toEqual({ parentId: m.id, depth: 1 })

    const events = await poolManager.get().query<{ event_type: string; actor_id: string }>(
      `SELECT event_type, actor_id FROM task_events WHERE task_id = $1 AND event_type = 'parent_cleared'`,
      [m.id],
    )
    expect(events.rows).toEqual([{ event_type: 'parent_cleared', actor_id: userA }])
  })

  it('DEPTH_EXCEEDED leaves every row in the rejected subtree and target unchanged', async () => {
    const { orgId, userA } = ids('depthexceeded')
    const p = await createTask({ orgId, creatorId: userA, title: 'p', assignees: [userA] })
    const p1 = await createTask({ orgId, creatorId: userA, title: 'p1', assignees: [userA] })
    const p2 = await createTask({ orgId, creatorId: userA, title: 'p2', assignees: [userA] })
    await setTaskParent({ orgId, actorId: userA, taskId: p1.id, body: { parentId: p.id } })
    await setTaskParent({ orgId, actorId: userA, taskId: p2.id, body: { parentId: p1.id } })
    // height(p's subtree) = 2

    const q0 = await createTask({ orgId, creatorId: userA, title: 'q0', assignees: [userA] })
    const q1 = await createTask({ orgId, creatorId: userA, title: 'q1', assignees: [userA] })
    const q2 = await createTask({ orgId, creatorId: userA, title: 'q2', assignees: [userA] })
    await setTaskParent({ orgId, actorId: userA, taskId: q1.id, body: { parentId: q0.id } })
    await setTaskParent({ orgId, actorId: userA, taskId: q2.id, body: { parentId: q1.id } })
    // depthOf(q2) = 2; 2 + 1 + height(2) = 5 > 4 => DEPTH_EXCEEDED

    const before = await Promise.all([taskRow(p.id), taskRow(p1.id), taskRow(p2.id), taskRow(q2.id)])
    await expect(setTaskParent({ orgId, actorId: userA, taskId: p.id, body: { parentId: q2.id } }))
      .rejects.toMatchObject({ status: 422, code: 'DEPTH_EXCEEDED' })
    const after = await Promise.all([taskRow(p.id), taskRow(p1.id), taskRow(p2.id), taskRow(q2.id)])
    expect(after).toEqual(before)
  })

  it('gate 6: a race between deleting a parent and reparenting its child resolves to exactly one winner, never a dangling pointer (M3-CONC-1)', async () => {
    const { orgId, userA } = ids('delvsset')
    const p = await createTask({ orgId, creatorId: userA, title: 'P', assignees: [userA] })
    const c = await createTask({ orgId, creatorId: userA, title: 'C', assignees: [userA] })

    const pool = poolManager.get().getInternalPool()
    const holder = await pool.connect()
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      if (!holder.processID) throw new Error('holder pid missing')
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
      pending = Promise.allSettled([
        setTaskParent({ orgId, actorId: userA, taskId: c.id, body: { parentId: p.id } }),
        deleteTaskById({ orgId, actorId: userA, taskId: p.id }),
      ])
      await waitUntilBlocked(holder.processID, 2)
      await holder.query('COMMIT')
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* already committed */ }
      holder.release()
    }
    const [setOutcome, delOutcome] = await pending!

    const fulfilled = [setOutcome, delOutcome].filter((o) => o.status === 'fulfilled')
    const rejected = [setOutcome, delOutcome].filter((o) => o.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    if (setOutcome.status === 'fulfilled') {
      // setTaskParent ran first: C is now a live child of P, so the delete
      // correctly sees it and is rejected as HAS_CHILDREN (not a silent
      // no-op, not a 500).
      expect(delOutcome.status).toBe('rejected')
      expect((delOutcome as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'HAS_CHILDREN' })
    } else {
      // deleteTaskById ran first: P no longer exists, so the reparent
      // correctly 404s on the (now-deleted) new parent.
      expect(delOutcome.status).toBe('fulfilled')
      expect((setOutcome as PromiseRejectedResult).reason).toMatchObject({ status: 404, code: 'NOT_FOUND' })
    }

    // No live task in the org is left pointing at a deleted or missing parent.
    const dangling = await poolManager.get().query<{ id: string }>(
      `SELECT c.id FROM tasks c LEFT JOIN tasks par ON par.id = c.parent_id
       WHERE c.org_id = $1 AND c.deleted_at IS NULL AND c.parent_id IS NOT NULL
         AND (par.id IS NULL OR par.deleted_at IS NOT NULL)`,
      [orgId],
    )
    expect(dangling.rows).toEqual([])
  })

  it('gate 6: two independent connections cross-moving serialize through the structure lock', async () => {
    const { orgId, userA } = ids('cross')
    const a = await createTask({ orgId, creatorId: userA, title: 'A', assignees: [userA] })
    const b = await createTask({ orgId, creatorId: userA, title: 'B', assignees: [userA] })

    // Force genuine contention (not incidental Promise scheduling): a third
    // connection holds the structure lock first, both moves are launched
    // while it is held and confirmed blocked, then the lock is released and
    // the two production calls run the actual cross-move race.
    const pool = poolManager.get().getInternalPool()
    const holder = await pool.connect()
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined
    try {
      if (!holder.processID) throw new Error('holder pid missing')
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
      pending = Promise.allSettled([
        setTaskParent({ orgId, actorId: userA, taskId: a.id, body: { parentId: b.id } }),
        setTaskParent({ orgId, actorId: userA, taskId: b.id, body: { parentId: a.id } }),
      ])
      await waitUntilBlocked(holder.processID, 2)
      await holder.query('COMMIT')
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* already committed */ }
      holder.release()
    }
    const [aOutcome, bOutcome] = await pending!
    const settled = [aOutcome, bOutcome]
    const fulfilled = settled.filter((o) => o.status === 'fulfilled')
    const rejected = settled.filter((o) => o.status === 'rejected')
    // Exactly one side of the cross-move succeeds; the other is rejected once the
    // first has committed and made it a would-be cycle (self/descendant), never a
    // 500 or a silent no-op.
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 422, code: 'INVALID_PARENT' })

    // The final tree is acyclic: exactly one of A/B has the other as its parent,
    // never both.
    const [rowA, rowB] = await Promise.all([taskRow(a.id), taskRow(b.id)])
    const aParentsB = rowA.parentId === b.id
    const bParentsA = rowB.parentId === a.id
    expect(aParentsB !== bParentsA).toBe(true)
    expect(aParentsB || bParentsA).toBe(true)
  })

  it('gate 6: a connection holding the structure lock blocks the production reparent op (positive control)', async () => {
    const { orgId, userA } = ids('lockwait')
    const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
    const child = await createTask({ orgId, creatorId: userA, title: '子', assignees: [userA] })
    const pool = poolManager.get().getInternalPool()
    const holder = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      if (!holder.processID) throw new Error('holder pid missing')
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
      // Canonical key reference: read back the (classid, objid, objsubid) the
      // HOLDER itself was granted, rather than recomputing hashtext's signed/
      // unsigned split by hand (lock §6.4's `objsubid=1` / negative-hashtext
      // `classid=4294967295` rule, read off the real row instead of re-derived).
      const held = await poolManager.get().query<{ classid: number; objid: number; objsubid: number }>(
        `SELECT classid, objid, objsubid FROM pg_locks
         WHERE locktype = 'advisory' AND pid = $1 AND granted = true`,
        [holder.processID],
      )
      expect(held.rows).toHaveLength(1)
      expect(held.rows[0]?.objsubid).toBe(1)
      const { classid, objid } = held.rows[0]!

      pending = setTaskParent({ orgId, actorId: userA, taskId: child.id, body: { parentId: root.id } })

      // Positive control: the production op's connection is waiting on the
      // advisory lock wait event AND pg_locks shows a granted=false row for
      // the SAME (classid, objid, objsubid) the holder was granted.
      const deadline = Date.now() + 8000
      let blocked = false
      while (Date.now() < deadline) {
        const waiters = await poolManager.get().query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
             AND $1 = ANY (pg_blocking_pids(pid))`,
          [holder.processID],
        )
        const notGranted = await poolManager.get().query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks
           WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 1 AND granted = false`,
          [classid, objid],
        )
        if (Number(waiters.rows[0]?.n ?? 0) >= 1 && Number(notGranted.rows[0]?.n ?? 0) >= 1) { blocked = true; break }
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      expect(blocked).toBe(true)

      await holder.query('COMMIT')
      const result = await pending
      expect(result).toMatchObject({ id: child.id, parentId: root.id, depth: 1 })

      // Once the holder has committed, the same key shows no not-granted row.
      const afterCommit = await poolManager.get().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks
         WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 1 AND granted = false`,
        [classid, objid],
      )
      expect(afterCommit.rows[0]?.n).toBe('0')
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* already committed */ }
      if (pending) await pending.catch(() => undefined)
      holder.release()
    }
  })

  it('gate 6 negative control: without acquireTaskStructureLock the reparent op does not block', async () => {
    const { orgId, userA } = ids('lockneg')
    const root = await createTask({ orgId, creatorId: userA, title: '根', assignees: [userA] })
    const child = await createTask({ orgId, creatorId: userA, title: '子', assignees: [userA] })
    const pool = poolManager.get().getInternalPool()
    const holder = await pool.connect()
    try {
      if (!holder.processID) throw new Error('holder pid missing')
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])

      // M3-CONC-7/M3G-7: keyed to the SAME (classid, objid, objsubid) the
      // holder was actually granted, read back the same way the positive
      // control does — not a bare "some advisory lock, some key" count,
      // which a holder of a DIFFERENT key would also satisfy.
      const held = await poolManager.get().query<{ classid: number; objid: number; objsubid: number }>(
        `SELECT classid, objid, objsubid FROM pg_locks
         WHERE locktype = 'advisory' AND pid = $1 AND granted = true`,
        [holder.processID],
      )
      expect(held.rows).toHaveLength(1)
      expect(held.rows[0]?.objsubid).toBe(1)
      const { classid, objid } = held.rows[0]!

      const lockFile = new URL('../../src/db/task-advisory-locks.ts', import.meta.url).pathname
      const original = readFileSync(lockFile, 'utf8')
      const needle = `export async function acquireTaskStructureLock(
  query: TaskAdvisoryQuery,
  orgId: string,
): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
}`
      expect(original.includes(needle)).toBe(true)
      const mutated = needle.replace(
        `await query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])`,
        `// mutated for gate 6 negative control: lock acquisition skipped`,
      )
      const backup = `/tmp/task-lock-mutant-${randomUUID()}.bak`
      const script = `/tmp/task-lock-probe-${randomUUID()}.mts`
      copyFileSync(lockFile, backup)
      let failed: unknown
      try {
        writeFileSync(lockFile, original.replace(needle, mutated))
        const rewritten = readFileSync(lockFile, 'utf8')
        expect(rewritten).not.toBe(original)
        expect(rewritten.includes('lock acquisition skipped')).toBe(true)
        writeFileSync(script, `
          const { setTaskParent } = await import(${JSON.stringify(new URL('../../src/services/task-structure.ts', import.meta.url).pathname)})
          const start = Date.now()
          const result = await setTaskParent({
            orgId: ${JSON.stringify(orgId)},
            actorId: ${JSON.stringify(userA)},
            taskId: ${JSON.stringify(child.id)},
            body: { parentId: ${JSON.stringify(root.id)} },
          })
          const elapsedMs = Date.now() - start
          console.log(JSON.stringify({ gate6neg: 'red', elapsedMs, result }))
          if (elapsedMs > 4000) process.exit(1)
          if (result.parentId !== ${JSON.stringify(root.id)}) process.exit(1)
          process.exit(0)
        `)
        const tsx = createRequire(import.meta.url).resolve('tsx/cli')
        const cwd = lockFile.slice(0, lockFile.indexOf('/src/'))
        execFileSync(process.execPath, [tsx, script], {
          cwd,
          env: process.env,
          stdio: 'inherit',
          timeout: 120000,
        })
        // While the mutant subprocess ran (and returned quickly), the holder's own
        // structure-lock grant must still show granted=true, on the SAME key
        // read above — the holder's transaction was never touched, only the
        // production op's own lock acquisition was skipped.
        const stillHeld = await poolManager.get().query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks
           WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 1 AND granted = true`,
          [classid, objid],
        )
        expect(Number(stillHeld.rows[0]?.n ?? 0)).toBeGreaterThan(0)
        // And, keyed to the same lock, there is no granted=false row at all —
        // the mutant op never even attempted to acquire (let alone queue on)
        // the structure key, consistent with its skipped call site.
        const notGranted = await poolManager.get().query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks
           WHERE locktype = 'advisory' AND classid = $1 AND objid = $2 AND objsubid = 1 AND granted = false`,
          [classid, objid],
        )
        expect(notGranted.rows[0]?.n).toBe('0')
      } catch (err) {
        failed = err
      } finally {
        copyFileSync(backup, lockFile)
        for (const path of [script, backup]) {
          try { unlinkSync(path) } catch { /* already removed */ }
        }
      }
      expect(readFileSync(lockFile, 'utf8')).toBe(original)
      if (failed) throw failed
    } finally {
      try { await holder.query('ROLLBACK') } catch { /* already committed */ }
      holder.release()
    }
  }, 180000)
})

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
