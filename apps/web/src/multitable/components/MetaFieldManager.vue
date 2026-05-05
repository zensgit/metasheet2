<template>
  <div v-if="visible" class="meta-field-mgr__overlay" @click.self="requestClose">
    <div class="meta-field-mgr">
      <div class="meta-field-mgr__header">
        <h4 class="meta-field-mgr__title">Manage Fields</h4>
        <button class="meta-field-mgr__close" @click="requestClose">&times;</button>
      </div>

      <div class="meta-field-mgr__body">
        <div
          v-for="(field, idx) in fields"
          :key="field.id"
          class="meta-field-mgr__row"
        >
          <span class="meta-field-mgr__icon">{{ FIELD_ICONS[displayFieldType(field)] ?? '?' }}</span>

          <template v-if="editingId === field.id">
            <input
              class="meta-field-mgr__rename"
              :value="editingName"
              @input="editingName = ($event.target as HTMLInputElement).value"
              @keydown.enter="confirmRename(field.id)"
              @keydown.escape="cancelRename"
            />
            <button class="meta-field-mgr__action meta-field-mgr__action--ok" @click="confirmRename(field.id)">&#x2713;</button>
            <button class="meta-field-mgr__action" @click="cancelRename">&#x2717;</button>
          </template>
          <template v-else>
            <span class="meta-field-mgr__name" :title="field.name">{{ field.name }}</span>
            <span class="meta-field-mgr__type">{{ displayFieldType(field) }}</span>
            <button class="meta-field-mgr__action" title="Configure" @click="openConfig(field)">&#x2699;</button>
            <button class="meta-field-mgr__action" title="Rename" @click="startRename(field)">&#x270E;</button>
            <button class="meta-field-mgr__action" :disabled="idx === 0" title="Move up" @click="moveField(field.id, idx - 1)">&#x25B2;</button>
            <button class="meta-field-mgr__action" :disabled="idx === fields.length - 1" title="Move down" @click="moveField(field.id, idx + 1)">&#x25BC;</button>
            <button class="meta-field-mgr__action meta-field-mgr__action--danger" title="Delete" @click="onDeleteField(field)">&#x1F5D1;</button>
          </template>
        </div>

        <div v-if="!fields.length" class="meta-field-mgr__empty">No fields defined</div>
      </div>

      <div v-if="configTargetType" class="meta-field-mgr__config">
        <div class="meta-field-mgr__config-header">
          <strong>{{ configTarget ? `Configure ${configTarget.name}` : `Configure new ${newFieldType} field` }}</strong>
          <span>{{ configTargetType }}</span>
        </div>
        <div v-if="fieldConfigOutdated" class="meta-field-mgr__warning">
          <span>{{ fieldConfigWarningText }}</span>
          <button class="meta-field-mgr__btn-inline" @click="reloadLatestConfig">Reload latest</button>
        </div>
        <div v-else-if="fieldConfigLiveRefreshText" class="meta-field-mgr__refresh">
          <span>{{ fieldConfigLiveRefreshText }}</span>
          <button class="meta-field-mgr__btn-inline" @click="dismissLiveRefreshNotice">Dismiss</button>
        </div>

        <template v-if="configTargetType === 'select' || configTargetType === 'multiSelect'">
          <div class="meta-field-mgr__field">
            <span>Options</span>
            <div class="meta-field-mgr__stack">
              <div v-for="(option, idx) in selectDraft.options" :key="idx" class="meta-field-mgr__option-row">
                <input v-model="option.value" class="meta-field-mgr__input" placeholder="Value" />
                <input v-model="option.color" class="meta-field-mgr__input" placeholder="#409eff" />
                <button class="meta-field-mgr__action meta-field-mgr__action--danger" @click="removeSelectOption(idx)">&times;</button>
              </div>
              <button class="meta-field-mgr__btn-inline" @click="addSelectOption">+ Add option</button>
            </div>
          </div>
        </template>

        <template v-else-if="configTargetType === 'link'">
          <label class="meta-field-mgr__field">
            <span>Target sheet</span>
            <select v-model="linkDraft.foreignSheetId" class="meta-field-mgr__select">
              <option value="">Select sheet</option>
              <option v-for="sheet in targetSheets" :key="sheet.id" :value="sheet.id">{{ sheet.name }}</option>
            </select>
          </label>
          <label class="meta-field-mgr__toggle">
            <input v-model="linkDraft.limitSingleRecord" type="checkbox" />
            <span>Limit to a single linked record</span>
          </label>
        </template>

        <template v-else-if="configTargetType === 'person'">
          <div class="meta-field-mgr__hint">
            People fields use the system people sheet preset and stay hidden from normal sheet navigation.
          </div>
          <label class="meta-field-mgr__toggle">
            <input v-model="personDraft.limitSingleRecord" type="checkbox" />
            <span>Limit to a single person</span>
          </label>
        </template>

        <template v-else-if="configTargetType === 'lookup'">
          <label class="meta-field-mgr__field">
            <span>Link field</span>
            <select v-model="lookupDraft.linkFieldId" class="meta-field-mgr__select">
              <option value="">Select link field</option>
              <option v-for="field in linkSourceFields" :key="field.id" :value="field.id">{{ field.name }}</option>
            </select>
          </label>
          <div class="meta-field-mgr__grid">
            <label class="meta-field-mgr__field">
              <span>Foreign sheet id</span>
              <input v-model="lookupDraft.foreignSheetId" class="meta-field-mgr__input" placeholder="Optional override" />
            </label>
            <label class="meta-field-mgr__field">
              <span>Target field id</span>
              <input v-model="lookupDraft.targetFieldId" class="meta-field-mgr__input" placeholder="fld_target" />
            </label>
          </div>
        </template>

        <template v-else-if="configTargetType === 'rollup'">
          <label class="meta-field-mgr__field">
            <span>Link field</span>
            <select v-model="rollupDraft.linkFieldId" class="meta-field-mgr__select">
              <option value="">Select link field</option>
              <option v-for="field in linkSourceFields" :key="field.id" :value="field.id">{{ field.name }}</option>
            </select>
          </label>
          <div class="meta-field-mgr__grid">
            <label class="meta-field-mgr__field">
              <span>Foreign sheet id</span>
              <input v-model="rollupDraft.foreignSheetId" class="meta-field-mgr__input" placeholder="Optional override" />
            </label>
            <label class="meta-field-mgr__field">
              <span>Target field id</span>
              <input v-model="rollupDraft.targetFieldId" class="meta-field-mgr__input" placeholder="fld_target" />
            </label>
          </div>
          <label class="meta-field-mgr__field">
            <span>Aggregation</span>
            <select v-model="rollupDraft.aggregation" class="meta-field-mgr__select">
              <option value="count">count</option>
              <option value="sum">sum</option>
              <option value="avg">avg</option>
              <option value="min">min</option>
              <option value="max">max</option>
            </select>
          </label>
        </template>

        <template v-else-if="configTargetType === 'formula'">
          <label class="meta-field-mgr__field">
            <span>Expression</span>
            <textarea v-model="formulaDraft.expression" class="meta-field-mgr__textarea" placeholder="=SUM({fld_price}, {fld_tax})"></textarea>
          </label>
          <div v-if="formulaDiagnostics.length" class="meta-field-mgr__formula-diagnostics">
            <div
              v-for="diagnostic in formulaDiagnostics"
              :key="diagnostic.message"
              class="meta-field-mgr__formula-diagnostic"
              :class="`meta-field-mgr__formula-diagnostic--${diagnostic.severity}`"
            >
              {{ diagnostic.message }}
            </div>
          </div>
          <div class="meta-field-mgr__field">
            <span>Insert field token</span>
            <div class="meta-field-mgr__chips">
              <button
                v-for="field in formulaSourceFields"
                :key="field.id"
                type="button"
                class="meta-field-mgr__chip"
                :title="`Insert {${field.id}}`"
                @click="insertFormulaField(field.id)"
              >{{ field.name }}</button>
            </div>
          </div>
          <div class="meta-field-mgr__field">
            <span>Formula reference</span>
            <div class="meta-field-mgr__formula-toolbar">
              <input
                v-model="formulaFunctionSearch"
                class="meta-field-mgr__input"
                placeholder="Search SUM, IF, %, ^, &..."
              />
              <select v-model="formulaFunctionCategory" class="meta-field-mgr__select">
                <option value="all">All categories</option>
                <option
                  v-for="category in formulaFunctionCategories"
                  :key="category.id"
                  :value="category.id"
                >{{ category.label }}</option>
              </select>
            </div>
            <div v-if="formulaCatalogSections.length" class="meta-field-mgr__formula-docs">
              <section
                v-for="section in formulaCatalogSections"
                :key="section.category"
                class="meta-field-mgr__formula-section"
              >
                <div class="meta-field-mgr__formula-section-title">
                  <strong>{{ section.label }}</strong>
                  <span>{{ section.description }}</span>
                </div>
                <button
                  v-for="doc in section.functions"
                  :key="doc.name"
                  type="button"
                  class="meta-field-mgr__formula-doc"
                  @click="insertFormulaFunction(doc)"
                >
                  <strong>{{ doc.signature }}</strong>
                  <span>{{ doc.description }}</span>
                  <code>{{ doc.example }}</code>
                </button>
              </section>
            </div>
            <div v-else class="meta-field-mgr__formula-empty">No matching functions.</div>
          </div>
        </template>

        <template v-else-if="configTargetType === 'attachment'">
          <div class="meta-field-mgr__grid">
            <label class="meta-field-mgr__field">
              <span>Max files</span>
              <input v-model.number="attachmentDraft.maxFiles" class="meta-field-mgr__input" type="number" min="1" />
            </label>
            <label class="meta-field-mgr__field">
              <span>Accepted mime types</span>
              <input v-model="attachmentDraft.acceptedMimeTypesText" class="meta-field-mgr__input" placeholder="image/png,application/pdf" />
            </label>
          </div>
        </template>

        <template v-else-if="configTargetType === 'currency'">
          <div class="meta-field-mgr__grid">
            <label class="meta-field-mgr__field">
              <span>Currency code (ISO 4217)</span>
              <select v-model="currencyDraft.code" class="meta-field-mgr__select">
                <option value="CNY">CNY (¥)</option>
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (€)</option>
                <option value="GBP">GBP (£)</option>
                <option value="JPY">JPY (¥)</option>
                <option value="HKD">HKD (HK$)</option>
                <option value="TWD">TWD (NT$)</option>
                <option value="KRW">KRW (₩)</option>
                <option value="AUD">AUD (A$)</option>
                <option value="CAD">CAD (CA$)</option>
                <option value="SGD">SGD (S$)</option>
              </select>
            </label>
            <label class="meta-field-mgr__field">
              <span>Decimals</span>
              <input v-model.number="currencyDraft.decimals" class="meta-field-mgr__input" type="number" min="0" max="6" />
            </label>
          </div>
        </template>

        <template v-else-if="configTargetType === 'percent'">
          <label class="meta-field-mgr__field">
            <span>Decimals</span>
            <input v-model.number="percentDraft.decimals" class="meta-field-mgr__input" type="number" min="0" max="6" />
          </label>
        </template>

        <template v-else-if="configTargetType === 'rating'">
          <label class="meta-field-mgr__field">
            <span>Maximum rating (1-10)</span>
            <input v-model.number="ratingDraft.max" class="meta-field-mgr__input" type="number" min="1" max="10" />
          </label>
        </template>

        <MetaFieldValidationPanel
          v-if="configTarget && validationPanelVisible"
          class="meta-field-mgr__validation"
          :field-id="configTarget.id"
          :field-type="validationPanelFieldType"
          :rules="validationDraft"
          :options="validationPanelOptions"
          @update:rules="onValidationRulesChange"
        />
        <div v-if="fieldConfigError" class="meta-field-mgr__error">{{ fieldConfigError }}</div>
        <div class="meta-field-mgr__config-actions">
          <button class="meta-field-mgr__btn-cancel" @click="closeConfig">Cancel</button>
          <button class="meta-field-mgr__btn-add" :disabled="Boolean(fieldConfigBlockingReason)" @click="saveConfig">{{ configTarget ? 'Save field settings' : 'Apply defaults' }}</button>
        </div>
      </div>

      <div class="meta-field-mgr__add-section">
        <div class="meta-field-mgr__add-row">
          <input
            v-model="newFieldName"
            class="meta-field-mgr__input"
            placeholder="Field name"
            @keydown.enter="onAddField"
          />
          <select v-model="newFieldType" class="meta-field-mgr__select" @change="openNewFieldConfigIfNeeded">
            <option v-for="t in FIELD_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
          <button class="meta-field-mgr__btn-add" :disabled="!newFieldName.trim()" @click="onAddField">+ Add</button>
        </div>
        <div v-if="newFieldTypeIsSystem" class="meta-field-mgr__hint meta-field-mgr__hint--system">
          {{ systemFieldHint(newFieldType) }}
        </div>
      </div>

      <div v-if="deleteTarget" class="meta-field-mgr__confirm">
        <p>Delete field <strong>{{ deleteTarget.name }}</strong>? This cannot be undone.</p>
        <div class="meta-field-mgr__confirm-actions">
          <button class="meta-field-mgr__btn-cancel" @click="deleteTargetId = null">Cancel</button>
          <button class="meta-field-mgr__btn-delete" @click="confirmDelete">Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { FieldValidationRule, MetaField, MetaFieldCreateType, MetaSheet } from '../types'
