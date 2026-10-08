# Recovery Explicit Read Verification

## Target

- Base: `062614f4407b3d9bffc82dae266071b8a6e5e5bd`.
- Final code/design: `584d5a8becbed371c4b7d2902453670dd9b30aae`.
- Final code tree: `36ca73994d8389fe671e4118ec230643233593ca`.
- Branch: `codex/timemachine-recovery-explicit-read-20260915`.
- Production delta: canonical base-read extraction and explicit snapshot forwarding
  through existing formula masking. No copied permission rules or new grant.
- This report is a documentation-only child; remote CI and merge are separate gates.

## Evidence

| Gate | Result |
| --- | --- |
| Explicit read unit | 18/18 (12 policy, 6 structural wiring) |
| Permission-service, taint chokepoint, exact-anchor unit neighbors | 82/82 |
| Full exact-anchor production-route real DB | 29/29 |
| Fresh PostgreSQL migration / second replay | 396 entries / no-op |
| Core typecheck and explicit new-unit typecheck | PASS |
| New unit explicit ESLint | PASS |
| Production ESLint | Same baseline 1 no-extra-semi error, 194 warnings; no new lint delta |
| Diff check | PASS |

The new real-DB case creates a foreign base and a formula dependency on its field,
grants base read, obtains a recovery preview, then revokes only database base-read
permission while leaving request permissions stale. Execute must return 403, preserve
record data/version, and burn no token. Re-granting permits preview again. The first
fixture attempt omitted the formula dependency that suite cleanup had removed; it
did not exercise the intended path. The final case explicitly inserts the dependency.

Mutation: omit the access argument at `hasFullTableReadAccess` -> both the new AST
forwarding assertion and the real-DB case fail. The latter returns 200 instead of 403.
Restoration yields the complete passing matrices above. Restored route SHA-256:
`f652abf8b7506a8fef4871d6067ab5e163f7811e8b25faab8d0fae9e9b77835c`.

Commands (candidate root, dedicated synthetic database only):

```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/recovery-explicit-read-authority.test.ts tests/unit/multitable-permission-service.test.ts tests/unit/multitable-stored-data-taint-chokepoint.guard.test.ts tests/unit/multitable-exact-anchor-recovery-route.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-exact-anchor-route-wiring-realdb.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend run type-check
```

The real-DB run used dedicated `DATABASE_URL` and `METASHEET_REAL_DB_TEST_STEP=1`.
Fresh/replay retained existing workflow exclusions. Database fixture users, sheets,
records, foreign bases and backend connections were all zero after the suite. The
dedicated database was dropped and its isolated PostgreSQL process stopped. No real
tenant, external service or customer data was involved. Dependencies were reused;
no installation, lockfile or workflow changes. The unit is in default discovery;
the existing real-DB suite remains exact-excluded from no-DB CI and whole-file wired.

## Review and Limits

Sol high reviewed `a4e90410993379b9b0cdf068c38e726c0e7d1bb1` read-only:
P1=0/P2=1/P3=0. It correctly found that the recovery access result omitted the verified
tenant formerly inherited by the reconstructed request. Final fix `584d5a8...` retains
only canonical `requestAccess.authenticatedTenantId`, leaving database permissions
and the admin intersection intact. Three unit cases cover same-org allow, cross-org
deny and absent-tenant deny through the real canonical projection-base resolver.
Removing the tenant propagation produces two failures, including same-org access
returning false instead of true; restoration passes. Codex independently verified
this closure and final scope; no second model or external final-zero verdict is claimed.
The Sol session was closed. The final code reran the 100-unit and 29-real-DB matrices.
Synthetic Express identity with real route/queries/transactions is not login or
browser/UAT proof. The supplied snapshot is internal and already adjudicated; it is
not accepted from an API request. Normal HTTP callers retain their existing resolution.
This removes request reconstruction in the recovery read check, but does not finish
the worker's complete row/field/link/person policy or startup/provider composition.
The separate inactive-actor repair in PR #5735 is neither copied nor merged here;
future integration must retain both changes in recovery authorization and both new
cases in the common real-DB suite.
Ready/merge, flags, dispatch, deployment, production and hard-delete resurrection
remain outside this slice.
