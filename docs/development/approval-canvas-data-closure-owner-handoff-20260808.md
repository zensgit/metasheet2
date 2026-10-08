# Approval Canvas + Data Closure — Owner Handoff (G0 / UAT / staged flags)

**Status:** G0 RATIFIED 2026-08-15 — real-tenant UAT and staged enablement remain open; product FINAL blocked here  
**G0 record:** `docs/development/approval-canvas-g0-ratify-20260815.md`  
**Date:** 2026-08-08  
**Product code land:** https://github.com/zensgit/metasheet2/pull/4806 → `main` `323d7e1afe`  
**Docs land stamp:** https://github.com/zensgit/metasheet2/pull/4811 → `main` `bea44e12d5`  
**Authority locks:**  
- `docs/development/approval-canvas-v2-interaction-design-lock-20260721.md` (**G0 RATIFIED 2026-08-15**)  
- `docs/development/approval-canvas-v2-development-plan-20260720.md` (G0 recorded; O3 DEFER; UAT/flags still owner-controlled)  
**Engineering companions:**  
- `docs/development/approval-canvas-data-closure-final-eligibility-development-20260808.md`  
- `docs/development/approval-canvas-data-closure-final-eligibility-verification-20260808.md`  
- `docs/development/approval-canvas-remaining-engineering-design-20260808.md`

---

## 0. Non-claims (read first)

| Claim | Status |
|---|---|
| Engineering stack for Canvas V2 authoring path + G5-R engineering invariants | **YES — on main** |
| Product FINAL | **NO** |
| G0 ratify of D0 | **YES — 2026-08-15 RATIFY** (see `approval-canvas-g0-ratify-20260815.md`) |
| Real-tenant UAT | **NO — still owner / tenant** |
| Any production / staging flag ON by default | **NO** (`approvalCanvasV2`, FWB, attachments all default OFF) |
| D3 Vue Flow / ELK renderer | **NO — O3 DEFER** |
| Number FWB unlock / optional D7 runtimes | **NO** |

Agents must **not** flip env flags or rewrite lock status from PROPOSED → RATIFIED without an explicit owner decision recorded below.

---

## 1. What is already on main

Squash of #4806 (`323d7e1afe`) delivered, behind flags OFF:

| Surface | Landed |
|---|---|
| Session history + live graph + topology merge | `apps/web/src/approvals/approvalAuthoringHistory.ts` |
| Canvas-first under `approvalCanvasV2` | `TemplateAuthoringView.vue` default `canvasViewMode = 'canvas'` |
| Edge mid-point `+` insert; no canvas node button clusters | `ApprovalFlowCanvas.vue` + inspector topology |
| Form field palette (D6-f2 slice) | `approval-field-palette` |
| Accessible list retained (**辅助编辑模式**) | until S12/G6-C owner window |
| Version read summary (thin D8-b) | `approvalVersionReadSummary.ts` + TemplateDetailView |
| Shell extract | `ApprovalFlowCanvas.vue`, `ApprovalCanvasNodeInspector.vue` |
| CI canaries | `approval-web-guard` + required web-tests list |
| Automated G5-C product-path suite | `approval-g5c-authoring-scenarios.test.ts` (S1–S12 structural + fail-closed) |

**Flags (must stay OFF until staged enablement):**

| Flag / feature | Default | Explicit ON |
|---|---|---|
| Backend Canvas V2 | OFF | `APPROVAL_CANVAS_V2_ENABLED=true` |
| Frontend product feature | `approvalCanvasV2: false` | backend/session features payload only (no silent inference) |
| FWB writeback | OFF | `APPROVAL_FWB_WRITEBACK_ENABLED=true` |
| Attachments pipeline | OFF | `APPROVAL_ATTACHMENTS_ENABLED=true` |

---

## 2. G0 ratify packet (owner decision)

### 2.1 Decision

Copy this block into the PR/issue comment or lock header when decided:

```text
G0 decision for approval-canvas-v2-interaction-design-lock-20260721.md
Date: 2026-08-15
Owner: zensgit
Decision: RATIFY
If RATIFY-WITH-DELTAS, list deltas: (none)
O3 layout engine (optional, independent): DEFER
Notes: Staging Canvas-only UAT (S1–S12) and staged flag enablement remain open. FWB/attachments stay OFF. No product FINAL.
```

