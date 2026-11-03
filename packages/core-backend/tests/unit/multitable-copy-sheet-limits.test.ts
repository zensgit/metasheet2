/**
 * MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS (ADR CS-15 / §7.5) — the parse contract the flag manifest describes.
 */
import { describe, expect, it } from 'vitest'

import {
  COPY_SHEET_MAX_FIELDS,
  COPY_SHEET_SYNC_MAX_ROWS_CEILING,
  COPY_SHEET_SYNC_MAX_ROWS_DEFAULT,
  COPY_SHEET_SYNC_MAX_ROWS_ENV,
  resolveCopySheetSyncMaxRows,
} from '../../src/multitable/copy-sheet-limits'

describe('copy-sheet limits', () => {
  it('defaults to 2000 when unset / blank / junk / non-integer / < 1', () => {
    expect(COPY_SHEET_SYNC_MAX_ROWS_DEFAULT).toBe(2000)
    expect(COPY_SHEET_SYNC_MAX_ROWS_ENV).toBe('MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS')
    for (const raw of [undefined, '', '   ', 'abc', '12.5', '0', '-3', 'NaN', 'Infinity']) {
      expect(resolveCopySheetSyncMaxRows({ MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS: raw } as NodeJS.ProcessEnv)).toBe(2000)
    }
  })

  it('honours an in-range integer verbatim and clamps above the 50 000 ceiling', () => {
    expect(resolveCopySheetSyncMaxRows({ MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS: '1' } as NodeJS.ProcessEnv)).toBe(1)
    expect(resolveCopySheetSyncMaxRows({ MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS: ' 1239 ' } as NodeJS.ProcessEnv)).toBe(1239)
    expect(resolveCopySheetSyncMaxRows({ MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS: '50000' } as NodeJS.ProcessEnv)).toBe(50_000)
    expect(resolveCopySheetSyncMaxRows({ MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS: '999999' } as NodeJS.ProcessEnv)).toBe(COPY_SHEET_SYNC_MAX_ROWS_CEILING)
  })

  it('field cap is the copy feature\'s own constant (500), not the template zod bound', () => {
    expect(COPY_SHEET_MAX_FIELDS).toBe(500)
  })
})
