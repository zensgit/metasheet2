# Multitable Feishu Phase 3 — D1 Email Bridge (Development)

- Date: 2026-05-14
- Branch: `codex/multitable-phase3-email-bridge-20260514`
- Base: `origin/main` at `a92189533` (after #1541 D0 skeleton)
- Author: Claude (Opus 4.7, 1M context), interactive harness; operator-supervised
- PR sequence anchor: PR R3 per
  `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
  § Suggested PR Sequence (active queue)
- Redaction policy: this PR contains no AI provider key, SMTP
  credential, JWT, bearer token, DingTalk webhook URL or robot
  `SEC...`, K3 endpoint password, Agent ID value, recipient user id,
  temporary password, or `.env` content. The bridge introduces an
  additional redaction layer over the email sub-gate's stdout /
  stderr / report fields as defense-in-depth.

## What this PR ships

Binds the existing `verify:multitable-email:real-send` package script
(which runs `tsx scripts/ops/multitable-email-real-send-smoke.ts`)
into the Phase 3 release-gate aggregator as the `email:real-send`
sub-gate. The bridge is **fail-closed**: only `exit=0` + `status=pass`
+ `ok=true` maps to PASS, only `exit=2` + `status=blocked` maps to
BLOCKED; every other shape — including missing report, parse
failure, exit/status mismatch, spawn error, signal kill — maps to
FAIL.

The aggregator now has four children: `email:real-send` plus the
three D0 stubs (`perf:large-table`, `permissions:matrix`,
`automation:soak`). When email PASS, the other three stay BLOCKED,
and the aggregator correctly returns BLOCKED (exit 2) — it does
**not** collapse a partial-pass to PASS.

## What this PR explicitly does NOT do

- Does **not** modify `scripts/ops/multitable-email-real-send-smoke.ts`,
  `scripts/ops/multitable-email-transport-readiness.ts`, or the
  underlying email transport modules.
- Does **not** modify the existing `verify:multitable-email:readiness`
  or `verify:multitable-email:real-send` package scripts.
- Does **not** add a new `verify:multitable-*` package script for
  `email:real-send`. The Phase 3 runner exposes `email:real-send` via
  `--gate email:real-send` only, so the email sub-gate stays a single
  source of truth even when invoked through the Phase 3 aggregator.
- Does **not** touch `plugins/plugin-integration-core/*`,
  `lib/adapters/k3-wise-*`, multitable runtime, OpenAPI source,
  generated dist, migrations, routes, workflows.
- Does **not** open a new product战线. Per the Activation Constraints
  in the plan, R3 is kernel polish on the already-shipped
  `multitable-email-real-send-smoke.ts` harness.

## Hard constraints from PR R3 design review

The bridge implementation honors four pre-implementation constraints
articulated by the operator:

### Constraint #1 — spawn via package script

`defaultRunScript` spawns `pnpm verify:multitable-email:real-send`,
**never** `tsx scripts/ops/...` directly. Rationale: routes through
the existing package script so the aggregator does not drift when
the email script's path or executor changes (e.g., if `tsx` is
replaced by `tsx --experimental-strip-types` or the script is
relocated).

### Constraint #2 — independent output paths

The bridge injects `EMAIL_REAL_SEND_JSON=<phase3-out>/children/email-real-send/report.json`
and `EMAIL_REAL_SEND_MD=<phase3-out>/children/email-real-send/report.md`
into the child process env. The existing email script reads these
env vars to override its default output location at
`output/multitable-email-real-send-smoke/`. Effect: each Phase 3
aggregator run gets its own child report, eliminating stale-report
and concurrent-overwrite risks.

### Constraint #3 — fail-closed status translation

Strict matching with sourceExitCode + sourceStatus + sourceOk
required:

| sourceExitCode | sourceStatus | sourceOk | Bridge outcome |
| --- | --- | --- | --- |
| `0` | `'pass'` | `true` | **pass** (exit 0) |
| `2` | `'blocked'` | any | **blocked** (exit 2) |
| any other shape | — | — | **fail** (exit 1) |

Specifically every one of these maps to fail-closed:

- Missing `report.json` (script crashed before writing).
- `report.json` present but malformed JSON.
- Mismatched signals (`exit=0` + `status=blocked`, `exit=2` +
  `status=pass`, `exit=0` + `status=pass` + `ok=false`, etc.).
- `spawnSync` throws synchronously.
- `spawnSync` returns `result.error` (e.g., `ENOENT` for missing
  pnpm).
- Process killed by signal (`exit` is `null` or `undefined`).

In every fail-closed case, the bridge result preserves
`sourceExitCode`, `sourceStatus`, `sourceReportPath` for diagnostic
purposes, but only **redacted** stdout / stderr samples (1200-char
cap) appear in the bridge result — never raw stream content.

### Constraint #4 — real SMTP env name redaction

The bridge's redaction layer covers the project's actual env names
consumed by `multitable-email-real-send-smoke.ts`:

- `MULTITABLE_EMAIL_SMTP_HOST` / `USER` / `PASSWORD` / `PORT` / `FROM`
- `MULTITABLE_EMAIL_SMOKE_TO` / `SUBJECT`
- `CONFIRM_SEND_EMAIL` (via generic `*_PASSWORD` family — covered by
  D0 redactor)

The D0 redactor (`multitable-phase3-release-gate-redact.mjs`) was
patched in PR #1541's follow-up commit to handle these env names.
This PR adds bridge-side tests proving the protection holds end-to-
end: artifact-integrity tests inject these env names into a spawned
gate run and assert none of the original values appear in
`stdout / stderr / report.json / report.md` of either the email
sub-gate alone or the aggregator path.

## File inventory

| Path | Lines | Purpose |
| --- | --- | --- |
| `scripts/ops/multitable-phase3-release-gate-email-bridge.mjs` | ~190 | Bridge — spawn + status translate + redact + fail-closed. |
| `scripts/ops/multitable-phase3-release-gate-email-bridge.test.mjs` | ~270 | 16 tests covering pass / blocked / fail / 5 mismatch flavors / missing report / parse fail / spawn throws / spawn error / signal kill / disk writes / sample redaction / truncation. |
| `scripts/ops/multitable-phase3-release-gate.mjs` | +60 | Imports bridge, adds `email:real-send` to PUBLIC_GATES, threads `outputDir` and `emailRunScript` through `executeGate`, runs email child first in aggregator, extracts `summarizeAggregateChildren`. |
| `scripts/ops/multitable-phase3-release-gate.test.mjs` | +180 | Adds mock runScript helpers, multi-state aggregator tests, summarizer unit tests, standalone email-gate routing tests, outputDir requirement tests; spawn-based aggregator test gains a `node_modules/.bin/tsx`-presence skip guard. |
| `docs/development/multitable-phase3-email-bridge-development-20260514.md` | this file | Development MD. |
| `docs/development/multitable-phase3-email-bridge-verification-20260514.md` | sibling | Verification MD. |

No change to `package.json`, no change to existing email scripts.

## Aggregator state machine

Children are evaluated in order `email:real-send` → `perf:large-table`
→ `permissions:matrix` → `automation:soak`. Aggregate status comes
from `summarizeAggregateChildren`:

| Child mix | Aggregate status | Aggregate exit |
| --- | --- | --- |
| Any child FAIL | fail | 1 |
| No FAIL, any BLOCKED | blocked | 2 |
| Every child PASS | pass | 0 |

Critical invariants (proven by tests):

- A partial PASS (email pass + 3 BLOCKED) yields **BLOCKED**, not
  PASS. Partial pass cannot collapse the aggregate to pass.
- A child FAIL beats any number of BLOCKED. A failed child cannot
  hide behind blocked siblings.
- BLOCKED never collapses to FAIL.

## CLI

`email:real-send` is invokable as a standalone gate:

```bash
node scripts/ops/multitable-phase3-release-gate.mjs \
  --gate email:real-send \
  --output-dir /tmp/phase3-email
```

The aggregator continues to be invoked the usual way:

```bash
node scripts/ops/multitable-phase3-release-gate.mjs \
  --gate release:phase3 \
  --output-dir /tmp/phase3-aggregate
```

Both paths require `--output-dir` because the bridge writes child
reports under `<output-dir>/children/email-real-send/`.

## Stage-1 lock compliance

| Check | Result |
| --- | --- |
| No change under `plugins/plugin-integration-core/*` | PASS |
| No change under `lib/adapters/k3-wise-*` | PASS |
| No new product战线 | PASS — kernel polish wraps an already-shipped script |
| No schema / migration / route / workflow change | PASS |
| No change to existing `verify:multitable-email:*` scripts | PASS |
| No change to `multitable-email-{real-send-smoke,transport-readiness}.ts` | PASS |
| No new package script (no `verify:multitable-phase3:email:*`) | PASS |
| Email script bound only via fail-closed wrapper | PASS |

## Cross-references

- Phase 3 plan: `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
  (Activation Constraints + Suggested PR Sequence active queue,
  R2 → R3 → R4)
- Phase 3 TODO: `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md`
  (Lane D1 — Real SMTP Gate)
- Phase 3 review: `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md`
- D0 skeleton (R2): merge commit `a92189533` (PR #1541)
- Email script (NOT modified): `scripts/ops/multitable-email-real-send-smoke.ts`
- Email readiness script (NOT modified): `scripts/ops/multitable-email-transport-readiness.ts`
- Phase 3 redactor (was patched in #1541 follow-up):
  `scripts/ops/multitable-phase3-release-gate-redact.mjs`

## Follow-ups (not in this PR)

- PR R4 — D4 automation soak gate: replace the `automation:soak`
  blocked stub with a real `record.created` / `update_record` /
  `send_email` / `send_webhook` repeat-fire harness, wired through
  the same fail-closed bridge pattern.
- D2 (perf large-table) and D3 (permission matrix) stay deferred
  under stage-1 lock plus T4 / T5 closure, per Activation
  Constraints in the plan.
