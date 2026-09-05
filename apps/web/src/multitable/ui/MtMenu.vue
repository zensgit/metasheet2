<template>
  <MtPopover ref="popoverRef" v-model:open="isOpen" :placement="placement">
    <template #trigger="slotProps">
      <slot name="trigger" v-bind="slotProps" />
    </template>
    <div ref="menuRef" class="mt-menu" role="menu" @keydown="onMenuKeydown">
      <slot />
    </div>
  </MtPopover>
</template>

<script setup lang="ts">
// MtMenu — P2-1b shared UI primitive (multitable-ui-p2-structure-designlock-20260706.md §2 P2-1).
// A trigger + dropdown list of <MtMenuItem> children, built on <MtPopover> so it inherits its
// Teleport-safety, click-outside, and Escape-to-close for free (rather than re-implementing the
// existing `ContextMenu.vue` idiom a second time). Presentation-only: no business logic, no data
// fetching. Consumes ONLY UF-1 `--ms-*` tokens (design-lock §8 / §3.1).
//
// Composition is slot-based, not a data-driven `items` array: put <MtMenuItem>/dividers as
// children, same as any other menu-of-rows component. Selecting an item (its `select` emit)
// closes the menu automatically via the MT_MENU_CLOSE_KEY provide/inject contract in
// `menuContext.ts` — MtMenu never inspects its slotted vnodes to do this.
//
// Record inspector v3 (2026-09-05, PR-A §1.2/§3 "MtMenu additive-only" acknowledgement, §4 item 10):
// arrow-key roving + Escape-returns-focus-to-trigger, added ADDITIVELY — no new prop, no changed
// emit, every existing consumer (MetaToolbar's density menu, this file's own pre-existing specs)
// gets the new keyboard behavior with zero markup changes on their side. Items are found by
// `[role^="menuitem"]` (matches both `menuitem` and a fallthrough-overridden `menuitemcheckbox`,
// see MtMenuItem.vue's own comment on attrs passthrough) rather than a class, so a non-MtMenuItem
// row (e.g. the kebab menu's RouterLink inbox entry) participates in roving as long as it carries
// the right role — no dependency on every row being an actual MtMenuItem instance.
import { nextTick, provide, ref, watch } from 'vue'
import MtPopover, { type MtPopoverPlacement } from './MtPopover.vue'
import { MT_MENU_CLOSE_KEY } from './menuContext'

withDefaults(defineProps<{
  placement?: MtPopoverPlacement
}>(), {
  placement: 'bottom-start',
})

const isOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)
const popoverRef = ref<InstanceType<typeof MtPopover> | null>(null)

provide(MT_MENU_CLOSE_KEY, () => {
  isOpen.value = false
})

// P3-6 (2026-09-05, record inspector v3 finding): a focusable descendant inside MtPopover's own
// `triggerRef` span (exposed there specifically for this, see that file's own comment) — a native
// `<button>`/`<a href>`/etc. rendered by the CONSUMER's `#trigger` slot, e.g. this file's own kebab
// `<MtIconButton>` consumer. Falls back to the span itself (still focusable if it — unusually — has
// its own `tabindex`) so a call site whose trigger slot content matches none of these still gets
// SOME element back rather than `null`.
const TRIGGER_FOCUSABLE_SELECTOR = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
function resolveTriggerElement(): HTMLElement | null {
  const root = popoverRef.value?.triggerRef ?? null
  return root?.querySelector<HTMLElement>(TRIGGER_FOCUSABLE_SELECTOR) ?? root
}

// Captured at the moment the menu opens — the ACTUAL trigger element (identified structurally via
// `resolveTriggerElement` above), NOT `document.activeElement` at that instant. The pre-fix version
// read `document.activeElement`, which is only equal to the trigger when the open was a real mouse
// click that already moved focus there FIRST (true in every real click, and in a test harness that
// explicitly calls `.focus()` before `.click()` — see multitable-record-inspector-header.spec.ts's
// own comment on why it does exactly that) — any other open path (a programmatic `isOpen.value =
// true`, or focus already resting elsewhere when the trigger is activated) captured the WRONG
// element, so an Escape-driven close silently failed to return focus to the actual trigger. Used
// ONLY to restore focus on an Escape-driven close (see `onMenuKeydown` below); a selection-driven
// close (MtMenuItem's own `closeMenu()` call) leaves focus wherever the browser puts it after the
// click, unchanged from pre-roving behavior.
let capturedTrigger: HTMLElement | null = null

function menuItems(): HTMLElement[] {
  if (!menuRef.value) return []
  return Array.from(menuRef.value.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)'))
}

watch(isOpen, (open) => {
  if (!open) return
  capturedTrigger = resolveTriggerElement()
  void nextTick(() => {
    menuItems()[0]?.focus()
  })
})

function onMenuKeydown(event: KeyboardEvent) {
  const items = menuItems()
  if (items.length === 0) return
  const active = document.activeElement as HTMLElement | null
  const currentIndex = active ? items.indexOf(active) : -1
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      items[(currentIndex + 1 + items.length) % items.length]?.focus()
      break
    case 'ArrowUp':
      event.preventDefault()
      items[(currentIndex - 1 + items.length) % items.length]?.focus()
      break
    case 'Home':
      event.preventDefault()
      items[0]?.focus()
      break
    case 'End':
      event.preventDefault()
      items[items.length - 1]?.focus()
      break
    case 'Escape': {
      event.preventDefault()
      isOpen.value = false
      const trigger = capturedTrigger
      void nextTick(() => {
        if (trigger?.isConnected) trigger.focus()
      })
      break
    }
    default:
      break
  }
}

// `close()` (alongside the pre-existing `isOpen` exposure) is for a host that owns a SINGLE
// root-level keydown dispatcher elsewhere (record inspector v3, 2026-09-05, PR-A §1.5) and needs to
// close this menu from outside without racing Vue's expose-proxy semantics for a bare ref (reading
// an exposed ref through a template ref auto-unwraps; writing one does not reliably reach the
// SAME ref this component's own template reads, since the expose proxy assigns onto the exposed
// object rather than through the ref's own setter) — a plain method avoids that trap entirely.
function close() {
  isOpen.value = false
}

defineExpose({ isOpen, close })
</script>

<style scoped>
.mt-menu {
  display: flex;
  flex-direction: column;
  min-width: 160px;
}
</style>
