# Data Factory #2342 C4 - large-BOM checkpointed apply design (2026-06-06)

## Scope

This is a design-only slice for the #2342 large-BOM Apply lane.

It defines how a future implementation should apply a completed large-BOM
stock-preparation plan without relying on one long HTTP request.

C4 adds no runtime, route, UI, worker, migration, package, MetaSheet row write,
PLM write, external database write, K3 path, production rollout, or retry
service. It is the contract for the later large-BOM writer implementation.

## Current grounding

The existing C4 helper, `applyStockPreparationPlan`, already has the correct
per-row write semantics:

- `add` is idempotent: find by idempotency key, patch if present, create if
  absent.
- `update` and `inactive` are find-then-patch only; no create-on-miss.
- `skip` and `manual_confirm` write nothing.
- human-preserved fields are omitted and defensively rejected.
- per-row failures are recorded and the writer continues.
- evidence is values-free.

That helper is safe for small reviewed plans, but it loops synchronously through
one in-memory plan. Large BOMs need a wrapper/job model that can checkpoint and
resume; simply raising caps and calling the synchronous writer is rejected.

## Decision

Large-BOM Apply must be a separate checkpointed apply job.

It consumes only a completed, authoritative C3 expansion/plan artifact plus an
explicit large-BOM owner approval. It does not consume browser-supplied plans,
payloads, caps, source bindings, target bindings, sheet ids, field ids, or raw
rows.

The current C4 per-decision write helper remains the semantic primitive. The
new layer is responsible for:

- approval binding;
- target/action locking;
- chunking;
- checkpointing;
- resume;
- values-free progress;
- failure isolation.

## Hard invariants

- Apply requires Data Factory write/admin permission from the authenticated
  approver. Permission is never hardcoded and never supplied by the browser.
- The target records API is server-scoped to the configured target sheet/object.
  Browser input cannot point the writer at another sheet.
- Apply consumes a server-side completed C3 artifact/plan revision.
- Manual-confirm decisions are held and never written.
- `skip` decisions are skipped and never written.
- `add` remains idempotent: existing key patches, missing key creates.
- `update` and `inactive` remain find-then-patch only; missing target row is a
  row-level failure, not create-on-miss.
- Human-preserved fields are never written.
- Per-row failures do not abort already-clean rows.
- No automatic retry storm. Resume/retry is checkpointed and owner-visible.
- Evidence is values-free.
- No PLM write, external database write, K3 path, Submit/Audit/BOM, raw SQL,
  JavaScript, URL, external call, or browser-supplied handler.

## Approval contract

Starting a large-BOM apply job requires all of:

- C3 completed artifact or completed full plan;
- plan revision bound to the C3 artifact revision;
- target binding revision;
- action config revision;
- decision counts and manual-confirm count;
- explicit large-BOM apply approval by an authenticated write/admin user;
- server policy allowing large-BOM apply for the action/tenant/workspace.

The normal C5 dry-run token is not enough for large-BOM apply. A future
implementation should issue or record a large-apply approval binding that is
specific to:

- action id;
- tenant/workspace/project scope;
- plan revision;
- target revision;
- approver principal;
- approval timestamp;
- accepted manual-confirm hold flag.

If any bound revision differs at start, the job fails closed and asks for a new
full review.

## Job lifecycle

Suggested lifecycle:

| Status | Meaning | Writes? |
|---|---|---:|
| `queued` | Approved and waiting for a worker. | No |
| `running` | Worker holds the lease and writes chunks. | Yes |
| `paused` | Operator/admin or budget pause; resumable. | No |
| `partial` | Some clean rows wrote, some rows failed/held. | No active writes |
| `succeeded` | All writable decisions completed, no row failures. | Complete |
| `failed` | No further progress possible without intervention. | No active writes |
| `cancelled` | Cancelled before completion. | No active writes |
| `expired` | Approval/artifact expired. | No active writes |

`partial` is an honest terminal or paused state for row-level failures. It must
not be hidden as success, and it must not cause an automatic retry loop.

## Checkpoint model

Minimum private apply checkpoint state:

- apply job id;
- C3 job/artifact id;
- plan revision;
- target binding revision;
- action config revision;
- approver principal and permission class;
- lease owner and lease expiry;
- next decision index or next stable decision key;
- per-decision result checkpoint;
- counts by result status;
- values-free error summaries;
- started/updated timestamps.

The checkpoint must be durable. Memory-only apply checkpoints are forbidden.

The checkpoint must advance only after the corresponding decision result is
persisted. If the process dies after a write but before a checkpoint, resume
must be safe because the per-decision writer is idempotent:

- `add` re-finds the key and patches instead of creating a duplicate;
- `update`/`inactive` re-patches the same target row;
- `skip`/`manual_confirm` remain no-write.

## Chunking and leases

Large apply runs in bounded chunks.

Minimum policy knobs:

- decisions per chunk;
- max chunk elapsed time;
- max row failures before pausing;
- max active apply jobs per tenant/workspace/action;
- lease timeout and heartbeat interval.

The worker must stop cleanly when it loses the lease. A second worker must not
write the same job concurrently. V1 should prefer sequential writes; bounded
parallelism is a later optimization only if it preserves target locks,
idempotency, and values-free result ordering.

