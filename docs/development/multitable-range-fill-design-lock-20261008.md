# Multitable rectangular copy and fill — design lock

Date: 2026-10-08. Owner request: implement rectangular copy/drag-repeat and numeric/date series, with design and executable verification. Base: `9d65b8318f3d5cbc323b458cb5c96c2240a144f7`.

## Contract

1. Opt-in UI: `VITE_MULTITABLE_RANGE_FILL_ENABLED === 'true'` at build time. Missing, `false`, `TRUE`, or whitespace stay disabled. Existing single-cell and row-selection behavior is preserved while disabled. No production enablement or deployment is included.
2. A cell rectangle is selected by primary-button dragging or Shift+click; Shift+arrow extends it. Existing row checkboxes remain separate. A corner handle extends a frozen source rectangle along one axis. A visible mode selector chooses **Copy** (default) or **Series**. A toolbar also offers copy/paste for discoverability.
3. Selection addresses the grid's current `displayRows` and visible fields, including visible expanded groups. Collapsed, filtered-out, unloaded rows and hidden columns are never targets. Scrolling uses the existing virtual window; no server-wide selection or implicit record creation. A changed row/column identity/order/version, sheet/view, or field definition cancels an outstanding drag/paste. Release outside the grid cancels the drag.
4. Copy/paste accepts a rectangular TSV matrix, quoted tabs/newlines/quotes, CRLF, and an optional final line terminator. Ragged/malformed, oversized, or out-of-bounds matrices fail without writes. A one-cell target expands to the source dimensions. A larger selected target must be a whole-number tiling of the source. Limit: 1,000 destination cells per operation (bounded UI work and request payload).
5. Writable target types in this slice: string, number, boolean, date, dateTime, select. Other types, computed/system/mirror/readOnly fields, masked fields, locked rows and per-user write-denied rows/fields fail the whole operation. Internal repeat uses typed source values and requires equal field types; select values must exist in the target options. External clipboard text uses explicit target-type conversion, never `Number('')`, broad date guessing, or implicit option creation. Empty clipboard cells clear nullable targets; required fields reject empty values.
6. Repeat tiles the source rectangle using a positive modulo in all four directions and writes only outside the source. The drag target includes the entire source and extends either rows or columns, never both simultaneously.
7. Series: numeric or date-only source cells, all of one type per axis. A single seed advances by 1 (one civil day for dates); two or more seeds must form a constant difference, otherwise reject. Each source column/row is an independent series. Reverse/up/left extrapolation is supported. Dates use strict YYYY-MM-DD civil-day arithmetic, including leap/month/year transitions, never browser-local DST arithmetic. dateTime/text sequence inference is excluded. Nonfinite numbers and out-of-range dates reject.
8. Commit via existing `/api/multitable/patch`, one request with `partialSuccess: false` and captured `expectedVersion` for every cell. Existing server authorization, validation, history, and canonical writers remain authoritative. Do not issue N independent cell writes or silently omit forbidden cells. Local data is applied only after complete successful version acknowledgement: project the captured scalar values, then overlay optional canonical/computed echoes for acknowledged records. Empty, partial, duplicate or malformed acknowledgement cannot mutate local state. 403/409/validation/network failure stays visible and does not optimistically alter cells. A range request and existing single-cell/bulk/undo/redo writes exclude one another; ordinary writes keep their existing behavior when no range request is pending. Synchronous sheet/view changes invalidate range work, including an away-and-back transition. Range operations clear stale single-cell undo history on success; range undo is not implemented, and the toolbar states this limitation.
9. Error UI contains fixed translated messages, never echoed values or raw server messages. New source logic lives in sibling modules/composables, with only binding changes in the existing large grid/workbench.

## Module interface

`utils/grid-range-fill.ts` exports:

- `CellPoint { row: number; col: number }`, `CellRange { top; left; bottom; right }`, `FillMode = 'copy' | 'series'`.
- `RangeChange { recordId; fieldId; value: unknown; expectedVersion: number }`.
- `rangeFromPoints(a,b)`, `rangeContains(range,point)`, `rangeSize(range)`.
- `parseClipboardMatrix(text): string[][]`, `serializeClipboardMatrix(values: unknown[][]): string`.
- `planRangePaste({rows,fields,target,matrix,canWrite}): RangeChange[]`.
- `planRangeFill({rows,fields,source,target,mode,canWrite}): RangeChange[]`.
- `RangeOperationError` with fixed `code`: `INVALID_RANGE | TOO_LARGE | INVALID_CLIPBOARD | OUT_OF_BOUNDS | READ_ONLY | INVALID_VALUE | INCOMPATIBLE_TYPE | INVALID_SERIES`.
- `canWrite(recordId,field): boolean` is an additional live UI gate. Helpers independently reject structural readOnly/system/mirror/hidden fields and locked rows. `rows` and `fields` are the displayed snapshot, not all backend records.

## Model allocation

Grok 4.7: bounded pure planner and unit tests; no UI/CI/shared-file writes. Sol 6.1: atomic writer, interaction tests and writer race corrections. Luna 6: exact-literal flag, manifest provenance and two-point CI wiring. Kimi K3: independent design/correctness counterexamples. Codex: selection interaction, integration, browser verification, independent test execution and final review. Model output is not acceptance evidence.

Kimi review decisions: an optional final TSV line terminator is ignored, but a deliberately empty cell remains a null-clear; reverse tiling is anchored at the source, not the destination; numeric differences tolerate floating-point roundoff; mixed text/numeric series reject rather than partly fall back to copy; hidden columns and filtered rows are excluded from visible geometry, not implicitly included. A request timeout has an uncertain outcome: no automatic replay, fixed UI asks the user to refresh and check before retrying. dateTime clipboard text requires an explicit timezone; native dateTime source numbers remain epoch milliseconds. The range writer must not overwrite newer realtime versions with a late successful response.

## Exit gates

| Gate | Required evidence |
| --- | --- |
| G1 | Pure planner: four directions, multi-column/row tiling, numeric and civil-date series, malformed clipboard and strict types |
| G2 | Grid: mouse/keyboard rectangle, corner drag, mode choice, clipboard roundtrip; collapsed/hidden/unloaded exclusions |
| G3 | Guard negatives: flag default/exact true, locked/readonly/permission, stale versions/view changes, operation cap, async cancellation |
| G4 | Writer: exact single atomic request, version capture, server success projection, 403/409 failure leaves local cells untouched |
| G5 | New specs wired into multitable-web-guard and required web test list; focused specs plus neighbor grid/edit/virtualization tests |
| G6 | Guard mutation goes red then source restored; UI browser screenshot; type-check/build or named baseline blockers |

The existing main date-import regression found during review is a separate concern; this slice must not silently fold it into its diff. No new backend API, migrations, customer data, external writes, or feature enablement.
