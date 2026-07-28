#!/usr/bin/env node
'use strict'

// #4556 W4C-0 Stage D — regenerates the pinned §8.4 DML debt baseline artifact from a git ref.
//
// Usage: node generate-baseline-manifest.cjs [--ref <sha>] [--out <path>]
// Defaults: --ref e0defbe26d7f2e1747e74aa908ca710422812bf7 (the design lock's pinned pre-W4
// baseline), --out docs/development/attendance-w4c0-dml-debt-baseline-e0defbe26.json
//
// This script reads ONLY the given git ref's tree (via `git show`/`git ls-tree`) — never the
// working tree — so re-running it is reproducible regardless of what is currently checked out.
// The committed artifact is data-only: re-running this script and diffing its output against the
// committed file is how a reviewer verifies the manifest was not hand-edited.

const path = require('path')
const fs = require('fs')

const { createGitRefSource } = require('./sources.cjs')
const { buildRawCensus, classifyCensus, contentHashOfKeys } = require('./collector.cjs')
const { CURATED_DEBT_ENTRIES } = require('./curated-debt-entries.cjs')
const { classifyTrackedSites } = require('./classify-tracked-sites.cjs')

const DEFAULT_REF = 'e0defbe26d7f2e1747e74aa908ca710422812bf7'
const DEFAULT_OUT = 'docs/development/attendance-w4c0-dml-debt-baseline-e0defbe26.json'

function parseArgs(argv) {
  const out = { ref: DEFAULT_REF, out: DEFAULT_OUT }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--ref') out.ref = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
  }
  return out
}

function main() {
  const repoRoot = path.resolve(__dirname, '../../..')
  const { ref, out } = parseArgs(process.argv.slice(2))

  const source = createGitRefSource(repoRoot, ref)
  const { roots, sites } = buildRawCensus(source)
  const classified = classifyCensus(sites)
  const { claimsByEntryId, genericAllowlisted, unclaimed } = classifyTrackedSites(classified.trackedSites)

  if (unclaimed.length > 0) {
    console.error(`generate-baseline-manifest: ${unclaimed.length} tracked site(s) unclaimed by any curated debt entry:`)
    for (const s of unclaimed) console.error(`  ${s.relPath} :: ${s.enclosingSymbol} :: ${s.table}:${s.verb}@${s.line}`)
    process.exit(1)
  }
  if (classified.unclassifiedTableSites.length > 0) {
    console.error(`generate-baseline-manifest: ${classified.unclassifiedTableSites.length} unclassified attendance-owned table site(s).`)
    process.exit(1)
  }
  if (classified.outsideBoundarySites.length > 0) {
    console.error(`generate-baseline-manifest: ${classified.outsideBoundarySites.length} w4_canonical-table site(s) outside the canonical boundary.`)
    process.exit(1)
  }

  const entries = CURATED_DEBT_ENTRIES.map((entry) => {
    const claimed = claimsByEntryId.get(entry.id) || []
    const keys = claimed.map((s) => s.key).sort()
    return {
      id: entry.id,
      title: entry.title,
      owningSlice: entry.owningSlice,
      sharedHook: entry.sharedHook,
      confidence: entry.confidence || 'direct',
      siteCount: claimed.length,
      tables: [...new Set(claimed.map((s) => `${s.table}:${s.verb}`))].sort(),
      symbols: [...new Set(claimed.map((s) => `${s.relPath} :: ${s.enclosingSymbol}`))].sort(),
      contentHash: contentHashOfKeys(keys),
    }
  })

  const manifest = {
    schemaVersion: 1,
    generatedFromRef: ref,
    lockAnchor:
      'docs/development/attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md#8.4',
    runtimeRoots: roots,
    debtEntries: entries,
    genericSharedAllowlist: genericAllowlisted.map((s) => `${s.relPath} :: ${s.enclosingSymbol}`).sort(),
    manifestContentHash: contentHashOfKeys(classified.trackedSites.map((s) => s.key)),
  }

  const outAbs = path.join(repoRoot, out)
  fs.writeFileSync(outAbs, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`wrote ${out}`)
  console.log(`  tracked sites: ${classified.trackedSites.length}`)
  console.log(`  debt entries: ${entries.length}`)
  console.log(`  manifestContentHash: ${manifest.manifestContentHash}`)
}

main()
