# Approval Canvas Residual Parallel Engineering (2026-08-08)

**Status:** AUTHORITATIVE FOR PARALLEL EXECUTION  
**PLAN_ID:** `6fa2fbf6`  
**Base:** `origin/main` at residual start (post #4806 / #4811 / #4812)  
**Flags:** remain default OFF. No product FINAL claim. No G0 ratify flip.

## Goal

Ship residual product polish after Canvas final-eligibility land, as **three independent lanes** with no shared hot file:

| Lane | Owns | Does not touch |
|---|---|---|
| **PR1** Form session history | `approvalFormAuthoringHistory.ts`, `TemplateAuthoringView.vue` form section, form history tests | `TemplateDetailView.vue` |
| **PR2** Dual-canvas version compare | pure dual-canvas model + `TemplateDetailView.vue` version panel | `TemplateAuthoringView.vue` |
| **PR3** G5-C CI + owner smoke | tests, CI canaries, scripts, this design ledger | product Vue authoring/detail |

## Non-goals

- G0 / UAT / staged flag ON  
- D3 Vue Flow / ELK (O3)  
- Number FWB unlock / D7  
- Product FINAL claim  

## PR Plan

### PR 1: Form session undo/redo — OPEN

- **Description:** Add pure `approvalFormAuthoringHistory` snapshot history for form field list mutations (add/remove/reorder/type change via existing helpers). Wire form-section undo/redo toolbar in `TemplateAuthoringView` (Canvas V2 or always-available for form section; keep canvas history separate). Fail closed on empty stacks. No field-id ordinary-user entry. Tests pure + mounted pin.
- **Files/components affected:** `apps/web/src/approvals/approvalFormAuthoringHistory.ts` (new), `apps/web/src/views/approval/TemplateAuthoringView.vue`, `apps/web/tests/approval-form-authoring-history.test.ts` (new), optional G5-C structural pin  
- **Dependencies:** None  

### PR 2: Dual-canvas version compare (D8-b residual) — OPEN

- **Description:** Pure model builds side-by-side before/after graph layouts + change badges from existing diff/overlay inputs. Wire a **双画布** mode in `TemplateDetailView` version panel (in addition to list + single overlay). Read-only; no restore semantics change; no network contract change. Tests pure + lightweight mount/summary pins.
- **Files/components affected:** `apps/web/src/approvals/approvalVersionDualCanvas.ts` (new), `apps/web/src/views/approval/TemplateDetailView.vue`, `apps/web/tests/approval-version-dual-canvas.test.ts` (new)  
- **Dependencies:** None  

### PR 3: G5-C CI canaries + owner smoke harness — OPEN

- **Description:** Expand CI canaries for new residual test files once present; add `scripts/ops/approval-canvas-owner-uat-smoke.sh` checklist runner (values-free, flag-aware, does not flip env). Keep gate workflow honest. Update residual design ledger statuses after land.
- **Files/components affected:** `.github/workflows/approval-web-guard.yml`, `apps/web/scripts/run-required-web-tests.sh`, `scripts/ops/approval-canvas-owner-uat-smoke.sh` (new), `.grok/workflows/approval-canvas-final-gate.rhai`, this design doc  
- **Dependencies:** None (can land before PR1/PR2; canaries no-op if files missing until follow-up, or list only existing + document pending)

## Execute order

```text
Level 0 parallel: PR1 || PR2 || PR3
```

Max parallelism: 3. Stack assembly optional (independent PRs into main).

## Autonomy

Agents may implement, test, push, open draft PRs, arm auto-merge when green. Must not flip flags or claim product FINAL.

## CI canary policy (PR3)

- Existing Canvas V2 canaries remain required always-on:
  `approval-canvas-commands`, `approval-form-commands`, `approval-authoring-history`,
  `approval-g5c-authoring-scenarios`, `approval-version-read-summary`.
- Residual canaries use `test -f` guards so this PR stays green alone:
  - `apps/web/tests/approval-form-authoring-history.test.ts` (PR1)
  - `apps/web/tests/approval-version-dual-canvas.test.ts` (PR2)
- Owner smoke: `SKIP_TESTS=1 scripts/ops/approval-canvas-owner-uat-smoke.sh` for values-free checks;
  omit `SKIP_TESTS` to also run focused history + G5-C vitest when `pnpm` is available.
