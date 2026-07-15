/**
 * W0-1 v3.7 (owner-ratified #4331 §9, docs/development/multitable-w0-1-v37-exact-anchor-trust-design-lock-
 * 20260715.md) — `checkAllGenerationsContiguity`, the PURE, seq-ordered, ALL-GENERATIONS core behind
 * `MULTITABLE_HISTORY_CONTIGUITY_STRICT`. Unit-level, no DB, mirrors `multitable-history-contiguity.test.ts`
 * (the legacy epoch-ordered comparator's own pure-core suite) so both comparators are pinned
 * deterministically. The DB goldens (`multitable-history-contiguity-strict-seq-realdb.test.ts`) exercise the
 * same logic end-to-end + C3 + the HTTP surface.
 *
 * `seq` is the EXACT decimal-string value of the shared `meta_record_chain_seq` bigint column — NEVER a
 * `number`. Small integer strings ('1', '2', ...) stand in for real sequence values in most tests below; the
 * EXACT-BIGINT section proves the comparator stays exact at real int8 magnitudes too (values > 2^53, where
 * `Number(...)` silently collapses distinct decimal strings to the same float64 — see that section for the
 * JS-native proof).
 */
import { describe, expect, test } from 'vitest'

import {
  checkAllGenerationsContiguity,
  type StrictScope,
  type StrictTimelineItem,
} from '../../src/multitable/history-integrity-precheck'

const ev = (version: number, action: 'create' | 'update' | 'delete', seq: string): StrictTimelineItem => ({ kind: 'event', version, action, seq })
const mk = (version: number, seq: string): StrictTimelineItem => ({ kind: 'marker', version, seq })
const live = (liveVersion: number): StrictScope => ({ kind: 'live', liveVersion })
const deleted: StrictScope = { kind: 'deleted' }

