# Requester snapshot display repair — local verification, 2026-10-26

Status: Draft/HOLD. Base main: 4c4cd3abafad0761cb1fedcc8731b4341d02ee19. This is a derived R7 display repair, not an S7/W4 authority change or full business acceptance.

## Problem and resulting behavior

The existing builder used a technical ID when no requester label existed. Cross-user dispatch/swap/trip creation could store the authenticated operator's name against the target ID. Pending edit replaced a saved display name with the request user ID.

New creation selects a genuine name/email belonging to the authoritative subject, preserves genuine names byte-for-byte even when equal to an ID, and uses the existing neutral term Unknown user for missing display data. Cross-user profile lookup is limited to the target's active organization membership. Pending edit preserves only a valid old name; existing malformed/explicitly contradictory snapshots become neutral instead of refreshing from today's directory. Missing legacy binding fields remain compatible. No history is bulk rewritten.

The entire existing approval upsert function is byte-identical (3,066 bytes, including its 16-entry SET list, SQL, parameters and org derivation). Authorization, identity/envelope construction, transaction and replay behavior remain in their original paths. Read failures abort rather than fabricating a neutral success; serialization/deadlock SQLSTATEs remain retryable.

## Actual evidence and phase boundaries

| Gate | Actual result |
|---|---|
| Original real builder | Retained 2 missing-label reds / 3 genuine-label controls from source-identical earlier proof; new whitespace case 1 matching red / 7 filtered |
| Original real HTTP/PG | Across original 62-case run and corrected 15-case subset: 37 unique matching label reds and 25 passing controls. First-attempt outdoor/swap 15 precondition failures are excluded from defect proof |
| Fixture correction | Outdoor uses real server time to respect the existing future-punch guard; swap names its UUID org. Same assertions and budgets |
| Candidate review regression | Astra/ultra found null label rejected by original schema before replay; actual generic missing-profile HTTP 500/201 matching red, 61 filtered. Fixed only neutral return value; schema unchanged |
| Candidate real HTTP/PG | 40 actual passed, 25 filtered: all 37 prior matching reds plus 3 new missing-actor replay/operator-target regressions. Exit 0. Not a fresh all-65 run |
| Actual assembly | Canonical MetaSheetServer, original attendance plugin, DB-backed auth/RBAC, real saved snapshots and GET unified approval DTO. Generic/outdoor self; dispatch/swap/trip self and cross-user; pending edit, D-10 moved org, approver access and replay |
| Original controls retained | 25 passed across original phases, including original permission/input/conflict/SQL-failure rollback controls. They are not represented as new-head reruns |
| Unit/neighbor | New unit 29 and existing bridge neighbor 3 passed, then 2 new schema-safe profile rows passed with 29 filtered; no redundant whole-suite rerun |
| Registration | New suite in real-DB run list, no-DB exclusion and strict corpus; W4C2 324 TAP assertions, zero skip. W7 13 passed, both aggregate bans retained |
| Quality | Three CJS syntax checks, explicit non-ignored changed-test lint and pnpm validate:all all exit 0 |
| Independent review | gpt-6-astra/ultra source review; its confirmed nullable P2 reproduced and closed. Final source/hash/result readback found no further confirmed introduced P1/P2 |

The owned UTF8 PostgreSQL database applied 458 migrations, pending 0, ledger 458. Subsequent phases reused that same schema and audited its ledger instead of rerunning migrations. Both DB URL variables bound to that single isolated database. Each phase stopped its own unchanged postmaster PID and retained data. No provider/customer IO, real UAT or business configuration change.

## Commands

Run with the owned Node20.20.2 / pnpm9.15.9 wrapper and blank environment:

- pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-approval-requester-display.test.ts tests/unit/attendance-approval-center-bridge.test.ts
- pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts tests/integration/attendance-approval-requester-display.db.test.ts (affected cases selected from original named failures; see phase counts above)
- node --test scripts/ops/attendance-w4c2-ci-wiring.test.mjs
- pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-w7-w6r5-preservation-guard.test.ts
- pnpm validate:all

Vitest 1.6.1's top-level passed count can include filtered assertions. All counts above come from per-assertion statuses; filtered/skipped cases are never counted as passed.

## Remaining gates

All three matching mutation checks passed: each 1 matching red + 1 passing control (29 or 63 filtered), exact candidate restoration; real PG used for cross-user and frozen-name mutations. Current private-input compatibility is recorded separately after completion. Published-head required CI is independently pending until its actual terminal states and check SHAs are verified; local green is not remote CI.

