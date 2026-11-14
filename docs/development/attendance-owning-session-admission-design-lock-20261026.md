# Attendance owning-session admission repair design lock — 2026-10-26

Status: implementation scope authorized directly by the user; Draft/HOLD only. Refs #4844. Base source main `40ce1b47eab87b5fb4d7f69b3b8b9f7cfcdd003b`.

## Problem and scope

The current query-only idle check creates a savepoint in an already open caller transaction. If later query calls cannot execute, it cannot guarantee removing that savepoint while also preserving the caller transaction. Catching cleanup errors, retrying indefinitely, rolling back the caller transaction, or discarding a borrowed session do not meet the original requirement.

Upgrade internal owning-session admission and migrate existing owning consumers. Keep the query-only transaction-body/joining interface separate. No new attendance capability, permission policy, flag, provider IO, dependency version or schema change. Business SQL, isolation, bounded retries, lock/statement budgets, payloads and default-OFF behavior stay within their existing contracts.

Installed pg8.16.3 does not expose getTransactionStatus; its readyForQuery Boolean cannot distinguish idle, transaction-open and transaction-aborted. Pool checkout alone is not idle evidence. Exact direct-call inventory currently identifies21 runtime calls in12 modules, not a complete dynamic ownership graph. All additional helper/adaptor/test consumers must be inventoried before migration is declared complete.

## Admission and ownership contract

1. Owning admission must obtain trusted, nonmutating PostgreSQL ReadyForQuery state I/T/E (unknown refuses), tied to the actual same live backend and connection generation. Never infer idle from an xid, a readiness Boolean, an arbitrary WeakMap stamp, a past successful query or a cached idle sample with active/queued work.
2. Admission plus the owning operation must hold one exclusive same-session lease. No await gap may admit an outside BEGIN/query, replacement backend, release or competing owning call. Raw references cannot bypass the lease. Transaction-body query capability is scoped to that lease and cannot establish ownership itself.
3. Caller-owned T/E, unknown/stale/busy/released/ending/failed sessions refuse before probe SQL, BEGIN, callback, emit, COMMIT, ROLLBACK or discard. Caller writes, nested savepoints, read-only and no-xid SERIALIZABLE transactions are preserved exactly. Product refusal remains values-free.
4. Only a transaction this lease actually began can be committed/rolled back by its runner. Only an actually owned unusable session can be discarded by its host. Preserve existing retry and uncertainty semantics; do not reclassify a borrowed-session refusal as permission to destroy that caller.
5. A pinned-driver adapter must observe protocol state from connection establishment, not after losing the initial ready message. The candidate implementation is a scoped Client/Pool construction adapter plus private protocol/lease tracking; its exact API must be verified against the installed driver and migrated consumers before it is considered implemented. Exposed query-only joining ports remain available for their existing body roles.

## Gates

| Gate | Required proof | Current state |
|---|---|---|
| Source/consumer inventory | All owning entrypoints, idle-helper consumers, host adapters, external exported paths and affected test pools; exact base and files | 19 changed runtime files plus private driver; owning host/caller and shared-helper source census completed within the bounded static repository scope; not a dynamic graph claim |
| Driver lifecycle | Real protocol I/T/E/unknown, first connection, reuse, failed/released/ending/back-end generation, in-flight BEGIN and queued work | Local staged protocol/unit proofs recorded in verification report; two end-fence controls passed without runtime repair |
| Exclusive lease | Competing owners and raw query/release attempts cannot cross admission or use stale body ports | Matching raw-query/release/custom-submit/meta-event negatives and restored positives; checkout generation/listener-lifetime controls |
| Borrowed-state preservation | Both operation registry and outbox, caller writes/nested savepoints/read-only/no-xid SERIALIZABLE/aborted, zero callee SQL/body/emit/rollback/discard | 18 actual real-PG tests, zero skipped, both sites and original caller-state assertions |
| Cleanup-failure gate | Original failure model cannot create a callee savepoint or consume caller state; retain explicit fault-injection and ownership negative controls | 18-test PG proof refuses before callee SQL; two armed teardown cases cannot create a callee savepoint; native discard mutation additionally red/restore green |
| Existing runner semantics | SERIALIZABLE, bounded retry classes/count, lock/statement limits, callback/emit counts, cleanup and uncertainty paths | Affected real-PG and standalone protocol phases complete; retries/budgets/error identity retained; existing TODOs and sentinels separately disclosed |
| Host/caller migration | Every verified consumer accepts the new owning contract; joining operations and disabled business paths preserved | Verified owning consumers migrated; three remaining unit files59 passed and protocols61/15/27 passed; joining ports unchanged |
| Registration/security | New modules classified under both W7 bans; suites in real-DB run list/no-DB exclusion/strict corpus; original guards retained | Private driver classified under both W7 bans;13/13 guard; existing real-DB suite paths/run-list/corpus unchanged |
| Quality and independent review | Focused original-red/fix/mutations/neighbors, relevant compile/quality and bounded isolated-PG evidence, independent source review | Production validate:all0, explicit CLI lint0, zero introduced test lint diagnostics by same-config baseline; independent reviews and main-disposition receipts |
| Published head | Draft, clean/hash-pinned source, all required checks completed/success at actual head; final exact evidence readback | Draft #6568 published. The three core adapters now pass on d769308d actual CI. Its approval G3 recorder compatibility failure is locally reproduced/fixed (2 affected passed/36 filtered, 2 recorder negatives red, original test/hook texts unchanged). A new head must obtain all actual-head required success and final exact evidence readback |

## Verification and boundaries

All execution in the owned isolated copy and existing owned UTF8 PG, one owned heavy task globally. Preserve original data and prior failure evidence. Select affected assertions rather than replay unchanged passed suites. Record individual assertion statuses; filtered cases are exclusions. Source-qualified reuse must name the actual phase and unchanged inputs, never a fresh-run claim.

User authorization permits this internal compatibility upgrade and Draft repair, not gate reduction, final owner acceptance, merge or deployment. Stream/lifecycle OFF. No R71/tag/release/business configuration change. Real UAT and business50004 excluded; historical08PUT INCONCLUSIVE. Interface design and implementation are not proof of whole-product or production acceptance.
