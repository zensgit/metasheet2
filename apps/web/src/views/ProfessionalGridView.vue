<template>
  <div class="professional-grid-container">
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <div class="toolbar-group">
        <button @click="saveData" class="toolbar-btn primary">
          <span class="icon">💾</span> 保存
        </button>
        <button @click="autoSave = !autoSave" class="toolbar-btn" :class="{ active: autoSave }">
          <span class="icon">🔄</span> 自动保存
          <span v-if="autoSave" class="status">ON</span>
        </button>
      </div>

      <div class="toolbar-group">
        <button @click="showImportDialog" class="toolbar-btn">
          <span class="icon">📥</span> 导入
        </button>
        <button @click="showExportMenu = !showExportMenu" class="toolbar-btn">
          <span class="icon">📤</span> 导出
        </button>
        <div v-if="showExportMenu" class="dropdown-menu">
          <div @click="exportExcel" class="menu-item">导出为 Excel</div>
          <div @click="exportCSV" class="menu-item">导出为 CSV</div>
          <div @click="exportJSON" class="menu-item">导出为 JSON</div>
        </div>
      </div>

      <div class="toolbar-group">
        <button @click="undo" class="toolbar-btn" :disabled="!canUndo">
          <span class="icon">↶</span> 撤销
        </button>
        <button @click="redo" class="toolbar-btn" :disabled="!canRedo">
          <span class="icon">↷</span> 重做
        </button>
      </div>

      <div class="toolbar-group">
        <button @click="insertRow" class="toolbar-btn">
          <span class="icon">➕</span> 插入行
        </button>
        <button @click="insertColumn" class="toolbar-btn">
          <span class="icon">➕</span> 插入列
        </button>
        <button @click="deleteRow" class="toolbar-btn">
          <span class="icon">➖</span> 删除行
        </button>
        <button @click="deleteColumn" class="toolbar-btn">
          <span class="icon">➖</span> 删除列
        </button>
      </div>

      <div class="toolbar-group">
        <button @click="toggleFormulas" class="toolbar-btn" :class="{ active: showFormulas }">
          <span class="icon">ƒ</span> 显示公式
        </button>
        <button @click="recalculate" class="toolbar-btn">
          <span class="icon">🔄</span> 重算
        </button>
      </div>

      <div class="toolbar-spacer"></div>

      <div class="toolbar-info">
        <span v-if="selectedCell">{{ selectedCell }}</span>
        <span v-if="lastSaved">最后保存: {{ lastSaved }}</span>
      </div>
    </div>

    <!-- 公式栏 -->
    <div class="formula-bar">
      <span class="formula-label">{{ selectedCell || 'A1' }}</span>
      <span class="formula-fx">ƒx</span>
      <input
        v-model="formulaBarValue"
        @keyup.enter="applyFormula"
        @focus="formulaBarFocused = true"
        @blur="formulaBarFocused = false"
        class="formula-input"
        placeholder="输入数据或公式（以 = 开头）"
      />
    </div>

    <!-- 表格容器 -->
    <div ref="spreadsheetEl" class="spreadsheet-container"></div>

    <!-- 状态栏 -->
    <div class="status-bar">
      <div class="status-left">
        <span class="status-item">{{ rowCount }} 行 × {{ colCount }} 列</span>
        <span class="status-item">{{ cellCount }} 个单元格</span>
        <span v-if="selectedRange" class="status-item">
          选中: {{ selectedRange }}
        </span>
      </div>
      <div class="status-right">
        <span v-if="selectedStats" class="status-item">
          求和: {{ selectedStats.sum }} | 平均: {{ selectedStats.avg }} | 计数: {{ selectedStats.count }}
        </span>
      </div>
    </div>

    <!-- 导入对话框 -->
    <div v-if="showImport" class="modal-overlay" @click="closeImportDialog">
      <div class="modal-dialog" @click.stop>
        <div class="modal-header">
          <h3>导入数据</h3>
          <button @click="closeImportDialog" class="close-btn">×</button>
        </div>
        <div class="modal-body">
          <div class="import-zone" @drop="handleDrop" @dragover.prevent @dragenter.prevent>
            <input
              type="file"
              ref="fileInput"
              @change="handleFileSelect"
              accept=".xlsx,.xls,.csv,.json"
              style="display: none"
            />
            <div class="import-icon">📁</div>
            <p>拖拽文件到这里，或 <a @click="($event: any) => ($event.target.parentElement.parentElement.querySelector('input[type=file]') as HTMLInputElement)?.click()">点击选择</a></p>
            <p class="import-hint">支持 Excel (.xlsx, .xls), CSV, JSON 格式</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import Spreadsheet from 'x-data-spreadsheet'
