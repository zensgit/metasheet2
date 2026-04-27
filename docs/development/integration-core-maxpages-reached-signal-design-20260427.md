# Design: Record maxPagesReached + pagesProcessed in Run Details

**PR**: #1204  
**Date**: 2026-04-27  
**File**: `plugins/plugin-integration-core/lib/pipeline-runner.cjs`

---

## Problem

`runPipeline` reads source records in a `while (page < maxPages)` loop. The loop exits via three breaks (dry-run sample exhausted, `readResult.done`, no `nextCursor`) or by hitting the page cap.

When the page cap is hit but the source still has more data, the loop simply exits. The watermark advances to the last successful record, so subsequent runs do pick up where this one left off — there's no data loss. But:

- Operators have no signal that the pipeline is bigger than `maxPages × batchSize` allows in one run
- Dashboards can't surface "this pipeline keeps hitting the cap" patterns
- Tuning `maxPages` (default 100) or `batchSize` (default 1000) requires guessing

## Fix

Track an `exitedNormally` flag that's set to `true` inside each break point. After the loop:

```javascript
const maxPagesReached = !exitedNormally && page >= maxPages
```

This distinguishes:
- Loop exited via break (source done, dry-run sample reached, no more cursor) → `exitedNormally=true`
- Loop exited because `page >= maxPages` was no longer true at the head → `maxPagesReached=true`

Both `maxPagesReached` and `pagesProcessed` land in `run.details`:

```javascript
run = await runLogger.finishRun(run, metrics, status, {
  details: {
    dryRun,
    watermarkAdvanced: ...,
    nextCursor: cursor,
    erpFeedback,
    maxPagesReached,      // NEW
    pagesProcessed: page, // NEW
  },
})
```

## Why Not a Top-Level Field?

The runner already returns `{ run, metrics, preview }`. Adding a new top-level field would change the public API contract. Putting the signal in `run.details` is non-breaking — callers that care can read `result.run.details.maxPagesReached`; callers that don't are unaffected. Run details are already JSONB-stored and surfaced in run logs and the runs API.

## Why Not Throw?

Hitting `maxPages` is intended behavior — the cap exists to bound runtime per request. Throwing would mark the run `failed` and signal disaster, but the run did succeed for the records it processed and the watermark did advance. A non-fatal signal in details is the right shape.

## Detection Logic

```
while (page < maxPages) {
  page += 1
  // ... read, process, write
  if (dryRunSamplesExhausted)    { exitedNormally = true; break }
  if (readDone || !nextCursor)   { exitedNormally = true; break }
  cursor = nextCursor
}
maxPagesReached = !exitedNormally && page >= maxPages
```

If the loop finishes its final iteration *without* breaking, `cursor` was just advanced to a non-null `nextCursor` — meaning the source still has data. The next iteration's `while` check fails because `page === maxPages`. That's exactly the "cap hit with more work" case.

## Affected Files

| File | Change |
|------|--------|
| `lib/pipeline-runner.cjs` | `exitedNormally` flag + 2 new keys in `run.details` |
| `__tests__/pipeline-runner.test.cjs` | Section 19 — 2 scenarios (cap hit; clean exit) |
