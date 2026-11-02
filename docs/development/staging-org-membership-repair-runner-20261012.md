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
| `.github/workflows/attendance-staging-window-runner.yml` | Two new `action` choices.<br>One new input `repair_spec`, bringing workflow_dispatch to exactly 10 inputs.<br>The validation step (`id: validate`) reads `repair_spec` from the event payload (`GITHUB_EVENT_PATH`), never from a step env. It checks: single line, then the strict regex, then scoping (required for repair, empty for every other action), with exit 2. It writes the validated value, or empty, to its step output as the last thing it does.<br>The remote step and the summary step receive only `steps.validate.outputs.repair_spec`.<br>`deploy_sha` must be empty or a full lower-case SHA for every action. |
| `scripts/ops/attendance-window-runner-pipeline.lib.sh` | Pure text helpers:<br>• spec parser (returns 2 on a malformed spec)<br>• read-only transaction wrapper<br>• the precheck counter generator `target_precheck_counters_query` / `_sql`, now the ONE source for the migrate precheck and both new actions<br>• inspect / precheck / write SQL generators<br>• the applied-deprovision-evidence expression<br>• the migrate-gate rule and its projection<br>• synthetic class list |
| `scripts/ops/attendance-staging-window-runner-remote.sh` | `REPAIR_SPEC` is re-validated at top level, before the staging guard and before any docker call (exit 2).<br>`staging_db_dump`, the single `pg_dump`, is now shared by the migrate backup and the repair backup.<br>The migrate precheck uses the shared counter generator; its output was proven identical in both predicate shapes.<br>New functions `action_org_membership_inspect` and `action_org_membership_repair`, plus their dispatcher arms. |
| `scripts/ops/attendance-window-runner-pipeline.test.mjs` | Two pinned action lists updated.<br>`runWorkflowValidation` synthesizes the event payload and `GITHUB_OUTPUT`.<br>New cells, listed under Verification, including one opt-in real-PostgreSQL cell. |

## Rules: `action=org-membership-inspect` (read-only)

- Every query runs inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY` and is
  followed by `ROLLBACK`. The session also sets
  `PGOPTIONS=-c default_transaction_read_only=on`. Terse errors are set both on the psql command
  line (`-v VERBOSITY=terse`) and as the first stdin line.
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
    `directory_account_links`, `applied_deprovision_evidence`;
  - yes/no facts: `is_admin_flag`, `role_column_admin`, `has_logged_in`;
  - `migrate_gate_after_add` and `migrate_gate_after_deactivate`: `pass`, `blocked` or `unknown`
    (see "Effect on the migrate gate").
- The output also lists one line per org with active members: the org id, `spec_nameable`,
  and `active_members`. An org id that the repair spec could not name is withheld, and only its
  fingerprint is shown.
- It prints the full migrate precheck counter vector, using the same generator as migrate, and
  `migrate_gate_now`.
- Synthetic classes come from the runner's own prefixes: the smoke `stamp_prefix` values
  (ae4, rd45, otbank-v18, mp6, hmr5, tasks; these match on id) and `SOAK_USER_PREFIX` (matches
  on username or email). Matching uses `starts_with`, never `LIKE`.

## Rules: `action=org-membership-repair`

- Spec grammar. The regex below is one literal shared by the lib, the validation step and the
  summary step:
  - `deactivate:<fp16>:I_CONFIRM_STAGING_ORG_MEMBERSHIP_REPAIR`
  - `add-membership:<fp16>:<org_id>:I_CONFIRM_STAGING_ORG_MEMBERSHIP_REPAIR`, where `org_id`
    matches `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.
  - Anything else exits 2, in both the workflow and the remote script.
- What reaches the public job log:
  - The raw input is read only from the event payload, inside the validation step. No step env
    carries it, and no workflow expression names it (the self-test pins both). GitHub prints
    each step's env values in the log header, so a refused value is not published there. The
    validation messages do not print it either.
  - A **validated** spec is passed to the remote step and the summary step through the step
    output. Their env headers therefore show it, including the org slot. Copy the fp and the org
    id only from the inspect output, never from anywhere else.
  - The summary step prints mode and fp only. The remote summary names the org only after it
    resolved to an org with active members. A refusal does not echo the org value.
