# K3 WISE Preflight URL Secret Guard Verification - 2026-05-06

## Local Commands

```bash
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
```

Result:

- 17 tests passed
- new URL secret guard cases passed

```bash
node --input-type=module -e "import { buildPacket } from './scripts/ops/integration-k3wise-live-poc-preflight.mjs'; ..."
```

Result:

- `https://user:secret-pass@k3.example.test/K3API/?token=abc123` is rejected
- error field is `k3Wise.apiUrl`
- error message names inline username/password credentials

## Coverage Added

The preflight test suite now covers:

- rejecting inline username/password in `k3Wise.apiUrl`
- rejecting secret-like query params in `k3Wise.apiUrl`
- rejecting secret-like query params in `plm.baseUrl`
- preserving non-secret query params in `plm.baseUrl`

## Full Gate

```bash
pnpm run verify:integration-k3wise:poc
```

Result:

- preflight: 17 tests passed
- evidence: 31 tests passed
- mock PoC demo: PASS

```bash
git diff --check origin/main..HEAD
```

Result:

- passed, no whitespace errors

## Notes

```bash
pnpm run verify:integration-k3wise:poc
git diff --check origin/main..HEAD
```

The full PoC script in this branch uses the current `origin/main` package
definition, so it runs preflight + evidence + mock demo. The SQL mock contract
test is covered by PR #1335 and is intentionally not part of this branch.
