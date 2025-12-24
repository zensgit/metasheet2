<template>
  <div class="meta-fields">
    <div class="meta-fields__header">
      <div>
        <h2 class="meta-fields__title">Meta Fields</h2>
        <div class="meta-fields__subtitle">
          sheetId: <span class="meta-fields__mono">{{ sheetId }}</span>
        </div>
      </div>
      <div class="meta-fields__header-actions">
        <router-link class="meta-fields__btn" to="/sheets">返回 Sheets</router-link>
        <router-link
          v-if="sheetId"
          class="meta-fields__btn"
          :to="{ path: `/sheets/${encodeURIComponent(sheetId)}/views` }"
        >
          Views
        </router-link>
        <button type="button" class="meta-fields__btn" :disabled="loading" @click="refresh">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <div class="meta-fields__create">
      <input
        v-model="createName"
        class="meta-fields__input"
        placeholder="新字段名称"
        @keydown.enter.prevent="createField"
      />
      <select v-model="createType" class="meta-fields__select">
        <option value="string">string</option>
        <option value="number">number</option>
        <option value="boolean">boolean</option>
        <option value="formula">formula</option>
        <option value="select">select</option>
        <option value="link">link</option>
        <option value="lookup">lookup</option>
        <option value="rollup">rollup</option>
      </select>
      <button
        type="button"
        class="meta-fields__btn meta-fields__btn--primary"
        :disabled="createLoading || !createName.trim() || !sheetId"
        @click="createField"
      >
        {{ createLoading ? '创建中…' : '创建' }}
      </button>
      <label class="meta-fields__checkbox">
        <input v-model="createReadonly" type="checkbox" :disabled="createReadonlyForced" />
        只读
        <span v-if="createReadonlyForced" class="meta-fields__muted">（lookup/rollup 自动只读）</span>
      </label>
      <div v-if="createType === 'select'" class="meta-fields__options">
        <textarea
          v-model="createOptionsText"
          class="meta-fields__textarea"
          rows="3"
          placeholder="Select 选项（每行一个；可选颜色：Value|#RRGGBB）"
        />
      </div>
      <div v-if="createType === 'link'" class="meta-fields__options meta-fields__link-options">
        <input
          v-model="createLinkForeignSheetId"
          class="meta-fields__input"
          placeholder="foreignDatasheetId（关联目标 sheetId，可空=普通字符串 link）"
        />
        <input
          v-model="createLinkDisplayFieldId"
          class="meta-fields__input"
          list="link-display-fields-create"
          placeholder="displayFieldId（显示字段ID，可选）"
        />
        <datalist id="link-display-fields-create">
          <option
            v-for="field in createLinkForeignFields"
            :key="field.id"
            :value="field.id"
          >
            {{ field.name }} ({{ field.id }})
          </option>
        </datalist>
        <div v-if="createLinkForeignError" class="meta-fields__muted">
          外表字段加载失败：{{ createLinkForeignError }}
        </div>
        <label class="meta-fields__checkbox">
          <input v-model="createLinkLimitSingleRecord" type="checkbox" />
          limitSingleRecord
        </label>
      </div>
      <div v-if="createType === 'lookup'" class="meta-fields__options meta-fields__link-options">
        <select v-model="createLookupLinkFieldId" class="meta-fields__select">
          <option value="">选择 Link 字段</option>
          <option
            v-for="field in linkFieldOptions"
            :key="field.id"
            :value="field.id"
          >
            {{ field.name || field.id }} ({{ field.id }}){{ field.foreignSheetId ? '' : ' · 未配置外表' }}
          </option>
        </select>
        <div class="meta-fields__muted">
          外表 sheetId：{{ createLookupForeignSheetId || '未配置' }}
        </div>
        <input
          v-model="createLookupTargetFieldId"
          class="meta-fields__input"
          list="lookup-target-fields-create"
          placeholder="lookUpTargetFieldId（外表字段ID）"
        />
        <datalist id="lookup-target-fields-create">
          <option
            v-for="field in createLookupForeignFields"
            :key="field.id"
            :value="field.id"
          >
            {{ field.name }} ({{ field.id }})
          </option>
        </datalist>
        <div v-if="createLookupForeignError" class="meta-fields__muted">
          外表字段加载失败：{{ createLookupForeignError }}
        </div>
      </div>
      <div v-if="createType === 'rollup'" class="meta-fields__options meta-fields__link-options">
        <select v-model="createRollupLinkFieldId" class="meta-fields__select">
          <option value="">选择 Link 字段</option>
          <option
            v-for="field in linkFieldOptions"
            :key="field.id"
            :value="field.id"
          >
            {{ field.name || field.id }} ({{ field.id }}){{ field.foreignSheetId ? '' : ' · 未配置外表' }}
          </option>
        </select>
        <div class="meta-fields__muted">
          外表 sheetId：{{ createRollupForeignSheetId || '未配置' }}
        </div>
        <input
          v-model="createRollupTargetFieldId"
          class="meta-fields__input"
          list="rollup-target-fields-create"
          placeholder="targetFieldId（外表字段ID）"
        />
        <datalist id="rollup-target-fields-create">
          <option
            v-for="field in createRollupForeignFields"
            :key="field.id"
            :value="field.id"
          >
            {{ field.name }} ({{ field.id }})
          </option>
        </datalist>
        <div v-if="createRollupForeignError" class="meta-fields__muted">
          外表字段加载失败：{{ createRollupForeignError }}
        </div>
        <select v-model="createRollupAgg" class="meta-fields__select">
          <option value="count">count</option>
          <option value="sum">sum</option>
          <option value="avg">avg</option>
          <option value="min">min</option>
          <option value="max">max</option>
        </select>
        <div class="meta-fields__muted">Rollup 建议选择 number 字段</div>
      </div>
      <div v-if="createError" class="meta-fields__error">{{ createError }}</div>
    </div>

    <div v-if="error" class="meta-fields__error meta-fields__error--block">{{ error }}</div>

    <div v-if="!loading && fields.length === 0" class="meta-fields__empty">
      暂无字段。可使用上方表单创建第一个字段。
    </div>

    <table v-else class="meta-fields__table">
      <thead>
        <tr>
          <th style="width: 80px;">顺序</th>
          <th>名称</th>
          <th>ID</th>
          <th style="width: 120px;">类型</th>
          <th>选项</th>
          <th style="width: 220px;">只读原因</th>
          <th style="width: 240px;">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="field in fields" :key="field.id">
          <td class="meta-fields__mono">{{ field.order ?? 0 }}</td>
          <td>
            <template v-if="editingId === field.id">
              <input v-model="editName" class="meta-fields__input meta-fields__input--inline" />
            </template>
            <template v-else>
              {{ field.name }}
            </template>
          </td>
          <td class="meta-fields__mono">{{ field.id }}</td>
          <td>
            <template v-if="editingId === field.id">
              <select v-model="editType" class="meta-fields__select meta-fields__select--inline">
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="formula">formula</option>
                <option value="select">select</option>
                <option value="link">link</option>
                <option value="lookup">lookup</option>
                <option value="rollup">rollup</option>
              </select>
            </template>
            <template v-else>
              <span class="meta-fields__mono">{{ field.type }}</span>
            </template>
          </td>
          <td>
            <template v-if="editingId === field.id">
              <textarea
                v-if="editType === 'select'"
                v-model="editOptionsText"
                class="meta-fields__textarea meta-fields__textarea--inline"
                rows="3"
                placeholder="Value|#RRGGBB"
              />
              <div v-else-if="editType === 'link'" class="meta-fields__link-editor">
                <input
                  v-model="editLinkForeignSheetId"
                  class="meta-fields__input meta-fields__input--inline"
                  placeholder="foreignDatasheetId"
                />
                <input
                  v-model="editLinkDisplayFieldId"
                  class="meta-fields__input meta-fields__input--inline"
                  list="link-display-fields-edit"
                  placeholder="displayFieldId（显示字段ID）"
                />
                <datalist id="link-display-fields-edit">
                  <option
                    v-for="field in editLinkForeignFields"
                    :key="field.id"
                    :value="field.id"
                  >
                    {{ field.name }} ({{ field.id }})
                  </option>
                </datalist>
                <div v-if="editLinkForeignError" class="meta-fields__muted">
                  外表字段加载失败：{{ editLinkForeignError }}
                </div>
                <label class="meta-fields__checkbox">
                  <input v-model="editLinkLimitSingleRecord" type="checkbox" />
                  limitSingleRecord
                </label>
              </div>
              <div v-else-if="editType === 'lookup'" class="meta-fields__link-editor">
                <select v-model="editLookupLinkFieldId" class="meta-fields__select meta-fields__select--inline">
                  <option value="">选择 Link 字段</option>
                  <option
                    v-for="field in linkFieldOptions"
                    :key="field.id"
                    :value="field.id"
                  >
                    {{ field.name || field.id }} ({{ field.id }}){{ field.foreignSheetId ? '' : ' · 未配置外表' }}
                  </option>
                </select>
                <div class="meta-fields__muted">
                  外表 sheetId：{{ editLookupForeignSheetId || '未配置' }}
                </div>
                <input
                  v-model="editLookupTargetFieldId"
                  class="meta-fields__input meta-fields__input--inline"
                  list="lookup-target-fields-edit"
                  placeholder="lookUpTargetFieldId"
                />
                <datalist id="lookup-target-fields-edit">
                  <option
                    v-for="field in editLookupForeignFields"
                    :key="field.id"
                    :value="field.id"
                  >
                    {{ field.name }} ({{ field.id }})
                  </option>
                </datalist>
                <div v-if="editLookupForeignError" class="meta-fields__muted">
                  外表字段加载失败：{{ editLookupForeignError }}
                </div>
              </div>
              <div v-else-if="editType === 'rollup'" class="meta-fields__link-editor">
                <select v-model="editRollupLinkFieldId" class="meta-fields__select meta-fields__select--inline">
                  <option value="">选择 Link 字段</option>
                  <option
                    v-for="field in linkFieldOptions"
                    :key="field.id"
                    :value="field.id"
                  >
                    {{ field.name || field.id }} ({{ field.id }}){{ field.foreignSheetId ? '' : ' · 未配置外表' }}
                  </option>
                </select>
                <div class="meta-fields__muted">
                  外表 sheetId：{{ editRollupForeignSheetId || '未配置' }}
                </div>
                <input
                  v-model="editRollupTargetFieldId"
                  class="meta-fields__input meta-fields__input--inline"
                  list="rollup-target-fields-edit"
                  placeholder="targetFieldId"
                />
                <datalist id="rollup-target-fields-edit">
                  <option
                    v-for="field in editRollupForeignFields"
                    :key="field.id"
                    :value="field.id"
                  >
                    {{ field.name }} ({{ field.id }})
                  </option>
                </datalist>
                <div v-if="editRollupForeignError" class="meta-fields__muted">
                  外表字段加载失败：{{ editRollupForeignError }}
                </div>
                <select v-model="editRollupAgg" class="meta-fields__select meta-fields__select--inline">
                  <option value="count">count</option>
                  <option value="sum">sum</option>
                  <option value="avg">avg</option>
                  <option value="min">min</option>
                  <option value="max">max</option>
                </select>
                <div class="meta-fields__muted">Rollup 建议选择 number 字段</div>
              </div>
              <span v-else class="meta-fields__muted">-</span>
              <label class="meta-fields__checkbox meta-fields__checkbox--inline">
                <input v-model="editReadonly" type="checkbox" :disabled="editReadonlyForced" />
                只读
                <span v-if="editReadonlyForced" class="meta-fields__muted">（lookup/rollup 自动只读）</span>
              </label>
            </template>
            <template v-else>
              <span class="meta-fields__mono">{{ formatOptions(field) }}</span>
            </template>
          </td>
          <td>
            <div v-if="readonlyInfoById[field.id]" class="meta-fields__readonly" :title="readonlyInfoById[field.id].detail">
              <span class="meta-fields__readonly-tag">{{ readonlyInfoById[field.id].tag }}</span>
              <span class="meta-fields__readonly-reason">{{ readonlyInfoById[field.id].reason }}</span>
            </div>
            <span v-else class="meta-fields__muted">可编辑</span>
          </td>
          <td class="meta-fields__actions">
            <template v-if="editingId === field.id">
              <button type="button" class="meta-fields__btn meta-fields__btn--primary" :disabled="editSaving" @click="saveEdit">
                {{ editSaving ? '保存中…' : '保存' }}
              </button>
              <button type="button" class="meta-fields__btn" :disabled="editSaving" @click="cancelEdit">取消</button>
            </template>
            <template v-else>
              <button type="button" class="meta-fields__btn" @click="beginEdit(field)">编辑</button>
            </template>

            <button
              type="button"
              class="meta-fields__btn"
              :disabled="loading || editingId !== null || !canMoveUp(field)"
              @click="move(field, -1)"
            >
              ↑
            </button>
            <button
              type="button"
              class="meta-fields__btn"
              :disabled="loading || editingId !== null || !canMoveDown(field)"
              @click="move(field, 1)"
            >
              ↓
            </button>

            <button
              type="button"
              class="meta-fields__btn meta-fields__btn--danger"
              :disabled="deleteLoadingId === field.id || editSaving"
              @click="deleteField(field.id)"
            >
              {{ deleteLoadingId === field.id ? '删除中…' : '删除' }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { apiFetch } from '../utils/api'

type ApiError = { code: string; message: string }

type Field = {
  id: string
  name: string
  type: string
  order?: number
  options?: Array<{ value: string; color?: string }>
  property?: Record<string, unknown>
}

type ReadonlyInfo = {
  tag: string
  reason: string
  detail: string
}

type FieldsResponse = {
  ok: boolean
  data?: { fields: Field[] }
  error?: ApiError
}

type CreateFieldResponse = {
  ok: boolean
  data?: { field: Field }
  error?: ApiError
}

type UpdateFieldResponse = {
  ok: boolean
  data?: { field: Field }
  error?: ApiError
}

type DeleteFieldResponse = {
  ok: boolean
  data?: { deleted: string }
  error?: ApiError
}

const route = useRoute()
const sheetId = computed(() => String(route.params.sheetId ?? '').trim())

const fields = ref<Field[]>([])
const loading = ref(false)
const error = ref('')

const createName = ref('新字段')
const createType = ref<'string' | 'number' | 'boolean' | 'formula' | 'select' | 'link' | 'lookup' | 'rollup'>('string')
const createOptionsText = ref('')
const createLinkForeignSheetId = ref('')
const createLinkDisplayFieldId = ref('')
const createLinkLimitSingleRecord = ref(false)
const createLookupLinkFieldId = ref('')
const createLookupTargetFieldId = ref('')
const createRollupLinkFieldId = ref('')
const createRollupTargetFieldId = ref('')
const createRollupAgg = ref<'count' | 'sum' | 'avg' | 'min' | 'max'>('count')
const createReadonly = ref(false)
const createLoading = ref(false)
const createError = ref('')
const createReadonlyForced = computed(() => createType.value === 'lookup' || createType.value === 'rollup')

const editingId = ref<string | null>(null)
const editName = ref('')
const editType = ref<'string' | 'number' | 'boolean' | 'formula' | 'select' | 'link' | 'lookup' | 'rollup'>('string')
const editOptionsText = ref('')
const editProperty = ref<Record<string, unknown>>({})
const editLinkForeignSheetId = ref('')
const editLinkDisplayFieldId = ref('')
const editLinkLimitSingleRecord = ref(false)
const editLookupLinkFieldId = ref('')
const editLookupTargetFieldId = ref('')
const editRollupLinkFieldId = ref('')
const editRollupTargetFieldId = ref('')
const editRollupAgg = ref<'count' | 'sum' | 'avg' | 'min' | 'max'>('count')
const editReadonly = ref(false)
const editSaving = ref(false)
const deleteLoadingId = ref<string | null>(null)
const editReadonlyForced = computed(() => editType.value === 'lookup' || editType.value === 'rollup')

const foreignFieldsBySheetId = ref<Record<string, Field[]>>({})
const foreignFieldsLoadingBySheetId = ref<Record<string, boolean>>({})
const foreignFieldsErrorBySheetId = ref<Record<string, string>>({})

async function parseJsonSafe<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T
  } catch {
    return null
  }
}

