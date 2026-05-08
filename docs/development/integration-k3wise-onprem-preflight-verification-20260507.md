# Verification: K3 PoC On-Prem Deployment Preflight

**Date**: 2026-05-07
**Design**: `docs/development/integration-k3wise-onprem-preflight-design-20260507.md`
**Files under verification**:
- `scripts/ops/integration-k3wise-onprem-preflight.mjs`
- `scripts/ops/integration-k3wise-onprem-preflight.test.mjs`
- `package.json` (`verify:integration-k3wise:onprem-preflight`)

---

## Required-coverage matrix

| Operator scenario from spec | Test case | Expected exit | Result |
|---|---|---|---|
| Missing `DATABASE_URL` fails with clear hint | `exit 1 when DATABASE_URL is missing, with clear hint` | `1` | PASS |
| `JWT_SECRET` too short fails | `exit 1 when JWT_SECRET is too short, with explicit length hint` | `1` | PASS |
| Mock mode does not require real K3 endpoint | `exit 0 in mock mode with valid env, K3 endpoint not required` | `0` | PASS |
| Live mode missing K3 URL/acctId/username → `GATE_BLOCKED` | `exit 2 (GATE_BLOCKED) when --live and K3 env is missing` | `2` | PASS |
| Output never leaks `password` / `token` / `secret` values | `output redacts real secret values in stdout, JSON, and MD` | n/a | PASS |
| Postgres unreachable yields a clear diagnostic | `Postgres TCP probe: ECONNREFUSED yields clear diagnostic` | `1` | PASS |
| Migration alignment status explains "code vs DB" | `migration alignment check explains alignment status when skipped` + `… when DATABASE_URL is missing` | `0` / `1` | PASS |

Additional guards:

| Concern | Test case | Result |
|---|---|---|
| `FAIL` always wins over `GATE_BLOCKED` | `exit 1 (FAIL) takes precedence over exit 2 (GATE_BLOCKED)` | PASS |
| Unknown CLI argument is rejected | `rejects unknown CLI argument with non-zero exit` | PASS |
| Out-of-range `--timeout-ms` is rejected | `rejects out-of-range --timeout-ms` | PASS |
| Bad `--gate-file` path is `fail`, not `gate-blocked` | `--gate-file pointing at nonexistent path fails (not gate-blocked)` | PASS |
| `pnpm`/`tsx` not on PATH → `skip`, not `fail` (handles stripped-down on-prem boxes) | `migration alignment check gracefully skips when pnpm/tsx is not on PATH` | PASS |

## Local commands & results

### 1) Unit tests (the canonical local gate)

```
$ pnpm verify:integration-k3wise:onprem-preflight
> node --test scripts/ops/integration-k3wise-onprem-preflight.test.mjs
✔ exit 1 when DATABASE_URL is missing, with clear hint
✔ exit 1 when JWT_SECRET is too short, with explicit length hint
✔ exit 0 in mock mode with valid env, K3 endpoint not required
✔ exit 2 (GATE_BLOCKED) when --live and K3 env is missing
✔ exit 1 (FAIL) takes precedence over exit 2 (GATE_BLOCKED)
✔ Postgres TCP probe: ECONNREFUSED yields clear diagnostic
✔ migration alignment check explains alignment status when skipped
✔ migration alignment check skips with explanation when DATABASE_URL is missing
✔ output redacts real secret values in stdout, JSON, and MD
✔ rejects unknown CLI argument with non-zero exit
✔ rejects out-of-range --timeout-ms
✔ migration alignment check gracefully skips when pnpm/tsx is not on PATH
✔ --gate-file pointing at nonexistent path fails (not gate-blocked)
ℹ tests 13 / pass 13 / fail 0
ℹ duration_ms 485.604
```

### 2) Existing K3 WISE PoC chain — regression check

```
$ pnpm verify:integration-k3wise:poc
... (live-poc-preflight + live-poc-evidence test suites) ...
✓ step 1-2: preflight packet generated, Save-only=true, autoSubmit=false
✓ step 3: mock K3 WebAPI listening at http://127.0.0.1:51373
✓ step 4: mock SQL executor ready (t_ICItem readonly with 1 canned row)
✓ step 5a: K3 testConnection ok against mock
✓ step 5b: SQL channel testConnection ok against mock
✓ step 6: K3 Save-only upsert wrote 2 records, 0 Submit, 0 Audit (PoC safety preserved)
✓ step 7a: SQL readonly probe returned 1 row from t_ICItem
✓ step 7b: SQL safety guard rejected INSERT into t_ICItem (core table)
✓ step 8-9: evidence compiler returned PASS with 0 issues
✓ K3 WISE PoC mock chain verified end-to-end (PASS)
```

