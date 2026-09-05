# Phase 5 Plugin Reload Metrics Design

## Scope

Base: `70dc72d7671cad9cea1925ed93f90d3d9c746aeb`.
Runtime code: `7d6bab102b3b5592c0900c7d0d1d55ddb4917766`.
Final test checkpoint: `f45b9715c69485d10607d6e9eb90e083f85abbf6`, tree
`17dbd7fe03b303a4ece4f63c1a49a0dfb4763895`. Status: local verified / Draft-HOLD.

Wire the existing registered `metasheet_plugin_reload_duration_seconds` histogram to
the already-successful `PluginLoader.reloadPlugin` path. This is instrumentation
repair only; it adds no reload behavior, endpoint, flag, workflow, or metric
definition.

## Evidence And Boundary

- `src/metrics/metrics.ts` defines, registers, and exports the histogram with the
  server-owned `plugin_name` label and seconds unit.
- At the base above, `src/core/plugin-loader.ts` recorded only the legacy
  `plugin_hot_swap_duration_ms` custom metric after a reload succeeds.
- Unknown plugins and failed loads return before that success tail. Those paths
  must not emit a successful-reload histogram sample.
- Existing before/after hook handling, unload/load ordering, return value, and
  legacy custom metrics remain unchanged.

## Change

At the existing success tail, observe `duration / 1000` once using the loaded
plugin identity. Wrap only the Prometheus observation so an observer failure
cannot turn a successful reload into a failure; do not catch reload, hook, or
load errors.

## Verification

The existing loader-edge unit file uses synthetic loaded plugins and stubs
only for loader reload side effects. It asserts real registry exposition:

- exactly one `_count` sample and a seconds-valued `_sum` after success;
- no sample after unknown or failed reload;
- existing failed and callback semantics;
- an observer throw leaves the successful reload return intact.
- distinct original and reloaded names prove the label comes from the returned
  manifest, not the lookup argument;
- a rejected load preserves the exact business error and emits no sample;
- the legacy custom histogram still receives exactly one millisecond call.

All six mutations were RED and restored: remove `observe`, pass milliseconds,
remove observer containment, use the lookup label, swallow the load error, and
remove the old millisecond call. Final focused tests passed 5/5; three owning and
neighbor files passed 37/37; typecheck, source ESLint, and diff-check passed.
These are synthetic local gates, not production reload/scrape evidence.
