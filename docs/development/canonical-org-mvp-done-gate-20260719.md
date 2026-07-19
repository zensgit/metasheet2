# Canonical Org MVP - Done-Gate and Verification Record

Date: 2026-07-19  
Verified baseline: `origin/main` at `b004c57978c9dbfe8ad3795dc4bad239f0cf8691`  
Verdict: **development-side DONE; production release remains OWNER/OPS-GATED**

## 1. What this closes

Canonical Org now provides a stable editable local anchor, explicit routing policy, one proven
approval-routing consumer, and suggest-only external reconciliation:

1. A local integration is stable and unique per org; local departments, accounts, memberships, and
   normalized direct-manager relations are editable through server-scoped admin APIs.
2. Archive is read-only at each write point, primary switching is atomic, reparenting is cycle-safe
   under concurrency, and a disabled local integration reactivates the same anchor.
3. Department bindings are constrained by database FKs so cross-org and provider-mislabeled shapes
   cannot be inserted.
4. `(org, purpose)` routing is explicit and fail-closed. Policy preview is read-only, and a concurrent
   target disable cannot race a successful policy write.
5. Approval routing is proven on real PostgreSQL to preserve the local/DingTalk requester
   department/title/direct-manager result and the in-flight/new-instance boundary.
6. External directory data can suggest bindings and update binding liveness only. It cannot mutate
   the canonical local department, and ambiguous matches are never auto-applied.

This does **not** claim that every directory consumer has migrated. Manager-chain and `deptHead`
remain provider-specific/legacy paths; B6 pins that boundary. Feishu/WeCom drivers, per-org quiet
hours, shared rate limiting, and all-consumer migration remain outside this milestone.

## 2. Landing ledger

| Increment | PR | Merge SHA | Done-gate contribution |
| --- | --- | --- | --- |
| B1 | #4304 | `849f1d53d` | local bootstrap, one-active-local cap, corp shape, create audit |
| B2 | #4317 | `bf52b9513` | local CRUD, archive-not-delete, strict input boundary, primary switch |
| B3 | #4318 | `65dec7b36` | normalized `is_manager`, scoped writer, direct-manager resolver |
| PB4-1..4 | #4366/#4392/#4397/#4401 | `9a0f23037` / `a993e8b84` / `80f4aceae` / `987bdc5e0` | input/atomicity, archive write-point locks, cycle serialization, same-anchor reactivation |
| B4 | #4419 | `b94dcd644` | FK-backed department-binding integrity |
| B5-a | #4429 | `81aff8203` | routing-policy schema |
| B5-b | #4430 | `05dcd5282` | policy-authoritative fail-closed resolver |
| B5-c | #4431 | `5e55b549d` | admin policy routes and read-only preview |
| B6 | #4434 | `50cbfcfea` | local/DingTalk approval-routing equivalence proof |
| B7 | #4436 | `b004c5797` | suggest-only reconciliation and Q6 sync hook |

The B5/B6 design lock was merged separately as #4425 (`d9f56a8c2`).

## 3. Composed verification on merged main

The closeout was rerun after B7 merged; it does not infer composition safety from old per-PR green
checks.

| Gate | Result |
| --- | --- |
| Fresh PostgreSQL database `codex_canonical_done_20260719` | full migration chain passed |
| Migration replay | second `migrate` completed with no pending migration or error |
| B1-B7 composed real-DB battery | 18 files, **227/227 tests passed** |
| TypeScript | `pnpm --filter @metasheet/core-backend exec tsc --noEmit` passed |
| B4-B7 CI wiring contracts | **15/15 passed**; whole-file real-DB execution and no-DB exclusions pinned |
| B7 exact-head GitHub CI | **16 success, 1 intentional skip, 0 failure** before merge |

The 18-file battery included local bootstrap/scheduler exclusion, local CRUD and routes, archive
read-only, cycle detection, reactivation, department-binding constraints, routing schema/resolver/
routes/fail-close, direct-manager compatibility, B6 equivalence, B7 reconciliation/admin routes/
sync hook, and normalized-manager coverage.

## 4. Refute-first evidence

Mutation evidence remains SHA-scoped to the increment where it was reviewed. The closeout does not
falsely claim that every historical mutation was rerun as one giant script; it records the
load-bearing classes and adds a fresh composed green run:

| Increment | Independently red mutation classes |
| --- | --- |
| B1-B3/PB4 | remove local uniqueness/CHECK/scheduler exclusion; relax scoped manager predicates; split atomic primary switch; remove write-point archive locks; remove cycle serialization; remove reactivation latch |
| B4 | drop org FK or `NOT NULL`; remove either department-FK provider leg |
| B5-a | drop same-org FK; change fallback `RESTRICT` to `CASCADE`; drop `(org,purpose)` uniqueness |
| B5-b | bypass policy/fail-close guards; remove org scope with a bind-compatible tautology; alter the legacy strict fixture path |
| B5-c | remove `FOR SHARE` while preserving the transaction; the disable-vs-set barrier becomes red |
| B6 | bypass canonical integration scope; remove local normalized-manager or DingTalk leader parsing |
| B7 | remove child-provider predicate; materialize a suggestion; break whole-file CI adjacency; remove integration narrowing; restore raw error logging |

For B7, Codex applied each of the five listed mutations separately on the final reviewed patch,
observed the intended test turn red, restored it, and reran the final 19-test B7 battery green before
the exact-head CI run.

## 5. Remaining gates and next sequence

The following remain outside this development done-gate and must not be simulated:

- real-enterprise U1-U13 evidence, including the real callback `eventCorpId/corpId` anchor;
- switch-ledger owners and per-switch operational rulings;
- the alert-topology and stream-worker owner decisions already recorded by Hardening v1.

They block Canonical Org **production release/MVP DONE**, not continued engineering. Transfer now
proceeds in the ratified order:

`T1 -> T2 -> T2-Gate -> (T2.5 when collision is confirmed) -> T3 -> T4 -> T5`

T2-Gate is a real two-corp staging proof. A confirmed `(provider, external_key)` collision makes T2.5
mandatory before T3; a sandbox signature or document cannot substitute for that owner/ops evidence.