import * as XLSX from 'xlsx'
import { saveAs } from 'file-saver'
import 'x-data-spreadsheet/dist/xspreadsheet.css'

// 数据和状态
const spreadsheetEl = ref<HTMLElement>()
const spreadsheet = ref<any>(null)
const formulaBarValue = ref('')
const formulaBarFocused = ref(false)
const selectedCell = ref('A1')
const selectedRange = ref('')
const selectedStats = ref<any>(null)
const rowCount = ref(100)
const colCount = ref(26)
const cellCount = ref(0)
const lastSaved = ref('')
const autoSave = ref(false)
const showFormulas = ref(false)
const showImport = ref(false)
const showExportMenu = ref(false)
const canUndo = ref(false)
const canRedo = ref(false)

// 历史记录
const history = ref<any[]>([])
const historyIndex = ref(-1)
const maxHistory = 50

// 自动保存定时器
let autoSaveTimer: any = null

// 中文本地化
const zhCN = {
  toolbar: {
    undo: '撤销 (Ctrl+Z)',
    redo: '恢复 (Ctrl+Y)',
    print: '打印 (Ctrl+P)',
    paintformat: '格式刷',
    clearformat: '清除格式',
    format: '格式',
    fontName: '字体',
    fontSize: '字号',
    fontBold: '加粗',
    fontItalic: '倾斜',
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
  },
  contextmenu: {
    copy: '复制',
    cut: '剪切',
    paste: '粘贴',
    pasteSpecial: '选择性粘贴',
    insert: '插入',
    delete: '删除',
    deleteCell: '删除单元格',
    deleteRow: '删除行',
    deleteColumn: '删除列',
    clearContent: '清除内容',
    clearFormat: '清除格式',
    clearAll: '全部清除'
  }
}

// 初始化表格
function initSpreadsheet() {
  if (!spreadsheetEl.value) return

  const options = {
    mode: 'edit' as const,
    showToolbar: true,
    showGrid: true,
    showContextmenu: true,
    view: {
      height: () => spreadsheetEl.value?.clientHeight || 600,
      width: () => spreadsheetEl.value?.clientWidth || 1000
    },
    row: {
      len: rowCount.value,
      height: 25
    },
    col: {
      len: colCount.value,
      width: 100,
      minWidth: 50,
      indexWidth: 60
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
        name: 'Helvetica',
        size: 10,
        bold: false,
        italic: false
      }
    }
  }

  spreadsheet.value = new Spreadsheet(spreadsheetEl.value, options)

  // 应用中文语言
  spreadsheet.value.locale('zh-cn', zhCN)

  // 监听变化
  spreadsheet.value.change((data: any) => {
    addToHistory(data)
    updateStats()
    if (autoSave.value) {
      scheduleAutoSave()
    }
  })

  // 监听选择变化
  spreadsheet.value.on('cell-selected', (cell: any, ri: number, ci: number) => {
    selectedCell.value = `${String.fromCharCode(65 + ci)}${ri + 1}`
    const cellData = spreadsheet.value.getData()[0]?.rows?.[ri]?.cells?.[ci]
    formulaBarValue.value = cellData?.text || ''
  })

  // 监听范围选择
  spreadsheet.value.on('cells-selected', (
    cell: any,
    { sri, sci, eri, eci }: any
  ) => {
    const startCell = `${String.fromCharCode(65 + sci)}${sri + 1}`
    const endCell = `${String.fromCharCode(65 + eci)}${eri + 1}`
    selectedRange.value = `${startCell}:${endCell}`
    calculateRangeStats(sri, sci, eri, eci)
  })

  // 加载初始数据
  loadInitialData()
}

