<template>
  <div class="kanban-container">
    <div class="kanban-header">
      <h2>看板视图</h2>
      <button @click="addColumn" class="add-column-btn">+ 添加列</button>
    </div>

    <div v-if="loading" class="loading">加载看板数据中...</div>

    <div v-else-if="error" class="error">
      {{ error }}
    </div>

    <div v-else class="kanban-board">
      <div
        v-for="column in columns"
        :key="column.id"
        class="kanban-column"
        @drop="handleDrop($event, column.id)"
        @dragover.prevent
        @dragenter.prevent
      >
        <div class="column-header">
          <h3>{{ column.title }}</h3>
          <span class="card-count">{{ column.cards.length }}</span>
        </div>

        <div class="cards-container">
          <div
            v-for="card in column.cards"
            :key="card.id"
            class="kanban-card"
            draggable="true"
            @dragstart="handleDragStart($event, card, column.id)"
          >
            <h4>{{ card.title }}</h4>
            <p>{{ card.content }}</p>
            <div class="card-footer">
              <span class="card-id">#{{ card.id }}</span>
              <span class="card-status" :class="card.status">
                {{ getStatusLabel(card.status) }}
              </span>
            </div>
          </div>
        </div>

        <button @click="addCard(column.id)" class="add-card-btn">
          + 添加卡片
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useRoute } from 'vue-router'

interface Card {
  id: string
  title: string
  content: string
  status: string
}

interface Column {
  id: string
  title: string
  cards: Card[]
  order: number
}

const columns = ref<Column[]>([])
const loading = ref(true)
const error = ref('')
const draggedCard = ref<{ card: Card; fromColumn: string } | null>(null)
const route = useRoute()
const viewId = computed(() => {
  const id = route.params.viewId
  return typeof id === 'string' ? id : 'kanban1'
})
const storageKey = computed(() => `kanban:${viewId.value}`)

function debounce<T extends (...args: any[]) => any>(fn: T, wait = 400) {
  let t: number | undefined
  return (...args: Parameters<T>) => {
    if (t) window.clearTimeout(t)
    t = window.setTimeout(() => fn(...args), wait)
  }
}

function loadFromStorage(): Column[] | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(storageKey.value)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed as Column[]
  } catch {
    return null
  }
}

const persistColumns = debounce(() => {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey.value, JSON.stringify(columns.value))
  } catch {
    // ignore storage failures
  }
}, 300)

// 获取看板数据
async function fetchKanbanData() {
  const cached = loadFromStorage()
  if (cached && cached.length > 0) {
    columns.value = cached
    loading.value = false
    return
  }
  try {
    const response = await fetch('http://localhost:8900/api/kanban/board1')
    const result = await response.json()

    if (result.success && result.data) {
      columns.value = result.data.sort((a: Column, b: Column) => a.order - b.order)
      persistColumns()
    } else {
      // 使用模拟数据
      columns.value = [
        {
          id: 'todo',
          title: '待处理',
          cards: [
            { id: '1', title: '设计数据库架构', content: '设计插件系统的数据库表结构', status: 'todo' },
            { id: '2', title: '实现权限系统', content: '实现基于角色的访问控制', status: 'todo' }
          ],
          order: 1
        },
        {
          id: 'in_progress',
          title: '进行中',
          cards: [
            { id: '3', title: '开发插件加载器', content: '实现插件的动态加载和卸载功能', status: 'in_progress' }
          ],
          order: 2
        },
        {
          id: 'done',
          title: '已完成',
          cards: [
            { id: '4', title: '项目初始化', content: '创建项目结构和基础配置', status: 'done' },
            { id: '5', title: '微内核设计', content: '完成微内核架构设计', status: 'done' }
          ],
          order: 3
        }
      ]
      persistColumns()
    }
  } catch (err) {
    console.error('Failed to fetch kanban data:', err)
    error.value = '无法连接到服务器，使用演示数据'

    // 使用默认数据
    columns.value = [
      {
        id: 'todo',
        title: '待处理',
        cards: [
          { id: '1', title: '任务示例', content: '这是一个待处理的任务', status: 'todo' }
        ],
        order: 1
      },
      {
        id: 'in_progress',
        title: '进行中',
        cards: [],
        order: 2
      },
      {
        id: 'done',
        title: '已完成',
        cards: [],
        order: 3
      }
    ]
    persistColumns()
  } finally {
    loading.value = false
  }
}

// 拖拽开始
function handleDragStart(event: DragEvent, card: Card, columnId: string) {
  draggedCard.value = { card, fromColumn: columnId }
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
  }
}

