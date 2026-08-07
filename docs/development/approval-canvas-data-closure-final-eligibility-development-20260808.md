# Approval Canvas + Data Closure — Final Eligibility Development (2026-08-08)

**Status:** ENGINEERING-READY FOR PRODUCT FINAL (owner UAT + staged flag ON still required)  
**Branch:** `claude/approval-canvas-final-engineering-20260808`  
**Base:** `origin/main@7c7d550dbfba175a8c29afe0f59ba06b2287303d`  
**Exact product head:** `6e98b36cfcd774465af32bd9fcb94f96c406d9ea`  
**Authority:**  
- `docs/development/approval-canvas-v2-development-plan-20260720.md` (D0–D11 + G gates; status remains PROPOSED for G0 owner ratify)  
- `docs/development/approval-canvas-v2-interaction-design-lock-20260721.md` (D0 interaction contract; still PROPOSED until G0)  
- `docs/development/approval-automation-canvas-completion-*-20260722.md` (prior compose stack on main)

This document records the **engineering closeout** that closes remaining G5-C product-path gaps on the dormant Canvas V2 surface and re-asserts G5-R data-closure invariants. It does **not** enable production flags or claim real-tenant UAT.

## 1. Product outcome (engineering scope of this change)

Ordinary-user approval authoring **behind `approvalCanvasV2` (default OFF)** can:

1. Build form fields of every authorable kind via pure form commands (no ordinary-user field-id entry).  
2. Author linear + condition + parallel flows on **one** `preservedGraph` rail (linear steps promote into graph authoring when entering the flow section under Canvas V2).  
3. Configure nodes through the existing inspector / retained list alternative.  
4. Use typed canvas commands for semantic move (and session history for topology insert/remove) so invalid mutations fail closed.  
5. **Undo / redo** on the canvas toolbar, restoring graph + selection.  
6. Keep the structured list as **辅助编辑模式** (S12 accessible alternative retained).  

Data-closure (already on main from the 20260722 stack) remains:

- FWB create / constrained update production paths (flag OFF).  
- Attachment pipeline with flag-OFF positive controls.  
- Template version diff / restore contracts.  
- Number writeback fail-closed (`exact_number_mapping_unavailable`).

## 2. What changed in this delivery

| Area | Change |
|---|---|
| Session history | New pure module `apps/web/src/approvals/approvalAuthoringHistory.ts` — typed canvas-command path + topology snapshot path; promote linear → graph |
| Authoring surface | `TemplateAuthoringView.vue` — default `canvasViewMode = 'canvas'`; undo/redo toolbar; moves via `applyCanvasCommandToSession`; topology via session history; linear promote on flow section when Canvas V2 on |
| Accessible alternative | Toggle label **辅助编辑模式** (`approval-view-list`); not removed |
| Tests | `approval-authoring-history.test.ts`, `approval-g5c-authoring-scenarios.test.ts` (S1–S12 product-path), canvas-inspector list-default fix |
| Docs | This development MD + paired verification MD |

### Explicit non-changes

- No production / staging flag flipped ON.  
- No Vue Flow / ELK adoption (O3 remains open; bespoke layout retained).  
- No number FWB unlock.  
- No optional D7 runtimes (handler nodes, within-node ordered approvers, new assignee sources, readonly enforcement).  
- No free-form edge rewiring / large-graph virtualization / native mobile bottom sheet.  
- G0 owner ratification of D0 is **not** claimed — lock/plan status text left PROPOSED; implementation follows the written lock as the contract for this goal.

## 3. Mapping to D0–D11 / G gates

| Gate / item | Engineering status after this delivery |
|---|---|
| D0 interaction lock | Written contract implemented for history, canvas-first default under flag, retained list alternative; **G0 owner ratify still open** |
| D1 hygiene | Unchanged / still holds (no JSON / raw-id ordinary path) |
| D2-a/b/c | Command algebra + session history **mounted**; empty-branch / invalid-move fail closed |
| D3 Vue Flow/ELK | **Not** started (O3 open); bespoke layout + session commands |
| D4–D6 shell | Intermediate canvas shell + inspector remain; button clusters still present on nodes (documented residual vs lock § no button clusters) |
| D6-f1/f2 form | Pure commands covered for all authorable kinds; full palette drag UI not new this round |
| D8-a version service | Prior main stack; diff/overlay helpers re-tested |
| D8-b canvas dual version UX | Helpers only; full side-by-side product shell residual |
| D9 FWB / attachments | Prior main stack; unit gates re-run |
| G5-C | S1–S12 automated product-path suite added (pure + structural + mounted) |
| G5-R | Flag defaults OFF; number fail-closed; attachment flag-OFF routes re-run |
| G6-C / G6-R | **Owner-only** — real UAT + staged enablement |

### Residual product gaps (honest)

1. Node button clusters not fully retired to inspector + edge-`+` only (D0 §4).  
2. Form palette drag-from-library (D6-f2 visual) not a new surface.  
3. Version side-by-side canvas overlay UX not fully productized in the editor.  
4. G0 / O3 owner decisions still open.  
5. Real-tenant UAT and staged flag ON not executed.

These residuals do **not** block the engineering claim “G5-C product-path algebra + mounted undo/history + canvas-first under flag + G5-R invariants hold.” They **do** block an honest **product FINAL** label until owner gates close.

## 4. Flags (unchanged defaults)

| Flag | Default | Notes |
|---|---|---|
| `APPROVAL_CANVAS_V2_ENABLED` / `approvalCanvasV2` | OFF | Explicit env / session only |
| `APPROVAL_FWB_WRITEBACK_ENABLED` / `approvalFwbWriteback` | OFF | |
| `APPROVAL_ATTACHMENTS_ENABLED` / `approvalAttachments` | OFF | Flag-OFF installs no routes |
| Durable / Class A / Class B | OFF | Not touched |

## 5. Files touched

- `apps/web/src/approvals/approvalAuthoringHistory.ts` (new)  
- `apps/web/src/views/approval/TemplateAuthoringView.vue`  
- `apps/web/tests/approval-authoring-history.test.ts` (new)  
- `apps/web/tests/approval-g5c-authoring-scenarios.test.ts` (new)  
- `apps/web/tests/approval-template-authoring-canvas-inspector.spec.ts`  
- `docs/development/approval-canvas-data-closure-final-eligibility-development-20260808.md`  
- `docs/development/approval-canvas-data-closure-final-eligibility-verification-20260808.md`

## 6. Verdict

**ENGINEERING-READY FOR PRODUCT FINAL eligibility** — remaining engineering for G5-C path tests, mounted undo/history, canvas-first under flag, and G5-R regression is complete on this head.

**NOT product FINAL** until:

1. Owner G0 ratifies D0 (and optionally O3 layout choice).  
2. Real-tenant UAT for authoring + FWB + attachments + version restore.  
3. Staged flag enablement with observation (durable → Class A/B → FWB → attachments/Canvas).
