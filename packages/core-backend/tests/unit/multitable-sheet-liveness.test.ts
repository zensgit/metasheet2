/**
 * Sheet liveness — the primitive that soft delete made necessary.
 *
 * The hard delete was safe BY CONSTRUCTION: the row was gone, so a path that addressed records by
 * `sheet_id` and never joined `meta_sheets` still found nothing. Soft delete removed that guarantee.
 * This file pins the primitive; the route-level and service-level applications of it are pinned in
 * tests/unit/multitable-display-rename-authority.test.ts (§8) and
 * tests/unit/multitable-sheet-liveness-closure.guard.test.ts (the closed-world sweep).
 */
import { describe, expect, it, vi } from 'vitest'

import {
  SHEET_DELETED_CODE,
  SHEET_DELETED_MESSAGE,
  SheetNotLiveError,
  assertSheetLive,
  isSheetLive,
  loadSheetLiveness,
} from '../../src/multitable/sheet-liveness'

const SHEET = 'sheet_live_1'

/** `rows` models exactly what `SELECT deleted_at FROM meta_sheets WHERE id = $1` would return. */
function queryReturning(rows: unknown[]) {
  return vi.fn(async () => ({ rows }))
}

describe('loadSheetLiveness — three outcomes, not two', () => {
  it('a row with deleted_at NULL is live', async () => {
    expect(await loadSheetLiveness(queryReturning([{ deleted_at: null }]), SHEET)).toBe('live')
  })

  it('a row with a deleted_at timestamp is deleted', async () => {
    expect(await loadSheetLiveness(queryReturning([{ deleted_at: '2026-08-31T00:00:00.000Z' }]), SHEET)).toBe('deleted')
  })

  it('a Date deleted_at (what node-postgres actually returns for timestamptz) is deleted', async () => {
    expect(await loadSheetLiveness(queryReturning([{ deleted_at: new Date() }]), SHEET)).toBe('deleted')
  })

  it('no row at all is absent', async () => {
    expect(await loadSheetLiveness(queryReturning([]), SHEET)).toBe('absent')
  })

  it('an empty or non-string id is absent WITHOUT querying — no id, no lookup', async () => {
    const query = queryReturning([{ deleted_at: null }])
    expect(await loadSheetLiveness(query, '')).toBe('absent')
    expect(await loadSheetLiveness(query, undefined as unknown as string)).toBe('absent')
    expect(query).not.toHaveBeenCalled()
  })

  it('reads deleted_at rather than filtering on it, so deleted and absent stay distinguishable', async () => {
    const query = queryReturning([{ deleted_at: null }])
    await loadSheetLiveness(query, SHEET)
    const [sql, params] = query.mock.calls[0]! as unknown as [string, unknown[]]
    expect(sql).toContain('deleted_at')
    // A `WHERE deleted_at IS NULL` here would collapse the two outcomes and lose the actionable half.
    expect(sql).not.toContain('IS NULL')
    expect(params).toEqual([SHEET])
  })
})

describe('assertSheetLive — the refusal', () => {
  it('returns quietly for a live sheet', async () => {
    await expect(assertSheetLive(queryReturning([{ deleted_at: null }]), SHEET)).resolves.toBeUndefined()
  })

  it('throws SHEET_DELETED for a soft-deleted sheet, naming the restore route', async () => {
    const err = await assertSheetLive(queryReturning([{ deleted_at: new Date() }]), SHEET).catch((e) => e)
    expect(err).toBeInstanceOf(SheetNotLiveError)
    expect(err.code).toBe(SHEET_DELETED_CODE)
    expect(err.liveness).toBe('deleted')
    expect(err.sheetId).toBe(SHEET)
    expect(err.message).toBe(SHEET_DELETED_MESSAGE)
    // Actionable: it says how to get the sheet back, not merely that it is gone.
    expect(err.message).toContain('/restore')
  })

  it('throws NOT_FOUND for an absent sheet — "restore it" is nonsense for a sheet that never existed', async () => {
    const err = await assertSheetLive(queryReturning([]), SHEET).catch((e) => e)
    expect(err).toBeInstanceOf(SheetNotLiveError)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.liveness).toBe('absent')
    expect(err.message).not.toContain('/restore')
  })

  it('the two refusals are DIFFERENT codes — collapsing them would lose the actionable one', async () => {
    const deleted = await assertSheetLive(queryReturning([{ deleted_at: new Date() }]), SHEET).catch((e) => e)
    const absent = await assertSheetLive(queryReturning([]), SHEET).catch((e) => e)
    expect(deleted.code).not.toBe(absent.code)
  })
})

describe('isSheetLive', () => {
  it('is true only for live', async () => {
    expect(await isSheetLive(queryReturning([{ deleted_at: null }]), SHEET)).toBe(true)
    expect(await isSheetLive(queryReturning([{ deleted_at: new Date() }]), SHEET)).toBe(false)
    expect(await isSheetLive(queryReturning([]), SHEET)).toBe(false)
  })
})
