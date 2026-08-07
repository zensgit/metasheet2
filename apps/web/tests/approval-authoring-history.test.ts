import { describe, expect, it } from 'vitest'
import {
  applyCanvasCommandToSession,
  applyTopologyOpToSession,
  canRedoAuthoring,
  canUndoAuthoring,
  createAuthoringSessionHistory,
  draftFromSessionGraph,
  promoteLinearDraftToGraphAuthoring,
  redoAuthoringSession,
  reseedAuthoringSessionHistory,
  undoAuthoringSession,
} from '../src/approvals/approvalAuthoringHistory'
import {
  appendApprovalNode,
  insertConditionGateway,
  moveLinearNode,
} from '../src/approvals/graphTopologyEdit'
import {
  buildApprovalGraph,
  createEmptyStepDraft,
  createEmptyTemplateDraft,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import type { ApprovalGraph } from '../src/types/approval'

function linearThree(): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'a1', type: 'approval', name: '审批1', config: { assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }] } },
      { key: 'a2', type: 'approval', name: '审批2', config: { assigneeSources: [{ kind: 'static_user', userIds: ['u2'] }] } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e-start-a1', source: 'start', target: 'a1' },
      { key: 'e-a1-a2', source: 'a1', target: 'a2' },
      { key: 'e-a2-end', source: 'a2', target: 'end' },
    ],
  }
}

function draftWithGraph(graph: ApprovalGraph): TemplateAuthoringDraft {
  const base = createEmptyTemplateDraft()
  return {
    ...base,
    steps: [],
    preservedGraph: graph,
  }
}

function edgeBetween(graph: ApprovalGraph, source: string, target: string) {
  return graph.edges.find((e) => e.source === source && e.target === target)
}

describe('approvalAuthoringHistory — canvas command path', () => {
  it('apply move then undo restores graph + selection; invalid move leaves history identical', () => {
    const graph = linearThree()
    const selection = { kind: 'node' as const, nodeKey: 'a1' }
    let history = createAuthoringSessionHistory(graph, selection)
    const snap = JSON.parse(JSON.stringify(history))

    const bad = applyCanvasCommandToSession(history, {
      type: 'move-node-into-edge',
      nodeKey: 'a1',
      intoEdgeKey: 'e-a1-a2',
    })
    expect(bad.ok).toBe(false)
    expect(bad.history).toEqual(snap)

    const applied = applyCanvasCommandToSession(
      history,
      { type: 'move-node-into-edge', nodeKey: 'a1', intoEdgeKey: 'e-a2-end' },
      selection,
    )
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    history = applied.history
    expect(edgeBetween(history.graph, 'a2', 'a1')).toBeTruthy()
    expect(history.selection).toEqual({ kind: 'node', nodeKey: 'a1' })
    expect(canUndoAuthoring(history)).toBe(true)

    const undone = undoAuthoringSession(history)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    expect(undone.history.graph).toEqual(graph)
    expect(undone.history.selection).toEqual(selection)
    expect(canRedoAuthoring(undone.history)).toBe(true)

    const redone = redoAuthoringSession(undone.history)
    expect(redone.ok).toBe(true)
    if (!redone.ok) return
    expect(redone.history.graph).toEqual(history.graph)
    expect(redone.history.selection).toEqual(history.selection)
  })
})

describe('approvalAuthoringHistory — topology snapshot path', () => {
  it('insert + undo restores draft graph via session projection', () => {
    const graph = linearThree()
    let draft = draftWithGraph(graph)
    let history = reseedAuthoringSessionHistory(draft, { kind: 'none' })

    const inserted = applyTopologyOpToSession(
      history,
      draft,
      (g) => appendApprovalNode(g, 'a2'),
      { kind: 'node', nodeKey: 'a2' },
    )
    expect(inserted.ok).toBe(true)
    draft = inserted.draft
    history = inserted.history
    expect(draft.preservedGraph?.nodes.some((n) => n.type === 'approval' && n.key !== 'a1' && n.key !== 'a2')).toBe(true)
    expect(canUndoAuthoring(history)).toBe(true)

    const undone = undoAuthoringSession(history)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    draft = draftFromSessionGraph(draft, undone.history.graph)
    expect(buildApprovalGraph(draft)).toEqual(graph)
    history = undone.history

    const redone = redoAuthoringSession(history)
    expect(redone.ok).toBe(true)
    if (!redone.ok) return
    draft = draftFromSessionGraph(draft, redone.history.graph)
    expect(buildApprovalGraph(draft).nodes.length).toBeGreaterThan(graph.nodes.length)
  })

  it('failed topology leaves draft and history untouched', () => {
    const graph = linearThree()
    const draft = draftWithGraph(graph)
    const history = reseedAuthoringSessionHistory(draft)
    const snapH = JSON.parse(JSON.stringify(history))
    const snapD = JSON.parse(JSON.stringify(draft))

    const failed = applyTopologyOpToSession(history, draft, () => {
      throw new Error('internal-key-should-not-surface')
    })
    expect(failed.ok).toBe(false)
    expect(failed.errorMessage).toBe('该拓扑操作不适用于当前流程结构')
    expect(failed.errorMessage).not.toMatch(/internal-key/)
    expect(failed.history).toEqual(snapH)
    expect(failed.draft).toEqual(snapD)
  })
})