import {
  FORMULA_FUNCTION_CATEGORIES,
  buildFormulaFieldTokenInsertion,
  buildFormulaFunctionInsertion,
  getFormulaFunctionCatalog,
  validateFormulaExpression,
  type FormulaFunctionCategory,
  type FormulaFunctionDoc,
  type FormulaDiagnostic,
} from '../utils/formula-docs'
import {
  normalizeStringArray,
  resolveAttachmentFieldProperty,
  resolveCurrencyFieldProperty,
  resolveFormulaFieldProperty,
  resolveLinkFieldProperty,
  resolveLookupFieldProperty,
  resolvePercentFieldProperty,
  resolveRatingFieldProperty,
  resolveRollupFieldProperty,
  resolveSelectFieldOptions,
} from '../utils/field-config'
import {
  SYSTEM_FIELD_TYPES,
  isSystemFieldCreateType,
  systemFieldHint,
} from '../utils/system-fields'
import MetaFieldValidationPanel from './MetaFieldValidationPanel.vue'

/** Field types where the validation panel is configurable. */
const VALIDATION_PANEL_TYPES: ReadonlySet<string> = new Set(['string', 'longText', 'number', 'select', 'multiSelect'])

function mapTypeForValidationPanel(fieldType: string): 'text' | 'number' | 'select' {
  if (fieldType === 'string' || fieldType === 'longText') return 'text'
  if (fieldType === 'number') return 'number'
  return 'select'
}

