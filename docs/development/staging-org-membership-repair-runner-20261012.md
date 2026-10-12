# Staging org-membership inspect / repair runner actions (2026-10-12)

## Ruling and scope

- Owner ruling 2026-10-12: the active staging user with no `user_orgs` row is handled through
  the staging window runner. First locate it (read-only, values-free). Then repair it, but only
  after the owner names **deactivate** or **add-membership**. The read-only locate may be
  dispatched from this branch once an independent gate has passed. Production is never touched.
- Background: `action=migrate` stopped fail-closed in `action_migrate_read_only_prechecks`. On a
  multi-org staging DB (`distinct_active_org_count=4`), it found `zero_membership_no_row_count=1`
  and `recovery09_repairable_user_count=1`, and the Recovery09 migrations were already applied.
- Population, the same for both actions:
  `users u WHERE u.is_active = TRUE AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id)`.

## Changes

| File | Change |
|---|---|
| `.github/workflows/attendance-staging-window-runner.yml` | Two new `action` choices.<br>One new input `repair_spec`, bringing workflow_dispatch to exactly 10 inputs.<br>The validation step checks: single line, then the strict regex, then scoping (required for repair, empty for every other action), with exit 2.<br>`REPAIR_SPEC` is passed to the remote prelude.<br>The step summary re-validates the spec before printing it. |
| `scripts/ops/attendance-window-runner-pipeline.lib.sh` | Pure text helpers:<br>• spec parser (returns 2 on a malformed spec)<br>• read-only transaction wrapper<br>• the precheck counter generator `target_precheck_counters_query` / `_sql`, now the ONE source for the migrate precheck and both new actions<br>• inspect / precheck / write SQL generators<br>• synthetic class list |
| `scripts/ops/attendance-staging-window-runner-remote.sh` | `REPAIR_SPEC` is re-validated at top level, before the staging guard and before any docker call (exit 2).<br>`staging_db_dump`, the single `pg_dump`, is now shared by the migrate backup and the repair backup.<br>The migrate precheck uses the shared counter generator; its output was proven identical in both predicate shapes.<br>New functions `action_org_membership_inspect` and `action_org_membership_repair`, plus their dispatcher arms. |
| `scripts/ops/attendance-window-runner-pipeline.test.mjs` | Two pinned action lists updated.<br>`runWorkflowValidation` passes `REPAIR_SPEC`.<br>15 new cells (listed under Verification). |

## Rules: `action=org-membership-inspect` (read-only)

- Every query runs inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` and is
  followed by `ROLLBACK`. The session also sets
  `PGOPTIONS=-c default_transaction_read_only=on`, and psql runs with `\set VERBOSITY terse`.
- Optional tables and columns are probed first through `information_schema`. A fact whose
  table or column is absent prints `n/a`. A query never names a relation the probe did not find.
- Output for each matching user (values-free):
  - `fp` = `left(md5(id),16)`, plus `fp_shared_by_users`;
  - `created_at` (UTC);
  - `synthetic_class` (class name or `none`) and `synthetic_match` (`id`, `username`, `email` or
    `none`);
  - counts: `inactive_memberships` (0 by predicate), `user_roles`, `admin_role_rows`,
    `approvals_as_requester`, `class6_shaped_requested`, `tasks_created`,
    `task_assignee_rows`, `multitable_records_created`, `external_identity_rows`,
    `directory_account_links`;
  - yes/no facts: `is_admin_flag`, `role_column_admin`, `has_logged_in`.
- The output also lists one line per org with active members: the org id, `spec_nameable`,
  and `active_members`. An org id that the repair spec could not name is withheld, and only its
  fingerprint is shown.
- It prints the full migrate precheck counter vector, using the same generator as migrate.
- Synthetic classes come from the runner's own prefixes: the smoke `stamp_prefix` values
  (ae4, rd45, otbank-v18, mp6, hmr5, tasks; these match on id) and `SOAK_USER_PREFIX` (matches
  on username or email). Matching uses `starts_with`, never `LIKE`.

## Rules: `action=org-membership-repair`

- Spec grammar. The regex below is one literal shared by the lib, the validation step and the
  summary step:
  - `deactivate:<fp16>:I_CONFIRM_STAGING_ORG_MEMBERSHIP_REPAIR`
  - `add-membership:<fp16>:<org_id>:I_CONFIRM_STAGING_ORG_MEMBERSHIP_REPAIR`, where `org_id`
    matches `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.
  - Anything else exits 2, in both the workflow and the remote script, and the value is never
    echoed back.
