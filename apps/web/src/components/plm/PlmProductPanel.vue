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
      :can-transfer-target="panel.canTransferWorkbenchTeamViewTarget"
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

    <div class="scene-catalog">
      <div class="scene-catalog__header">
        <div>
          <h2>团队场景目录</h2>
          <p class="muted">快速应用当前团队推荐场景，或跳转查看默认场景变更审计。</p>
        </div>
        <div class="scene-catalog__toolbar">
          <label
            v-if="panel.sceneCatalogOwnerOptions.value.length"
            class="scene-catalog__filter"
            for="plm-scene-catalog-owner"
          >
            <span>Owner</span>
            <select
              id="plm-scene-catalog-owner"
              v-model="panel.sceneCatalogOwnerFilter.value"
              name="plmSceneCatalogOwner"
            >
              <option value="">全部</option>
              <option v-for="owner in panel.sceneCatalogOwnerOptions.value" :key="owner" :value="owner">
                {{ owner }}
              </option>
            </select>
          </label>
          <label class="scene-catalog__filter" for="plm-scene-catalog-recommendation">
            <span>推荐</span>
            <select
              id="plm-scene-catalog-recommendation"
              v-model="panel.sceneCatalogRecommendationFilter.value"
              name="plmSceneCatalogRecommendation"
            >
              <option
                v-for="option in panel.sceneCatalogRecommendationOptions"
                :key="option.value || 'all'"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
          <button class="btn ghost" @click="panel.openWorkbenchSceneAudit">查看场景审计</button>
        </div>
      </div>
      <div v-if="panel.sceneCatalogSummaryChips.value.length" class="scene-catalog__summary">
        <button
          v-for="chip in panel.sceneCatalogSummaryChips.value"
          :key="chip.value || 'all'"
          class="scene-catalog__summary-chip"
          :class="{ 'scene-catalog__summary-chip--active': chip.active }"
          type="button"
          :aria-pressed="chip.active"
          @click="handleSceneCatalogSummaryClick(chip.value)"
        >
          <span>{{ chip.label }}</span>
          <strong>{{ chip.count }}</strong>
        </button>
      </div>
      <p v-if="panel.sceneCatalogSummaryHint.value" class="scene-catalog__summary-hint">
        <strong>{{ panel.sceneCatalogSummaryHint.value.label }}</strong>
        <span>共 {{ panel.sceneCatalogSummaryHint.value.count }} 个场景。</span>
        <span>{{ panel.sceneCatalogSummaryHint.value.description }}</span>
      </p>
      <div v-if="panel.recommendedWorkbenchScenes.value.length" class="scene-catalog__list">
        <article
          v-for="scene in panel.recommendedWorkbenchScenes.value"
          :key="scene.id"
          class="scene-catalog__item"
          :class="{ 'scene-catalog__item--highlighted': highlightedSceneId === scene.id }"
          :ref="(el) => setSceneCatalogItemRef(scene.id, el)"
          :data-scene-id="scene.id"
          tabindex="-1"
        >
          <div class="scene-catalog__meta">
            <strong>{{ scene.name }}</strong>
            <span
              v-if="sceneBadgeLabel(scene)"
              class="scene-catalog__badge"
              :class="{ 'scene-catalog__badge--default': scene.isDefault }"
            >
              {{ sceneBadgeLabel(scene) }}
            </span>
            <span class="muted">Owner: {{ scene.ownerUserId || '-' }}</span>
            <span v-if="scene.lastDefaultSetAt" class="muted">
              最近设默认 {{ panel.formatTime(scene.lastDefaultSetAt) }}
            </span>
            <span class="muted">更新于 {{ panel.formatTime(scene.updatedAt) }}</span>
            <span class="scene-catalog__reason">
              推荐来源：{{ scene.recommendationSourceLabel }}
              <template v-if="scene.recommendationSourceTimestamp">
                · {{ panel.formatTime(scene.recommendationSourceTimestamp) }}
              </template>
            </span>
            <span class="scene-catalog__action-note">{{ scene.actionNote }}</span>
          </div>
          <div class="scene-catalog__actions">
            <button
              class="btn mini"
              :class="scene.isDefault ? 'primary' : 'ghost'"
              :disabled="scene.primaryActionDisabled"
              @click="panel.applyRecommendedWorkbenchScene(scene.id)"
            >
              {{ scene.primaryActionLabel }}
            </button>
            <button class="btn ghost mini" :disabled="scene.secondaryActionDisabled" @click="handleSceneSecondaryAction(scene)">
              {{ scene.secondaryActionLabel }}
            </button>
          </div>
        </article>
      </div>
      <p v-else class="muted">暂无团队场景。</p>
    </div>

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
      <summary>字段对照清单（静态）</summary>
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

    <details v-if="panel.product.value" class="field-map">
      <summary>模型字段（AML Metadata，{{ panel.productMetadataRows.value.length }}）</summary>
      <p v-if="panel.productMetadataLoading.value" class="status">模型字段加载中...</p>
      <p v-else-if="panel.productMetadataError.value" class="status error">{{ panel.productMetadataError.value }}</p>
      <p v-else-if="!panel.productMetadataRows.value.length" class="muted">当前类型暂无模型字段定义</p>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>Label</th>
            <th>Name</th>
            <th>Type</th>
            <th>必填</th>
            <th>长度</th>
            <th>默认值</th>
            <th>当前值</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="field in panel.productMetadataRows.value" :key="field.name">
            <td>{{ field.label }}</td>
            <td class="mono">{{ field.name }}</td>
            <td>{{ field.type }}</td>
            <td>{{ field.required ? '是' : '否' }}</td>
            <td>{{ field.length }}</td>
            <td class="muted">{{ field.defaultValue }}</td>
            <td>{{ field.currentValue }}</td>
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
import { nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue'
import PlmTeamViewsBlock from './PlmTeamViewsBlock.vue'
import { resolvePlmSceneCatalogAutoFocus } from './plmSceneCatalogAutoFocus'
import type {
  PlmProductPanelModel,
  PlmRecommendedWorkbenchScene,
  PlmWorkbenchSceneRecommendationFilter,
} from '../../views/plm/plmPanelModels'

const props = defineProps<{
  panel: PlmProductPanelModel
}>()

const highlightedSceneId = ref('')
const sceneCatalogItemRefs = new Map<string, HTMLElement>()
let sceneCatalogHighlightTimer: ReturnType<typeof setTimeout> | null = null

function setSceneCatalogItemRef(
  sceneId: string,
  el: Element | ComponentPublicInstance | null,
) {
  if (el instanceof HTMLElement) {
    sceneCatalogItemRefs.set(sceneId, el)
    return
  }
  sceneCatalogItemRefs.delete(sceneId)
}

function clearSceneCatalogHighlight() {
  if (sceneCatalogHighlightTimer) {
    clearTimeout(sceneCatalogHighlightTimer)
    sceneCatalogHighlightTimer = null
  }
  highlightedSceneId.value = ''
}

function highlightScene(sceneId: string) {
  clearSceneCatalogHighlight()
  highlightedSceneId.value = sceneId
  sceneCatalogHighlightTimer = setTimeout(() => {
    highlightedSceneId.value = ''
    sceneCatalogHighlightTimer = null
  }, 1600)
}

async function handleSceneCatalogSummaryClick(value: PlmWorkbenchSceneRecommendationFilter) {
  props.panel.setSceneCatalogRecommendationFilter(value)
  await nextTick()
  const targetScene = props.panel.recommendedWorkbenchScenes.value[0]
  if (!targetScene) {
    clearSceneCatalogHighlight()
    return
  }
  highlightScene(targetScene.id)
  const element = sceneCatalogItemRefs.get(targetScene.id)
  element?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  element?.focus?.({ preventScroll: true })
}

onBeforeUnmount(() => {
  clearSceneCatalogHighlight()
  sceneCatalogItemRefs.clear()
})

function sceneBadgeLabel(scene: PlmRecommendedWorkbenchScene) {
  if (scene.isDefault) return '默认'
  if (scene.recommendationReason === 'recent-default') return '近期默认'
  if (scene.recommendationReason === 'recent-update') return '近期更新'
  return ''
}

async function handleSceneSecondaryAction(scene: PlmRecommendedWorkbenchScene) {
  if (scene.secondaryActionKind === 'copy-link') {
    await props.panel.copyRecommendedWorkbenchSceneLink(scene.id)
    return
  }

  await props.panel.openRecommendedWorkbenchSceneAudit(scene)
}

watch(
  () => [
    props.panel.sceneCatalogAutoFocusSceneId.value,
    props.panel.recommendedWorkbenchScenes.value.map((scene) => scene.id).join(','),
    props.panel.workbenchTeamViews.value.map((view) => view.id).join(','),
  ],
  async ([sceneId]) => {
    const resolution = resolvePlmSceneCatalogAutoFocus(
      sceneId,
      props.panel.recommendedWorkbenchScenes.value.map((scene) => scene.id),
      props.panel.workbenchTeamViews.value.map((view) => view.id),
    )
    if (!resolution.targetSceneId) {
      if (resolution.shouldClear) {
        clearSceneCatalogHighlight()
        props.panel.clearSceneCatalogAutoFocusSceneId()
      }
      return
    }
    await nextTick()
    highlightScene(resolution.targetSceneId)
    const element = sceneCatalogItemRefs.get(resolution.targetSceneId)
    element?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
    element?.focus?.({ preventScroll: true })
    props.panel.clearSceneCatalogAutoFocusSceneId()
  },
  { flush: 'post' },
)
</script>

<style scoped src="./PlmPanelShared.css"></style>
