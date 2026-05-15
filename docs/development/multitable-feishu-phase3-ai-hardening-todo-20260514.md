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

## Activation Gate

The K3 PoC stage-1 lock recorded in
`docs/development/integration-erp-platform-roadmap-20260425.md` §4-§5
is in effect. Under that lock, lanes carry one of three statuses:

- `pending` — in the active queue. Implementation may start once
  Phase 0 hygiene is complete.
- `deferred pending K3 GATE PASS` — blocked by the stage-1 lock. The
  lane re-enters `pending` only after the operator announces K3 GATE
  PASSED (or explicitly invokes "打破阶段一约束" per
  `project_k3_poc_stage1_lock.md`) **and** the lane's T-numbered
  blockers from
  `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md`
  are closed.
- `pending PM / SME assignment` — blocked by missing non-engineering
  inputs. The lane re-enters `pending` only after PM / PD ownership
  and domain SME availability are confirmed, and rollback budget
  (T7) is settled.

Active queue at the time this TODO lands: Lane D0, Lane D1, Lane D4.

Deferred under stage-1 lock: Lane A1 / A2 / A3, Lane B1 / B2, Lane
D2, Lane D3.

Deferred under PM / SME assignment: Lane C1, Lane C2.

Re-entering a deferred lane to `pending` requires a follow-up commit
to this TODO that flips the Status field and updates the active-queue
roster, plus a matching update to the Active queue / Deferred lanes
tables in
`docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`.

## Phase 0 - Planning and Hygiene

