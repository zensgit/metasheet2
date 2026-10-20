# Managed Discussion across independent Meta processes

Source `70cccf2d5971dd237e5b8b3a15dc51989a19688c` extends `917564f649436b15097a540f9f16abfc2ba2cabd` with actual process/concurrency verification. No backend product source, frontend, package manifest or dependency-lock bytes change. The previously qualified917 package therefore keeps its original source pin and receipts; this test extension does not initiate another package/source SHA cycle.

## Actual topology and assertions

The committed portable coordinator starts separate Native PostgreSQL stores, Meta PostgreSQL, Redis7.4.10 and a real Native API. The integration fixture starts **two additional independent Node20 Meta processes**, each mounting the actual global JWT middleware and managed router, with separate process state and shared production PostgreSQL/Redis. IPC ready messages are bound to each fork's actual PID. The accepted run used PIDs82003 and82025; each acknowledged shutdown and exited0. Both workers and Native/PG/Redis are stopped, and the successful owned directory is removed.

**All22 integration assertions pass, with no skips/todo**, preserving the prior19 identity/operation/expiry/source/foreign-root/unlink cases and adding:

1. Simultaneous writes through two actual Meta processes using one managed cookie and fresh Native embed token: exactly one200 and one401, exactly one Native exchange, one authored Native comment, then a fresh read through the losing worker returns that exact thread.
2. Simultaneous read/write through different Meta processes using one token: exactly one200 and one401 and one Native exchange; a newly minted token reads successfully afterward. Read authority is never converted into write authority.
3. A real unlink HTTP request in workerB waits on workerA's admitted Native write/PG lock. The Native write completes, unlink acknowledges, and new calls through both workers return401 without another Native exchange. A fresh independently delegated managed session succeeds through workerB, refuting a blanket-denial implementation.

The original19 assertions still include exact frozen revocation identity, live Native delegation revocation, active Meta user restoration using the unspent token, source drift, Native first-party foreign-root positives and all eight operations. Session fixtures use actual first-party Native authorize/exchange/status/revoke; the Meta session rows themselves are provisioned fixtures.

The coordinator now requires two distinct actual worker PIDs, stop acknowledgements, exit0, all22 individual test statuses, stable1438 source files and ten critical committed source hashes. It also verifies the Native API paths at executed head `293765ad2eea75d7a626c65fe243af2ea57b78ae` are identical to fixed API pin `f87e019b2f01ae97dca2b2a13aa426c269e31a6b`. The CI gate increases19→22, preserving process cleanup and source guards. Backend no-emit types and actionlint pass. Existing171 unit assertions are not rerun for this test-only extension.

## Failure and evidence

The first owned run passed21 assertions and failed only the new unlink fixture's wrong URL. The real route is POST `/api/plm/managed-login/unlink` with `dataSourceId`; correcting that fixture and draining its pending HTTP requests yields22 passes. This is not recorded as a product vulnerability. Failed raw evidence and stopped owned root are retained; no unknown volume/data/image is removed. A preliminary actionlint/read command used the wrong cwd and did not run; the corrected absolute-path actionlint invocation passed.

Compact receipt: `artifacts/plm-managed-discussion-processes-20261020/verification.json`. Detailed reports, individual assertion statuses, worker stop proof, source hashes and failure logs are in its private archive. The actual command is the existing `scripts/verification/plm-managed-discussion/verify.py` with explicit Native tree, Python3.11, Node20, PostgreSQL16 bin directory, pinned Redis binary/SHA and fresh output path. The second run is the accepted report; the first is preserved separately.

## Scope still open

This is two actual mounted middleware/router processes, not two complete Meta application deployments. It does not prove the Meta callback persistence path, managed Discussion browser/token broker, current-source Visual admission, signing-key configuration, installed Discussion, customer/production or long-term acceptance. The separate917 host-package71-check installation/disable/backup/upgrade recovery proof remains valid only within its documented scope. Full W01–W23 remains active.

Keep the source plus one closeout document commit local while #363 exact74fcf61's valuable perf job118040891880 remains queued. Publish dependencies serially afterward, require actual remote CI on each necessary exact head, and keep all PRs Draft. No merge/deploy/production enablement/business notification or gate weakening is performed.
