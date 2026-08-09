'use strict'

// #4556 W4C-0 Stage D — matches tracked (business/schedule_fact/shared_hook bucket) census sites
// against the frozen approved-site-identity table.
//
// There is exactly ONE recognition rule:
//
//     a tracked site is approved  <=>  its (relPath, enclosingSymbol, table, verb) identity is
//                                      listed in approved-site-identities.cjs
//     ...and the census must contain that identity EXACTLY `occurrences` times.
//
// Anything else is new or unclassified debt: §8.4 "an unclassified table or new write symbol
// fails CI". Concretely, inside an already-approved file a new table, a new verb, a new symbol,
// or a second occurrence of an approved identity all land in a non-empty leg below. No predicate
// approves a file or a path prefix, so nothing "falls through" to a broader claim.

const { CURATED_DEBT_ENTRIES, isGenericSharedAllowlisted } = require('./curated-debt-entries.cjs')
const {
  APPROVED_SITE_IDENTITIES,
  APPROVED_SITE_IDENTITY_BY_KEY,
  siteIdentityKey,
  siteIdentityLabel,
} = require('./approved-site-identities.cjs')

/**
 * @param {Array<object>} trackedSites census sites in the tracked buckets.
 *
 * Every leg is always computed. `unclaimed` and `overCount` are meaningful for ANY census,
 * including the synthetic single-site fixtures the positive controls feed. `missing` and
 * `fingerprintDrift` are only meaningful for a whole-tree census — both walk the frozen identity
 * table, so a partial census trivially puts most of the 181 identities into each — and both are
 * asserted empty by the full-tree gate only.
 */
function classifyTrackedSites(trackedSites) {
  const claimsByEntryId = new Map(CURATED_DEBT_ENTRIES.map((e) => [e.id, []]))
  const genericAllowlisted = []
  const unclaimed = []
  const observedCountByKey = new Map()
  const observedFingerprintsByKey = new Map()

  for (const site of trackedSites) {
    const key = siteIdentityKey(site)
    observedCountByKey.set(key, (observedCountByKey.get(key) || 0) + 1)
    if (!observedFingerprintsByKey.has(key)) observedFingerprintsByKey.set(key, [])
    observedFingerprintsByKey.get(key).push(site.statementFingerprint ?? null)

    const approved = APPROVED_SITE_IDENTITY_BY_KEY.get(key)
    if (!approved) {
      // Not an approved identity at all: a new table, verb, symbol, or file.
      unclaimed.push(site)
      continue
    }
    if (approved.entryIds.length > 0) {
      for (const entryId of approved.entryIds) {
        claimsByEntryId.get(entryId).push(site)
      }
      continue
    }
    // Approved with no owning debt id => generic-shared disposition (proven exact by the
    // identity table's own ambiguous-disposition check, not by this file's path knowledge).
    if (isGenericSharedAllowlisted(site)) {
      genericAllowlisted.push(site)
      continue
    }
    unclaimed.push(site)
  }

  // Multiplicity legs. `overCount` is what makes a SECOND write at an already-approved
  // (file, symbol, table, verb) fail — approval is for a site occurring an exact pinned number
  // of times, not for a (file, symbol, table, verb) coordinate in perpetuity.
  // `missing` is simultaneously the stale-approval leg and the non-empty-domain leg: if the
  // scanner ever returns an empty or truncated census, all 181 pinned identities land here, so
  // the gate cannot pass vacuously against nothing.
  const overCount = []
  const missing = []
  for (const row of APPROVED_SITE_IDENTITIES) {
    const key = siteIdentityKey(row)
    const observed = observedCountByKey.get(key) || 0
    if (observed > row.occurrences) {
      overCount.push({
        identity: siteIdentityLabel(row),
        pinned: row.occurrences,
        observed,
        entryIds: row.entryIds,
      })
    } else if (observed < row.occurrences) {
      missing.push({
        identity: siteIdentityLabel(row),
        pinned: row.occurrences,
        observed,
        entryIds: row.entryIds,
      })
    }
  }

  // Statement-fingerprint leg. `unclaimed`/`overCount`/`missing` all answer "is this write at a
  // coordinate somebody approved, the pinned number of times". None of them answers "is it still
  // the STATEMENT somebody approved". Deleting the whole `WHERE` from an approved tenant-scoped
  // UPDATE — making it an unbounded cross-tenant table-wide UPDATE — changes no component of the
  // identity and no count, so every leg above stays empty. This one reds.
  //
  // Compared as a sorted MULTISET, not a set, and that is load-bearing: 11 of the 19 repeated
  // identities have occurrences with DIFFERENT statement text, and 5 more have two occurrences
  // sharing one fingerprint. A set would collapse those and silently lose an occurrence.
  //
  // A count change reds here as well as in overCount/missing. That overlap is deliberate: the
  // legs are additive and none is weakened to keep them disjoint.
  const fingerprintDrift = []
  for (const row of APPROVED_SITE_IDENTITIES) {
    const key = siteIdentityKey(row)
    const pinned = [...(row.statementFingerprints || [])].sort()
    const observed = [...(observedFingerprintsByKey.get(key) || [])].sort()
    if (JSON.stringify(pinned) !== JSON.stringify(observed)) {
      fingerprintDrift.push({
        identity: siteIdentityLabel(row),
        pinned,
        observed,
        entryIds: row.entryIds,
      })
    }
  }

  return {
    claimsByEntryId,
    genericAllowlisted,
    unclaimed,
    overCount,
    missing,
    fingerprintDrift,
    trackedSiteCount: trackedSites.length,
    observedIdentityCount: observedCountByKey.size,
    approvedIdentityCount: APPROVED_SITE_IDENTITIES.length,
  }
}

module.exports = { classifyTrackedSites }