- [x] Create Phase 3 plan and TODO docs.
  - PR: #1537
  - Merge commit: `55b4b685d`
  - Development MD: `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
  - Verification MD: `docs/development/multitable-feishu-phase3-ai-hardening-review-landing-verification-20260514.md`
  - Verification summary: plan/review/TODO docs landed; active queue limited to D0/D1/D4 under the K3 stage-1 lock.
- [x] Confirm root checkout is not used for Phase 3 implementation.
  - PR: #1537
  - Merge commit: `55b4b685d`
  - Development MD: `docs/development/multitable-feishu-phase3-ai-hardening-review-landing-development-20260514.md`
  - Verification MD: `docs/development/multitable-feishu-phase3-ai-hardening-review-landing-verification-20260514.md`
  - Verification summary: TODO records the clean-worktree rule; subsequent D0/D1 work starts from `/private/tmp/ms2-multitable-phase3-*`.
- [x] Create clean worktree naming convention for Phase 3 lanes.
  - PR: #1537
  - Merge commit: `55b4b685d`
  - Development MD: `docs/development/multitable-feishu-phase3-ai-hardening-review-landing-development-20260514.md`
  - Verification MD: `docs/development/multitable-feishu-phase3-ai-hardening-review-landing-verification-20260514.md`
  - Verification summary: naming convention documented as `/private/tmp/ms2-multitable-phase3-<lane>-20260514`.
- [ ] Classify existing unrelated dirty root files before opening any Phase 3 PR from root.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary:

## Lane D0 - Release Gate Skeleton

Status: pending — active queue (kernel polish, allowed under stage-1 lock).

Owner recommendation: Codex.

Reason: this lane defines artifact shape, redaction, and release safety constraints.

- [x] Add shared Phase 3 report writer for JSON and Markdown artifacts.
  - PR: #1541
  - Merge commit: `a92189533`
  - Development MD: `docs/development/multitable-phase3-release-gate-skeleton-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-release-gate-skeleton-verification-20260514.md`
  - Verification summary: `multitable-phase3-release-gate-report.test.mjs` passed; JSON/Markdown artifacts are redacted before write.
- [x] Add shared secret redaction helper for AI, SMTP, webhook, JWT, bearer, and recipient-like values.
  - PR: #1541
  - Merge commit: `a92189533`
  - Development MD: `docs/development/multitable-phase3-release-gate-skeleton-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-release-gate-skeleton-verification-20260514.md`
  - Verification summary: redaction tests cover bearer/JWT/sk/SEC/query tokens, SMTP envs, recipient envs, and DB URI credentials.
- [x] Add blocked-mode command `pnpm verify:multitable-release:phase3`.
  - PR: #1541
  - Merge commit: `a92189533`
  - Development MD: `docs/development/multitable-phase3-release-gate-skeleton-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-release-gate-skeleton-verification-20260514.md`
  - Verification summary: `release:phase3` exits 2 when child gates are blocked and does not collapse BLOCKED into FAIL.
- [x] Add placeholder blocked-mode commands for:
  - `pnpm verify:multitable-email:real-send`
  - `pnpm verify:multitable-perf:large-table`
  - `pnpm verify:multitable-permissions:matrix`
  - `pnpm verify:multitable-automation:soak`
  - PR: #1541
  - Merge commit: `a92189533`
  - Development MD: `docs/development/multitable-phase3-release-gate-skeleton-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-release-gate-skeleton-verification-20260514.md`
  - Verification summary: D0 skeleton added perf/permissions/automation placeholders; email real-send existed already and is wired into the aggregate gate by D1.
- [x] Add unit tests proving blocked gates exit non-zero when required env is missing.
  - PR: #1541
  - Merge commit: `a92189533`
  - Development MD: `docs/development/multitable-phase3-release-gate-skeleton-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-release-gate-skeleton-verification-20260514.md`
  - Verification summary: spawn tests verify exit 2 for blocked gates and `--allow-blocked` preserves report status.
- [x] Add unit tests proving artifacts do not leak token-like or credential-like values.
  - PR: #1541
  - Merge commit: `a92189533`
  - Development MD: `docs/development/multitable-phase3-release-gate-skeleton-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-release-gate-skeleton-verification-20260514.md`
  - Verification summary: artifact-integrity tests assert stdout/stderr/report JSON/report MD do not contain injected secret values.

## Lane A1 - AI Provider Readiness Contract

Status: deferred pending K3 GATE PASS — also blocked by T1 (cost ledger / rate limit) and T6 (provider state enum).

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

Status: deferred pending K3 GATE PASS — also blocked by T1, T2 (automation-service boundary), T3 (SLO numbers).

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

Status: deferred pending K3 GATE PASS — also blocked by T3 (SLO numbers, cancel / streaming UX) and T6 (provider state enum).

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

Status: deferred pending K3 GATE PASS — non-AI dry-run path could ship sooner, but stays deferred to keep Lane B coherent with B2.

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

Status: deferred pending K3 GATE PASS — also blocked by T1, T3, T6, and depends on Lane A1 + Lane B1 landing first.

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

Status: pending PM / SME assignment — five industry templates need domain SME input before engineering builds shell.

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

Status: pending PM / SME assignment — also blocked by T7 (rollback budget upgrade or downgrade decision).

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

Status: pending — active queue (kernel polish on shipped automation send_email path).

Owner recommendation: Codex.

Scope note: the guarded SMTP transport smoke already existed before
Phase 3. This D1 slice wires that existing harness into the Phase 3
aggregate release gate as `email:real-send`; it does not add a new
SMTP provider or send a real email without the existing explicit
guards.

- [x] Implement guarded real-send smoke.
  - PR: pre-existing before Phase 3; aggregated by #1544.
  - Merge commit: `1f9061f56`
  - Development MD: `docs/development/multitable-phase3-real-smtp-gate-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-real-smtp-gate-verification-20260514.md`
  - Verification summary: `email:real-send` delegates to `pnpm verify:multitable-email:real-send` and reports child status/path in Phase 3 artifacts.
- [x] Require `CONFIRM_SEND_EMAIL=1`.
  - PR: pre-existing before Phase 3; aggregated by #1544.
  - Merge commit: `1f9061f56`
  - Development MD: `docs/development/multitable-phase3-real-smtp-gate-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-real-smtp-gate-verification-20260514.md`
  - Verification summary: existing real-send harness exits 2 unless `CONFIRM_SEND_EMAIL=1` and `MULTITABLE_EMAIL_REAL_SEND_SMOKE=1` are both present.
- [x] Require dedicated test recipient env.
  - PR: pre-existing before Phase 3; aggregated by #1544.
  - Merge commit: `1f9061f56`
  - Development MD: `docs/development/multitable-phase3-real-smtp-gate-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-real-smtp-gate-verification-20260514.md`
  - Verification summary: existing real-send harness exits 2 unless `MULTITABLE_EMAIL_SMOKE_TO` is configured; D1 tests prove recipient values are redacted from aggregate artifacts.
- [ ] Tie send result to automation execution log.
  - PR:
  - Merge commit:
  - Development MD:
  - Verification MD:
  - Verification summary: intentionally not claimed by this transport-level D1 aggregation slice; the shipped RC automation smoke covers execution-log behavior with the default mock channel, and D4 remains the correct place for repeat-fire automation-log soak semantics.
- [x] Redact SMTP credentials and recipients in artifacts.
  - PR: #1544
  - Merge commit: `1f9061f56`
  - Development MD: `docs/development/multitable-phase3-real-smtp-gate-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-real-smtp-gate-verification-20260514.md`
  - Verification summary: D1 adds email delegate artifact-integrity coverage for SMTP host/user/password/from and smoke recipient values.

## Lane D2 - Large Table Performance Gate

Status: deferred — D2 perf-gate must not run on 142 during K3 PoC live window (T4). Re-entry requires K3-free staging or K3 GATE PASS.

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

Status: deferred — D3 must explicitly choose snapshot vs golden matrix semantics for sheet / view / field / record / export paths (T5) before activation.

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

Status: pending — active queue (kernel polish on shipped automation execution paths).

Owner recommendation: Codex.

- [x] Exercise `record.created` trigger repeatedly.
  - PR: #1547
  - Merge commit: `855ba871e`
  - Development MD: `docs/development/multitable-phase3-automation-soak-gate-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-automation-soak-gate-verification-20260514.md`
  - Verification summary: `MULTITABLE_AUTOMATION_SOAK_ITERATIONS` controls repeated record creation; fake-fetch tests cover two iterations and the default remote gate blocks until configured.
- [x] Exercise `update_record` action repeatedly.
  - PR: #1547
  - Merge commit: `855ba871e`
  - Development MD: `docs/development/multitable-phase3-automation-soak-gate-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-automation-soak-gate-verification-20260514.md`
  - Verification summary: soak rule updates a status field on each created record and verifies read-back state.
- [x] Exercise `send_email` action repeatedly in safe mode.
  - PR: #1547
  - Merge commit: `855ba871e`
  - Development MD: `docs/development/multitable-phase3-automation-soak-gate-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-automation-soak-gate-verification-20260514.md`
  - Verification summary: soak requires `MULTITABLE_AUTOMATION_SOAK_EMAIL_SAFE_MODE=mock` and uses reserved test-local recipient identifiers; tests validate execution-log shape without real SMTP.
- [x] Exercise `send_webhook` action against a controlled local/staging sink.
  - PR: #1547
  - Merge commit: `855ba871e`
  - Development MD: `docs/development/multitable-phase3-automation-soak-gate-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-automation-soak-gate-verification-20260514.md`
  - Verification summary: soak requires both success and expected-failure webhook sink URLs before it can PASS.
- [x] Verify execution log persistence and failure handling.
  - PR: #1547
  - Merge commit: `855ba871e`
  - Development MD: `docs/development/multitable-phase3-automation-soak-gate-development-20260514.md`
  - Verification MD: `docs/development/multitable-phase3-automation-soak-gate-verification-20260514.md`
  - Verification summary: soak polls automation logs for every rule and treats the controlled failing webhook as PASS only when failed executions are persisted with step errors.
- [x] Add redacted execution support packet copy/download actions to the shipped run-history UI.
  - PR: #1564
  - Merge commit: `8dd1eb1b1`
  - Development MD: `docs/development/multitable-automation-log-support-packet-development-20260515.md`
  - Verification MD: `docs/development/multitable-automation-log-support-packet-verification-20260515.md`
  - Verification summary: `MetaAutomationLogViewer` exposes copy/download actions for each expanded execution; generated Markdown/JSON packets use the shared automation log redactor and summarize step output/error without raw recipient, token, SMTP, webhook, or DingTalk receiver values.

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
