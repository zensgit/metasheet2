<template>
  <div class="enhanced-grid-container" @contextmenu.prevent="handleContextMenu">
    <!-- 顶部工具栏 -->
    <div class="top-toolbar">
      <div class="toolbar-left">
        <button @click="saveData" class="btn primary">
          💾 保存
        </button>
        <button @click="showVersionHistory" class="btn">
          📜 版本历史
        </button>
        <button @click="createSnapshot" class="btn">
          📸 创建快照
        </button>
        <div class="separator"></div>
        <button @click="undo" class="btn" :disabled="!canUndo">
          ↩️ 撤销
        </button>
        <button @click="redo" class="btn" :disabled="!canRedo">
          ↪️ 重做
        </button>
        <div class="separator"></div>
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
      </div>

      <div class="toolbar-right">
        <span class="info-text">{{ rows }}行 × {{ cols }}列 | {{ getCurrentMode() }}</span>
        <label class="auto-save-toggle">
          <input id="grid-auto-save" name="grid-auto-save" type="checkbox" v-model="autoSaveEnabled" />
          <span>自动保存</span>
        </label>
        <button v-if="currentVersion" @click="exitVersionView" class="btn warning">
          退出版本查看
        </button>
      </div>
    </div>

    <!-- 公式栏 -->
    <div class="formula-bar">
      <span class="cell-label">{{ getCurrentCellLabel() }}</span>
      <div class="formula-input-wrapper">
        <input
          id="grid-formula-input"
          name="grid-formula-input"
          v-model="formulaBarValue"
          @keyup.enter="applyFormula"
          @blur="applyFormula"
          class="formula-input"
          placeholder="输入数值或公式 (如: =SUM(A1:A10))"
        />
      </div>
      <button @click="showFormulaHelp" class="help-btn">
        ℹ️ 函数帮助
      </button>
    </div>

    <!-- 主体区域 -->
    <div class="main-content">
      <!-- 表格区域 -->
      <div class="grid-area" :class="{ 'with-sidebar': showSidebar }">
        <div class="table-container">
          <table class="spreadsheet-table">
            <thead>
              <tr>
                <th class="row-header"></th>
                <th v-for="col in cols" :key="col" class="col-header">
                  {{ getColumnLabel(col - 1) }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row">
                <td class="row-header">{{ row }}</td>
                <td
                  v-for="col in cols"
                  :key="`${row}-${col}`"
                  class="cell"
                  :class="{
                    selected: isSelected(row - 1, col - 1),
                    readonly: isReadonly,
                    merged: mergedCells.has(`${row - 1}_${col - 1}`)
                  }"
                  :style="{
                    ...getCellStyle(row - 1, col - 1),
                    width: columnWidths[col - 1] ? `${columnWidths[col - 1]}px` : undefined,
                    height: rowHeights[row - 1] ? `${rowHeights[row - 1]}px` : undefined
                  }"
                  @click="selectCell(row - 1, col - 1)"
                  @dblclick="startEdit(row - 1, col - 1)"
                >
                  <input
                    v-if="isEditing(row - 1, col - 1)"
                    :id="`grid-cell-input-${row - 1}-${col - 1}`"
                    :name="`grid-cell-input-${row - 1}-${col - 1}`"
                    v-model="editingValue"
                    @blur="finishEdit"
                    @keyup.enter="finishEdit"
                    @keyup.escape="cancelEdit"
                    @keyup.tab.prevent="moveNext"
                    ref="cellInput"
                    class="cell-input"
                    :readonly="isReadonly"
                  />
                  <span v-else class="cell-value">
                    {{ getCellDisplay(row - 1, col - 1) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 侧边栏 -->
      <transition name="slide">
        <div v-if="showSidebar" class="sidebar">
          <!-- 版本历史 -->
          <div v-if="sidebarMode === 'history'" class="sidebar-content">
            <div class="sidebar-header">
              <h3>版本历史</h3>
              <button @click="closeSidebar" class="close-btn">×</button>
            </div>
            <div class="version-list">
              <div
                v-for="version in versionHistory"
                :key="version.id"
                class="version-item"
                :class="{ active: currentVersion?.id === version.id }"
                @click="loadVersion(version)"
              >
                <div class="version-header">
                  <span class="version-label">{{ version.label }}</span>
                  <span class="version-time">{{ formatTime(version.createdAt) }}</span>
                </div>
                <div class="version-info">
                  <span class="version-author">{{ version.author }}</span>
                  <span class="version-type">{{ getVersionTypeLabel(version.type) }}</span>
                </div>
                <div v-if="version.description" class="version-desc">
                  {{ version.description }}
                </div>
                <div class="version-actions">
                  <button @click.stop="compareWithVersion(version)" class="link-btn">
                    对比
                  </button>
                  <button @click.stop="restoreVersion(version)" class="link-btn">
                    恢复
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 快照管理 -->
          <div v-else-if="sidebarMode === 'snapshots'" class="sidebar-content">
            <div class="sidebar-header">
              <h3>快照管理</h3>
              <button @click="closeSidebar" class="close-btn">×</button>
            </div>
            <div class="snapshot-list">
              <div
                v-for="snapshot in snapshots"
                :key="snapshot.id"
                class="snapshot-item"
                @click="loadSnapshot(snapshot)"
              >
                <div class="snapshot-header">
                  <span class="snapshot-name">{{ snapshot.name }}</span>
                  <span class="snapshot-size">{{ formatSize(snapshot.size) }}</span>
                </div>
                <div class="snapshot-info">
                  <span class="snapshot-time">{{ formatTime(snapshot.createdAt) }}</span>
                  <span class="snapshot-rows">{{ snapshot.rowCount }} 行</span>
                </div>
                <div class="snapshot-actions">
                  <button @click.stop="downloadSnapshot(snapshot)" class="link-btn">
                    下载
                  </button>
                  <button @click.stop="deleteSnapshot(snapshot)" class="link-btn danger">
                    删除
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 函数帮助 -->
          <div v-else-if="sidebarMode === 'formula'" class="sidebar-content">
            <div class="sidebar-header">
              <h3>函数帮助</h3>
              <button @click="closeSidebar" class="close-btn">×</button>
            </div>
            <div class="formula-help">
              <div class="formula-category">
                <h4>常用函数</h4>
                <div class="formula-list">
                  <div class="formula-item" @click="insertFormula('SUM')">
                    <strong>SUM</strong> - 求和
                    <code>=SUM(A1:A10)</code>
                  </div>
                  <div class="formula-item" @click="insertFormula('AVERAGE')">
                    <strong>AVERAGE</strong> - 平均值
                    <code>=AVERAGE(A1:A10)</code>
                  </div>
                  <div class="formula-item" @click="insertFormula('COUNT')">
                    <strong>COUNT</strong> - 计数
                    <code>=COUNT(A1:A10)</code>
                  </div>
                  <div class="formula-item" @click="insertFormula('MAX')">
                    <strong>MAX</strong> - 最大值
                    <code>=MAX(A1:A10)</code>
                  </div>
                  <div class="formula-item" @click="insertFormula('MIN')">
                    <strong>MIN</strong> - 最小值
                    <code>=MIN(A1:A10)</code>
                  </div>
                  <div class="formula-item" @click="insertFormula('IF')">
                    <strong>IF</strong> - 条件判断
                    <code>=IF(A1>10, "大", "小")</code>
                  </div>
                  <div class="formula-item" @click="insertFormula('VLOOKUP')">
                    <strong>VLOOKUP</strong> - 垂直查找
                    <code>=VLOOKUP(A1, B:C, 2, FALSE)</code>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </transition>
    </div>

    <!-- 状态栏 -->
    <div class="status-bar">
      <span>当前单元格: {{ getCurrentCellLabel() }}</span>
      <span v-if="lastSaved">最后保存: {{ lastSaved }}</span>
      <span v-if="autoSaveEnabled && nextAutoSave">下次自动保存: {{ nextAutoSave }}秒</span>
    </div>

    <!-- 右键菜单 -->
    <ContextMenu
      v-model="showContextMenu"
      :x="contextMenuX"
      :y="contextMenuY"
      :items="contextMenuItems"
      @select="handleMenuSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { formulaEngine } from '../utils/formulaEngine'
import { getApiBase, authHeaders } from '../utils/api'
import ContextMenu from '../components/ContextMenu.vue'
import type { MenuItem } from '../components/ContextMenu.vue'

interface Version {
  id: string
  label: string
  author: string
  type: 'auto' | 'manual' | 'snapshot'
  createdAt: Date
  description?: string
  data: any[][]
}

interface Snapshot {
  id: string
  name: string
  size: number
  rowCount: number
  createdAt: Date
  data: any[][]
}

// 数据状态
const rows = ref(30)
const cols = ref(15)
const data = ref<string[][]>([])
const selectedRow = ref(0)
const selectedCol = ref(0)
const editingRow = ref(-1)
const editingCol = ref(-1)
const editingValue = ref('')
const formulaBarValue = ref('')
const isReadonly = ref(false)
const lastSaved = ref('')

// 撤销/重做
const undoStack = ref<any[]>([])
const redoStack = ref<any[]>([])
const canUndo = computed(() => undoStack.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)

// UI状态
const showSidebar = ref(false)
const sidebarMode = ref<'history' | 'snapshots' | 'formula'>('history')
const currentVersion = ref<Version | null>(null)

// 版本和快照数据
const versionHistory = ref<Version[]>([])
const snapshots = ref<Snapshot[]>([])

// 自动保存
const autoSaveEnabled = ref(true)
const autoSaveInterval = 30000 // 30秒
const nextAutoSave = ref(30)
let autoSaveTimer: any = null
let countdownTimer: any = null

// 单元格引用
const cellInput = ref<HTMLInputElement | null>(null)

// 右键菜单状态
const showContextMenu = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuItems = ref<MenuItem[]>([])
const contextMenuType = ref<'cell' | 'row' | 'column' | ''>('')
const contextMenuTarget = ref<{ row?: number; col?: number }>({})
const clipboard = ref<any>(null)

// 样式和格式化相关
const cellStyles = ref<Record<string, any>>({})
const mergedCells = ref<Set<string>>(new Set())
const columnWidths = ref<Record<number, number>>({})
const rowHeights = ref<Record<number, number>>({})

// 初始化数据
function initData() {
  data.value = Array(rows.value).fill(null).map(() =>
    Array(cols.value).fill('')
  )

  // 添加示例数据
  const sampleData = [
    ['产品名称', '数量', '单价', '总价', '折扣率', '折后价'],
    ['产品A', '10', '100', '=B2*C2', '0.9', '=D2*E2'],
    ['产品B', '20', '150', '=B3*C3', '0.85', '=D3*E3'],
    ['产品C', '15', '200', '=B4*C4', '0.8', '=D4*E4'],
    ['产品D', '25', '120', '=B5*C5', '0.95', '=D5*E5'],
    ['', '', '', '', '', ''],
    ['合计', '=SUM(B2:B5)', '=AVERAGE(C2:C5)', '=SUM(D2:D5)', '', '=SUM(F2:F5)']
  ]

  // 填充示例数据
  for (let r = 0; r < sampleData.length && r < rows.value; r++) {
    if (!data.value[r]) data.value[r] = Array(cols.value).fill('')
    for (let c = 0; c < sampleData[r]!.length && c < cols.value; c++) {
      data.value[r]![c] = sampleData[r]![c]!
    }
  }

  // 计算所有公式
  recalculateAll()
}

// 获取列标签
function getColumnLabel(index: number): string {
  let label = ''
  while (index >= 0) {
    label = String.fromCharCode(65 + (index % 26)) + label
    index = Math.floor(index / 26) - 1
  }
  return label
}

// 获取单元格样式
function getCellStyle(row: number, col: number): any {
  const cellKey = `${row}_${col}`
  return cellStyles.value[cellKey] || {}
}

// 获取当前单元格标签
function getCurrentCellLabel(): string {
  return `${getColumnLabel(selectedCol.value)}${selectedRow.value + 1}`
}

// 检查是否选中
function isSelected(row: number, col: number): boolean {
  return row === selectedRow.value && col === selectedCol.value
}

// 检查是否在编辑
function isEditing(row: number, col: number): boolean {
  return row === editingRow.value && col === editingCol.value
}

// 选择单元格
function selectCell(row: number, col: number) {
  if (isReadonly.value) return

  selectedRow.value = row
  selectedCol.value = col
  formulaBarValue.value = data.value[row]?.[col] || ''
}

// 开始编辑
function startEdit(row: number, col: number) {
  if (isReadonly.value) return

  editingRow.value = row
  editingCol.value = col
  editingValue.value = data.value[row]?.[col] || ''

  nextTick(() => {
    cellInput.value?.focus()
    cellInput.value?.select()
  })
}

// 完成编辑
function finishEdit() {
  if (editingRow.value >= 0 && editingCol.value >= 0) {
    saveUndo()
    if (!data.value[editingRow.value]) {
      data.value[editingRow.value] = Array(cols.value).fill('')
    }
    data.value[editingRow.value]![editingCol.value] = editingValue.value
    recalculateAll()
    editingRow.value = -1
    editingCol.value = -1
  }
}

// 取消编辑
function cancelEdit() {
  editingRow.value = -1
  editingCol.value = -1
}

// 移动到下一个单元格
function moveNext() {
  finishEdit()
  if (selectedCol.value < cols.value - 1) {
    selectedCol.value++
  } else if (selectedRow.value < rows.value - 1) {
    selectedCol.value = 0
    selectedRow.value++
  }
  startEdit(selectedRow.value, selectedCol.value)
}

// 应用公式栏的值
function applyFormula() {
  if (isReadonly.value) return

  saveUndo()
  if (!data.value[selectedRow.value]) {
    data.value[selectedRow.value] = Array(cols.value).fill('')
  }
  data.value[selectedRow.value]![selectedCol.value] = formulaBarValue.value
  recalculateAll()
}

// 获取单元格显示值
function getCellDisplay(row: number, col: number): string {
  if (!data.value[row] || !data.value[row][col]) return ''

  const value = data.value[row][col]
  if (!value) return ''

  if (value.toString().startsWith('=')) {
    return calculateFormula(value, row, col)
  }
  return value
}

// 计算公式
function calculateFormula(formula: string, _row: number, _col: number): string {
  try {
    const context = {
      getCellValue: (r: number, c: number) => {
        const val = data.value[r]?.[c]
        if (!val) return 0
        if (val.toString().startsWith('=')) {
          return calculateFormula(val, r, c)
        }
        return isNaN(Number(val)) ? val : Number(val)
      }
    }

    const result = formulaEngine.evaluate(formula, context)
    return String(result)
  } catch (error) {
    return '#ERROR!'
  }
}

// 重新计算所有公式
function recalculateAll() {
  // 触发响应式更新
  data.value = [...data.value]
}

// 保存撤销状态
function saveUndo() {
  undoStack.value.push(JSON.parse(JSON.stringify(data.value)))
  redoStack.value = []

  // 限制撤销栈大小
  if (undoStack.value.length > 50) {
    undoStack.value.shift()
  }
}
// 撤销
function undo() {
  if (undoStack.value.length > 0) {
    redoStack.value.push(JSON.parse(JSON.stringify(data.value)))
    data.value = undoStack.value.pop()!
    recalculateAll()
  }
}

// 重做
function redo() {
  if (redoStack.value.length > 0) {
    undoStack.value.push(JSON.parse(JSON.stringify(data.value)))
    data.value = redoStack.value.pop()!
    recalculateAll()
  }
}

// 添加行
function addRow() {
  saveUndo()
  rows.value += 5
  for (let i = 0; i < 5; i++) {
    data.value.push(Array(cols.value).fill(''))
  }
}

// 添加列
function addColumn() {
  saveUndo()
  cols.value += 3
  data.value.forEach(row => {
    for (let i = 0; i < 3; i++) {
      row.push('')
    }
  })
}

// 保存数据
async function saveData() {
  try {
    // 保存到localStorage
    localStorage.setItem('gridData', JSON.stringify(data.value))
    localStorage.setItem('gridSize', JSON.stringify({ rows: rows.value, cols: cols.value }))

    // 保存到服务器
    const response = await fetch(`${getApiBase()}/api/spreadsheet`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        id: 'default',
        rows: rows.value,
        cols: cols.value,
        data: data.value
      })
    })

    if (response.ok) {
      lastSaved.value = new Date().toLocaleTimeString()

      // 创建版本记录
      const newVersion: Version = {
        id: `v${Date.now()}`,
        label: `v${versionHistory.value.length + 1}`,
        author: '用户',
        type: 'manual',
        createdAt: new Date(),
        description: '手动保存',
        data: JSON.parse(JSON.stringify(data.value))
      }

      versionHistory.value.unshift(newVersion)
      localStorage.setItem('versionHistory', JSON.stringify(versionHistory.value))

      alert('保存成功！')
    }
  } catch (error) {
    console.error('Save failed:', error)
    alert('保存失败！')
  }
}

