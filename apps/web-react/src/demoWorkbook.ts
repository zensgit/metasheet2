import { CellValueType, LocaleType, type IWorkbookData } from '@univerjs/core'

export const DEMO_WORKBOOK_DATA: IWorkbookData = {
  id: 'metasheet-poc',
  appVersion: '0.12.0',
  locale: LocaleType.EN_US,
  name: 'MetaSheet POC',
  sheetOrder: ['sheet-001'],
  styles: {},
  sheets: {
    'sheet-001': {
      id: 'sheet-001',
      name: 'Sheet1',
      rowCount: 20,
      columnCount: 10,
      cellData: {
        0: {
          0: { v: '产品' },
          1: { v: '数量' },
          2: { v: '单价' },
          3: { v: '小计' },
        },
        1: {
          0: { v: '产品A' },
          1: { v: 12, t: CellValueType.NUMBER },
          2: { v: 100, t: CellValueType.NUMBER },
          3: { v: 1200, t: CellValueType.NUMBER },
        },
        2: {
          0: { v: '产品B' },
          1: { v: 20, t: CellValueType.NUMBER },
          2: { v: 150, t: CellValueType.NUMBER },
          3: { v: 3000, t: CellValueType.NUMBER },
        },
        3: {
          0: { v: '产品C' },
          1: { v: 15, t: CellValueType.NUMBER },
          2: { v: 200, t: CellValueType.NUMBER },
          3: { v: 3000, t: CellValueType.NUMBER },
        },
      },
    },
  },
}
