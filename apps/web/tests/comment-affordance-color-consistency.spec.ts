import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Multitable comment-affordance token design-lock (RATIFIED 2026-07-13):
// docs/development/multitable-comment-affordance-token-design-lock-20260713.md
//
// §3.3 requires a source-scanning consistency guard over the 10 files that consume
// `resolveCommentAffordanceStateClass` (utils/comment-affordance.ts §1), asserting:
//   (a) no comment-affordance ACTIVE rule uses a raw hex color — it must reference the
//       specific `--ms-color-comment-active-{border,bg,text}` token for that CSS property
//       (not merely "some var()" — swapping in a DIFFERENT token, e.g. --ms-color-warning,
//       which the owner explicitly forbade, must also fail this guard);
//   (b) `resolveCommentAffordanceStateClass` remains the ONLY state-derivation entry — no
//       component hand-rolls its own comment-affordance `--active`/`--idle` class name outside
//       a call to that function.
// Both checks are TARGETED (selector text must contain "comment" + "--active"), not a whole-
// file hex ban — these 10 files still carry plenty of unrelated hardcoded hex (grid chrome,
// calendar event cards, DnD drop zones, …) that is explicitly OUT of this lock's scope
// (design-lock Status: "范围：仅 comment-affordance 的颜色语义与一致性").

const CONSUMER_FILES = [
  'src/multitable/components/MetaGridTable.vue',
  'src/multitable/components/MetaKanbanView.vue',
  'src/multitable/components/MetaGalleryView.vue',
  'src/multitable/components/MetaCalendarView.vue',
  'src/multitable/components/MetaTimelineView.vue',
  'src/multitable/components/MetaHierarchyView.vue',
  'src/multitable/components/MetaFormView.vue',
  'src/multitable/components/MetaRecordDrawer.vue',
  // W2 S1 (2026-07-15): MetaRecordFieldsPanel.vue was extracted from MetaRecordDrawer.vue's
  // `details` tab body and took the per-field comment anchor's `--active`/`--idle` rule with it
  // (scoped CSS must live with the template that renders it). Added here so this lock keeps
  // covering that rule at its new home instead of silently losing it off the guarded list.
  'src/multitable/components/MetaRecordFieldsPanel.vue',
  'src/multitable/components/MetaCommentActionChip.vue',
  'src/multitable/components/MetaCommentAffordance.vue',
] as const

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

const STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/g

function extractStyleBlocks(src: string): string[] {
  const blocks: string[] = []
  let m: RegExpExecArray | null
  STYLE_BLOCK_RE.lastIndex = 0
  while ((m = STYLE_BLOCK_RE.exec(src))) blocks.push(m[1])
  return blocks
}

// Strip CSS comments BEFORE rule/hex scanning. Without this, an explanatory `/* ... */` comment
// that mentions an old hex value for context (exactly what this PR's own MetaGridTable diff
// does, documenting the pre-OD-CA-2 blue #1d4ed8) would false-positive as a "raw hex in an
// active rule" — proven while building this guard (self-test below pins it).
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

type CssRule = { selector: string; body: string }

// Non-recursive selector{body} splitter — deliberately not a full CSS parser (same philosophy
// as ui-foundation-style-guard.spec.ts's extractStyleBlocks/countHexOrRgbLiterals). It does not
// correctly decompose @media/@keyframes internals, but none of the target rules live inside
// either at-rule in these files (verified), and stray non-matches from those blocks are simply
// ignored (the selector filter below never matches them).
const RULE_RE = /([^{}]+)\{([^{}]*)\}/g

function extractRules(styleBlock: string): CssRule[] {
  const rules: CssRule[] = []
  let m: RegExpExecArray | null
  RULE_RE.lastIndex = 0
  while ((m = RULE_RE.exec(styleBlock))) {
    rules.push({ selector: m[1].trim(), body: m[2].trim() })
  }
  return rules
}

// Matches any selector group containing a comment-affordance "active" state class, however it's
// combined (comma-grouped with siblings/idle, or class-chained like
// `.meta-record-drawer__btn--comment.meta-record-drawer__btn--comment--active`).
const COMMENT_ACTIVE_SELECTOR_RE = /comment[\w-]*--active\b/i

function commentActiveRules(rel: string): CssRule[] {
  const blocks = extractStyleBlocks(readSrc(rel)).map(stripCssComments)
  return blocks.flatMap(extractRules).filter((r) => COMMENT_ACTIVE_SELECTOR_RE.test(r.selector))
}

