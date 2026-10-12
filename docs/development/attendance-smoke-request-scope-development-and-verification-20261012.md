# Attendance smoke request and record scope verification

The non-default synthetic organization smoke could import and approve a request, then fail with `approved request not found in list`. Request writes carried `orgId` in JSON while the list URL omitted it. The existing URL helper scoped imports only, and the mock server returned requests regardless of the selector.

The helper now also binds request collection/actions and record reads, preserving filters and rejecting every conflicting selector, including contradictory duplicates. Auth, global directory/settings, rules/me, leave-balances/me and lookalike routes remain unchanged. Backend record reads already derive authenticated identity; this consumer change does not alter that policy.

Implementation source: `21e0845dbaa09a08e2339f7315e5a70442da5510`, parent `8fb388f0a71b42cffc9f16b6494994e4327ad10a`. The original finding was reproduced on backend `4a00287848a2e57312a8471f0b60ea96fb9e796d`, which contains the separately reviewed locale repair over main `1dd42d08761039c9937dae06c712fadd10092ab6`. Later main `8b2213f1fad87569d8c89497e60ef6c062dafc36` only changes unrelated documentation/EOL attributes relative to that main source. These are explicitly different consumer/backend revisions, not an assertion that this repair is deployed.

| Design-lock gate | Evidence |
| --- | --- |
| Counterexample | Expanded strict mock with original helper: 3 pass / 4 fail / 0 skipped |
| Positive and neighbors | Scope, reconciliation and workdate suites: 23/23 pass, 0 skipped |
| Conflicting selector and route boundary | Covered by existing whole-file spec, including contradictory duplicates and unrelated/lookalike routes |
| Mutation | Reverting only the helper to import-only: 4 expected failures; restored saved bytes: 7/7 pass |
| CI wiring | Existing plugin-tests command runs the entire scope spec plus reconciliation neighbor; no tests removed |
| Real synthetic minimum | Import, approval, approved-request list and record readback pass after repair |
| Real synthetic Strict API | All nine selected required API options enabled; exit 0, before/after expected backend SHA proof passed |
| Quality | `pnpm validate:all` exit 0 on implementation source; `git diff --check` clean |
| Independent review | Sol 6.1, high effort: 0 actionable findings; source review is separate from runtime proof |
| Public branch, PR, remote CI | Not authorized for this separate repair; local only |

Commands run with Node 20.20.2/pnpm 10.16.1 in the owned Mac mini worktree:

```bash
node --test scripts/ops/attendance-import-scope.test.mjs \
  scripts/ops/attendance-history-reconcile.test.mjs \
  scripts/ops/attendance-smoke-workdate.test.mjs
pnpm validate:all
git diff --check
```

Runtime qualification uses a fresh wholly synthetic PostgreSQL database, all 439 migrations without exclusions, real authentication and canonical UUID organizations. Required Strict API options: attendance admin API, idempotency, import export/upload/async/upload-async/telemetry/upsert strategy and preview async. Admin-settings-save was also enabled for subsequent browser qualification; API qualification alone does not establish that result. No tenant identifiers, credentials or target addresses are published here. Private receipts preserve failed attempts and corrected positive controls; a run overlapping the mutation is excluded from acceptance.

Complete Strict remains a separate gate: API, desktop and mobile passed, while role effective-permission readback and the production-flow browser's collapsed history filters failed in the first complete run. Docker deployment preflight was intentionally skipped for the local source runtime; build and tenant acceptance preflight did execute. This change therefore does not claim complete Strict, performance, governance, shared staging or production acceptance. CI variables, real environments, feature flags and branch protections are unchanged. No merge or deployment.
