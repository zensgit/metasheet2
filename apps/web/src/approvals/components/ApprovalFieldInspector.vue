<template>
  <section
    class="approval-field-inspector"
    :aria-labelledby="showHeading ? 'approval-field-inspector-heading' : undefined"
    :aria-label="showHeading ? undefined : `字段属性：${field.label.trim() || '未命名字段'}`"
    :data-form-field-local-id="field.localId"
    data-testid="approval-form-field-inspector"
  >
    <div v-if="showHeading" class="approval-field-inspector__heading">
      <div>
        <strong id="approval-field-inspector-heading">字段属性</strong>
        <small>{{ field.label.trim() || '未命名字段' }}</small>
      </div>
      <span class="approval-field-inspector__type">
        {{ APPROVAL_FORM_FIELD_TYPE_LABELS[field.type] }}
      </span>
    </div>

    <div class="approval-field-inspector__grid">
      <!-- Field ids remain generated/load-preserved and are not ordinary authoring controls. -->
      <el-form-item label="字段名称">
        <el-input
          :model-value="field.label"
          :disabled="readOnly"
          data-testid="approval-field-label-input"
          @update:model-value="updateStringField('label', $event)"
        />
      </el-form-item>
      <el-form-item label="类型">
        <el-select
          :model-value="field.type"
          :disabled="readOnly"
          class="ms-w-100pct"
          data-testid="approval-field-type"
          @update:model-value="onFieldTypeChange"
        >
          <el-option label="文本" value="text" />
          <el-option label="多行文本" value="textarea" />
          <el-option label="数字" value="number" />
          <el-option label="日期" value="date" />
          <el-option label="日期时间" value="datetime" />
          <el-option label="单选" value="select" />
          <el-option label="多选" value="multi-select" />
          <el-option label="用户" value="user" />
          <el-option label="明细（子表单）" value="detail" />
          <el-option label="关联记录" value="record-link" />
          <el-option
            v-if="attachmentAuthoringEnabled"
            label="附件"
            value="attachment"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="占位文本">
        <el-input
          :model-value="field.placeholder"
          :disabled="readOnly"
          data-testid="approval-field-placeholder-input"
          @update:model-value="updateStringField('placeholder', $event)"
        />
      </el-form-item>
      <el-form-item label="是否必填">
        <el-checkbox
          :model-value="field.required"
          :disabled="readOnly"
          data-testid="approval-field-required-input"
          @update:model-value="updateRequired"
        >
          必填
        </el-checkbox>
      </el-form-item>

      <el-form-item
        v-if="field.type === 'record-link'"
        label="关联目标"
        class="approval-field-inspector__wide"
        data-testid="approval-record-link-config"
      >
        <div
          v-if="recordLinkCatalogError"
          class="approval-field-inspector__hint approval-field-inspector__catalog-error"
          data-testid="approval-record-link-catalog-error"
        >
          <span>{{ recordLinkCatalogError }}</span>
          <el-button
            type="primary"
            link
            size="small"
            :loading="recordLinkCatalogLoading"
            data-testid="approval-record-link-catalog-retry"
            @click="emit('retry-record-link-catalog')"
          >
            重试
          </el-button>
        </div>
        <div class="approval-field-inspector__grid">
          <el-form-item label="目标空间">
            <el-select
              :model-value="field.recordLinkBaseId || undefined"
              :disabled="readOnly || recordLinkCatalogLoading"
              filterable
              clearable
              class="ms-w-100pct"
              placeholder="请选择目标空间"
              data-testid="approval-record-link-base-select"
              @update:model-value="onRecordLinkBaseChange"
              @visible-change="onCatalogSelectVisible"
            >
              <el-option
                v-for="option in recordLinkBaseOptions"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="目标表">
            <el-select
              :model-value="field.recordLinkSheetId || undefined"
              :disabled="readOnly || recordLinkCatalogLoading || !field.recordLinkBaseId.trim()"
              filterable
              clearable
              class="ms-w-100pct"
              placeholder="请选择目标表"
              data-testid="approval-record-link-sheet-select"
              @update:model-value="onRecordLinkSheetChange"
              @visible-change="onCatalogSelectVisible"
            >
              <el-option
                v-for="option in recordLinkSheetOptions"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
          </el-form-item>
        </div>
        <div class="approval-field-inspector__hint">
          仅可选择目标表中的一条记录。提交时会验证发起人是否可查看所选记录；不可用的历史目标需重新选择。
        </div>
      </el-form-item>

      <el-form-item
        v-if="field.type === 'select' || field.type === 'multi-select'"
        label="选项"
        class="approval-field-inspector__wide"
      >
        <el-input
          :model-value="field.optionsText"
          :disabled="readOnly"
          type="textarea"
          :rows="3"
          placeholder="每行一个选项，格式：显示名:值"
          data-testid="approval-field-options-input"
          @update:model-value="updateStringField('optionsText', $event)"
        />
      </el-form-item>

      <el-form-item
        v-if="field.type === 'detail'"
        label="明细子字段"
        class="approval-field-inspector__wide"
      >
        <div class="approval-field-inspector__detail" data-testid="approval-detail-config">
          <el-table
            v-if="field.detailColumns.length > 0"
            :data="field.detailColumns"
            border
            size="small"
            class="approval-field-inspector__detail-table"
          >
            <el-table-column label="名称" min-width="120">
              <template #default="{ row, $index }">
                <el-input
                  :model-value="row.label"
                  :disabled="readOnly"
                  placeholder="如 品名"
                  @update:model-value="updateDetailString($index, 'label', $event)"
                />
              </template>
            </el-table-column>
            <el-table-column label="类型" min-width="120">
              <template #default="{ row, $index }">
                <el-select
                  :model-value="row.type"
                  :disabled="readOnly"
                  class="ms-w-100pct"
                  @update:model-value="updateDetailType($index, $event)"
                >
                  <el-option
                    v-for="leaf in detailLeafTypeOptions"
                    :key="leaf.value"
                    :label="leaf.label"
                    :value="leaf.value"
                  />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="必填" width="70" align="center">
              <template #default="{ row, $index }">
                <el-checkbox
                  :model-value="row.required"
                  :disabled="readOnly"
                  @update:model-value="updateDetailRequired($index, $event)"
                />
              </template>
            </el-table-column>
            <el-table-column label="选项" min-width="160">
              <template #default="{ row, $index }">
                <el-input
                  v-if="row.type === 'select' || row.type === 'multi-select'"
                  :model-value="row.optionsText"
                  :disabled="readOnly"
                  type="textarea"
                  :rows="2"
                  placeholder="每行一个：显示名:值"
                  @update:model-value="updateDetailString($index, 'optionsText', $event)"
                />
                <span v-else class="approval-field-inspector__hint">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="70" align="center">
              <template #default="{ $index }">
                <el-button
                  type="danger"
                  link
                  :disabled="readOnly"
                  @click="removeDetailColumn($index)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
          <div v-else class="approval-field-inspector__hint">尚无子字段，请添加至少一个。</div>
          <div class="approval-field-inspector__detail-actions">
            <el-button
              size="small"
              type="primary"
              plain
              :disabled="readOnly"
              data-testid="approval-detail-add-column"
              @click="addDetailColumn"
            >
              添加子字段
            </el-button>
            <el-input
              :model-value="field.minRowsText"
              :disabled="readOnly"
              placeholder="最小行数"
              class="ms-w-120"
              data-testid="approval-detail-min-rows"
              @update:model-value="updateStringField('minRowsText', $event)"
            />
            <el-input
              :model-value="field.maxRowsText"
              :disabled="readOnly"
              placeholder="最大行数"
              class="ms-w-120"
              data-testid="approval-detail-max-rows"
              @update:model-value="updateStringField('maxRowsText', $event)"
            />
          </div>
        </div>
      </el-form-item>

      <el-form-item label="显隐规则" class="approval-field-inspector__wide">
        <div class="approval-field-inspector__visibility">
          <el-select
            :model-value="field.visibility.dependsOnFieldId"
            :disabled="readOnly"
            class="ms-w-200"
            data-testid="approval-field-visibility-depends"
            @update:model-value="updateVisibilityString('dependsOnFieldId', $event)"
          >
            <el-option label="无（始终显示）" value="" />
            <el-option
              v-for="dependency in visibilityFieldOptions"
              :key="dependency.localId"
              :label="dependency.label"
              :value="dependency.id"
            />
          </el-select>
          <template v-if="field.visibility.dependsOnFieldId">
            <el-select
              :model-value="field.visibility.operator"
              :disabled="readOnly"
              class="ms-w-130"
              data-testid="approval-field-visibility-operator"
              @update:model-value="updateVisibilityOperator"
            >
              <el-option label="等于" value="eq" />
              <el-option label="不等于" value="neq" />
              <el-option label="包含" value="in" />
              <el-option label="为空" value="isEmpty" />
              <el-option label="不为空" value="notEmpty" />
            </el-select>
            <el-input
              v-if="field.visibility.operator === 'in'"
              :model-value="field.visibility.valueText"
              :disabled="readOnly"
              type="textarea"
              :rows="2"
              placeholder="每行一个值"
              class="ms-w-240"
              data-testid="approval-field-visibility-values"
              @update:model-value="updateVisibilityString('valueText', $event)"
            />
            <el-input
              v-else-if="field.visibility.operator === 'eq' || field.visibility.operator === 'neq'"
              :model-value="field.visibility.valueText"
              :disabled="readOnly"
              placeholder="比较值"
              class="ms-w-240"
              data-testid="approval-field-visibility-value"
              @update:model-value="updateVisibilityString('valueText', $event)"
            />
          </template>
        </div>
        <div v-if="field.visibility.dependsOnFieldId" class="approval-field-inspector__hint">
          仅当依赖字段满足条件时才显示本字段。
          <template v-if="field.visibility.operator === 'eq' || field.visibility.operator === 'neq'">
            比较值留空表示「{{ field.visibility.operator === 'eq' ? '等于' : '不等于' }}空值」；要取消规则请把依赖字段设为「无」。
          </template>
        </div>
      </el-form-item>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  createEmptyDetailColumnDraft,
  DETAIL_LEAF_FIELD_TYPES,
  type DetailColumnDraft,
  type FieldAuthoringDraft,
  type FormAuthoringFieldType,
} from '../templateAuthoring'
import type { FormFieldVisibilityOperator } from '../../types/approval'
import { APPROVAL_FORM_FIELD_TYPE_LABELS } from '../formPalette'
import {
  buildRecordLinkBaseSelectOptions,
  buildRecordLinkSheetSelectOptions,
  type RecordLinkNamedOption,
} from '../recordLinkField'

