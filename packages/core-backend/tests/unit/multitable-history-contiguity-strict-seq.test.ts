/**
 * W0-1 v3.5 (design lock #4262 §2) — `checkRecordChainContiguityStrict`, the PURE, seq-ordered,
 * generation-by-count core behind `MULTITABLE_HISTORY_CONTIGUITY_STRICT`. Unit-level, no DB, mirrors
 * `multitable-history-contiguity.test.ts` (the legacy epoch-ordered comparator's own pure-core suite) so
 * both comparators are pinned deterministically. The DB goldens
 * (multitable-history-contiguity-strict-seq-realdb.test.ts) exercise the same logic end-to-end + C3.
 *
 * `seq` here is a small monotonically increasing integer standing in for the real `meta_record_chain_seq`
 * sequence value — the pure function only cares about relative order, never magnitude.
 */
import { describe, expect, test } from 'vitest'

import { checkRecordChainContiguityStrict, type ChainEvent, type VersionMarker } from '../../src/multitable/history-integrity-precheck'

const ev = (version: number, action: ChainEvent['action'], seq: number): ChainEvent => ({ version, action, seq })
const mk = (version: number, kind: VersionMarker['kind'], seq: number): VersionMarker => ({ version, kind, seq })

describe('W0-1 v3.5 checkRecordChainContiguityStrict — seq-ordered, generation-by-count', () => {
  test('healthy single-generation chain passes (positive control)', () => {
    expect(checkRecordChainContiguityStrict(2, [ev(1, 'create', 1), ev(2, 'update', 2)], [])).toEqual({ ok: true })
  })

  test('HEALED-GAP: v3 record with revisions {v1, v3} (v2 uncaptured) → chain_hole', () => {
    expect(checkRecordChainContiguityStrict(3, [ev(1, 'create', 1), ev(3, 'update', 2)], [])).toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('the v2 hole HEALED by a lock marker → passes', () => {
    expect(checkRecordChainContiguityStrict(3, [ev(1, 'create', 1), ev(3, 'update', 3)], [mk(2, 'lock', 2)])).toEqual({ ok: true })
  })

  test('healthy record locked then unlocked (two markers fill v2 + v3) → passes', () => {
    expect(checkRecordChainContiguityStrict(3, [ev(1, 'create', 1)], [mk(2, 'lock', 2), mk(3, 'unlock', 3)])).toEqual({ ok: true })
  })

  test('zero-revision live row (uncaptured CREATE fingerprint) → zero_revision_live_row', () => {
    expect(checkRecordChainContiguityStrict(1, [], [])).toEqual({ ok: false, reason: 'zero_revision_live_row' })
  })

  test('WITHIN-GENERATION DUPLICATE occupant → chain_corrupt (NOT the legacy duplicate_version_event)', () => {
    // §2: the marker unique-key replacement — a duplicate occupant at one version, same generation.
    expect(checkRecordChainContiguityStrict(2, [ev(1, 'create', 1), ev(2, 'update', 2), ev(2, 'update', 3)], []))
      .toEqual({ ok: false, reason: 'chain_corrupt' })
  })

  test('a duplicate MARKER at the same version as a content event (same generation) → chain_corrupt', () => {
    expect(checkRecordChainContiguityStrict(2, [ev(1, 'create', 1)], [mk(2, 'lock', 2), mk(2, 'lock', 3)]))
      .toEqual({ ok: false, reason: 'chain_corrupt' })
  })

  test('an event beyond the live version → out_of_range_version', () => {
    expect(checkRecordChainContiguityStrict(2, [ev(1, 'create', 1), ev(2, 'update', 2), ev(3, 'update', 3)], []))
      .toEqual({ ok: false, reason: 'out_of_range_version' })
  })

  test('a marker beyond the live version → out_of_range_version', () => {
    expect(checkRecordChainContiguityStrict(1, [ev(1, 'create', 1)], [mk(2, 'lock', 2)]))
      .toEqual({ ok: false, reason: 'out_of_range_version' })
  })

  test('live row whose latest event is a DELETE (uncaptured resurrection) → live_row_after_delete_revision', () => {
    expect(checkRecordChainContiguityStrict(1, [ev(1, 'create', 1), ev(1, 'delete', 2)], []))
      .toEqual({ ok: false, reason: 'live_row_after_delete_revision' })
  })

  test('GENERATION (by count): a trash-restored record (create/delete/create) → passes on its CURRENT generation', () => {
    // gen1: create@1 (seq1). delete@1 reuse (seq2) closes gen1. gen2: create@1 (seq3, restore) — current.
    expect(checkRecordChainContiguityStrict(1, [ev(1, 'create', 1), ev(1, 'delete', 2), ev(1, 'create', 3)], []))
      .toEqual({ ok: true })
  })

  test('GENERATION + DELETE-REUSE: prior generation update@2+delete@2 (reuse), restored then updated → passes', () => {
    // gen1: create@1(seq1), update@2(seq2), delete@2 reuse(seq3). gen2 (current): create@1(seq4), update@2(seq5).
    expect(checkRecordChainContiguityStrict(2, [
      ev(1, 'create', 1), ev(2, 'update', 2), ev(2, 'delete', 3), ev(1, 'create', 4), ev(2, 'update', 5),
    ], [])).toEqual({ ok: true })
  })

  test('a hole in the CURRENT generation is still caught after a restore', () => {
    // gen2 (current) = create@1(seq3) then update@3(seq4) — v2 missing ⇒ hole, live version 3.
    expect(checkRecordChainContiguityStrict(3, [
      ev(1, 'create', 1), ev(1, 'delete', 2), ev(1, 'create', 3), ev(3, 'update', 4),
    ], [])).toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('a live version < 1 is refused defensively', () => {
    expect(checkRecordChainContiguityStrict(0, [ev(1, 'create', 1)], [])).toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('missing seq on an event (caller bug / pre-migration deploy window) → comparator_error, fail-closed', () => {
    expect(checkRecordChainContiguityStrict(1, [{ version: 1, action: 'create' }], [])).toEqual({ ok: false, reason: 'comparator_error' })
  })

  test('missing seq on a marker → comparator_error, fail-closed', () => {
    expect(checkRecordChainContiguityStrict(1, [ev(1, 'create', 1)], [{ version: 2, kind: 'lock' }])).toEqual({ ok: false, reason: 'comparator_error' })
  })

  // ── C2 MONOTONICITY (fail-closed, corrects #4269's fail-open) ────────────────────────────────────────────
  test('C2: seq order and version order AGREE (normal churn) → passes', () => {
    expect(checkRecordChainContiguityStrict(3, [ev(1, 'create', 1), ev(2, 'update', 2), ev(3, 'update', 3)], []))
      .toEqual({ ok: true })
  })

  test('C2 TIME-REVERSAL: seq order says v3-then-v2 (version went BACKWARD as seq advanced) → nonmonotonic_history', () => {
    // No hole, no duplicate (versions {1,2,3} each occupied exactly once) — a version/count-only check would
    // PASS this. Only a true seq-vs-version order check catches it.
    expect(checkRecordChainContiguityStrict(3, [ev(1, 'create', 1), ev(3, 'update', 2), ev(2, 'update', 3)], []))
      .toEqual({ ok: false, reason: 'nonmonotonic_history' })
  })

  test('C2: a marker participates in the monotonicity check too (marker seq precedes a lower-version event)', () => {
    expect(checkRecordChainContiguityStrict(3, [ev(1, 'create', 1), ev(3, 'update', 3)], [mk(2, 'lock', 4)]))
      // marker@v2 arrives (seq4) AFTER update@v3 (seq3) — version went backward (3 → 2) ⇒ nonmonotonic.
      .toEqual({ ok: false, reason: 'nonmonotonic_history' })
  })

  test('C2: the TERMINAL delete reusing the prior version is EXEMPT from monotonicity (not a false reversal)', () => {
    // Deleted-record scope (liveVersion=null): create@1(seq1), update@2(seq2), delete@2 reuse(seq3) — the
    // delete's version (2) does not "decrease" relative to update@2; it legitimately reuses it.
    expect(checkRecordChainContiguityStrict(null, [ev(1, 'create', 1), ev(2, 'update', 2), ev(2, 'delete', 3)], []))
      .toEqual({ ok: true })
  })

  // ── DELETED-RECORD SCOPE (liveVersion === null) — the C3 caller's shape ──────────────────────────────────
  test('DELETED SCOPE: a clean single-generation deleted chain passes (positive control for C3)', () => {
    expect(checkRecordChainContiguityStrict(null, [ev(1, 'create', 1), ev(2, 'update', 2), ev(2, 'delete', 3)], []))
      .toEqual({ ok: true })
  })

  test('DELETED SCOPE: a mid-generation gap in the deleted chain → chain_hole (C3 negative control)', () => {
    // create@1(seq1) ... update@3(seq2, v2 missing) ... delete@3 reuse(seq3).
    expect(checkRecordChainContiguityStrict(null, [ev(1, 'create', 1), ev(3, 'update', 2), ev(3, 'delete', 3)], []))
      .toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('DELETED SCOPE: only the TERMINAL generation is checked — an older, already-superseded generation is not', () => {
    // gen1 (older, has a gap: create@1, update@3 [v2 missing], delete@3) → gen2 (terminal, clean: create@1,
    // update@2, delete@2). Only gen2 governs; gen1's gap is out of scope (symmetric with the live-record model).
    expect(checkRecordChainContiguityStrict(null, [
      ev(1, 'create', 1), ev(3, 'update', 2), ev(3, 'delete', 3),
      ev(1, 'create', 4), ev(2, 'update', 5), ev(2, 'delete', 6),
    ], [])).toEqual({ ok: true })
  })
})
