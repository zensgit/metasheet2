# Approval Canvas Residual Parallel — Wave 3 (2026-08-08)

**Status:** AUTHORITATIVE FOR WAVE-3 PARALLEL EXECUTION  
**PLAN_ID:** `6fa2fbf6-w3`  
**Base:** `origin/main` after wave-1 (#4815–#4817) + wave-2 (#4818–#4819)  
**Flags:** default OFF. No product FINAL. No G0 ratify flip.

## Goal

Four independent residual polish lanes with **no shared hot file**:

| Lane | Owns | Does not touch |
|---|---|---|
| **PR6** CI canaries + smoke + ledger closeout | workflows, `run-required-web-tests.sh`, smoke script, residual design MDs | product Vue |
| **PR7** Edge-insert **menu** a11y | `ApprovalFlowCanvas.vue` + a11y test | Authoring/Detail/CI |
| **PR8** Form palette focus-return | `TemplateAuthoringView.vue` form section only | Detail / FlowCanvas / CI |
| **PR9** G5-C structural pins | `approval-g5c-authoring-scenarios.test.ts` only | product Vue sources |

## Non-goals

- G0 / real-tenant UAT / staged flag ON  
- D3 Vue Flow / ELK  
- Product FINAL claim  
- Full dual-canvas editor-embedded chrome beyond TemplateDetailView  

## PR Plan

### PR 6: Promote residual canaries + smoke honesty — OPEN

- **Description:** Residual test files now exist on main. Promote form-history + dual-canvas from optional `test -f` to always-on canaries; add flow-canvas-a11y + inspector-a11y canaries. Update owner smoke to verify residual modules present. Stamp wave-1/2 design ledgers DONE with PR numbers.
- **Files/components affected:** `.github/workflows/approval-web-guard.yml`, `apps/web/scripts/run-required-web-tests.sh`, `scripts/ops/approval-canvas-owner-uat-smoke.sh`, residual design MDs (wave1/2/3)  
- **Dependencies:** None  

### PR 7: Edge-insert menu item a11y — OPEN

- **Description:** Menu buttons for insert approval/condition/parallel get business-language `aria-label` (no edge keys). Fit-to-view control gets aria-label if missing. Expand `approval-flow-canvas-a11y.test.ts` structural pins. No graph semantics.
- **Files/components affected:** `apps/web/src/approvals/components/ApprovalFlowCanvas.vue`, `apps/web/tests/approval-flow-canvas-a11y.test.ts`  
- **Dependencies:** None  

### PR 8: Form palette focus return after add — OPEN

- **Description:** After `addFieldOfType` / structural add, focus the new field row (or set selection) so keyboard/screen-reader authors land on the created field. Optional `aria-live` polite announcement. Wire through existing form history. Tests structural or focused mounted pin for focus/selection.
- **Files/components affected:** `apps/web/src/views/approval/TemplateAuthoringView.vue`, optional `apps/web/tests/approval-form-palette-focus.test.ts`  
- **Dependencies:** None  

### PR 9: G5-C residual structural pins — OPEN

- **Description:** Extend G5-C suite (source-scan style) to pin: form undo/redo testids, dual-canvas testids/module import, edge-insert + inspector a11y labels. No product code.
- **Files/components affected:** `apps/web/tests/approval-g5c-authoring-scenarios.test.ts`  
- **Dependencies:** None  

## Execute order

```text
Level 0 parallel: PR6 || PR7 || PR8 || PR9
```

## Autonomy

Agents implement, test, push, open PRs, arm squash auto-merge. Must not flip flags or claim product FINAL.
