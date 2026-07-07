# multitable/ui — shared UI primitives (P2-1a + P2-1b)

Design-lock: `docs/development/multitable-ui-p2-structure-designlock-20260706.md` §2 P2-1.

These are stateless, presentation-only primitives meant to replace the per-SFC bespoke-CSS
buttons/badges/menus/panels scattered across `apps/web/src/multitable/components/` and `views/`.
They consume **only** UF-1 design tokens (`apps/web/src/styles/tokens.css`, `--ms-*` / `--el-*`) —
never a new hardcoded hex, never a new token vocabulary.

Both slices are **additive only**: no existing component has been migrated to use these yet.
Migration is a separate, later slice (P2-1c), one SFC's buttons/badges/panels at a time,
presentation-only and click/emit-count-preserving.

## MtButton

```vue
<script setup lang="ts">
import { MtButton } from '@/multitable/ui'
import { ElIcon } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
</script>

<template>
  <!-- default (ghost) -->
  <MtButton @click="onCancel">Cancel</MtButton>

  <!-- primary, with a leading icon (UI-P1 idiom: <el-icon><component :is="..."/></el-icon>) -->
  <MtButton variant="primary" @click="onCreate">
    <template #icon><el-icon><Plus /></el-icon></template>
    New record
  </MtButton>

  <!-- danger, small, loading (shows a spinner + disables the button) -->
  <MtButton variant="danger" size="sm" :loading="isDeleting" @click="onDelete">
    Delete
  </MtButton>
</template>
```

Props:

| Prop | Type | Default | Notes |
|---|---|---|---|
| `variant` | `'primary' \| 'ghost' \| 'danger'` | `'ghost'` | primary = filled `--ms-color-primary`; ghost = transparent, `--ms-text-2`, hover `--ms-bg-page`; danger = filled `--ms-color-danger` |
| `size` | `'sm' \| 'md'` | `'md'` | md height = `--ms-control-height`; sm = that minus 8px |
| `disabled` | `boolean` | `false` | |
| `loading` | `boolean` | `false` | shows a spinner in place of the `icon` slot and forces `disabled` |

Slots: default (label), `icon` (leading, optional — hidden while `loading`).
Emits: `click(evt: MouseEvent)` — not emitted while `disabled`/`loading`.

## MtIconButton

A square icon-only `MtButton`. Accepts the icon either as a component reference (wrapped in
`<el-icon>` internally) or as slotted markup for callers that already hold their own `<el-icon>`.

```vue
<script setup lang="ts">
import { MtIconButton } from '@/multitable/ui'
import { Delete } from '@element-plus/icons-vue'
</script>

<template>
  <!-- icon via prop -->
  <MtIconButton :icon="Delete" variant="danger" title="Delete row" @click="onDelete" />

  <!-- icon via slot -->
  <MtIconButton title="More actions" @click="onMore">
    <template #icon><el-icon><MoreFilled /></el-icon></template>
  </MtIconButton>
</template>
```

Props: same as `MtButton` (`variant`, `size`, `disabled`, `loading`) plus:

| Prop | Type | Notes |
|---|---|---|
| `icon` | `Component` (optional) | rendered as `<el-icon><component :is="icon"/></el-icon>` |
| `title` | `string` (optional) | native tooltip; also the `aria-label` fallback |
| `ariaLabel` | `string` (optional) | overrides `title` for `aria-label` when they should differ |

Slots: `icon` (falls back to the default slot) — use when you need custom icon markup instead of the
`icon` prop.
Emits: `click(evt: MouseEvent)`.

## MtBadge

Small count/status pill — same sizing as the existing comment-badge affordance
(`MetaCommentAffordance.vue`), re-expressed on tokens instead of that component's hardcoded hex.

```vue
<script setup lang="ts">
import { MtBadge } from '@/multitable/ui'
</script>

<template>
  <!-- count pill, hidden when count is 0 -->
  <MtBadge :count="unresolvedCount" tone="danger" />

  <!-- always show, even at 0 -->
  <MtBadge :count="0" show-zero tone="info" />

  <!-- status dot instead of a count -->
  <MtBadge dot tone="success" />
</template>
```

Props:

