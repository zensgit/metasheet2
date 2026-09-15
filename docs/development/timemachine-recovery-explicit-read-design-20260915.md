# Recovery Explicit Read Authority

Base: `062614f4407b3d9bffc82dae266071b8a6e5e5bd`.

Recovery already adjudicates a transaction-fresh access snapshot. Its full-read
formula mask currently reconstructs an HTTP user to call request-shaped helpers.
Remove that reconstruction by threading the same explicit access snapshot through
stored-field masking, formula taint and foreign-sheet/base readability. Normal HTTP
callers retain their current request resolution when no explicit snapshot is supplied.

Extract the existing base-read policy into `resolveBaseReadableForAccess`; the HTTP
wrapper delegates to it. Preserve live-base checks, projection restrictions, global
grants, ownership, field scope, cross-base masks and same-base opt-out semantics.
The explicit snapshot is an internal adjudicated input, never a new client argument.

No new grant, migration, flag, provider, restore mode or worker enablement. This is
a prerequisite for request-independent worker policy, not full runtime composition.
Do not duplicate or merge the separate invalid-actor repair in PR #5735 here.

Gates: actual base-read unit controls; AST wiring proof that recovery passes its
snapshot through each taint layer without fabricating a request; existing permission
and taint guard neighbors; production-route real-DB regression; omission mutation;
typecheck and scoped lint; one independent exact-code security review; Draft/HOLD.
No Ready/merge, customer data, production, dispatch or deployment.
