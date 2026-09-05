# Phase 5 Plugin Reload Metrics Design

## Scope

Wire the existing registered `metasheet_plugin_reload_duration_seconds` histogram to
the already-successful `PluginLoader.reloadPlugin` path. This is instrumentation
repair only; it adds no reload behavior, endpoint, flag, workflow, or metric
definition.

## Evidence And Boundary

- `src/metrics/metrics.ts` defines, registers, and exports the histogram with the
  server-owned `plugin_name` label and seconds unit.
- `src/core/plugin-loader.ts` records only the legacy
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

The existing loader-edge unit file will use a synthetic loaded plugin and stubs
only for loader reload side effects. It will assert real registry exposition:

- exactly one `_count` sample and a seconds-valued `_sum` after success;
- no sample after unknown or failed reload;
- existing failed and callback semantics;
- an observer throw leaves the successful reload return intact.

Mutation checks will prove each guard: remove `observe`, pass milliseconds, and
remove observer containment; each must turn its matching proof red before
restoration. Local checks are the focused unit file, a loader neighbor, backend
type-check, source ESLint, and `git diff --check`. No remote CI or production
reload/scrape is part of this change.