function parseSelectOptions(text: string): Array<{ value: string; color?: string }> {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const options: Array<{ value: string; color?: string }> = []
  for (const line of lines) {
    const [valueRaw, colorRaw] = line.split('|')
    const value = (valueRaw ?? '').trim()
    const color = (colorRaw ?? '').trim()
    if (!value) continue
    if (color) options.push({ value, color })
    else options.push({ value })
  }
  return options
}

function resolveForeignSheetId(property?: Record<string, unknown>): string {
  if (!property) return ''
  const foreign = property.foreignDatasheetId ?? property.foreignSheetId ?? property.datasheetId
  return typeof foreign === 'string' ? foreign.trim() : ''
}

function resolveForeignSheetIdByFieldId(fieldId: string): string {
  if (!fieldId) return ''
  const field = fields.value.find((f) => f.id === fieldId)
  if (!field || field.type !== 'link') return ''
  return resolveForeignSheetId(field.property)
}

const linkFieldOptions = computed(() =>
  fields.value
    .filter((field) => field.type === 'link')
    .map((field) => ({
      id: field.id,
      name: field.name,
      foreignSheetId: resolveForeignSheetId(field.property),
    })),
)

const createLookupForeignSheetId = computed(() => resolveForeignSheetIdByFieldId(createLookupLinkFieldId.value))
const createRollupForeignSheetId = computed(() => resolveForeignSheetIdByFieldId(createRollupLinkFieldId.value))
const editLookupForeignSheetId = computed(() => resolveForeignSheetIdByFieldId(editLookupLinkFieldId.value))
const editRollupForeignSheetId = computed(() => resolveForeignSheetIdByFieldId(editRollupLinkFieldId.value))
const createLinkForeignSheet = computed(() => createLinkForeignSheetId.value.trim())
const editLinkForeignSheet = computed(() => editLinkForeignSheetId.value.trim())

