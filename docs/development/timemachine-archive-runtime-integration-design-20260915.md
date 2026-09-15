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

Reuse existing recovery authority rather than implementing a permissive worker substitute. HTTP retains its request/database intersection. Background work must resolve the persisted actor from fresh database state and bind the persisted workspace/base/sheet to live scope. An invalid account cannot regain access through a surviving sheet grant.

Full-table readability includes row restrictions, field scopes, and transitive foreign-field/base formula masking. Write authorization must additionally enforce the true delta's row edit/delete, field write, person membership, and forward-link target rules inside the fenced transaction. No cached JWT reconstruction, allow-all callback, or new grant semantics is acceptable.

The three inputs are true-merged without rewriting their history. The sole manual resolution preserves both independently added exact-anchor real-DB test blocks, unchanged. Original branches and PRs remain untouched.

## Remaining Runtime Work

Shared-policy checkpoint: `5fb07a51126aa228bf635b9d2d49d62720af4c00`, tree `e429ed6710cd948da1c0bd45826a069e4b1c0930`. `recovery-plan-authorization.ts` now owns the existing authorization stabilizer and true-delta evaluator. HTTP delegates to it using its unchanged request/database resolver and full-read evaluator. There is no worker adapter or startup activation yet. The shared evaluator accepts transaction-bound authority/full-read functions; callers must not provide permissive substitutes.

1. Share the existing full-read and true-delta evaluator between HTTP and worker without changing HTTP behavior.
2. Bind background identity to live scope; do not invent an authenticated tenant from a request-shaped object or unverified input.
3. Compose canonical mutation/outbox and post-commit effects; preserve cancellation, lease fencing, and writer-block cleanup.
4. Integrate existing provider-preflight/process-restart work without duplicating their implementation; verify the full combined candidate.
5. Validate standard startup with real provider boundaries and synthetic isolated acceptance before claiming runtime readiness.

Whole-sheet hard-delete resurrection, flags, dispatch, deployment, production and customer data remain outside this work. Ready/merge requires separate authorization. Existing constituent evidence is not combined runtime proof.
