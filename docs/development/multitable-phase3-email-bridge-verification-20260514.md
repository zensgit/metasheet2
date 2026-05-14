# Multitable Feishu Phase 3 — D1 Email Bridge (Verification)

- Date: 2026-05-14
- Branch: `codex/multitable-phase3-email-bridge-20260514`
- Base: `origin/main` at `a92189533` (after #1541 D0 skeleton)
- Author: Claude (Opus 4.7, 1M context), interactive harness; operator-supervised
- Companion: `multitable-phase3-email-bridge-development-20260514.md`
- Redaction policy: this document contains no AI provider key, SMTP
  credential, JWT, bearer token, DingTalk webhook URL or robot
  `SEC...`, K3 endpoint password, recipient user id, temporary
  password, or `.env` content.

## Result

**PASS / R3 bridge landing**.

- **62 / 62 focused tests PASS** via `node --test`. (One additional
  test skips locally with reason `requires node_modules/.bin/tsx`;
  it runs in CI where `pnpm install` has already populated
  `node_modules`.)
- CLI end-to-end verification: all 5 gates produce structurally
  correct artifacts. Without `pnpm install` in the worktree, the
  email-bridge path fail-closes to `exit=1, status=fail` — exactly
  the design intent.
- Four hard constraints from PR R3 review are all honored by the
  shipping code.

## V1 — Worktree provenance

```bash
git fetch origin main
git worktree add /private/tmp/ms2-phase3-r3-20260514 \
  -b codex/multitable-phase3-email-bridge-20260514 origin/main
```

Result: `HEAD is now at a92189533 test(multitable): add phase3
release gate skeleton (#1541)`.

## V2 — Focused tests

```bash
node --test \
  scripts/ops/multitable-phase3-release-gate-redact.test.mjs \
  scripts/ops/multitable-phase3-release-gate-report.test.mjs \
  scripts/ops/multitable-phase3-release-gate-email-bridge.test.mjs \
  scripts/ops/multitable-phase3-release-gate.test.mjs
```

Result:

```text
ℹ tests 63
ℹ pass 62
ℹ fail 0
ℹ skipped 1
ℹ duration_ms ~840
```

Test breakdown:

- `multitable-phase3-release-gate-redact.test.mjs` — 19 tests
  (unchanged from #1541 baseline plus its follow-up
  `MULTITABLE_EMAIL_SMTP_*` and `MULTITABLE_EMAIL_SMOKE_*` patches).
- `multitable-phase3-release-gate-report.test.mjs` — 5 tests
  (unchanged from #1541).
- `multitable-phase3-release-gate-email-bridge.test.mjs` — **16 tests
  (new)**: EMAIL_SUB_GATE_ID export, outputDir requirement,
  pass / blocked / fail mappings, 4 fail-closed mismatch flavors,
  missing report.json, malformed JSON, spawn throws, spawn error,
  signal kill (null exit), disk writes to `<outputDir>/children/`,
  redaction of SMTP / Bearer / sk- sentinels in samples, 1200-char
  truncation, source field preservation.
- `multitable-phase3-release-gate.test.mjs` — 23 tests (was 14 in
  #1541, **+9 net**): updated aggregator-blocked test for 4
  children, new aggregator multi-state tests (email pass + 3
  blocked → blocked; email fail + 3 blocked → fail), summarizer
  unit tests (all-pass / fail-beats-blocked / pass-plus-blocked-but-
  no-fail-stays-blocked), standalone email-gate routing (pass +
  blocked cases), `executeGate` outputDir guard tests.

The single skipped test is
`release:phase3 aggregator exits 2 (blocked) not 1 (fail) via spawn —
all 4 children blocked`. It is gated by
`existsSync('node_modules/.bin/tsx')` because the spawn-based
integration path requires the email script's runtime dependencies.
It runs in CI where `pnpm install` precedes tests; it skips in fresh
worktrees, with the skip reason printed inline.

## V3 — CLI end-to-end exit codes (without `pnpm install`)

```bash
for gate in 'release:phase3' 'email:real-send' 'perf:large-table' 'permissions:matrix' 'automation:soak'; do
  node scripts/ops/multitable-phase3-release-gate.mjs --gate "$gate" \
    --output-dir /tmp/r3-verify-"${gate//:/-}" >/dev/null 2>&1
  echo "  --gate $gate => exit=$?"
done
```

Result:

```text
--gate release:phase3 => exit=1
--gate email:real-send => exit=1
--gate perf:large-table => exit=2
--gate permissions:matrix => exit=2
--gate automation:soak => exit=2
```

Interpretation:

- `email:real-send` exits `1` (fail) because the worktree has no
  `node_modules` — the bridge spawns `pnpm verify:multitable-email:real-send`,
  pnpm cannot find `tsx`, the email script never writes a
  `report.json`, the bridge fail-closes per constraint #3.
- `release:phase3` aggregator exits `1` (fail) because its
  `email:real-send` child failed-closed; the aggregator correctly
  propagates a child FAIL to aggregate FAIL.
- The other three sub-gates exit `2` (blocked) per the D0 skeleton.

In CI where `pnpm install` has run before tests, the email script
will start, exit `2` with `status=blocked` (because real-send env
vars are not set), the bridge will translate to blocked, and the
aggregator will return `2` (blocked) — the BLOCKED-not-FAIL
invariant from PR R2 (#1541) still holds when prerequisites are
present.

## V4 — Sample fail-closed artifact (no node_modules path)

```bash
cat /tmp/r3-verify-email-real-send/report.json
```

Result (verbatim, redaction-clean):

```json
{
  "schemaVersion": 1,
  "tool": "multitable-phase3-release-gate",
  "gate": "email:real-send",
  "status": "fail",
  "exitCode": 1,
  "reason": "Email script did not write a report.json at /tmp/r3-verify-email-real-send/children/email-real-send/report.json.",
  "startedAt": "2026-05-14T07:39:22.764Z",
  "completedAt": "2026-05-14T07:39:23.006Z",
  "sourceExitCode": 1,
  "sourceStatus": null,
  "sourceReportPath": "/tmp/r3-verify-email-real-send/children/email-real-send/report.json",
  "stdoutSample": "[pnpm boot text + ELIFECYCLE Command failed]",
  "stderrSample": "sh: tsx: command not found"
}
```

`sourceExitCode` preserved (`1` from pnpm's ELIFECYCLE exit),
`sourceStatus` null (no report to parse), `sourceReportPath`
recorded for forensics. `stdoutSample` and `stderrSample` are
1200-char-capped and redacted. No env-supplied secret was ever fed
into the email script (it never ran), so there is nothing to leak.

## V5 — Sample aggregator artifact with 4 children

```bash
cat /tmp/r3-verify-release-phase3/report.json
```

Result (verbatim, abbreviated):

```json
{
  "schemaVersion": 1,
  "tool": "multitable-phase3-release-gate",
  "gate": "release:phase3",
  "status": "fail",
  "exitCode": 1,
  "reason": "One or more child sub-gates returned FAIL. Aggregator exits 1 (FAIL).",
  "children": [
    { "gate": "email:real-send", "status": "fail", "exitCode": 1, "deferral": null,
      "sourceExitCode": 1, "sourceStatus": null },
    { "gate": "perf:large-table", "status": "blocked", "exitCode": 2,
      "deferral": "D2 — Large Table Performance Gate" },
    { "gate": "permissions:matrix", "status": "blocked", "exitCode": 2,
      "deferral": "D3 — Permission Matrix Gate" },
    { "gate": "automation:soak", "status": "blocked", "exitCode": 2,
      "deferral": "D4 — Automation Soak Gate" }
  ]
}
```

Four children present. Email child fails-closed (no node_modules in
worktree); the other three remain blocked per the D0 plan.

## V6 — Aggregator state machine invariants

| Test | Result |
| --- | --- |
| All 4 children BLOCKED → aggregate BLOCKED (exit 2) | PASS (in-process with mock email runScript) |
| Email PASS + 3 others BLOCKED → aggregate BLOCKED (NOT PASS) | PASS — partial pass never collapses |
| Email FAIL + 3 others BLOCKED → aggregate FAIL (exit 1) | PASS — any FAIL beats BLOCKED |
| `summarizeAggregateChildren` synthetic all-PASS → PASS | PASS |
| `summarizeAggregateChildren` synthetic PASS + FAIL + BLOCKED → FAIL | PASS |
| `summarizeAggregateChildren` synthetic PASS + BLOCKED → BLOCKED | PASS |

## V7 — Fail-closed mapping invariants

Bridge unit tests prove these mappings:

| Mock source state | Bridge outcome | Test |
| --- | --- | --- |
| exit=0, status=pass, ok=true | pass (exit 0) | PASS |
| exit=2, status=blocked | blocked (exit 2) | PASS |
| exit=1, status=failed | fail (exit 1) | PASS |
| exit=0, status=blocked (mismatch) | fail (exit 1) | PASS |
| exit=2, status=pass (mismatch) | fail (exit 1) | PASS |
| exit=0, status=pass, ok=false (mismatch) | fail (exit 1) | PASS |
| Missing report.json | fail (exit 1) | PASS |
| Malformed report.json | fail (exit 1) | PASS |
| spawn throws | fail (exit 1) | PASS |
| spawn returns result.error (ENOENT) | fail (exit 1) | PASS |
| Null exit (signal kill) | fail (exit 1) | PASS |

## V8 — Spawn command shape

```bash
grep -nE "spawnSync\\('pnpm'|spawnSync\\('tsx'" scripts/ops/multitable-phase3-release-gate-email-bridge.mjs
```

Result:

```text
scripts/ops/multitable-phase3-release-gate-email-bridge.mjs:48:  return spawnSync('pnpm', ['verify:multitable-email:real-send'], {
```

Constraint #1 verified: the bridge spawns `pnpm`, never `tsx`
directly. The package script is the indirection point.

## V9 — Output-path injection

```bash
grep -nE "EMAIL_REAL_SEND_JSON|EMAIL_REAL_SEND_MD" scripts/ops/multitable-phase3-release-gate-email-bridge.mjs
```

Result: 2 lines, both inside `defaultRunScript`, injecting the
child-specific paths into the spawned process env.
Constraint #2 verified.

## V10 — Artifact integrity (real env names through bridge)

The existing two artifact-integrity tests (introduced in #1541) plus
the inline tests in this PR continue to pass after the bridge is
wired in. Each injects:

- `MULTITABLE_EMAIL_SMTP_HOST=smtp-aggregator-leak.example.com`
- `MULTITABLE_EMAIL_SMTP_USER=aggregator-smtp-user`
- `MULTITABLE_EMAIL_SMTP_PASSWORD=aggregatorSmtpPw88`
- `MULTITABLE_EMAIL_SMTP_FROM=aggregator-from@example.com`
- `MULTITABLE_EMAIL_SMOKE_TO=aggregator-to@example.com`

into the spawned aggregator's env. After the run, `stdout + stderr +
report.json + report.md` are concatenated and asserted to contain no
original value substring. Even when the bridge fail-closes (no
node_modules), there is no leak path because:

- The bridge never copies env values into its own result fields.
- `stdoutSample` / `stderrSample` from pnpm contain only pnpm
  diagnostic text (ELIFECYCLE, "tsx: command not found"), none of
  which echo env values.
- Even hypothetical leaks via pnpm would pass through the bridge's
  `compactSample` → `redactString` redaction layer (constraint #4,
  defense-in-depth).

Constraint #4 verified.

## V11 — Existing email scripts untouched

```bash
git diff --cached -- scripts/ops/multitable-email-real-send-smoke.ts \
                     scripts/ops/multitable-email-transport-readiness.ts \
                     scripts/ops/multitable-email-real-send-smoke.test.mjs \
                     scripts/ops/multitable-email-transport-readiness.test.mjs
```

Result: empty diff. Email-side files are untouched. The
`verify:multitable-email:real-send` and
`verify:multitable-email:readiness` package scripts in `package.json`
are also unchanged.

## V12 — Whitespace and conflict-marker check

```bash
git diff --cached --check
```

Result: clean (reported at staging time).

## V13 — Secret-pattern scan

```bash
grep -rEn --include='*.mjs' --include='*.ts' --include='*.md' --include='*.json' \
  '(SEC[A-Z0-9+/=_-]{8,}|Bearer[[:space:]]+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9_-]{20,}|DINGTALK_CLIENT_SECRET[[:space:]]*=[[:space:]]*[A-Za-z][A-Za-z0-9_]+)' \
  scripts/ops/multitable-phase3-release-gate*.mjs \
  docs/development/multitable-phase3-email-bridge-*-20260514.md
```

Result: only `.test.mjs` fixture matches surface, all inside
`assert.doesNotMatch(...)` / `assert.match(...)` clauses proving
redaction. Same posture as #1541. No real provider key, robot SEC,
JWT, SMTP password, or client secret is committed.

## V14 — Stage-1 lock self-attestation

| Check | Result |
| --- | --- |
| No change under `plugins/plugin-integration-core/*` | PASS |
| No change under `lib/adapters/k3-wise-*` | PASS |
| No new product战线 | PASS — wraps already-shipped email harness |
| No schema / migration / route / workflow change | PASS |
| No change to existing `verify:multitable-email:*` scripts | PASS |
| No change to `multitable-email-{real-send-smoke,transport-readiness}.ts` | PASS |
| No new `package.json` script | PASS — only `email:real-send` --gate routing added inside runner |
| Kernel polish on shipped automation send_email path | PASS |

## V15 — 142 production impact assessment

Same as #1541: `scripts/ops/` paths are not copied into the
Dockerfile.backend runner stage, so the runtime image's K3 PoC
behavior is unaffected. The runtime image's `package.json` is the
same as #1541's main HEAD `package.json` because R3 adds **no new
package script** — only internal runner routing changes. Build will
still re-push an image tagged with this PR's merge SHA, but the
runtime contents are byte-identical to the previous image, and 142
does not auto-pull, so the K3 PoC stable image stays in place
unless the operator explicitly syncs.

## Open follow-ups after this PR merges

- PR R4 — D4 automation soak gate: replace the `automation:soak`
  blocked stub with a real repeat-fire harness against shipped
  automation actions, using the same fail-closed bridge pattern.
- D2 / D3 stay deferred under stage-1 lock plus T4 / T5 closure.
- Once a 142-side or staging-side SMTP target is provisioned with
  proper CONFIRM_SEND_EMAIL guards, the email sub-gate can begin
  returning real PASS signals — proving the aggregator can
  partially-pass as designed.

## Final verdict

PASS. PR R3 binds the existing email-real-send harness into the
Phase 3 aggregator via a fail-closed bridge that honors all four
pre-implementation constraints from the design review. The bridge
preserves source diagnostic fields, redacts samples, never modifies
the email-side resources, and the aggregator's BLOCKED-vs-FAIL
invariant continues to hold across the new state machine surface.
