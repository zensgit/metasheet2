/**
 * FS-1 fix — the W4 approval-canvas closeout's single FAIL
 * (docs/development/approval-remaining-dev-verification-report-20260820.md §5.1; NOT the same
 * finding as "FAIL-1" in approval-parity-verification-report-20260818.md, which names the
 * unrelated approval-inspector-keyboard.spec.ts harness rot, already fixed — this file
 * deliberately avoids reusing that numeric label for a different defect).
 *
 * RATIFIED criterion violated: approval-canvas-v2-interaction-design-lock-20260721.md:366
 * ("Long labels" row, scope explicitly includes "Node cards"): "Truncate with ellipsis at
 * component limits (§14); full text on hover/focus tooltip, in the inspector, and in accessible
 * names." THREE legs — §5.1 scopes the FAIL to the FIRST only (hover/focus tooltip), and this
 * file tests ONLY that leg. The "in the inspector" leg (§5.1: "looks satisfied... not
 * click-through-verified") and the "in accessible names" leg (§5.1's FS-7 — a DIFFERENT defect:
 * the parent `role="button"` div's own `aria-label` overrides the whole subtree's accessible
 * name per standard accname computation, so the summary is never exposed via the accessible NAME
 * — "与 tooltip 腿是两个问题，混成一条就会重蹈「错归类被命名成天花板」", explicitly required to
 * stay a SEPARATE slice) are both OUT OF SCOPE here, on purpose.
 *
 * The flow-canvas node card's summary line is CSS-ellipsis-truncated
 * (`.template-authoring__canvas-node-summary` — `overflow: hidden; text-overflow: ellipsis;
 * white-space: nowrap`, see ApprovalFlowCanvas.vue's `<style>`) but shipped with NO way to recover
 * the full text — not on mouse hover, not on keyboard focus. The fix wraps the card's existing
 * focusable selector (`role="button" tabindex="0"`, unchanged) in `<el-tooltip
 * :trigger="['hover', 'focus']">` — Element Plus's own default `trigger` is `'hover'` ONLY
 * (confirmed by reading `element-plus/es/components/tooltip/src/trigger2.mjs`: the trigger
 * component's `onFocus`/`onBlur` handlers are gated by `whenTrigger(trigger, 'focus', …)`, so a
 * bare `<el-tooltip>` stays silently hover-only), so this file's whole job is proving the FOCUS
 * half actually works — the a11y half is the point of the fix, not a side effect of it.
 *
 * MOUNT STRATEGY: `ApprovalFlowCanvas.vue` is mounted DIRECTLY (not via the full
 * `TemplateAuthoringView`) with a minimal typed prop fixture — this is the first spec to do so;
 * no existing prop-fixture precedent existed for this component's ~24 required props (a scan of
 * `apps/web/tests/*.ts` for `ApprovalFlowCanvas` found only structural source-scans, never a
 * mount). `ElTooltip` is registered as a REAL Element Plus component (`app.component('ElTooltip',
 * ElTooltip)`, no stub) — this test exists specifically to exercise its genuine trigger/aria
 * mechanics, so stubbing it would test nothing. Every OTHER `el-*` tag in the template (el-button,
 * el-alert, el-icon, …) is deliberately left UNREGISTERED — Vue's own fallback for an unresolved
 * component is to render the tag literally as a wrapping DOM element (verified empirically), which
 * is harmless here because nothing below queries across that boundary (only `[data-testid=...]`
 * descendant selectors, confirmed against every other spec that already mounts a canvas node card
 * region — none uses a direct-child (`>`) or `.children[n]`/`firstElementChild` selector near
 * `.template-authoring__canvas-node`, so the unregistered-el-tooltip wrapper this fix ALSO adds to
 * every OTHER mounted spec that renders this component cannot break any existing assertion; ran
 * the six specs that mount `TemplateAuthoringView`/`ApprovalFlowCanvas` under jsdom after this
 * change landed — see the PR body for the full pass list).
 *
 * WHAT JSDOM CAN PROVE (asserted below, real Element Plus runtime — not a source-text regex):
 *   - the tooltip's rendered popper content carries the exact FULL summary string (Element Plus
 *     renders tooltip content into the DOM unconditionally when `NODE_ENV === 'test'` — see
 *     `content2.mjs`'s `persistentRef` — so it's queryable without ever opening the tooltip);
 *   - the trigger is really focusable (`tabIndex === 0`, `document.activeElement` actually moves
 *     to it on `.focus()` — a real jsdom focus, not a synthetic dispatch standing in for one) AND
 *     that focusing it flips the REAL open state: `aria-describedby` on the trigger appears and
 *     equals the popper content's `id` (Element Plus's own `ElPopperTrigger` sets this via
 *     `el.setAttribute` only once `props.open` is true — this is DOM mutation driven by genuine
 *     `focus`/`blur` event handling inside the library, not anything this test fabricates), and
 *     the popper content's `aria-hidden` flips `true` -> `false` -> `true` across focus/blur;
 *   - hover (`mouseenter`/`mouseleave`) independently opens/closes the SAME tooltip — proving the
 *     fix is hover-AND-focus, not a focus-only regression of the previously-working hover case.
 *
 * WHAT THIS FILE DOES NOT AND CANNOT PROVE (jsdom has no layout engine — honest boundary, not
 * silently dropped): that the summary text is actually CLIPPED on screen by the CSS ellipsis
 * (jsdom's `getBoundingClientRect`/`scrollWidth` are always 0, so there is no truncation to
 * measure); that a real mouse `:hover` pseudo-class (as opposed to a synthetic `mouseenter`
 * dispatch standing in for it) opens the tooltip; that the popper's real screen position avoids
 * viewport collision. Closing this needs a real-Chromium harness. **No existing browser-verify
 * spec covers this surface**: `apps/web/verification/approval-inspector-keyboard.spec.ts` — this
 * repo's one approval-scoped real-Chromium harness — mounts ONLY `ApprovalCanvasNodeInspector.vue`
 * + `ApprovalGraphNodeConfigEditor.vue` (confirmed by reading its harness file), never
 * `ApprovalFlowCanvas.vue`'s node cards. Building a NEW harness (`.html` + `.ts` mount script +
 * `tsconfig.verification-approval.json` include + workflow paths wiring) is deliberately OUT OF
 * SCOPE for this bounded fix slice — scoped out explicitly, not silently skipped; a future slice
 * that needs the visual leg should follow the `approval-inspector-keyboard-harness.ts` pattern.
 *
 * MUTATION EVIDENCE (see PR body for the actual red/green run): reverting `:trigger="['hover',
 * 'focus']"` to Element Plus's bare default (drop the `trigger` binding entirely, i.e. plain
 * `<el-tooltip>`) turns ONLY the "keyboard focus" `it()` red — "hover still opens" stays GREEN.
 * That asymmetry is the discriminating proof that this spec tests the FOCUS half specifically,
 * not just "a tooltip exists somewhere".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { ElTooltip } from 'element-plus'
import ApprovalFlowCanvas from '../src/approvals/components/ApprovalFlowCanvas.vue'
import type { GraphLayout } from '../src/approvals/graphLayout'
import type { ApprovalNode } from '../src/types/approval'

// A deliberately long, values-free business summary — long enough that a real 264px card would
// CSS-ellipsis it (measured against the shipped `.template-authoring__canvas-node` width), and
// containing zero raw ids/keys (no bare uuid/numeric-id token) — mirrors what
// `canvasNodeCardSummary()` in TemplateAuthoringView.vue actually renders (node-config-derived
// business text, e.g. "指定成员：..." / "条件：...", never a raw directory id).
const LONG_SUMMARY =
  '审批人：财务部经理、行政部经理、总经办秘书（共 3 人，按顺序依次审批，任一人拒绝则整单驳回，超时 48 小时自动提醒）'

const NODE_KEY = 'app_1'

function buildLayout(): GraphLayout {
  return { nodes: [{ key: NODE_KEY, x: 0, y: 0, layer: 0, order: 0 }], width: 400, height: 200 }
}

function buildNode(): ApprovalNode {
  return { key: NODE_KEY, type: 'approval', name: '审批节点', config: {} }
}

describe('ApprovalFlowCanvas node-card summary tooltip (W4 approval-canvas closeout gap)', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.useRealTimers()
  })

  function mount(): { trigger: HTMLElement; tooltipContent: HTMLElement } {
    const layout = buildLayout()
    const Host = defineComponent({
      setup: () => () =>
        h(ApprovalFlowCanvas, {
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
          minimapWidth: 100,
          minimapHeight: 60,
          graphNodeLabel: () => '审批节点',
          canvasNodeSummary: () => LONG_SUMMARY,
          nodeTypeLabel: () => '审批',
          canvasNodeByKey: () => buildNode(),
          canMoveCanvasNode: () => false,
          canInsertParallelOnEdge: () => false,
          canInsertHandlerOnEdge: () => false,
          canvasMoveTargetLabel: () => '',
        }),
    })
    app = createApp(Host)
    app.component('ElTooltip', ElTooltip)
    app.mount(container!)

    const trigger = document.querySelector('[data-testid="approval-canvas-node-select"]') as HTMLElement | null
    const tooltipContent = document.querySelector(
      '.template-authoring__canvas-node-summary-tooltip',
    ) as HTMLElement | null
    if (!trigger) throw new Error('fixture broken: node-select trigger not found')
    if (!tooltipContent) throw new Error('fixture broken: tooltip content not found')
    return { trigger, tooltipContent }
  }

  it('(a) the tooltip mechanism carries the EXACT full, untruncated, values-free summary — same string as the visible (CSS-truncated) card text', async () => {
    const { trigger, tooltipContent } = mount()
    await nextTick()

    const inlineSpan = trigger.querySelector('.template-authoring__canvas-node-summary')
    expect(inlineSpan?.textContent?.trim()).toBe(LONG_SUMMARY)
    // The tooltip mechanism's own content — not a second, independently-derived copy.
    expect(tooltipContent.textContent?.trim()).toBe(LONG_SUMMARY)
    // Values-free sanity on the fixture itself: no bare numeric/uuid-shaped id token in the string
    // that would make this fixture an accidental raw-id-render false negative for the census guard.
    expect(LONG_SUMMARY).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-/i)
    expect(LONG_SUMMARY).not.toMatch(/\buser_\d+\b/)
  })

  it('(b) reachable by keyboard focus: the trigger is a real tabbable element, and focusing it opens the tooltip via the SAME aria-describedby linkage el-tooltip provides on open', async () => {
    const { trigger, tooltipContent } = mount()
    await nextTick()

    // Focusability, independent of any tooltip behavior.
    expect(trigger.getAttribute('role')).toBe('button')
    expect(trigger.tabIndex).toBe(0)

    // Baseline: closed before any interaction.
    expect(trigger.getAttribute('aria-describedby')).toBeNull()
    expect(tooltipContent.getAttribute('aria-hidden')).toBe('true')

    vi.useFakeTimers()
    trigger.focus()
    expect(document.activeElement).toBe(trigger) // a REAL DOM focus move, not a synthetic stand-in
    await vi.runAllTimersAsync()
    await nextTick()

    const describedBy = trigger.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(describedBy).toBe(tooltipContent.id)
    expect(tooltipContent.getAttribute('aria-hidden')).toBe('false')

    trigger.blur()
    await vi.runAllTimersAsync()
    await nextTick()
    expect(trigger.getAttribute('aria-describedby')).toBeNull()
    expect(tooltipContent.getAttribute('aria-hidden')).toBe('true')
  })

  it('hover still opens the SAME tooltip (the fix adds focus — it does not remove the pre-existing hover behavior)', async () => {
    const { trigger, tooltipContent } = mount()
    await nextTick()

    vi.useFakeTimers()
    trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await vi.runAllTimersAsync()
    await nextTick()
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltipContent.id)
    expect(tooltipContent.getAttribute('aria-hidden')).toBe('false')

    trigger.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    await vi.runAllTimersAsync()
    await nextTick()
    expect(trigger.getAttribute('aria-describedby')).toBeNull()
  })

  it('structural pin: the tooltip content is bound to the SAME canvasNodeSummary(pos.key) call the visible card renders (no independent re-derivation, no raw node key)', () => {
    const src = readFileSync(join(__dirname, '../src/approvals/components/ApprovalFlowCanvas.vue'), 'utf8')
    expect(src).toMatch(/<el-tooltip[\s\S]{0,120}:content="canvasNodeSummary\(pos\.key\)"/)
    expect(src).toMatch(/:trigger="\['hover', 'focus'\]"/)
    // Never a raw key/id bound directly as tooltip content.
    expect(src).not.toMatch(/<el-tooltip[\s\S]{0,120}:content="pos\.key"/)
  })
})