function getForeignFields(sheetId: string): Field[] {
  if (!sheetId) return []
  return foreignFieldsBySheetId.value[sheetId] ?? []
}

function getForeignFieldsError(sheetId: string): string {
  if (!sheetId) return ''
  return foreignFieldsErrorBySheetId.value[sheetId] ?? ''
}

const createLookupForeignFields = computed(() => getForeignFields(createLookupForeignSheetId.value))
const createRollupForeignFields = computed(() => getForeignFields(createRollupForeignSheetId.value))
const editLookupForeignFields = computed(() => getForeignFields(editLookupForeignSheetId.value))
const editRollupForeignFields = computed(() => getForeignFields(editRollupForeignSheetId.value))
const createLinkForeignFields = computed(() => getForeignFields(createLinkForeignSheet.value))
const editLinkForeignFields = computed(() => getForeignFields(editLinkForeignSheet.value))

const createLookupForeignError = computed(() => getForeignFieldsError(createLookupForeignSheetId.value))
const createRollupForeignError = computed(() => getForeignFieldsError(createRollupForeignSheetId.value))
const editLookupForeignError = computed(() => getForeignFieldsError(editLookupForeignSheetId.value))
const editRollupForeignError = computed(() => getForeignFieldsError(editRollupForeignSheetId.value))
const createLinkForeignError = computed(() => getForeignFieldsError(createLinkForeignSheet.value))
const editLinkForeignError = computed(() => getForeignFieldsError(editLinkForeignSheet.value))

