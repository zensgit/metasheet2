# DingTalk Sync Integrated Roadmap

- Date: 2026-07-08
- Status: draft for planning (Rev 3.2 — adversarial review of PR #3873 verified all 16 code-anchor groups TRUE, 0 P1/P2; this rev applies its 4 polish items: DT-HARDEN-11 ticket + evidence row for 6.10, scoped 6.6 problem statement, corrected 6.10 add-keys list, DT-OPS ticket ordering. Rev 3.1 — incorporates review pass 2026-07-08: added 6.1b auto-provision fence, 6.11 attendance CSV header parity, multi-replica OAuth state-store in 7.8, deprovision severity note in 7.1, corrected 8.2 supersede scope, deferred-P3 note in 11)
- Source audit: 2026-07-07 full-line DingTalk integration audit (Rev 3), baseline `origin/main @ 3add4c07e`; review-pass premises re-verified against later `origin/main`. This roadmap is self-contained; the detailed audit and review notes are retained as working artifacts outside the repo.
- Working-tree note: planning and implementation must first refresh `origin/main` and compare it with this source baseline.

## 1. Purpose

This document consolidates the DingTalk sync audit plan and the internal consultant-style improvement roadmap into one execution-oriented plan.

The goal is not to add more DingTalk entry points first. The goal is to harden the current integration so it can be safely operated at enterprise scale:

- identity and directory sync must be correct and reversible;
- offboarding must close the local-account access loop;
- outbound delivery must avoid secret leakage, duplicate delivery, and misleading status;
- sync runs must be observable, resumable, and protected from concurrent full pulls;
- future real-time capabilities should reuse the same directory, approval, and delivery boundaries.

## 2. Baseline Discipline

Before creating tickets or implementation branches:

1. Run `git fetch origin --prune`.
2. Record `git rev-parse origin/main`.
3. Compare the result with the source audit baseline `3add4c07e`.
4. If `origin/main` has moved, re-check the touched DingTalk, directory, approval, automation, attendance, and auth files in a fresh worktree.
5. Keep the audit finding only if it is still present at the current head.

This rule exists because the Rev 3 review found two baseline-drift cases: token cache and E1 frontend wiring existed on current `origin/main`, but not in an older detached review checkout.

## 3. Product Judgment

The DingTalk integration line is already structurally solid:

- DingTalk directory data lands in shadow `directory_*` tables before affecting local users.
- Binding and admission are explicit reviewable workflows.
- Email and mobile matches are conservative.
- Department-manager enrichment preserves last-known-good manager data on transient API failures.
- Approval-card delivery has a dedicated ledger instead of relying on generic delivery history.
- Work notification and approval paths mostly fail closed when identity mapping is missing.

The remaining work is concentrated in four areas:

- access closure: offboarding and grant behavior;
- reliability: timeout, retry, lock, run lifecycle, partial failures;
- governance: audit logs, secrets, retention, PII and delivery content exposure;
- operability: dry-run, run diff, alerting, metrics, and staging smoke gates.

## 4. Execution Principles

- Fix hard correctness and security issues before expanding features.
- Put locks before external API pulls, not only around database writes.
- Prefer explicit `integration_id` over "latest active integration" resolution.
- Treat default-off features as requiring a full HTTP wire test and staging smoke before release.
- Preserve `directory_*` as the single organization source for DingTalk-backed approval routing.
- Do not introduce a second organization model; future local org charts should use `provider='local'` on the same directory model.
- Keep delivery history useful but not dangerous: redact, index, expire, and scope it.

## 5. Phase 0: Planning Gate

This phase is mandatory before implementation.

| Item | Output |
|---|---|
| Refresh source baseline | Current `origin/main` SHA recorded in the ticket or PR description |
| Re-check P1 findings | Each P1 marked present, fixed, or superseded |
| Split tickets by blast radius | Auth, directory sync, delivery, attendance, UI/ops, docs |
| Define smoke evidence | Supertest, unit/integration tests, staging probes, and manual DingTalk evidence where needed |
| Protect worktree hygiene | Use a fresh worktree if the local checkout is detached or dirty |

## 6. Phase 1: Current Iteration Hardening

These are the high-confidence, high-value fixes. They should be handled before new DingTalk capabilities are expanded.

### 6.1 E1 Container Login Wire Fix

Problem:

- The container-login backend route and frontend path can diverge.
- Current audited main reports frontend POST `/api/auth/login/dingtalk/container`, backend route `/api/auth/dingtalk/container`, and auth whitelist missing the container route.
- Existing tests bypass the full HTTP middleware path.

Target:

- Register the backend route where the frontend calls it, or update both sides to one canonical route.
- Ensure the route is intentionally public only for this auth-code exchange path.
- Add a full Express/Supertest integration test that goes through the global JWT gate and route stack.

Acceptance:

- Disabled flag returns expected disabled response.
- Missing authCode returns 400.
- Valid mocked DingTalk authCode returns a JWT/session response.
- No route in the E1 path requires an existing JWT.

### 6.1b Auto-Provision Corp Allowlist Fence

Problem:

- `isDingTalkCorpAllowed` treats an empty `DINGTALK_ALLOWED_CORP_IDS` as allow-all (`runtime-policy.ts:28-30`; the `assertDingTalkCorpAllowed` path is `runtime-policy.ts:45-47`).
- If an operator enables `DINGTALK_AUTH_AUTO_PROVISION=true` without also setting the corp allowlist, any DingTalk user from any org completing OAuth auto-creates a local account.
- The two safe defaults are independent, so a single misconfiguration removes the fence. The staging template already ships `DINGTALK_ALLOWED_CORP_IDS=replace-me` with `AUTO_PROVISION` one flip away.

Target:

- Refuse to enable auto-provision (or emit a loud startup warning) when the corp allowlist is empty.
- Document the auto-provision + allowlist coupling in the env template next to both keys (see 6.10).

Acceptance:

- With an empty allowlist, auto-provision is either rejected at startup or surfaced as an explicit high-visibility warning.
- With a configured allowlist, auto-provision behaves as today.
- Test covers empty-allowlist + auto-provision-on rejection/warning path.

### 6.2 Auto-Admission and OpenId Guard

Problem:

- Auto-admission currently enables DingTalk grant unconditionally.
- If the directory account has `corp_id` but no `open_id`, the grant guard throws after local user insertion.
- The outer sync path catches the error and continues, leaving a possible active local orphan user.

Target:

- Compute `enableDingTalkGrant = Boolean(openId)` for auto-admission.
- Move the grant assertion before inserting a local user.
- Add a one-time orphan-user inventory script or report.
- Preserve manual-admission behavior and UI semantics.

Acceptance:

- Account with no `open_id` can be admitted only with grant disabled.
- No local user row is inserted if binding cannot be safely completed.
- Sync stats distinguish admitted, admitted-without-grant, and failed.
- Regression test covers the no-openId path.

### 6.3 Group Robot Secret Encryption

Problem:

- `dingtalk_group_destinations.webhook_url` contains `access_token`.
- `secret` is also stored as plain text.
- Response masking exists, but database dump exposure remains dangerous.

Target:

- Encrypt both webhook URL and secret using the existing encrypted-secret helper.
- Provide a backward-compatible migration path for existing plain values.
- Keep API responses masked and never return raw secret values.

Acceptance:

- New rows store encrypted values.
- Existing plain rows are migrated or decrypted through a compatibility reader until migration completes.
- Secret presence remains visible as a boolean only.
- Tests cover create, update, list, test-send, and delivery send.

### 6.4 Batch Bind and Unbind Audit Integrity

Problem:

- Batch bind/unbind runs item by item.
- A mid-batch failure leaves earlier committed items without route-level audit logs.
- The caller receives one error instead of per-item results.

Target:

- Return per-item `{ succeeded, failed }` results.
- Write audit immediately after each successful item.
- Treat partial failure as a normal batch result, not a total HTTP failure.

Acceptance:

- Successful items have audit logs even when later items fail.
- UI can show exact success and failure counts.
- Retrying a failed subset does not collide with already successful items.

### 6.5 Sync Run Lease Before External Pull

Problem:

- Manual sync, scheduler sync, and multiple app replicas can overlap.
- A transaction-only advisory lock would not protect the expensive DingTalk API pull stage.

Target:

- Acquire a run lease or session-level advisory lock before any DingTalk API call.
- Manual trigger returns 409 with current run context when locked.
- Scheduler skips and logs when locked.
- Release lock in `finally`.

Acceptance:

- Two concurrent manual syncs produce one run and one 409/skip.
- Manual and scheduler collision is deterministic.
- Multi-replica behavior is covered by DB-level lock semantics.

### 6.6 DingTalk Request Timeout

Problem:

- DingTalk client calls in `requestDingTalkJson` use naked `fetch` with no timeout — directory sync, person work notification, approval card, and token fetch all go through it. (The group-robot delivery path already applies a 5s abort at the service layer; it is the exception, not the rule.)
- A hung request can block sync or automation for too long.

Target:

- Add a default timeout to `requestDingTalkJson`.
- Allow selected callers to override timeout where justified.
- Preserve business-error classification.

Acceptance:

- Timeout becomes a typed operational error.
- Directory sync records failed run and alert.
- Automation delivery records failed delivery rather than hanging.

### 6.7 Delivery Partial-Failure Semantics

Problem:

- Personal work-notification sends can write success rows for earlier batches, then mark all recipients failed when a later batch throws.
- Approval-card failed marking currently swallows mark-failed errors.

Target:

- Track sent and unsent batches separately.
- Record failed delivery only for the batch that failed or recipients not yet sent.
- Make card mark-failed observable.

Acceptance:

- A recipient cannot receive both success and failed rows for the same send attempt unless explicitly modeled as retry.
- Partial success is returned as a partial result.
- Card pending rows have a cleanup or alert path.

### 6.8 Primary Department Semantics

Problem:

- `is_primary` is derived from the first department ID in the array.
- Approval manager routing consumes the primary department.
- Multi-department users can route approvals through the wrong management chain.

Target:

- Use DingTalk's real primary-department signal, such as `dept_order_list`, after confirming the field shape in staging.
- Backfill existing `directory_account_departments.is_primary`.
- Add a golden test for multi-department approval routing.

Acceptance:

- Multi-department requester resolves direct manager and manager chain from the real primary department.
- Existing data can be corrected idempotently.

### 6.9 Delivery Table Hygiene

Problem:

- Delivery telemetry stores rendered content and response bodies.
- Some query patterns lack targeted indexes.
- Robot response validation can treat malformed successful HTTP responses as success.

Target:

- Add `(automation_rule_id, created_at DESC)` style indexes where list routes need them.
- Add retention sweep for delivery telemetry.
- Tighten robot response validation to require a parseable object and `errcode === 0`.
- Add length guards for outgoing message content.

Acceptance:

- Delivery history queries stay bounded.
- Sensitive content does not live indefinitely.
- 200 HTML or malformed proxy responses are not recorded as successful robot sends.

### 6.10 Environment Template and Staging Smoke

Problem:

- Staging env examples include dead DingTalk variables and miss active ones.
- Default-off features can pass unit tests while failing only when enabled.

Target:

- Remove dead DingTalk env keys.
- Add the missing active keys: container login flag, agent ID, approval-card link secret. (Public app URL and corp allowlist already exist in the template — verify and annotate them, including the auto-provision coupling from 6.1b, rather than re-adding.)
- Add a staging smoke checklist for E1, work notification, approval card, and directory sync.

Acceptance:

- Staging env template matches variables actually read by code.
- Release checklist contains explicit default-off smoke gates.

### 6.11 Attendance CSV Header Detection Parity

Problem:

- The large-file upload path accepts any non-empty first row as the header, while the inline path scans for a name+date header row.
- A DingTalk export with a leading title row imported via the large-file path mis-parses: every row is skipped as missing work date, while the same file imported inline succeeds.
- This is a correctness bug, not a strategic enhancement; it is placed in Phase 1 rather than the attendance strategic bucket (8.5).

Target:

- Reuse the inline header-detection semantics on the streaming/large-file path.
- Drop the unconditional first-row-is-header assumption for DingTalk-shaped CSVs.

Acceptance:

- A DingTalk export with a leading title row parses identically on inline and large-file paths.
- Regression test covers a title-row CSV through the large-file threshold path.

## 7. Phase 2: Weekly Structural Reinforcement

### 7.1 Offboarding Policy Executor

> Severity note: this is a **P1-severity** finding (departed DingTalk members retain local access). It is placed in Phase 2 because the executor is a design-and-build effort, not a quick fix — not because it is deprioritized. `DT-OPS-01` is correctly tagged P1 in the ticket table and should be scheduled alongside the Phase 1 batch, not after it.

Problem:

- `default_deprovision_policy` and `deprovision_policy_override` are stored but not enforced.
- DingTalk removal marks the shadow account inactive, but local password login can remain valid.

Target:

- Implement policy modes:
  - `manual_review`: current review-only behavior;
  - `disable_grant_only`: disable external DingTalk grant, keep local user active;
  - `mark_inactive`: disable local user, disable grant, preserve audit.
- Add offboarding audit entries.
- Add "inactive linked for N days" metric and alert.

Acceptance:

- Removing a linked DingTalk account from directory triggers the configured policy.
- Local user access behavior is explicit and test-covered.
- Admin UI shows policy effect before enabling it.

### 7.2 Unified DingTalk Transport

Target:

- Centralize timeout, retry, rate-limit, error classification, and token-cache usage.
- Retry only safe/idempotent API classes.
- Recognize DingTalk flow-control errors and back off.
- Keep work-notification sends bounded and classified.

Acceptance:

- Directory sync can survive transient 5xx and rate-limit errors within configured retry bounds.
- Repeated flow-control failures produce clear run stats and alerts.

### 7.3 Async Sync and Dry-Run Preview

Target:

- Change manual sync to `202 + runId`.
- Add preview mode that reports:
  - would-create accounts;
  - would-admit users;
  - would-disable or mark inactive;
  - would-bind, would-unbind, would-project member groups;
  - would-grant roles or namespaces.

Acceptance:

- Large tenant sync is not tied to one long HTTP request.
- Auto-admission can be safely reviewed before apply.

### 7.4 Run-Level Observability

Target:

- Persist per-run change summaries.
- Render alert details in admin UI.
- Connect run and alert lists to server-side pagination and filters.
- Add external alert delivery for repeated sync failures.
- Add manager-binding coverage metrics for approval routing.

Acceptance:

- Operators can answer "what changed in this run" without reading logs.
- Failed nightly sync is visible outside the admin panel.
- Approval-routing health is visible through directory metrics.

### 7.5 Explicit Multi-Integration Binding

Problem:

- Some work notification and approval-card flows can resolve config from env or latest active integration.
- Multi-corp deployments need explicit routing.

Target:

- Carry `integration_id` from directory account/link resolution into notification and approval-card delivery.
- Store `integration_id` on approval-card delivery rows.
- Resolve agent ID, link secret, public URL, and app credential from the selected integration.

Acceptance:

- A user bound under corp A cannot be notified with corp B credentials by "latest active" fallback.
- Single-integration deployments preserve env bootstrap behavior.

### 7.6 Delivery Closure

Target:

- Add idempotency key by execution, step, destination/user.
- Add retry tooling for failed deliveries.
- Promote DingTalk `task_id` into queryable columns.
- Keep `getsendresult` reconciliation as a later opt-in task.

Acceptance:

- Retrying automation execution does not duplicate sends to the same destination unless explicitly requested.
- Operators can trace accepted DingTalk async messages.

### 7.7 Sync Performance

Target:

- Prefer `user/list` as the primary field source after staging verification.
- Use detail calls only when fields are missing or manager-routing fields require it.
- Batch upsert departments, accounts, and account-department rows.
- Move bcrypt hashing outside the DB transaction.

Acceptance:

- 2000-user tenant target runtime is under one minute in staging-like conditions.
- DB transaction window is materially shorter.

### 7.8 Scheduler and Run Lifecycle

Target:

- Validate cron at save time.
- Add timezone support.
- Add startup cleanup for stale `running` runs or a heartbeat model. (Note: `DT-HARDEN-05` also introduces stale-run cleanup as part of the sync lease; assign ownership to one ticket so it is not implemented twice or dropped by mutual assumption. Recommended: land the minimal cleanup in `DT-HARDEN-05`, and let 7.8 own the heartbeat/observability refinement.)
- Ensure scheduler behavior is safe in multi-replica deployments.
- **OAuth state store under multi-replica**: the OAuth `state` falls back to an in-process Map when Redis is absent (`dingtalk-oauth.ts` `pendingStates`). Behind more than one replica without Redis, a callback can land on a different instance than the launch (valid state rejected → login fails), and one-time-use is only guaranteed per process; a transient Redis outage silently falls through to memory and also fails a legitimate login. Require a shared state store (Redis) as a precondition for multi-replica, and treat Redis-unavailable as a hard failure rather than a silent memory fallback in production.

Acceptance:

- Invalid cron cannot silently unschedule without clear UI feedback.
- Crash recovery does not leave stale "running" forever.
- Multi-replica deployment either uses a shared OAuth state store or documents single-replica as a hard constraint; production does not silently degrade to per-process memory state.

## 8. Phase 3: Strategic Evolution

### 8.1 Event-Driven Directory Sync

Use DingTalk Stream events for incremental directory changes. Keep cron full sync as daily reconciliation.

This should be evaluated together with one-tap interactive card Stream infrastructure.

### 8.2 Interactive Approval Cards

Complete one-tap Slice B (the supersede sweep already exists — `supersedeDingTalkApprovalCardDeliveriesForInstance`; Slice B reuses it rather than rebuilding it):

- in-chat button callback;
- card terminal state update;
- reuse of the existing stale-card supersede primitive from the Stream callback;
- owner-gated staging smoke.

### 8.3 Credential Single Source of Truth

Unify directory sync, OAuth, work notification, and approval-card config under integration config.

Environment variables should become bootstrap fallback only.

### 8.4 Local Directory Provider

If non-DingTalk organizations need manager approval routing, add editable `provider='local'` directory integrations.

Do not build a second department model.

### 8.5 Attendance Integration Expansion

Target:

- directory-driven attendee expansion;
- scheduled or event-based attendance pull;
- quiet hours;
- recipient unsubscribe;
- daily notification cap;
- CSV import preview warnings for timezone and header-shape risks.

### 8.6 Directory Admin Modernization

Target:

- split the large Directory Management SFC;
- introduce i18n label helpers;
- add run-diff panels;
- improve temporary-password reveal behavior;
- provide archive/delete lifecycle for integrations.

## 9. Suggested Ticket Split

| Ticket | Scope | Priority |
|---|---|---|
| DT-HARDEN-01 | E1 route/whitelist + full HTTP test | P1 |
| DT-HARDEN-02 | Auto-admission openId guard + orphan inventory | P1 |
| DT-HARDEN-03 | Group robot credential encryption | P1 |
| DT-HARDEN-04 | Batch bind/unbind per-item results and audit | P1 |
| DT-HARDEN-05 | Pre-API sync lease and stale run cleanup | P1 |
| DT-HARDEN-06 | DingTalk timeout + partial personal-delivery failure fix | P1 |
| DT-HARDEN-07 | Primary department correction and approval-routing golden | P1 |
| DT-HARDEN-08 | Delivery retention, indexes, response validation | P2 |
| DT-HARDEN-09 | Auto-provision corp-allowlist fence (6.1b) | P2 |
| DT-HARDEN-10 | Attendance CSV header detection parity (6.11) | P2 |
| DT-HARDEN-11 | Env template hygiene + default-off staging smoke checklist (6.10) | P2 |
| DT-OPS-01 | Deprovision policy executor (P1-severity; Phase 2 by size) | P1 |
| DT-OPS-02 | Async sync + dry-run preview | P2 |
| DT-OPS-03 | Run diff, alert delivery, manager coverage metrics | P2 |
| DT-OPS-04 | Explicit integration_id binding for outbound config | P2 |
| DT-OPS-05 | Multi-replica OAuth state store precondition (7.8) | P2 |
| DT-PERF-01 | User-list primary source and batch upsert | P2 |
| DT-STRAT-01 | Event-driven directory sync design lock | P3 |
| DT-STRAT-02 | Interactive card Slice B design and smoke gate | P3 |

## 10. Test and Evidence Matrix

| Area | Required Evidence |
|---|---|
| E1 login | Supertest through full middleware; mocked DingTalk success and failure; optional staging smoke |
| Auto-admission | Unit/integration test for missing openId; no orphan user insert; stats verified |
| Auto-provision fence | Empty-allowlist + auto-provision-on rejection/warning test |
| OAuth state store | Multi-replica or Redis-outage state-rejection behavior asserted (no silent memory fallback in prod) |
| Attendance CSV headers | Title-row CSV parses identically inline and via large-file path |
| Deprovision | Integration test for each policy mode; local login/grant behavior asserted |
| Sync lease | Concurrent trigger test; scheduler/manual collision test |
| Delivery | Batch partial-failure test; robot malformed response test; retention/index migration test |
| Secrets | Migration test for old plain rows and new encrypted rows |
| Primary department | Multi-department account golden; approval manager route test |
| Dry-run | Preview/apply parity test |
| Observability | Run diff persistence; alert details UI/API; repeated failure alert delivery |
| Env template | Template keys diffed against actual code reads (no dead keys, no missing active keys); staging smoke checklist exists and is exercised once per default-off feature |

## 11. Non-Goals for This Roadmap

- Replacing the existing `directory_*` model.
- Building a separate organization tree outside directory integrations.
- Making DingTalk the only identity source.
- Implementing Stream event sync before hardening current full sync.
- Expanding notification message formats before delivery reliability and privacy controls are fixed.

Deferred P3s (acknowledged, not scheduled this roadmap): external-auth session parity with password sessions (same claims/24h TTL/no step-up hook), JWT stored in localStorage, login-intent state not client-bound, application-level-only uniqueness on `union_id`/`open_id`. These are tracked in the source audit but intentionally out of scope for the hardening pass; revisit if the security posture bar rises.

## 12. Immediate Next Step

Start with `DT-HARDEN-01` and `DT-HARDEN-02`.

They are small, high-confidence, and directly reduce the risk created by default-off features and unsafe auto-admission behavior.
