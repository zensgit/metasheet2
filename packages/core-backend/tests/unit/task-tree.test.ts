import { describe, expect, it } from 'vitest'
import * as taskTreeModule from '../../src/tasks/task-tree'
import {
  TASK_MAX_DEPTH,
  TaskTreeCorruptError,
  canReparent,
  depthOf,
  descendantsOf,
  parentCandidates,
  subtreeHeight,
  validateClearParent,
  validateSetParent,
  type TaskTreeNodes,
} from '../../src/tasks/task-tree'

function nodesOf(entries: Array<[string, { parentId: string | null; [k: string]: unknown }]>): TaskTreeNodes {
  return new Map(entries)
}

/** root(0) -> n1(1) -> n2(2) -> n3(3) -> n4(4) — the five-level (depth 0..4) reference chain. */
function chain(): TaskTreeNodes {
  return nodesOf([
    ['root', { parentId: null }],
    ['n1', { parentId: 'root' }],
    ['n2', { parentId: 'n1' }],
    ['n3', { parentId: 'n2' }],
    ['n4', { parentId: 'n3' }],
  ])
}

describe('task-tree', () => {
  describe('TASK_MAX_DEPTH', () => {
    it('is 4 (depth 0..4, five levels including root)', () => {
      expect(TASK_MAX_DEPTH).toBe(4)
    })
  })

  describe('depthOf — 0..4 boundary', () => {
    const nodes = chain()
    it('root is depth 0', () => {
      expect(depthOf('root', nodes)).toBe(0)
    })
    it('depth 1', () => {
      expect(depthOf('n1', nodes)).toBe(1)
    })
    it('depth 2', () => {
      expect(depthOf('n2', nodes)).toBe(2)
    })
    it('depth 3', () => {
      expect(depthOf('n3', nodes)).toBe(3)
    })
    it('depth 4 (== TASK_MAX_DEPTH, the deepest legal level)', () => {
      expect(depthOf('n4', nodes)).toBe(4)
    })
  })

  describe('depthOf — corruption', () => {
    it('throws TaskTreeCorruptError when id itself is missing', () => {
      const nodes = nodesOf([['root', { parentId: null }]])
      expect(() => depthOf('ghost', nodes)).toThrow(TaskTreeCorruptError)
    })
    it('throws TaskTreeCorruptError on a dangling parent along the chain', () => {
      const nodes = nodesOf([['a', { parentId: 'nonexistent' }]])
      expect(() => depthOf('a', nodes)).toThrow(TaskTreeCorruptError)
    })
    it('throws TaskTreeCorruptError on a self-loop', () => {
      const nodes = nodesOf([['a', { parentId: 'a' }]])
      expect(() => depthOf('a', nodes)).toThrow(TaskTreeCorruptError)
    })
    it('throws TaskTreeCorruptError on a two-node cycle', () => {
      const nodes = nodesOf([
        ['a', { parentId: 'b' }],
        ['b', { parentId: 'a' }],
      ])
      expect(() => depthOf('a', nodes)).toThrow(TaskTreeCorruptError)
    })
    it('the thrown error carries the stable code and name', () => {
      const nodes = nodesOf([['a', { parentId: 'a' }]])
      try {
        depthOf('a', nodes)
        expect.unreachable('depthOf should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(TaskTreeCorruptError)
        expect((err as TaskTreeCorruptError).code).toBe('TASK_TREE_CORRUPT')
        expect((err as TaskTreeCorruptError).name).toBe('TaskTreeCorruptError')
      }
    })
  })

  describe('descendantsOf', () => {
    it('returns all descendants, not including self', () => {
      const nodes = chain()
      expect(descendantsOf('n1', nodes)).toEqual(['n2', 'n3', 'n4'])
    })
    it('a leaf has no descendants', () => {
      const nodes = chain()
      expect(descendantsOf('n4', nodes)).toEqual([])
    })
    it('throws TaskTreeCorruptError when id itself is not in nodes (dangling reference)', () => {
      const nodes = chain()
      expect(() => descendantsOf('ghost', nodes)).toThrow(TaskTreeCorruptError)
    })
    it('throws TaskTreeCorruptError on a cycle reachable from id', () => {
      const nodes = nodesOf([
        ['a', { parentId: 'b' }],
        ['b', { parentId: 'a' }],
      ])
      expect(() => descendantsOf('a', nodes)).toThrow(TaskTreeCorruptError)
    })
  })

  describe('subtreeHeight', () => {
    it('a leaf is height 0', () => {
      const nodes = chain()
      expect(subtreeHeight('n4', nodes)).toBe(0)
    })
    it('height is the max edge-distance down to the deepest descendant', () => {
      const nodes = chain()
      expect(subtreeHeight('n1', nodes)).toBe(3) // n1 -> n2 -> n3 -> n4
      expect(subtreeHeight('root', nodes)).toBe(4)
    })
    it('a branching tree takes the DEEPEST branch, not the first one found', () => {
      const nodes = nodesOf([
        ['root', { parentId: null }],
        ['shallow', { parentId: 'root' }],
        ['deepA', { parentId: 'root' }],
        ['deepB', { parentId: 'deepA' }],
        ['deepC', { parentId: 'deepB' }],
      ])
      expect(subtreeHeight('root', nodes)).toBe(3) // root -> deepA -> deepB -> deepC
    })
    // Mutant-guard (advisor fix #3): a LEAF whose own ancestor chain is corrupt must still throw —
    // `subtreeHeight` calls `depthOf(id, nodes)` UNCONDITIONALLY before ever looking at descendants,
    // so this doesn't slip through as "0 descendants, therefore height 0".
    it('throws TaskTreeCorruptError for a leaf with a dangling parent (not silently 0)', () => {
      const nodes = nodesOf([['leaf', { parentId: 'nonexistent' }]])
      expect(() => subtreeHeight('leaf', nodes)).toThrow(TaskTreeCorruptError)
    })
    it('throws TaskTreeCorruptError when id itself is missing', () => {
      const nodes = chain()
      expect(() => subtreeHeight('ghost', nodes)).toThrow(TaskTreeCorruptError)
    })
  })

  describe('validateSetParent — check order & outcomes', () => {
    it('not_found: taskId missing', () => {
      const nodes = chain()
      expect(validateSetParent({ taskId: 'ghost', newParentId: 'n1', nodes })).toEqual({
        ok: false,
        reason: 'not_found',
      })
    })
    it('not_found: newParentId missing', () => {
      const nodes = chain()
      expect(validateSetParent({ taskId: 'n1', newParentId: 'ghost', nodes })).toEqual({
        ok: false,
        reason: 'not_found',
      })
    })
    it('order: taskId === newParentId but the id is absent from nodes -> not_found, NOT self', () => {
      const nodes = nodesOf([['root', { parentId: null }]])
      expect(validateSetParent({ taskId: 'ghost', newParentId: 'ghost', nodes })).toEqual({
        ok: false,
        reason: 'not_found',
      })
    })
    it('self: newParentId === taskId (both present)', () => {
      const nodes = chain()
      expect(validateSetParent({ taskId: 'n2', newParentId: 'n2', nodes })).toEqual({ ok: false, reason: 'self' })
    })
    it('descendant: newParentId is a descendant of taskId', () => {
      const nodes = chain()
      expect(validateSetParent({ taskId: 'n1', newParentId: 'n3', nodes })).toEqual({
        ok: false,
        reason: 'descendant',
      })
    })
    it('order: descendant AND depth_exceeded both hold -> descendant wins (checked before depth)', () => {
      // root(0) -> a(1) -> b(2) -> c(3) -> d(4). Moving `a` under its own descendant `d`: `d` IS a
      // descendant of `a` (so 'descendant' must fire), AND depthOf(d)+1+subtreeHeight(a) = 4+1+3=8
      // > 4 (so 'depth_exceeded' WOULD also fire if the descendant check were skipped/reordered).
      const nodes = nodesOf([
        ['root', { parentId: null }],
        ['a', { parentId: 'root' }],
        ['b', { parentId: 'a' }],
        ['c', { parentId: 'b' }],
        ['d', { parentId: 'c' }],
      ])
      expect(validateSetParent({ taskId: 'a', newParentId: 'd', nodes })).toEqual({
        ok: false,
        reason: 'descendant',
      })
    })
    it('depth_exceeded: exactly at the boundary (resulting depth 4) is ALLOWED, not rejected', () => {
      // `leaf` currently under n1 (depth 2, height 0). Moving it under n3 (depth 3) makes its new
      // depth exactly 4 == TASK_MAX_DEPTH — must be accepted. Mutant guard for `>` vs `>=`.
      const nodes = nodesOf([
        ['root', { parentId: null }],
        ['n1', { parentId: 'root' }],
        ['n2', { parentId: 'n1' }],
        ['n3', { parentId: 'n2' }],
        ['leaf', { parentId: 'n1' }],
      ])
      const result = validateSetParent({ taskId: 'leaf', newParentId: 'n3', nodes })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.noop).toBe(false)
        expect(result.depthChanges).toEqual([{ id: 'leaf', depth: 4 }])
      }
    })
    it('depth_exceeded: one past the boundary (resulting depth 5) is REJECTED', () => {
      const nodes = nodesOf([
        ['root', { parentId: null }],
        ['n1', { parentId: 'root' }],
        ['n2', { parentId: 'n1' }],
        ['n3', { parentId: 'n2' }],
        ['n4', { parentId: 'n3' }],
        ['leaf', { parentId: 'n1' }],
      ])
      expect(validateSetParent({ taskId: 'leaf', newParentId: 'n4', nodes })).toEqual({
        ok: false,
        reason: 'depth_exceeded',
      })
    })
    it('depth_exceeded accounts for the MOVED subtree height, not just the moved node', () => {
      // `n1` has height 3 (n1->n2->n3->n4). Reparenting `n1` under itself's sibling at depth 1
      // would put its deepest descendant at depth 1+1+3=5 > 4.
      const nodes = nodesOf([
        ['root', { parentId: null }],
        ['n1', { parentId: 'root' }],
        ['n2', { parentId: 'n1' }],
        ['n3', { parentId: 'n2' }],
        ['n4', { parentId: 'n3' }],
        ['sibling', { parentId: 'root' }],
      ])
      expect(validateSetParent({ taskId: 'n1', newParentId: 'sibling', nodes })).toEqual({
        ok: false,
        reason: 'depth_exceeded',
      })
    })
    it('noop: already this parent', () => {
      const nodes = chain()
      expect(validateSetParent({ taskId: 'n2', newParentId: 'n1', nodes })).toEqual({
        ok: true,
        noop: true,
        depthChanges: [],
        events: [],
      })
    })
    it('applies: moves the subtree and computes depthChanges for the task AND every descendant', () => {
      const nodes = nodesOf([
        ['root', { parentId: null }],
        ['a', { parentId: 'root' }],
        ['b', { parentId: 'root' }],
        ['b1', { parentId: 'b' }],
        ['b2', { parentId: 'b1' }],
      ])
      // Move `b` (depth 1, subtree b1(2)/b2(3)) under `a` (depth 1) -> b becomes depth 2, delta=+1.
      const result = validateSetParent({ taskId: 'b', newParentId: 'a', nodes })
      expect(result).toEqual({
        ok: true,
        noop: false,
        depthChanges: [
          { id: 'b', depth: 2 },
          { id: 'b1', depth: 3 },
          { id: 'b2', depth: 4 },
        ],
        events: [{ type: 'parent_set' }],
      })
    })
    it('every depthChanges entry has exactly the keys {id, depth}', () => {
      const nodes = nodesOf([
        ['root', { parentId: null }],
        ['a', { parentId: 'root' }],
        ['b', { parentId: 'root' }],
        ['b1', { parentId: 'b' }],
      ])
      const result = validateSetParent({ taskId: 'b', newParentId: 'a', nodes })
      expect(result.ok).toBe(true)
      if (result.ok) {
        for (const entry of result.depthChanges) {
          expect(Object.keys(entry).sort()).toEqual(['depth', 'id'])
        }
      }
    })
    it('does not mutate the input nodes map, and does not touch completion-shaped extra fields', () => {
      const nodes = nodesOf([
        ['root', { parentId: null, status: 'open', completedAt: null }],
        ['a', { parentId: 'root', status: 'done', completedAt: new Date('2026-09-01T00:00:00.000Z') }],
        ['b', { parentId: 'root', status: 'open', completedAt: null }],
      ])
      const before = [...nodes.entries()].map(([id, node]) => [id, { ...node }])
      validateSetParent({ taskId: 'b', newParentId: 'a', nodes })
      const after = [...nodes.entries()].map(([id, node]) => [id, { ...node }])
      expect(after).toEqual(before)
    })
    it('exports no function that mutates completion state (§6.3 "父完成不级联子")', () => {
      const names = Object.keys(taskTreeModule)
      expect(names.some((n) => /complet/i.test(n))).toBe(false)
    })
  })

  describe('validateClearParent', () => {
    it('not_found: taskId missing', () => {
      const nodes = chain()
      expect(validateClearParent({ taskId: 'ghost', nodes })).toEqual({ ok: false, reason: 'not_found' })
    })
    it('noop: already a root', () => {
      const nodes = chain()
      expect(validateClearParent({ taskId: 'root', nodes })).toEqual({
        ok: true,
        noop: true,
        depthChanges: [],
        events: [],
      })
    })
    it('applies: the whole subtree shifts up by the same delta', () => {
      const nodes = chain()
      const result = validateClearParent({ taskId: 'n1', nodes })
      expect(result).toEqual({
        ok: true,
        noop: false,
        depthChanges: [
          { id: 'n1', depth: 0 },
          { id: 'n2', depth: 1 },
          { id: 'n3', depth: 2 },
          { id: 'n4', depth: 3 },
        ],
        events: [{ type: 'parent_cleared' }],
      })
    })
    it('does not mutate the input nodes map', () => {
      const nodes = chain()
      const before = [...nodes.entries()].map(([id, node]) => [id, { ...node }])
      validateClearParent({ taskId: 'n2', nodes })
      const after = [...nodes.entries()].map(([id, node]) => [id, { ...node }])
      expect(after).toEqual(before)
    })
  })

  describe('canReparent', () => {
    it('true only when both ends have edit AND same org', () => {
      expect(canReparent({ childRoles: ['assignee'], parentRoles: ['creator'], sameOrg: true })).toBe(true)
      expect(canReparent({ childRoles: ['follower'], parentRoles: ['creator'], sameOrg: true })).toBe(false)
      expect(canReparent({ childRoles: ['assignee'], parentRoles: ['follower'], sameOrg: true })).toBe(false)
      expect(canReparent({ childRoles: ['assignee'], parentRoles: ['creator'], sameOrg: false })).toBe(false)
    })
  })

  describe('parentCandidates', () => {
    it('excludes self, all descendants (not just direct children), and over-depth nodes; sorted', () => {
      const nodes = nodesOf([
        ['root', { parentId: null }],
        ['n1', { parentId: 'root' }],
        ['n2', { parentId: 'n1' }],
        ['n3', { parentId: 'n2' }],
        ['n4', { parentId: 'n3' }],
        ['other', { parentId: 'root' }],
      ])
      // Candidates for 'n1' (subtree height 3: n1->n2->n3->n4): excludes n1 itself and n2/n3/n4
      // (all descendants). 'root' (depth 0) would push the deepest descendant to 0+1+3=4 (OK).
      // 'other' (depth 1) would push it to 1+1+3=5 (over depth, excluded).
      expect(parentCandidates({ taskId: 'n1', nodes })).toEqual(['root'])
    })
    it('a leaf (height 0) can attach anywhere up to depth 3 (own depth would land at 4); depth-4 n4 is excluded', () => {
      const nodes = nodesOf([
        ['root', { parentId: null }],
        ['n1', { parentId: 'root' }],
        ['n2', { parentId: 'n1' }],
        ['n3', { parentId: 'n2' }],
        ['n4', { parentId: 'n3' }],
        ['leaf', { parentId: 'root' }],
      ])
      // n3 (depth 3) -> leaf would land at depth 4 (OK, boundary). n4 (depth 4) -> leaf would land
      // at depth 5 (excluded).
      expect(parentCandidates({ taskId: 'leaf', nodes })).toEqual(['n1', 'n2', 'n3', 'root'])
    })
  })
})

