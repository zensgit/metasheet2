# Time Machine Archive Worker Identity Context

Status: implementation and isolated verification under the standing Time Machine goal.
Base: `c6f2d437a8810a822fb4210976aaf6af9ed3af74`.

## Existing Contract

The archive application reuses one callback set across durable jobs. The job binding already
persists `jobId`, `workspaceId`, `baseId`, `sheetId`, and `actorId`. The async facade previously
supplied only sheet/actor to the coarse authority check, and supplied no identity to the
preliminary read, final locked read, or mutation hook. Request-scoped closures cannot be the
identity source for a process-wide, restartable worker.

This change exposes the existing durable identity to adapters. It does not create a new
permission, restore mode, provider, HTTP endpoint, flag, or object-storage credential.

## Identity and Callback Contract

1. Read the binding using the existing fenced worker claim. Reject job/sheet mismatch before
   loading archive objects. Snapshot exactly the five identity fields with `Object.freeze`.
2. Use the snapshot for archive materialization authority and the later transaction authority
   check. Reject runner job/sheet/actor mismatch before calling transactional authorization.
3. Bind the same snapshot into each L8 callback for this chunk: preliminary full read,
   authorization stabilization, final locked full read, projected write authorization, and the
   optional same-transaction mutation hook. Retain each callback's original query, lock scope,
   plan context, mutation payload, return value, and rejection behavior.
4. Each facade execution owns its snapshot. Shared adapters must receive different identities
   for different jobs, including concurrent jobs. Resume derives identity again from the same
   durable job; worker ownership/fences remain managed by the existing runner.
5. Providers must evaluate current authority using this identity and the provided transaction.
   Supplying context does not prove that a provider uses it correctly: TypeScript still permits
   functions to ignore arguments. Real authorization composition remains a separate required
   deliverable. Test-only allow-all policy callbacks must never be installed in production.

## Verification Gates

| Gate | Required evidence |
| --- | --- |
| Old behavior is distinguishable | Full identity assertion fails against the old facade |
| Callback propagation | All six stages receive the exact frozen, closed identity |
| Isolation | Concurrent jobs reuse adapters without sharing identity objects |
| Refusal | Binding/runner mismatch and revoked authority reach no L8 apply |
| Mutation | Omitted identity, mutable identity, and removed mismatch guards turn tests red |
| Real DB | Existing 5,001-record reset/revert facade cases check identity at every stage |
| Continuation | Existing expired-worker/reclaimer case retains identity and rejects stale claims |
| Neighbors | Worker, application, server wiring, durable-job units and core typecheck |
| Delivery | Exact-SHA verification MD, ordinary push, Draft/HOLD PR, remote checks separate |

## Preserved Boundaries

No changes to recovery permissions, data projection, restore receipts, seals, writer fences,
lease admission, provider wiring, migrations, API schemas, shared CI selectors, or feature flags.
No whole-sheet hard-delete resurrection. No Ready/merge, dispatch, staging, deployment,
production, or real customer data. An in-process worker-disappearance test is not a real
process crash/restart rehearsal or proof that the standard production runtime is configured.
