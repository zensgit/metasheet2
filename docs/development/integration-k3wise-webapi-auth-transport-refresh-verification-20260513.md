# K3 WISE WebAPI Auth Transport Refresh Verification - 2026-05-13

## Scope

Refresh of PR #1352 on top of current `main` to require usable K3 WebAPI auth
transport, reject unsafe endpoint paths, preserve base URL context paths, and
tighten the mock K3 WebAPI contract.

## Commands

```bash
node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
node --test scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.test.mjs
pnpm run verify:integration-k3wise:poc
git diff --check origin/main..HEAD
```

## Expected Coverage

- login success without cookie or session id returns
  `K3_WISE_AUTH_TRANSPORT_MISSING`
- adapter stops at login and does not run health after missing auth transport
- protocol-relative endpoint paths are rejected
- backslash-normalized endpoint paths are rejected
- `baseUrl` context paths are preserved when joining endpoint paths
- mock K3 endpoint methods match the expected K3 WebAPI contract
- mock K3 can model login success without auth transport
- mock K3 call logs still redact login credential fields

## Local Results

### Adapter Test

```bash
node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
```

Result: passed.

- WebAPI, SQL Server channel, and auto-flag coercion tests passed.
- New coverage verifies `K3_WISE_AUTH_TRANSPORT_MISSING`.
- New coverage verifies context-path URL joining.
- New coverage verifies protocol-relative and backslash endpoint rejection.

### Mock K3 WebAPI Contract Test

```bash
node --test scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.test.mjs
```

Result: passed.

- 4/4 tests passed.
- Credential redaction coverage still passes.
- Raw material payload evaluation still passes.
- Method contract coverage passes.
- Login-without-auth-transport simulation passes.

### Full Offline K3 WISE PoC Gate

```bash
pnpm run verify:integration-k3wise:poc
```

Result: passed.

- preflight suite: 20/20 passed
- evidence suite: 41/41 passed
- mock K3 WebAPI suite: 4/4 passed
- mock SQL Server suite: 12/12 passed
- mock PoC demo: PASS

### Whitespace Check

```bash
git diff --check
```

Result: passed, no whitespace errors.
