# Attendance #4709 FSER-3 Apply/Rebuild Config Consumption Verification

Status: **IMPLEMENTED / HOLD FOR FRESH-MAIN EXACT-HEAD GATE**

- Ratified contract: `attendance-4709-fixed-schedule-effectiveness-read-model-design-lock-20260801.md`
- Original implementation base: `6b439a1ab05a8b2588e42f59499f9849bd3242b1`
- Fresh-main verification base: `e3dfe59d2e6038f96762865ad98bad42ad92920f`
- Scope: FSER-3 apply/rebuild desired-config consumption only
- Explicitly excluded: FSER-4, merge authorization, feature flags, deployment,
  soak, production or customer data, and closing #4556

## 1. Delivered behavior

Apply and rebuild now consume the desired fixed-schedule config inside their
existing transaction. They validate the group and finite date window, lock an
existing config row before target locks, reject stale revision or legacy-value
candidates with typed `409 ATTENDANCE_FIXED_SCHEDULE_CONFIG_CHANGED`, and use
the transactionally reloaded config as the materialization input.

When no config exists, the same path validates the candidate shift and a
non-empty current target set before `INSERT ... ON CONFLICT DO NOTHING`, reloads
the winner `FOR UPDATE`, and distinguishes identical from different concurrent
candidates. The existing canonical producer-key builder, result shape, target
lock ordering, overlap checks, and transaction boundary remain authoritative.
Route-level business failures are converted into an internal transaction-abort
exception so the database rolls back before the HTTP layer restores the exact
typed response shape.

The HTTP request accepts optional `expectedConfigRevision`; legacy finite
candidates remain compatible only when all three values equal the locked row.
Open-ended direct apply is now rejected because the ratified desired-config
record requires a finite start and end date.

## 2. Focused automated evidence

Results run locally on 2026-08-04 and repeated after the fresh-main rebase:

| Spec | Result | Contract |
| --- | ---: | --- |
| `attendance-group-fixed-schedule-config-consume.test.ts` | 21/21 PASS | first-create, stale 409, transaction rollback, lock order, canonical builder, response shape |
| `attendance-scheduling-assignment-conflict.test.ts` | 22/22 PASS | existing producer/conflict/rebuild behavior under config consumption |
| `attendance-uuid-validation-routes.test.ts` | 87/87 PASS | HTTP schema, typed stale response, permission and zero-write route behavior |
| `attendance-group-fixed-schedule-config-consume.db.test.ts` | 5/5 PASS | real PostgreSQL atomicity and two-connection convergence |
| `attendance-plugin.test.ts` | 163/163 PASS | complete HTTP integration, actual apply/rebuild config/assignment success and rollback residue |
| FSER migration/effectiveness + W3 writer matrix | 63/63 PASS | existing schema/read model and writer behavior |
| sealed-export package provenance | PASS | required pin refreshed for the changed `plugin-tests.yml` evidence file |

The real-DB suite uses a fresh schema and proves both identical-candidate
convergence and different-candidate one-winner/typed-409 behavior without a
losing materialization effect. The full HTTP integration suite also contains
the stronger actual-table assertions: successful first legacy apply creates
both config and managed assignment; a first apply that hits a real assignment
conflict leaves zero config and zero managed assignment residue.

That HTTP leg found and closed one real implementation defect before this
record was finalized. The first draft returned a business-error object from the
transaction callback, so PostgreSQL committed the first-created config while
the route rendered a `409`. The route now throws an internal sentinel inside
the transaction and renders the same response only after rollback. A focused
unit leg kills removal of that throw, and separate real HTTP apply and rebuild
assertions prove zero config and zero assignment rows after each conflict.

## 3. Existing-call compatibility correction

The first broad regression run exposed six old direct-call fixtures that knew
nothing about the new config lock, plus one real HTTP scenario that changed a
group window by calling apply directly. Those were not waived:

1. direct-call fixtures now model the finite desired config and its pre-target
   lock;
2. the obsolete open-ended direct apply expectation is now a validation-negative
   while the producer-key builder retains its separate null-window unit proof;
3. the HTTP scenario saves the changed desired config first, reads revision 2,
   and passes that revision to apply/rebuild.

The repaired existing unit suite is included in the 22/22 result above.

## 4. Mutation evidence

Five focused mutations were executed against the restored baseline:

1. removing `ON CONFLICT DO NOTHING` makes both real concurrent legs fail with
   PostgreSQL `23505` instead of convergence / typed `409`;
2. weakening the config row lock from `FOR UPDATE` to `FOR SHARE` makes both
   apply and rebuild lock-order legs fail;
3. replacing the canonical producer-key call with raw concatenation makes the
   dedicated canonical-source leg fail;
4. returning the business error from the transaction callback instead of
   throwing makes the rollback leg fail because the promise resolves and the
   staged write commits;
5. bypassing the aborting wrapper on the rebuild route makes the real HTTP
   rebuild-conflict leg fail (`500` instead of the typed `409`) before it can
   accept any residue claim.

All mutations were restored; the focused unit suite returned to 21/21 and the
real concurrency suite returned to 5/5.

## 5. Honest remaining gates

Before FSER-3 may be presented for merge consideration, the final rebased PR
head still requires:

1. rebase onto fresh `main` and repeat the affected focused / real-DB evidence;
2. backend typecheck, diff check, and fresh required GitHub checks;
3. independent exact-head review with zero open P1/P2.

An earlier complete-HTTP attempt was discarded after the local Docker engine
stopped with `no space left on device`; it is infrastructure evidence only and
is not counted as a product result. The 163/163 result above came from a newly
created, fully migrated isolated database after that incident. Passing all
remaining gates still does not authorize merge or FSER-4.
