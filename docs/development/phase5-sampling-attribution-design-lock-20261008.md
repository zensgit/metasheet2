# Phase5 sampling attribution repair — 2026-10-08

Base: `9eee3a3cd0e734f6a4abb972068f4f535eb08ebf`.

This repairs existing Phase5 diagnostics; it introduces no Time Machine capability.
The final validation JSON gains a values-free `sampling` block for the SECOND /
PERCENTILE scrape: exact input SHA256, parsed/relevant histogram counts and each
configured latency threshold's metric ID, raw family bucket-line count, exact
family histogram count, selected count and reason. Selection must use the same
exact serialized metric key as the existing validator. No arbitrary labels,
keys, bodies, URLs, headers or secrets enter this new block.

Distinguish absent buckets, present but unparsed buckets, missing exact selector,
missing parsed count, invalid nonfinite count, genuine zero count and positive selected count. A count
defaulted to zero is not evidence of genuine zero samples. A complete finite
nonnegative count token must agree with the legacy parsed count;
malformed/prefix-only tokens cannot prove positive or zero samples. Reasons describe
sampling, not SLO success or deployment identity. Early HTTP/CLI failures still
exit before final JSON; this repair does not claim to diagnose those failures.

Gates, thresholds, selectors, two requests, authentication, percentile calculation,
exporter, deployment and flags remain unchanged. The nullable/+Inf calculation
repair on a different candidate is outside this slice. Existing artifact fields
are unchanged; values-free applies to the new sampling block only.

Verification: whole real-CLI contract covers missing, passing, wrong selector
with sensitive-label sentinel, missing count, zero count and malformed buckets;
preserve actual exits and the existing 11-check gate. Verify exact second-body
hash and two requests, plus bounded own-child timeout/spawn-error refusals. A
backend unit guard runs the whole eight-test contract with a fixed count so the
existing required backend test chain discovers it. Run this
guard and existing cache/auth contract neighbors, targeted TypeScript and Bash
syntax checks. Only owned synthetic loopback input and offline dependencies are
used; no external metrics, business activity, native APFS, publication or enablement.
