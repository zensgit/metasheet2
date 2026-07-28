<template>
  <aside
    class="approval-form-palette"
    aria-labelledby="approval-form-palette-heading"
    data-testid="approval-form-palette"
  >
    <div class="approval-form-palette__heading">
      <strong id="approval-form-palette-heading">表单组件</strong>
    </div>
    <div
      class="approval-form-palette__items"
      role="group"
      aria-label="可添加的表单组件"
    >
      <button
        v-for="item in paletteItems"
        :key="item.type"
        type="button"
        class="approval-form-palette__item"
        :disabled="readOnly"
        :draggable="!readOnly"
        :data-testid="`approval-form-palette-${item.type}`"
        @click="emit('add', item.type)"
        @dragstart="onDragStart($event, item.type)"
      >
        <el-icon aria-hidden="true">
          <component :is="item.icon" />
        </el-icon>
        <span>{{ item.label }}</span>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import {
  Calendar,
  Checked,
  Clock,
  Connection,
  Document,
  EditPen,
  Grid,
  List,
  Tickets,
  User,
} from "@element-plus/icons-vue";
import type { Component } from "vue";
import type { AuthorableFieldType } from "../templateAuthoring";
import {
  APPROVAL_FORM_FIELD_TYPE_LABELS,
  APPROVAL_FORM_PALETTE_MIME,
  APPROVAL_FORM_PALETTE_TYPES,
} from "../formPalette";

defineProps<{
  readOnly: boolean;
}>();

const emit = defineEmits<{
  add: [type: AuthorableFieldType];
}>();

const icons: Record<AuthorableFieldType, Component> = {
  text: EditPen,
  textarea: Document,
  number: Tickets,
  date: Calendar,
  datetime: Clock,
  select: Checked,
  "multi-select": List,
  user: User,
  detail: Grid,
  "record-link": Connection,
};

const paletteItems = APPROVAL_FORM_PALETTE_TYPES.map((type) => ({
  type,
  label: APPROVAL_FORM_FIELD_TYPE_LABELS[type],
  icon: icons[type],
}));

function onDragStart(event: DragEvent, type: AuthorableFieldType) {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(APPROVAL_FORM_PALETTE_MIME, type);
}
</script>

<style scoped>
.approval-form-palette {
  position: sticky;
  top: 116px;
  display: grid;
  grid-row: 1 / span 999;
  gap: 12px;
  align-self: start;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}

.approval-form-palette__items {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.approval-form-palette__item {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  min-height: 42px;
  padding: 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font: inherit;
  text-align: left;
  cursor: grab;
}

.approval-form-palette__item:hover:not(:disabled),
.approval-form-palette__item:focus-visible {
  border-color: var(--el-color-primary);
  outline: none;
  box-shadow: 0 0 0 2px var(--el-color-primary-light-8);
}

.approval-form-palette__item:active:not(:disabled) {
  cursor: grabbing;
}

.approval-form-palette__item:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.approval-form-palette__item span {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
}

@media (max-width: 1024px) {
  .approval-form-palette {
    position: static;
    grid-row: auto;
  }

  .approval-form-palette__items {
    grid-template-columns: repeat(5, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .approval-form-palette__items {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .approval-form-palette__item {
    min-height: 44px;
  }
}
</style>
