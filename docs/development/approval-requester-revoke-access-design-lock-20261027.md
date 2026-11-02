# Requester revoke permission boundary — 2026-10-27

Status: Draft / HOLD. Base: 5193da4c5667418a8bd9fa40a9a80021cdcac077.
Branch: codex/approval-requester-revoke-access-20261027.
Scope: the authenticated unified platform-template actions route; no live configuration or deployment.

## Contract

A literal request body `action === 'revoke'` may pass the existing effective `approvals:act` OR `approvals:write` resource guard. Every other action retains the original act guard. Read alone, action arrays/objects/case/whitespace variants cannot use the new exception. The later existing parser behavior for act-authorized callers is unchanged.

The route constructs the actor from authentication and sets a private internal `requesterRevokeRoute: true` marker. Client actor/identity/org/marker fields are not authority. This marker is not an environment flag or public request contract.

For marked revokes, inside the existing locked-instance transaction and after the inherited attendance exclusion, require the stored requester identity and an active `user_orgs` row matching that actor and the nonblank stored instance org. Perform this before instance-derived parameter/policy validation details. Missing/blank org or absent/inactive membership fails closed. This applies to unified-route act/admin calls as well as the new write entry; compatibility is tested with an active-org non-admin act actor. No claim is made for retaining lost-org act/admin behavior. Internal unmarked service/cancel-round callers retain their original ordering.

Membership is observed by an ordinary query within the existing transaction. No new lock order or linearizable concurrent membership-revocation guarantee is introduced.

## Existing rules remain

Keep frozen allowRevoke, real requester identity (including admins), terminal/current-node checks, revoke-before-node window, handled-node audit restrictions and cancellation/attendance/external bridge exclusions. Approved-leave cancellation is a separate capability.

Retain the original transaction: seat deactivation, revoked status, cleared cursor, version increment, requester audit, parallel-state handling, commit/rollback and existing event paths. Do not add a direct-SQL alternate revoke, broaden other actions, or grant employees handler permissions.

## Evidence gates

| Gate | Disposition |
| --- | --- |
| Original write-only-entry mismatch | Actual native RW_SELF403 red; seated non-revoke control passed |
| Initial narrow candidate | Whole11 passed: sentinel,4 original DB cases,6 new DB cases |
| Act-only compatibility / strict raw action |2 additional actual passes,11 filtered exclusions |
| Route, identity, read and membership guard faults |8 groups,9 matching reds,8 RW_SELF controls; exact restore |
| Early-error information disclosure review finding |2 native400-versus403 reds with node details,2 controls; not unauthorized revoke |
| Final early authorization fix |8 affected actual passes,8 excluded; legitimate owner parameter refusal preserved |
| Neighbor / quality |190 actual service-unit passes; final type-check and validate:all exit0 |
| Explicit lint / preservation |Same paths/config/no-ignore, introduced0; original4 test-call AST text exact |
| Current-head required and native CI |PENDING: all required plus dedicated native whole16/sentinel, zero skip |

Passing evidence comes from separate phases and source bindings, not a fresh final whole16 execution. Filtered cases and repeated controls are never extra unique passes. The first type-check detected a missing local row-type declaration; a local org_id intersection fixed that type error. Its failure is retained; final type-check was actually rerun.

## Registration and review

The existing dedicated `approval-realdb-revoke-terminal-guard.yml` triggers on both changed runtime paths and this test, executes the whole file with EXPECT_DB=1 and verbose output, and remains byte-identical. The default no-DB config excludes the file. Shared required/backend/web greens do not prove this native lane ran. No frontend spec or workflow is added.

Initial independent source review found the early fieldWrites disclosure; main reproduced both cases and moved only the marked-route authorization. The follow-up is source review, not test execution. Exact raw reporters, log hashes and main disposition are retained privately.

## Deployment and business boundaries

The human reports R74 build commit f3efc86c0159408ec8531b887d86a157368af666. Seven relevant source files match this base; no live binary/image digest was independently read. The controlled original403 matches the reported permission symptom, not a complete live-environment qualification.

Seven reported leave templates remain unpublished. This PR does not assign unverifiable demo manager/head relationships, publish/delete templates, change directory/permissions or inspect secret values. No merge, deployment, R71/tag/release/config/flag change. Stream/lifecycle/external writes OFF. Real UAT/business50004 excluded; historical08PUT INCONCLUSIVE. Parent owner/manual/frozen/live gates remain open.
