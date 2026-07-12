<template>
  <button
    type="button"
    class="mt-button"
    :class="[`mt-button--${variant}`, `mt-button--${size}`, { 'is-loading': loading }]"
    :disabled="isDisabled"
    @click="onClick"
  >
    <span v-if="loading" class="mt-button__icon mt-button__icon--spinner">
      <el-icon class="mt-button__spinner"><Loading /></el-icon>
    </span>
    <span v-else-if="$slots.icon" class="mt-button__icon">
      <slot name="icon" />
    </span>
    <span v-if="$slots.default" class="mt-button__label"><slot /></span>
  </button>
</template>

<script setup lang="ts">
// MtButton — P2-1a shared UI primitive (multitable-ui-p2-structure-designlock-20260706.md §2 P2-1).
// Presentation-only: no business logic, no data fetching. Consumes ONLY UF-1 `--ms-*` / `--el-*`
// tokens (design-lock §8 / §3.1) — never introduce a new hardcoded hex here.
//
// `plain` variant — multitable-ui-p2-1c-tail-lock #3866 §2-T2 (RATIFIED, owner-authored boundary):
// the token-normalized replacement for the soft-tinted (#ecf5ff bg / #2563eb text / #c7ddff border)
// bespoke "create" buttons scattered across Gallery/Kanban/Timeline. Token mapping is owner-pinned,
// not invented: bg = --el-color-primary-light-9, border = --el-color-primary-light-7, text =
// --ms-color-primary (same primary text color as the bespoke original). Hover follows the existing
// variant convention already used by primary/danger below (step to the next pre-defined, named
// token — light-8 — rather than a new hardcoded hex); disabled reuses the shared
// `.mt-button.is-loading, .mt-button:disabled` rule below, same as every other variant.
import { computed } from 'vue'
import { ElIcon } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'

export type MtButtonVariant = 'primary' | 'ghost' | 'danger' | 'plain'
export type MtButtonSize = 'sm' | 'md'

const props = withDefaults(defineProps<{
  variant?: MtButtonVariant
  size?: MtButtonSize
  disabled?: boolean
  loading?: boolean
}>(), {
  variant: 'ghost',
  size: 'md',
  disabled: false,
  loading: false,
})

const emit = defineEmits<{
  (e: 'click', evt: MouseEvent): void
}>()

// Loading implies disabled — a single source of truth for the `disabled` DOM attribute so the
// native button already blocks pointer/keyboard activation without extra guard logic downstream.
const isDisabled = computed(() => props.disabled || props.loading)

function onClick(evt: MouseEvent) {
  if (isDisabled.value) return
  emit('click', evt)
}
</script>

<style scoped>
.mt-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--ms-space-1);
  box-sizing: border-box;
  border-radius: var(--ms-radius-sm);
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s, border-color 0.15s, color 0.15s;
}

.mt-button:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.mt-button.is-loading,
.mt-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* ---- sizes ---- */
.mt-button--md {
  height: var(--ms-control-height);
  padding: 0 var(--ms-space-4);
}

.mt-button--sm {
  height: calc(var(--ms-control-height) - 8px);
  padding: 0 var(--ms-space-3);
  font-size: 12px;
}

/* ---- variants ---- */
.mt-button--ghost {
  background: transparent;
  color: var(--ms-text-2);
  border-color: transparent;
}

.mt-button--ghost:hover:not(:disabled) {
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
}

.mt-button--primary {
  background: var(--ms-color-primary);
  border-color: var(--ms-color-primary);
  color: var(--ms-bg-card);
}

.mt-button--primary:hover:not(:disabled) {
  background: var(--el-color-primary-dark-2);
  border-color: var(--el-color-primary-dark-2);
}

.mt-button--danger {
  background: var(--ms-color-danger);
  border-color: var(--ms-color-danger);
  color: var(--ms-bg-card);
}

.mt-button--danger:hover:not(:disabled) {
  background: var(--el-color-danger-dark-2);
  border-color: var(--el-color-danger-dark-2);
}

.mt-button--plain {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-7);
  color: var(--ms-color-primary);
}

.mt-button--plain:hover:not(:disabled) {
  background: var(--el-color-primary-light-8);
}

/* ---- icon / spinner ---- */
.mt-button__icon {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  line-height: 1;
}

.mt-button__spinner {
  animation: mt-button-spin 0.8s linear infinite;
}

@keyframes mt-button-spin {
  to { transform: rotate(360deg); }
}

.mt-button__label {
  display: inline-flex;
  align-items: center;
}
</style>
