# K3 WISE GATE UI Readiness Verification - 2026-05-05

## Worktree

`/private/tmp/ms2-erp-plm-config-20260505`

Branch:

`codex/erp-plm-config-workbench-20260505`

Baseline:

`origin/main` at `e7f293235`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web build
pnpm run verify:integration-k3wise:poc
git diff --check
```

## Results

Initial GATE readiness slice:

- `k3WiseSetup.spec.ts`: 21/21 passed.
- `@metasheet/web type-check`: passed.
- `@metasheet/web build`: passed. Vite reported the existing large chunk warnings.
- `verify:integration-k3wise:poc`: passed.
  - preflight tests: 16/16 passed.
  - evidence tests: 31/31 passed.
  - mock PoC demo ended with `K3 WISE PoC mock chain verified end-to-end (PASS)`.
- `git diff --check`: passed.

Customer GATE import follow-up:

- `k3WiseSetup.spec.ts`: 24/24 passed.
- `@metasheet/web type-check`: passed.
- `@metasheet/web build`: passed. Vite reported the existing dynamic import and large chunk warnings.
- `verify:integration-k3wise:poc`: passed.
  - preflight tests: 16/16 passed.
  - evidence tests: 31/31 passed.
  - mock PoC demo ended with `K3 WISE PoC mock chain verified end-to-end (PASS)`.
- `git diff --check`: passed.

Customer GATE import UI regression follow-up:

- `k3WiseSetupView.spec.ts`: 1/1 passed.
- `k3WiseSetup.spec.ts` + `platform-shell-nav.spec.ts`: 27/27 passed.
  - `platform-shell-nav.spec.ts` printed the existing `WebSocket server error: Port is already in use` warning, but all assertions passed.
- `@metasheet/web type-check`: passed.
- `@metasheet/web build`: passed. Vite reported the existing dynamic import and large chunk warnings.
- `verify:integration-k3wise:poc`: passed.
  - preflight tests: 16/16 passed.
  - evidence tests: 31/31 passed.
  - mock PoC demo ended with `K3 WISE PoC mock chain verified end-to-end (PASS)`.

## Coverage Added

- GATE draft generation from the setup form.
- Secret redaction for K3 and PLM passwords in generated GATE JSON.
- PoC command-set generation for preflight, offline mock, and evidence compilation.
- Client-side blocking for production K3 WISE, non-Save-only flags, BOM product-scope gaps, and SQL core-table writes in non-readonly modes.
- Customer-returned GATE JSON import into public form fields.
- Rejection for empty, malformed, and non-object GATE JSON.
- Boolean normalization for English, numeric, and Chinese customer hand-edit variants.
- Alias normalization for K3 environment, PLM read method, and SQL Server mode.
- Secret-like field detection and password-field clearing on import.
- Page-level regression coverage for the import textarea, import button, warning list, rendered form values, and password clearing.
- Page-level regression coverage for generated GATE JSON download redaction, hidden anchor cleanup, and deferred object URL release.
- Page-level regression coverage for authenticated postdeploy smoke and summary commands in the PoC readiness panel.
- Page-level regression coverage for one-click copy of displayed postdeploy commands.

GATE JSON copy redaction UI regression follow-up:

- `k3WiseSetupView.spec.ts`: 2/2 passed.
- `k3WiseSetup.spec.ts` + `k3WiseSetupView.spec.ts` + `platform-shell-nav.spec.ts`: 29/29 passed.
- `@metasheet/web type-check`: passed.
- `@metasheet/web build`: passed. Vite reported the existing dynamic import and large chunk warnings.
- `verify:integration-k3wise:poc`: passed.
  - preflight tests: 16/16 passed.
  - evidence tests: 31/31 passed.
  - mock PoC demo ended with `K3 WISE PoC mock chain verified end-to-end (PASS)`.
- `git diff --check`: passed.

GATE JSON download redaction UI regression follow-up:

- `k3WiseSetupView.spec.ts`: 3/3 passed.
- `k3WiseSetup.spec.ts` + `k3WiseSetupView.spec.ts` + `platform-shell-nav.spec.ts`: 30/30 passed.
- `@metasheet/web type-check`: passed.
- `@metasheet/web build`: passed. Vite reported the existing dynamic import and large chunk warnings.
- `verify:integration-k3wise:poc`: passed.
  - preflight tests: 16/16 passed.
  - evidence tests: 31/31 passed.
  - mock PoC demo ended with `K3 WISE PoC mock chain verified end-to-end (PASS)`.
- `git diff --check`: passed.

Postdeploy smoke command UI follow-up:

- `k3WiseSetup.spec.ts`: 24/24 passed.
- `k3WiseSetupView.spec.ts`: 3/3 passed. The local jsdom run printed the existing `WebSocket server error: Port is already in use` warning, but all assertions passed.
- `k3WiseSetup.spec.ts` + `k3WiseSetupView.spec.ts` + `platform-shell-nav.spec.ts`: 30/30 passed.
- `@metasheet/web type-check`: passed.
- `@metasheet/web build`: passed. Vite reported the existing dynamic import and large chunk warnings.
- `verify:integration-k3wise:poc`: passed.
  - preflight tests: 16/16 passed.
  - evidence tests: 31/31 passed.
  - mock PoC demo ended with `K3 WISE PoC mock chain verified end-to-end (PASS)`.
- `node scripts/ops/integration-k3wise-postdeploy-smoke.mjs --help` and `node scripts/ops/integration-k3wise-postdeploy-summary.mjs --help`: passed, confirming the surfaced flags still match CLI contracts.
- `git diff --check`: passed.

PoC command copy UI follow-up:

- `k3WiseSetupView.spec.ts`: 3/3 passed, covering copying `Postdeploy smoke` directly from the PoC readiness panel and preserving the existing GATE JSON copy path.
- `k3WiseSetup.spec.ts`: 24/24 passed. The local jsdom run printed the existing `WebSocket server error: Port is already in use` warning, but all assertions passed.
- `k3WiseSetup.spec.ts` + `k3WiseSetupView.spec.ts` + `platform-shell-nav.spec.ts`: 30/30 passed.
- `@metasheet/web type-check`: passed.
- `@metasheet/web build`: passed. Vite reported the existing dynamic import and large chunk warnings.
- `verify:integration-k3wise:poc`: passed.
  - preflight tests: 16/16 passed.
  - evidence tests: 31/31 passed.
  - mock PoC demo ended with `K3 WISE PoC mock chain verified end-to-end (PASS)`.
- `node scripts/ops/integration-k3wise-postdeploy-smoke.mjs --help` and `node scripts/ops/integration-k3wise-postdeploy-summary.mjs --help`: passed.
- `git diff --check`: passed.

## Not Covered

- Real customer PLM connectivity.
- Real K3 WISE WebAPI connectivity.
- Browser-level visual screenshot verification.
- Running the preflight script from the browser. Operators still run the displayed command outside the web page.
