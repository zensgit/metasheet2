# Current-source managed frame discovery

Source `0dfe9ed675e9c35e7f53306be1f682828ccd56e9` adds POST `/api/plm/managed-login/discussion-context` as the metadata bootstrap needed before a managed iframe can trust its Native parent or choose a source. It reuses the existing managed Discussion admission code and remains behind the actual global JWT/managed-cookie middleware. It is not added to the token-only whitelist.

The strict body is `{operation:"context",parentOrigin:<candidate browser message origin>}` plus a fresh Native Ed25519 embed token in the existing header. The source is selected from the current authenticated managed session and actor, never a query/body source ID, the most recent link or global adapter configuration. `lockManagedBomAuthority` then checks and locks all current session/link/generation/user/membership/source/registration state. Native Auth subject/tenant/org/part and Meta client recipient remain separately checked. The candidate parent must exactly equal the locked persistent Native source URL's normalized origin. A mismatch or extra source selector refuses before JTI consumption.

The accepted bootstrap consumes the shared single-use token and returns only `{sourceId,partId,parentOrigin}`. It does not exchange a Discussion purpose credential or return a grant/token. Each later read/write still needs its own fresh Native token and independent existing purpose exchange. Context cannot be used as an implicit source fallback for a write. Cache-Control is no-store and Referrer-Policy no-referrer.

## Actual evidence

**174 unit assertions pass**, comprising existing171 plus three source-discovery/refusal controls. **25 actual integration assertions pass** through Meta PostgreSQL, production Redis, Native HTTP with separated Native PostgreSQL stores, and two independently started Meta processes using actual JWT middleware/router. The prior22 operation/identity/expiry/process-race/unlink cases remain green. Three new cases establish:

- No cookie refuses, the same fresh token with the correct managed cookie returns exact source/root/registered parent, replay refuses, and no Discussion exchange occurs.
- Forged parent and caller-selected source refuse before spending the token; the identical token succeeds after the request is corrected.
- Two different live delegated sessions resolve their own sources, including the older session after a newer source exists. No latest/global-source fallback occurs.

All individual assertion statuses are passed; no skip/zero-test inference is used. Both Meta processes acknowledge shutdown and exit0, Native/PG/Redis stop, and the owned directory is removed. Source digests before/after and ten critical Git blobs match. Full backend no-emit types and actionlint pass. CI gates increase171→174 and22→25; no threshold is weakened. CI is defined and locally checked, not remotely run.

Raw reports are in the private archive referenced by `artifacts/plm-managed-discussion-context-20261020/verification.json`. The sparse checkout initially omitted the newly switched workflow/coordinator files; exact HEAD blobs were materialized. The missing-file invocation started no resources. The accepted portable coordinator is the second context run. Native API product paths remain equal to fixedf87 even though the isolated Native checkout includes subsequent configuration/document commits.

## Browser integration still to implement

The Native managed launcher currently performs a top-level redirect, so its existing iframe token broker does not survive that navigation. The existing per-frame broker already pins contentWindow/origin/part/generation and mints fresh read/write tokens; reuse it. The existing Discussion panel already owns the engine/UI and should receive the managed transport, rather than introducing another Discussion implementation.

A managed frame must treat initial message origin as a candidate only until this bootstrap verifies it against persistent configuration. Authentication must use the current managed/normal browser identity rules and clear old rendered data on identity/source changes. Missing Meta authentication must use the existing explicit top-level managed-login bridge; do not navigate Native consent inside an iframe, infer authority from an opener, weaken cookie rules, or use a shared credential fallback. Verify actual CSP, same-site cookie behavior and the complete rendered browser flow before accepting the entry. Metadata discovery alone does not complete this journey.

Managed Visual admission and key-enabled installation/recovery remain open. The independent key-handoff e817 and earlier917 package71-check evidence are separate scopes; the new product source has not been packaged/installed. Full W01–W23 stays active. Keep all PRs Draft and preserve #363's valuable queued perf job118040891880; source plus one documentation commit remain local until serial dependency publication is permitted. No merge, deployment or production enablement occurs.
