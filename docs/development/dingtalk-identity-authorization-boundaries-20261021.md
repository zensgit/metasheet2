# DingTalk identity and authorization boundaries — 2026-10-21

Owner approved implementation of the three reviewed identity/auth fixes, synthetic regression and PostgreSQL concurrency verification, and a PR. Merge, deployment, real UAT, Stream/lifecycle enablement and 50004 are excluded.

## Contract

1. An explicit disabled DingTalk grant cannot be re-enabled by self-bind. First binding with no grant and ordinary binding with an enabled grant remain supported. Administrator roles are unchanged.
2. Self-bind rechecks active/activated local-user state and directory ownership after acquiring the canonical users mutex. A directory takeover committed while OAuth is pending wins; self-bind must reject without identity or grant writes.
3. Email fallback is first association, not implicit replacement of an existing identity or directory-managed association. The identity/ownership check and write share one user lock. Identity-based login must also recheck its binding and grant after waiting, so a stale lookup cannot restore an administrator-replaced binding or admit revoked access. Same-person union/OpenID enrichment and container/web alternation remain supported, within the same corp. A known UnionID conflict is not overridden by a matching OpenID. A missing corp column may be completed only when the stored canonical identity key already proves the configured corp; unknown or other-corp keys do not authorize migration. When OAuth corp is unset (an existing supported configuration), a same-person login preserves the established stored corp and its key namespace. A rejected login may still learn the same person's missing OpenID, but must re-read the binding under the users mutex and skip enrichment after a concurrent replacement or removal.
4. External DingTalk exchanges occur outside database transactions. Policy or database-read failure must not silently permit writes. No new flag, migration or identity namespace is introduced.

## Gates

| Gate | Required evidence |
| --- | --- |
| Unit policy | Disabled grant both modes, current account gate and authorization-read failure; existing OAuth/routes/backfill assertions retained |
| Real PostgreSQL | Absent/enabled positive controls, identity conflict, same-person enrichment, optional-corp compatibility and second-corp negatives; durable readback after concurrent grant revoke, directory takeover, user deactivation and identity install/replacement, with actual blocking-PID observation before writer commit |
| Regression | Existing OAuth/routes/OpenID-backfill/container suites retained |
| Quality | validate:all; affected gate wiring checks |
| CI | Every required check successful on the actual PR head; pending/skipped are not success |
| Delivery | Draft PR with exact evidence; no merge or deployment |

## Verification evidence

The initial policy cases reproduced 13 database assertion failures and 9 unit assertion failures before implementation. Follow-up review reproduced six failures for optional-corp compatibility and rejected-login stale enrichment, then three failures for legacy key-only scope. These are synthetic fixtures against a dedicated migrated PostgreSQL database; no real DingTalk UAT or business database is involved.

When both the configured corp and stored corp are absent, enrichment preserves a canonical key prefix only by matching an exact known stored UnionID/OpenID suffix. It does not infer or populate a corp column from an arbitrary string. A later explicit corp configuration must still satisfy the existing canonical-key proof. The existing corp-less lookup ambiguity between different local users sharing provider identifiers is not changed by this write-boundary slice; deployments should configure their intended corp explicitly.

The focused suite includes real lock-wait interleavings, durable identity/grant/role/link readback, same-person positive controls, configured cross-corp negatives, rejected-login replacement races and optional-corp/legacy-key compatibility. The new database suite is wired into required `test (20.x)` and excluded from the no-database suite. Existing OAuth, routes, directory backfill, container, access-mutex and deprovision regression assertions remain.

Current exact-head counts, mutation results and CI links are maintained in the PR verification table. Remote artifact logs include `identity-review-red.log`, `identity-legacy-scope-expanded-red.log`, `identity-legacy-scope-green.log` and the final regression logs. No migration is introduced; existing migrations are applied to the isolated test database.

Commands (database command requires a dedicated migrated test database):

```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-identity-boundaries.test.ts
EXPECT_DB=1 pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/dingtalk-identity-boundaries.db.test.ts
pnpm validate:all
```