// 加载初始数据
function loadInitialData() {
  // 从本地存储加载
  const savedData = localStorage.getItem('professionalGridData')
  if (savedData) {
    try {
      const data = JSON.parse(savedData)
      spreadsheet.value?.loadData(data)
    } catch (error) {
      console.error('Failed to load saved data:', error)
      loadSampleData()
    }
  } else {
    loadSampleData()
  }
}

// 加载示例数据
function loadSampleData() {
  const sampleData = [{
    rows: {
      0: {
        cells: {
          0: { text: '产品名称', style: 0 },
          1: { text: '单价', style: 0 },
          2: { text: '数量', style: 0 },
          3: { text: '小计', style: 0 },
          4: { text: '税率', style: 0 },
          5: { text: '税额', style: 0 },
          6: { text: '总计', style: 0 }
        }
      },
      1: {
        cells: {
          0: { text: 'iPhone 15 Pro' },
          1: { text: '7999' },
          2: { text: '2' },
          3: { text: '=B2*C2' },
          4: { text: '0.13' },
          5: { text: '=D2*E2' },
          6: { text: '=D2+F2' }
        }
      },
      2: {
        cells: {
          0: { text: 'MacBook Pro 16' },
          1: { text: '19999' },
          2: { text: '1' },
          3: { text: '=B3*C3' },
          4: { text: '0.13' },
          5: { text: '=D3*E3' },
          6: { text: '=D3+F3' }
        }
      },
      3: {
        cells: {
          0: { text: 'iPad Pro 12.9' },
          1: { text: '8999' },
          2: { text: '3' },
          3: { text: '=B4*C4' },
          4: { text: '0.13' },
          5: { text: '=D4*E4' },
          6: { text: '=D4+F4' }
        }
      },
      4: {
        cells: {
          0: { text: 'AirPods Pro' },
          1: { text: '1999' },
          2: { text: '5' },
          3: { text: '=B5*C5' },
          4: { text: '0.13' },
          5: { text: '=D5*E5' },
          6: { text: '=D5+F5' }
        }
      },
      6: {
        cells: {
          0: { text: '合计', style: 0 },
          1: { text: '=SUM(B2:B5)' },
          2: { text: '=SUM(C2:C5)' },
          3: { text: '=SUM(D2:D5)' },
          4: { text: '' },
          5: { text: '=SUM(F2:F5)' },
          6: { text: '=SUM(G2:G5)' }
        }
      }
    },
    styles: [
      {
        bgcolor: '#f4f5f8',
        font: { bold: true }
      }
    ]
  }]

  if (spreadsheet.value) {
    spreadsheet.value.loadData(sampleData)
  }
}

// 保存数据
function saveData() {
  const data = spreadsheet.value?.getData()
  if (data) {
    localStorage.setItem('professionalGridData', JSON.stringify(data))
    lastSaved.value = new Date().toLocaleTimeString('zh-CN')
    showNotification('数据已保存')
  }
}

// 自动保存
function scheduleAutoSave() {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
  }
  autoSaveTimer = setTimeout(() => {
    saveData()
  }, 5000) // 5秒后自动保存
}

// 导入功能
function showImportDialog() {
  showImport.value = true
}

function closeImportDialog() {
  showImport.value = false
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  const files = e.dataTransfer?.files
  if (files && files[0]) {
    importFile(files[0]!)
  }
}

function handleFileSelect(e: Event) {
  const target = e.target as HTMLInputElement
  if (target.files && target.files[0]) {
    importFile(target.files[0]!)
  }
}

async function importFile(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase()

  try {
    if (extension === 'csv') {
      await importCSVFile(file)
    } else if (extension === 'json') {
      await importJSONFile(file)
    } else if (extension === 'xlsx' || extension === 'xls') {
      await importExcelFile(file)
    } else {
      throw new Error('不支持的文件格式')
    }
    closeImportDialog()
    showNotification('导入成功')
  } catch (error) {
    console.error('Import error:', error)
    alert('导入失败: ' + error)
  }
}

async function importExcelFile(file: File) {
  const data = await file.arrayBuffer()
  const workbook = XLSX.read(data)
  const worksheet = workbook.Sheets[workbook.SheetNames[0]!]
  const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

  // 转换为 x-data-spreadsheet 格式
  const rows: any = {}
  json.forEach((row: any, ri: number) => {
    const cells: any = {}
    row.forEach((cell: any, ci: number) => {
      cells[ci] = { text: String(cell || '') }
    })
    rows[ri] = { cells }
  })

  spreadsheet.value?.loadData([{ rows }])
}

