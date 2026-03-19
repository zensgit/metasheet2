<template>
  <div class="panel-header">
    <h2>BOM 结构</h2>
    <div class="panel-actions">
      <button class="btn ghost" :disabled="bomView !== 'tree' || !bomHasTree" @click="$emit('expand-all')">
        展开全部
      </button>
      <button class="btn ghost" :disabled="bomView !== 'tree' || !bomHasTree" @click="$emit('collapse-all')">
        折叠全部
      </button>
      <button
        class="btn ghost"
        :disabled="bomView !== 'tree' || !bomHasTree"
        @click="$emit('expand-to-depth', bomDepth)"
      >
        展开到深度
      </button>
      <button
        class="btn ghost"
        :disabled="bomView !== 'table' || !bomTablePathIdsCount"
        @click="$emit('copy-table-path-ids')"
      >
        复制所有路径 ID
      </button>
      <button
        class="btn ghost"
        :disabled="bomView !== 'tree' || !bomTreePathIdsCount"
        @click="$emit('copy-tree-path-ids')"
      >
        复制树形路径 ID
      </button>
      <button class="btn ghost" :disabled="!bomSelectedCount" @click="$emit('copy-selected-child-ids')">
        复制选中子件
      </button>
      <button class="btn ghost" :disabled="!bomSelectedCount" @click="$emit('clear-selection')">
        清空选择
      </button>
      <span v-if="bomSelectedCount" class="muted">已选 {{ bomSelectedCount }}</span>
      <button class="btn ghost" :disabled="!bomExportCount" @click="$emit('export-csv')">
        导出 CSV
      </button>
      <button class="btn" :disabled="!productId || bomLoading" @click="$emit('refresh-bom')">
        {{ bomLoading ? '加载中...' : '刷新 BOM' }}
      </button>
    </div>
  </div>

  <div class="form-grid compact">
    <label for="plm-bom-depth">
      深度
      <div class="field-inline">
        <input
          id="plm-bom-depth"
          :value="bomDepth"
          name="plmBomDepth"
          type="number"
          min="1"
          max="10"
          @input="$emit('update:bom-depth', Number(($event.target as HTMLInputElement).value))"
        />
        <div class="field-actions">
          <button
            v-for="depth in quickDepthOptions"
            :key="`bom-depth-${depth}`"
            class="btn ghost mini"
            type="button"
            :disabled="bomDepth === depth"
            @click="$emit('set-depth-quick', depth)"
          >
            {{ depth }}
          </button>
        </div>
      </div>
    </label>
    <label for="plm-bom-effective-at">
      生效时间
      <input
        id="plm-bom-effective-at"
        :value="bomEffectiveAt"
        name="plmBomEffectiveAt"
        type="datetime-local"
        @input="$emit('update:bom-effective-at', ($event.target as HTMLInputElement).value)"
      />
    </label>
    <label for="plm-bom-view">
      视图
      <select
        id="plm-bom-view"
        :value="bomView"
        name="plmBomView"
        @change="$emit('update:bom-view', ($event.target as HTMLSelectElement).value as 'table' | 'tree')"
      >
        <option value="table">表格</option>
        <option value="tree">树形</option>
      </select>
    </label>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  bomView: 'table' | 'tree'
  bomHasTree: boolean
  bomTablePathIdsCount: number
  bomTreePathIdsCount: number
  bomSelectedCount: number
  bomExportCount: number
  productId: string
  bomLoading: boolean
  bomDepth: number
  bomEffectiveAt: string
  quickDepthOptions: number[]
}>()

defineEmits<{
  (event: 'expand-all'): void
  (event: 'collapse-all'): void
  (event: 'expand-to-depth', depth: number): void
  (event: 'copy-table-path-ids'): void
  (event: 'copy-tree-path-ids'): void
  (event: 'copy-selected-child-ids'): void
  (event: 'clear-selection'): void
  (event: 'export-csv'): void
  (event: 'refresh-bom'): void
  (event: 'update:bom-depth', value: number): void
  (event: 'set-depth-quick', value: number): void
  (event: 'update:bom-effective-at', value: string): void
  (event: 'update:bom-view', value: 'table' | 'tree'): void
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

.panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px 16px;
  align-items: end;
  margin-bottom: 12px;
}

.form-grid.compact {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: #374151;
}

input,
select {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 13px;
  background: #fff;
}

input:focus,
select:focus {
  outline: none;
  border-color: #1976d2;
  box-shadow: 0 0 0 2px rgba(25, 118, 210, 0.15);
}

.field-inline {
  display: flex;
  gap: 6px;
  align-items: center;
}

.field-actions {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
}

.btn {
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 8px 14px;
  background: #f9fafb;
  cursor: pointer;
  font-size: 13px;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.btn.ghost {
  background: transparent;
  border-color: #e5e7eb;
  color: #374151;
}

.btn.mini {
  padding: 4px 8px;
  font-size: 12px;
}

.muted {
  color: #6b7280;
  font-size: 12px;
}
</style>
