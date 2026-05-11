# K3 WISE API Authority Token Auth - Verification

## Package Review

Reviewed `/Users/chouhua/Downloads/K3API.zip` in a temporary directory.

Relevant evidence:

- top-level K3 WebAPI files: `Default.aspx`, `DoAction.ashx`, `Web.config`,
  `DOCUMENT/*.aspx`, `XML/*.xml`, and `BIN/Kingdee.K3.API.*.dll`
- nested APITest project under `FILE/APITest.zip`
- APITest calls `Token/Create?authorityCode=...`, then `...?Token=...`
- material logs show `controller: Material`, `action: Save`, and `k3data`
  shaped as `{ "Data": { ... } }`

Secret handling:

- no token, authority code, password, or URL query secret from the package is
  copied into this document
- the package remains outside git

## Local Tests

### K3 WebAPI adapter contract

```bash
node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
```

Result:

```text
PASS - WebAPI, SQL Server channel, and auto-flag coercion tests passed
```

Coverage added:

- authority-code token request uses `authorityCode` query param
- returned token is cached across `testConnection()` and `upsert()`
- material save sends `Token` as query param
- default body envelope is `Data`
- K3 package response shape maps to successful upsert metadata
- legacy login-session mode still passes

### Frontend setup helpers

```bash
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false
```

Result:

```text
PASS - 26 tests
```

Coverage added:

- frontend builds authority-code token external-system payloads
- login mode remains available and validates username/password/acctId
- saved legacy login config loads back as login mode
- localStorage fallback works when the test environment exposes a partial
  `localStorage` object

### REST PoC control plane

```bash
node plugins/plugin-integration-core/__tests__/http-routes-plm-k3wise-poc.test.cjs
```

Result:

```text
PASS - REST PLM -> K3 WISE mock control-plane chain passed
```

### E2E PLM to K3 writeback

```bash
node plugins/plugin-integration-core/__tests__/e2e-plm-k3wise-writeback.test.cjs
```

Result:

```text
PASS - mock PLM -> K3 WISE -> feedback tests passed
```

### K3 WISE offline PoC readiness

```bash
pnpm run verify:integration-k3wise:poc
```

Result:

```text
PASS - preflight tests, evidence tests, and mock PoC demo passed
```

## Deployment Impact

This is runtime-safe for the current Windows/on-prem package path:

- no migration
- no package-layout change
- no new runtime dependency
- no secret printed to logs or documentation
- existing `/K3API/Login` deployments can still select login mode

The next Windows package should include both this PR and #1458 so that:

1. the integration plugin routes are present in the package
2. the K3 WebAPI adapter matches the real K3API authority-code token flow
