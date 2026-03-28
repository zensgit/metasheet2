<template>
  <section class="panel">
    <div class="panel-header">
      <h2>BOM 结构</h2>
      <div class="panel-actions">
        <button class="btn ghost" :disabled="panel.bomView.value !== 'tree' || !panel.bomHasTree.value" @click="panel.expandAllBom">
          展开全部
        </button>
        <button class="btn ghost" :disabled="panel.bomView.value !== 'tree' || !panel.bomHasTree.value" @click="panel.collapseAllBom">
          折叠全部
        </button>
        <button
          class="btn ghost"
          :disabled="panel.bomView.value !== 'tree' || !panel.bomHasTree.value"
          @click="panel.expandBomToDepth(panel.bomDepth.value)"
        >
          展开到深度
        </button>
        <button
          class="btn ghost"
          :disabled="panel.bomView.value !== 'table' || !panel.bomTablePathIdsCount.value"
          @click="panel.copyBomTablePathIdsBulk"
        >
          复制所有路径 ID
        </button>
        <button
          class="btn ghost"
          :disabled="panel.bomView.value !== 'tree' || !panel.bomTreePathIdsCount.value"
          @click="panel.copyBomTreePathIdsBulk"
        >
          复制树形路径 ID
        </button>
        <button class="btn ghost" :disabled="!panel.bomSelectedCount.value" @click="panel.copyBomSelectedChildIds">
          复制选中子件
        </button>
        <button class="btn ghost" :disabled="!panel.bomSelectedCount.value" @click="panel.clearBomSelection">
          清空选择
        </button>
        <span v-if="panel.bomSelectedCount.value" class="muted">已选 {{ panel.bomSelectedCount.value }}</span>
        <button class="btn ghost" :disabled="!panel.bomExportCount.value" @click="panel.exportBomCsv">
          导出 CSV
        </button>
        <button class="btn" :disabled="!panel.productId.value || panel.bomLoading.value" @click="panel.loadBom">
          {{ panel.bomLoading.value ? '加载中...' : '刷新 BOM' }}
        </button>
      </div>
    </div>
    <div class="form-grid compact">
      <label for="plm-bom-depth">
        深度
        <div class="field-inline">
          <input
            id="plm-bom-depth"
            v-model.number="panel.bomDepth.value"
            name="plmBomDepth"
            type="number"
            min="1"
            max="10"
          />
          <div class="field-actions">
            <button
              v-for="depth in panel.BOM_DEPTH_QUICK_OPTIONS"
              :key="`bom-depth-${depth}`"
              class="btn ghost mini"
              type="button"
              :disabled="panel.bomDepth.value === depth"
              @click="panel.setBomDepthQuick(depth)"
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
          v-model="panel.bomEffectiveAt.value"
          name="plmBomEffectiveAt"
          type="datetime-local"
        />
      </label>
      <label for="plm-bom-view">
        视图
        <select id="plm-bom-view" v-model="panel.bomView.value" name="plmBomView">
          <option value="table">表格</option>
          <option value="tree">树形</option>
        </select>
      </label>
      <label for="plm-bom-filter">
        过滤
        <div class="field-inline">
          <select id="plm-bom-filter-field" v-model="panel.bomFilterField.value" name="plmBomFilterField">
            <option v-for="option in panel.bomFilterFieldOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <input
            id="plm-bom-filter"
            v-model.trim="panel.bomFilter.value"
            name="plmBomFilter"
            :placeholder="panel.bomFilterPlaceholder.value"
          />
        </div>
      </label>
      <label for="plm-bom-filter-preset">
        预设
        <div class="field-inline">
          <select
            id="plm-bom-filter-preset-group-filter"
            v-model="panel.bomFilterPresetGroupFilter.value"
            name="plmBomFilterPresetGroupFilter"
          >
            <option value="all">全部分组</option>
            <option value="ungrouped">未分组</option>
            <option v-for="group in panel.bomFilterPresetGroups.value" :key="group" :value="group">
              {{ group }}
            </option>
          </select>
          <select id="plm-bom-filter-preset" v-model="panel.bomFilterPresetKey.value" name="plmBomFilterPreset">
            <option value="">选择预设</option>
            <option v-for="preset in panel.bomFilteredPresets.value" :key="preset.key" :value="preset.key">
              {{ preset.label }}{{ preset.group ? ` (${preset.group})` : '' }}
            </option>
          </select>
          <button
            id="plm-bom-filter-preset-apply"
            class="btn ghost mini"
            :disabled="!panel.bomFilterPresetKey.value"
            @click="panel.applyBomFilterPreset"
          >
            应用
          </button>
          <button class="btn ghost mini" :disabled="!panel.bomFilterPresetKey.value" @click="panel.duplicateBomFilterPreset">
            复制
          </button>
          <button class="btn ghost mini" :disabled="!panel.bomFilterPresetKey.value" @click="panel.renameBomFilterPreset">
            重命名
          </button>
          <button class="btn ghost mini" :disabled="!panel.bomFilterPresetKey.value" @click="panel.deleteBomFilterPreset">
            删除
          </button>
          <button class="btn ghost mini" :disabled="!panel.bomFilterPresetKey.value" @click="panel.promoteBomFilterPresetToTeam">
            升团队
          </button>
          <button class="btn ghost mini" :disabled="!panel.bomFilterPresetKey.value" @click="panel.promoteBomFilterPresetToTeamDefault">
            升默认
          </button>
          <button
            id="plm-bom-filter-preset-share"
            class="btn ghost mini"
            :disabled="!panel.bomFilterPresetKey.value"
            @click="panel.shareBomFilterPreset"
          >
            分享
          </button>
          <button
            id="plm-bom-filter-preset-assign-group"
            class="btn ghost mini"
            :disabled="!panel.bomFilterPresetKey.value"
            @click="panel.assignBomPresetGroup"
          >
            设为分组
          </button>
        </div>
        <div class="field-inline">
          <input
            id="plm-bom-filter-preset-name"
            v-model.trim="panel.bomFilterPresetName.value"
            name="plmBomFilterPresetName"
            placeholder="新预设名称"
          />
          <input
            id="plm-bom-filter-preset-group"
            v-model.trim="panel.bomFilterPresetGroup.value"
            name="plmBomFilterPresetGroup"
            class="deep-link-input"
            placeholder="分组（可选）"
          />
          <button
            id="plm-bom-filter-preset-save"
            class="btn ghost mini"
            :disabled="!panel.canSaveBomFilterPreset.value"
            @click="panel.saveBomFilterPreset"
          >
            保存
          </button>
        </div>
        <div class="field-inline field-actions">
          <button
            id="plm-bom-filter-preset-export"
            class="btn ghost mini"
            :disabled="!panel.bomFilterPresets.value.length"
            @click="panel.exportBomFilterPresets"
          >
            导出
          </button>
          <input
            id="plm-bom-filter-preset-import"
            v-model.trim="panel.bomFilterPresetImportText.value"
            name="plmBomFilterPresetImport"
            class="deep-link-input"
            placeholder="粘贴 JSON"
          />
          <select
            id="plm-bom-filter-preset-import-mode"
            v-model="panel.bomFilterPresetImportMode.value"
            name="plmBomFilterPresetImportMode"
            class="deep-link-select"
          >
            <option value="merge">合并</option>
            <option value="replace">覆盖</option>
          </select>
          <button
            id="plm-bom-filter-preset-import-apply"
            class="btn ghost mini"
            :disabled="!panel.bomFilterPresetImportText.value"
            @click="panel.importBomFilterPresets"
          >
            导入
          </button>
          <button class="btn ghost mini" @click="panel.triggerBomFilterPresetFileImport">文件</button>
          <input
            :ref="panel.bomFilterPresetFileInput"
            id="plm-bom-filter-preset-file"
            name="plmBomFilterPresetFile"
            class="deep-link-file"
            type="file"
            accept=".json,application/json"
            @change="panel.handleBomFilterPresetFileImport"
          />
          <button
            id="plm-bom-filter-preset-clear"
            class="btn ghost mini"
            :disabled="!panel.bomFilterPresets.value.length"
            @click="panel.clearBomFilterPresets"
          >
            清空
          </button>
          <button
            id="plm-bom-filter-preset-manager-toggle"
            class="btn ghost mini"
            @click="panel.showBomPresetManager.value = !panel.showBomPresetManager.value"
          >
            {{ panel.showBomPresetManager.value ? '收起' : '管理' }}
          </button>
        </div>
        <div v-if="panel.showBomPresetManager.value" class="preset-manager">
          <div class="field-inline field-actions">
            <button class="btn ghost mini" :disabled="!panel.bomFilteredPresets.value.length" @click="panel.selectAllBomPresets">
              全选
            </button>
            <button class="btn ghost mini" :disabled="!panel.bomPresetSelectionCount.value" @click="panel.clearBomPresetSelection">
              清空选择
            </button>
            <span class="muted">已选 {{ panel.bomPresetSelectionCount.value }}/{{ panel.bomFilteredPresets.value.length }}</span>
          </div>
          <div class="field-inline field-actions">
            <input
              id="plm-bom-filter-preset-batch-group"
              v-model.trim="panel.bomPresetBatchGroup.value"
              name="plmBomFilterPresetBatchGroup"
              class="deep-link-input"
              placeholder="批量分组（留空清除）"
            />
            <button class="btn ghost mini" :disabled="!panel.bomPresetSelectionCount.value" @click="panel.applyBomPresetBatchGroup">
              应用分组
            </button>
            <button class="btn ghost mini danger" :disabled="!panel.bomPresetSelectionCount.value" @click="panel.deleteBomPresetSelection">
              批量删除
            </button>
          </div>
          <div class="preset-list">
            <label v-for="preset in panel.bomFilteredPresets.value" :key="preset.key" class="preset-item">
              <input type="checkbox" :value="preset.key" v-model="panel.bomPresetSelection.value" />
              <span>{{ preset.label }}{{ preset.group ? ` (${preset.group})` : '' }}</span>
            </label>
          </div>
        </div>
        <div class="team-preset-block">
          <div class="team-preset-header">
            <span class="team-preset-title">团队预设</span>
            <button class="btn ghost mini" :disabled="panel.bomTeamPresetsLoading.value" @click="panel.refreshBomTeamPresets">
              {{ panel.bomTeamPresetsLoading.value ? '刷新中...' : '刷新' }}
            </button>
          </div>
          <div class="field-inline">
            <select id="plm-bom-team-preset" v-model="panel.bomTeamPresetKey.value" name="plmBomTeamPreset">
              <option value="">选择团队预设</option>
              <option v-for="preset in panel.bomTeamPresets.value" :key="preset.id" :value="preset.id">
                {{ preset.name }}{{ preset.state.group ? ` (${preset.state.group})` : '' }} · {{ preset.ownerUserId }}{{ preset.isDefault ? ' · 默认' : '' }}{{ preset.isArchived ? ' · 已归档' : '' }}
              </option>
            </select>
            <button class="btn ghost mini" :disabled="!panel.canApplyBomTeamPreset.value" @click="panel.applyBomTeamPreset">
              应用
            </button>
            <button class="btn ghost mini" :disabled="!panel.canDuplicateBomTeamPreset.value" @click="panel.duplicateBomTeamPreset">
              复制副本
            </button>
            <button
              v-if="panel.showManageBomTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canShareBomTeamPreset.value"
              @click="panel.shareBomTeamPreset"
            >
              分享
            </button>
            <button
              v-if="panel.showManageBomTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canArchiveBomTeamPreset.value"
              @click="panel.archiveBomTeamPreset"
            >
              归档
            </button>
            <button
              v-if="panel.showManageBomTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canRestoreBomTeamPreset.value"
              @click="panel.restoreBomTeamPreset"
            >
              恢复
            </button>
            <button
              v-if="panel.showManageBomTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canRenameBomTeamPreset.value"
              @click="panel.renameBomTeamPreset"
            >
              重命名
            </button>
            <button
              v-if="panel.showManageBomTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canSetBomTeamPresetDefault.value"
              @click="panel.setBomTeamPresetDefault"
            >
              设为默认
            </button>
            <button
              v-if="panel.showManageBomTeamPresetActions.value"
              class="btn ghost mini"
              :disabled="!panel.canClearBomTeamPresetDefault.value"
              @click="panel.clearBomTeamPresetDefault"
            >
              取消默认
            </button>
            <button
              v-if="panel.showManageBomTeamPresetActions.value"
              class="btn ghost mini danger"
              :disabled="!panel.canDeleteBomTeamPreset.value"
              @click="panel.deleteBomTeamPreset"
            >
              删除
            </button>
          </div>
          <p v-if="panel.bomDefaultTeamPresetLabel.value" class="status">当前默认：{{ panel.bomDefaultTeamPresetLabel.value }}</p>
          <div class="field-inline">
            <input
              id="plm-bom-team-preset-name"
              v-model.trim="panel.bomTeamPresetName.value"
              name="plmBomTeamPresetName"
              placeholder="团队预设名称"
            />
            <input
              id="plm-bom-team-preset-group"
              v-model.trim="panel.bomTeamPresetGroup.value"
              name="plmBomTeamPresetGroup"
              class="deep-link-input"
              placeholder="分组（可选）"
            />
            <button class="btn ghost mini" :disabled="!panel.canSaveBomTeamPreset.value || panel.bomTeamPresetsLoading.value" @click="panel.saveBomTeamPreset">
              保存到团队
            </button>
          </div>
          <div v-if="panel.showManageBomTeamPresetActions.value" class="field-inline">
            <input
              id="plm-bom-team-preset-owner"
              v-model.trim="panel.bomTeamPresetOwnerUserId.value"
              name="plmBomTeamPresetOwnerUserId"
              class="deep-link-input"
              placeholder="目标用户 ID"
              :disabled="!panel.canTransferTargetBomTeamPreset.value || panel.bomTeamPresetsLoading.value"
            />
            <button
              class="btn ghost mini"
              :disabled="!panel.canTransferBomTeamPreset.value || panel.bomTeamPresetsLoading.value"
              @click="panel.transferBomTeamPreset"
            >
              转移所有者
            </button>
          </div>
          <div v-if="panel.hasManageableBomTeamPresets.value" class="field-inline field-actions">
            <button class="btn ghost mini" @click="panel.showBomTeamPresetManager.value = !panel.showBomTeamPresetManager.value">
              {{ panel.showBomTeamPresetManager.value ? '收起批量管理' : '批量管理' }}
            </button>
          </div>
          <div v-if="panel.showBomTeamPresetManager.value && panel.hasManageableBomTeamPresets.value" class="preset-manager">
            <div class="field-inline field-actions">
              <button class="btn ghost mini" @click="panel.selectAllBomTeamPresets">全选可管理</button>
              <button class="btn ghost mini" :disabled="!panel.bomTeamPresetSelectionCount.value" @click="panel.clearBomTeamPresetSelection">
                清空选择
              </button>
              <span class="muted">已选 {{ panel.bomTeamPresetSelectionCount.value }}/{{ panel.bomTeamPresets.value.length }}</span>
            </div>
            <div class="field-inline field-actions">
              <button
                class="btn ghost mini"
                :disabled="!panel.selectedBatchArchivableBomTeamPresetIds.value.length"
                @click="panel.archiveBomTeamPresetSelection"
              >
                批量归档
              </button>
              <button
                class="btn ghost mini"
                :disabled="!panel.selectedBatchRestorableBomTeamPresetIds.value.length"
                @click="panel.restoreBomTeamPresetSelection"
              >
                批量恢复
              </button>
              <button
                class="btn ghost mini danger"
                :disabled="!panel.selectedBatchDeletableBomTeamPresetIds.value.length"
                @click="panel.deleteBomTeamPresetSelection"
              >
                批量删除
              </button>
            </div>
            <div class="preset-list">
              <label v-for="preset in panel.bomTeamPresets.value" :key="preset.id" class="preset-item">
                <input
                  type="checkbox"
                  :value="preset.id"
                  v-model="panel.bomTeamPresetSelection.value"
                  :disabled="!preset.permissions?.canManage && !preset.canManage"
                />
                <span>
                  {{ preset.name }}{{ preset.state.group ? ` (${preset.state.group})` : '' }} · {{ preset.ownerUserId }}{{ preset.isDefault ? ' · 默认' : '' }}{{ preset.isArchived ? ' · 已归档' : '' }}{{ !preset.permissions?.canManage && !preset.canManage ? ' · 只读' : '' }}
                </span>
              </label>
            </div>
          </div>
          <p v-if="panel.bomTeamPresetsError.value" class="status error">{{ panel.bomTeamPresetsError.value }}</p>
        </div>
      </label>
    </div>
    <p v-if="panel.bomError.value" class="status error">{{ panel.bomError.value }}</p>
    <p v-if="panel.bomItems.value.length" class="status">共 {{ panel.bomItems.value.length }} 条，展示 {{ panel.bomDisplayCount.value }} 条</p>
    <div v-if="!panel.bomItems.value.length" class="empty">
      暂无 BOM 数据
      <span class="empty-hint">（可在 PLM 关联 BOM 行后刷新）</span>
    </div>
    <div v-else-if="panel.bomView.value === 'tree' && !panel.bomTreeVisibleCount.value" class="empty">
      暂无匹配项
      <span class="empty-hint">（可清空过滤条件）</span>
    </div>
    <div v-else-if="panel.bomView.value === 'table' && !panel.bomFilteredItems.value.length" class="empty">
      暂无匹配项
      <span class="empty-hint">（可清空过滤条件）</span>
    </div>
    <div v-else-if="panel.bomView.value === 'tree'" class="bom-tree">
      <div class="tree-row tree-header bom-tree-header">
        <div class="tree-cell">组件</div>
        <div class="tree-cell">名称</div>
        <div class="tree-cell">数量</div>
        <div class="tree-cell">单位</div>
        <div class="tree-cell">Find #</div>
        <div class="tree-cell">Refdes</div>
        <div class="tree-cell">BOM 行 ID</div>
        <div class="tree-cell">操作</div>
      </div>
      <div
        v-for="row in panel.bomTreeVisibleRows.value"
        :key="row.key"
        class="tree-row"
        :class="{ 'tree-root': row.depth === 0, selected: panel.isBomTreeSelected(row) }"
        :data-line-id="row.line ? panel.resolveBomLineId(row.line) : ''"
        @click="panel.selectBomTreeRow(row)"
      >
        <div class="tree-cell tree-node" :style="{ paddingLeft: `${row.depth * 16}px` }">
          <button class="tree-toggle" :disabled="!row.hasChildren" @click.stop="panel.toggleBomNode(row.key)">
            {{ row.hasChildren ? (panel.isBomCollapsed(row.key) ? '▸' : '▾') : '•' }}
          </button>
          <div class="tree-node-meta">
            <span class="mono">{{ row.label }}</span>
            <span v-if="row.componentId && row.componentId !== row.label" class="muted mono">
              {{ row.componentId }}
            </span>
          </div>
        </div>
        <div class="tree-cell">{{ row.name || '-' }}</div>
        <div class="tree-cell">{{ row.line?.quantity ?? '-' }}</div>
        <div class="tree-cell">{{ row.line?.unit ?? row.line?.uom ?? '-' }}</div>
        <div class="tree-cell">{{ row.line ? panel.formatBomFindNum(row.line) : '-' }}</div>
        <div class="tree-cell">{{ row.line ? panel.formatBomRefdes(row.line) : '-' }}</div>
        <div class="tree-cell">
          <div class="tree-bom-meta">
            <span class="mono">{{ row.line ? panel.resolveBomLineId(row.line) || '-' : '-' }}</span>
            <button
              class="btn ghost mini"
              :disabled="!panel.formatBomPathIds(row)"
              :title="panel.formatBomPathIds(row)"
              @click="panel.copyBomPathIds(row)"
            >
              路径 ID
            </button>
          </div>
        </div>
        <div class="tree-cell">
          <div class="inline-actions">
            <button
              class="btn ghost mini"
              :disabled="!row.line || (!panel.resolveBomChildId(row.line) && !panel.resolveBomChildNumber(row.line)) || panel.productLoading.value"
              @click.stop="row.line && panel.applyProductFromBom(row.line)"
            >
              产品
            </button>
            <button
              class="btn ghost mini"
              :disabled="!row.line || !panel.resolveBomChildId(row.line) || panel.whereUsedLoading.value"
              @click.stop="row.line && panel.applyWhereUsedFromBom(row.line)"
            >
              Where-Used
            </button>
            <button
              class="btn ghost mini"
              :disabled="!row.line || !panel.resolveBomLineId(row.line) || panel.substitutesLoading.value"
              @click.stop="row.line && panel.applySubstitutesFromBom(row.line)"
            >
              替代件
            </button>
            <button
              class="btn ghost mini"
              :disabled="!row.line || (!panel.resolveBomChildId(row.line) && !panel.resolveBomChildNumber(row.line))"
              @click.stop="row.line && panel.copyBomChildId(row.line)"
            >
              复制子件
            </button>
          </div>
        </div>
      </div>
    </div>
    <table v-else class="data-table">
      <thead>
        <tr>
          <th>层级</th>
          <th>组件编码</th>
          <th>组件名称</th>
          <th>数量</th>
          <th>单位</th>
          <th>Find #</th>
          <th>Refdes</th>
          <th>路径 ID</th>
          <th>BOM 行 ID</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in panel.bomFilteredItems.value"
          :key="item.id"
          :class="{ 'row-selected': panel.isBomItemSelected(item) }"
          @click="panel.selectBomTableRow(item)"
        >
          <td>{{ item.level }}</td>
          <td>
            <div>{{ item.component_code || item.component_id }}</div>
            <div v-if="item.component_id" class="muted mono">{{ item.component_id }}</div>
          </td>
          <td>{{ item.component_name }}</td>
          <td>{{ item.quantity }}</td>
          <td>{{ item.unit }}</td>
          <td>{{ panel.formatBomFindNum(item) }}</td>
          <td>{{ panel.formatBomRefdes(item) }}</td>
          <td>
            <div class="tree-bom-meta">
              <span class="mono">{{ panel.formatBomTablePathIds(item) || '-' }}</span>
              <button
                class="btn ghost mini"
                :disabled="!panel.formatBomTablePathIds(item)"
                :title="panel.formatBomTablePathIds(item)"
                @click="panel.copyBomTablePathIds(item)"
              >
                路径 ID
              </button>
            </div>
          </td>
          <td :data-bom-line-id="item.id || ''">
            <div class="mono">{{ item.id || '-' }}</div>
            <div v-if="item.parent_item_id" class="muted">父: {{ item.parent_item_id }}</div>
          </td>
          <td>
            <div class="inline-actions">
              <button
                class="btn ghost mini"
                :disabled="(!panel.resolveBomChildId(item) && !panel.resolveBomChildNumber(item)) || panel.productLoading.value"
                @click="panel.applyProductFromBom(item)"
              >
                切换产品
              </button>
              <button
                class="btn ghost mini"
                :disabled="!panel.resolveBomChildId(item) || panel.whereUsedLoading.value"
                @click.stop="panel.applyWhereUsedFromBom(item)"
              >
                Where-Used
              </button>
              <button
                class="btn ghost mini"
                :disabled="!panel.resolveBomLineId(item) || panel.substitutesLoading.value"
                @click.stop="panel.applySubstitutesFromBom(item)"
              >
                替代件
              </button>
              <button
                class="btn ghost mini"
                :disabled="!panel.resolveBomChildId(item) && !panel.resolveBomChildNumber(item)"
                @click.stop="panel.copyBomChildId(item)"
              >
                复制子件
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import type { PlmBomPanelModel } from '../../views/plm/plmPanelModels'

defineProps<{
  panel: PlmBomPanelModel
}>()
</script>

<style scoped src="./PlmPanelShared.css"></style>
