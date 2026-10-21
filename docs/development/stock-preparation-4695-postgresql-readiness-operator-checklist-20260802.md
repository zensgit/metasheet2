# Stock-Preparation #4695 — PostgreSQL Readiness Operator Checklist (values-free)

Date: 2026-08-02
Scope: issue #4695 readiness fields only. This document converts the two `UNKNOWN`
readiness items (`canCreateIsolatedTestDatabase`, `canCreateSelectOnlyTestPrincipal`)
and the role/migration readiness questions into executable, read-only checks and a
mechanically derived rule set, so an operator or DBA can answer #4695 without making
any design decision.

## 0. What this checklist does NOT authorize

This is preparation guidance only. Executing the read-only checks in Part A mutates
nothing. Nothing in this document authorizes:

- package download to an entity machine, software installation, or deployment;
- database creation, principal/role creation, or running migration 073;
- any change to `MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED`
  (default and final state: OFF);
- provisioning, flag-ON execution, retry, rollout, or any external write.

Issue #4695 governs authorization. #4695 requires the readiness reply to be produced
with **no mutating commands**; every command in Part A is a read-only `SELECT`/`SHOW`.
A passing PostgreSQL run, if later authorized, is controlled synthetic functional
evidence only; it does not establish real-customer production, sealed-snapshot
semantics, high scale, external write, rollout, or PLM/ERP/CRM/SRM generalization.

## 1. Provenance of every rule in this document

All rules below are extracted mechanically from three repository files. All three are
blob-identical between the frozen S6-A runtime SHA
`a45a2fe3fa818b6b90830418a55a6b9f635e91c9` and current `main` (verified via
`git rev-parse <sha>:<path>` blob comparison on 2026-08-02), so this checklist
describes both the frozen package contents and `main`:

| Source | Cited as |
|---|---|
| `packages/core-backend/migrations/073_create_sealed_export_stock_prep_runtime_authority.sql` | `073:<line>` |
| `plugins/plugin-integration-core/lib/sealed-export/stock-preparation-runtime-config.cjs` | `config:<line>` |
| `plugins/plugin-integration-core/scripts/provision-stock-preparation-sqlserver-sealed-snapshot.cjs` | `provision:<line>` |
| `plugins/plugin-integration-core/lib/sealed-export/stock-preparation-runtime-database.cjs` | `db:<line>` |
| `plugins/plugin-integration-core/lib/sealed-export/stock-preparation-runtime-provisioning.cjs` | `prov-svc:<line>` |
| `packages/core-backend/src/db/migration-provider.ts` | `provider:<line>` |

Placeholders in angle brackets (for example `<RUNTIME_ROLE>`) are placeholders chosen
by the deployment, never repository constants and never example values. Do not paste
real role names, database names, hostnames, URLs, or credentials into any reply.

## 2. Part A — Read-only precondition checks (answer #4695 before touching anything)

### A1. Test-machine six-field lane (`canCreate*` fields)

Run as the administrative account that would later perform the creation, connected to
the candidate PostgreSQL service. Each command is read-only.

1. Engine major version (readiness field `postgresMajorVersion`):

   ```sql
   SHOW server_version;
   ```

   Repository evidence exists only for major 15 (`.github/workflows/smoke-verify.yml`,
   `postgres:15` service container, `workflow_dispatch`, `SMOKE_DATABASE_URL`) and
   major 16 (`.github/workflows/sealed-export-s5-sqlserver.yml:147`, `postgres:16`).
   There is no `postgres:17` reference anywhere in the repository (re-derived
   2026-08-02). A major-17 answer therefore does not fail this checklist but cannot be
   promoted to "validated" by it.

2. `canCreateIsolatedTestDatabase` — the capability question is whether the admin
   account holds `CREATEDB` (or superuser):

   ```sql
   SELECT rolcreatedb OR rolsuper AS can_create_database
   FROM pg_roles WHERE rolname = current_user;
   ```

   `true` → answer `YES`; `false` → answer `NO`. Optionally confirm the candidate
   database name is unclaimed (still read-only):

   ```sql
   SELECT COUNT(*) FROM pg_database WHERE datname = '<ISOLATED_DB_NAME>';
   ```

   `0` means the name is free. What "isolated" means concretely (which name, same
   cluster or not) is fixed by the later exact instruction, not by this checklist.

