# Approval Canvas Remaining Engineering — Design + PR Plan (2026-08-08)

**Status:** AUTHORITATIVE FOR AUTONOMOUS EXECUTION (agent-run; no mid-step human confirm)  
**Base branch:** `claude/approval-canvas-final-engineering-20260808` (or `origin/main` + rebased feature)  
**Authority locks:** D0 interaction lock (written contract; G0 owner ratify still open), canvas V2 plan D-items, final-eligibility MDs  
**Flags:** remain default OFF. No production enablement. No real-tenant UAT in this plan.

## Goal

Close residual **product engineering** against the written D0 lock without requiring owner mid-session confirmation:

1. Canvas-first ordinary-user surface: no primary **node button clusters**; insertion via **edge `+`** and inspector topology.  
2. Form palette for authorable field kinds without ordinary-user field IDs.  
3. Session history / live-graph / topology merge already on branch — preserve.  
4. Accessible list (**辅助编辑模式**) retained until S12/G6-C.  
5. Honest docs: ENGINEERING-READY advances; product FINAL still needs owner G0/UAT/flags.

## Non-goals

- G0 formal ratify text flip without owner  
- O3 Vue Flow/ELK (bespoke layout retained until O3)  
- Number FWB unlock  
- Optional D7 runtimes  
- Production flag ON / real-tenant UAT execution  

## Autonomy policy

Agents may implement, test, commit, and open draft PRs. Agents **must not** merge to main, flip env flags, or claim product FINAL. Owner gates are recorded as blockers only.

## PR Plan

### PR 1: Edge insert + retire canvas node button clusters

- **Description:** On Canvas V2 canvas surface, remove primary per-node action button clusters. Provide edge mid-point `+` insert (approval / condition / parallel where legal). Move topology actions for the **selected** node into the right inspector (same draft handlers + same data-testids for load-bearing specs). List/辅助编辑模式 keeps full topology buttons (S12).  
- **Files/components affected:** `apps/web/src/views/approval/TemplateAuthoringView.vue`, `apps/web/tests/approval-template-authoring-canvas-inspector.spec.ts`, `apps/web/tests/approval-g5c-authoring-scenarios.test.ts`  
- **Dependencies:** None  

### PR 2: Form field palette (D6-f2 slice)

- **Description:** Palette of authorable field types; one-click add without ID entry; keyboard/up-down reorder retained; pure form-command path preferred when identity history available, else existing `createEmptyFieldDraft` for text default + type set.  
- **Files/components affected:** `apps/web/src/views/approval/TemplateAuthoringView.vue`, `apps/web/tests/approval-g5c-authoring-scenarios.test.ts`  
- **Dependencies:** None (may land with PR 1 if same branch; independent logically)  

### PR 3: Version overlay read surface (D8-b thin)

- **Description:** Reuse `diffApprovalTemplateVersions` + `buildVersionGraphOverlay` in authoring/review step as a read-only change summary when optional version payloads are present; no new backend. If API not wired in authoring view, ship pure helper wiring + structural test only without claiming dual-canvas product shell.  
- **Files/components affected:** `apps/web/src/approvals/versionGraphOverlay.ts` (existing), tests, optional thin UI in TemplateAuthoringView or TemplateDetailView only if already loading versions  
- **Dependencies:** None  

### PR 4: Final-eligibility MD + gate workflow

- **Description:** Update development/verification MDs; add `.grok/workflows/approval-canvas-final-gate.rhai` for unattended regression evidence.  
- **Files/components affected:** `docs/development/approval-canvas-data-closure-final-eligibility-*.md`, `.grok/workflows/approval-canvas-final-gate.rhai`, this design doc  
- **Dependencies:** PR 1, PR 2  

## Verification

- Web focused suites green (history, G5-C, inspector, form commands).  
- `vue-tsc --noEmit` pass.  
- Flags default OFF unchanged.  
- Structural: canvas has edge insert testids; node clusters absent on canvas; palette present; list topology retained.
