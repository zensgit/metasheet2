# Directory metadata batch upsert — Draft verification

Status: local evidence complete; current-head required CI pending publication. Design: `directory-metadata-batch-upsert-design-lock-20261026.md`. Base `bcd879f1b5efc23bcf5346c42224bc59801ad724`.

## Behavior and source boundary

The production sync previously performed three department and five account metadata INSERT statements for the synthetic fixture. It now performs one of each, preserving the actual rows, first-run4created/1updated and repeat0created/5updated account counts. Larger inputs use fixed500-row statements (department max4500/account max8000 binds). Account-department batching already existed and is unchanged.

Both trusted scalar SQL statements are byte-identical to their prior production versions; only their row tuples repeat with shifted bind markers. The existing scalar account SQL test accessor is rendered from the same parts actual batching uses. Original integration/provider/corp scope, openId CASE, normalization, transaction/freeze ordering and all following identity/link/rehire/group/deprovision phases are unchanged. No new flag, dependency, migration, OpenAPI or SDK change.

## Actual local phases

All commands used the owned isolated wrapper, Node20.20.2/pnpm9.15.9, empty external-env directory and synthetic native PostgreSQL16 UTF8. Provider IO is mocked. Counts come from individual assertionResults.status; filtered/skipped items never count passed.

| Gate | Executed evidence |
| --- | --- |
| G1 original production baseline | One matching failure/8filtered: native observation returned3department/5account statements versus1/1. Raw expected/received diff proves both; JSON failureMessage ellipsized the second field and made the controller postcheck fail, so the independent raw-log audit accepts the RED without replay. |
| Unit/chunk contract | New module plus affected run-lease neighbor34/34 actualpassed. Covers empty, exact scalar SQL, 500/501 ordering/bind shift, literal-created counts and propagated second-chunk error without transaction SQL. |
| Native metadata | Initial4/4 actualpassed: all6openId cases, full metadata/IDs, 501rows/kind, caller-owned rollback after later-chunk FKfailure, second-integration isolation. Review added department ID/created_at and separate department scope readback; only those2affected cases reran:2passed/2filtered. |
| Production/preview fixture recovery | First positive had7passed/2failed because the new production-count case prematurely auto-admitted the original neighbor fixture user. The new case now owns a separate manual-default integration/corp and cleans it. Removing only its import/case restores all8original cases/hooks byte-for-byte. Only newcase+2affected originals reran:3passed/6filtered. Historical failure retained; no assertion or budget weakened. |
| Identity/primary/stale neighbors | Existing OpenID grant-path whole file24/24; primary-department writer10/10; affected run1..4 persisted created/updated/departed/steady-state counters4passed/10filtered. |
| Matching security mutation | Remove only same-corp openId retention condition:1matching native failure/3filtered (cross-corp known openId incorrectly retained); exact module bytes restored. |
| Matching batching mutation | Restore only original metadata runtime loops with the final isolated production case:1matching failure/8filtered,3/5versus1/1; exact runtime bytes restored. |
| Quality/registration | Explicit changed-file lint0; validate:all0. Final two added assertions are test-only, explicitly linted and executed; production inputs are unchanged and tsc showConfig excludes that integration test, so quality was not rerun. Existing CI-wiring contract322/322. New DB file is in realDB run-list and noDB exclude. |
| Independent review | No confirmed introducedP1/P2 in bounded source review. Two concrete department assertion gaps were addressed as above. Model review is not execution proof. |

Owned baseline/fix/mutation logs have distinct filenames and independent SHA256 verification. All owned controllers exited; PG stopped, port closed, data retained. Ledger458/pending0 was established on a fresh owned DB, then reused without migration replay.

## Remaining delivery gates

Current-head required CI must finish success with actual new unit/DB file execution, whole production/preview file and appropriate neighbor summaries. Preserve local phase boundaries; do not describe the staged filtered runs as a fresh all-suite invocation. PR remains Draft with exact final source/head/clean/body readback. This proof does not establish the2000-user staging runtime target, formal parent/W8/owner acceptance, live provider behavior, production or deployment. No merge/deploy/R71/tag/release/config changes; Stream/lifecycle OFF; realUAT/business50004 excluded; historical08PUTINCONCLUSIVE.
