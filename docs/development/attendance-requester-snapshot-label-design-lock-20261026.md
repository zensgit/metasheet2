# Attendance requester snapshot display-label repair — 2026-10-26

Status: derived R7 bug-fix contract, Draft/HOLD. This is not a new capability ratification or a rewrite of S7/W4 authority.

Base: current fetched main4c4cd3abafad0761cb1fedcc8731b4341d02ee19. Whole DingTalk closeout is authorized; no merge/deploy/R71/tag/release/business configuration change. Stream/lifecycle OFF; real UAT/business50004 excluded; historical08PUT INCONCLUSIVE.

## Authoritative scope and evidence

Parent attendance-shift-group-advanced-capability-design-lock-20260723.md §2.3 R7 requires neutral unknown/deleted actor labels and forbids raw user IDs as display fallbacks. S7 resolver lock §3.4 freezes manager/dept-head/chain for step advancement; it does not authorize refreshing historical display names or changing pending-edit routing semantics.

Actual production builder already has2 missing-label matching reds and3 genuine-name/email/name-equals-ID controls in the prior source-identical probe. Fresh main plugin source is byte-identical. Actual source now confirms: buildAttendanceApprovalInstancePayload uses requesterName || userId; pending edit supplies existingRequest.user_id as requesterName; the upsert replaces requester_snapshot. Six call paths include generic/outdoor/dispatch/swap/pending-edit/business-trip, and cross-user paths may bind the authenticated actor's label to the target identity. The latter needs actual-route proof, not source inference alone.

## Minimal implementation boundary

- Keep requesterSnapshot.id and every canonical request/actor/org identity, authorizer, request target validation, workflow, operation envelope, transaction, lock and rollback path unchanged.
- Keep the16-entry upsert SET list, its SQL/parameters structure and org-stamp derivation unchanged. Fix display-name inputs before this existing writer. Do not create another writer.
- New creation names must belong to the authoritative request user. A trusted authenticated name/email may be used only when its source actor identity equals that user. For a cross-user request, resolve the existing authorized target's profile with the existing transaction client after the original target/scope checks. No global search/cache or client-provided name authority.
- Preserve a nonblank genuine name exactly, even if its bytes equal the technical user ID. Email is a fallback only if nonblank and not merely that ID. Missing/invalid display data uses the existing neutral approval-picker term Unknown user, never a technical-ID fallback. This is a fixed neutral API string, not a locale/humanAT claim.
- At pending edit, preserve the existing referenced approval snapshot's nonblank display name without a live directory refresh, including ambiguous legacy names equal to IDs. Scope the lookup through the already-authoritative request/approval identity in the original transaction. Missing or malformed name becomes neutral; an actually absent prior approval row follows the existing new-snapshot path. Do not rewrite historical rows or change manager/dept-head/chain refresh/advancement behavior.
- Preserve legacy snapshot/identity handling. A display-only repair must not invent an org-pin activation, new privilege, cancellation workflow permission or a new business validation rule. Confirm the existing bound instance/request checks before deciding how a mismatched snapshot identity is handled; any confirmed authority defect is separately diagnosed.
- New logic lives in a narrow sibling CJS module; index.cjs and the existing business-trip adapter receive only necessary glue. Do not alter getUserLabel's unrelated actor/audit14-call behavior.
- SQL read errors remain failures under the original request transaction/catch, with fixed values-free error data; no swallowed transaction-abort error, fabricated successful write or raw driver/user-value echo.
- Existing unified approval DTO/bridge forwards the saved snapshot. Verify actual persisted creation/edit snapshots and returned DTOs, not only a pure replacement label.

## Required gates

| Gate | Proof |
|---|---|
| Existing missing-name fallback | Retain the source-identical2red/3control production-builder evidence; add actual route reproductions for affected new cases |
| Target identity | Authenticated self/cross-user creation for six caller paths; forged display inputs ignored; genuine name/email/name-equals-ID preserved |
| Pending edit | Existing nonblank snapshot stays byte-exact after directory rename; missing-name neutral; legacy ID-like names kept; target/org403/409 and original rollback/idempotency behavior unchanged |
| S7/W4 | Existing relation/assignment/snapshot/operation neighbors, unchanged16-entry writer fence and original source budgets |
| Mutation | Neuter missing-name normalization, target binding and frozen-label preservation; matching cases red then exact restore |
| Integration | Isolated UTF8 PG apply/list pending0; real original auth/RBAC/router/plugin/DTO path with explicit source assembly limits; no provider IO |
| Registration | New PG suite in realDB run-list, no-DB exclusion and strict wiring corpus; new sibling module classified accurately under W7 guards |
| Quality/review | Focused lint/syntax, affected guards, validate:all; independent implementation review and main actual assertion audit |
| Publication | Own normal push, Draft PR, exact source manifest; actual published-head required CI and final body readback |
| Existing combined inputs | Targeted new-input compatibility against the frozen private closeout source, not an unrelated green-suite rerun |

This lock does not close whole parent/allactor/native-menu/humanAT, owner approval, manual/soak/live, TRANSFER frozen or excluded work. No customer/provider reads, external writes, enablement or deployment.


## Source review clarifications before implementation

Generic/outdoor are self-only. No symmetric cross-user capability is added. Ordinary pending edit may have a null route org; preserve the authoritative existing request/org-stamp D-10 behavior even after current membership moves. The existing FK binds workflow pairs, not requester JSON identity/org. A present explicit contradictory identity/org must not masquerade as an absent approval; neutralize its label only, without new request rejection. Omitted legacy fields are not positive contradictions. Keep only a valid historical name, not the whole snapshot or its manager/dept/chain fields. Existing completed replay returns before fresh prepare; label reads stay outside command/envelope identity and hashes. Values-free wrapping must preserve genuine retryable SQLSTATE40001/40P01 and the original transaction budget. No new authority defect or malformed production data is claimed from source alone.
