/**
 * W0-1 — generation-aware contiguity, the PURE core (`checkRecordChainContiguity`). Unit-level, no DB, so the
 * exact-set / generation / delete-reuse semantics are pinned deterministically and are mutation-friendly:
 * the DB goldens (multitable-history-contiguity-realdb.test.ts) exercise the same logic end-to-end.
 *
 * `orderKey` is a monotone temporal position (created_at epoch, then version). Here we pass small integers to
 * express the temporal order of events within a record's lifetime.
 */
import { describe, expect, test } from 'vitest'

import { checkRecordChainContiguity, type ChainEvent, type VersionMarker } from '../../src/multitable/history-integrity-precheck'

const ev = (version: number, action: ChainEvent['action'], orderKey: number): ChainEvent => ({ version, action, orderKey })
const mk = (version: number, kind: VersionMarker['kind'], orderKey: number): VersionMarker => ({ version, kind, orderKey })

describe('W0-1 checkRecordChainContiguity — generation-aware exact-set', () => {
  test('healthy single-generation chain passes (positive control)', () => {
    expect(checkRecordChainContiguity(2, [ev(1, 'create', 0), ev(2, 'update', 1)], [])).toEqual({ ok: true })
  })

  test('THE HEALED-GAP: v3 record with revisions {v1, v3} (v2 uncaptured) → chain_hole', () => {
    // The exact design-flaw the whole slice exists to catch. A live-vs-latest comparator PASSES this (live == v3).
    expect(checkRecordChainContiguity(3, [ev(1, 'create', 0), ev(3, 'update', 2)], [])).toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('the same v2 hole HEALED by a lock marker → passes (marker is a legitimate non-data bump)', () => {
    expect(checkRecordChainContiguity(3, [ev(1, 'create', 0), ev(3, 'update', 2)], [mk(2, 'lock', 1)])).toEqual({ ok: true })
  })

  test('healthy record locked then unlocked (two markers fill v2 + v3) → passes', () => {
    expect(checkRecordChainContiguity(3, [ev(1, 'create', 0)], [mk(2, 'lock', 1), mk(3, 'unlock', 2)])).toEqual({ ok: true })
  })

  test('zero-revision live row (uncaptured CREATE fingerprint) → zero_revision_live_row', () => {
    expect(checkRecordChainContiguity(1, [], [])).toEqual({ ok: false, reason: 'zero_revision_live_row' })
  })

  test('duplicate create/update at one version → duplicate_version_event (C5, count-based would miss)', () => {
    expect(checkRecordChainContiguity(2, [ev(1, 'create', 0), ev(2, 'update', 1), ev(2, 'update', 2)], []))
      .toEqual({ ok: false, reason: 'duplicate_version_event' })
  })

  test('an event beyond the live version → out_of_range_version (C5)', () => {
    expect(checkRecordChainContiguity(2, [ev(1, 'create', 0), ev(2, 'update', 1), ev(3, 'update', 2)], []))
      .toEqual({ ok: false, reason: 'out_of_range_version' })
  })

  test('a marker beyond the live version → out_of_range_version', () => {
    expect(checkRecordChainContiguity(1, [ev(1, 'create', 0)], [mk(2, 'lock', 1)]))
      .toEqual({ ok: false, reason: 'out_of_range_version' })
  })

  test('live row whose latest event is a DELETE (uncaptured resurrection) → live_row_after_delete_revision', () => {
    expect(checkRecordChainContiguity(1, [ev(1, 'create', 0), ev(1, 'delete', 1)], []))
      .toEqual({ ok: false, reason: 'live_row_after_delete_revision' })
  })

  test('GENERATION: a trash-restored record (create/delete/create) → passes on its CURRENT generation', () => {
    // create@1 (gen1) → delete@1 (gen1 terminates, reuses v1) → create@1 (gen2 = current, restore at v1).
    // A non-generation-aware "duplicate create at v1" criterion would FALSELY refuse this common case.
    expect(checkRecordChainContiguity(1, [ev(1, 'create', 0), ev(1, 'delete', 1), ev(1, 'create', 2)], []))
      .toEqual({ ok: true })
  })

  test('GENERATION + DELETE-REUSE: prior generation update@2+delete@2 (reuse), restored then updated → passes', () => {
    // gen1: create@1, update@2, delete@2 (delete REUSES v2). gen2 (current): create@1 (restore), update@2.
    // Proves delete-reuse in the prior generation does not become a false hole/duplicate for the current one.
    expect(checkRecordChainContiguity(2, [
      ev(1, 'create', 0), ev(2, 'update', 1), ev(2, 'delete', 2), ev(1, 'create', 3), ev(2, 'update', 4),
    ], [])).toEqual({ ok: true })
  })

  test('a hole in the CURRENT generation is still caught after a restore', () => {
    // gen2 (current) = create@1 (restore, ok3) then update@3 (ok4) — v2 missing ⇒ hole, live version 3.
    expect(checkRecordChainContiguity(3, [
      ev(1, 'create', 0), ev(1, 'delete', 1), ev(1, 'create', 2), ev(3, 'update', 3),
    ], [])).toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('a live version < 1 is refused defensively', () => {
    expect(checkRecordChainContiguity(0, [ev(1, 'create', 0)], [])).toEqual({ ok: false, reason: 'chain_hole' })
  })
})