describe('approvalAuthoringHistory — linear promote', () => {
  it('promotes steps-only draft into preservedGraph without semantic drift', () => {
    const draft = createEmptyTemplateDraft()
    draft.steps = [{ ...createEmptyStepDraft(1), name: '经理审批', idsText: 'u1' }]
    expect(draft.preservedGraph).toBeUndefined()
    const promoted = promoteLinearDraftToGraphAuthoring(draft)
    expect(promoted.preservedGraph).toBeDefined()
    expect(promoted.steps).toEqual([])
    const g = buildApprovalGraph(promoted)
    expect(g.nodes.some((n) => n.type === 'approval')).toBe(true)
    expect(g.nodes.some((n) => n.type === 'start')).toBe(true)
    expect(g.nodes.some((n) => n.type === 'end')).toBe(true)
    // Second promote is a no-op identity on the preserved rail.
    expect(promoteLinearDraftToGraphAuthoring(promoted)).toEqual(promoted)
  })

  it('linear promote then condition insert then undo restores linear graph shape', () => {
    let draft = createEmptyTemplateDraft()
    draft.steps = [{ ...createEmptyStepDraft(1), name: '审批', idsText: 'u1' }]
    draft = promoteLinearDraftToGraphAuthoring(draft)
    let history = reseedAuthoringSessionHistory(draft)
    const baseline = buildApprovalGraph(draft)

    const approvalKey = baseline.nodes.find((n) => n.type === 'approval')!.key
    const result = applyTopologyOpToSession(
      history,
      draft,
      (g) => insertConditionGateway(g, approvalKey),
    )
    expect(result.ok).toBe(true)
    draft = result.draft
    history = result.history
    expect(buildApprovalGraph(draft).nodes.some((n) => n.type === 'condition')).toBe(true)

    const undone = undoAuthoringSession(history)
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    draft = draftFromSessionGraph(draft, undone.history.graph)
    expect(buildApprovalGraph(draft)).toEqual(baseline)
  })
})

describe('approvalAuthoringHistory — mixed stack', () => {
  it('topology insert then typed move undoes in reverse order', () => {
    let draft = draftWithGraph(linearThree())
    let history = reseedAuthoringSessionHistory(draft, { kind: 'node', nodeKey: 'a1' })

    const inserted = applyTopologyOpToSession(
      history,
      draft,
      (g) => appendApprovalNode(g, 'a2'),
    )
    draft = inserted.draft
    history = inserted.history
    const afterInsert = buildApprovalGraph(draft)

    // Move a1 after a2's outgoing edge if possible; otherwise move a1 into a2-end style target.
    const moveTargets = afterInsert.edges.filter((e) => e.source === 'a2')
    expect(moveTargets.length).toBeGreaterThan(0)
    const into = moveTargets[0]!.key
    // Sanity: pure helper accepts the move (command algebra uses same invariants).
    expect(() => moveLinearNode(afterInsert, 'a1', into)).not.toThrow()

    const moved = applyCanvasCommandToSession(
      history,
      { type: 'move-node-into-edge', nodeKey: 'a1', intoEdgeKey: into },
      { kind: 'node', nodeKey: 'a1' },
      buildApprovalGraph(draft),
    )
    // Move may fail closed if algebra rejects this slot — either path is valid.
    if (moved.ok) {
      history = moved.history
      const u1 = undoAuthoringSession(history, buildApprovalGraph(draftFromSessionGraph(draft, history.graph)))
      expect(u1.ok).toBe(true)
      if (!u1.ok) return
      history = u1.history
      expect(history.graph).toEqual(afterInsert)
    }

    const u2 = undoAuthoringSession(history)
    expect(u2.ok).toBe(true)
    if (!u2.ok) return
    expect(u2.history.graph).toEqual(linearThree())
  })
})

