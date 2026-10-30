# Attendance closeout regression-gate repair — 2026-10-24

Status: owner-authorized final-audit repair, Draft/HOLD. No product runtime or default changes, feature enablement, merge, deployment, R71, real UAT or business50004 work.

Base: fdb30a671686db8dbdbdf606f3a6f1b98add9969. Refs #4556.

The W6-234 verification report lists two still-current residuals: the effective-policy panel's real feature-store default is not covered by its mocked host tests, and the decision-trace metric spec is omitted from the domain changed-path classifier. The final audit additionally confirmed that the metric filter was absent from the actual required runner; both registrations are repaired. The backend two-layer enforcement already exists; this repair adds regression evidence without changing it.

## Required behavior and gates

- Exercise the real feature store: initial/default missing flag is OFF; admin/product mode/plugin inference never turns this panel ON; accept explicit backend booleans and preserve the existing separately authorized local override path.
- Wire the new spec into domain push paths, PR changed-path classification and actual targeted execution, plus the unconditional required runner and generated token registry.
- Add a discriminating workflow regression for both the new spec and the inherited metric spec. Original metric file must first fail its classifier assertion.
- Mutation: change only this feature's initial default to true; the initial default assertion must fail; remove the metric classifier entry and its named workflow assertion must fail. Restore exact bytes.
- New spec, workflow neighbors, required-lane guards and quality pass with actual assertion status and source hashes. Pending/skipped do not count. Published-head required CI remains a separate gate.
- No modifications under product src, backend, plugin, API, migrations, flags or business configuration. No UI screenshot requirement because there is no UI behavior/layout change.

Evidence: owned remote artifacts/attendance-closeout-gate-repairs-20261024. No original passed suite is re-run without a changed input; the changed workflow and runner justify their affected neighbor checks.

## Actual local evidence

- Original workflow regression: 2 matching failures, 31 filtered exclusions.
- Real-store feature cases 14, existing metric cases 14, host cases 2, mobile neighbor cases 3: all 33 actual passed at unchanged file hashes; retained from the first run.
- First candidate workflow result 32 passed / 1 failed exposed the missing required metric registration. This failure is preserved, not counted as success.
- Final complete workflow contract: 33/33; required-lane shape/manifest guards: 63/63; zero skipped/pending in normal suites. Generated registry adds exactly two tokens and removes none.
- Default mutation: 1 named failure / 13 filtered exclusions; classifier mutation: 1 named failure / 32 filtered exclusions. Exclusions are never counted as passed. Exact source bytes restored.
- `pnpm validate:all`: exit 0 using Node 20.20.2 / pnpm 9.15.9 in the owned remote copy. Runtime trees, API, migrations, flags and lockfile unchanged.
- Independent static review found no confirmed remaining issue at the six reviewed path hashes. This final documentation paragraph is evidence-only and was added after that review.

Published-head required CI is pending separately. These local gates do not authorize merge, deployment, flag enablement, issue closure or product acceptance. Existing failed attempts and helper-receipt limitations remain in the remote audit receipts.
