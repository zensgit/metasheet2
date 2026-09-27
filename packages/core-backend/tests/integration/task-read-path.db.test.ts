import '../helpers/assert-rbac-optional-off'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { completeTask, countPending, createTask, listPending, listTasks } from '../../src/services/task-records'
import { isOverdueOrToday, resolveViewerTimeZone } from '../../src/tasks/task-dates'
import { taskMatchesView, type TaskView } from '../../src/tasks/task-access'

if (process.env.EXPECT_DB !== '1') {
  throw new Error('task-read-path.db.test.ts requires EXPECT_DB=1')
}

const ORG_PREFIX = 'org_tasks_read_'

function ids(label: string): { orgId: string; creator: string; me: string; other: string } {
  const stamp = randomUUID()
  return {
    orgId: `${ORG_PREFIX}${label}_${stamp}`,
    creator: `usrC_${label}_${stamp}`,
    me: `usrM_${label}_${stamp}`,
    other: `usrO_${label}_${stamp}`,
  }
}

async function seedPastDue(taskId: string): Promise<void> {
  await poolManager.get().query(
    `UPDATE tasks
     SET due_date = ((now() AT TIME ZONE 'UTC')::date - 1),
         due_time = TIME '12:00',
         due_at = now() - interval '2 hours',
         time_zone = 'UTC'
     WHERE id = $1`,
    [taskId],
  )
}

