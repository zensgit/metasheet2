# Multitable Feishu Phase 3 Plan - AI Parity and Commercial Hardening

Date: 2026-05-14

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

The preferred implementation order is:

1. Phase 3D0 - release gate skeleton and evidence contract.
2. Phase 3A - AI field shortcuts V1.
3. Phase 3B - formula AI assist and diagnostics.
4. Phase 3C - template and industry solution center V2.
5. Phase 3D1 - commercial hardening gates on 142 staging.

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

### PR 1 - docs only

Title:

```text
docs(multitable): plan phase3 ai parity and hardening
```

Contents:

- Phase 3 plan MD.
- Phase 3 TODO MD.

### PR 2 - release gate skeleton

Title:

```text
test(multitable): add phase3 release gate skeleton
```

Contents:

- Empty or blocked-mode gate runners.
- Shared report writer.
- Redaction tests.

### PR 3 - AI provider readiness

Title:

```text
feat(multitable): add ai provider readiness contract
```

Contents:

- Provider resolver.
- Disabled/blocked contract.
- Redaction.
- Unit tests.

### PR 4 - AI field shortcut backend

Title:

```text
feat(multitable): add ai field shortcut execution service
```

Contents:

- Preview API.
- Run API.
- Execution audit.
- Backend tests.

### PR 5 - AI field shortcut frontend

Title:

```text
feat(multitable): add ai field shortcut authoring
```

Contents:

- Field Manager entry.
- Preview/run UI.
- Blocked/error states.

### PR 6 - formula diagnostics

Title:

```text
feat(multitable): add formula dry-run diagnostics
```

Contents:

- Dry-run API.
- Typed diagnostics.
- UI diagnostics.

### PR 7 - formula AI assist

Title:

```text
feat(multitable): add formula ai assist
```

Contents:

- Formula suggestion API.
- Manual accept flow.
- Provider blocked fallback.

### PR 8 - template center preview

Title:

```text
feat(multitable): add template preview and dry-run
```

Contents:

- Preview API.
- Dry-run API.
- Template detail UI.

### PR 9 - template onboarding

Title:

```text
feat(multitable): add template onboarding checklist
```

Contents:

- Install hardening.
- Post-install checklist.

### PR 10 - commercial gates

Title:

```text
test(multitable): add phase3 commercial release gates
```

Contents:

- Real SMTP gate.
- Large table performance gate.
- Permission matrix gate.
- Automation soak gate.

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
