# Time Machine Phase 5 latency sample census design lock — 2026-09-30

## Scope and success criteria

Phase 5 scheduled validation currently reports six required latency samples as N/A. The existing validator fetches Prometheus metrics twice, so a separate diagnostic request cannot reliably explain the percentile result. This slice uses the same fetched metrics body for percentile calculation and a values-free census of the required latency families.

Success means one validation run distinguishes, for each required histogram, an absent family, a declared but empty family, a family with nonmatching selector labels, and a matching selector with no positive observations. Synthetic loopback tests must cover these cases and show that the existing N/A/fail and measured-threshold decisions are unchanged. The new test must run in CI.

## Contract

- Reuse the validator's existing raw metrics response as the percentile input. Do not make an additional metrics request for the census.
- Recognize histogram TYPE declarations with the horizontal whitespace allowed by the [Prometheus text format](https://prometheus.io/docs/instrumenting/exposition_formats/#line-format). A declared family with no samples remains `declared_empty`, including tab-separated or indented declarations.
- Add only bounded counts and booleans under `latency_source_census` in the validation JSON, keyed by fixed metric identifiers from the Phase 5 threshold contract. Do not include raw metric lines, label values, hosts, URLs, credentials, or customer values in the new field.
- Keep existing percentile thresholds, missing-sample failure behavior, feature flags, and report verdict unchanged.
- Do not synthesize activity or samples. This is a local diagnostic and CI slice, not a staging dispatch, flag enablement, merge, or production-readiness claim.

## Gates

1. Focused synthetic loopback test verifies one metrics request and all missing-sample distinctions.
2. Existing Phase 5 required-samples contract test still passes, including missing-sample failure and positive-sample success.
3. The test is wired into a PR-running CI lane and the exact PR head is green.
4. Staging acceptance follows the owner-selected storage/custody assurance profile and a separately authorized exact-SHA window. D1 allows local object storage for staging; the existing D7 runbook's independent-store/KMS profile and the approved non-KMS local synthetic profile remain distinct. This diagnostic slice supplies neither runtime/provider selection nor staging execution.
