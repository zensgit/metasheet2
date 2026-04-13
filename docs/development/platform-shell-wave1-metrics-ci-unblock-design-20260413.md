# Platform Shell Wave 1 Metrics CI Unblock Design

## Context

PR `#852` was blocked by the GitHub Actions workflow `Plugin System Tests / test (18.x)`.

The failing assertion was not in platform-shell code. It came from
`packages/core-backend/src/metrics/__tests__/metrics-integration.test.ts`, which
still asserted that the metrics module exported exactly `61` metrics.

Current `main` exports `65` metrics because recent observability work added:

- `rpcLatencySeconds`
- `metricsStreamClients`
- `metricsStreamPushesTotal`
- `metricsStreamErrorsTotal`

## Problem

The existing test used a raw count assertion:

- it failed as soon as new metrics were added
- it did not explain which metrics were expected
- it created CI breakage on unrelated PRs such as `#852`

This made the test a poor fit for a metrics module that is expected to grow.

## Change

Replace the exact-count assertion with an explicit presence assertion for the
recently added observability metrics:

- `rpcLatencySeconds`
- `metricsStreamClients`
- `metricsStreamPushesTotal`
- `metricsStreamErrorsTotal`

The pre-existing test for required core metrics remains in place.

## Rationale

This keeps the test aligned with what actually matters:

- core metrics remain exported
- newly added RPC and metrics-stream metrics remain exported

It removes brittle coupling to an incidental total count.

