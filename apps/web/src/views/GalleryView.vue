<template>
  <div class="gallery-container">
    <!-- Gallery Header -->
    <div class="gallery-header">
      <div class="header-left">
        <h2>{{ config?.name || '图库视图' }}</h2>
        <span v-if="totalItems > 0" class="item-count">{{ totalItems }} 项</span>
      </div>

      <div class="header-right">
        <!-- Layout Controls -->
        <div class="layout-controls">
          <label class="control-label">布局:</label>
          <select v-model="localConfig.layout.columns" @change="updateConfig" class="columns-select">
            <option :value="2">2列</option>
            <option :value="3">3列</option>
            <option :value="4">4列</option>
            <option :value="5">5列</option>
            <option :value="6">6列</option>
          </select>

          <select v-model="localConfig.layout.cardSize" @change="updateConfig" class="size-select">
            <option value="small">小</option>
            <option value="medium">中</option>
            <option value="large">大</option>
          </select>
        </div>

        <!-- Search -->
        <div class="search-box">
          <input
            v-model="searchQuery"
            @input="handleSearch"
            type="text"
            placeholder="搜索..."
            class="search-input"
          />
        </div>

        <!-- View Options -->
        <button @click="showConfigModal = true" class="config-btn">
          ⚙️ 配置
        </button>
      </div>
    </div>

    <!-- Filters -->
    <div v-if="appliedFilters.length > 0" class="filters-bar">
      <div class="filter-tags">
        <span
          v-for="filter in appliedFilters"
          :key="`${filter.field}_${filter.value}`"
          class="filter-tag"
        >
          {{ filter.field }}: {{ filter.value }}
          <button @click="removeFilter(filter)" class="remove-filter">×</button>
        </span>
      </div>
      <button @click="clearAllFilters" class="clear-filters">清除所有筛选</button>
    </div>

    <!-- Loading State -->
    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <p>加载图库数据中...</p>
    </div>

    <!-- Error State -->
    <div v-else-if="error" class="error-state">
      <p class="error-message">{{ error }}</p>
      <button @click="loadData" class="retry-btn">重试</button>
    </div>

    <!-- Empty State -->
    <div v-else-if="cards.length === 0" class="empty-state">
      <div class="empty-icon">🖼️</div>
      <h3>暂无数据</h3>
      <p>暂时没有可显示的项目</p>
    </div>

    <!-- Gallery Grid -->
    <div v-else class="gallery-grid" :class="gridClass">
      <div
        v-for="card in cards"
        :key="card.id"
        class="gallery-card"
        :class="cardClass"
        @click="openDetailModal(card)"
      >
        <!-- Card Image -->
        <div v-if="card.image && localConfig.display.showImage" class="card-image">
          <img :src="card.image" :alt="card.title" @error="handleImageError" />
        </div>

        <!-- Card Content -->
        <div class="card-content">
          <h3 v-if="localConfig.display.showTitle" class="card-title">
            {{ card.title }}
          </h3>

          <div v-if="localConfig.display.showContent" class="card-body">
            <div
              v-for="(content, index) in card.content"
              :key="index"
              class="content-item"
            >
              {{ truncateText(content) }}
            </div>
          </div>

          <div v-if="card.tags && localConfig.display.showTags" class="card-tags">
            <span
              v-for="tag in card.tags"
              :key="tag"
              class="tag"
              @click.stop="addTagFilter(tag)"
            >
              {{ tag }}
            </span>
          </div>

          <!-- Card Footer -->
          <div class="card-footer">
            <span v-if="card.metadata?.createdAt" class="card-date">
              {{ formatDate(card.metadata.createdAt) }}
            </span>
            <span v-if="card.metadata?.author" class="card-author">
              {{ card.metadata.author }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="pagination">
      <button
        :disabled="currentPage <= 1"
        @click="changePage(currentPage - 1)"
        class="page-btn"
      >
        上一页
      </button>

      <span class="page-info">
        第 {{ currentPage }} 页，共 {{ totalPages }} 页
      </span>

      <button
        :disabled="currentPage >= totalPages"
        @click="changePage(currentPage + 1)"
        class="page-btn"
      >
        下一页
      </button>
    </div>

    <!-- Detail Modal -->
    <div v-if="selectedCard" class="modal-overlay" @click="closeDetailModal">
      <div class="detail-modal" @click.stop>
        <div class="modal-header">
          <h2>{{ selectedCard.title }}</h2>
          <button @click="closeDetailModal" class="close-btn">×</button>
        </div>

        <div class="modal-body">
          <div v-if="selectedCard.image" class="detail-image">
            <img :src="selectedCard.image" :alt="selectedCard.title" />
          </div>

          <div class="detail-content">
            <div
              v-for="(content, index) in selectedCard.content"
              :key="index"
              class="detail-item"
            >
              {{ content }}
            </div>
          </div>

          <div v-if="selectedCard.tags" class="detail-tags">
            <span v-for="tag in selectedCard.tags" :key="tag" class="tag">
              {{ tag }}
            </span>
          </div>

          <!-- Raw Data -->
          <details class="raw-data">
            <summary>原始数据</summary>
            <pre>{{ JSON.stringify(selectedCard.data, null, 2) }}</pre>
          </details>
        </div>
      </div>
    </div>

    <!-- Configuration Modal -->
    <div v-if="showConfigModal" class="modal-overlay" @click="closeConfigModal">
      <div class="config-modal" @click.stop>
        <div class="modal-header">
          <h2>图库配置</h2>
          <button @click="closeConfigModal" class="close-btn">×</button>
        </div>

        <div class="modal-body">
          <!-- Card Template Configuration -->
          <div class="config-section">
            <h3>卡片模板</h3>
            <div class="form-group">
              <label>标题字段:</label>
              <select v-model="localConfig.cardTemplate.titleField">
                <option v-for="field in availableFields" :key="field" :value="field">
                  {{ field }}
                </option>
              </select>
            </div>

            <div class="form-group">
              <label>图片字段:</label>
              <select v-model="localConfig.cardTemplate.imageField">
                <option value="">无</option>
                <option v-for="field in availableFields" :key="field" :value="field">
                  {{ field }}
                </option>
              </select>
            </div>
          </div>

          <!-- Display Options -->
          <div class="config-section">
            <h3>显示选项</h3>
            <div class="checkbox-group">
              <label>
                <input type="checkbox" v-model="localConfig.display.showTitle" />
                显示标题
              </label>
              <label>
                <input type="checkbox" v-model="localConfig.display.showContent" />
                显示内容
              </label>
              <label>
                <input type="checkbox" v-model="localConfig.display.showImage" />
                显示图片
              </label>
              <label>
                <input type="checkbox" v-model="localConfig.display.showTags" />
                显示标签
              </label>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button @click="saveConfig" class="save-btn">保存</button>
          <button @click="closeConfigModal" class="cancel-btn">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { GalleryConfig, GalleryCard } from '../types/views'
import { ViewManager } from '../services/ViewManager'

// Props and route
const route = useRoute()
const viewId = computed(() => route.params.viewId as string || 'gallery1')

// Reactive data
const loading = ref(true)
const error = ref('')
const cards = ref<GalleryCard[]>([])
const config = ref<GalleryConfig | null>(null)
const localConfig = ref<GalleryConfig>(createDefaultConfig())
const selectedCard = ref<GalleryCard | null>(null)
const showConfigModal = ref(false)

// Pagination
const currentPage = ref(1)
const pageSize = ref(20)
const totalItems = ref(0)
const totalPages = computed(() => Math.ceil(totalItems.value / pageSize.value))

// Search and filters
const searchQuery = ref('')
const appliedFilters = ref<{ field: string; operator: string; value: any }[]>([])

// Available fields (will be populated from data)
const availableFields = ref<string[]>([])

// Services
const viewManager = ViewManager.getInstance()

// Computed properties
const gridClass = computed(() => {
  const cols = localConfig.value?.layout.columns || 3
  const spacing = localConfig.value?.layout.spacing || 'normal'
  return [`cols-${cols}`, `spacing-${spacing}`]
})

const cardClass = computed(() => {
  const size = localConfig.value?.layout.cardSize || 'medium'
  return [`size-${size}`]
})

// Methods
async function loadData() {
  loading.value = true
  error.value = ''

  try {
    // Load config if not already loaded
    if (!config.value) {
      config.value = await viewManager.loadViewConfig<GalleryConfig>(viewId.value)
      if (config.value) {
        localConfig.value = JSON.parse(JSON.stringify(config.value))
      } else {
        // Create default config
        localConfig.value = createDefaultConfig()
      }
    }

    // Build filters from applied filters and search
    const filters: Record<string, any> = {}

    appliedFilters.value.forEach(filter => {
      filters[filter.field] = filter.value
    })

    if (searchQuery.value.trim()) {
      filters._search = searchQuery.value.trim()
    }

    // Build sorting
    const sorting = localConfig.value?.sorting || []

    // Load data
    const response = await viewManager.loadViewData<any>(viewId.value, {
      page: currentPage.value,
      pageSize: pageSize.value,
      filters,
      sorting
    })

    if (response.success) {
      // Transform data to gallery cards
      cards.value = response.data.map(transformToGalleryCard)
      totalItems.value = response.meta.total

      // Extract available fields from first record
      if (response.data.length > 0) {
        availableFields.value = Object.keys(response.data[0])
      }
    } else {
      error.value = response.error || '加载数据失败'
    }
  } catch (err) {
    console.error('Failed to load gallery data:', err)
    error.value = '无法连接到服务器'

    // Use demo data
    cards.value = createDemoData()
    totalItems.value = cards.value.length
  } finally {
    loading.value = false
  }
}

function createDefaultConfig(): GalleryConfig {
  return {
    id: viewId.value,
    name: '图库视图',
    type: 'gallery',
    description: '默认图库视图配置',
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'system',
    cardTemplate: {
      titleField: 'title',
      contentFields: ['content'],
      imageField: 'image',
      tagFields: ['tags']
    },
    layout: {
      columns: 3,
      cardSize: 'medium',
      spacing: 'normal'
    },
    display: {
      showTitle: true,
      showContent: true,
      showImage: true,
      showTags: true,
      truncateContent: true,
      maxContentLength: 150
    }
  }
}

function transformToGalleryCard(data: any): GalleryCard {
  const template = localConfig.value?.cardTemplate
  if (!template) return createDefaultCard(data)

  return {
    id: data.id || Math.random().toString(36).substr(2, 9),
    title: data[template.titleField] || data.title || '无标题',
    content: template.contentFields.map(field => data[field]).filter(Boolean),
    image: template.imageField ? data[template.imageField] : undefined,
    tags: template.tagFields?.flatMap(field =>
      Array.isArray(data[field]) ? data[field] : [data[field]]
    ).filter(Boolean),
    data,
    metadata: {
      createdAt: data.created_at ? new Date(data.created_at) : undefined,
      updatedAt: data.updated_at ? new Date(data.updated_at) : undefined,
      author: data.author || data.created_by
    }
  }
}

function createDefaultCard(data: any): GalleryCard {
  return {
    id: data.id || Math.random().toString(36).substr(2, 9),
    title: data.title || data.name || '无标题',
    content: [data.content || data.description || '无内容'],
    image: data.image || data.thumbnail,
    tags: Array.isArray(data.tags) ? data.tags : data.tags ? [data.tags] : undefined,
    data
  }
}

function createDemoData(): GalleryCard[] {
  return [
    {
      id: '1',
      title: '项目 Alpha',
      content: ['这是一个重要的项目，包含多个功能模块'],
      image: 'https://picsum.photos/300/200?random=1',
      tags: ['重要', '进行中'],
      data: { status: 'active', priority: 'high' }
    },
    {
      id: '2',
      title: '数据分析报告',
      content: ['Q3季度数据分析报告，包含关键指标和趋势分析'],
      image: 'https://picsum.photos/300/200?random=2',
      tags: ['报告', '已完成'],
      data: { status: 'completed', type: 'report' }
    },
    {
      id: '3',
      title: '用户体验优化',
      content: ['提升产品用户体验的优化方案和实施计划'],
      tags: ['UX', '设计'],
      data: { status: 'planning', department: 'design' }
    }
  ]
}

function truncateText(text: string): string {
  if (!localConfig.value?.display.truncateContent) return text

  const maxLength = localConfig.value?.display.maxContentLength || 150
  return text.length > maxLength ? text.substr(0, maxLength) + '...' : text
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(date)
}

function handleImageError(event: Event) {
  const img = event.target as HTMLImageElement
  img.style.display = 'none'
}

function handleSearch() {
  // Debounce search
  setTimeout(() => {
    currentPage.value = 1
    loadData()
  }, 300)
}

function addTagFilter(tag: string) {
  const exists = appliedFilters.value.some(f => f.field === 'tags' && f.value === tag)
  if (!exists) {
    appliedFilters.value.push({ field: 'tags', operator: 'contains', value: tag })
    currentPage.value = 1
    loadData()
  }
}

function removeFilter(filter: { field: string; operator: string; value: any }) {
  const index = appliedFilters.value.findIndex(f =>
    f.field === filter.field && f.value === filter.value
  )
  if (index > -1) {
    appliedFilters.value.splice(index, 1)
    currentPage.value = 1
    loadData()
  }
}

function clearAllFilters() {
  appliedFilters.value = []
  searchQuery.value = ''
  currentPage.value = 1
  loadData()
}

function changePage(page: number) {
  currentPage.value = page
  loadData()
}

function openDetailModal(card: GalleryCard) {
  selectedCard.value = card
}

function closeDetailModal() {
  selectedCard.value = null
}

function closeConfigModal() {
  showConfigModal.value = false
  // Reset local config to saved config
  if (config.value) {
    localConfig.value = JSON.parse(JSON.stringify(config.value))
  }
}

async function updateConfig() {
  if (localConfig.value) {
    currentPage.value = 1
    await loadData()
  }
}

async function saveConfig() {
  if (localConfig.value) {
    const success = await viewManager.saveViewConfig(localConfig.value)
    if (success) {
      config.value = JSON.parse(JSON.stringify(localConfig.value))
      showConfigModal.value = false
      await loadData()
    } else {
      alert('保存配置失败')
    }
  }
}

// Lifecycle
onMounted(() => {
  loadData()
})

// Watch for view ID changes
watch(() => viewId.value, () => {
  config.value = null
  localConfig.value = createDefaultConfig()
  currentPage.value = 1
  loadData()
})
</script>

<style scoped>
.gallery-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 1rem;
}

