<template>
  <div
    class="mt-menu-item"
    :class="{ 'is-disabled': disabled }"
    role="menuitem"
    :aria-disabled="disabled || undefined"
    @click="handleClick"
  >
    <span v-if="$slots.icon" class="mt-menu-item__icon"><slot name="icon" /></span>
    <span class="mt-menu-item__label"><slot /></span>
  </div>
</template>

<script setup lang="ts">
// MtMenuItem — P2-1b shared UI primitive, a single row inside <MtMenu>. Presentation-only: emits
// `select` and (when hosted inside an <MtMenu>) asks the menu to close itself; it never runs
// business logic of its own. Consumes ONLY UF-1 `--ms-*` tokens (design-lock §8 / §3.1).
import { inject } from 'vue'
import { MT_MENU_CLOSE_KEY } from './menuContext'

const props = withDefaults(defineProps<{
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  (e: 'select', evt: MouseEvent): void
}>()

// Optional — MtMenuItem also renders sensibly standalone (e.g. inside a hand-rolled popover)
// where there is no ancestor <MtMenu> providing a close callback.
const closeMenu = inject(MT_MENU_CLOSE_KEY, null)

function handleClick(evt: MouseEvent) {
  if (props.disabled) return
  emit('select', evt)
  closeMenu?.()
}
</script>

<style scoped>
.mt-menu-item {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  min-height: var(--ms-control-height);
  padding: 0 var(--ms-space-3);
  font-size: 13px;
  color: var(--ms-text-2);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}

.mt-menu-item:hover:not(.is-disabled) {
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
}

.mt-menu-item.is-disabled {
  color: var(--ms-text-3);
  cursor: not-allowed;
}

.mt-menu-item__icon {
  display: inline-flex;
  align-items: center;
  font-size: 14px;
}

.mt-menu-item__label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
