/**
 * W2-A — pure / near-pure contracts for the exact-anchor recovery route-helper draft.
 * Does not mount routes, flip flags, or exercise live DB integration.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  checkExactAnchorRecoveryTrust,
  enforceSheetRecoverySizeCeiling,
  finalizePreviewSuccess,
  httpForPreviewFailure,
  loadLiveByIdForPreview,
  mapApplyRefusal,
  mapHistoryIncompleteRefusal,
  mapParseRefusal,
  mapRecoveryTrustRefusal,
  mapResolveRefusal,
  mapSizeCeilingFailure,
  parseRecoveryAnchorRequest,
  previewExactAnchorRecovery,
  summarizePreviewPlan,
  type PreviewPlanSummary,
} from '../../src/multitable/exact-anchor-recovery-route'
import { ExactAnchorPlanDataError } from '../../src/multitable/exact-anchor-recovery-plan'
import {
  classifyExactAnchorDatabaseConflict,
  type ExactAnchorApplyRefusal,
} from '../../src/multitable/exact-anchor-recovery-execute'
import { composeBaselineOverlay, type ResolveAnchorRefusal } from '../../src/multitable/exact-anchor-recovery'
import type { QueryFn } from '../../src/multitable/permission-service'

const originalFence = process.env.MULTITABLE_ENABLE_WRITER_FENCE
const originalStrict = process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT

afterEach(() => {
  if (originalFence === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
  else process.env.MULTITABLE_ENABLE_WRITER_FENCE = originalFence
  if (originalStrict === undefined) delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
  else process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = originalStrict
  vi.restoreAllMocks()
})

describe('parseRecoveryAnchorRequest — exactly one anchor, no silent prefer', () => {
  test('accepts a single nonblank anchorOperationId', () => {
    expect(
      parseRecoveryAnchorRequest({ anchorOperationId: '  op-1  ' }),
    ).toEqual({
      ok: true,
      request: { kind: 'exact-anchor', anchorOperationId: 'op-1' },
    })
  })

  test('accepts a single nonblank historyBatchId', () => {
    expect(
      parseRecoveryAnchorRequest({ historyBatchId: '  batch-9  ' }),
    ).toEqual({
      ok: true,
      request: { kind: 'history-batch', historyBatchId: 'batch-9' },
    })
  })

  test('rejects BOTH present as validation/ambiguous — never silently prefers one', () => {
    expect(
      parseRecoveryAnchorRequest({
        historyBatchId: 'batch-1',
        anchorOperationId: 'op-1',
      }),
    ).toEqual({ ok: false, reason: 'validation' })
  })

  test('empty body is exact-anchor-required', () => {
    expect(parseRecoveryAnchorRequest({})).toEqual({
      ok: false,
      reason: 'exact-anchor-required',
    })
  })

  test('asOf-only is exact-anchor-required (no wall-clock destructive authority)', () => {
    expect(
      parseRecoveryAnchorRequest({ asOf: '2026-01-01T00:00:00.000Z' }),
    ).toEqual({ ok: false, reason: 'exact-anchor-required' })
  })

  test('whitespace-only anchors are exact-anchor-required', () => {
    expect(
      parseRecoveryAnchorRequest({ historyBatchId: '   ', anchorOperationId: '\t' }),
    ).toEqual({ ok: false, reason: 'exact-anchor-required' })
  })

  test('any nonblank asOf with a co-present exact id is exact-anchor-required (never ignore asOf)', () => {
    expect(
      parseRecoveryAnchorRequest({
        historyBatchId: 'batch-1',
        asOf: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({ ok: false, reason: 'exact-anchor-required' })
    expect(
      parseRecoveryAnchorRequest({
        anchorOperationId: 'op-1',
        asOf: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({ ok: false, reason: 'exact-anchor-required' })
  })

  test('both exact ids still win as validation even when asOf is also present', () => {
    expect(
      parseRecoveryAnchorRequest({
        historyBatchId: 'batch-1',
        anchorOperationId: 'op-1',
        asOf: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({ ok: false, reason: 'validation' })
  })

  test('rejects malformed authority fields instead of silently treating them as absent', () => {
    expect(parseRecoveryAnchorRequest({ anchorOperationId: 'op-1', asOf: 123 })).toEqual({
      ok: false,
      reason: 'invalid-request',
    })
    expect(parseRecoveryAnchorRequest({ anchorOperationId: 'op-1', historyBatchId: false })).toEqual({
      ok: false,
      reason: 'invalid-request',
    })
  })
})

describe('composeBaselineOverlay — corrupt checkpoint rows fail closed', () => {
  const queryWith = (row: Record<string, unknown>): QueryFn =>
    (async () => ({ rows: [row], rowCount: 1 })) as QueryFn

  test.each([
    ['scalar data', { record_id: 'r1', data: 'not-an-object', version: 1, is_trashed: false }],
    ['array data', { record_id: 'r1', data: [], version: 1, is_trashed: false }],
    ['string version', { record_id: 'r1', data: {}, version: '1', is_trashed: false }],
    ['negative version', { record_id: 'r1', data: {}, version: -1, is_trashed: false }],
    ['non-boolean trash marker', { record_id: 'r1', data: {}, version: 1, is_trashed: 'false' }],
    ['missing record id', { record_id: null, data: {}, version: 1, is_trashed: false }],
  ])('%s is rejected instead of coerced into a signed recovery state', async (_name, row) => {
    await expect(composeBaselineOverlay(queryWith(row), {
      sheetId: 'sheet-1',
      checkpointId: 'checkpoint-1',
      stateMap: new Map(),
    })).rejects.toThrow(/checkpoint baseline/)
  })

  test('a replay-exact record wins without consuming its stale baseline payload', async () => {
    const replay = new Map([['r1', { recordId: 'r1', exists: true, data: { value: 'exact' }, version: 2 }]])
    const out = await composeBaselineOverlay(
      queryWith({ record_id: 'r1', data: 'stale-and-irrelevant', version: -1, is_trashed: false }),
      { sheetId: 'sheet-1', checkpointId: 'checkpoint-1', stateMap: replay },
    )
    expect(out).toEqual(replay)
  })
})

describe('summarizePreviewPlan — true restorable fieldIds + values-free summary', () => {
  test('exposes TRUE restorable changedFieldIds via projectRestorableOntoLive (not Object.keys(targetData))', () => {
    const stateMap = new Map([
      [
        'r1',
        {
          recordId: 'r1',
          exists: true,
          // target carries formula + restorable scalar; Object.keys would over-report formula
          data: { s: 'at-anchor', f: 'stale-formula', same: 'x' },
          version: 1,
        },
      ],
    ])
    const liveById = new Map([
      [
        'r1',
        {
          data: { s: 'live', f: 'live-formula', same: 'x' },
          version: 2,
        },
      ],
    ])
    const fieldIds = new Set(['s', 'f', 'same'])
    const summary = summarizePreviewPlan(stateMap, liveById, fieldIds, 'revert', {
      fieldById: new Map([
        ['s', { type: 'string' }],
        ['f', { type: 'formula' }],
        ['same', { type: 'string' }],
      ]),
      rawTypeById: new Map([
        ['s', 'string'],
        ['f', 'formula'],
        ['same', 'string'],
      ]),
    })

    expect(summary.reverts).toEqual([{ recordId: 'r1', fieldIds: ['s'] }])
    expect(summary.reverts[0]!.fieldIds).not.toContain('f')
    expect(summary.reverts[0]!.fieldIds).not.toEqual(Object.keys(stateMap.get('r1')!.data!))
    expect(summary.effectiveWriteCount).toBe(1)
    expect(summary.resurrectIds).toEqual([])
    expect(summary.deleteIds).toEqual([])
    expect(summary.driftCount).toBe(0)
    expect(summary.keptCreatedAfterAnchorCount).toBe(0)
  })

  test('derived-only drift is a no-op and does not count toward effectiveWriteCount', () => {
    const stateMap = new Map([
      [
        'r1',
        {
          recordId: 'r1',
          exists: true,
          data: { f: 'old-formula', s: 'same' },
          version: 1,
        },
      ],
    ])
    const liveById = new Map([
      ['r1', { data: { f: 'new-formula', s: 'same' }, version: 3 }],
    ])
    const summary = summarizePreviewPlan(
      stateMap,
      liveById,
      new Set(['f', 's']),
      'revert',
      {
        fieldById: new Map([
          ['f', { type: 'formula' }],
          ['s', { type: 'string' }],
        ]),
        rawTypeById: new Map([
          ['f', 'formula'],
          ['s', 'string'],
        ]),
      },
    )

    // classify sees data inequality → candidate, but projection is no-op → not counted
    expect(summary.reverts).toEqual([])
    expect(summary.effectiveWriteCount).toBe(0)
  })

  test('excludes mirror-owned link fields from the projection surface (caller passes filtered fieldById)', () => {
    const stateMap = new Map([
      [
        'r1',
        {
          recordId: 'r1',
          exists: true,
          data: { s: 'old', mirrorLk: ['a'] },
          version: 1,
        },
      ],
    ])
    const liveById = new Map([
      ['r1', { data: { s: 'new', mirrorLk: ['b'] }, version: 2 }],
    ])
    // projection surface excludes mirror-owned link (spine invariant) — only 's' is projectable
    const summary = summarizePreviewPlan(
      stateMap,
      liveById,
      new Set(['s', 'mirrorLk']),
      'revert',
      {
        fieldById: new Map([['s', { type: 'string' }]]),
        rawTypeById: new Map([
          ['s', 'string'],
          ['mirrorLk', 'link'],
        ]),
      },
    )
    expect(summary.reverts).toEqual([{ recordId: 'r1', fieldIds: ['s'] }])
    expect(summary.reverts[0]!.fieldIds).not.toContain('mirrorLk')
  })

  test('effectiveWriteCount = non-noop reverts + resurrects + reset deletes; counts stay values-free', () => {
    const stateMap = new Map([
      [
        'r-revert',
        {
          recordId: 'r-revert',
          exists: true,
          data: { s: 'old' },
          version: 1,
        },
      ],
      [
        'r-resurrect',
        {
          recordId: 'r-resurrect',
          exists: true,
          data: { s: 'gone' },
          version: 1,
        },
      ],
      [
        'r-deleted-at-anchor',
        {
          recordId: 'r-deleted-at-anchor',
          exists: false,
          data: null,
          version: 2,
        },
      ],
    ])
    const liveById = new Map([
      ['r-revert', { data: { s: 'live' }, version: 2 }],
      ['r-deleted-at-anchor', { data: { s: 'later' }, version: 4 }],
      ['r-created-after', { data: { s: 'new' }, version: 1 }],
    ])
    const projection = {
      fieldById: new Map([['s', { type: 'string' }]]),
      rawTypeById: new Map([['s', 'string']]),
    }
    const fieldIds = new Set(['s'])

    const revertMode = summarizePreviewPlan(stateMap, liveById, fieldIds, 'revert', projection)
    expect(revertMode.reverts).toHaveLength(1)
    expect(revertMode.resurrectIds).toEqual(['r-resurrect'])
    expect(revertMode.deleteIds).toEqual([])
    // 1 restorable write + 1 resurrect (delete set empty in revert mode)
    expect(revertMode.effectiveWriteCount).toBe(2)
    // Revert keeps created-after + deleted-at-anchor-live-now
    expect(revertMode.keptCreatedAfterAnchorCount).toBe(2)
    expect(revertMode.driftCount).toBe(0)

    const resetMode = summarizePreviewPlan(stateMap, liveById, fieldIds, 'reset', projection)
    expect(resetMode.deleteIds.sort()).toEqual(['r-created-after', 'r-deleted-at-anchor'])
    // 1 restorable write + 1 resurrect + 2 deletes
    expect(resetMode.effectiveWriteCount).toBe(4)
    expect(resetMode.keptCreatedAfterAnchorCount).toBe(0)
  })

  test('summary is values-free: no targetData / live snapshots / raw plan object', () => {
    const stateMap = new Map([
      [
        'r1',
        {
          recordId: 'r1',
          exists: true,
          data: { s: 'secret-at-anchor', private: 'payload' },
          version: 1,
        },
      ],
    ])
    const liveById = new Map([
      ['r1', { data: { s: 'secret-live', private: 'now' }, version: 2 }],
    ])
    const summary = summarizePreviewPlan(stateMap, liveById, new Set(['s', 'private']), 'revert', {
      fieldById: new Map([
        ['s', { type: 'string' }],
        ['private', { type: 'string' }],
      ]),
      rawTypeById: new Map([
        ['s', 'string'],
        ['private', 'string'],
      ]),
    })
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('secret-at-anchor')
    expect(serialized).not.toContain('secret-live')
    expect(serialized).not.toContain('targetData')
    expect(serialized).not.toContain('snapshot')
    // Shape pin: only ids/counts — no raw plan
    expect(summary).not.toHaveProperty('plan')
    expect(Object.keys(summary).sort()).toEqual([
      'deleteIds',
      'driftCount',
      'effectiveWriteCount',
      'keptCreatedAfterAnchorCount',
      'resurrectIds',
      'reverts',
    ].sort())
  })

  test('malformed live substrate surfaces ExactAnchorPlanDataError (caller collapses to recovery-trust-required)', () => {
    const stateMap = new Map([
      [
        'r1',
        {
          recordId: 'r1',
          exists: true,
          data: { s: 'x' },
          version: 1,
        },
      ],
    ])
    // Pass a map that violates the live contract — classify throws ExactAnchorPlanDataError.
    // (loadLiveByIdForPreview refuses this shape earlier; this pins the plan-layer fail-closed.)
    const badLive = new Map([
      ['r1', { data: ['not-an-object'] as unknown as Record<string, unknown>, version: 1 }],
    ])
    expect(() =>
      summarizePreviewPlan(stateMap, badLive, new Set(['s']), 'revert', {
        fieldById: new Map([['s', { type: 'string' }]]),
        rawTypeById: new Map([['s', 'string']]),
      }),
    ).toThrow(ExactAnchorPlanDataError)
  })
})

describe('finalizePreviewSuccess — no doomed/no-op token leak', () => {
  const baseResolved = {
    ok: true as const,
    token: 'jwt-destructive-token-MUST-NOT-LEAK',
    anchorSeq: '42',
    checkpointId: 'cp-1',
    anchorOperationId: '00000000-0000-4000-8000-000000000001',
    mode: 'revert' as const,
    scopeHash: 'scope-abc-internal-only',
    stateMap: new Map(),
  }

  const emptySummary = (): PreviewPlanSummary => ({
    reverts: [],
    resurrectIds: [],
    deleteIds: [],
    effectiveWriteCount: 0,
    keptCreatedAfterAnchorCount: 0,
    driftCount: 0,
  })

  test('executable revert exposes previewIdentity and never returns raw token / scopeHash', () => {
    const summary: PreviewPlanSummary = {
      ...emptySummary(),
      reverts: [{ recordId: 'r1', fieldIds: ['s'] }],
      effectiveWriteCount: 1,
    }
    const out = finalizePreviewSuccess(baseResolved, summary)
    expect(out.ok).toBe(true)
    expect(out.executable).toBe(true)
    expect(out.previewIdentity).toBe('jwt-destructive-token-MUST-NOT-LEAK')
    expect(out).not.toHaveProperty('token')
    expect(out).not.toHaveProperty('resolved')
    expect(out.anchor).not.toHaveProperty('scopeHash')
    expect(JSON.stringify(out)).not.toContain('stateMap')
    expect(JSON.stringify(out)).not.toContain('scope-abc-internal-only')
  })

  test('doomed resurrection plan returns previewIdentity: null (no token value anywhere)', () => {
    const summary: PreviewPlanSummary = {
      ...emptySummary(),
      reverts: [{ recordId: 'r1', fieldIds: ['s'] }],
      resurrectIds: ['r-gone'],
      effectiveWriteCount: 2,
    }
    const out = finalizePreviewSuccess(baseResolved, summary)
    expect(out.executable).toBe(false)
    expect(out.previewIdentity).toBeNull()
    expect(out).not.toHaveProperty('token')
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('jwt-destructive-token-MUST-NOT-LEAK')
    expect(serialized).not.toMatch(/"token"\s*:/)
  })

  test('mixed restorable reverts + schema drift is non-executable (L8 whole-refuses driftCount>0)', () => {
    const summary: PreviewPlanSummary = {
      ...emptySummary(),
      reverts: [{ recordId: 'r1', fieldIds: ['s'] }],
      effectiveWriteCount: 1,
      driftCount: 2,
    }
    const out = finalizePreviewSuccess(baseResolved, summary)
    expect(out.executable).toBe(false)
    expect(out.previewIdentity).toBeNull()
    expect(out.summary.driftCount).toBe(2)
    expect(out.summary.reverts).toHaveLength(1)
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('jwt-destructive-token-MUST-NOT-LEAK')
    expect(serialized).not.toMatch(/"token"\s*:/)
  })

  test('no-op plan (zero restorable writes) returns previewIdentity: null', () => {
    const out = finalizePreviewSuccess(baseResolved, emptySummary())
    expect(out.executable).toBe(false)
    expect(out.previewIdentity).toBeNull()
    expect(JSON.stringify(out)).not.toContain('jwt-destructive-token-MUST-NOT-LEAK')
  })

  test('reset with only deletes is executable and receives the identity', () => {
    const resolved = { ...baseResolved, mode: 'reset' as const }
    const summary: PreviewPlanSummary = {
      ...emptySummary(),
      deleteIds: ['r-created'],
      effectiveWriteCount: 1,
    }
    const out = finalizePreviewSuccess(resolved, summary)
    expect(out.executable).toBe(true)
    expect(out.previewIdentity).toBe('jwt-destructive-token-MUST-NOT-LEAK')
    expect(out.anchor.mode).toBe('reset')
  })
})

describe('enforceSheetRecoverySizeCeiling — fail-closed count, no zero fabrication', () => {
  const mockCount = (c: unknown): QueryFn =>
    (async () => ({ rows: [{ c }], rowCount: 1 })) as QueryFn

  test('well-formed count under ceiling is ok', async () => {
    await expect(
      enforceSheetRecoverySizeCeiling(mockCount(3), 'sheet-1', 10),
    ).resolves.toEqual({ ok: true, recordCount: 3, maxRecords: 10 })
  })

  test('count above ceiling is too-large with the real count', async () => {
    await expect(
      enforceSheetRecoverySizeCeiling(mockCount(12), 'sheet-1', 10),
    ).resolves.toEqual({ ok: false, reason: 'too-large', recordCount: 12, maxRecords: 10 })
  })

  test('malformed / missing / negative counts fail closed as recovery-trust-required (never 0)', async () => {
    for (const bad of [undefined, null, '3', 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = await enforceSheetRecoverySizeCeiling(mockCount(bad), 'sheet-1', 10)
      expect(res).toEqual({ ok: false, reason: 'recovery-trust-required' })
      // Must not invent a zero count that would open the ceiling.
      expect(res).not.toMatchObject({ recordCount: 0 })
      expect(res).not.toMatchObject({ ok: true })
    }
    // Missing row entirely.
    const emptyQuery = (async () => ({ rows: [], rowCount: 0 })) as QueryFn
    expect(await enforceSheetRecoverySizeCeiling(emptyQuery, 'sheet-1', 10)).toEqual({
      ok: false,
      reason: 'recovery-trust-required',
    })
  })

  test('mapSizeCeilingFailure maps malformed to RECOVERY_TRUST_REQUIRED and oversize to 413', () => {
    expect(
      mapSizeCeilingFailure({ ok: false, reason: 'recovery-trust-required' }, 'revert'),
    ).toEqual(mapRecoveryTrustRefusal())
    expect(
      mapSizeCeilingFailure(
        { ok: false, reason: 'too-large', recordCount: 9, maxRecords: 5 },
        'reset',
      ),
    ).toMatchObject({ status: 413, code: 'SHEET_TOO_LARGE' })
  })
})

describe('loadLiveByIdForPreview — fail-closed, no live coercion', () => {
  const mockQuery = (rows: Array<{ id: unknown; data: unknown; version: unknown }>): QueryFn =>
    (async () => ({ rows, rowCount: rows.length })) as QueryFn

  test('well-formed rows load as-is', async () => {
    const res = await loadLiveByIdForPreview(
      mockQuery([{ id: 'r1', data: { s: 1 }, version: 0 }]),
      'sheet-1',
    )
    expect(res).toEqual({
      ok: true,
      liveById: new Map([['r1', { data: { s: 1 }, version: 0 }]]),
    })
  })

  test('array data fails closed as recovery-trust-required (never {})', async () => {
    const res = await loadLiveByIdForPreview(
      mockQuery([{ id: 'r1', data: [1, 2], version: 1 }]),
      'sheet-1',
    )
    expect(res).toEqual({ ok: false, reason: 'recovery-trust-required' })
  })

  test('null / non-object data fails closed', async () => {
    expect(
      await loadLiveByIdForPreview(mockQuery([{ id: 'r1', data: null, version: 1 }]), 's'),
    ).toEqual({ ok: false, reason: 'recovery-trust-required' })
    expect(
      await loadLiveByIdForPreview(mockQuery([{ id: 'r1', data: 'x', version: 1 }]), 's'),
    ).toEqual({ ok: false, reason: 'recovery-trust-required' })
  })

  test('non-safe / negative / non-number versions fail closed (never Number(...)||0)', async () => {
    expect(
      await loadLiveByIdForPreview(mockQuery([{ id: 'r1', data: {}, version: -1 }]), 's'),
    ).toEqual({ ok: false, reason: 'recovery-trust-required' })
    expect(
      await loadLiveByIdForPreview(mockQuery([{ id: 'r1', data: {}, version: 1.5 }]), 's'),
    ).toEqual({ ok: false, reason: 'recovery-trust-required' })
    expect(
      await loadLiveByIdForPreview(mockQuery([{ id: 'r1', data: {}, version: '3' }]), 's'),
    ).toEqual({ ok: false, reason: 'recovery-trust-required' })
    expect(
      await loadLiveByIdForPreview(mockQuery([{ id: 'r1', data: {}, version: Number.NaN }]), 's'),
    ).toEqual({ ok: false, reason: 'recovery-trust-required' })
  })
})

describe('HTTP mapping — every current ExactAnchorApplyRefusal is values-free', () => {
  const ALL_APPLY_REFUSALS: ExactAnchorApplyRefusal[] = [
    'identity-invalid',
    'token-replayed',
    'forbidden',
    'no-covering-checkpoint',
    'checkpoint-changed',
    'preview-drift',
    'schema-drift',
    'inbound-unprovable',
    'link-integrity',
    'value-invalid',
    'record-locked',
    'history-incomplete',
    'recovery-trust-required',
  ]

  test('mapApplyRefusal covers every CURRENT ExactAnchorApplyRefusal including value-invalid', () => {
    for (const reason of ALL_APPLY_REFUSALS) {
      const mapped = mapApplyRefusal(reason)
      expect(mapped.status).toBeGreaterThanOrEqual(400)
      expect(typeof mapped.code).toBe('string')
      expect(mapped.code.length).toBeGreaterThan(0)
      expect(typeof mapped.message).toBe('string')
      // values-free: never echo record/field payloads
      expect(mapped.message).not.toMatch(/\{.*\}/)
    }
    const valueInvalid = mapApplyRefusal('value-invalid')
    expect(valueInvalid.status).toBe(422)
    expect(valueInvalid.code).toBe('VALUE_INVALID')
    expect(valueInvalid.message).toMatch(/invalid under the current schema/i)
    expect(mapApplyRefusal('recovery-trust-required')).toEqual(mapRecoveryTrustRefusal())
    expect(mapApplyRefusal('history-incomplete')).toEqual(mapHistoryIncompleteRefusal())
  })

  test('database deadlock/serialization and live-target FK failures become retryable typed refusals', () => {
    expect(classifyExactAnchorDatabaseConflict({ code: '40P01' })).toBe('preview-drift')
    expect(classifyExactAnchorDatabaseConflict({ code: '40001' })).toBe('preview-drift')
    expect(classifyExactAnchorDatabaseConflict({
      code: '23503',
      constraint: 'meta_links_foreign_record_id_fkey',
    })).toBe('link-integrity')
    expect(classifyExactAnchorDatabaseConflict({ code: '23503', constraint: 'some_other_fk' })).toBeNull()
    expect(classifyExactAnchorDatabaseConflict(new Error('not postgres'))).toBeNull()
  })

  test('mapResolveRefusal covers every ResolveAnchorRefusal', () => {
    const all: ResolveAnchorRefusal[] = [
      'exact-anchor-required',
      'invalid-anchor',
      'unknown-anchor',
      'no-covering-checkpoint',
      'history-incomplete',
      'forbidden',
    ]
    for (const reason of all) {
      const mapped = mapResolveRefusal(reason)
      expect(mapped.status).toBeGreaterThanOrEqual(400)
      expect(mapped.code.length).toBeGreaterThan(0)
    }
  })

  test('mapParseRefusal: ambiguity, malformed fields, and missing exact authority remain distinct', () => {
    const validation = mapParseRefusal('validation')
    expect(validation.status).toBe(400)
    expect(validation.code).toBe('AMBIGUOUS_ANCHOR')
    expect(validation.message).toMatch(/exactly one/i)
    expect(mapParseRefusal('invalid-request').code).toBe('VALIDATION_ERROR')
    expect(mapParseRefusal('exact-anchor-required').code).toBe('EXACT_ANCHOR_REQUIRED')
  })

  test('httpForPreviewFailure distinguishes history-incomplete from missing trust and maps sizes too-large', () => {
    const trust = httpForPreviewFailure({ ok: false, reason: 'recovery-trust-required' }, 'revert')
    expect(trust).toEqual(mapRecoveryTrustRefusal())
    expect(trust.message).not.toMatch(/requires both MULTITABLE_ENABLE_WRITER_FENCE/i)
    expect(trust.message).toMatch(/active checkpoint/i)
    expect(
      httpForPreviewFailure({ ok: false, reason: 'history-incomplete' }, 'revert'),
    ).toEqual(mapHistoryIncompleteRefusal())
    expect(
      httpForPreviewFailure(
        { ok: false, reason: 'too-large', recordCount: 9, maxRecords: 5 },
        'reset',
      ),
    ).toMatchObject({ status: 413, code: 'SHEET_TOO_LARGE' })
    expect(
      httpForPreviewFailure({ ok: false, reason: 'forbidden' }, 'revert'),
    ).toEqual(mapResolveRefusal('forbidden'))
  })
})

describe('previewExactAnchorRecovery — no-oracle ordering + structural guards (near-pure)', () => {
  test('unauthorized full-read sees forbidden before trust/history/anchor DB work', async () => {
    const calls: string[] = []
    const query: QueryFn = async (sql: string) => {
      calls.push(String(sql))
      throw new Error(`unexpected DB access: ${sql}`)
    }
    const result = await previewExactAnchorRecovery(query, {
      sheetId: 'sheet-1',
      request: { kind: 'exact-anchor', anchorOperationId: '00000000-0000-4000-8000-000000000001' },
      actorId: 'actor-1',
      mode: 'revert',
      evaluateFullReadAccess: async () => {
        calls.push('full-read')
        return false
      },
      evaluatePlanAuthorization: async () => true,
    })
    expect(result).toEqual({ ok: false, reason: 'forbidden' })
    expect(calls).toEqual(['full-read'])
  })

  test('wall-clock request refuses exact-anchor-required with zero DB and without full-read', async () => {
    let fullReadCalled = false
    const query: QueryFn = async () => {
      throw new Error('DB must not be touched')
    }
    const result = await previewExactAnchorRecovery(query, {
      sheetId: 'sheet-1',
      request: { kind: 'wall-clock', asOf: '2026-01-01T00:00:00.000Z' },
      actorId: 'actor-1',
      mode: 'revert',
      evaluateFullReadAccess: async () => {
        fullReadCalled = true
        return true
      },
      evaluatePlanAuthorization: async () => true,
    })
    expect(result).toEqual({ ok: false, reason: 'exact-anchor-required' })
    expect(fullReadCalled).toBe(false)
  })

  test('after full-read, missing trust substrate refuses recovery-trust-required before history SQL', async () => {
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
    expect(checkExactAnchorRecoveryTrust()).toEqual({
      ok: false,
      reason: 'recovery-trust-required',
    })

    const calls: string[] = []
    const query: QueryFn = async (sql: string) => {
      calls.push(String(sql))
      throw new Error(`unexpected DB access: ${sql}`)
    }
    const result = await previewExactAnchorRecovery(query, {
      sheetId: 'sheet-1',
      request: { kind: 'history-batch', historyBatchId: 'batch-1' },
      actorId: 'actor-1',
      mode: 'reset',
      evaluateFullReadAccess: async () => {
        calls.push('full-read')
        return true
      },
      evaluatePlanAuthorization: async () => true,
    })
    expect(result).toEqual({ ok: false, reason: 'recovery-trust-required' })
    expect(calls).toEqual(['full-read'])
  })

  test('structural: preview and execute call the production precheck, never the strict test seam', () => {
    // Production path MUST go through the authoritative entry so checkStrictEnablementPrecondition
    // (RECONSTRUCTION_CAUSALITY_LANDED + active checkpoint) is not bypassed.
    const routePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../src/multitable/exact-anchor-recovery-route.ts',
    )
    const executePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../src/multitable/exact-anchor-recovery-execute.ts',
    )
    const src = `${readFileSync(routePath, 'utf8')}\n${readFileSync(executePath, 'utf8')}`
    // Strip block + line comments so a mention in a "do not call Strict" note does not false-green.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(stripped).toMatch(/\bprecheckSheetHistoryIntegrity\b/)
    expect(stripped).not.toMatch(/\bprecheckSheetHistoryIntegrityStrict\b/)
    // Import surface pin: production entry is imported; Strict is not.
    expect(stripped).toMatch(/import\s*\{[^}]*\bprecheckSheetHistoryIntegrity\b[^}]*\}\s*from\s*'\.\/history-integrity-precheck'/)
  })
})
