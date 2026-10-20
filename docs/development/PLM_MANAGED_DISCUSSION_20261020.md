# Managed Discussion identity and transport verification

Source `b3b813991f2dd1b8b75f10e603697781b640e7b9` on `codex/plm-managed-discussion-20261020` builds on the independent managed-authority expiry fix `237ed70305312c046a1b0be7bfb140198757e3fb`. This bounded backend slice is locally verified and unpublished. The complete W01–W23 goal remains open.

## Authority and behavior

POST `/api/plm/managed-login/sources/:sourceId/discussion` uses the existing global JWT/managed-cookie authentication path. It supports list, thread, create, comment, edit, delete, resolve and reopen through the existing Native Discussion engine. The legacy shared adapter still refuses managed sources.

`lockManagedBomAuthority` holds current session/link/generation, persistent source, owner/active user, Meta membership and registration locks through the Native operation. The managed BOM read session identifies the link only. A separate fresh Ed25519 Native token must match Native Auth subject, Native tenant/organization/part, and registered Meta recipient. Browser Origin must equal that registered Meta origin. Persistent source URL and scope are independently checked; Meta identities never stand in for Native identities.

Read and write operations exchange separate Native Discussion purpose credentials. No read/approval grant or shared credential authorizes writing. Shared Redis JTI consumption occurs after local admission. There is no redirect or automatic request retry. Provider internal errors are sanitized. Plain input rejects Visual markup/anchors, and the existing Visual response projector strips gated geometry regardless of ambient feature flag values. Current-source Visual admission remains separate work.

## Actual verification

- **171 unit assertions pass**, including the existing142 and new29. New tests use real signatures and loopback HTTP; authority SQL and Redis are mocked only in that layer. All eight mappings, identity/scope/source/origin/refusal/replay/outage/redirect and error sanitization are covered. Five controlled Visual disclosure counterexamples failed before the projector fix and pass afterward for false/true/TRUE/1/empty flags.
- **19 integration assertions pass** through the committed portable coordinator, actual Meta PostgreSQL, Redis7.4.10, independent Native API and distinct Native PostgreSQL stores. Actual Native first-party login/PKCE authorize/exchange/status/revoke supplies live delegations. The mounted real Meta JWT middleware/router tests cookie/no-cookie, source ownership, revoked delegation, active-user refusal with same-token restoration, persistent source drift, all eight operations and foreign-root controls with Native first-party positives.
- Actual HTTP unlink waits for an admitted Native comment, freezes exact revoke identity, acknowledges unlink and refuses subsequent calls without another exchange. Independent database writers test lock serialization and expiry after link/membership waits. The separate helper fix and its48 read-PG/16 snapshot-PG regressions are documented in `PLM_MANAGED_AUTHORITY_EXPIRY_20261020.md`.
- Backend TypeScript no-emit and both changed workflows pass actionlint. Actual individual test statuses are checked, not merely Vitest top-level counters. The portable coordinator verifies unchanged1437 source files during execution and nine critical source Git blobs afterward. All owned successful processes shut down and the owned directory was removed; raw failures remain private.

The immutable Native API pin is `f87e019b2f01ae97dca2b2a13aa426c269e31a6b`. Locally executed Native head `e26ec6c12a6b361e63ac95235fe96b3d7d45d40a` has identical `src`, locked requirements and Native fixture bytes to that pin. A new CI lane checks out the exact pin, requires Node20/Python3.11, immutable Redis source checksum, PostgreSQL16 tools, all19 assertions, source stability and process cleanup. The existing companion unit gate increases142→171; no gate is lowered. CI has been defined and statically checked, not remotely executed.

Compact proof: `artifacts/plm-managed-discussion-20261020/verification.json`. Detailed raw evidence is retained in the private archive named there. The first portable invocation refused an already-created output log before starting resources; the distinct-output second invocation passed. Earlier fixture/setup failures and the genuine stale-session/Visual counterexamples remain preserved and are not counted as green runs.

## Remaining acceptance and publication

Meta managed session rows are provisioned fixtures against real Native delegation. This proves the mounted JWT/router composition, not the Meta OAuth callback persistence path, full application/browser, complete migration chain, two Meta workers, or installation. The process topology is Native API plus the Meta test HTTP server and independent PostgreSQL writers. The earlier unbound95-check concurrency proof is separate.

Next: integrate the existing frame token broker and Discussion panel into the managed workspace, implement actual current-source Visual admission, hand off independent embed signing/verification keys through the existing package manager, then build and install the exact new package and exercise browser, disable/recovery and backup/restore. Existing f0ee host/images omit both this feature and the shared expiry fix and cannot qualify the replacement.

Preserve #363 head `74fcf61f8669a9cd3af91457347d09bc647a97f6` and valuable queued perf job118040891880. Publish dependencies serially only after that job is terminal; the Native pin must exist remotely before this CI runs. Keep every PR Draft. No merge, deployment, production enablement, historical HOLD change or business notification is performed.