/**
 * Translate the engine-shape validation array stored on `field.property`
 * (`{ type, params, message }`) into the flat UI shape the panel expects
 * (`{ type, value, message }`).
 */
function rulesFromProperty(property: Record<string, unknown> | null | undefined): FieldValidationRule[] {
  const raw = property?.validation
  if (!Array.isArray(raw)) return []
  const out: FieldValidationRule[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const type = typeof obj.type === 'string' ? obj.type : ''
    if (!type) continue
    const message = typeof obj.message === 'string' ? obj.message : undefined
    const params = obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : undefined
    let value: FieldValidationRule['value']
    if (type === 'min' || type === 'max' || type === 'minLength' || type === 'maxLength') {
      const raw = params?.value ?? (obj as { value?: unknown }).value
      const num = typeof raw === 'number' ? raw : Number(raw)
      if (Number.isFinite(num)) value = num
    } else if (type === 'pattern') {
      const raw = params?.regex ?? (obj as { value?: unknown }).value
      if (typeof raw === 'string') value = raw
    } else if (type === 'enum') {
      const raw = params?.values ?? (obj as { value?: unknown }).value
      if (Array.isArray(raw)) {
        value = raw.filter((v): v is string => typeof v === 'string')
      }
    }
    out.push({ type: type as FieldValidationRule['type'], ...(value !== undefined ? { value } : {}), ...(message ? { message } : {}) })
  }
  return out
}

/**
 * Translate UI-shape rules back into the engine contract for persistence
 * in `field.property.validation`. Drops entries the engine cannot
 * enforce (missing required numeric/regex/enum value).
 */
function rulesToProperty(rules: FieldValidationRule[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const rule of rules) {
    const base: Record<string, unknown> = { type: rule.type }
    if (rule.message) base.message = rule.message
    switch (rule.type) {
      case 'required':
        out.push(base)
        break
      case 'min':
      case 'max':
      case 'minLength':
      case 'maxLength': {
        const num = typeof rule.value === 'number' ? rule.value : Number(rule.value)
        if (!Number.isFinite(num)) continue
        base.params = { value: num }
        out.push(base)
        break
      }
      case 'pattern': {
        if (typeof rule.value !== 'string' || rule.value.length === 0) continue
        base.params = { regex: rule.value }
        out.push(base)
        break
      }
      case 'enum': {
        if (!Array.isArray(rule.value)) continue
        const values = rule.value.filter((v): v is string => typeof v === 'string')
        base.params = { values }
        out.push(base)
        break
      }
    }
  }
  return out
}

const FIELD_TYPES: MetaFieldCreateType[] = [
  'string', 'longText', 'number', 'boolean', 'date', 'select', 'multiSelect', 'link', 'person',
  'formula', 'lookup', 'rollup', 'attachment',
  'currency', 'percent', 'rating', 'url', 'email', 'phone',
  ...SYSTEM_FIELD_TYPES,
]
const FIELD_ICONS: Record<string, string> = {
  string: 'Aa', longText: '\u00B6', number: '#', boolean: '\u2611', date: '\u{1F4C5}', select: '\u25CF', multiSelect: '\u25C9',
  link: '\u21C4', person: '\u{1F464}', lookup: '\u2197', rollup: '\u03A3', formula: 'fx', attachment: '\uD83D\uDCCE',
  currency: '\u00A4', percent: '%', rating: '\u2605', url: '\u{1F517}', email: '\u2709', phone: '\u260E',
  createdTime: 'CT', modifiedTime: 'MT', createdBy: 'CB', modifiedBy: 'MB',
}