// 拖拽释放
function handleDrop(event: DragEvent, toColumnId: string) {
  event.preventDefault()

  if (!draggedCard.value) return

  const { card, fromColumn } = draggedCard.value

  // 从原列中移除
  const sourceCol = columns.value.find(col => col.id === fromColumn)
  if (sourceCol) {
    const index = sourceCol.cards.findIndex(c => c.id === card.id)
    if (index > -1) {
      sourceCol.cards.splice(index, 1)
    }
  }

  // 添加到目标列
  const targetCol = columns.value.find(col => col.id === toColumnId)
  if (targetCol) {
    card.status = toColumnId
    targetCol.cards.push(card)
  }

  draggedCard.value = null

  // TODO: 发送更新到服务器
  console.log(`Moved card ${card.id} from ${fromColumn} to ${toColumnId}`)
  persistColumns()
}

// 添加新列
function addColumn() {
  const newColumn: Column = {
    id: `col_${Date.now()}`,
    title: '新列',
    cards: [],
    order: columns.value.length + 1
  }
  columns.value.push(newColumn)
  persistColumns()
}

// 添加新卡片
function addCard(columnId: string) {
  const column = columns.value.find(col => col.id === columnId)
  if (column) {
    const newCard: Card = {
      id: `card_${Date.now()}`,
      title: '新任务',
      content: '点击编辑任务内容',
      status: columnId
    }
    column.cards.push(newCard)
    persistColumns()
  }
}

// 获取状态标签
function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    todo: '待处理',
    in_progress: '进行中',
    done: '已完成'
  }
  return labels[status] || status
}

onMounted(() => {
  fetchKanbanData()
})

watch(
  () => storageKey.value,
  () => {
    const cached = loadFromStorage()
    if (cached) columns.value = cached
  }
)
</script>

<style scoped>
.kanban-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.kanban-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.kanban-header h2 {
  margin: 0;
  color: #333;
}

.add-column-btn {
  padding: 0.5rem 1rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.3s;
}

.add-column-btn:hover {
  background: #5a67d8;
}

.kanban-board {
  display: flex;
  gap: 1rem;
  overflow-x: auto;
  flex: 1;
  padding-bottom: 1rem;
}

.kanban-column {
  min-width: 300px;
  background: #f8f9fa;
  border-radius: 8px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
}

.column-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 2px solid #e0e0e0;
}

.column-header h3 {
  margin: 0;
  color: #333;
  font-size: 1.1rem;
}

.card-count {
  background: #667eea;
  color: white;
  padding: 0.2rem 0.5rem;
  border-radius: 12px;
  font-size: 0.85rem;
  font-weight: 500;
}

.cards-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 200px;
}

.kanban-card {
  background: white;
  border-radius: 6px;
  padding: 1rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  cursor: move;
  transition: all 0.3s;
}

.kanban-card:hover {
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
  transform: translateY(-2px);
}

.kanban-card h4 {
  margin: 0 0 0.5rem 0;
  color: #333;
  font-size: 1rem;
}

.kanban-card p {
  margin: 0 0 0.75rem 0;
  color: #666;
  font-size: 0.9rem;
  line-height: 1.4;
}

.card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-id {
  color: #999;
  font-size: 0.8rem;
}

.card-status {
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-weight: 500;
}

.card-status.todo {
  background: #fef3c7;
  color: #92400e;
}

.card-status.in_progress {
  background: #dbeafe;
  color: #1e40af;
}

.card-status.done {
  background: #d1fae5;
  color: #065f46;
}

.add-card-btn {
  margin-top: 0.75rem;
  padding: 0.5rem;
  background: transparent;
  border: 2px dashed #ccc;
  border-radius: 6px;
  color: #666;
  cursor: pointer;
  transition: all 0.3s;
  font-size: 0.9rem;
}

.add-card-btn:hover {
  border-color: #667eea;
  color: #667eea;
  background: rgba(102, 126, 234, 0.05);
}

.loading,
.error {
  text-align: center;
  padding: 3rem;
  color: #666;
  font-size: 1.1rem;
}

.error {
  color: #ef4444;
}

/* 滚动条样式 */
.kanban-board::-webkit-scrollbar {
  height: 8px;
}

.kanban-board::-webkit-scrollbar-track {
  background: #f1f1f1;
  border-radius: 4px;
}

.kanban-board::-webkit-scrollbar-thumb {
  background: #888;
  border-radius: 4px;
}

.kanban-board::-webkit-scrollbar-thumb:hover {
  background: #555;
}
</style>