.gallery-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #e0e0e0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.header-left h2 {
  margin: 0;
  color: #333;
}

.item-count {
  color: #666;
  font-size: 0.9rem;
  background: #f5f5f5;
  padding: 0.25rem 0.5rem;
  border-radius: 12px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.layout-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.control-label {
  font-size: 0.9rem;
  color: #666;
}

.columns-select,
.size-select {
  padding: 0.25rem 0.5rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 0.9rem;
}

.search-box {
  position: relative;
}

.search-input {
  padding: 0.5rem 1rem;
  border: 1px solid #ddd;
  border-radius: 20px;
  font-size: 0.9rem;
  width: 200px;
}

.config-btn {
  padding: 0.5rem 1rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
}

.config-btn:hover {
  background: #5a67d8;
}

.filters-bar {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
  padding: 0.75rem;
  background: #f8f9fa;
  border-radius: 6px;
}

.filter-tags {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.filter-tag {
  background: #e2e8f0;
  padding: 0.25rem 0.5rem;
  border-radius: 12px;
  font-size: 0.8rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.remove-filter {
  background: none;
  border: none;
  cursor: pointer;
  font-weight: bold;
  color: #666;
}

.clear-filters {
  background: none;
  border: 1px solid #ddd;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
}

.loading-state,
.error-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  color: #666;
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 4px solid #f0f0f0;
  border-top: 4px solid #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 1rem;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.error-message {
  color: #ef4444;
  margin-bottom: 1rem;
}

.retry-btn {
  padding: 0.5rem 1rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.empty-state .empty-icon {
  font-size: 4rem;
  margin-bottom: 1rem;
}

.gallery-grid {
  display: grid;
  gap: 1rem;
  flex: 1;
}

.gallery-grid.cols-2 { grid-template-columns: repeat(2, 1fr); }
.gallery-grid.cols-3 { grid-template-columns: repeat(3, 1fr); }
.gallery-grid.cols-4 { grid-template-columns: repeat(4, 1fr); }
.gallery-grid.cols-5 { grid-template-columns: repeat(5, 1fr); }
.gallery-grid.cols-6 { grid-template-columns: repeat(6, 1fr); }

.gallery-grid.spacing-compact { gap: 0.5rem; }
.gallery-grid.spacing-normal { gap: 1rem; }
.gallery-grid.spacing-comfortable { gap: 1.5rem; }

.gallery-card {
  background: white;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  cursor: pointer;
  transition: all 0.3s ease;
  border: 1px solid #e0e0e0;
}

.gallery-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  transform: translateY(-2px);
}

.card-image {
  position: relative;
  overflow: hidden;
}

.size-small .card-image { height: 120px; }
.size-medium .card-image { height: 160px; }
.size-large .card-image { height: 200px; }

.card-image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.card-content {
  padding: 1rem;
}

.card-title {
  margin: 0 0 0.5rem 0;
  font-size: 1rem;
  font-weight: 600;
  color: #333;
  line-height: 1.3;
}

.card-body {
  margin-bottom: 0.75rem;
}

.content-item {
  color: #666;
  font-size: 0.9rem;
  line-height: 1.4;
  margin-bottom: 0.25rem;
}

.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-bottom: 0.75rem;
}

.tag {
  background: #e2e8f0;
  color: #4a5568;
  padding: 0.2rem 0.5rem;
  border-radius: 12px;
  font-size: 0.75rem;
  cursor: pointer;
  transition: background-color 0.2s;
}

.tag:hover {
  background: #cbd5e0;
}

.card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.8rem;
  color: #999;
  border-top: 1px solid #f0f0f0;
  padding-top: 0.5rem;
}

