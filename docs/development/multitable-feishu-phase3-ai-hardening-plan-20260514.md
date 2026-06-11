# Multitable Feishu Phase 3 Plan - AI Parity and Commercial Hardening

Date: 2026-05-14

2026-05-28 update: #1792 satisfies the K3 macro gate for M1 one-record Material Save-only. Mentions of "stage-1 lock" below are historical activation context; they no longer block planning by themselves. Deferred lanes still require their T-numbered blockers and explicit operator opt-in before implementation.

> **Reconcile 2026-06-10** (evidence: 2026-06-10 five-agent completion audit; historical text below is preserved, read with these corrections):
>
> - D0/D1/D4 "pending activation" rows: SHIPPED + formally closed — D0 #1541 (`a92189533`) + #1549 (`8025b2499`); D1 #1544 (`1f9061f56`) + #1554 (`7fe0b5ca7` — the TODO's "pending until squash merge" note is stale); D4 #1547 (`855ba871e`); closeout #1565 + 2026-05-15 staging audit PASS.
> - Deferred Lane B1 (formula diagnostics): SHIPPED via the later dry-run track #1860/#1865/#1869/#1873/#1995/#2006/#2021 (+ hydration #2465).
> - Deferred D2 sub-gate: first 10k baseline SHIPPED via #1807/#1808/#1809/#1815; 50k/100k still blocked (undici harness limitation).
> - Deferred D3 sub-gate: SHIPPED via #1818/#1822/#1827/#1831 (real-DB golden tests), extended by #2028/#2044.
> - Blockers T4/T5: closed/overtaken by the D2/D3 deliveries above. T1/T2/T3/T6/T7 remain genuinely open.
> - Lane C1 partial: template center + 5 industry templates shipped via #1651/#1655; template preview/dry-run and onboarding remain unbuilt.
> - The AI lanes (A1/A2/A3, B2) are now tracked by `docs/development/multitable-ai-field-staged-arc-development-plan-20260610.md` (M0–M4); this plan's lane tables are historical context.

## Status

This document starts the next multitable Feishu-parity phase after the signed RC and Phase 2 closeout.

Current repository evidence shows the core multitable product line is no longer blocked by the original Feishu parity gaps:

- Base, sheet, field, view, record lifecycle is covered.
- Views cover grid, kanban, gallery, calendar, timeline, gantt, hierarchy, form, and dashboard surfaces.
- Field types cover long text, currency, percent, rating, url, email, phone, multi-select, auto-number, system fields, date-time, number format, barcode, location, person, formula, lookup, rollup, link, attachment, select, checkbox, date, and number.
- XLSX import/export, CSV, conditional formatting, formula, public form, Gantt dependency rendering, Hierarchy cycle prevention, record history, record subscription, comments, mentions, presence, permissions, and automation send_email are already represented in merged documentation and smoke evidence.
- RC validation has API and UI smoke harnesses, 142 staging artifacts, release evidence, and secret redaction patterns.

The remaining Feishu-facing gap is now concentrated in AI-assisted authoring, industry solution packaging, and customer-trial hardening. The next phase should not reopen RC smoke scope or rewrite working table primitives.

## External Baseline

Feishu/Lark Base public docs and product pages emphasize these capabilities beyond basic table modeling:

- Rich field catalog, including formula, lookup, rollup, creator/updater metadata, auto number, location, attachment, link, people, select, date, and URL-like fields.
- View types including grid, kanban, gallery, and gantt.
- AI-assisted usage, including AI field shortcuts, AI formula generation, automation AI nodes, smart dashboard insights, and smart visual styling.

Reference URLs:

- https://s.apifox.cn/apidoc/docs-site/532425/doc-436428
- https://feishu.apifox.cn/doc-436427
- https://www.feishu.cn/content/base

## Phase 3 Goal

Move MetaSheet multitable from "feature parity usable" to "customer-trial ready against modern Feishu Base expectations".

The original preferred implementation order — preserved here as
authorial intent — is:

