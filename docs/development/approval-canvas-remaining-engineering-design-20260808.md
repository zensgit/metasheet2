# Approval Canvas Remaining Engineering — Design + PR Plan (2026-08-08)

**Status:** AUTHORITATIVE FOR AUTONOMOUS EXECUTION  
**Tracking PR:** https://github.com/zensgit/metasheet2/pull/4806 (draft)  
**Head family:** `claude/approval-canvas-final-engineering-20260808`  
**Authority locks:** D0 interaction lock (written contract; G0 owner ratify still open), canvas V2 plan D-items, final-eligibility MDs  
**Flags:** remain default OFF. No production enablement. No real-tenant UAT in this plan.

## Goal

Close residual **product engineering** against the written D0 lock without mid-session human confirm:

1. Canvas-first ordinary-user surface: no primary **node button clusters**; insertion via **edge `+`** and inspector topology.  
2. Form palette for authorable field kinds without ordinary-user field IDs.  
3. Session history / live-graph / topology merge — preserve.  
4. Accessible list (**辅助编辑模式**) retained until S12/G6-C.  
5. Honest docs: ENGINEERING-READY advances; product FINAL still needs owner G0/UAT/flags.

## Non-goals

- G0 formal ratify text flip without owner  
- O3 Vue Flow/ELK (bespoke layout retained until O3)  
- Number FWB unlock  
- Optional D7 runtimes  
- Production flag ON / real-tenant UAT execution  
- Merge of #4806 without green required checks  

## Autonomy policy

Agents may implement, test, commit, push to the tracking branch, and update the draft PR. Agents **must not** merge to main, flip env flags, or claim product FINAL. Owner gates are recorded as blockers only.

## Ledger vs #4806

| Item | Status on #4806 | Notes |
|---|---|---|
| Session history + undo/redo + live graph + topology merge | **DONE** | `approvalAuthoringHistory.ts` + view wiring + tests |
| Canvas-first default under flag | **DONE** | `canvasViewMode = 'canvas'` |
| Linear promote into preservedGraph | **DONE** | flow section entry |
| Edge `+` insert + retire node clusters | **DONE** | inspector topology keeps load-bearing testids |
| Form field palette (D6-f2 slice) | **DONE** | `approval-field-palette` |
| Final-eligibility MD + gate workflow | **DONE** | docs + `.grok/workflows/approval-canvas-final-gate.rhai` |
| G5-C S1–S12 product-path suite | **DONE** | `approval-g5c-authoring-scenarios.test.ts` (CI-wired) |
| CI: approval-web-guard / web-tests green | **IN PROGRESS** | fix regressions; required canaries include new specs |
| Version dual-canvas shell (full D8-b) | **OPEN** | helpers exist; no editor dual-canvas product shell |
| Extract `ApprovalFlowCanvas` / inspector modules | **OPEN** | reduce `TemplateAuthoringView` heat |
| D3 Vue Flow/ELK | **BLOCKED (O3)** | do not start |

## PR Plan (execute-plan ready)

Statuses: `DONE` items must not be re-implemented by `/execute-plan`. Only `OPEN` / `IN_PROGRESS` nodes are executable.

### PR 0: #4806 closeout — CI green + gate wiring — IN_PROGRESS

- **Description:** Fix CI failures introduced by D0 productization (authoring specs that assumed node button clusters; UF-6 hex/rgb guard). Wire `approval-authoring-history` + `approval-g5c-authoring-scenarios` into approval-web-guard canaries and required web run-list. Push to #4806 until `approval-web-guard` and `web-tests` are green.  
- **Files/components affected:** `apps/web/src/views/approval/TemplateAuthoringView.vue`, `apps/web/tests/approvalTemplateAuthoring.spec.ts`, `.github/workflows/approval-web-guard.yml`, `apps/web/scripts/run-required-web-tests.sh`, this design doc, workflow  
- **Dependencies:** None  

### PR 1: Edge insert + retire canvas node button clusters — DONE (on #4806)

- **Description:** Edge mid-point `+` insert; topology on selected inspector; list keeps full topology.  
- **Files/components affected:** `TemplateAuthoringView.vue`, inspector/G5-C specs  
- **Dependencies:** None  

### PR 2: Form field palette (D6-f2 slice) — DONE (on #4806)

- **Description:** Palette of authorable field types without ID entry.  
- **Files/components affected:** `TemplateAuthoringView.vue`, G5-C structural assertions  
- **Dependencies:** None  

### PR 3: Version overlay read surface (D8-b thin) — OPEN

- **Description:** Reuse `diffApprovalTemplateVersions` + `buildVersionGraphOverlay` as a read-only change summary when version payloads are available in authoring/review. No new backend. Do not claim dual-canvas product shell. Prefer pure helper + structural tests if UI surface is deferred.  
- **Files/components affected:** `apps/web/src/approvals/versionGraphOverlay.ts`, `apps/web/src/approvals/templateVersionDiff.ts`, optional thin UI under `apps/web/src/views/approval/`, tests  
- **Dependencies:** PR 0 (green #4806 preferred)  

### PR 4: Extract ApprovalFlowCanvas / inspector shell — OPEN

- **Description:** Extract canvas viewport, edge-insert, node cards, and inspector chrome from `TemplateAuthoringView.vue` into focused components; keep draft/history as single source of truth; no graph semantic changes. Serialize ownership of the hot file.  
- **Files/components affected:** `apps/web/src/views/approval/TemplateAuthoringView.vue`, new files under `apps/web/src/approvals/components/` or `apps/web/src/views/approval/components/`, mounted specs  
- **Dependencies:** PR 0  

### PR 5: Final-eligibility MD + gate workflow — DONE (on #4806; maintain)

- **Description:** Keep development/verification MDs honest; keep `.grok/workflows/approval-canvas-final-gate.rhai` current with canary file list and #4806 CI awareness.  
- **Files/components affected:** `docs/development/approval-canvas-data-closure-final-eligibility-*.md`, `.grok/workflows/approval-canvas-final-gate.rhai`, this design doc  
- **Dependencies:** PR 1, PR 2 (satisfied)  

## Execute-plan dry-run order

Linearized remaining stack after PR 0 is green:

```text
PR0 (CI closeout on #4806) → PR4 (extract) → PR3 (version thin)
```

- Max parallelism: 1 on `TemplateAuthoringView.vue` (PR0 then PR4). PR3 may parallel PR4 only if it does not touch the same hot file.  
- Suggested: `/execute-plan docs/development/approval-canvas-remaining-engineering-design-20260808.md --dry-run` then execute only OPEN nodes (implementer must skip DONE).  

## Verification

- Web focused suites green (history, G5-C, inspector, form/canvas commands, approvalTemplateAuthoring, ui-foundation-style-guard).  
- `approval-web-guard` + `web-tests` green on #4806.  
- `vue-tsc --noEmit` pass.  
- Flags default OFF unchanged.  
- Structural: edge insert testids; no `template-authoring__canvas-node-actions` on canvas; palette present; list topology retained.  
- Workflow `approval-canvas-final-gate` reports `product_final: false` always; `engineering_ready` only when tests + flags + honest docs hold.
