<template>
  <div class="panel-header">
    <div>
      <h1>PLM 产品详情</h1>
      <p class="subtext">联邦接口：产品详情、BOM、where-used、BOM 对比、替代件</p>
      <div class="auth-status">
        <span class="auth-label">MetaSheet</span>
        <span class="auth-pill" :class="authStateClass">{{ authStateText }}</span>
        <span v-if="authExpiryText" class="auth-expiry">{{ authExpiryText }}</span>
        <button class="btn ghost" @click="$emit('refresh-auth-status')">刷新状态</button>
      </div>
      <div class="auth-status secondary">
        <span class="auth-label">PLM Token</span>
        <span class="auth-pill" :class="plmAuthStateClass">{{ plmAuthStateText }}</span>
        <span v-if="plmAuthExpiryText" class="auth-expiry">{{ plmAuthExpiryText }}</span>
      </div>
      <p v-if="authHint" class="hint">{{ authHint }}</p>
      <p v-if="plmAuthHint" class="hint">{{ plmAuthHint }}</p>
      <p v-if="authError" class="status error">{{ authError }}</p>
      <p v-if="deepLinkStatus" class="status">{{ deepLinkStatus }}</p>
      <p v-if="deepLinkError" class="status error">{{ deepLinkError }}</p>
    </div>
    <div class="panel-actions">
      <button class="btn ghost" @click="$emit('copy-deep-link')">复制深链接</button>
      <button class="btn" @click="$emit('reset')">重置</button>
    </div>
  </div>

  <div class="deep-link-scope">
    <span class="deep-link-label">深链接范围</span>
    <label class="deep-link-option" for="plm-deeplink-preset">
      <span>预设</span>
      <select
        id="plm-deeplink-preset"
        name="plmDeepLinkPreset"
        class="deep-link-select"
        :value="deepLinkPreset"
        @change="handlePresetChange"
      >
        <option value="">自动</option>
        <option v-for="preset in deepLinkPresets" :key="preset.key" :value="preset.key">
          {{ preset.label }}
        </option>
      </select>
    </label>
    <button
      class="btn ghost"
      :disabled="!deepLinkPreset.startsWith('custom:')"
      @click="$emit('move-preset', 'up')"
    >
      上移
    </button>
    <button
      class="btn ghost"
      :disabled="!deepLinkPreset.startsWith('custom:')"
      @click="$emit('move-preset', 'down')"
    >
      下移
    </button>
    <label
      v-for="option in deepLinkPanelOptions"
      :key="option.key"
      class="deep-link-option"
      :for="`plm-deeplink-scope-${option.key}`"
    >
      <input
        :id="`plm-deeplink-scope-${option.key}`"
        name="plmDeepLinkScope"
        type="checkbox"
        :checked="deepLinkScope.includes(option.key)"
        @change="handleScopeToggle(option.key, $event)"
      />
      <span>{{ option.label }}</span>
    </label>
    <button class="btn ghost" @click="$emit('clear-deep-link-scope')">自动</button>
    <label class="deep-link-option" for="plm-deeplink-preset-name">
      <span>保存为</span>
      <input
        id="plm-deeplink-preset-name"
        name="plmDeepLinkPresetName"
        class="deep-link-input"
        :value="customPresetName"
        placeholder="输入名称"
        @input="$emit('update:custom-preset-name', ($event.target as HTMLInputElement).value)"
      />
      <button
        class="btn ghost"
        :disabled="!customPresetName || !deepLinkScope.length"
        @click="$emit('save-deep-link-preset')"
      >
        保存
      </button>
    </label>
    <button
      class="btn ghost"
      :disabled="!deepLinkPreset.startsWith('custom:')"
      @click="$emit('delete-deep-link-preset')"
    >
      删除预设
    </button>
    <label class="deep-link-option" for="plm-deeplink-preset-rename">
      <span>重命名</span>
      <input
        id="plm-deeplink-preset-rename"
        name="plmDeepLinkPresetRename"
        class="deep-link-input"
        :value="editingPresetLabel"
        :disabled="!deepLinkPreset.startsWith('custom:')"
        placeholder="新名称"
        @input="$emit('update:editing-preset-label', ($event.target as HTMLInputElement).value)"
      />
      <button
        class="btn ghost"
        :disabled="!deepLinkPreset.startsWith('custom:') || !editingPresetLabel"
        @click="$emit('apply-preset-rename')"
      >
        保存
      </button>
    </label>
    <button class="btn ghost" @click="$emit('export-custom-presets')">导出预设</button>
    <label class="deep-link-option" for="plm-deeplink-preset-import">
      <span>导入</span>
      <input
        id="plm-deeplink-preset-import"
        name="plmDeepLinkPresetImport"
        class="deep-link-input"
        :value="importPresetText"
        placeholder="粘贴 JSON"
        @input="$emit('update:import-preset-text', ($event.target as HTMLInputElement).value)"
      />
      <button class="btn ghost" :disabled="!importPresetText" @click="$emit('import-custom-presets')">
        导入
      </button>
    </label>
    <button class="btn ghost" @click="openFilePicker">选择文件</button>
    <input
      ref="fileInput"
      id="plm-deeplink-preset-file"
      name="plmDeepLinkPresetFile"
      class="deep-link-file"
      type="file"
      accept=".json,application/json"
      @change="$emit('file-import', $event)"
    />
    <div
      class="deep-link-drop"
      :class="{ active: isPresetDropActive }"
      @dragenter="$emit('preset-drag-enter', $event)"
      @dragover="$emit('preset-drag-over', $event)"
      @dragleave="$emit('preset-drag-leave', $event)"
      @drop="$emit('preset-drop', $event)"
    >
      <span>拖拽 JSON 预设文件到这里</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

