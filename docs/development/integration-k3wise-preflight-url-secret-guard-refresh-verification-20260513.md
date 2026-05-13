# K3 WISE Preflight URL Secret Guard Refresh Verification - 2026-05-13

## Local Verification

```bash
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
```

Result:

- 20/20 tests passed.
- The URL secret guard test rejects credential-bearing K3 and PLM URLs.
- The same test preserves non-secret PLM routing query parameters.

```bash
node -e "JSON.parse(require('fs').readFileSync('scripts/ops/fixtures/integration-k3wise/gate-sample.json','utf8'))"
```

Result:

- `gate-sample.json` remains valid JSON after the customer guidance update.

```bash
pnpm run verify:integration-k3wise:poc
```

Result:

- Preflight: 20/20 tests passed.
- Evidence: 37/37 tests passed.
- Mock K3 WISE PoC demo passed.

```bash
git diff --check origin/main..HEAD
```

Result:

- No whitespace errors.

## PR #1337 Disposition

PR #1337 is superseded by current `main` plus this small refresh:

- Core guard behavior already exists in `assertNoSecretLikeText()`.
- This branch preserves the only remaining customer-facing instruction and compatibility assertion.
- The old branch should be closed after this refresh PR is opened.

## Not Covered

This verification does not hit a live customer K3 WISE endpoint. It validates the offline preflight and mock PoC safety contract only.
