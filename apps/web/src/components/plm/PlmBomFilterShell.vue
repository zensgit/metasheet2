<template>
  <label for="plm-bom-filter">
    过滤
    <div class="field-inline">
      <select
        id="plm-bom-filter-field"
        :value="bomFilterField"
        name="plmBomFilterField"
        @change="$emit('update:bom-filter-field', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="option in bomFilterFieldOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <input
        id="plm-bom-filter"
        :value="bomFilter"
        name="plmBomFilter"
        :placeholder="bomFilterPlaceholder"
        @input="$emit('update:bom-filter', ($event.target as HTMLInputElement).value)"
      />
    </div>
  </label>
  <label for="plm-bom-filter-preset">
    预设
    <div class="field-inline">
      <select
        id="plm-bom-filter-preset-group-filter"
        :value="bomFilterPresetGroupFilter"
        name="plmBomFilterPresetGroupFilter"
        @change="$emit('update:bom-filter-preset-group-filter', ($event.target as HTMLSelectElement).value)"
      >
        <option value="all">全部分组</option>
        <option value="ungrouped">未分组</option>
        <option v-for="group in bomFilterPresetGroups" :key="group" :value="group">
          {{ group }}
        </option>
      </select>
      <select
        id="plm-bom-filter-preset"
        :value="bomFilterPresetKey"
        name="plmBomFilterPreset"
        @change="$emit('update:bom-filter-preset-key', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">选择预设</option>
        <option v-for="preset in bomFilteredPresets" :key="preset.key" :value="preset.key">
          {{ preset.label }}{{ preset.group ? ` (${preset.group})` : '' }}
        </option>
      </select>
      <button class="btn ghost mini" :disabled="!bomFilterPresetKey" @click="$emit('apply-bom-filter-preset')">
        应用
      </button>
      <button class="btn ghost mini" :disabled="!bomFilterPresetKey" @click="$emit('delete-bom-filter-preset')">
        删除
      </button>
      <button class="btn ghost mini" :disabled="!bomFilterPresetKey" @click="$emit('share-bom-filter-preset')">
        分享
      </button>
      <button class="btn ghost mini" :disabled="!bomFilterPresetKey" @click="$emit('assign-bom-preset-group')">
        设为分组
      </button>
    </div>
    <div class="field-inline">
      <input
        id="plm-bom-filter-preset-name"
        :value="bomFilterPresetName"
        name="plmBomFilterPresetName"
        placeholder="新预设名称"
        @input="$emit('update:bom-filter-preset-name', ($event.target as HTMLInputElement).value)"
      />
      <input
        id="plm-bom-filter-preset-group"
        :value="bomFilterPresetGroup"
        name="plmBomFilterPresetGroup"
        class="deep-link-input"
        placeholder="分组（可选）"
        @input="$emit('update:bom-filter-preset-group', ($event.target as HTMLInputElement).value)"
      />
      <button class="btn ghost mini" :disabled="!canSaveBomFilterPreset" @click="$emit('save-bom-filter-preset')">
        保存
      </button>
    </div>
    <div class="field-inline field-actions">
      <button class="btn ghost mini" :disabled="bomFilterPresetsCount === 0" @click="$emit('export-bom-filter-presets')">
        导出
      </button>
      <input
        id="plm-bom-filter-preset-import"
        :value="bomFilterPresetImportText"
        name="plmBomFilterPresetImport"
        class="deep-link-input"
        placeholder="粘贴 JSON"
        @input="$emit('update:bom-filter-preset-import-text', ($event.target as HTMLInputElement).value)"
      />
      <select
        id="plm-bom-filter-preset-import-mode"
        :value="bomFilterPresetImportMode"
        name="plmBomFilterPresetImportMode"
        class="deep-link-select"
        @change="$emit('update:bom-filter-preset-import-mode', ($event.target as HTMLSelectElement).value as 'merge' | 'replace')"
      >
        <option value="merge">合并</option>
        <option value="replace">覆盖</option>
      </select>
      <button class="btn ghost mini" :disabled="!bomFilterPresetImportText" @click="$emit('import-bom-filter-presets')">
        导入
      </button>
      <button class="btn ghost mini" @click="openFilePicker">文件</button>
      <input
        ref="fileInput"
        id="plm-bom-filter-preset-file"
        name="plmBomFilterPresetFile"
        class="deep-link-file"
        type="file"
        accept=".json,application/json"
        @change="$emit('file-import', $event)"
      />
      <button
        id="plm-bom-filter-preset-clear"
        class="btn ghost mini"
        :disabled="bomFilterPresetsCount === 0"
        @click="$emit('clear-bom-filter-presets')"
      >
        清空
      </button>
      <button class="btn ghost mini" @click="$emit('toggle-bom-preset-manager')">
        {{ showBomPresetManager ? '收起' : '管理' }}
      </button>
    </div>
    <div v-if="showBomPresetManager" class="preset-manager">
      <div class="field-inline field-actions">
        <button class="btn ghost mini" :disabled="!bomFilteredPresets.length" @click="$emit('select-all-bom-presets')">
          全选
        </button>
        <button class="btn ghost mini" :disabled="!bomPresetSelectionCount" @click="$emit('clear-bom-preset-selection')">
          清空选择
        </button>
        <span class="muted">已选 {{ bomPresetSelectionCount }}/{{ bomFilteredPresets.length }}</span>
      </div>
      <div class="field-inline field-actions">
        <input
          id="plm-bom-filter-preset-batch-group"
          :value="bomPresetBatchGroup"
          name="plmBomFilterPresetBatchGroup"
          class="deep-link-input"
          placeholder="批量分组（留空清除）"
          @input="$emit('update:bom-preset-batch-group', ($event.target as HTMLInputElement).value)"
        />
        <button class="btn ghost mini" :disabled="!bomPresetSelectionCount" @click="$emit('apply-bom-preset-batch-group')">
          应用分组
        </button>
        <button class="btn ghost mini danger" :disabled="!bomPresetSelectionCount" @click="$emit('delete-bom-preset-selection')">
          批量删除
        </button>
      </div>
      <div class="preset-list">
        <label v-for="preset in bomFilteredPresets" :key="preset.key" class="preset-item">
          <input
            type="checkbox"
            :value="preset.key"
            :checked="bomPresetSelection.includes(preset.key)"
            @change="togglePresetSelection(preset.key, $event)"
          />
          <span>{{ preset.label }}{{ preset.group ? ` (${preset.group})` : '' }}</span>
        </label>
      </div>
    </div>
  </label>