type DeepLinkPresetOption = {
  key: string
  label: string
}

type DeepLinkPanelOption = {
  key: string
  label: string
}

const props = defineProps<{
  authStateText: string
  authStateClass: string
  authExpiryText?: string
  authHint?: string
  authError?: string
  plmAuthStateText: string
  plmAuthStateClass: string
  plmAuthExpiryText?: string
  plmAuthHint?: string
  deepLinkStatus?: string
  deepLinkError?: string
  deepLinkPreset: string
  deepLinkPresets: DeepLinkPresetOption[]
  deepLinkPanelOptions: DeepLinkPanelOption[]
  deepLinkScope: string[]
  customPresetName: string
  editingPresetLabel: string
  importPresetText: string
  isPresetDropActive: boolean
}>()

const emit = defineEmits<{
  (event: 'refresh-auth-status'): void
  (event: 'copy-deep-link'): void
  (event: 'reset'): void
  (event: 'update:deep-link-preset', value: string): void
  (event: 'apply-deep-link-preset'): void
  (event: 'move-preset', direction: 'up' | 'down'): void
  (event: 'update:deep-link-scope', value: string[]): void
  (event: 'clear-deep-link-scope'): void
  (event: 'update:custom-preset-name', value: string): void
  (event: 'save-deep-link-preset'): void
  (event: 'delete-deep-link-preset'): void
  (event: 'update:editing-preset-label', value: string): void
  (event: 'apply-preset-rename'): void
  (event: 'export-custom-presets'): void
  (event: 'update:import-preset-text', value: string): void
  (event: 'import-custom-presets'): void
  (event: 'file-import', value: Event): void
  (event: 'preset-drag-enter', value: DragEvent): void
  (event: 'preset-drag-over', value: DragEvent): void
  (event: 'preset-drag-leave', value: DragEvent): void
  (event: 'preset-drop', value: DragEvent): void
}>()

const fileInput = ref<HTMLInputElement | null>(null)

function openFilePicker() {
  fileInput.value?.click()
}

function handlePresetChange(event: Event) {
  emit('update:deep-link-preset', (event.target as HTMLSelectElement).value)
  emit('apply-deep-link-preset')
}

function handleScopeToggle(key: string, event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const next = checked
    ? [...props.deepLinkScope, key]
    : props.deepLinkScope.filter((entry) => entry !== key)
  emit('update:deep-link-scope', Array.from(new Set(next)))
}
</script>

<style scoped>
.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.panel-header h1 {
  font-size: 20px;
  margin-bottom: 4px;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.subtext {
  color: #6b7280;
  font-size: 13px;
}

.hint {
  color: #9ca3af;
  font-size: 12px;
  margin-top: 4px;
}

.status {
  font-size: 13px;
  color: #374151;
  margin: 8px 0;
}

.status.error {
  color: #b91c1c;
}

.auth-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.auth-status.secondary {
  margin-top: 4px;
}

.auth-label {
  font-size: 12px;
  color: #6b7280;
}

.auth-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid transparent;
}

.auth-expiry {
  font-size: 12px;
  color: #6b7280;
}

.auth-valid {
  color: #14532d;
  background: #dcfce7;
  border-color: #bbf7d0;
}

.auth-expiring {
  color: #7c2d12;
  background: #ffedd5;
  border-color: #fed7aa;
}

.auth-expired,
.auth-invalid {
  color: #7f1d1d;
  background: #fee2e2;
  border-color: #fecaca;
}

.auth-missing {
  color: #1f2937;
  background: #f3f4f6;
  border-color: #e5e7eb;
}

.deep-link-scope {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 8px 0 4px;
}

.deep-link-label {
  font-size: 12px;
  color: #6b7280;
}

.deep-link-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #374151;
}

.deep-link-option input[type='checkbox'] {
  accent-color: #2563eb;
}

.deep-link-input {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fff;
  color: #111827;
  min-width: 120px;
}

.deep-link-select {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: #fff;
  color: #111827;
}

.deep-link-file {
  display: none;
}

.deep-link-drop {
  border: 1px dashed #cbd5f5;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: #4b5563;
  background: #f8fafc;
}

.deep-link-drop.active {
  border-color: #3b82f6;
  background: #eff6ff;
  color: #1d4ed8;
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
</style>
