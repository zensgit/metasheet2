# Phase 5 Plugin Reload Metrics Verification

## Frozen Code Binding

- Base: `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`
- Code commit: `7d6bab102b3b5592c0900c7d0d1d55ddb4917766`
- Code tree: `799f56e23b59d7a28be79016b0e4d2bcbca918be`
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
| Focused loader edge unit | PASS: 4 tests |
| Loader and metrics neighbors | PASS: 3 files, 36 tests |
| Core backend type-check | PASS |
| Backend-context source ESLint | PASS |
| `git diff --check` | PASS |

The focused suite uses the real shared registry and proves one exact labeled
`_count` sample plus a `0.25`-second `_sum`; it also proves no sample for unknown
or failed reloads, preserves cascade failure callback behavior, and preserves a
successful result when the observer throws.

## Mutation Evidence

| Mutation | Expected RED evidence | Restored |
| --- | --- | --- |
| Remove observation | Missing count/sum and zero observer calls | Yes |
| Pass milliseconds | Expected `0.25`; received `250` | Yes |
| Remove containment | Successful reload rejected with observer error | Yes |

## Limits And Hold

Remote CI was not run. No database, network endpoint, external IO, live reload,
production scrape, flag, dispatch, push, PR, merge, or deployment was performed.
This proves only the bounded local wiring. Missing live Prometheus samples remain
HOLD, and this change is not production proof or an explanation for all six live
NA assertions.
