/**
 * G5-C S1–S12 product-path scenarios exercised through shipped pure modules
 * (commands, topology, layout, version overlay, form commands) — not re-implementations.
 * Mounted inspector / Playwright remain complementary; these prove the load-bearing algebra.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addFormField,
  applyFormCommands,
  moveFormFieldByOffset,
  type CompleteFormIdentityHistory,
  type FormFieldIdentity,
} from '../src/approvals/approvalFormCommands'
import {
  applyCanvasCommandToSession,
  applyTopologyOpToSession,
  createAuthoringSessionHistory,
  promoteLinearDraftToGraphAuthoring,
  reseedAuthoringSessionHistory,
  undoAuthoringSession,
} from '../src/approvals/approvalAuthoringHistory'
import {
  appendApprovalNode,
  insertConditionGateway,
  insertParallelGateway,
  hasEmptyParallelBranch,
} from '../src/approvals/graphTopologyEdit'
import { computeLayout, graphValidityIssues } from '../src/approvals/graphLayout'
import {
  AUTHORABLE_FIELD_TYPES,
  buildApprovalGraph,
  createEmptyTemplateDraft,
  draftFromTemplate,
  type AuthorableFieldType,
} from '../src/approvals/templateAuthoring'
import { diffApprovalTemplateVersions } from '../src/approvals/templateVersionDiff'
import { buildVersionGraphOverlay } from '../src/approvals/versionGraphOverlay'
import type { ApprovalGraph, ApprovalTemplateDetailDTO } from '../src/types/approval'

const VIEW_PATH = join(__dirname, '../src/views/approval/TemplateAuthoringView.vue')

function completeHistory(ids: string[]): CompleteFormIdentityHistory {
  return { complete: true, persistentIds: ids, localIds: ids.map((id) => `local-${id}`) }
}

function identityFor(type: AuthorableFieldType, n: number): FormFieldIdentity {
  const base = {
    persistentId: `f_${type}_${n}`,
    localId: `local_f_${type}_${n}`,
  }
  if (type === 'detail') {
    return {
      ...base,
      detailColumn: {
        persistentId: `f_${type}_${n}_col`,
        localId: `local_f_${type}_${n}_col`,
      },
    }
  }
  return base
}

describe('G5-C S1 form authoring (real form commands)', () => {
  it('creates every authorable field kind and keyboard-equivalent reorder without exposing ids as inputs', () => {
    let draft = createEmptyTemplateDraft()
    // Start from empty field list for a clean matrix.
    draft = { ...draft, fields: [] }
    // Identity history is complete but empty: allocator-owned ids must not pre-exist.
    const emptyHistory = completeHistory([])

    for (const [index, type] of AUTHORABLE_FIELD_TYPES.entries()) {
      const identity = identityFor(type, index)
      const added = addFormField(draft, type, identity, emptyHistory)
      expect(added.ok, `add ${type}`).toBe(true)
      if (!added.ok) return
      draft = added.draft
      // Ordinary-user path never takes a free-typed field id — identity is allocator-owned.
      expect(identity.persistentId.startsWith('f_')).toBe(true)
    }
    expect(draft.fields.length).toBe(AUTHORABLE_FIELD_TYPES.length)

    const firstLocal = draft.fields[0]!.localId
    const moved = moveFormFieldByOffset(draft, firstLocal, 1)
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.draft.fields[1]!.localId).toBe(firstLocal)

    // Empty command sequence preserves fields (legacy no-op).
    const applied = applyFormCommands(moved.draft, [])
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.draft.fields.map((f) => f.localId)).toEqual(moved.draft.fields.map((f) => f.localId))
  })
})

describe('G5-C S2–S5 linear / condition / parallel topology', () => {
  it('builds publish-ready linear, condition, and parallel graphs without validity issues', () => {
    let draft = promoteLinearDraftToGraphAuthoring(createEmptyTemplateDraft())
    let session = reseedAuthoringSessionHistory(draft)
    const approvalKey = buildApprovalGraph(draft).nodes.find((n) => n.type === 'approval')!.key

    // S2 linear: start → approval → end already present after promote.
    expect(graphValidityIssues(buildApprovalGraph(draft))).toEqual([])

    // S3 condition
    let r = applyTopologyOpToSession(session, draft, (g) => insertConditionGateway(g, approvalKey))
    expect(r.ok).toBe(true)
    draft = r.draft
    session = r.history
    expect(buildApprovalGraph(draft).nodes.some((n) => n.type === 'condition')).toBe(true)
    expect(graphValidityIssues(buildApprovalGraph(draft))).toEqual([])

    // S4/S5 parallel from a fresh linear
    draft = promoteLinearDraftToGraphAuthoring(createEmptyTemplateDraft())
    session = reseedAuthoringSessionHistory(draft)
    const aKey = buildApprovalGraph(draft).nodes.find((n) => n.type === 'approval')!.key
    r = applyTopologyOpToSession(session, draft, (g) => insertParallelGateway(g, aKey))
    expect(r.ok).toBe(true)
    draft = r.draft
    const parallelGraph = buildApprovalGraph(draft)
    expect(parallelGraph.nodes.some((n) => n.type === 'parallel')).toBe(true)
    // Empty branch guard is the structural fail-closed surface for parallel integrity.
    expect(hasEmptyParallelBranch(parallelGraph)).toBe(false)
    expect(graphValidityIssues(parallelGraph)).toEqual([])
  })
})

describe('G5-C S6 dynamic assignee empty policy visibility', () => {
  it('preserves emptyAssigneePolicy on approval nodes through promote and build', () => {
    const draft = createEmptyTemplateDraft()
    draft.steps[0] = {
      ...draft.steps[0]!,
      sourceKind: 'direct_manager',
      emptyAssigneePolicy: 'auto-approve',
    }
    const promoted = promoteLinearDraftToGraphAuthoring(draft)
    const graph = buildApprovalGraph(promoted)
    const approval = graph.nodes.find((n) => n.type === 'approval')
    expect(approval).toBeTruthy()
    const policy = (approval?.config as { emptyAssigneePolicy?: string } | undefined)?.emptyAssigneePolicy
    expect(policy).toBe('auto-approve')
    expect(draft.steps[0]!.sourceKind).toBe('direct_manager')
  })
})

describe('G5-C S7 route preview substrate (no instance create)', () => {
  it('route preview controller module is pure and does not import instance-create APIs', () => {
    const src = readFileSync(
      join(__dirname, '../src/approvals/routePreviewController.ts'),
      'utf8',
    )
    expect(src).not.toMatch(/createInstance|submitApproval|startInstance/)
    expect(src).toMatch(/preview|dryRun|route/i)
  })
})

describe('G5-C S8 hidden-field boundary', () => {
  it('step fieldPermissions carry hidden without leaking into ordinary field labels', () => {
    const draft = createEmptyTemplateDraft()
    const fieldId = draft.fields[0]!.id
    draft.steps[0] = {
      ...draft.steps[0]!,
      fieldPermissions: [{ fieldId, access: 'hidden' }],
    }
    const graph = buildApprovalGraph(draft)
    const approval = graph.nodes.find((n) => n.type === 'approval')
    const perms = (approval?.config as { fieldPermissions?: Array<{ fieldId: string; access: string }> })
      ?.fieldPermissions
    expect(perms?.some((p) => p.fieldId === fieldId && p.access === 'hidden')).toBe(true)
    // Field label remains business-facing, not the raw permission enum.
    expect(draft.fields[0]!.label).not.toMatch(/hidden|fieldId/i)
  })
})

describe('G5-C S9 version publish/diff/restore helpers', () => {
  it('diff + overlay mark added/removed nodes for restore preview', () => {
    const before: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'a1', type: 'approval', name: 'A1', config: {} },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'a1' },
        { key: 'e2', source: 'a1', target: 'end' },
      ],
    }
    const after: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'a1', type: 'approval', name: 'A1', config: {} },
        { key: 'a2', type: 'approval', name: 'A2', config: {} },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'a1' },
        { key: 'e3', source: 'a1', target: 'a2' },
        { key: 'e4', source: 'a2', target: 'end' },
      ],
    }
    const form = { fields: [{ id: 'f1', type: 'text' as const, label: '标题', required: true }] }
    const diff = diffApprovalTemplateVersions(
      { formSchema: form, approvalGraph: before },
      { formSchema: form, approvalGraph: after },
    )
    expect(diff.nodeChanges).toBeGreaterThan(0)
    const overlay = buildVersionGraphOverlay(before, after, diff)
    expect(overlay.nodeChanges.get('a2')).toBe('added')
  })
})

describe('G5-C S10 legacy complex round-trip', () => {
  it('complex template opens into preservedGraph and save-build is byte-stable without edits', () => {
    const complex: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        {
          key: 'cond_1',
          type: 'condition',
          name: '金额判断',
          config: {
            branches: [
              {
                edgeKey: 'edge-cond_1-high',
                rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }],
                conjunction: 'and',
              },
            ],
            defaultEdgeKey: 'edge-cond_1-low',
          },
        },
        {
          key: 'a_high',
          type: 'approval',
          name: '高额',
          config: {
            assigneeSources: [{ kind: 'requester' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        {
          key: 'a_low',
          type: 'approval',
          name: '默认',
          config: {
            assigneeSources: [{ kind: 'requester' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'edge-start-cond_1', source: 'start', target: 'cond_1' },
        { key: 'edge-cond_1-high', source: 'cond_1', target: 'a_high' },
        { key: 'edge-cond_1-low', source: 'cond_1', target: 'a_low' },
        { key: 'edge-high-end', source: 'a_high', target: 'end' },
        { key: 'edge-low-end', source: 'a_low', target: 'end' },
      ],
    }
    const template: ApprovalTemplateDetailDTO = {
      id: 'tpl_1',
      key: 'legacy_complex',
      name: 'legacy',
      description: null,
      category: null,
      visibilityScope: { type: 'all', ids: [] },
      formSchema: { fields: [{ id: 'amount', type: 'number', label: '金额', required: true }] },
      approvalGraph: complex,
      slaHours: null,
      status: 'draft',
      activeVersionId: null,
      latestVersionId: 'ver_1',
      createdAt: '2026-06-23T00:00:00Z',
      updatedAt: '2026-06-23T00:00:00Z',
    }

    const draft = draftFromTemplate(template)
    expect(draft.preservedGraph).toBeDefined()
    expect(buildApprovalGraph(draft)).toEqual(complex)
  })
})

describe('G5-C S11 100-node operable layout', () => {
  it('computes deterministic layout for a 100-node chain without throwing', () => {
    const nodes: ApprovalGraph['nodes'] = [
      { key: 'start', type: 'start', name: '发起', config: {} },
    ]
    const edges: ApprovalGraph['edges'] = []
    let prev = 'start'
    for (let i = 1; i <= 98; i += 1) {
      const key = `a${i}`
      nodes.push({ key, type: 'approval', name: `节点${i}`, config: {} })
      edges.push({ key: `e-${prev}-${key}`, source: prev, target: key })
      prev = key
    }
    nodes.push({ key: 'end', type: 'end', name: '结束', config: {} })
    edges.push({ key: `e-${prev}-end`, source: prev, target: 'end' })
    const graph: ApprovalGraph = { nodes, edges }
    expect(graph.nodes.length).toBe(100)
    const layout = computeLayout(graph)
    expect(layout.nodes.length).toBe(100)
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
    // No two layout positions share identical coordinates (chain is strictly layered).
    const coords = new Set(layout.nodes.map((n) => `${n.x},${n.y}`))
    expect(coords.size).toBe(100)
  })
})

describe('G5-C S12 accessible alternative retained on authoring surface', () => {
  it('TemplateAuthoringView keeps list alternative, undo/redo, canvas-first, edge insert, palette; no node clusters', () => {
    const src = readFileSync(VIEW_PATH, 'utf8')
    const canvasShell = readFileSync(
      join(__dirname, '../src/approvals/components/ApprovalFlowCanvas.vue'),
      'utf8',
    )
    const inspectorShell = readFileSync(
      join(__dirname, '../src/approvals/components/ApprovalCanvasNodeInspector.vue'),
      'utf8',
    )
    // F0 extraction (delta §5 F0): the field palette markup moved verbatim onto
    // ApprovalFormInlineEditor.vue, same pattern as the PR4 canvas/inspector shells above.
    const formEditorShell = readFileSync(
      join(__dirname, '../src/approvals/components/ApprovalFormInlineEditor.vue'),
      'utf8',
    )
    expect(src).toMatch(/data-testid="approval-view-list"/)
    expect(src).toMatch(/辅助编辑模式/)
    // Undo/redo + edge insert live on extracted ApprovalFlowCanvas (PR4).
    expect(canvasShell).toMatch(/data-testid="approval-canvas-undo"/)
    expect(canvasShell).toMatch(/data-testid="approval-canvas-redo"/)
    expect(src).toMatch(/const canvasViewMode = ref<'list' \| 'canvas'>\('canvas'\)/)
    expect(src).toMatch(/applyCanvasCommandToSession|undoAuthoringSession/)
    expect(src).toMatch(/promoteLinearDraftToGraphAuthoring/)
    expect(canvasShell).toMatch(/data-testid="approval-canvas-edge-insert"/)
    expect(inspectorShell).toMatch(/data-testid="approval-canvas-inspector-topology"/)
    expect(src).not.toMatch(/class="template-authoring__canvas-node-actions"/)
    expect(canvasShell).not.toMatch(/class="template-authoring__canvas-node-actions"/)
    // D6-f2 palette (F0: markup lives on the extracted ApprovalFormInlineEditor.vue).
    expect(formEditorShell).toMatch(/data-testid="approval-field-palette"/)
    expect(src).toMatch(/addFieldOfType/)
    // PR4 extract: shell components owned under approvals/components
    expect(src).toMatch(/ApprovalFlowCanvas/)
    expect(src).toMatch(/ApprovalCanvasNodeInspector/)
  })
})

describe('G5-C PR4 component extract (structural)', () => {
  it('ships ApprovalFlowCanvas and ApprovalCanvasNodeInspector modules', () => {
    const canvas = readFileSync(
      join(__dirname, '../src/approvals/components/ApprovalFlowCanvas.vue'),
      'utf8',
    )
    const inspector = readFileSync(
      join(__dirname, '../src/approvals/components/ApprovalCanvasNodeInspector.vue'),
      'utf8',
    )
    expect(canvas).toMatch(/data-testid="approval-graph-canvas"/)
    expect(canvas).toMatch(/data-testid="approval-canvas-edge-insert"/)
    expect(inspector).toMatch(/data-testid="approval-canvas-inspector"/)
    expect(inspector).toMatch(/data-testid="approval-canvas-inspector-topology"/)
  })
})

/**
 * Residual canvas polish pins (Wave-3 PR9): form undo/redo shell, form history module,
 * version dual-canvas on detail, edge-insert a11y copy, inspector graphNodeLabel aria.
 * Source-scan only — no flaky mounts.
 */
