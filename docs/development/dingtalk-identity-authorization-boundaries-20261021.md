# DingTalk identity and authorization boundaries — 2026-10-21

Owner approved implementation of the three reviewed identity/auth fixes, synthetic regression and PostgreSQL concurrency verification, and a PR. Merge, deployment, real UAT, Stream/lifecycle enablement and 50004 are excluded.

## Contract

1. An explicit disabled DingTalk grant cannot be re-enabled by self-bind. First binding with no grant and ordinary binding with an enabled grant remain supported. Administrator roles are unchanged.
2. Self-bind rechecks active/activated local-user state and directory ownership after acquiring the canonical users mutex. A directory takeover committed while OAuth is pending wins; self-bind must reject without identity or grant writes.
3. Email fallback is first association, not implicit replacement of an existing identity or directory-managed association. The identity/ownership check and write share one user lock. Identity-based login must also recheck its binding and grant after waiting, so a stale lookup cannot restore an administrator-replaced binding or admit revoked access. Same-person union/OpenID enrichment and container/web alternation remain supported, within the same corp. A known UnionID conflict is not overridden by a matching OpenID. A missing corp column may be completed only when the stored canonical identity key already proves the configured corp; unknown or other-corp keys do not authorize migration.
4. External DingTalk exchanges occur outside database transactions. Policy or database-read failure must not silently permit writes. No new flag, migration or identity namespace is introduced.

## Gates

| Gate | Required evidence |
| --- | --- |
| Unit policy | Disabled grant both modes, absent/enabled positive controls, identity conflict, same-person enrichment, read failure and second-corp negatives |
| Real PostgreSQL | Durable readback; concurrent grant revoke, directory takeover, user deactivation and identity install/replacement, with actual blocking-PID observation before writer commit |
| Regression | Existing OAuth/routes/OpenID-backfill/container suites retained |
| Quality | validate:all; affected gate wiring checks |
| CI | Every required check successful on the actual PR head; pending/skipped are not success |
| Delivery | Draft PR with exact evidence; no merge or deployment |

## Local verification

Base refreshed to `fc185559e7dbbd4bb70e0c68c2d4d170c6a50e2f`. The two incoming main commits only changed frontend files; every owned file remained byte-identical during the fast-forward.

- Before the fix: the initial 21-case database suite had 13 expected assertion failures and 8 passing controls; the 9 new policy unit cases all failed on unexpected admission.
- Final focused unit regression: 8 files, **204/204** tests (`identity-unit-final.log`). Existing assertions remain; transaction mocks now return the current user, grant and identity rows being rechecked.
- Final real PostgreSQL regression: 6 files, **79/79** tests (`identity-db-final.log`), including the new 28-case boundary suite and 10 observed lock-wait interleavings. No skipped tests. Only DingTalk transport is synthetic; SQL, transaction locks, constraints and persisted readback are real.
- Six guards were independently disabled: explicit grant denial, managed self-bind, identity ownership, post-lock grant recheck, current account gate and corp scope. The matching **14 named assertions failed**, then the exact source bytes were restored. The restored new suites passed **9/9 unit + 28/28 DB** (`identity-mutations.json`, `identity-mutations-complete.json`).
- All existing migrations applied to a dedicated temporary test database (`identity-migrate.log`). No schema migration is added, so there is no new migration rollback step.
- `pnpm validate:all`: **exit 0**, including plugin validation, lint, backend/frontend type checks and verification projects (`identity-validate-all-final.log`).
- Exact-head required CI is recorded in the PR verification table; local success does not substitute for those checks.

Logs remain in the session's remote artifact directory. They contain synthetic fixtures; no business tenant, account or credential evidence is included here.

Commands (database command requires a dedicated migrated test database):

```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-identity-boundaries.test.ts
EXPECT_DB=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/dingtalk-identity-boundaries.db.test.ts
pnpm validate:all
```

The database suite is explicitly wired into the required `test (20.x)` approval real-DB step and excluded from the no-database suite. The unit suite is picked up by the existing required unit glob. PR evidence records the final exact head and CI links separately.
