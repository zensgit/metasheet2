// Barrel for the P2-1a/P2-1b shared UI primitives (multitable-ui-p2-structure-designlock-20260706.md
// §2 P2-1). Additive only — nothing here changes any existing component's behavior; migration of
// existing SFCs onto these primitives is a separate, later slice (P2-1c).
export { default as MtButton } from './MtButton.vue'
export type { MtButtonVariant, MtButtonSize } from './MtButton.vue'
export { default as MtIconButton } from './MtIconButton.vue'
export { default as MtBadge } from './MtBadge.vue'
export type { MtBadgeTone } from './MtBadge.vue'

// P2-1b — overlay primitives (Teleport-safe: MtPopover / MtMenu render into `body`).
export { default as MtPopover } from './MtPopover.vue'
export type { MtPopoverPlacement } from './MtPopover.vue'
export { default as MtMenu } from './MtMenu.vue'
export { default as MtMenuItem } from './MtMenuItem.vue'
export { default as MtPanel } from './MtPanel.vue'
export type { MtPanelPadding } from './MtPanel.vue'