const props = defineProps<{
  visible: boolean
  fields: MetaField[]
  sheets: MetaSheet[]
  sheetId: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'create-field', input: { sheetId: string; name: string; type: string; property?: Record<string, unknown> }): void
  (e: 'update-field', fieldId: string, input: { name?: string; order?: number; type?: string; property?: Record<string, unknown> }): void
  (e: 'delete-field', fieldId: string): void
  (e: 'update:dirty', dirty: boolean): void
}>()

const newFieldName = ref('')
const newFieldType = ref<MetaFieldCreateType>('string')
const newFieldConfigVisible = ref(false)
const editingId = ref<string | null>(null)
const editingName = ref('')
const deleteTargetId = ref<string | null>(null)
const configTargetId = ref<string | null>(null)
const configDraftType = ref<string | null>(null)
const fieldConfigError = ref('')

const selectDraft = reactive<{ options: Array<{ value: string; color: string }> }>({
  options: [{ value: '', color: '' }],
})
const linkDraft = reactive<{ foreignSheetId: string; limitSingleRecord: boolean }>({
  foreignSheetId: '',
  limitSingleRecord: false,
})
const personDraft = reactive<{ limitSingleRecord: boolean }>({
  limitSingleRecord: true,
})
const lookupDraft = reactive<{ linkFieldId: string; targetFieldId: string; foreignSheetId: string }>({
  linkFieldId: '',
  targetFieldId: '',
  foreignSheetId: '',
})
const rollupDraft = reactive<{ linkFieldId: string; targetFieldId: string; foreignSheetId: string; aggregation: 'count' | 'sum' | 'avg' | 'min' | 'max' }>({
  linkFieldId: '',
  targetFieldId: '',
  foreignSheetId: '',
  aggregation: 'count',
})
const formulaDraft = reactive<{ expression: string }>({
  expression: '',
})
const formulaFunctionSearch = ref('')
const formulaFunctionCategory = ref<FormulaFunctionCategory | 'all'>('all')
const formulaFunctionCategories = FORMULA_FUNCTION_CATEGORIES
const attachmentDraft = reactive<{ maxFiles: number; acceptedMimeTypesText: string }>({
  maxFiles: 1,
  acceptedMimeTypesText: '',
})
const currencyDraft = reactive<{ code: string; decimals: number }>({
  code: 'CNY',
  decimals: 2,
})
const percentDraft = reactive<{ decimals: number }>({
  decimals: 1,
})
const ratingDraft = reactive<{ max: number }>({
  max: 5,
})
const validationDraft = ref<FieldValidationRule[]>([])
// True when the field had explicit validation rules stored OR the user
// touched the panel. Keeps us from overwriting the engine's defaults
// (e.g. default `enum` on select, default `maxLength: 10000` on string)
// when the user opened the config section but never edited rules.
const validationDraftTouched = ref(false)
const fieldConfigBaseline = ref('')
const fieldConfigOutdated = ref(false)
const fieldConfigLiveRefreshText = ref('')
const fieldConfigSourceSignature = ref('')

const configTarget = computed(() => props.fields.find((field) => field.id === configTargetId.value) ?? null)
const deleteTarget = computed(() => props.fields.find((field) => field.id === deleteTargetId.value) ?? null)
const linkSourceFields = computed(() => props.fields.filter((field) => field.type === 'link'))
const targetSheets = computed(() => props.sheets.filter((sheet) => sheet.id !== props.sheetId))
const formulaSourceFields = computed(() =>
  props.fields.filter((field) => field.id !== configTarget.value?.id && field.type !== 'formula'),
)
const formulaCatalogSections = computed(() =>
  getFormulaFunctionCatalog(formulaFunctionSearch.value, formulaFunctionCategory.value)
    .map((section) => ({ ...section, functions: section.functions.slice(0, 6) })),
)
const formulaDiagnostics = computed<FormulaDiagnostic[]>(() =>
  configTargetType.value === 'formula'
    ? validateFormulaExpression(formulaDraft.expression, formulaSourceFields.value)
    : [],
)
const configTargetType = computed(() => {
  if (configTarget.value) return configDraftType.value
  return newFieldConfigVisible.value && requiresConfig(newFieldType.value) ? newFieldType.value : null
})
const fieldConfigSchemaChanged = computed(() =>
  Boolean(configTarget.value && configDraftType.value && displayFieldType(configTarget.value) !== configDraftType.value),
)
const fieldConfigBlockingReason = computed(() => {
  if (!configTarget.value || !fieldConfigOutdated.value || !fieldConfigSchemaChanged.value) return ''
  return 'This field changed type in the background. Reload latest before saving.'
})
const fieldConfigWarningText = computed(() => {
  return fieldConfigBlockingReason.value || 'This field changed in the background. Save keeps your draft, or reload the latest settings.'
})
const newFieldTypeIsSystem = computed(() => isSystemFieldCreateType(newFieldType.value))

const validationPanelVisible = computed(() => {
  const draftType = configDraftType.value
  if (!draftType) return false
  return VALIDATION_PANEL_TYPES.has(draftType)
})

const validationPanelFieldType = computed(() => {
  return mapTypeForValidationPanel(configDraftType.value ?? '')
})

const validationPanelOptions = computed(() => {
  if (configDraftType.value !== 'select' && configDraftType.value !== 'multiSelect') return undefined
  return selectDraft.options
    .map((option) => ({ value: option.value.trim() }))
    .filter((option) => option.value.length > 0)
})

function onValidationRulesChange(rules: FieldValidationRule[]) {
  validationDraft.value = [...rules]
  validationDraftTouched.value = true
}

function requiresConfig(type: MetaFieldCreateType): boolean {
  return [
    'select', 'multiSelect', 'link', 'person', 'lookup', 'rollup', 'formula', 'attachment',
    'currency', 'percent', 'rating', 'longText',
  ].includes(type)
}

function displayFieldType(field: MetaField): string {
  if (field.type === 'link' && field.property?.refKind === 'user') return 'person'
  return field.type
}