watch(createLinkForeignSheet, (sheet) => {
  if (sheet) ensureForeignFields(sheet)
})

watch(editLinkForeignSheet, (sheet) => {
  if (sheet) ensureForeignFields(sheet)
})

async function ensureForeignFields(sheetId: string) {
  if (!sheetId) return
  if (foreignFieldsBySheetId.value[sheetId]) return
  if (foreignFieldsLoadingBySheetId.value[sheetId]) return

  foreignFieldsLoadingBySheetId.value = { ...foreignFieldsLoadingBySheetId.value, [sheetId]: true }
  foreignFieldsErrorBySheetId.value = { ...foreignFieldsErrorBySheetId.value, [sheetId]: '' }

  try {
    const res = await apiFetch(`/api/univer-meta/fields?sheetId=${encodeURIComponent(sheetId)}`)
    const json = await parseJsonSafe<FieldsResponse>(res)
    if (!res.ok || !json?.ok || !json.data) {
      throw new Error(json?.error?.message ?? `加载外表字段失败 (${res.status})`)
    }
    foreignFieldsBySheetId.value = { ...foreignFieldsBySheetId.value, [sheetId]: json.data.fields }
  } catch (err) {
    foreignFieldsErrorBySheetId.value = {
      ...foreignFieldsErrorBySheetId.value,
      [sheetId]: err instanceof Error ? err.message : String(err),
    }
  } finally {
    foreignFieldsLoadingBySheetId.value = { ...foreignFieldsLoadingBySheetId.value, [sheetId]: false }
  }
}

