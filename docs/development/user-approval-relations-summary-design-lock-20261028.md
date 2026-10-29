# User-management approval relationships — Draft/HOLD

User-authorized scope: explain that users.position is profile text, show current existing organization approval relations, and link to /admin/organization. No per-employee manager assignment, policy write, relationship write, automatic title interpretation, or new permission.

Use the existing resolveApprovalRequesterOrgRelations with its production kernel policy/source resolution, without preview overrides or new selection logic. A narrow platform-admin authenticated GET reads one consistent READ ONLY snapshot. Return only the selected subject, source posture/provider, primary department, and manager/head public display identities. Legacy selection is labelled implicit and potentially changeable; no source forcing. Unresolved/misconfigured/error/403 states are explicit and clear prior data. This is current relationship context, not a published-template simulation or old-instance rewrite.

UI: position explanatory text in create/edit; create has no saved target and shows pending configuration. Edit mounts a separate component keyed by selected target. Prevent stale user/session/org requests from presenting old relations. Relationships are display-only; maintenance link uses the existing organization workspace. No automatic data writes.

R77 dependencies are separately delivered Draft #6589 (native local head resolution) and #6592 (organization workspace). Their existing tests are not rerun. This slice remains a standalone Draft on fresh main; full local-head behavior requires that source union, not a fictitious Git ancestor or merge. Exact R77 target commit pending.

Gates: exact response and authentication/403/404/invalid-input negatives, genuine resolver delegation/source parity, READ ONLY before reads, current/empty/misconfigured UI and selected-user/session/org/unmount late-response refusal, no mutations from summary, two-point frontend CI wiring, focused affected lint/type/build/quality and meaningful matching guard negatives. Synthetic browser entry evidence; preserve all unchanged suites. Existing instances remain frozen; new creation uses existing routing.

No merge/deploy/R71/tag/release/business configuration/provider writes; Stream/lifecycle/externalwrites OFF; UAT/50004 excluded; historical08PUT inconclusive. No complete-product acceptance.