describe('task-c review round 1: descendant depth changes and candidate exclusion', () => {
  // p0 - q1 - s2          m0 - n1
  const forest = () =>
    nodesOf([
      ['p', { parentId: null }],
      ['q', { parentId: 'p' }],
      ['s', { parentId: 'q' }],
      ['m', { parentId: null }],
      ['n', { parentId: 'm' }],
    ])
  it('moving a subtree DOWN by 2 sets every descendant to its own new depth', () => {
    const result = taskTreeModule.validateSetParent({ taskId: 'm', newParentId: 'q', nodes: forest() })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const byId = Object.fromEntries(result.depthChanges.map((c) => [c.id, c.depth]))
    expect(byId).toEqual({ m: 2, n: 3 })
  })
  it('moving a subtree UP by 2 (clear parent of a depth-2 node) shifts each descendant up by 2', () => {
    const nodes = nodesOf([
      ['p', { parentId: null }],
      ['q', { parentId: 'p' }],
      ['s', { parentId: 'q' }],
      ['t', { parentId: 's' }],
    ])
    const result = validateClearParent({ taskId: 's', nodes })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const byId = Object.fromEntries(result.depthChanges.map((c) => [c.id, c.depth]))
    expect(byId).toEqual({ s: 0, t: 1 })
  })
  it('parentCandidates excludes the task and every descendant, keeps unrelated nodes', () => {
    const got = parentCandidates({ taskId: 'q', nodes: forest() })
    expect(got).not.toContain('q')
    expect(got).not.toContain('s')
    expect(got).toEqual(['m', 'n', 'p'])
  })
  it('parentCandidates for an unknown task is an empty list', () => {
    expect(parentCandidates({ taskId: 'ghost', nodes: forest() })).toEqual([])
  })
})

describe('task-c review round 2: setParent moving a subtree UP', () => {
  it('re-parenting a depth-3 subtree under a root shifts every descendant up by 2', () => {
    const nodes = nodesOf([
      ['p', { parentId: null }],
      ['q', { parentId: 'p' }],
      ['s', { parentId: 'q' }],
      ['t', { parentId: 's' }],
      ['u', { parentId: 't' }],
      ['r', { parentId: null }],
    ])
    const result = taskTreeModule.validateSetParent({ taskId: 't', newParentId: 'r', nodes })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const byId = Object.fromEntries(result.depthChanges.map((c) => [c.id, c.depth]))
    expect(byId).toEqual({ t: 1, u: 2 })
  })
})
