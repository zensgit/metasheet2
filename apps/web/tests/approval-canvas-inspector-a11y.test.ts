/**
 * Wave-2 PR5 — ApprovalCanvasNodeInspector topology a11y (structural source scan).
 * Pins stable data-testid strings (G5-C load-bearing) + business-language aria-labels
 * that use graphNodeLabel (not raw node keys as the sole accessible name).
 * No mount / command algebra — pure SFC source contract.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSPECTOR_SRC = readFileSync(
  join(HERE, '../src/approvals/components/ApprovalCanvasNodeInspector.vue'),
  'utf8',
)

describe('ApprovalCanvasNodeInspector topology a11y (structural)', () => {
  it('keeps stable topology data-testid prefixes (G5-C load-bearing)', () => {
    expect(INSPECTOR_SRC).toMatch(/data-testid="approval-canvas-inspector"/)
    expect(INSPECTOR_SRC).toMatch(/data-testid="approval-canvas-inspector-topology"/)
    expect(INSPECTOR_SRC).toMatch(/data-testid="approval-canvas-inspector-close"/)

    // Primary topology action testids — node.key suffix retained for existing specs.
    expect(INSPECTOR_SRC).toMatch(/approval-canvas-move-up-\$\{node\.key\}/)
    expect(INSPECTOR_SRC).toMatch(/approval-canvas-move-down-\$\{node\.key\}/)
    expect(INSPECTOR_SRC).toMatch(/approval-canvas-move-\$\{node\.key\}/)
    expect(INSPECTOR_SRC).toMatch(/approval-canvas-add-condition-\$\{node\.key\}/)
    expect(INSPECTOR_SRC).toMatch(/approval-canvas-add-parallel-\$\{node\.key\}/)
    expect(INSPECTOR_SRC).toMatch(/approval-canvas-insert-\$\{node\.key\}/)
    expect(INSPECTOR_SRC).toMatch(/approval-canvas-insert-condition-\$\{node\.key\}/)
    expect(INSPECTOR_SRC).toMatch(/approval-canvas-insert-parallel-\$\{node\.key\}/)
    expect(INSPECTOR_SRC).toMatch(/approval-canvas-remove-\$\{node\.key\}/)
  })

  it('labels reorder / insert / remove actions with graphNodeLabel business copy', () => {
    // Reorder
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`上移\$\{graphNodeLabel\(node\.key\)\}节点`"/,
    )
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`下移\$\{graphNodeLabel\(node\.key\)\}节点`"/,
    )
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`移动\$\{graphNodeLabel\(node\.key\)\}节点`"/,
    )

    // Branch add
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`为\$\{graphNodeLabel\(node\.key\)\}添加条件分支`"/,
    )
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`为\$\{graphNodeLabel\(node\.key\)\}添加并行分支`"/,
    )

    // Insert after
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`在\$\{graphNodeLabel\(node\.key\)\}后插入审批节点`"/,
    )
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`在\$\{graphNodeLabel\(node\.key\)\}后插入条件节点`"/,
    )
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`在\$\{graphNodeLabel\(node\.key\)\}后插入并行节点`"/,
    )

    // Remove
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`删除\$\{graphNodeLabel\(node\.key\)\}节点`"/,
    )
  })

  it('does not use raw node.key as the sole accessible name on topology actions', () => {
    // Forbid aria-label that is only the internal key (or only interpolates node.key).
    expect(INSPECTOR_SRC).not.toMatch(/:aria-label="node\.key"/)
    expect(INSPECTOR_SRC).not.toMatch(/:aria-label="`\$\{node\.key\}`"/)
    // Every dynamic topology aria-label must go through graphNodeLabel.
    const dynamicAriaLabels = [
      ...INSPECTOR_SRC.matchAll(/:aria-label="`([^`]+)`"/g),
    ].map((m) => m[1])
    expect(dynamicAriaLabels.length).toBeGreaterThanOrEqual(9)
    for (const label of dynamicAriaLabels) {
      if (label.includes('node.key')) {
        expect(label).toContain('graphNodeLabel(node.key)')
      }
    }
  })

  it('exposes topology toolbar and close control with static business aria-labels', () => {
    expect(INSPECTOR_SRC).toMatch(/role="toolbar"/)
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`\$\{graphNodeLabel\(node\.key\)\}节点拓扑操作`"/,
    )
    expect(INSPECTOR_SRC).toMatch(/aria-label="关闭节点检查器"/)
  })

  it('does not change emit contract for topology actions', () => {
    expect(INSPECTOR_SRC).toMatch(/'move-up': \[nodeKey: string\]/)
    expect(INSPECTOR_SRC).toMatch(/'move-down': \[nodeKey: string\]/)
    expect(INSPECTOR_SRC).toMatch(/'begin-move': \[nodeKey: string\]/)
    expect(INSPECTOR_SRC).toMatch(/'add-condition-branch': \[nodeKey: string\]/)
    expect(INSPECTOR_SRC).toMatch(/'add-parallel-branch': \[nodeKey: string\]/)
    expect(INSPECTOR_SRC).toMatch(/'insert-approval': \[nodeKey: string\]/)
    expect(INSPECTOR_SRC).toMatch(/'insert-condition': \[nodeKey: string\]/)
    expect(INSPECTOR_SRC).toMatch(/'insert-parallel': \[nodeKey: string\]/)
    expect(INSPECTOR_SRC).toMatch(/remove: \[nodeKey: string\]/)
  })
})
