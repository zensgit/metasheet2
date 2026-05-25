# K3 WISE business success evidence design - 2026-05-25

## Context

Issue #1792 exposed a real K3 WISE write-confirmation gap during the Material
GATE. MetaSheet reported a one-record Save-only run as `rowsWritten=1`, but K3
readback could not confirm that the material existed. Direct K3 WebAPI probes
then showed the important shape:

- HTTP transport can succeed.
- K3 outer envelope can return `StatusCode=200` and `Message=Successful`.
- The row-level business payload can still return `FStatus=false`,
  `FItemID=0`, and field-level validation text.

That means outer HTTP/envelope success is not enough evidence for a K3 write.

## Scope

This slice fixes the runtime interpretation of K3 WISE business responses. It
does not implement the full customer material template, K3 reference resolution,
post-save readback templates, BOM write, Submit, or Audit.

Touched runtime surfaces:

- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
- `plugins/plugin-integration-core/lib/pipeline-runner.cjs`

## Design

### Save-specific success rule

Generic `businessSuccess()` still exists for login, token, health, submit, and
audit style calls. It now rejects explicit negative business signals before it
falls back to the envelope status.

K3 Save uses the stricter `saveBusinessSuccess()` path:

1. Any explicit failure wins:
   - negative `Data.Code`;
   - `Result.ResponseStatus.IsSuccess=false`;
   - row `FStatus=false`;
   - row or envelope text that clearly indicates failure such as `Faild`,
     `failed`, `invalid`, `not found`, `no access`, `失败`, `错误`, `不存在`, or
     `无权限`.
2. Save success requires business evidence:
   - configured `saveSuccessPath` / `successPath`; or
   - positive `Data.Code`; or
   - explicit success boolean; or
   - success entity count; or
   - row `FStatus=true` plus a meaningful id / number.
3. K3 envelope `StatusCode=200` by itself is insufficient for Save.

### Sanitized business summaries

The adapter now builds one small business-response summary per attempted K3
operation. The summary records evidence shape, not raw payload values:

- operation;
- envelope status and message presence;
- response code and message presence;
- row count;
- successful/failed row counts;
- success entity count;
- whether an external id or bill number was present.

The persisted summary records only message presence, not raw K3 message text,
because K3 field-level errors may echo material codes or other customer row
values.

Pipeline runner persists those summaries to run details under
`targetWriteSummaries`, after `sanitizeIntegrationPayload()` and size/depth
limits. This gives operators a run-level explanation for "outer 200, business
row failed" without storing tokens or full K3 payloads.

The runner caps collected summaries at 50 during the write loop, not only at
final serialization time, so large runs do not keep sanitizing summaries that
will be discarded.

### Compatibility

Existing adapter error code compatibility is preserved for Save failures:
`K3_WISE_SAVE_FAILED` remains the emitted code. The difference is that row-level
K3 failures now go to the failed path instead of being counted as written.

## Out Of Scope

- No K3 Submit / Audit.
- No BOM write.
- No K3 WebAPI read/list runtime.
- No SQL direct K3 table writes.
- No DB migration.
- No frontend UI changes.
- No full Material template/reference-resolution implementation.
- No post-save readback implementation in this slice.