function resetDrafts() {
  selectDraft.options = [{ value: '', color: '' }]
  linkDraft.foreignSheetId = ''
  linkDraft.limitSingleRecord = false
  personDraft.limitSingleRecord = true
  lookupDraft.linkFieldId = ''
  lookupDraft.targetFieldId = ''
  lookupDraft.foreignSheetId = ''
  rollupDraft.linkFieldId = ''
  rollupDraft.targetFieldId = ''
  rollupDraft.foreignSheetId = ''
  rollupDraft.aggregation = 'count'
  formulaDraft.expression = ''
  formulaFunctionSearch.value = ''
  formulaFunctionCategory.value = 'all'
  attachmentDraft.maxFiles = 1
  attachmentDraft.acceptedMimeTypesText = ''
  currencyDraft.code = 'CNY'
  currencyDraft.decimals = 2
  percentDraft.decimals = 1
  ratingDraft.max = 5
  validationDraft.value = []
  validationDraftTouched.value = false
  fieldConfigError.value = ''
}

function serializeFieldDraft(type: string | null): string {
  const validation = VALIDATION_PANEL_TYPES.has(type ?? '') && validationDraftTouched.value
    ? rulesToProperty(validationDraft.value)
    : undefined
  if (type === 'select' || type === 'multiSelect') {
    return JSON.stringify({
      options: selectDraft.options.map((option) => ({
        value: option.value.trim(),
        color: option.color.trim(),
      })),
      validation,
    })
  }
  if (type === 'link') {
    return JSON.stringify({
      foreignSheetId: linkDraft.foreignSheetId,
      limitSingleRecord: linkDraft.limitSingleRecord,
    })
  }
  if (type === 'person') {
    return JSON.stringify({
      limitSingleRecord: personDraft.limitSingleRecord,
    })
  }
  if (type === 'lookup') {
    return JSON.stringify({
      linkFieldId: lookupDraft.linkFieldId,
      targetFieldId: lookupDraft.targetFieldId,
      foreignSheetId: lookupDraft.foreignSheetId,
    })
  }
  if (type === 'rollup') {
    return JSON.stringify({
      linkFieldId: rollupDraft.linkFieldId,
      targetFieldId: rollupDraft.targetFieldId,
      foreignSheetId: rollupDraft.foreignSheetId,
      aggregation: rollupDraft.aggregation,
    })
  }
  if (type === 'formula') {
    return JSON.stringify({ expression: formulaDraft.expression.trim() })
  }
  if (type === 'attachment') {
    return JSON.stringify({
      maxFiles: attachmentDraft.maxFiles,
      acceptedMimeTypesText: attachmentDraft.acceptedMimeTypesText.trim(),
    })
  }
  if (type === 'currency') {
    return JSON.stringify({ code: currencyDraft.code.trim().toUpperCase(), decimals: currencyDraft.decimals })
  }
  if (type === 'percent') {
    return JSON.stringify({ decimals: percentDraft.decimals })
  }
  if (type === 'rating') {
    return JSON.stringify({ max: ratingDraft.max })
  }
  if (type === 'string' || type === 'longText' || type === 'number') {
    return JSON.stringify({ validation })
  }
  return ''
}

function serializeFieldSourceSignature(field: MetaField | null): string {
  if (!field) return ''
  return JSON.stringify({
    id: field.id,
    name: field.name,
    type: field.type,
    property: field.property ?? null,
    fields: props.fields.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      property: item.property ?? null,
    })),
    sheets: props.sheets.map((sheet) => ({
      id: sheet.id,
      name: sheet.name,
    })),
    sheetId: props.sheetId,
  })
}

function hydrateExistingFieldConfig(field: MetaField, options?: { liveRefreshText?: string }) {
  newFieldConfigVisible.value = false
  configTargetId.value = field.id
  resetDrafts()
  const fieldType = displayFieldType(field)
  configDraftType.value = fieldType
  fieldConfigLiveRefreshText.value = options?.liveRefreshText ?? ''
  if (fieldType === 'select' || fieldType === 'multiSelect') {
    const optionsList = resolveSelectFieldOptions(field.property)
    selectDraft.options = optionsList.length > 0
      ? optionsList.map((option) => ({ value: option.value, color: option.color ?? '' }))
      : [{ value: '', color: '' }]
  } else if (fieldType === 'link') {
    const property = resolveLinkFieldProperty(field.property)
    linkDraft.foreignSheetId = property.foreignSheetId ?? ''
    linkDraft.limitSingleRecord = property.limitSingleRecord
  } else if (fieldType === 'person') {
    const property = resolveLinkFieldProperty(field.property)
    personDraft.limitSingleRecord = property.limitSingleRecord || property.limitSingleRecord !== false
  } else if (fieldType === 'lookup') {
    const property = resolveLookupFieldProperty(field.property)
    lookupDraft.linkFieldId = property.linkFieldId ?? ''
    lookupDraft.targetFieldId = property.targetFieldId ?? ''
    lookupDraft.foreignSheetId = property.foreignSheetId ?? ''
  } else if (fieldType === 'rollup') {
    const property = resolveRollupFieldProperty(field.property)
    rollupDraft.linkFieldId = property.linkFieldId ?? ''
    rollupDraft.targetFieldId = property.targetFieldId ?? ''
    rollupDraft.foreignSheetId = property.foreignSheetId ?? ''
    rollupDraft.aggregation = property.aggregation
  } else if (fieldType === 'formula') {
    formulaDraft.expression = resolveFormulaFieldProperty(field.property).expression
  } else if (fieldType === 'attachment') {
    const property = resolveAttachmentFieldProperty(field.property)
    attachmentDraft.maxFiles = property.maxFiles ?? 1
    attachmentDraft.acceptedMimeTypesText = property.acceptedMimeTypes.join(',')
  } else if (fieldType === 'currency') {
    const property = resolveCurrencyFieldProperty(field.property)
    currencyDraft.code = property.code
    currencyDraft.decimals = property.decimals
  } else if (fieldType === 'percent') {
    const property = resolvePercentFieldProperty(field.property)
    percentDraft.decimals = property.decimals
  } else if (fieldType === 'rating') {
    const property = resolveRatingFieldProperty(field.property)
    ratingDraft.max = property.max
  }
  if (VALIDATION_PANEL_TYPES.has(fieldType)) {
    const loaded = rulesFromProperty(field.property ?? null)
    validationDraft.value = loaded
    validationDraftTouched.value = loaded.length > 0
  }
  fieldConfigBaseline.value = serializeFieldDraft(fieldType)
  fieldConfigOutdated.value = false
  fieldConfigSourceSignature.value = serializeFieldSourceSignature(field)
}

