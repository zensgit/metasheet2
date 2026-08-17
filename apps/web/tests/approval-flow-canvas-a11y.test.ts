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
    expect(CANVAS_SRC).toMatch(/aria-label="插入抄送节点"/)
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

  it('flow cards expose type chrome, summary, and a circular edge + (no 办理人)', () => {
    expect(CANVAS_SRC).toMatch(/template-authoring__canvas-node-kind/)
    expect(CANVAS_SRC).toMatch(/canvasNodeSummary\(pos\.key\)/)
    expect(CANVAS_SRC).toMatch(/template-authoring__canvas-edge-insert-btn/)
    expect(CANVAS_SRC).toMatch(/border-radius: 50%/)
    expect(CANVAS_SRC).toMatch(/插入抄送节点/)
    expect(CANVAS_SRC).not.toMatch(/办理人/)
    // Insert chrome is painted after node cards so the open menu receives the click.
    const nodeIdx = CANVAS_SRC.indexOf('data-testid="approval-canvas-node"')
    const insertIdx = CANVAS_SRC.lastIndexOf('data-testid="approval-canvas-edge-insert"')
    expect(nodeIdx).toBeGreaterThan(0)
    expect(insertIdx).toBeGreaterThan(nodeIdx)
    expect(CANVAS_SRC).toMatch(/\.is-open \{\s*z-index: 20;/)
  })

  it('fit-to-view toolbar control has business aria-label', () => {
    expect(CANVAS_SRC).toMatch(/data-testid="approval-canvas-fit"/)
    expect(CANVAS_SRC).toMatch(
      /data-testid="approval-canvas-fit"[\s\S]{0,120}aria-label="适应画布"|aria-label="适应画布"[\s\S]{0,120}data-testid="approval-canvas-fit"/,
    )
  })
})

// P1-D (docs/development/approval-parity-master-design-lock-20260817.md §4 P1-D; D0 §3.2 flat-card
// grammar): the shipped renderer used per-type colored ribbons — a full-width `background:` fill on
// the `.template-authoring__canvas-node-kind` type-label bar, varying by `data-node-type`. This
// migrates to the RATIFIED flat-card grammar: flat background, 1px border, 8px radius, and a
// supplementary per-type accent expressed ONLY as a left-border token on the card — never a
// colored-title-band fill. Text (`nodeTypeLabel`) remains the sole REQUIRED type carrier (V-6/V-8);
// these pins guard the PROHIBITED presentation, not the text label (already covered above).
describe('ApprovalFlowCanvas flat-card grammar (P1-D, structural)', () => {
  it('the type-label bar carries no per-type background ribbon (no `[data-node-type=...] { background:` fill anywhere)', () => {
    // Mutation probe: re-adding e.g. `.template-authoring__canvas-node-kind[data-node-type='approval'] {
    // background: var(--el-color-primary-light-8); }` must turn this red — token-based colors pass
    // UF-6 (no hex/rgb literal), so this explicit source pin is the actual guard, not UF-6.
    expect(CANVAS_SRC).not.toMatch(/canvas-node-kind\[data-node-type=[^\]]+\][\s\S]{0,120}background:/)
  })

  it('the type-label bar itself has exactly one flat background across every node type (no per-type override block)', () => {
    const kindRuleMatches = CANVAS_SRC.match(/\.template-authoring__canvas-node-kind\s*\{[\s\S]*?\}/g) ?? []
    expect(kindRuleMatches.length).toBe(1) // the single base rule only — no `[data-node-type=...]` variants
    expect(kindRuleMatches[0]).toMatch(/background:\s*var\(--el-fill-color-light\)/)
  })

  it('per-type accent is a left-border token on the CARD, one rule per node type, token-only', () => {
    for (const type of ['approval', 'cc', 'condition', 'parallel']) {
      const re = new RegExp(
        `\\.template-authoring__canvas-node\\[data-node-type='${type}'\\]\\s*\\{[\\s\\S]{0,120}border-left-color:\\s*var\\(--el-color-`,
      )
      expect(CANVAS_SRC).toMatch(re)
    }
    // start/end intentionally share one selector block (mirrors the pre-migration shared ribbon).
    expect(CANVAS_SRC).toMatch(
      /\.template-authoring__canvas-node\[data-node-type='start'\],\s*\n\s*\.template-authoring__canvas-node\[data-node-type='end'\]\s*\{[\s\S]{0,120}border-left-color:\s*var\(--el-color-/,
    )
  })

  it('selection accent stays on the card border/ring, applied uniformly (no per-type selected-state fill)', () => {
    // The old ribbon-era rule ONLY recolored the `approval` type's kind bar on selection — that
    // per-type special case must be gone; `.is-selected` styling must not reference `[data-node-type=`.
    const selectedBlockMatch = CANVAS_SRC.match(/\.template-authoring__canvas-node\.is-selected[\s\S]*?\n\}/)
    expect(selectedBlockMatch).not.toBeNull()
    expect(CANVAS_SRC).not.toMatch(/is-selected[\s\S]{0,40}canvas-node-kind\[data-node-type=/)
  })

  it('card corner radius matches D0 §3.2 (8px) and the base card carries no shadow-stack literal', () => {
    const cardRuleMatch = CANVAS_SRC.match(/\.template-authoring__canvas-node\s*\{[\s\S]*?\n\}/)
    expect(cardRuleMatch).not.toBeNull()
    expect(cardRuleMatch![0]).toMatch(/border-radius:\s*8px/)
    expect(cardRuleMatch![0]).not.toMatch(/box-shadow:/)
  })
})
