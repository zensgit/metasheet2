<template>
  <div class="template-authoring__form-designer">
    <aside class="template-authoring__form-palette-pane">
      <p class="template-authoring__form-palette-title">控件</p>
      <!-- D6-f2 palette: ordinary users pick a field kind; no field-id entry. -->
      <div
        v-if="!readOnly"
        class="template-authoring__field-palette"
        data-testid="approval-field-palette"
        role="group"
        aria-label="添加表单字段类型"
      >
        <section
          v-for="group in fieldPaletteGroups"
          :key="group.id"
          class="template-authoring__field-palette-group"
        >
          <h3>{{ group.label }}</h3>
          <div class="template-authoring__field-palette-grid">
            <button
              v-for="entry in group.entries"
              :key="entry.type"
              type="button"
              class="template-authoring__field-palette-chip"
              :data-testid="`approval-field-palette-${entry.type}`"
              :draggable="true"
              @click="addFieldOfType(entry.type)"
              @dragstart="onPaletteDragStart(entry.type, $event)"
            >
              <span>{{ entry.label }}</span>
              <span class="template-authoring__field-palette-mark" aria-hidden="true">{{ entry.mark }}</span>
            </button>
          </div>
        </section>
      </div>
    </aside>

    <div
      class="template-authoring__form-preview-stage"
      @dragover.prevent
      @drop="onPreviewDrop"
    >
      <div class="template-authoring__form-phone" data-testid="approval-form-preview">
        <header class="template-authoring__form-phone-title">
          {{ templateName.trim() || '未命名审批' }}
        </header>
        <div class="template-authoring__form-phone-body">
          <div
            v-if="fields.length === 0"
            class="template-authoring__form-drop-hint"
          >
            点击或拖拽左侧控件至此处
          </div>
          <button
            v-for="(field, index) in fields"
            :key="`preview-${field.localId}`"
            type="button"
            class="template-authoring__form-preview-row"
            :class="{ 'is-selected': formFieldFocusLocalId === field.localId }"
            :data-testid="`approval-form-preview-row-${field.localId}`"
            @click="selectFormFieldFocus(field.localId)"
            :draggable="!readOnly"
            @dragstart="onFieldDragStart(index)"
            @dragover.prevent
            @drop.stop="onFieldDrop(index)"
          >
            <span class="template-authoring__form-preview-label">{{ field.label.trim() || fieldPaletteLabels[field.type] }}</span>
            <span class="template-authoring__form-preview-type">{{ fieldPaletteLabels[field.type] }}</span>
          </button>
          <div
            v-if="fields.length > 0 && !readOnly"
            class="template-authoring__form-drop-hint is-tail"
          >
            点击或拖拽左侧控件至此处
          </div>
        </div>
      </div>
    </div>

    <div class="template-authoring__form-inspector-pane">
      <div
        v-for="(field, index) in fields"
        :id="`approval-field-row-${field.localId}`"
        :key="field.localId"
        v-show="formFieldFocusLocalId === field.localId || (!formFieldFocusLocalId && index === 0)"
        class="template-authoring__item"
        :class="{ 'template-authoring__item--focused': formFieldFocusLocalId === field.localId }"
        data-testid="approval-template-field-row"
        :data-field-local-id="field.localId"
        :data-selected="formFieldFocusLocalId === field.localId ? 'true' : undefined"
        :aria-current="formFieldFocusLocalId === field.localId ? 'true' : undefined"
        tabindex="-1"
        :draggable="!readOnly"
        @focusin="selectFormFieldFocus(field.localId)"
        @dragstart="onFieldDragStart(index)"
        @dragover.prevent
        @drop="onFieldDrop(index)"
      >
        <div class="template-authoring__item-toolbar">
          <strong>字段 {{ index + 1 }}</strong>
          <div>
            <el-button size="small" :disabled="readOnly || index === 0" @click="moveField(index, -1)">上移</el-button>
            <el-button size="small" :disabled="readOnly || index === fields.length - 1" @click="moveField(index, 1)">下移</el-button>
            <el-button size="small" type="danger" :disabled="readOnly || fields.length === 1" @click="removeField(index)">删除</el-button>
          </div>
        </div>
        <div class="template-authoring__grid">
          <!-- D1 hygiene: field.id is auto-generated / load-preserved; not an ordinary control. -->
          <el-form-item label="字段名称">
            <el-input v-model="field.label" :disabled="readOnly" />
          </el-form-item>
          <el-form-item label="类型">
            <el-select
              v-model="field.type"
              :disabled="readOnly"
              class="ms-w-100pct"
              data-testid="approval-field-type"
              @change="invalidateStaleRecordLinkDependencies(field)"
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
              <el-option label="日期区间" value="date_range" />
            </el-select>
          </el-form-item>
          <el-form-item label="占位文本">
            <el-input v-model="field.placeholder" :disabled="readOnly" />
          </el-form-item>
          <el-form-item label="是否必填">
            <el-checkbox v-model="field.required" :disabled="readOnly">必填</el-checkbox>
          </el-form-item>
          <el-form-item
            v-if="field.type === 'record-link'"
            label="关联目标"
            class="template-authoring__wide"
            data-testid="approval-record-link-config"
          >
            <div
              v-if="recordLinkCatalogError"
              class="template-authoring__hint template-authoring__record-link-catalog-error"
              data-testid="approval-record-link-catalog-error"
            >
              <span>{{ recordLinkCatalogError }}</span>
              <el-button
                type="primary"
                link
                size="small"
                :loading="recordLinkCatalogLoading"
                data-testid="approval-record-link-catalog-retry"
                @click="retryRecordLinkCatalog"
              >
                重试
              </el-button>
            </div>
            <div class="template-authoring__grid">
              <el-form-item label="目标空间">
                <el-select
                  :model-value="field.recordLinkBaseId || undefined"
                  :disabled="readOnly || recordLinkCatalogLoading"
                  filterable
                  clearable
                  class="ms-w-100pct"
                  placeholder="请选择目标空间"
                  data-testid="approval-record-link-base-select"
                  @update:model-value="(value: string | null | undefined) => onRecordLinkBaseChange(field, value)"
                  @visible-change="(open: boolean) => { if (open && !recordLinkCatalogLoaded) retryRecordLinkCatalog() }"
                >
                  <el-option
                    v-for="opt in recordLinkBaseOptionsFor(field)"
                    :key="opt.value"
                    :label="opt.label"
                    :value="opt.value"
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
                  @update:model-value="(value: string | null | undefined) => onRecordLinkSheetChange(field, value)"
                  @visible-change="(open: boolean) => { if (open && !recordLinkCatalogLoaded) retryRecordLinkCatalog() }"
                >
                  <el-option
                    v-for="opt in recordLinkSheetOptionsFor(field)"
                    :key="opt.value"
                    :label="opt.label"
                    :value="opt.value"
                  />
                </el-select>
              </el-form-item>
            </div>
            <div class="template-authoring__hint">
              仅可选择目标表中的一条记录。提交时会验证发起人是否可查看所选记录；不可用的历史目标需重新选择。
            </div>
          </el-form-item>

          <el-form-item
            v-if="field.type === 'select' || field.type === 'multi-select'"
            label="选项"
            class="template-authoring__wide"
          >
            <el-input
              v-model="field.optionsText"
              :disabled="readOnly"
              type="textarea"
              :rows="3"
              placeholder="每行一个选项，格式：显示名:值"
            />
          </el-form-item>
          <!-- L8-C (approval-lock8-field-vocabulary-20260817.md §1.3, OD-L8-6/M10): formatted-number
               DISPLAY props on the EXISTING `number` type — currency prefix, thousands separator,
               中文大写 (amountInWords.ts re-sited). Every control here writes to a real
               FieldAuthoringDraft key that buildFormSchema emits (M7: no inert/disabled-theater
               controls). Copy stays scoped to formatted-DISPLAY vocabulary only — never a
               money/exact-storage claim (gate M-2). -->
          <el-form-item
            v-if="field.type === 'number'"
            label="格式化数字"
            class="template-authoring__wide"
            data-testid="approval-number-format-config"
          >
            <div class="template-authoring__grid">
              <el-form-item label="货币符号">
                <el-select
                  v-model="field.numberCurrencySymbol"
                  :disabled="readOnly"
                  clearable
                  class="ms-w-100pct"
                  data-testid="approval-number-currency-select"
                >
                  <el-option label="不显示" value="" />
                  <el-option label="¥ 人民币" value="¥" />
                  <el-option label="$ 美元" value="$" />
                  <el-option label="€ 欧元" value="€" />
                  <el-option label="£ 英镑" value="£" />
                </el-select>
              </el-form-item>
              <el-form-item label="千位分隔符">
                <el-checkbox
                  v-model="field.numberThousandsSeparator"
                  :disabled="readOnly"
                  data-testid="approval-number-thousands-toggle"
                >
                  显示千位分隔符
                </el-checkbox>
              </el-form-item>
              <el-form-item label="中文大写">
                <el-checkbox
                  v-model="field.numberUppercaseCny"
                  :disabled="readOnly"
                  data-testid="approval-number-uppercase-toggle"
                >
                  显示中文大写
                </el-checkbox>
              </el-form-item>
            </div>
            <div class="template-authoring__hint">
              格式化数字仅用于展示（货币符号、千位分隔符、中文大写回显），不改变提交的数值。
            </div>
          </el-form-item>
          <!-- Lock-8 L8-B (approval-lock8-field-vocabulary-20260817.md §1.2, OD-L8-4/OD-L8-5/
               OD-L8-8): date_range (日期区间) — a start+end pair. `dateType` is REQUIRED with NO
               absent-default (a range whose granularity is implicit cannot be compared or diffed
               unambiguously, §1.2) — the placeholder option is intentionally non-selectable-back-to
               so an author must actively choose. `startLabel`/`endLabel` are required (C-7's
               控件名称 1/2); `durationLabel` is an OPTIONAL custom label for the ALWAYS-rendered
               derived duration (OD-L8-8) — every control here writes to a real FieldAuthoringDraft
               key `buildFormSchema` emits (M7: no inert/disabled-theater controls). -->
          <el-form-item
            v-if="field.type === 'date_range'"
            label="日期区间"
            class="template-authoring__wide"
            data-testid="approval-date-range-config"
          >
            <div class="template-authoring__grid">
              <el-form-item label="日期类型" required>
                <el-select
                  v-model="field.dateRangeDateType"
                  :disabled="readOnly"
                  class="ms-w-100pct"
                  data-testid="approval-date-range-type-select"
                >
                  <el-option label="年-月-日" value="date" />
                  <el-option label="年-月-日 上午/下午" value="date_half_day" />
                  <el-option label="年-月-日 时:分" value="date_minute" />
                </el-select>
              </el-form-item>
              <el-form-item label="起始控件名称" required>
                <el-input
                  v-model="field.dateRangeStartLabel"
                  :disabled="readOnly"
                  placeholder="例如：开始时间"
                  data-testid="approval-date-range-start-label"
                />
              </el-form-item>
              <el-form-item label="结束控件名称" required>
                <el-input
                  v-model="field.dateRangeEndLabel"
                  :disabled="readOnly"
                  placeholder="例如：结束时间"
                  data-testid="approval-date-range-end-label"
                />
              </el-form-item>
              <el-form-item label="时长控件名称">
                <el-input
                  v-model="field.dateRangeDurationLabel"
                  :disabled="readOnly"
                  placeholder="默认：时长"
                  data-testid="approval-date-range-duration-label"
                />
              </el-form-item>
            </div>
            <div class="template-authoring__hint">
              时长由起始、结束自动计算并展示，不可编辑；提交时以系统计算结果为准。
            </div>
          </el-form-item>
          <!-- detail / sub-form (明细) config: sub-field list editor + minRows/maxRows. Each
               sub-field is a LEAF type (no nested detail). Mirrors the backend column schema. -->
          <el-form-item
            v-if="field.type === 'detail'"
            label="明细子字段"
            class="template-authoring__wide"
          >
            <div class="template-authoring__detail" data-testid="approval-detail-config">
              <el-table
                v-if="field.detailColumns.length > 0"
                :data="field.detailColumns"
                border
                size="small"
                class="template-authoring__detail-table"
              >
                <!-- D1 hygiene: detail column id is auto-generated / load-preserved; not ordinary UI. -->
                <el-table-column label="名称" min-width="120">
                  <template #default="{ row }">
                    <el-input v-model="row.label" :disabled="readOnly" placeholder="如 品名" />
                  </template>
                </el-table-column>
                <el-table-column label="类型" min-width="120">
                  <template #default="{ row }">
                    <el-select v-model="row.type" :disabled="readOnly" class="ms-w-100pct">
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
                  <template #default="{ row }">
                    <el-checkbox v-model="row.required" :disabled="readOnly" />
                  </template>
                </el-table-column>
                <el-table-column label="选项" min-width="160">
                  <template #default="{ row }">
                    <el-input
                      v-if="row.type === 'select' || row.type === 'multi-select'"
                      v-model="row.optionsText"
                      :disabled="readOnly"
                      type="textarea"
                      :rows="2"
                      placeholder="每行一个：显示名:值"
                    />
                    <span v-else class="template-authoring__hint">—</span>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="70" align="center">
                  <template #default="{ $index }">
                    <el-button
                      type="danger"
                      link
                      :disabled="readOnly"
                      @click="removeDetailColumn(field, $index)"
                    >
                      删除
                    </el-button>
                  </template>
                </el-table-column>
              </el-table>
              <div v-else class="template-authoring__hint">尚无子字段，请添加至少一个。</div>
              <div class="template-authoring__detail-actions">
                <el-button
                  size="small"
                  type="primary"
                  plain
                  :disabled="readOnly"
                  data-testid="approval-detail-add-column"
                  @click="addDetailColumn(field)"
                >
                  添加子字段
                </el-button>
                <el-input
                  v-model="field.minRowsText"
                  :disabled="readOnly"
                  placeholder="最小行数"
                  class="ms-w-120"
                />
                <el-input
                  v-model="field.maxRowsText"
                  :disabled="readOnly"
                  placeholder="最大行数"
                  class="ms-w-120"
                />
              </div>
            </div>
          </el-form-item>
          <el-form-item label="显隐规则" class="template-authoring__wide">
            <div class="template-authoring__visibility">
              <el-select
                v-model="field.visibility.dependsOnFieldId"
                :disabled="readOnly"
                class="ms-w-200"
                data-testid="approval-field-visibility-depends"
              >
                <el-option label="无（始终显示）" value="" />
                <el-option
                  v-for="dep in visibilityFieldOptions(field)"
                  :key="dep.localId"
                  :label="dep.label"
                  :value="dep.id"
                />
              </el-select>
              <template v-if="field.visibility.dependsOnFieldId">
                <el-select
                  v-model="field.visibility.operator"
                  :disabled="readOnly"
                  class="ms-w-130"
                  data-testid="approval-field-visibility-operator"
                >
                  <el-option label="等于" value="eq" />
                  <el-option label="不等于" value="neq" />
                  <el-option label="包含" value="in" />
                  <el-option label="为空" value="isEmpty" />
                  <el-option label="不为空" value="notEmpty" />
                </el-select>
                <el-input
                  v-if="field.visibility.operator === 'in'"
                  v-model="field.visibility.valueText"
                  :disabled="readOnly"
                  type="textarea"
                  :rows="2"
                  placeholder="每行一个值"
                  class="ms-w-240"
                  data-testid="approval-field-visibility-values"
                />
                <el-input
                  v-else-if="field.visibility.operator === 'eq' || field.visibility.operator === 'neq'"
                  v-model="field.visibility.valueText"
                  :disabled="readOnly"
                  placeholder="比较值"
                  class="ms-w-240"
                  data-testid="approval-field-visibility-value"
                />
              </template>
            </div>
            <div v-if="field.visibility.dependsOnFieldId" class="template-authoring__hint">
              仅当依赖字段满足条件时才显示本字段。
              <template v-if="field.visibility.operator === 'eq' || field.visibility.operator === 'neq'">
                比较值留空表示「{{ field.visibility.operator === 'eq' ? '等于' : '不等于' }}空值」；要取消规则请把依赖字段设为「无」。
              </template>
            </div>
          </el-form-item>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * F0 extraction (delta §5 F0) — the current #4917 three-region form-design shell
 * (grouped draggable palette, phone-frame preview, focused-field inspector pane,
 * append-only drop, direct `v-model` property edits) moved out of
 * `TemplateAuthoringView.vue` byte/behavior-equivalent. This is the permanent
 * flag-OFF fallback (FB-D8); it is NOT the new Designer 2.0 builder and must not
 * import `approvalFormCommands` or change identity/drop semantics.
 *
 * Ownership boundary (Gate F0):
 * - All field-list mutation, form history (undo/redo), focus management, and
 *   record-link catalog state/loading/retry/validation REMAIN PARENT-OWNED.
 * - This component is a synchronous, always-present descendant in the same DOM
 *   position as before (no lazy/async boundary, no Teleport, no remount-on-edit,
 *   no second fetch). It renders parent-supplied state and forwards every
 *   interaction to the parent via typed emits; it never mutates `fields`
 *   structurally itself and never reads catalog values back from the DOM.
 * - `field.label` / `field.type` / etc. v-model bindings mutate the SAME reactive
 *   `FieldAuthoringDraft` objects the parent owns (passed through the `fields`
 *   prop by reference) — this is the pre-existing direct-property-edit behavior
 *   (FB-D7 legacy path), preserved unchanged, not a new second owner.
 *
 * Props:
 * - fields: the live `draft.fields` array (shared reference; property v-models
 *   mutate it in place, exactly as before extraction).
 * - readOnly: whole-template read-only (permission or unsupported-template lock).
 * - templateName: `draft.name`, used for the phone-preview header.
 * - formFieldFocusLocalId: the parent's structural-history focus cursor.
 * - fieldPaletteGroups / fieldPaletteLabels / detailLeafTypeOptions: parent-owned
 *   pure display data (palette grouping, type labels, detail leaf-type options).
 * - recordLinkCatalogError / recordLinkCatalogLoading / recordLinkCatalogLoaded:
 *   parent-owned record-link catalog state (Gate F0 #2 — never duplicated here).
 * - recordLinkBaseOptionsFor / recordLinkSheetOptionsFor / visibilityFieldOptions:
 *   parent-owned pure derivation functions (same functions the parent used
 *   in-template before extraction; called here, never re-implemented).
 *
 * Emits (all forward 1:1 to the parent's pre-existing handler of the same name;
 * the parent owns every mutation and history/catalog side effect):
 * - add-field-of-type, palette-drag-start, preview-drop, select-field-focus,
 *   field-drag-start, field-drop, move-field, remove-field,
 *   invalidate-record-link-deps, retry-record-link-catalog,
 *   record-link-base-change, record-link-sheet-change, add-detail-column,
 *   remove-detail-column.
 *
 * No injections are used.
 */
import type { AuthorableFieldType, FieldAuthoringDraft } from '../templateAuthoring'

interface ApprovalFormFieldPaletteEntry {
  type: AuthorableFieldType
  label: string
  mark: string
}

interface ApprovalFormFieldPaletteGroup {
  id: string
  label: string
  entries: ApprovalFormFieldPaletteEntry[]
}

interface ApprovalFormSelectOption {
  value: string
  label: string
}

interface ApprovalFormVisibilityFieldOption {
  localId: string
  id: string
  label: string
}

interface ApprovalFormDetailLeafTypeOption {
  value: string
  label: string
}

defineProps<{
  fields: FieldAuthoringDraft[]
  readOnly: boolean
  templateName: string
  formFieldFocusLocalId: string | null
  fieldPaletteGroups: ApprovalFormFieldPaletteGroup[]
  fieldPaletteLabels: Record<AuthorableFieldType, string>
  detailLeafTypeOptions: ApprovalFormDetailLeafTypeOption[]
  recordLinkCatalogError: string
  recordLinkCatalogLoading: boolean
  recordLinkCatalogLoaded: boolean
  recordLinkBaseOptionsFor: (field: FieldAuthoringDraft) => ApprovalFormSelectOption[]
  recordLinkSheetOptionsFor: (field: FieldAuthoringDraft) => ApprovalFormSelectOption[]
  visibilityFieldOptions: (field: FieldAuthoringDraft) => ApprovalFormVisibilityFieldOption[]
}>()

const emit = defineEmits<{
  (e: 'add-field-of-type', type: AuthorableFieldType): void
  (e: 'palette-drag-start', type: AuthorableFieldType, event: DragEvent): void
  (e: 'preview-drop', event: DragEvent): void
  (e: 'select-field-focus', localId: string): void
  (e: 'field-drag-start', index: number): void
  (e: 'field-drop', index: number): void
  (e: 'move-field', index: number, delta: -1 | 1): void
  (e: 'remove-field', index: number): void
  (e: 'invalidate-record-link-deps', field: FieldAuthoringDraft): void
  (e: 'retry-record-link-catalog'): void
  (e: 'record-link-base-change', field: FieldAuthoringDraft, value: string | null | undefined): void
  (e: 'record-link-sheet-change', field: FieldAuthoringDraft, value: string | null | undefined): void
  (e: 'add-detail-column', field: FieldAuthoringDraft): void
  (e: 'remove-detail-column', field: FieldAuthoringDraft, index: number): void
}>()

function addFieldOfType(type: AuthorableFieldType): void {
  emit('add-field-of-type', type)
}
function onPaletteDragStart(type: AuthorableFieldType, event: DragEvent): void {
  emit('palette-drag-start', type, event)
}
function onPreviewDrop(event: DragEvent): void {
  emit('preview-drop', event)
}
function selectFormFieldFocus(localId: string): void {
  emit('select-field-focus', localId)
}
function onFieldDragStart(index: number): void {
  emit('field-drag-start', index)
}
function onFieldDrop(index: number): void {
  emit('field-drop', index)
}
function moveField(index: number, delta: -1 | 1): void {
  emit('move-field', index, delta)
}
function removeField(index: number): void {
  emit('remove-field', index)
}
function invalidateStaleRecordLinkDependencies(field: FieldAuthoringDraft): void {
  emit('invalidate-record-link-deps', field)
}
function retryRecordLinkCatalog(): void {
  emit('retry-record-link-catalog')
}
function onRecordLinkBaseChange(field: FieldAuthoringDraft, value: string | null | undefined): void {
  emit('record-link-base-change', field, value)
}
function onRecordLinkSheetChange(field: FieldAuthoringDraft, value: string | null | undefined): void {
  emit('record-link-sheet-change', field, value)
}
function addDetailColumn(field: FieldAuthoringDraft): void {
  emit('add-detail-column', field)
}
function removeDetailColumn(field: FieldAuthoringDraft, index: number): void {
  emit('remove-detail-column', field, index)
}
</script>

<style scoped>
/* Classes shared with TemplateAuthoringView.vue (used both inside this extracted
   region and elsewhere in the parent's remaining sections) are copied verbatim
   here per the established extraction pattern (IU-2b/IU-2c) — CSS `scoped`
   attributes do not cross component boundaries, so a shared class must be
   defined in both places rather than left only in the parent. */
.template-authoring__item-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.template-authoring__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}

