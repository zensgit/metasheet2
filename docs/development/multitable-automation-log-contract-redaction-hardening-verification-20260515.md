# Multitable Automation Log Viewer — Contract + Redaction Hardening (Verification)

- Date: 2026-05-15
- Branch: `codex/multitable-automation-log-viewer-hardening-20260515`
- Base: `origin/main` at `dca447981`
- Author: Claude (Opus 4.7, 1M context), interactive harness; operator-supervised
- Companion: `multitable-automation-log-contract-redaction-hardening-development-20260515.md`
- Redaction policy: this document contains no AI provider key, SMTP
  credential, JWT, bearer token, DingTalk webhook URL or robot
  `SEC...`, K3 endpoint password, recipient user id, temporary
  password, or `.env` content.

## Result

**PASS / contract + redaction hardening landing**.

- 35 / 35 new tests pass.
- 72 / 72 existing manager spec passes (verifies my downstream fix to
  `describeTestRunExecution` does not regress).
- 7 / 7 backend route wiring spec passes (verifies the `/logs`
  response shape `{ executions: [...] }` and `triggeredAt /
  triggeredBy` field names are unchanged).

## V1 — Worktree provenance

```bash
git fetch origin main
git worktree add /private/tmp/ms2-automation-log-hardening-20260515 \
  -b codex/multitable-automation-log-viewer-hardening-20260515 origin/main
pnpm install --frozen-lockfile --prefer-offline
```

Result: `HEAD is now at dca447981 feat(integration): expose multitable
target in workbench (#1556)`. pnpm install completed in 3.2s (cache hit).

## V2 — New tests (35 cases)

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/automation-log-redact.spec.ts \
  tests/MetaAutomationLogViewer.spec.ts \
  --watch=false
```

Result:

```text
✓ tests/automation-log-redact.spec.ts  (23 tests) 3ms
✓ tests/MetaAutomationLogViewer.spec.ts  (12 tests) 61ms

Test Files  2 passed (2)
     Tests  35 passed (35)
  Duration  571ms
```

Breakdown:

- **23 redactor unit tests**: Bearer / JWT / SEC / sk- / 4 URL query
  patterns / env-style API_KEY family / prefix-aware SMTP_* (bare and
  `MULTITABLE_EMAIL_SMTP_*`) / `MULTITABLE_EMAIL_SMOKE_*` envelope /
  postgres / mysql URI; structured-field masking by name; recipient
  arrays; nested objects; free-text fallback; null / undefined safety;
  truncation cap; empty-input cases; clean-error pass-through.
- **12 component tests**: 4 backend-contract normalization (each
  removed field name asserted no longer breaks rendering), 3 step
  output / error redaction (uses `LEAKY_EXECUTION` fixture with raw
  webhook access_token, receiverUserIds, customer-order subject,
  Bearer token, SMTP password, OpenAI key — all 6 sentinel substrings
  asserted absent from the DOM), 5 load-failure assertions (logs
  endpoint throws, stats endpoint throws, redacted error message,
  retry button, empty-state suppressed during error).

## V3 — Existing manager spec (regression guard)

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-automation-manager.spec.ts --watch=false
```

Result:

```text
Test Files  1 passed (1)
     Tests  72 passed (72)
  Duration  1.08s
```

`describeTestRunExecution` (now reads `execution.duration` only — the
removed `execution.durationMs` alias is gone) continues to render
"(N ms)" test-run summaries correctly. All 72 manager-side assertions
still pass.

## V4 — Existing backend route wiring spec (contract guard)

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/automation-routes-wiring.test.ts --watch=false
```

Result:

```text
✓ POST /test returns flat AutomationExecution (not envelope)
✓ GET /logs returns shape { executions: [...] } — NOT { logs }
✓ GET /logs respects limit query param, clamped to [1,200]
✓ GET /stats returns flat AutomationStats (not envelope)
✓ returns 503 when automation service has not yet initialized
✓ lazy resolver picks up a service that initializes after route mount
✓ missing ruleId returns 400

Test Files  1 passed (1)
     Tests  7 passed (7)
  Duration  319ms