function validateLookupConfig(linkFieldId: string, targetFieldId: string): string | null {
  if (!linkFieldId.trim()) return 'Lookup 需要选择本表 Link 字段'
  const foreignId = resolveForeignSheetIdByFieldId(linkFieldId.trim())
  if (!foreignId) return '所选 Link 字段缺少 foreignSheetId'
  if (!targetFieldId.trim()) return 'Lookup 需要填写外表字段 ID'
  return null
}

function validateRollupConfig(linkFieldId: string, targetFieldId: string): string | null {
  if (!linkFieldId.trim()) return 'Rollup 需要选择本表 Link 字段'
  const foreignId = resolveForeignSheetIdByFieldId(linkFieldId.trim())
  if (!foreignId) return '所选 Link 字段缺少 foreignSheetId'
  if (!targetFieldId.trim()) return 'Rollup 需要填写外表字段 ID'
  return null
}

watch(createLookupForeignSheetId, (sheet) => {
  if (sheet) ensureForeignFields(sheet)
})

watch(createRollupForeignSheetId, (sheet) => {
  if (sheet) ensureForeignFields(sheet)
})

watch(editLookupForeignSheetId, (sheet) => {
  if (sheet) ensureForeignFields(sheet)
})

watch(editRollupForeignSheetId, (sheet) => {
  if (sheet) ensureForeignFields(sheet)
})

function formatOptions(field: Field): string {
  if (field.type === 'select') {
    const opts = Array.isArray(field.options) ? field.options : []
    if (opts.length === 0) return '(empty)'
    return opts.map((o) => (o.color ? `${o.value}|${o.color}` : o.value)).join(', ')
  }

  if (field.type === 'link') {
    const prop = field.property ?? {}
    const foreign = prop.foreignDatasheetId ?? prop.foreignSheetId ?? prop.datasheetId
    const foreignText = typeof foreign === 'string' && foreign.trim().length > 0 ? foreign.trim() : ''
    const single = prop.limitSingleRecord === true
    const displayFld = typeof prop.displayFieldId === 'string' ? prop.displayFieldId : ''
    const parts: string[] = []
    if (foreignText) parts.push(foreignText)
    if (displayFld) parts.push(`display: ${displayFld}`)
    if (single) parts.push('single')
    if (parts.length === 0) return '-'
    return parts.join(', ')
  }

  if (field.type === 'lookup') {
    const prop = field.property ?? {}
    const linkField = prop.relatedLinkFieldId ?? prop.linkFieldId ?? prop.linkedFieldId
    const targetField = prop.lookUpTargetFieldId ?? prop.lookupTargetFieldId ?? prop.targetFieldId
    const parts: string[] = []
    if (typeof linkField === 'string' && linkField.trim().length > 0) parts.push(`link: ${linkField.trim()}`)
    if (typeof targetField === 'string' && targetField.trim().length > 0) parts.push(`target: ${targetField.trim()}`)
    return parts.length > 0 ? parts.join(', ') : '-'
  }

  if (field.type === 'rollup') {
    const prop = field.property ?? {}
    const linkField = prop.linkedFieldId ?? prop.linkFieldId ?? prop.relatedLinkFieldId
    const targetField = prop.targetFieldId ?? prop.lookUpTargetFieldId ?? prop.lookupTargetFieldId
    const aggregation = prop.aggregation ?? prop.agg ?? prop.function
    const parts: string[] = []
    if (typeof linkField === 'string' && linkField.trim().length > 0) parts.push(`link: ${linkField.trim()}`)
    if (typeof targetField === 'string' && targetField.trim().length > 0) parts.push(`target: ${targetField.trim()}`)
    if (typeof aggregation === 'string' && aggregation.trim().length > 0) parts.push(`agg: ${aggregation.trim()}`)
    return parts.length > 0 ? parts.join(', ') : '-'
  }

  return '-'
}

const READONLY_HINTS = {
  property: '只读字段',
  lookup: 'Lookup 计算结果',
  rollup: 'Rollup 计算结果',
}

function resolveReadonlyTag(field: Field): string {
  if (field.type === 'lookup') return 'Lookup'
  if (field.type === 'rollup') return 'Rollup'
  if (field.property?.readonly === true) return '只读'
  return '只读'
}

