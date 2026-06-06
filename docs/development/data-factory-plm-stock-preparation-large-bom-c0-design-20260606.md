# Data Factory #2342 C0 - PLM stock-preparation large-BOM strategy (2026-06-06)

## Scope

This is a design-only slice for issue #2342. It defines the large-BOM behavior
for the PLM stock-preparation table action after the #2340 owner sample proved
that the deployed cap can be reached before a full plan exists:

- dry-run only;
- `status=failed`;
- `canApply=false`;
- `expansion.status=failed`;
- `expansion.rowsExpanded=500`;
- `expansion.maxRows=500`;
- `expansion.readCount=1068`;
- `expansion.errorTypes=max_rows_exceeded`;
- bounded rows existed, but Apply correctly stayed blocked.

This slice adds no runtime, route, UI, migration, package change, PLM write,
external database write, MetaSheet row write, C4 Apply, K3 action, or retry
worker.

## Current implementation grounding

The current code already has the right safety posture, but not the right large
operator experience:

- C2 expansion is app-side over flat reads and has hard guards:
  `DEFAULT_MAX_ROWS=10000`, `DEFAULT_MAX_DEPTH=20`, `DEFAULT_MAX_PAGES=100` in
  `plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs`.
- `maxRows` can be overridden by the server-side action config. The onsite
  cap of 500 was a deployment/action-config limit, not the helper default.
- When `maxRows` is exceeded, C2 records `max_rows_exceeded`, returns bounded
  rows, and marks the expansion `status='failed'` / `valid=false`.
- The table-action dry-run computes a conflict plan over the returned rows, but
  sets `canApply=false` when global expansion errors exist. No dry-run token is
  issued in that state.
- `readCount` is a read-attempt count from expansion read diagnostics. It is
  useful for diagnosing fan-out, but it is not the total BOM row count.
- C3 can only plan from rows it receives. If expansion is bounded, C3 conflict
  counts and duplicate diagnostics are not authoritative for the full BOM.
- C4 apply is a synchronous per-decision writer. It is idempotent and
  row-failure-aware, but it is not a background, resumable checkpoint writer.

Therefore #2342 is not a silent-write bug. It is a scale/readiness and operator
workflow gap: current behavior is fail-closed but too opaque and too binary for
large BOMs.

## C0 decision

Use a two-lane strategy:

1. **Synchronous dry-run lane:** keep it bounded. When the cap is reached,
   return a values-free `largeBom=true` bounded-preview state and keep Apply
   disabled. Do not pretend the bounded subset is an authoritative plan.
2. **Large-BOM lane:** full expansion and large apply require a separate
   background/checkpointed execution mode with explicit owner approval.

C0 intentionally rejects this shortcut:

```text
raise maxRows high enough -> run normal sync dry-run -> enable normal sync Apply
```

A larger synchronous cap may be useful for reviewed dry-run diagnosis, but it
must not by itself unlock synchronous one-click Apply for a large BOM.

## Synchronous dry-run behavior

For normal BOMs below the configured cap, existing behavior remains valid:

- complete C2 expansion;
- authoritative C3 plan;
- dry-run token only when `canApply=true`;
- Apply remains gated by the existing C5/C4 permission and token contracts.

For BOMs that hit `max_rows_exceeded`, future C1 should represent the state as
bounded and explicit instead of an opaque failure:

```json
{
  "status": "large_bom_bounded",
  "canApply": false,
  "largeBom": true,
  "boundedPreview": {
    "complete": false,
    "rowsExpanded": 500,
    "maxRows": 500,
    "readCount": 1068,
    "errorTypes": ["max_rows_exceeded"]
  }
}
```

The exact wire shape can be refined in C1, but the semantics are locked:

- `largeBom=true` means the plan is not authoritative.
- `canApply=false` is mandatory.
- no dry-run token is issued.
- C3 counts may be shown only as bounded/subset counts.
- duplicate counts, collision shapes, and manual-confirm counts are not
  authoritative unless expansion completed.

## 20k-row display contract

Do not render 20,000 rows as one normal workbench table.

The tenant UI can later use a large-BOM review surface, but it must be explicit:

1. Summary first: cap, rows expanded so far, read-attempt count, expansion
   status, completeness, blocked reason, and whether conflict counts are
   authoritative.
2. Bounded preview: virtualized or paged tenant-only row review for authorized
   users.
3. Operator choices:
   - choose a smaller sample;
   - request a reviewed higher dry-run cap for diagnosis only;
   - route to background full expansion.
4. Apply remains disabled unless the run has a complete authoritative plan and
   the selected execution mode is approved.

Issue/customer evidence must stay values-free and should not include preview
row values, project number, PLM row values, target row values, source ids,
sheet ids, field ids, target bindings, request payloads, dry-run tokens, raw
SQL, credentials, or Bridge secrets.

## Background/checkpoint lane

Large-BOM full processing is a later runtime track. C0 locks the direction:

- background job, not a long single HTTP request;
- checkpointed expansion progress;
- resumable/idempotent apply progress;
- per-row failure recording;
- no automatic retry storm;
- explicit owner approval before large write execution;
- values-free progress evidence.

