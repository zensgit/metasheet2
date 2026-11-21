# MUT06 W2-08 global settings read — finite native proof

Refs #4556. Draft/HOLD. This slice proves the existing deployment-wide attendance.settings reader, not a new tenant-scoping exception or a complete MUT06 denominator.

The production createPluginAttendanceWorkDateResolver and its real PostgreSQL adapter must read exactly the bound global key, normalize the existing camel/snake fields and 0..360 minute bounds, retain the 120 minute fallback, and reject an array source. Two synthetic organizations observe the same global value while their published shift identities remain separate. Every test uses one physical transaction and rolls back all fixture writes; settings are compared before/after.

| Gate | Required evidence |
|---|---|
| G1 | Seven actual parameter cases, no skipped success; native SELECT and exact bind positive controls |
| G2 | Wrong-key and normalization-removal mutations produce matching failures; restore production bytes |
| G3 | Existing neighboring W2 org-scope case still passes; original test/hook bytes unchanged |
| G4 | Explicit changed-file lint against baseline; production quality applicability or current validation |
| G5 | Current PR CI actual full W2 file; Draft, no enablement/deployment |

Only the resolver reader is exercised here. The active-current caller, PUT writer authority, every-query census completeness, owner acceptance and live-provider proof remain separate. No runtime, schema, API, dependency, workflow or flag change is intended.
