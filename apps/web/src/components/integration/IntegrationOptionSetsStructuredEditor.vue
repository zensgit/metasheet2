<template>
  <div class="option-sets-editor" data-testid="option-sets-structured-editor">
    <p v-if="rows.length === 0" class="option-sets-editor__hint" data-testid="option-sets-empty-hint">
      {{ bi('还没有字段；点击"新增字段"开始（示例：字段名 material_type，选项 value=plate / label=Plate）。',
            'No fields yet — click "Add field" to start (example: field material_type, option value=plate / label=Plate).') }}
    </p>
    <p v-if="duplicateFieldKeys.length > 0" class="option-sets-editor__hint option-sets-editor__hint--warning" data-testid="option-sets-duplicate-warning">
      {{ bi('存在重复字段名，序列化时只会保留同名的最后一行；请修改字段名以避免遗漏数据。',
            'Duplicate field names detected — only the last row with a given name is kept on serialize; rename to avoid losing data.') }}
    </p>
    <div class="option-sets-editor__rows">
      <div v-for="(row, rowIndex) in rows" :key="row.id" class="option-sets-editor__row" :data-testid="`option-sets-row-${rowIndex}`">
        <div class="option-sets-editor__row-head">
          <label class="option-sets-editor__field-key">
            <span>{{ bi('字段名', 'Field key') }}</span>
            <input
              :value="row.fieldKey"
              type="text"
              :placeholder="bi('例如 material_type', 'e.g. material_type')"
              :data-testid="`option-sets-row-key-${rowIndex}`"
              @input="onFieldKeyInput(row, $event)"
            />
          </label>
          <button
            type="button"
            class="integration-workbench__icon-button"
            :data-testid="`option-sets-row-remove-${rowIndex}`"
            @click="removeRow(rowIndex)"
          >
            {{ bi('删除字段', 'Remove field') }}
          </button>
        </div>
        <div class="option-sets-editor__options">
          <div
            v-for="(option, optionIndex) in row.options"
            :key="option.id"
            class="option-sets-editor__option"
            :data-testid="`option-sets-option-${rowIndex}-${optionIndex}`"
          >
            <label>
              <span>value</span>
              <input
                :value="option.entry.value"
                type="text"
                :placeholder="bi('例如 plate', 'e.g. plate')"
                :data-testid="`option-sets-option-value-${rowIndex}-${optionIndex}`"
                @input="onOptionFieldInput(option, 'value', $event)"
              />
            </label>
            <label>
              <span>label</span>
              <input
                :value="option.entry.label"
                type="text"
                :placeholder="bi('例如 Plate', 'e.g. Plate')"
                :data-testid="`option-sets-option-label-${rowIndex}-${optionIndex}`"
                @input="onOptionFieldInput(option, 'label', $event)"
              />
            </label>
            <button
              type="button"
              class="integration-workbench__icon-button"
              :data-testid="`option-sets-option-remove-${rowIndex}-${optionIndex}`"
              @click="removeOption(row, optionIndex)"
            >
              {{ bi('删除选项', 'Remove') }}
            </button>
          </div>
          <button
            type="button"
            class="integration-workbench__button"
            :data-testid="`option-sets-option-add-${rowIndex}`"
            @click="addOption(row)"
          >
            {{ bi('新增选项', 'Add option') }}
          </button>
        </div>
      </div>
    </div>
    <button type="button" class="integration-workbench__button" data-testid="option-sets-add-row" @click="addRow">
      {{ bi('新增字段', 'Add field') }}
    </button>
  </div>
</template>

