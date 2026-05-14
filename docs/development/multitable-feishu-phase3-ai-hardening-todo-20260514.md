# Multitable Feishu Phase 3 TODO - AI Parity and Commercial Hardening

Date: 2026-05-14

## Status

- Baseline: `origin/main` after Phase 2 and RC closeout.
- Goal: continue Feishu parity toward AI-assisted authoring and customer-trial hardening.
- Rule: each completed implementation item must include PR, merge commit, development MD, verification MD, and verification summary.
- Worktree rule: all implementation work starts from a clean worktree based on `origin/main`; do not develop from the dirty root checkout.

## Completion Rules

Mark an item complete only after all are true:

- Code is merged or explicitly accepted as docs-only.
- Focused tests are recorded.
- `git diff --check` passes.
- OpenAPI source and generated dist are updated when contracts change.
- Staging claims include artifact paths or redacted command transcripts.
- AI provider keys, SMTP credentials, JWTs, bearer tokens, webhook URLs, and real recipient lists are not written to docs or logs.

## Phase 0 - Planning and Hygiene

- [ ] Create Phase 3 plan and TODO docs.
  - PR:
  - Merge commit:
  - Development MD: `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
  - Verification MD:
  - Verification summary:
- [ ] Confirm root checkout is not used for Phase 3 implementation.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Create clean worktree naming convention for Phase 3 lanes.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Classify existing unrelated dirty root files before opening any Phase 3 PR from root.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane D0 - Release Gate Skeleton

Owner recommendation: Codex.

Reason: this lane defines artifact shape, redaction, and release safety constraints.

- [ ] Add shared Phase 3 report writer for JSON and Markdown artifacts.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add shared secret redaction helper for AI, SMTP, webhook, JWT, bearer, and recipient-like values.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add blocked-mode command `pnpm verify:multitable-release:phase3`.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add placeholder blocked-mode commands for:
  - `pnpm verify:multitable-email:real-send`
  - `pnpm verify:multitable-perf:large-table`
  - `pnpm verify:multitable-permissions:matrix`
  - `pnpm verify:multitable-automation:soak`
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add unit tests proving blocked gates exit non-zero when required env is missing.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add unit tests proving artifacts do not leak token-like or credential-like values.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane A1 - AI Provider Readiness Contract

Owner recommendation: Codex.

Reason: provider config, redaction, and blocked-state behavior are security-sensitive.

- [ ] Add AI provider config resolver.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Make default provider state disabled.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Return blocked state when provider config is missing or incomplete.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add provider timeout and max output length settings.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add redaction tests for provider key, bearer token, JWT, webhook URL, and SMTP-like secrets.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane A2 - AI Field Shortcut Backend

Owner recommendation: Claude can implement; Codex reviews security and contracts.

- [ ] Add AI field shortcut preview endpoint.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add AI field shortcut run endpoint.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add execution audit persistence.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Support summarize preset.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Support translate preset.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Support extract preset.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Support classify preset.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Ensure run writes output through authoritative record write path.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add backend tests for preview no-write behavior.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add backend tests for run persistence and audit log.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane A3 - AI Field Shortcut Frontend

Owner recommendation: Claude can implement; Codex reviews blocked/error states.

- [ ] Add Field Manager entry for AI field shortcuts.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add source field selector.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add target field selector.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add preset selector for summarize, translate, extract, classify.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add preview result panel.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add run confirmation and execution result summary.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add disabled/provider-blocked UI state.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add frontend tests for preview, run, blocked state, and validation errors.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane B1 - Formula Dry-Run Diagnostics

Owner recommendation: Codex or Claude; Codex reviews API contract.

- [ ] Add formula dry-run endpoint.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add typed parse error diagnostic.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add typed unknown-field diagnostic.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add typed type-mismatch diagnostic where statically knowable.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add typed runtime diagnostic.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add formula diagnostics UI before save.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add backend and frontend tests for successful and failing dry-runs.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane B2 - Formula AI Assist

Owner recommendation: Claude can implement after Lane A1 and B1 land; Codex reviews provider and persistence boundaries.

- [ ] Add formula AI suggest endpoint.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Ensure suggestions do not persist automatically.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Run candidate formula through dry-run before returning a success suggestion.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add formula editor UI action for natural-language formula generation.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add manual accept flow.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add function catalog search and Chinese function descriptions.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add tests for provider blocked, suggestion success, dry-run failure, and manual accept.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane C1 - Template Preview and Dry-Run

Owner recommendation: Claude.

- [ ] Add template preview endpoint.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add template dry-run endpoint with no writes.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add preview data for project management template.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add preview data for CRM follow-up template.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add preview data for contract management template.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add preview data for inspection feedback template.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add preview data for recruiting pipeline template.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add template detail UI with fields, views, automations, permissions, and sample records.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add tests proving dry-run does not write data.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane C2 - Template Install and Onboarding

Owner recommendation: Claude; Codex reviews rollback and no-overwrite behavior.

- [ ] Harden template install flow to create all objects through authoritative services.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add no-overwrite protection for repeated installs.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Return created object IDs.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Return rollback status on partial failure.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add post-install onboarding checklist.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add frontend tests for install and onboarding.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane D1 - Real SMTP Gate

Owner recommendation: Codex.

- [ ] Implement guarded real-send smoke.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Require `CONFIRM_SEND_EMAIL=1`.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Require dedicated test recipient env.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Tie send result to automation execution log.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Redact SMTP credentials and recipients in artifacts.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane D2 - Large Table Performance Gate

Owner recommendation: Codex or Claude.

- [ ] Add 10k record import/export/query performance check.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add 50k record import/export/query performance check.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Add 100k record import/export/query performance check.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Record duration and result counts in report artifacts.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Avoid making performance thresholds strict until baseline is measured on 142.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane D3 - Permission Matrix Gate

Owner recommendation: Codex.

- [ ] Cover sheet read/write/admin matrix.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Cover view permission matrix.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Cover field hidden/read-only matrix.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Cover record permission matrix.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Cover export restrictions.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane D4 - Automation Soak Gate

Owner recommendation: Codex.

- [ ] Exercise `record.created` trigger repeatedly.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Exercise `update_record` action repeatedly.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Exercise `send_email` action repeatedly in safe mode.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Exercise `send_webhook` action against a controlled local/staging sink.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:
- [ ] Verify execution log persistence and failure handling.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Final Phase 3 Acceptance

- [ ] AI field shortcuts support summarize, translate, extract, and classify.
- [ ] AI provider disabled/missing config returns blocked safely.
- [ ] Formula dry-run diagnostics are available before save.
- [ ] Formula AI assist returns suggestions that require manual acceptance.
- [ ] Template center supports preview, dry-run, install, and onboarding.
- [ ] Phase 3 release gates produce redacted JSON and Markdown artifacts.
- [ ] 142 staging has a passing Phase 3 release report.
- [ ] OpenAPI source and generated dist are updated for all route/schema changes.
- [ ] Every PR has development and verification MDs.
- [ ] This TODO is updated with PR, merge commit, and verification summary for completed tasks.