.template-authoring__wide {
  grid-column: 1 / -1;
}

.template-authoring__visibility {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-start;
}

.template-authoring__hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

.template-authoring__detail {
  width: 100%;
}

.template-authoring__detail-table {
  width: 100%;
}

.template-authoring__detail-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.template-authoring__item {
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.template-authoring__item + .template-authoring__item {
  margin-top: 12px;
}

/* Form palette focus-return: selected field row (formFieldFocusLocalId). */
.template-authoring__item--focused {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary-light-5);
}

.template-authoring__item--focused:focus {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

@media (max-width: 760px) {
  .template-authoring__grid {
    grid-template-columns: 1fr;
  }
}

/* Classes exclusive to this extracted three-region shell. */
.template-authoring__form-designer {
  display: grid;
  grid-template-columns: 228px minmax(0, 1fr) minmax(280px, 360px);
  gap: 0;
  min-height: min(68vh, 720px);
  margin: -8px -12px -16px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.template-authoring__form-palette-pane {
  border-right: 1px solid var(--el-border-color-lighter);
  padding: 12px 12px 16px;
  overflow: auto;
  background: var(--el-bg-color);
}
.template-authoring__form-palette-title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
}
.template-authoring__field-palette {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-bottom: 0;
}
.template-authoring__field-palette-group h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}
.template-authoring__field-palette-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.template-authoring__field-palette-chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 36px;
  padding: 6px 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  color: var(--el-text-color-regular);
  font-size: 12px;
  cursor: grab;
  text-align: left;
}
.template-authoring__field-palette-chip:hover,
.template-authoring__field-palette-chip:focus-visible {
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}
.template-authoring__field-palette-mark {
  color: var(--el-text-color-placeholder);
  font-size: 11px;
}
.template-authoring__form-preview-stage {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 24px 16px 32px;
  background: var(--el-fill-color-lighter);
}
.template-authoring__form-phone {
  width: min(100%, 360px);
  min-height: 520px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 16px;
  background: var(--el-bg-color);
  box-shadow: var(--el-box-shadow-lighter);
  overflow: hidden;
}
.template-authoring__form-phone-title {
  padding: 16px 16px 12px;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.template-authoring__form-phone-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.template-authoring__form-preview-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 8px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-blank);
  cursor: pointer;
  text-align: left;
}
.template-authoring__form-preview-row.is-selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-8);
}
.template-authoring__form-preview-label {
  font-size: 13px;
  color: var(--el-text-color-primary);
}
.template-authoring__form-preview-type {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}
.template-authoring__form-drop-hint {
  min-height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  background: var(--el-fill-color-blank);
}
.template-authoring__form-drop-hint.is-tail {
  min-height: 48px;
  font-size: 12px;
}
.template-authoring__form-inspector-pane {
  border-left: 1px solid var(--el-border-color-lighter);
  padding: 12px;
  overflow: auto;
  background: var(--el-bg-color);
}
@media (max-width: 1100px) {
  .template-authoring__form-designer {
    grid-template-columns: 200px minmax(0, 1fr);
  }
  .template-authoring__form-inspector-pane {
    grid-column: 1 / -1;
    border-left: 0;
    border-top: 1px solid var(--el-border-color-lighter);
  }
}
</style>
