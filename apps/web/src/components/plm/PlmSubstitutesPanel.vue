<template>
  <section class="panel">
    <div class="panel-header">
      <h2>替代件</h2>
      <div class="panel-actions">
        <button class="btn ghost" @click="panel.copyDeepLink('substitutes')">复制深链接</button>
        <button class="btn ghost" :disabled="!panel.substitutesRows.value.length" @click="panel.exportSubstitutesCsv">
          导出 CSV
        </button>
        <button class="btn" :disabled="!panel.bomLineId.value || panel.substitutesLoading.value" @click="panel.loadSubstitutes">
          {{ panel.substitutesLoading.value ? '加载中...' : '查询' }}
        </button>
      </div>
    </div>
    <div class="form-grid compact">
      <label for="plm-bom-line-id">
        BOM Line ID
        <input
          id="plm-bom-line-id"
          v-model.trim="panel.bomLineId.value"
          name="plmBomLineId"
          placeholder="输入 BOM 行 ID"
        />
      </label>
      <label for="plm-bom-line-quick-pick">
        BOM 行快选
        <select
          id="plm-bom-line-quick-pick"
          v-model="panel.bomLineQuickPick.value"
          name="plmBomLineQuickPick"
          :disabled="!panel.bomLineOptions.value.length"
          @change="panel.applyBomLineQuickPick"
        >
          <option value="">从 BOM 选择</option>
          <option v-for="option in panel.bomLineOptions.value" :key="option.key" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label for="plm-substitutes-filter">
        过滤
        <input
          id="plm-substitutes-filter"
          v-model.trim="panel.substitutesFilter.value"
          name="plmSubstitutesFilter"
          placeholder="替代件/原件编号"
        />
      </label>
    </div>
    <p v-if="!panel.bomLineId.value" class="hint">提示：从 BOM 或 BOM 对比表中点击“替代件”可自动填入。</p>
    <div v-if="panel.bomLineId.value" class="context-row">
      <span class="context-title">BOM 行</span>
      <span class="mono">{{ panel.bomLineId.value }}</span>
      <button class="btn ghost mini" @click="panel.copyBomLineId">复制 BOM 行</button>
      <template v-if="panel.bomLineContext.value">
        <span class="context-divider"></span>
        <span>
          子件:
          <strong>{{ panel.bomLineContext.value.component_code || panel.bomLineContext.value.component_id || '-' }}</strong>
        </span>
        <span v-if="panel.bomLineContext.value.component_name" class="muted">{{ panel.bomLineContext.value.component_name }}</span>
        <span class="muted">数量: {{ panel.bomLineContext.value.quantity ?? '-' }} {{ panel.bomLineContext.value.unit || '' }}</span>
        <span class="muted">Find: {{ panel.bomLineContext.value.sequence ?? '-' }}</span>
        <button class="btn ghost mini" :disabled="panel.whereUsedLoading.value" @click="panel.applyWhereUsedFromBom(panel.bomLineContext.value)">
          Where-Used
        </button>
      </template>
      <span v-else class="muted">未在当前 BOM 中找到</span>
    </div>
    <div class="form-grid compact">
      <label for="plm-substitute-item-id">
        替代件 ID
        <input
          id="plm-substitute-item-id"
          v-model.trim="panel.substituteItemId.value"
          name="plmSubstituteItemId"
          placeholder="输入替代件 Item ID"
        />
      </label>
      <label for="plm-substitute-quick-pick">
        替代件快选
        <select
          id="plm-substitute-quick-pick"
          v-model="panel.substituteQuickPick.value"
          name="plmSubstituteQuickPick"
          :disabled="!panel.substituteQuickOptions.value.length"
          @change="panel.applySubstituteQuickPick"
        >
          <option value="">从 BOM / 搜索结果选择</option>
          <option v-for="option in panel.substituteQuickOptions.value" :key="option.key" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label for="plm-substitute-rank">
        优先级
        <input
          id="plm-substitute-rank"
          v-model.trim="panel.substituteRank.value"
          name="plmSubstituteRank"
          placeholder="可选"
        />
      </label>
      <label for="plm-substitute-note">
        备注
        <input
          id="plm-substitute-note"
          v-model.trim="panel.substituteNote.value"
          name="plmSubstituteNote"
          placeholder="可选"
        />
      </label>
    </div>
    <div class="panel-actions">
      <button class="btn" :disabled="!panel.bomLineId.value || !panel.substituteItemId.value || panel.substitutesMutating.value" @click="panel.addSubstitute">
        {{ panel.substitutesMutating.value ? '处理中...' : '新增替代件' }}
      </button>
    </div>
    <p v-if="panel.substitutesActionStatus.value" class="status">{{ panel.substitutesActionStatus.value }}</p>
    <p v-if="panel.substitutesActionError.value" class="status error">{{ panel.substitutesActionError.value }}</p>
    <p v-if="panel.substitutesError.value" class="status error">{{ panel.substitutesError.value }}</p>
    <div v-if="!panel.substitutes.value" class="empty">
      暂无替代件数据
      <span class="empty-hint">（填写 BOM Line ID 后查询）</span>
    </div>
    <div v-else>
      <p class="status">共 {{ panel.substitutes.value.count || 0 }} 条，展示 {{ panel.substitutesRows.value.length }} 条</p>
      <div v-if="!panel.substitutesRows.value.length" class="empty">
        暂无匹配项
        <span class="empty-hint">（可清空过滤条件）</span>
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>替代件编号</th>
            <th>替代件名称</th>
            <th>状态</th>
            <th>原件编号</th>
            <th>原件名称</th>
            <th>优先级</th>
            <th>备注</th>
            <th>关系 ID</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in panel.substitutesRows.value" :key="entry.relationship?.id || entry.id">
            <td>
              <div>{{ panel.getSubstituteNumber(entry) }}</div>
              <div class="muted">{{ panel.getSubstituteId(entry) }}</div>
            </td>
            <td>{{ panel.getSubstituteName(entry) }}</td>
            <td>
              <span class="tag" :class="panel.itemStatusClass(panel.getSubstituteStatus(entry))">
                {{ panel.getSubstituteStatus(entry) }}
              </span>
            </td>
            <td>
              <div>{{ panel.getItemNumber(entry.part) }}</div>
              <div class="muted">{{ entry.part?.id || '-' }}</div>
            </td>
            <td>{{ panel.getItemName(entry.part) }}</td>
            <td>{{ panel.formatSubstituteRank(entry) }}</td>
            <td>{{ panel.formatSubstituteNote(entry) }}</td>
            <td>{{ entry.relationship?.id || '-' }}</td>
            <td>
              <div class="inline-actions">
                <button
                  class="btn ghost mini"
                  :disabled="!panel.resolveSubstituteTargetKey(entry, 'substitute') || panel.productLoading.value"
                  @click="panel.applyProductFromSubstitute(entry, 'substitute')"
                >
                  替代件
                </button>
                <button
                  class="btn ghost mini"
                  :disabled="!panel.resolveSubstituteTargetKey(entry, 'part') || panel.productLoading.value"
                  @click="panel.applyProductFromSubstitute(entry, 'part')"
                >
                  原件
                </button>
                <button
                  class="btn ghost"
                  :disabled="panel.substitutesMutating.value || panel.substitutesDeletingId.value === (entry.relationship?.id || entry.id)"
                  @click="panel.removeSubstitute(entry)"
                >
                  {{ panel.substitutesDeletingId.value === (entry.relationship?.id || entry.id) ? '删除中...' : '删除' }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <details class="json-block">
        <summary>原始数据</summary>
        <pre>{{ panel.formatJson(panel.substitutes.value) }}</pre>
      </details>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PlmSubstitutesPanelModel } from '../../views/plm/plmPanelModels'

defineProps<{
  panel: PlmSubstitutesPanelModel
}>()
</script>

<style scoped src="./PlmPanelShared.css"></style>
