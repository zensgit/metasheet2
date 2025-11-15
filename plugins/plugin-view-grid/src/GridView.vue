<template>
  <div class="grid-view-container">
    <!-- 工具栏 -->
    <div class="grid-toolbar">
      <button @click="saveData" class="btn btn-primary">
        💾 保存
      </button>
      <button @click="importData" class="btn">
        📥 导入
      </button>
      <button @click="exportData" class="btn">
        📤 导出
      </button>
      <div class="separator"></div>
      <button @click="addRow" class="btn">
        ➕ 添加行
      </button>
      <button @click="addColumn" class="btn">
        ➕ 添加列
      </button>
      <div class="separator"></div>
      <span class="formula-bar">
        <span class="label">公式:</span>
        <input
          v-model="currentFormula"
          @keyup.enter="applyFormula"
          placeholder="输入公式，如 =SUM(A1:A10)"
        />
      </span>
    </div>

    <!-- 表格容器 -->
    <div ref="spreadsheetEl" class="spreadsheet-container"></div>

    <!-- 状态栏 -->
    <div class="status-bar">
      <span>{{ selectedCell }}</span>
      <span>{{ rowCount }} 行 × {{ colCount }} 列</span>
      <span v-if="lastSaved">最后保存: {{ lastSaved }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import Spreadsheet from 'x-data-spreadsheet'
import 'x-data-spreadsheet/dist/xspreadsheet.css'
import { FormulaEngine } from './formulaEngine'

// 中文语言包
const zhCN = {
  toolbar: {
    undo: '撤销',
    redo: '重做',
    print: '打印',
    paintformat: '格式刷',
    clearformat: '清除格式',
    format: '格式',
    font: '字体',
    fontSize: '字号',
    fontBold: '加粗',
    fontItalic: '斜体',
    underline: '下划线',
    strike: '删除线',
    color: '文字颜色',
    bgcolor: '背景颜色',
    border: '边框',
    merge: '合并单元格',
    align: '对齐方式',
    valign: '垂直对齐',
    textwrap: '自动换行',
    freeze: '冻结窗格',
    autofilter: '自动筛选',
    formula: '公式',
    more: '更多'
  }
}

// 响应式数据
const spreadsheetEl = ref<HTMLElement>()
const currentFormula = ref('')
const selectedCell = ref('A1')
const rowCount = ref(100)
const colCount = ref(26)
const lastSaved = ref('')

let spreadsheet: any = null
let formulaEngine: FormulaEngine | null = null

// 初始化表格
function initSpreadsheet() {
  if (!spreadsheetEl.value) return

  // 创建表格实例
  spreadsheet = new Spreadsheet(spreadsheetEl.value, {
    mode: 'edit',
    showToolbar: true,
    showGrid: true,
    showContextmenu: true,
    view: {
      height: () => window.innerHeight - 200,
      width: () => spreadsheetEl.value?.clientWidth || 1000
    },
    row: {
      len: rowCount.value,
      height: 25
    },
    col: {
      len: colCount.value,
      width: 100,
      minWidth: 60
    },
    style: {
      bgcolor: '#ffffff',
      align: 'left',
      valign: 'middle',
      textwrap: false,
      strike: false,
      underline: false,
      color: '#0a0a0a',
      font: {
        name: 'Arial',
        size: 10,
        bold: false,
        italic: false
      }
    }
  })

  // 加载语言包
  spreadsheet.locale('zh-cn', zhCN)

  // 监听变化
  spreadsheet.change((data: any) => {
    console.log('Data changed:', data)
    processFormulas()
  })

  // 监听选择
  spreadsheet.on('cell-selected', (cell: any, ri: number, ci: number) => {
    selectedCell.value = `${String.fromCharCode(65 + ci)}${ri + 1}`
    const cellData = spreadsheet.getData()[0].rows[ri]?.[ci]
    if (cellData?.text && cellData.text.startsWith('=')) {
      currentFormula.value = cellData.text
    } else {
      currentFormula.value = ''
    }
  })

  // 初始化公式引擎
  const data = spreadsheet.getData()[0]
  formulaEngine = new FormulaEngine({
    data: data.rows || [],
    columns: []
  })

  // 加载示例数据
  loadSampleData()
}

// 处理公式
function processFormulas() {
  if (!spreadsheet || !formulaEngine) return

  const data = spreadsheet.getData()[0]
  const rows = data.rows || {}

  // 遍历所有单元格，计算公式
  Object.keys(rows).forEach(ri => {
    const row = rows[ri]
    if (row && row.cells) {
      Object.keys(row.cells).forEach(ci => {
        const cell = row.cells[ci]
        if (cell && cell.text && cell.text.startsWith('=')) {
          try {
            const result = formulaEngine!.calculate(cell.text, parseInt(ri), parseInt(ci))
            cell.value = result
          } catch (error) {
            cell.value = '#ERROR!'
          }
        }
      })
    }
  })

  spreadsheet.loadData(data)
}

// 加载示例数据
function loadSampleData() {
  const sampleData = {
    rows: {
      0: { cells: { 0: { text: '产品' }, 1: { text: '数量' }, 2: { text: '单价' }, 3: { text: '总价' } } },
      1: { cells: { 0: { text: '产品A' }, 1: { text: '10' }, 2: { text: '100' }, 3: { text: '=B2*C2' } } },
      2: { cells: { 0: { text: '产品B' }, 1: { text: '20' }, 2: { text: '150' }, 3: { text: '=B3*C3' } } },
      3: { cells: { 0: { text: '产品C' }, 1: { text: '15' }, 2: { text: '200' }, 3: { text: '=B4*C4' } } },
      4: { cells: { 0: { text: '合计' }, 1: { text: '=SUM(B2:B4)' }, 2: { text: '' }, 3: { text: '=SUM(D2:D4)' } } }
    }
  }

  if (spreadsheet) {
    spreadsheet.loadData([sampleData])
    processFormulas()
  }
}

// 保存数据
function saveData() {
  const data = spreadsheet?.getData()
  console.log('Saving data:', data)

  // TODO: 发送到后端保存
  localStorage.setItem('gridData', JSON.stringify(data))
  lastSaved.value = new Date().toLocaleTimeString()

  alert('数据已保存！')
}

// 导入数据
function importData() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.xlsx,.csv'
  input.onchange = (e: any) => {
    const file = e.target.files[0]
    if (file) {
      // TODO: 实现文件导入
      console.log('Import file:', file)
      alert('导入功能开发中...')
    }
  }
  input.click()
}

