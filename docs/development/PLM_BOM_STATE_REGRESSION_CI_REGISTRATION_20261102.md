# PLM BOM State existing-lane registration - 2026-11-02

Source: `8b8a8e4712f07e98569e36aaf1192157470f7a03`  
Parent: `6cc752b200851f593c4ca63bc4e7418d3b867713`  
Branch: `codex/plm-bom-state-regression-ci-registration-20261102`

The existing PLM personal lane's UI command omitted usePlmBomState.spec.ts.
The generic plugin-tests pull-request base filter targets main/develop and
therefore does not supply coverage for a child of the current codex/* Draft
stack. The new shared-assembly, applied-depth and zero-quantity regressions
belong in the existing lane, alongside its existing web tests.

Exactly three lines were added to plm-personal-approval-realdb.yml: the complete
spec path in each existing pull-request/push path list, and one whole-file
argument in the existing Personal binding settings UI Vitest command. Product
paths are already covered by apps/web/src/**. No test-name selector, new job,
command or framework was added. Inverse deletion of only these three lines
restores the complete 11623-byte original, SHA256:
`cd9d8c8c1d1fd2ff6f0d0737edb9a4263239cd79b41571e2c1990d54093bdadf`.

All other workflow bytes remain unchanged, including runner, install, PG,
retry, permissions, policy, gates, browser behavior, reporter and arguments.
This is a bounded registration gap, not a conclusion that the whole repository
has no other CI coverage.

Requested Grok model/effort: grok-4.7/medium. Literal CLI footer observed
Grok4.7/xhigh, backend deployment UNKNOWN; author-report actuals UNKNOWN remain
separate. Independent Sol requested gpt-6.1-sol/medium, actual UNKNOWN, accepted
with blockers[]. Root copied frozen author bytes without implementation edits.
Final five-member ZIP SHA256:
`1af40a8f980aea7e39f47f1e19313bd7496a786e1e4e3775714931729ccdb18f`.
Independent review SHA256:
`813a41b1db961df06e3859eb202cd169181702482d1430a5b465d0e7f7b1e85c`.

Static full-byte inverse, readonly/input/capsule checks and git diff --check
passed. YAML parsing, tests, types, lint, imports, build, install, HTTP/PG,
browser, product runtime and new CI: NOT_RUN. This increment and its preceding
new BOM fixes remain local-only. Prior Draft6686 CI qualifies its fixed5e3b2372
head only. The earlier publication/CI exception does not authorize this batch.

This source plus this single document consume the slice's commit scope; later
results belong in external records/state or a separately authorized PR body.
N2 lease, all HOLDs, browser boundaries and all seven OPEN packages remain.
No push, new PR, dispatch, merge, deployment, production enablement, real
notification or goal-panel change is authorized by this static delivery.
