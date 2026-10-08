import { describe, expect, it } from 'vitest'

import {
  OPAQUE_IDENTITY_TOKEN_BYTES,
  createOpaqueFormIdentityAllocator,
  defaultIdentityRandomSource,
  type IdentityRandomSource,
} from '../src/approvals/approvalFormIdentity'

/** Deterministic seam: replays scripted byte blocks and counts draws. */
function scriptedSource(blocks: number[][]): IdentityRandomSource & {
  draws: number
} {
  let cursor = 0
  const source = {
    draws: 0,
    nextBytes(length: number): Uint8Array {
      expect(length).toBe(OPAQUE_IDENTITY_TOKEN_BYTES)
      const block = blocks[cursor % blocks.length]!
      cursor += 1
      source.draws += 1
      return Uint8Array.from(block)
    },
  }
  return source
}

function countingSource(): IdentityRandomSource & { draws: number } {
  const source = {
    draws: 0,
    nextBytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length)
      // Encode the draw ordinal into the block so every token is distinct
      // and provably a function of the seam, not of any outside state.
      bytes[0] = (source.draws >> 8) & 0xff
      bytes[1] = source.draws & 0xff
      source.draws += 1
      return bytes
    },
  }
  return source
}

describe('approvalFormIdentity - opaque collision-resistant allocator (FB-D5)', () => {
  it('derives identities from the injected opaque randomness, never from list length or suffix counters', () => {
    // Named discriminating pin: a length-/suffix-derived allocator ignores the
    // injected seam, so these EXACT ids can only come from the seam bytes.
    const source = scriptedSource([
      [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07],
      [0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88],
    ])
    const allocator = createOpaqueFormIdentityAllocator(source)
    const identity = allocator.nextFieldIdentity('text')
    expect(identity).toEqual({
      persistentId: 'fld_0001020304050607',
      localId: 'fldloc_ffeeddccbbaa9988',
    })
    expect(identity.detailColumn).toBeUndefined()
    expect(source.draws).toBe(2)
  })

  it('mints a detail field identity with a first-column identity from four independent draws', () => {
    const source = countingSource()
    const allocator = createOpaqueFormIdentityAllocator(source)
    const identity = allocator.nextFieldIdentity('detail')
    expect(identity.persistentId).toMatch(/^fld_[0-9a-f]{16}$/)
    expect(identity.localId).toMatch(/^fldloc_[0-9a-f]{16}$/)
    expect(identity.detailColumn?.persistentId).toMatch(/^dcol_[0-9a-f]{16}$/)
    expect(identity.detailColumn?.localId).toMatch(/^dcolloc_[0-9a-f]{16}$/)
    expect(source.draws).toBe(4)
    // All four tokens are pairwise distinct.
    const tokens = [
      identity.persistentId,
      identity.localId,
      identity.detailColumn!.persistentId,
      identity.detailColumn!.localId,
    ].map((value) => value.slice(value.indexOf('_') + 1))
    expect(new Set(tokens).size).toBe(4)
  })

  it('produces a FRESH candidate on every call (retry never re-submits a rejected candidate)', () => {
    const source = countingSource()
    const allocator = createOpaqueFormIdentityAllocator(source)
    const first = allocator.nextFieldIdentity('text')
    const second = allocator.nextFieldIdentity('text')
    expect(second.persistentId).not.toBe(first.persistentId)
    expect(second.localId).not.toBe(first.localId)
    const columnA = allocator.nextDetailColumnIdentity()
    const columnB = allocator.nextDetailColumnIdentity()
    expect(columnB.persistentId).not.toBe(columnA.persistentId)
    expect(columnB.localId).not.toBe(columnA.localId)
  })

  it('default source mints unique well-formed identities at session scale', () => {
    const allocator = createOpaqueFormIdentityAllocator()
    const seen = new Set<string>()
    for (let index = 0; index < 500; index += 1) {
      const identity = allocator.nextFieldIdentity('text')
      expect(identity.persistentId).toMatch(/^fld_[0-9a-f]{16}$/)
      expect(identity.localId).toMatch(/^fldloc_[0-9a-f]{16}$/)
      seen.add(identity.persistentId)
      seen.add(identity.localId)
    }
    expect(seen.size).toBe(1000)
  })

  it('opaque prefixes never alias the legacy length-derived shapes', () => {
    const allocator = createOpaqueFormIdentityAllocator()
    const identity = allocator.nextFieldIdentity('detail')
    const column = allocator.nextDetailColumnIdentity()
    for (const value of [
      identity.persistentId,
      identity.localId,
      identity.detailColumn!.persistentId,
      identity.detailColumn!.localId,
      column.persistentId,
      column.localId,
    ]) {
      // Legacy shapes: field_N / col_N (persisted) and field_<ts>_* /
      // detailcol_<ts>_* (local). The opaque lineage must not collide.
      expect(value).not.toMatch(/^field_/)
      expect(value).not.toMatch(/^col_/)
      expect(value).not.toMatch(/^detailcol_/)
    }
  })

  it('default random source returns independent blocks of the requested length', () => {
    const source = defaultIdentityRandomSource()
    const first = source.nextBytes(OPAQUE_IDENTITY_TOKEN_BYTES)
    const second = source.nextBytes(OPAQUE_IDENTITY_TOKEN_BYTES)
    expect(first).toHaveLength(OPAQUE_IDENTITY_TOKEN_BYTES)
    expect(second).toHaveLength(OPAQUE_IDENTITY_TOKEN_BYTES)
    // 2^-64 false-failure probability: two independent 8-byte draws colliding.
    expect(Array.from(first)).not.toEqual(Array.from(second))
  })
})
