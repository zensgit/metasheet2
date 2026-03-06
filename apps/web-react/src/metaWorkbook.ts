import {
  CellValueType,
  HorizontalAlign,
  LocaleType,
  type IStyleData,
  type IWorkbookData,
} from '@univerjs/core'

export type MetaField = {
  id: string
  name: string
  type: 'string' | 'number' | 'boolean' | 'formula' | 'select' | 'link' | 'lookup' | 'rollup'
  order?: number
  property?: {
    options?: Array<{ value: string; label?: string; color?: string }>
  }
}

export type MetaRecord = {
  id: string
  data: Record<string, unknown>
}

export const shiftFormulaRows = (formula: string, offset: number) => {
  return formula.replace(/([A-Z]+)(\d+)/g, (_match, col, row) => `${col}${Number(row) + offset}`)
}

export const buildWorkbookFromMeta = (fields: MetaField[], rows: MetaRecord[]): IWorkbookData => {
  const orderedFields = [...fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const sheetId = 'sheet-001'
  const headerRow = 0
  const dataStartRow = 1
  const cellData: NonNullable<Partial<IWorkbookData['sheets'][string]>['cellData']> = {}
  const styles: Record<string, IStyleData> = {}
  const styleIds = new Map<string, string>()

  const registerStyle = (key: string, style: IStyleData) => {
    if (!styleIds.has(key)) {
      styleIds.set(key, key)
      styles[key] = style
    }
    return key
  }

  const headerStyle = registerStyle('header', {
    bl: 1,
    bg: { rgb: 'rgb(248,250,252)' },
  })
  const linkStyle = registerStyle('link', {
    cl: { rgb: '#2563eb' },
  })
  const numberStyle = registerStyle('number', {
    ht: HorizontalAlign.RIGHT,
  })
  const formulaStyle = registerStyle('formula', {
    cl: { rgb: '#64748b' },
    ff: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  })

  cellData[headerRow] = {}
  orderedFields.forEach((field, col) => {
    cellData[headerRow][col] = { v: field.name, s: headerStyle }
  })

  rows.forEach((row, rowIndex) => {
    const rowKey = dataStartRow + rowIndex
    cellData[rowKey] = {}
    orderedFields.forEach((field, col) => {
      const value = row.data[field.id]
      const valueLabel = Array.isArray(value)
        ? value.map((item) => String(item)).join(', ')
        : value

      if (field.type === 'number' && typeof value === 'number') {
        cellData[rowKey][col] = { v: value, t: CellValueType.NUMBER, s: numberStyle }
        return
      }

      if (field.type === 'boolean' && typeof value === 'boolean') {
        cellData[rowKey][col] = { v: value ? 1 : 0, t: CellValueType.BOOLEAN, s: numberStyle }
        return
      }

      if (field.type === 'formula' && typeof value === 'string' && value.startsWith('=')) {
        cellData[rowKey][col] = { f: shiftFormulaRows(value, dataStartRow), s: formulaStyle }
        return
      }

      if (field.type === 'select' && typeof value === 'string') {
        const option = field.property?.options?.find((opt) => opt.value === value || opt.label === value)
        const styleId = option?.color
          ? registerStyle(`select:${option.value}`, { bg: { rgb: option.color } })
          : undefined
        cellData[rowKey][col] = { v: value, s: styleId }
        return
      }

      if (field.type === 'link' && value !== null && value !== undefined) {
        cellData[rowKey][col] = { v: String(valueLabel), s: linkStyle }
        return
      }

      if (typeof value === 'string' || typeof value === 'number') {
        cellData[rowKey][col] = { v: value }
        return
      }

      if (value === null || value === undefined) {
        cellData[rowKey][col] = { v: '' }
        return
      }

      cellData[rowKey][col] = { v: typeof valueLabel === 'string' ? valueLabel : JSON.stringify(valueLabel) }
    })
  })

  return {
    id: `metasheet-meta-${Date.now()}`,
    appVersion: '0.12.0',
    locale: LocaleType.EN_US,
    name: 'MetaSheet Meta View',
    sheetOrder: [sheetId],
    styles,
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: 'Meta',
        rowCount: Math.max(rows.length + 5, 20),
        columnCount: Math.max(orderedFields.length + 2, 10),
        cellData,
      },
    },
  }
}