describe('tasks read path', () => {
  afterAll(async () => {
    await poolManager.get().query('DELETE FROM tasks WHERE org_id LIKE $1', [`${ORG_PREFIX}%`])
  })

  it('gate 4 negative: a completed assignee stays in assigned and leaves pending and the overdue count', async () => {
    const { orgId, creator, me, other } = ids('g4neg')
    const created = await createTask({
      orgId,
      creatorId: creator,
      title: '备料复核',
      assignees: [me, other],
      completionMode: 'all',
    })
    const counted = await poolManager.get().query<{ n: string }>(
      'SELECT count(*)::text AS n FROM task_assignees WHERE task_id = $1',
      [created.id],
    )
    expect(counted.rows[0]?.n).toBe('2')
    await seedPastDue(created.id)
    await completeTask({ orgId, actorId: me, taskId: created.id })

    const assigned = await listTasks({ orgId, actorId: me, view: 'assigned' })
    expect(assigned.map((row) => row.id)).toContain(created.id)
    const pending = await listPending({ orgId, actorId: me, viewerTz: null })
    expect(pending.map((row) => row.id)).not.toContain(created.id)
    expect(await countPending({ orgId, actorId: me, viewerTz: null })).toBe(0)
  })

  it('gate 4 positive: an overdue open assignment is pending and counts as 1', async () => {
    const { orgId, creator, me, other } = ids('g4pos')
    const created = await createTask({
      orgId,
      creatorId: creator,
      title: '备料复核',
      assignees: [me, other],
      completionMode: 'all',
    })
    await seedPastDue(created.id)

    const pending = await listPending({ orgId, actorId: me, viewerTz: null })
    expect(pending.map((row) => row.id)).toEqual([created.id])
    expect(await countPending({ orgId, actorId: me, viewerTz: null })).toBe(1)
  })

  it('keeps an undated open assignment on the pending list and out of the overdue count', async () => {
    // Lock §13-4: /pending passes all_open; /pending-count uses default badge_scope overdue.
    // Gate 4's two cells are both already overdue, so they do not collapse those parameters.
    const { orgId, creator, me } = ids('split')
    const created = await createTask({
      orgId,
      creatorId: creator,
      title: '备料复核',
      assignees: [me],
      completionMode: 'all',
    })

    const pending = await listPending({ orgId, actorId: me, viewerTz: null })
    expect(pending.map((row) => row.id)).toEqual([created.id])
    expect(await countPending({ orgId, actorId: me, viewerTz: null })).toBe(0)
  })

  it('gate 5: one all-day task has the same dueAt bytes for UTC+14 and UTC-11 viewers', async () => {
    const { orgId, creator, me } = ids('g5')
    const created = await createTask({
      orgId,
      creatorId: creator,
      title: '备料复核',
      assignees: [me],
      completionMode: 'all',
    })
    await poolManager.get().query(
      `UPDATE tasks
       SET due_date = '2026-09-28', due_time = NULL, due_at = NULL, time_zone = 'Asia/Shanghai'
       WHERE id = $1`,
      [created.id],
    )
    const east = await listPending({ orgId, actorId: me, viewerTz: 'Pacific/Kiritimati' })
    const west = await listPending({ orgId, actorId: me, viewerTz: 'Pacific/Pago_Pago' })
    const eastItem = east.find((row) => row.id === created.id)
    const westItem = west.find((row) => row.id === created.id)
    expect(eastItem?.dueAt).toBe('2026-09-28T15:59:59.999Z')
    expect(westItem?.dueAt).toBe(eastItem?.dueAt)
    expect(eastItem && 'description' in eastItem).toBe(false)
  })

  it('gate 8: invalid and missing viewer zones fall back to the task zone, and a UTC fallback disagrees', () => {
    const now = new Date('2026-09-15T12:30:00.000Z')
    const task = { dueAt: new Date('2026-09-15T18:00:00.000Z'), dueDate: null, dueTime: '00:00', timeZone: 'Asia/Shanghai' }
    const explicit = isOverdueOrToday(task, now, 'Asia/Shanghai')
    expect(isOverdueOrToday(task, now, resolveViewerTimeZone('Not/AZone', 'Asia/Shanghai'))).toBe(explicit)
    expect(isOverdueOrToday(task, now, resolveViewerTimeZone(undefined, 'Asia/Shanghai'))).toBe(explicit)
    const utcFallback = isOverdueOrToday(task, now, 'UTC')
    expect(utcFallback).not.toBe(explicit)
  })

  it('gate 8 negative: changing the viewer fallback to UTC makes both cells disagree', () => {
    const dates = new URL('../../src/tasks/task-dates.ts', import.meta.url)
    const needle = 'return validateViewerTimeZoneHeader(headerValue) ?? taskTimeZone'
    runSourceMutant(dates.pathname, needle, "return validateViewerTimeZoneHeader(headerValue) ?? 'UTC'", `
      const { isOverdueOrToday, resolveViewerTimeZone } = await import(${JSON.stringify(dates.pathname)})
      const now = new Date('2026-09-15T12:30:00.000Z')
      const task = { dueAt: new Date('2026-09-15T18:00:00.000Z'), dueDate: null, dueTime: '00:00', timeZone: 'Asia/Shanghai' }
      const explicit = isOverdueOrToday(task, now, 'Asia/Shanghai')
      const invalid = isOverdueOrToday(task, now, resolveViewerTimeZone('Not/AZone', 'Asia/Shanghai'))
      const missing = isOverdueOrToday(task, now, resolveViewerTimeZone(undefined, 'Asia/Shanghai'))
      console.log(JSON.stringify({ gate8: 'red', explicit, invalid, missing }))
      if (invalid === explicit || missing === explicit) process.exit(1)
      process.exit(0)
    `)
  }, 180000)
})

const ACCESS = new URL('../../src/tasks/task-access.ts', import.meta.url)
const VIEWS = new Set(['assigned', 'following', 'created', 'delegated', 'any_role'])
const SUFFIXES = new Set(['noa', 'oa', 'of'])

function parseCell(name: string): { roles: string[]; view: TaskView; suffix: string } {
  const parts = name.split('|')
  let suffix = ''
  if (SUFFIXES.has(parts[parts.length - 1] ?? '')) suffix = parts.pop() ?? ''
  const view = parts.pop()
  if (!view || !VIEWS.has(view)) throw new Error(name)
  const raw = parts.slice(1).join('|')
  return { roles: raw === 'none' ? [] : raw.split('+'), view: view as TaskView, suffix }
}

