# Plugin Metrics Hardening Plan

## Current Metrics (Stubs)
| Metric | Type | Status |
|--------|------|--------|
| plugin_loaded_total | Counter | stub increment (best-effort) |
| plugin_validation_fail_total | Counter | stub increment |

## Proposed Expansion
| Metric | Type | Purpose |
|--------|------|---------|
| plugin_sandbox_wrap_fail_total | Counter | Track sandbox wrap failures |
| plugin_load_duration_ms | Histogram | Distribution of load times per plugin |
| plugin_activation_duration_ms | Histogram | Activation overhead |
| plugin_capabilities_per_plugin | Gauge | Number of capabilities per plugin |

## Implementation Steps
1. Add prom-client singleton registration module (avoid duplicate collectors)
2. Replace lazy require in loader with direct import (after registry ready)
3. Wrap load & activation with timers → observe() histogram
4. Add optional label `plugin_id` (ensure bounded cardinality)
5. Provide `/metrics` documentation section for plugin metrics

## Validation
| Check | Method |
|-------|--------|
| Counters increment | Load example plugin with flag |
| No duplicate metric registration | Restart process twice, scrape /metrics |
| Histogram buckets reasonable | p50/p95 within expected targets |

## Hardening Timeline
1. Stabilize dynamic loading baseline (current)
2. Add counters + histograms (PR 1)
3. Add sandbox failure & capability counts (PR 2)
4. Monitor & tune buckets (PR 3)

## Risk & Mitigation
| Risk | Mitigation |
|------|------------|
| Cardinality explosion | Enforce plugin_id whitelist, no arbitrary user keys |
| Duplicate registration | Central registry singleton |
| Performance overhead | Benchmark load with and without metrics (target <5% overhead) |