- Order of operations (each step must pass before the next):
  1. Spec validation.
  2. Read-only counters and preconditions:
     - exactly one active no-row user has this fp (0 or more than 1 aborts);
     - for add-membership, the org must already have active members. There is no orgs table, so
       "exists" means "has active `user_orgs` members".

     Any refusal here happens before the backup and before any write.
  3. Full `pg_dump` (the migrate backup's own dump) to the runner backup directory on the host.
     The artifact records only the file name, size and sha256.
  4. ONE transaction:
     - `LOCK TABLE user_orgs IN SHARE ROW EXCLUSIVE MODE`;
     - counter snapshot;
     - `FOR UPDATE` on the matching user row;
     - re-check that exactly one user matches;
     - write exactly one row:
       - deactivate: `UPDATE users SET is_active = FALSE` (plus `updated_at` when that column
         exists);
       - add-membership: `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES (…, TRUE)`.
         These are the same minimal columns Recovery09 and the provisioning migration write;
         `created_at` defaults.
     - `ROW_COUNT = 1`;
     - counter snapshot;
     - full delta-vector check;
     - `COMMIT`.

     Any mismatch raises `ORGFIX_ABORT …`, which carries only counts, labels or the fp, and
     rolls the whole transaction back.
  5. Read-only counters after the COMMIT. `zero_membership_no_row_count` must fall by exactly 1.
- Expected delta vector. k = the user's `class6_shaped_requested`. Every other counter must stay
  unchanged.

  | counter | deactivate | add-membership |
  |---|---|---|
  | zero_membership_active_user_count | −1 | −1 |
  | zero_membership_no_row_count | −1 | −1 |
  | recovery09_repairable_user_count | −1 | −1 |
  | class6_candidate_count | 0 | −k |
  | recovery09_unsupported_class6_count | +k | 0 |
  | legacy_anchor_active_membership_witness_count | 0 | +1 only when org_id = `default` |

- Effect on the migrate gate:
  - Deactivate unblocks the multi-org precheck only when that user's `class6_shaped_requested`
    is 0. When it is above 0, the user's class-6-shaped requests stay in
    `class6_candidate_count` and become `recovery09_unsupported_class6_count`.
  - add-membership removes them from `class6_candidate_count`.
  - Inspect prints k for each user so that the owner can see this before choosing.
- `UPDATE OF is_active` on `users` fires the recovery-authority try-lock trigger. If that lock is
  busy, the transaction aborts with nothing written and is safe to retry. A retry takes a new
  backup.
- Restoring from the host dump is an owner call. The runner never restores on its own.

## Rules: containment and values-free output

- Both actions use only `metasheet-staging-postgres`:
  - the container name is asserted;
  - the staging compose file must define it;
  - it must be running.
- They do not use compose, `staging_exec` or the backend/web/redis containers, and they make no
  reference to the prod-track repo or container names. The self-test pins all of this.
- No identity column (id, username, email, name) reaches any SELECT list except inside `md5()`
  or a comparison. No echo/printf/log/fail line prints an identity variable. Both are
  static-scanned, with positive controls.

## Dispatch

Before any dispatch, an independent gate must have passed on this branch. Repair additionally
requires the owner to name the mode, the fp and, for add-membership, the org id.

```
gh workflow run attendance-staging-window-runner.yml --ref claude/runner-org-membership-repair \
  -f action=org-membership-inspect

gh workflow run attendance-staging-window-runner.yml --ref claude/runner-org-membership-repair \
  -f action=org-membership-repair \
  -f repair_spec='deactivate:<fp16>:I_CONFIRM_STAGING_ORG_MEMBERSHIP_REPAIR'

gh workflow run attendance-staging-window-runner.yml --ref claude/runner-org-membership-repair \
  -f action=org-membership-repair \
  -f repair_spec='add-membership:<fp16>:<org_id>:I_CONFIRM_STAGING_ORG_MEMBERSHIP_REPAIR'
```

After a repair, re-run `action=org-membership-inspect` and then `action=migrate` with the same
`deploy_sha` as before.

## Verification

RAN (local, 2026-10-12):

- `node --test scripts/ops/attendance-window-runner-pipeline.test.mjs`: 213/213 pass. This is
  198 existing cells plus 15 new ones.
- The workflow's own self-test invocation (`… pipeline.test.mjs scripts/ops/staging-tasks-smoke.test.mjs`):
  404/404.
- Sibling contracts that read the runner files:
  - `staging-tasks-smoke.test.mjs` 191/191
  - `dingtalk-lifecycle-staging-canary-contract.test.mjs` 213/213
  - `dingtalk-interactive-card-stream-staging-uat-contract.test.mjs` 50/50
  - `dingtalk-oauth-staging-config-contract.test.mjs` 8/8
- New cells:
  - wiring and the 10-input cap;
  - regex parity between the lib and both workflow checks;
  - spec parser: 4 accepted shapes and 27 rejected shapes. The rejected shapes cover missing
    confirm, extra fields, metacharacters, newline/CR, quotes and length;
  - workflow validation exits 2;
  - remote top-level exits 2 with zero docker calls;
  - a positive control for the read-only scan;
  - inspect executable: every query is READ ONLY with ROLLBACK and PGOPTIONS, with no dump and no
    write;
  - repair executable: aborts on 0 and on 2 matches with no backup and no write;
  - repair refuses an org that has no active members;
  - repair executable: precheck, then backup, then exactly one write, then the re-measure. The
    backup metadata is file name, size and sha256 only;
  - write-transaction guards: the exact-one-row writes and the delta vector;
  - values-free static scans, with positive controls;
  - containment (staging postgres only);
  - the shared counter generator and the single `pg_dump`;
  - synthetic-class coverage.
- Mutation checks (7/7 caught):
  - backup moved after the write;
  - READ ONLY dropped;
  - ROW_COUNT guard dropped;
  - remote spec validation dead-wrapped;
  - `== 1` relaxed to `>= 1`;
  - read-only PGOPTIONS dropped;
  - an echoed id added.
- Real PostgreSQL 15, throwaway local cluster, synthetic rows only. The real remote script ran
  unmodified, with a docker shim that maps `docker exec` onto that cluster:
  - The refactored precheck counter SQL gave output identical to the previous inline SQL, with
    and without the `org_id` predicate.
  - inspect worked end to end.
  - deactivate committed with the exact predicted vector, including
    `recovery09_unsupported_class6_count +k`.
  - add-membership to a non-default org committed with `class6 −k`.
  - add-membership to `default` committed with anchor `+1`.
  - These were refused before backup and before any write: fp with 0 matches, an org with only
    inactive members, an unknown org. No new dump file appeared.
  - A malformed spec exited 2 with zero docker calls. A spec on inspect exited 2.
  - A side-effect trigger forced a delta mismatch. The result was `ORGFIX_ABORT counter_delta_mismatch`,
    the whole transaction rolled back, and no row changed.
  - Run directly, the in-transaction guards raised `match_count=0`,
    `org_has_no_active_members`, `malformed_org` and `deactivate_takes_no_org`.
  - The read-only wrapper refused an `UPDATE`.
- actionlint and shellcheck: no findings beyond the origin/main baseline.

NOT RUN:

- Any dispatch against staging. Inspect waits for the independent gate. Repair waits for the
  owner to name the mode.
- Anything against production (out of scope by ruling).
- The SQL against the staging PostgreSQL major version itself. Locally it ran on 15 only.
- The users-table recovery-authority trigger. The local schema did not carry it, so the BUSY
  path is covered only by the reasoning above.