function formatReadonlyDetail(field: Field, reason: string): string {
  const label = field.name?.trim() || '该字段'
  return `字段【${label}】为${reason}，无法编辑`
}

function resolveReadonlyInfo(field: Field): ReadonlyInfo | null {
  if (field.type === 'lookup') {
    return {
      tag: resolveReadonlyTag(field),
      reason: READONLY_HINTS.lookup,
      detail: formatReadonlyDetail(field, READONLY_HINTS.lookup),
    }
  }
  if (field.type === 'rollup') {
    return {
      tag: resolveReadonlyTag(field),
      reason: READONLY_HINTS.rollup,
      detail: formatReadonlyDetail(field, READONLY_HINTS.rollup),
    }
  }
  if (field.property?.readonly === true) {
    return {
      tag: resolveReadonlyTag(field),
      reason: READONLY_HINTS.property,
      detail: formatReadonlyDetail(field, READONLY_HINTS.property),
    }
  }
  return null
}

const readonlyInfoById = computed<Record<string, ReadonlyInfo>>(() => {
  const mapping: Record<string, ReadonlyInfo> = {}
  for (const field of fields.value) {
    const info = resolveReadonlyInfo(field)
    if (info) mapping[field.id] = info
  }
  return mapping
})

function canMoveUp(field: Field): boolean {
  const idx = fields.value.findIndex((f) => f.id === field.id)
  return idx > 0
}

function canMoveDown(field: Field): boolean {
  const idx = fields.value.findIndex((f) => f.id === field.id)
  return idx >= 0 && idx < fields.value.length - 1
}

