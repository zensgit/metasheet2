# Multitable RC `2026-05-08b` Evidence Archive + UI Harness Wrapper · Verification

> Date: 2026-05-08
> Companion to: `multitable-rc-20260508b-evidence-archive-development-20260508.md`

## Wrapper syntax check

```bash
bash -n scripts/verify-multitable-rc-ui-smoke.sh
```

Result: passes (no output).

## Wrapper env-validation paths (dry runs)

Test 1 — missing `AUTH_TOKEN`:

```
FE_BASE_URL=http://x API_BASE_URL=http://x \
  bash scripts/verify-multitable-rc-ui-smoke.sh
```

```
[rc-ui-smoke] AUTH_TOKEN is required
exit=2
```

Test 2 — credentials embedded in URL:

```
FE_BASE_URL=http://x API_BASE_URL='http://u:p@x' AUTH_TOKEN=x \
  bash scripts/verify-multitable-rc-ui-smoke.sh
```

```
[rc-ui-smoke] API_BASE_URL must not contain credentials, query, or fragment: http://u:p@x
exit=2
```

Both paths exit `2` as documented in the wrapper's contract.

## package.json validity

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
grep -n 'verify:multitable-rc' package.json
```

```
json valid
48:    "verify:multitable-rc:staging": "node scripts/verify-multitable-rc-staging-smoke.mjs",
49:    "verify:multitable-rc:ui": "bash scripts/verify-multitable-rc-ui-smoke.sh",
```

## Diff hygiene

```bash
git diff --check
```

Result: passes.

## Scoped diff

- `docs/development/multitable-rc-20260508b-final-verification.md` — new canonical evidence MD
- `docs/development/multitable-rc-20260508b-api-harness-report.md` — verbatim 7/7 run report (copy of `/tmp/rc-staging-final-08c60362-api.md`); placed at `docs/development/` root because `docs/development/artifacts/` is `.gitignore`d
- `scripts/verify-multitable-rc-ui-smoke.sh` — new wrapper, executable
- `package.json` — `verify:multitable-rc:ui` script entry
- `docs/development/multitable-rc-20260508b-evidence-archive-development-20260508.md` — dev MD
- `docs/development/multitable-rc-20260508b-evidence-archive-verification-20260508.md` — this file

## End-to-end verification (deferred, but reproduces 3/3)

The wrapper was NOT run end-to-end against deployed 142 from this branch, because:

- The original 3/3 run on 2026-05-08T14:30:13Z is the canonical UI-sign-off evidence already captured in `multitable-rc-20260508b-final-verification.md`. Re-running for a docs PR would create duplicate test fixtures on staging without changing the contract being validated.
- The wrapper is a thin shell-level alias for the same Playwright invocation that produced the 3/3 result. Running it would re-create `pnpm --filter @metasheet/core-backend exec playwright test --config tests/e2e/playwright.config.ts multitable-gantt-smoke.spec.ts --workers=1` with the same env, against the same image (`08c6036284b`).

To prove equivalence locally, an operator can confirm the Playwright invocation argv matches by reading `scripts/verify-multitable-rc-ui-smoke.sh` and the original session output recorded in the evidence MD.

## Pre-deployment checks

- [x] No DingTalk / public-form runtime / Gantt / Hierarchy / formula / automation runtime / `plugins/plugin-integration-core/*` files touched.
- [x] No migration / OpenAPI / route additions.
- [x] No new env vars beyond what operators already supply for `verify:multitable-rc:staging` (FE_BASE_URL, API_BASE_URL, AUTH_TOKEN, OUTPUT_DIR).
- [x] Branch rebased onto `origin/main@ff0a11efe` before push.

## Result

Documentation + tooling change only. Evidence for `multitable-rc-20260508b-08c6036284` is now formally archived in `docs/development/`, and `pnpm verify:multitable-rc:ui` is wired as the dedicated UI sign-off command alongside `pnpm verify:multitable-rc:staging` (API). Future RC closeouts should run BOTH harnesses before declaring complete.
