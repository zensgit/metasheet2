// W4 commit accepts only a canonical 8-4-4-4-12 user id. Preview used to treat any
// non-empty UserId cell (including an email) as already resolved, then commit threw
// W4C0_USER_ID_INVALID and the route answered HTTP 500. Both paths now share this check.
const CANONICAL_IMPORT_USER_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function isCanonicalImportUserId(value) {
  return typeof value === 'string' && value.length === 36 && CANONICAL_IMPORT_USER_ID_RE.test(value)
}

const IMPORT_USER_IDENTIFIER_WHITESPACE = ' \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

function importUserIdentifierLookupKey(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return ''
  try {
    return trimmed.normalize('NFKC').toLowerCase()
  } catch (_error) {
    return trimmed.toLowerCase()
  }
}

function importUserMobileMatchKeys(value) {
  const compact = importUserIdentifierLookupKey(value).replace(/[\s()-]/g, '')
  if (!/^\+?\d{7,15}$/.test(compact)) return []
  const keys = new Set([compact])
  if (compact.startsWith('+')) keys.add(compact.slice(1))
  if (compact.startsWith('+86') && compact.length > 3) keys.add(compact.slice(3))
  if (/^1\d{10}$/.test(compact)) keys.add(`+86${compact}`)
  return Array.from(keys)
}

function addOwner(index, key, id) {
  if (!key) return
  let owners = index.get(key)
  if (!owners) {
    owners = new Set()
    index.set(key, owners)
  }
  // Two distinct owners are enough to prove ambiguity, even in collision-heavy data.
  if (owners.size < 2) owners.add(id)
}

function buildImportUserOwnerIndexes(users) {
  const identifiers = new Map()
  const mobiles = new Map()
  for (const user of Array.isArray(users) ? users : []) {
    if (!user) continue
    const id = String(user.id)
    addOwner(identifiers, importUserIdentifierLookupKey(id), id)
    const email = user.email
    const username = user.username
    const mobile = user.mobile
    if (typeof email === 'string') addOwner(identifiers, importUserIdentifierLookupKey(email), id)
    if (typeof username === 'string') addOwner(identifiers, importUserIdentifierLookupKey(username), id)
    for (const key of importUserMobileMatchKeys(mobile)) addOwner(mobiles, key, id)
  }
  return { identifiers, mobiles }
}

function classifyImportUserIdentifier(raw, owners) {
  const matched = new Set()
  const groups = [owners.identifiers.get(importUserIdentifierLookupKey(raw))]
  for (const key of importUserMobileMatchKeys(raw)) groups.push(owners.mobiles.get(key))
  for (const group of groups) {
    for (const id of group ?? []) {
      matched.add(id)
      if (matched.size > 1) return { ambiguous: true }
    }
  }
  if (!matched.size) return { missing: true }
  const [id] = matched
  return isCanonicalImportUserId(id) ? { userId: id } : { nonCanonical: true }
}

function adoptCanonicalImportUserId(rawUserId, index) {
  if (!rawUserId) return { userId: null, warning: null }
  const raw = String(rawUserId).trim()
  if (!raw) return { userId: null, warning: null }
  if (isCanonicalImportUserId(raw)) return { userId: raw.toLowerCase(), warning: null }
  const entry = index instanceof Map ? index.get(importUserIdentifierLookupKey(raw)) : null
  if (entry?.userId && isCanonicalImportUserId(entry.userId)) {
    return { userId: entry.userId.toLowerCase(), warning: null }
  }
  if (entry?.ambiguous) {
    return {
      userId: null,
      warning: 'Unresolved user identifier; more than one user in this organization matches',
    }
  }
  if (entry?.nonCanonical) {
    return {
      userId: null,
      warning: 'Unresolved user identifier; the matched account id is not a canonical user id',
    }
  }
  return {
    userId: null,
    warning: 'Unresolved user identifier; use a user id, or an email, username, or mobile that matches one user in this organization',
  }
}

async function loadAttendanceImportUserIdentifierIndex(db, orgId, rawIdentifiers) {
  const index = new Map()
  const unique = []
  const seen = new Set()
  for (const raw of Array.isArray(rawIdentifiers) ? rawIdentifiers : []) {
    const trimmed = String(raw ?? '').trim()
    if (!trimmed || isCanonicalImportUserId(trimmed)) continue
    const key = importUserIdentifierLookupKey(trimmed)
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(trimmed)
  }
  if (!unique.length || !db || typeof db.query !== 'function') return index

  const lowerKeys = unique.map((value) => importUserIdentifierLookupKey(value))
  const mobileKeys = Array.from(new Set(unique.flatMap((value) => importUserMobileMatchKeys(value))))
  // Alias columns are optional on older schemas. Authorization columns are required:
  // never retry without the active user and active organization membership predicates.
  // Non-ASCII aliases are a candidate superset: JS owns Unicode case folding, not the DB locale.
  let users
  try {
    users = await db.query(
      `SELECT u.id::text AS id, u.email,
              to_jsonb(u)->>'username' AS username, to_jsonb(u)->>'mobile' AS mobile
         FROM users u
         JOIN user_orgs uo ON uo.user_id = u.id
        WHERE uo.org_id = $1
          AND uo.is_active = true
          AND u.is_active = true
          AND (
            u.id = ANY($2::text[])
            OR lower(btrim(normalize(COALESCE(u.email, ''), NFKC), $5::text) COLLATE "C") = ANY($3::text[])
            OR lower(btrim(normalize(COALESCE(to_jsonb(u)->>'username', ''), NFKC), $5::text) COLLATE "C") = ANY($3::text[])
            OR translate(COALESCE(to_jsonb(u)->>'mobile', ''), $5::text || '-()', '') = ANY($4::text[])
            OR octet_length(COALESCE(u.email, '')) <> length(COALESCE(u.email, ''))
            OR octet_length(COALESCE(to_jsonb(u)->>'username', '')) <> length(COALESCE(to_jsonb(u)->>'username', ''))
            OR octet_length(COALESCE(to_jsonb(u)->>'mobile', '')) <> length(COALESCE(to_jsonb(u)->>'mobile', ''))
          )`,
      [orgId, unique, lowerKeys, mobileKeys, IMPORT_USER_IDENTIFIER_WHITESPACE]
    )
  } catch (error) {
    if (error?.code === '42703' || error?.code === '42P01') {
      throw Object.assign(new Error('ATTENDANCE_IMPORT_IDENTITY_SCHEMA_NOT_READY'), { code: error.code })
    }
    throw new Error('ATTENDANCE_IMPORT_IDENTITY_LOOKUP_FAILED')
  }
  const owners = buildImportUserOwnerIndexes(users)
  for (const raw of unique) {
    index.set(importUserIdentifierLookupKey(raw), classifyImportUserIdentifier(raw, owners))
  }
  return index
}

module.exports = {
  isCanonicalImportUserId,
  importUserIdentifierLookupKey,
  adoptCanonicalImportUserId,
  loadAttendanceImportUserIdentifierIndex,
}
