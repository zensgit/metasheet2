# Time Machine Manual Capture Contract

Status: OWNER-CONFIRMED bounded scope; implementation and acceptance OPEN.

Owner confirmation: `确认手动归档合同` on 2026-09-17, in response to the
proposal to let an administrator explicitly select a table for manual archive
capture, with isolated synthetic verification and without automatic scheduling,
retention cleanup or customer storage integration.

Inspected base: `89f1ecdee2c3b70205a318074824c834bc6a5c7e` (merged #5848).
This confirmation removes the manual-capture scope blocker only. It does not
ratify the deferred numeric policies in `timemachine-capture-policy-proposal-20260917.md`,
resolve nightly monitoring failures or authorize deployment.

## Confirmed Boundaries

1. An authorized administrator explicitly selects an existing table and initiates
   capture. No implicit all-table scan or startup-triggered capture is added.
   Administrator means the existing recovery authority for that table, not a new
   global-admin bypass. Concretely, reuse authenticated identity,
   `canManageSheetAccess`, full-table read and live sheet/base/workspace scope
   checks; the name of an existing `OwnerContext` helper is not a new
   workspace-owner-only policy. Workspace/base/table/actor bindings remain
   server-owned.
2. Capture creates a recoverable archive of the selected source state. It does
   not move the table to trash, delete it, overwrite live records or perform a
   restore. Archive creation and restore acceptance remain separate commands.
3. Reuse the existing archive format, source seals, coverage proofs, encryption,
   authenticated object receipts, catalog and canonical restore writer. Do not
   expose arbitrary client-supplied rows, source vectors, storage paths, keys,
   manifest hashes or verified-state assertions as capture inputs.
4. Only complete, authenticated captures may become recoverable catalog entries.
   Missing sections, failed storage writes and interrupted capture cannot be
   presented as success. Empty sections require authoritative empty evidence;
   empty arrays must not hide an unsupported source reader.
5. Implement and verify in an isolated worktree with synthetic data and
   task-owned local storage/DB only. Existing runtime switches remain unchanged
   and fail closed. Ordinary push and Draft/HOLD publication follow standing
   authorization; Ready/merge require separate exact authorization.
6. No automatic schedule, retention duration, automatic cleanup, customer NAS
   access, flag enablement, dispatch, staging/deployment, production or customer
   data operation is authorized. Do not revive an already hard-deleted table.

## Source-Grounded Reuse

These are existing components, not evidence of a completed manual-capture flow:

| Component | Existing responsibility |
| --- | --- |
| `recovery-archive-section-rows.ts` | Exact canonical rows for nine data sections |
| `recovery-archive-snapshot-plan.ts` | Ten-section plaintext plan, derived coverage and nonce validation |
| `recovery-archive-section-bootstrap.ts` | Snapshot/section identity reservations and source bootstrap consumption |
| `recovery-archive-seals.ts` | Bound section and snapshot source seals |
| `recovery-archive-object-receipts.ts` | Uploaded/verified object evidence and transactional receipt verification |
| `recovery-archive-catalog.ts` | Existing catalog read contract |
| `recovery-local-startup.ts` | Explicit local custody/provider composition; no capture scheduling |
| `univer-meta.ts::resolveRecoveryArchiveRestoreOwnerContext` | Current manage-sheet + full-read authority, server scope and fresh recheck |

The inspected planner explicitly has no database, storage, route or production
caller responsibility. Its presence must not be reported as a manual capture
button or a complete source-to-archive pipeline.

## Implementation Invariants

- Preserve current recovery permission checks and recheck authority at acceptance
  and publication. Cross-workspace/base/table substitution, revoked authority,
  callers without the required capabilities and managed/system-table
  restrictions must fail closed.
- Use an exact consistent source boundary for all mandatory sections. Source
  movement during capture must not create a mixed-time snapshot. Do not hold an
  unbounded database transaction across object-store operations merely to avoid
  defining the source-boundary protocol.
- Give a manual request a durable identity with a canonical payload binding.
  Same-identity retry must recover the original capture rather than duplicate an
  effect; a conflicting payload must be rejected. Existing reservation and
  publication authority are the first reuse candidates, not a second ledger by
  default.
- Return values-free failures and closed progress/result DTOs. Do not return
  plaintext row data, secrets or physical storage locations in diagnostics.
- Use the unlocked configured provider. Capture cannot provision custody or
  unlock it implicitly. Storage exhaustion or receipt verification failure
  refuses publication; it cannot trigger archive deletion or shorten retention.
- UI progress reflects durable server state. The UI must distinguish pending,
  failed/incomplete and recoverable outcomes according to the final server
  contract; reload/retry must not manufacture success.
- The user reviews and accepts a restore separately through the existing preview
  and canonical writer path. Capture success does not grant restore permission.

## Required Acceptance

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Permission and identity | Authorized positive; unauthenticated/missing-capability/cross-scope and revocation negatives | OPEN |
| Live source capture | Selected synthetic table to canonical sections, with concurrent-source boundary proof | OPEN |
| Complete publication | All mandatory receipts/coverage; missing/corrupt section and storage-failure negatives | OPEN |
| Retry/concurrency | Same request replay, conflicting payload refusal, concurrent attempt and interruption recovery | OPEN |
| Recovery loop | Public catalog -> preview -> separate restore -> exact schema-valid state comparison | OPEN |
| User experience | Real selected-table entry, confirmation, durable progress, reload and failure display | OPEN |
| Discriminating tests | Neutralize authority, scope, receipt/coverage and retry guards -> targeted RED -> restore GREEN | OPEN |
| Isolation | Exact/prefix DB, backend, child process and temporary storage residue zero | OPEN |
| Publication | Required test selectors, immutable reviewed head, exact-head CI and design/verification MD | OPEN |

Empty-table and nonempty-table positives are both required. Unsupported
attachment/section shapes must be visibly refused, never silently omitted.
Record local measurements separately from configured recovery objectives; no
RPO/RTO, NAS durability or independent backup SLA is implied.

## Execution Order

One coordinator owns writes. First trace and implement consistent source capture
and reuse existing publication authority; then bind the command to existing
recovery authorization and the table UI. Review high-risk persistence/permission
changes independently on a frozen head. Run focused neighbors and mutations,
then isolated DB/browser acceptance and required CI wiring. Do not split off
another unused pure-policy implementation and call this contract complete.

Technical route spelling, persisted request representation and exact file scope
are implementation decisions to record after the source trace, not new business
permissions. Any need to widen capture/restore semantics beyond these boundaries
returns to the owner. Keep historical SHA-scoped reports unchanged.
