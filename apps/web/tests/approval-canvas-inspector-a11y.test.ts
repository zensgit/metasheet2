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

// ── Lock-0 P1-A — L0-1 tab strip a11y (structural source scan) ─────────────────────────────────
// docs/development/approval-lock0-d0-interaction-delta-20260817.md §3 A-11/A-12. Mounted keyboard
// behavior (roving tabindex actually moving focus, arrow-key containment at both widget
// boundaries) is proven with real DOM/keyboard interaction in
// approval-template-authoring-canvas-inspector.spec.ts's A-11/A-12 tests; this file pins the
// static SOURCE contract those behaviors depend on, matching this file's existing convention.
describe('ApprovalCanvasNodeInspector L0-1 tab strip a11y (structural)', () => {
  it('renders a tablist with roving tabindex and per-tab ARIA wiring', () => {
    expect(INSPECTOR_SRC).toMatch(/role="tablist"/)
    expect(INSPECTOR_SRC).toMatch(/role="tab"/)
    expect(INSPECTOR_SRC).toMatch(/role="tabpanel"/)
    // Roving tabindex: only the active tab is in the Tab sequence.
    expect(INSPECTOR_SRC).toMatch(/:tabindex="activeTab === tab\.id \? 0 : -1"/)
    expect(INSPECTOR_SRC).toMatch(/:aria-selected="activeTab === tab\.id \? 'true' : 'false'"/)
    expect(INSPECTOR_SRC).toMatch(/:aria-controls="`approval-canvas-inspector-tabpanel-\$\{tab\.id\}`"/)
    expect(INSPECTOR_SRC).toMatch(/:aria-labelledby="`approval-canvas-inspector-tab-\$\{activeTab\}`"/)
  })

  it('the tablist aria-label is a static string, not a raw-node-key template literal (keeps the ≥9 dynamic-aria-label floor above meaningful)', () => {
    // A plain `aria-label="..."` (no leading colon) is a static attribute — it does not enter the
    // `:aria-label="`...`"` dynamic-template-literal set the earlier test in this file scans, so
    // adding it does not require routing it through graphNodeLabel.
    expect(INSPECTOR_SRC).toMatch(/aria-label="节点设置"/)
    expect(INSPECTOR_SRC).not.toMatch(/:aria-label="`节点设置`"/)
  })

  it('keydown handling is bound to the tablist element only, not to a panel-wide listener shared with the toolbar', () => {
    // The topology toolbar (role="toolbar") and the tablist are two independent DOM subtrees with
    // independent (or absent) keydown wiring — A-12's "one arrow keypress never crosses the two"
    // holds by construction, not by a shared dispatcher that routes between them.
    expect(INSPECTOR_SRC).toMatch(/role="tablist"[\s\S]*?@keydown="onTabsKeydown"/)
    const toolbarBlock = INSPECTOR_SRC.slice(
      INSPECTOR_SRC.indexOf('role="toolbar"'),
      INSPECTOR_SRC.indexOf('role="tablist"'),
    )
    expect(toolbarBlock).not.toMatch(/@keydown/)
  })

  it('a visible focus ring is defined for the tab control (parent §6.2, §14 V-6)', () => {
    expect(INSPECTOR_SRC).toMatch(
      /\.template-authoring__canvas-inspector-tab:focus-visible\s*\{[\s\S]*?outline:\s*2px/,
    )
  })

  it('tab membership is derived from the L0-2 registry, not a hand-written boolean', () => {
    // The 操作权限 entry is pushed ONLY inside the registry-gate `if`, not unconditionally.
    expect(INSPECTOR_SRC).toMatch(
      /if \(hasRatifiedOperationPolicy\(registry, props\.node\.type\)\) \{\s*\n\s*list\.push\(\{ id: 'operations', label: '操作权限' \}\)/,
    )
  })
})

// ── B1/B2 (owner-approved draft-authoring UX slice, 20260824) — structural pins ───────────────
describe('ApprovalCanvasNodeInspector B1 footer action bar (structural)', () => {
  it('keeps stable footer/action data-testids, outside the scrolling body', () => {
    expect(INSPECTOR_SRC).toMatch(/data-testid="approval-canvas-inspector-footer"/)
    expect(INSPECTOR_SRC).toMatch(/data-testid="approval-canvas-inspector-footer-close"/)
    // The footer is a sibling of `.template-authoring__canvas-inspector-body` (the scrolling
    // region), declared AFTER it closes — never nested inside it.
    const bodyOpenIndex = INSPECTOR_SRC.indexOf('template-authoring__canvas-inspector-body')
    const footerIndex = INSPECTOR_SRC.indexOf('data-testid="approval-canvas-inspector-footer"')
    expect(bodyOpenIndex).toBeGreaterThan(0)
    expect(footerIndex).toBeGreaterThan(bodyOpenIndex)
  })

  it('pins the footer flex rule that keeps it fixed while the body scrolls', () => {
    expect(INSPECTOR_SRC).toMatch(
      /\.template-authoring__canvas-inspector-footer\s*\{[\s\S]*?flex:\s*0 0 auto/,
    )
    expect(INSPECTOR_SRC).toMatch(
      /\.template-authoring__canvas-inspector-body\s*\{[\s\S]*?overflow:\s*auto/,
    )
  })

  it('the footer carries a SINGLE 关闭 (E-P2-3: the 取消/确定 pair both aliased close over live-committing fields — a cancel that cannot discard — and RATIFIED A-8 forbids Save/Cancel/Apply outright)', () => {
    expect(INSPECTOR_SRC).toMatch(/data-testid="approval-canvas-inspector-footer-close"[\s\S]{0,80}>\s*关闭\s*</)
    expect(INSPECTOR_SRC).not.toMatch(/data-testid="approval-canvas-inspector-cancel"/)
    expect(INSPECTOR_SRC).not.toMatch(/data-testid="approval-canvas-inspector-confirm"/)
  })
})

describe('ApprovalCanvasNodeInspector B2 inline title rename (structural)', () => {
  it('keeps stable rename data-testids and emits a typed `rename` event (not a second write path)', () => {
    expect(INSPECTOR_SRC).toMatch(/data-testid="approval-canvas-inspector-rename"/)
    expect(INSPECTOR_SRC).toMatch(/data-testid="approval-canvas-inspector-rename-input"/)
    expect(INSPECTOR_SRC).toMatch(/rename: \[nodeKey: string, name: string\]/)
  })

  it('the rename affordance is gated on `!readOnly`, matching the topology toolbar\'s own gate', () => {
    expect(INSPECTOR_SRC).toMatch(
      /v-if="!readOnly"\s*\n\s*type="button"\s*\n\s*class="template-authoring__inspector-rename-btn"/,
    )
  })

  it('rename aria-labels route through graphNodeLabel(node.key), never the raw node key alone (raw-id census discipline)', () => {
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`重命名\$\{graphNodeLabel\(node\.key\)\}节点`"/,
    )
    expect(INSPECTOR_SRC).toMatch(
      /:aria-label="`\$\{graphNodeLabel\(node\.key\)\}节点名称`"/,
    )
  })

  it('Enter commits, Esc cancels, blur commits — exact keydown/blur wiring on the rename input', () => {
    expect(INSPECTOR_SRC).toMatch(/@keydown\.enter="commitRenameTitle"/)
    expect(INSPECTOR_SRC).toMatch(/@keydown\.esc="cancelRenameTitle"/)
    expect(INSPECTOR_SRC).toMatch(/@blur="commitRenameTitle"/)
  })

  it('switching the selected node discards an in-progress rename (no leaked edit onto the next node)', () => {
    expect(INSPECTOR_SRC).toMatch(
      /watch\(\s*\(\) => props\.node\.key,\s*\(\) => \{[\s\S]{0,220}isRenamingTitle\.value = false/,
    )
  })
})

// B2 priority slot — REFUSED, not implemented (owner contract decision needed; see PR
// description). `ApprovalNode`/`ConditionBranch` carry no priority/order field today — pin the
// negative so a future accidental addition here is a deliberate, reviewed choice, not a silent
// drift back to "render nothing".
describe('ApprovalCanvasNodeInspector B2 priority slot (deliberately NOT implemented)', () => {
  it('renders no priority/order control in the panel header (no contract to author against yet)', () => {
    expect(INSPECTOR_SRC).not.toMatch(/data-testid="[^"]*priority[^"]*"/)
    expect(INSPECTOR_SRC).not.toMatch(/优先级/)
  })
})
