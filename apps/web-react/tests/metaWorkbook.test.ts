import { CellValueType, LocaleType } from '@univerjs/core'
import { describe, expect, it } from 'vitest'
import { buildWorkbookFromMeta, shiftFormulaRows, type MetaField, type MetaRecord } from '../src/metaWorkbook'

describe('metaWorkbook helpers', () => {
  it('shifts formula row references by the provided offset', () => {
    expect(shiftFormulaRows('=SUM(A1:B2)+C10', 2)).toBe('=SUM(A3:B4)+C12')
  })

  it('builds a workbook with ordered headers, typed cells, and styles from meta fields', () => {
    const fields: MetaField[] = [
      { id: 'name', name: 'Name', type: 'string', order: 2 },
      { id: 'amount', name: 'Amount', type: 'number', order: 0 },
      { id: 'done', name: 'Done', type: 'boolean', order: 1 },
      { id: 'calc', name: 'Calc', type: 'formula', order: 3 },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        order: 4,
        property: {
          options: [{ value: 'open', color: '#fef3c7' }],
        },
      },
      { id: 'link', name: 'Link', type: 'link', order: 5 },
    ]

    const rows: MetaRecord[] = [
      {
        id: 'row-1',
        data: {
          name: 'Alice',
          amount: 42,
          done: true,
          calc: '=SUM(B1:B2)',
          status: 'open',
          link: 123,
        },
      },
    ]

    const workbook = buildWorkbookFromMeta(fields, rows)
    const sheet = workbook.sheets['sheet-001']

    expect(workbook.locale).toBe(LocaleType.EN_US)
    expect(sheet.cellData?.[0]?.[0]).toEqual(expect.objectContaining({ v: 'Amount', s: 'header' }))
    expect(sheet.cellData?.[0]?.[1]).toEqual(expect.objectContaining({ v: 'Done', s: 'header' }))
    expect(sheet.cellData?.[0]?.[2]).toEqual(expect.objectContaining({ v: 'Name', s: 'header' }))
    expect(sheet.cellData?.[1]?.[0]).toEqual(expect.objectContaining({ v: 42, t: CellValueType.NUMBER, s: 'number' }))
    expect(sheet.cellData?.[1]?.[1]).toEqual(expect.objectContaining({ v: 1, t: CellValueType.BOOLEAN, s: 'number' }))
    expect(sheet.cellData?.[1]?.[3]).toEqual(expect.objectContaining({ f: '=SUM(B2:B3)', s: 'formula' }))
    expect(sheet.cellData?.[1]?.[4]).toEqual(expect.objectContaining({ v: 'open', s: 'select:open' }))
    expect(sheet.cellData?.[1]?.[5]).toEqual(expect.objectContaining({ v: '123', s: 'link' }))
    expect(workbook.styles).toEqual(
      expect.objectContaining({
        header: expect.any(Object),
        number: expect.any(Object),
        formula: expect.any(Object),
        'select:open': expect.any(Object),
        link: expect.any(Object),
      }),
    )
  })
})