The pre-existing PoC chain still passes — the preflight script does not touch
`plugin-integration-core` runtime or the existing evidence compiler.

### 3) Manual exit-code matrix (operator simulations)

```
# Empty env, mock mode → FAIL (1) on env defects.
$ DATABASE_URL='' JWT_SECRET='' \
  node scripts/ops/integration-k3wise-onprem-preflight.mjs \
    --skip-tcp --skip-migrations --out-dir /tmp/ms2-pf-1
... [fail] env.database-url
... [fail] env.jwt-secret
EXIT=1
```

```
# Valid env, mock mode, fixtures present → PASS (0).
$ DATABASE_URL='postgres://demo:demo@127.0.0.1:65432/demo' \
  JWT_SECRET="$(printf 'a%.0s' {1..40})" \
  node scripts/ops/integration-k3wise-onprem-preflight.mjs \
    --skip-tcp --skip-migrations --out-dir /tmp/ms2-pf-2
... PASS (exit 0, mode=mock)
EXIT=0
```

```
# Live mode without K3 env → GATE_BLOCKED (2).
$ DATABASE_URL='postgres://demo:demo@127.0.0.1:65432/demo' \
  JWT_SECRET="$(printf 'a%.0s' {1..40})" \
  node scripts/ops/integration-k3wise-onprem-preflight.mjs \
    --live --skip-tcp --skip-migrations --out-dir /tmp/ms2-pf-3
... GATE_BLOCKED (exit 2, mode=live)
... [gate-blocked] k3.live-config — live preflight cannot proceed until customer GATE supplies these values
... [gate-blocked] gate.file-present — live preflight requires --gate-file <path>; …
EXIT=2
```

### 4) Redaction — end-to-end leak check

Set values that *look like real secrets* and confirm none of them appear in
stdout, JSON, or MD:

```
$ DATABASE_URL='postgres://demo_admin:hunter2_secret_value@127.0.0.1:65432/demo' \
  JWT_SECRET="$(printf 'x%.0s' {1..40})" \
  K3_API_URL='http://127.0.0.1:65431/K3API/' \
  K3_ACCT_ID='AIS_LIVE' K3_USERNAME='realuser' \
  K3_PASSWORD='realpass-LeAk-tEsT-1234' \
  node scripts/ops/integration-k3wise-onprem-preflight.mjs \
    --live --skip-tcp --skip-migrations --out-dir /tmp/ms2-pf-leak

$ grep -c -E "hunter2_secret_value|realpass-LeAk-tEsT|xxxxxxxxxxxx" \
    /tmp/ms2-pf-leak.stdout \
    /tmp/ms2-pf-leak/preflight.json \
    /tmp/ms2-pf-leak/preflight.md
/tmp/ms2-pf-leak/preflight.json:0
/tmp/ms2-pf-leak.stdout:0
/tmp/ms2-pf-leak/preflight.md:0
```

All three output channels report **0 occurrences** of the real secret values.

### 5) Help text and arg validation

```
$ node scripts/ops/integration-k3wise-onprem-preflight.mjs --help
Usage: node scripts/ops/integration-k3wise-onprem-preflight.mjs [options]
... (decision code map and full flag set printed)

$ node scripts/ops/integration-k3wise-onprem-preflight.mjs --bogus 2>&1
[integration-k3wise-onprem-preflight] ERROR: unknown argument: --bogus
EXIT=1
```

## CI status

CI is not modified by this PR.

- No CI workflow file is touched.
- The new test runs under `node --test`, the same runner used by every other
  `scripts/ops/*.test.mjs` test in the repo.
- Existing CI gates (build / type-check / lint / package tests) are unaffected
  because no runtime code changes.

If a CI job ever wants to wire the new gate in, the canonical command is:

```
pnpm verify:integration-k3wise:onprem-preflight
```

## Deployment impact

**None.** No image change, no DB change, no service rewire. The script is an
operator/CI tool that runs *before* backend services start. Output is written to
`artifacts/integration-k3wise-onprem-preflight/<runId>/` (gitignored by default
artifact convention) or to `--out-dir`.

## Customer GATE status

PR is **outside** the GATE block:

- No real ERP business behaviour is added.
- `plugin-integration-core` runtime, adapters, pipelines, and runner are
  untouched.
- The Stage 1 Lock memory ("until GATE PASS, no integration-core touch / no new
  战线") remains in force.
- This PR only tightens the offline / pre-deploy operator loop so a future
  on-prem PoC runs against a known-good box.

## Worktree

Branch: `codex/dingtalk-directory-return-banner-tests-20260505` (continued)
Cwd: `/Users/chouhua/Downloads/Github/metasheet2`
