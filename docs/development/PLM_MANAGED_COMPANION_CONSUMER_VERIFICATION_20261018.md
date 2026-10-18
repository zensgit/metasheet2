# PLM managed companion consumer verification (2026-10-18)

Branch `codex/plm-managed-companion-consumer-20261018` at parent `9c5fb4c56b9b41df585748db3dd85cbf3f89f0ed`. Nothing in this slice is committed, pushed, or published. Native checkout `/tmp/codex-plm-managed-browser-entry-20261017` HEAD is `a7ee408f532b13410563ff9429b2cdafb4408250` and was not edited.

Product, auth, router, and browser source blobs remain exactly the accepted `aff4197b3fb8440a9a7b81d13712c4c7b52552a3` protocol. Main normal-merged its accepted three fixture-only files plus docs recovery through the audit, read, login, and browser branches, avoiding a repeat of the 90-minute child CI. The src diff from that protocol is three disposable fixture files. Parent 349 exactaef contracts 1 and 2 are 1172 PASS, 0 skip, 2330.92s. This is not full native remote CI completion. The paired browser command was rerun after the lifecycle fix. The native tree was not edited.

## Commands and results

Backend unit tests, `DATABASE_URL` unset:

`pnpm exec vitest run --watch=false tests/unit/plm-managed-companion-refute.test.ts tests/unit/plm-managed-adapter-refute.test.ts tests/unit/plm-managed-companion.test.ts`

Exit 0. 21 passed across the classifier refute, the adapter refute, and the original unit file. The classifier refute covers flag `false` and a removed flag for `42P01` and `ECONNREFUSED`: both refuse before the shared-credential sentinel. A missing `DATABASE_URL` refuses with `PLM_MANAGED_BINDING_UNAVAILABLE` and does not query. A successful empty binding query still runs the legacy sentinel. The adapter refute is 7 passed. An already connected shared client does not run inherited `select`, `insert`, `update`, `delete`, `tableExists`, `download`, `testConnection`, or `getSchema` after the source is bound, including when the flag is `false` or removed and when classification is `schema-missing` or `unavailable`. Mock `getProducts` and discussion exchange do not return data or call `fetch`. The same adapter first completes `select` and mock `getProducts` while the binding reader proves unbound, then refuses those calls with zero further client calls after the source becomes bound. Personal BOM write is not refused as shared transport. The original unit file is 8 passed, including the managed-purpose rejection before the trusted-user shortcut, shared-transport refusal with a no-call sentinel, a binding whose OAuth `client_origin` differs from the frozen PLM origin, and the missing-database-URL refusal.

Disposable PostgreSQL, socket cluster `/tmp/plm-managed-consumer-pg-b3`, both `DATABASE_URL` and `PLM_MANAGED_COMPANION_TEST_PG_URL` set to `postgresql://plm_test@localhost/plm_managed?host=/tmp/plm-managed-consumer-pg-b3/s&port=5432`. The command is `node node_modules/vitest/vitest.mjs run --watch=false --config vitest.plm-managed-companion.config.ts` from `packages/core-backend`.

RED, before the password and tenant fix, log `/tmp/managed-password-tenant-red.log`. Exit 1. 4 failed, 14 passed. `POST /api/auth/password/change` with a managed must-change bearer returned 200. `POST /api/plm/managed-login/links` stored native tenant id `default` as the Meta tenant while the session tenant was a different membership. Strict verify accepted a persisted Meta tenant that had no `user_orgs` row. After `tenant_id` changed on the same owner and origin, start still returned a navigation URL. The normal must-change token control passed in that same run.

GREEN, same command, log `/tmp/managed-password-tenant-green.log`. Exit 0. 18 passed. The managed password route now returns `403 MANAGED_SESSION_REISSUE_REJECTED` with the password hash, `must_change_password`, and `user_sessions` unchanged. The normal must-change token still changes the password and inserts one ordinary purpose-less session. Provision refuses a native id, a tenant without membership, and a membership that is not the authenticated tenant, and persists only the validated pair. Strict verify returns null for a stored tenant without that membership. Moving persistent `tenant_id`, `workspace_id`, or `scope_kind` returns `PLM_MANAGED_SOURCE_CHANGED`, fails the existing managed token, and does not open shared transport. The earlier classifier, outage, provisioning, browser, unlink, and CAS cases remain in this 18.