.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid #e0e0e0;
}

.page-btn {
  padding: 0.5rem 1rem;
  background: #f8f9fa;
  border: 1px solid #ddd;
  border-radius: 6px;
  cursor: pointer;
}

.page-btn:hover:not(:disabled) {
  background: #e9ecef;
}

.page-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.page-info {
  color: #666;
  font-size: 0.9rem;
}

/* Modal Styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.detail-modal,
.config-modal {
  background: white;
  border-radius: 8px;
  max-width: 800px;
  width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.5rem;
  border-bottom: 1px solid #e0e0e0;
}

.modal-header h2 {
  margin: 0;
  color: #333;
}

.close-btn {
  background: none;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
  color: #666;
  padding: 0.25rem;
  border-radius: 4px;
}

.close-btn:hover {
  background: #f0f0f0;
}

.modal-body {
  flex: 1;
  padding: 1.5rem;
  overflow-y: auto;
}

.detail-image {
  margin-bottom: 1rem;
}

.detail-image img {
  width: 100%;
  max-height: 400px;
  object-fit: contain;
  border-radius: 6px;
}

.detail-content {
  margin-bottom: 1rem;
}

.detail-item {
  margin-bottom: 0.75rem;
  line-height: 1.6;
  color: #333;
}

.detail-tags {
  margin-bottom: 1rem;
}

.raw-data {
  margin-top: 1.5rem;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 1rem;
}

.raw-data summary {
  cursor: pointer;
  font-weight: 500;
  margin-bottom: 0.5rem;
}

.raw-data pre {
  background: #f8f9fa;
  padding: 1rem;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 0.8rem;
  line-height: 1.4;
}

.config-modal {
  max-width: 600px;
}

.config-section {
  margin-bottom: 2rem;
}

.config-section h3 {
  margin-bottom: 1rem;
  color: #333;
  font-size: 1.1rem;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 500;
  color: #555;
}

.form-group select,
.form-group input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 0.9rem;
}

.checkbox-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.checkbox-group label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: normal;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 1rem;
  padding: 1.5rem;
  border-top: 1px solid #e0e0e0;
}

.save-btn {
  padding: 0.75rem 1.5rem;
  background: #667eea;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
}

.save-btn:hover {
  background: #5a67d8;
}

.cancel-btn {
  padding: 0.75rem 1.5rem;
  background: #f8f9fa;
  border: 1px solid #ddd;
  border-radius: 6px;
  cursor: pointer;
}

.cancel-btn:hover {
  background: #e9ecef;
}

/* Responsive */
@media (max-width: 768px) {
  .gallery-grid {
    grid-template-columns: repeat(2, 1fr) !important;
    gap: 0.75rem;
  }

  .gallery-header {
    flex-direction: column;
    gap: 1rem;
    align-items: stretch;
  }

  .header-right {
    flex-wrap: wrap;
    justify-content: space-between;
  }

  .search-input {
    width: 100%;
  }
}

@media (max-width: 480px) {
  .gallery-grid {
    grid-template-columns: 1fr !important;
  }

  .gallery-container {
    padding: 0.5rem;
  }

  .layout-controls {
    display: none;
  }
}
</style>