'use strict'

// DF-T3b-2b: live mapping-sheet bulk-read → referenceMappingIndexes (the seam #2063 built).
// REUSES the staging source-adapter's read() — NO new sheet reader (#2036: "read the same way the
// staging source-adapter already reads cleansing sheets, its rows via the multitable records API by
// sheetId"). The adapter does the I/O; this loops its paginated read to a bounded page cap and builds
// a per-domain index via the T3b-1 resolver. Per-run, NO cross-run cache. READ-ONLY — no upsert /
// Save / pipeline-runner (the real-Save compose wire is DF-T3b-2c).

const { buildReferenceMappingIndex } = require('./reference-mapping-resolver.cjs')

const DEFAULT_MAX_PAGES = 100

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Loop the staging adapter's paginated read() until done — a BULK read of one mapping sheet's rows.
// Bounded by maxPages (a mapping dictionary is small): exceeding it THROWS — never silently truncate,
// because a truncated dictionary would resolve real codes to "unresolved" (a silent wrong answer).
async function bulkReadRows(adapter, object, { maxPages = DEFAULT_MAX_PAGES, pageLimit } = {}) {
  if (!adapter || typeof adapter.read !== 'function') {
    throw new Error('reference mapping bulk-read requires a source adapter with read()')
  }
  const rows = []
  let cursor
  for (let page = 0; ; page += 1) {
    if (page >= maxPages) {
      throw new Error(`reference mapping bulk-read exceeded ${maxPages} pages for object "${object}" — dictionary too large or misconfigured`)
    }
    const input = { object }
    if (cursor !== undefined) input.cursor = cursor
    if (pageLimit) input.limit = pageLimit
    const result = await adapter.read(input)
    const records = isPlainObject(result) && Array.isArray(result.records) ? result.records : []
    for (const record of records) rows.push(record)
    // Stop on the adapter's own done signal (or absence of a next cursor) — same contract its read uses.
    if (!isPlainObject(result) || result.done === true || !result.nextCursor) break
    cursor = result.nextCursor
  }
  return rows
}

// Build referenceMappingIndexes for the #2063 preview seam. bindings = [{ domain, object, template }].
// Each binding BULK-READS its sheet via the SAME adapter (staging source-adapter) and indexes by
// sourceCode (T3b-1 buildReferenceMappingIndex). Per-run; the caller passes a freshly-created adapter.
async function buildReferenceMappingIndexes(adapter, bindings, options = {}) {
  const indexes = {}
  for (const binding of (Array.isArray(bindings) ? bindings : [])) {
    if (!isPlainObject(binding) || typeof binding.domain !== 'string' || typeof binding.object !== 'string' || !isPlainObject(binding.template)) {
      throw new Error('reference mapping binding requires { domain, object, template }')
    }
    const rows = await bulkReadRows(adapter, binding.object, options)
    indexes[binding.domain] = buildReferenceMappingIndex(binding.template, rows)
  }
  return indexes
}

module.exports = {
  DEFAULT_MAX_PAGES,
  bulkReadRows,
  buildReferenceMappingIndexes,
}