function closeConfig() {
  if (!configTarget.value) {
    newFieldConfigVisible.value = false
  }
  configTargetId.value = null
  configDraftType.value = null
  fieldConfigBaseline.value = ''
  fieldConfigOutdated.value = false
  fieldConfigLiveRefreshText.value = ''
  fieldConfigSourceSignature.value = ''
  resetDrafts()
}

function resetTransientState() {
  newFieldName.value = ''
  newFieldType.value = 'string'
  editingId.value = null
  editingName.value = ''
  deleteTargetId.value = null
  configTargetId.value = null
  configDraftType.value = null
  newFieldConfigVisible.value = false
  fieldConfigBaseline.value = ''
  fieldConfigOutdated.value = false
  fieldConfigLiveRefreshText.value = ''
  fieldConfigSourceSignature.value = ''
  resetDrafts()
}

function requestClose() {
  if (!confirmDiscardFieldManagerChanges()) return
  resetTransientState()
  emit('close')
}

function openNewFieldConfigIfNeeded() {
  if (!requiresConfig(newFieldType.value)) {
    newFieldConfigVisible.value = false
    configTargetId.value = null
    configDraftType.value = null
    fieldConfigBaseline.value = ''
    fieldConfigOutdated.value = false
    fieldConfigLiveRefreshText.value = ''
    fieldConfigSourceSignature.value = ''
    return
  }
  resetDrafts()
  newFieldConfigVisible.value = true
  configTargetId.value = null
  configDraftType.value = newFieldType.value
  fieldConfigBaseline.value = serializeFieldDraft(newFieldType.value)
  fieldConfigOutdated.value = false
  fieldConfigLiveRefreshText.value = ''
  fieldConfigSourceSignature.value = ''
}

function currentDraftProperty(type: MetaFieldCreateType | string): Record<string, unknown> | undefined {
  const normalizedType = type === 'link' || type === 'select' || type === 'multiSelect' || type === 'lookup' || type === 'rollup' || type === 'formula' || type === 'attachment' || type === 'person' || type === 'currency' || type === 'percent' || type === 'rating'
    ? type
    : null
  fieldConfigError.value = ''

  const validationProperty = VALIDATION_PANEL_TYPES.has(type) && validationDraftTouched.value
    ? { validation: rulesToProperty(validationDraft.value) }
    : {}

  if (normalizedType === 'select' || normalizedType === 'multiSelect') {
    const options = selectDraft.options
      .map((option) => ({ value: option.value.trim(), color: option.color.trim() }))
      .filter((option) => option.value.length > 0)
    if (!options.length) {
      fieldConfigError.value = `${normalizedType === 'multiSelect' ? 'Multi-select' : 'Select'} fields need at least one option`
      return undefined
    }
    return { options, ...validationProperty }
  }
  if (normalizedType === 'link') {
    if (!linkDraft.foreignSheetId || !targetSheets.value.some((sheet) => sheet.id === linkDraft.foreignSheetId)) {
      fieldConfigError.value = 'Choose a target sheet for link fields'
      return undefined
    }
    return {
      foreignSheetId: linkDraft.foreignSheetId,
      foreignDatasheetId: linkDraft.foreignSheetId,
      limitSingleRecord: linkDraft.limitSingleRecord,
    }
  }
  if (normalizedType === 'person') {
    return { limitSingleRecord: personDraft.limitSingleRecord }
  }
  if (normalizedType === 'lookup') {
    if (!lookupDraft.linkFieldId || !linkSourceFields.value.some((field) => field.id === lookupDraft.linkFieldId) || !lookupDraft.targetFieldId) {
      fieldConfigError.value = 'Lookup fields need a link field and a target field id'
      return undefined
    }
    if (lookupDraft.foreignSheetId && !targetSheets.value.some((sheet) => sheet.id === lookupDraft.foreignSheetId)) {
      fieldConfigError.value = 'Lookup fields need a valid target sheet'
      return undefined
    }
    return {
      relatedLinkFieldId: lookupDraft.linkFieldId,
      lookUpTargetFieldId: lookupDraft.targetFieldId,
      ...(lookupDraft.foreignSheetId ? { foreignSheetId: lookupDraft.foreignSheetId } : {}),
    }
  }
  if (normalizedType === 'rollup') {
    if (!rollupDraft.linkFieldId || !linkSourceFields.value.some((field) => field.id === rollupDraft.linkFieldId) || !rollupDraft.targetFieldId) {
      fieldConfigError.value = 'Rollup fields need a link field and a target field id'
      return undefined
    }
    if (rollupDraft.foreignSheetId && !targetSheets.value.some((sheet) => sheet.id === rollupDraft.foreignSheetId)) {
      fieldConfigError.value = 'Rollup fields need a valid target sheet'
      return undefined
    }
    return {
      linkedFieldId: rollupDraft.linkFieldId,
      targetFieldId: rollupDraft.targetFieldId,
      aggregation: rollupDraft.aggregation,
      ...(rollupDraft.foreignSheetId ? { foreignSheetId: rollupDraft.foreignSheetId } : {}),
    }
  }
  if (normalizedType === 'formula') {
    const blockingDiagnostic = formulaDiagnostics.value.find((diagnostic) => diagnostic.severity === 'error')
    if (blockingDiagnostic) {
      fieldConfigError.value = blockingDiagnostic.message
      return undefined
    }
    return { expression: formulaDraft.expression.trim() }
  }
  if (normalizedType === 'attachment') {
    return {
      maxFiles: attachmentDraft.maxFiles,
      acceptedMimeTypes: normalizeStringArray(attachmentDraft.acceptedMimeTypesText.split(',')),
    }
  }
  if (normalizedType === 'currency') {
    const code = currencyDraft.code.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code)) {
      fieldConfigError.value = 'Currency code must be a 3-letter ISO code (e.g. CNY, USD, EUR)'
      return undefined
    }
    const decimals = Number(currencyDraft.decimals)
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 6) {
      fieldConfigError.value = 'Currency decimals must be between 0 and 6'
      return undefined
    }
    return { code, decimals: Math.round(decimals) }
  }
  if (normalizedType === 'percent') {
    const decimals = Number(percentDraft.decimals)
    if (!Number.isFinite(decimals) || decimals < 0 || decimals > 6) {
      fieldConfigError.value = 'Percent decimals must be between 0 and 6'
      return undefined
    }
    return { decimals: Math.round(decimals) }
  }
  if (normalizedType === 'rating') {
    const max = Number(ratingDraft.max)
    if (!Number.isFinite(max) || max < 1 || max > 10) {
      fieldConfigError.value = 'Rating max must be between 1 and 10'
      return undefined
    }
    return { max: Math.round(max) }
  }
  if (type === 'string' || type === 'longText' || type === 'number') {
    return { ...validationProperty }
  }
  return undefined
}

