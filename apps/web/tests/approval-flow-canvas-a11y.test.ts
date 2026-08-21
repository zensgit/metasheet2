/**
 * Wave-2 PR4 — ApprovalFlowCanvas edge-insert / node-card a11y lock.
 * Pure structural source-scan (G5-C style): no jsdom mount of the full canvas tree.
 *
 * FS-7 (2026-08-21) adds a SECOND, MOUNTED tier at the bottom of this file — see the
 * "node card accessible names (accname, mounted DOM)" describe block. It is a deliberately
 * DIFFERENT problem from the tooltip work elsewhere in the closeout line (do not fuse them,
 * feedback_misclassified_gap_called_a_ceiling.md) and a deliberately DIFFERENT tier from the
 * source-scan tests above it (feedback_source_text_assertions_are_not_behaviour.md): the source
 * scan above already pins that `:aria-label="`编辑${graphNodeLabel(pos.key)}节点`"` is the literal
 * text TemplateAuthoringView.vue's real `graphNodeLabel`/`nodeTypeLabel` wire into; the block below
 * proves what that WIRING actually PRODUCES once compiled and mounted — a real DOM read, not a
 * regex over source text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import ApprovalFlowCanvas from '../src/approvals/components/ApprovalFlowCanvas.vue'
import { computeLayout } from '../src/approvals/graphLayout'
import type { ApprovalGraph, ApprovalNode, ApprovalNodeType } from '../src/types/approval'

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
  // P7-R2 gate hardening (P2-3): the original non-global `.match()` here only ever captured the
  // FIRST `<style>` block — a second block anywhere in the file would carry zero test signal
  // through any of the four assertions below (reproduced: an appended hostile second block with a
  // light-5, colour-only, bare-outline:none rule left every assertion green). Mirrors the
  // sibling-file fix already shipped in `ui-foundation-style-guard.spec.ts`'s `extractStyleBlocks`
  // (global regex + `exec` loop, concatenating every block) rather than inventing a new pattern.
  const STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/g
  function extractStyleBlock(src: string): string {
    const blocks: string[] = []
    let match: RegExpExecArray | null
    STYLE_BLOCK_RE.lastIndex = 0
    while ((match = STYLE_BLOCK_RE.exec(src))) {
      blocks.push(match[1])
    }
    if (blocks.length === 0) throw new Error('no <style> block found in ApprovalFlowCanvas.vue')
    return blocks.join('\n')
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FS-7 — canvas node card accessible names (accname), MOUNTED DOM tier.
//
// WHAT WAS "UNVERIFIED": the closeout flagged the node card's accessible name (what a screen
// reader announces on Tab focus) as unverified — the ONLY prior coverage was the source-scan
// above (a regex over `.vue` file text), which pins the WIRING ("this literal expression is
// bound to :aria-label") but never renders anything or reads a real DOM attribute. This block
// mounts ApprovalFlowCanvas.vue for real (jsdom, via `createApp` — the same pattern used by
// DirectoryDeprovisionEvidencePanel.spec.ts / directoryManagementView.spec.ts elsewhere in this
// repo, not @vue/test-utils, which this repo does not depend on) and reads attributes/text off
// the actual rendered nodes.
//
// UNIT BOUNDARY: ApprovalFlowCanvas.vue's own docstring calls it "pure presentation — parent owns
// draft/history and all topology/command mutations." `graphNodeLabel` / `nodeTypeLabel` /
// `canvasNodeSummary` arrive as PROP FUNCTIONS from TemplateAuthoringView.vue, which is not
// exported (private `<script setup>` locals) and so cannot be imported here. This block therefore
// mounts the child in isolation and supplies fixture functions that MIRROR the real one-liners
// byte-for-byte (`node.name?.trim() || nodeTypeLabel(node.type)`) — this proves "does this
// component's own template correctly turn a `graphNodeLabel` contract into a per-node accname",
// which combined with the source-scan above ("TemplateAuthoringView wires its REAL
// `graphNodeLabel` — not some other computation — into this exact prop") closes the loop without
// needing the full parent view's heavier router/store/API mock harness.
//
// ACCNAME ALGORITHM, JSDOM-APPROXIMATED (`computeAccName` below): aria-labelledby text → aria-label
// → visible text content (aria-hidden and inline display:none/visibility:hidden subtrees excluded).
// HONEST BOUNDARY: this is NOT the full WAI-ARIA Accessible Name and Description Computation 1.2
// algorithm — it does not resolve `<label for>`/native-control value fallback (not applicable to
// these `role="button"` divs), CSS `::before`/`::after` generated content, the `title` attribute
// last-resort fallback, or `<slot>` distribution edge cases. jsdom also does not compute real
// paint-time visibility (e.g. an ancestor with `display:none` set via a class + real stylesheet,
// as opposed to an inline `style` attribute, is invisible to the `visibility`/`display` checks
// below). A verdict that depends on any of those needs a real browser harness (Chromium/Playwright)
// — same boundary this repo already documents for CSS in general (feedback_css_verify_in_real_
// browser_not_jsdom.md). Within that boundary, this is what jsdom + these two `getAttribute` reads
// + a filtered `textContent` walk can prove, and it is sufficient here because EVERY node-card
// accname in the shipped markup is carried by `aria-label` alone (no `aria-labelledby`, no native
// label) — verified structurally by the source-scan block above.
describe('ApprovalFlowCanvas node card accessible names (accname, mounted DOM — FS-7)', () => {
  const NODE_TYPES: ApprovalNodeType[] = ['start', 'approval', 'cc', 'condition', 'parallel', 'handler', 'end']

  // Mirrors TemplateAuthoringView.vue's real NODE_TYPE_LABELS / nodeTypeLabel (line ~1892) —
  // byte-identical values, kept here only because the real map is a private script-setup const.
  const NODE_TYPE_LABELS: Record<ApprovalNodeType, string> = {
    start: '发起',
    approval: '审批',
    cc: '抄送',
    condition: '条件分支',
    parallel: '并行分支',
    handler: '办理',
    end: '结束',
  }
  function nodeTypeLabel(type: string): string {
    return NODE_TYPE_LABELS[type as ApprovalNodeType] ?? type
  }
  // Mirrors TemplateAuthoringView.vue's real `graphNodeLabel` (line ~2193) byte-for-byte:
  // `node.name?.trim() || nodeTypeLabel(node.type)`.
  function graphNodeLabel(graph: ApprovalGraph, key: string): string {
    const node = graph.nodes.find((candidate) => candidate.key === key)
    if (!node) return '流程节点'
    return node.name?.trim() || nodeTypeLabel(node.type)
  }

  function buildGraph(names: Partial<Record<ApprovalNodeType, string>>): ApprovalGraph {
    // `config: {}` for every node — not config-VALID per any node type's real schema, only
    // config-SHAPED enough to satisfy the type. Fine here: accname computation never reads
    // `node.config` (only `node.name`/`node.type`), so an empty stub is not a fixture gap.
    const nodes: ApprovalNode[] = NODE_TYPES.map((type) => ({
      key: `n_${type}`,
      type,
      name: names[type],
      config: {} as ApprovalNode['config'],
    }))
    const edges = NODE_TYPES.slice(0, -1).map((type, index) => ({
      key: `e_${index}`,
      source: `n_${type}`,
      target: `n_${NODE_TYPES[index + 1]}`,
    }))
    return { nodes, edges }
  }

  // Author-given names, one distinct string per type, none of which is a substring of the node's
  // own raw key (`n_approval` etc.) or of any OTHER type's name — so "contains the node's own
  // name" and "does not leak the raw key" are both non-vacuous per type.
  const NAMED: Record<ApprovalNodeType, string> = {
    start: '发起环节',
    approval: '总经理审批',
    cc: '知会人事',
    condition: '金额分支',
    parallel: '会签并行',
    handler: '资料办理',
    end: '流程结束',
  }

  /** Walks `el`'s subtree, excluding aria-hidden and inline-hidden branches — the jsdom-approximated "visible text content" leg of computeAccName. */
  function visibleTextContent(el: Element): string {
    let out = ''
    el.childNodes.forEach((child) => {
      if (child.nodeType === 3 /* Node.TEXT_NODE */) {
        out += child.textContent ?? ''
        return
      }
      if (child.nodeType !== 1 /* Node.ELEMENT_NODE */) return
      const childEl = child as HTMLElement
      if (childEl.getAttribute('aria-hidden') === 'true') return
      if (childEl.style && (childEl.style.display === 'none' || childEl.style.visibility === 'hidden')) return
      out += visibleTextContent(childEl)
    })
    return out
  }

  /** jsdom-approximated AccName: aria-labelledby text -> aria-label -> filtered text content. See the file-level doc comment above for the honest boundary. */
  function computeAccName(el: Element): string {
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => node !== null)
        .map((node) => visibleTextContent(node).trim())
        .filter(Boolean)
        .join(' ')
      if (text.trim()) return text.trim()
    }
    const ariaLabel = el.getAttribute('aria-label')
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim()
    return visibleTextContent(el).replace(/\s+/g, ' ').trim()
  }

  async function mountFixture(names: Partial<Record<ApprovalNodeType, string>>) {
    const graph = buildGraph(names)
    const layout = computeLayout(graph)
    const byKey = new Map(graph.nodes.map((node) => [node.key, node]))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app: App = createApp(ApprovalFlowCanvas, {
      readOnly: false,
      canvasValidity: [],
      canUndo: false,
      canRedo: false,
      canvasZoomLabel: '100%',
      canvasStageCss: {},
      canvasSurfaceCss: {},
      canvasLayout: layout,
      canvasEdgeLines: [],
      canvasMoveTargetLines: [],
      selectedCanvasNode: null,
      movingCanvasNode: null,
      edgeInsertMenuEdgeKey: null,
      canvasMinimap: { offsetX: 0, offsetY: 0, scale: 1, viewport: { x: 0, y: 0, width: 10, height: 10 } },
      nodeWidth: 264,
      nodeHeight: 76,
      minimapWidth: 200,
      minimapHeight: 120,
      graphNodeLabel: (key: string) => graphNodeLabel(graph, key),
      // Deliberately EMPTY (not the real canvasNodeCardSummary, which never returns '') — an
      // adversarial fixture so the visible card text carries NO fallback content of its own.
      // CONFIRMED during development, not just inferred: re-ran the CC mutation below (§ mutation
      // evidence) against a non-empty summary stub ('点击配置') — with :aria-label stripped for
      // `cc`, the raw textContent fallback came back "点击配置›" (non-empty), so a bare
      // "non-empty accname" assertion would have passed VACUOUSLY under the very mutation it
      // exists to catch (only the separate "contains the node's own name" leg still caught it).
      // '' removes that vacuous-pass path so the non-empty assertion is load-bearing on its own.
      canvasNodeSummary: () => '',
      nodeTypeLabel,
      canvasNodeByKey: (key: string) => byKey.get(key),
      canMoveCanvasNode: () => false,
      canInsertParallelOnEdge: () => false,
      canInsertHandlerOnEdge: () => false,
      canvasMoveTargetLabel: () => '',
    })
    app.mount(container)
    await nextTick()
    const accNameByType = new Map<ApprovalNodeType, string>()
    const ariaLabelByType = new Map<ApprovalNodeType, string | null>()
    for (const type of NODE_TYPES) {
      const key = `n_${type}`
      const selector = container.querySelector(
        `[data-canvas-node="${key}"] [data-testid="approval-canvas-node-select"]`,
      )
      if (!selector) throw new Error(`no node-select control rendered for ${key}`)
      accNameByType.set(type, computeAccName(selector))
      ariaLabelByType.set(type, selector.getAttribute('aria-label'))
    }
    return { app, container, accNameByType, ariaLabelByType }
  }

  let named: Awaited<ReturnType<typeof mountFixture>>
  let unnamed: Awaited<ReturnType<typeof mountFixture>>

  beforeAll(async () => {
    named = await mountFixture(NAMED)
    unnamed = await mountFixture({})
  })

  afterAll(() => {
    named.app.unmount()
    named.container.remove()
    unnamed.app.unmount()
    unnamed.container.remove()
  })

  it('the computeAccName helper prefers aria-label over visible text content, and excludes aria-hidden text (proves the exclusion branch actually fires)', () => {
    const withLabel = document.createElement('div')
    withLabel.setAttribute('aria-label', '标签文本')
    withLabel.textContent = '被忽略的内容'
    expect(computeAccName(withLabel)).toBe('标签文本')

    const withoutLabel = document.createElement('div')
    const visible = document.createElement('span')
    visible.textContent = '可见文本'
    const hidden = document.createElement('span')
    hidden.setAttribute('aria-hidden', 'true')
    hidden.textContent = '隐藏文本'
    withoutLabel.appendChild(visible)
    withoutLabel.appendChild(hidden)
    // Sanity: the hidden text is really there in the DOM (so exclusion below is a real subtraction,
    // not a fixture that never contained it in the first place).
    expect(withoutLabel.textContent).toContain('隐藏文本')
    expect(computeAccName(withoutLabel)).toBe('可见文本')
    expect(computeAccName(withoutLabel)).not.toContain('隐藏文本')

    const withLabelledBy = document.createElement('div')
    const labelSource = document.createElement('span')
    labelSource.id = 'accname-test-labelledby-src'
    labelSource.textContent = 'labelledby文本'
    document.body.appendChild(labelSource)
    withLabelledBy.setAttribute('aria-labelledby', 'accname-test-labelledby-src')
    withLabelledBy.setAttribute('aria-label', '被labelledby盖过的文本')
    expect(computeAccName(withLabelledBy)).toBe('labelledby文本')
    labelSource.remove()
  })

  for (const type of NODE_TYPES) {
    it(`${type} node card: named-graph accname is non-empty, contains the node's own name, and never leaks the raw key (values-free)`, () => {
      const key = `n_${type}`
      const accName = named.accNameByType.get(type)!
      expect(accName.length).toBeGreaterThan(0)
      expect(accName).toContain(NAMED[type])
      expect(accName).not.toContain(key)
    })

    it(`${type} node card: unnamed-graph accname falls back to the exact type label ("编辑${NODE_TYPE_LABELS[type]}节点")`, () => {
      const accName = unnamed.accNameByType.get(type)!
      expect(accName).toBe(`编辑${NODE_TYPE_LABELS[type]}节点`)
    })
  }

  it('the seven unnamed-graph fallback accnames are mutually distinct (type-distinguishing even with no author-given name)', () => {
    const values = NODE_TYPES.map((type) => unnamed.accNameByType.get(type)!)
    expect(values.every((v) => v.length > 0)).toBe(true)
    expect(new Set(values).size).toBe(NODE_TYPES.length)
  })

  it('the seven named-graph accnames are mutually distinct', () => {
    const values = NODE_TYPES.map((type) => named.accNameByType.get(type)!)
    expect(new Set(values).size).toBe(NODE_TYPES.length)
  })

  it('every node-card accname is carried by the aria-label attribute alone (matches the source-scan-pinned wiring, not a coincidental text-content match)', () => {
    for (const type of NODE_TYPES) {
      expect(named.ariaLabelByType.get(type)).toBeTruthy()
      expect(named.ariaLabelByType.get(type)).toBe(named.accNameByType.get(type))
    }
  })
})