describe('gate 19 view grid', () => {
  afterAll(async () => {
    await poolManager.get().query('DELETE FROM tasks WHERE org_id LIKE $1', ['org_g19_%'])
  })

  const cells = [
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

  // Gate 17② counts each array row of this it.each (49 names, no header).
  it.each(cells)('%s', async (name) => {
      const { roles, view, suffix } = parseCell(name)
      const stamp = randomUUID()
      const orgId = `org_g19_${stamp}`
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
        orgId, creatorId: creator, title: '备料复核', assignees, completionMode: 'all',
      })
      const db = poolManager.get()
      if (meInFollowers) {
        await db.query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, me])
      }
      if (suffix === 'of') {
        await db.query('INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2)', [created.id, `usrF_${stamp}`])
      }
      const expectRow = taskMatchesView({
        createdBy: creator,
        assigneeIds: assignees,
        followerIds: [...(meInFollowers ? [me] : []), ...(suffix === 'of' ? [`usrF_${stamp}`] : [])],
      }, me, view)
      const rows = await listTasks({ orgId, actorId: me, view })
      expect(rows.map((row) => row.id).includes(created.id)).toBe(expectRow)
  })
})

function packageRoot(file: string): string {
  const at = file.lastIndexOf('/src/')
  if (at < 0) throw new Error(`not a package source file: ${file}`)
  return file.slice(0, at)
}

function runSourceMutant(file: string, needle: string, replacement: string, body: string): void {
  const backup = `/tmp/task-mutant-${randomUUID()}.bak`
  const script = `/tmp/task-probe-${randomUUID()}.mts`
  copyFileSync(file, backup)
  const original = readFileSync(file, 'utf8')
  let failed: unknown
  try {
    expect(original.includes(needle)).toBe(true)
    writeFileSync(file, original.replace(needle, replacement))
    writeFileSync(script, body)
    const tsx = createRequire(import.meta.url).resolve('tsx/cli')
    execFileSync(process.execPath, [tsx, script], {
      cwd: packageRoot(file), env: process.env, stdio: 'inherit', timeout: 120000,
    })
  } catch (err) {
    failed = err
  } finally {
    copyFileSync(backup, file)
    for (const path of [script, backup]) {
      try { unlinkSync(path) } catch { /* already removed */ }
    }
  }
  expect(readFileSync(file, 'utf8')).toBe(original)
  if (failed) throw failed
}

