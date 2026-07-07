<template>
  <MtButton
    class="mt-icon-button"
    :class="`mt-icon-button--${size}`"
    :variant="variant"
    :size="size"
    :disabled="disabled"
    :loading="loading"
    :title="title"
    :aria-label="ariaLabel || title"
    @click="emit('click', $event)"
  >
    <template #icon>
      <el-icon v-if="icon"><component :is="icon" /></el-icon>
      <slot v-else name="icon"><slot /></slot>
    </template>
  </MtButton>
</template>

<script setup lang="ts">
// MtIconButton — P2-1a shared UI primitive (multitable-ui-p2-structure-designlock-20260706.md §2 P2-1).
// A square icon-only button; wraps MtButton so variants/sizes/tokens stay in one place. Accepts the
// icon either as a component reference (`icon` prop, wrapped in <el-icon> internally per the UI-P1
// icon idiom) or as slotted markup (named `icon` slot, falling back to the default slot) for callers
// that already hold their own <el-icon><component :is="..."/></el-icon> markup.
import type { Component } from 'vue'
import { ElIcon } from 'element-plus'
import MtButton, { type MtButtonVariant, type MtButtonSize } from './MtButton.vue'

withDefaults(defineProps<{
  icon?: Component
  variant?: MtButtonVariant
  size?: MtButtonSize
  disabled?: boolean
  loading?: boolean
  title?: string
  ariaLabel?: string
}>(), {
  variant: 'ghost',
  size: 'md',
  disabled: false,
  loading: false,
})

const emit = defineEmits<{
  (e: 'click', evt: MouseEvent): void
}>()
</script>

<style scoped>
/* Overrides MtButton's own `.mt-button--{size}` horizontal padding so the icon sits centered in a
   square box; `!important` is deliberate here (both rules share single-class specificity and the
   cascade order between a component and its child's <style> block is otherwise load-order
   dependent — this pins the intent instead of relying on it). */
.mt-icon-button {
  padding: 0 !important;
}

.mt-icon-button--md {
  width: var(--ms-control-height);
}

.mt-icon-button--sm {
  width: calc(var(--ms-control-height) - 8px);
}
</style>
