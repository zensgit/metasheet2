import { describe, expect, it } from 'vitest'
import type { TaskRole } from '../../src/tasks/task-access'
import {
  TASK_DEPENDENCY_MAX_EDGES_PER_TASK,
  applyAddDependency,
  applyRemoveDependency,
  canManageDependency,
  dependencyCandidates,
  validateAddDependency,
  wouldCreateDependencyCycle,
  type TaskDependencyEdge,
} from '../../src/tasks/task-dependencies'

const NOW = new Date('2026-10-07T08:00:00.000Z')
const e = (predecessorId: string, successorId: string): TaskDependencyEdge => ({ predecessorId, successorId })

/** A→B, A→C, B→D, C→D — D is reachable from A along two paths. */
const DIAMOND = [e('tsk_a', 'tsk_b'), e('tsk_a', 'tsk_c'), e('tsk_b', 'tsk_d'), e('tsk_c', 'tsk_d')]

/** `count` edges that all touch `hub` (hub → tsk_fN). */
function fanOut(hub: string, count: number): TaskDependencyEdge[] {
  return Array.from({ length: count }, (_, i) => e(hub, `tsk_f${i}`))
}

function add(predecessorId: string, successorId: string, edges: TaskDependencyEdge[], orgs: [string, string] = ['org1', 'org1']) {
  return validateAddDependency({
    predecessorId,
    successorId,
    predecessorOrgId: orgs[0],
    successorOrgId: orgs[1],
    edges,
  })
}

