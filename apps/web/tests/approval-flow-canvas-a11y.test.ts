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
  it('no data-node-type-scoped selector of ANY shape sets a background fill (no per-type ribbon, however the selector is spelled)', () => {
    // Mutation probe: re-adding the literal `.template-authoring__canvas-node-kind[data-node-type=
    // 'approval'] { background: ... }` must turn this red — token-based colors pass UF-6 (no
    // hex/rgb literal), so this explicit source pin is the actual guard, not UF-6.
    //
    // house-rule fix (adversarial gate P2-1, 20260817): a prior version of this pin keyed off the
    // literal substring "canvas-node-kind", which a restatement defeats trivially by reaching the
    // SAME element through a different selector — e.g.
    // `.template-authoring__canvas-node[data-node-type='cc'] > div:first-child { background: ... }`
    // (the kind bar IS that element's first child div — verified against the template markup).
    // The mechanism being guarded is "no rule whose selector is scoped to a `[data-node-type=...]`
    // attribute sets background/background-color", regardless of what else the selector says
    // (class name, combinator, pseudo-class) — so the pin now matches on the attribute selector
    // itself, not on a co-occurring class name.
    expect(CANVAS_SRC).not.toMatch(/\[data-node-type=[^\]]+\][^{]*\{[^}]{0,240}background(-color)?:/)
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

// P2-1 hardening (adversarial gate, 20260817): the source-text pin above guards the SPELLING of the
// prohibited rule; this block guards the MECHANISM directly by reading real computed style off real
// DOM nodes — a spelling restatement (e.g. `[data-node-type=X] > div:first-child { background: … }`)
// cannot evade a check that never looks at selector text at all.
//
// The component's OWN raw `<style scoped>` block text is injected as a literal stylesheet. The
// `scoped` hash attribute (`data-v-xxxxxxxx`) is added by the SFC compiler at BUILD time and is not
// present in this raw source, so the selectors as written (plain classes / attribute selectors)
// match ordinary hand-built DOM nodes here without needing that hash.
describe('ApprovalFlowCanvas flat-card grammar — computed-style mechanism guard (P1-D / P2-1)', () => {
  function extractStyleBlock(src: string): string {
    const match = src.match(/<style[^>]*>([\s\S]*?)<\/style>/)
    if (!match) throw new Error('no <style> block found in ApprovalFlowCanvas.vue')
    return match[1]
  }

  function kindBarBackground(nodeType: string): string {
    const styleEl = document.createElement('style')
    styleEl.textContent = extractStyleBlock(CANVAS_SRC)
    document.head.appendChild(styleEl)
    const card = document.createElement('div')
    card.className = 'template-authoring__canvas-node'
    card.setAttribute('data-node-type', nodeType)
    const kindBar = document.createElement('div')
    kindBar.className = 'template-authoring__canvas-node-kind'
    kindBar.setAttribute('data-node-type', nodeType)
    card.appendChild(kindBar)
    // A second child mirrors the real markup's `.template-authoring__canvas-node-selector` sibling,
    // so a MUTATION-A-shaped `> div:first-child` selector resolves against the SAME element a real
    // mount would hit — not an artifact of a single-child fixture.
    const selectorEl = document.createElement('div')
    selectorEl.className = 'template-authoring__canvas-node-selector'
    card.appendChild(selectorEl)
    document.body.appendChild(card)
    // jsdom does not resolve CSS custom properties (`var(--x)`), so `.backgroundColor` collapses
    // to the same default `rgba(0, 0, 0, 0)` for every rule regardless of which `var(--el-…)` token
    // it names — that would make every type compare EQUAL even under a real mutation (a toothless
    // check). `.background` (the shorthand) preserves the raw, unresolved `var(--el-…)` text, which
    // DOES differ correctly per rule — verified empirically: under MUTATION-A this returns
    // `var(--el-color-success-light-8)` for `cc` vs `var(--el-fill-color-light)` for every
    // unaffected type, while `.backgroundColor` stayed `rgba(0, 0, 0, 0)` for all of them.
    const computed = getComputedStyle(kindBar)
    // Widened beyond `.background` alone: a ribbon can be repainted per type through any
    // paint-relevant property (`box-shadow: inset 0 0 0 99px …` reproduces the shipped ribbon with
    // zero `background` involvement), so the guard compares the full paint tuple. Property-scoped
    // guards are a trap-enumeration anti-pattern; the tuple below is the paint surface of this
    // element, not a list of known evasions.
    const paint = JSON.stringify([
      computed.background,
      computed.backgroundImage,
      computed.boxShadow,
      computed.border,
      computed.borderLeft,
      computed.outline,
      computed.filter,
      computed.opacity,
    ])
    const backgroundOnly = computed.background
    document.body.removeChild(card)
    document.head.removeChild(styleEl)
    return { paint, backgroundOnly }
  }

  it('kind-bar computed paint tuple is IDENTICAL across every node type (behavioral, not text-based)', () => {
    const types = ['start', 'end', 'approval', 'cc', 'condition', 'parallel']
    const values = types.map((type) => kindBarBackground(type))
    // Sanity: jsdom actually resolved something from the injected stylesheet, not a silent no-op
    // that would make the equality check below vacuously true.
    expect(values.every((v) => v.backgroundOnly !== '')).toBe(true)
    expect(new Set(values.map((v) => v.paint)).size).toBe(1)
  })
})