const props = withDefaults(defineProps<{
  fields: FieldAuthoringDraft[]
  field: FieldAuthoringDraft
  readOnly: boolean
  showHeading?: boolean
  recordLinkBases: RecordLinkNamedOption[]
  recordLinkSheets: Array<RecordLinkNamedOption & { baseId?: string | null }>
  recordLinkCatalogLoading: boolean
  recordLinkCatalogLoaded: boolean
  recordLinkCatalogError: string
  attachmentAuthoringEnabled: boolean
}>(), {
  showHeading: true,
})

const field = computed(() => props.field)

const emit = defineEmits<{
  'retry-record-link-catalog': []
  'update:field': [field: FieldAuthoringDraft]
}>()

const DETAIL_LEAF_TYPE_LABELS: Record<string, string> = {
  text: '文本',
  textarea: '多行文本',
  number: '数字',
  date: '日期',
  datetime: '日期时间',
  select: '单选',
  'multi-select': '多选',
  user: '用户',
}

const detailLeafTypeOptions = DETAIL_LEAF_FIELD_TYPES.map((type) => ({
  value: type,
  label: DETAIL_LEAF_TYPE_LABELS[type] ?? type,
}))

const recordLinkBaseOptions = computed(() =>
  buildRecordLinkBaseSelectOptions(props.recordLinkBases, field.value.recordLinkBaseId),
)