Unit command after the same fix, `DATABASE_URL` unset, log `/tmp/managed-password-tenant-unit.log`. Exit 0. 21 passed. The binding fixture treats a changed persistent tenant, workspace, or scope as a fingerprint mismatch. The two transport refutations stay green.

Lifecycle follow-up, socket cluster `/tmp/plm-managed-consumer-pg-b4`, both URLs set to `postgresql://plm_test@localhost/plm_managed?host=/tmp/plm-managed-consumer-pg-b4/s&port=5432`. Same vitest command.

RED, before the cookie, generation, in-flight, and public-retry fix, log `/tmp/managed-lifecycle-red.log`. Exit 1. 7 failed, 18 passed. A callback carrying another person's managed session cookie returned 302. An ordinary bearer for tenant `meta-org` plus a managed cookie for tenant `meta-tenant` relayed `kind: ok`. After unlink, an admin rebind of native person `900` returned `PLM_MANAGED_BINDING_REFUSED` instead of `PLM_MANAGED_REBIND_OWNER_REQUIRED`, and the owner's rebind of that person did not reach the next source generation. The same refusal happened after transfer. Two concurrent rebinds of different native people both failed, so neither took the next generation. Unlink during a held exchange returned `acked`. `POST /revoke-retry` with only `{ dataSourceId }` returned 400. The earlier password, tenant, fingerprint, classifier, and adapter cases stayed in the 18.

GREEN, same command, log `/tmp/managed-lifecycle-green.log`. Exit 0. 25 passed. The other person's cookie now returns `409 PLM_MANAGED_PERSON_CONFLICT` before exchange, leaves that session cookie in place, and still lets the same person and an invalid cookie complete. The mismatched bearer tenant is `PLM_MANAGED_SESSION_REQUIRED`. The matching tenant relays `kind: ok`. A different native person after unlink or transfer receives the next source generation. The old link row stays immutable. One of two concurrent rebinds wins. Admin rebind of a stopped source is `PLM_MANAGED_REBIND_OWNER_REQUIRED`. Unlink during exchange stays `pending`, including `GET /session`, through a failed native revoke, and a `{ dataSourceId }` retry reaches `acked` with no outbox id in the response. `{ outboxId }` and `registration_mismatch` stay as before.

Unit command after that fix, `DATABASE_URL` unset, log `/tmp/managed-lifecycle-unit.log`. Exit 0. 21 passed. Both transport refutations stay green.

Web specs, from `apps/web`, log `/tmp/managed-lifecycle-web.log`:

`node node_modules/vitest/vitest.mjs run --watch=false tests/plmManagedCompanion.spec.ts tests/PlmManagedCompanionView.spec.ts tests/PlmBomReviewWorkspaceView.spec.ts`

Exit 0. 13 passed (1 client, 2 managed view, 10 existing BOM workspace). These specs do not drive the new cookie or retry routes. The paired browser run below does.

Flag manifest:

`node scripts/ops/global-history-flag-manifest.test.mjs`

Exit 0. 50 passed.

Backend `tsc --noEmit`: exit 0.

Web `vue-tsc -b`: exit 2. The only diagnostic is `apps/web/vite.config.ts(28,29) TS2769`, a Vite 5 versus Vite 7 plugin `apply` clash through the linked read-only `node_modules`. No diagnostic names the managed companion SFC or client. `vite.config.ts` and `node_modules` were not edited. The verification-approval and stock-prep type-check projects were not run.

## Paired native and Meta browser

```
/Users/chouhua/.codex/tmp/yuantus-bom-ui-20261015/bin/python scripts/verification/plm-managed-companion-paired/verify.py \
  --meta-checkout /private/tmp/codex-plm-managed-companion-consumer-20261018 \
  --native-checkout /tmp/codex-plm-managed-browser-entry-20261017 \
  --python /Users/chouhua/.codex/tmp/yuantus-bom-ui-20261015/bin/python \
  --node /Users/chouhua/.nvm/versions/node/v20.20.2/bin/node \
  --pg-bin /opt/homebrew/opt/postgresql@15/bin \
  --browser-cache /Users/chouhua/Library/Caches/ms-playwright \
  --output /tmp/plm-managed-paired-proof-lifecycle.json
```

