/**
 * SPIKE 3 — External key registry: unit tests for the pure prototype logic.
 * No DB. Exercises spike3-registry-prototype.ts only.
 */

import { describe, expect, it } from 'vitest'

import {
  classifyUpsert,
  detectCollapse,
  hashCanonicalKey,
  normalizeKey,
  stableExternalKeyId,
  type ExternalKeyRow,
  type OldRowForCollapseCheck,
} from './spike3-registry-prototype'

describe('normalizeKey', () => {
  it('v1 trims, collapses internal whitespace, and uppercases', () => {
    expect(normalizeKey('  pn-007b  ', 'v1')).toBe('PN-007B')
    expect(normalizeKey('pn   007b', 'v1')).toBe('PN 007B')
  })

  it('v1 does NOT strip leading zeros', () => {
    expect(normalizeKey('0007', 'v1')).toBe('0007')
    expect(normalizeKey('PN-007B', 'v1')).toBe('PN-007B')
  })

  it('v1 folds full-width (NFKC) digits/letters to half-width', () => {
    // full-width "０００７" (U+FF10 x3, U+FF17) -> "0007"
    expect(normalizeKey('０００７', 'v1')).toBe('0007')
  })

  it('v2 strips leading zeros from digit runs, keeping at least one digit', () => {
    expect(normalizeKey('0007', 'v2')).toBe('7')
    expect(normalizeKey('PN-007B', 'v2')).toBe('PN-7B')
    expect(normalizeKey('0', 'v2')).toBe('0')
    expect(normalizeKey('00', 'v2')).toBe('0')
  })

  it('v2 still applies v1 rules (case/space/NFKC) on top of zero-stripping', () => {
    expect(normalizeKey('  pn-007b  ', 'v2')).toBe('PN-7B')
  })

  it('is a pure function: same input+version always yields same output', () => {
    const a = normalizeKey('PN-0007', 'v2')
    const b = normalizeKey('PN-0007', 'v2')
    expect(a).toBe(b)
  })

  it('throws on an unrecognized version rather than silently passing through', () => {
    // @ts-expect-error deliberately invalid version to prove the runtime guard
    expect(() => normalizeKey('x', 'v999')).toThrow(RangeError)
  })

  it('throws on null/undefined raw key', () => {
    // @ts-expect-error deliberately invalid input
    expect(() => normalizeKey(null, 'v1')).toThrow(TypeError)
  })
})

describe('hashCanonicalKey', () => {
  it('is deterministic sha256 hex', () => {
    const h1 = hashCanonicalKey('PN-7B')
    const h2 = hashCanonicalKey('PN-7B')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs for different canonical strings (no accidental universal collision)', () => {
    expect(hashCanonicalKey('PN-7B')).not.toBe(hashCanonicalKey('PN-7C'))
  })
})