- Order of operations (each step must pass before the next):
  1. Spec validation.
  2. Read-only counters, column probe and preconditions:
     - exactly one active no-row user has this fp (0 or more than 1 aborts);
     - that user has no `applied` rows in `directory_deprovision_events` or
       `directory_deprovision_effects` (when those tables exist);
     - for add-membership, the org must already have active members. There is no orgs table, so
       "exists" means "has active `user_orgs` members".

     Any refusal here happens before the backup and before any write.
  3. Full `pg_dump` (the migrate backup's own dump) to the runner backup directory on the host.
     The artifact records only the file name, size and sha256. A failed or empty dump stops the
     run before the write.
  4. ONE transaction:
     - `FOR UPDATE` on the user row(s) with this fp, then
       `LOCK TABLE user_orgs IN SHARE ROW EXCLUSIVE MODE`. This is the app's lock order: user row
       first, then the membership table;
     - counter snapshot;
     - re-check that exactly one user matches, by population and fp in one statement;
     - re-check that the user has no applied deprovision evidence;
     - write exactly one row:
       - deactivate: `UPDATE users SET is_active = FALSE`, plus `updated_at = now()` and
         `access_generation = COALESCE(access_generation, 0) + 1` when those columns exist;
       - add-membership: `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES (…, TRUE)`.
         These are the same minimal columns Recovery09 and the provisioning migration write;
         `created_at` defaults.
     - `ROW_COUNT = 1`;
     - counter snapshot;
     - full delta-vector check;
     - `COMMIT`.

     Any mismatch raises `ORGFIX_ABORT …` and rolls the whole transaction back. Every RAISE
     argument is a count or a label (the self-test pins an allowlist).
  5. Read-only counters after the COMMIT. `zero_membership_no_row_count` must fall by exactly 1,
     or the result is `post_commit_mismatch`.
- If the write call does not report `write_committed=yes`, the result is `commit_unconfirmed`.
  This is normally an abort, which rolls everything back. The terse error in `ssh.log` is one of:
  `ORGFIX_ABORT …`, `METASHEET_RECOVERY_AUTHORITY_BUSY`, or a lock, deadlock or statement
  timeout. Re-run inspect before retrying. A retry takes a new backup.
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

- Deliberate differences from the platform's own user-status and membership writers. Those
  writers lock the user, write, supersede applied deprovision evidence, advance
  `access_generation`, revoke sessions and write an audit row. This runner:
  - refuses a user with applied deprovision evidence instead of superseding it;
  - advances `access_generation` on deactivate only. On add-membership that would be a second
    row write;
  - writes no session-revocation row and no audit row. Access is still denied after deactivate,
    because token verification re-reads `users.is_active`.
- `UPDATE OF is_active` on `users` fires the recovery-authority try-lock trigger. If that lock is
  busy, the transaction aborts with nothing written and is safe to retry.
- Restoring from the host dump is an owner call. The runner never restores on its own.

## Effect on the migrate gate

`action_migrate_read_only_prechecks` enters its multi-org branch when
`recovery09_repairable_user_count > 0` or `class6_candidate_count > 0` and
`distinct_active_org_count != 1`. With the Recovery09 migrations already applied, that branch
always fails. `invalid_approval_action_count` and `attachment_org_conflict_count` must be 0 in
every case.

So, after one repair of a user with k class-6-shaped requests, the gate passes only if both of
these are 0:
- `recovery09_repairable_user_count − 1`. Users with only inactive memberships count too.
- `class6_candidate_count − k` for add-membership, or `class6_candidate_count` unchanged for
  deactivate.

Requesters other than this user can keep `class6_candidate_count` above 0. These include
requesters missing from `users` and requesters with two or more active memberships. In that case
neither mode unblocks migrate.

Inspect prints this projection for each user (`migrate_gate_after_add`,
`migrate_gate_after_deactivate`). The repair summary prints `migrate_gate_after`, computed with
the same rule from the counters measured after the COMMIT.

The population is also created by design: self-registration writes no `user_orgs` row, and a
partial smoke cleanup can leave an active user with no row. A later migrate can therefore stop
at the same precheck again. Re-running inspect before migrate is the check.

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
- Residuals the task text asks for, which the owner should accept knowingly before dispatch:
  - the inspect org list publishes the raw org ids that the spec can name, with member counts;
  - fp is an unsalted md5 prefix of the id. It is pseudonymous: anyone holding a candidate id
    can confirm it.

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

RAN (local, 2026-10-12, fixer round 1):

- `node --test scripts/ops/attendance-window-runner-pipeline.test.mjs`: 225 cells, 224 pass and
  1 skipped (the opt-in real-PostgreSQL cell). With
  `WINDOW_RUNNER_ORGFIX_PG_BIN` pointing at a PostgreSQL 15 bin directory: 225/225 pass.
- The workflow's own self-test invocation (`… pipeline.test.mjs scripts/ops/staging-tasks-smoke.test.mjs`):
  415 pass, 1 skipped, 0 fail.
- Sibling contracts that read the runner files:
  - `staging-tasks-smoke.test.mjs` 191/191
  - `dingtalk-lifecycle-staging-canary-contract.test.mjs` 213/213
  - `dingtalk-interactive-card-stream-staging-uat-contract.test.mjs` 50/50
  - `dingtalk-oauth-staging-config-contract.test.mjs` 8/8
- Cells for this change:
  - wiring and the 10-input cap;
  - no workflow expression names the raw input, and no step env carries it, with positive
    controls. Validate writes its output only after every refusal;
  - regex parity between the lib and both workflow checks;
  - spec parser: 4 accepted shapes and 27 rejected shapes;
  - workflow validation, reading a synthesized event payload: exits 2 on every rejected shape, on
    a missing, unparsable or non-string payload value, and on a spec for another action. Only a
    validated value reaches `GITHUB_OUTPUT`;
  - `deploy_sha` must be empty or a full SHA for every action;
  - the summary step, run as extracted: mode + fp only, a withheld marker otherwise;
  - remote top-level exits 2 with zero docker calls;
  - inspect executable: every query is READ ONLY with ROLLBACK and PGOPTIONS, with no dump and no
    write; the migrate-gate projection per mode; the gate rule itself;
  - repair executable, against an fp-aware stub:
    - refused on 0 and on 2 matches;
    - refused on an fp that names no user, with a positive control;
    - refused on an org without active members, without echoing the org;
    - refused on applied deprovision evidence;
    - a failed or empty dump stops it before the write;
    - an unconfirmed commit or an after-COMMIT mismatch is a failure;
    - order: precheck, backup, one write, re-measure;
  - per-statement pins of the population predicate and the fp clause (precheck, evidence,
    inspect, in-transaction re-check);
  - write-transaction guards: lock order, the exact writes and dynamic statements, and the delta
    vector;
  - RAISE argument allowlist, and terse on both psql command lines;
  - values-free static scans, containment, the shared counter generator and the single
    `pg_dump`, synthetic-class coverage.
- Opt-in real-PostgreSQL cell (PostgreSQL 15.17, throwaway local cluster, synthetic rows only).
  It runs the generated SQL through psql and covers:
  - inspect through the read-only wrapper;
  - the wrapper refusing a write;
  - deactivate: exact vector and `access_generation` advanced;
  - add-membership to a non-default org and to `default`;
  - an fp of a user outside the population, of a member and of nobody: each aborts with
    `match_count=0` and changes nothing;
  - a side-effect trigger: aborts with a delta mismatch and rolls back;
  - applied evidence: refused in the precheck and in the transaction.
- Mutation checks, each applied alone to the committed files and run against the default suite.
  All are killed:
  - from the review: A3, A4, A5 (fp clause dropped in the precheck, in the re-check, in both);
    E1 (`LOCK TABLE` removed); E2 (post-commit check disabled); E3 (commit-marker check
    disabled); E4 (delta check disabled); B4 (empty-dump `fail` → `log`); B6 (pg_dump under
    `set +e`); E10, E11 (`uo.is_active` added to the inspect or re-check population); F9 (the
    summary prints the env value);
  - new: the raw input put back into the Validate env; a RAISE printing `v_ids[1]`; the org
    echoed in the refusal; the evidence gate removed; the `access_generation` fragment removed;
    the lock order reversed; the step output removed; the gate rule's multi-org arm removed;
    terse removed from the psql command line.
  - E4 first survived the default suite; the delta, missing-counter, histogram and counter-set
    checks are now pinned as text, and E4 is killed. With the opt-in real-PostgreSQL cell
    enabled, A4, E4 and E11 are also killed semantically by that cell.
- The independent gate ran these on PostgreSQL 15.17 (the major version the staging compose
  file pins), with the recovery-authority trigger enabled:
  - a normal deactivate committed;
  - while another session held the exclusive authority lock, the run aborted with
    `METASHEET_RECOVERY_AUTHORITY_BUSY`, wrote nothing and left one extra dump.

NOT RUN:

- Any dispatch against staging. Inspect waits for the independent gate. Repair waits for the
  owner to name the mode.
- Anything against production (out of scope by ruling).
- The live staging schema itself (out-of-band triggers or RLS). The live container's
  PostgreSQL version was not checked; the compose file pins 15.