function insertFormulaField(fieldId: string) {
  formulaDraft.expression = buildFormulaFieldTokenInsertion(formulaDraft.expression, fieldId)
}

function insertFormulaFunction(doc: FormulaFunctionDoc) {
  formulaDraft.expression = buildFormulaFunctionInsertion(formulaDraft.expression, doc)
}

function onAddField() {
  const name = newFieldName.value.trim()
  if (!name) return
  if (requiresConfig(newFieldType.value) && !newFieldConfigVisible.value) {
    openNewFieldConfigIfNeeded()
    return
  }
  const property = requiresConfig(newFieldType.value) ? currentDraftProperty(newFieldType.value) : undefined
  if (requiresConfig(newFieldType.value) && !property && fieldConfigError.value) return
  emit('create-field', {
    sheetId: props.sheetId,
    name,
    type: newFieldType.value,
    ...(property ? { property } : {}),
  })
  resetTransientState()
}

function saveConfig() {
  if (!configTarget.value) {
    if (requiresConfig(newFieldType.value)) currentDraftProperty(newFieldType.value)
    return
  }
  if (fieldConfigBlockingReason.value) return
  const fieldType = configDraftType.value ?? displayFieldType(configTarget.value)
  const property = currentDraftProperty(fieldType)
  if (!property && fieldConfigError.value) return
  if (!property) return
  // Skip no-op saves for types that only expose validation: if the user
  // never touched the panel there is nothing to persist, and emitting
  // an empty `property: {}` would otherwise clobber existing values on
  // the server. Types with mandatory structural config (select/link/
  // lookup/rollup/formula/attachment) always have keys to persist.
  const onlyValidationSurface = (fieldType === 'string' || fieldType === 'longText' || fieldType === 'number')
  if (onlyValidationSurface && !validationDraftTouched.value) {
    closeConfig()
    return
  }
  emit('update-field', configTarget.value.id, { property })
  closeConfig()
}

function startRename(field: MetaField) {
  if (editingId.value !== field.id && !confirmDiscardFieldManagerChanges()) return
  editingId.value = field.id
  editingName.value = field.name
}

function confirmRename(fieldId: string) {
  const name = editingName.value.trim()
  if (name && name !== props.fields.find((field) => field.id === fieldId)?.name) {
    emit('update-field', fieldId, { name })
  }
  cancelRename()
}

function cancelRename() {
  editingId.value = null
  editingName.value = ''
}

function moveField(fieldId: string, newIdx: number) {
  emit('update-field', fieldId, { order: newIdx })
}

function onDeleteField(field: MetaField) {
  deleteTargetId.value = field.id
}

function confirmDelete() {
  if (deleteTarget.value) {
    emit('delete-field', deleteTarget.value.id)
    deleteTargetId.value = null
  }
}

const fieldConfigDirty = computed(() => {
  if (!configTarget.value) return false
  return serializeFieldDraft(configDraftType.value) !== fieldConfigBaseline.value
})

const newFieldDraftDirty = computed(() => {
  if (!requiresConfig(newFieldType.value) || !newFieldConfigVisible.value) return false
  return serializeFieldDraft(newFieldType.value) !== fieldConfigBaseline.value
})

const renameDirty = computed(() => {
  if (!editingId.value) return false
  return editingName.value.trim() !== (props.fields.find((field) => field.id === editingId.value)?.name ?? '')
})

const hasPendingDrafts = computed(() => fieldConfigDirty.value ||
  renameDirty.value ||
  newFieldName.value.trim().length > 0 ||
  newFieldType.value !== 'string' ||
  newFieldDraftDirty.value)

const managerDirty = computed(() => props.visible && hasPendingDrafts.value)

function confirmDiscardFieldManagerChanges() {
  if (!hasPendingDrafts.value) return true
  return window.confirm('Discard unsaved field manager changes?')
}

function reloadLatestConfig() {
  if (!configTarget.value) return
  hydrateExistingFieldConfig(configTarget.value)
}

function dismissLiveRefreshNotice() {
  fieldConfigLiveRefreshText.value = ''
}

function addSelectOption() {
  selectDraft.options.push({ value: '', color: '' })
}

function removeSelectOption(index: number) {
  if (selectDraft.options.length === 1) {
    selectDraft.options.splice(0, 1, { value: '', color: '' })
    return
  }
  selectDraft.options.splice(index, 1)
}

function openConfig(field: MetaField) {
  if (configTargetId.value && configTargetId.value !== field.id && !confirmDiscardFieldManagerChanges()) return
  hydrateExistingFieldConfig(field)
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) resetTransientState()
  },
)

watch(
  [() => props.fields, () => props.sheets, () => props.sheetId, () => configTargetId.value, () => deleteTargetId.value, () => editingId.value],
  () => {
    if (configTargetId.value && !configTarget.value) closeConfig()
    else if (configTarget.value) {
      const latestSignature = serializeFieldSourceSignature(configTarget.value)
      if (latestSignature !== fieldConfigSourceSignature.value) {
        if (fieldConfigDirty.value) {
          fieldConfigOutdated.value = true
          fieldConfigLiveRefreshText.value = ''
        } else {
          hydrateExistingFieldConfig(configTarget.value, {
            liveRefreshText: 'Latest field metadata loaded from the sheet context.',
          })
        }
      }
    }
    if (deleteTargetId.value && !deleteTarget.value) deleteTargetId.value = null
    if (editingId.value && !props.fields.some((field) => field.id === editingId.value)) cancelRename()
  },
)

watch(
  fieldConfigDirty,
  (dirty) => {
    if (dirty) fieldConfigLiveRefreshText.value = ''
  },
)

