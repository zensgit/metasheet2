<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { useInjectedToolbarPins, type ToolbarPinsApi } from '../composables/useToolbarPins'
import { isToolbarPinCommandId } from '../utils/toolbar-pins'
import { metaCoreLabel } from '../utils/meta-core-labels'

const props = defineProps<{
  commandId: string
  api?: ToolbarPinsApi | null
}>()

const { isZh } = useLocale()
const injected = useInjectedToolbarPins()
const pins = computed(() => props.api ?? injected)

const pinned = computed(() => pins.value?.isPinned(props.commandId) ?? false)
const allowed = computed(() => isToolbarPinCommandId(props.commandId))
const disabled = computed(() => !pins.value || !allowed.value || (!pinned.value && !pins.value.canPin(props.commandId)))
const title = computed(() => {
  if (pinned.value) return metaCoreLabel('toolbar.unpinFromBar', isZh.value)
  if (disabled.value) return metaCoreLabel('toolbar.pinCapReached', isZh.value)
  return metaCoreLabel('toolbar.pinToBar', isZh.value)
})

function onToggle(event: MouseEvent): void {
  event.preventDefault()
  event.stopPropagation()
  pins.value?.toggle(props.commandId)
}
</script>

<template>
  <button
    v-if="pins && allowed"
    type="button"
    class="meta-toolbar__pin"
    :class="{ 'is-pinned': pinned }"
    :title="title"
    :aria-label="title"
    :aria-pressed="pinned"
    :disabled="disabled"
    :data-testid="`toolbar-pin-${commandId}`"
    :data-command-pin="commandId"
    @click="onToggle"
  >
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
      <path d="M9.7 1.6 8.4 2.9l3.7 3.7 1.3-1.3a1.1 1.1 0 0 0 0-1.6L11.3 1.6a1.1 1.1 0 0 0-1.6 0Z" />
      <path d="M7.8 3.8 3.2 6.4a.7.7 0 0 0-.2 1l2.2 2.2-3.6 3.6.8.8 3.6-3.6 2.2 2.2a.7.7 0 0 0 1-.2l2.6-4.6-5-5Z" />
    </svg>
  </button>
</template>

<style scoped>
.meta-toolbar__pin {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--ms-radius-sm, 6px);
  background: transparent;
  color: var(--ms-sheet-icon-color, #6b7280);
  cursor: pointer;
}
.meta-toolbar__pin:hover:not(:disabled) { color: var(--ms-color-primary); background: var(--ms-bg-page, #f5f6f8); }
.meta-toolbar__pin.is-pinned { color: var(--ms-color-primary); }
.meta-toolbar__pin:disabled { opacity: 0.35; cursor: not-allowed; }
</style>