describe('classifyUpsert', () => {
  const activeRow = (over: Partial<ExternalKeyRow> = {}): ExternalKeyRow => {
    const canonicalKey = over.canonicalKey ?? 'PN-7B'
    return {
      id: 'xkey_1',
      recordId: 'rec_A',
      canonicalKey,
      // Default the hash from the (possibly overridden) canonicalKey so a fixture
      // that changes canonicalKey stays self-consistent; an explicit
      // normalizedKeyHash override (for forced-collision fixtures) still wins.
      normalizedKeyHash: hashCanonicalKey(canonicalKey),
      normalizationVersion: 'v2',
      state: 'active',
      ...over,
    }
  }

  it('classifies as new when no existing row shares the canonical key', () => {
    const result = classifyUpsert([], 'PN-7B', 'rec_A')
    expect(result.kind).toBe('new')
  })

  it('classifies as match when the same record re-submits the same canonical key (idempotent)', () => {
    const existing = activeRow()
    const result = classifyUpsert([existing], 'PN-7B', 'rec_A')
    expect(result).toEqual({ kind: 'match', existing })
  })

  it('classifies as collision when a DIFFERENT record submits the same canonical key', () => {
    const existing = activeRow({ recordId: 'rec_A' })
    const result = classifyUpsert([existing], 'PN-7B', 'rec_B')
    expect(result).toEqual({ kind: 'collision', existing })
  })

  it('acceptance: hash collision — two distinct canonicals coexist & are distinguishable', () => {
    // rowX carries the REAL sha256 hash of its own canonical key ('PN-7B') —
    // this is what the DB would actually store. rowY is deliberately given
    // the SAME hash value under a DIFFERENT canonicalKey, simulating the one
    // scenario the schema must tolerate: a genuine (astronomically rare)
    // sha256 collision between two unrelated business keys. A real sha256
    // collision cannot be constructed by hand, so this test constructs the
    // bucket directly and proves classifyUpsert never trusts the hash alone
    // — it always re-derives the incoming hash and then requires an EXACT
    // canonicalKey match before calling something 'match' or 'collision'.
    const sharedHash = hashCanonicalKey('PN-7B')
    const rowX = activeRow({ id: 'xkey_x', recordId: 'rec_X', canonicalKey: 'PN-7B', normalizedKeyHash: sharedHash })
    const rowY = activeRow({ id: 'xkey_y', recordId: 'rec_Y', canonicalKey: 'CANON-Y-DIFFERENT', normalizedKeyHash: sharedHash })

    // Re-submitting the exact canonical 'PN-7B' for its own owner (rec_X)
    // matches rowX specifically — rowY sharing the same hash bucket does not
    // interfere, proving the two distinct canonicals are distinguishable.
    const matchResult = classifyUpsert([rowX, rowY], 'PN-7B', 'rec_X')
    expect(matchResult).toEqual({ kind: 'match', existing: rowX })

    // A different record trying to claim 'PN-7B' is a collision against rowX
    // specifically — again not confused with rowY despite the shared hash.
    const collisionResult = classifyUpsert([rowX, rowY], 'PN-7B', 'rec_OTHER')
    expect(collisionResult).toEqual({ kind: 'collision', existing: rowX })

    // rowY's own canonical ('CANON-Y-DIFFERENT') has its OWN real hash in
    // practice (the fixture only forced its stored hash for bucket-sharing
    // purposes); submitting that literal string looks up its true hash
    // bucket, which contains neither row here, so it is correctly 'new'.
    // This documents that the fixture's forced collision does not leak into
    // unrelated lookups.
    const unrelatedResult = classifyUpsert([rowX, rowY], 'CANON-Y-DIFFERENT', 'rec_Y')
    expect(unrelatedResult.kind).toBe('new')
  })

  it('acceptance: one external key never points to two active records (collision blocks second binder)', () => {
    const existing = activeRow({ recordId: 'rec_A', canonicalKey: 'PN-1' })
    const attempt = classifyUpsert([existing], 'PN-1', 'rec_B')
    expect(attempt.kind).toBe('collision')
    // Caller contract: a 'collision' result must be rejected/escalated, never
    // silently written — this test documents the contract the DB partial
    // unique index (see migration .draft.sql) backstops.
  })

  it('ignores rows in non-active states (state filtering is the caller\'s job before calling in)', () => {
    // classifyUpsert trusts its input list is already state='active'-filtered
    // (mirrors the DB query `WHERE registry_generation_id = ? AND state = 'active'`).
    // A retired row with the same canonical must not block a fresh new-classification
    // if the caller correctly excludes it.
    const result = classifyUpsert([], 'PN-1', 'rec_A')
    expect(result.kind).toBe('new')
  })
})