const recordLinkSheetOptions = computed(() =>
  buildRecordLinkSheetSelectOptions(
    props.recordLinkSheets,
    field.value.recordLinkBaseId,
    field.value.recordLinkSheetId,
  ),
)

const visibilityFieldOptions = computed(() =>
  props.fields
    .filter((candidate) => (
      candidate.localId !== field.value.localId
      && candidate.id.trim().length > 0
      && candidate.type !== 'record-link'
      && candidate.type !== 'detail'
    ))
    .map((candidate) => ({
      localId: candidate.localId,
      id: candidate.id.trim(),
      label: candidate.label?.trim() || '未命名字段',
    })),
)

function cloneField(): FieldAuthoringDraft {
  return JSON.parse(JSON.stringify(field.value)) as FieldAuthoringDraft
}

function updateField(mutate: (next: FieldAuthoringDraft) => void): void {
  if (props.readOnly) return
  const next = cloneField()
  mutate(next)
  emit('update:field', next)
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function updateStringField(
  key: 'label' | 'placeholder' | 'optionsText' | 'minRowsText' | 'maxRowsText',
  value: unknown,
): void {
  updateField((next) => { next[key] = toStringValue(value) })
}

function updateRequired(value: unknown): void {
  updateField((next) => { next.required = value === true })
}

function onFieldTypeChange(value: unknown): void {
  if (typeof value !== 'string') return
  if (value === 'attachment' && !props.attachmentAuthoringEnabled) return
  updateField((next) => { next.type = value as FormAuthoringFieldType })
}

function addDetailColumn(): void {
  updateField((next) => {
    next.detailColumns = [
      ...next.detailColumns,
      createEmptyDetailColumnDraft(next.detailColumns.length + 1),
    ]
  })
}

function removeDetailColumn(index: number): void {
  updateField((next) => {
    next.detailColumns = next.detailColumns.filter((_, current) => current !== index)
  })
}

function updateDetailString(
  index: number,
  key: 'label' | 'optionsText',
  value: unknown,
): void {
  updateField((next) => {
    const column = next.detailColumns[index]
    if (column) column[key] = toStringValue(value)
  })
}

function updateDetailType(index: number, value: unknown): void {
  if (typeof value !== 'string' || !DETAIL_LEAF_FIELD_TYPES.includes(value as DetailColumnDraft['type'])) return
  updateField((next) => {
    const column = next.detailColumns[index]
    if (column) column.type = value as DetailColumnDraft['type']
  })
}

function updateDetailRequired(index: number, value: unknown): void {
  updateField((next) => {
    const column = next.detailColumns[index]
    if (column) column.required = value === true
  })
}

function updateVisibilityString(
  key: 'dependsOnFieldId' | 'valueText',
  value: unknown,
): void {
  updateField((next) => { next.visibility[key] = toStringValue(value) })
}

function updateVisibilityOperator(value: unknown): void {
  if (typeof value !== 'string') return
  updateField((next) => { next.visibility.operator = value as FormFieldVisibilityOperator })
}

function onCatalogSelectVisible(open: boolean): void {
  if (open && !props.recordLinkCatalogLoaded) emit('retry-record-link-catalog')
}

function onRecordLinkBaseChange(value: string | null | undefined): void {
  const baseId = typeof value === 'string' ? value.trim() : ''
  updateField((next) => {
    next.recordLinkBaseId = baseId
    if (!next.recordLinkSheetId.trim()) return
    const sheetStillValid = props.recordLinkSheets.some(
      (sheet) => sheet.id === next.recordLinkSheetId.trim()
        && (typeof sheet.baseId === 'string' ? sheet.baseId.trim() : '') === baseId,
    )
    if (!sheetStillValid) next.recordLinkSheetId = ''
  })
}

function onRecordLinkSheetChange(value: string | null | undefined): void {
  updateField((next) => {
    next.recordLinkSheetId = typeof value === 'string' ? value.trim() : ''
  })
}
</script>

<style scoped>
.approval-field-inspector {
  min-width: 0;
}

.approval-field-inspector__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.approval-field-inspector__heading > div {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.approval-field-inspector__heading small {
  overflow: hidden;
  color: var(--el-text-color-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.approval-field-inspector__type {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 999px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.approval-field-inspector__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}

.approval-field-inspector__wide {
  grid-column: 1 / -1;
}

.approval-field-inspector__hint {
  margin-top: 6px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.approval-field-inspector__catalog-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 8px;
}

.approval-field-inspector__detail,
.approval-field-inspector__detail-table {
  width: 100%;
}

.approval-field-inspector__detail-actions,
.approval-field-inspector__visibility {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
}

.approval-field-inspector__detail-actions {
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

@media (max-width: 760px) {
  .approval-field-inspector__grid {
    grid-template-columns: 1fr;
  }
}
</style>
