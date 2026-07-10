import { describe, expect, it } from 'vitest'
import {
  FILES_POISON_KEY_PREFIX,
  deriveStorageKeyFromUrl,
  isPoisonedStorageKey,
} from '../../src/services/filesStorageKey'
import { QUARANTINE_PREFIX } from '../../src/db/migrations/zzzz20260710140000_add_files_storage_key'

// F3 files-storage-integrity design-lock (2026-07-10), owner guard E + poison-prefix drift guard.
// Pure-function coverage — the accept/reject logic is the security-load-bearing part.

const BASE = 'http://localhost:8900/files'

describe('filesStorageKey: deriveStorageKeyFromUrl (owner guard E — controlled fallback)', () => {
  it('recovers the raw relative key for a same-origin url', () => {
    expect(deriveStorageKeyFromUrl(`${BASE}/photo.jpg`, BASE)).toBe('photo.jpg')
    expect(deriveStorageKeyFromUrl(`${BASE}/sub/dir/report.pdf`, BASE)).toBe('sub/dir/report.pdf')
    // a raw legacy filename with a literal `%` that is NOT valid percent-encoding is tolerated (kept raw)
    expect(deriveStorageKeyFromUrl(`${BASE}/50%off.pdf`, BASE)).toBe('50%off.pdf')
  })

  it('tolerates a trailing-slash difference between the stored baseUrl and the arg', () => {
    expect(deriveStorageKeyFromUrl(`${BASE}/x.png`, `${BASE}/`)).toBe('x.png')
  })

  it('rejects a cross-origin / non-prefixed url (returns null → route 404s)', () => {
    expect(deriveStorageKeyFromUrl('http://evil.example/files/x.png', BASE)).toBeNull()
    expect(deriveStorageKeyFromUrl('https://localhost:8900/files/x.png', BASE)).toBeNull()
    expect(deriveStorageKeyFromUrl(`${BASE}`, BASE)).toBeNull() // no trailing key
    expect(deriveStorageKeyFromUrl(`${BASE}/`, BASE)).toBeNull() // empty key
  })

  it('rejects a raw `..` traversal segment', () => {
    expect(deriveStorageKeyFromUrl(`${BASE}/../secret`, BASE)).toBeNull()
    expect(deriveStorageKeyFromUrl(`${BASE}/a/../../secret`, BASE)).toBeNull()
    expect(deriveStorageKeyFromUrl(`${BASE}/dir/..`, BASE)).toBeNull()
    // backslash separator variant
    expect(deriveStorageKeyFromUrl(`${BASE}/..\\secret`, BASE)).toBeNull()
  })

  it('rejects an ENCODED traversal segment (%2e%2e) that decodes to `..`', () => {
    expect(deriveStorageKeyFromUrl(`${BASE}/%2e%2e/secret`, BASE)).toBeNull()
    expect(deriveStorageKeyFromUrl(`${BASE}/a/%2e%2e/%2e%2e/secret`, BASE)).toBeNull()
  })

  it('rejects null/empty inputs', () => {
    expect(deriveStorageKeyFromUrl(null, BASE)).toBeNull()
    expect(deriveStorageKeyFromUrl(undefined, BASE)).toBeNull()
    expect(deriveStorageKeyFromUrl(`${BASE}/x`, '')).toBeNull()
  })
})

describe('filesStorageKey: poison sentinel (owner guard D/G rule 2)', () => {
  it('isPoisonedStorageKey matches exactly the quarantine prefix', () => {
    expect(isPoisonedStorageKey('!f3-collision:abc')).toBe(true)
    expect(isPoisonedStorageKey(`${FILES_POISON_KEY_PREFIX}some-id`)).toBe(true)
    expect(isPoisonedStorageKey('uuid/photo.jpg')).toBe(false)
    expect(isPoisonedStorageKey(null)).toBe(false)
    expect(isPoisonedStorageKey(undefined)).toBe(false)
    expect(isPoisonedStorageKey('')).toBe(false)
  })

  it('the read-path poison prefix and the migration quarantine prefix are IDENTICAL (drift guard)', () => {
    // If these ever diverge, the migration would poison rows the read path no longer rejects — silently
    // re-opening the F3-1 shared-blob leak. This assertion makes that impossible.
    expect(FILES_POISON_KEY_PREFIX).toBe(QUARANTINE_PREFIX)
  })
})
