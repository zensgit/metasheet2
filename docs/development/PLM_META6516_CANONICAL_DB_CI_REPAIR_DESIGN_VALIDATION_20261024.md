# Canonical DB CI repair — 2026-10-24

Uncommitted local repair on `codex/plm-meta-integrated-window-20261024` in `/Users/chouhua/.codex/worktrees/plm-w23-meta-readonly-20261023/metasheet2`. Base and HEAD are `469bd5c8c09bfd589937d84d5095c5c644c6f61d` (published ONE of Draft #6516; prior SOURCE `92f2cfe`). Owner nonce `c3d4c317e0864f6999b182dc89b850a8`. No commit, push, rebase, merge, or notification. Root publishes SOURCE and ONE later. This note does not claim CI green, a whole-goal closeout, or an install.

Current Draft #6516 CI is 35 FAIL and 14 SUCCESS. This repair covers three proven causes only. The selected companion stop-case origin conflict is a local harness reuse of one database (`data_sources` `source-1` `ON CONFLICT DO NOTHING` against an earlier embed UPSERT). It is not a proven CI failure. Companion product, tests, and auth are unchanged. Root PostgreSQL nonce `471516ab0908eae7` stayed untouched: no start, stop, cleanup, connection, or test database.

## Allowlist

| Path | Role |
| --- | --- |
| `packages/core-backend/src/db/migrations/zzzz20261024010000_create_plm_collaboration_snapshots.ts` | Production preflight and the two `meta_views` guard sites |
| `packages/core-backend/tests/plm-collaboration-snapshot/bootstrap.ts` | Fixture `meta_views` and owned deferred foreign keys after shared bootstrap |
| `packages/core-backend/tests/integration/plm-collaboration-snapshot-db-guards.realdb.test.ts` | Canonical view statements, exact rollback ids, two focused controls |
| `scripts/verification/plm-managed-companion-pg/owned-socket.mjs` | `initdb` UTF8 and measured `server_encoding` |
| `docs/development/PLM_META6516_CANONICAL_DB_CI_REPAIR_DESIGN_VALIDATION_20261024.md` | This note |
| `artifacts/plm-meta6516-canonical-db-ci-repair-20261024/verification.json` | Thin pin record |

Closed docs, HOLD notes, the workflow, the old history migration, and the managed companion cohort are outside this list.

## Cause 1 — canonical `meta_views` has no `deleted_at`

Generic job `approval-attachment-roundtrip-guard` (run `40013793157`, job `120620555112`) failed `pnpm --filter @metasheet/core-backend db:migrate` on `zzzz20261024010000_create_plm_collaboration_snapshots` with SQLSTATE `23514`, message `plm_collaboration_predecessors_absent`, constraint `meta_plm_collaboration_predecessor_guard`, PL/pgSQL line 44. That job uses the `postgres:16` service image. Its workflow has no `initdb`, `createdb`, `LC_ALL`/`LANG`, or `POSTGRES_INITDB_ARGS`, and it does not call `owned-socket.mjs`. The selected log does not print `SHOW server_encoding`. Encoding of that job stays UNKNOWN. Line 44 is the column-count guard. The encoding guard is the earlier `server_encoding` check.

Root's separate UTF8 schema, with the canonical view and no `deleted_at`, raised the same `23514` at generated line 44 and created 0 `meta_plm_collaboration_%` relations (`/tmp/plm-meta6516-w23-root-two-utf8-red-20261024.json`, exit 1, 2 registered, 2 failed, nonce `471516ab0908eae7`). Canonical view columns in that capture are `id`, `sheet_id`, `name`, `type`, `filter_info`, `sort_info`, `group_info`, `hidden_field_ids`, `config`, `created_at`.

`REQUIRED_COLUMNS` no longer lists `meta_views.deleted_at`. The length is 25. Binding admission reads `view_row.sheet_id` only. The `meta_views` arm of `meta_plm_collaboration_container_guard` still refuses a bound DELETE, a bound `id` change, and a bound `sheet_id` change. It no longer reads `NEW.deleted_at` or `OLD.deleted_at`. Base and sheet `deleted_at` checks stay. No production `ALTER` adds a view soft-delete column. Field, record, truncate, sealing, and writer-fence guards are unchanged.

The fixture `CREATE TABLE meta_views` matches that canonical column list. `data_sources.deleted_at` stays. The bound-view statement that assigned `deleted_at` now inserts a second sheet and expects `23514` `meta_plm_collaboration_container_guard` on `UPDATE meta_views SET sheet_id`. The unbound statement now sets `name` to `plain renamed` and still hard-deletes that view before the sheet.

## Cause 2 — owned deferred operation foreign keys

`zzzz20260715210000_create_meta_record_history_operations.ts` is unchanged (SHA256 `7ec8ec81e5430d3932dcf9029c16e859f22c431ee2c2c2710b71bcb7003eff13`). Its global `conname` probe can skip `ADD CONSTRAINT` when another schema already holds `fk_mrr_operation` or `fk_mrvm_operation`. Root UTF8 shadow proof recorded `local_fks=[]` and an unsealed `recordRecordRevision` COMMIT with 1 revision and 0 endpoints. Listener job `120620553249` (run `40013792805`) failed `operation_and_commit_atomicity` the same way: the third `expectCommitFailure` committed instead of `23503` `fk_mrr_operation`.

After `bootstrapPlmBaseTestDb`, the existing W23 bootstrap calls `ensureOwnedOperationForeignKeys`. That function qualifies `fk_mrr_operation` on `meta_record_revisions` and `fk_mrvm_operation` on `meta_record_version_markers` by `current_schema()`, `contype = 'f'`, deferrable, deferred, validated, and ordered key names `sheet_id`, `operation_id` on both sides, referencing `meta_record_history_operations` in the same schema. A wrong local shape throws and is not dropped or rewritten. A missing key is added only on those two owned fixture relations. Foreign and `public` constraints are not dropped.

Production `preflightSql` counts the same two serving-schema shapes. If the count is not 2, it raises the existing `23514` `plm_collaboration_predecessors_absent` / `meta_plm_collaboration_predecessor_guard` and does not create or repair a foreign key. `up` still runs that preflight inside `withOwnedTransaction` before `createStatements`, so a raise leaves 0 new collaboration relations. A foreign schema that already has the canonical names does not satisfy the serving-schema count.

`expectCommitFailure` accepts a parameter array or a function. The function runs after the failed `COMMIT`. The three rollback checks in `operation_and_commit_atomicity` use the omitted binding id, the foreign-sheet record id, and the owned record id plus operation id. The `record_id NOT IN (SELECT record_id FROM meta_plm_collaboration_rows)` predicates are gone. The first sealed positive, the `23503` / `23514` names, sealing, and `MULTITABLE_ENABLE_WRITER_FENCE=true` stay.

Two permanent tests sit in the same file. `foreign_operation_names_still_require_owned_deferred_fk` builds a second `plm_w23_*` schema that already has both deferred names, then expects the serving schema to own both names, the foreign count to stay 2, and an unsealed commit to raise `23503` `fk_mrr_operation`. `missing_owned_operation_fk_refuses_preflight` uses `migrate: false`, drops the two owned constraints, and expects `up` to raise `23514` with 0 `meta_plm_collaboration_%` relations while the foreign count stays 2. The file now has 17 `test()` calls. These two tests were not executed. No workflow asserts the old 15.

## Cause 3 — owned socket cluster encoding

`scripts/verification/plm-managed-companion-pg/owned-socket.mjs` kept `LC_ALL=C` and `LANG=C`. `initdb` is now `-D`, `-U`, `--auth=trust`, `--encoding=UTF8`, `--locale=C`, `--no-instructions`. `createdb` still inherits the cluster. After start, and again on boot, the helper runs `SHOW server_encoding` and refuses any value other than `UTF8` before it emits proof. The proof field is `serverEncoding`. The existing self-check requires that field on the start proof and on the boot proof, and it queries `SHOW server_encoding` again before stop and after restart. `SELECT 1`, negative `pg_ctl` retention, wrong nonce, decoy preservation, cleanup, the `/tmp/plm-managed-consumer-pg-` prefix, and the socket-only `-h ''` options stay. The migration UTF8 gate is unchanged. There is no new helper and no third manager.

`node --check scripts/verification/plm-managed-companion-pg/owned-socket.mjs` exited 0. The helper was not started. Self-check was not run. Root still owns that self-check on a fresh UTF8 cluster, plus renewal 29, the failed operation node, and the two new controls. A database created by hand inside the live SQL_ASCII cluster is not a substitute: `createdb` without an encoding flag inherits the cluster.

## Pins

| Path | Before (`469bd5c`) | After (working tree) |
| --- | --- | --- |
| collaboration snapshot migration | `dd55d2364baca595deaf3692ca99d75df9fb68a3f561a4083c4d197c5bacf3a4` | `0fde297de630f2c8819d4cb8b07cf70ab64eb121938ce93043eff5e5bfc0c855` |
| W23 bootstrap | `a1cb4bb9d5017a63189f2bfbf157e7196dada4b56a91b23347ffe5cd6b0a7cf9` | `be33af5b327b14dec8bf12b9561abf8e7d8855ccdaf11436902bb26a026744a9` |
| realdb guards | `6fd0f3dbf0b0c14fada9bd9f7b3537d474c0dc06b62a318ac0751a773f5c682b` | `e8889c0af759889c3ef4aba286fdc93cd537f4ce610a42250bdd7609e6b6cde7` |
| owned socket | `cfb1a26724103f291407affba6d918c86dd896c8a57cd4ea38c7c117ad5a1d6f` | `c21f8767d372c66b0cf160d74ab6ecfff83560f32881617248c6180276a69c09` |

Unchanged content SHA256 values checked against HEAD or the worktree: snapshot vitest config `7d3523917852fb99fa069a6b47fe057c07b5b480a927dbc758cec4c1d41cbdc2`, backend vitest config `7ca3bbdc14657543e5d54f04c26180eeb8d453c2d07d38fae566065c241dbbdb`, base bootstrap `50624ae5f8347a6031f67d77e26c85d5667eb3635743a31dfa44ad08ac8cdf64`, old history migration `7ec8ec81e5430d3932dcf9029c16e859f22c431ee2c2c2710b71bcb7003eff13`, managed consumer workflow `6d52717ef80744ff0551d77747dd437d0c1fbbc261bdfc4aee369b3f5a6ff740`, listener workflow blob `73e9c26f274926ac1ae580941d635fa414e7ce5f602181e2bf9c3188603a282f`. The consumer workflow still asserts unit 197, discussion 61, PostgreSQL 133, and web 222. Those suites were not rerun. Deadlines were not edited.

## Validation and limits

`git diff --name-only` before these two new files was exactly the four tracked allowlisted paths (`330 insertions, 21 deletions`). `node --check` on the runner exited 0. Typecheck, PostgreSQL, Docker, cohort reruns (`193` / `61` / `133` / `14`), build, install, and browser were not run. Disk free space before this documentation write was `15696678912` bytes, above the `4563402752` floor. The pre-edit check in the same session was `15843237888` bytes.

Root still runs the two new controls, the failed `operation_and_commit_atomicity` node, renewal 29, and the real socket self-check. Generic job encoding remains UNKNOWN. The companion origin conflict remains untouched. PostgreSQL 133 was not rerun. The earlier backend typecheck RED is outside this allowlist and was not rerun.

## Round 2 — MATCH and referential actions

Nonce `da4aed58af714d5589a120d8caae2e9f`. The round 1 text above stays as the historical closeout. This round does not rerun it and does not claim CI green.

The round 1 shape check required the name, both namespaces, ordered `sheet_id`/`operation_id` keys, validation, and `DEFERRABLE INITIALLY DEFERRED`. It did not require match type or referential actions. Root reproduced that hole on PostgreSQL 16.15 UTF8. One focused case registered 1 and failed 1 with `ROOT_MALFORMED_OPERATION_FK_ACCEPTED_3`. Source pins were stable. All three variants passed preflight and left collaboration relations behind:

| Variant | `fk_mrr_operation` shape | Match | Update | Delete |
| --- | --- | --- | --- | --- |
| `match_full` | `MATCH FULL DEFERRABLE INITIALLY DEFERRED` | `f` | `a` | `a` |
| `update_cascade` | `ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED` | `s` | `c` | `a` |
| `delete_set_null` | `ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED` | `s` | `a` | `n` |

Evidence is `/tmp/plm-meta6516-ci-repair-malformed-fk-root-red-20261024.json` and packet manifest `e029c8f1317580a83d80769b914bf668fa833a6954f6544a65a5ebce0cdaf855` (16 files). Root's temporary module is not copied into the product.

Production preflight, `ensureOwnedOperationForeignKeys`, and `OWNED_OPERATION_FK_SQL` now also require `confmatchtype = 's'`, `confupdtype = 'a'`, and `confdeltype = 'a'`. That is MATCH SIMPLE and NO ACTION on update and delete, the defaults of the unchanged history migration `7ec8ec81e5430d3932dcf9029c16e859f22c431ee2c2c2710b71bcb7003eff13`. A wrong local shape is still refused and is not rewritten. A missing owned fixture key is still added with those defaults plus `DEFERRABLE INITIALLY DEFERRED`. MATCH FULL stays refused: a legacy revision may store a non-null `sheet_id` with a null `operation_id`, which MATCH SIMPLE allows and MATCH FULL rejects. The preflight still raises `23514` `plm_collaboration_predecessors_absent` / `meta_plm_collaboration_predecessor_guard` and still creates no foreign key.

`missing_owned_operation_fk_refuses_preflight` is now `missing_or_malformed_owned_operation_fk_refuses_preflight`. The file still has 17 top-level `test()` functions. That one function loops four named subcases, each on a fresh owned fixture, while one foreign schema keeps the canonical names: `canonical_missing`, `match_full`, `update_cascade`, and `delete_set_null`. Each expects the same `23514`, zero `meta_plm_collaboration_%` relations, and foreign count 2. The three malformed subcases replace only `fk_mrr_operation`, which is the shape root admitted. These four subcases were not executed.

`scripts/verification/plm-managed-companion-pg/owned-socket.mjs` stays `c21f8767d372c66b0cf160d74ab6ecfff83560f32881617248c6180276a69c09`. This round did not start or stop it. Root reported that helper's self-check PASS for UTF8 start, UTF8 boot, wrong nonce, decoy, unexpected-status retention, and cleanup, and one selected companion outage PASS on a fresh UTF8 cluster whose postmaster PID changed. Renewal 29 was already running on root PostgreSQL nonce `471901d1f994f3fc`. This round did not contact that cluster.

Selected PostgreSQL proof of this predicate repair is pending. Root still runs the new counterexamples, the failed operation node, the canonical-view case, and these two focused product tests. Prior RED and HOLD records stay. Assert-report integers 197, 61, 133, and 222 were not edited and were not rerun.

| Path | Inherited dirty pin | After this round |
| --- | --- | --- |
| collaboration snapshot migration | `0fde297de630f2c8819d4cb8b07cf70ab64eb121938ce93043eff5e5bfc0c855` | `df125b0fa4dd3eb652507d116b0005b1afe5a66a038699f7747ee5dc8fc20714` |
| W23 bootstrap | `be33af5b327b14dec8bf12b9561abf8e7d8855ccdaf11436902bb26a026744a9` | `80e85370e80dc500c3b2f77f8a36e40ee1e3a7a72d8046679ed6bace87a59f3f` |
| realdb guards | `e8889c0af759889c3ef4aba286fdc93cd537f4ce610a42250bdd7609e6b6cde7` | `1f1cb6bc7a4742712eaf61a104f4cfbdfcbf26b8b4224d403400ffe70734d59b` |
| owned socket | `c21f8767d372c66b0cf160d74ab6ecfff83560f32881617248c6180276a69c09` | unchanged |


## Codex root verification — 2026-10-23T20:42Z

The source corrections passed the bounded checks below. Earlier RED/HOLD packets remain immutable. The table reports separate executions; it does not claim a single complete 17-test or 133-test run, current-head CI, installation, or the entire master goal.

| Check | Actual result |
| --- | --- |
| Existing owned-socket self-check | PASS: UTF8 checked after start and restart; wrong nonce, decoy and unexpected pg_ctl status protections retained; its cluster removed |
| Previously local-harness-failed outage node | 1 PASS; 79 unselected; fresh UTF8 cluster, actual PID 35318 → 38473 |
| Renewal tests previously blocked in beforeAll by SQL_ASCII | 29 PASS, 0 skipped; 41.065 seconds of tests; existing per-test deadlines unchanged |
| Failed operation node, changed canonical-view container node, two new FK controls | 4 PASS; 13 unselected; malformed predecessor node checks four fresh-fixture subcases |
| Independent canonical-view and foreign-FK-name counterexamples | 2 PASS, 0 skipped; canonical view has no deleted_at, unsealed COMMIT is 23503 and exact owned revision/endpoint counts are zero |
| Independent malformed-FK counterexample | 1 PASS, 0 skipped; MATCH FULL, UPDATE CASCADE and DELETE SET NULL all refused before any collaboration relations |

The earlier local isolated outage refusal was a stale test source: retained source-1 used origin :7 while companion setup's ON CONFLICT DO NOTHING expected :9. A fresh helper-owned database resolved the fixture contamination; product authentication was unchanged. This was not classified as a remote CI cause.

The generic approval job's server encoding remains UNKNOWN. Its line-44 predecessor failure and the separate managed helper's observed SQL_ASCII cause remain distinct. Canonical-view guard and full FK shape checks passed actual PostgreSQL 16.15 controls; this does not classify every prior failed CI job.

Root-owned nonce 471901d1f994f3fc: no plm_w23 fixture schemas remained; only the marked root foreign-name shadow remained before dropping the owned database. The fresh database catalog returned to postgres/template0/template1; pg_ctl status 3, former PID absent, no open files, and owned runtime directory removed. Four retained PostgreSQL/pgcrypto runtime pins remained unchanged. Docker/MinIO recovery is not claimed.

Evidence packets:

- Root DB GREEN + owned cleanup: `/Users/chouhua/.codex/worktrees/plm-listener-review-20261015/Yuantus/artifacts/plm-listener-review-20261015/private-acceptance-evidence-20261020/meta6516-canonical-db-ci-root-green-and-cleanup-20261024`, manifest `b429b93e975305baac54bf31e1a4bc73adae0ef7e015938c4fe17eb54f937f81`.
- Existing helper and focused managed checks: `/Users/chouhua/.codex/worktrees/plm-listener-review-20261015/Yuantus/artifacts/plm-listener-review-20261015/private-acceptance-evidence-20261020/meta6516-UTF8-owned-helper-and-focused-managed-green-20261024`, manifest `db3b5af0a9298fafd71bab37672837772617b07d5a39928b12099f11769a2a57`.
- Original exact469 CI and two actual UTF8 RED controls: manifest `864fa6fe00ae7759f4bd1be5df4c86953c2980f969657f2f06ac9af2e0053e20`.
- Additional noncanonical FK RED: manifest `e029c8f1317580a83d80769b914bf668fa833a6954f6544a65a5ebce0cdaf855`.

The managed strict CI counts 197/61/133/222, shared historical migration, Adapter, wire, authentication, and existing deadlines remain unchanged. The four source pins are frozen in the root packet. The 13 unselected DB tests and already passing 103/197/61 cohorts were not repeated; this cut introduces no skip or baseline relaxation. All PRs remain Draft. Current-head CI must be checked after publication.
