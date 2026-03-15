<template>
  <section class="panel">
    <div class="panel-header">
      <div>
        <h2>产品搜索</h2>
        <p class="subtext">基于联邦接口快速定位可用的 PLM 产品 ID</p>
      </div>
      <button class="btn primary" :disabled="searchLoading" @click="$emit('search')">
        {{ searchLoading ? '搜索中...' : '搜索' }}
      </button>
    </div>

    <div class="form-grid">
      <label for="plm-search-query">
        关键词
        <input
          id="plm-search-query"
          :value="searchQuery"
          name="plmSearchQuery"
          placeholder="可留空，返回最新记录"
          @input="$emit('update:search-query', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label for="plm-search-item-type">
        Item Type
        <input
          id="plm-search-item-type"
          :value="searchItemType"
          name="plmSearchItemType"
          placeholder="Part"
          @input="$emit('update:search-item-type', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label for="plm-search-limit">
        Limit
        <input
          id="plm-search-limit"
          :value="searchLimit"
          name="plmSearchLimit"
          type="number"
          min="1"
          max="50"
          @input="$emit('update:search-limit', Number(($event.target as HTMLInputElement).value))"
        />
      </label>
    </div>

    <p v-if="searchError" class="status error">{{ searchError }}</p>
    <p v-else-if="searchResults.length" class="status">
      共 {{ searchTotal }} 条，当前展示 {{ searchResults.length }} 条
    </p>
    <div v-if="!searchResults.length" class="empty">暂无搜索结果</div>
    <table v-else class="data-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>料号</th>
          <th>状态</th>
          <th>类型</th>
          <th>更新时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in searchResults" :key="item.id">
          <td>{{ item.name || '-' }}</td>
          <td>{{ item.partNumber || item.item_number || item.itemNumber || item.code || '-' }}</td>
          <td>{{ item.status || '-' }}</td>
          <td>{{ item.itemType || '-' }}</td>
          <td>{{ item.updatedAt || item.updated_at || '-' }}</td>
          <td>
            <div class="inline-actions">
              <button class="btn" @click="$emit('apply-item', item)">使用</button>
              <button class="btn ghost mini" @click="$emit('compare-item', item, 'left')">
                左对比
              </button>
              <button class="btn ghost mini" @click="$emit('compare-item', item, 'right')">
                右对比
              </button>
              <button class="btn ghost mini" @click="$emit('copy-item', item, 'id')">
                复制 ID
              </button>
              <button class="btn ghost mini" @click="$emit('copy-item', item, 'number')">
                复制料号
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
type SearchResultItem = {
  id: string
  name?: string
  partNumber?: string
  item_number?: string
  itemNumber?: string
  code?: string
  status?: string
  itemType?: string
  updatedAt?: string
  updated_at?: string
}

defineProps<{
  searchQuery: string
  searchItemType: string
  searchLimit: number
  searchResults: SearchResultItem[]
  searchTotal: number
  searchLoading: boolean
  searchError: string
}>()

defineEmits<{
  (event: 'update:search-query', value: string): void
  (event: 'update:search-item-type', value: string): void
  (event: 'update:search-limit', value: number): void
  (event: 'search'): void
  (event: 'apply-item', item: SearchResultItem): void
  (event: 'compare-item', item: SearchResultItem, side: 'left' | 'right'): void
  (event: 'copy-item', item: SearchResultItem, kind: 'id' | 'number'): void
}>()
</script>

<style scoped>
.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.subtext {
  color: #6b7280;
  font-size: 13px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px 16px;
  align-items: end;
  margin-bottom: 12px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: #374151;
}

input {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
}

input:focus {
  outline: none;
  border-color: #1976d2;
  box-shadow: 0 0 0 2px rgba(25, 118, 210, 0.15);
}

.btn {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 8px 14px;
  background: #f9fafb;
  cursor: pointer;
  font-size: 13px;
}

.btn.primary {
  background: #1976d2;
  color: #fff;
  border-color: #1976d2;
}

.btn.ghost {
  background: transparent;
  border-color: #e5e7eb;
  color: #374151;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.btn.mini {
  padding: 4px 8px;
  font-size: 12px;
}

.status {
  font-size: 13px;
  color: #374151;
  margin: 8px 0;
}

.status.error {
  color: #b91c1c;
}

.empty {
  color: #9ca3af;
  font-size: 13px;
  padding: 8px 0;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table th,
.data-table td {
  border-bottom: 1px solid #eef0f2;
  padding: 10px 8px;
  text-align: left;
  vertical-align: top;
}

.inline-actions {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
</style>
