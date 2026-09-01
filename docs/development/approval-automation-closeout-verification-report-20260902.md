# Approval Automation Closeout Verification Report (Draft) - 2026-09-02

**Status:** DRAFT / HOLD. This is evidence preparation, not a completion or
release declaration.

**Base:** `81960ae650d974dbd9a96c922ffb4a917292ac24`.
**Candidate:** `0f4331010c60405278bbcd4ab4e38fd5b5d92c38` (Draft PR #5439).
**Diff:** exactly 10 files, `+348/-24`.

## Code-head evidence

| Gate | Result | Boundary |
|---|---|---|
| Focused unit suite | 76/76 pass | `multitable-automation-service`, test-run gate, F4-E workflow wiring, and departure dispatch neighbors. |
| Post-fix direct unit rerun | 70/70 pass | The three directly owned unit files remained green after the continuation and evidence-gate fixes. |
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

## Exact-head remote CI result

Draft PR #5439 at exact code head
`0f4331010c60405278bbcd4ab4e38fd5b5d92c38` completed 25 contexts:
24 SUCCESS, 1 intentional Strict E2E SKIPPED, 0 pending, and 0 failure.
Node 18 succeeded in 18m40s and Node 20 succeeded in 32m00s. Web Tests, the
dedicated F4-E real-DB lane, migration replay, recovery schema drift, approval
browser verification, and coverage all succeeded. This is code-head evidence;
the report-only child commit still requires its own exact-head terminal result.

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
| Code-head exact CI | COMPLETE: 24 SUCCESS / 1 intentional SKIP / 0 bad |
| Report-only child exact CI | NOT RUN at report authoring time |
| Independent external review | COMPLETE: final Terra high 0/0/0 |
| Ready, merge, or branch-protection update | NOT RUN |
| Flag enablement, dispatch, staging, deployment, production, real-tenant data | NOT RUN |
| F4-E tenant UAT | NOT RUN |

## Final disposition rule

Only terminal exact-head CI, a review with no P1/P2, and explicit owner
authorization can replace this Draft status. A later code, base, or CI-head
change requires a new snapshot rather than carrying these results forward.
