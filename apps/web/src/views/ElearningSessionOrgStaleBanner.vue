<!--
  Shown by a cloud-classroom page after an accepted session-org switch (see
  useElearningSessionOrg). Same shape as AttendanceView's `attendanceSessionStale` banner: the
  page content is inert behind it and nothing is discarded until the user asks for the reload.
-->
<template>
  <section
    class="elearning-session-org-stale"
    data-testid="elearning-session-org-stale"
    role="alert"
  >
    <p>{{ elearningLabel('sessionOrg.staleNotice', isZh) }}</p>
    <button
      type="button"
      data-testid="elearning-session-org-reload"
      @click="emit('reload')"
    >
      {{ elearningLabel('sessionOrg.discardAndReload', isZh) }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { elearningLabel } from './elearningLabels'

defineProps<{ isZh: boolean }>()
const emit = defineEmits<{ reload: [] }>()
</script>

<style scoped>
.elearning-session-org-stale {
  display: grid;
  gap: 8px;
  margin: 0 auto 12px;
  padding: 12px 16px;
  border: 1px solid #f4c7a1;
  border-radius: 10px;
  background: #fff7ed;
  color: #7c2d12;
}

.elearning-session-org-stale button {
  justify-self: start;
  border: 1px solid #c2410c;
  border-radius: 8px;
  padding: 6px 12px;
  background: #fff;
  color: #c2410c;
  font: inherit;
  cursor: pointer;
}
</style>
