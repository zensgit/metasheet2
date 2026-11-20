<template>
  <div class="meta-manual-parent-picker" data-testid="manual-parent-picker">
    <div v-if="modelValue && !listOpen" class="meta-manual-parent-picker__picked" data-testid="manual-parent-picked">
      <span><span class="meta-manual-parent-picker__code">{{ modelValue.code }}</span> · {{ modelValue.name ?? l('parent.noName') }}</span>
      <MtLink data-action="manual-parent-change" :disabled="disabled" @click="openList">{{ l('parent.change') }}</MtLink>
    </div>
    <div v-else class="meta-manual-parent-picker__dropdown">
      <div class="meta-manual-parent-picker__search">
        <input
          v-model="query"
          class="meta-manual-parent-picker__input"
          type="text"
          maxlength="200"
          data-testid="manual-parent-search"
          :placeholder="l('parent.search')"
          :aria-label="l('parent.search')"
          :disabled="disabled"
          @input="scheduleSearch"
        />
      </div>
      <p v-if="loading" class="meta-manual-parent-picker__note" data-testid="manual-parent-loading">{{ l('parent.searching') }}</p>
      <p v-else-if="loadError" class="meta-manual-parent-picker__note meta-manual-parent-picker__note--error" role="alert" data-testid="manual-parent-load-error">{{ loadError }}</p>
      <template v-else>
        <template v-if="groups.parents.length">
          <div class="meta-manual-parent-picker__group" data-testid="manual-parent-group-parents">{{ l('parent.groupParents') }}</div>
          <button
            v-for="option in groups.parents"
            :key="`p:${option.code}`"
            type="button"
            class="meta-manual-parent-picker__item"
            :class="{ 'meta-manual-parent-picker__item--on': isPicked(option) }"
            data-manual-parent-option="parent"
            :disabled="disabled"
            @click="pick(option)"
          >
            <span><span class="meta-manual-parent-picker__code">{{ option.code }}</span> {{ option.name ?? l('parent.noName') }}</span>
            <small>{{ manualRowParentChildCountText(option.childCount ?? 0, isZh) }}</small>
          </button>
        </template>
        <template v-if="groups.components.length">
          <div class="meta-manual-parent-picker__group" data-testid="manual-parent-group-components">{{ l('parent.groupComponents') }}</div>
          <button
            v-for="option in groups.components"
            :key="`c:${option.code}`"
            type="button"
            class="meta-manual-parent-picker__item"
            :class="{ 'meta-manual-parent-picker__item--on': isPicked(option) }"
            data-manual-parent-option="component"
            :disabled="disabled"
            @click="pick(option)"
          >
            <span><span class="meta-manual-parent-picker__code">{{ option.code }}</span> {{ option.name ?? l('parent.noName') }}</span>
          </button>
        </template>
        <p v-if="loaded && !groups.parents.length && !groups.components.length" class="meta-manual-parent-picker__note" data-testid="manual-parent-empty">{{ l('parent.empty') }}</p>
        <p v-if="groups.truncated" class="meta-manual-parent-picker__note" data-testid="manual-parent-truncated">{{ l('parent.truncated') }}</p>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
// 人工补充行的父组件 (ADR adr-stock-prep-manual-rows-20261030 §12.2 / §12.6, slice P2): the searchable picker shared by
// the 新增 dialog (「选已有的」) and the drawer's 「修改父组件」 (「改成已有的」). It reads the host's candidates through the
// `search` the caller hands in (GET …/manual-rows/parent-options), debounced; it shows 「已有父组件」 first (with their
// child count), then 「本项目物料」, and leaves out the row's own 图号 (`ownCode`). A picked entry is emitted EXACTLY as
// the host returned it — never trimmed or rewritten: the fill view groups by the raw text.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { MtLink } from '../ui'
import type { MetaManualRowParentOption } from '../types'
import { manualRowLabel, manualRowParentChildCountText, type ManualRowLabelKey } from '../utils/manual-row-labels'
import { groupManualRowParentOptions } from '../utils/manual-rows'

type Picked = { code: string; name: string | null }

const props = withDefaults(defineProps<{
  modelValue: Picked | null
  search: (q: string) => Promise<unknown>
  /** The row's own 图号 (typed in the dialog, or stored on the row): never offered. */
  ownCode?: unknown
  disabled?: boolean
  debounceMs?: number
}>(), {
  disabled: false,
  debounceMs: 250,
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: Picked): void
}>()

const { isZh } = useLocale()
const l = (key: ManualRowLabelKey) => manualRowLabel(key, isZh.value)

const listOpen = ref(!props.modelValue)
const query = ref('')
const raw = ref<unknown>(null)
const loading = ref(false)
const loaded = ref(false)
const loadError = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let requestSeq = 0

// The own 图号 is applied here, not in the request: typing it in the dialog after the list arrived still removes it.
const groups = computed(() => groupManualRowParentOptions(raw.value, props.ownCode))

async function runSearch(): Promise<void> {
  const seq = ++requestSeq
  loading.value = true
  loadError.value = null
  try {
    const answer = await props.search(query.value.trim())
    if (seq !== requestSeq) return
    raw.value = answer
    loaded.value = true
  } catch (error) {
    if (seq !== requestSeq) return
    raw.value = null
    loadError.value = (error as Error | null)?.message || l('parent.loadFailed')
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

function scheduleSearch(): void {
  clearTimer()
  timer = setTimeout(() => { timer = null; void runSearch() }, props.debounceMs)
}

function openList(): void {
  listOpen.value = true
  if (!loaded.value && !loading.value) void runSearch()
}

function isPicked(option: MetaManualRowParentOption): boolean {
  return !!props.modelValue && props.modelValue.code === option.code && props.modelValue.name === option.name
}

function pick(option: MetaManualRowParentOption): void {
  emit('update:modelValue', { code: option.code, name: option.name })
  listOpen.value = false
}

onMounted(() => { if (listOpen.value) void runSearch() })
onBeforeUnmount(() => { clearTimer(); requestSeq += 1 })
</script>

<style scoped>
.meta-manual-parent-picker { display: flex; flex-direction: column; gap: 6px; }
.meta-manual-parent-picker__picked { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--ms-color-primary, #409eff); border-radius: 4px; background: #ecf5ff; font-size: 13px; }
.meta-manual-parent-picker__dropdown { border: 1px solid #dcdfe6; border-radius: 4px; max-height: 260px; overflow-y: auto; }
.meta-manual-parent-picker__search { padding: 6px; border-bottom: 1px solid #ebedf0; position: sticky; top: 0; background: #fff; }
.meta-manual-parent-picker__input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #dcdfe6; border-radius: 4px; font-size: 14px; font-family: inherit; }
.meta-manual-parent-picker__group { font-size: 12px; color: #909399; padding: 6px 10px 2px; }
.meta-manual-parent-picker__item { display: flex; width: 100%; justify-content: space-between; gap: 8px; padding: 5px 10px; border: none; background: none; text-align: left; font: inherit; font-size: 13px; cursor: pointer; }
.meta-manual-parent-picker__item:hover, .meta-manual-parent-picker__item--on { background: #ecf5ff; }
.meta-manual-parent-picker__item small { color: #909399; white-space: nowrap; }
.meta-manual-parent-picker__code { font-family: ui-monospace, Consolas, monospace; }
.meta-manual-parent-picker__note { margin: 0; padding: 6px 10px; font-size: 12px; color: #909399; }
.meta-manual-parent-picker__note--error { color: #f56c6c; }
</style>
