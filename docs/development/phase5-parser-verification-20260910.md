# Phase 5 Histogram Parser Verification

## Evidence Binding

Base: `a22955f83187602d09f787889c4e433fdc815107`.
Parser checkpoint: `9175829b6a9839410a8a19aad2fc4b403554a325`.
Restored parser SHA-256:
`73c4adee54e5525e498968f951bc757f10c9090fd7be036321a88134d383e240`.
The publication head is the commit carrying this report; future CI must be read
at that exact head, not inferred from local results or earlier PRs.

## Reproducible Gates

```sh
# Exact workflow test command (no live endpoint; fixture HTTP server is loopback).
node --test scripts/ops/phase5-required-samples-contract.test.mjs

# Same suite plus adjacent contracts.
node --test scripts/ops/phase5-required-samples-contract.test.mjs scripts/ops/phase5-cache-hit-rate-contract.test.mjs scripts/ops/phase5-metrics-auth-fallback-workflow-contract.test.mjs scripts/ops/phase5-nginx-metrics-route-contract.test.mjs

pnpm exec tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --types node --skipLibCheck --strict scripts/phase5-metrics-percentiles.ts
pnpm exec eslint --no-eslintrc --config packages/core-backend/.eslintrc.json --parser-options '{"project":null}' --env node scripts/phase5-metrics-percentiles.ts scripts/ops/phase5-required-samples-contract.test.mjs
pnpm --filter plugin-integration-core run test:sealed-export-s5
git diff --check
```

Neighbor suite after CI assertion: 55 passed, zero failed/skipped. Before CI
assertion: 54 passed, zero failed/skipped. Strict targeted tsc passed. ESLint
passed with zero errors and two pre-existing explicit-any warnings in threshold
loading; the local shared dependency setup needed NODE_PATH for the installed
ESLint dependencies. No repository-wide typecheck or lint claim.

The full-validator positive checks all eleven assertions and the exact current
three metric keys/counts. Negative controls preserve absent-family and explicit
zero-observation N/A/fail behavior. Malformed observations fail rather than
becoming apparent zero observations. Fixtures run the actual CLI and validator,
not a substitute parser.

## Discriminating Mutations

Five independent parser mutations each turned its named targeted test red and
were restored to the parser hash above:

| Mutation | Required red test |
| --- | --- |
| Skip bare totals | Bare-label positive |
| Remove canonical sort | Reordered-label positive |
| Restore prefix numeric parsing | Scientific-notation positive |
| Remove infinite-bucket requirement | Missing-infinity negative |
| Restore unescaped output keys | Distinct-label collision negative |

The first three were rerun on the final parser, not just its earlier version.
Normal full-suite positives were rerun after restoration. Deleting the workflow's
whole-file step turned exactly the wiring assertion red (exit 1, one failed
test); restoration returned the workflow SHA-256 to
`e572e98c0a21bd3e4e3f151d8f3d77b823a20174e1b85e2e049c695075581942`.
The official computed manifest equals the pinned manifest. All eleven commands
in the S5 package test chain passed after resolving the local dependency path.

## Review and Limits

Terra high-effort independent parser review identified missing infinite-bucket
validation and escaped output-key collisions. Both corrections were reviewed
without remaining P1/P2/P3 in that bounded delta. The reviewer did not rerun the
suite: Codex owns the execution and mutation evidence. CI-only review is separate.

Initial S5 execution stopped because the reused plugin dependency tree contained
a stale mssql symlink. No product/config change or package install was used to
repair that environment: a run-specific NODE_PATH selects the already installed
mssql 10.0.4 package. Initial failed attempts remain part of the evidence.

One Node 24.14.1 standalone run concurrent with neighboring verification ended
after 27 passing tests with one suite cancellation: `Promise resolution is still
pending but the event loop has already resolved`. It is not a green run; no root
cause is claimed from concurrency alone. The adjacent full 55-test run completed
successfully. Serial exact-command and supported Node 20 checks are recorded
separately below; the unsuccessful attempt is retained rather than erased.

- Serial Node 24.14.1 exact whole-file command: exit 0, 32 passed, zero
  failed/cancelled/skipped. This does not establish the cancellation's cause.
- Serial Node 20.20.2 exact whole-file command: exit 0, 32 passed, zero
  failed/cancelled/skipped. PATH was explicitly bound to the existing Node 20
  installation for both the runner and its CLI children.
- Serial Node 20.20.2 neighbor command: exit 0, 55 passed, zero
  failed/cancelled/skipped.
- Local Node 18 is unavailable in the checked installed-runtime directories;
  Node 18 remote CI remains unverified until publication and actual execution.
- Lifecycle inspection found callback-based listen/close, callback-settled
  execFile, and awaited finally cleanup; no unref, added delay, larger timeout,
  swallowed cancellation, or skip was introduced. No deterministic race has
  been established and no speculative lifecycle rewrite was made.

CI-delta review found no other actionable issues, but held publication pending a
supported runtime run after the cancellation. The coordinator accepted the
successful supported Node 20 exact-command evidence for Draft-only publication,
not as a resolution of the Node 24 anomaly. Remote Node 18/20 must actually run
the whole-file step with zero cancellations; a failed/cancelled run stops
promotion for investigation rather than automatic retry.

Remote CI, merge, environment nightly diagnosis, B1/B2 owner decisions, and final
synthetic product UAT are separate gates. Nothing here authorizes live metrics,
database access, flags, dispatch, staging, production, or changing SLO limits.