// 显示版本历史
function showVersionHistory() {
  showSidebar.value = true
  sidebarMode.value = 'history'
}

// 创建快照
function createSnapshot() {
  const name = prompt('请输入快照名称:')
  if (!name) return

  const snapshot: Snapshot = {
    id: `snap_${Date.now()}`,
    name,
    size: JSON.stringify(data.value).length,
    rowCount: rows.value,
    createdAt: new Date(),
    data: JSON.parse(JSON.stringify(data.value))
  }

  snapshots.value.unshift(snapshot)
  localStorage.setItem('snapshots', JSON.stringify(snapshots.value))

  alert('快照创建成功！')
  showSidebar.value = true
  sidebarMode.value = 'snapshots'
}

// 显示函数帮助
function showFormulaHelp() {
  showSidebar.value = true
  sidebarMode.value = 'formula'
}

// 插入公式
function insertFormula(funcName: string) {
  formulaBarValue.value = `=${funcName}()`
  closeSidebar()
  // 将光标定位到括号内
  nextTick(() => {
    const input = document.querySelector('.formula-input') as HTMLInputElement
    if (input) {
      input.focus()
      input.setSelectionRange(funcName.length + 2, funcName.length + 2)
    }
  })
}

// 加载版本
function loadVersion(version: Version) {
  currentVersion.value = version
  data.value = JSON.parse(JSON.stringify(version.data))
  isReadonly.value = true
  recalculateAll()
}

