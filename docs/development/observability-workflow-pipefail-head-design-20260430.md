# Observability Workflow Pipefail Head Design - 2026-04-30

## Context

The attendance remote workflow summary fixes removed several `awk | head` patterns that could false-red under `set -o pipefail`. A follow-up scan of the latest `origin/main` found the same pattern in the observability workflows:

- `.github/workflows/observability-e2e.yml`
- `.github/workflows/observability-strict.yml`

These jobs fetch Prometheus-style metrics and extract the first matching series for RBAC cache, RealShare, and approval conflict counters.

## Problem

The previous extraction style was:

```sh
awk '/metric_pattern/{print $2}' metrics.txt | head -1
```

If the metrics payload contains multiple matching series, `head -1` can close the pipe after the first line. With `pipefail` enabled, the upstream `awk` may receive SIGPIPE and the step can fail even though a valid metric was found. That creates CI false negatives in observability validation.

## Design

Keep the existing "first matching series" semantics, but make `awk` stop itself:

```sh
awk '/metric_pattern/{print $2; exit}' metrics.txt
```

For `$NF`-based strict metrics, the same pattern is used:

```sh
awk '/metric_pattern/ {print $NF; exit}' metrics.txt
```

This avoids early pipe closure entirely, preserves shell behavior for missing metrics, and does not change threshold logic.

## Scope

Changed metric extraction in:

- `observability-e2e.yml`
  - `rbac_perm_cache_hits_total`
  - `rbac_perm_cache_miss_total`
  - `rbac_perm_queries_real_total`
  - `rbac_perm_queries_synth_total`
- `observability-strict.yml`
  - `rbac_perm_queries_real_total`
  - `rbac_perm_queries_synth_total`
  - `rbac_perm_cache_hits_total`
  - `rbac_perm_cache_misses_total`
  - `metasheet_approval_conflict_total`

Intentionally not changed:

- Non-observability workflows.
- Non-metric `head` usage where the surrounding command already tolerates failure or has different semantics.

## Guardrail

Added `scripts/ops/observability-workflow-pipefail-contract.test.mjs` to keep these observability metric extraction sites from regressing to `awk ... | head -1`.
