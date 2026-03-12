<template>
  <section class="panel">
    <div class="panel-header">
      <div>
        <h1>PLM 产品详情</h1>
        <p class="subtext">联邦接口：产品详情、BOM、where-used、BOM 对比、替代件</p>
        <div class="auth-status">
          <span class="auth-label">MetaSheet</span>
          <span class="auth-pill" :class="panel.authStateClass.value">{{ panel.authStateText.value }}</span>
          <span v-if="panel.authExpiryText.value" class="auth-expiry">{{ panel.authExpiryText.value }}</span>
          <button class="btn ghost" @click="panel.refreshAuthStatus">刷新状态</button>
        </div>
        <div class="auth-status secondary">
          <span class="auth-label">PLM Token</span>
          <span class="auth-pill" :class="panel.plmAuthStateClass.value">{{ panel.plmAuthStateText.value }}</span>
          <span v-if="panel.plmAuthExpiryText.value" class="auth-expiry">{{ panel.plmAuthExpiryText.value }}</span>
        </div>
        <p v-if="panel.authHint.value" class="hint">{{ panel.authHint.value }}</p>
        <p v-if="panel.plmAuthHint.value" class="hint">{{ panel.plmAuthHint.value }}</p>
        <p v-if="panel.authError.value" class="status error">{{ panel.authError.value }}</p>
        <p v-if="panel.deepLinkStatus.value" class="status">{{ panel.deepLinkStatus.value }}</p>
        <p v-if="panel.deepLinkError.value" class="status error">{{ panel.deepLinkError.value }}</p>
      </div>
      <div class="panel-actions">
        <button class="btn ghost" @click="panel.copyDeepLink()">复制深链接</button>
        <button class="btn" @click="panel.resetAll">重置</button>
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
          v-model="panel.deepLinkPreset.value"
          @change="panel.applyDeepLinkPreset"
        >
          <option value="">自动</option>
          <option v-for="preset in panel.deepLinkPresets.value" :key="preset.key" :value="preset.key">
            {{ preset.label }}
          </option>
        </select>
      </label>
      <button
        class="btn ghost"
        :disabled="!panel.deepLinkPreset.value.startsWith('custom:')"
        @click="panel.movePreset('up')"
      >
        上移
      </button>
      <button
        class="btn ghost"
        :disabled="!panel.deepLinkPreset.value.startsWith('custom:')"
        @click="panel.movePreset('down')"
      >
        下移
      </button>
      <label
        v-for="option in panel.deepLinkPanelOptions"
        :key="option.key"
        class="deep-link-option"
        :for="`plm-deeplink-scope-${option.key}`"
      >
        <input
          :id="`plm-deeplink-scope-${option.key}`"
          name="plmDeepLinkScope"
          type="checkbox"
          :value="option.key"
          v-model="panel.deepLinkScope.value"
        />
        <span>{{ option.label }}</span>
      </label>
      <button class="btn ghost" @click="panel.clearDeepLinkScope">自动</button>
      <label class="deep-link-option" for="plm-deeplink-preset-name">
        <span>保存为</span>
        <input
          id="plm-deeplink-preset-name"
          name="plmDeepLinkPresetName"
          class="deep-link-input"
          v-model.trim="panel.customPresetName.value"
          placeholder="输入名称"
        />
        <button
          class="btn ghost"
          :disabled="!panel.customPresetName.value || !panel.deepLinkScope.value.length"
          @click="panel.saveDeepLinkPreset"
        >
          保存
        </button>
      </label>
      <button
        class="btn ghost"
        :disabled="!panel.deepLinkPreset.value.startsWith('custom:')"
        @click="panel.deleteDeepLinkPreset"
      >
        删除预设
      </button>
      <label class="deep-link-option" for="plm-deeplink-preset-rename">
        <span>重命名</span>
        <input
          id="plm-deeplink-preset-rename"
          name="plmDeepLinkPresetRename"
          class="deep-link-input"
          v-model.trim="panel.editingPresetLabel.value"
          :disabled="!panel.deepLinkPreset.value.startsWith('custom:')"
          placeholder="新名称"
        />
        <button
          class="btn ghost"
          :disabled="!panel.deepLinkPreset.value.startsWith('custom:') || !panel.editingPresetLabel.value"
          @click="panel.applyPresetRename"
        >
          保存
        </button>
      </label>
      <button class="btn ghost" @click="panel.exportCustomPresets">导出预设</button>
      <label class="deep-link-option" for="plm-deeplink-preset-import">
        <span>导入</span>
        <input
          id="plm-deeplink-preset-import"
          name="plmDeepLinkPresetImport"
          class="deep-link-input"
          v-model.trim="panel.importPresetText.value"
          placeholder="粘贴 JSON"
        />
        <button class="btn ghost" :disabled="!panel.importPresetText.value" @click="panel.importCustomPresets">
          导入
        </button>
      </label>
      <button class="btn ghost" @click="panel.triggerPresetFileImport">选择文件</button>
      <input
        :ref="panel.importFileInput"
        id="plm-deeplink-preset-file"
        name="plmDeepLinkPresetFile"
        class="deep-link-file"
        type="file"
        accept=".json,application/json"
        @change="panel.handlePresetFileImport"
      />
      <div
        class="deep-link-drop"
        :class="{ active: panel.isPresetDropActive.value }"
        @dragenter="panel.handlePresetDragEnter"
        @dragover="panel.handlePresetDragOver"
        @dragleave="panel.handlePresetDragLeave"
        @drop="panel.handlePresetDrop"
      >
        <span>拖拽 JSON 预设文件到这里</span>
      </div>
    </div>

    <PlmTeamViewsBlock
      label="工作台"
      select-id="plm-workbench-team-view"
      select-name="plmWorkbenchTeamView"
      input-id="plm-workbench-team-view-name"
      input-name="plmWorkbenchTeamViewName"
      owner-input-id="plm-workbench-team-view-owner-user-id"
      owner-input-name="plmWorkbenchTeamViewOwnerUserId"
      :team-view-key="panel.workbenchTeamViewKey"
      :team-view-name="panel.workbenchTeamViewName"
      :team-view-owner-user-id="panel.workbenchTeamViewOwnerUserId"
      :team-views="panel.workbenchTeamViews"
      :loading="panel.workbenchTeamViewsLoading"
      :error="panel.workbenchTeamViewsError"
      :can-save="panel.canSaveWorkbenchTeamView"
      :can-apply="panel.canApplyWorkbenchTeamView"
      :show-manage-actions="panel.showManageWorkbenchTeamViewActions"
      :can-duplicate="panel.canDuplicateWorkbenchTeamView"
      :can-share="panel.canShareWorkbenchTeamView"
      :can-delete="panel.canDeleteWorkbenchTeamView"
      :can-archive="panel.canArchiveWorkbenchTeamView"
      :can-restore="panel.canRestoreWorkbenchTeamView"
      :can-rename="panel.canRenameWorkbenchTeamView"
      :can-transfer="panel.canTransferWorkbenchTeamView"
      :can-set-default="panel.canSetWorkbenchTeamViewDefault"
      :can-clear-default="panel.canClearWorkbenchTeamViewDefault"
      :default-label="panel.workbenchDefaultTeamViewLabel"
      :has-manageable-team-views="panel.hasManageableWorkbenchTeamViews"
      :show-batch-manager="panel.showWorkbenchTeamViewManager"
      :team-view-selection="panel.workbenchTeamViewSelection"
      :team-view-selection-count="panel.workbenchTeamViewSelectionCount"
      :selected-batch-archivable-team-view-ids="panel.selectedBatchArchivableWorkbenchTeamViewIds"
      :selected-batch-restorable-team-view-ids="panel.selectedBatchRestorableWorkbenchTeamViewIds"
      :selected-batch-deletable-team-view-ids="panel.selectedBatchDeletableWorkbenchTeamViewIds"
      :refresh="panel.refreshWorkbenchTeamViews"
      :apply="panel.applyWorkbenchTeamView"
      :save="panel.saveWorkbenchTeamView"
      :duplicate="panel.duplicateWorkbenchTeamView"
      :share="panel.shareWorkbenchTeamView"
      :remove="panel.deleteWorkbenchTeamView"
      :archive="panel.archiveWorkbenchTeamView"
      :restore="panel.restoreWorkbenchTeamView"
      :rename="panel.renameWorkbenchTeamView"
      :transfer="panel.transferWorkbenchTeamView"
      :set-default="panel.setWorkbenchTeamViewDefault"
      :clear-default="panel.clearWorkbenchTeamViewDefault"
      :select-all-team-views="panel.selectAllWorkbenchTeamViews"
      :clear-team-view-selection="panel.clearWorkbenchTeamViewSelection"
      :archive-team-view-selection="panel.archiveWorkbenchTeamViewSelection"
      :restore-team-view-selection="panel.restoreWorkbenchTeamViewSelection"
      :delete-team-view-selection="panel.deleteWorkbenchTeamViewSelection"
    />

    <div class="form-grid">
      <label for="plm-product-id">
        产品 ID
        <input
          id="plm-product-id"
          v-model.trim="panel.productId.value"
          name="plmProductId"
          placeholder="输入 PLM 产品 ID"
        />
      </label>
      <label for="plm-item-number">
        Item Number
        <input
          id="plm-item-number"
          v-model.trim="panel.productItemNumber.value"
          name="plmItemNumber"
          placeholder="输入 item_number（可选）"
        />
      </label>
      <label for="plm-item-type">
        Item Type
        <input
          id="plm-item-type"
          v-model.trim="panel.itemType.value"
          name="plmItemType"
          placeholder="Part"
        />
      </label>
      <button class="btn primary" :disabled="(!panel.productId.value && !panel.productItemNumber.value) || panel.productLoading.value" @click="panel.loadProduct">
        {{ panel.productLoading.value ? '加载中...' : '加载产品' }}
      </button>
    </div>

    <p v-if="panel.productError.value" class="status error">{{ panel.productError.value }}</p>
    <p v-else-if="panel.productLoading.value" class="status">产品加载中...</p>

    <div v-if="panel.product.value" class="detail-grid">
      <div>
        <span>ID</span>
        <strong class="mono">{{ panel.productView.value.id || '-' }}</strong>
      </div>
      <div>
        <span>名称</span>
        <strong>{{ panel.productView.value.name }}</strong>
      </div>
      <div>
        <span>料号</span>
        <strong>{{ panel.productView.value.partNumber }}</strong>
      </div>
      <div>
        <span>版本</span>
        <strong>{{ panel.productView.value.revision }}</strong>
      </div>
      <div>
        <span>状态</span>
        <strong>{{ panel.productView.value.status }}</strong>
      </div>
      <div>
        <span>类型</span>
        <strong>{{ panel.productView.value.itemType }}</strong>
      </div>
      <div>
        <span>更新时间</span>
        <strong>{{ panel.formatTime(panel.productView.value.updatedAt) }}</strong>
      </div>
      <div>
        <span>创建时间</span>
        <strong>{{ panel.formatTime(panel.productView.value.createdAt) }}</strong>
      </div>
    </div>
    <div v-if="panel.product.value" class="inline-actions">
      <button class="btn ghost mini" :disabled="!panel.hasProductCopyValue('id')" @click="panel.copyProductField('id')">
        复制 ID
      </button>
      <button class="btn ghost mini" :disabled="!panel.hasProductCopyValue('number')" @click="panel.copyProductField('number')">
        复制料号
      </button>
      <button
        class="btn ghost mini"
        :disabled="!panel.hasProductCopyValue('revision')"
        @click="panel.copyProductField('revision')"
      >
        复制版本
      </button>
      <button class="btn ghost mini" :disabled="!panel.hasProductCopyValue('type')" @click="panel.copyProductField('type')">
        复制类型
      </button>
      <button class="btn ghost mini" :disabled="!panel.hasProductCopyValue('status')" @click="panel.copyProductField('status')">
        复制状态
      </button>
    </div>
    <div v-else class="empty">
      暂无产品详情
      <span class="empty-hint">（输入产品 ID 或 item number 后加载）</span>
    </div>

    <p v-if="panel.productView.value.description" class="description">{{ panel.productView.value.description }}</p>
    <p v-else-if="panel.product.value" class="muted">暂无描述</p>

    <details v-if="panel.product.value" class="field-map">
      <summary>字段对照清单</summary>
      <table class="data-table">
        <thead>
          <tr>
            <th>字段</th>
            <th>Key</th>
            <th>来源</th>
            <th>回退</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="field in panel.productFieldCatalog" :key="field.key">
            <td>{{ field.label }}</td>
            <td class="mono">{{ field.key }}</td>
            <td>{{ field.source }}</td>
            <td class="muted">{{ field.fallback }}</td>
          </tr>
        </tbody>
      </table>
    </details>

    <details v-if="panel.product.value" class="json-block">
      <summary>原始数据</summary>
      <pre>{{ panel.formatJson(panel.product.value) }}</pre>
    </details>
  </section>
</template>

<script setup lang="ts">
import PlmTeamViewsBlock from './PlmTeamViewsBlock.vue'
import type { PlmProductPanelModel } from '../../views/plm/plmPanelModels'

defineProps<{
  panel: PlmProductPanelModel
}>()
</script>

<style scoped src="./PlmPanelShared.css"></style>
