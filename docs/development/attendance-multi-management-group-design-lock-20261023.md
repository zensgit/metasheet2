# Attendance management-group membership policy — 2026-10-23

Owner-authorized slice: an organization setting for multiple management attendance groups, default OFF. Implementation is aligned to main `663faa529f71e41ed4c5b4a7787645ce0b89ab70`. PR stays Draft; no deployment, R71/tag/release changes, Stream/lifecycle enablement, real UAT or business error code 50004 work.

## Contract

- The attendance admin settings panel loads explicitly and shows the committed policy separately from the proposed checkbox value. An unknown result requires refresh; late responses from a stale session are discarded.
- GET/POST `/api/attendance/group-membership-policy?orgId=<selected>` require attendance administration authority and active membership of the authenticated organization. A selector cannot change that binding.
- Success is `{ok:true,data:{orgId,allowMultipleGroups,version}}`. POST accepts exactly `{allowMultipleGroups:boolean,expectedVersion:nonnegative safe integer}`. No coercion or unknown fields; malformed input is 400 and stale versions are 409.
- Absent policy means false/version 0. Only an actual boolean transition increments the version. Persistence is per organization in `attendance_management_group_policies`, independent of the global settings document. No new env flag.
- OFF rejects a NEW second management-group membership, including two new groups in one batch. ON permits multiple management groups.
- Existing multiple memberships, same-group idempotency, removals and non-membership edits remain valid. No membership cleanup or historical recalculation. Calculation-group effective-date and no-overlap constraints stay unchanged.

## Enforcement and lock order

A sibling CJS policy implementation is shared by plugin and core. The decision and member INSERT share a transaction. Organization serialization uses the existing timezone-source prefix before sorted organization/user admission locks. A policy row write fence rejects SERIALIZABLE snapshots predating a committed policy transition. Group UUID comparison is canonicalized; user ID text is not case-folded.

All four production writers are covered: member POST, legacy import helper, admin onboarding and frozen legacy import group effects. Frozen plans check current admission as a precondition under the transaction lock. The immutable effects adapter verifies an organization/assignment/transaction capability; it does not reread settings/policy or recompute frozen existence branches.

The null-version reservation helper takes the organization prefix FIRST within its original helper deadline, ahead of rollout/reservation/job locks and revision-triggering DML. Direct legacy import transactions take it before idempotency and business writes. This avoids the revision-row/organization-lock cycle with concurrent member admission. Original budgets and error classification remain intact.

## Verification gates

| Gate | Actual evidence |
| --- | --- |
| Backend policy/auth/frozen boundaries | P1-affected three files: 69/69 actual assertions; earlier admission/UUID/calculation neighbors retained without repeating unchanged suites |
| UI/session and neighbors | Policy panel 24/24; timezone/session neighbors 42/42 |
| Web execution registration | Workflow shape 32/32; token-manifest guard 29/29; registered in domain and required lanes |
| Real PostgreSQL | Five complete files 117/117, including installed production revision triggers, policy toggle/CAS races and missing/cross-transaction effects capabilities |
| Real onboarding endpoint | Seven cases 7/7, including actual rollback after a synthetic DB-side first assignment causes second-group refusal |
| Mutation controls | Removing the new prefix produces one matching red with PostgreSQL 40P01; bypassing admission capability produces two unit and two PG reds; UI ACK/envelope mutations produce one/two matching reds |
| Restoration | Mutated production sources restored to original hashes; filtered tests reported as excluded, never counted as passes |
| Schema/contracts/quality | 456 migrations applied, pending 0; OpenAPI/SDK guard and validation exit 0; pnpm validate:all exit 0 |
| UI evidence | Synthetic desktop/mobile screenshots under artifacts/attendance-group-membership-policy; all non-fixture browser requests blocked |

Normal suites have no skipped/pending assertions. Mutation execution counts are separate from passing-suite counts. The isolated UTF-8 PostgreSQL cluster is stopped and its data retained.

The onboarding neighbor's cold server module graph exceeded its original 15-second beforeAll hook. Timed phase evidence localized the wait to module import. Collection preload was appended after fixture initialization; the original hook, executable assertions and budgets were preserved. The corrected full seven-case file passed.

Detailed local receipts are in the owned review workspace's `artifacts/attendance-multi-group-20261023/`. Implementation and independent source review were separate; the identified lock-order and token-registration findings were corrected and rechecked.

## Migration and rollback

Apply the new Kysely migration using the normal migration runner on a dedicated test database; inspect db:list for pending 0. The new PG test exercises migration idempotency and down/up. Down drops only the policy table and preserves group memberships. Application/schema rollback must be coordinated: code requiring a missing policy table fails closed rather than silently assuming OFF. No deployed database migration was performed.

## Focused reproduction

Use a dedicated UTF-8 PostgreSQL database, with DATABASE_URL and ATTENDANCE_TEST_DATABASE_URL pointing to it. Run the named files through the existing unit or integration config:

- Unit: attendance-group-membership-policy; admin-users-routes; attendance-uuid-validation-routes; attendance-calculation-group-membership-timeline-integrity; w4c3a-plugin-v1-boundary; w4c3a-legacy-plan-mutation-seams.
- Integration: attendance-group-membership-policy; attendance-w4c0-concurrency-gates-e3; attendance-w4c3a-group-effects; attendance-w4c3a-group-preconditions; attendance-timezone-runtime; attendance-w4pre1b-admin-users-explicit-org.
- Web: attendance-group-membership-policy.spec.ts; attendanceTimezonePolicyPanel.spec.ts; useAttendanceSessionGuard.spec.ts; attendance-web-guard-workflow.spec.ts.
- Gate/contract/quality: required-web-lane-token-manifest-guard.test.ts; pnpm openapi:guard; pnpm openapi:validate; pnpm validate:all.

For the lock-order mutation remove only the added bounded organization takeLock block, retaining the original budgets and real production triggers. For the effects mutation bypass only requireAdmission. Restore exact source bytes before any normal validation or commit.
