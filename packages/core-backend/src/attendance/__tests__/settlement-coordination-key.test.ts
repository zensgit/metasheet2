import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'

import {
  ADVISORY_FIXED_KEY1_REGISTRY,
  AttendanceCoordinationKeyError,
  SETTLEMENT_COORDINATION_KEY1,
  SETTLEMENT_COORDINATION_KEY2_PREFIX,
  buildSettlementCoordinationKeyV1,
  canonicalizeSettlementCoordinationOrgV1,
  deriveSettlementCoordinationKey2V1,
} from '../coordination/settlement-coordination-key'

const UUID_LOWER = '0e4b1f8a-3c2d-4e5f-9a6b-7c8d9e0f1a2b'

// Independent re-derivation (string concatenation with an embedded NUL rather than the module's
// Buffer.concat), so a regression in either path shows up as a mismatch.
function independentKey2(org: string): number {
  return createHash('sha256').update(`${SETTLEMENT_COORDINATION_KEY2_PREFIX}\u0000${org}`, 'utf8').digest().readInt32BE(0)
}

describe('settlement coordination key', () => {
  it('reserves key1 = 0x4D533243', () => {
    expect(SETTLEMENT_COORDINATION_KEY1).toBe(1297297987)
    expect(SETTLEMENT_COORDINATION_KEY1.toString(16)).toBe('4d533243')
    expect(SETTLEMENT_COORDINATION_KEY2_PREFIX).toBe('metasheet2:attendance:settlement-coordination:v1')
  })

  it('derives key2 from SHA-256(prefix NUL org) as a big-endian signed int4 — pinned goldens', () => {
    const goldens: Array<[string, number]> = [
      ['default', 1908561738],
      [UUID_LOWER, -1064581151],
      ['legacy-org-42', -470462511],
      ['部门-甲', 439789506],
    ]
    for (const [org, key2] of goldens) {
      expect(deriveSettlementCoordinationKey2V1(org)).toBe(key2)
      expect(independentKey2(org)).toBe(key2)
    }
  })

  it('keeps key2 inside the signed int4 range', () => {
    for (let i = 0; i < 200; i += 1) {
      const key2 = deriveSettlementCoordinationKey2V1(`org-${i}`)
      expect(Number.isInteger(key2)).toBe(true)
      expect(key2).toBeGreaterThanOrEqual(-2147483648)
      expect(key2).toBeLessThanOrEqual(2147483647)
    }
  })

  it('canonicalizes canonical orgs through the class-00 lexical rules', () => {
    expect(canonicalizeSettlementCoordinationOrgV1(UUID_LOWER)).toEqual({ lexical: UUID_LOWER, kind: 'canonical' })
    expect(canonicalizeSettlementCoordinationOrgV1(UUID_LOWER.toUpperCase())).toEqual({ lexical: UUID_LOWER, kind: 'canonical' })
    expect(canonicalizeSettlementCoordinationOrgV1('default')).toEqual({ lexical: 'default', kind: 'canonical' })
    const upper = buildSettlementCoordinationKeyV1(UUID_LOWER.toUpperCase())
    const lower = buildSettlementCoordinationKeyV1(UUID_LOWER)
    expect(upper.key2).toBe(lower.key2)
  })

  it('uses legacy orgs as-is and rejects any non-canonical form instead of repairing it', () => {
    expect(canonicalizeSettlementCoordinationOrgV1('legacy-org-42')).toEqual({ lexical: 'legacy-org-42', kind: 'legacy' })
    expect(canonicalizeSettlementCoordinationOrgV1('Default')).toEqual({ lexical: 'Default', kind: 'legacy' })
    expect(canonicalizeSettlementCoordinationOrgV1('部门-甲')).toEqual({ lexical: '部门-甲', kind: 'legacy' })
    // No length cap: the org column is unbounded text.
    expect(canonicalizeSettlementCoordinationOrgV1('x'.repeat(4096)).kind).toBe('legacy')
    const rejected: unknown[] = [
      '',
      ' legacy-org-42',
      'legacy-org-42 ',
      '\tlegacy',
      'legacy\n',
      'a\u0000b',
      ` ${UUID_LOWER}`,
      null,
      undefined,
      42,
      {},
    ]
    for (const input of rejected) {
      expect(() => canonicalizeSettlementCoordinationOrgV1(input)).toThrow(AttendanceCoordinationKeyError)
    }
  })

  it('builds the full key for canonical and legacy orgs', () => {
    const key = buildSettlementCoordinationKeyV1('legacy-org-42')
    expect(key).toEqual({
      org: { lexical: 'legacy-org-42', kind: 'legacy' },
      key1: 1297297987,
      key2: -470462511,
    })
  })

  it('lists the coordination key1 in the fixed key1 registry with distinct names', () => {
    const names = ADVISORY_FIXED_KEY1_REGISTRY.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    const coordination = ADVISORY_FIXED_KEY1_REGISTRY.find((entry) => entry.name === 'attendance-settlement-coordination')
    expect(coordination?.key1).toEqual({ literal: 1297297987 })
    const literals = ADVISORY_FIXED_KEY1_REGISTRY.flatMap((entry) => ('literal' in entry.key1 ? [entry.key1.literal] : []))
    expect(new Set(literals).size).toBe(literals.length)
  })
})
