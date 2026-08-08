# Approval Canvas Residual Parallel — Wave 2 (2026-08-08)

**Status:** DONE  
**PLAN_ID:** `6fa2fbf6-w2`  
**Depends on wave-1 PRs:** none for file ownership (wave-1 is #4815 form history, #4816 dual canvas, #4817 CI/smoke)  
**Merged:** #4818 (PR4 flow canvas a11y), #4819 (PR5 inspector topology a11y)  
**Flags:** default OFF. No product FINAL.

## Goal

While wave-1 CI runs, ship **two more independent a11y/polish lanes** that do **not** touch:

- `TemplateAuthoringView.vue` (#4815)
- `TemplateDetailView.vue` (#4816)
- CI / smoke scripts (#4817)

| Lane | Owns | Parallel with |
|---|---|---|
| **PR4** Flow canvas a11y | `ApprovalFlowCanvas.vue` + focused tests | PR5, wave-1 |
| **PR5** Inspector topology a11y | `ApprovalCanvasNodeInspector.vue` + focused tests | PR4, wave-1 |

## Non-goals

G0 / UAT / flags / D3 / product FINAL / form undo wiring / dual-canvas detail panel.

## PR Plan

### PR 4: Flow canvas edge-insert a11y — DONE (#4818)

- **Description:** Ensure every edge mid-point `+` control has an explicit accessible name (aria-label business copy, no edge keys). Keyboard focusable (`tabindex=0` or native button). Add/extend pure structural or shallow mount tests under `apps/web/tests/`. No graph semantic changes.
- **Files/components affected:** `apps/web/src/approvals/components/ApprovalFlowCanvas.vue`, `apps/web/tests/approval-flow-canvas-a11y.test.ts` (new) or extend existing canvas inspector tests without touching TemplateAuthoringView  
- **Dependencies:** None  

### PR 5: Inspector topology a11y — DONE (#4819)

- **Description:** Topology insert/remove controls in `ApprovalCanvasNodeInspector` get stable `data-testid` (if missing) + aria-labels in business language. No command algebra change. Tests structural or shallow.
- **Files/components affected:** `apps/web/src/approvals/components/ApprovalCanvasNodeInspector.vue`, `apps/web/tests/approval-canvas-inspector-a11y.test.ts` (new)  
- **Dependencies:** None  

## Execute order

```text
Level 0: PR4 || PR5   (and continue babysit wave-1 #4815||#4816||#4817)
```

## Follow-on

Wave-3 (`6fa2fbf6-w3`): promote residual canaries always-on + smoke honesty + additional polish lanes — see `approval-canvas-residual-parallel-wave3-design-20260808.md`.
