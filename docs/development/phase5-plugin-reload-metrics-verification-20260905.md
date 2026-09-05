# Phase 5 Plugin Reload Metrics Verification

## Frozen Code Binding

- Base: `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`
- Code commit: `7d6bab102b3b5592c0900c7d0d1d55ddb4917766`
- Code tree: `799f56e23b59d7a28be79016b0e4d2bcbca918be`
- Final test-only checkpoint: `f45b9715c69485d10607d6e9eb90e083f85abbf6`
- Test checkpoint tree: `17dbd7fe03b303a4ece4f63c1a49a0dfb4763895`
- The runtime file is byte-identical to the code commit; subsequent changes
  are the owning test file and this report pair only.
- Code scope: `packages/core-backend/src/core/plugin-loader.ts` and
  `packages/core-backend/tests/unit/loader-edges.test.ts` only.

## Result

`PluginLoader.reloadPlugin` retains the legacy custom millisecond histogram and,
only after a successful reload, observes the registered Prometheus histogram once
with `reloaded.manifest.name` and `duration / 1000`. The observer call is
contained so an observability fault cannot replace the successful return. Unknown
plugins and failed loads return before this success-only observation.

## Local Evidence

| Gate | Result |
| --- | --- |
| Focused loader edge unit | Original 4/4; final 5/5 PASS |
| Loader and metrics neighbors | Original 36/36; final 3 files, 37/37 PASS |
| Core backend type-check | PASS |
| Backend-context source ESLint | PASS |
| `git diff --check` | PASS |

The focused suite uses the real shared registry and proves one exact labeled
`_count` sample plus a `0.25`-second `_sum`; it also proves no sample for unknown
or failed reloads, preserves cascade failure callback behavior, and preserves a
successful result when the observer throws.

Final commands from `packages/core-backend`, with Node 20.20.2 and existing local
dependency links (no install):

```sh
./node_modules/.bin/vitest run --watch=false tests/unit/loader-edges.test.ts tests/plugin-loader.success.test.ts src/metrics/__tests__/metrics-integration.test.ts
./node_modules/.bin/tsc --noEmit
../../node_modules/.bin/eslint src/core/plugin-loader.ts
git diff --check
```

The first additional legacy-call assertion used a matcher unavailable in the
repo's Vitest 1.6.1; that run failed and is not mutation evidence. The assertion
was replaced with exact `mock.calls` equality before the final gates. ESLint's
initial package-local executable lookup was unavailable; the existing root
executable ran successfully from the backend config context.

## Mutation Evidence

| Mutation | Expected RED evidence | Restored |
| --- | --- | --- |
| Remove observation | Missing count/sum and zero observer calls | Yes |
| Pass milliseconds | Expected `0.25`; received `250` | Yes |
| Remove containment | Successful reload rejected with observer error | Yes |
| Use lookup argument instead of returned manifest label | Exact successful histogram sample missing | Yes |
| Swallow a rejected load into a successful fallback | Exact business-error rejection assertion failed | Yes |
| Remove the legacy millisecond histogram | Exact legacy call-array assertion failed | Yes |

The last three mutations each produced exactly one failed test and four passed
tests; runtime source was restored byte-for-byte before the 37-test final run.

## Review

Luna's read-only review found no runtime bug, but raised two P2 discrimination
gaps (same-name label fixture and untested rejected load) and one P3 gap (legacy
metric preservation). Codex verified and closed each in the existing unit file:
distinct original/returned names, identity-preserving rejected-error assertion,
and exact legacy millisecond call. The matching independent mutations above are
coordinator evidence. No new runtime implementation change was needed; no
remote or live review result is inferred.

## Limits And Hold

Remote CI was not run. No database, network endpoint, external IO, live reload,
production scrape, flag, dispatch, push, PR, merge, or deployment was performed.
This proves only the bounded local wiring. Missing live Prometheus samples remain
HOLD, and this change is not production proof or an explanation for all six live
NA assertions.
