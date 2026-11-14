# DingTalk group credential incident repair — 2026-10-30

This patch preserves the reviewed repair core and its real PostgreSQL regression tests. It is an explicit operator tool for one frozen table/field scope, with 49 rows, 97 nonempty credential fields and four independently stored application ciphertext canaries. It is not a general database-wide key rotation API.

The core updates only `public.dingtalk_group_destinations.webhook_url` and `secret`, using the application's existing encryption material. It preserves exact bytes, checks canaries, pins database identity and scope digests, locks the table, uses CAS and decrypted readback, and commits all rows together. A matching completed scope replays with zero updates. Partial or changed scopes fail closed; a lost COMMIT acknowledgement requires read-only verification. Custom triggers are refused.

The restore helper requires TABLE and TABLE DATA from a custom dump. It restores only the reviewed table into a temporary database, validates recovered rows against the private scope digest, and records cleanup privately. Active temporary connections are terminated on cleanup; cleanup failures stop further attempts. The operator role must be able to create/drop the temporary database and terminate its own restore sessions.

Provider-side credential rotation, key changes, deployment and outbound enablement are separate owner decisions. Encrypting stored credentials does not revoke copies in older backups. Do not execute against production from an unattended cron or infer authority from a CLI flag.

The environment-specific SSH/Docker entry point, approval reference, private plan, backups and credential-related digests are deliberately excluded from this patch. Production execution uses its independently frozen runbook and controlled entry point. Source code alone does not establish target identity, backup readiness or owner approval.

## Reproduce in a disposable PostgreSQL cluster

Use Node 20, pnpm and PostgreSQL 16. The restore fixture defaults to the existing Homebrew PostgreSQL 16 binaries; set `PG_BIN_DIR` to another PostgreSQL 16 binary directory. CI runs on GitHub-hosted Ubuntu with PostgreSQL 16. Do not point these tests at an application database. They create and remove synthetic test databases.

From `packages/core-backend`:

```sh
DATABASE_URL='<disposable test cluster>' pnpm exec vitest run --config vitest.credential-repair-20261030.config.ts
DATABASE_URL='<same disposable test cluster>' python3 scripts/ops-tests/dingtalk-backup-restore-20261030.py
```

The `.case.ts` fixture is intentionally outside default test filename discovery; the explicit config fails without a database. The dedicated `DingTalk credential repair` workflow runs both test files with a real disposable database on every matching PR update; this does not add skip-green tests or modify an existing required CI lane. No runtime flag, migration, provider send or database key is added by the patch.

The scoped production execution and delivery patch are separate evidence. Applying or merging the patch does not run a backfill. Public reports contain only counts, status and source fingerprints; never include material, raw credentials, stored ciphertext, application IDs or private scope/environment digests.
