<template>
  <section class="title-admin" aria-labelledby="elearning-title-admin-heading">
    <header>
      <h3 id="elearning-title-admin-heading">{{ text('Credit titles', '学分称号') }}</h3>
      <p>{{ text('Publish the complete threshold table used to resolve each learner’s current title.', '发布完整的学分阈值表，用于动态解析员工当前称号。') }}</p>
    </header>

    <div class="title-admin__rows" data-testid="elearning-title-rows">
      <div v-for="(row, index) in rows" :key="row.localId" class="title-admin__row">
        <input v-model="row.id" :aria-label="text('Title key', '称号标识')" data-testid="elearning-title-key" maxlength="512" :disabled="busy">
        <input v-model="row.name" :aria-label="text('Title name', '称号名称')" data-testid="elearning-title-name" maxlength="512" :disabled="busy">
        <input v-model.number="row.threshold" :aria-label="text('Threshold', '学分阈值')" data-testid="elearning-title-threshold" type="number" min="0" :max="PG_INT4_MAX" step="1" :disabled="busy">
        <button data-testid="elearning-title-remove" type="button" :disabled="busy" @click="remove(index)">
          {{ text('Remove', '删除') }}
        </button>
      </div>
    </div>
    <div class="title-admin__actions">
      <button data-testid="elearning-title-add" type="button" :disabled="busy" @click="add">
        {{ text('Add title', '添加称号') }}
      </button>
      <button data-testid="elearning-title-publish" type="button" :disabled="busy" @click="void submit()">
        {{ busy ? text('Publishing...', '正在发布…') : text('Publish titles', '发布称号') }}
      </button>
    </div>
    <p v-if="loading" data-testid="elearning-title-loading">{{ text('Loading titles...', '正在加载称号…') }}</p>
    <p v-if="status" class="title-admin__status" :class="{ 'title-admin__status--error': error }" data-testid="elearning-title-status" role="status">
      {{ status }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  getElearningTitleSnapshot,
  publishElearningTitleSnapshot,
  type ElearningTitleRow,
} from '../services/elearningCredit'

const PG_INT4_MAX = 2_147_483_647
type EditableTitle = ElearningTitleRow & { localId: number }

const { isZh } = useLocale()
const rows = ref<EditableTitle[]>([])
const loading = ref(false)
const busy = ref(false)
const status = ref('')
const error = ref(false)
let nextLocalId = 1
let requestId = ''
let attemptedPayload = ''

function text(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function add(): void {
  rows.value.push({
    localId: nextLocalId++,
    id: '',
    name: '',
    threshold: 0,
  })
}

function remove(index: number): void {
  rows.value.splice(index, 1)
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : ''
}

function commandRows(): ElearningTitleRow[] {
  return rows.value.map(({ id, name, threshold }) => ({
    id: id.trim(),
    name: name.trim(),
    threshold,
  })).sort((left, right) => left.threshold - right.threshold)
}

function errorText(value: unknown): string {
  if (value instanceof ElearningApiError) {
    if (value.status === 409) return text('This request ID was already used for different title values.', '该请求标识已用于不同的称号内容。')
    if (value.status === 400) return text('Enter unique title keys and thresholds using valid integers.', '请输入唯一的称号标识和阈值，并使用有效整数。')
    if (value.status === 403) return text('You do not have permission to manage titles.', '您没有管理称号的权限。')
    if (value.status === 404) return text('Credit titles are disabled.', '学分称号功能未启用。')
  }
  return text('Unable to update titles. Try again.', '无法更新称号，请重试。')
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const snapshot = await getElearningTitleSnapshot()
    rows.value = snapshot.titles.map((row) => ({
      ...row,
      localId: nextLocalId++,
    }))
  } catch (value) {
    error.value = true
    status.value = errorText(value)
  } finally {
    loading.value = false
  }
}

async function submit(): Promise<void> {
  if (busy.value) return
  const titles = commandRows()
  const payload = JSON.stringify(titles)
  if (payload !== attemptedPayload) {
    requestId = newRequestId()
    attemptedPayload = payload
  }
  if (!requestId) {
    error.value = true
    status.value = text('Secure request identifiers are unavailable.', '当前环境无法生成安全请求标识。')
    return
  }
  busy.value = true
  error.value = false
  status.value = ''
  try {
    const snapshot = await publishElearningTitleSnapshot({ requestId, titles })
    requestId = ''
    attemptedPayload = ''
    rows.value = snapshot.titles.map((row) => ({
      ...row,
      localId: nextLocalId++,
    }))
    status.value = text('Titles published.', '称号已发布。')
  } catch (value) {
    error.value = true
    status.value = errorText(value)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void refresh()
})
</script>

<style scoped>
.title-admin {
  display: grid;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid #cbd9e8;
}
.title-admin h3,
.title-admin p { margin: 0; }
.title-admin__rows { display: grid; gap: 8px; }
.title-admin__row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(160px, 2fr) minmax(100px, 1fr) auto;
  gap: 8px;
}
.title-admin__row input,
.title-admin__row button,
.title-admin__actions button { min-height: 36px; }
.title-admin__actions { display: flex; gap: 8px; }
.title-admin__status--error { color: #b42318; }
</style>