async function refresh() {
  if (!sheetId.value) {
    fields.value = []
    error.value = '缺少 sheetId'
    return
  }

  loading.value = true
  error.value = ''
  try {
    const res = await apiFetch(`/api/univer-meta/fields?sheetId=${encodeURIComponent(sheetId.value)}`)
    const json = await parseJsonSafe<FieldsResponse>(res)
    if (!res.ok || !json?.ok || !json.data) {
      fields.value = []
      error.value = json?.error?.message ?? `加载失败 (${res.status})`
      return
    }
    fields.value = json.data.fields
  } catch (err) {
    fields.value = []
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function createField() {
  if (!sheetId.value) return
  if (!createName.value.trim()) return
  if (createLoading.value) return

  createLoading.value = true
  createError.value = ''

  try {
    if (createType.value === 'lookup') {
      const err = validateLookupConfig(createLookupLinkFieldId.value, createLookupTargetFieldId.value)
      if (err) {
        createError.value = err
        return
      }
    }
    if (createType.value === 'rollup') {
      const err = validateRollupConfig(createRollupLinkFieldId.value, createRollupTargetFieldId.value)
      if (err) {
        createError.value = err
        return
      }
    }
    const property: Record<string, unknown> = {}
    if (createType.value === 'select') {
      property.options = parseSelectOptions(createOptionsText.value)
    }
    if (createType.value === 'link') {
      const foreignId = createLinkForeignSheetId.value.trim()
      if (foreignId) property.foreignDatasheetId = foreignId
      const displayFieldId = createLinkDisplayFieldId.value.trim()
      if (displayFieldId) property.displayFieldId = displayFieldId
      if (createLinkLimitSingleRecord.value) property.limitSingleRecord = true
    }
    if (createType.value === 'lookup') {
      const linkFieldId = createLookupLinkFieldId.value.trim()
      const targetFieldId = createLookupTargetFieldId.value.trim()
      if (linkFieldId) property.relatedLinkFieldId = linkFieldId
      if (targetFieldId) property.lookUpTargetFieldId = targetFieldId
    }
    if (createType.value === 'rollup') {
      const linkFieldId = createRollupLinkFieldId.value.trim()
      const targetFieldId = createRollupTargetFieldId.value.trim()
      if (linkFieldId) property.linkedFieldId = linkFieldId
      if (targetFieldId) property.targetFieldId = targetFieldId
      property.aggregation = createRollupAgg.value
    }
    if (createReadonly.value && !createReadonlyForced.value) {
      property.readonly = true
    }
    const res = await apiFetch('/api/univer-meta/fields', {
      method: 'POST',
      body: JSON.stringify({
        sheetId: sheetId.value,
        name: createName.value.trim(),
        type: createType.value,
        property,
      }),
    })
    const json = await parseJsonSafe<CreateFieldResponse>(res)
    if (!res.ok || !json?.ok || !json.data?.field) {
      createError.value = json?.error?.message ?? `创建失败 (${res.status})`
      return
    }
    createName.value = '新字段'
    createOptionsText.value = ''
    createLinkForeignSheetId.value = ''
    createLinkDisplayFieldId.value = ''
    createLinkLimitSingleRecord.value = false
    createLookupLinkFieldId.value = ''
    createLookupTargetFieldId.value = ''
    createRollupLinkFieldId.value = ''
    createRollupTargetFieldId.value = ''
    createRollupAgg.value = 'count'
    createReadonly.value = false
    await refresh()
  } catch (err) {
    createError.value = err instanceof Error ? err.message : String(err)
  } finally {
    createLoading.value = false
  }
}

function beginEdit(field: Field) {
  editingId.value = field.id
  editName.value = field.name
  editType.value = (field.type as any) ?? 'string'
  editProperty.value = field.property ?? {}
  editOptionsText.value = Array.isArray(field.options)
    ? field.options.map((o) => (o.color ? `${o.value}|${o.color}` : o.value)).join('\n')
    : ''

  const foreign =
    editProperty.value.foreignDatasheetId ?? editProperty.value.foreignSheetId ?? editProperty.value.datasheetId
  editLinkForeignSheetId.value = typeof foreign === 'string' ? foreign : ''
  const displayFld = editProperty.value.displayFieldId
  editLinkDisplayFieldId.value = typeof displayFld === 'string' ? displayFld : ''
  editLinkLimitSingleRecord.value = editProperty.value.limitSingleRecord === true
  editReadonly.value = editProperty.value.readonly === true

  if (field.type === 'lookup') {
    const linkField = editProperty.value.relatedLinkFieldId ?? editProperty.value.linkFieldId ?? editProperty.value.linkedFieldId
    const targetField = editProperty.value.lookUpTargetFieldId ?? editProperty.value.lookupTargetFieldId ?? editProperty.value.targetFieldId
    editLookupLinkFieldId.value = typeof linkField === 'string' ? linkField : ''
    editLookupTargetFieldId.value = typeof targetField === 'string' ? targetField : ''
  } else {
    editLookupLinkFieldId.value = ''
    editLookupTargetFieldId.value = ''
  }

  if (field.type === 'rollup') {
    const linkField = editProperty.value.linkedFieldId ?? editProperty.value.linkFieldId ?? editProperty.value.relatedLinkFieldId
    const targetField = editProperty.value.targetFieldId ?? editProperty.value.lookUpTargetFieldId ?? editProperty.value.lookupTargetFieldId
    const aggregation = editProperty.value.aggregation ?? editProperty.value.agg ?? editProperty.value.function
    editRollupLinkFieldId.value = typeof linkField === 'string' ? linkField : ''
    editRollupTargetFieldId.value = typeof targetField === 'string' ? targetField : ''
    editRollupAgg.value = typeof aggregation === 'string' ? (aggregation as any) : 'count'
  } else {
    editRollupLinkFieldId.value = ''
    editRollupTargetFieldId.value = ''
    editRollupAgg.value = 'count'
  }
}

function cancelEdit() {
  editingId.value = null
  editName.value = ''
  editOptionsText.value = ''
  editProperty.value = {}
  editLinkForeignSheetId.value = ''
  editLinkDisplayFieldId.value = ''
  editLinkLimitSingleRecord.value = false
  editLookupLinkFieldId.value = ''
  editLookupTargetFieldId.value = ''
  editRollupLinkFieldId.value = ''
  editRollupTargetFieldId.value = ''
  editRollupAgg.value = 'count'
  editReadonly.value = false
}

async function saveEdit() {
  if (!editingId.value) return
  if (!editName.value.trim()) return
  if (editSaving.value) return

  editSaving.value = true
  try {
    if (editType.value === 'lookup') {
      const err = validateLookupConfig(editLookupLinkFieldId.value, editLookupTargetFieldId.value)
      if (err) {
        window.alert(err)
        return
      }
    }
    if (editType.value === 'rollup') {
      const err = validateRollupConfig(editRollupLinkFieldId.value, editRollupTargetFieldId.value)
      if (err) {
        window.alert(err)
        return
      }
    }
    const base: Record<string, unknown> = { ...(editProperty.value ?? {}) }
    if (editType.value === 'select') {
      base.options = parseSelectOptions(editOptionsText.value)
    }
    if (editType.value === 'link') {
      const foreignId = editLinkForeignSheetId.value.trim()
      if (foreignId) {
        base.foreignDatasheetId = foreignId
        delete (base as any).foreignSheetId
        delete (base as any).datasheetId
        base.limitSingleRecord = editLinkLimitSingleRecord.value
        const displayFieldId = editLinkDisplayFieldId.value.trim()
        if (displayFieldId) {
          base.displayFieldId = displayFieldId
        } else {
          delete (base as any).displayFieldId
        }
      } else {
        delete (base as any).foreignDatasheetId
        delete (base as any).foreignSheetId
        delete (base as any).datasheetId
        delete (base as any).limitSingleRecord
        delete (base as any).displayFieldId
      }
    }
    if (editType.value === 'lookup') {
      const linkFieldId = editLookupLinkFieldId.value.trim()
      const targetFieldId = editLookupTargetFieldId.value.trim()
      if (linkFieldId) base.relatedLinkFieldId = linkFieldId
      else delete (base as any).relatedLinkFieldId
      if (targetFieldId) base.lookUpTargetFieldId = targetFieldId
      else delete (base as any).lookUpTargetFieldId
    } else {
      delete (base as any).relatedLinkFieldId
      delete (base as any).lookUpTargetFieldId
      delete (base as any).lookupTargetFieldId
      delete (base as any).targetFieldId
    }
    if (editType.value === 'rollup') {
      const linkFieldId = editRollupLinkFieldId.value.trim()
      const targetFieldId = editRollupTargetFieldId.value.trim()
      if (linkFieldId) base.linkedFieldId = linkFieldId
      else delete (base as any).linkedFieldId
      if (targetFieldId) base.targetFieldId = targetFieldId
      else delete (base as any).targetFieldId
      base.aggregation = editRollupAgg.value
    } else {
      delete (base as any).linkedFieldId
      delete (base as any).aggregation
      delete (base as any).agg
      delete (base as any).function
    }
    if (editReadonlyForced.value) {
      delete (base as any).readonly
    } else if (editReadonly.value) {
      base.readonly = true
    } else {
      delete (base as any).readonly
    }
    const property = base
    const res = await apiFetch(`/api/univer-meta/fields/${encodeURIComponent(editingId.value)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: editName.value.trim(), type: editType.value, property }),
    })
    const json = await parseJsonSafe<UpdateFieldResponse>(res)
    if (!res.ok || !json?.ok || !json.data?.field) {
      window.alert(json?.error?.message ?? `保存失败 (${res.status})`)
      return
    }
    cancelEdit()
    await refresh()
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err))
  } finally {
    editSaving.value = false
  }
}

async function move(field: Field, dir: -1 | 1) {
  if (!field.id) return
  const idx = fields.value.findIndex((f) => f.id === field.id)
  if (idx < 0) return

  const currentOrder = field.order ?? idx
  const nextOrder = Math.max(currentOrder + dir, 0)

  try {
    const res = await apiFetch(`/api/univer-meta/fields/${encodeURIComponent(field.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ order: nextOrder }),
    })
    const json = await parseJsonSafe<UpdateFieldResponse>(res)
    if (!res.ok || !json?.ok) {
      window.alert(json?.error?.message ?? `移动失败 (${res.status})`)
      return
    }
    await refresh()
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err))
  }
}

