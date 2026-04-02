<template>
  <section class="panel">
    <div class="panel-header">
      <h2>BOM 对比</h2>
      <div class="panel-actions">
        <button class="btn ghost" :disabled="!panel.productId.value" @click="panel.applyCompareFromProduct('left')">
          左=当前产品
        </button>
        <button class="btn ghost" :disabled="!panel.productId.value" @click="panel.applyCompareFromProduct('right')">
          右=当前产品
        </button>
        <button class="btn ghost" :disabled="!panel.compareLeftId.value || !panel.compareRightId.value" @click="panel.swapCompareSides">
          交换左右
        </button>
        <button class="btn ghost" @click="panel.copyDeepLink('compare')">复制深链接</button>
        <button class="btn ghost" :disabled="panel.compareTotalFiltered.value === 0" @click="panel.exportBomCompareCsv">
          导出 CSV
        </button>
        <button class="btn" :disabled="!panel.compareLeftId.value || !panel.compareRightId.value || panel.compareLoading.value" @click="panel.loadBomCompare">
          {{ panel.compareLoading.value ? '加载中...' : '对比' }}
        </button>
      </div>
    </div>
    <div class="form-grid">
      <label for="plm-compare-left-id">
        左侧 ID
        <input
          id="plm-compare-left-id"
          v-model.trim="panel.compareLeftId.value"
          name="plmCompareLeftId"
          placeholder="左侧 item/version ID"
        />
      </label>
      <label for="plm-compare-left-quick-pick">
        左侧快选
        <select
          id="plm-compare-left-quick-pick"
          v-model="panel.compareLeftQuickPick.value"
          name="plmCompareLeftQuickPick"
          :disabled="!panel.compareQuickOptions.value.length"
          @change="panel.applyCompareQuickPick('left')"
        >
          <option value="">从搜索结果选择</option>
          <option v-for="option in panel.compareQuickOptions.value" :key="`left-${option.key}`" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label for="plm-compare-right-id">
        右侧 ID
        <input
          id="plm-compare-right-id"
          v-model.trim="panel.compareRightId.value"
          name="plmCompareRightId"
          placeholder="右侧 item/version ID"
        />
      </label>
      <label for="plm-compare-right-quick-pick">
        右侧快选
        <select
          id="plm-compare-right-quick-pick"
          v-model="panel.compareRightQuickPick.value"
          name="plmCompareRightQuickPick"
          :disabled="!panel.compareQuickOptions.value.length"
          @change="panel.applyCompareQuickPick('right')"
        >
          <option value="">从搜索结果选择</option>
          <option v-for="option in panel.compareQuickOptions.value" :key="`right-${option.key}`" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label for="plm-compare-max-levels">
        最大层级
        <input
          id="plm-compare-max-levels"
          v-model.number="panel.compareMaxLevels.value"
          name="plmCompareMaxLevels"
          type="number"
          min="-1"
          max="20"
        />
      </label>
      <label for="plm-compare-line-key">
        Line Key
        <select id="plm-compare-line-key" v-model="panel.compareLineKey.value" name="plmCompareLineKey">
          <option v-for="option in panel.compareLineKeyOptions.value" :key="option" :value="option">
            {{ option }}
          </option>
        </select>
      </label>
      <label for="plm-compare-mode">
        Compare Mode
        <input
          id="plm-compare-mode"
          v-model.trim="panel.compareMode.value"
          name="plmCompareMode"
          list="plm-compare-mode-options"
          placeholder="only_product / summarized / num_qty"
        />
        <datalist id="plm-compare-mode-options">
          <option v-for="mode in panel.compareModeOptions.value" :key="mode.mode" :value="mode.mode">
            {{ mode.description || mode.mode }}
          </option>
        </datalist>
      </label>
      <label for="plm-compare-effective-at">
        生效时间
        <input
          id="plm-compare-effective-at"
          v-model="panel.compareEffectiveAt.value"
          name="plmCompareEffectiveAt"
          type="datetime-local"
        />
      </label>
      <label for="plm-compare-rel-props">
        关系字段
        <input
          id="plm-compare-rel-props"
          v-model.trim="panel.compareRelationshipProps.value"
          name="plmCompareRelProps"
          placeholder="quantity,uom,find_num,refdes"
        />
      </label>
      <label for="plm-compare-filter">
        过滤
        <input
          id="plm-compare-filter"
          v-model.trim="panel.compareFilter.value"
          name="plmCompareFilter"
          placeholder="编号/名称/Line ID"
        />
      </label>
      <label class="checkbox-field" for="plm-compare-include-child">
        <span>包含父/子字段</span>
        <input id="plm-compare-include-child" v-model="panel.compareIncludeChildFields.value" name="plmCompareIncludeChild" type="checkbox" />
      </label>
      <label class="checkbox-field" for="plm-compare-include-subs">
        <span>包含替代件</span>
        <input id="plm-compare-include-subs" v-model="panel.compareIncludeSubstitutes.value" name="plmCompareIncludeSubs" type="checkbox" />
      </label>
      <label class="checkbox-field" for="plm-compare-include-effectivity">
        <span>包含生效性</span>
        <input id="plm-compare-include-effectivity" v-model="panel.compareIncludeEffectivity.value" name="plmCompareIncludeEffectivity" type="checkbox" />
      </label>
      <label class="checkbox-field" for="plm-compare-sync">
        <span>联动 Where-Used / 替代件</span>
        <input id="plm-compare-sync" v-model="panel.compareSyncEnabled.value" name="plmCompareSync" type="checkbox" />
      </label>
    </div>
    <p v-if="!panel.compareLeftId.value && !panel.compareRightId.value" class="hint">
      提示：左右 ID 支持 item / version，可用“左/右=当前产品”或快选填入。
    </p>
    <p v-if="panel.compareSchemaLoading.value" class="status">对比字段加载中...</p>
    <p v-else-if="panel.compareSchemaError.value" class="status error">{{ panel.compareSchemaError.value }}（已回退默认字段）</p>
    <p v-if="panel.compareError.value" class="status error">{{ panel.compareError.value }}</p>
    <div v-if="!panel.bomCompare.value" class="empty">
      暂无对比数据
      <span class="empty-hint">（填写左右 ID 后对比）</span>
    </div>
    <div v-else>
      <div class="summary-row">
        <span>新增: {{ panel.compareSummary.value.added ?? 0 }}</span>
        <span>删除: {{ panel.compareSummary.value.removed ?? 0 }}</span>
        <span>变更: {{ panel.compareSummary.value.changed ?? 0 }}</span>
        <span>重大: {{ panel.compareSummary.value.changed_major ?? 0 }}</span>
        <span>轻微: {{ panel.compareSummary.value.changed_minor ?? 0 }}</span>
        <span>提示: {{ panel.compareSummary.value.changed_info ?? 0 }}</span>
        <span class="muted">展示: {{ panel.compareTotalFiltered.value }}</span>
      </div>

      <div class="compare-section">
        <h3>新增 ({{ panel.compareAddedFiltered.value.length }}/{{ panel.compareAdded.value.length }})</h3>
        <div v-if="!panel.compareAddedFiltered.value.length" class="empty">无新增</div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>层级</th>
              <th>父件</th>
              <th>子件</th>
              <th>数量</th>
              <th>单位</th>
              <th>Find #</th>
              <th>Refdes</th>
              <th>生效</th>
              <th>替代件</th>
              <th>Line</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in panel.compareAddedFiltered.value"
              :key="entry.relationship_id || entry.line_key || entry.child_id"
              :class="{ 'row-selected': panel.isCompareEntrySelected(entry, 'added') }"
              :data-compare-child="panel.resolveCompareChildKey(entry)"
              :data-compare-line="panel.resolveCompareLineId(entry)"
              @click="panel.selectCompareEntry(entry, 'added')"
            >
              <td>{{ entry.level ?? '-' }}</td>
              <td>
                <div>{{ panel.getItemNumber(panel.getCompareParent(entry)) }}</div>
                <div class="muted">{{ panel.getItemName(panel.getCompareParent(entry)) }}</div>
                <div class="inline-actions">
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareParentKey(entry) || panel.productLoading.value" @click="panel.applyProductFromCompareParent(entry)">
                    产品
                  </button>
                </div>
              </td>
              <td>
                <div>{{ panel.getItemNumber(panel.getCompareChild(entry)) }}</div>
                <div class="muted">{{ panel.getItemName(panel.getCompareChild(entry)) }}</div>
              </td>
              <td>{{ panel.getCompareProp(entry, 'quantity') }}</td>
              <td>{{ panel.getCompareProp(entry, 'uom') }}</td>
              <td>{{ panel.getCompareProp(entry, 'find_num') }}</td>
              <td>{{ panel.getCompareProp(entry, 'refdes') }}</td>
              <td>{{ panel.formatEffectivity(entry) }}</td>
              <td>{{ panel.formatSubstituteCount(entry) }}</td>
              <td>
                <div class="mono">{{ entry.line_key || '-' }}</div>
                <div class="muted">{{ entry.relationship_id || '-' }}</div>
                <div class="inline-actions">
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareChildKey(entry) || panel.whereUsedLoading.value" @click="panel.applyWhereUsedFromCompare(entry)">
                    Where-Used
                  </button>
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareLineId(entry) || panel.substitutesLoading.value" @click="panel.applySubstitutesFromCompare(entry)">
                    替代件
                  </button>
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareLineId(entry)" @click="panel.copyCompareLineId(entry)">
                    复制 Line
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="compare-section">
        <h3>删除 ({{ panel.compareRemovedFiltered.value.length }}/{{ panel.compareRemoved.value.length }})</h3>
        <div v-if="!panel.compareRemovedFiltered.value.length" class="empty">无删除</div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>层级</th>
              <th>父件</th>
              <th>子件</th>
              <th>数量</th>
              <th>单位</th>
              <th>Find #</th>
              <th>Refdes</th>
              <th>生效</th>
              <th>替代件</th>
              <th>Line</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in panel.compareRemovedFiltered.value"
              :key="entry.relationship_id || entry.line_key || entry.child_id"
              :class="{ 'row-selected': panel.isCompareEntrySelected(entry, 'removed') }"
              :data-compare-child="panel.resolveCompareChildKey(entry)"
              :data-compare-line="panel.resolveCompareLineId(entry)"
              @click="panel.selectCompareEntry(entry, 'removed')"
            >
              <td>{{ entry.level ?? '-' }}</td>
              <td>
                <div>{{ panel.getItemNumber(panel.getCompareParent(entry)) }}</div>
                <div class="muted">{{ panel.getItemName(panel.getCompareParent(entry)) }}</div>
                <div class="inline-actions">
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareParentKey(entry) || panel.productLoading.value" @click="panel.applyProductFromCompareParent(entry)">
                    产品
                  </button>
                </div>
              </td>
              <td>
                <div>{{ panel.getItemNumber(panel.getCompareChild(entry)) }}</div>
                <div class="muted">{{ panel.getItemName(panel.getCompareChild(entry)) }}</div>
              </td>
              <td>{{ panel.getCompareProp(entry, 'quantity') }}</td>
              <td>{{ panel.getCompareProp(entry, 'uom') }}</td>
              <td>{{ panel.getCompareProp(entry, 'find_num') }}</td>
              <td>{{ panel.getCompareProp(entry, 'refdes') }}</td>
              <td>{{ panel.formatEffectivity(entry) }}</td>
              <td>{{ panel.formatSubstituteCount(entry) }}</td>
              <td>
                <div class="mono">{{ entry.line_key || '-' }}</div>
                <div class="muted">{{ entry.relationship_id || '-' }}</div>
                <div class="inline-actions">
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareChildKey(entry) || panel.whereUsedLoading.value" @click="panel.applyWhereUsedFromCompare(entry)">
                    Where-Used
                  </button>
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareLineId(entry) || panel.substitutesLoading.value" @click="panel.applySubstitutesFromCompare(entry)">
                    替代件
                  </button>
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareLineId(entry)" @click="panel.copyCompareLineId(entry)">
                    复制 Line
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="compare-section">
        <h3>变更 ({{ panel.compareChangedFiltered.value.length }}/{{ panel.compareChanged.value.length }})</h3>
        <div v-if="!panel.compareChangedFiltered.value.length" class="empty">无变更</div>
        <table v-else class="data-table">
          <thead>
            <tr>
              <th>层级</th>
              <th>父件</th>
              <th>子件</th>
              <th>严重度</th>
              <th>变更项</th>
              <th>生效</th>
              <th>替代件</th>
              <th>Line</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in panel.compareChangedFiltered.value"
              :key="entry.relationship_id || entry.line_key || entry.child_id"
              :class="[panel.compareRowClass(entry), { 'row-selected': panel.isCompareEntrySelected(entry, 'changed') }]"
              :data-compare-child="panel.resolveCompareChildKey(entry)"
              :data-compare-line="panel.resolveCompareLineId(entry)"
              @click="panel.selectCompareEntry(entry, 'changed')"
            >
              <td>{{ entry.level ?? '-' }}</td>
              <td>
                <div>{{ panel.getItemNumber(panel.getCompareParent(entry)) }}</div>
                <div class="muted">{{ panel.getItemName(panel.getCompareParent(entry)) }}</div>
                <div class="inline-actions">
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareParentKey(entry) || panel.productLoading.value" @click="panel.applyProductFromCompareParent(entry)">
                    产品
                  </button>
                </div>
              </td>
              <td>
                <div>{{ panel.getItemNumber(panel.getCompareChild(entry)) }}</div>
                <div class="muted">{{ panel.getItemName(panel.getCompareChild(entry)) }}</div>
              </td>
              <td>
                <span class="tag" :class="panel.severityClass(panel.getCompareEntrySeverity(entry))">
                  {{ panel.getCompareEntrySeverity(entry) }}
                </span>
              </td>
              <td>
                <div v-if="entry.changes?.length" class="diff-list">
                  <div v-for="change in panel.getCompareChangeRows(entry)" :key="change.key" class="diff-row">
                    <span class="tag" :class="panel.severityClass(change.severity)">{{ change.severity }}</span>
                    <span class="diff-field" :title="change.description || ''">
                      {{ change.label }}
                      <span v-if="panel.compareFieldLabelMap.value.has(change.field)" class="diff-field-code">
                        ({{ change.field }})
                      </span>
                      <span v-if="change.normalized && change.normalized !== '-'" class="diff-field-meta">
                        {{ change.normalized }}
                      </span>
                    </span>
                    <span class="diff-value">
                      <span class="diff-value-left">{{ panel.formatDiffValue(change.left) }}</span>
                      <span class="diff-arrow">→</span>
                      <span class="diff-value-right">{{ panel.formatDiffValue(change.right) }}</span>
                    </span>
                  </div>
                </div>
                <span v-else class="muted">-</span>
              </td>
              <td>{{ panel.formatEffectivity(entry) }}</td>
              <td>{{ panel.formatSubstituteCount(entry) }}</td>
              <td>
                <div class="mono">{{ entry.line_key || '-' }}</div>
                <div class="muted">{{ entry.relationship_id || '-' }}</div>
                <div class="inline-actions">
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareChildKey(entry) || panel.whereUsedLoading.value" @click="panel.applyWhereUsedFromCompare(entry)">
                    Where-Used
                  </button>
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareLineId(entry) || panel.substitutesLoading.value" @click="panel.applySubstitutesFromCompare(entry)">
                    替代件
                  </button>
                  <button class="btn ghost mini" :disabled="!panel.resolveCompareLineId(entry)" @click="panel.copyCompareLineId(entry)">
                    复制 Line
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="compare-detail" data-compare-detail="true">
        <div class="compare-detail-header">
          <h3>字段级对照</h3>
          <div class="compare-detail-actions">
            <template v-if="panel.compareSelectedMeta.value">
              <span class="tag" :class="panel.compareSelectedMeta.value.tagClass">{{ panel.compareSelectedMeta.value.kindLabel }}</span>
              <span v-if="panel.compareSelectedMeta.value.lineKey" class="mono">Line: {{ panel.compareSelectedMeta.value.lineKey }}</span>
              <span v-if="panel.compareSelectedMeta.value.relationshipId" class="muted mono">
                {{ panel.compareSelectedMeta.value.relationshipId }}
              </span>
              <span v-if="panel.compareSelectedMeta.value.pathLabel" class="muted">
                {{ panel.compareSelectedMeta.value.pathLabel }}
              </span>
            </template>
            <button class="btn ghost mini" :disabled="!panel.compareDetailRows.value.length" @click="panel.copyCompareDetailRows">
              复制字段对照
            </button>
            <button class="btn ghost mini" :disabled="!panel.compareDetailRows.value.length" @click="panel.exportCompareDetailCsv">
              导出字段对照
            </button>
            <button class="btn ghost mini" :disabled="!panel.compareSelectedEntry.value" @click="panel.clearCompareSelection">
              清空选择
            </button>
          </div>
        </div>
        <div v-if="!panel.compareSelectedEntry.value" class="empty">点击上方条目查看字段级对照</div>
        <table v-else class="data-table compact">
          <thead>
            <tr>
              <th>字段</th>
              <th>左侧</th>
              <th>右侧</th>
              <th>严重度</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in panel.compareDetailRows.value"
              :key="row.key"
              :class="{ 'compare-field-row': true, changed: row.changed }"
              :data-field-key="row.key"
            >
              <td>
                <div class="diff-field" :title="row.description || ''">{{ row.label }}</div>
                <div class="muted mono">{{ row.key }}</div>
              </td>
              <td>
                <div class="diff-value-left">{{ row.left }}</div>
                <div v-if="row.normalizedLeft" class="muted">规范化: {{ row.normalizedLeft }}</div>
              </td>
              <td>
                <div class="diff-value-right">{{ row.right }}</div>
                <div v-if="row.normalizedRight" class="muted">规范化: {{ row.normalizedRight }}</div>
              </td>
              <td>
                <span v-if="row.severity" class="tag" :class="panel.severityClass(row.severity)">{{ row.severity }}</span>
                <span v-else class="muted">-</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <details class="field-map">
        <summary>字段对照清单</summary>
        <table class="data-table">
          <thead>
            <tr>
              <th>字段</th>
              <th>Key</th>
              <th>来源</th>
              <th>默认严重度</th>
              <th>归一化</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in panel.compareFieldCatalog.value" :key="field.key">
              <td>{{ field.label }}</td>
              <td class="mono">{{ field.key }}</td>
              <td>{{ field.source }}</td>
              <td>
                <span class="tag" :class="panel.severityClass(field.severity)">{{ field.severity }}</span>
              </td>
              <td class="muted">{{ field.normalized }}</td>
            </tr>
          </tbody>
        </table>
      </details>

      <details class="json-block">
        <summary>详细结果</summary>
        <pre>{{ panel.formatJson(panel.bomCompare.value) }}</pre>
      </details>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { PlmComparePanelModel } from '../../views/plm/plmPanelModels'

defineProps<{
  panel: PlmComparePanelModel
}>()
</script>

<style scoped src="./PlmPanelShared.css"></style>