```

Confirms the `/logs` and `/stats` response shapes that this PR aligns
the frontend to are still intact on the backend side. No
backend-routing change required by this PR; the route shape was
already correct, only the frontend was reading wrong field names.

## V5 — Field-by-field contract alignment verification

| Backend field (from `automation-routes-wiring.test.ts:42-43` + `automation-log-service.ts`) | Old frontend interface | Old viewer reference | New frontend interface | New viewer reference |
| --- | --- | --- | --- | --- |
| `triggeredAt` | `startedAt` | `log.startedAt` | `triggeredAt` | `log.triggeredAt` |
| `triggeredBy` | `triggerType` | `log.triggerType` | `triggeredBy` | `log.triggeredBy` (`data-field="triggeredBy"`) |
| `duration` (ms) | `durationMs` | `log.durationMs ?? '-'` | `duration` | `log.duration ?? '-'` |
| `avgDuration` (ms, from `AutomationStats`) | `avgDurationMs` | `stats.avgDurationMs` | `avgDuration` | `stats.avgDuration` |

Component test `tests/MetaAutomationLogViewer.spec.ts` asserts each
of these 4 alignments against a real mounted component and a mock
client returning backend-shaped data.

## V6 — Redaction artifact integrity (DOM-side)

The `LEAKY_EXECUTION` fixture in
`tests/MetaAutomationLogViewer.spec.ts` injects six secret-shaped
values into a step output / error:

```text
output.webhookUrl  = 'https://oapi.dingtalk.com/robot/send?access_token=raw-leak-token-12345'
output.receiverUserIds = ['user-001', 'user-002']
output.subject = 'Customer Order 12345'
output.authToken = 'Bearer raw-bearer-leak-token-abcdefghijklmnop'
error = 'SMTP_PASSWORD=secret-pw-99 timed out for OPENAI_API_KEY=sk-raw-key-leak1234567890abc'
```

After mount + click-to-expand, all six substrings are asserted to be
absent from `item.textContent`:

```text
✓ does not render raw JSON.stringify of step.output
✓ does not render raw step.error
✓ shows redacted placeholder text in the output cell
```

The previous render path (`{{ JSON.stringify(step.output) }}`) would
have leaked every one of those sentinels into the DOM.

## V7 — Load-failure UX

| Scenario | Old behaviour | New behaviour | Test |
| --- | --- | --- | --- |
| `getAutomationLogs` throws | Silent — panel shows "No execution logs found." | Visible red error block with "Failed to load logs:" label + redacted message + Retry button | `renders a visible error alert when getAutomationLogs throws` |
| `getAutomationStats` throws | Silent | Same visible error block | `renders a visible error alert when getAutomationStats throws` |
| Error contains a Bearer token | Token would leak into UI if shown | Error message itself runs through `redactString` | `redacts secret-shaped content in the load error message` |
| Empty rule + error | Both "no logs" and (now) error would be ambiguous | Empty-state placeholder is suppressed while error is shown | `does not show the empty-state placeholder while error is present` |

## V8 — Scope check

```bash
git diff --cached --name-only
```

Result:

```text
apps/web/src/multitable/components/MetaAutomationLogViewer.vue
apps/web/src/multitable/components/MetaAutomationManager.vue
apps/web/src/multitable/types.ts
apps/web/src/multitable/utils/automation-log-redact.ts
apps/web/tests/MetaAutomationLogViewer.spec.ts
apps/web/tests/automation-log-redact.spec.ts
docs/development/multitable-automation-log-contract-redaction-hardening-development-20260515.md
docs/development/multitable-automation-log-contract-redaction-hardening-verification-20260515.md
```

No file outside `apps/web/` or `docs/development/` is modified. Zero
touch on `plugins/plugin-integration-core/`, `lib/adapters/k3-wise-*`,
`packages/core-backend/`, migrations, routes, workflows, K3 / Data
Factory / DingTalk / Attendance surfaces.

## V9 — Whitespace and conflict-marker check

```bash
git diff --cached --check
```

Result: clean (asserted at staging time).

## V10 — Secret-pattern scan over committed files

```bash
grep -rEn --include='*.ts' --include='*.vue' --include='*.md' \
  '(SEC[A-Z0-9+/=_-]{8,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9_-]{20,}|DINGTALK_CLIENT_SECRET[[:space:]]*=[[:space:]]*[A-Za-z][A-Za-z0-9_]+)' \
  apps/web/src/multitable/utils/automation-log-redact.ts \
  apps/web/src/multitable/components/MetaAutomationLogViewer.vue \
  apps/web/tests/automation-log-redact.spec.ts \
  apps/web/tests/MetaAutomationLogViewer.spec.ts \
  docs/development/multitable-automation-log-contract-redaction-hardening-*-20260515.md
```

Result: only `.spec.ts` fixture matches surface, all inside
`expect(...).toContain(...)` / `expect(...).not.toContain(...)`
clauses proving redaction. No real provider key, robot SEC, JWT,
SMTP password, or client secret is committed.

## V11 — Stage-1 lock self-attestation

| Check | Result |
| --- | --- |
| No change under `plugins/plugin-integration-core/*` | PASS |
| No change under `lib/adapters/k3-wise-*` | PASS |
| No new product战线 | PASS — hardens already-shipped log viewer |
| No schema / migration / route / workflow change | PASS |
| No change to `automation-log-service.ts`, `automation-executor.ts`, or `routes/automation.ts` | PASS |
| No new API endpoint | PASS — only consumes existing `/logs` and `/stats` |
| No new action type | PASS |
| No change to executor semantics | PASS |
| No touch on K3 / Data Factory / Attendance / DingTalk surfaces | PASS |
| Kernel polish on shipped multitable automation observability | PASS |

## V12 — Cross-references resolve in this commit

- `packages/core-backend/src/multitable/automation-log-service.ts` —
  read-only reference; backend service shape this PR aligns to.
- `packages/core-backend/tests/unit/automation-routes-wiring.test.ts` —
  read-only reference; authoritative source for `/logs` response
  shape and `triggeredAt / triggeredBy` field names.
- `apps/web/src/multitable/components/MetaAutomationLogViewer.vue` —
  modified.
- `apps/web/src/multitable/components/MetaAutomationManager.vue` —
  modified (one helper function).
- `apps/web/src/multitable/types.ts` — modified (2 interfaces).
- `apps/web/src/multitable/utils/automation-log-redact.ts` — new.
- `scripts/ops/multitable-phase3-release-gate-redact.mjs` — read-only
  reference; server-side redactor whose patterns this PR ports.

## Final verdict

PASS. Frontend now reads the backend's actual response shape so the
"View Logs" panel displays meaningful time, trigger source, duration,
and average. Step output and step error are redacted before reaching
the DOM, covering bearer / JWT / SEC / sk- / SMTP / webhook /
recipient / DingTalk receiver-id / subject classes. Load failures
surface as a visible, redacted, retryable error block instead of
masquerading as an empty rule. No backend contract change, no new
endpoint, no migration, no executor change, no touch on locked
surfaces.
