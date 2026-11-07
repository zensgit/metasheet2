# Attendance required meta guard registration — design lock

Base: `9bcaf4b8197eb9752f7eb5010bc0e0ba3cd6d651`. Scope: authorized Draft/HOLD registration repair of the existing `apps/web/tests/attendance-web-guard-workflow.spec.ts`; creator work is independent.

## Evidence and implementation

The actual stdlib parser `allVitestTokens` unions positional filters across all Vitest run invocations after comment removal, continuation folding and trailing error-guard stripping. Case-insensitive substring comparison of every baseline filter against the full target path finds zero covering filters. This is stronger than exact-token absence. The domain lane already registers the spec.

Add only `attendance-web-guard-workflow.spec.ts` to the final exec block as one physical continuation line at its case-insensitive sorted position. This basename with extension matches exactly the one tracked target under apps/web. Regenerate the committed token manifest only with the official stdlib generator --write.

## Gates and boundaries

| Gate | Required disposition |
| --- | --- |
| Frozen base and fetched main | Exactly the base above before branch creation |
| Source delta | This lock, runner, generated token manifest only |
| Token preservation | Every prior token and its multiplicity preserved; only target added once; maximum multiplicity unchanged |
| Invocation/source shape | Invocation count, flags, other physical lines and all other tracked files unchanged |
| Domain/protection/scanner/business/assertions/budgets | Unchanged |
| Runtime guards | Actual runner-derived target31passed; backend token/shape63passed; zero skip; baseline coverage0-vs1 red and token-removal coverage+manifest matching red, exact source restored |
| Global quality | validate:all exit0 on this isolated candidate; no product build/PG/business suite rerun |
| Remote required CI | Pending new candidate head; no borrowed green |

The initial source-only preparation is retained separately. Main executed an offline/frozen install from the existing store (934 reused, zero downloaded), extracted the actual token from the committed runner with the actual parser, ran only its single matched existing spec, verified strict registration guards and two matching token-removal negatives, restored source, and completed validate:all. This is not a full local required-lane rerun; current-head remote CI must prove the whole required chain. No domain/protection/scanner/assertion/budget changes, no product runtime source or native build changes. R71/tag/release/config/Stream/lifecycle remain unchanged/OFF; all PRs Draft, no merge/deploy, realUAT/business50004 excluded, historical08PUT INCONCLUSIVE.
