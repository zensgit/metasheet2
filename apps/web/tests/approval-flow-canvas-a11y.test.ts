/**
 * Wave-2 PR4 — ApprovalFlowCanvas edge-insert / node-card a11y lock.
 * Pure structural source-scan (G5-C style): no jsdom mount of the full canvas tree.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CANVAS_SRC = readFileSync(
  join(__dirname, '../src/approvals/components/ApprovalFlowCanvas.vue'),
  'utf8',
)

describe('ApprovalFlowCanvas a11y (structural)', () => {
  it('edge mid-point insert control has business aria-label (no raw edge keys)', () => {
    expect(CANVAS_SRC).toMatch(/aria-label="在此连线插入节点"/)
    // Stable shell testid for the edge-insert control family
    expect(CANVAS_SRC).toMatch(/data-testid="approval-canvas-edge-insert"/)
    // Per-edge testid remains for e2e targeting, but must not be the accessible name
    expect(CANVAS_SRC).toMatch(/:data-testid="`approval-canvas-edge-insert-\$\{line\.key\}`"/)
  })

  it('edge insert + is a native focusable button (not a bare div)', () => {
    // Button with business label lives under the edge-insert shell
    expect(CANVAS_SRC).toMatch(
      /class="template-authoring__canvas-edge-insert-btn"[\s\S]*?type="button"|type="button"[\s\S]*?class="template-authoring__canvas-edge-insert-btn"/,
    )
    expect(CANVAS_SRC).toMatch(
      /class="template-authoring__canvas-edge-insert-btn"[\s\S]{0,200}aria-label="在此连线插入节点"/,
    )
  })

  it('does not bind edge-key-only strings as aria-label on edge insert', () => {
    // Forbidden: accessible name is only the raw edge key
    expect(CANVAS_SRC).not.toMatch(/:aria-label="line\.key"/)
    expect(CANVAS_SRC).not.toMatch(/aria-label="\$\{line\.key\}"/)
    expect(CANVAS_SRC).not.toMatch(
      /canvas-edge-insert-btn[\s\S]{0,300}:aria-label="[^"]*\$\{line\.key\}/,
    )
  })

  it('node selector exposes display-name accessible name and keyboard activation', () => {
    expect(CANVAS_SRC).toMatch(/role="button"/)
    expect(CANVAS_SRC).toMatch(/tabindex="0"/)
    // Accessible name derived from graphNodeLabel (display name), not raw node key alone
    expect(CANVAS_SRC).toMatch(/:aria-label="`编辑\$\{graphNodeLabel\(pos\.key\)\}节点`"/)
    expect(CANVAS_SRC).toMatch(/@keydown\.enter/)
    expect(CANVAS_SRC).toMatch(/@keydown\.space/)
    expect(CANVAS_SRC).toMatch(/:aria-pressed="selectedCanvasNode === pos\.key"/)
  })

  it('edge-insert menu items use business-language aria-labels (no edge keys)', () => {
    expect(CANVAS_SRC).toMatch(/aria-label="插入审批节点"/)
    expect(CANVAS_SRC).toMatch(/aria-label="插入条件分支"/)
    expect(CANVAS_SRC).toMatch(/aria-label="插入并行分支"/)
    // Menu item labels must not interpolate edge keys into accessible names
    expect(CANVAS_SRC).not.toMatch(
      /edge-insert-(approval|condition|parallel)[\s\S]{0,200}:aria-label="[^"]*\$\{line\.key\}/,
    )
    expect(CANVAS_SRC).not.toMatch(
      /aria-label="[^"]*\$\{line\.key\}[^"]*"[\s\S]{0,120}edge-insert-(approval|condition|parallel)/,
    )
  })

  it('fit-to-view toolbar control has business aria-label', () => {
    expect(CANVAS_SRC).toMatch(/data-testid="approval-canvas-fit"/)
    expect(CANVAS_SRC).toMatch(
      /data-testid="approval-canvas-fit"[\s\S]{0,120}aria-label="适应画布"|aria-label="适应画布"[\s\S]{0,120}data-testid="approval-canvas-fit"/,
    )
  })
})
