<script setup lang="ts">
import { computed, ref } from 'vue'

type Translate = (en: string, zh: string) => string

const props = withDefaults(defineProps<{
  modelValue?: string
  options?: string[]
  placeholder?: string
  tr: Translate
  inputAttrs?: Record<string, string>
  search?: (query: string) => Promise<string[]>
}>(), {
  modelValue: '',
  options: () => [],
  placeholder: '',
  inputAttrs: () => ({}),
  search: undefined,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const draft = ref('')
const menuOpen = ref(false)
const searchHits = ref<string[]>([])
let searchTimer = 0
let searchSeq = 0

function parseList(value?: string): string[] {
  if (!value) return []
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

const selected = computed(() => parseList(props.modelValue))

const suggestions = computed(() => {
  const chosen = new Set(selected.value.map((item) => item.toLowerCase()))
  const needle = draft.value.trim().toLowerCase()
  const seen = new Set<string>()
  return [...props.options, ...searchHits.value].filter((item) => {
    const text = item.trim()
    const key = text.toLowerCase()
    if (!text || chosen.has(key) || seen.has(key)) return false
    if (needle && !key.includes(needle)) return false
    seen.add(key)
    return true
  }).slice(0, 8)
})

function write(next: string[]): void {
  emit('update:modelValue', next.join(','))
}

function addValue(raw: string): void {
  const parts = parseList(raw)
  if (!parts.length) return
  const next = [...selected.value]
  const seen = new Set(next.map((item) => item.toLowerCase()))
  for (const part of parts) {
    const key = part.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    next.push(part)
  }
  write(next)
  draft.value = ''
  searchHits.value = []
  menuOpen.value = false
}

function removeValue(value: string): void {
  write(selected.value.filter((item) => item !== value))
}

function onDraftInput(): void {
  menuOpen.value = true
  if (!props.search) return
  const query = draft.value.trim()
  window.clearTimeout(searchTimer)
  if (query.length < 1) {
    searchHits.value = []
    return
  }
  const seq = ++searchSeq
  searchTimer = window.setTimeout(() => {
    void props.search?.(query).then((hits) => {
      if (seq !== searchSeq) return
      searchHits.value = Array.isArray(hits) ? hits : []
    }).catch(() => {
      if (seq === searchSeq) searchHits.value = []
    })
  }, 250)
}

function onFocus(): void {
  menuOpen.value = true
}

function onBlur(): void {
  window.setTimeout(() => {
    menuOpen.value = false
  }, 160)
}
</script>

<template>
  <div class="audience-chip-field" data-audience-chip-field>
    <input type="hidden" :value="modelValue || ''" v-bind="inputAttrs" />
    <div v-if="selected.length" class="audience-chip-field__chips">
      <span v-for="value in selected" :key="value" class="audience-chip-field__chip">
        {{ value }}
        <button type="button" :aria-label="tr('Remove', '移除') + ' ' + value" @click="removeValue(value)">×</button>
      </span>
    </div>
    <div class="audience-chip-field__adder">
      <input
        v-model="draft"
        type="text"
        :placeholder="placeholder || tr('Type and press Enter', '输入后回车')"
        :aria-label="placeholder || tr('Add value', '添加')"
        @focus="onFocus"
        @blur="onBlur"
        @input="onDraftInput"
        @keydown.enter.prevent="addValue(draft)"
      />
      <ul v-if="menuOpen && suggestions.length" class="audience-chip-field__menu">
        <li v-for="option in suggestions" :key="option">
          <button type="button" @mousedown.prevent="addValue(option)">{{ option }}</button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.audience-chip-field {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  width: fit-content;
  max-width: 16rem;
}

.audience-chip-field__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-width: 16rem;
}

.audience-chip-field__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 8px;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: 999px;
  background: var(--ms-bg-card, #fff);
  color: var(--ms-text-1, #1f2329);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
}

.audience-chip-field__chip button {
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--ms-text-3, #667085);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}

.audience-chip-field__adder {
  position: relative;
  width: fit-content;
  max-width: 100%;
}

.audience-chip-field__adder input {
  width: 11rem;
  max-width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: var(--ms-radius-md, 8px);
  background: var(--ms-bg-card, #fff);
  color: var(--ms-text-1, #1f2329);
  font-size: 13px;
}

.audience-chip-field__menu {
  position: absolute;
  z-index: 8;
  top: calc(100% + 4px);
  left: 0;
  width: max-content;
  min-width: 11rem;
  max-width: 16rem;
  max-height: 168px;
  margin: 0;
  padding: 4px;
  overflow: auto;
  list-style: none;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: var(--ms-radius-md, 8px);
  background: var(--ms-bg-card, #fff);
  box-shadow: var(--ms-shadow-card, 0 8px 20px rgba(16, 24, 40, 0.08));
}

.audience-chip-field__menu button {
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ms-text-1, #1f2329);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.audience-chip-field__menu button:hover {
  background: var(--el-color-primary-light-9, #eff6ff);
}
</style>
