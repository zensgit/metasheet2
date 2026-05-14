# Multitable Feishu Phase 3 — D0 Release Gate Skeleton (Verification)

- Date: 2026-05-14
- Branch: `codex/multitable-phase3-release-gate-skeleton-20260514`
- Base: `origin/main` at `0b4575fe3` (after #1539)
- Author: Claude (Opus 4.7, 1M context), interactive harness; operator-supervised
- Companion: `multitable-phase3-release-gate-skeleton-development-20260514.md`
- Redaction policy: this document contains no AI provider key, SMTP
  credential, JWT, bearer token, DingTalk webhook URL or robot
  `SEC...`, K3 endpoint password, recipient user id, temporary
  password, or `.env` content.

## Result

**PASS / skeleton landing**.

- 33 / 33 focused tests PASS via `node --test`.
- Four new `verify:multitable-*` package scripts wired up and each
  exits **2** (BLOCKED) on a clean env, as required by the
  Activation Constraints in the plan.
- `release:phase3` aggregator returns exit code **2**, never **1**,
  when child sub-gates are BLOCKED. This is the user's
  pre-implementation requirement #3.
- Artifact-integrity test: stdout + stderr + report.json + report.md
  combined contain no env-supplied secret values across two
  scenarios (`perf:large-table` sub-gate + `release:phase3`
  aggregator with five injected secret-shaped env vars).

## V1 — Worktree provenance

```bash
git fetch origin main
git worktree add /private/tmp/ms2-phase3-d0-20260514 \
  -b codex/multitable-phase3-release-gate-skeleton-20260514 origin/main
```

Result: `HEAD is now at 0b4575fe3 fix(attendance): resolve longrun
auth from deploy host (#1539)`.

## V2 — Focused tests

```bash
node --test \
  scripts/ops/multitable-phase3-release-gate-redact.test.mjs \
  scripts/ops/multitable-phase3-release-gate-report.test.mjs \
  scripts/ops/multitable-phase3-release-gate.test.mjs
```

Result:

```text
ℹ tests 33
ℹ pass 33
ℹ fail 0
ℹ duration_ms ~280
```

Test breakdown:

- `multitable-phase3-release-gate-redact.test.mjs` — 16 tests:
  Bearer, JWT, DingTalk `SEC`, `sk-` API key, `access_token=` URL,
  env-style `*_API_KEY` / `*_CLIENT_SECRET` / `*_TOKEN` / `*_SECRET`
  / `*_PASSWORD`, SMTP credentials, DingTalk robot webhook URL,
  postgres URI, mysql URI, structured-field masking by key name,
  recipient arrays, nested objects, no-leak via free-text fields,
  null / undefined safety.
- `multitable-phase3-release-gate-report.test.mjs` — 5 tests:
  schema version stamp, redaction integration in buildReport, MD
  rendering for sub-gates and aggregators, disk-output integrity
  (read back report.json + report.md, assert no leaks of original
  secret values, assert replacement markers present).
- `multitable-phase3-release-gate.test.mjs` — 12 tests: in-process
  blocked behavior, in-process "env present but still blocked"
  D0 behavior, in-process aggregator BLOCKED-not-FAIL invariant,
  spawn-based per-sub-gate exit code, spawn-based aggregator exit
  code, `--allow-blocked` override semantics, unknown-gate
  rejection, artifact-integrity for sub-gate, artifact-integrity
  for aggregator.

## V3 — Exit-code contract (end-to-end via spawn)

```bash
for gate in 'release:phase3' 'perf:large-table' 'permissions:matrix' 'automation:soak'; do
  node scripts/ops/multitable-phase3-release-gate.mjs --gate "$gate" \
    --output-dir /tmp/d0-verify-"${gate//:/-}" >/dev/null 2>&1
  echo "--gate $gate => exit=$?"
done
```

Result:

```text
--gate release:phase3 => exit=2
--gate perf:large-table => exit=2
--gate permissions:matrix => exit=2
--gate automation:soak => exit=2
```

Every gate exits 2 (BLOCKED). The aggregator does not collapse into
1 (FAIL); the bedrock invariant from the user's pre-implementation
requirement #3 holds end-to-end.

## V4 — Artifact integrity (env-supplied secrets)

```bash
node --test scripts/ops/multitable-phase3-release-gate.test.mjs 2>&1 \
  | grep -E 'artifact integrity'
```

Result:

```text
✔ artifact integrity — stdout + stderr + report.json + report.md never leak env-supplied secrets
✔ artifact integrity — release:phase3 aggregator does not leak env-supplied secrets
```

The artifact-integrity tests inject five secret-shaped env vars
(`MULTITABLE_PERF_TARGET_DB`, `OPENAI_API_KEY`,
`DINGTALK_CLIENT_SECRET`, `SMTP_PASSWORD`, `SMTP_HOST`, `SMTP_USER`),
spawn the gate, capture stdout + stderr + report.json + report.md,
concatenate, and assert that no original secret value substring
appears anywhere.

## V5 — Sample blocked aggregator artifact (release:phase3)

```bash
cat /tmp/d0-verify-release-phase3/report.json
```

Result (verbatim, no secrets, no operator-private identifiers):

```json
{
  "schemaVersion": 1,
  "tool": "multitable-phase3-release-gate",
  "gate": "release:phase3",
  "status": "blocked",
  "exitCode": 2,
  "reason": "One or more child sub-gates are BLOCKED. Aggregator exits 2 (BLOCKED); it does not collapse into 1 (FAIL).",
  "startedAt": "2026-05-14T06:52:52.486Z",
  "completedAt": "2026-05-14T06:52:52.487Z",
  "children": [
    { "gate": "perf:large-table", "status": "blocked", "exitCode": 2, "deferral": "D2 — Large Table Performance Gate" },
    { "gate": "permissions:matrix", "status": "blocked", "exitCode": 2, "deferral": "D3 — Permission Matrix Gate" },
    { "gate": "automation:soak", "status": "blocked", "exitCode": 2, "deferral": "D4 — Automation Soak Gate" }
  ]
}
```

## V6 — Scope check (Git diff path-only)

```bash
git diff --cached --name-only
```

Result:

```text
docs/development/multitable-phase3-release-gate-skeleton-development-20260514.md
docs/development/multitable-phase3-release-gate-skeleton-verification-20260514.md
package.json
scripts/ops/multitable-phase3-release-gate-redact.mjs
scripts/ops/multitable-phase3-release-gate-redact.test.mjs
scripts/ops/multitable-phase3-release-gate-report.mjs
scripts/ops/multitable-phase3-release-gate-report.test.mjs
scripts/ops/multitable-phase3-release-gate.mjs
scripts/ops/multitable-phase3-release-gate.test.mjs
```

No file under `plugins/plugin-integration-core/`, `lib/adapters/`,
`packages/core-backend/`, `apps/web/`, `.github/workflows/`,
`docker/`, or any migration directory is modified. Stage-1 lock
compliance affirmed.

## V7 — Existing email scripts untouched

```bash
git diff --cached -- scripts/ops/multitable-email-real-send-smoke.ts \
                     scripts/ops/multitable-email-transport-readiness.ts
```

Result: empty diff. Existing email-real-send and email-readiness
scripts are not modified. The corresponding
`verify:multitable-email:real-send` and
`verify:multitable-email:readiness` package scripts are also
unchanged. PR R3 (D1) will bind them into the aggregator.

## V8 — Whitespace and conflict-marker check

```bash
git diff --cached --check
```

Result: clean.

## V9 — Secret-pattern scan over the PR

```bash
grep -rEn --include='*.mjs' --include='*.ts' --include='*.md' --include='*.json' \
  '(SEC[A-Z0-9+/=_-]{8,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9_-]{20,}|DINGTALK_CLIENT_SECRET[[:space:]]*=[[:space:]]*[A-Za-z][A-Za-z0-9_]+|password[[:space:]]*=[[:space:]]*[A-Za-z0-9][A-Za-z0-9_]+)' \
  scripts/ops/multitable-phase3-release-gate*.mjs \
  docs/development/multitable-phase3-release-gate-skeleton-*-20260514.md
```

Result: only known test-fixture sentinels surface, and every match
sits inside an `assert.doesNotMatch(...)` or `assert.match(...)`
clause inside a `.test.mjs` file — i.e., the patterns are being
*matched against to prove redaction*, not embedded as live
credentials. No real provider key, robot SEC, JWT, SMTP password,
or DingTalk client secret is committed. The development and
verification MDs contain no secret-shaped literals beyond the
sentinel strings explicitly designed to be redacted by the
helper (`abcdefghijklmnopqrstuvwx12345`,
`sk-leakytestonly1234567890abcdef`, `l3akyp4ssw0rd`,
`l3akySmtpPwd99`, etc., all flagged as "leaky*"-prefixed test data).

## V10 — Stage-1 lock self-attestation

| Check | Result |
| --- | --- |
| No change under `plugins/plugin-integration-core/*` | PASS |
| No change under `lib/adapters/k3-wise-*` | PASS |
| No new product战线 (AI, industry template, marketplace) | PASS |
| No schema, migration, route, workflow, OpenAPI change | PASS |
| No change to existing `verify:multitable-email:*` scripts | PASS |
| No change to `multitable-email-{real-send-smoke,transport-readiness}.ts` | PASS |
| Kernel polish on already-shipped automation and release-evidence paths | PASS |

## V11 — Exit-code semantic invariants (explicit)

| Invariant | Asserted by | Result |
| --- | --- | --- |
| Sub-gate BLOCKED when env missing → exit 2 | `node --test` per-gate cases | PASS |
| Sub-gate still BLOCKED when env present at D0 → exit 2 | in-process executeGate test | PASS |
| Aggregator BLOCKED when any child BLOCKED → exit 2, NEVER 1 | both in-process and spawn tests, plus end-to-end shell loop | PASS |
| `--allow-blocked` overrides exit to 0, but report.status stays `blocked` | dedicated spawn test | PASS |
| Unknown `--gate` → exit 1, error message redacted | dedicated spawn test | PASS |

## V12 — Cross-references resolve in this commit

- Plan at `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md`
  — referenced by the runner banner comment and the development MD.
- Independent review at
  `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md`
  — referenced by the runner banner comment.
- Existing DingTalk release-gate precedent at
  `scripts/ops/dingtalk-work-notification-release-gate.mjs`
  — referenced for argparse / blocked-mode style.

## Open follow-ups after this PR merges

- PR R3 (D1 real SMTP gate) binds the existing
  `verify:multitable-email:real-send` into the Phase 3 aggregator
  and adds the `email:real-send` sub-gate routing.
- PR R4 (D4 automation soak) replaces the `automation:soak`
  skeleton with the real `record.created` / `update_record` /
  `send_email` / `send_webhook` repeat-fire harness.
- D2 (perf large-table) and D3 (permission matrix) stay deferred
  under stage-1 lock plus T4 / T5 closure, per Activation
  Constraints in the plan.

## Final verdict

PASS. The D0 release-gate skeleton ships under the K3 PoC stage-1
lock as kernel polish on already-shipped multitable + automation
features. The PR satisfies the user's three pre-implementation
requirements: existing email script untouched, only the four
declared verify scripts added, and aggregator `BLOCKED ≠ FAIL`
invariant proven by both unit tests and end-to-end exit codes.
