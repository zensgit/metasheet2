# Multitable Feishu Phase 3 — D0 Release Gate Skeleton (Development)

- Date: 2026-05-14
- Branch: `codex/multitable-phase3-release-gate-skeleton-20260514`
- Base: `origin/main` at `0b4575fe3` (after #1539)
- Author: Claude (Opus 4.7, 1M context), interactive harness; operator-supervised
- PR sequence anchor: PR R2 per
  `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
  § Suggested PR Sequence (active queue)
- Redaction policy: this PR contains no AI provider key, SMTP
  credential, JWT, bearer token, DingTalk webhook URL or robot
  `SEC...`, K3 endpoint password, Agent ID value, recipient user id,
  temporary password, or `.env` content. The redaction helper
  introduced here covers each of these classes plus database URI
  credentials.

## What this PR ships

Implements the D0 release-gate skeleton required by the Phase 3 active
queue. Provides:

- A new gate runner `scripts/ops/multitable-phase3-release-gate.mjs`
  that routes between an `release:phase3` aggregator and three new
  sub-gates: `perf:large-table`, `permissions:matrix`,
  `automation:soak`.
- A shared redaction helper
  `scripts/ops/multitable-phase3-release-gate-redact.mjs` covering
  Bearer / JWT / DingTalk `SEC` / `sk-` / env-style API_KEY /
  CLIENT_SECRET / TOKEN / SECRET / PASSWORD / SMTP credentials /
  postgres + mysql URIs / structured-field redaction by key name.
- A shared JSON + Markdown report writer
  `scripts/ops/multitable-phase3-release-gate-report.mjs` that runs
  every report through the redaction helper before persisting to
  disk.
- Three test files exercising redaction (16 cases), report writer
  (5 cases), and the runner end-to-end (12 cases including the
  artifact-integrity test that concatenates stdout + stderr +
  report.json + report.md and asserts no env-supplied secret leaks).
- Four new `package.json` scripts:
  - `verify:multitable-release:phase3`
  - `verify:multitable-perf:large-table`
  - `verify:multitable-permissions:matrix`
  - `verify:multitable-automation:soak`

## What this PR explicitly does NOT do

- Does **not** modify the existing
  `verify:multitable-email:real-send` or
  `verify:multitable-email:readiness` scripts. The existing
  `scripts/ops/multitable-email-real-send-smoke.ts` and
  `scripts/ops/multitable-email-transport-readiness.ts` stay
  authoritative. Wiring the email-real-send sub-gate into the
  Phase 3 aggregator is PR R3 (D1) scope.
- Does **not** implement any real harness for `perf:large-table`,
  `permissions:matrix`, or `automation:soak`. D0 ships the routing,
  redaction, and report layers only. The real soak harness for
  `automation:soak` is PR R4 (D4) scope. D2 / D3 stay deferred under
  the K3 PoC stage-1 lock plus T4 / T5 closure.
- Does **not** touch `plugins/plugin-integration-core/*`,
  `lib/adapters/k3-wise-*`, multitable runtime, OpenAPI source,
  generated dist, or any migration / route / workflow.
- Does **not** introduce a new product战线 (no AI provider, no
  industry template surface). Per the Activation Constraints in the
  plan, D0 is kernel polish on already-shipped multitable +
  automation features.

## Exit-code contract

| Status | Exit code | Semantics |
| --- | --- | --- |
| PASS | 0 | All work succeeded. |
| FAIL | 1 | Real failure surfaced (e.g., harness threw, real check failed). |
| BLOCKED | 2 | Sub-gate refused to run (missing env, deferred lane, skeleton stage). The aggregator never collapses BLOCKED into FAIL — when any child is BLOCKED, the aggregator returns 2, not 1. |

`--allow-blocked` overrides the runner's exit code to 0 when the
status is BLOCKED, but the recorded `status` field in
`report.json` / `report.md` stays `blocked`. This is an intentional
escape hatch for downstream ops scripts that need to chain blocked
sub-gates without failing the overall pipeline.

## File inventory

| Path | Lines | Purpose |
| --- | --- | --- |
| `scripts/ops/multitable-phase3-release-gate.mjs` | ~210 | Main runner: argparse, routing, blocked-mode, summary line. |
| `scripts/ops/multitable-phase3-release-gate.test.mjs` | ~190 | 12 tests covering in-process executeGate, spawn-based runs, allow-blocked, artifact-integrity. |
| `scripts/ops/multitable-phase3-release-gate-redact.mjs` | ~100 | Shared redaction helper (string + structured object). |
| `scripts/ops/multitable-phase3-release-gate-redact.test.mjs` | ~135 | 16 tests covering 11 secret pattern classes plus structured-field masking. |
| `scripts/ops/multitable-phase3-release-gate-report.mjs` | ~60 | JSON + Markdown writer that runs every report through `redactValue`. |
| `scripts/ops/multitable-phase3-release-gate-report.test.mjs` | ~95 | 5 tests covering buildReport, renderMarkdown, writeReport disk output. |
| `package.json` | +4 | Four new `verify:multitable-*` scripts. |
| `docs/development/multitable-phase3-release-gate-skeleton-development-20260514.md` | this file | Development MD. |
| `docs/development/multitable-phase3-release-gate-skeleton-verification-20260514.md` | sibling | Verification MD. |

## Sub-gate env contracts (D0 stays BLOCKED regardless)

| Gate | Required env | D0 status | Re-entry |
| --- | --- | --- | --- |
| `perf:large-table` | `MULTITABLE_PERF_LARGE_TABLE_CONFIRM`, `MULTITABLE_PERF_TARGET_DB` | BLOCKED (D2 deferred + T4) | K3-free staging or K3 GATE PASS |
| `permissions:matrix` | `MULTITABLE_PERM_MATRIX_CONFIRM` | BLOCKED (D3 deferred + T5) | snapshot-vs-golden decision + K3-free or PASS |
| `automation:soak` | `MULTITABLE_AUTOMATION_SOAK_CONFIRM` | BLOCKED (D0 stub) | PR R4 implements real soak harness |

Even when all required env vars are set, sub-gates at the D0 stage
remain `blocked` with the reason "D0 skeleton: env vars accepted as
input but no harness implementation present". This prevents the
skeleton from accidentally appearing to PASS before the real harness
is wired in by a follow-up PR.

## Redaction coverage

The shared helper covers 11 string-pattern classes:

1. `Bearer <token>` HTTP auth header
2. JWT (`eyJ...`-prefixed)
3. DingTalk robot `SEC...` secret
4. OpenAI / Anthropic / generic `sk-...` keys
5. `access_token=...` URL query
6. `publicToken=...` URL query
7. `sign=...` / `timestamp=...` DingTalk URL query
8. Generic env-style `*_API_KEY` / `*_CLIENT_SECRET` / `*_TOKEN` /
   `*_SECRET` / `*_PASSWORD` assignments
9. `SMTP_USER` / `SMTP_PASS` / `SMTP_PASSWORD` / `SMTP_HOST` /
   `SMTP_PORT` / `SMTP_FROM` assignments
10. `postgres://user:pass@host` URI credentials
11. `mysql://user:pass@host` URI credentials

Plus a structured-field allowlist masking 19 well-known sensitive
object keys (`authToken`, `apiKey`, `clientSecret`, `password`,
`smtpPassword`, `recipient`, `webhook`, etc.) regardless of value
content.

## Stage-1 lock compliance

- [x] No change under `plugins/plugin-integration-core/*`.
- [x] No change under `lib/adapters/k3-wise-*`.
- [x] No new product战线 (no AI surface, no industry templates, no
      marketplace).
- [x] No schema, migration, route, workflow change.
- [x] No change to existing `verify:multitable-email:*` scripts or
      the underlying `multitable-email-{real-send-smoke,transport-readiness}.ts`
      files.
- [x] Kernel polish on already-shipped multitable + automation
      features — explicitly permitted per
      `project_k3_poc_stage1_lock.md`.

## Cross-references

- Plan: `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
  (Activation Constraints + Suggested PR Sequence active queue)
- TODO: `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md`
  (Lane D0 — Release Gate Skeleton)
- Independent review: `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md`
  (Recommended Re-Scope, Lane D subset)
- Roadmap: `docs/development/integration-erp-platform-roadmap-20260425.md`
  §4-§5 (stage-1 lock)
- Existing email gate (NOT modified):
  `scripts/ops/multitable-email-real-send-smoke.ts` +
  `scripts/ops/multitable-email-transport-readiness.ts`
- Existing DingTalk release-gate pattern reference:
  `scripts/ops/dingtalk-work-notification-release-gate.mjs`

## Follow-ups (not in this PR)

- PR R3 — D1 real SMTP gate: bind the existing
  `verify:multitable-email:real-send` script into the Phase 3
  aggregator and add the `email:real-send` sub-gate routing.
- PR R4 — D4 automation soak: replace the `automation:soak`
  skeleton with the real `record.created` / `update_record` /
  `send_email` / `send_webhook` repeat-fire harness.