Exit 0. Log `/tmp/managed-lifecycle-paired.log`. Proof file `/tmp/plm-managed-paired-proof-lifecycle.json`. The harness now passes `authenticatedTenantId` `meta-org` and stores that same Meta tenant, matching the browser JWT tenant. Native ids stay `default` and `fixture-org`.

- Meta: `ok` true, handshakes 2, BOM line `line`, write PATCH 200, 2 Meta audit rows, native logout 204, transfer `acked`, rebind generation 2, revoke outage `pending-then-acked`, late-callback open sessions 0, 3 callback URLs observed.
- Native: 1 write audit, subject `[42]`, line `line`.

Product, auth, router, and browser blobs are unchanged from `aff4197b3fb8440a9a7b81d13712c4c7b52552a3`. The earlier proof file `/tmp/plm-managed-paired-proof.json` was left in place. This rerun is not full native remote CI.

The browser path is Meta-first start, native password login, native Continue, callback to the existing Meta owner, and a BOM row rendered from the native managed-context fetch. Personal write uses the native `/personal-approval-grants#bom-write` page and the existing Meta bind and quantity controls. The shared adapter config points at `https://stale-native.invalid` with `shared-must-not-be-used`. The persisted source origin is the native HTTPS base. Native logout, owner transfer, rebind, SIGSTOP during unlink, retry until ACK, and a late callback are in the same run.

Node fetch verifies the local test certificate through `NODE_EXTRA_CA_CERTS`. The script asserts `NODE_TLS_REJECT_UNAUTHORIZED` is not `0`. Playwright uses `ignoreHTTPSErrors` only so Chromium can open that same local certificate. The personal-write `target_origin` check requires `https://`, so the native listener is HTTP behind a local TLS proxy.

## Harness cleanup, owned socket runner, and CI wiring

Product, auth, router, migration, and dependency files were not edited in this follow-up. The outage test still classifies the source as bound before the stop, `unavailable` with `PLM_MANAGED_BINDING_UNAVAILABLE` and sentinel 0 while the postmaster is down, and bound again after restart.

Paired cleanup rerun:

```
/Users/chouhua/.codex/tmp/yuantus-bom-ui-20261015/bin/python scripts/verification/plm-managed-companion-paired/verify.py \
  --meta-checkout /private/tmp/codex-plm-managed-companion-consumer-20261018 \
  --native-checkout /tmp/codex-plm-managed-browser-entry-20261017 \
  --python /Users/chouhua/.codex/tmp/yuantus-bom-ui-20261015/bin/python \
  --node /Users/chouhua/.nvm/versions/node/v20.20.2/bin/node \
  --pg-bin /opt/homebrew/opt/postgresql@15/bin \
  --browser-cache /Users/chouhua/Library/Caches/ms-playwright \
  --output /tmp/plm-managed-paired-proof-cleanup.json
```

Exit 0. Proof `/tmp/plm-managed-paired-proof-cleanup.json` has `ok` true. Meta: handshakes 2, BOM line `line`, write PATCH 200, 2 Meta audit rows, native logout 204, transfer `acked`, rebind generation 2, revoke outage `pending-then-acked`, late-callback open sessions 0, 3 callback URLs. Native: 1 write audit, subject `[42]`, line `line`. The public retry is `GET /session?dataSourceId=source-1` (`pendingRevoke` true) and `POST /revoke-retry` with `{ dataSourceId: "source-1" }`. The harness does not look up an outbox id. Node `CLEANUP_PROOF` is `ok` true with `failures` `[]`. Verifier cleanup is `postgresStopped` true, `directoryRemoved` true, `markerMatched` true, `nativeChildStopped` true, `proxyClosed` true, `failures` `[]`. The marker-owned directory `/tmp/plm-managed-paired-x9haxs5g` was removed after `pg_ctl status` showed the postmaster stopped. A cleanup timeout exits 1. The earlier proof `/tmp/plm-managed-paired-proof-lifecycle.json` was left in place.

Owned socket runner self-check:

