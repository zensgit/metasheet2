# Verification: Per-Record Guard for Null/Non-Object Source Records

**PR**: #1205  
**Date**: 2026-04-27

---

## Test Scenarios Added (Section 20)

### Mixed-batch run: 6 source records, 2 valid + 4 invalid

**Setup**: Source returns a single page with this record array:

```javascript
[
  null,
  { code: 'valid-1', revision: 'r1', qty: '3', name: 'Bolt', ... },
  undefined,
  'raw-string-not-an-object',
  { code: 'valid-2', revision: 'r1', qty: '5', name: 'Nut', ... },
  [{ nested: 'array' }],
]
```

**Without the fix**: `transformRecord(null, ...)` throws on the first record; the entire run fails before either valid record can be written.

**With the fix**:
- `result.run.status === 'partial'` (run completes despite invalid records)
- `metrics.rowsRead === 6` (all 6 counted as read)
- `metrics.rowsCleaned === 2` (only the two valid records cleaned)
- `metrics.rowsWritten === 2` (both valid records written to target)
- `metrics.rowsFailed === 4` (4 invalid records failed)
- `targetRows.size === 2` (target has the two valid records only)

### Per-record dead letters with INVALID_SOURCE_RECORD

**Assertions on `integration_dead_letters` rows where `error_code === 'INVALID_SOURCE_RECORD'`**:
- 4 dead letters created (one per invalid record)
- `error_message` for each variant mentions its type:
  - `null` → message contains `'null'`
  - `undefined` → message contains `'undefined'`
  - array (`[{nested:'array'}]`) → message contains `'array'`
  - string (`'raw-string-not-an-object'`) → message contains `'string'`

## Regression Guard

All 18 `plugin-integration-core` test files pass on top of latest `origin/main` (`d7fd6d6ea`):

```
✓ credential-store        ✓ adapter-contracts       ✓ http-adapter
✓ db.cjs                 ✓ plm-yuantus-wrapper     ✓ pipelines
✓ external-systems       ✓ transform-validator      ✓ runner-support
✓ payload-redaction      ✓ pipeline-runner          ✓ http-routes
✓ k3-wise-adapters       ✓ erp-feedback             ✓ e2e-plm-k3wise-writeback
✓ staging-installer      ✓ migration-sql
```

## Worktree

Branch: `codex/integration-invalid-source-record-guard-20260427`  
Worktree: `/tmp/ms2-invalid-source-record`  
Base: `d7fd6d6ea` (origin/main after PR #1204)
