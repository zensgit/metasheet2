import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// UI foundation design-lock (docs/development/ui-foundation-design-lock-20260706.md §6 UF-6):
// "ESLint 禁 style="（存量 57 处清零）+ 表单布局工具类；同时加「新增硬编码 hex」lint"。
//
// Mechanism note: `vue/no-static-inline-styles` IS configured (apps/web/.eslintrc.cjs override,
// scoped to this same file set) — but apps/web's `lint` script runs an explicit file list that
// today covers only 2 of these 21 files, and no ESLint rule can police "hex/rgb literal inside a
// <style> block" at all. So this fs-level source guard is the CI-enforced gate for both halves
// of UF-6; the ESLint rule is IDE feedback + future-glob insurance.
//
// Scope = the exact UF surface set named in the design-lock: the approval views, the shared
// automation rule editor/manager, the workflow hub/designer, and the shared layout/status
// components. This is a TARGETED gate, not a whole-repo lint — the rest of the app is
// unmigrated and tracked separately (design-lock §6 slice ladder).
const TARGET_FILES = [
  'src/views/approval/ApprovalCardDecisionView.vue',
  'src/views/approval/ApprovalCenterTable.vue',
  'src/views/approval/ApprovalCenterView.vue',
  'src/views/approval/ApprovalDetailView.vue',
  'src/views/approval/ApprovalMetricsView.vue',
  'src/views/approval/ApprovalMobileList.vue',
  'src/views/approval/ApprovalNewView.vue',
  'src/views/approval/DelegationSettingsView.vue',
  'src/views/approval/MyDelegationView.vue',
  'src/views/approval/TemplateAuthoringView.vue',
  'src/views/approval/TemplateCenterView.vue',
  'src/views/approval/TemplateDetailView.vue',
  'src/views/ApprovalInboxView.vue',
  'src/views/AutomationExecutionsView.vue',
  'src/views/WorkflowHubView.vue',
  'src/views/WorkflowDesigner.vue',
  'src/components/layout/PageHeader.vue',
  'src/components/layout/PageShell.vue',
  'src/components/status/StatusTag.vue',
  'src/components/status/EmptyState.vue',
  'src/multitable/components/MetaAutomationManager.vue',
  'src/multitable/components/MetaAutomationRuleEditor.vue',
] as const

// Per-file allowlist for counts that are legitimately un-clearable. Keep this EMPTY unless a
// concrete, justified exception shows up — every entry must carry a one-line reason. The UF-6
// purge cleared all 21 target files to zero on both axes, so both maps start empty; a future PR
// that needs an exception adds `'src/views/.../Foo.vue': N, // reason` here, never widens the
// regex or silently allowlists a whole file.
const STATIC_STYLE_ALLOWLIST: Partial<Record<(typeof TARGET_FILES)[number], number>> = {}

const HEX_COLOR_ALLOWLIST: Partial<Record<(typeof TARGET_FILES)[number], number>> = {}

function readTarget(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

// Matches a static `style="..."` attribute but not the Vue binding `:style="..."` /
// `v-bind:style="..."` (both end in `:style="`, so a negative lookbehind on the colon is enough —
// no word-boundary trick needed since whitespace/`"`/`<` all precede a genuine static attribute).
const STATIC_STYLE_RE = /(?<!:)style="/g

function countStaticStyleAttrs(src: string): number {
  const matches = src.match(STATIC_STYLE_RE)
  return matches ? matches.length : 0
}

const STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/g

function extractStyleBlocks(src: string): string[] {
  const blocks: string[] = []
  let match: RegExpExecArray | null
  STYLE_BLOCK_RE.lastIndex = 0
  while ((match = STYLE_BLOCK_RE.exec(src))) {
    blocks.push(match[1])
  }
  return blocks
}

// Hex literals (#abc / #aabbcc / #aabbccdd) OR rgb()/rgba() functional notation, anywhere in a
// <style> block — including inside a `var(--x, <literal>)` fallback, which is exactly the escape
// hatch this guard exists to close. `var(...)` references to other custom properties, and the
// bare keywords transparent/inherit/currentColor/none, are unaffected (they never match either
// pattern) — those are the only allowed color-authoring forms left after the UF-1..UF-3 tokens.
function countHexOrRgbLiterals(styleBlock: string): number {
  const hexMatches = styleBlock.match(/#[0-9a-fA-F]{3,8}\b/g)
  const rgbMatches = styleBlock.match(/\brgba?\(/g)
  return (hexMatches ? hexMatches.length : 0) + (rgbMatches ? rgbMatches.length : 0)
}

describe('UI foundation style guard (UF-6)', () => {
  describe('zero static style= attributes', () => {
    it.each(TARGET_FILES)('%s', (rel) => {
      const src = readTarget(rel)
      const allowed = STATIC_STYLE_ALLOWLIST[rel] ?? 0
      expect(countStaticStyleAttrs(src)).toBe(allowed)
    })
  })

  describe('zero hex/rgb() color literals in <style> blocks', () => {
    it.each(TARGET_FILES)('%s', (rel) => {
      const src = readTarget(rel)
      const blocks = extractStyleBlocks(src)
      const total = blocks.reduce((sum, block) => sum + countHexOrRgbLiterals(block), 0)
      const allowed = HEX_COLOR_ALLOWLIST[rel] ?? 0
      expect(total).toBe(allowed)
    })
  })

  // Regex self-checks (not a substitute for the mutation test run against the real tree — see
  // the UF-6 PR body — but pins the two counting helpers' behavior so a future refactor of this
  // spec can't accidentally regress them to "always pass").
  describe('helper regressions', () => {
    it('does not flag a Vue :style binding as a static style=', () => {
      const fixture = '<div :style="{ color: x }"></div>'
      expect(countStaticStyleAttrs(fixture)).toBe(0)
    })

    it('flags a static style= attribute', () => {
      const fixture = '<div style="width: 100%"></div>'
      expect(countStaticStyleAttrs(fixture)).toBe(1)
    })

    it('does not flag var() references to other custom properties', () => {
      const fixture = '<style scoped>.x { color: var(--ms-color-danger); }</style>'
      const blocks = extractStyleBlocks(fixture)
      const total = blocks.reduce((sum, block) => sum + countHexOrRgbLiterals(block), 0)
      expect(total).toBe(0)
    })

    it('flags a hex literal used as a var() fallback', () => {
      const fixture = '<style scoped>.x { color: var(--ms-color-danger, #dc2626); }</style>'
      const blocks = extractStyleBlocks(fixture)
      const total = blocks.reduce((sum, block) => sum + countHexOrRgbLiterals(block), 0)
      expect(total).toBe(1)
    })

    it('flags an rgba() literal', () => {
      const fixture = '<style scoped>.x { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }</style>'
      const blocks = extractStyleBlocks(fixture)
      const total = blocks.reduce((sum, block) => sum + countHexOrRgbLiterals(block), 0)
      expect(total).toBe(1)
    })
  })
})