```
PG_BIN=/opt/homebrew/opt/postgresql@15/bin LC_ALL=C LANG=C \
  node scripts/verification/plm-managed-companion-pg/owned-socket.mjs self-check
```

Exit 0. Nonce `02d4b6096c257ed8`. `locale` `C`, `selectAfterRestart` true, `wrongNonceRefused` true, `decoyPreserved` true, `directoryRemoved` true, `postgresStopped` true. `initdb`, `pg_ctl`, `createdb`, and `psql` run with `LC_ALL=C` and `LANG=C`. Stop and boot check the nonce, the marker, `data`, and the socket before acting. Cleanup removes the directory only after status proves the postmaster is stopped. The retained log `/tmp/managed-consumer-main-pg-locale-failure.log` still records Main's `FATAL: postmaster became multithreaded` from a restart without `LC_ALL`. This run did not delete that log and did not treat an outage as unbound.

PostgreSQL suite on a runner-created cluster, both URLs set to `postgresql://plm_test@localhost/plm_managed?host=/tmp/plm-managed-consumer-pg-531ad9d9dac4b780/s&port=5432`. From `packages/core-backend`:

`node node_modules/vitest/vitest.mjs run --watch=false --config vitest.plm-managed-companion.config.ts --reporter=json --outputFile=/tmp/plm-managed-pg-runner.json`

Exit 0. 25 passed. `scripts/verification/plm-managed-companion-ci/assert-report.mjs` accepted the report only because failed, pending, and todo were 0 and passed equaled total equaled 25. Cleanup proof `/tmp/plm-managed-pg-runner-cleanup.json`: `directoryRemoved` true, `postgresStopped` true, `markerMatched` true. The directory is gone.

Unit rerun, `DATABASE_URL` unset, same three files, JSON `/tmp/plm-managed-unit-runner.json`. Exit 0. 21 passed. The same assert script required exactly 21. Web specs, backend `tsc`, and `vue-tsc --noEmit -p tsconfig.app.json` were not re-run; those sources were not edited. `vue-tsc -b` remains outside this gate because of the existing `apps/web/vite.config.ts` TS2769.

CI wiring is `.github/workflows/plm-managed-companion-consumer.yml`, job `managed-companion-consumer`. `pull_request` has no base-branch filter and no path filter, so a stacked draft whose base is `codex/plm-customer-bom-entry-20261017` runs it. Pushes remain limited to `main` and `develop`. `cancel-in-progress` is false. It uses the existing Node 20 and pnpm 10.16.1 setup, installs PostgreSQL 16, and sets `PG_BIN=/usr/lib/postgresql/16/bin`. The job runs the runner self-check, the three unit/refute files, the owned-socket PostgreSQL file, the three web specs, `tsc --noEmit`, and `vue-tsc --noEmit -p tsconfig.app.json`. The PostgreSQL assert expects 27, the unit assert expects 21, and the web assert expects 13. A missing binary, a missing socket DSN, a skip, or a zero-test run fails the job. The web-tests job and the personal-approval TCP PostgreSQL job do not run these files and do not stand in for this one. GitHub Actions did not execute this workflow in this session.

## Native cleanup bound and exact revoke intent

RED on owned-socket nonce `d8b5d25ce88bbf31`, log `/tmp/managed-lifecycle-bound-red.log`. Exit 1. 2 failed and 25 passed. `stays pending after browser expiry while a held exchange can still mint a native grant` received `acked` where the case required `pending`. That row's browser `expires_at` was already before PostgreSQL `clock_timestamp()`, and `consumed_at` plus 608 seconds was still later. `acks only the intent that produced the revoke when two held exchanges finish newer first` found `del-b` on the older consumed intent. The case required that older delegation to stay null. The fixture clock was stored and restored, and the intent immutability trigger still rejected a `code_challenge` update. Product SQL still compared browser `expires_at` with `now()` and stamped the oldest null consumed intent.

GREEN on the same cluster, log `/tmp/managed-lifecycle-bound-green.log`, JSON `/tmp/plm-managed-lifecycle-bound-green.json`. Exit 0. `scripts/verification/plm-managed-companion-ci/assert-report.mjs` accepted the report because failed, pending, and todo were 0 and passed equaled total equaled 27. The short-lived held exchange stays `pending` after browser expiry and at `consumed_at` plus 601 seconds, then reaches `acked` at `consumed_at` plus 609 seconds with a null delegation and no outbox row. The newer failed revoke is acknowledged onto the newer intent as `del-b`. The older failed revoke stays pending, and its own acknowledgement stamps `del-a` only on the older intent.