| Prop | Type | Default | Notes |
|---|---|---|---|
| `count` | `number` | `0` | pill hidden when `0` unless `showZero`; renders `99+` above 99 |
| `showZero` | `boolean` | `false` | |
| `dot` | `boolean` | `false` | renders a small solid dot instead of the count |
| `tone` | `'info' \| 'primary' \| 'success' \| 'warning' \| 'danger'` | `'info'` | maps to `--ms-color-*` / `--el-color-*-light-9` |

## MtPopover

A token-styled floating panel anchored to a trigger slot, Teleport'd to `body` (never clipped by
an ancestor's `overflow: hidden`) — mirrors the existing `ContextMenu.vue` idiom (Teleport +
click-outside + Escape) but anchors to a trigger element instead of raw `x`/`y` coordinates.

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { MtPopover, MtButton } from '@/multitable/ui'

const open = ref(false)
</script>

<template>
  <MtPopover v-model:open="open">
    <template #trigger>
      <MtButton>Open</MtButton>
    </template>
    <div style="padding: 8px 12px;">Popover content</div>
  </MtPopover>
</template>
```

Props:

| Prop | Type | Default | Notes |
|---|---|---|---|
| `open` | `boolean` | `false` | controlled — pair with `v-model:open` |
| `placement` | `'bottom-start' \| 'bottom-end' \| 'top-start' \| 'top-end'` | `'bottom-start'` | anchor corner relative to the trigger |

Slots: `trigger` (scoped with `{ open }`), default (panel content).
Emits: `update:open(value: boolean)` — fired when the trigger is clicked (toggles), a click lands
outside both the trigger and the panel, or Escape is pressed while open.

## MtMenu / MtMenuItem

A trigger + dropdown list of `MtMenuItem` rows, built on `MtPopover` (so it inherits Teleport-safety
+ click-outside + Escape for free instead of re-implementing `ContextMenu.vue`'s mechanics a second
time). Composition is **slot-based**, not a data-driven `items` array — put `MtMenuItem`s (and any
dividers you want) directly in the default slot, same as any other menu-of-rows component.
Selecting an item closes the menu automatically (via an internal provide/inject contract in
`menuContext.ts` — MtMenu never inspects its slotted vnodes to do this).

```vue
<script setup lang="ts">
import { MtMenu, MtMenuItem, MtIconButton } from '@/multitable/ui'
import { Delete, Edit } from '@element-plus/icons-vue'
</script>

<template>
  <MtMenu>
    <template #trigger>
      <MtIconButton title="More actions" :icon="MoreFilled" />
    </template>
    <MtMenuItem @select="onRename">
      <template #icon><el-icon><Edit /></el-icon></template>
      Rename
    </MtMenuItem>
    <MtMenuItem disabled @select="onDelete">
      <template #icon><el-icon><Delete /></el-icon></template>
      Delete
    </MtMenuItem>
  </MtMenu>
</template>
```

`MtMenu` props: `placement` (same type as `MtPopover`, default `'bottom-start'`).
`MtMenu` slots: `trigger`, default (menu items).

`MtMenuItem` props: `disabled?: boolean` (default `false`) — a disabled item never emits `select`
and never closes the menu.
`MtMenuItem` slots: default (label), `icon` (optional, leading).
`MtMenuItem` emits: `select(evt: MouseEvent)`.

## MtPanel

A small token-styled container card for grouping content — border/radius/background, optional
shadow.

```vue
<script setup lang="ts">
import { MtPanel } from '@/multitable/ui'
</script>

<template>
  <MtPanel shadow padding="sm">
    <div>Grouped content</div>
  </MtPanel>
</template>
```

Props:

| Prop | Type | Default | Notes |
|---|---|---|---|
| `padding` | `'none' \| 'sm' \| 'md'` | `'md'` | inner padding, from the `--ms-space-*` scale |
| `shadow` | `boolean` | `false` | adds `--ms-shadow-card` |

Slots: default (content).

## Token discipline

Every color declaration in these components is a `var(--ms-*)` or `var(--el-*)` reference —
no hex/rgb literals, including as `var(..., #fallback)` fallbacks (the UF-6 style guard closes that
exact escape hatch for its target file set; these new files hold to the same discipline even though
they are not yet in that guard's list). Non-color sizing (font-size, gap) that has no dedicated token
follows the existing convention in `MetaToolbar.vue` (e.g. `font-size: 13px`).