1. Phase 3D0 - release gate skeleton and evidence contract.
2. Phase 3A - AI field shortcuts V1.
3. Phase 3B - formula AI assist and diagnostics.
4. Phase 3C - template and industry solution center V2.
5. Phase 3D1 - commercial hardening gates on 142 staging.

The Activation Constraints section below records the active-queue decision made
under the K3 PoC stage-1 lock, plus the post-GATE reading after #1792.

## Activation Constraints

The K3 PoC stage-1 lock recorded in
`docs/development/integration-erp-platform-roadmap-20260425.md` §4-§5
was in effect when this plan landed. As of 2026-05-28, #1792 satisfies the K3
macro gate. Re-entry is now governed by lane-local blockers, operator
ratification, and the scoped-gate rules in
`docs/development/k3-post-gate-scoped-governance-20260528.md`.

### Active queue (allowed under stage-1 lock)

| Lane | Status | Re-entry condition |
| --- | --- | --- |
| D0 - Release Gate Skeleton | active | none — kernel polish |
| D1 - Real SMTP Gate | active | none — kernel polish |
| D4 - Automation Soak Gate | active | none — kernel polish |

These three sub-lanes harden code that is already live on `main` and
already deployed on 142. They do not open a new product战线 and they
do not touch `plugins/plugin-integration-core/*` or any K3 PoC path.

### Deferred lanes

| Lane | Status | Re-entry condition |
| --- | --- | --- |
| Lane A - AI Field Shortcuts V1 (A1 / A2 / A3) | deferred pending T-blockers / operator ratification | T1, T2, T3, T6 closed; K3 macro gate satisfied via #1792 |
| Lane B - Formula AI Assist and Diagnostics (B1 / B2) | deferred pending T-blockers / operator ratification | T1, T3, T6 closed; K3 macro gate satisfied via #1792 |
| Lane C - Template / Industry Solution Center V2 (C1 / C2) | pending PM / SME assignment | PM / PD ownership plus domain SME for at least three of the five industry templates, plus T7 closed |
| D2 - Large Table Performance Gate | deferred | K3 macro gate satisfied via #1792; still needs T4 / 142 host decision |
| D3 - Permission Matrix Gate | deferred | K3 macro gate satisfied via #1792; still needs T5 and staging / 142 decision |

### Activation blockers — T1 through T7

The independent review at
`docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md`
enumerates seven pre-launch technical blockers. Until each blocker is
closed, the corresponding lane stays deferred:

- T1 — AI cost ledger, per-tenant token budget, daily / weekly cap,
  burst rate-limit. Blocks Lane A and Lane B activation.
- T2 — Explicit boundary statement against
  `packages/core-backend/src/multitable/automation-service.ts`.
  Blocks Lane A activation.
- T3 — Concrete SLO numbers — max wall-clock per preview call, max
  wall-clock per run row, cancel and streaming semantics. Blocks
  Lane A and Lane B activation.
- T4 — D2 perf-gate runs must not run on 142 during the K3 PoC
  live window. Blocks D2 activation.
- T5 — D3 must explicitly choose snapshot semantics versus golden
  matrix semantics for sheet / view / field / record / export
  permission paths. Blocks D3 activation.
- T6 — Full AI provider state enumeration (`disabled`,
  `rate_limited`, `quota_exhausted`, `provider_error`,
  `unsafe_input`) in addition to `blocked`. Blocks Lane A and
  Lane B activation.
- T7 — Lane C install rollback budget upgraded to its own sub-lane,
  or downgraded to "best-effort no-rollback with explicit
  partial-state report". Blocks Lane C activation.

### Re-entry process

Because #1792 has satisfied the K3 macro gate, the relevant lane becomes eligible
for activation only after closing its T-numbered blocker(s) and receiving
operator opt-in. Each activation must be recorded in this plan as a follow-up
commit that moves the lane row from the Deferred table to the Active queue, and
in the companion TODO as a Status field update from `deferred` to `pending`.

## Worktree Rule