3. `canCreateSelectOnlyTestPrincipal` — the capability question is whether the admin
   account holds `CREATEROLE` (or superuser):

   ```sql
   SELECT rolcreaterole OR rolsuper AS can_create_role
   FROM pg_roles WHERE rolname = current_user;
   ```

   `true` → answer `YES`; `false` → answer `NO`. Granting `SELECT` inside a database
   the same admin created is covered by ownership of that database's objects; which
   relations the principal must be able to read is fixed by the later exact
   instruction (see Part G item 1).

### A2. Entity-lane role and migration readiness fields

Run as the exact PostgreSQL user that will apply migration 073 (this matters: two of
the predicate branches compare against `current_user`; run as anyone else and the
answer is about the wrong principal — `073:506-507`). All commands are read-only.

1. `rolesExistBeforeMigration073`:

   ```sql
   SELECT COUNT(*) FROM pg_roles
   WHERE rolname IN ('<RUNTIME_ROLE>', '<PROVISIONING_ROLE>');
   ```

   `2` → `YES`. Anything else → `NO` (migration 073 will fail closed, F3 below).

2. Migration-073 safety predicate, evaluated read-only before any migration run. This
   query is the exact predicate of `073:498-518` re-expressed as a `SELECT`; a role
   passes migration 073 if and only if `passes_073_safety_predicate` is `true`:

   ```sql
   SELECT
     r.rolname,
     NOT (
       r.rolsuper
       OR r.rolcreatedb
       OR r.rolcreaterole
       OR r.rolreplication
       OR r.rolbypassrls
       OR NOT r.rolcanlogin
       OR r.rolinherit
       OR r.rolname = current_user
       OR pg_has_role(r.rolname, current_user, 'MEMBER')
       OR EXISTS (
         SELECT 1 FROM pg_auth_members m
         WHERE m.member = r.oid OR m.roleid = r.oid
       )
     ) AS passes_073_safety_predicate
   FROM pg_roles r
   WHERE r.rolname IN ('<RUNTIME_ROLE>', '<PROVISIONING_ROLE>');
   ```

   Expect exactly two rows, both `true`. Zero or one row → a role does not exist (F3).

3. Mutual-inheritance check (`073:521-528`; run only after A2.1 returned `2`, because
   `pg_has_role` errors on a nonexistent role name):

   ```sql
   SELECT pg_has_role('<RUNTIME_ROLE>', '<PROVISIONING_ROLE>', 'MEMBER')
       OR pg_has_role('<PROVISIONING_ROLE>', '<RUNTIME_ROLE>', 'MEMBER')
       AS roles_inherit_each_other;
   ```

   Must be `false`.

