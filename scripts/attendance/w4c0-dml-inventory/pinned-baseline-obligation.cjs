'use strict'

/**
 * W4C-3c — separately named pinned-baseline obligation.
 *
 * This module is the ONLY place that proves the frozen e0defbe debt artifact still
 * covers the pinned pre-W4 tree. It must NOT be satisfied by stuffing historical
 * symbols into current CURATED_DEBT_ENTRIES claims (for example a removed
 * attachManualResultEditMarkerToRecord body).
 *
 * Current-tree zero-debt (unclaimed=0 + every entry canonicalizedBy) is a different
 * gate, enforced by the HEAD scan and W4C-3c hard zero-bypass tests against live claims.
 */

const fs = require('fs')
const path = require('path')

const { createGitRefSource } = require('./sources.cjs')
const { buildRawCensus, classifyCensus, contentHashOfKeys } = require('./collector.cjs')
const { isGenericSharedAllowlisted } = require('./curated-debt-entries.cjs')

const PINNED_BASELINE_REF = 'e0defbe26d7f2e1747e74aa908ca710422812bf7'
const PINNED_BASELINE_ARTIFACT_RELPATH =
  'docs/development/attendance-w4c0-dml-debt-baseline-e0defbe26.json'

function loadPinnedBaselineArtifact(repoRoot) {
  const abs = path.join(repoRoot, PINNED_BASELINE_ARTIFACT_RELPATH)
  const text = fs.readFileSync(abs, 'utf8')
  const artifact = JSON.parse(text)
  return { text, artifact, abs }
}

/**
 * Prove every tracked site at the pinned ref is covered by the frozen artifact's
 * symbol/table ledger or the generic-shared allowlist — without consulting live
 * CURATED_DEBT_ENTRIES.claims predicates.
 */
function provePinnedBaselineObligation(repoRoot) {
  const { text, artifact } = loadPinnedBaselineArtifact(repoRoot)
  if (artifact.generatedFromRef !== PINNED_BASELINE_REF) {
    const error = new Error(
      `PINNED_BASELINE_REF_MISMATCH: artifact.generatedFromRef=${artifact.generatedFromRef}`,
    )
    error.code = 'PINNED_BASELINE_REF_MISMATCH'
    throw error
  }

  const gitSource = createGitRefSource(repoRoot, PINNED_BASELINE_REF)
  const { roots, sites } = buildRawCensus(gitSource)
  const classified = classifyCensus(sites)

  if (classified.unclassifiedTableSites.length > 0) {
    const error = new Error(
      `PINNED_BASELINE_UNCLASSIFIED_TABLE: ${classified.unclassifiedTableSites.length}`,
    )
    error.code = 'PINNED_BASELINE_UNCLASSIFIED_TABLE'
    error.sites = classified.unclassifiedTableSites
    throw error
  }
  if (classified.outsideBoundarySites.length > 0) {
    const error = new Error(
      `PINNED_BASELINE_OUTSIDE_BOUNDARY: ${classified.outsideBoundarySites.length}`,
    )
    error.code = 'PINNED_BASELINE_OUTSIDE_BOUNDARY'
    error.sites = classified.outsideBoundarySites
    throw error
  }

  const trackedHash = contentHashOfKeys(classified.trackedSites.map((site) => site.key))
  if (trackedHash !== artifact.manifestContentHash) {
    const error = new Error(
      `PINNED_BASELINE_MANIFEST_HASH_DRIFT: live=${trackedHash} artifact=${artifact.manifestContentHash}`,
    )
    error.code = 'PINNED_BASELINE_MANIFEST_HASH_DRIFT'
    throw error
  }

  const symbolTableCoverage = new Set()
  for (const entry of artifact.debtEntries || []) {
    for (const symbol of entry.symbols || []) {
      for (const tableVerb of entry.tables || []) {
        symbolTableCoverage.add(`${symbol}@@${tableVerb}`)
      }
    }
  }
  const genericAllowlist = new Set(artifact.genericSharedAllowlist || [])

  const uncovered = []
  for (const site of classified.trackedSites) {
    const symbolKey = `${site.relPath} :: ${site.enclosingSymbol}`
    const tableVerb = `${site.table}:${site.verb}`
    const coveredByArtifact = symbolTableCoverage.has(`${symbolKey}@@${tableVerb}`)
    const coveredByGeneric =
      genericAllowlist.has(symbolKey) || isGenericSharedAllowlisted(site)
    if (!coveredByArtifact && !coveredByGeneric) {
      uncovered.push(`${symbolKey} :: ${tableVerb}`)
    }
  }
  if (uncovered.length > 0) {
    const error = new Error(
      `PINNED_BASELINE_UNCOVERED_SITE: ${uncovered.length} tracked site(s) missing from frozen artifact ledger`,
    )
    error.code = 'PINNED_BASELINE_UNCOVERED_SITE'
    error.uncovered = uncovered
    throw error
  }

  // Artifact text stability: committed file is exact generator formatting (no hand edits).
  const normalized = `${JSON.stringify(artifact, null, 2)}\n`
  if (text !== normalized) {
    const error = new Error('PINNED_BASELINE_ARTIFACT_HAND_EDITED')
    error.code = 'PINNED_BASELINE_ARTIFACT_HAND_EDITED'
    throw error
  }

  return {
    ok: true,
    pinnedRef: PINNED_BASELINE_REF,
    trackedSiteCount: classified.trackedSites.length,
    debtEntryCount: (artifact.debtEntries || []).length,
    runtimeRoots: roots,
    manifestContentHash: trackedHash,
  }
}

module.exports = {
  PINNED_BASELINE_REF,
  PINNED_BASELINE_ARTIFACT_RELPATH,
  loadPinnedBaselineArtifact,
  provePinnedBaselineObligation,
}