const HEX_OR_RGB_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/g

function hexOrRgbLiteralCount(text: string): number {
  const m = text.match(HEX_OR_RGB_RE)
  return m ? m.length : 0
}

// Property -> the ONE token this lock authorizes for it. A rule that declares the property with
// any OTHER value (raw hex, a different var(), or the forbidden --ms-color-warning alias) fails.
const PROPERTY_TOKEN: Record<string, string> = {
  'border-color': 'var(--ms-color-comment-active-border)',
  background: 'var(--ms-color-comment-active-bg)',
  color: 'var(--ms-color-comment-active-text)',
}

function declarationsOf(body: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const decl of body.split(';')) {
    const idx = decl.indexOf(':')
    if (idx === -1) continue
    const prop = decl.slice(0, idx).trim()
    const value = decl.slice(idx + 1).trim()
    if (prop) map.set(prop, value)
  }
  return map
}

describe('comment-affordance color consistency guard (CA lock §3.3, RATIFIED)', () => {
  describe('(a) active rules are token-only — no raw hex/rgb, no wrong token', () => {
    it.each(CONSUMER_FILES)('%s', (rel) => {
      const rules = commentActiveRules(rel)
      // Every one of the 10 files DOES have at least one comment-affordance --active selector
      // (Chip/Affordance are opacity-only but still define the rule) — a file with zero matched
      // rules would mean the selector filter regressed, not that the file is clean.
      expect(rules.length).toBeGreaterThan(0)

      for (const rule of rules) {
        expect(hexOrRgbLiteralCount(rule.body)).toBe(0)

        const decls = declarationsOf(rule.body)
        for (const [prop, expected] of Object.entries(PROPERTY_TOKEN)) {
          if (decls.has(prop)) {
            expect(decls.get(prop)).toBe(expected)
          }
        }
      }
    })

    // Encodes the design-lock §2 note verbatim: MetaCommentActionChip and MetaCommentAffordance
    // have NO visual distinction of their own between active/idle (opacity: 1 both ways — the
    // active look comes entirely from the parent button's class, e.g. the drawer's
    // `--comment--active`). Don't invent a state color for them; pin that they stay that way.
    it.each(['src/multitable/components/MetaCommentActionChip.vue', 'src/multitable/components/MetaCommentAffordance.vue'] as const)(
      '%s: --active/--idle carry no color, opacity-only (parent-styled)',
      (rel) => {
        const rules = commentActiveRules(rel)
        expect(rules).toHaveLength(1)
        const decls = declarationsOf(rules[0].body)
        expect(decls.get('opacity')).toBe('1')
        expect(decls.has('color')).toBe(false)
        expect(decls.has('background')).toBe(false)
        expect(decls.has('border-color')).toBe(false)
      },
    )
  })

  describe('(b) resolveCommentAffordanceStateClass is the only state-derivation entry', () => {
    it.each(CONSUMER_FILES)('%s', (rel) => {
      const src = readSrc(rel)
      // Positive half: the file actually goes through the shared util.
      expect(src).toContain("from '../utils/comment-affordance'")
      expect(src).toMatch(/\bresolveCommentAffordanceStateClass\b/)

      // Negative half: outside <style> blocks (where the literal class name legitimately has to
      // appear as a CSS selector), no comment-affordance state class name is hand-rolled — e.g.
      // a template/script literal like `'meta-grid__comment-action--active'` built without going
      // through the util. MetaRecordDrawer's own `tab--active` class (an unrelated Details/
      // History tab toggle) is a real hand-rolled --active in this exact file, proving the regex
      // isn't vacuous — it must NOT false-positive on it because it has no "comment" in the name.
      const nonStyleSrc = src.replace(STYLE_BLOCK_RE, ' ')
      const handRolled = nonStyleSrc.match(/[\w-]*comment[\w-]*--(active|idle)\b/gi) || []
      expect(handRolled).toEqual([])
    })
  })

  describe('tokens.css defines the exact RATIFIED comment-active trio (OD-CA-1 = A)', () => {
    it('pins the three token declarations (whitespace-tolerant — a formatter pass may re-align the block\'s hand-aligned colons without changing values)', () => {
      const tokens = readFileSync(join(__dirname, '..', 'src/styles/tokens.css'), 'utf8')
      expect(tokens).toMatch(/--ms-color-comment-active-border:\s*#f59e0b;/)
      expect(tokens).toMatch(/--ms-color-comment-active-bg:\s*#fff7ed;/)
      expect(tokens).toMatch(/--ms-color-comment-active-text:\s*#b45309;/)
    })
  })

  // Positive-control self-tests: fixtures that PROVE the extraction/detection helpers actually
  // fire on the exact defects this guard exists to catch. Complements (does not replace) the
  // one-time live-file mutation proof described in the PR body — these fixtures stay in the repo
  // permanently so a future refactor of the helpers above can't silently regress them to
  // "always pass" (same rationale as ui-foundation-style-guard.spec.ts's "helper regressions").
  describe('helper self-tests (positive control)', () => {
    it('flags a raw hex planted into a comment-active rule', () => {
      const fixture = `<style scoped>\n.meta-x__comment-btn--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }\n</style>`
      const rules = extractStyleBlocks(fixture)
        .map(stripCssComments)
        .flatMap(extractRules)
        .filter((r) => COMMENT_ACTIVE_SELECTOR_RE.test(r.selector))
      expect(rules).toHaveLength(1)
      expect(hexOrRgbLiteralCount(rules[0].body)).toBe(3)
    })

    it('flags a rule that swaps in a DIFFERENT (wrong) token, e.g. --ms-color-warning', () => {
      const fixture = `<style scoped>\n.meta-x__comment-btn--active { border-color: var(--ms-color-warning); background: var(--ms-color-comment-active-bg); color: var(--ms-color-comment-active-text); }\n</style>`
      const rules = extractStyleBlocks(fixture)
        .map(stripCssComments)
        .flatMap(extractRules)
        .filter((r) => COMMENT_ACTIVE_SELECTOR_RE.test(r.selector))
      expect(rules).toHaveLength(1)
      const decls = declarationsOf(rules[0].body)
      expect(decls.get('border-color')).not.toBe('var(--ms-color-comment-active-border)')
    })

    it('passes a rule that correctly uses all three tokens', () => {
      const fixture = `<style scoped>\n.meta-x__comment-btn--active { border-color: var(--ms-color-comment-active-border); background: var(--ms-color-comment-active-bg); color: var(--ms-color-comment-active-text); }\n</style>`
      const rules = extractStyleBlocks(fixture)
        .map(stripCssComments)
        .flatMap(extractRules)
        .filter((r) => COMMENT_ACTIVE_SELECTOR_RE.test(r.selector))
      expect(rules).toHaveLength(1)
      expect(hexOrRgbLiteralCount(rules[0].body)).toBe(0)
      const decls = declarationsOf(rules[0].body)
      for (const [prop, expected] of Object.entries(PROPERTY_TOKEN)) {
        expect(decls.get(prop)).toBe(expected)
      }
    })

    it('does not false-positive on an unrelated --active selector without "comment" in it', () => {
      const fixture = `<style scoped>\n.meta-record-drawer__tab--active { background: #111827; color: #fff; }\n</style>`
      const rules = extractStyleBlocks(fixture).flatMap(extractRules).filter((r) => COMMENT_ACTIVE_SELECTOR_RE.test(r.selector))
      expect(rules).toEqual([])
    })

    it('ignores a hex value mentioned only inside a CSS comment (not a live declaration)', () => {
      const fixture = `<style scoped>\n.meta-x__comment-btn--active {\n  /* was #1d4ed8 before the token migration */\n  color: var(--ms-color-comment-active-text);\n}\n</style>`
      const rules = extractStyleBlocks(fixture)
        .map(stripCssComments)
        .flatMap(extractRules)
        .filter((r) => COMMENT_ACTIVE_SELECTOR_RE.test(r.selector))
      expect(rules).toHaveLength(1)
      expect(hexOrRgbLiteralCount(rules[0].body)).toBe(0)
    })

    it('flags a hand-rolled comment-affordance state class built outside the util', () => {
      const fixture = `<script setup>\nconst rootClass = isActive.value ? 'meta-x__comment-thing--active' : 'meta-x__comment-thing--idle'\n</script>\n<style scoped>\n.meta-x__comment-thing--active { color: var(--ms-color-comment-active-text); }\n</style>`
      const nonStyleSrc = fixture.replace(STYLE_BLOCK_RE, ' ')
      const handRolled = nonStyleSrc.match(/[\w-]*comment[\w-]*--(active|idle)\b/gi) || []
      expect(handRolled.length).toBeGreaterThan(0)
    })
  })
})
