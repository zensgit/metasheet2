# Phase 5 scheduled sample attribution, 2026-09-30

Status: OPEN operational gate. Read-only attribution; no workflow dispatch, metrics probe, threshold edit, sample-generating operation, deployment, or flag change.

All three scheduled runs used main `fc684dceeb692aef050558ca72c16e16a39dbe7b`:

| Workflow | Run | Artifact | Summary |
| --- | --- | --- | --- |
| External Metrics | [36658520672](https://github.com/zensgit/metasheet2/actions/runs/36658520672) | `phase5-nightly` / `11073247938` | 11 checks, 5 pass, 0 fail, 6 N/A, overall fail |
| With Regression | [36658691166](https://github.com/zensgit/metasheet2/actions/runs/36658691166) | `phase5-validation` / `11073740552` | same |
| Nightly Validation | [36659195003](https://github.com/zensgit/metasheet2/actions/runs/36659195003) | `phase5-validation` / `11073367480` | same |

The six N/A assertions are P95/P99 for `plugin_reload` and snapshot `create`/`restore`. All five cache/fallback/memory/HTTP assertions pass. The Nightly log fetched 857 raw metric lines and found 22 histogram families, but filtered to zero histograms for the two configured target families. Its artifact has an empty `percentiles` object. `scripts/phase5-thresholds.json` names the two families and their exact labels; `scripts/phase5-full-validate.sh` correctly makes missing latency samples blocking. The relevant metric declarations and observation call sites exist in `packages/core-backend/src/metrics/metrics.ts`, `src/core/plugin-loader.ts`, and `src/services/SnapshotService.ts`.

The local required-samples contract ran on this branch with `node --test scripts/ops/phase5-required-samples-contract.test.mjs`: 2/2 pass. It checks both that missing samples fail the overall gate and that supplied samples can pass. This corroborates the validator behavior; it does not identify the deployed scrape target or prove production latency health.

**Bounded conclusion:** these runs fail because required target latency samples are absent, not because a measured latency exceeded a threshold. The artifacts do not contain the raw scrape, and the code/CI records do not distinguish absent metric registration, unexpected label values, different scrape target, or zero relevant operations. Keep the alerts open. A later authorized read-only scrape/target-and-label census must bind the authenticated target, deployed SHA, metric family/label counts, and run time; never generate production reload/restore activity merely to make the monitor green.

This Phase 5 gate is platform operational evidence, not an attribution of a Time Machine product regression. It does not block isolated synthetic APFS development, but it remains a release/monitoring gate before any production Time Machine claim.