An absent previous approval row's new-snapshot branch has unit coverage, not an FK-consistent real-HTTP missing-row proof. Provider directory-account synchronization and dynamic S7 relation advancement are not this file's new runtime proof; existing relation/assignment behavior is preserved. This does not close whole-parent all-actor/policy/human-AT/native-menu, owner approval, TRANSFER frozen, manual/soak/live gates. All PRs remain Draft/HOLD; no merge, deploy, R71/tag/release change. Stream/lifecycle OFF; real UAT/business error 50004 excluded. Historical 08:00 PUT remains INCONCLUSIVE.

## Private 25-input compatibility

Based on the qualified private24 fixture, the new candidate forms an exact 246-path source union. The only import conflict retained both original membership-policy and requester-display imports. Independently applying the exact requester transformations to the old combined index reproduces the resolved file byte-for-byte; four new runtime/test files match the public candidate bytes. Cached offline install reused 934 packages with zero download. Combined W4C2 registration passed 324 TAP assertions; seven targeted new requester real HTTP/PG cases passed with 58 filtered (six paths plus missing-display replay). Own PG stopped, data retained. No old full suite, fresh combined full-web/build/quality or production acceptance is claimed. This private fixture is not main, was not pushed and is not a GitHub merge; patched input is not claimed as a Git ancestor.


## Current-head CI failure and bounded retry diagnostics

The `abe345b71c454c193c8cbf9bdbf45427a8a16675` backend job failed in the first attendance integration batch: the existing ACP authoritative cleanup-retry case did not observe a projection-lock waiter within its original 3000 ms / 20 ms budget. The test file was byte-identical to the base. The first batch reported 137 passing files and one failing file; its 2065 passing assertions do not include 10 skipped and four todo. Shell fail-fast prevented the later isolated-database batch containing this PR's 65 requester cases from running. Registration is not execution.

The original ACP case passed once in the owned isolated PostgreSQL database (one actual pass, 34 filtered). This does not reproduce or explain the CI failure. Source inspection identified a diagnostic blind spot: a retry that returns HTTP before acquiring the held row lock is discarded after the lock assertion times out. The test now records only numeric HTTP status and an explicit allowlist of ten product error codes (everything else is UNKNOWN), and asserts that no response arrived before observing the existing lock wait. The original SQL, blocking assertion, 3000/20 budget, subsequent 409/version/preservation/exactly-once assertions and cleanup remain intact. No production behavior changed.

An injected early 409/ATTENDANCE_CLEANING_BUSY response produced one matching red with 34 filtered and the expected bounded diagnostic. Restoring the real HTTP retry produced one actual pass with 34 filtered; owned PG was stopped and data retained. Final diagnostic redaction was then narrowed from a bounded string pattern to the explicit allowlist; the actual final expression passed 16 code/redaction cases and changed-test lint exited zero (three inherited warnings). That final redaction variant is not misrepresented as a new whole PG run. Earlier zero-match selector and reporter-abbreviation postcheck failures are preserved as harness history, not green suite results.

This is a diagnostic repair, not a demonstrated root-cause fix. The original CI concurrency failure remains unexplained until actual retry/lock evidence identifies it. No blind CI rerun or unchanged green suite replay was performed; the new commit must earn its own required CI.

## FE06 permanent paired-null witness — 2026-10-27

The already-proved valid never-approved paired-null request case is now part of the existing registered integration file. Both approval reference columns start NULL, no approval exists with its ATT request number, and a fresh request UUID/control actor keeps old history separate. The original invalid create-then-detach probe remains retired; it is not promoted and not counted as a new product defect.

| Evidence | Actual result |
|---|---|
| Real authenticated HTTP/PG registered case | 1passed/65filtered; real profile, FK23503 rejection and preserved paired-null preimage, edit200/new snapshot, exact unified DTO and1new matching approval, unrelated entire old approval row unchanged |
| Matching mutation | Only null-reference current-name branch changed to neutral label:1matching red/65filtered; exact helper bytes restored |
| Source preservation | Valid case copied byte-exact from retained one-off proof; original65cases/hooks byte-identical. Runtime, auth/permissions, FK/CHECK, realDB run-list and noDB exclusion unchanged |
| Owned DB | Original ledger458/pending0 re-read, no migration replay. Pair CHECK and composite FK validated/nondeferrable; ownPG stopped/portclosed/dataretained |
| Quality | Explicit changed-test lint exit0; actual production TS file list excludes the changed integration spec. Production validate:all is carried by unchanged production inputs, not described as rerun |
| Review | Independent source review PASS,0introducedP1/P2; actual test/restore/loghashes independently verified by main |
| Current-head CI | Pending. Must observe full registered66case execution and all current-head required terminal success before final evidence; old65case/D4green is historical |

This is durable evidence maintenance for existing FE06 behavior, not a new parent acceptance denominator or runtime repair. All original phase/source limits and owner/manual/live exclusions remain.
