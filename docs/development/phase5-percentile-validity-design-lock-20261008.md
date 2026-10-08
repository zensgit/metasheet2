# Phase5 percentile validity repair — 2026-10-08

Bounded correctness repair against base `afd32b704c6ff4c82dbfe90b94066fcaf3fc0074`.

## Contract

- A required latency histogram with positive sample count can pass a finite threshold only when its requested percentile is finite and satisfies that threshold.
- Prometheus `+Inf` is an infinite boundary. A requested rank inside an infinite or invalid boundary, or beyond bucket coverage, produces an explicit nullable percentile. Do not substitute the last finite boundary.
- The validator preserves null and records FAIL with valid JSON for positive-count unestimable latency. It does not send null to `bc`.
- Missing/zero required samples remain NA and make overall validation fail.
- Finite interpolation, thresholds, flags and metric/label selection retain their existing behavior.

## Verification gates

| Gate | Required evidence |
| --- | --- |
| Defect reproduction | Full production parser/validator against loopback synthetic histograms exits 0 before repair for positive-count overflow; contract tests RED |
| Correctness | Whole `scripts/ops/phase5-required-samples-contract.test.mjs`: seven tests PASS, zero skip/todo/cancelled |
| Controls | Finite interpolation PASS; missing and zero samples NA/overall FAIL |
| Mutation | Restore null-to-zero extraction: three positive-count negatives RED; byte-identical restore; whole contract GREEN |
| Neighbors | Cache/auth workflow contract files PASS |
| Source checks | Strict targeted TypeScript compile and Bash syntax PASS |
| Required CI | Backend unit wrapper must collect and run the whole seven-test contract; root owns wiring and CI evidence |

## Boundaries

Local tests use synthetic loopback metrics and owned installed dependencies with npm offline mode. No live metrics, customer data, flag enablement, external writes or deployment are part of this repair. Extra scrape-label selection/aggregation requires a separate semantic decision and is unchanged.

This reproduced positive-count false green does not establish the cause of historical nightly runs that selected zero histograms and reported five PASS plus six NA.