Unit rerun with both PostgreSQL URLs unset, JSON `/tmp/plm-managed-lifecycle-bound-unit.json`, log `/tmp/managed-lifecycle-bound-unit.log`. Exit 0. The same assert script required exactly 21. The fixture-clock refusal sits in the existing hook test.

Cleanup proof `/tmp/plm-managed-lifecycle-bound-cleanup.json`: `directoryRemoved` true, `postgresStopped` true, `postgresRunning` false, `markerMatched` true, `locale` `C`. The directory `/tmp/plm-managed-consumer-pg-d8b5d25ce88bbf31` is gone.

The workflow now requires 27 PostgreSQL tests and still requires 21 unit tests and 13 web tests. GitHub Actions did not execute it. Full B2 is not accepted. This repair is not committed or pushed.

## Runner status proof and stacked pull-request trigger

The consumer workflow `pull_request` trigger no longer lists `branches: [main, develop]`. A pull request into `codex/plm-customer-bom-entry-20261017` matches it. `cancel-in-progress` is false. The owned-socket runner treats `pg_ctl status` exit 0 as running and exit 3 as the only proof that the postmaster is stopped. Exit 1, exit 4, a signal, a timeout, and a spawn error fail the command and leave the owned directory in place.

Self-check log `/tmp/plm-managed-socket-status-self-check.json`. Exit 0. Nonce `c1414e9c495fd885`. `locale` `C`, `selectAfterRestart` true, `wrongNonceRefused` true, `decoyPreserved` true, `status3ProvesStopped` true, `unexpectedStatusRetained` true, `directoryRemoved` true. The classifier rejects status 1, status 4, `SIGTERM`, and `ETIMEDOUT`. A real empty data directory, which this machine's `pg_ctl` reports as exit 4, made `cleanup` exit 1 and left the marker, data directory, and root in place until the self-check removed that fixture after the proof. The self-check directory is gone.

PostgreSQL suite after that runner change, nonce `9a38b5e0b1b42057`, JSON `/tmp/plm-managed-socket-status-pg.json`, log `/tmp/plm-managed-socket-status-pg.log`. Exit 0. `assert-report.mjs` accepted 27 passed, with failed, pending, and todo at 0. The count was not reduced to 25. Cleanup proof `/tmp/plm-managed-socket-status-pg-cleanup.json`: `directoryRemoved` true, `postgresStopped` true, `markerMatched` true, `locale` `C`. The directory `/tmp/plm-managed-consumer-pg-9a38b5e0b1b42057` is gone. GitHub Actions did not execute the workflow. Nothing in this correction is committed or pushed.

## Consumed intent stays pending without a time bound

The 608-second acknowledgement above is not a native deadline. `AbortSignal.timeout` of 8 seconds aborts only the local fetch. Native `exchange_code` locks the parent and only then samples `now_epoch`, and it accepts a code whose `code_expires_at` is still later than that locked time. A code can therefore be minted about 100 seconds after Meta consume and the credential can remain valid until about 700 seconds after consume. The earlier expectation of `acked` at `consumed_at` plus 609 seconds, with a null delegation and no outbox row, was a false acknowledgement.

RED on owned-socket nonce `d012669653cc56cb`, log `/tmp/managed-lifecycle-no-time-ack-red.log`, JSON `/tmp/plm-managed-no-time-ack-red.json`. Exit 1. 1 failed and 26 passed. `stays pending after browser expiry while a held exchange can still mint a native grant` failed with `held exchange past a delayed native grant stays pending: expected 'acked' to be 'pending'`. The exchange was still held. Browser `expires_at` was already past, and the case still required `pending` through `consumed_at` plus 601 seconds. `consumed_at` was then moved 100 years before PostgreSQL `clock_timestamp()`, so `consumed_at` plus 608 seconds, plus 700 seconds, and plus 2147483647 seconds were all already past. Delegation was null. Product SQL still treated the 608-second comparison as cleanup and acknowledged the source retry with no outbox row.

