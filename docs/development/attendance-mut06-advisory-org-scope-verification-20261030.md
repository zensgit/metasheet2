# MUT06 advisory organization-key regressions — 2026-10-30

Base: a03d804d60d83717feaedce099e5ff14216afc58. Draft/HOLD.

The existing legacy-idempotency and operational-bulk assertions stayed green when the organization component was removed from both key preimages. Two new unit cases pin the complete advisory-query shapes and independently calculated keys for two legal synthetic orgs. Two new PostgreSQL cases prove simultaneous distinct foreign-org bigint locks and a genuinely blocked same-org retry that acquires after the owner commits.

## Actual local phases

| Phase | Actual result | Scope |
| --- | --- | --- |
| Existing assertions on the combined faulty source | 2 passed, 50 filtered | Demonstrates the old gap; not a correct-source baseline rerun |
| New unit cases on that faulty source | 2 matching failed, 52 filtered | Named raw assertion frames and exact expected own-key differences verified |
| Runtime restored, new unit cases | 2 passed, 52 filtered | Exact public-helper SQL capture |
| New native cases, original runtime | 2 passed, 11 filtered | Real independent PoolClients, pg_locks grants and waiting before commit |
| Same two source faults, new native cases | 2 matching failed, 11 filtered | Legacy IN_PROGRESS and bulk TARGET_BUSY on the foreign-org acquisition |

These are four distinct new passing cases and four failed leaf executions across two combined fault rounds. There are two source-fault kinds, not four distinct defects. The original52 unit and11 native helper/test-body bytes are recovered exactly by removing the additions and two native imports. Existing filename registrations and workflow/corpus/guard/budget assertions are unchanged.

The native legacy same-org retry may wait on the compatibility two-int lock; isolated class10 retry waiting is not separately established. Both new native cases prove two distinct granted single-bigint keys before the same-org control. PostgreSQL documents this key representation in [pg_locks](https://www.postgresql.org/docs/16/view-pg-locks.html). These are direct helper/database proofs, not HTTP/JWT, public-writer creation, full worker/provenance, Redis or live-provider acceptance.

## Source and quality

Runtime, schema/migrations, workflows, dependencies, policies and flags have no published delta. Temporary key-preimage faults were restored exactly. One owned database startup was observed to readiness on the same PID; the test DB was cloned from an existing owned fixture without migration apply. PostgreSQL stopped0 and data remains retained.

Explicit no-ignore configured lint retains one existing tsconfig-inclusion diagnostic per file in both baseline and candidate. AST lint retains the original unit no-extra-semi diagnostic1/1; native0/0. Focused target-file type diagnostics retain the original import.meta configuration diagnostic TS1343,1/1. Introduced diagnostics0. The initial ignored lint is not counted as code execution; the additional wrapper's mistaken AST-total-zero assertion is preserved and qualified from all eight actual comparison outputs without reruns. No fresh whole validate-all, lint-zero or whole-backend typecheck claim.

Two trailing-space-only blank lines in the new native block were removed after validation. Parsed nontrivia AST leaves and TypeScript-emitted test JS are identical; execution/source-review receipts retain their original hash and the final-source rebind is separate. No passed test was rerun for this cleanup.

Independent source reviews of both additions found no remaining confirmed finding. Main independently checked actual JSON leaf statuses, complete raw-log hashes, matching named failure frames, source restoration and the whitespace-only rebind.

Reproduce selected unit cases with:
pnpm --filter @metasheet/core-backend exec vitest --config vitest.config.ts run src/attendance/__tests__/w4c0-identity.test.ts --watch=false --cache=false --testNamePattern='MUT06_ADVISORY_(LEGACY|BULK)_ORG:'

Reproduce selected native cases on an owned synthetic database with:
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-w4c0-concurrency-gates-e3.db.test.ts --watch=false --cache=false --testNamePattern='MUT06_ADVISORY_ORG_NATIVE:'

| Existing gate | Evidence | Remaining boundary |
| --- | --- | --- |
| Advanced attendance design-lock §7.4 organization mutation | Two org-key omissions have named unit and real-database failing legs | Other call paths and the whole semantic/provider/parent denominator remain open |
| Preserve current gates | Original52/11 bodies and registrations byte-preserved | Current-head unfiltered unit54/native13 CI still requires actual execution evidence |
| Delivery authorization | Draft/HOLD, switchesOFF | No merge, Ready, deployment, R71, target migration or provider enablement |

Main actual-execution audit SHA256: 95440ac1e5b25b01b676ef118f7d9679fe19f055613c1d9b65d699f3b2c7dabf.
Final quality disposition SHA256: f6e93b61b662a2ff577cbd0fea881464f3571bde66c8cc6833e142b5a8eaf8dd.
Native source-equivalence proof SHA256: 0156732a79af2605aae514fcbdefcf456d06c4a85fd900c44397fd32041ddac9.

Refs #4556. Full DingTalk and MUT06 completion is not claimed.