4. `migration073AlreadyRecorded` — migration 073 is a plain-SQL migration applied
   through the Kysely runner (`provider:186-187`), recorded in the Kysely tracking
   table (`provider:32`):

   ```sql
   SELECT COUNT(*) FROM kysely_migration
   WHERE name = '073_create_sealed_export_stock_prep_runtime_authority';
   ```

   `0` → `NO` (expected for the first accepted path per #4695); `1` → `YES`, in which
   case run A2.5 before doing anything else.

5. Latent-grant detection (only meaningful when A2.4 returned `1`). Migration 073
   succeeds **without granting anything** when neither role setting was supplied
   (`073:462-466`, `RAISE NOTICE ... privilege grants remain latent`). Detect that
   state read-only:

   ```sql
   SELECT
     has_table_privilege('<RUNTIME_ROLE>',
       'integration_sealed_export_stock_prep_runs', 'SELECT')
       AS runtime_grants_applied,
     has_table_privilege('<PROVISIONING_ROLE>',
       'integration_sealed_export_stock_prep_bindings', 'SELECT')
       AS provisioning_grants_applied;
   ```

   Run A2.1 first: `has_table_privilege` errors on a nonexistent role, and
   "recorded but roles absent" already proves the latent state on its own.
   If migration 073 is recorded and either column is `false`, the migration was
   recorded latent. STOP and report; do not re-run the SQL file by hand and do not
   enable the flag (existing rule:
   `docs/operations/stock-preparation-s6a-sqlserver-onprem-runbook-20260731.md`,
   "If migration 073 was already recorded without the two grants, stop").

6. Setting-delivery self-check, in the session that would run migrations, after
   exporting `PGOPTIONS` per the runbook and before running anything:

   ```sql
   SELECT
     current_setting('metasheet.sealed_export_runtime_role', true)
       AS runtime_role_setting,
     current_setting('metasheet.sealed_export_provisioning_role', true)
       AS provisioning_role_setting;
   ```

   Both must be non-empty and distinct (`073:450-457, 462-476`). `NULL`/empty in both
   → the migration would apply latent (A2.5 state). Exactly one set → hard failure F1.

## 3. Part B — The two roles are deployment inputs

The repository fixes **no** role names. Migration 073's header states they are
deployment inputs supplied at migration time (`073:4-8`):

```text
-c metasheet.sealed_export_runtime_role=<RUNTIME_ROLE>
-c metasheet.sealed_export_provisioning_role=<PROVISIONING_ROLE>
```

The #4695 readiness-reply template pins the exact identifiers that particular
deployment must echo; read them from #4695 directly — this document deliberately does
not restate them. Whatever names the deployment chooses must satisfy all of the
following simultaneously, or migration 073 fails closed:

| # | Constraint | Source |
|---|---|---|
| B1 | Both settings supplied together (never only one) | `073:467-471` |
| B2 | The two names are distinct | `073:472-476` |
| B3 | Each role exists in `pg_roles` before the migration runs | `073:480-497` |
| B4 | `NOSUPERUSER` (`rolsuper = false`) | `073:499` |
| B5 | `NOCREATEDB` (`rolcreatedb = false`) | `073:500` |
| B6 | `NOCREATEROLE` (`rolcreaterole = false`) | `073:501` |
| B7 | `NOREPLICATION` (`rolreplication = false`) | `073:502` |
| B8 | `NOBYPASSRLS` (`rolbypassrls = false`) | `073:503` |
| B9 | `LOGIN` (`rolcanlogin = true`) — the role must authenticate directly | `073:504`, `db:125-131` |
| B10 | `NOINHERIT` (`rolinherit = false`) | `073:505` |
| B11 | Not the same role as the migration-applying user | `073:506` |
| B12 | Not a member (direct or indirect) of the migration-applying role | `073:507` |
| B13 | Zero rows in `pg_auth_members` in either direction: the role is a member of nothing, and nothing is a member of it | `073:508-514` |
| B14 | The two roles do not inherit each other in either direction | `073:521-528` |

Note B13 subsumes B14 for direct and chained memberships (any chain has a
`pg_auth_members` row touching the candidate); B14 remains as defense in depth, so
both error messages are listed in Part C.

### B13 caveat — PostgreSQL 16+ `CREATEROLE` auto-grants the membership B13 forbids

**This is the single most likely way a correct-looking DBA procedure fails B13, and
nothing in the migration says so.**

From PostgreSQL 16 onward, a **non-superuser** role holding `CREATEROLE` is
automatically granted membership **WITH ADMIN OPTION** in every role it creates. That
automatic grant is a `pg_auth_members` row whose `roleid` is the newly created role, so
B13 (`073:508-514`, and the identical preambles at `074:121-127` and `075:164-170`) is
violated the instant the role exists — even though every one of B4–B12 passes and the
`CREATE ROLE` statement matched the runbook text character for character.

The related GUC is **`createrole_self_grant`** (also new in 16). Read its default
carefully before relying on it: it controls only whether `SET` and/or `INHERIT` ride
along on that automatic grant. It does **not** control whether the `pg_auth_members` row
exists, and leaving it at its default does **not** suppress the row. Searching for
`createrole_self_grant` is how most operators will arrive at this section; the setting is
the signpost, not the fix.

On PostgreSQL 15 and earlier the automatic grant does not happen, which is why a
procedure that worked on 15 can fail on the same host after a major upgrade.

Detection (run as any role that can read the catalogs, before migrating):

```sql
SELECT r.rolname, count(m.*) AS membership_rows
FROM pg_roles r
LEFT JOIN pg_auth_members m ON m.roleid = r.oid OR m.member = r.oid
WHERE r.rolname IN ('<RUNTIME_ROLE>', '<PROVISIONING_ROLE>')
GROUP BY r.rolname;
```

Both counts must be `0`. Any non-zero count is B13, and migration 073 will abort with
F4 (`sealed-export role has unsafe authority`) without naming the cause.

Remediation, in order of preference:

1. **Create the two roles as a `SUPERUSER`.** A superuser's `CREATE ROLE` produces no
   automatic membership on any version. This is what the vitest lane and the CI
   role-bound arm both do, so it is the path with coverage.
2. If the roles must be created by a `CREATEROLE` non-superuser, **revoke the automatic
   grant before migrating** — `REVOKE "<RUNTIME_ROLE>" FROM "<creating-role>";` and the
   same for the provisioning role — then re-run the detection query and require `0`.
   Note that revoking the ADMIN OPTION removes the creator's ability to drop or alter
   that role afterwards on 16+, so confirm the ownership model first.

Do **not** attempt to relax the predicate, and do not edit migration 073, 074 or 075 to
work around this. Beyond the ordinary rule that applied migrations are not amended, 073
is a content-digest pin of the frozen S6-A package
(`plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`
→ `migrations."073"`, asserted by `verifyPinnedMigrations` in
`sealed-export-package-provenance.cjs`), so a one-byte edit invalidates the package.

**Why this caveat is here and not in the runbook.**
`docs/operations/stock-preparation-s6a-sqlserver-onprem-runbook-20260731.md` is itself a
frozen runtime-file pin (`runtimeFiles.s6aOnpremRunbook` in the same pins file, asserted
by `verifyPinnedRuntimeFiles`), so its §2 cannot be amended without breaking the frozen
package. This checklist is not pinned and is the correct place for it. Read runbook §2
for the role-creation procedure and this section for the PostgreSQL 16+ caveat that §2
predates.

**Where this is now proven.** `.github/workflows/stock-prep-main-package-verify.yml` job
`migrate-postgres-role-bound` reproduces exactly this on the PG16 and PG17 legs: a
`CREATEROLE` non-superuser creates the roles with default `createrole_self_grant`, every
other predicate leg is measured passing on those same roles, and the migration run must
be REFUSED with `sealed-export role has unsafe authority`. The PG15 leg asserts the
contrast — no automatic membership — so the version boundary above is measured, not
assumed.

The same job carries the POSITIVE arm: roles created with §2's attribute set, `PGOPTIONS`
exported per §2, and then the grants measured directly — which is the only way to
distinguish "migration recorded" from "grants landed", since the latent branch records the
migration too and its `NOTICE` is never printed by the Node runner.

It lives in that lane and not in
`.github/workflows/stock-prep-s6a-postgres17-validation.yml` for a structural reason worth
knowing before reading either lane's evidence: the frozen S6-A asset the PG17 lane pins
**predates migrations 074 and 075** (#4695, 2026-08-04 disclosure). Dispatching the
role-bound arm there failed all three legs at `--confirm 074…` with exit 2, "not found
among the known migrations" (run 32136846204). A green PG17-lane run therefore says
nothing about 074/075 at all; only the build-from-commit lane can. The role-bound job
derives the three ledger names from the packaged migrations directory rather than
hardcoding them, so this class of mismatch fails loudly at the derive step instead of
part-way through an assertion.

Consequence of B9 + `db:125-131`: each database URL later supplied to the runtime or
provisioning path must authenticate **as the role itself**. Connecting as some other
login and issuing `SET ROLE` fails the readiness assertion, because `session_user`
must also equal the expected role.

## 4. Part C — Failure-mode table (what the operator will actually see)

### C1. Migration-time outcomes (running migration 073)

All errors below carry `SQLSTATE 55000` (`object_not_in_prerequisite_state`) and abort
the migration run. After remediation, re-run the migration entry point and re-check
recording state with A2.4.

| ID | Exact message | Trigger condition | Operator action |
|---|---|---|---|
| F0 (not an error) | NOTICE: `sealed-export roles are not configured; privilege grants remain latent` | Neither setting supplied (or both empty) — `NULLIF(..., '')` treats empty as unset | Migration succeeds with **no grants**. Acceptable only for latent/default-OFF environments; for an accepted S6-B path this is the A2.5 STOP state. `073:450-466` |
| F1 | ERROR: `sealed-export runtime and provisioning roles must be configured together` | Exactly one of the two settings supplied | Supply both `-c` settings in the same session; verify with A2.6. `073:467-471` |
| F2 | ERROR: `sealed-export runtime and provisioning roles must be distinct` | Both settings name the same role | Choose two different names (B2). `073:472-476` |
| F3 | ERROR: `sealed-export role does not exist` | A named role has no `pg_roles` row | Create the missing role first (when authorized), with exactly the Part B attributes; verify with A2.1/A2.2. `073:480-497` |
| F4 | ERROR: `sealed-export role has unsafe authority` | Any single branch of B4–B13 fails for either role | Run A2.2 to identify which role fails; recreate or `ALTER ROLE`/`REVOKE` (when authorized) until A2.2 shows `true` for both. The message intentionally does not say which branch failed — A2.2 is the diagnostic. `073:498-518` |
| F5 | ERROR: `sealed-export runtime and provisioning roles must not inherit each other` | `pg_has_role` reachable in either direction between the two roles | Remove the membership path (when authorized); verify with A2.3. `073:521-528` |

**F4 on PostgreSQL 16 or 17 — check B13 first.** F4 covers eight branches with one
message, and on 16+ the overwhelmingly most common branch is B13, because a
non-superuser `CREATEROLE` DBA is auto-granted ADMIN OPTION membership in the roles it
creates. If the roles look correct in every attribute and F4 still fires, run the
`pg_auth_members` detection query in "B13 caveat — PostgreSQL 16+ `CREATEROLE`
auto-grants the membership B13 forbids" (Part B) before touching anything else. The
related setting to search for is `createrole_self_grant`; note that it does not suppress
the row.

### C2. Post-migration trigger errors (also `SQLSTATE 55000` — not operator errors)

These fire on `UPDATE` of the two S6-A tables after migration 073 succeeded. They are
runtime invariants, not provisioning mistakes; an operator seeing one must not attempt
a DBA-side "fix". Record and escalate.

| Exact message | Fires when | Source |
|---|---|---|
| `sealed-export stock-prep binding anchors are immutable` | An UPDATE changes any anchor column of a binding row | `073:237-279` |
| `sealed-export stock-prep run identity is immutable` | An UPDATE changes a run's identity columns | `073:285-306` |
| `sealed-export stock-prep run anchors are immutable` | An UPDATE overwrites an already-set run evidence field | `073:308-346` |
| `sealed-export stock-prep run transition is invalid` | An UPDATE moves a run's status outside the allowed transition edges | `073:348-367` |

### C3. Provisioning-script outcomes (closed tokens, values-free by construction)

The provisioning script emits exactly one JSON line and nothing else. Failure shape
(`provision:34-42`):

```json
{"code":"<CLOSED_TOKEN>","ok":false,"valuesFree":true}
```

with process exit code 1. `code` is always a member of the closed 30-token vocabulary
(`plugins/plugin-integration-core/lib/sealed-export/failure-vocabulary.cjs:48-79`);
any undeclared reason is collapsed to `SEALED_EXPORT_INTERNAL_ERROR`. Causes an
operator can produce, all reported as `SEALED_EXPORT_INTERNAL_ERROR`:

| Cause | Source |
|---|---|
| Any required environment variable missing, empty, padded with whitespace, containing control characters, or over-length (4096 general; 128 for role names and the qualification key id) | `config:65-81, 193, 196, 217-218, 222` |
| Artifact root not an absolute path | `config:207-210` |
| A key file missing, not a regular file, or outside 32–128 bytes (evidence/identity/qualification keys) | `config:83-105` |
| Signer key file not a parseable PEM ed25519 private key, or over 16 KB | `config:107-127` |
| Spec file not valid JSON, over 64 KB, wrong top-level keys, wrong `binding`/`externalSystem` field sets, or either `workspaceId` not null | `config:39-63, 148-168` |
| Database connection succeeded but `current_user` or `session_user` differs from the configured expected role (e.g. URL authenticates as a different login, or relies on `SET ROLE`) | `db:115-131` |
| A structurally invalid spec object reaching the service | reported instead as `SEALED_EXPORT_BINDING_UNQUALIFIED`, `prov-svc:52-59` |

Success shape (`provision:33`): one line
`{"ok":true,"changed":...,"externalWrite":false,"qualificationCurrent":true,"signerEnrolled":true,"valuesFree":true}`
(field set per `prov-svc:151-157`).

## 5. Part D — Environment variables (complete set, from the `ENV` table)

All names below are the complete, closed set defined at `config:13-38`. Nothing else
is read by these two paths. "Required" is per-path: when a path runs, every variable
listed for it is mandatory (there are no optional variables within an active path);
the feature flag is the only switch.

Feature flag — `MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED`
(`config:13-14`): only the exact value `true` (case-insensitive, trimmed) enables the
runtime (`config:129-131, 176`); any other value, including unset, yields
`{ enabled: false }` and **no other runtime variable is read** (`config:176-177`).
Default and final state for #4695 is OFF; this checklist does not authorize changing it.

| Environment variable (suffix after `MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_`) | Runtime path (flag ON) | Provisioning path | Constraint | Source |
|---|---|---|---|---|
| `ARTIFACT_ROOT` | required | required | absolute path | `config:16-17, 179-182, 207-210` |
| `EVIDENCE_KEY_FILE` | required | not read | regular file, 32–128 bytes | `config:18-19, 189, 99-105` |
| `IDENTITY_KEY_FILE` | required | required | regular file, 32–128 bytes | `config:20-21, 190, 213` |
| `QUALIFICATION_KEY_FILE` | required | required | regular file, 32–128 bytes | `config:22-23, 194, 223` |
| `QUALIFICATION_KEY_ID` | required | required | non-empty, ≤128 chars | `config:24-25, 193, 222` |
| `PROVISIONING_DATABASE_ROLE` | not read | required | non-empty, ≤128 chars; must equal the connection's `current_user` and `session_user` | `config:26-27, 217-218`, `db:125-131` |
| `PROVISIONING_DATABASE_URL` | not read | required | non-empty, ≤4096 chars; authenticates directly as the provisioning role | `config:28-29, 219-220` |
| `PROVISIONING_SPEC_FILE` | not read | required | JSON ≤64 KB, exact field sets, null `workspaceId` | `config:30-31, 225, 148-168` |
| `RUNTIME_DATABASE_ROLE` | required | not read | non-empty, ≤128 chars; must equal the connection's `current_user` and `session_user` | `config:32-33, 196`, `db:125-131` |
| `RUNTIME_DATABASE_URL` | required | not read | non-empty, ≤4096 chars; authenticates directly as the runtime role | `config:34-35, 197` |
| `SIGNER_PRIVATE_KEY_FILE` | required | required | PEM ed25519 private key, ≤16 KB | `config:36-37, 183-185, 214-216, 107-127` |

Note the provisioning path does **not** consult the feature flag
(`loadStockPreparationProvisioningConfig`, `config:201-227`, contains no
`featureEnabled` call): provisioning is designed to run while the flag is OFF. Running
it is nevertheless a mutating step and is not authorized by this checklist.

## 6. Part E — Where the provisioning script fits

`plugins/plugin-integration-core/scripts/provision-stock-preparation-sqlserver-sealed-snapshot.cjs`
is the Phase-4 one-shot that writes the initial ACTIVE binding. Sequence position:
after migration 073 has been applied **with grants** (Part C1 success, A2.5 both
`true`) and before any flag-ON window.

What it does (`provision:17-54`, `prov-svc:49-158`):

1. loads the provisioning environment (Part D column 3) — no flag check;
2. opens a role-bound pool (max 2 connections, application name
   `metasheet-s6a-stock-preparation-provisioning`) and asserts
   `current_user`/`session_user` equal the configured provisioning role
   (`db:42-46, 115-131, 165-171`);
3. validates the spec shape, derives the source anchors, probes and verifies source
   qualification for the single approved binding (`prov-svc:50-108`);
4. enrolls the signer public key and persists the initial stock-prep binding through
   the lifecycle provisioning service (`prov-svc:109-150`);
5. prints exactly one values-free JSON line and exits (0 on success, 1 on failure),
   closing the pool either way (`provision:33-51`).

What it does NOT do: it does not create databases or roles, does not run or record
migrations, does not read or change the feature flag, does not start the runtime,
does not write to the external source (`externalWrite:false`, `prov-svc:153`), does
not retry, and does not print any value beyond the closed token set.

## 7. Part G — What this checklist could NOT determine (left explicitly open)

> **There is no Part F.** The lettering runs A, B, C, D, E, G — `G` is for *gaps*. No
> section is missing and nothing in this document references a Part F; if you were
> looking for one, you have the complete checklist.

1. The M1 test packet's own privilege and fixture SQL: the packet referenced by #4695
   (draft, SHA-256 `ff3fe07c051468ba7147969fa7b2ee111eb70015056a3de23f6a62cc77b68c28`)
   is not published and not in the repository, so the concrete isolated-database name
   and the exact relations the SELECT-only test principal must read cannot be derived
   here. The A1 checks answer the **capability** fields; the later exact instruction
   supplies the specifics.
2. PostgreSQL 17 validation: no `postgres:17` exists anywhere in the repository.
   This checklist cannot and does not certify major 17.
3. The Kysely tracking table is cited by its default name `kysely_migration`
   (`provider:32`). If a deployment relocated it to a non-default schema, the A2.4
   query must be schema-qualified by the operator; this repository defines no such
   relocation.
4. Whether the entity deployment's migration owner account satisfies A2's
   "run as the migration-applying user" requirement is a deployment fact only the
   operator can observe; the checklist provides the query, not the answer.
