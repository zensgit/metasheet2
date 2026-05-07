# K3 WISE Mock WebAPI Log Redaction Verification

Date: 2026-05-07

## Scope

Files verified:

- `scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.mjs`
- `scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.test.mjs`
- `scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`

## Checks

Run from repository root:

```bash
node --check scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.mjs
node --check scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.test.mjs
node --test scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.test.mjs
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
pnpm run verify:integration-k3wise:poc
git diff --check
```

## Results

- `node --check scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.mjs`: pass.
- `node --check scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.test.mjs`: pass.
- `node --test scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.test.mjs`: pass, 2/2 tests.
- `node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`: pass, end-to-end mock chain decision PASS.
- `pnpm run verify:integration-k3wise:poc`: pass, preflight 16/16, evidence 31/31, mock PoC demo PASS.
- `git diff --check`: pass.

## Acceptance

- Login request `password`, `acctId`, nested token/API key fields, and array
  credential fields are redacted in `mock.calls`.
- The optional mock logger receives only sanitized events.
- Serialized call logs do not contain the original secret values.
- Material Save rejection still uses the raw request body internally, proving
  redaction does not break mock response behavior.
- The one-command offline K3 WISE mock PoC demo still passes.
