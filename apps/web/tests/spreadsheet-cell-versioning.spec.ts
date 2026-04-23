import { describe, expect, it } from 'vitest'
import {
  buildCellVersionMap,
  cellVersionKey,
  formatCellReference,
  formatCellVersionConflict,
  isCellVersionConflict,
  mergeCellVersionMap,
  withExpectedCellVersions,
} from '../src/utils/spreadsheetCellVersions'

describe('spreadsheet legacy cell versioning helpers', () => {
  it('indexes server cell versions by row and column', () => {
    expect(buildCellVersionMap([
      { row_index: 0, column_index: 0, version: 1 },
      { row_index: 4, column_index: 27, version: 9 },
      { row_index: 2, column_index: 3, version: null },
    ])).toEqual({
      [cellVersionKey(0, 0)]: 1,
      [cellVersionKey(4, 27)]: 9,
    })
  })

  it('adds expectedVersion only for cells with a known server version', () => {
    const patches = withExpectedCellVersions([
      { row: 0, col: 0, value: 'A1' },
      { row: 1, col: 0, value: 'A2' },
      { row: 2, col: 0, formula: '=A1+A2', value: null },
    ], {
      [cellVersionKey(0, 0)]: 3,
      [cellVersionKey(2, 0)]: 7,
    })

    expect(patches).toEqual([
      { row: 0, col: 0, value: 'A1', expectedVersion: 3 },
      { row: 1, col: 0, value: 'A2' },
      { row: 2, col: 0, formula: '=A1+A2', value: null, expectedVersion: 7 },
    ])
  })

  it('merges returned update versions without dropping untouched cells', () => {
    expect(mergeCellVersionMap({
      [cellVersionKey(0, 0)]: 1,
      [cellVersionKey(0, 1)]: 2,
    }, [
      { row_index: 0, column_index: 0, version: 2 },
      { row_index: 3, column_index: 2, version: 1 },
    ])).toEqual({
      [cellVersionKey(0, 0)]: 2,
      [cellVersionKey(0, 1)]: 2,
      [cellVersionKey(3, 2)]: 1,
    })
  })

  it('formats A1 references and version conflict messages', () => {
    expect(formatCellReference(0, 0)).toBe('A1')
    expect(formatCellReference(4, 27)).toBe('AB5')
    expect(isCellVersionConflict({ code: 'VERSION_CONFLICT' })).toBe(true)
    expect(formatCellVersionConflict({
      code: 'VERSION_CONFLICT',
      row: 4,
      col: 27,
      serverVersion: 9,
      expectedVersion: 7,
    })).toBe('Cell AB5 was changed by another session. Refresh before retrying. (server version: 9, expected: 7)')
    expect(formatCellVersionConflict({
      code: 'VERSION_CONFLICT',
      row: 0,
      col: 0,
      serverVersion: 2,
      expectedVersion: 1,
    }, { locale: 'zh-CN' })).toBe('单元格 A1 已被其他会话更新，请刷新后重试。（服务器版本：2，本地版本：1）')
  })
})
