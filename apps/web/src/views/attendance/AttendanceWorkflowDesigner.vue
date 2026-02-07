<template>
  <section v-if="!canDesign" class="attendance-workflow">
    <article class="attendance-workflow__card">
      <h3>Approval Workflow Designer</h3>
      <p class="attendance-workflow__empty">
        Workflow capability is not enabled for this tenant.
      </p>
    </article>
  </section>

  <WorkflowDesigner v-else />
</template>

<script setup lang="ts">
import WorkflowDesigner from '../WorkflowDesigner.vue'

withDefaults(
  defineProps<{
    canDesign?: boolean
  }>(),
  {
    canDesign: false,
  },
)
</script>

<style scoped>
.attendance-workflow {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.attendance-workflow__card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 20px;
}

.attendance-workflow__card h3 {
  margin: 0 0 10px;
  font-size: 20px;
}

.attendance-workflow__desc,
.attendance-workflow__hint,
.attendance-workflow__empty {
  margin: 0;
  color: #4b5563;
}

.attendance-workflow__list {
  margin: 16px 0;
  padding-left: 20px;
  color: #111827;
  display: grid;
  gap: 6px;
}
</style>