describe('W0-1 v3.7 checkAllGenerationsContiguity — seq-ordered, ALL generations (not terminal-only)', () => {
  test('healthy single-generation chain passes (positive control)', () => {
    expect(checkAllGenerationsContiguity(live(2), [ev(1, 'create', '1'), ev(2, 'update', '2')])).toEqual({ ok: true })
  })

  test('HEALED-GAP: v3 record with revisions {v1, v3} (v2 uncaptured) → chain_hole', () => {
    expect(checkAllGenerationsContiguity(live(3), [ev(1, 'create', '1'), ev(3, 'update', '2')])).toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('the v2 hole HEALED by a lock marker → passes', () => {
    expect(checkAllGenerationsContiguity(live(3), [ev(1, 'create', '1'), mk(2, '2'), ev(3, 'update', '3')])).toEqual({ ok: true })
  })

  test('healthy record locked then unlocked (two markers fill v2 + v3) → passes', () => {
    expect(checkAllGenerationsContiguity(live(3), [ev(1, 'create', '1'), mk(2, '2'), mk(3, '3')])).toEqual({ ok: true })
  })

  test('zero-revision live row (uncaptured CREATE fingerprint) → zero_revision_live_row', () => {
    expect(checkAllGenerationsContiguity(live(1), [])).toEqual({ ok: false, reason: 'zero_revision_live_row' })
  })

  test('WITHIN-GENERATION DUPLICATE occupant (two updates at one version) → chain_corrupt', () => {
    expect(checkAllGenerationsContiguity(live(2), [ev(1, 'create', '1'), ev(2, 'update', '2'), ev(2, 'update', '3')]))
      .toEqual({ ok: false, reason: 'chain_corrupt' })
  })

  test('a duplicate MARKER at the same version as another marker (same generation) → chain_corrupt', () => {
    expect(checkAllGenerationsContiguity(live(2), [ev(1, 'create', '1'), mk(2, '2'), mk(2, '3')]))
      .toEqual({ ok: false, reason: 'chain_corrupt' })
  })

  test('an event beyond the live version → out_of_range_version', () => {
    expect(checkAllGenerationsContiguity(live(2), [ev(1, 'create', '1'), ev(2, 'update', '2'), ev(3, 'update', '3')]))
      .toEqual({ ok: false, reason: 'out_of_range_version' })
  })

  test('a marker beyond the live version → out_of_range_version', () => {
    expect(checkAllGenerationsContiguity(live(1), [ev(1, 'create', '1'), mk(2, '2')])).toEqual({ ok: false, reason: 'out_of_range_version' })
  })

  test('live row whose latest event is a DELETE (uncaptured resurrection) → live_row_after_delete_revision', () => {
    expect(checkAllGenerationsContiguity(live(1), [ev(1, 'create', '1'), ev(1, 'delete', '2')]))
      .toEqual({ ok: false, reason: 'live_row_after_delete_revision' })
  })

  // ── GENERATION-2-LOCK-SURVIVES (multi-generation, marker in a NON-first generation) ─────────────────────
  test('GENERATION-2-LOCK-SURVIVES: gen1 clean (create+delete), gen2 = create + lock marker filling v2 → passes', () => {
    // gen1: create@1(seq1), delete@1 reuse(seq2). gen2 (terminal, live=2): create@1(seq3), lock-marker@2(seq4).
    expect(checkAllGenerationsContiguity(live(2), [
      ev(1, 'create', '1'), ev(1, 'delete', '2'), ev(1, 'create', '3'), mk(2, '4'),
    ])).toEqual({ ok: true })
  })

  // ── THE v3.7 CORRECTION: ALL generations validated, not terminal-only ────────────────────────────────────
  test('TARGET-GENERATION HOLE, CLEAN TERMINAL: a hole in an OLDER generation refuses even though the terminal generation is completely clean (owner High-2 — "terminal-generation-only validation is forbidden")', () => {
    // gen1 (older): create@1(seq1), update@3(seq2) [v2 MISSING], delete@3 reuse(seq3).
    // gen2 (terminal, live=2): create@1(seq4), update@2(seq5) — clean.
    // A terminal-only comparator (the superseded v3.5 shape) would PASS this (gen2 alone is healthy); the
    // v3.7 all-generations walk refuses on gen1's hole regardless.
    expect(checkAllGenerationsContiguity(live(2), [
      ev(1, 'create', '1'), ev(3, 'update', '2'), ev(3, 'delete', '3'),
      ev(1, 'create', '4'), ev(2, 'update', '5'),
    ])).toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('a hole in the CURRENT (terminal) generation is still caught after a restore', () => {
    // gen2 (terminal) = create@1(seq3) then update@3(seq4) — v2 missing ⇒ hole, live version 3.
    expect(checkAllGenerationsContiguity(live(3), [
      ev(1, 'create', '1'), ev(1, 'delete', '2'), ev(1, 'create', '3'), ev(3, 'update', '4'),
    ])).toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('a live version < 1 is refused defensively', () => {
    expect(checkAllGenerationsContiguity(live(0), [ev(1, 'create', '1')])).toEqual({ ok: false, reason: 'out_of_range_version' })
  })

  // ── ILLEGAL/MALFORMED SEQ FAIL-CLOSE (§9.3 scope item 6) ─────────────────────────────────────────────────
  test('illegal seq "0" (non-positive) → comparator_error, fail-closed', () => {
    expect(checkAllGenerationsContiguity(live(1), [ev(1, 'create', '0')])).toEqual({ ok: false, reason: 'comparator_error' })
  })

  test('illegal seq "-5" (negative) → comparator_error, fail-closed', () => {
    expect(checkAllGenerationsContiguity(live(1), [ev(1, 'create', '-5')])).toEqual({ ok: false, reason: 'comparator_error' })
  })

  test('illegal seq "abc" (non-numeric) → comparator_error, fail-closed', () => {
    expect(checkAllGenerationsContiguity(live(1), [ev(1, 'create', 'abc')])).toEqual({ ok: false, reason: 'comparator_error' })
  })

  test('illegal seq "01" (leading zero) → comparator_error, fail-closed', () => {
    expect(checkAllGenerationsContiguity(live(1), [ev(1, 'create', '01')])).toEqual({ ok: false, reason: 'comparator_error' })
  })

  test('a duplicate seq value shared by two items (shared-sequence-domain violation) → comparator_error', () => {
    expect(checkAllGenerationsContiguity(live(2), [ev(1, 'create', '1'), ev(2, 'update', '2'), mk(2, '2')]))
      .toEqual({ ok: false, reason: 'comparator_error' })
  })

  test('seq regression (caller passed items out of ascending order) → comparator_error, fail-closed', () => {
    expect(checkAllGenerationsContiguity(live(2), [ev(1, 'create', '2'), ev(2, 'update', '1')]))
      .toEqual({ ok: false, reason: 'comparator_error' })
  })

  // ── DELETED-RECORD SCOPE (C3) ─────────────────────────────────────────────────────────────────────────────
  test('DELETED SCOPE: a clean single-generation deleted chain passes (positive control for C3)', () => {
    expect(checkAllGenerationsContiguity(deleted, [ev(1, 'create', '1'), ev(2, 'update', '2'), ev(2, 'delete', '3')])).toEqual({ ok: true })
  })

  test('DELETED SCOPE: a mid-generation gap in the deleted chain → chain_hole (C3 negative control)', () => {
    // create@1(seq1) ... update@3(seq2, v2 missing) ... delete@3 reuse(seq3).
    expect(checkAllGenerationsContiguity(deleted, [ev(1, 'create', '1'), ev(3, 'update', '2'), ev(3, 'delete', '3')]))
      .toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('DELETED SCOPE + v3.7 correction: an OLDER generation gap refuses even though the TERMINAL (most recent) generation is clean', () => {
    // gen1 (older, has a gap): create@1(seq1), update@3(seq2) [v2 missing], delete@3(seq3).
    // gen2 (terminal, clean): create@1(seq4), update@2(seq5), delete@2 reuse(seq6).
    // The superseded v3.5 draft checked ONLY the terminal generation here and would PASS; v3.7 refuses.
    expect(checkAllGenerationsContiguity(deleted, [
      ev(1, 'create', '1'), ev(3, 'update', '2'), ev(3, 'delete', '3'),
      ev(1, 'create', '4'), ev(2, 'update', '5'), ev(2, 'delete', '6'),
    ])).toEqual({ ok: false, reason: 'chain_hole' })
  })

  test('DELETED SCOPE: a live record (scope=deleted called in error) whose chain does not end in a delete → chain_hole', () => {
    expect(checkAllGenerationsContiguity(deleted, [ev(1, 'create', '1'), ev(2, 'update', '2')])).toEqual({ ok: false, reason: 'chain_hole' })
  })

  // ── EXACT BIGINT (§9.7 — 2^53 boundary; production-magnitude, never Number()/subtraction) ────────────────
  describe('EXACT BIGINT: values above 2^53 (float64 loses precision at this magnitude)', () => {
    const TWO_POW_53 = '9007199254740992' // 2^53 — exactly representable in float64
    const TWO_POW_53_PLUS_1 = '9007199254740993' // 2^53 + 1 — NOT exactly representable

    test('sanity: JS Number() actually collapses these two distinct decimal strings to the same float64', () => {
      // This is the well-known float64 precision-loss gotcha the whole exact-bigint requirement guards
      // against: two DIFFERENT bigint values become INDISTINGUISHABLE once coerced through Number().
      expect(Number(TWO_POW_53) === Number(TWO_POW_53_PLUS_1)).toBe(true)
      // BigInt is exact — the same two strings are NOT equal as arbitrary-precision integers.
      expect(BigInt(TWO_POW_53) === BigInt(TWO_POW_53_PLUS_1)).toBe(false)
    })

    test('two distinct occupant seqs straddling 2^53 are NOT treated as a duplicate/collision — healthy chain passes', () => {
      // create@1 (low seq) → update@2 (seq = 2^53) → update@3 (seq = 2^53+1). A Number()-based duplicate/
      // ordering check would see the last two seqs as EQUAL and wrongly refuse this healthy chain
      // (comparator_error) — the exact BigInt-based implementation must NOT.
      expect(checkAllGenerationsContiguity(live(3), [
        ev(1, 'create', '1000'), ev(2, 'update', TWO_POW_53), ev(3, 'update', TWO_POW_53_PLUS_1),
      ])).toEqual({ ok: true })
    })

    test('near int8 max: two adjacent seqs at the extreme end of bigint range remain distinct and correctly ordered', () => {
      const NEAR_INT8_MAX_A = '9223372036854775806' // int8 max (9223372036854775807) minus 1
      const NEAR_INT8_MAX_B = '9223372036854775807' // int8 max
      expect(checkAllGenerationsContiguity(live(2), [
        ev(1, 'create', NEAR_INT8_MAX_A), ev(2, 'update', NEAR_INT8_MAX_B),
      ])).toEqual({ ok: true })
    })
  })
})
