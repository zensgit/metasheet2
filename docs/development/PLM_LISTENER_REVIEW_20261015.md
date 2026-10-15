# PLM durable listener: design and verification (2026-10-15)

## Scope and authority

This paired backend change delivers owner-authorized BOM sharing, configurable review/completion events, durable source consumption and delivery. It does not include the remaining full-window UI, personal approval grants, visual review or record projection ingress. The original dirty development checkouts are preserved; these publication branches start from main.

Only the current active PLM data-source owner with native sheet-management permission can explicitly enable or rebind a listener. Sheet administrators cannot borrow source credentials. The source independently checks the normal authenticated Yuantus session, tenant/org and object access. Snapshot sharing checks every included part/version/relationship. Rule creator, row/field access and destination authority are checked again before delivery.

Enabling reads the current source sequence and persists it without historical replay. Listener generation, owner, source fingerprint, binding version, configuration revision and cursor are durable. Transfer, source edits/deletion and local revocation stop authorization; restored ownership does not restart it. A new owner must explicitly rebind. Remote revocation is observed on authenticated polling/delivery, not by a distributed instantaneous revocation transaction.

## Concurrency and delivery

Yuantus writes an occurrence and a tenant/org/part sequence counter in the same business transaction. Counter locking prevents a later committed sequence from overtaking an uncommitted lower sequence; rollback does not consume a sequence. BOM writeback and ECO apply are distinct business facts. ECO clears the previous current version with a flush before promoting the target, avoiding UUID-dependent unique-index ordering.

MetaSheet serializes listener progress against binding/generation/cursor. Inbox insertion, outbound-event trigger and cursor advancement share one PostgreSQL transaction. Replayed identical facts are idempotent; conflicting facts and malformed/gapped feeds cannot advance progress. Durable delivery retains event identity, rechecks authority and uses HMAC; external receivers must deduplicate because a crash after HTTP acceptance can cause a retry.

This review found a re-enable race: the prior listener could advance while the replacement baseline request awaited HTTP. Comparing only generation allowed resetting progress. Re-enable now compares the observed generation, cursor and status before replacement. A deterministic paused-baseline test lets the old poll finish first and verifies replacement fails without losing its generation or accepted fact. Separate negative coverage gives a non-owner sheet admin full sheet authority and still rejects listener startup before network access.

## Verification on isolated publication branches

- Yuantus source/authentication/wire/share tests: **84 passed** (Python 3.11).
- Yuantus PostgreSQL 16 atomicity, concurrent counter ordering and migration downgrade protection: **2 passed**.
- Fresh PostgreSQL 16 default, tenant and identity chains reach `plm_change_sequence_008`, `t17_plm_change_sequence`, `i9b0c1d2e3f4`. Tenant invocation explicitly uses `-x target_schema=yt_t_listener -x create_schema=true`; an initial missing-parameter attempt failed as expected before migration.
- MetaSheet real PostgreSQL suite with separate real Yuantus provider: **125 passed**, including both BOM-line and ECO listeners, baseline/no-history, restart, duplicate polling, rollback, transfer/rebind, source revocation, native row/field restrictions and signed delivery to a loopback fixture. Provider uses real auth/service transactions and synthetic isolated databases; no remote business system receives messages.
- MetaSheet focused wire/transport/login/worker tests: **55 passed**; subscription/idempotency/shutdown tests: **31 passed**; provider/runtime/wire tests: **25 passed**. These are separate test groups, not an asserted unique aggregate.
- MetaSheet TypeScript `tsc --noEmit`: passed. Global-history flag manifest: **47 passed**.
- Real `MetaSheetServer` entrypoint with fresh full migrations, PostgreSQL 16 and Redis 7: worker and HTTP endpoint start; stop drains worker, closes HTTP, preserves Redis replay state, leaves no referenced timers/sockets. Initial boot/shutdown rehearsal exposed main's missing singleton cleanup; lifecycle fixes and regressions are included. Plugin directories are empty, so this is core-server verification rather than production plugin acceptance.

The cross-process runner records before/after source hashes and verifies stability, closes its provider port and removes disposable credentials/databases. Application Docker containers are removed. Local logs remain in `artifacts/plm-listener-review-20261015/`; only compact evidence is versioned. Remote CI is tracked by exact PR head separately; local success is not a CI or production claim.

## Operation and boundaries

Both sides remain opt-in. Yuantus requires `YUANTUS_ENABLE_METASHEET=true` and `YUANTUS_PLM_CHANGE_EVENTS_ENABLED=true`. MetaSheet requires the existing PLM product/provider configuration plus `PLM_BOM_REVIEW_ENABLED=true`, `MULTITABLE_ENABLE_WRITER_FENCE=true` and `AUTOMATION_DURABLE_DELIVERY_ENABLED=true`. Configure the destination/rule, then have the source owner explicitly start the listener. No production configuration is changed by this work.