GREEN on the same cluster, log `/tmp/managed-lifecycle-no-time-ack-green.log`, JSON `/tmp/plm-managed-no-time-ack-green.json`. Exit 0. `assert-report.mjs` accepted 27 passed, with failed, pending, and todo at 0. The count stayed 27. The held exchange stays `pending` after browser expiry, at `consumed_at` plus 601 seconds, and after `consumed_at` is 100 years before `clock_timestamp()`. `pendingRevoke` stays true, the delegation stays null, and the outbox stays empty. An observed native acknowledgement still stamps only the stored intent id. A still-pending intent cancelled before exchange still acknowledges with no outbox row. The intent immutability trigger still rejects a `code_challenge` update.

Unit rerun with both PostgreSQL URLs unset, JSON `/tmp/plm-managed-no-time-ack-unit.json`, log `/tmp/managed-lifecycle-no-time-ack-unit.log`. Exit 0. The assert script required exactly 21. The fixture-clock setter still refuses when the test gate is off and when `NODE_ENV` is production. Cleanup does not read that clock.

Cleanup proof `/tmp/plm-managed-no-time-ack-cleanup.json`: `directoryRemoved` true, `postgresStopped` true, `postgresRunning` false, `markerMatched` true, `locale` `C`. The directory `/tmp/plm-managed-consumer-pg-d012669653cc56cb` is gone. GitHub Actions did not execute the workflow. Full B2 is not accepted. This repair is not committed or pushed.

## Legacy unit fixtures prove an empty binding query

Main's unchanged personal-approval unit selection, with `DATABASE_URL` and the managed flags unset, was 318 passed, 76 failed, and 0 skipped. Log `/tmp/managed-consumer-main-legacy-unit.log`, JSON `/tmp/managed-consumer-main-legacy-unit.json`. The 76 failures were ordinary adapter, workbench, and personal-write tests receiving `Managed companion request refused` or HTTP 403 `PLM_MANAGED_BINDING_UNAVAILABLE` before the handler they meant to exercise. `classifyManagedSource` returns unavailable without querying when `DATABASE_URL` is missing. That guard stayed. The classifier was not changed, flag-off shared fallback was not restored, and no test installs a reader that returns unbound.

The six failing files now set a synthetic `DATABASE_URL` and answer `FROM plm_managed_source_bindings` with zero rows. The same double records that call and checks `WHERE b.data_source_id = $1` plus the source id (`plm`, `ds-1`, or `ds-probe`). Audit-down tests reject only the later statement. Outcome-lost tests let the attempt audit succeed and then fail the outcome audit. A rejected tenant claim still returns `PLM_BOM_WRITE_FORBIDDEN` with dispatch and legacy list uncalled; its query assertion now requires that the only statement was the empty binding select. Paths that return 401 or 404 before classification do not require a query.

Focused rerun with both PostgreSQL URLs and the managed flags unset: JSON `/tmp/managed-consumer-legacy-fixture.json`, log `/tmp/managed-consumer-legacy-fixture.log`. Exit 0. The six files passed 111, and `plm-managed-companion-refute.test.ts`, `plm-managed-adapter-refute.test.ts`, and `plm-managed-companion.test.ts` passed 21. Failed, pending, and skipped were 0. The other 16 files in the 394 selection were not rerun. The whole 394 selection is not claimed green. Original business assertions in those six files stay, including `PLM_BOM_WRITE_FORBIDDEN`, dispatch not called, and legacy list not called. The rejected-claim case proves the only statement was the empty binding select.

Main's unchanged legacy web selection of the same 12 files exited 0. JSON `/tmp/managed-consumer-main-legacy-web.json` reports `success: true`, 12 files, 156 passed, 0 failed, 0 pending. The log records only that the JSON report was written. No web source was edited for that run. The count extends the historical 138 to 156 on the C1 parent. That web selection is not repeated until a relevant web edit. Full B2 is not accepted. This fixture repair is not committed or pushed.

## Paired postgres status must be proved before removal

