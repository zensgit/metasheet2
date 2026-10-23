# Meta6516 canonical database CI repair closeout

Source: `238ccdc15d414911963d53bcf0a936c5c0d190d3` (six paths). Parent: `469bd5c8c09bfd589937d84d5095c5c644c6f61d`. This document is the single separate closeout commit for this source cut. Prior SOURCE92f2cfe/ONE469 evidence remains unchanged. PR [6516](https://github.com/zensgit/metasheet2/pull/6516) stays Draft.

The migration accepts canonical meta_views without a nonexistent deleted_at column while preserving bound-view DELETE/id/sheet guards. It requires serving-schema operation foreign keys with the canonical relation/column pair, validated deferred semantics, MATCH SIMPLE and NO ACTION. The isolated W23 bootstrap restores only its own missing keys after the unchanged historical bootstrap, and tests check exact owned rollback IDs. The existing disposable PostgreSQL helper explicitly initializes UTF8 under locale C and verifies actual server encoding after start and restart.

Grok4.7(xhigh) implemented the bounded source changes. Codex independently reviewed the diff and reproduced the canonical-view and foreign-constraint-name failures, then found and reproduced three incorrectly admitted FK shapes. The final source passes those bounded counterexamples. No alternative manager, action, grant, Adapter or authentication change was introduced.

## Validation

| Execution | Result |
| --- | --- |
| Changed helper's existing real self-check | PASS, fresh UTF8 before/after restart and existing refusal/cleanup controls |
| Previously local-harness-failed outage node | 1 PASS / 79 unselected; actual owned postmaster PID changed |
| Renewal suite previously blocked beforeAll | 29 PASS / 0 skipped, existing deadlines |
| Failed/changed/new W23 nodes | 4 PASS / 13 unselected; one node includes four fresh predecessor-shape subcases |
| Independent canonical-view and foreign-name controls | 2 PASS / 0 skipped |
| Independent malformed FK control | 1 PASS / 0 skipped, three malformed definitions refused before publication |

These are separate executions, not a single complete 17-test or 133-test run. Previously passed cohorts were not repeated. Strict managed counts 197/61/133/222 and historical migration bytes remain unchanged.

Root DB evidence: `/Users/chouhua/.codex/worktrees/plm-listener-review-20261015/Yuantus/artifacts/plm-listener-review-20261015/private-acceptance-evidence-20261020/meta6516-canonical-db-ci-root-green-and-cleanup-20261024`; manifest `b429b93e975305baac54bf31e1a4bc73adae0ef7e015938c4fe17eb54f937f81`. The separate helper/managed packet manifest is `db3b5af0a9298fafd71bab37672837772617b07d5a39928b12099f11769a2a57`. Original RED manifests `864fa6fe00ae7759f4bd1be5df4c86953c2980f969657f2f06ac9af2e0053e20` and `e029c8f1317580a83d80769b914bf668fa833a6954f6544a65a5ebce0cdaf855` are retained.

Root nonce471901d1f994f3fc: no fixture-schema residue; the owned database was dropped and the fresh catalog restored to postgres/template0/template1. pg_ctl status3, former PID absent, no open files and owned directory removed were verified. Retained PostgreSQL/pgcrypto pins were unchanged.

## Remaining acceptance

At document creation the new head is not pushed and its CI has not run. Publication must recheck the exact Draft head and necessary checks. Prior generic-job server encoding remains UNKNOWN; no blanket classification of all35 prior failed jobs is made. Docker/MinIO recovery, installed runtime, persistent ECO/readiness APIs/UI, real browser/hour/business acceptance and the entire master goal remain open. No merge, deployment, production enablement, business notification or issue closure.
