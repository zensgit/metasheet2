<template>
  <button
    type="button"
    class="mt-menu-item"
    role="menuitem"
    :disabled="disabled"
    @click="handleClick"
  >
    <span v-if="$slots.icon" class="mt-menu-item__icon"><slot name="icon" /></span>
    <span class="mt-menu-item__label"><slot /></span>
  </button>
</template>

<script setup lang="ts">
// MtMenuItem — P2-1b shared UI primitive, a single row inside <MtMenu>. Presentation-only: emits
// `select` and (when hosted inside an <MtMenu>) asks the menu to close itself; it never runs
// business logic of its own. Consumes ONLY UF-1 `--ms-*` tokens (design-lock §8 / §3.1).
//
// A NATIVE <button> (not a div) so the declared role="menuitem" is honestly keyboard-operable:
// the browser gives focusability, Enter/Space → click activation, and real `disabled` semantics
// (removed from the tab order, activation suppressed) for free — no hand-rolled keydown handling,
// no double-fire risk. This matters because P2-1c migrates existing menus onto this primitive; a
// keyboard-inoperable "menu" would otherwise propagate.
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
  // The native `disabled` attribute already suppresses activation (mouse and keyboard); this guard
  // is belt-and-suspenders for programmatic dispatch.
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
  width: 100%;
  min-height: var(--ms-control-height);
  padding: 0 var(--ms-space-3);
  /* reset native <button> chrome so the row matches the menu surface */
  border: none;
  background: transparent;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--ms-text-2);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}

.mt-menu-item:hover:not(:disabled),
.mt-menu-item:focus-visible {
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
}

/* keyboard focus ring (focus-visible only, so mouse clicks don't show it) */
.mt-menu-item:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: -2px;
}

.mt-menu-item:disabled {
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
