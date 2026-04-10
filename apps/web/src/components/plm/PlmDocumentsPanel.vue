<template>
  <section class="panel">
    <div class="panel-header">
      <h2>关联文档</h2>
      <div class="panel-actions">
        <button class="btn ghost" @click="panel.copyDeepLink('documents')">复制深链接</button>
        <button class="btn ghost" :disabled="!panel.documentsFiltered.value.length" @click="panel.exportDocumentsCsv">
          导出 CSV
        </button>
        <button class="btn" :disabled="!panel.productId.value || panel.documentsLoading.value" @click="panel.loadDocuments">
          {{ panel.documentsLoading.value ? '加载中...' : '刷新文档' }}
        </button>
      </div>
    </div>
    <div class="form-grid compact">
      <label for="plm-document-role">
        文档角色
        <input
          id="plm-document-role"
          v-model.trim="panel.documentRole.value"
          name="plmDocumentRole"
          placeholder="primary / secondary"
        />
      </label>
      <label for="plm-document-filter">
        过滤
        <input
          id="plm-document-filter"
          v-model.trim="panel.documentFilter.value"
          name="plmDocumentFilter"
          placeholder="名称/类型/作者/MIME"
        />
      </label>
      <label for="plm-document-sort">
        排序
        <select id="plm-document-sort" v-model="panel.documentSortKey.value" name="plmDocumentSort">
          <option value="updated">更新时间</option>
          <option value="created">创建时间</option>
          <option value="name">名称</option>
          <option value="type">类型</option>
          <option value="revision">版本</option>
          <option value="role">角色</option>
          <option value="mime">MIME</option>
          <option value="size">大小</option>
        </select>
      </label>
      <label for="plm-document-sort-dir">
        顺序
        <select id="plm-document-sort-dir" v-model="panel.documentSortDir.value" name="plmDocumentSortDir">
          <option value="desc">降序</option>
          <option value="asc">升序</option>
        </select>
      </label>
    </div>
    <div class="toggle-grid">
      <span class="toggle-label">显示列</span>
      <label v-for="col in panel.documentColumnOptions" :key="col.key" class="checkbox-field" :for="`plm-document-column-${col.key}`">
        <input
          :id="`plm-document-column-${col.key}`"
          :name="`plmDocumentColumn-${col.key}`"
          type="checkbox"
          v-model="panel.documentColumns.value[col.key]"
        />
        <span>{{ col.label }}</span>
      </label>
    </div>
    <PlmTeamViewsBlock
      label="文档"
      select-id="plm-document-team-view"
      select-name="plmDocumentTeamView"
      input-id="plm-document-team-view-name"
      input-name="plmDocumentTeamViewName"
      owner-input-id="plm-document-team-view-owner-user-id"
      owner-input-name="plmDocumentTeamViewOwnerUserId"
      :team-view-key="panel.documentTeamViewKey"
      :team-view-name="panel.documentTeamViewName"
      :team-view-owner-user-id="panel.documentTeamViewOwnerUserId"
      :team-views="panel.documentTeamViews"
      :loading="panel.documentTeamViewsLoading"
      :error="panel.documentTeamViewsError"
      :can-save="panel.canSaveDocumentTeamView"
      :can-apply="panel.canApplyDocumentTeamView"
      :show-manage-actions="panel.showManageDocumentTeamViewActions"
      :can-duplicate="panel.canDuplicateDocumentTeamView"
      :can-share="panel.canShareDocumentTeamView"
      :can-delete="panel.canDeleteDocumentTeamView"
      :can-archive="panel.canArchiveDocumentTeamView"
      :can-restore="panel.canRestoreDocumentTeamView"
      :can-rename="panel.canRenameDocumentTeamView"
      :can-transfer-target="panel.canTransferDocumentTeamViewTarget"
      :can-transfer="panel.canTransferDocumentTeamView"
      :can-set-default="panel.canSetDocumentTeamViewDefault"
      :can-clear-default="panel.canClearDocumentTeamViewDefault"
      :default-label="panel.documentDefaultTeamViewLabel"
      :has-manageable-team-views="panel.hasManageableDocumentTeamViews"
      :show-batch-manager="panel.showDocumentTeamViewManager"
      :team-view-selection="panel.documentTeamViewSelection"
      :team-view-selection-count="panel.documentTeamViewSelectionCount"
      :selected-batch-archivable-team-view-ids="panel.selectedBatchArchivableDocumentTeamViewIds"
      :selected-batch-restorable-team-view-ids="panel.selectedBatchRestorableDocumentTeamViewIds"
      :selected-batch-deletable-team-view-ids="panel.selectedBatchDeletableDocumentTeamViewIds"
      :refresh="panel.refreshDocumentTeamViews"
      :apply="panel.applyDocumentTeamView"
      :save="panel.saveDocumentTeamView"
      :duplicate="panel.duplicateDocumentTeamView"
      :share="panel.shareDocumentTeamView"
      :remove="panel.deleteDocumentTeamView"
      :archive="panel.archiveDocumentTeamView"
      :restore="panel.restoreDocumentTeamView"
      :rename="panel.renameDocumentTeamView"
      :transfer="panel.transferDocumentTeamView"
      :set-default="panel.setDocumentTeamViewDefault"
      :clear-default="panel.clearDocumentTeamViewDefault"
      :select-all-team-views="panel.selectAllDocumentTeamViews"
      :clear-team-view-selection="panel.clearDocumentTeamViewSelection"
      :archive-team-view-selection="panel.archiveDocumentTeamViewSelection"
      :restore-team-view-selection="panel.restoreDocumentTeamViewSelection"
      :delete-team-view-selection="panel.deleteDocumentTeamViewSelection"
    />
    <p v-if="panel.documentsError.value" class="status error">{{ panel.documentsError.value }}</p>
    <p v-if="panel.documentsWarning.value && !panel.documentsError.value" class="status warning">⚠ {{ panel.documentsWarning.value }}</p>
    <p v-if="panel.documentSourceProductId.value" class="status return-source">
      <button class="btn ghost mini" @click="panel.returnToDocumentSource">← 返回源产品</button>
      <span class="return-hint">当前正在查看关联文档对象</span>
    </p>
    <div v-if="!panel.documents.value.length" class="empty">
      暂无文档
      <span class="empty-hint">（可先在 PLM 关联文件或设置文档角色过滤）</span>
    </div>
    <p v-else class="status">共 {{ panel.documents.value.length }} 条，展示 {{ panel.documentsSorted.value.length }} 条</p>
    <div v-if="panel.documents.value.length && !panel.documentsSorted.value.length" class="empty">
      暂无匹配项
      <span class="empty-hint">（可清空过滤条件）</span>
    </div>
    <table v-else class="data-table">
      <thead>
        <tr>
          <th>名称</th>
          <th v-if="panel.documentColumns.value.fileId">File ID</th>
          <th v-if="panel.documentColumns.value.type">类型</th>
          <th v-if="panel.documentColumns.value.revision">版本</th>
          <th v-if="panel.documentColumns.value.role">角色</th>
          <th v-if="panel.documentColumns.value.author">作者</th>
          <th v-if="panel.documentColumns.value.sourceSystem">来源系统</th>
          <th v-if="panel.documentColumns.value.sourceVersion">来源版本</th>
          <th v-if="panel.documentColumns.value.mime">MIME</th>
          <th v-if="panel.documentColumns.value.size">大小</th>
          <th v-if="panel.documentColumns.value.created">创建时间</th>
          <th v-if="panel.documentColumns.value.updated">更新时间</th>
          <th v-if="panel.documentColumns.value.preview">预览</th>
          <th v-if="panel.documentColumns.value.download">下载</th>
          <th v-if="panel.documentColumns.value.cad">CAD</th>
          <th v-if="panel.documentColumns.value.actions">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="doc in panel.documentsSorted.value" :key="doc.id">
          <td>{{ panel.getDocumentName(doc) }}</td>
          <td v-if="panel.documentColumns.value.fileId" class="mono">{{ panel.getDocumentId(doc) }}</td>
          <td v-if="panel.documentColumns.value.type">{{ panel.getDocumentType(doc) }}</td>
          <td v-if="panel.documentColumns.value.revision">{{ panel.getDocumentRevision(doc) }}</td>
          <td v-if="panel.documentColumns.value.role">
            <span class="tag status-neutral">{{ panel.getDocumentRole(doc) }}</span>
          </td>
          <td v-if="panel.documentColumns.value.author">{{ panel.getDocumentAuthor(doc) }}</td>
          <td v-if="panel.documentColumns.value.sourceSystem">{{ panel.getDocumentSourceSystem(doc) }}</td>
          <td v-if="panel.documentColumns.value.sourceVersion">{{ panel.getDocumentSourceVersion(doc) }}</td>
          <td v-if="panel.documentColumns.value.mime">{{ panel.getDocumentMime(doc) }}</td>
          <td v-if="panel.documentColumns.value.size">{{ panel.formatBytes(panel.getDocumentSize(doc)) }}</td>
          <td v-if="panel.documentColumns.value.created">{{ panel.formatTime(panel.getDocumentCreatedAt(doc)) }}</td>
          <td v-if="panel.documentColumns.value.updated">{{ panel.formatTime(panel.getDocumentUpdatedAt(doc)) }}</td>
          <td v-if="panel.documentColumns.value.preview">
            <a
              v-if="panel.getDocumentPreviewUrl(doc)"
              :href="panel.getDocumentPreviewUrl(doc)"
              target="_blank"
              rel="noopener"
            >查看</a>
            <span v-else>-</span>
          </td>
          <td v-if="panel.documentColumns.value.download">
            <a
              v-if="panel.getDocumentDownloadUrl(doc)"
              :href="panel.getDocumentDownloadUrl(doc)"
              target="_blank"
              rel="noopener"
            >下载</a>
            <span v-else>-</span>
          </td>
          <td v-if="panel.documentColumns.value.cad">
            <div class="inline-actions">
              <button class="btn ghost mini" @click="panel.selectCadFile(doc, 'primary')">主</button>
              <button class="btn ghost mini" @click="panel.selectCadFile(doc, 'other')">对比</button>
            </div>
          </td>
          <td v-if="panel.documentColumns.value.actions">
            <div class="inline-actions">
              <button
                v-if="panel.isAmlRelatedDocument(doc)"
                class="btn ghost mini"
                @click="panel.applyProductFromDocument(doc)"
              >
                打开
              </button>
              <button class="btn ghost mini" @click="panel.copyDocumentId(doc)">复制 ID</button>
              <button
                class="btn ghost mini"
                :disabled="!panel.getDocumentDownloadUrl(doc)"
                @click="panel.copyDocumentUrl(doc, 'download')"
              >
                复制下载
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <details class="field-map">
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
          <tr v-for="field in panel.documentFieldCatalog" :key="field.key">
            <td>{{ field.label }}</td>
            <td class="mono">{{ field.key }}</td>
            <td>{{ field.source }}</td>
            <td class="muted">{{ field.fallback }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </section>
</template>

<script setup lang="ts">
import PlmTeamViewsBlock from './PlmTeamViewsBlock.vue'
import type { PlmDocumentsPanelModel } from '../../views/plm/plmPanelModels'

defineProps<{
  panel: PlmDocumentsPanelModel
}>()
</script>

<style scoped src="./PlmPanelShared.css"></style>
