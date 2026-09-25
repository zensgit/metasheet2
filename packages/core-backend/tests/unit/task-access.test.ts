import { describe, expect, it } from 'vitest'
import {
  TASK_ABILITIES,
  TASK_ROLES,
  TASK_ROLE_ABILITY,
  TASK_VIEWS,
  buildTaskPendingCondition,
  buildTaskScopeCondition,
  can,
  resolveTaskRoles,
  taskMatchesView,
  type TaskAbility,
  type TaskRole,
  type TaskView,
  type TaskViewRow,
} from '../../src/tasks/task-access'

// ---------------------------------------------------------------------------------------------
// §2.1 — TASK_ROLE_ABILITY 6×8 truth table, transcribed verbatim from the design doc.
// ---------------------------------------------------------------------------------------------
const EXPECTED_ROLE_ABILITY: Record<TaskRole, Record<TaskAbility, boolean>> = {
  creator: { view: true, edit: true, complete: true, reopen: true, comment: true, attach: true, delete: true, leave: false },
  assignee: { view: true, edit: true, complete: true, reopen: true, comment: true, attach: true, delete: false, leave: false },
  follower: { view: true, edit: false, complete: false, reopen: false, comment: true, attach: false, delete: false, leave: true },
  'list-editor': { view: true, edit: true, complete: true, reopen: true, comment: true, attach: true, delete: false, leave: false },
  'list-reader': { view: true, edit: false, complete: false, reopen: false, comment: true, attach: false, delete: false, leave: false },
  none: { view: false, edit: false, complete: false, reopen: false, comment: false, attach: false, delete: false, leave: false },
}

