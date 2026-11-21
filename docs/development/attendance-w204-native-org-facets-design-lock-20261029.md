# W2-04 native organization facets — Draft evidence slice (2026-10-29)

Refs #4556. This test-only slice implements the existing organization-removal mutation gate in section 7.4 of attendance-shift-group-advanced-capability-design-lock-20260723.md. It changes no product contract, runtime, schema, dependency, workflow, flags, or business data.

The existing resolveEffectiveCalendar test seam reaches loadShiftReferenceLookup's unfiltered branch from a persisted whitespace rotation reference under ordinary current constraints. Fixtures are transaction-local, namespaced, and rolled back. The requested organization is exercised in both directions.

| Gate | Required evidence |
| --- | --- |
| W204-OUTER | Actual unfiltered PostgreSQL rowset contains only the requested organization; removing only outer scope with valid binds gives the named rowset failure. |
| W204-SEGMENT | Actual executed unfiltered carrier retains seg.org_id = s.org_id and returns exact legal segment counts; removing only this predicate gives the named executed-carrier failure. |
| W204-INTEGRITY | Actual composite FK rejects foreign-org segment insertion with SQLSTATE 23503 and the exact constraint, while legal rows survive savepoint rollback. |
| Preservation | Original eleven test bodies and budgets are unchanged; runtime exact restoration after each mutation; three new cases and one existing neighbor initially pass; two mutations each produce one matching failure and two unaffected controls; final three pass. |
| Delivery | Same existing backend CI registration; current-head actual execution and required checks before final evidence closure; explicit baseline lint comparison and validate:all; independent source review; Draft only. |

The segment predicate is defense in depth under a composite FK. This proof does not claim a legal foreign-row leak, disable constraints, fabricate rows, or cover every MUT06 facet. Existing W2 six-carrier/ten-facet, W208 reader, and W7R6 proof stay separate. Original failed attempts remain evidence, never counted as passing executions. R77 organization packaging, owner/manual acceptance, real provider/Redis and other pending semantics remain independent.