## Target and auth scoping

The future route must derive all target scope from server-side action config.
The browser can provide only an action id/path id, allowlisted parameters, and
an apply approval confirmation.

The records API injected into the apply job must be target-scoped:

- calls without `sheetId` are filled with the configured sheet id;
- calls with any other `sheetId` fail closed;
- field id mapping comes from the server target binding;
- public evidence must not expose sheet ids or field ids.

The background worker may continue an already-approved job without an active
HTTP request, but any manual resume/retry after pause/failure must require a
fresh authenticated write/admin user. There is no system/admin fallback for
approval.

## Failure handling

Row-level failures are recorded and the job continues until the configured
pause threshold is reached.

Examples:

- `target_row_not_found` for update/inactive missing target;
- `duplicate_target_key`;
- `field_mapping_failed`;
- `select_option_not_found`;
- `target_field_type_mismatch`;
- `target_record_validation_failed`;
- `target_scope_violation`.

Global failures pause/fail the job:

- durable checkpoint store unavailable;
- completed C3 artifact missing/expired;
- plan revision mismatch;
- target binding revision mismatch;
- target-scoped records API unavailable;
- permission/approval invalid;
- lease conflict.

Global failure must not erase row-level progress. Re-run/resume must skip or
re-confirm completed decisions through the checkpoint/idempotent writer.

## Evidence

Public progress/evidence must be values-free:

```json
{
  "jobId": "opaque",
  "status": "running",
  "planRevisionPresent": true,
  "counts": {
    "created": 1200,
    "updated": 19,
    "inactive": 0,
    "skipped": 44,
    "held": 28,
    "failed": 2
  },
  "errorCodes": ["target_row_not_found"],
  "resultStatuses": ["created", "failed", "held", "skipped"]
}
```

Evidence must not include:

- project number;
- component code/name/material/source ids;
- idempotency keys;
- target row values;
- target record ids;
- sheet ids or field ids;
- dry-run/apply approval tokens;
- raw plan rows or payloads;
- error messages containing row values.

Error summaries should use code/count/decision/status/field-type categories,
matching the existing values-free `summarizeApplyResultForEvidence` posture.

## Relationship to existing C4 helper

The checkpointed writer should reuse or wrap the existing per-decision logic
instead of inventing a second write semantic.

Required carry-forward semantics:

- `add` existing-key path patches instead of duplicate-create.
- `update`/`inactive` target miss is `target_row_not_found`.
- `manual_confirm` is held.
- human fields are omitted and rejected defensively.
- per-row failure isolation continues.

A future implementation can refactor `applyStockPreparationPlan` into a
single-decision primitive, but tests must prove the synchronous small-plan path
and checkpointed large-plan path make the same decision for the same row.

## Relationship to #2343 duplicate handling

The large-BOM writer must not silently drop duplicate demands.

For current C3 planner output, `duplicate_expanded_key` becomes
`manual_confirm` and is held. When #2343 D1 introduces explicit duplicate
policies, C4 must write only the decisions produced by that reviewed policy:

- keep-multiple writes each reviewed independent decision;
- merge writes the reviewed merged quantity decision;
- ignore/skip writes nothing and records that the demand was skipped;
- source-correction-required writes nothing.

No duplicate policy may be inferred by the writer itself.

## Relationship to C5/entity validation

Future validation should run in this order:

1. sandbox/small complete plan proves checkpointed apply writes the same rows
   as synchronous C4;
2. interrupt/resume proves no duplicate create;
3. re-pull proves idempotency: no new adds after the first successful run;
4. human-preserved fields remain unchanged after update/inactive;
5. row-level target failure yields partial/failed evidence without hiding clean
   writes;
6. production apply remains a separate owner-approved step.

## Implementation slices

Suggested future decomposition:

1. **C4-1 single-decision primitive:** extract/test one decision write while
   preserving existing small-plan behavior.
2. **C4-2 apply job store:** durable checkpoint, lease, values-free public
   projection, fail-closed memory-store rejection.
3. **C4-3 worker:** chunked decision execution, resume, target lock.
4. **C4-4 route/UI handoff:** start/inspect/pause/resume large apply from a
   completed C3 artifact with authenticated write/admin approval.
5. **C4-5 entity-machine validation:** interrupt/resume, idempotent re-pull,
   human-field preservation, row-failure evidence.

## Acceptance locks for future C4 implementation

- No large Apply can start from `largeBom=true` bounded preview.
- No large Apply can start without completed authoritative C3 artifact/plan.
- Browser-supplied plan/payload/source/target/caps/sheet id/field id are
  rejected.
- Permission is derived from the authenticated approver, never hardcoded.
- Target records API is server-scoped to the configured sheet/object.
- Durable checkpoint storage is required; memory-only storage fails closed.
- Resume after interruption does not duplicate target rows.
- `update`/`inactive` never create on miss.
- `manual_confirm` decisions are held and write nothing.
- Human-preserved fields are never written.
- Row-level failures are values-free and do not erase clean-row progress.
- No automatic retry storm.
- No PLM write, external database write, K3, raw SQL, CTE, stored procedure, or
  vendor API path is introduced.