async function importCSVFile(file: File) {
  const text = await file.text()
  const lines = text.split('\n')
  const rows: any = {}

  lines.forEach((line, ri) => {
    const cells: any = {}
    const values = line.split(',')
    values.forEach((value, ci) => {
      cells[ci] = { text: value.trim() }
    })
    rows[ri] = { cells }
  })

  spreadsheet.value?.loadData([{ rows }])
}

async function importJSONFile(file: File) {
  const text = await file.text()
  const data = JSON.parse(text)
  spreadsheet.value?.loadData(data)
}

// 导出功能
function exportExcel() {
  const data = spreadsheet.value?.getData()[0]
  if (!data) return

  // 转换为二维数组
  const rows = []
  const maxRow = Math.max(...Object.keys(data.rows || {}).map(Number))
  const maxCol = Math.max(
    ...Object.values(data.rows || {}).map((row: any) =>
      Math.max(...Object.keys(row.cells || {}).map(Number))
    )
  )

  for (let r = 0; r <= maxRow; r++) {
    const row = []
    for (let c = 0; c <= maxCol; c++) {
      const cell = data.rows?.[r]?.cells?.[c]
      row.push(cell?.text || '')
    }
    rows.push(row)
  }

  // 创建工作簿
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')

  // 导出文件
  XLSX.writeFile(wb, `spreadsheet_${Date.now()}.xlsx`)
  showExportMenu.value = false
}

function exportCSV() {
  const data = spreadsheet.value?.getData()[0]
  if (!data) return

  let csv = ''
  const maxRow = Math.max(...Object.keys(data.rows || {}).map(Number))
  const maxCol = Math.max(
    ...Object.values(data.rows || {}).map((row: any) =>
      Math.max(...Object.keys(row.cells || {}).map(Number))
    )
  )

  for (let r = 0; r <= maxRow; r++) {
    const row = []
    for (let c = 0; c <= maxCol; c++) {
      const cell = data.rows?.[r]?.cells?.[c]
      const value = cell?.text || ''
      // CSV 转义
      if (value.includes(',') || value.includes('"') || value.includes('\n')) {
        row.push(`"${value.replace(/"/g, '""')}"`)
      } else {
        row.push(value)
      }
    }
    csv += row.join(',') + '\n'
  }

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  saveAs(blob, `spreadsheet_${Date.now()}.csv`)
  showExportMenu.value = false
}

function exportJSON() {
  const data = spreadsheet.value?.getData()
  if (!data) return

  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  saveAs(blob, `spreadsheet_${Date.now()}.json`)
  showExportMenu.value = false
}

// 撤销/重做
function addToHistory(data: any) {
  // 移除当前索引之后的历史记录
  history.value = history.value.slice(0, historyIndex.value + 1)

  // 添加新的历史记录
  history.value.push(JSON.parse(JSON.stringify(data)))

  // 限制历史记录数量
  if (history.value.length > maxHistory) {
    history.value.shift()
  } else {
    historyIndex.value++
  }

  updateUndoRedoStatus()
}

function undo() {
  if (historyIndex.value > 0) {
    historyIndex.value--
    const data = history.value[historyIndex.value]
    spreadsheet.value?.loadData(data)
    updateUndoRedoStatus()
  }
}

function redo() {
  if (historyIndex.value < history.value.length - 1) {
    historyIndex.value++
    const data = history.value[historyIndex.value]
    spreadsheet.value?.loadData(data)
    updateUndoRedoStatus()
  }
}

function updateUndoRedoStatus() {
  canUndo.value = historyIndex.value > 0
  canRedo.value = historyIndex.value < history.value.length - 1
}

// 插入/删除行列
function insertRow() {
  const ri = spreadsheet.value?.getSelectedRect()?.sri || 0
  spreadsheet.value?.insertRow(ri)
}

function insertColumn() {
  const ci = spreadsheet.value?.getSelectedRect()?.sci || 0
  spreadsheet.value?.insertColumn(ci)
}

