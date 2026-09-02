# Approval Automation Closeout Verification Report (Draft) - 2026-09-02

**Status:** DRAFT / HOLD. This is evidence preparation, not a completion or
release declaration.

**Original code baseline:** `81960ae650d974dbd9a96c922ffb4a917292ac24`.
**Original code head:** `0f4331010c60405278bbcd4ab4e38fd5b5d92c38`.
**Final replay base:** `24942c70fb07133b580250c00aecbc208aa2f8e8`.
**Final replay code head/tree:**
`bdf7626d6c8b1ffefcbccfc33571d04974f31224` /
`777c7bf0d4ac419715ee8d4abd370bca973222f1` (Draft PR #5439).
**Final replay diff:** exactly 12 files: the original 10 code files and these
two reports.

## Code-head evidence

| Gate | Result | Boundary |
|---|---|---|
| Original code-head focused suite | 76/76 pass | Original code-head evidence; it is not the later replay command. |
| Direct-owned unit rerun | 70/70 pass | Three files: `multitable-automation-service` (52), `automation-testrun-gate` (15), and F4-E CI wiring (3). |
| Final replay focused suite | 77/77 pass | Exact command: `pnpm --filter @metasheet/core-backend exec vitest run --watch=false tests/unit/multitable-automation-service.test.ts tests/unit/automation-testrun-gate.test.ts tests/unit/approval-departure-transfer-ci-wiring.test.ts tests/unit/approval-departure-transfer-dispatch.test.ts --reporter=dot`; the fourth dispatcher file contributes 7 tests. |
| Type check | pass | Core-backend type check. |
| Targeted lint | exit 0, warnings only | Existing unused-type warning; no new lint error. |
| Patch hygiene | pass | `git diff --check` and clean worktree. |
| Fresh PostgreSQL 15 | 43/43 pass | Exact-byte-equivalent integration source ran against a freshly migrated isolated database, then the database was dropped; residue was zero. |
| Approval continuation fresh DB | 27/27 pass | The failed Node 20 suite and the sample-read authority suite passed together in a newly migrated scratch database; the database was dropped. |
| External model review | 0 P1 / 0 P2 / 0 P3 | Luna high cleared the test-only actor fix. Terra found two P2 evidence gaps; both were reproduced and fixed, and a fresh Terra high review cleared the final 10-file exact head. |
| Self review | 0 P1 / 0 P2 | Bounded refute-first review of the final 10-file candidate. |

## Discriminating mutations

Each mutation was restored after the corresponding targeted failure.

1. Replacing strict server-shaped sample validation with a truthiness check
   made malformed sample negatives fail, demonstrating that `real_fire` does
   not accept a truthy malformed payload.
2. Disabling the committed-boundary departure dispatch made the F4-E
   orchestration cases fail, including the hostile invitation-ledger sibling
   failure case; the committed run remained terminal rather than failing.
3. Removing the orchestration test from the F4-E workflow path selector made
   the wiring guard fail.
4. Removing `sampleRecord.actorId` from the approval-continuation fixture made
   that exact integration suite fail 1/25 with
   `TEST_RUN_SAMPLE_RECORD_REQUIRED`; restoring it returned 25/25.
5. Reintroducing a missing-record identifier into the public 404 body made the
   exact values-free route assertion fail; restoring the fixed body returned
   the route suite to green.
6. Removing either the deprovision ledger or planner path independently from
   the F4-E workflow made the mechanical PR/push path-equality gate fail.

## Code-head replay and remote CI result

Historical report head `129556911a78764cc6c1d69687bc657b2af52474` completed
24 SUCCESS plus one intentional Strict E2E SKIPPED. The `bdf...` code replay
merge is non-conflicting and preserves all 12 candidate blobs byte-for-byte;
its old/replay patch SHA-256 is
`8b90e3de6340ad99e2c6e743679db08500d32767871c36926038746453eb98e8`.

Draft PR #5439 at final replay code head
`bdf7626d6c8b1ffefcbccfc33571d04974f31224` completed 24 SUCCESS plus one
intentional Strict E2E SKIPPED, with zero pending and zero failure. Node 18,
Node 20, Web Tests, the dedicated F4-E real-DB lane, migration replay,
recovery schema drift, approval browser verification, and coverage succeeded.
This report-refresh child is later evidence and has no CI result at authoring.

## Acceptance statements

- A direct real-fire request cannot manufacture a usable sample from arbitrary
  request fields; the persisted server record remains the authoritative shape.
- A valid server-shaped sample preserves the approved real-fire route.
- The departure transfer dispatcher is invoked after the durable directory
  boundary and is insulated from a throwing post-commit sibling; no failure may
  downgrade the already committed terminal directory run.
- The real-DB workflow observes the dispatcher and orchestration suites rather
  than only an isolated writer test.

## Still NOT RUN / owner-gated

| Item | State |
|---|---|
| Historical report head CI | COMPLETE: 24 SUCCESS / 1 intentional SKIP / 0 bad |
| Final replay code-head CI | COMPLETE: 24 SUCCESS / 1 intentional SKIP / 0 bad |
| This report-refresh child CI | No result at authoring; must be independently terminal before any merge decision |
| Independent external review | COMPLETE for code: fresh Terra high replay review 0 P1 / 0 P2; its single report-count P3 is resolved by the three distinct rows above |
| Ready, merge, or branch-protection update | NOT RUN |
| Flag enablement, dispatch, staging, deployment, production, real-tenant data | NOT RUN |
| F4-E tenant UAT | NOT RUN |

## Final disposition rule

Only terminal exact-head CI, a review with no P1/P2, and explicit owner
authorization can replace this Draft status. A later code, base, or CI-head
change requires a new snapshot rather than carrying these results forward.