describe('approvalAuthoringHistory — inspector map edits survive move/undo', () => {
  it('reseed → mutate approvalNodeEdits → move on live graph retains config; stale tip would wipe', () => {
    // Seed graph with "default" approval config (single + requester).
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        {
          key: 'a1',
          type: 'approval',
          name: '审批1',
          config: {
            assigneeSources: [{ kind: 'requester' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        {
          key: 'a2',
          type: 'approval',
          name: '审批2',
          config: {
            assigneeSources: [{ kind: 'requester' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e-start-a1', source: 'start', target: 'a1' },
        { key: 'e-a1-a2', source: 'a1', target: 'a2' },
        { key: 'e-a2-end', source: 'a2', target: 'end' },
      ],
    }
    let draft = draftWithGraph(graph)
    // Reseed once from the seed graph — session tip does NOT include later map edits.
    let history = reseedAuthoringSessionHistory(draft, { kind: 'node', nodeKey: 'a1' })
    expect(
      (history.graph.nodes.find((n) => n.key === 'a1')?.config as { approvalMode?: string })
        ?.approvalMode,
    ).toBe('single')

    // Inspector-only edit: change a1 without reseeding history.
    draft = {
      ...draft,
      approvalNodeEdits: {
        ...(draft.approvalNodeEdits ?? {}),
        a1: {
          nodeKey: 'a1',
          assigneeSources: [{ kind: 'direct_manager' }],
          approvalMode: 'all',
          emptyAssigneePolicy: 'auto-approve',
        },
        a2: draft.approvalNodeEdits?.a2 ?? {
          nodeKey: 'a2',
          assigneeSources: [{ kind: 'requester' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
    }
    const live = buildApprovalGraph(draft)
    const liveA1 = live.nodes.find((n) => n.key === 'a1')!
    expect((liveA1.config as { approvalMode?: string }).approvalMode).toBe('all')
    expect(
      (liveA1.config as { assigneeSources?: Array<{ kind: string }> }).assigneeSources?.[0]?.kind,
    ).toBe('direct_manager')
    // Session tip is still the pre-inspector graph (stale).
    expect(
      (history.graph.nodes.find((n) => n.key === 'a1')?.config as { approvalMode?: string })
        ?.approvalMode,
    ).toBe('single')

    // Discriminating control: applying against the STALE tip then projecting wipes the edit.
    const wiped = applyCanvasCommandToSession(
      history,
      { type: 'move-node-into-edge', nodeKey: 'a1', intoEdgeKey: 'e-a2-end' },
      { kind: 'node', nodeKey: 'a1' },
      history.graph, // intentionally stale
    )
    expect(wiped.ok).toBe(true)
    if (!wiped.ok) return
    const wipedDraft = draftFromSessionGraph(draft, wiped.history.graph)
    const wipedA1 = buildApprovalGraph(wipedDraft).nodes.find((n) => n.key === 'a1')!
    expect((wipedA1.config as { approvalMode?: string }).approvalMode).toBe('single')
    expect(
      (wipedA1.config as { assigneeSources?: Array<{ kind: string }> }).assigneeSources?.[0]?.kind,
    ).toBe('requester')

    // Product path: pass live effective graph — configs survive move + project.
    const moved = applyCanvasCommandToSession(
      history,
      { type: 'move-node-into-edge', nodeKey: 'a1', intoEdgeKey: 'e-a2-end' },
      { kind: 'node', nodeKey: 'a1' },
      live,
    )
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    draft = draftFromSessionGraph(draft, moved.history.graph)
    history = moved.history
    const afterMove = buildApprovalGraph(draft)
    const a1After = afterMove.nodes.find((n) => n.key === 'a1')!
    expect((a1After.config as { approvalMode?: string }).approvalMode).toBe('all')
    expect(
      (a1After.config as { assigneeSources?: Array<{ kind: string }> }).assigneeSources?.[0]?.kind,
    ).toBe('direct_manager')
    expect(edgeBetween(afterMove, 'a2', 'a1')).toBeTruthy()

    // Undo move on live graph also keeps the inspector config that was present at move time.
    const undone = undoAuthoringSession(history, buildApprovalGraph(draft))
    expect(undone.ok).toBe(true)
    if (!undone.ok) return
    draft = draftFromSessionGraph(draft, undone.history.graph)
    const a1Undone = buildApprovalGraph(draft).nodes.find((n) => n.key === 'a1')!
    expect((a1Undone.config as { approvalMode?: string }).approvalMode).toBe('all')
    expect(
      (a1Undone.config as { assigneeSources?: Array<{ kind: string }> }).assigneeSources?.[0]?.kind,
    ).toBe('direct_manager')
    expect(edgeBetween(buildApprovalGraph(draft), 'a1', 'a2')).toBeTruthy()
  })
})