function deleteRow() {
  const ri = spreadsheet.value?.getSelectedRect()?.sri
  if (ri !== undefined) {
    spreadsheet.value?.deleteRow(ri)
  }
}

function deleteColumn() {
  const ci = spreadsheet.value?.getSelectedRect()?.sci
  if (ci !== undefined) {
    spreadsheet.value?.deleteColumn(ci)
  }
}

// 公式相关
function applyFormula() {
  const [ri, ci] = getCellIndex(selectedCell.value)
  const data = spreadsheet.value?.getData()[0]

  if (!data.rows[ri]) data.rows[ri] = { cells: {} }
  if (!data.rows[ri].cells) data.rows[ri].cells = {}

  data.rows[ri].cells[ci] = { text: formulaBarValue.value }
  spreadsheet.value?.loadData([data])
  spreadsheet.value?.reRender()
}

function toggleFormulas() {
  showFormulas.value = !showFormulas.value
  // TODO: 实现显示/隐藏公式功能
}

function recalculate() {
  spreadsheet.value?.reRender()
  showNotification('公式已重新计算')
}

// 辅助函数
function getCellIndex(cellRef: string): [number, number] {
  const match = cellRef.match(/([A-Z]+)(\d+)/)
  if (!match) return [0, 0]

  const col = match[1].charCodeAt(0) - 65
  const row = parseInt(match[2]) - 1

  return [row, col]
}

function updateStats() {
  const data = spreadsheet.value?.getData()[0]
  if (!data) return

  let count = 0
  Object.values(data.rows || {}).forEach((row: any) => {
    Object.values(row.cells || {}).forEach((cell: any) => {
      if (cell?.text) count++
    })
  })
  cellCount.value = count
}

function calculateRangeStats(sri: number, sci: number, eri: number, eci: number) {
  const data = spreadsheet.value?.getData()[0]
  if (!data) return

  let sum = 0
  let count = 0
  const values: number[] = []

  for (let r = sri; r <= eri; r++) {
    for (let c = sci; c <= eci; c++) {
      const cell = data.rows?.[r]?.cells?.[c]
      if (cell?.text) {
        const value = parseFloat(cell.text)
        if (!isNaN(value)) {
          sum += value
          values.push(value)
          count++
        }
      }
    }
  }

  if (count > 0) {
    selectedStats.value = {
      sum: sum.toFixed(2),
      avg: (sum / count).toFixed(2),
      count
    }
  } else {
    selectedStats.value = null
  }
}

function showNotification(message: string) {
  // 简单的通知提示
  const notification = document.createElement('div')
  notification.className = 'notification'
  notification.textContent = message
  document.body.appendChild(notification)

  setTimeout(() => {
    notification.remove()
  }, 3000)
}

// 键盘快捷键
function handleKeydown(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey) {
    switch (e.key) {
      case 's':
        e.preventDefault()
        saveData()
        break
      case 'z':
        e.preventDefault()
        undo()
        break
      case 'y':
        e.preventDefault()
        redo()
        break
    }
  }
}

// 生命周期
onMounted(() => {
  initSpreadsheet()
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer)
  }
})
</script>

<style scoped>
.professional-grid-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f5f6fa;
}

/* 工具栏 */
.toolbar {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  background: white;
  border-bottom: 1px solid #e1e4e8;
  gap: 16px;
  flex-wrap: wrap;
}

.toolbar-group {
  display: flex;
  gap: 4px;
  position: relative;
}

.toolbar-btn {
  padding: 6px 12px;
  background: white;
  border: 1px solid #d1d5da;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.toolbar-btn:hover:not(:disabled) {
  background: #f6f8fa;
  border-color: #667eea;
}

.toolbar-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toolbar-btn.primary {
  background: #667eea;
  color: white;
  border-color: #667eea;
}

.toolbar-btn.primary:hover {
  background: #5a67d8;
}

.toolbar-btn.active {
  background: #e7f3ff;
  border-color: #667eea;
  color: #667eea;
}

.toolbar-btn .icon {
  font-size: 14px;
}

.toolbar-btn .status {
  font-size: 10px;
  padding: 1px 4px;
  background: #28a745;
  color: white;
  border-radius: 3px;
  margin-left: 4px;
}

.toolbar-spacer {
  flex: 1;
}

