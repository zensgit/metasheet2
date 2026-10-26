# W6 personnel calculation-membership history — 2026-10-26

Status: authorized existing-parent remaining engineering; Draft/HOLD, implementation and gates pending.

## Existing contract and evidence

Parent attendance-shift-group-advanced-capability-design-lock-20260723.md §§3.4/5.1 requires personnel calculation-group attribution and date changes. Ordinary management-group member createdAt / Joined is audit time, not calculation effective time. Preserve these distinct concepts.

Existing GET /api/attendance-admin/calculation-group-memberships requires orgId + userId. Core attendance:admin plus canReadAttendanceDirectoryReadiness checks platform/delegated-admin and active organization scope. listAttendanceCalculationGroupMemberships returns the selected person's complete org timeline ordered by effectiveFrom/id and rejects corrupt overlapping intervals. effectiveFrom/effectiveTo are inclusive; null means no recorded end, not proof of current activity. A D transition closes the previous interval D-1. No new endpoint/permission is required.

The API's organization query is supported; do not misdescribe it as principal-only. Server authorization remains authoritative; the client capability controls affordance only. No global search/fetch-all-then-hide or new identity authority.

## Smallest complete consumer for this requirement

- In the existing People stage, behind attendanceGroupEffectivePolicyPanel and the existing attendance:admin UI capability, provide a separate read-only calculation-group-history view for a selected organization person. It is not limited to ordinary current management members; explicit org-scoped search using the existing endpoint, or a known person ID can identify historical/former members. Explicit View/Refresh triggers the timeline GET; no auto timeline reads.
- Render the complete returned timeline with inclusive calendar dates unchanged (no UTC/local conversion), resolved scoped group names where known and neutral unknown group labels otherwise. Separate technical group information from primary names. Never display assignedBy/reason/correlation/createdAt as actor names or effective dates.
- Project only row ID/groupId/effectiveFrom/effectiveTo, after validating response shape, exact org/user, UUID identity, valid calendar dates, ordering, unique row IDs and nonoverlap. Missing/malformed or cross-scope rows make the whole result unavailable; no partial filtering that hides an error. Legitimate empty items is explicitly no recorded intervals and does not infer org default. Unknown audit fields are ignored and never echoed.
- Missing end is explicit No recorded end, not Effective/active. Do not compute winners, effective badges or change cardinality. One calculation group per person/org/day remains the server's existing invariant.
- OFF returns the same original People element VNode, with no new wrapper/Fragment/comment/scopeID/DOM or reads. Existing management membership/owner writes, fields and handlers remain exact. ON preserves the existing member section and adds an independent read-only section. No transition POST, create/remove/auto-move or additional flag.
- Both GETs pass existing suppressUnauthorizedRedirect and an owned AbortSignal. Scope invalidation aborts transport retry as well as rejecting late data. Subscribe to existing auth-reset and relevant storage notifications through a local epoch; invalidate synchronously even when the current permission returns true again after A-B-A. Do not modify global API/auth semantics or clear auth storage in this reader.
- Scope and stale-response guards are synchronous for person/group/org/stage/enabled/capability/session/unmount, including A-B-A. Check before dispatch and after response/JSON/catch/finally. Clear previous result on scope change, do not auto replay/fetch. A scoped error or denial is unavailable/forbidden, not empty success, and raw server details never become UI messages.
- Person search calls the existing /api/attendance-admin/users/search with explicit orgId+nonblank q only on Search. No scope=global, no initial automatic directory read. Use only name/email primary labels and neutral missing labels; name equal to ID can be genuine and is retained, while an email equal to ID is not used as a technical placeholder fallback. The shared picker is unchanged; its auto-load/error and selected-org timing behavior is not expanded by this view.
- Group lookup is only the already loaded scoped catalog; unresolved names remain neutral, no extra per-row fetch. The timeline covers the selected person across groups, not an inferred complete historical people census or an authorization claim for a target outside the server's org scope.

## Gates

| Gate | Required evidence |
|---|---|
| Parent original missing effective-date UI | Mounted original-source matching red with original management/permission controls |
| Typed timeline projection | Valid inclusive and open intervals; invalid enums/dates/scope/order/duplicate/overlap negatives; no raw/audit-value echo |
| Real mounted consumer/host | Explicit org+user GET; org-scoped picker; whole response; full-admin hint and server403 handling; no writes; no auto reads |
| Temporal safety | Header/response/JSON/error/finally and A-B-A, user/org/group/stage/capability/session/unmount stale paths |
| OFF exactness | Original raw People DOM and request ledger same; no wrapper/comment/scope change |
| Both live frontend lanes | New specs in domain paths/classifier/run and reachable required runner, manifest maximum multiplicity |
| Negative controls | Scope fence / invalid data / permission / no-writer / OFF protection mutations matching red then exact restore |
| Quality / review / actual-entry | Focused neighbors and lane guards, scoped lint/validate:all/build, independent review; synthetic native desktop browser and honest mobile gate |
| Publication | Own normal branch push, Draft PR, frozen sources, actual current-head required CI and final readback; private compatible input UNION |

Existing backend/W1 authorization, transactions, transition semantics, migration/roles/configuration unchanged. A UI mock is not real server authorization evidence; retained applicable existing receipts or a bounded new actual-server probe must be identified separately. No provider/customer IO, R71/tag/release/config changes, merge/deploy, Stream/lifecycle enablement. Real UAT and business50004 excluded; historical08PUT INCONCLUSIVE. Whole allactor/humanAT/owner/manual/live acceptance remains separate.


## Recorded qualification boundary

Local gates and exact phase limits are recorded in attendance-w6-membership-history-verification-20261026.md. Standard native-select automation qualified the application flow; the Mac headless native-menu keyboard attempts did not select an option and remain unclosed with humanAT. No claim of whole-page OFF equality, functional mobile administration, whole parent acceptance or current-head public CI success is made before those gates are evidenced.
