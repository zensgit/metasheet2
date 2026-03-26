import type { MetaField } from '../types'
import { extractImportTokens } from '../import/delimited'

export type PeopleImportLookupMaps = {
  recordId?: Map<string, string | null>
  email?: Map<string, string | null>
  name?: Map<string, string | null>
  alias?: Map<string, string | null>
}

type LookupKind = 'recordId' | 'email' | 'name' | 'alias'

export function normalizePeopleImportKey(value: string): string {
  return value.trim().toLowerCase()
}

export function addPeopleLookupToken(map: Map<string, string | null>, token: string, recordId: string) {
  const normalized = normalizePeopleImportKey(token)
  if (!normalized) return
  const current = map.get(normalized)
  if (typeof current === 'string' && current !== recordId) {
    map.set(normalized, null)
    return
  }
  if (current === null) return
  map.set(normalized, recordId)
}

export function inferPeopleLookupKind(fieldName: string): Exclude<LookupKind, 'recordId'> | null {
  const normalized = fieldName.trim()
  if (!normalized) return null
  if (/email/i.test(normalized)) return 'email'
  if (/^name$/i.test(normalized) || /\bfull name\b/i.test(normalized) || /\bdisplay name\b/i.test(normalized)) return 'name'
  if (/(alias|display|nickname|nick ?name|username|user name)/i.test(normalized)) return 'alias'
  return null
}

function ambiguousMatchMessage(token: string, kind: LookupKind) {
  if (kind === 'recordId') return `Multiple people match "${token}"`
  if (kind === 'email') return `Multiple people match "${token}". Please verify the email value.`
  return `Multiple people match "${token}". Use email for an exact match.`
}

function collectMatchesForLookup(token: string, kind: LookupKind, lookup?: Map<string, string | null>) {
  if (!lookup) return []
  const normalized = normalizePeopleImportKey(token)
  if (!normalized || !lookup.has(normalized)) return []
  const match = lookup.get(normalized)
  if (match === null) throw new Error(ambiguousMatchMessage(token, kind))
  return typeof match === 'string' ? [match] : []
}

function pushUniqueIds(target: string[], ids: string[]) {
  for (const id of ids) {
    if (!target.includes(id)) target.push(id)
  }
}

export function resolvePeopleImportValue(params: {
  rawValue: string
  currentField?: MetaField
  lookups: PeopleImportLookupMaps
}): string[] | null {
  const { rawValue, currentField, lookups } = params
  const tokens = extractImportTokens(rawValue)
  if (!tokens.length) return null

  const matchesFromIds: string[] = []
  for (const token of tokens) {
    pushUniqueIds(matchesFromIds, collectMatchesForLookup(token, 'recordId', lookups.recordId))
  }
  if (matchesFromIds.length) {
    if (currentField?.property?.limitSingleRecord === true && matchesFromIds.length > 1) {
      throw new Error(`People field only allows one person: ${rawValue}`)
    }
    return matchesFromIds
  }

  const priorities: Array<Exclude<LookupKind, 'recordId'>> = ['email', 'name', 'alias']
  for (const kind of priorities) {
    const bucketMatches: string[] = []
    for (const token of tokens) {
      pushUniqueIds(bucketMatches, collectMatchesForLookup(token, kind, lookups[kind]))
    }
    if (!bucketMatches.length) continue
    if (currentField?.property?.limitSingleRecord === true && bucketMatches.length > 1) {
      throw new Error(`People field only allows one person: ${rawValue}`)
    }
    return bucketMatches
  }

  return null
}