.toolbar-info {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: #586069;
}

/* 下拉菜单 */
.dropdown-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  background: white;
  border: 1px solid #d1d5da;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  z-index: 1000;
  min-width: 150px;
}

.menu-item {
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.2s;
}

.menu-item:hover {
  background: #f6f8fa;
}

/* 公式栏 */
.formula-bar {
  display: flex;
  align-items: center;
  padding: 4px 12px;
  background: white;
  border-bottom: 1px solid #e1e4e8;
  gap: 8px;
}

.formula-label {
  padding: 4px 12px;
  background: #f6f8fa;
  border: 1px solid #d1d5da;
  border-radius: 3px;
  font-size: 13px;
  font-weight: 500;
  min-width: 60px;
  text-align: center;
}

.formula-fx {
  font-style: italic;
  font-weight: bold;
  color: #667eea;
  font-size: 14px;
}

.formula-input {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid #d1d5da;
  border-radius: 3px;
  font-size: 13px;
  font-family: 'Monaco', 'Courier New', monospace;
  transition: border-color 0.2s;
}

.formula-input:focus {
  outline: none;
  border-color: #667eea;
  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
}

/* 表格容器 */
.spreadsheet-container {
  flex: 1;
  background: white;
  margin: 12px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  overflow: hidden;
}

/* 状态栏 */
.status-bar {
  display: flex;
  justify-content: space-between;
  padding: 6px 12px;
  background: white;
  border-top: 1px solid #e1e4e8;
  font-size: 12px;
  color: #586069;
}

.status-left,
.status-right {
  display: flex;
  gap: 16px;
}

.status-item {
  padding: 2px 8px;
  background: #f6f8fa;
  border-radius: 3px;
}

/* 导入对话框 */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.modal-dialog {
  background: white;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2);
  width: 500px;
  max-width: 90%;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #e1e4e8;
}

.modal-header h3 {
  margin: 0;
  font-size: 18px;
}

.close-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  font-size: 24px;
  cursor: pointer;
  color: #586069;
  border-radius: 4px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: #f6f8fa;
}

.modal-body {
  padding: 20px;
}

.import-zone {
  border: 2px dashed #d1d5da;
  border-radius: 8px;
  padding: 40px;
  text-align: center;
  transition: all 0.2s;
  cursor: pointer;
}

.import-zone:hover {
  border-color: #667eea;
  background: #f8f9ff;
}

.import-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.import-zone p {
  margin: 8px 0;
  color: #586069;
}

.import-zone a {
  color: #667eea;
  text-decoration: none;
  font-weight: 500;
}

.import-zone a:hover {
  text-decoration: underline;
}

.import-hint {
  font-size: 12px;
  color: #959da5;
}

/* 通知 */
:global(.notification) {
  position: fixed;
  top: 20px;
  right: 20px;
  padding: 12px 20px;
  background: #28a745;
  color: white;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  z-index: 3000;
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

/* 覆盖 x-data-spreadsheet 样式 */
:deep(.x-spreadsheet) {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
}

:deep(.x-spreadsheet-toolbar) {
  background: #fafbfc;
  border-bottom: 1px solid #e1e4e8;
}

:deep(.x-spreadsheet-toolbar .x-spreadsheet-toolbar-btn) {
  transition: all 0.2s;
}

:deep(.x-spreadsheet-toolbar .x-spreadsheet-toolbar-btn:hover) {
  background: #e7f3ff;
}

:deep(.x-spreadsheet-selector) {
  background: #667eea !important;
}

:deep(.x-spreadsheet-cell-selected) {
  border-color: #667eea !important;
  box-shadow: inset 0 0 0 2px #667eea;
}

:deep(.x-spreadsheet-editor) {
  border-color: #667eea !important;
}

:deep(.x-spreadsheet-contextmenu) {
  box-shadow: 0 2px 12px rgba(0,0,0,0.15);
  border-radius: 4px;
}

:deep(.x-spreadsheet-contextmenu .x-spreadsheet-item:hover) {
  background: #e7f3ff;
}
</style>
// 文件选择 ref
const fileInput = ref<HTMLInputElement | null>(null)

function onChooseFile() {
  (fileInput.value as HTMLInputElement | null)?.click?.()
}