// 导出数据
function exportData() {
  const data = spreadsheet?.getData()
  console.log('Exporting data:', data)

  // 简单的CSV导出
  let csv = ''
  const rows = data[0].rows || {}

  Object.keys(rows).forEach(ri => {
    const row = rows[ri]
    const values: string[] = []
    if (row && row.cells) {
      for (let ci = 0; ci < colCount.value; ci++) {
        const cell = row.cells[ci]
        values.push(cell?.text || '')
      }
    }
    csv += values.join(',') + '\n'
  })

  // 下载CSV
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'export.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// 添加行
function addRow() {
  rowCount.value += 10
  initSpreadsheet()
}

// 添加列
function addColumn() {
  colCount.value += 5
  initSpreadsheet()
}

// 应用公式
function applyFormula() {
  if (!spreadsheet || !currentFormula.value) return

  const data = spreadsheet.getData()[0]
  const [ri, ci] = getSelectedCellIndex()

  if (!data.rows[ri]) data.rows[ri] = { cells: {} }
  if (!data.rows[ri].cells) data.rows[ri].cells = {}

  data.rows[ri].cells[ci] = { text: currentFormula.value }

  spreadsheet.loadData([data])
  processFormulas()
}

// 获取选中单元格索引
function getSelectedCellIndex(): [number, number] {
  const match = selectedCell.value.match(/([A-Z]+)(\d+)/)
  if (!match) return [0, 0]

  const col = match[1].charCodeAt(0) - 65
  const row = parseInt(match[2]) - 1

  return [row, col]
}

// 生命周期
onMounted(() => {
  initSpreadsheet()

  // 加载本地保存的数据
  const savedData = localStorage.getItem('gridData')
  if (savedData) {
    try {
      const data = JSON.parse(savedData)
      spreadsheet?.loadData(data)
      processFormulas()
    } catch (error) {
      console.error('Failed to load saved data:', error)
    }
  }
})

onUnmounted(() => {
  // 清理资源
  spreadsheet = null
  formulaEngine = null
})
</script>

<style scoped>
.grid-view-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
}

.grid-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  background: #f5f5f5;
  border-bottom: 1px solid #ddd;
}

.btn {
  padding: 6px 12px;
  background: white;
  border: 1px solid #ddd;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.3s;
}

.btn:hover {
  background: #e8e8e8;
}

.btn-primary {
  background: #667eea;
  color: white;
  border-color: #667eea;
}

.btn-primary:hover {
  background: #5a67d8;
}

.separator {
  width: 1px;
  height: 24px;
  background: #ddd;
  margin: 0 4px;
}

.formula-bar {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.formula-bar .label {
  font-weight: 500;
  color: #666;
}

.formula-bar input {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-family: 'Monaco', 'Courier New', monospace;
  font-size: 13px;
}

.spreadsheet-container {
  flex: 1;
  overflow: hidden;
}

.status-bar {
  display: flex;
  justify-content: space-between;
  padding: 4px 12px;
  background: #f8f8f8;
  border-top: 1px solid #ddd;
  font-size: 12px;
  color: #666;
}

/* 覆盖 x-spreadsheet 默认样式 */
:deep(.x-spreadsheet) {
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

:deep(.x-spreadsheet-toolbar) {
  background: #fafafa;
}

:deep(.x-spreadsheet-selector) {
  background: #667eea !important;
}

:deep(.x-spreadsheet-cell-selected) {
  border-color: #667eea !important;
}
</style>