// 退出版本查看
function exitVersionView() {
  currentVersion.value = null
  isReadonly.value = false
  loadSavedData()
}

// 对比版本
function compareWithVersion(version: Version) {
  // 简化实现：显示版本差异
  alert(`当前版本与 ${version.label} 的差异对比功能正在开发中...`)
}

// 恢复版本
function restoreVersion(version: Version) {
  if (!confirm(`确定要恢复到版本 ${version.label} 吗？`)) return

  saveUndo()
  data.value = JSON.parse(JSON.stringify(version.data))
  isReadonly.value = false
  currentVersion.value = null
  recalculateAll()
  saveData()
}

// 加载快照
function loadSnapshot(snapshot: Snapshot) {
  saveUndo()
  data.value = JSON.parse(JSON.stringify(snapshot.data))
  recalculateAll()
  closeSidebar()
}

// 下载快照
function downloadSnapshot(snapshot: Snapshot) {
  const json = JSON.stringify(snapshot.data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${snapshot.name}.json`
  link.click()
  URL.revokeObjectURL(url)
}

// 删除快照
function deleteSnapshot(snapshot: Snapshot) {
  if (!confirm(`确定要删除快照 "${snapshot.name}" 吗？`)) return

  const index = snapshots.value.findIndex(s => s.id === snapshot.id)
  if (index > -1) {
    snapshots.value.splice(index, 1)
    localStorage.setItem('snapshots', JSON.stringify(snapshots.value))
  }
}

// 导入数据
function importData() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,.csv'
  input.onchange = (e: any) => {
    const file = e.target.files[0]
    if (file) {
      const reader = new FileReader()
      reader.onload = (event) => {
        try {
          const imported = JSON.parse(event.target?.result as string)
          saveUndo()
          data.value = imported
          rows.value = imported.length
          cols.value = imported[0]?.length || cols.value
          recalculateAll()
          alert('导入成功！')
        } catch (error) {
          alert('导入失败：文件格式错误')
        }
      }
      reader.readAsText(file)
    }
  }
  input.click()
}

// 导出数据
function exportData() {
  const json = JSON.stringify(data.value, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `spreadsheet_${Date.now()}.json`
  link.click()
  URL.revokeObjectURL(url)
}

// 关闭侧边栏
function closeSidebar() {
  showSidebar.value = false
}

// 获取当前模式
function getCurrentMode(): string {
  if (currentVersion.value) {
    return `查看版本: ${currentVersion.value.label}`
  }
  return '编辑模式'
}

// 保存历史记录
function saveToHistory(description: string) {
  saveUndo()
  // 创建自动版本记录
  const autoVersion: Version = {
    id: `auto_${Date.now()}`,
    label: `自动-${Date.now()}`,
    author: '系统',
    type: 'auto',
    createdAt: new Date(),
    description: description,
    data: JSON.parse(JSON.stringify(data.value))
  }

  versionHistory.value.unshift(autoVersion)

  // 限制自动版本历史数量
  const autoVersions = versionHistory.value.filter(v => v.type === 'auto')
  if (autoVersions.length > 20) {
    const oldestAutoIndex = versionHistory.value.findIndex(v => v.id === autoVersions[autoVersions.length - 1].id)
    if (oldestAutoIndex > -1) {
      versionHistory.value.splice(oldestAutoIndex, 1)
    }
  }

  localStorage.setItem('versionHistory', JSON.stringify(versionHistory.value))
}

// 获取单元格值
function getCellValue(row: number, col: number): string {
  if (!data.value[row] || col >= data.value[row].length) return ''
  return data.value[row][col] || ''
}

// 设置单元格值
function setCellValue(row: number, col: number, value: string) {
  if (!data.value[row]) {
    data.value[row] = Array(cols.value).fill('')
  }
  data.value[row][col] = value
  recalculateAll()
}

// 获取版本类型标签
function getVersionTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    auto: '自动保存',
    manual: '手动保存',
    snapshot: '快照'
  }
  return labels[type] || type
}

// 格式化时间
function formatTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleString('zh-CN')
}

// 格式化文件大小
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

// 自动保存
function startAutoSave() {
  if (!autoSaveEnabled.value) return

  // 倒计时
  countdownTimer = setInterval(() => {
    nextAutoSave.value--
    if (nextAutoSave.value <= 0) {
      nextAutoSave.value = 30
    }
  }, 1000)

  // 自动保存
  autoSaveTimer = setInterval(() => {
    if (autoSaveEnabled.value && !isReadonly.value) {
      saveData()
    }
  }, autoSaveInterval)
}

// 停止自动保存
function stopAutoSave() {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer)
    autoSaveTimer = null
  }
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

// 监听自动保存开关
watch(autoSaveEnabled, (enabled) => {
  if (enabled) {
    startAutoSave()
  } else {
    stopAutoSave()
  }
})

// 加载保存的数据
function loadSavedData() {
  // 从localStorage加载
  const savedData = localStorage.getItem('gridData')
  const savedSize = localStorage.getItem('gridSize')

  if (savedData) {
    try {
      data.value = JSON.parse(savedData)
      if (savedSize) {
        const size = JSON.parse(savedSize)
        rows.value = size.rows
        cols.value = size.cols
      }
      recalculateAll()
      return
    } catch (error) {
      console.error('Failed to load saved data:', error)
    }
  }

  // 从服务器加载
  fetch(`${getApiBase()}/api/spreadsheet?id=default`, {
    headers: authHeaders()
  })
    .then(res => res.json())
    .then(serverData => {
      if (serverData.data && Object.keys(serverData.data).length > 0) {
        // 转换服务器数据格式
        // 服务器数据可能是稀疏的，需要转换
        initData()
      } else {
        initData()
      }
    })
    .catch(() => {
      initData()
    })
}

// 加载版本历史
function loadVersionHistory() {
  const saved = localStorage.getItem('versionHistory')
  if (saved) {
    try {
      versionHistory.value = JSON.parse(saved)
    } catch (error) {
      console.error('Failed to load version history:', error)
    }
  }
}

// 加载快照
function loadSnapshots() {
  const saved = localStorage.getItem('snapshots')
  if (saved) {
    try {
      snapshots.value = JSON.parse(saved)
    } catch (error) {
      console.error('Failed to load snapshots:', error)
    }
  }
}

// 处理右键菜单
function handleContextMenu(event: MouseEvent) {
  event.preventDefault()

  const target = event.target as HTMLElement

  // 判断点击的位置
  if (target.classList.contains('row-header')) {
    // 行头右键
    const row = parseInt(target.textContent || '1') - 1
    showRowContextMenu(event, row)
  } else if (target.classList.contains('col-header')) {
    // 列头右键
    const col = Array.from(target.parentElement?.children || []).indexOf(target) - 1
    if (col >= 0) {
      showColumnContextMenu(event, col)
    }
  } else if (target.closest('td.cell')) {
    // 单元格右键
    const cell = target.closest('td.cell') as HTMLElement
    const row = parseInt(cell.parentElement?.children[0]?.textContent || '1') - 1
    const col = Array.from(cell.parentElement?.children || []).indexOf(cell) - 1
    if (row >= 0 && col >= 0) {
      showCellContextMenu(event, row, col)
    }
  }
}

// 显示单元格右键菜单
function showCellContextMenu(event: MouseEvent, row: number, col: number) {
  contextMenuType.value = 'cell'
  contextMenuTarget.value = { row, col }

  contextMenuItems.value = [
    {
      id: 'copy',
      label: '复制',
      icon: '📋',
      shortcut: 'Ctrl+C',
      handler: () => copyCell(row, col)
    },
    {
      id: 'paste',
      label: '粘贴',
      icon: '📄',
      shortcut: 'Ctrl+V',
      disabled: !clipboard.value,
      handler: () => pasteCell(row, col)
    },
    {
      id: 'cut',
      label: '剪切',
      icon: '✂️',
      shortcut: 'Ctrl+X',
      handler: () => cutCell(row, col)
    },
    {
      id: 'delete',
      label: '清除内容',
      icon: '🗑️',
      shortcut: 'Delete',
      handler: () => deleteCell(row, col)
    },
    {
      id: 'divider1',
      label: '',
      divider: true
    },
    {
      id: 'format-bold',
      label: '加粗',
      icon: 'B',
      shortcut: 'Ctrl+B',
      handler: () => {
        contextMenuTarget.value = { row, col }
        toggleBold()
      }
    },
    {
      id: 'format-italic',
      label: '斜体',
      icon: 'I',
      shortcut: 'Ctrl+I',
      handler: () => {
        contextMenuTarget.value = { row, col }
        toggleItalic()
      }
    },
    {
      id: 'format-underline',
      label: '下划线',
      icon: 'U',
      shortcut: 'Ctrl+U',
      handler: () => {
        contextMenuTarget.value = { row, col }
        toggleUnderline()
      }
    },
    {
      id: 'divider2',
      label: '',
      divider: true
    },
    {
      id: 'merge-cells',
      label: '合并单元格',
      icon: '🔗',
      handler: () => mergeCells(row, col)
    },
    {
      id: 'unmerge-cells',
      label: '取消合并',
      icon: '🔓',
      handler: () => unmergeCells(row, col)
    },
    {
      id: 'divider3',
      label: '',
      divider: true
    },
    {
      id: 'insert-row-above',
      label: '在上方插入行',
      icon: '⬆️',
      handler: () => insertRow(row, 'above')
    },
    {
      id: 'insert-row-below',
      label: '在下方插入行',
      icon: '⬇️',
      shortcut: 'Alt+Enter',
      handler: () => insertRow(row, 'below')
    },
    {
      id: 'delete-row',
      label: '删除行',
      icon: '❌',
      handler: () => deleteRow(row)
    },
    {
      id: 'divider4',
      label: '',
      divider: true
    },
    {
      id: 'insert-col-left',
      label: '在左侧插入列',
      icon: '⬅️',
      shortcut: 'Ctrl+Shift+←',
      handler: () => insertColumn(col, 'left')
    },
    {
      id: 'insert-col-right',
      label: '在右侧插入列',
      icon: '➡️',
      shortcut: 'Ctrl+Shift+→',
      handler: () => insertColumn(col, 'right')
    },
    {
      id: 'delete-col',
      label: '删除列',
      icon: '❌',
      handler: () => deleteColumn(col)
    },
    {
      id: 'divider5',
      label: '',
      divider: true
    },
    {
      id: 'find-replace',
      label: '查找和替换',
      icon: '🔍',
      shortcut: 'Ctrl+F',
      handler: () => openFindReplace()
    }
  ]

  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  showContextMenu.value = true
}

// 显示行右键菜单
function showRowContextMenu(event: MouseEvent, row: number) {
  contextMenuType.value = 'row'
  contextMenuTarget.value = { row }

  contextMenuItems.value = [
    {
      id: 'copy-row',
      label: '复制行',
      icon: '📋',
      handler: () => copyRow(row)
    },
    {
      id: 'paste-row',
      label: '粘贴行',
      icon: '📄',
      disabled: !clipboard.value || clipboard.value.type !== 'row',
      handler: () => pasteRow(row)
    },
    {
      id: 'cut-row',
      label: '剪切行',
      icon: '✂️',
      handler: () => cutRow(row)
    },
    {
      id: 'divider',
      label: '',
      divider: true
    },
    {
      id: 'insert-row-above',
      label: '在上方插入行',
      icon: '⬆️',
      handler: () => insertRow(row, 'above')
    },
    {
      id: 'insert-row-below',
      label: '在下方插入行',
      icon: '⬇️',
      shortcut: 'Alt+Enter',
      handler: () => insertRow(row, 'below')
    },
    {
      id: 'delete-row',
      label: '删除行',
      icon: '❌',
      handler: () => deleteRow(row)
    },
    {
      id: 'divider2',
      label: '',
      divider: true
    },
    {
      id: 'set-height',
      label: '设置行高',
      icon: '📏',
      handler: () => setRowHeight(row)
    },
    {
      id: 'auto-fit-height',
      label: '自动适应高度',
      icon: '⚡',
      handler: () => autoFitRow(row)
    }
  ]

  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  showContextMenu.value = true
}

// 显示列右键菜单
function showColumnContextMenu(event: MouseEvent, col: number) {
  contextMenuType.value = 'column'
  contextMenuTarget.value = { col }

  contextMenuItems.value = [
    {
      id: 'copy-col',
      label: '复制列',
      icon: '📋',
      handler: () => copyColumn(col)
    },
    {
      id: 'paste-col',
      label: '粘贴列',
      icon: '📄',
      disabled: !clipboard.value || clipboard.value.type !== 'column',
      handler: () => pasteColumn(col)
    },
    {
      id: 'cut-col',
      label: '剪切列',
      icon: '✂️',
      handler: () => cutColumn(col)
    },
    {
      id: 'divider',
      label: '',
      divider: true
    },
    {
      id: 'insert-col-left',
      label: '在左侧插入列',
      icon: '⬅️',
      shortcut: 'Ctrl+Shift+←',
      handler: () => insertColumn(col, 'left')
    },
    {
      id: 'insert-col-right',
      label: '在右侧插入列',
      icon: '➡️',
      shortcut: 'Ctrl+Shift+→',
      handler: () => insertColumn(col, 'right')
    },
    {
      id: 'delete-col',
      label: '删除列',
      icon: '❌',
      handler: () => deleteColumn(col)
    },
    {
      id: 'divider2',
      label: '',
      divider: true
    },
    {
      id: 'set-width',
      label: '设置列宽',
      icon: '📏',
      handler: () => setColumnWidth(col)
    },
    {
      id: 'auto-fit',
      label: '自动适应',
      icon: '⚡',
      handler: () => autoFitColumn(col)
    },
    {
      id: 'divider3',
      label: '',
      divider: true
    },
    {
      id: 'sort-asc',
      label: '升序排序',
      icon: '🔼',
      handler: () => sortColumn(col, 'asc')
    },
    {
      id: 'sort-desc',
      label: '降序排序',
      icon: '🔽',
      handler: () => sortColumn(col, 'desc')
    }
  ]

  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  showContextMenu.value = true
}

// 处理菜单选择
function handleMenuSelect(item: MenuItem) {
  // 菜单项的 handler 已经在定义时指定
  console.log('Menu selected:', item.id)
}

// 复制单元格
function copyCell(row: number, col: number) {
  clipboard.value = {
    type: 'cell',
    data: data.value[row]?.[col] || ''
  }
  alert('已复制单元格内容')
}

// 粘贴单元格
function pasteCell(row: number, col: number) {
  if (!clipboard.value) return

  saveUndo()
  if (!data.value[row]) {
    data.value[row] = Array(cols.value).fill('')
  }
  data.value[row][col] = clipboard.value.data
  recalculateAll()
}

// 剪切单元格
function cutCell(row: number, col: number) {
  copyCell(row, col)
  deleteCell(row, col)
}

// 删除单元格内容
function deleteCell(row: number, col: number) {
  saveUndo()
  if (data.value[row]) {
    data.value[row][col] = ''
  }
  recalculateAll()
}

// 复制行
function copyRow(row: number) {
  clipboard.value = {
    type: 'row',
    data: [...(data.value[row] || [])]
  }
  alert('已复制整行')
}

// 粘贴行
function pasteRow(row: number) {
  if (!clipboard.value || clipboard.value.type !== 'row') return

  saveUndo()
  data.value[row] = [...clipboard.value.data]
  recalculateAll()
}

// 剪切行
function cutRow(row: number) {
  copyRow(row)
  deleteRow(row)
}

// 复制列
function copyColumn(col: number) {
  const colData = data.value.map(row => row[col])
  clipboard.value = {
    type: 'column',
    data: colData
  }
  alert('已复制整列')
}

// 粘贴列
function pasteColumn(col: number) {
  if (!clipboard.value || clipboard.value.type !== 'column') return

  saveUndo()
  clipboard.value.data.forEach((value: any, row: number) => {
    if (data.value[row]) {
      data.value[row][col] = value
    }
  })
  recalculateAll()
}

// 剪切列
function cutColumn(col: number) {
  copyColumn(col)
  deleteColumn(col)
}

// 插入行
function insertRow(row: number, position: 'above' | 'below') {
  saveUndo()
  const newRow = Array(cols.value).fill('')
  const insertIndex = position === 'above' ? row : row + 1
  data.value.splice(insertIndex, 0, newRow)
  rows.value++
  recalculateAll()
}

// 删除行
function deleteRow(row: number) {
  if (rows.value <= 1) {
    alert('至少保留一行')
    return
  }

  saveUndo()
  data.value.splice(row, 1)
  rows.value--
  recalculateAll()
}

// 插入列
function insertColumn(col: number, position: 'left' | 'right') {
  saveUndo()
  const insertIndex = position === 'left' ? col : col + 1
  data.value.forEach(row => {
    row.splice(insertIndex, 0, '')
  })
  cols.value++
  recalculateAll()
}

// 删除列
function deleteColumn(col: number) {
  if (cols.value <= 1) {
    alert('至少保留一列')
    return
  }

  saveUndo()
  data.value.forEach(row => {
    row.splice(col, 1)
  })
  cols.value--
  recalculateAll()
}

// 排序列
function sortColumn(col: number, order: 'asc' | 'desc') {
  saveUndo()

  // 保存标题行
  const headerRow = data.value[0] ?? []
  const dataRows = data.value.slice(1)

  // 排序数据行
  dataRows.sort((a, b) => {
    const aVal = a[col]
    const bVal = b[col]

    // 处理数字排序
    const aNum = parseFloat(String(aVal ?? ''))
    const bNum = parseFloat(String(bVal ?? ''))

    if (!isNaN(aNum) && !isNaN(bNum)) {
      return order === 'asc' ? aNum - bNum : bNum - aNum
    }

    // 字符串排序
    const aStr = String(aVal || '')
    const bStr = String(bVal || '')

    if (order === 'asc') {
      return aStr.localeCompare(bStr)
    } else {
      return bStr.localeCompare(aStr)
    }
  })

  // 重新组合数据
  data.value = [headerRow, ...dataRows]
  recalculateAll()
}

// 键盘快捷键处理
function handleKeydown(event: KeyboardEvent) {
  const key = event.key
  const ctrl = event.ctrlKey || event.metaKey
  const shift = event.shiftKey
  const alt = event.altKey

  if (ctrl && key === 'z') {
    event.preventDefault()
    if (shift) {
      redo()
    } else {
      undo()
    }
  } else if (ctrl && key === 'y') {
    event.preventDefault()
    redo()
  } else if (ctrl && key === 'c') {
    event.preventDefault()
    const target = contextMenuTarget.value
    if (target && 'row' in target && 'col' in target) {
      copyCell(target.row!, target.col!)
    }
  } else if (ctrl && key === 'v') {
    event.preventDefault()
    const target = contextMenuTarget.value
    if (target && 'row' in target && 'col' in target) {
      pasteCell(target.row!, target.col!)
    }
  } else if (ctrl && key === 'x') {
    event.preventDefault()
    const target = contextMenuTarget.value
    if (target && 'row' in target && 'col' in target) {
      cutCell(target.row!, target.col!)
    }
  } else if (key === 'Delete') {
    event.preventDefault()
    const target = contextMenuTarget.value
    if (target && 'row' in target && 'col' in target) {
      deleteCell(target.row!, target.col!)
    }
  } else if (ctrl && key === 'b') {
    event.preventDefault()
    toggleBold()
  } else if (ctrl && key === 'i') {
    event.preventDefault()
    toggleItalic()
  } else if (ctrl && key === 'u') {
    event.preventDefault()
    toggleUnderline()
  } else if (ctrl && key === 'f') {
    event.preventDefault()
    openFindReplace()
  } else if (alt && key === 'Enter') {
    event.preventDefault()
    const target = contextMenuTarget.value
    if (target && 'row' in target) {
      insertRow(target.row!, 'below')
    }
  } else if (ctrl && shift && key === 'ArrowRight') {
    event.preventDefault()
    const target = contextMenuTarget.value
    if (target && 'col' in target) {
      insertColumn(target.col!, 'right')
    }
  } else if (ctrl && shift && key === 'ArrowLeft') {
    event.preventDefault()
    const target = contextMenuTarget.value
    if (target && 'col' in target) {
      insertColumn(target.col!, 'left')
    }
  }
}

// 格式化功能
function toggleBold() {
  const target = contextMenuTarget.value
  if (target && 'row' in target && 'col' in target) {
    const cellKey = `${target.row}_${target.col}`
    if (!cellStyles.value[cellKey]) {
      cellStyles.value[cellKey] = {}
    }
    cellStyles.value[cellKey].fontWeight =
      cellStyles.value[cellKey].fontWeight === 'bold' ? 'normal' : 'bold'
    saveToHistory('格式化')
  }
}

function toggleItalic() {
  const target = contextMenuTarget.value
  if (target && 'row' in target && 'col' in target) {
    const cellKey = `${target.row}_${target.col}`
    if (!cellStyles.value[cellKey]) {
      cellStyles.value[cellKey] = {}
    }
    cellStyles.value[cellKey].fontStyle =
      cellStyles.value[cellKey].fontStyle === 'italic' ? 'normal' : 'italic'
    saveToHistory('格式化')
  }
}

function toggleUnderline() {
  const target = contextMenuTarget.value
  if (target && 'row' in target && 'col' in target) {
    const cellKey = `${target.row}_${target.col}`
    if (!cellStyles.value[cellKey]) {
      cellStyles.value[cellKey] = {}
    }
    cellStyles.value[cellKey].textDecoration =
      cellStyles.value[cellKey].textDecoration === 'underline' ? 'none' : 'underline'
    saveToHistory('格式化')
  }
}

// 合并单元格功能
function mergeCells(row: number, col: number) {
  // 这里简单实现合并选中的单元格
  const cellKey = `${row}_${col}`
  mergedCells.value.add(cellKey)
  saveToHistory('合并单元格')
}

function unmergeCells(row: number, col: number) {
  const cellKey = `${row}_${col}`
  mergedCells.value.delete(cellKey)
  saveToHistory('取消合并')
}

// 查找和替换功能
function openFindReplace() {
  // 这里可以打开一个查找替换对话框
  const searchText = prompt('查找内容:')
  if (searchText) {
    const replaceText = prompt('替换为:')
    if (replaceText !== null) {
      let replacements = 0
      for (let r = 0; r < rows.value; r++) {
        for (let c = 0; c < cols.value; c++) {
          const cellValue = getCellValue(r, c)
          if (cellValue && cellValue.toString().includes(searchText)) {
            setCellValue(r, c, cellValue.toString().replace(searchText, replaceText))
            replacements++
          }
        }
      }
      if (replacements > 0) {
        saveToHistory(`查找替换 (${replacements} 处)`)
        alert(`已替换 ${replacements} 处`)
      } else {
        alert('未找到匹配项')
      }
    }
  }
}

// 设置列宽和行高
function setColumnWidth(col: number) {
  const width = prompt('设置列宽 (像素):', '100')
  if (width && !isNaN(parseInt(width))) {
    columnWidths.value[col] = parseInt(width)
    saveToHistory('设置列宽')
  }
}

function setRowHeight(row: number) {
  const height = prompt('设置行高 (像素):', '30')
  if (height && !isNaN(parseInt(height))) {
    rowHeights.value[row] = parseInt(height)
    saveToHistory('设置行高')
  }
}

function autoFitColumn(col: number) {
  // 自动适应列宽
  let maxWidth = 50
  for (let r = 0; r < rows.value; r++) {
    const content = getCellValue(r, col)
    if (content) {
      const width = content.toString().length * 8 + 20
      maxWidth = Math.max(maxWidth, Math.min(width, 300))
    }
  }
  columnWidths.value[col] = maxWidth
  saveToHistory('自动适应列宽')
}

function autoFitRow(row: number) {
  // 自动适应行高
  rowHeights.value[row] = 30 // 默认高度
  saveToHistory('自动适应行高')
}

// 组件挂载
onMounted(() => {
  loadSavedData()
  loadVersionHistory()
  loadSnapshots()

  if (autoSaveEnabled.value) {
    startAutoSave()
  }

  // 添加键盘事件监听
  document.addEventListener('keydown', handleKeydown)
})

// 组件卸载
onUnmounted(() => {
  stopAutoSave()
  // 移除键盘事件监听
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.enhanced-grid-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f5f5f7;
}

.top-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: white;
  border-bottom: 1px solid #e0e0e0;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn {
  padding: 5px 10px;
  background: white;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.btn:hover:not(:disabled) {
  background: #f3f4f6;
  border-color: #9ca3af;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn.primary {
  background: #667eea;
  color: white;
  border-color: #667eea;
}

.btn.primary:hover {
  background: #5a67d8;
}

.btn.warning {
  background: #f59e0b;
  color: white;
  border-color: #f59e0b;
}

.btn.warning:hover {
  background: #d97706;
}

.separator {
  width: 1px;
  height: 20px;
  background: #e5e7eb;
  margin: 0 2px;
}

.info-text {
  color: #6b7280;
  font-size: 13px;
}

.auto-save-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #6b7280;
  cursor: pointer;
}

.auto-save-toggle input {
  cursor: pointer;
}

.formula-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: white;
  border-bottom: 1px solid #e0e0e0;
}

.cell-label {
  font-weight: 500;
  color: #374151;
  min-width: 50px;
  text-align: center;
  padding: 4px 8px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
}

.formula-input-wrapper {
  flex: 1;
}

.formula-input {
  width: 100%;
  padding: 4px 8px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-family: 'Monaco', 'Courier New', monospace;
  font-size: 13px;
}

.formula-input:focus {
  outline: none;
  border-color: #667eea;
}

.help-btn {
  padding: 4px 8px;
  background: #f3f4f6;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
}

.help-btn:hover {
  background: #e5e7eb;
}

.main-content {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.grid-area {
  flex: 1;
  padding: 12px;
  transition: margin-right 0.3s;
}

.grid-area.with-sidebar {
  margin-right: 360px;
}

.table-container {
  height: 100%;
  overflow: auto;
  background: white;
  border: 1px solid #e0e0e0;
  border-radius: 4px;
}

.spreadsheet-table {
  border-collapse: collapse;
  font-family: 'Monaco', 'Courier New', monospace;
  font-size: 13px;
}

.spreadsheet-table th,
.spreadsheet-table td {
  border: 1px solid #e5e7eb;
  min-width: 80px;
  height: 28px;
  text-align: center;
  position: relative;
}

.row-header,
.col-header {
  background: #f9fafb;
  font-weight: 500;
  color: #6b7280;
  min-width: 40px !important;
  user-select: none;
  font-size: 12px;
}

.cell {
  background: white;
  cursor: cell;
  padding: 0;
}

.cell:hover:not(.readonly) {
  background: #f9fafb;
}

.cell.selected {
  outline: 2px solid #667eea;
  outline-offset: -1px;
  z-index: 1;
}

.cell.readonly {
  background: #f9fafb;
  cursor: not-allowed;
}

.cell-input {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  padding: 4px;
  font: inherit;
  background: white;
}

.cell-value {
  display: block;
  padding: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 360px;
  background: white;
  border-left: 1px solid #e0e0e0;
  box-shadow: -2px 0 8px rgba(0,0,0,0.05);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  z-index: 100;
}

.sidebar-content {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.sidebar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #e0e0e0;
  background: #f9fafb;
}

.sidebar-header h3 {
  margin: 0;
  font-size: 16px;
  color: #1f2937;
}

.close-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  font-size: 20px;
  cursor: pointer;
  color: #6b7280;
  border-radius: 4px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: #e5e7eb;
  color: #1f2937;
}

.version-list,
.snapshot-list,
.formula-help {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.version-item,
.snapshot-item {
  padding: 10px;
  margin-bottom: 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.version-item:hover,
.snapshot-item:hover {
  background: #f9fafb;
  border-color: #667eea;
}

.version-item.active {
  background: #eff1ff;
  border-color: #667eea;
}

.version-header,
.snapshot-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.version-label,
.snapshot-name {
  font-weight: 500;
  color: #1f2937;
  font-size: 14px;
}

.version-time,
.snapshot-size {
  font-size: 11px;
  color: #6b7280;
}

.version-info,
.snapshot-info {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 6px;
}

.version-type {
  padding: 2px 6px;
  background: #f3f4f6;
  border-radius: 3px;
  font-size: 11px;
}

.version-desc {
  font-size: 12px;
  color: #4b5563;
  margin-bottom: 6px;
}

.version-actions,
.snapshot-actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}

.link-btn {
  background: none;
  border: none;
  color: #667eea;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  transition: color 0.2s;
}

.link-btn:hover {
  color: #5a67d8;
  text-decoration: underline;
}

.link-btn.danger {
  color: #ef4444;
}

.link-btn.danger:hover {
  color: #dc2626;
}

.formula-category {
  margin-bottom: 16px;
}

.formula-category h4 {
  margin: 0 0 8px 0;
  font-size: 14px;
  color: #374151;
}

.formula-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.formula-item {
  padding: 8px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}

.formula-item:hover {
  background: #eff1ff;
  border-color: #667eea;
}

.formula-item strong {
  color: #1f2937;
  display: block;
  margin-bottom: 2px;
}

.formula-item code {
  display: block;
  font-size: 11px;
  color: #6b7280;
  margin-top: 4px;
  padding: 2px 4px;
  background: white;
  border-radius: 2px;
}

.status-bar {
  display: flex;
  gap: 16px;
  padding: 4px 12px;
  background: #f9fafb;
  border-top: 1px solid #e0e0e0;
  font-size: 12px;
  color: #6b7280;
}

/* 动画 */
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.3s;
}

.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
}
</style>