All Phase 3 work must start from a clean worktree based on `origin/main`.

Do not develop from the current root checkout while it contains unrelated dirty or untracked files. Use paths like:

```bash
git fetch origin main
git worktree add /private/tmp/ms2-multitable-phase3-<lane>-20260514 -b codex/multitable-phase3-<lane>-20260514 origin/main
```

## Completion Rule

Every completed task must have:

- PR number.
- Merge commit.
- Development MD.
- Verification MD.
- Focused local test results.
- CI result.
- Staging artifact path when claiming staging behavior.
- Secret scan result when touching AI, SMTP, webhook, auth, provider, or release artifacts.

## Lane A - AI Field Shortcuts V1

### Objective

Add a controlled "AI field shortcut" capability similar to Feishu's AI field shortcuts, but keep it narrow, auditable, and disabled by default.

The first release supports four presets:

- Summarize text.
- Translate text.
- Extract information.
- Classify into labels.

### Product Behavior

Users can configure an AI shortcut from Field Manager or a dedicated field action panel:

- Select a source field.
- Select a target field.
- Select one preset.
- Optionally provide a short instruction.
- Preview one record.
- Run against selected records or the current view subset.

AI output writes to a normal target field. No new special AI field type is required for V1.

### Backend Requirements

Add an AI provider readiness resolver:

- Default state is disabled.
- Missing provider config returns `blocked`, not `pass`.
- Provider secrets are never included in thrown errors, logs, reports, or JSON artifacts.
- Provider timeout and max output length are centrally enforced.

Add AI shortcut execution service:

- Preview endpoint executes one record only and does not persist output.
- Run endpoint persists output to target fields through the authoritative record write path.
- Execution records include actor, sheet, source field, target field, preset, status, duration, count, and error code.
- Failure on one row must not corrupt other records. V1 can be all-or-nothing or partial-success, but the chosen mode must be explicit in the API and verification docs.

Recommended API shape:

```text
POST /api/multitable/sheets/:sheetId/ai/field-shortcuts/preview
POST /api/multitable/sheets/:sheetId/ai/field-shortcuts/run
GET  /api/multitable/sheets/:sheetId/ai/executions
```

### Frontend Requirements

Add a small authoring surface:

- AI disabled state with a clear blocked message.
- Preset selector.
- Source field selector.
- Target field selector.
- Preview result panel.
- Run confirmation with selected record count.
- Execution result summary.

### Non-Goals

- No chat-style copilot.
- No AI dashboard explanation.
- No AI image, audio, or file understanding.
- No per-cell streaming UI.
- No provider-specific UI.

### Validation

Minimum tests:

- Disabled provider returns blocked.
- Preview does not persist.
- Run persists target field output.
- Invalid source or target field returns validation error.
- Output length limit is enforced.
- Execution audit is written.
- Secret scan proves provider key and prompts with token-like strings are redacted.

## Lane B - Formula AI Assist and Diagnostics

### Objective

Make formula fields usable by non-technical users by adding natural-language formula suggestions and better diagnostics.

### Product Behavior

Formula field configuration adds:

- Function catalog search.
- Chinese function descriptions.
- Parameter examples.
- "Generate formula from description" action.
- Dry-run diagnostics before saving.

AI suggestion returns one or more candidate formulas. The user must manually accept a suggestion before it becomes the formula property.

### Backend Requirements

Add formula dry-run endpoint:

```text
POST /api/multitable/sheets/:sheetId/formulas/dry-run
```

Dry-run validates:

- Formula syntax.
- Field references.
- Type compatibility where statically knowable.
- Runtime evaluation on sample record values.

Add AI suggest endpoint:

```text
POST /api/multitable/sheets/:sheetId/formulas/ai-suggest
```

The suggestion endpoint:

- Requires AI provider readiness.
- Returns candidates only.
- Does not persist field changes.
- Runs candidates through dry-run before returning a success candidate.

### Error Model

Replace generic formula failure where possible with typed diagnostics:

- `FORMULA_PARSE_ERROR`
- `FORMULA_UNKNOWN_FIELD`
- `FORMULA_TYPE_MISMATCH`
- `FORMULA_RUNTIME_ERROR`
- `FORMULA_AI_PROVIDER_BLOCKED`

### Non-Goals

- No full formula language rewrite.
- No AI auto-save.
- No cross-base formula generation.

### Validation

Minimum tests:

- Natural language prompt returns candidate formula when provider is enabled in test double.
- Disabled provider returns blocked.
- Dry-run rejects invalid syntax.
- Dry-run rejects unknown field reference.
- Dry-run success can be accepted and saved from UI.
- Existing formula fields still evaluate.

## Lane C - Template and Industry Solution Center V2

### Objective

Upgrade the existing template library into a customer-trial oriented solution center.

### Product Behavior

Template detail page shows:

- Fields.
- Views.
- Automations.
- Permission recommendations.
- Sample records.
- Installation impact summary.

The first industry templates:

- Project management.
- CRM follow-up.
- Contract management.
- Inspection feedback.
- Recruiting pipeline.

### Backend Requirements

Add preview and dry-run support:

```text
GET  /api/multitable/templates/:templateId/preview
POST /api/multitable/templates/:templateId/dry-run
POST /api/multitable/templates/:templateId/install
```

Dry-run must not write data. It returns the objects that would be created.

Install must:

- Create base/sheet/fields/views/automations through existing authoritative services.
- Avoid overwriting existing user data.
- Return created object IDs.
- Return rollback status if a partial failure happens.

### Frontend Requirements

Template center V2 adds:

- Template detail route or drawer.
- Preview tabs for fields, views, automations, and sample data.
- Install dry-run screen.
- Post-install onboarding checklist.

### Non-Goals

- No public marketplace.
- No third-party template publishing workflow.
- No paid template billing.

### Validation

Minimum tests:

- Preview returns stable schema.
- Dry-run writes nothing.
- Install creates expected objects.
- Duplicate install does not overwrite user data.
- UI renders template details and onboarding checklist.

## Lane D - Commercial Hardening Gates

### Objective

Turn customer-trial release checks into repeatable, redacted, fail-loud gates.

### D0 - Gate Skeleton

Create script and artifact contracts first, before adding expensive live checks.

Recommended commands:

```bash
pnpm verify:multitable-release:phase3
pnpm verify:multitable-email:real-send
pnpm verify:multitable-perf:large-table
pnpm verify:multitable-permissions:matrix
pnpm verify:multitable-automation:soak
```

Each script must:

- Exit non-zero on failure.
- Produce `report.json`.
- Produce `report.md`.
- Redact secrets.
- Print artifact paths.
- Support dry-run or blocked mode when required env is absent.

### D1 - Real SMTP Gate

Use only with explicit confirmation:

```text
CONFIRM_SEND_EMAIL=1
MULTITABLE_EMAIL_REAL_SEND_SMOKE=1
MULTITABLE_EMAIL_SMOKE_TO=<dedicated test recipient>
```

Requirements:

- No real recipient list in artifact.
- No SMTP host credential leakage.
- Controlled failure if SMTP env is incomplete.
- Mail send result tied to automation execution log.

### D2 - Large Table Performance Gate

Run import/export/query checks at:

- 10k records.
- 50k records.
- 100k records.

Record:

- Duration.
- Memory if available.
- Created record count.
- Export row count.
- Failure code.

### D3 - Permission Matrix Gate

Cover:

- Sheet read/write/admin.
- View permission.
- Field hidden/read-only.
- Record permission.
- Export restrictions.

### D4 - Automation Soak Gate

Cover:

- `record.created`.
- `update_record`.
- `send_email`.
- `send_webhook`.
- Execution log persistence.
- Controlled failure behavior.

## Suggested PR Sequence

Under the Activation Constraints above, only the docs-only landing
PR plus three implementation PRs are in the active queue. The
remaining seven PRs from the original sequence stay deferred. The
original numbering is preserved for cross-reference; active PRs
carry an `R`-prefix to mark them as re-scoped.

