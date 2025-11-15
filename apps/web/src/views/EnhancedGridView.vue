<template>
  <div class="enhanced-grid-container">
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
        <button @click="importData" class="btn">
          📥 导入
        </button>
        <button @click="exportData" class="btn">
          📤 导出
        </button>
      </div>

      <div class="toolbar-right">
        <span class="info-text">{{ getCurrentMode() }}</span>
        <button v-if="currentVersion" @click="exitVersionView" class="btn warning">
          退出版本查看
        </button>
      </div>
    </div>

    <!-- 主体区域 -->
    <div class="main-content">
      <!-- 表格区域 -->
      <div class="grid-area" :class="{ 'with-sidebar': showSidebar }">
        <GridView ref="gridViewRef" :data="currentData" :readonly="isReadonly" />
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
        </div>
      </transition>
    </div>

    <!-- 版本对比模态框 -->
    <div v-if="showCompareModal" class="modal-overlay" @click="closeCompareModal">
      <div class="modal-content" @click.stop>
        <div class="modal-header">
          <h2>版本对比</h2>
          <button @click="closeCompareModal" class="close-btn">×</button>
        </div>
        <div class="modal-body">
          <div class="compare-container">
            <div class="compare-side">
              <h4>当前版本</h4>
              <div class="compare-grid">
                <!-- 显示当前版本数据 -->
                <pre>{{ JSON.stringify(currentData, null, 2) }}</pre>
              </div>
            </div>
            <div class="compare-side">
              <h4>{{ compareVersion?.label }}</h4>
              <div class="compare-grid">
                <!-- 显示对比版本数据 -->
                <pre>{{ JSON.stringify(compareVersion?.data, null, 2) }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import GridView from './GridView.vue'

interface Version {
  id: string
  label: string
  author: string
  type: 'auto' | 'manual' | 'snapshot'
  createdAt: Date
  description?: string
  data: any
}

interface Snapshot {
  id: string
  name: string
  size: number
  rowCount: number
  createdAt: Date
  data: any
}

// 组件引用
const gridViewRef = ref()

// 数据状态
const currentData = ref<any[][]>([])
const originalData = ref<any[][]>([])
const currentVersion = ref<Version | null>(null)
const isReadonly = ref(false)

// UI状态
const showSidebar = ref(false)
const sidebarMode = ref<'history' | 'snapshots'>('history')
const showCompareModal = ref(false)
const compareVersion = ref<Version | null>(null)

// 版本和快照数据
const versionHistory = ref<Version[]>([])
const snapshots = ref<Snapshot[]>([])

// 自动保存计时器
let autoSaveTimer: any = null
const autoSaveInterval = 30000 // 30秒

// 初始化
onMounted(() => {
  loadInitialData()
  loadVersionHistory()
  loadSnapshots()
  startAutoSave()
})

// 加载初始数据
function loadInitialData() {
  // 从本地存储或服务器加载数据
  const savedData = localStorage.getItem('enhancedGridData')
  if (savedData) {
    try {
      currentData.value = JSON.parse(savedData)
      originalData.value = JSON.parse(savedData)
    } catch (error) {
      console.error('Failed to load saved data:', error)
      initDefaultData()
    }
  } else {
    initDefaultData()
  }
}

// 初始化默认数据
function initDefaultData() {
  currentData.value = [
    ['产品', '数量', '单价', '总价'],
    ['产品A', '10', '100', '=B2*C2'],
    ['产品B', '20', '150', '=B3*C3'],
    ['产品C', '15', '200', '=B4*C4']
  ]
  originalData.value = [...currentData.value]
}

// 加载版本历史
function loadVersionHistory() {
  // 从本地存储加载版本历史
  const saved = localStorage.getItem('versionHistory')
  if (saved) {
    try {
      versionHistory.value = JSON.parse(saved)
    } catch (error) {
      console.error('Failed to load version history:', error)
    }
  }

  // 如果没有历史，创建初始版本
  if (versionHistory.value.length === 0) {
    versionHistory.value = [
      {
        id: 'v1',
        label: 'v1.0.0',
        author: '系统',
        type: 'auto',
        createdAt: new Date(),
        description: '初始版本',
        data: [...originalData.value]
      }
    ]
  }
}

// 加载快照列表
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

// 保存数据
async function saveData() {
  try {
    // 获取当前表格数据
    const gridData = gridViewRef.value?.getData() || currentData.value

    // 保存到本地存储
    localStorage.setItem('enhancedGridData', JSON.stringify(gridData))

    // 创建新版本
    const newVersion: Version = {
      id: `v${versionHistory.value.length + 1}`,
      label: `v1.${versionHistory.value.length}.0`,
      author: '用户',
      type: 'manual',
      createdAt: new Date(),
      description: '手动保存',
      data: [...gridData]
    }

    versionHistory.value.unshift(newVersion)
    localStorage.setItem('versionHistory', JSON.stringify(versionHistory.value))

    alert('保存成功！')
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
async function createSnapshot() {
  const name = prompt('请输入快照名称:')
  if (!name) return

  const gridData = gridViewRef.value?.getData() || currentData.value

  const snapshot: Snapshot = {
    id: `snap_${Date.now()}`,
    name,
    size: JSON.stringify(gridData).length,
    rowCount: gridData.length,
    createdAt: new Date(),
    data: [...gridData]
  }

  snapshots.value.unshift(snapshot)
  localStorage.setItem('snapshots', JSON.stringify(snapshots.value))

  alert('快照创建成功！')

  // 显示快照列表
  showSidebar.value = true
  sidebarMode.value = 'snapshots'
}

// 加载版本
function loadVersion(version: Version) {
  currentVersion.value = version
  currentData.value = [...version.data]
  isReadonly.value = true
}

// 退出版本查看
function exitVersionView() {
  currentVersion.value = null
  loadInitialData()
  isReadonly.value = false
}

// 对比版本
function compareWithVersion(version: Version) {
  compareVersion.value = version
  showCompareModal.value = true
}

// 恢复版本
async function restoreVersion(version: Version) {
  if (!confirm(`确定要恢复到版本 ${version.label} 吗？`)) return

  // 先创建当前状态的备份
  await createSnapshot()

  // 恢复到指定版本
  currentData.value = [...version.data]
  localStorage.setItem('enhancedGridData', JSON.stringify(currentData.value))

  // 创建恢复记录
  const restoreVersion: Version = {
    id: `v${versionHistory.value.length + 1}`,
    label: `v1.${versionHistory.value.length}.0`,
    author: '系统',
    type: 'manual',
    createdAt: new Date(),
    description: `恢复自 ${version.label}`,
    data: [...version.data]
  }

  versionHistory.value.unshift(restoreVersion)
  localStorage.setItem('versionHistory', JSON.stringify(versionHistory.value))

  alert('版本恢复成功！')
  closeSidebar()
}

// 加载快照
function loadSnapshot(snapshot: Snapshot) {
  currentData.value = [...snapshot.data]
  closeSidebar()
}

// 下载快照
function downloadSnapshot(snapshot: Snapshot) {
  const dataStr = JSON.stringify(snapshot.data, null, 2)
  const dataBlob = new Blob([dataStr], { type: 'application/json' })
  const url = URL.createObjectURL(dataBlob)
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
    alert('快照已删除')
  }
}

// 导入数据
function importData() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,.csv,.xlsx'
  input.onchange = (e: any) => {
    const file = e.target.files[0]
    if (file) {
      const reader = new FileReader()
      reader.onload = (event) => {
        try {
          const data = JSON.parse(event.target?.result as string)
          currentData.value = data
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
  const data = gridViewRef.value?.getData() || currentData.value
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `spreadsheet_${Date.now()}.json`
  link.click()
  URL.revokeObjectURL(url)
}

// 自动保存
function startAutoSave() {
  autoSaveTimer = setInterval(() => {
    if (!isReadonly.value && hasChanges()) {
      autoSave()
    }
  }, autoSaveInterval)
}

// 执行自动保存
function autoSave() {
  const gridData = gridViewRef.value?.getData() || currentData.value

  // 创建自动保存版本
  const autoVersion: Version = {
    id: `auto_${Date.now()}`,
    label: `自动保存`,
    author: '系统',
    type: 'auto',
    createdAt: new Date(),
    data: [...gridData]
  }

  // 限制自动保存版本数量
  const autoVersions = versionHistory.value.filter(v => v.type === 'auto')
  if (autoVersions.length >= 10) {
    // 删除最旧的自动保存版本
    const oldestAuto = autoVersions[autoVersions.length - 1]!
    const index = versionHistory.value.findIndex(v => v.id === oldestAuto.id)
    if (index > -1) {
      versionHistory.value.splice(index, 1)
    }
  }

  versionHistory.value.unshift(autoVersion)
  localStorage.setItem('versionHistory', JSON.stringify(versionHistory.value))
  localStorage.setItem('enhancedGridData', JSON.stringify(gridData))
}

// 检查是否有更改
function hasChanges(): boolean {
  const current = JSON.stringify(currentData.value)
  const original = JSON.stringify(originalData.value)
  return current !== original
}

// 关闭侧边栏
function closeSidebar() {
  showSidebar.value = false
}

// 关闭对比模态框
function closeCompareModal() {
  showCompareModal.value = false
  compareVersion.value = null
}

// 获取当前模式
function getCurrentMode(): string {
  if (currentVersion.value) {
    return `查看版本: ${currentVersion.value.label}`
  }
  return '编辑模式'
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

// 清理定时器
onUnmounted(() => {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer)
  }
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
  padding: 12px 16px;
  background: white;
  border-bottom: 1px solid #e0e0e0;
  box-shadow: 0 2px 4px rgba(0,0,0,0.05);
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn {
  padding: 6px 12px;
  background: white;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.btn:hover {
  background: #f3f4f6;
  border-color: #9ca3af;
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
  height: 24px;
  background: #e5e7eb;
  margin: 0 4px;
}

.info-text {
  color: #6b7280;
  font-size: 14px;
}

.main-content {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.grid-area {
  flex: 1;
  padding: 16px;
  transition: margin-right 0.3s;
}

.grid-area.with-sidebar {
  margin-right: 360px;
}

.sidebar {
  position: fixed;
  right: 0;
  top: 60px;
  bottom: 0;
  width: 360px;
  background: white;
  border-left: 1px solid #e0e0e0;
  box-shadow: -4px 0 8px rgba(0,0,0,0.05);
  overflow: hidden;
  display: flex;
  flex-direction: column;
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
  padding: 16px;
  border-bottom: 1px solid #e0e0e0;
}

.sidebar-header h3 {
  margin: 0;
  font-size: 18px;
  color: #1f2937;
}

.close-btn {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  font-size: 24px;
  cursor: pointer;
  color: #6b7280;
  border-radius: 4px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: #f3f4f6;
  color: #1f2937;
}

.version-list,
.snapshot-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.version-item,
.snapshot-item {
  padding: 12px;
  margin-bottom: 8px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
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
  margin-bottom: 8px;
}

.version-label,
.snapshot-name {
  font-weight: 500;
  color: #1f2937;
}

.version-time,
.snapshot-size {
  font-size: 12px;
  color: #6b7280;
}

.version-info,
.snapshot-info {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: #6b7280;
  margin-bottom: 8px;
}

.version-type {
  padding: 2px 6px;
  background: #f3f4f6;
  border-radius: 4px;
  font-size: 11px;
}

.version-desc {
  font-size: 13px;
  color: #4b5563;
  margin-bottom: 8px;
}

.version-actions,
.snapshot-actions {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}

.link-btn {
  background: none;
  border: none;
  color: #667eea;
  font-size: 13px;
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

/* 模态框样式 */
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
  z-index: 1000;
}

.modal-content {
  background: white;
  border-radius: 12px;
  width: 90%;
  max-width: 1200px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  border-bottom: 1px solid #e0e0e0;
}

.modal-header h2 {
  margin: 0;
  font-size: 20px;
  color: #1f2937;
}

.modal-body {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
}

.compare-container {
  display: flex;
  gap: 24px;
  height: 100%;
}

.compare-side {
  flex: 1;
}

.compare-side h4 {
  margin: 0 0 12px 0;
  color: #1f2937;
}

.compare-grid {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 12px;
  height: calc(100% - 32px);
  overflow: auto;
}

.compare-grid pre {
  margin: 0;
  font-size: 12px;
  font-family: 'Monaco', 'Courier New', monospace;
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