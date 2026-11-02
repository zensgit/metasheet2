# Ordinary data-source audit actor retention

Source commit: `25e0559c3e51cf3915cfe112add84bc98304a8ae`. Parent: MetaSheet Draft #6684 documentation head `8d237dac8ef6f168353d7cf8806a878e026bd0e5` (source `9fb1e39570abf7802479575e755b679dcab9ff24`).

## Problem and change

A normally authenticated UUID user can create or manage a private data source. The route passes the UUID to `auditLog`, but that shared wrapper converts it with `Number(actorId)`; the resulting non-finite value is omitted from the integer `audit_logs.user_id`. Previously the data-source audit metadata did not retain the actor either. A successful audit insert could therefore lose the identity of the person who performed the action. An object's owner cannot stand in for its actor because platform administrators can manage another owner's source.

All eight existing data-source audit call sites now pass the existing authenticated identity resolver at the top level and preserve the same string in `meta.actorId`. The metadata property comes after every spread. The shared audit wrapper already forwards metadata to the existing JSONB `action_details`, so no schema migration, numeric surrogate identity, new audit event or manager is introduced.

Coverage includes the cross-owner helper, create, draft connection test, update, both loaded and load-failed credential updates, delete and owner query. Credential values are still excluded by the existing sanitization. The source's owner and access checks use their existing paths.

## Static verification and authored regressions

Root verified that reversing only the declared actor additions and comment restores the parent route byte for byte. There are still exactly eight audit calls. The pre-existing test code is byte-identical after reversing the two synthetic UUID fixtures and the explicit new assertions/cases. `git diff --check` passed. An independent Sol6.1 high-requested static review found no blocking issue; actual model and effort were not returned and remain UNKNOWN.

The existing authority-matrix unit file now uses synthetic UUID owner/admin fixtures and adds five cases: authenticated owner identity despite body and alternate-claim actor fields; UUID admin distinct from source owner; two id-less authentication refusals; and consistency of metadata on audit calls observed by the suite. The pre-existing credential poison sweep remains. These tests mock the audit wrapper and do not prove a PostgreSQL insert or execution of every route branch.

Tests, type checking, build, application startup, HTTP/PG execution, installation and CI for this child are **NOT_RUN**. No previously passed validation was rerun. The patch is a local static development increment; it has not been pushed or opened as another PR because publication could trigger new CI runtime under the current static-only instruction. Future results belong in state and the PR body, without further source or closeout-document commits solely for results.

## Limits and retained gates

The UUID may still have NULL numeric `user_id`; its exact string is retained in `action_details.actorId`. Numeric audit query/aggregation and the MessageBus `who` envelope's legacy numeric fallback are unchanged. This patch does not claim a complete UUID audit identity model or correct the shared MessageBus actor classification.

The earlier c24 actual permission evidence belongs to its original source and was not rerun or relabelled as verification of this patch. Retained compiled artifacts likewise do not include this child. Current main was observed as `b0fc545ce696d2edbfbbd9c0bc3a21bc04bcdb2b`; this stacked child is not rebased onto main, and future main/integration gates remain.

The existing runtime lease is retained. No new runtime, process probe, lease close, grant/BOM action, browser, merge, deployment or production activity occurred. Source23, W2, Claude H3/StageA/RG/#249/perf/inventory/O-axis, P16 and W23 decisions remain in force. All seven delivery packages remain open.
