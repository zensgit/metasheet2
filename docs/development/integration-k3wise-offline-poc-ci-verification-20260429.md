# K3 WISE Offline PoC CI Verification

## Commands

```bash
pnpm run verify:integration-k3wise:poc
node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/plugin-tests.yml"); puts "workflow yaml ok"'
git diff --check
```

## Expected Result

- The root script runs all three offline PoC commands in sequence.
- Preflight tests keep Save-only packet generation, customer-format coercion,
  production environment blocking, Submit/Audit blocking, SQL core-table write
  blocking, and BOM product-scope checks green.
- Evidence tests keep PASS/PARTIAL/FAIL decisions, redaction, boolean coercion,
  numeric ID coercion, status synonym normalization, and packet-safety checks
  green.
- Mock demo prints `K3 WISE PoC mock chain verified end-to-end (PASS)`.
- GitHub workflow YAML parses.
- Diff has no whitespace errors.

## Local Result

- `pnpm run verify:integration-k3wise:poc`: pass.
- `node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`: pass.
- `node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs`: pass.
- `node scripts/ops/fixtures/integration-k3wise/run-mock-poc-demo.mjs`: pass.
- Workflow YAML parse: pass.
- `git diff --check`: pass.

## CI Expectation

`Plugin System Tests` should now include a lightweight Node 20 job named
`K3 WISE offline PoC`. It should not run `pnpm install`, require customer
secrets, or contact real PLM, K3 WISE, SQL Server, or deployed MetaSheet
infrastructure.