describe('gate 19 probes', () => {
  const file = ACCESS.pathname
  const cwd = packageRoot(file)

  afterAll(() => {
    const live = readFileSync(file, 'utf8')
    expect(live.includes("return 'FALSE'")).toBe(false)
  })

  it('probe 1: replacing the assigned arm with FALSE drops assigned, pending, and the count', async () => {
    const { orgId, creator, me } = ids('probe1green')
    const created = await createTask({
      orgId, creatorId: creator, title: '备料复核', assignees: [me], completionMode: 'all',
    })
    await seedPastDue(created.id)
    expect((await listTasks({ orgId, actorId: me, view: 'assigned' })).map((row) => row.id)).toContain(created.id)
    expect((await listPending({ orgId, actorId: me, viewerTz: null })).map((row) => row.id)).toContain(created.id)
    expect(await countPending({ orgId, actorId: me, viewerTz: null })).toBe(1)
    await poolManager.get().query('DELETE FROM tasks WHERE org_id = $1', [orgId])

    const needle = "case 'assigned':\n      return `EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = ${ME_PLACEHOLDER})`"
    runSourceMutant(file, needle, "case 'assigned':\n      return 'FALSE'", `
      const { createTask, listTasks, listPending, countPending } = await import(${JSON.stringify(cwd + '/src/services/task-records.ts')})
      const { poolManager } = await import(${JSON.stringify(cwd + '/src/integration/db/connection-pool.ts')})
      const orgId = 'org_probe1_' + Date.now()
      const creator = 'usrC_probe1'
      const me = 'usrM_probe1'
      const created = await createTask({ orgId, creatorId: creator, title: '备料复核', assignees: [me], completionMode: 'all' })
      await poolManager.get().query("UPDATE tasks SET due_at = now() - interval '2 hours', due_time = TIME '12:00', time_zone = 'UTC', due_date = (now() AT TIME ZONE 'UTC')::date - 1 WHERE id = $1", [created.id])
      let assignedRed = false
      try {
        const assigned = (await listTasks({ orgId, actorId: me, view: 'assigned' })).map((row) => row.id)
        assignedRed = !assigned.includes(created.id)
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
        assignedRed = code === '42P18'
      }
      const pending = (await listPending({ orgId, actorId: me, viewerTz: null })).map((row) => row.id)
      const count = await countPending({ orgId, actorId: me, viewerTz: null })
      await poolManager.get().query('DELETE FROM tasks WHERE org_id = $1', [orgId])
      console.log(JSON.stringify({ gate19probe1: 'red', assignedRed, pendingHasRow: pending.includes(created.id), count }))
      if (!assignedRed || pending.includes(created.id) || count !== 0) process.exit(1)
      process.exit(0)
    `)
  }, 180000)

  it('probe 2: flipping assignee complete makes complete fail and leaves the list row', async () => {
    const { orgId, creator, me } = ids('probe2green')
    const created = await createTask({
      orgId, creatorId: creator, title: '备料复核', assignees: [me], completionMode: 'all',
    })
    await seedPastDue(created.id)
    expect((await listTasks({ orgId, actorId: me, view: 'assigned' })).map((row) => row.id)).toContain(created.id)
    expect((await listPending({ orgId, actorId: me, viewerTz: null })).map((row) => row.id)).toContain(created.id)
    expect(await countPending({ orgId, actorId: me, viewerTz: null })).toBe(1)
    await completeTask({ orgId, actorId: me, taskId: created.id })
    await poolManager.get().query('DELETE FROM tasks WHERE org_id = $1', [orgId])

    const needle = `  assignee: {
    view: true,
    edit: true,
    complete: true,`
    runSourceMutant(file, needle, needle.replace('complete: true', 'complete: false'), `
      const { createTask, completeTask, listTasks, listPending, countPending } = await import(${JSON.stringify(cwd + '/src/services/task-records.ts')})
      const { poolManager } = await import(${JSON.stringify(cwd + '/src/integration/db/connection-pool.ts')})
      const orgId = 'org_probe2_' + Date.now()
      const creator = 'usrC_probe2'
      const me = 'usrM_probe2'
      const created = await createTask({ orgId, creatorId: creator, title: '备料复核', assignees: [me], completionMode: 'all' })
      await poolManager.get().query("UPDATE tasks SET due_at = now() - interval '2 hours', due_time = TIME '12:00', time_zone = 'UTC', due_date = (now() AT TIME ZONE 'UTC')::date - 1 WHERE id = $1", [created.id])
      let failed = false
      try { await completeTask({ orgId, actorId: me, taskId: created.id }) } catch { failed = true }
      const assigned = (await listTasks({ orgId, actorId: me, view: 'assigned' })).map((row) => row.id)
      const pending = (await listPending({ orgId, actorId: me, viewerTz: null })).map((row) => row.id)
      const count = await countPending({ orgId, actorId: me, viewerTz: null })
      await poolManager.get().query('DELETE FROM tasks WHERE org_id = $1', [orgId])
      console.log(JSON.stringify({ gate19probe2: 'red', failed, assigned: assigned.includes(created.id), pending: pending.includes(created.id), count }))
      if (!failed || !assigned.includes(created.id) || !pending.includes(created.id) || count !== 1) process.exit(1)
      process.exit(0)
    `)
  }, 180000)
})
