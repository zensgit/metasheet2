'use strict'

// #4556 W4C-0 Stage D — matches tracked (business/schedule_fact/shared_hook bucket) census sites
// against the curated debt-entry predicates and the generic-shared-function allowlist.
//
// A tracked site claimed by zero curated entries AND not on the generic-shared allowlist is new
// or unclassified debt: §8.4 "an unclassified table or new write symbol fails CI".

const { CURATED_DEBT_ENTRIES, isGenericSharedAllowlisted } = require('./curated-debt-entries.cjs')

function classifyTrackedSites(trackedSites) {
  const claimsByEntryId = new Map(CURATED_DEBT_ENTRIES.map((e) => [e.id, []]))
  const genericAllowlisted = []
  const unclaimed = []

  for (const site of trackedSites) {
    const claimingEntries = CURATED_DEBT_ENTRIES.filter((entry) => entry.claims(site))
    if (claimingEntries.length > 0) {
      for (const entry of claimingEntries) {
        claimsByEntryId.get(entry.id).push(site)
      }
      continue
    }
    if (isGenericSharedAllowlisted(site)) {
      genericAllowlisted.push(site)
      continue
    }
    unclaimed.push(site)
  }

  return { claimsByEntryId, genericAllowlisted, unclaimed }
}

module.exports = { classifyTrackedSites }
