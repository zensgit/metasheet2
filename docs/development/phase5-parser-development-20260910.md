# Phase 5 Histogram Parser Development

## Status and Scope

Bounded offline correctness fix, prepared for Draft/HOLD publication. This is
not Record Detail B1/B2 ratification, nightly acceptance, or deployment approval.
Base: `a22955f83187602d09f787889c4e433fdc815107`.
Parser checkpoint: `9175829b6a9839410a8a19aad2fc4b403554a325`.

The final candidate has exactly six relative-base paths:

- `scripts/phase5-metrics-percentiles.ts`
- `scripts/ops/phase5-required-samples-contract.test.mjs`
- `.github/workflows/plugin-tests.yml`
- `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`
- `docs/development/phase5-parser-development-20260910.md`
- `docs/development/phase5-parser-verification-20260910.md`

## Correctness Changes

Bare sum/count samples and explicit empty labels now describe the same series.
Label order is canonicalized; empty and escaped values retain identity. Full
decimal/exponent parsing replaces prefix parsing, so `1e1` means ten, not one.
Totals may precede buckets. Unrelated summary/gauge totals do not become
histograms merely because their names end with sum/count.

Observed histogram families require totals, a finite bound, and a matching
`+Inf` bucket. Duplicate or malformed samples, incomplete numeric tokens,
negative/fractional/unsafe counts, nonmonotonic cumulative counts, and inconsistent
totals fail with values-free errors. Percentiles falling in the infinite bucket
return the last finite bound rather than serializing NaN/Infinity as null.
Output label values are escaped to prevent distinct label sets sharing one key.

True missing families and explicit zero observations remain N/A/fail in the full
validator. No threshold, baseline, flag, environment permission, or live scrape
behavior changed. The old positive fixture lacked a required infinite bucket;
the fixture was made complete, not the validation rule weakened.

## CI and Provenance

The whole existing contract file runs in Plugin System Tests after pnpm installs
the workspace dependencies and a dedicated step installs bc/jq/curl. Neither new
step has a conditional skip or continue-on-error. The job retains both Node 18
and Node 20. At preflight, `test (20.x)` was an existing required context; branch
protection is unchanged.

The workflow's unrestricted pull_request event and merge_group event remain.
Push coverage includes scripts, backend dependencies, root package/lock, and
workflow paths. Existing steps/events/jobs are a strict semantic union: remove
only the two new steps and the parsed workflow equals the frozen base.

The existing contract structurally checks this wiring without recursively
executing itself. This local assertion is not an independent second required
caller: removal of the sole workflow step also disconnects its assertions in CI.
Do not claim an undeletable or independently protected requiredness guarantee.

The official `computePackageProvenancePinSet` recomputes the pin manifest. Only
`evidenceFiles.pluginTestsWorkflow` changes; all other digests stay identical.

## Compatibility and Boundaries

Current threshold/report/regression selectors are ordinary one-label keys and
retain exact output-key compatibility. Arbitrary escaped custom selectors in the
unchanged shell consumer are not newly supported. This is not a general claim of
support for every Prometheus exposition format.

Offline parser defects were reproduced, but are not proven causes of the empty
percentile maps in nightly runs 34427854013 and 34428034906. Raw scrape text was
not retained in those artifacts. Missing-sample diagnosis remains open. RSS
increased relative to an old baseline; matched-load/uptime/replica observations
are absent, so this does not prove a memory leak. No live metrics endpoint was
accessed and no real reload/snapshot action was invoked to manufacture samples.

Record Detail PR-A is separate: #5585 landed, #5488 was retired; B1/#5494 and
B2/#5495 remain separate owner-ratify decisions. This fix grants none of them.