describe('detectCollapse', () => {
  it('reports no groups for an empty input', () => {
    const report = detectCollapse([], 'v2')
    expect(report.safe).toEqual([])
    expect(report.conflicts).toEqual([])
  })

  it('acceptance: normalization upgrade can COLLAPSE two v1-distinct keys onto one v2 canonical (single record = safe)', () => {
    const oldRows: OldRowForCollapseCheck[] = [
      { id: 'xkey_1', recordId: 'rec_A', rawKey: 'PN-0007' },
      { id: 'xkey_2', recordId: 'rec_A', rawKey: 'PN-7' },
    ]
    // Under v1 these are distinct (0007 !== 7). Under v2 both -> "PN-7".
    expect(normalizeKey('PN-0007', 'v1')).not.toBe(normalizeKey('PN-7', 'v1'))
    expect(normalizeKey('PN-0007', 'v2')).toBe(normalizeKey('PN-7', 'v2'))

    const report = detectCollapse(oldRows, 'v2')
    expect(report.conflicts).toEqual([])
    expect(report.safe).toHaveLength(1)
    expect(report.safe[0]).toMatchObject({
      newCanonical: 'PN-7',
      recordIds: ['rec_A'],
    })
    expect(report.safe[0].sourceRowIds.sort()).toEqual(['xkey_1', 'xkey_2'])
  })

  it('flags a CONFLICT when two DIFFERENT records collapse onto the same new canonical', () => {
    const oldRows: OldRowForCollapseCheck[] = [
      { id: 'xkey_1', recordId: 'rec_A', rawKey: 'PN-0007' },
      { id: 'xkey_2', recordId: 'rec_B', rawKey: 'PN-7' }, // different record, same eventual canonical
    ]
    const report = detectCollapse(oldRows, 'v2')
    expect(report.safe).toEqual([])
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0].newCanonical).toBe('PN-7')
    expect(report.conflicts[0].recordIds.sort()).toEqual(['rec_A', 'rec_B'])
  })

  it('rows that remain distinct under the new normalizer produce separate safe groups', () => {
    const oldRows: OldRowForCollapseCheck[] = [
      { id: 'xkey_1', recordId: 'rec_A', rawKey: 'PN-7' },
      { id: 'xkey_2', recordId: 'rec_B', rawKey: 'PN-8' },
    ]
    const report = detectCollapse(oldRows, 'v2')
    expect(report.conflicts).toEqual([])
    expect(report.safe).toHaveLength(2)
    expect(report.safe.map((g) => g.newCanonical).sort()).toEqual(['PN-7', 'PN-8'])
  })

  it('a mixed rebuild can report both safe merges and blocking conflicts simultaneously', () => {
    const oldRows: OldRowForCollapseCheck[] = [
      // safe: same record, two old keys collapse
      { id: 'xkey_1', recordId: 'rec_A', rawKey: 'PN-0007' },
      { id: 'xkey_2', recordId: 'rec_A', rawKey: 'PN-7' },
      // conflict: two different records collapse
      { id: 'xkey_3', recordId: 'rec_B', rawKey: 'PN-0010' },
      { id: 'xkey_4', recordId: 'rec_C', rawKey: 'PN-10' },
      // untouched: unique, no collapse
      { id: 'xkey_5', recordId: 'rec_D', rawKey: 'PN-99' },
    ]
    const report = detectCollapse(oldRows, 'v2')
    expect(report.safe.map((g) => g.newCanonical).sort()).toEqual(['PN-7', 'PN-99'])
    expect(report.conflicts.map((g) => g.newCanonical)).toEqual(['PN-10'])
    expect(report.conflicts[0].recordIds.sort()).toEqual(['rec_B', 'rec_C'])
  })
})

describe('stableExternalKeyId', () => {
  it('is deterministic for the same (binding, generation, canonical) triple', () => {
    const a = stableExternalKeyId('bind_1', 'gen_1', 'PN-7B')
    const b = stableExternalKeyId('bind_1', 'gen_1', 'PN-7B')
    expect(a).toBe(b)
    expect(a.startsWith('xkey_')).toBe(true)
    expect(a.length).toBeLessThanOrEqual(50)
  })

  it('differs when the registry generation differs, even for the same canonical key', () => {
    const genA = stableExternalKeyId('bind_1', 'gen_A', 'PN-7B')
    const genB = stableExternalKeyId('bind_1', 'gen_B', 'PN-7B')
    expect(genA).not.toBe(genB)
  })
})