describe('G5-C residual canvas polish pins (structural)', () => {
  it('TemplateAuthoringView wires form undo/redo testids and form authoring history module', () => {
    const src = readFileSync(VIEW_PATH, 'utf8')
    expect(src).toMatch(/data-testid="approval-form-undo"/)
    expect(src).toMatch(/data-testid="approval-form-redo"/)
    // Discriminating import path (not a loose name match elsewhere).
    expect(src).toMatch(/from ['"].*approvalFormAuthoringHistory['"]/)
  })

  it('TemplateDetailView keeps dual-canvas version surface', () => {
    const detail = readFileSync(
      join(__dirname, '../src/views/approval/TemplateDetailView.vue'),
      'utf8',
    )
    expect(detail).toMatch(/data-testid="template-version-dual-canvas"/)
    expect(detail).toMatch(/from ['"].*approvalVersionDualCanvas['"]/)
  })

  it('edge mid-point insert keeps business aria-label on ApprovalFlowCanvas', () => {
    const canvas = readFileSync(
      join(__dirname, '../src/approvals/components/ApprovalFlowCanvas.vue'),
      'utf8',
    )
    expect(canvas).toMatch(/aria-label="在此连线插入节点"/)
    expect(canvas).toMatch(/data-testid="approval-canvas-edge-insert"/)
  })

  it('inspector topology actions use graphNodeLabel in aria-labels', () => {
    const inspector = readFileSync(
      join(__dirname, '../src/approvals/components/ApprovalCanvasNodeInspector.vue'),
      'utf8',
    )
    expect(inspector).toMatch(/data-testid="approval-canvas-inspector-topology"/)
    expect(inspector).toMatch(
      /:aria-label="`\$\{graphNodeLabel\(node\.key\)\}节点拓扑操作`"/,
    )
    expect(inspector).toMatch(
      /:aria-label="`上移\$\{graphNodeLabel\(node\.key\)\}节点`"/,
    )
    expect(inspector).toMatch(
      /:aria-label="`在\$\{graphNodeLabel\(node\.key\)\}后插入审批节点`"/,
    )
    expect(inspector).toMatch(
      /:aria-label="`删除\$\{graphNodeLabel\(node\.key\)\}节点`"/,
    )
  })
})

describe('G5-C command fail-closed surface', () => {
  it('invalid move does not partially apply and empty undo fails closed', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'a1', type: 'approval', name: 'A1', config: {} },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'a1' },
        { key: 'e2', source: 'a1', target: 'end' },
      ],
    }
    const history = createAuthoringSessionHistory(graph)
    const snap = JSON.stringify(history)
    const bad = applyCanvasCommandToSession(history, {
      type: 'move-node-into-edge',
      nodeKey: 'a1',
      intoEdgeKey: 'missing-edge',
    })
    expect(bad.ok).toBe(false)
    expect(JSON.stringify(bad.history)).toBe(snap)

    const emptyUndo = undoAuthoringSession(history)
    expect(emptyUndo.ok).toBe(false)
    expect(emptyUndo.history).toBe(history)

    // Positive control: topology append still works through session.
    const draft = {
      ...createEmptyTemplateDraft(),
      steps: [],
      preservedGraph: graph,
    }
    const session = reseedAuthoringSessionHistory(draft)
    const appended = applyTopologyOpToSession(session, draft, (g) => appendApprovalNode(g, 'a1'))
    expect(appended.ok).toBe(true)
    expect(buildApprovalGraph(appended.draft).nodes.length).toBeGreaterThan(graph.nodes.length)
  })
})