### Active queue

#### PR 1 — docs only (landed as #1537)

Title:

```text
docs(multitable): land feishu phase 3 plan, todo, and review
```

Contents:

- Phase 3 plan MD.
- Phase 3 TODO MD.
- Independent review MD.
- Landing development and verification MDs.

Status: landed. Commit `087b8e6fb` on
`codex/multitable-feishu-phase3-plan-review-20260514`.

#### PR R2 — D0 release gate skeleton

Title:

```text
test(multitable): add phase3 release gate skeleton
```

Contents:

- Blocked-mode `pnpm verify:multitable-release:phase3` runner.
- Shared JSON + Markdown report writer.
- Shared secret redaction helper covering AI provider keys, SMTP
  credentials, JWTs, bearer tokens, webhook URLs, and recipient-like
  values.
- Unit tests proving blocked gates exit non-zero when required env
  is missing, and that artifacts do not leak token-like or
  credential-like values.

Status: pending activation. No new product战线; kernel polish on
already-shipped automation and release-evidence paths.

#### PR R3 — D1 real SMTP gate

Title:

```text
test(multitable): add phase3 real smtp send gate
```

Contents:

- `pnpm verify:multitable-email:real-send` guarded by
  `CONFIRM_SEND_EMAIL=1` plus dedicated test recipient env.
- Mail send result tied to automation execution log.
- Redacted artifact: no SMTP host credential leakage and no real
  recipient list in the report.

Status: pending activation. Depends on PR R2 (D0 skeleton).

#### PR R4 — D4 automation soak gate

Title:

```text
test(multitable): add phase3 automation soak gate
```

Contents:

- `pnpm verify:multitable-automation:soak` exercising
  `record.created` / `update_record` / `send_email` /
  `send_webhook` repeat-fire against shipped automation actions
  only.
- Execution-log persistence assertions.
- Controlled-failure behavior assertions.

Status: pending activation. Depends on PR R2 (D0 skeleton).

### Deferred — not in active queue

The following PRs from the original sequence remain deferred under the
Activation Constraints above. After #1792, they re-enter the active queue only
after the corresponding T-numbered blockers close and the operator opts in.

| Original PR | Lane | Defer reason |
| --- | --- | --- |
| PR 3 — AI provider readiness | Lane A1 | T1 / T6 open; operator ratification missing |
| PR 4 — AI field shortcut backend | Lane A2 | T1 / T2 / T3 open |
| PR 5 — AI field shortcut frontend | Lane A3 | T3 / T6 open |
| PR 6 — formula diagnostics | Lane B1 | Operator opt-in required |
| PR 7 — formula AI assist | Lane B2 | T1 / T3 / T6 open |
| PR 8 — template center preview | Lane C1 | PM / SME unassigned |
| PR 9 — template onboarding | Lane C2 | T7 unbudgeted |
| (Original PR 10 sub-gate) — large-table perf | D2 | T4 open; risk to 142 K3 PoC integrity |
| (Original PR 10 sub-gate) — permission matrix | D3 | T5 open |

The original PR 10 grouped D1, D2, D3, D4 into a single PR. Under the
Activation Constraints above, D1 and D4 are split into PR R3 and
PR R4 (active), while D2 and D3 are deferred separately.

## Final Acceptance Criteria

Phase 3 is complete only after:

- AI field shortcuts support summarize, translate, extract, and classify.
- AI field shortcuts are disabled safely when provider config is missing.
- Formula dry-run diagnostics are available before save.
- Formula AI assist can suggest a formula and requires manual acceptance.
- Template center supports preview, dry-run, install, and onboarding.
- Phase 3 release gates produce redacted artifacts.
- 142 staging has a passing Phase 3 report.
- All route/schema changes update OpenAPI source and generated dist.
- Every PR has development and verification MDs.
- Phase 3 TODO has PR, merge commit, and verification summaries filled for completed tasks.
