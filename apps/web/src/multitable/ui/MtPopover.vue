<template>
  <span ref="triggerRef" class="mt-popover__trigger" @click="handleTriggerClick">
    <slot name="trigger" :open="open" />
  </span>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panelRef"
      class="mt-popover"
      :style="panelStyle"
      @click.stop
    >
      <slot />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// MtPopover — P2-1b shared UI primitive (multitable-ui-p2-structure-designlock-20260706.md §2 P2-1).
// A token-styled floating panel anchored to a trigger slot, Teleport-safe (renders its content to
// `body` so it is never clipped by an ancestor's `overflow: hidden`, matching the existing
// `ContextMenu.vue` idiom — see its `Teleport to="body"` + click-outside/Escape handling, which
// this mirrors). Presentation-only: no business logic, no data fetching. Consumes ONLY UF-1
// `--ms-*` tokens (design-lock §8 / §3.1) — never introduce a new hardcoded hex here.
//
// Controlled via `open` + `update:open` (usable as `v-model:open`). Clicking the trigger toggles
// `open`; clicking outside the trigger+panel or pressing Escape while open closes it. MtMenu builds
// on top of this for its trigger+dropdown-list composition.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

export type MtPopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

const props = withDefaults(defineProps<{
  open?: boolean
  placement?: MtPopoverPlacement
}>(), {
  open: false,
  placement: 'bottom-start',
})

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
}>()

const triggerRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const panelStyle = ref<Record<string, string>>({ top: '0px', left: '0px' })

function handleTriggerClick(evt: MouseEvent) {
  evt.stopPropagation()
  emit('update:open', !props.open)
}

function close() {
  if (props.open) emit('update:open', false)
}

function computePosition() {
  const trigger = triggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const panelRect = panelRef.value?.getBoundingClientRect()
  const panelWidth = panelRect?.width ?? 0
  const panelHeight = panelRect?.height ?? 0

  let top = props.placement.startsWith('top') ? rect.top - panelHeight - 4 : rect.bottom + 4
  let left = props.placement.endsWith('end') ? rect.right - panelWidth : rect.left

  // Clamp to the viewport the same way ContextMenu.vue does, so the panel never renders
  // partially off-screen near an edge.
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  if (left + panelWidth > viewportWidth) left = Math.max(0, viewportWidth - panelWidth - 8)
  if (left < 0) left = 8
  if (top + panelHeight > viewportHeight) top = Math.max(0, viewportHeight - panelHeight - 8)

  panelStyle.value = { top: `${top}px`, left: `${left}px` }
}

function handleClickOutside(evt: MouseEvent) {
  const target = evt.target as Node
  if (triggerRef.value?.contains(target)) return
  if (panelRef.value?.contains(target)) return
  close()
}

function handleEscape(evt: KeyboardEvent) {
  if (evt.key === 'Escape') close()
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      // Attach the outside-click/Escape listeners synchronously — they don't need the panel to
      // be in the DOM yet, and a test (or a very fast real interaction) dispatching an event right
      // after `open` flips true must not race an `await nextTick()` here. Only the position
      // calculation, which reads the panel's rendered layout, needs to wait a tick.
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleEscape)
      nextTick(() => computePosition())
    } else {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside)
  document.removeEventListener('keydown', handleEscape)
})

// P3-6 (2026-09-05, record inspector v3 finding, additive-only kit change): `triggerRef` exposed
// ALONGSIDE the pre-existing `close` — a consumer (MtMenu.vue) needs to reliably identify the DOM
// node that actually opened this popover, rather than guessing via `document.activeElement` at open
// time (a Chromium-mouse-click assumption that is wrong whenever the trigger was activated some
// other way — a caller opening it programmatically, a non-mouse focus path, or simply focus already
// having moved elsewhere before the open). Reading an exposed ref through a template ref
// auto-unwraps (see MtMenu.vue's own comment on this same expose-proxy semantics for `close`), so a
// consumer's `popoverRef.value?.triggerRef` reads the CURRENT trigger span with no extra plumbing.
defineExpose({ close, triggerRef })
</script>

<style scoped>
.mt-popover__trigger {
  display: inline-flex;
}

.mt-popover {
  position: fixed;
  z-index: 2000;
  min-width: 160px;
  box-sizing: border-box;
  background: var(--ms-bg-card);
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-md);
  box-shadow: var(--ms-shadow-pop);
  padding: var(--ms-space-1) 0;
}
</style>
