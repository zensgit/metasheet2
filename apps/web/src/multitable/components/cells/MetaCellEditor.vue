<template>
  <div class="meta-cell-editor">
    <!-- string: date-like -->
    <input
      v-if="field.type === 'string' && isDateLike"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="date"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />
    <!-- string: normal -->
    <input
      v-else-if="field.type === 'string'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="text"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- number -->
    <input
      v-else-if="field.type === 'number'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="number"
      :value="modelValue ?? ''"
      @input="onNumberInput"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- boolean -->
    <label v-else-if="field.type === 'boolean'" class="meta-cell-editor__check">
      <input
        type="checkbox"
        :checked="!!modelValue"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked); emit('confirm')"
      />
      <span>{{ modelValue ? 'Yes' : 'No' }}</span>
    </label>

    <!-- select -->
    <select
      v-else-if="field.type === 'select'"
      ref="inputRef"
      class="meta-cell-editor__select"
      :value="modelValue ?? ''"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value); emit('confirm')"
      @keydown.escape="emit('cancel')"
    >
      <option value="">—</option>
      <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">
        {{ opt.value }}
      </option>
    </select>

    <!-- link -->
    <button
      v-else-if="field.type === 'link'"
      class="meta-cell-editor__link-btn"
      @click="emit('open-link-picker')"
    >Choose linked records...</button>

    <!-- readonly fallback -->
    <span v-else class="meta-cell-editor__readonly">{{ modelValue ?? '' }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { MetaField } from '../../types'

const props = defineProps<{ field: MetaField; modelValue: unknown }>()

const DATE_RE = /^\d{4}-\d{2}-\d{2}/
const DATE_FIELD_NAMES = /date|time|deadline|due|start|end|created|updated|birthday/i
const isDateLike = computed(() => {
  if (props.field.type !== 'string') return false
  if (DATE_FIELD_NAMES.test(props.field.name)) return true
  if (typeof props.modelValue === 'string' && DATE_RE.test(props.modelValue)) return true
  return false
})

const emit = defineEmits<{
  (e: 'update:modelValue', val: unknown): void
  (e: 'confirm'): void
  (e: 'cancel'): void
  (e: 'open-link-picker'): void
}>()

const inputRef = ref<HTMLElement | null>(null)

function onNumberInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  emit('update:modelValue', v === '' ? null : Number(v))
}

onMounted(() => {
  if (inputRef.value && 'focus' in inputRef.value) {
    ;(inputRef.value as HTMLInputElement).focus()
  }
})
</script>

<style scoped>
.meta-cell-editor { display: flex; align-items: center; }
.meta-cell-editor__input {
  width: 100%; padding: 2px 6px; border: 1px solid #409eff; border-radius: 3px;
  font-size: 13px; outline: none;
}
.meta-cell-editor__select {
  width: 100%; padding: 2px 4px; border: 1px solid #409eff; border-radius: 3px;
  font-size: 13px; outline: none;
}
.meta-cell-editor__check { display: flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; }
.meta-cell-editor__link-btn {
  padding: 2px 8px; border: 1px solid #409eff; border-radius: 3px;
  background: #ecf5ff; color: #409eff; cursor: pointer; font-size: 12px;
}
.meta-cell-editor__readonly { color: #999; font-size: 13px; }
</style>