Do not downgrade evidence-bearing migrations: their guards preserve audit/receipt history. No merge, deployment, native AutoCAD revalidation or complete full-window business acceptance is claimed. This source baseline has normal JWT authentication; unpublished PAT/personal-grant issuance is not pulled into this change.

Publication base for this repository: `ad2246fecd7af5227f8f4a68ee5c8ba8512e212c`.

## Reproduction

From `packages/core-backend`, run the workflow unit list and `node node_modules/vitest/vitest.mjs run --config vitest.plm-bom-review.config.ts` with a disposable `DATABASE_URL` and `EXPECT_DB=1`. The standalone DB suite has 124 tests; only the paired Yuantus runner registers the 125th cross-process test. From the repository root, `python3 scripts/plm-listener/run-pg.py RUN_NAME` provisions a private local cluster; `python3 scripts/plm-listener/run-app.py RUN_NAME` validates full core startup/shutdown using locally available Docker images `postgres:16` and `redis:7-alpine`. Set `NODE_BINARY` for Node 20 and optionally `PG_BIN` for PostgreSQL binaries.

## CI follow-up: native writer contracts

The broad CI writer census identified the new snapshot writer. It now uses the common `ensureRecordNotLocked` rule: an unrelated lock rejects the refresh and rolls back all changes; the record owner or locker can write under the existing native policy. PostgreSQL regression covers rejection, rollback and both permitted cases. The snapshot writer emits revisions in the same transaction and writes only fixed source `string` fields whose types are protected by the existing BOM field trigger; local rich-text fields are not patched. Its fence/call-site dispositions are explicitly recorded, without excluding it from scans.

When BOM review is disabled, server route setup no longer obtains its pool. Route tests use the repository's pinned HTTP listener. The standalone real-DB suite is excluded only from the no-database test configuration and remains mandatory as a whole file in its dedicated PostgreSQL CI.

Follow-up local verification: 125 standalone PostgreSQL tests; 126 paired cross-process tests; full core application startup/shutdown with fresh PostgreSQL/Redis passed again; TypeScript passed. Eight broad guard/wiring suites passed, with the HTTP tripwire subsequently repaired and rerun together with route tests (13 passed). Remote CI on the new commit remains pending.


## Source/account authority ABA correction

A source owner changing A→B→A during the asynchronous baseline request could previously satisfy the final current-value comparison. The same gap existed for account disable→enable. New per-source and per-account UUID authority versions are rotated by database triggers on actual authority changes. Enable/rebind compares the before/after versions; a missing migration fails closed. Account disable immediately stops active listeners and reactivation does not resume them. Cosmetic source name edits retain the version. Migration rollback refuses retained listener evidence and holds the relevant tables while checking.

The source ABA tests failed before the fix (2 selected failures); account ABA tests failed before its extension (3 selected failures). The final standalone PostgreSQL suite passes 131/0/0. The paired real-HTTP Yuantus / PostgreSQL consumer run passes 132/0/0, including lost acknowledgment after receiver acceptance, recovery in a new Node process with stable delivery identity, and stale-generation cancellation after rebind. The receiver is a loopback idempotent test fixture. Its lease is accelerated for testing; this does not prove elapsed real lease timing. TypeScript passes. The paired driver reports providerExit=0, private credentials/database removed, provider port closed, sourceStable=true.

This version fix covers source authority and local account activity transitions. It does not establish historical versioning for every role/field permission or transient remote Yuantus revocation; existing current-permission checks and the in-flight remote boundary still apply. Yuantus uses fixture SQLite business/identity data with actual HTTP authentication/services; the MetaSheet consumer uses private PostgreSQL 15. The local Yuantus interpreter has SQLAlchemy 2.0.51 rather than the application lock's 2.0.45. No production access or external customer webhook is exercised. Earlier CI greens cover the prior source only; this new source requires fresh exact-head CI.

## Final source CI

Source `d6cd2064d9800589d6a9fd8d79e9363b00b3aad6` now has 61 successful and one skipped checks. All 51 workflow runs returned by the exact-source query are completed successfully; the skipped check is not an executed test. The compact CI record preserves each run name, source SHA, conclusion and URL in `artifacts/plm-listener-review-20261015/ci-final-summary.json`.

- [PLM BOM listener](https://github.com/zensgit/metasheet2/actions/runs/38700362127) — success.

This document records the verified source. Its subsequent documentation commit is checked separately in the PR; another commit is not needed merely to cite its own SHA. Keep Draft and retain the local/fixture, production, enterprise and long-term acceptance boundaries above. Current CI success does not qualify unrelated later UI slices or complete the recovered window.
