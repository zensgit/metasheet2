import { describe, expect, it } from 'vitest'

import { sourceSyncFreezeLockKey } from '../../src/directory/source-sync-freeze-lock'

// T2 lock-correctness P1 — no-DB guard for the key contract. The advisory lock hashes the
// RAW TEXT key, so the key function is case-SENSITIVE even though `directory_integrations.id`
// is a uuid column that matches case-insensitively. That asymmetry is exactly why
// `syncDirectoryIntegration` MUST canonicalize the route-supplied id to the DB-read-back
// `integration.id` before any lock acquisition (the DB-side proof — read-back equality and
// hashtext divergence on a real row — lives in
// tests/integration/directory-source-freeze-lock-correctness.db.test.ts).
describe('sourceSyncFreezeLockKey — case-sensitivity makes canonicalization load-bearing', () => {
  it('is a pure prefix + verbatim id (no normalization inside the key fn)', () => {
    expect(sourceSyncFreezeLockKey('abc-def')).toBe('directory:source-sync-freeze:abc-def')
  })

  it('case-variant ids of the SAME uuid row produce DIFFERENT keys', () => {
    const lower = 'facade00-1234-4abc-8def-0123456789ab'
    const upper = lower.toUpperCase()
    expect(sourceSyncFreezeLockKey(upper)).not.toBe(sourceSyncFreezeLockKey(lower))
  })
})
