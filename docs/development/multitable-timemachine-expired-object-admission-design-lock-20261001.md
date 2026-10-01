# Expired archive object deletion admission

Status: bounded local development candidate; runtime OFF, Draft/HOLD. D1 exact-SHA
ratification remains a merge/runtime gate. This does not complete original D-L or D-H2.

Authority: Phase D1 D-L (2026-08-26, lifecycle/object deletion/hold ordering), the
LC1..6 retained-key contract and local storage contract (2026-09-16). Base
`2472eb288391ae9a58ea8a5429d27abc636efee8`; no existing runtime caller changes.

## Bounded contract

- Add one normalized deletion intent per exact generation/object, with immutable
  owner request and provider operation key, closed original D-L states and bigint CAS.
  Only `requested -> ready` and hold-driven cancellation are reachable here.
- Request and prepare use one checked SECURITY DEFINER command function that
  takes canonical sheet fence, bytewise key rows, bytewise exact-identity generation
  rows, jobs, active holds, and object/reference rows. Direct base-table DML and
  transaction GUCs cannot mint a transition for the restricted runtime role. The
  command entrypoint validates every predicate itself; it is storage authority, not an owner-authenticated runtime API.
  No production role is created or privileges enabled. PUBLIC table DML and function
  execution are revoked. Future invocation requires an approved non-owner, non-superuser
  role with no direct/inherited base DML or authority DDL and only required function
  grants. Owner/superuser arbitrary DDL is outside this permission boundary.
- Admit only already-expired finalized complete generations at database time, with
  active bound key and exact verified object receipt. Require READ COMMITTED;
  reject stale-snapshot isolation before any admission. Attachment replacement
  identity includes exact provider version, not just matching plaintext digest. Refuse active holds,
  nonterminal bound jobs, incomplete object/attachment rosters, stale CAS/bindings,
  and unverified/inexact supersession candidates. Unknown query/schema state refuses.
- No independent owner-deleted point catalog exists at this baseline. Conservatively
  consider all same-exact-identity catalog rows with a future recovery horizon legal;
  do not invent an owner-deletion exemption or retention duration. Another cover must
  be verified/nonexpired and have all ten sections, manifest and exact available
  attachment receipts. Later anchors and building generations do not substitute.
- Hold placement shares the generation lock and atomically cancels requested, ready
  or failed_retryable intents. It explicitly refuses deleting/deleted if those states
  are introduced by a future worker. This slice cannot enter either external state.
- Preserve all archive/object/attachment/key references. No provider/KMS invocation,
  receipt finalization, object/key deletion, key retirement, sweeper, timer, route,
  environment flag, startup activation, capture policy, or customer-data access.

## Verification and remaining gates

Unit input/result/transaction negatives and isolated native PostgreSQL positive,
expiry/hold/job/sole-cover/replacement/CAS/raw-DML/GUC/rollback negatives; hold races
and key-first locking; new CI selector plus migration replay UNION; load-bearing
guard mutation must RED and source bytes must restore exactly. Apply/down only on
the owned synthetic database; down refuses any retained intent. Record shutdown and
zero residue. Future D-L still needs deleting claim/lease/reconciliation/receipt and
reference release, full hold-versus-deleting goldens, independent horizon sweep,
owner-authorized surface and key-destruction authority. Original D-H2 and controlled
staging acceptance remain separate open gates.
