import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { createTask, listTasks } from '../../src/services/task-records'
import { taskMatchesView, type TaskView } from '../../src/tasks/task-access'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-gate19.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_g19_'
const VIEWS = new Set(['assigned', 'following', 'created', 'delegated', 'any_role'])
const SUFFIXES = new Set(['noa', 'oa', 'of'])

const CELLS = [
  'gate19|assignee+creator+follower|any_role',
  'gate19|assignee+creator+follower|assigned',
  'gate19|assignee+creator+follower|created',
  'gate19|assignee+creator+follower|delegated',
  'gate19|assignee+creator+follower|delegated|noa',
  'gate19|assignee+creator+follower|following',
  'gate19|assignee+creator|any_role',
  'gate19|assignee+creator|assigned',
  'gate19|assignee+creator|created',
  'gate19|assignee+creator|delegated',
  'gate19|assignee+creator|delegated|noa',
  'gate19|assignee+creator|following',
  'gate19|assignee+follower|any_role',
  'gate19|assignee+follower|assigned',
  'gate19|assignee+follower|created',
  'gate19|assignee+follower|delegated',
  'gate19|assignee+follower|following',
  'gate19|assignee|any_role',
  'gate19|assignee|assigned',
  'gate19|assignee|created',
  'gate19|assignee|delegated',
  'gate19|assignee|following',
  'gate19|creator+follower|any_role',
  'gate19|creator+follower|assigned',
  'gate19|creator+follower|created',
  'gate19|creator+follower|delegated',
  'gate19|creator+follower|delegated|noa',
  'gate19|creator+follower|following',
  'gate19|creator|any_role',
  'gate19|creator|any_role|noa',
  'gate19|creator|assigned',
  'gate19|creator|created',
  'gate19|creator|delegated',
  'gate19|creator|delegated|noa',
  'gate19|creator|following',
  'gate19|follower|any_role',
  'gate19|follower|assigned',
  'gate19|follower|created',
  'gate19|follower|delegated',
  'gate19|follower|following',
  'gate19|none|any_role',
  'gate19|none|any_role|oa',
  'gate19|none|assigned',
  'gate19|none|assigned|oa',
  'gate19|none|created',
  'gate19|none|delegated',
  'gate19|none|delegated|oa',
  'gate19|none|following',
  'gate19|none|following|of'
]

function parseCell(name: string): { roles: string[]; view: TaskView; suffix: string } {
  const parts = name.split('|')
  if (parts[0] !== 'gate19') throw new Error(name)
  let suffix = ''
  if (SUFFIXES.has(parts[parts.length - 1] ?? '')) suffix = parts.pop() ?? ''
  const view = parts.pop()
  if (!view || !VIEWS.has(view)) throw new Error(name)
  const raw = parts.slice(1).join('|')
  const roles = raw === 'none' ? [] : raw.split('+')
  return { roles, view: view as TaskView, suffix }
}

describe('gate 19 view grid', () => {
  afterAll(async () => {
    await poolManager.get().query('DELETE FROM tasks WHERE org_id LIKE $1', [`${ORG_PREFIX}%`])
  })

  for (const name of CELLS) {
    it(name, async () => {
      const { roles, view, suffix } = parseCell(name)
      const stamp = randomUUID()
      const orgId = `${ORG_PREFIX}${stamp}`
      const me = `usrM_${stamp}`
      const other = `usrO_${stamp}`
      const createdByMe = roles.includes('creator')
      const meInAssignees = roles.includes('assignee')
      const meInFollowers = roles.includes('follower')
      let othersAssigned = (view === 'delegated' || view === 'any_role') && createdByMe
      if (suffix === 'noa') othersAssigned = false
      if (suffix === 'oa') othersAssigned = true
      const creator = createdByMe ? me : other
      const assignees: string[] = []
      if (meInAssignees) assignees.push(me)
      if (othersAssigned) assignees.push(createdByMe ? other : `usrA_${stamp}`)
      const created = await createTask({
        orgId,
        creatorId: creator,
        title: '备料复核',
        assignees,
        completionMode: 'all',
      })
      const db = poolManager.get()
      if (meInFollowers) {
        await db.query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, me])
      }
      if (suffix === 'of') {
        await db.query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, `usrF_${stamp}`])
      }
      const assigneeIds = assignees.slice()
      const followerIds = [
        ...(meInFollowers ? [me] : []),
        ...(suffix === 'of' ? [`usrF_${stamp}`] : []),
      ]
      const expectRow = taskMatchesView({
        createdBy: creator,
        assigneeIds,
        followerIds,
      }, me, view)
      const rows = await listTasks({ orgId, actorId: me, view })
      const seen = rows.map((row) => row.id)
      expect(seen.includes(created.id)).toBe(expectRow)
    })
  }
})
