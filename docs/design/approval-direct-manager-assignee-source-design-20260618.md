# Approval — `direct_manager` assignee source (design-lock)

**Status:** design-lock → implemented in the same PR (decisions pre-approved by the owner).
**Builds on:** the landed read-only org-relation plumbing that bakes `requesterSnapshot.managerId` (derived from the directory `leader_in_dept` of the requester's primary department, self-excluded) at approval creation. This lane turns that snapshot field into an authorable **assignee source**.

## What it is
A new assignee-source kind `direct_manager` that resolves a node's approver to the requester's direct manager. It carries **no extra config** — it is requester-relative, like `requester`.

## Locked decisions
1. **Unresolvable manager → empty result → existing `emptyAssigneePolicy`.** When `requesterSnapshot.managerId` is absent (e.g. the requester is the org head, or no leader was synced), the resolver returns **no assignment** for that source. The node then follows its configured `emptyAssigneePolicy` (`error` / `auto-approve`) through `ApprovalGraphExecutor` — exactly the existing semantics for any source that resolves empty. No special-casing in the resolver.
2. **Manager == requester → exclude self → empty result.** If the resolved `managerId` equals the requester's own id, the resolver treats it as **no valid manager** and returns empty (falling to `emptyAssigneePolicy`). This mirrors the directory resolver's own self-exclusion. We deliberately do **not** defer this to the self-approver (`autoApprovalPolicy`) path: `direct_manager` semantically means "someone *above* the requester," so a self-resolution is invalid by definition, not an auto-approval opportunity.
3. **Point-in-time snapshot.** The resolver reads `requesterSnapshot.managerId` **frozen at approval start**. There is no live directory re-query during dispatch / admin-jump / return — consistent with the frozen runtime-graph + snapshot model every other runtime path already follows.

## In scope (this PR)
Backend type (`ApprovalAssigneeSourceKind` + `ApprovalAssigneeSource` union) · normalizer (accept `{ kind: 'direct_manager' }`, no extra fields) · resolver (`ApprovalAssigneeResolver`, read `managerId`, self-exclusion, push when present) · metadata (`resolvedFrom.kind = 'direct_manager'`, automatic via `metadataFor`) · FE type/draft/source-picker/`sourceFromStep` · tests (normal resolve, unresolvable→empty-policy, self-exclusion→empty, metadata, hydrate/save UI, real-DB create/start).

## Out of scope (stay gated)
`dept_head` (waits on a sync-plumbing slice — `dept_manager_userid_list` is not captured by the current department-list sync) · `continuous_managers` (multi-level escalation, later) · any live re-resolution · W7 result write-back (locked).

## Implementation checklist
- [ ] `ApprovalAssigneeSourceKind` += `'direct_manager'`; union += `{ kind: 'direct_manager' }`.
- [ ] `normalizeApprovalAssigneeSources`: `case 'direct_manager': return { kind: 'direct_manager' }`.
- [ ] `resolveApprovalAssignees`: `case 'direct_manager'` → read `requesterSnapshot.managerId`, push `user` assignment iff present **and** `!== requester id`.
- [ ] Metadata: `resolvedFrom.kind = 'direct_manager'` (no change needed — `metadataFor` keys off `source.kind`).
- [x] FE: `ApprovalStepSourceKind` (auto via `ApprovalAssigneeSource['kind']`), `draftFromTemplate` kind→sourceKind map, `sourceFromStep`, the source-picker option, **and the `unsupportedTemplateAuthoringReason` source-kind allowlist** — without it a saved `direct_manager` template reads back fail-closed/read-only (write-out / can't-read-back). FE `ApprovalAssigneeSource` type is mirrored separately from the backend, so both are updated.
- [x] Tests: resolver (resolve+`resolvedFrom` metadata / unresolvable→empty incl. null snapshot / self-exclusion→empty), authoring (hydrate + save round-trip), and a **mounted-view read-back** regression (a saved `direct_manager` template is NOT fail-closed: no unsupported alert, save enabled, sourceKind hydrated).
- [x] Real-DB integration is **scoped to create/start + the unresolvable→`emptyAssigneePolicy` decision on BOTH branches** (auto-approve cascades past the empty node; `error` rejects at start). The **resolved-manager assignment** (managerId present → manager assigned) is covered by the resolver unit (resolution logic + metadata) + the `ApprovalDirectoryOrg` plumbing tests (directory→`managerId` bake); it is intentionally **not** re-seeded here as a 5-table directory fixture (`directory_accounts.integration_id` FKs to `directory_integrations`).
