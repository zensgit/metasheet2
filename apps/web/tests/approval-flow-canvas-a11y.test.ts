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

  it('flow cards expose type chrome, summary, a circular edge +, and the 办理人 edge-insert item (Lock-3 §1.5)', () => {
    expect(CANVAS_SRC).toMatch(/template-authoring__canvas-node-kind/)
    expect(CANVAS_SRC).toMatch(/canvasNodeSummary\(pos\.key\)/)
    expect(CANVAS_SRC).toMatch(/template-authoring__canvas-edge-insert-btn/)
    expect(CANVAS_SRC).toMatch(/border-radius: 50%/)
    expect(CANVAS_SRC).toMatch(/插入抄送节点/)
    // Lock-3 §1.5: the canvas gains a fifth edge-insert item — 办理人 — beside 审批人/抄送人/条件分支/
    // 并行分支, emitting `edge-insert-handler` with the `approval-canvas-edge-insert-handler` testid,
    // hidden on edges inside a parallel region (`canInsertHandlerOnEdge`).
    expect(CANVAS_SRC).toMatch(/data-testid="approval-canvas-edge-insert-handler"/)
    expect(CANVAS_SRC).toMatch(/插入办理节点/)
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
    // 'handler' added by the FAIL-6 fix (P7-R2, gate fix round) — was the only one of seven
    // shipped node types with no accent at all (fell through to the CARD's own default
    // `--el-border-color-lighter`), until this rule landed.
    for (const type of ['approval', 'cc', 'condition', 'parallel', 'handler']) {
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

// FAIL-2 fix (P7 phase-A evidence ledger, P7-R2, 20260818): 13 of 19 flow-canvas controls used
// `--el-color-primary-light-5` (#92b1f5) for the keyboard focus ring, measured 2.05-2.14:1 against
// every abutting surface in real Chromium — below the ratified >=3:1 (V-6,
// approval-canvas-v2-interaction-design-lock-20260721.md:412). `--el-color-primary` (#2563eb)
// measured 4.45-5.17:1 on every surface (the P7-A ledger's own table).
//
// P2-1 hardening precedent (this file, above): a pin keyed to a specific selector SPELLING is
// defeated by restating the same rule under a different selector. This block guards the MECHANISM
// instead — it enumerates every rule in the component's own raw stylesheet text whose selector
// contains `:focus-visible`, then asserts three properties over that DERIVED set, not over two
// named line numbers:
//   1. the set is non-empty (so the loop below cannot pass vacuously);
//   2. no rule in the set references the sub-3:1 `--el-color-primary-light-5` ring token;
//   3. every rule in the set declares a non-color channel (`outline` or `box-shadow`) — colour
//      alone never carries focus state (also closes the §7 checklist "colour is not the sole
//      carrier of state" finding tied to the same root cause);
//   4. no rule in the set ships a bare `outline: none` (a removal with no replacement ring).
// A future contributor who re-adds a light-5 (or color-only, or outline:none) focus-visible rule
// ANYWHERE in this component — new selector text included — trips this without editing the test.
describe('ApprovalFlowCanvas focus-ring contrast (FAIL-2 / V-6, P7-R2 fix, mechanism guard)', () => {
  function extractStyleBlock(src: string): string {
    const match = src.match(/<style[^>]*>([\s\S]*?)<\/style>/)
    if (!match) throw new Error('no <style> block found in ApprovalFlowCanvas.vue')
    return match[1]
  }

  function focusVisibleRuleBlocks(styleBlock: string): string[] {
    // Strip `/* ... */` comments FIRST. Several of THIS FIX's own explanatory comments discuss
    // `:focus-visible` and quote the exact prohibited declaration (`outline: none`) as prose —
    // without stripping, that comment text would glue onto the adjacent rule's captured selector
    // (nothing but the comment separates it from the next `{`) and produce a false positive on
    // the "no bare outline: none" check below purely from the comment's own words.
    const withoutComments = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '')
    // `<selector(s) containing :focus-visible> { <declarations> }` — the selector segment can be
    // comma-separated (none currently are, post-fix, but the pattern doesn't assume otherwise).
    const blocks: string[] = []
    const ruleRe = /([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g
    let m: RegExpExecArray | null
    // eslint-disable-next-line no-cond-assign
    while ((m = ruleRe.exec(withoutComments))) {
      blocks.push(`${m[1].trim()} {${m[2]}}`)
    }
    return blocks
  }

  const styleBlock = extractStyleBlock(CANVAS_SRC)
  const blocks = focusVisibleRuleBlocks(styleBlock)

  it('the enumeration finds every shipped :focus-visible rule (cannot pass vacuously)', () => {
    // Mutation probe: deleting a `:focus-visible` rule from the component must shrink this count —
    // proving the loop-based assertions below are actually exercised, not skipped over an empty set.
    expect(blocks.length).toBe(5)
  })

  it('no :focus-visible rule anywhere in the component references the sub-3:1 light-5 ring token', () => {
    for (const block of blocks) {
      expect(block).not.toMatch(/--el-color-primary-light-5/)
    }
  })

  it('every :focus-visible rule declares a non-color channel (outline or box-shadow) — colour is never the sole carrier of focus state', () => {
    for (const block of blocks) {
      const hasNonColorChannel = /\boutline\s*:/.test(block) || /\bbox-shadow\s*:/.test(block)
      expect(hasNonColorChannel).toBe(true)
    }
  })

  it('no :focus-visible rule ships a bare `outline: none` (a removal with no replacement ring)', () => {
    for (const block of blocks) {
      expect(block).not.toMatch(/outline\s*:\s*none\b/)
    }
  })
})

// FAIL-2 fix, second root cause (P7-R2, discovered during real-Chromium re-measurement, not named
// by line number in the original ledger finding): the canvas toolbar buttons (撤销/重做/缩小/
// 100%/放大/适应画布) are real `<el-button>`s, so their `:focus-visible` ring is NOT painted by any
// rule in this component's own stylesheet at all — it comes from Element Plus's OWN base
// `.el-button` default, which sets `--el-button-outline-color: var(--el-color-primary-light-5)`.
// Measured in real Chromium: 2.14:1 before this fix, 5.17:1 after (scoped override below).
// Deliberately NOT overriding Element Plus's app-wide default (that is a separate, unratified,
// much larger surface) — only the canvas toolbar's own buttons.
describe('ApprovalFlowCanvas toolbar buttons — Element Plus default ring override (FAIL-2, P7-R2)', () => {
  it('scopes an --el-button-outline-color override to the canvas toolbar only, off the sub-3:1 light-5 default', () => {
    const rule = CANVAS_SRC.match(
      /\.template-authoring__canvas-toolbar\s+:deep\(\.el-button\)\s*\{([^}]*)\}/,
    )
    expect(rule).not.toBeNull()
    expect(rule![1]).toMatch(/--el-button-outline-color:\s*var\(--el-color-primary\)/)
    expect(rule![1]).not.toMatch(/--el-color-primary-light-5/)
  })
})
