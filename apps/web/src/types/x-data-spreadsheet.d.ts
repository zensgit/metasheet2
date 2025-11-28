/**
 * Type declarations for x-data-spreadsheet
 */

declare module 'x-data-spreadsheet' {
  export interface Options {
    mode?: 'read' | 'edit'
    showToolbar?: boolean
    showGrid?: boolean
    showContextmenu?: boolean
    view?: {
      height: () => number
      width: () => number
    }
    row?: {
      len: number
      height: number
    }
    col?: {
      len: number
      width: number
      minWidth: number
      indexWidth: number
    }
    style?: {
      bgcolor?: string
      align?: string
      valign?: string
      textwrap?: boolean
      strike?: boolean
      underline?: boolean
      color?: string
      font?: {
        name?: string
        size?: number
        bold?: boolean
        italic?: boolean
      }
    }
  }

  export interface CellData {
    text?: string
    style?: number
    merge?: [number, number]
  }

  export interface RowData {
    cells: Record<number, CellData>
  }

  export interface SheetData {
    name?: string
    rows?: Record<number, RowData>
    cols?: Record<number, { width: number }>
    merges?: string[]
    styles?: any[]
  }

  export default class Spreadsheet {
    constructor(el: string | HTMLElement, options?: Options)
    loadData(data: SheetData | SheetData[]): this
    getData(): SheetData[]
    change(cb: (data: SheetData) => void): this
    on(event: string, cb: (...args: any[]) => void): this
    cellText(ri: number, ci: number, text?: string): string | this
    cell(ri: number, ci: number, cell?: CellData): CellData | this
    reRender(): this
    validate(): boolean
  }
}

declare module 'x-data-spreadsheet/dist/xspreadsheet.css' {
  const content: string
  export default content
}