The current C4 writer is a useful primitive because it is idempotent
find-then-create/patch and reports per-row failures. It is not sufficient as the
large-BOM writer by itself because it loops synchronously through one in-memory
plan. C3/C4 large execution should wrap or extend the writer with checkpoints
instead of simply raising the cap.

Minimum checkpoint state for a later design:

- background job or run identifier;
- action id and target table identity;
- dry-run revision / expansion revision;
- project parameter fingerprint, not project value in public evidence;
- last completed expansion cursor/page/depth boundary;
- last completed apply decision index or stable decision key;
- counts by status;
- failure summaries by code, values-free.

## Relationship to #2343 duplicate handling

#2343 remains valid for the complete #2340 246-row sample: that sample fully
expanded, so its 28 duplicate rows are authoritative.

For large samples, #2342 is upstream:

- bounded expansion means C3 sees only a subset;
- duplicate count and collision-shape diagnostics are not authoritative;
- `keep_multiple_rows`, `merge_quantity`, or `source_correction_required`
  policies must wait for complete expansion on that large sample.

The shared large-BOM background/checkpoint lane should also be reusable by
future #2343 duplicate-resolution apply at scale.

## Cap policy

C0 separates three caps:

| Cap | Purpose | Apply allowed? |
|---|---|---|
| Smoke/deployment cap | Fast onsite validation, often intentionally low. | No if cap is hit. |
| Reviewed synchronous dry-run cap | Operator diagnosis for larger but still bounded samples. | No if cap is hit; yes only if expansion completes and other gates pass. |
| Background full-expansion limit | Large-BOM complete planning after owner approval. | Only through the approved background/checkpoint lane. |

The cap must be server-side action config or server-side policy. Browser input
must not raise `maxRows`, `maxPages`, `maxDepth`, or Apply mode.

## Apply contract

For large BOMs, Apply must not run from a bounded dry-run.

Allowed apply states:

- complete normal dry-run below cap + existing C5/C4 approval gates;
- complete background full-expansion plan + explicit large-BOM owner approval +
  checkpointed apply lane.

Forbidden:

- Apply from `largeBom=true`;
- Apply from `max_rows_exceeded`;
- Apply from a bounded/subset C3 plan;
- Apply from browser-supplied cap/mode overrides;
- synchronous large apply just because a higher cap was configured.

## C1-C5 decomposition

### C1 - bounded dry-run readiness shape

Docs-approved runtime slice. It should surface `largeBom=true` and bounded
preview metadata when `max_rows_exceeded` occurs, while preserving the existing
fail-closed behavior:

- Apply disabled;
- no dry-run token;
- no MetaSheet write;
- no PLM/external database write;
- no K3;
- values-free evidence.

### C2 - large-BOM UI affordance

Add the operator display for bounded-preview state:

- summary-first display;
- virtualized/paged bounded row review if values are shown in tenant UI;
- issue-evidence copy path stays values-free;
- clear next actions.

### C3 - background full-expansion design

Design the job/checkpoint model for complete large-BOM expansion:

- no raw SQL / CTE / stored procedure / vendor API escape hatch;
- continue app-side flat reads unless the source gate explicitly pivots to a
  customer flat BOM view or deferred PLM adapter/API track;
- completion produces an authoritative expansion before C3 conflict policies
  are trusted.

### C4 - checkpointed apply writer design

Design large-BOM apply as resumable/idempotent work:

- clean rows can continue;
- per-row failures are recorded;
- manual-confirm rows remain held;
- no automatic retry loop;
- re-run is safe and does not duplicate already-applied rows.

### C5 - entity-machine validation

Validate with values-free evidence:

- a bounded large-BOM dry-run shows `largeBom=true` and Apply disabled;
- a complete normal sample still behaves as before;
- a background/full-expansion sample, if implemented, proves authoritative
  counts before any write.

## Acceptance locks

- C0 is docs-only.
- Current C2/C3/C4 runtime behavior remains unchanged.
- Large-BOM bounded preview is never an authoritative plan.
- `largeBom=true` always blocks Apply.
- No dry-run token is issued for bounded/failed large-BOM state.
- `readCount` is labeled as read attempts, not total BOM size.
- C3 duplicate analysis on bounded rows is labeled non-authoritative.
- Synchronous cap increases are diagnosis-only unless expansion completes
  below that cap.
- Large apply requires a separate background/checkpointed execution mode.
- Evidence remains values-free.
- No raw SQL, CTE, stored procedure, vendor API call, PLM write, external DB
  write, K3 Save/Submit/Audit/BOM, production rollout, or automatic retry is
  unlocked by this design.

## Immediate next step

After C0 is reviewed and merged, the next safe implementation slice is C1:
surface the `largeBom=true` bounded-preview readiness shape while preserving
the existing `canApply=false` and no-token behavior. #2343 D1 should remain
ready, but large-sample duplicate policy should wait until #2342 provides
complete expansion for that sample.