describe('task-dependencies', () => {
  it('TASK_DEPENDENCY_MAX_EDGES_PER_TASK is 50 (RULED(2026-10-09): [S28]; ASSUMPTION(task-e): [D18])', () => {
    expect(TASK_DEPENDENCY_MAX_EDGES_PER_TASK).toBe(50)
  })

  describe('wouldCreateDependencyCycle', () => {
    it('a self edge is a cycle', () => {
      expect(wouldCreateDependencyCycle([], 'tsk_a', 'tsk_a')).toBe(true)
    })
    it('the reverse of an existing edge is a cycle', () => {
      expect(wouldCreateDependencyCycle([e('tsk_a', 'tsk_b')], 'tsk_b', 'tsk_a')).toBe(true)
    })
    it('a long back edge is a cycle', () => {
      const chain = [e('tsk_1', 'tsk_2'), e('tsk_2', 'tsk_3'), e('tsk_3', 'tsk_4'), e('tsk_4', 'tsk_5')]
      expect(wouldCreateDependencyCycle(chain, 'tsk_5', 'tsk_1')).toBe(true)
      expect(wouldCreateDependencyCycle(chain, 'tsk_1', 'tsk_5')).toBe(false)
    })
    // Mutant guard: a walk that treats a revisit as corruption (task-tree's descendantsOf) throws here.
    it('walks a diamond without throwing: revisiting D is fine', () => {
      expect(wouldCreateDependencyCycle(DIAMOND, 'tsk_d', 'tsk_a')).toBe(true)
      expect(wouldCreateDependencyCycle(DIAMOND, 'tsk_a', 'tsk_d')).toBe(false)
      expect(wouldCreateDependencyCycle(DIAMOND, 'tsk_d', 'tsk_e')).toBe(false)
      expect(wouldCreateDependencyCycle([...DIAMOND, e('tsk_d', 'tsk_e')], 'tsk_e', 'tsk_a')).toBe(true)
    })
    it('terminates on an input that already contains a cycle', () => {
      const looped = [e('tsk_a', 'tsk_b'), e('tsk_b', 'tsk_a')]
      expect(wouldCreateDependencyCycle(looped, 'tsk_x', 'tsk_a')).toBe(false)
      expect(wouldCreateDependencyCycle(looped, 'tsk_b', 'tsk_a')).toBe(true)
    })
    it('rejects malformed input with TypeError', () => {
      expect(() => wouldCreateDependencyCycle('x' as unknown as TaskDependencyEdge[], 'tsk_a', 'tsk_b')).toThrow(TypeError)
      expect(() => wouldCreateDependencyCycle([], '_tsk_a', 'tsk_b')).toThrow(TypeError)
      expect(() => wouldCreateDependencyCycle([e('tsk_a', 'tsk__b')], 'tsk_a', 'tsk_c')).toThrow(TypeError)
      expect(() => wouldCreateDependencyCycle([null as unknown as TaskDependencyEdge], 'tsk_a', 'tsk_c')).toThrow(TypeError)
    })
  })

  describe('validateAddDependency', () => {
    it('accepts a plain new edge', () => {
      expect(add('tsk_a', 'tsk_b', [])).toEqual({ ok: true })
    })
    it('accepts an edge that completes a diamond (no cycle)', () => {
      expect(add('tsk_a', 'tsk_d', DIAMOND)).toEqual({ ok: true })
      expect(add('tsk_d', 'tsk_e', DIAMOND)).toEqual({ ok: true })
    })
    it('cross_org: the two ends live in different orgs', () => {
      expect(add('tsk_a', 'tsk_b', [], ['org1', 'org2'])).toEqual({ ok: false, reason: 'cross_org' })
    })
    it('cross_org: a blank org on either side never matches', () => {
      expect(add('tsk_a', 'tsk_b', [], ['', ''])).toEqual({ ok: false, reason: 'cross_org' })
      expect(add('tsk_a', 'tsk_b', [], ['org1', ''])).toEqual({ ok: false, reason: 'cross_org' })
    })
    it('self: a task cannot depend on itself', () => {
      expect(add('tsk_a', 'tsk_a', [])).toEqual({ ok: false, reason: 'self' })
    })
    it('duplicate: the same-direction edge already exists', () => {
      expect(add('tsk_a', 'tsk_b', [e('tsk_a', 'tsk_b')])).toEqual({ ok: false, reason: 'duplicate' })
    })
    it('the reverse edge is a cycle, not a duplicate', () => {
      expect(add('tsk_b', 'tsk_a', [e('tsk_a', 'tsk_b')])).toEqual({ ok: false, reason: 'cycle' })
    })
    it('cycle: a longer back edge', () => {
      expect(add('tsk_d', 'tsk_a', DIAMOND)).toEqual({ ok: false, reason: 'cycle' })
    })
    describe('limit (degree after insert, both ends)', () => {
      it('49 existing edges on the predecessor: the 50th is allowed', () => {
        expect(add('tsk_hub', 'tsk_new', fanOut('tsk_hub', 49))).toEqual({ ok: true })
      })
      it('50 existing edges on the predecessor: refused', () => {
        expect(add('tsk_hub', 'tsk_new', fanOut('tsk_hub', 50))).toEqual({ ok: false, reason: 'limit' })
      })
      it('50 existing edges on the SUCCESSOR only: refused', () => {
        expect(add('tsk_new', 'tsk_hub', fanOut('tsk_hub', 50))).toEqual({ ok: false, reason: 'limit' })
      })
      it('predecessors and successors count together', () => {
        const mixed = [...fanOut('tsk_hub', 25), ...Array.from({ length: 25 }, (_, i) => e(`tsk_p${i}`, 'tsk_hub'))]
        expect(add('tsk_hub', 'tsk_new', mixed)).toEqual({ ok: false, reason: 'limit' })
        expect(add('tsk_hub', 'tsk_new', mixed.slice(1))).toEqual({ ok: true })
      })
    })
    describe('check order (inputs that fail several checks at once)', () => {
      it('cross_org before self', () => {
        expect(add('tsk_a', 'tsk_a', [], ['org1', 'org2'])).toEqual({ ok: false, reason: 'cross_org' })
      })
      it('cross_org before cycle', () => {
        expect(add('tsk_b', 'tsk_a', [e('tsk_a', 'tsk_b')], ['org1', 'org2'])).toEqual({ ok: false, reason: 'cross_org' })
      })
      it('self before limit', () => {
        expect(add('tsk_hub', 'tsk_hub', fanOut('tsk_hub', 50))).toEqual({ ok: false, reason: 'self' })
      })
      it('duplicate before limit', () => {
        const edges = fanOut('tsk_hub', 50)
        expect(add('tsk_hub', 'tsk_f0', edges)).toEqual({ ok: false, reason: 'duplicate' })
      })
      it('limit before cycle', () => {
        const edges = [...fanOut('tsk_hub', 49), e('tsk_back', 'tsk_hub')]
        expect(add('tsk_hub', 'tsk_back', edges)).toEqual({ ok: false, reason: 'limit' })
        expect(add('tsk_hub', 'tsk_back', edges.slice(1))).toEqual({ ok: false, reason: 'cycle' })
      })
    })
    it('rejects malformed input with TypeError', () => {
      expect(() => validateAddDependency('x' as never)).toThrow(TypeError)
      expect(() => add('tsk_a', 'tsk_b_', [])).toThrow(TypeError)
      expect(() => add('tsk_a', 'tsk_b', 'x' as unknown as TaskDependencyEdge[])).toThrow(TypeError)
      expect(() =>
        validateAddDependency({ predecessorId: 'tsk_a', successorId: 'tsk_b', predecessorOrgId: 1 as unknown as string, successorOrgId: 'org1', edges: [] }),
      ).toThrow(TypeError)
    })
  })

  describe('applyAddDependency', () => {
    it('emits dependency_added on both ends, each naming the other end (successor first)', () => {
      const result = applyAddDependency({
        predecessorId: 'tsk_a',
        successorId: 'tsk_b',
        predecessorOrgId: 'org1',
        successorOrgId: 'org1',
        edges: [],
        actorId: 'u1',
        now: NOW,
      })
      expect(result).toEqual({
        ok: true,
        edge: { predecessorId: 'tsk_a', successorId: 'tsk_b' },
        events: [
          { taskId: 'tsk_b', type: 'dependency_added', userId: 'u1', occurredAt: NOW, payload: { predecessorId: 'tsk_a' } },
          { taskId: 'tsk_a', type: 'dependency_added', userId: 'u1', occurredAt: NOW, payload: { successorId: 'tsk_b' } },
        ],
      })
    })
    it('a refusal carries the reason and no events', () => {
      const result = applyAddDependency({
        predecessorId: 'tsk_b',
        successorId: 'tsk_a',
        predecessorOrgId: 'org1',
        successorOrgId: 'org1',
        edges: [e('tsk_a', 'tsk_b')],
        actorId: 'u1',
        now: NOW,
      })
      expect(result).toEqual({ ok: false, reason: 'cycle' })
    })
    it('requires an actor and a real Date', () => {
      const base = { predecessorId: 'tsk_a', successorId: 'tsk_b', predecessorOrgId: 'org1', successorOrgId: 'org1', edges: [] }
      expect(() => applyAddDependency({ ...base, actorId: '', now: NOW })).toThrow(TypeError)
      expect(() => applyAddDependency({ ...base, actorId: 'u1', now: new Date('nope') })).toThrow(TypeError)
    })
  })

  describe('applyRemoveDependency', () => {
    it('removing an absent edge is a no-op with no events', () => {
      expect(applyRemoveDependency({ predecessorId: 'tsk_a', successorId: 'tsk_b', edges: [], actorId: 'u1', now: NOW })).toEqual({
        noop: true,
        events: [],
      })
    })
    it('the reverse edge does not count as the edge being removed', () => {
      const result = applyRemoveDependency({ predecessorId: 'tsk_b', successorId: 'tsk_a', edges: [e('tsk_a', 'tsk_b')], actorId: 'u1', now: NOW })
      expect(result).toEqual({ noop: true, events: [] })
    })
    it('removing a present edge emits dependency_removed on both ends', () => {
      const result = applyRemoveDependency({ predecessorId: 'tsk_a', successorId: 'tsk_b', edges: [e('tsk_a', 'tsk_b')], actorId: 'u2', now: NOW })
      expect(result).toEqual({
        noop: false,
        events: [
          { taskId: 'tsk_b', type: 'dependency_removed', userId: 'u2', occurredAt: NOW, payload: { predecessorId: 'tsk_a' } },
          { taskId: 'tsk_a', type: 'dependency_removed', userId: 'u2', occurredAt: NOW, payload: { successorId: 'tsk_b' } },
        ],
      })
    })
  })

  describe('canManageDependency (RULED(2026-10-09): [S11] edit on both ends, same org)', () => {
    const roles: TaskRole[][] = [['creator'], ['assignee'], ['list-editor'], ['follower'], ['list-reader'], ['none']]
    it('needs edit on both ends', () => {
      for (const pred of roles) {
        for (const succ of roles) {
          const expected = ['creator', 'assignee', 'list-editor'].includes(pred[0]) && ['creator', 'assignee', 'list-editor'].includes(succ[0])
          expect(canManageDependency({ predecessorRoles: pred, successorRoles: succ, sameOrg: true }), `${pred}/${succ}`).toBe(expected)
        }
      }
    })
    it('a role union counts (follower + assignee can edit)', () => {
      expect(canManageDependency({ predecessorRoles: ['follower', 'assignee'], successorRoles: ['creator'], sameOrg: true })).toBe(true)
    })
    it('different orgs is always false', () => {
      expect(canManageDependency({ predecessorRoles: ['creator'], successorRoles: ['creator'], sameOrg: false })).toBe(false)
    })
    it('rejects malformed input with TypeError', () => {
      expect(() => canManageDependency({ predecessorRoles: 'x' as never, successorRoles: [], sameOrg: true })).toThrow(TypeError)
      expect(() => canManageDependency({ predecessorRoles: [], successorRoles: [], sameOrg: 'yes' as never })).toThrow(TypeError)
    })
  })

  describe('dependencyCandidates', () => {
    const edges = [e('tsk_up', 'tsk_me'), e('tsk_me', 'tsk_down'), e('tsk_down', 'tsk_far'), e('tsk_top', 'tsk_up')]
    const pool = ['tsk_me', 'tsk_up', 'tsk_down', 'tsk_far', 'tsk_top', 'tsk_free2', 'tsk_free1', 'tsk_free1']
    it('new predecessors: excludes itself, linked tasks, and everything downstream', () => {
      expect(dependencyCandidates({ taskId: 'tsk_me', direction: 'predecessor', candidateIds: pool, edges })).toEqual([
        'tsk_free1',
        'tsk_free2',
        'tsk_top',
      ])
    })
    it('new successors: excludes itself, linked tasks, and everything upstream', () => {
      expect(dependencyCandidates({ taskId: 'tsk_me', direction: 'successor', candidateIds: pool, edges })).toEqual([
        'tsk_far',
        'tsk_free1',
        'tsk_free2',
      ])
    })
    it('does not filter by the edge limit', () => {
      const busy = fanOut('tsk_busy', 50)
      expect(dependencyCandidates({ taskId: 'tsk_me', direction: 'successor', candidateIds: ['tsk_busy'], edges: busy })).toEqual(['tsk_busy'])
    })
    it('rejects malformed input with TypeError', () => {
      expect(() => dependencyCandidates({ taskId: 'tsk_me', direction: 'sideways' as never, candidateIds: [], edges: [] })).toThrow(TypeError)
      expect(() => dependencyCandidates({ taskId: 'tsk_me', direction: 'successor', candidateIds: 'x' as never, edges: [] })).toThrow(TypeError)
      expect(() => dependencyCandidates({ taskId: 'tsk_me', direction: 'successor', candidateIds: ['__'], edges: [] })).toThrow(TypeError)
    })
  })
})