Recorded in `docs/development/approval-canvas-g0-ratify-20260815.md`. D0 lock Status is **RATIFIED**. Agents must still not flip runtime flags or claim product FINAL without a later owner decision.

### 2.2 G0 checklist (plan §7 + lock §19) — engineering evidence vs owner judgment

| G0 requirement | Engineering evidence on main | Owner still judges |
|---|---|---|
| One-canvas IA + inspector explicit | Canvas-first under flag; inspector dock; list as 辅助编辑模式 | UX acceptable for product |
| Longest labels fit summaries | Layout/tests exist; no claim of full visual critique pass | Visual/long-label at 1440/1024/390 |
| Condition / parallel / validation / empty / loading / permission / conflict states | Condition/parallel authoring + fail-closed paths tested | Product copy & empty/error UX in real tenant |
| Desktop + narrow layouts defined | Lock §5 + responsive CSS in authoring; Playwright matrix not claimed as owner UAT | Sign off at 1440 / 1280 / 1024 / 390 |
| Touch insert alternative; drag never only path | Edge `+` + inspector topology + list topology | Touch device pass |
| Screen-reader / accessible alternative | **辅助编辑模式** retained (S12 not claiming AT equivalence) | Keep fallback until S12 real AT pass |
| Structured editor retirement decision | Lock: keep ordinary-user entry until S12 + G6-C window | Confirm retirement policy |

### 2.3 Optional O3 (not required for product FINAL of current bespoke canvas)

| Choice | Meaning |
|---|---|
| KEEP_BESPOKE | Current renderer stays; no Vue Flow work |
| ADOPT_VUE_FLOW_ELK | Opens D3 engineering after separate design slice |
| DEFER | No decision; D3 remains BLOCKED |

---

## 3. Real-tenant UAT checklist (G5-C / G5-R)

**Environment:** non-prod tenant with observation; flags OFF until §4.  
**Discipline:** values-free notes (template ids / outcomes only; no form PII dumps).  
**Entry:** product routes `/approval-templates/new` and `/approval-templates/:id/edit` with Canvas V2 temporarily ON in **that** environment only.

### 3.1 Preflight

- [ ] Deploy/build includes `323d7e1afe` or later main tip  
- [ ] Confirm defaults OFF on prod: Canvas / FWB / attachments  
- [ ] Staging (or canary) can set `APPROVAL_CANVAS_V2_ENABLED=true` without touching prod  
- [ ] Backend `normalizeApprovalGraph` rejects invalid graphs (spot-check: bad publish fails closed)  
- [ ] Telemetry/logging redacts form values (or is values-free)

### 3.2 G5-C scenarios (product UI, not pure helpers alone)

| ID | Scenario | Pass criteria | Result | Notes |
|---|---|---|---|---|
| S1 | Form authoring | All authorable field kinds via palette + reorder; no ordinary-user field IDs | ⬜ | |
| S2 | Linear | requester → approval → cc/end publish + execute | ⬜ | |
| S3 | Conditional | two ordered conditions + default selects expected branch | ⬜ | |
| S4 | Parallel all | join waits for all branches | ⬜ | |
| S5 | Parallel any | first completion advances; siblings not corrupted | ⬜ | |
| S6 | Dynamic assignee | manager/role/form-driven + empty fallback visible/correct | ⬜ | |
| S7 | Route preview | dry-run path correct; no instance created | ⬜ | |
| S8 | Hidden-field boundary | hidden holds through submit/preview/snapshot/history | ⬜ | |
| S9 | Version | publish v1/v2; read summary/diff; run v1; restore v1 → new draft | ⬜ | full dual-canvas chrome optional |
| S10 | Legacy round-trip | pre-V2 complex graph/form open+save no semantic drift | ⬜ | |
| S11 | Scale | ~100-node mixed remains operable (pan/zoom/select) | ⬜ | |
| S12 | Accessible | keyboard + list 辅助编辑模式 completes linear + branch edit | ⬜ | SR equivalence optional later |