async function deleteField(fieldId: string) {
  if (!fieldId) return
  if (deleteLoadingId.value) return

  const ok = window.confirm(`确定删除字段？\n\n${fieldId}`)
  if (!ok) return

  deleteLoadingId.value = fieldId
  try {
    const res = await apiFetch(`/api/univer-meta/fields/${encodeURIComponent(fieldId)}`, { method: 'DELETE' })
    const json = await parseJsonSafe<DeleteFieldResponse>(res)
    if (!res.ok || !json?.ok) {
      window.alert(json?.error?.message ?? `删除失败 (${res.status})`)
      return
    }
    await refresh()
  } catch (err) {
    window.alert(err instanceof Error ? err.message : String(err))
  } finally {
    deleteLoadingId.value = null
  }
}

onMounted(() => {
  refresh().catch(() => null)
})
</script>

<style scoped>
.meta-fields {
  padding: 18px 20px;
  max-width: 1200px;
  margin: 0 auto;
}

.meta-fields__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.meta-fields__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #111827;
}

.meta-fields__subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: #6b7280;
}

.meta-fields__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
}

.meta-fields__muted {
  color: #9ca3af;
}

.meta-fields__readonly {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
}

.meta-fields__readonly-tag {
  padding: 2px 8px;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  font-weight: 600;
}

.meta-fields__readonly-reason {
  color: #6b7280;
}

.meta-fields__checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #374151;
  margin-top: 8px;
}

.meta-fields__checkbox--inline {
  margin-top: 8px;
}

.meta-fields__link-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-fields__header-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.meta-fields__create {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 14px;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.meta-fields__options {
  width: 100%;
}

.meta-fields__link-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.meta-fields__input {
  height: 34px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0 10px;
  min-width: 220px;
}

.meta-fields__input--inline {
  min-width: 180px;
}

.meta-fields__select {
  height: 34px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0 8px;
  background: #fff;
}

.meta-fields__select--inline {
  width: 120px;
}

.meta-fields__textarea {
  width: 100%;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  resize: vertical;
}

.meta-fields__textarea--inline {
  max-width: 460px;
}

.meta-fields__btn {
  height: 34px;
  border-radius: 8px;
  border: 1px solid #d1d5db;
  background: #fff;
  padding: 0 12px;
  cursor: pointer;
  font-size: 13px;
  color: #111827;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.meta-fields__btn:hover {
  background: #f3f4f6;
}

.meta-fields__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.meta-fields__btn--primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}

.meta-fields__btn--primary:hover {
  background: #1d4ed8;
}

.meta-fields__btn--danger {
  border-color: #ef4444;
  color: #ef4444;
}

.meta-fields__btn--danger:hover {
  background: #fef2f2;
}

.meta-fields__error {
  color: #b91c1c;
  font-size: 13px;
}

.meta-fields__error--block {
  margin-bottom: 12px;
}

.meta-fields__empty {
  padding: 14px;
  border: 1px dashed #d1d5db;
  border-radius: 10px;
  color: #6b7280;
  background: #fff;
}

.meta-fields__table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  overflow: hidden;
}

.meta-fields__table th,
.meta-fields__table td {
  padding: 10px 12px;
  border-bottom: 1px solid #e5e7eb;
  text-align: left;
  vertical-align: top;
}

.meta-fields__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
