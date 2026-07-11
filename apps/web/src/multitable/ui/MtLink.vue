<template>
  <button
    type="button"
    class="mt-link"
    :disabled="disabled"
    @click="onClick"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
// MtLink — P2-1c T3 shared UI primitive (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md
// §2-T3, RATIFIED). A text-link-styled action, distinct in strength from MtButton: MtButton's every
// variant adds padding + a border (button-strength), which is a visible bump for callers that were a
// bare inline text link (mark-all-read, select-all/clear-all, add-filter/add-sort, add-condition/
// add-group) — hence a dedicated primitive rather than folding these into an MtButton variant.
// Semantics are pinned by the design lock and implemented literally, nothing beyond it:
//   - native <button type="button"> (keyboard-operable: focusable, Enter/Space activates, `disabled`
//     is the real DOM attribute — same idiom as MtButton/MtMenuItem, not a styled <a>/<span>)
//   - zero padding, zero border
//   - primary-color text (--ms-color-primary)
//   - underline only on :hover
//   - token-only (--ms-* / --el-*) — never a new hardcoded hex (design-lock §8 / §3.1)
// Presentation-only: no business logic, no data fetching.
const props = withDefaults(defineProps<{
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  (e: 'click', evt: MouseEvent): void
}>()

function onClick(evt: MouseEvent) {
  // The native `disabled` attribute already suppresses activation (mouse and keyboard); this guard
  // is belt-and-suspenders for programmatic dispatch, same idiom as MtButton/MtMenuItem.
  if (props.disabled) return
  emit('click', evt)
}
</script>

<style scoped>
.mt-link {
  display: inline-flex;
  align-items: center;
  /* reset native <button> chrome — this IS the "zero padding / zero border" lock requirement, not an
     invented extra: without it the browser's default button box (padding + bevel border/background)
     would still show through. */
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  color: var(--ms-color-primary);
  cursor: pointer;
  white-space: nowrap;
}

.mt-link:hover:not(:disabled) {
  text-decoration: underline;
}

.mt-link:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.mt-link:disabled {
  cursor: not-allowed;
  opacity: 0.5;
  text-decoration: none;
}
</style>
