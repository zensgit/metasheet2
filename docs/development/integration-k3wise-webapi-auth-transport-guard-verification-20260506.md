# K3 WISE WebAPI Auth Transport Guard Verification - 2026-05-06

## Scope

Verified that the K3 WISE WebAPI adapter no longer treats a login response as usable unless the response provides reusable auth material for later K3 Save-only calls.

Changed files:

- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
- `plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs`
- `scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.mjs`
- `scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.test.mjs`
- `package.json`
- `docs/development/integration-k3wise-webapi-auth-transport-guard-design-20260506.md`
- `docs/development/integration-k3wise-webapi-auth-transport-guard-verification-20260506.md`

## Checks

### Focused Adapter Test

Command:

```bash
pnpm --dir plugins/plugin-integration-core run test:k3-wise-adapters
```

Expected result:

```text
k3-wise-adapters: WebAPI, SQL Server channel, and auto-flag coercion tests passed
```

Coverage added:

- Successful login without `Set-Cookie` or session id returns a failed connection check.
- The failure code is `K3_WISE_AUTH_TRANSPORT_MISSING`.
- The adapter stops at login and does not continue to health checks after missing auth transport.

### Mock K3 WebAPI Contract Test

Command:

```bash
node --test scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.test.mjs
```

Expected result:

```text
3 tests pass
```

Coverage added:

- Happy-path login, health, and material Save endpoints still work.
- Login/Save/Submit/Audit endpoints reject non-POST calls with `405` and `Allow: POST`.
- Health rejects non-GET calls with `405` and `Allow: GET`.
- The mock can model a business-success login response with no cookie and no session id.

### Full Offline K3 PoC Chain

Command:

```bash
pnpm run verify:integration-k3wise:poc
```

Expected result:

```text
K3 WISE PoC mock chain verified end-to-end (PASS)
```

This command now includes the mock K3 WebAPI contract test before running the end-to-end mock PoC demo.

### Diff Hygiene

Command:

```bash
git diff --check
```

Expected result:

```text
passed
```

## Live Validation

This is an offline adapter and fixture contract hardening. It does not require live K3 WISE access. During live customer PoC, a K3 endpoint that reports login success but does not provide `Set-Cookie` or a configured session id will now fail during connection testing with a direct operator-readable code.
