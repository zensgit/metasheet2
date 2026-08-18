# Approval Canvas Residual Parallel Engineering (2026-08-08)

**Status:** DONE (wave-1)  
**PLAN_ID:** `6fa2fbf6`  
**Base:** `origin/main` at residual start (post #4806 / #4811 / #4812)  
**Merged:** #4815 (PR1 form history), #4816 (PR2 dual canvas), #4817 (PR3 G5-C CI/smoke)  
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

### PR 1: Form session undo/redo — DONE (#4815)

- **Description:** Add pure `approvalFormAuthoringHistory` snapshot history for form field list mutations (add/remove/reorder/type change via existing helpers). Wire form-section undo/redo toolbar in `TemplateAuthoringView` (Canvas V2 or always-available for form section; keep canvas history separate). Fail closed on empty stacks. No field-id ordinary-user entry. Tests pure + mounted pin.
- **Files/components affected:** `apps/web/src/approvals/approvalFormAuthoringHistory.ts` (new), `apps/web/src/views/approval/TemplateAuthoringView.vue`, `apps/web/tests/approval-form-authoring-history.test.ts` (new), optional G5-C structural pin  
- **Dependencies:** None  

### PR 2: Dual-canvas version compare (D8-b residual) — DONE (#4816)

- **Description:** Pure model builds side-by-side before/after graph layouts + change badges from existing diff/overlay inputs. Wire a **双画布** mode in `TemplateDetailView` version panel (in addition to list + single overlay). Read-only; no restore semantics change; no network contract change. Tests pure + lightweight mount/summary pins.
- **Files/components affected:** `apps/web/src/approvals/approvalVersionDualCanvas.ts` (new), `apps/web/src/views/approval/TemplateDetailView.vue`, `apps/web/tests/approval-version-dual-canvas.test.ts` (new)  
- **Dependencies:** None  

### PR 3: G5-C CI canaries + owner smoke harness — DONE (#4817)

- **Description:** Expand CI canaries for new residual test files once present; add `scripts/ops/approval-canvas-owner-uat-smoke.sh` checklist runner (values-free, flag-aware, does not flip env). Keep gate workflow honest. Update residual design ledger statuses after land.
- **Files/components affected:** `.github/workflows/approval-web-guard.yml`, `apps/web/scripts/run-required-web-tests.sh`, `scripts/ops/approval-canvas-owner-uat-smoke.sh` (new), `.grok/workflows/approval-canvas-final-gate.rhai`, this design doc  
- **Dependencies:** None (landed with optional `test -f` residual canaries; wave-3 PR6 promotes to always-on)

## Execute order

```text
Level 0 parallel: PR1 || PR2 || PR3
```

Max parallelism: 3. Stack assembly optional (independent PRs into main).

## Autonomy

Agents may implement, test, push, open draft PRs, arm auto-merge when green. Must not flip flags or claim product FINAL.

## CI canary policy (PR3 → wave-3 PR6)

- Existing Canvas V2 canaries remain required always-on:
  `approval-canvas-commands`, `approval-form-commands`, `approval-authoring-history`,
  `approval-g5c-authoring-scenarios`, `approval-version-read-summary`.
- Residual canaries (promoted always-on in wave-3 after files landed; palette-focus added in residual closeout):
  - `approval-form-authoring-history` (#4815)
  - `approval-version-dual-canvas` (#4816)
  - `approval-flow-canvas-a11y` (#4818)
  - `approval-canvas-inspector-a11y` (#4819)
  - `approval-form-palette-focus` (#4825)
- Owner smoke: `SKIP_TESTS=1 scripts/ops/approval-canvas-owner-uat-smoke.sh` for values-free checks;
  omit `SKIP_TESTS` to also run focused history + G5-C + residual vitest when `pnpm` is available.

## Follow-on

- Wave-2 a11y polish: see `approval-canvas-residual-parallel-wave2-design-20260808.md` (DONE #4818–#4819).
- Wave-3 canaries/smoke + remaining polish: see `approval-canvas-residual-parallel-wave3-design-20260808.md` (DONE #4823–#4826).
- Residual as-built closeout (no UAT / flag ON / product FINAL): `approval-canvas-residual-parallel-closeout-verification-20260815.md`.
