/**
 * 4c-2 forward tombstone-capture — shared helper unit tests (no DB). Covers the pure
 * flag/cap-resolution logic and exercises the RESERVED lossy-retype capture seam
 * (`captureLossyRetypePreImageRows`) so it is a tested, not a dead, helper even though no
 * route wires it in this PR (4c-1 will).
 */
import { describe, expect, test, vi } from 'vitest'

import {
  assertWithinCaptureCap,
  captureLossyRetypePreImageRows,
  isTombstoneCaptureEnabled,
  resolveTombstoneCaptureMaxRows,
  TOMBSTONE_CAPTURE_DEFAULT_MAX_ROWS,
  TombstoneCaptureCapExceededError,
  type TombstoneQueryFn,
} from '../../src/multitable/tombstone-capture'

describe('tombstone-capture: flag + cap resolution', () => {
  test('capture is disabled unless the flag is EXACTLY "true"', () => {
    expect(isTombstoneCaptureEnabled({})).toBe(false)
    expect(isTombstoneCaptureEnabled({ MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: '1' })).toBe(false)
    expect(isTombstoneCaptureEnabled({ MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'TRUE' })).toBe(false)
    expect(isTombstoneCaptureEnabled({ MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'true' })).toBe(true)
  })

  test('cap defaults to 50000 and falls back on invalid/non-positive values', () => {
    expect(resolveTombstoneCaptureMaxRows({})).toBe(TOMBSTONE_CAPTURE_DEFAULT_MAX_ROWS)
    expect(resolveTombstoneCaptureMaxRows({ MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS: '0' })).toBe(TOMBSTONE_CAPTURE_DEFAULT_MAX_ROWS)
    expect(resolveTombstoneCaptureMaxRows({ MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS: '-5' })).toBe(TOMBSTONE_CAPTURE_DEFAULT_MAX_ROWS)
    expect(resolveTombstoneCaptureMaxRows({ MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS: 'not-a-number' })).toBe(TOMBSTONE_CAPTURE_DEFAULT_MAX_ROWS)
    expect(resolveTombstoneCaptureMaxRows({ MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS: '123' })).toBe(123)
    expect(resolveTombstoneCaptureMaxRows({ MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS: '123.9' })).toBe(123) // floored
  })

  test('assertWithinCaptureCap: no-op at/under the cap, throws TombstoneCaptureCapExceededError over it', () => {
    expect(() => assertWithinCaptureCap(50, { MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS: '50' })).not.toThrow()
    expect(() => assertWithinCaptureCap(51, { MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS: '50' })).toThrow(TombstoneCaptureCapExceededError)
    try {
      assertWithinCaptureCap(51, { MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS: '50' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TombstoneCaptureCapExceededError)
      const capErr = err as TombstoneCaptureCapExceededError
      expect(capErr.totalRows).toBe(51)
      expect(capErr.cap).toBe(50)
      expect(capErr.message).toMatch(/51/)
      expect(capErr.message).toMatch(/50/)
    }
  })
})

describe('tombstone-capture: reserved lossy-retype pre-image seam (NOT wired to any route in this PR)', () => {
  test('no-ops on an empty row set — never issues a query', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 })) as unknown as TombstoneQueryFn
    await captureLossyRetypePreImageRows(query, [], { sheetId: 's1', fieldId: 'f1', configRevisionId: 'rev1' })
    expect(query).not.toHaveBeenCalled()
  })

  test('batches ALL rows into ONE INSERT via jsonb_to_recordset — never a per-row round trip', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const query = (async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] })
      return { rows: [], rowCount: 2 }
    }) as unknown as TombstoneQueryFn

    await captureLossyRetypePreImageRows(
      query,
      [
        { recordId: 'r1', value: 'old-string-value' },
        { recordId: 'r2', value: null },
      ],
      { sheetId: 's1', fieldId: 'f1', configRevisionId: 'rev1' },
    )

    expect(calls.length).toBe(1) // ONE batched statement, not one per row
    const [{ sql, params }] = calls
    expect(sql).toContain('jsonb_to_recordset')
    expect(sql).toContain("'lossy_retype'")
    expect(params[0]).toBe('s1')
    expect(params[1]).toBe('f1')
    expect(params[2]).toBe('rev1')
    const payload = JSON.parse(params[3] as string) as Array<{ record_id: string; value: unknown }>
    expect(payload).toEqual([
      { record_id: 'r1', value: 'old-string-value' },
      { record_id: 'r2', value: null },
    ])
  })
})
