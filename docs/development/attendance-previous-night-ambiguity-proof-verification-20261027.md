# Previous-night ambiguity proof verification

Draft/HOLD. Refs #4556. Base5193da4c5667418a8bd9fa40a9a80021cdcac077.

## Actual local evidence

The new MUT05_PREVIOUS_AMBIGUITY case covers two distinct previous overnight
candidates containing the same post-midnight punch, no open-record winner,
both input orders and the full existing ambiguity response. It uses the real
pure selector and existing fixture helpers. The legal unique previous-night
case is the actual positive control.

| Phase | Actual assertions | Original cases excluded |
| --- | --- | --- |
| Temporary previous-date winner fault | New case failed: resolved instead of ambiguous; unique-night control passed | 42 |
| Exact runtime restoration | New case and unique-night control passed, exit0, zero selected skips | 42 |

The fault changed only the existing previous-night branch from requiring one
candidate/one match to allowing one-or-more previous candidates. Runtime
bytes were restored exactly. This is a guard discriminator, not a product
runtime defect or implementation change. Each phase is recorded separately;
filtered assertions and duplicate reporter messages are not counted as passes.

The candidate unit SHA256 is
`bd7138360365b97b2ded9e29714bc178fb642fff9971ceb5db730481382dbe49`.
The original/restored runtime SHA256 is
`a0e6b6bf3592202a42c90ba99a23d6e1cdced99fcd5ac4b4636bb383f9c5b2cb`.
Removing only the added case restores the entire original unit file exactly,
including all43 original cases, hooks and budgets.

Explicit same-absolute-path/config lint: baseline and current both exit1 with
one pre-existing `@typescript-eslint/no-var-requires` error and no warnings;
introduced errors/warnings0. This is not full-file lint0. Actual successful
same-base DST production validate:all is retained through14117 identical
other tracked inputs and the actual TS test exclusions; it was not rerun.

Independent source-only review found no confirmed introduced P1/P2, and the
main agent separately audited raw assertions, failure diffs, source hashes,
original-file inverse and quality applicability. Review is not run proof.
Artifacts: `MUT05-targeted-validation-state.json`,
`explicit-test-lint-and-quality-state.json`,
`main-independent-local-final-audit.json` and
`independent-candidate-source-review.json`.

These runs were on the uncommitted candidate over the stated base. The exact
tested unit bytes are bound to the final source commit without replaying the
tests merely for a commit receipt. No runtime/schema/dependency/workflow/flag
or API-contract changes. This existing unit file is already in required
backend core tests; its exact-head whole44 result remains CI-pending.

Pure-selection synthetic proof only: no five-entrypoint parity, SQL/HTTP,
real auth, UAT or parent/owner acceptance claim. All PRs remain Draft;
Stream/lifecycleOFF, realUAT/50004excluded, no merge/deploy/R71.
