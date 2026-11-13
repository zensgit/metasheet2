# MUT06 candidate-job ID native regression — 2026-10-30

Base: a03d804d60d83717feaedce099e5ff14216afc58. Draft/HOLD.

The existing repository unit case pins the initial ID predicate and bindings with a mocked query result. This regression adds the real PostgreSQL behavior for an absent legal UUID when the table contains exactly one legal V1 candidate. The shipped predicate is already correct; there is no runtime fix or claim of a demonstrated tenant leak.

## Behavior and fixture

The new case runs before the existing job fixtures so a missing ID comparison cannot be concealed by the repository's multi-row cardinality guard. It creates a synthetic organization and memberships, then uses the existing production reservation path to commit a strict_targeted V1 job, manifest and chunk. It checks the exact legal job shape and one-row/one-manifest/one-chunk residue.

A real PoolClient delegates both repository queries to PostgreSQL: the existing job ID returns its exact ID and organization; a separate absent canonical UUID returns null. Exact before/after JSON snapshots cover jobs, plans, chunks and scoped attendance records, requests and import batches. Values-free receipts retain query/binding and state hashes. No query result is mocked.

## Actual local execution

| Phase | Actual leaf result | Scope |
| --- | --- | --- |
| Main base, new case | 1 passed, 24 filtered | Real PostgreSQL; existing 24 case bodies did not execute |
| Initial ID comparison neutralized | 1 matching failed, 24 filtered | Positive existing-ID control still works; absent ID incorrectly returns the sole legal job |
| Existing composed source at 285314d03a989f284f1647b713b3eb5258273e7a, same new case | 1 passed, 24 filtered | Composition applicability for this repository selection only |

These are one distinct new case, two positive executions and one matching failed leaf across one source-fault kind. The intentional fault replaces only WHERE id = $1::uuid with WHERE $1::uuid IS NOT NULL inside the candidate query, preserving its binding arity. The failing oracle is the absent result's toBeNull assertion, rather than a SQL parameter error. Runtime source and the temporary composed test were restored exactly.

The first controller stopped after the successful main phase because Vitest's filtered JSON headline reported25 passed although actual assertionResults.status and the verbose summary prove1 passed/24 filtered. The original receipt is retained and qualified. The main phase was not rerun; continuation performed only the unexecuted fault and composition phases. PostgreSQL was started and stopped twice across those two controllers; the owned data directory remains retained. The suite's existing disposable database lifecycle is reused; a separate post-drop catalog check was not performed.

## Final source and quality

Only the new test block and this verification note change. Imports, original helpers, original24 cases, runtime, migrations, workflows, dependencies, budgets, guards, policies and flags stay unchanged. Removing the final new block recovers the complete original test file byte for byte.

The existing strictInput helper carries a literal payload.__jobType of 'commit', but TypeScript infers string. Only the added reservation call asserts this existing fixture as Parameters<typeof reserveAttendanceLegacyImportPlanJobV1>[2]. It adds no any cast and changes no fixture values or runtime validation.

The first focused quality comparison found one introduced TS2345 diagnostic at the new call. After this local type-only assertion, cached baseline/final target diagnostics are37/37 and transitive diagnostics49/49, introduced0. Explicit configured no-ignore lint retains the existing tsconfig-inclusion diagnostic1/1; AST lint is0/0, introduced0. Original failed quality receipts remain retained. This is not a whole-backend typecheck, lint-zero or validate-all claim.

The executed and final test sources emit byte-identical standalone ESM/ES2022 JavaScript with the project options and specified emit settings. This is a standalone TypeScript emission proof, not an actual Vitest transform artifact. No already-passed native case was rerun for the type-only edit. Main independently checked the execution receipts, exact source restoration, old-body preservation, diagnostic cause and type-only binding.

Independent source reviews of the executed candidate and the final type-only callsite found no remaining confirmed finding. The reviewer compared existing evidence without running checks or adding execution credit.

Reproduce only the new case against an owned synthetic PostgreSQL database, with DATABASE_URL set securely:

pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-w4c3a-durable-plan-enqueue.db.test.ts --watch=false --cache=false --testNamePattern='MUT06_CANDIDATE_JOB_ID_NATIVE:'

| Existing gate | Evidence | Remaining boundary |
| --- | --- | --- |
| Advanced attendance design-lock §7.4 organization mutation | Real repository selection rejects absent legal ID with a legal single-row positive control | Full queue/HTTP admission, foreign-org authorization and whole MUT06 denominator remain open |
| Preserve current gates | Existing24 bodies and imports recovered byte-exact; current filename registration unchanged | New current-head unfiltered whole-file25 CI evidence still required |
| Delivery authorization | Draft/HOLD; external-write switches OFF | No Ready, merge, deployment, R71, target migration or provider enablement |

Main actual-native execution audit SHA256: d692275e94411641f6bdf52583442df80b99a1e6d8db72c65af9cc4d38ba25fc.
Final source-rebind proof SHA256: 92294c0d69211b17010c864b996ecd5be881c7a8114d25316d201adbfc9cdaa7.
Final focused quality state SHA256: 79f90bee67c5dc42a2025dc5ea666788c2e62a28fa7bfd6cd57070ad487d15a4.

Refs #4556. Full DingTalk or MUT06 completion is not claimed.