watch(
  managerDirty,
  (dirty) => {
    emit('update:dirty', dirty)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  emit('update:dirty', false)
})
</script>

<style scoped>
.meta-field-mgr__overlay { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 100; display: flex; align-items: center; justify-content: center; }
.meta-field-mgr { width: 720px; max-height: 84vh; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); display: flex; flex-direction: column; }
.meta-field-mgr__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-field-mgr__title { font-size: 15px; font-weight: 600; margin: 0; }
.meta-field-mgr__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-field-mgr__body { flex: 1; overflow-y: auto; padding: 8px 16px; }
.meta-field-mgr__row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f5f5f5; }
.meta-field-mgr__icon { width: 24px; text-align: center; color: #999; font-size: 13px; }
.meta-field-mgr__name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-field-mgr__type { font-size: 11px; color: #999; background: #f5f5f5; padding: 1px 6px; border-radius: 3px; }
.meta-field-mgr__rename { flex: 1; padding: 2px 6px; border: 1px solid #409eff; border-radius: 3px; font-size: 13px; }
.meta-field-mgr__action { border: none; background: none; color: #999; cursor: pointer; font-size: 13px; padding: 2px 4px; }
.meta-field-mgr__action:hover { color: #333; }
.meta-field-mgr__action:disabled { opacity: 0.3; cursor: not-allowed; }
.meta-field-mgr__action--ok { color: #67c23a; }
.meta-field-mgr__action--danger:hover { color: #f56c6c; }
.meta-field-mgr__empty { text-align: center; padding: 20px; color: #999; font-size: 13px; }
.meta-field-mgr__config { padding: 14px 16px; border-top: 1px solid #eee; background: #fbfdff; display: flex; flex-direction: column; gap: 12px; }
.meta-field-mgr__config-header { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: #666; }
.meta-field-mgr__field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #666; }
.meta-field-mgr__toggle { display: flex; gap: 8px; align-items: center; font-size: 12px; color: #444; }
.meta-field-mgr__hint { padding: 8px 10px; border: 1px solid #d9ecff; border-radius: 6px; background: #ecf5ff; color: #4a6785; font-size: 12px; }
.meta-field-mgr__warning { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid #f3d19e; border-radius: 6px; background: #fff7e6; color: #8a5a00; font-size: 12px; }
.meta-field-mgr__refresh { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: 1px solid #bfd6ff; border-radius: 6px; background: #eef5ff; color: #1d4ed8; font-size: 12px; }
.meta-field-mgr__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.meta-field-mgr__chip { border: 1px solid #d9ecff; border-radius: 999px; background: #f0f7ff; color: #2563eb; padding: 3px 10px; cursor: pointer; font-size: 11px; }
.meta-field-mgr__formula-diagnostics { display: flex; flex-direction: column; gap: 4px; }
.meta-field-mgr__formula-diagnostic { padding: 6px 8px; border-radius: 5px; font-size: 12px; }
.meta-field-mgr__formula-diagnostic--warning { background: #fff7e6; color: #8a5a00; border: 1px solid #f3d19e; }
.meta-field-mgr__formula-diagnostic--error { background: #fef0f0; color: #c0392b; border: 1px solid #fbc4c4; }
.meta-field-mgr__formula-toolbar { display: grid; grid-template-columns: minmax(0, 1fr) 180px; gap: 8px; }
.meta-field-mgr__formula-docs { display: flex; flex-direction: column; gap: 10px; max-height: 220px; overflow-y: auto; }
.meta-field-mgr__formula-section { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.meta-field-mgr__formula-section-title { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; color: #334155; }
.meta-field-mgr__formula-section-title strong { font-size: 12px; color: #0f172a; }
.meta-field-mgr__formula-section-title span { font-size: 11px; color: #64748b; }
.meta-field-mgr__formula-doc { display: flex; flex-direction: column; gap: 3px; padding: 8px; border: 1px solid #e2e8f0; border-radius: 6px; background: #fff; color: #334155; text-align: left; cursor: pointer; }
.meta-field-mgr__formula-doc:hover { border-color: #93c5fd; background: #f8fbff; }
.meta-field-mgr__formula-doc strong { font-size: 12px; color: #1d4ed8; }
.meta-field-mgr__formula-doc span { font-size: 11px; color: #64748b; }
.meta-field-mgr__formula-doc code { font-size: 11px; color: #475569; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta-field-mgr__formula-empty { padding: 8px; border: 1px dashed #cbd5e1; border-radius: 6px; color: #64748b; background: #fff; font-size: 12px; }
.meta-field-mgr__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.meta-field-mgr__stack { display: flex; flex-direction: column; gap: 8px; }
.meta-field-mgr__option-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center; }
.meta-field-mgr__add-section { padding: 10px 16px; border-top: 1px solid #eee; }
.meta-field-mgr__add-row { display: flex; gap: 8px; }
.meta-field-mgr__input, .meta-field-mgr__select, .meta-field-mgr__textarea { width: 100%; padding: 5px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; background: #fff; }
.meta-field-mgr__textarea { min-height: 88px; resize: vertical; }
.meta-field-mgr__btn-add { padding: 5px 14px; background: #409eff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
.meta-field-mgr__btn-add:disabled { opacity: 0.4; cursor: not-allowed; }
.meta-field-mgr__btn-add:hover:not(:disabled) { background: #66b1ff; }
.meta-field-mgr__btn-inline { align-self: flex-start; padding: 4px 10px; border: 1px dashed #cbd5e1; border-radius: 4px; background: #fff; color: #475569; cursor: pointer; font-size: 12px; }
.meta-field-mgr__confirm { padding: 12px 16px; border-top: 1px solid #eee; background: #fef0f0; }
.meta-field-mgr__confirm p { margin: 0 0 8px; font-size: 13px; color: #333; }
.meta-field-mgr__confirm-actions, .meta-field-mgr__config-actions { display: flex; gap: 8px; justify-content: flex-end; }
.meta-field-mgr__btn-cancel { padding: 4px 12px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-field-mgr__btn-delete { padding: 4px 12px; background: #f56c6c; color: #fff; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
.meta-field-mgr__error { color: #f56c6c; font-size: 12px; }
.meta-field-mgr__validation { margin-top: 4px; }
</style>
