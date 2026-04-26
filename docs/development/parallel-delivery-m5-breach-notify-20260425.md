# Parallel Delivery — M5 Automation + SLA Breach Notify — 2026-04-25 (wave 9)

## Wave scope

Two file-disjoint lanes baselined from `origin/main = fa559458b`, post-review
rebased to `origin/main = 892ed2f9c`, executed in
isolated `git worktree`s. Per the `integration-erp-platform-roadmap-20260425.md`
约束（阶段一锁定不开新战线 / 不动 K3 PoC 路径），this wave intentionally closes
existing themes rather than opens new product surface.

| Lane | Theme closed | Branch | Final commit |
|------|-------------|--------|---|
| **M5** | Multitable monolith decomposition (M0→M2→M3→M4→**M5**) | `codex/multitable-m5-automation-service-20260425` | `3559ed4e1` |
| **Breach-Notify** | WP5 SLA observability — `onBreach()` hook → DingTalk + email channels | `codex/approval-sla-breach-notify-20260425` | `50179d9d7` |

Both run green against origin/main; zero file overlap between the two; zero
overlap with the 4 currently-open PRs (#1139 / #1138 / #1137 / #1129) and zero
touch on `plugins/plugin-integration-core/*` (mainline K3 PoC path).

## Lane M5 — automation-service extraction

**Files (7 total, +859 / −679):**

- `packages/core-backend/src/multitable/automation-service.ts` — new, +290 LoC.
- `packages/core-backend/src/routes/univer-meta.ts` — **−184 / +21**, net **−163**.
- `packages/core-backend/tests/unit/multitable-automation-service.test.ts` —
  expanded 12 → 33 tests, +270 LoC.
- Dev + verification MDs.

**What moved:** route-handler residue — `serializeAutomationRule`,
`parseDingTalkAutomationDeliveryLimit`, `parseCreateRuleInput`,
`parseUpdateRuleInput`, `preflightDingTalkAutomationCreate`,
`preflightDingTalkAutomationUpdate`, plus `VALID_ACTION_TYPES` constant and
defensive trigger / action-type validation inside `createRule` / `updateRule`.

**Composition, not replacement:** the `AutomationService` class itself was
extracted in earlier waves; M5 is the cleanup that hoists the remaining
parsing / preflight / serialization helpers out of the route, leaving thin
composition handlers that preserve capability→503→parse→preflight→service
ordering and identical JSON envelopes / error messages.

**Verification:**

- `pnpm --filter @metasheet/core-backend exec tsc --noEmit` → exit 0.
- Unit 9 files / **226 tests pass** — `multitable-automation-service` (33),
  `automation-routes-wiring`, `automation-scheduler-leader`,
  `automation-scheduler-metrics`, `automation-v1` (122),
  `dingtalk-automation-link-validation`, `plugin-automation-registry`,
  `multitable-permission-service`, `multitable-access`.
- Integration **32 / 32 pass** — `dingtalk-automation-link-routes.api.test.ts`
  (the sentinel that spies on `validateDingTalkAutomationLinks` and asserts
  post-normalization payloads) passes unchanged.

**Caveats:**

- Smaller LoC delta than M4 (−163 vs M4 −1034) because the
  `AutomationService` class itself was extracted in earlier waves; M5 only
  had route-handler residue left to lift. Documented in the verification MD.
- DingTalk normalization runs twice on writes (route preflight + service
  re-validation inside `createRule` / `updateRule`). Idempotent and
  intentional — keeps the service self-validating for non-route callers
  (e.g., automation rules created via API tokens). Not flagged for cleanup.

**Theme closed:** with M5 landed, the multitable monolith decomposition track
(M0 → M2 → M2-PATCH → M3 → M4 → M5) reaches a stable equilibrium. Future
multitable refactors should be judged on their own merit, not as part of the
extraction theme.

## Lane Breach-Notify — SLA breach channel wire-up

**Files (12 total, +1242 / −495):**

- `packages/core-backend/src/services/ApprovalBreachNotifier.ts` — new
  notifier orchestrator.
- `packages/core-backend/src/services/breach-channels/index.ts` — new channel
  contract + barrel.
- `packages/core-backend/src/services/breach-channels/dingtalk-channel.ts` —
  new, reuses `integrations/dingtalk/robot.ts` leaf helpers
  (`buildDingTalkMarkdown`, `buildSignedDingTalkWebhookUrl`,
  `normalizeDingTalkRobotWebhookUrl`, `validateDingTalkRobotResponse`); HTTP
  via native `fetch` mirroring `automation-executor.ts:1393`.
- `packages/core-backend/src/services/breach-channels/email-channel.ts` —
  logging stub (no SMTP/SendGrid/Mailgun in repo today; per task constraint
  no new deps were added).
- `packages/core-backend/src/services/ApprovalMetricsService.ts` — adds
  `ApprovalBreachContext` type + `listBreachContextByIds()` (one JOIN over
  `approval_metrics` + `approval_instances` + `approval_templates`).
- `packages/core-backend/src/index.ts` — wires `notifier` into
  `ApprovalSlaScheduler.onBreach`, wrapped in try/catch so notifier failure
  cannot break the next tick.
- `packages/core-backend/tests/unit/approval-breach-notifier.test.ts` (8) +
  `dingtalk-breach-channel.test.ts` (6).
- Dev + verification MDs.

**Channel decisions:**

- **DingTalk:** reused leaf helpers from `integrations/dingtalk/robot.ts` —
  did NOT reuse the `DingTalkNotificationChannel` class because its
  `sender(notification, recipients)` legacy shape would force fake
  notification objects.
- **Email:** stubbed. Repo has no `nodemailer` / SendGrid / Mailgun /
  transporter. Per task spec ("do NOT add new deps"), the channel logs and
  returns `{ok: false, error: 'email transport not configured'}`. Wiring a
  real transport is recorded as a follow-up.

**Idempotency:** in-memory FIFO `Set<instanceId>` bounded at 5000. Justified
in the dev MD: `checkSlaBreaches` filters on `sla_breached = FALSE` so the
scheduler will not re-fire a breach event for the same id within the same
process; the in-memory set is a defensive belt against rapid retick. The
restart-semantics rationale was corrected in commit `190bedee5` after
advisor feedback. Post-review, channels are also **env-gated** (commit
`50179d9d7`) so the notifier registers a channel only when its env vars
are configured — eliminates per-breach failure noise on default
deployments.

**Failure isolation:** a channel throwing does NOT block other channels;
notifier throwing does NOT block scheduler tick.

**Verification:**

- `npx tsc --noEmit` → exit 0.
- `approval-breach-notifier.test.ts` → **8 / 8 pass**.
- `dingtalk-breach-channel.test.ts` → **6 / 6 pass**.
- `approval-sla-scheduler.test.ts` → **7 / 7 pass** (regression green).
- `approval-metrics-service.test.ts` → **15 / 15 pass** (existing coverage
  green after JOIN method added).
- Aggregate **36 / 36 pass**, ~300 ms.

**Theme closed:** with breach notifications wired, the WP5 observability
loop is structurally complete: instance start → node activations →
terminal → SLA scan → breach mark → channel dispatch. Real SMTP transport
is the only remaining piece.

## Cross-lane interaction / merge order

No file conflicts between M5 and Breach-Notify:

- M5 touches `multitable/automation-service.ts` (new) + `routes/univer-
  meta.ts`.
- Breach-Notify touches `services/ApprovalBreachNotifier.ts` (new) +
  `services/breach-channels/*` (new) + `services/ApprovalMetricsService.ts` +
  `services/breach-channels/index.ts` + `src/index.ts`.

**Shared touch surface check:** none.

**Recommended merge order:** either order works. Suggest **M5 → Breach-Notify**
for narrative continuity (M5 closes a multi-wave theme; Breach-Notify lands
as a bonus closeout immediately after).

## Validation commands (for PR review)

Lane M5:

```bash
cd /tmp/ms2-m5-automation
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm -F @metasheet/core-backend test -- multitable-automation-service
pnpm -F @metasheet/core-backend test -- automation
pnpm -F @metasheet/core-backend test -- univer-meta
```

Lane Breach-Notify:

```bash
cd /tmp/ms2-breach-notify
npx tsc --noEmit
pnpm -F @metasheet/core-backend test -- approval-breach-notifier
pnpm -F @metasheet/core-backend test -- dingtalk-breach-channel
pnpm -F @metasheet/core-backend test -- approval-sla-scheduler
```

## Follow-up surface

- **Email channel real transport** — once dep policy permits, wire SMTP
  (nodemailer) or a managed sender (SES/SendGrid). Today the channel is a
  logging stub.
- **Persistent `breach_notified_at` column** — for cross-restart /
  cross-leader-takeover dedupe. The in-memory set is correct under steady-
  state but cannot defend against rapid leader churn. Optional migration.
- **Live DingTalk integration test** — currently only mocked; manual `curl`
  verification documented in the verify MD.
- **Multitable** — M0..M5 closed. Future refactors evaluated standalone, not
  as theme work.

## Explicit non-goals (this wave)

- Not rebased against each other — both baselined from `origin/main` and
  land independently via PR.
- Not pushed; no PRs opened — user opens from these branches.
- No changes to `plugins/plugin-integration-core/*` — K3 Live PoC path
  untouched.
- No new npm dependencies added.
- No `pnpm install` artefacts committed (`pnpm-lock.yaml` /
  `tools/*/node_modules/` symlink drift kept out per task constraints).

## Individual dev + verification MDs

Each lane's worktree contains its own pair, committed alongside the code:

- Lane M5:
  - `docs/development/multitable-m5-automation-service-development-20260425.md`
  - `docs/development/multitable-m5-automation-service-verification-20260425.md`
- Lane Breach-Notify:
  - `docs/development/approval-sla-breach-notify-development-20260425.md`
  - `docs/development/approval-sla-breach-notify-verification-20260425.md`

These land with their respective PRs; this top-level MD summarises the wave.