</template>

<script setup lang="ts">
import { ref } from 'vue'

type SelectOption = {
  value: string
  label: string
}

type FilterPreset = {
  key: string
  label: string
  group?: string
}

const props = defineProps<{
  bomFilterField: string
  bomFilterFieldOptions: SelectOption[]
  bomFilter: string
  bomFilterPlaceholder: string
  bomFilterPresetGroupFilter: string
  bomFilterPresetGroups: string[]
  bomFilterPresetKey: string
  bomFilteredPresets: FilterPreset[]
  bomFilterPresetName: string
  bomFilterPresetGroup: string
  canSaveBomFilterPreset: boolean
  bomFilterPresetsCount: number
  bomFilterPresetImportText: string
  bomFilterPresetImportMode: 'merge' | 'replace'
  showBomPresetManager: boolean
  bomPresetSelection: string[]
  bomPresetSelectionCount: number
  bomPresetBatchGroup: string
}>()

const emit = defineEmits<{
  (event: 'update:bom-filter-field', value: string): void
  (event: 'update:bom-filter', value: string): void
  (event: 'update:bom-filter-preset-group-filter', value: string): void
  (event: 'update:bom-filter-preset-key', value: string): void
  (event: 'apply-bom-filter-preset'): void
  (event: 'delete-bom-filter-preset'): void
  (event: 'share-bom-filter-preset'): void
  (event: 'assign-bom-preset-group'): void
  (event: 'update:bom-filter-preset-name', value: string): void
  (event: 'update:bom-filter-preset-group', value: string): void
  (event: 'save-bom-filter-preset'): void
  (event: 'export-bom-filter-presets'): void
  (event: 'update:bom-filter-preset-import-text', value: string): void
  (event: 'update:bom-filter-preset-import-mode', value: 'merge' | 'replace'): void
  (event: 'import-bom-filter-presets'): void
  (event: 'file-import', value: Event): void
  (event: 'clear-bom-filter-presets'): void
  (event: 'toggle-bom-preset-manager'): void
  (event: 'select-all-bom-presets'): void
  (event: 'clear-bom-preset-selection'): void
  (event: 'update:bom-preset-batch-group', value: string): void
  (event: 'apply-bom-preset-batch-group'): void
  (event: 'delete-bom-preset-selection'): void
  (event: 'update:bom-preset-selection', value: string[]): void
}>()

const fileInput = ref<HTMLInputElement | null>(null)

function openFilePicker() {
  fileInput.value?.click()
}

function togglePresetSelection(key: string, event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const next = checked
    ? [...props.bomPresetSelection, key]
    : props.bomPresetSelection.filter((entry) => entry !== key)
  emit('update:bom-preset-selection', Array.from(new Set(next)))
}
</script>

<style scoped>
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

.field-inline + .field-inline {
  margin-top: 6px;
}

.field-inline input {
  flex: 1;
  min-width: 0;
}

.field-inline select {
  min-width: 120px;
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

.btn.danger {
  border-color: #fecaca;
  color: #b91c1c;
}

.deep-link-input,
.deep-link-select {
  font-size: 12px;
}

.deep-link-file {
  display: none;
}

.preset-manager {
  margin-top: 8px;
  padding: 8px;
  border: 1px dashed #e5e7eb;
  border-radius: 8px;
  background: #fafafa;
  display: grid;
  gap: 6px;
}

.preset-list {
  display: grid;
  gap: 4px;
  max-height: 160px;
  overflow: auto;
  padding-right: 4px;
}

.preset-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #374151;
}

.muted {
  color: #6b7280;
  font-size: 12px;
}
</style>