<script setup lang="ts">
// D2 (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-5, site 5):
// repeatable-row structured editor for the `optionSets JSON` textarea in
// `IntegrationFieldOptionSyncPanel.vue`. Mounted with `v-if` (not `v-show`) by the parent — every
// time the parent switches INTO structured mode this component is freshly created, so parsing the
// current model text happens exactly once, at setup, from the parent's live text at that moment
// (never via a reactive text->rows watcher, which would fight in-progress row edits / create an
// update loop). The parent is responsible for only mounting this component when
// `parseOptionSets` on the current text succeeds (`ok: true`) — see that module's header comment
// for the closed-shape contract this editor structures.
//
// Data flow is one-way-at-a-time: user edits (add/remove row, add/remove option, or an input's
// own `@input`) synchronously rebuild the JSON text via `serializeOptionSets` and emit
// `update:modelValue` — the parent's shared model (and therefore the sibling expert-mode textarea,
// the run button's can-run gate, etc.) stays live-in-sync exactly like the plain textarea used to
// behave. This component never reads `props.modelValue` again after the initial parse — the
// parent owns "is the current text still structurable" via its own `parseOptionSets` check for
// the mode-toggle gate.
//
// Existing option entries are carried through by REFERENCE (not cloned) and mutated in place
// (`option.entry.value = ...`) so any key beyond `value`/`label` (e.g. `actionBindings`) and the
// original per-entry key order survive edits untouched — see optionSetsStructured.ts's header.
import { reactive, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import {
  findDuplicateFieldKeys,
  parseOptionSets,
  serializeOptionSets,
  type OptionSetsOptionEntry,
} from '../../utils/optionSetsStructured'

const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

interface UiOption {
  id: number
  entry: OptionSetsOptionEntry
}

interface UiRow {
  id: number
  fieldKey: string
  options: UiOption[]
}

let nextId = 0

// Defensive fallback only — the parent gates mounting on `parseOptionSets(...).ok === true`, so
// this branch should be unreachable in normal use. Never throw on unexpected input; degrade to a
// fresh empty wrapped document instead (an empty structured editor is a safe, visible state; a
// thrown error would blank the whole panel).
const initialParse = parseOptionSets(props.modelValue)
const wrapped = initialParse.ok ? initialParse.wrapped : true
const originalRecord = initialParse.ok ? initialParse.originalRecord : {}
const initialRows = initialParse.ok ? initialParse.rows : []

const rows = reactive<UiRow[]>(
  initialRows.map((row) => ({
    id: nextId++,
    fieldKey: row.fieldKey,
    options: row.options.map((entry) => ({ id: nextId++, entry })),
  })),
)

const duplicateFieldKeys = ref<string[]>(findDuplicateFieldKeys(toFieldRows()))

function toFieldRows() {
  return rows.map((row) => ({
    fieldKey: row.fieldKey,
    options: row.options.map((option) => option.entry),
  }))
}

function handleEdit(): void {
  duplicateFieldKeys.value = findDuplicateFieldKeys(toFieldRows())
  emit('update:modelValue', serializeOptionSets(toFieldRows(), wrapped, originalRecord))
}

function addRow(): void {
  rows.push({ id: nextId++, fieldKey: '', options: [] })
  handleEdit()
}

function removeRow(index: number): void {
  rows.splice(index, 1)
  handleEdit()
}

function addOption(row: UiRow): void {
  row.options.push({ id: nextId++, entry: { value: '', label: '' } })
  handleEdit()
}

function removeOption(row: UiRow, index: number): void {
  row.options.splice(index, 1)
  handleEdit()
}

// Explicit `:value` + `@input` (rather than `v-model` alongside a second `@input` listener on the
// same element) so the mutate-then-serialize ordering is unambiguous — a single handler mutates
// the reactive field and THEN reads `rows` to serialize, with no dependency on how Vue would merge
// two separate `input` listeners on one element.
function onFieldKeyInput(row: UiRow, event: Event): void {
  row.fieldKey = (event.target as HTMLInputElement).value
  handleEdit()
}

function onOptionFieldInput(option: UiOption, field: 'value' | 'label', event: Event): void {
  option.entry[field] = (event.target as HTMLInputElement).value
  handleEdit()
}
</script>

<style scoped>
.option-sets-editor {
  display: grid;
  gap: var(--ms-space-2);
  margin-top: var(--ms-space-2);
}

.option-sets-editor__hint {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.option-sets-editor__hint--warning {
  color: var(--ms-color-danger);
  font-weight: 700;
}

.option-sets-editor__rows {
  display: grid;
  gap: 10px;
}

.option-sets-editor__row {
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  padding: 10px 12px;
}

.option-sets-editor__row-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.option-sets-editor__field-key {
  display: grid;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  color: var(--ms-text-1);
  font-size: 13px;
  font-weight: 700;
}

.option-sets-editor__field-key input {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  padding: 6px 8px;
  color: var(--ms-text-1);
  font: inherit;
  font-weight: 700;
}

.option-sets-editor__options {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.option-sets-editor__option {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: end;
  gap: 8px;
}

.option-sets-editor__option label {
  display: grid;
  gap: 4px;
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: 600;
}

.option-sets-editor__option input {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  padding: 6px 8px;
  color: var(--ms-text-1);
  font: inherit;
}

.integration-workbench__button,
.integration-workbench__icon-button {
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-weight: 700;
  text-decoration: none;
}

.integration-workbench__button {
  padding: 8px 12px;
  justify-self: start;
}

.integration-workbench__icon-button {
  padding: 6px 8px;
  flex-shrink: 0;
}

.integration-workbench__button:hover,
.integration-workbench__icon-button:hover {
  border-color: var(--ms-color-primary);
}

@media (max-width: 900px) {
  .option-sets-editor__option {
    grid-template-columns: 1fr;
  }
}
</style>
