<template>
  <div
    class="context-help"
    data-attendance-context-help
    :data-context-help-context="contextId"
    role="note"
    :aria-label="tr('Help for this task', '本任务帮助')"
  >
    <!--
      W5-2 (Wave 5 explainability design-lock, RATIFIED §6/§9 W5-2): pure DISPLAY component — this
      template only renders the pre-derived closed-set entries from `attendanceContextHelp.ts`
      (charter L267-268 discipline carried over from W5-1: no branch logic embedded here beyond
      iterating an already-derived array). R1/owner freeze ⑦: the ONLY interactive element in this
      tree is the read-only evidence-link `<a>` — there is no button, no form input, no write call
      anywhere in this component.
    -->
    <div
      v-for="entry in entries"
      :key="entry.category"
      class="context-help__entry"
      data-context-help-entry
      :data-context-help-category="entry.category"
    >
      <h5 class="context-help__title">{{ entry.title }}</h5>
      <ul class="context-help__body">
        <li v-for="(line, index) in entry.body" :key="index">{{ line }}</li>
      </ul>
      <p v-if="entry.link" class="context-help__link-row">
        <a
          class="context-help__link"
          :href="entry.link.href"
          data-context-help-evidence-link
          @click.prevent="emit('evidence-link-click', entry.link)"
        >
          {{ entry.link.label }}
        </a>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  getAttendanceContextHelpEntries,
  type AttendanceContextHelpContextId,
  type AttendanceContextHelpEvidenceLink,
  type TranslateFn,
} from './attendanceContextHelp'

const props = defineProps<{
  tr: TranslateFn
  contextId: AttendanceContextHelpContextId
}>()

const emit = defineEmits<{
  (event: 'evidence-link-click', link: AttendanceContextHelpEvidenceLink): void
}>()

const tr = computed(() => props.tr)
const entries = computed(() => getAttendanceContextHelpEntries(props.contextId, props.tr))
</script>

<style scoped>
.context-help {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  padding: var(--ms-space-3);
  border: 1px dashed var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-page);
  margin: var(--ms-space-2) 0;
}

.context-help__entry {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
}

.context-help__title {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: var(--ms-font-weight-title);
  text-transform: none;
}

.context-help__body {
  margin: 0;
  padding: 0 0 0 var(--ms-space-4);
  color: var(--ms-text-1);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
}

.context-help__link-row {
  margin: 0;
}

.context-help__link {
  color: var(--ms-color-primary);
  font-size: 13px;
  cursor: pointer;
}
</style>
