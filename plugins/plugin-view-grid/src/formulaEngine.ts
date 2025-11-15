/**
 * 简化版公式引擎
 * 支持基本的表格公式计算
 */

export interface FormulaContext {
  data: any
  columns: any[]
}

export class FormulaEngine {
  private context: FormulaContext

  constructor(context: FormulaContext) {
    this.context = context
  }

  /**
   * 计算公式
   */
  calculate(formula: string, row: number, col: number): any {
    if (!formula.startsWith('=')) {
      return formula
    }

    // 移除等号
    formula = formula.substring(1)

    try {
      // 替换单元格引用
      formula = this.replaceCellReferences(formula)

      // 替换函数
      formula = this.replaceFunctions(formula)

      // 使用 Function 构造器安全计算
      const fn = new Function('return ' + formula)
      return fn()
    } catch (error) {
      console.error('Formula calculation error:', error)
      return '#ERROR!'
    }
  }

  /**
   * 替换单元格引用
   */
  private replaceCellReferences(formula: string): string {
    // 匹配单元格引用 (如 A1, B2 等)
    const cellPattern = /([A-Z]+)(\d+)/g

    return formula.replace(cellPattern, (match, col, row) => {
      const colIndex = this.columnToIndex(col)
      const rowIndex = parseInt(row) - 1

      // 获取单元格值
      const value = this.getCellValue(rowIndex, colIndex)
      return isNaN(value) ? `"${value}"` : value
    })
  }

  /**
   * 替换函数
   */
  private replaceFunctions(formula: string): string {
    // SUM 函数
    formula = formula.replace(/SUM\(([^)]+)\)/gi, (match, range) => {
      return this.calculateSum(range)
    })

    // AVERAGE 函数
    formula = formula.replace(/AVERAGE\(([^)]+)\)/gi, (match, range) => {
      return this.calculateAverage(range)
    })

    // COUNT 函数
    formula = formula.replace(/COUNT\(([^)]+)\)/gi, (match, range) => {
      return this.calculateCount(range)
    })

    // MAX 函数
    formula = formula.replace(/MAX\(([^)]+)\)/gi, (match, range) => {
      return this.calculateMax(range)
    })

    // MIN 函数
    formula = formula.replace(/MIN\(([^)]+)\)/gi, (match, range) => {
      return this.calculateMin(range)
    })

    return formula
  }

  /**
   * 计算 SUM
   */
  private calculateSum(range: string): string {
    const values = this.getRangeValues(range)
    const sum = values.reduce((acc, val) => acc + (parseFloat(val) || 0), 0)
    return sum.toString()
  }

  /**
   * 计算 AVERAGE
   */
  private calculateAverage(range: string): string {
    const values = this.getRangeValues(range)
    const numbers = values.filter(v => !isNaN(parseFloat(v)))
    if (numbers.length === 0) return '0'
    const sum = numbers.reduce((acc, val) => acc + parseFloat(val), 0)
    return (sum / numbers.length).toString()
  }

  /**
   * 计算 COUNT
   */
  private calculateCount(range: string): string {
    const values = this.getRangeValues(range)
    const numbers = values.filter(v => !isNaN(parseFloat(v)))
    return numbers.length.toString()
  }

  /**
   * 计算 MAX
   */
  private calculateMax(range: string): string {
    const values = this.getRangeValues(range)
    const numbers = values
      .filter(v => !isNaN(parseFloat(v)))
      .map(v => parseFloat(v))

    if (numbers.length === 0) return '0'
    return Math.max(...numbers).toString()
  }

  /**
   * 计算 MIN
   */
  private calculateMin(range: string): string {
    const values = this.getRangeValues(range)
    const numbers = values
      .filter(v => !isNaN(parseFloat(v)))
      .map(v => parseFloat(v))

    if (numbers.length === 0) return '0'
    return Math.min(...numbers).toString()
  }

  /**
   * 获取范围内的值
   */
  private getRangeValues(range: string): any[] {
    const values: any[] = []

    // 解析范围 (如 A1:B10)
    const rangePattern = /([A-Z]+)(\d+):([A-Z]+)(\d+)/
    const match = range.match(rangePattern)

    if (match) {
      const [, startCol, startRow, endCol, endRow] = match
      const startColIndex = this.columnToIndex(startCol)
      const endColIndex = this.columnToIndex(endCol)
      const startRowIndex = parseInt(startRow) - 1
      const endRowIndex = parseInt(endRow) - 1

      for (let r = startRowIndex; r <= endRowIndex; r++) {
        for (let c = startColIndex; c <= endColIndex; c++) {
          const value = this.getCellValue(r, c)
          if (value !== null && value !== undefined && value !== '') {
            values.push(value)
          }
        }
      }
    } else {
      // 单个单元格
      const cellPattern = /([A-Z]+)(\d+)/
      const cellMatch = range.match(cellPattern)
      if (cellMatch) {
        const [, col, row] = cellMatch
        const value = this.getCellValue(
          parseInt(row) - 1,
          this.columnToIndex(col)
        )
        if (value !== null && value !== undefined && value !== '') {
          values.push(value)
        }
      }
    }

    return values
  }

  /**
   * 获取单元格值
   */
  private getCellValue(row: number, col: number): any {
    const rows = this.context.data
    if (!rows[row] || !rows[row].cells || !rows[row].cells[col]) {
      return 0
    }

    const cell = rows[row].cells[col]
    if (cell.value !== undefined) {
      return cell.value
    }

    const text = cell.text || ''

    // 如果是公式，返回0避免循环
    if (text.startsWith('=')) {
      return 0
    }

    // 尝试转换为数字
    const num = parseFloat(text)
    return isNaN(num) ? text : num
  }

  /**
   * 列字母转索引
   */
  private columnToIndex(col: string): number {
    let index = 0
    for (let i = 0; i < col.length; i++) {
      index = index * 26 + (col.charCodeAt(i) - 65 + 1)
    }
    return index - 1
  }

  /**
   * 索引转列字母
   */
  private indexToColumn(index: number): string {
    let col = ''
    while (index >= 0) {
      col = String.fromCharCode((index % 26) + 65) + col
      index = Math.floor(index / 26) - 1
    }
    return col
  }
}