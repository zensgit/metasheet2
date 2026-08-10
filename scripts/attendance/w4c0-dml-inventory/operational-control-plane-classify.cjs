'use strict'

// #4556 W4C-0 follow-up — owner ruling on the report-sync job control-plane writes.
//
// Classifies operational-control-plane-census.cjs's site list against
// operational-control-plane-registry.cjs's exact tuples and
// plugin-attendance-table-domain.cjs's migrations-derived domain. Six buckets:
//
//   - claimed:           site's (relPath, symbol, table, verb) identity is registered, its
//                         observed count is not over the registered multiplicity, and its
//                         statement fingerprint matches.
//   - unclaimed:         table IS in the migrations-derived domain, but this
//                         (relPath, symbol, table, verb) identity is not registered at all —
//                         a new table/verb/symbol inside an otherwise-known file.
//   - undomained:        table matches the `plugin_attendance_` prefix but no migration creates
//                         it. Deliberately a SEPARATE bucket from `unclaimed` (not folded into
//                         "not in domain therefore invisible") — see the module docblock on why
//                         the census's scope gate is the prefix, not domain membership: a
//                         constant re-pointed at an undomained table must still surface here,
//                         not silently fall out of scope.
//   - missing:           a registered identity's observed count is 0 (the constant was
//                         re-pointed away, the symbol/verb changed, or the site was deleted).
//   - overCount:         a registered identity's observed count exceeds its multiplicity (a
//                         second write added inside an already-approved symbol).
//   - fingerprintDrift:  a registered identity matched on (relPath, symbol, table, verb) with
//                         the right count, but the statement text hashed differently — the SQL
//                         around the table target changed shape without changing its verb.
//
// Registry precision note: identity keys are built from a JSON array, not a `::`-joined string
// (a joined key lets a symbol name containing the separator alias a different tuple — the very
// defect this task's owning ruling exists to keep out of an "exact identity" mechanism).

function identityKey(x) {
  return JSON.stringify([x.relPath, x.symbol ?? x.enclosingSymbol, x.table, x.verb])
}

function classifyOperationalControlPlaneSites(sites, registry, domainTables) {
  const domainSet = new Set(domainTables)
  const registryByIdentity = new Map(registry.map((entry) => [identityKey(entry), entry]))
  const sitesByIdentity = new Map()

  const undomained = []
  const unclaimed = []

  for (const site of sites) {
    if (!domainSet.has(site.table)) {
      undomained.push(site)
      continue
    }
    const key = identityKey(site)
    if (!sitesByIdentity.has(key)) sitesByIdentity.set(key, [])
    sitesByIdentity.get(key).push(site)
    if (!registryByIdentity.has(key)) unclaimed.push(site)
  }

  const claimed = []
  const missing = []
  const overCount = []
  const fingerprintDrift = []

  for (const entry of registry) {
    const key = identityKey(entry)
    const matched = sitesByIdentity.get(key) || []
    if (matched.length === 0) {
      missing.push(entry)
      continue
    }
    if (matched.length > entry.multiplicity) {
      overCount.push({ entry, observed: matched.length, sites: matched })
      continue
    }
    for (const site of matched) {
      if (site.fingerprint !== entry.fingerprint) {
        fingerprintDrift.push({ entry, site })
      } else {
        claimed.push(site)
      }
    }
  }

  return { claimed, unclaimed, undomained, missing, overCount, fingerprintDrift }
}

module.exports = { identityKey, classifyOperationalControlPlaneSites }