describe('task-access', () => {
  describe('closed sets', () => {
    it('TASK_ROLES is the exact six-role closed set', () => {
      expect(TASK_ROLES).toEqual(['creator', 'assignee', 'follower', 'list-editor', 'list-reader', 'none'])
    })
    it('TASK_ABILITIES is the exact eight-ability closed set', () => {
      expect(TASK_ABILITIES).toEqual(['view', 'edit', 'complete', 'reopen', 'comment', 'attach', 'delete', 'leave'])
    })
    it('TASK_VIEWS is the exact five-view closed set', () => {
      expect(TASK_VIEWS).toEqual(['assigned', 'following', 'created', 'delegated', 'any_role'])
    })
  })

  describe('TASK_ROLE_ABILITY — 6×8 truth table, cell by cell (design §2.1)', () => {
    for (const role of TASK_ROLES) {
      for (const ability of TASK_ABILITIES) {
        it(`${role} × ${ability} = ${EXPECTED_ROLE_ABILITY[role][ability]}`, () => {
          expect(TASK_ROLE_ABILITY[role][ability]).toBe(EXPECTED_ROLE_ABILITY[role][ability])
        })
      }
    }
  })

  describe('can() — union across roles', () => {
    it('a single role reads straight off the table', () => {
      expect(can(['assignee'], 'complete')).toBe(true)
      expect(can(['follower'], 'complete')).toBe(false)
    })
    it('multiple roles take the union — any true role wins', () => {
      expect(can(['follower', 'assignee'], 'edit')).toBe(true) // follower=false, assignee=true -> true
      expect(can(['follower', 'list-reader'], 'edit')).toBe(false) // both false -> false
    })
    it('none alone answers false for every ability', () => {
      for (const ability of TASK_ABILITIES) expect(can(['none'], ability)).toBe(false)
    })
    it('empty role list answers false for every ability', () => {
      for (const ability of TASK_ABILITIES) expect(can([], ability)).toBe(false)
    })

    // A prior "mutation probe" here was REMOVED (P2 finding): it diffed a spread-clone of
    // `EXPECTED_ROLE_ABILITY` against `EXPECTED_ROLE_ABILITY` itself, never reading the SOURCE
    // `TASK_ROLE_ABILITY` at all — it was green for every possible source and proved nothing about
    // this module. The real copy-injection run (source `TASK_ROLE_ABILITY.assignee.complete`
    // flipped to `false` in a scratch copy of task-access.ts, real test suite re-run against it) DID
    // red — `assignee × complete` and the `can(['assignee'],'complete')` test above both failed —
    // but that evidence lives outside this repo (an in-repo probe that imports a mutated module
    // copy would need build tooling this test file does not have, and a `vi.mock` of the
    // `TASK_ROLE_ABILITY` export would not reach `can()`'s internal module-scope binding). The
    // "TASK_ROLE_ABILITY — 6×8 truth table, cell by cell" `describe` above IS the real coverage: it
    // reads the source table directly and will fail on any single-cell edit.
  })

  describe('resolveTaskRoles', () => {
    it('creator + assignee + follower all resolve when the row says so', () => {
      const roles = resolveTaskRoles({ createdBy: 'me', assigneeIds: ['me'], followerIds: ['me'] }, 'me')
      expect(roles.sort()).toEqual(['assignee', 'creator', 'follower'])
    })
    it('no matching role resolves to exactly ["none"]', () => {
      const roles = resolveTaskRoles({ createdBy: 'other', assigneeIds: [], followerIds: [] }, 'me')
      expect(roles).toEqual(['none'])
    })
    it('list memberships are P1 — default empty means no list-editor/list-reader appear', () => {
      const roles = resolveTaskRoles({ createdBy: 'other', assigneeIds: [], followerIds: [] }, 'me')
      expect(roles).not.toContain('list-editor')
      expect(roles).not.toContain('list-reader')
    })
    it('an explicit list membership still resolves (forward-compat signature)', () => {
      const roles = resolveTaskRoles({ createdBy: 'other', assigneeIds: [], followerIds: [] }, 'me', [
        { listId: 'tlst_a', role: 'editor' },
      ])
      expect(roles).toContain('list-editor')
    })
  })

  // -------------------------------------------------------------------------------------------
  // §2.2 / lock §6.1 — the 49-cell gate-19 grid, case names `gate19|<s>|<v>[|tag]` exactly as the
  // lock's i-m2 block. The pinned 8×5 base table + the 9-cell I_FLIP override table.
  // -------------------------------------------------------------------------------------------
  const ME = 'u_me'
  const OTHER = 'u_other'
  const OTHER2 = 'u_other2'

  function flagsFor(s: string): { creator: boolean; assignee: boolean; follower: boolean } {
    if (s === 'none') return { creator: false, assignee: false, follower: false }
    const parts = new Set(s.split('+'))
    return { creator: parts.has('creator'), assignee: parts.has('assignee'), follower: parts.has('follower') }
  }

  function buildRow(s: string, v: TaskView, tag?: 'noa' | 'oa' | 'of'): TaskViewRow {
    const { creator, assignee, follower } = flagsFor(s)
    let othersAssigned: boolean
    if (!tag) {
      othersAssigned = (v === 'delegated' || v === 'any_role') && creator
    } else if (tag === 'oa') {
      othersAssigned = true
    } else {
      othersAssigned = false // 'noa' or 'of'
    }
    const assigneeIds = [...(assignee ? [ME] : []), ...(othersAssigned ? [OTHER] : [])]
    const followerIds = [...(follower ? [ME] : []), ...(tag === 'of' ? [OTHER2] : [])]
    return { createdBy: creator ? ME : OTHER, assigneeIds, followerIds }
  }

  const VIEWS: TaskView[] = ['assigned', 'following', 'created', 'delegated', 'any_role']

  // Pinned 8×5 base table (lock §6.1, "s \ v" table).
  const BASE_TABLE: Record<string, Record<TaskView, boolean>> = {
    none: { assigned: false, following: false, created: false, delegated: false, any_role: false },
    assignee: { assigned: true, following: false, created: false, delegated: false, any_role: true },
    follower: { assigned: false, following: true, created: false, delegated: false, any_role: true },
    creator: { assigned: false, following: false, created: true, delegated: true, any_role: true },
    'assignee+follower': { assigned: true, following: true, created: false, delegated: false, any_role: true },
    'assignee+creator': { assigned: true, following: false, created: true, delegated: true, any_role: true },
    'creator+follower': { assigned: false, following: true, created: true, delegated: true, any_role: true },
    'assignee+creator+follower': { assigned: true, following: true, created: true, delegated: true, any_role: true },
  }

  type Case = { name: string; s: string; v: TaskView; tag?: 'noa' | 'oa' | 'of'; expected: boolean }

  const baseCases: Case[] = []
  for (const s of Object.keys(BASE_TABLE)) {
    for (const v of VIEWS) {
      baseCases.push({ name: `gate19|${s}|${v}`, s, v, expected: BASE_TABLE[s][v] })
    }
  }

  // I_FLIP — 9-cell override table (lock §6.1 "ambient 钉法" overrides), pinned expectations.
  const flipCases: Case[] = [
    { name: 'gate19|creator|delegated|noa', s: 'creator', v: 'delegated', tag: 'noa', expected: false },
    { name: 'gate19|assignee+creator|delegated|noa', s: 'assignee+creator', v: 'delegated', tag: 'noa', expected: false },
    { name: 'gate19|creator+follower|delegated|noa', s: 'creator+follower', v: 'delegated', tag: 'noa', expected: false },
    {
      name: 'gate19|assignee+creator+follower|delegated|noa',
      s: 'assignee+creator+follower',
      v: 'delegated',
      tag: 'noa',
      expected: false,
    },
    { name: 'gate19|none|delegated|oa', s: 'none', v: 'delegated', tag: 'oa', expected: false },
    { name: 'gate19|creator|any_role|noa', s: 'creator', v: 'any_role', tag: 'noa', expected: true },
    { name: 'gate19|none|any_role|oa', s: 'none', v: 'any_role', tag: 'oa', expected: false },
    { name: 'gate19|none|assigned|oa', s: 'none', v: 'assigned', tag: 'oa', expected: false },
    { name: 'gate19|none|following|of', s: 'none', v: 'following', tag: 'of', expected: false },
  ]

  const allCases = [...baseCases, ...flipCases]

  // Verbatim transcription of the lock's `i-m2` fenced block (lock-ce180c88.md `:336-386`), one case
  // name per line, exactly as authored there. Comparing this against our case-name list (both sorted
  // the same way the lock's own extraction script sorts them — `LC_ALL=C sort`, which for pure-ASCII
  // strings is the same ordering as JS's default `Array.sort()`) catches a swapped/misspelled `s`
  // token (e.g. `creator+assignee` for `assignee+creator`) that a bare count+uniqueness check cannot.
  const LOCK_I_M2_NAMES = [
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
    'gate19|none|following|of',
  ]

  it('the grid has exactly 49 cells, matching the lock i-m2 block', () => {
    expect(allCases.length).toBe(49)
    expect(new Set(allCases.map((c) => c.name)).size).toBe(49) // no duplicate case names
    expect(LOCK_I_M2_NAMES.length).toBe(49)
  })

  it('the sorted case-name set is BYTE-IDENTICAL to the lock i-m2 block, sorted the same way (LC_ALL=C)', () => {
    const ours = allCases.map((c) => c.name).slice().sort()
    const locks = LOCK_I_M2_NAMES.slice().sort()
    expect(ours).toEqual(locks)
  })

  describe('taskMatchesView — 49-cell gate-19 grid', () => {
    for (const c of allCases) {
      it(c.name, () => {
        const row = buildRow(c.s, c.v, c.tag)
        expect(taskMatchesView(row, ME, c.v)).toBe(c.expected)
      })
    }
  })

  it('positive control: every row the grid says should match ALSO satisfies can(resolveTaskRoles(row),"view")===true', () => {
    for (const c of allCases) {
      if (!c.expected) continue
      const row = buildRow(c.s, c.v, c.tag)
      expect(can(resolveTaskRoles(row, ME), 'view')).toBe(true)
    }
  })

  // -------------------------------------------------------------------------------------------
  // P2 finding: a `view` outside the closed `TASK_VIEWS` set must THROW, not silently answer
  // `false`/emit `(FALSE)` — an unvalidated `?view=` forwarded straight through should surface as a
  // predicate error (lock §4.3 `degraded:true, reason:'predicate_error'`), not an empty 200 list
  // indistinguishable from "no tasks".
  // -------------------------------------------------------------------------------------------
  describe('unknown view throws rather than silently matching nothing', () => {
    it('taskMatchesView throws for a view outside TASK_VIEWS', () => {
      const row: TaskViewRow = { createdBy: OTHER, assigneeIds: [], followerIds: [] }
      expect(() => taskMatchesView(row, ME, 'bogus' as unknown as TaskView)).toThrow(TypeError)
    })

    it('buildTaskScopeCondition throws for a view outside TASK_VIEWS', () => {
      expect(() =>
        buildTaskScopeCondition({ view: 'bogus' as unknown as TaskView, actorParam: 'u1', orgParam: 'org1' }),
      ).toThrow(TypeError)
    })
  })

  // -------------------------------------------------------------------------------------------
  // buildTaskScopeCondition — five-arm SQL text snapshots + single org-clause emission.
  // -------------------------------------------------------------------------------------------
  describe('buildTaskScopeCondition — SQL text snapshots (lock §6.1)', () => {
    it('assigned arm', () => {
      const { sql, params } = buildTaskScopeCondition({ view: 'assigned', actorParam: 'u1', orgParam: 'org1' })
      expect(sql).toBe(
        '(tasks.org_id = $2) AND tasks.deleted_at IS NULL AND (EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = $1))',
      )
      expect(params).toEqual(['u1', 'org1'])
    })

    it('following arm', () => {
      const { sql } = buildTaskScopeCondition({ view: 'following', actorParam: 'u1', orgParam: 'org1' })
      expect(sql).toBe(
        '(tasks.org_id = $2) AND tasks.deleted_at IS NULL AND (EXISTS (SELECT 1 FROM task_followers tf WHERE tf.task_id = tasks.id AND tf.user_id = $1))',
      )
    })

    it('created arm', () => {
      const { sql } = buildTaskScopeCondition({ view: 'created', actorParam: 'u1', orgParam: 'org1' })
      expect(sql).toBe('(tasks.org_id = $2) AND tasks.deleted_at IS NULL AND (tasks.created_by = $1)')
    })

    it('delegated arm', () => {
      const { sql } = buildTaskScopeCondition({ view: 'delegated', actorParam: 'u1', orgParam: 'org1' })
      expect(sql).toBe(
        "(tasks.org_id = $2) AND tasks.deleted_at IS NULL AND (tasks.created_by = $1 AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id <> $1))",
      )
    })

    it('any_role arm — four-arm OR', () => {
      const { sql } = buildTaskScopeCondition({ view: 'any_role', actorParam: 'u1', orgParam: 'org1' })
      expect(sql).toBe(
        '(tasks.org_id = $2) AND tasks.deleted_at IS NULL AND ' +
          '((EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = $1)) OR ' +
          '(EXISTS (SELECT 1 FROM task_followers tf WHERE tf.task_id = tasks.id AND tf.user_id = $1)) OR ' +
          '(tasks.created_by = $1) OR ' +
          "(tasks.created_by = $1 AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id <> $1)))",
      )
    })

    it('the org clause appears exactly once for every view', () => {
      for (const view of TASK_VIEWS) {
        const { sql } = buildTaskScopeCondition({ view, actorParam: 'u1', orgParam: 'org1' })
        const occurrences = sql.split('tasks.org_id = $2').length - 1
        expect(occurrences).toBe(1)
      }
    })

    it('mutation probe: deleting the created_by=:me conjunct from the delegated arm reds the PINNED snapshot (per design §5 "删 SQL created_by=:me 合取 ⇒ 文本快照红")', () => {
      // Behavioural probe on the TS twin: a delegated predicate WITHOUT the createdByMe conjunct
      // (the SQL mutant's semantics) must disagree with the real predicate on the lock's
      // `none|delegated|oa` cell (someone else created it, someone else is assigned, I am uninvolved).
      const row = { createdBy: 'other', assigneeIds: ['other2'], followerIds: [] as string[] }
      const mutantDelegated = (r: typeof row, me: string) => r.assigneeIds.some((id) => id !== me)
      expect(mutantDelegated(row, 'me')).toBe(true)
      expect(taskMatchesView(row, 'me', 'delegated')).toBe(false)
      // And the real SQL text carries the conjunct the mutant drops.
      expect(buildTaskScopeCondition({ view: 'delegated', actorParam: 'u1', orgParam: 'org1' }).sql).toContain(
        'tasks.created_by = $1 AND EXISTS',
      )
    })
  })

  describe('buildTaskPendingCondition (lock `:414` — must derive from view:"assigned", must not emit any other role arm)', () => {
    it('contains the assigned arm', () => {
      const { sql } = buildTaskPendingCondition({ actorParam: 'u1', orgParam: 'org1', scope: 'all_open' })
      expect(sql).toContain('EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = $1)')
    })

    it('does not contain the following/created/delegated role arms', () => {
      const { sql } = buildTaskPendingCondition({ actorParam: 'u1', orgParam: 'org1', scope: 'all_open' })
      expect(sql).not.toContain('task_followers')
      expect(sql).not.toContain('tasks.created_by')
    })

    it('the org clause still appears exactly once', () => {
      const { sql } = buildTaskPendingCondition({ actorParam: 'u1', orgParam: 'org1', scope: 'all_open' })
      expect(sql.split('tasks.org_id = $2').length - 1).toBe(1)
    })

    it('includes status=open and the not-already-completed-by-me condition for every scope', () => {
      for (const scope of ['all_open', 'overdue', 'overdue_or_today'] as const) {
        const { sql } = buildTaskPendingCondition({ actorParam: 'u1', orgParam: 'org1', scope })
        expect(sql).toContain("tasks.status = 'open'")
        expect(sql).toContain('ta_done.completed_at IS NOT NULL')
      }
    })

    // P2 finding: `pending`'s own clause must be a PURE FILTER on the assigned-arm's rows (it can
    // only remove a row, never add one by itself) — not a second positive membership arm.
    describe('the own-row clause cannot itself admit a row (P2 finding — pure filter, not a second arm)', () => {
      it('pending.sql always STARTS WITH the derived assigned-arm scope condition, byte for byte', () => {
        const base = buildTaskScopeCondition({ view: 'assigned', actorParam: 'u1', orgParam: 'org1' })
        for (const scope of ['all_open', 'overdue', 'overdue_or_today'] as const) {
          const { sql } = buildTaskPendingCondition({ actorParam: 'u1', orgParam: 'org1', scope })
          expect(sql.startsWith(base.sql)).toBe(true)
        }
      })

      it('task_assignees appears in exactly ONE positive (non-NOT) EXISTS — the assigned arm', () => {
        for (const scope of ['all_open', 'overdue', 'overdue_or_today'] as const) {
          const { sql } = buildTaskPendingCondition({ actorParam: 'u1', orgParam: 'org1', scope })
          const positiveOccurrences = (sql.match(/(?<!NOT )EXISTS \(SELECT 1 FROM task_assignees/g) ?? []).length
          expect(positiveOccurrences).toBe(1)
          // and the own-row clause IS present, as a negative existential.
          expect(sql).toContain('NOT EXISTS (SELECT 1 FROM task_assignees ta_done')
        }
      })
    })

    describe('full-text snapshots per scope, transcribing lock §4.4\'s pinned formula (P1 finding fix)', () => {
      it('all_open — no date clause, 2 params ($1 actor / $2 org)', () => {
        const { sql, params } = buildTaskPendingCondition({ actorParam: 'u1', orgParam: 'org1', scope: 'all_open' })
        expect(sql).toBe(
          "(tasks.org_id = $2) AND tasks.deleted_at IS NULL AND (EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = $1)) AND tasks.status = 'open' AND NOT EXISTS (SELECT 1 FROM task_assignees ta_done WHERE ta_done.task_id = tasks.id AND ta_done.user_id = $1 AND ta_done.completed_at IS NOT NULL)",
        )
        expect(params).toEqual(['u1', 'org1'])
      })

      it('overdue — rule 1 (scheduled) OR rule 3 (all-day) per row, viewer tz via COALESCE($3, tasks.time_zone)', () => {
        const { sql, params } = buildTaskPendingCondition({ actorParam: 'u1', orgParam: 'org1', scope: 'overdue' })
        expect(sql).toBe(
          "(tasks.org_id = $2) AND tasks.deleted_at IS NULL AND (EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = $1)) AND tasks.status = 'open' AND NOT EXISTS (SELECT 1 FROM task_assignees ta_done WHERE ta_done.task_id = tasks.id AND ta_done.user_id = $1 AND ta_done.completed_at IS NOT NULL) AND ((tasks.due_time IS NOT NULL AND tasks.due_at < now()) OR (tasks.due_time IS NULL AND tasks.due_date < (now() AT TIME ZONE COALESCE($3, tasks.time_zone))::date))",
        )
        expect(params).toEqual(['u1', 'org1', null])
      })

      it('overdue_or_today — rule 2 (scheduled) OR rule 3 (all-day) per row', () => {
        const { sql, params } = buildTaskPendingCondition({
          actorParam: 'u1',
          orgParam: 'org1',
          scope: 'overdue_or_today',
        })
        expect(sql).toBe(
          "(tasks.org_id = $2) AND tasks.deleted_at IS NULL AND (EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = $1)) AND tasks.status = 'open' AND NOT EXISTS (SELECT 1 FROM task_assignees ta_done WHERE ta_done.task_id = tasks.id AND ta_done.user_id = $1 AND ta_done.completed_at IS NOT NULL) AND ((tasks.due_time IS NOT NULL AND tasks.due_at < (((now() AT TIME ZONE COALESCE($3, tasks.time_zone))::date + 1)::timestamp AT TIME ZONE COALESCE($3, tasks.time_zone))) OR (tasks.due_time IS NULL AND tasks.due_date <= (now() AT TIME ZONE COALESCE($3, tasks.time_zone))::date))",
        )
        expect(params).toEqual(['u1', 'org1', null])
      })

      it('a supplied viewerTzParam binds as $3 instead of null, for both date-scoped clauses', () => {
        const overdue = buildTaskPendingCondition({
          actorParam: 'u1',
          orgParam: 'org1',
          scope: 'overdue',
          viewerTzParam: 'Asia/Shanghai',
        })
        expect(overdue.params).toEqual(['u1', 'org1', 'Asia/Shanghai'])
        expect(overdue.sql).toContain('COALESCE($3, tasks.time_zone)')

        const overdueOrToday = buildTaskPendingCondition({
          actorParam: 'u1',
          orgParam: 'org1',
          scope: 'overdue_or_today',
          viewerTzParam: 'UTC',
        })
        expect(overdueOrToday.params).toEqual(['u1', 'org1', 'UTC'])
      })

      it('all_open ignores viewerTzParam — no $3 in its SQL or params, since it has no date comparison', () => {
        const { sql, params } = buildTaskPendingCondition({
          actorParam: 'u1',
          orgParam: 'org1',
          scope: 'all_open',
          viewerTzParam: 'Asia/Shanghai',
        })
        expect(sql).not.toContain('$3')
        expect(params).toEqual(['u1', 'org1'])
      })
    })

    it('rejects an unknown scope', () => {
      expect(() =>
        buildTaskPendingCondition({ actorParam: 'u1', orgParam: 'org1', scope: 'bogus' as never }),
      ).toThrow()
    })

    it('params for all_open match the derived assigned-arm scope condition exactly', () => {
      const pending = buildTaskPendingCondition({ actorParam: 'u1', orgParam: 'org1', scope: 'all_open' })
      const base = buildTaskScopeCondition({ view: 'assigned', actorParam: 'u1', orgParam: 'org1' })
      expect(pending.params).toEqual(base.params)
    })
  })
})

describe('task-access — bind-slot contract (review round 2)', () => {
  it('the scope fragment uses exactly $1/$2 and the pending fragment $1..$3, so an outer query can number its own params from $4', () => {
    const scope = buildTaskScopeCondition({ view: 'any_role', actorParam: 'u1', orgParam: 'org1' })
    expect(scope.params).toEqual(['u1', 'org1'])
    expect(new Set(scope.sql.match(/\$\d+/g))).toEqual(new Set(['$1', '$2']))
    const pending = buildTaskPendingCondition({ actorParam: 'u1', orgParam: 'org1', scope: 'overdue', viewerTzParam: 'UTC' })
    expect(pending.params).toEqual(['u1', 'org1', 'UTC'])
    expect(new Set(pending.sql.match(/\$\d+/g))).toEqual(new Set(['$1', '$2', '$3']))
    const outer = `SELECT id FROM tasks WHERE ${pending.sql} AND tasks.status = $4 LIMIT $5`
    const outerParams = [...pending.params, 'open', 50]
    const maxSlot = Math.max(...(outer.match(/\$(\d+)/g) ?? []).map((m) => Number(m.slice(1))))
    expect(maxSlot).toBe(outerParams.length)
  })
})