`scripts/verification/plm-managed-companion-paired/verify.py` used `pg_ctl status` exit 0 as running and every other result as stopped. A missing data directory was also treated as stopped after `started` was true, and the owned directory could then be removed. The classifier now matches the owned-socket runner. Exit 0 is running. Exit 3 is the only stopped proof. Exit 1, exit 4, a negative status, a signal, a timeout, and a spawn that does not finish fail the cleanup and keep the directory. A symlink is not followed. Missing or symlink data after start does not prove that no postmaster is live. A data directory that was never created, before start, is still removable with the rest of the owned temp directory.

The negative proof does not start a cluster and does not rerun the paired harness. Command: `python3 scripts/verification/plm-managed-companion-paired/verify.py --self-check`. Exit 0. JSON `/tmp/plm-managed-paired-status-self-check.json`. `startedCluster` is false. `status0Running`, `status3ProvesStopped`, `unexpectedStatusRetained`, `missingAfterStartRetained`, `symlinkRetained`, `timeoutRetained`, and `signalRetained` are true. The self-check removed only its own never-started fixture after those checks, nonce `20488819c8a6fa66`, directory `/tmp/plm-managed-paired-status-20488819c8a6fa66-5pddj153`. That directory is gone. The native tree was not modified. Full B2 is not accepted. This change is not committed or pushed.

## Limitations

- Installed customer topology and entire-window acceptance are later C3 work.
- Lost exchange response and database commit failure are proved in the disposable PostgreSQL suite, not in the browser script.
- The disposable PostgreSQL clusters `b2`, `b3`, and `b4` were already removed. The runner clusters `531ad9d9dac4b780`, `d8b5d25ce88bbf31`, `c1414e9c495fd885`, `9a38b5e0b1b42057`, and `d012669653cc56cb`, and the paired directory `plm-managed-paired-x9haxs5g`, were removed after status proved their postmasters stopped. Older directories that do not carry this run's marker were not deleted, including `/tmp/plm-managed-consumer-pg-main-shuubiq9`.
- The new workflow file has not run on GitHub Actions. Main still repeats the paired harness and the owned socket runner before any commit.
- Parent 349 exactaef contracts 1 and 2 at 1172 PASS, 0 skip, 2330.92s are not full native remote CI completion.
- Nothing in this slice is committed, pushed, merged, deployed, or published.


## Independent Codex closeout for the B2 source slice

After the final lifecycle, cleanup, and compatibility fixture corrections, Codex ran the original workflow backend selection together with the managed refutations: **415 passed, zero failures/pending/skips across 25 files** (394 existing cases plus 21 managed cases). Source hashes remained stable. The earlier 318/76 result remains above as the reproduced compatibility failure; explicit successful empty-binding query fixtures repaired it without changing the fail-closed classifier or the original business assertions.

Codex independently ran the portable owned-socket runner self-check and all **27 PostgreSQL cases**, zero failures/pending/skips, on PostgreSQL 15. The marker/nonce matched, restart and wrong-nonce/unknown-status controls passed, the postmaster was proven stopped, and the owned directory was removed. This is local PG15 evidence; the dedicated remote PG16 job is pending. The old 608-second assumption is rejected: unresolved consumed exchanges remain pending until the exact native delegation acknowledgement, regardless of browser expiry or client abort.

The actual paired Chromium/Meta/PostgreSQL/native-process run passed: two handshakes, actual BOM read, personal line PATCH 200, two Meta audit rows, native audit subject42, native logout204, transfer acknowledged, rebind generation2, revoke outage pending then acknowledged, and zero late-callback open sessions. Both Node and verifier cleanup proofs succeeded; the native child stopped and the owned directory was removed. Backend source types and workflow actionlint passed. The prior independent 156-case legacy web and 13-case managed web checks remain applicable because those sources did not change; the overlapping customer-view cases are not added together. The prior app/approval/stock-prep type checks remain separate from the full build's existing Vite configuration incompatibility.

Compact evidence: `artifacts/plm-managed-companion-consumer-20261018/verification.json`. This accepts the local **existing Meta owner bind/read consumer slice** only. It does not establish pure Yuantus entry without a Meta login, full application bootstrap, installed topology, remote CI, or the entire master goal. A lost exchange with no observed delegation remains visibly pending; elapsed time does not fabricate an ACK. All publication stays Draft and exact-head CI must still run.
