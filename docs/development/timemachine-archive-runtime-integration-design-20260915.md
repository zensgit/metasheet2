# Archive Runtime Integration

Status: LOCAL INTEGRATION IN PROGRESS. Not runtime acceptance or enablement.

## Frozen Inputs

- Main: `062614f4407b3d9bffc82dae266071b8a6e5e5bd`, verified with GitHub REST on 2026-09-15.
- Actor authority: PR #5735, `dde094922da92845856f761ab0144f2ad9471d36`.
- Explicit read authority: PR #5737, `fd88ca719614e587c9e7aef8628b8419b0115ed5`.
- Persisted worker identity: PR #5727, `a9c1a42112338b74eac2ca28c5c93bed81a0a1ea`.
- Combined code: `22d9fbcd6eefcfc752e953a79b9cf96341dd2836`.
- Combined tree: `756d1e7152ad4a2b732ae68525f5b8dda582cf7f`.

## Contract

Commit-effects checkpoint `77fa2e3d85a0fba5b734d86a9b6fa56666645667` (tree `6360456c6bc41512b4770ad2a51efd68224ad05a`) adds an optional worker `afterCommit(identity, mutations)` port. It runs only after a newly committed chunk, never after rollback, already-committed replay, or no-pending result. Transaction callback retries reset accumulated mutation facts. Effect failures log a fixed values-free code and do not rewrite committed status. Application dependency snapshots preserve this callback. Durable events must still be enqueued inside `onMutationApplied`; this best-effort port is not a durable delivery guarantee, and a process crash after COMMIT may lose the notification. Actual production event/formula/realtime handlers and provider startup composition remain to be connected and verified.

Reuse existing recovery authority rather than implementing a permissive worker substitute. HTTP retains its request/database intersection. Background work must resolve the persisted actor from fresh database state and bind the persisted workspace/base/sheet to live scope. An invalid account cannot regain access through a surviving sheet grant.

Full-table readability includes row restrictions, field scopes, and transitive foreign-field/base formula masking. Write authorization must additionally enforce the true delta's row edit/delete, field write, person membership, and forward-link target rules inside the fenced transaction. No cached JWT reconstruction, allow-all callback, or new grant semantics is acceptable.

The three inputs are true-merged without rewriting their history. The sole manual resolution preserves both independently added exact-anchor real-DB test blocks, unchanged. Original branches and PRs remain untouched.

## Remaining Runtime Work

Shared-policy checkpoint: `5fb07a51126aa228bf635b9d2d49d62720af4c00`, tree `e429ed6710cd948da1c0bd45826a069e4b1c0930`. `recovery-plan-authorization.ts` owns the existing authorization stabilizer and true-delta evaluator. HTTP delegates to it using its unchanged request/database resolver and full-read evaluator. The shared evaluator accepts transaction-bound authority/full-read functions; callers must not provide permissive substitutes.

Worker-adapter checkpoint: `6185c4b39e49214643ced708ce60abfc605e926d`, tree `420890aec4d0775297ca2b681cc5cf740a29f119`. `createRecoveryArchiveWorkerAuthorization` binds the canonical full-read implementation without creating a Request. The new adapter compares persisted base/workspace/sheet identity with live non-deleted sheet/base rows, loads database-fresh actor authority on each read, and delegates true-delta/stabilization rules to the shared module. It rejects mismatched actor/sheet contexts and final lock scopes missing the source sheet. No tenant is inferred from the persisted identity. Provider/application composition and mutation/post-commit hooks remain unwired; this checkpoint does not enable the worker.

1. Share the existing full-read and true-delta evaluator between HTTP and worker without changing HTTP behavior.
2. Bind background identity to live scope; do not invent an authenticated tenant from a request-shaped object or unverified input.
3. Compose canonical mutation/outbox and post-commit effects; preserve cancellation, lease fencing, and writer-block cleanup.
4. Integrate existing provider-preflight/process-restart work without duplicating their implementation; verify the full combined candidate.
5. Validate standard startup with real provider boundaries and synthetic isolated acceptance before claiming runtime readiness.

Whole-sheet hard-delete resurrection, flags, dispatch, deployment, production and customer data remain outside this work. Ready/merge requires separate authorization. Existing constituent evidence is not combined runtime proof.

### Shared Mutation Events

Code checkpoint `9062f3144355e99798c0d505e939f6f54152bdba`, tree `f68b51dd5e8ef2bf042700fb8d32e2812b989dd3`, extracts the existing HTTP event builder into `recovery-mutation-events.ts`. HTTP and worker hooks use the same canonical producer, supplied transaction query, event family and payload. The transaction marker is not authority: the existing durable producer still probes the transaction. Worker hooks retain the same event ID until commit and reject a mixed/unbound identity batch before emitting anything. Durable delivery suppresses the legacy bus; disabled delivery preserves the legacy post-commit path. Failed enqueue never creates an emit-ready entry.

These hooks are not yet assembled with standard application providers and post-commit formula/realtime effects. This is a local integration checkpoint, not completed runtime delivery.

Real-DB follow-up `745b5685626490426d8cd71164df3d0be02e23b9` proves the extracted producer's commit/rollback atomicity and autocommit refusal. It does not change the outstanding application composition contract or authorize enabling durable delivery outside the isolated test process.

### Requestless Computed Effects

Checkpoint `7e37fadb2c50e041178f60c10bb7be82a131ca14`, tree `9c7ef5473e68541f855de44dc62c0e0bbe737520`, adds explicit resolved-access propagation through lookup/rollup hydration, relation aggregation, formula recompute and dependent-record recompute. HTTP callers keep their request path. `createRecoveryComputedHelpers` accepts a resolved actor, rejects an absent actor, and does not manufacture a Request. The caller must obtain database-fresh authority and verify recovery scope before invoking it; the factory itself does not grant or refresh permission.

The real-DB test exposed a pre-existing mismatch: recompute could discover an expression dependency absent from `formula_dependencies`, while taint only consulted that table. The taint graph now unions authoritative expression references with indexed dependencies, so a denied foreign input cannot be persisted as a degraded formula value through that fallback. This is reduce-only; indexed dependencies are retained. Standard worker composition remains open.

### Canonical Worker Callback Assembly

Checkpoint `467b80a239c81b58e1e44a1ec4336c5ef7ab3aef`, tree `452dd5beac6309a01a55de006a1a231fe368a7cf`, exposes `createRecoveryArchiveWorkerCallbacks`. It combines canonical authorization and transaction-bound mutation events with shared HTTP post-commit recompute/notification behavior. HTTP uses the same moved implementation with its original request helpers. Background callbacks resolve fresh authority and live scope before recomputing; revoked authority receives only ID invalidations, not value reads or formula writes. No fake Request or caller-provided allow-all policy is used by this factory.

Remaining lifecycle issue: the chunk callback precedes job finalization, while the long-lived writer block is released by terminalization. Derived writes respect that block. These callback tests deliberately prove composition without an active job block and cannot establish full job completion effects. Terminal/restart-safe derived recompute and standard provider startup remain required; do not wire this as fully ready until that gate is closed.