### 3.3 G5-R scenarios (only when that flag’s own UAT is scheduled)

| ID | Scenario | Flag | Pass criteria | Result |
|---|---|---|---|---|
| R1 | New-record FWB | `APPROVAL_FWB_WRITEBACK_ENABLED` | creates exactly one authorized multitable record | ⬜ |
| R2 | Update FWB | same | approver-confirmed update once on authorized row | ⬜ |
| R3 | Attachment | `APPROVAL_ATTACHMENTS_ENABLED` | bind/survive/writeback; reject bad type/size | ⬜ |
| R4 | Optional D7 | per-feature flag | **out of scope** until separate design lock | — |

Number writeback remains **fail-closed** (`exact_number_mapping_unavailable`) — do not treat number FWB as UAT-passable.

### 3.4 Discriminating negatives (must see fail-closed)

- [ ] Invalid topology / empty required branch cannot publish  
- [ ] Undo at empty history is no-op / closed  
- [ ] Flag OFF: Canvas V2 chrome not primary path; FWB/attachments production paths inert  
- [ ] Stale version restore fails closed (no rewrite of published version)

---

## 4. Staged flag enablement (G6-C / G6-R)

Do **not** enable everything at once. Canvas ON does **not** transitively enable FWB or attachments (plan §7 G6).

| Stage | Action | Observe | Abort if |
|---|---|---|---|
| 0 | All flags OFF on prod | baseline | n/a |
| 1 | Durable automation / Class A/B paths already owner-approved (if any) stay as previously gated | existing | new error budget burn |
| 2 | Staging: `APPROVAL_CANVAS_V2_ENABLED=true` | authoring load/save, validation fails, fallback list use | save/publish regression or data loss |
| 3 | Canary tenant: Canvas ON | S1–S7 + S12 smoke | same |
| 4 | Wider Canvas canary → default ON only after owner sign-off | G5-C full table | any P0 authoring bug |
| 5 | **Separate** FWB canary: `APPROVAL_FWB_WRITEBACK_ENABLED=true` after R1/R2 | idempotency, wrong-sheet deny | double-write / unauthorized row |
| 6 | **Separate** attachments canary: `APPROVAL_ATTACHMENTS_ENABLED=true` after R3 | bind/GC/auth | existence oracle / orphan blob |

**Rollback:** set the corresponding env back to unset/`false` and redeploy/restart; no data migration required for flag OFF. Published graphs remain valid on the legacy/list path.

---

## 5. Owner sign-off template

```text
Product FINAL gate — Approval Canvas + Data Closure
Land SHA: 323d7e1afe (later main tip at G0 record: 9b693a11d9)
G0: RATIFY  2026-08-15 / zensgit
UAT G5-C: NOT RUN  (no managed staging tenant on the recording machine)
UAT G5-R: DEFERRED (R1–R3 — not this round)
Staged flags: Canvas not applied / FWB OFF / Attachments OFF
Residual accepted: O3 DEFER; list fallback keep; dual-canvas full shell not required for this G0
Product FINAL authorized: NO
```

Only when **G0 + real-tenant UAT + staged enablement** are all owner-complete may docs claim **product FINAL**.

---

## 6. Optional residual engineering (not blocking ENGINEERING-READY)

| Item | Status | Next step |
|---|---|---|
| Full editor-embedded dual-canvas version UX | Partial (TemplateDetailView summary) | New design slice if product wants |
| Form palette drag affordances | Palette present; drag polish optional | Small PR after UAT feedback |
| Vue Flow / ELK (D3) | BLOCKED on O3 | Owner O3 then design PR plan |
| Remove 辅助编辑模式 ordinary-user entry | Blocked on S12 + G6-C window | Owner only after AT proof |

---

## 7. Suggested owner order of operations

1. **G0** on D0 lock (and optional O3) using §2. **Done 2026-08-15 (RATIFY, O3 DEFER).**  
2. Staging **Canvas-only** UAT using §3.2. **Still open.**  
3. Stage flags per §4 (Canvas before FWB before attachments). **Not started.**  
4. Sign product FINAL with §5. **Not authorized.**  
5. Open residual polish PRs only if UAT produces concrete gaps.
