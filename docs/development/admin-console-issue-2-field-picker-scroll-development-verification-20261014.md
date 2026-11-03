# Admin console issue 2 — field picker scroll

- Date: 2026-10-14
- Slice: design-lock ordered slice 2, field-picker half only (`docs/development/admin-console-issues-1-5-design-lock-20261014.md`). Items 4/5 stay the priority line. Password helper (item 1) is out of this slice.
- Contract: neutral synthetic. Customer document and customer data were not read.
- Runtime: CSS only. No install, build, vitest, browser, SSH, network, commit, publish, flag, or workflow change.

## Cause

Header Fields uses shared `MtPopover` (`Teleport` to `body`, `position: fixed`). `computePosition` (`apps/web/src/multitable/ui/MtPopover.vue` 58–77) measures the panel once on open and clamps with an 8px inset:

- `left = max(0, innerWidth - width - 8)` when the border box would pass the right edge; `left = 8` when negative.
- `top = max(0, innerHeight - height - 8)` when the border box would pass the bottom edge.

`.mt-popover` (131–141) has no max size: `padding: var(--ms-space-1) 0` (`--ms-space-1` is 4px) and a 1px border. The field list lived in `.meta-toolbar__field-panel` with padding and `min-width: 200px` only, so a tall list or a long name grew the border box past the viewport. The clamp then pins the origin at 0 and the overflow has no scrollport. `MtPopover` was not changed.

## Change

`.meta-toolbar__field-panel` max size is the clamp budget minus popover chrome:

- Vertical chrome 4+4 padding + 1+1 border = 10, plus the 8px inset → `max-height: calc(100vh - 18px)`.
- Horizontal chrome 1+1 border = 2, plus the 8px inset → `max-width: calc(100vw - 10px)`.
- `overflow: auto` scrolls whichever axis exceeds that cap.
- `.meta-toolbar__field-toggle` is `width: max-content; min-width: 100%; white-space: nowrap`, so a very long name widens the row and scrolls sideways. Short names still fill the panel. No ellipsis.

Checkbox `@change` still emits `toggle-field` and does not clear `showFieldPicker`. Outside click and Escape stay on `MtPopover`. No grid overflow rule was edited.

## Assumptions

- `100vh` / `100vw` match `window.innerHeight` / `window.innerWidth` (Mac overlay scrollbars). A classic scrollbar can make `100vw` wider than `innerWidth`.
- Default placement stays `bottom-start`. The cap is the viewport, not the space under the trigger. A trigger near the bottom still uses the existing upward clamp; this slice does not add a second position pass.
- `getBoundingClientRect` is the border box. Shadow is outside that box and can paint past the viewport edge.
- Neighbor proof remains `apps/web/tests/meta-toolbar-hide-fields-mtpopover-migration.spec.ts` (read only): open, checked = visible, toggle emits and leaves the popover open, Escape, outside mousedown, second trigger click, hidden-count badge. Two short synthetic names. It does not measure 120 rows or a long name.

## NOT RUN (parent Mac)

- `pnpm --filter @metasheet/web exec vitest run tests/meta-toolbar-hide-fields-mtpopover-migration.spec.ts --watch=false`
- Browser, synthetic fields only: 120 rows scroll vertically and the last checkbox is reachable; a very long unbroken name scrolls horizontally and is fully readable; toggling a checkbox leaves the panel open; outside click and Escape still close it; main grid scroll styles unchanged.
- Install, build, type-check, lint, commit, publish.

## Changed paths

- `apps/web/src/multitable/components/MetaToolbar.vue`
- `docs/development/admin-console-issue-2-field-picker-scroll-development-verification-20261014.md`

## Parent native qualification

Frozen code `cc3204d1dbc8c929bcf7f08349698a12537e2b34` matched Mac source full tree/digests. Baseline `d7be3a83a2` reproduced an unbounded4132×3256px list at all three window sizes. Native Chromium compiled the actual MetaToolbar/MtPopover with product tokens and120 synthetic fields, including a521-character unbroken name. At1280×800,800×600 and320×400, panel border boxes stayed inside the viewport, both axes scrolled, the lastcheckbox toggled without closing, horizontal offset moved, Escape and outside mouse click closed normally. Independent grid scroll control remained unchanged; this is a component harness, not a live multitable/customer acceptance.

Two existing hidefields/sort-popover neighbor files:17passed/0failed/0skipped. No new Vitest file, so no new registration required. Sol review `sol-ui-correction-and-field-scroll-review.md` accepted the fieldpanel source at cc (within6fc); its HOLD concerns separate permission UI corrections only. Root quality for latestcombinedsource remains pending. Screenshots and receipts under `artifacts/admin-issues-20261014`; both owned web processes were stopped after checks. No public push/PR/deploy.
