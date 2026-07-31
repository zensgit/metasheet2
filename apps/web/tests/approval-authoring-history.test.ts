import { describe, expect, it } from 'vitest'
import {
  createApprovalAuthoringHistory,
  isApprovalHistoryShortcutBlocked,
  recordApprovalAuthoringCommand,
  redoApprovalAuthoringCommand,
  undoApprovalAuthoringCommand,
  type ApprovalAuthoringCommand,
  type ApprovalAuthoringSnapshot,
} from '../src/approvals/approvalAuthoringHistory'
import { createEmptyTemplateDraft } from '../src/approvals/templateAuthoring'

function snapshot(marker: string): ApprovalAuthoringSnapshot {
  const draft = createEmptyTemplateDraft()
  draft.description = marker
  return {
    draft,
    selection: { kind: 'node', nodeKey: 'approval_1' },
    focus: { kind: 'inspector', nodeKey: 'approval_1', controlTestId: 'approval-node-mode' },
  }
}

describe('approval authoring unified history', () => {
  it('records every C5 command class in one per-draft stack without renderer coordinates', () => {
    const commands: ApprovalAuthoringCommand[] = [
      { type: 'insert-node', edgeKey: 'edge_1', nodeType: 'approval' },
      { type: 'insert-after', nodeKey: 'approval_1', nodeType: 'condition' },
      { type: 'add-branch', nodeKey: 'condition_1', branchType: 'condition' },
      { type: 'move-node', nodeKey: 'approval_1', edgeKey: 'edge_2' },
      { type: 'reorder-condition-branches', nodeKey: 'condition_1' },
      { type: 'reorder-parallel-branches', nodeKey: 'parallel_1' },
      { type: 'delete-node', nodeKey: 'approval_1' },
      { type: 'configure-node', nodeKey: 'approval_1', control: 'approval-node-mode' },
    ]
    let history = createApprovalAuthoringHistory('template_a')
    commands.forEach((command, index) => {
      history = recordApprovalAuthoringCommand(history, command, snapshot(`before-${index}`), snapshot(`after-${index}`))
    })

    expect(history.undoStack.map((entry) => entry.command.type)).toEqual(commands.map((command) => command.type))
    expect(history.redoStack).toEqual([])
    expect(JSON.stringify(history)).not.toMatch(/"(?:x|y|position|coordinates)":/)
  })

  it('restores draft plus selection/focus and clears redo after a divergent edit', () => {
    let history = createApprovalAuthoringHistory('template_a')
    const before = snapshot('before')
    const after = snapshot('after')
    history = recordApprovalAuthoringCommand(
      history,
      { type: 'configure-node', nodeKey: 'approval_1', control: 'approval-node-mode' },
      before,
      after,
    )
    const undone = undoApprovalAuthoringCommand(history)
    expect(undone.snapshot).toEqual(before)
    expect(undone.history.redoStack).toHaveLength(1)

    const diverged = recordApprovalAuthoringCommand(
      undone.history,
      { type: 'delete-node', nodeKey: 'approval_1' },
      before,
      snapshot('diverged'),
    )
    expect(diverged.redoStack).toEqual([])
    expect(redoApprovalAuthoringCommand(diverged).snapshot).toBeNull()
  })

  it('creates a clean history for a different loaded template', () => {
    let first = createApprovalAuthoringHistory('template_a')
    first = recordApprovalAuthoringCommand(
      first,
      { type: 'insert-node', edgeKey: 'edge_1', nodeType: 'approval' },
      snapshot('before'),
      snapshot('after'),
    )
    const second = createApprovalAuthoringHistory('template_b')

    expect(first.undoStack).toHaveLength(1)
    expect(second).toEqual({ draftKey: 'template_b', undoStack: [], redoStack: [] })
  })

  it('never hijacks editable controls', () => {
    for (const element of [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
    ]) {
      expect(isApprovalHistoryShortcutBlocked(element)).toBe(true)
    }
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const child = document.createElement('span')
    editable.append(child)
    expect(isApprovalHistoryShortcutBlocked(child)).toBe(true)
    expect(isApprovalHistoryShortcutBlocked(document.createElement('button'))).toBe(false)
  })
})
