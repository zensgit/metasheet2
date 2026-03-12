<template>
  <section class="panel">
    <div class="panel-header">
      <h2>Where-Used</h2>
      <div class="panel-actions">
        <button class="btn ghost" @click="panel.copyDeepLink('where-used')">复制深链接</button>
        <button
          class="btn ghost"
          :disabled="panel.whereUsedView.value !== 'tree' || !panel.whereUsedHasTree.value"
          @click="panel.expandAllWhereUsed"
        >
          展开全部
        </button>
        <button
          class="btn ghost"
          :disabled="panel.whereUsedView.value !== 'tree' || !panel.whereUsedHasTree.value"
          @click="panel.collapseAllWhereUsed"
        >
          折叠全部
        </button>
        <button
          class="btn ghost"
          :disabled="panel.whereUsedView.value !== 'table' || !panel.whereUsedPathIdsCount.value"
          @click="panel.copyWhereUsedTablePathIdsBulk"
        >
          复制所有路径 ID
        </button>
        <button
          class="btn ghost"
          :disabled="panel.whereUsedView.value !== 'tree' || !panel.whereUsedTreePathIdsCount.value"
          @click="panel.copyWhereUsedTreePathIdsBulk"
        >
          复制树形路径 ID
        </button>
        <button class="btn ghost" :disabled="!panel.whereUsedSelectedCount.value" @click="panel.copyWhereUsedSelectedParents">
          复制选中父件
        </button>
        <button class="btn ghost" :disabled="!panel.whereUsedSelectedCount.value" @click="panel.clearWhereUsedSelection">
          清空选择
        </button>
        <span v-if="panel.whereUsedSelectedCount.value" class="muted">已选 {{ panel.whereUsedSelectedCount.value }}</span>
        <button class="btn ghost" :disabled="!panel.whereUsedFilteredRows.value.length" @click="panel.exportWhereUsedCsv">
          导出 CSV
        </button>
        <button class="btn" :disabled="!panel.whereUsedItemId.value || panel.whereUsedLoading.value" @click="panel.loadWhereUsed">
          {{ panel.whereUsedLoading.value ? '加载中...' : '查询' }}
        </button>
      </div>
    </div>
    <div class="form-grid compact">
      <label for="plm-where-used-item-id">
        子件 ID
        <input
          id="plm-where-used-item-id"
          v-model.trim="panel.whereUsedItemId.value"
          name="plmWhereUsedItemId"
          placeholder="输入子件 ID"
        />
      </label>
      <label for="plm-where-used-quick-pick">
        快速选择
        <select
          id="plm-where-used-quick-pick"
          v-model="panel.whereUsedQuickPick.value"
          name="plmWhereUsedQuickPick"
          :disabled="!panel.whereUsedQuickOptions.value.length"
          @change="panel.applyWhereUsedQuickPick"
        >
          <option value="">从 BOM / 搜索结果选择</option>
          <option v-for="option in panel.whereUsedQuickOptions.value" :key="option.key" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label for="plm-where-used-recursive">
        递归
        <select id="plm-where-used-recursive" v-model="panel.whereUsedRecursive.value" name="plmWhereUsedRecursive">
          <option :value="true">是</option>
          <option :value="false">否</option>
        </select>
      </label>
      <label for="plm-where-used-max-levels">
        最大层级
        <input
          id="plm-where-used-max-levels"
          v-model.number="panel.whereUsedMaxLevels.value"
          name="plmWhereUsedMaxLevels"
          type="number"
          min="1"
          max="20"
        />
      </label>
      <label for="plm-where-used-view">
        视图
        <select id="plm-where-used-view" v-model="panel.whereUsedView.value" name="plmWhereUsedView">
          <option value="table">表格</option>
          <option value="tree">树形</option>
        </select>
      </label>
      <label for="plm-where-used-filter">
        过滤
        <div class="field-inline">
          <select id="plm-where-used-filter-field" v-model="panel.whereUsedFilterField.value" name="plmWhereUsedFilterField">
            <option v-for="option in panel.whereUsedFilterFieldOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <input
            id="plm-where-used-filter"
            v-model.trim="panel.whereUsedFilter.value"
            name="plmWhereUsedFilter"
            :placeholder="panel.whereUsedFilterPlaceholder.value"
          />
        </div>
      </label>
      <label for="plm-where-used-filter-preset">
        预设
        <div class="field-inline">
          <select
            id="plm-where-used-filter-preset-group-filter"
            v-model="panel.whereUsedFilterPresetGroupFilter.value"
            name="plmWhereUsedFilterPresetGroupFilter"
          >
            <option value="all">全部分组</option>
            <option value="ungrouped">未分组</option>
            <option v-for="group in panel.whereUsedFilterPresetGroups.value" :key="group" :value="group">
              {{ group }}
            </option>
          </select>
          <select
            id="plm-where-used-filter-preset"
            v-model="panel.whereUsedFilterPresetKey.value"
            name="plmWhereUsedFilterPreset"
          >
            <option value="">选择预设</option>
            <option v-for="preset in panel.whereUsedFilteredPresets.value" :key="preset.key" :value="preset.key">
              {{ preset.label }}{{ preset.group ? ` (${preset.group})` : '' }}
            </option>
          </select>
          <button class="btn ghost mini" :disabled="!panel.whereUsedFilterPresetKey.value" @click="panel.applyWhereUsedFilterPreset">
            应用
          </button>
          <button class="btn ghost mini" :disabled="!panel.whereUsedFilterPresetKey.value" @click="panel.duplicateWhereUsedFilterPreset">
            复制
          </button>
          <button class="btn ghost mini" :disabled="!panel.whereUsedFilterPresetKey.value" @click="panel.renameWhereUsedFilterPreset">
            重命名
          </button>
          <button class="btn ghost mini" :disabled="!panel.whereUsedFilterPresetKey.value" @click="panel.deleteWhereUsedFilterPreset">
            删除
          </button>
          <button class="btn ghost mini" :disabled="!panel.whereUsedFilterPresetKey.value" @click="panel.promoteWhereUsedFilterPresetToTeam">
            升团队
          </button>
          <button class="btn ghost mini" :disabled="!panel.whereUsedFilterPresetKey.value" @click="panel.promoteWhereUsedFilterPresetToTeamDefault">
            升默认
          </button>
          <button class="btn ghost mini" :disabled="!panel.whereUsedFilterPresetKey.value" @click="panel.shareWhereUsedFilterPreset">
            分享
          </button>
          <button class="btn ghost mini" :disabled="!panel.whereUsedFilterPresetKey.value" @click="panel.assignWhereUsedPresetGroup">
            设为分组
          </button>
        </div>
        <div class="field-inline">
          <input
            id="plm-where-used-filter-preset-name"
            v-model.trim="panel.whereUsedFilterPresetName.value"
            name="plmWhereUsedFilterPresetName"
            placeholder="新预设名称"
          />
          <input
            id="plm-where-used-filter-preset-group"
            v-model.trim="panel.whereUsedFilterPresetGroup.value"
            name="plmWhereUsedFilterPresetGroup"
            class="deep-link-input"
            placeholder="分组（可选）"
          />
          <button class="btn ghost mini" :disabled="!panel.canSaveWhereUsedFilterPreset.value" @click="panel.saveWhereUsedFilterPreset">
            保存
          </button>
        </div>
        <div class="field-inline field-actions">
          <button
            class="btn ghost mini"
            :disabled="!panel.whereUsedFilterPresets.value.length"
            @click="panel.exportWhereUsedFilterPresets"
          >
            导出
          </button>
          <input
            id="plm-where-used-filter-preset-import"
            v-model.trim="panel.whereUsedFilterPresetImportText.value"
            name="plmWhereUsedFilterPresetImport"
            class="deep-link-input"
            placeholder="粘贴 JSON"
          />
          <select
            id="plm-where-used-filter-preset-import-mode"
            v-model="panel.whereUsedFilterPresetImportMode.value"
            name="plmWhereUsedFilterPresetImportMode"
            class="deep-link-select"
          >
            <option value="merge">合并</option>
            <option value="replace">覆盖</option>
          </select>
          <button
            class="btn ghost mini"
            :disabled="!panel.whereUsedFilterPresetImportText.value"
            @click="panel.importWhereUsedFilterPresets"
          >
            导入
          </button>
          <button class="btn ghost mini" @click="panel.triggerWhereUsedFilterPresetFileImport">文件</button>
          <input
            :ref="panel.whereUsedFilterPresetFileInput"
            id="plm-where-used-filter-preset-file"
            name="plmWhereUsedFilterPresetFile"
            class="deep-link-file"
            type="file"
            accept=".json,application/json"
            @change="panel.handleWhereUsedFilterPresetFileImport"
          />
          <button
            id="plm-where-used-filter-preset-clear"
            class="btn ghost mini"
            :disabled="!panel.whereUsedFilterPresets.value.length"
            @click="panel.clearWhereUsedFilterPresets"
          >
            清空
          </button>
          <button class="btn ghost mini" @click="panel.showWhereUsedPresetManager.value = !panel.showWhereUsedPresetManager.value">
            {{ panel.showWhereUsedPresetManager.value ? '收起' : '管理' }}
          </button>
        </div>
        <div v-if="panel.showWhereUsedPresetManager.value" class="preset-manager">
          <div class="field-inline field-actions">
            <button class="btn ghost mini" :disabled="!panel.whereUsedFilteredPresets.value.length" @click="panel.selectAllWhereUsedPresets">
              全选
            </button>
            <button class="btn ghost mini" :disabled="!panel.whereUsedPresetSelectionCount.value" @click="panel.clearWhereUsedPresetSelection">
              清空选择
            </button>
            <span class="muted">已选 {{ panel.whereUsedPresetSelectionCount.value }}/{{ panel.whereUsedFilteredPresets.value.length }}</span>
          </div>
          <div class="field-inline field-actions">
            <input
              id="plm-where-used-filter-preset-batch-group"
              v-model.trim="panel.whereUsedPresetBatchGroup.value"
              name="plmWhereUsedFilterPresetBatchGroup"
              class="deep-link-input"
              placeholder="批量分组（留空清除）"
            />
            <button class="btn ghost mini" :disabled="!panel.whereUsedPresetSelectionCount.value" @click="panel.applyWhereUsedPresetBatchGroup">
              应用分组
            </button>
            <button class="btn ghost mini danger" :disabled="!panel.whereUsedPresetSelectionCount.value" @click="panel.deleteWhereUsedPresetSelection">
              批量删除
            </button>
          </div>
          <div class="preset-list">
            <label v-for="preset in panel.whereUsedFilteredPresets.value" :key="preset.key" class="preset-item">
              <input type="checkbox" :value="preset.key" v-model="panel.whereUsedPresetSelection.value" />
              <span>{{ preset.label }}{{ preset.group ? ` (${preset.group})` : '' }}</span>
            </label>
          </div>
        </div>
        <div class="team-preset-block">
          <div class="team-preset-header">
            <span class="team-preset-title">团队预设</span>
            <button class="btn ghost mini" :disabled="panel.whereUsedTeamPresetsLoading.value" @click="panel.refreshWhereUsedTeamPresets">
              {{ panel.whereUsedTeamPresetsLoading.value ? '刷新中...' : '刷新' }}
            </button>
          </div>
          <div class="field-inline">
            <select id="plm-where-used-team-preset" v-model="panel.whereUsedTeamPresetKey.value" name="plmWhereUsedTeamPreset">
              <option value="">选择团队预设</option>
              <option v-for="preset in panel.whereUsedTeamPresets.value" :key="preset.id" :value="preset.id">
                {{ preset.name }}{{ preset.state.group ? ` (${preset.state.group})` : '' }} · {{ preset.ownerUserId }}{{ preset.isDefault ? ' · 默认' : '' }}{{ preset.isArchived ? ' · 已归档' : '' }}
              </option>
            </select>
            <button class="btn ghost mini" :disabled="!panel.canApplyWhereUsedTeamPreset.value" @click="panel.applyWhereUsedTeamPreset">
              应用
            </button>
            <button class="btn ghost mini" :disabled="!panel.canDuplicateWhereUsedTeamPreset.value" @click="panel.duplicateWhereUsedTeamPreset">
              复制副本
            </button>
            <button
              v-if="panel.showManageWhereUsedTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canShareWhereUsedTeamPreset.value"
              @click="panel.shareWhereUsedTeamPreset"
            >
              分享
            </button>
            <button
              v-if="panel.showManageWhereUsedTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canArchiveWhereUsedTeamPreset.value"
              @click="panel.archiveWhereUsedTeamPreset"
            >
              归档
            </button>
            <button
              v-if="panel.showManageWhereUsedTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canRestoreWhereUsedTeamPreset.value"
              @click="panel.restoreWhereUsedTeamPreset"
            >
              恢复
            </button>
            <button
              v-if="panel.showManageWhereUsedTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canRenameWhereUsedTeamPreset.value"
              @click="panel.renameWhereUsedTeamPreset"
            >
              重命名
            </button>
            <button
              v-if="panel.showManageWhereUsedTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canSetWhereUsedTeamPresetDefault.value"
              @click="panel.setWhereUsedTeamPresetDefault"
            >
              设为默认
            </button>
            <button
              v-if="panel.showManageWhereUsedTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canClearWhereUsedTeamPresetDefault.value"
              @click="panel.clearWhereUsedTeamPresetDefault"
            >
              取消默认
            </button>
            <button
              v-if="panel.showManageWhereUsedTeamPresetActions.value"
              class="btn ghost mini danger"
              :disabled="!panel.canDeleteWhereUsedTeamPreset.value"
              @click="panel.deleteWhereUsedTeamPreset"
            >
              删除
            </button>
          </div>
          <p v-if="panel.whereUsedDefaultTeamPresetLabel.value" class="status">当前默认：{{ panel.whereUsedDefaultTeamPresetLabel.value }}</p>
          <div class="field-inline">
            <input
              id="plm-where-used-team-preset-name"
              v-model.trim="panel.whereUsedTeamPresetName.value"
              name="plmWhereUsedTeamPresetName"
              placeholder="团队预设名称"
            />
            <input
              id="plm-where-used-team-preset-group"
              v-model.trim="panel.whereUsedTeamPresetGroup.value"
              name="plmWhereUsedTeamPresetGroup"
              class="deep-link-input"
              placeholder="分组（可选）"
            />
            <button
              class="btn ghost mini"
              :disabled="!panel.canSaveWhereUsedTeamPreset.value || panel.whereUsedTeamPresetsLoading.value"
              @click="panel.saveWhereUsedTeamPreset"
            >
              保存到团队
            </button>
          </div>
          <div v-if="panel.showManageWhereUsedTeamPresetActions.value" class="field-inline">
            <input
              id="plm-where-used-team-preset-owner"
              v-model.trim="panel.whereUsedTeamPresetOwnerUserId.value"
              name="plmWhereUsedTeamPresetOwnerUserId"
              class="deep-link-input"
              placeholder="目标用户 ID"
            />
            <button
              class="btn ghost mini"
              :disabled="!panel.canTransferWhereUsedTeamPreset.value || panel.whereUsedTeamPresetsLoading.value"
              @click="panel.transferWhereUsedTeamPreset"
            >
              转移所有者
            </button>
          </div>
          <div v-if="panel.hasManageableWhereUsedTeamPresets.value" class="field-inline field-actions">
            <button class="btn ghost mini" @click="panel.showWhereUsedTeamPresetManager.value = !panel.showWhereUsedTeamPresetManager.value">
              {{ panel.showWhereUsedTeamPresetManager.value ? '收起批量管理' : '批量管理' }}
            </button>
          </div>
          <div
            v-if="panel.showWhereUsedTeamPresetManager.value && panel.hasManageableWhereUsedTeamPresets.value"
            class="preset-manager"
          >
            <div class="field-inline field-actions">
              <button class="btn ghost mini" @click="panel.selectAllWhereUsedTeamPresets">全选可管理</button>
              <button
                class="btn ghost mini"
                :disabled="!panel.whereUsedTeamPresetSelectionCount.value"
                @click="panel.clearWhereUsedTeamPresetSelection"
              >
                清空选择
              </button>
              <span class="muted">已选 {{ panel.whereUsedTeamPresetSelectionCount.value }}/{{ panel.whereUsedTeamPresets.value.length }}</span>
            </div>
            <div class="field-inline field-actions">
              <button
                class="btn ghost mini"
                :disabled="!panel.selectedBatchArchivableWhereUsedTeamPresetIds.value.length"
                @click="panel.archiveWhereUsedTeamPresetSelection"
              >
                批量归档
              </button>
              <button
                class="btn ghost mini"
                :disabled="!panel.selectedBatchRestorableWhereUsedTeamPresetIds.value.length"
                @click="panel.restoreWhereUsedTeamPresetSelection"
              >
                批量恢复
              </button>
              <button
                class="btn ghost mini danger"
                :disabled="!panel.selectedBatchDeletableWhereUsedTeamPresetIds.value.length"
                @click="panel.deleteWhereUsedTeamPresetSelection"
              >
                批量删除
              </button>
            </div>
            <div class="preset-list">
              <label v-for="preset in panel.whereUsedTeamPresets.value" :key="preset.id" class="preset-item">
                <input
                  type="checkbox"
                  :value="preset.id"
                  v-model="panel.whereUsedTeamPresetSelection.value"
                  :disabled="!preset.permissions?.canManage && !preset.canManage"
                />
                <span>
                  {{ preset.name }}{{ preset.state.group ? ` (${preset.state.group})` : '' }} · {{ preset.ownerUserId }}{{ preset.isDefault ? ' · 默认' : '' }}{{ preset.isArchived ? ' · 已归档' : '' }}{{ !preset.permissions?.canManage && !preset.canManage ? ' · 只读' : '' }}
                </span>
              </label>
            </div>
          </div>
          <p v-if="panel.whereUsedTeamPresetsError.value" class="status error">{{ panel.whereUsedTeamPresetsError.value }}</p>
        </div>
      </label>
    </div>
    <p v-if="!panel.whereUsedItemId.value" class="hint">
      提示：可从 BOM / 对比 / 替代件面板点击 Where-Used 自动填入。
    </p>
    <p v-if="panel.whereUsedError.value" class="status error">{{ panel.whereUsedError.value }}</p>
    <div v-if="!panel.whereUsed.value" class="empty">
      暂无 where-used 数据
      <span class="empty-hint">（输入子件 ID 后查询）</span>
    </div>
    <div v-else>
      <p class="status">共 {{ panel.whereUsed.value.count || 0 }} 条，展示 {{ panel.whereUsedFilteredRows.value.length }} 条</p>
      <div v-if="!panel.whereUsedFilteredRows.value.length" class="empty">
        暂无匹配项
        <span class="empty-hint">（可清空过滤条件）</span>
      </div>
      <div v-else-if="panel.whereUsedView.value === 'tree'" class="where-used-tree">
        <div class="tree-row tree-header">
          <div class="tree-cell">节点</div>
          <div class="tree-cell">名称</div>
          <div class="tree-cell">数量</div>
          <div class="tree-cell">单位</div>
          <div class="tree-cell">Find #</div>
          <div class="tree-cell">Refdes</div>
          <div class="tree-cell">关系 ID</div>
          <div class="tree-cell">操作</div>
        </div>
        <div
          v-for="row in panel.whereUsedTreeVisibleRows.value"
          :key="row.key"
          class="tree-row"
          :class="{ 'tree-root': row.depth === 0, selected: panel.isWhereUsedTreeSelected(row) }"
          :data-entry-count="row.entryCount"
          @click="panel.selectWhereUsedTreeRow(row)"
        >
          <div class="tree-cell tree-node" :style="{ paddingLeft: `${row.depth * 16}px` }">
            <button class="tree-toggle" :disabled="!row.hasChildren" @click.stop="panel.toggleWhereUsedNode(row.key)">
              {{ row.hasChildren ? (panel.isWhereUsedCollapsed(row.key) ? '▸' : '▾') : '•' }}
            </button>
            <span class="mono">{{ row.label || row.id }}</span>
            <span v-if="row.entryCount > 1" class="tree-multi">×{{ row.entryCount }}</span>
          </div>
          <div class="tree-cell">{{ row.name || '-' }}</div>
          <div class="tree-cell">{{ panel.getWhereUsedTreeLineValue(row, 'quantity') }}</div>
          <div class="tree-cell">{{ panel.getWhereUsedTreeLineValue(row, 'uom') }}</div>
          <div class="tree-cell">{{ panel.getWhereUsedTreeLineValue(row, 'find_num') }}</div>
          <div class="tree-cell">{{ panel.getWhereUsedTreeRefdes(row) }}</div>
          <div class="tree-cell">
            <div class="tree-bom-meta">
              <span class="mono">{{ panel.getWhereUsedTreeRelationship(row) }}</span>
              <button
                class="btn ghost mini"
                :disabled="!panel.formatWhereUsedPathIds(row)"
                :title="panel.formatWhereUsedPathIds(row)"
                @click="panel.copyWhereUsedPathIds(row)"
              >
                路径 ID
              </button>
            </div>
          </div>
          <div class="tree-cell">
            <button
              class="btn ghost mini"
              :disabled="!row.id || panel.productLoading.value"
              @click.stop="panel.applyProductFromWhereUsedRow(row)"
            >
              产品
            </button>
          </div>
        </div>
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>层级</th>
            <th>父件编号</th>
            <th>父件名称</th>
            <th>路径</th>
            <th>路径 ID</th>
            <th>数量</th>
            <th>单位</th>
            <th>Find #</th>
            <th>Refdes</th>
            <th>关系 ID</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in panel.whereUsedFilteredRows.value"
            :key="entry._key"
            :class="{ 'row-selected': panel.isWhereUsedEntrySelected(entry) }"
            @click="panel.selectWhereUsedTableRow(entry)"
          >
            <td>{{ entry.level }}</td>
            <td>{{ panel.getItemNumber(entry.parent) }}</td>
            <td>{{ panel.getItemName(entry.parent) }}</td>
            <td>
              <details v-if="entry.pathLabel" class="inline-details">
                <summary>{{ entry.pathLabel }}</summary>
                <div class="path-list">
                  <div v-for="(node, idx) in entry.pathNodes" :key="`${entry._key}-path-${idx}`" class="path-node">
                    <span class="path-index">{{ idx }}</span>
                    <span class="mono">{{ node.label }}</span>
                    <span v-if="node.name && node.name !== node.label" class="muted">{{ node.name }}</span>
                    <span class="muted">{{ node.id }}</span>
                  </div>
                </div>
              </details>
              <span v-else>-</span>
            </td>
            <td>
              <div class="tree-bom-meta">
                <span class="mono">{{ panel.formatWhereUsedEntryPathIds(entry) || '-' }}</span>
                <button
                  class="btn ghost mini"
                  :disabled="!panel.formatWhereUsedEntryPathIds(entry)"
                  :title="panel.formatWhereUsedEntryPathIds(entry)"
                  @click="panel.copyWhereUsedEntryPathIds(entry)"
                >
                  路径 ID
                </button>
              </div>
            </td>
            <td>{{ panel.getWhereUsedLineValue(entry, 'quantity') }}</td>
            <td>{{ panel.getWhereUsedLineValue(entry, 'uom') }}</td>
            <td>{{ panel.getWhereUsedLineValue(entry, 'find_num') }}</td>
            <td>{{ panel.getWhereUsedRefdes(entry) }}</td>
            <td>{{ entry.relationship?.id || '-' }}</td>
            <td>
              <button
                class="btn ghost mini"
                :disabled="!panel.resolveWhereUsedParentId(entry) || panel.productLoading.value"
                @click.stop="panel.applyProductFromWhereUsed(entry)"
              >
                产品
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <details class="json-block">
        <summary>原始数据</summary>
        <pre>{{ panel.formatJson(panel.whereUsed.value) }}</pre>
      </details>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PlmWhereUsedPanelModel } from '../../views/plm/plmPanelModels'

defineProps<{
  panel: PlmWhereUsedPanelModel
}>()
</script>

<style scoped src="./PlmPanelShared.css"></style>
