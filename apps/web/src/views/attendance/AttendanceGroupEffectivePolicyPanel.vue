<!--
  W6 (#4556) group effective-policy aggregate panel — UI SHELL (PROPOSED).

  Status: preparation-only. This component is intentionally NOT imported or
  mounted by any runtime file in W6-0; it renders a static placeholder, makes
  zero API calls, and contains zero business logic. Deleting this file must
  leave every existing test green (design lock red line W6-R9).

  Governing document:
    docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
  Mount plan (W6-3, blocked on owner RATIFY): inside the existing four-stage
  group workspace behind the OD-W6-7 default-OFF gate; label mapping and
  editorRef resolution will live in a standalone .ts module (lock §5.5), not
  in this SFC.
-->
<template>
  <section
    class="attendance-group-effective-policy-panel"
    data-attendance-w6-effective-policy-shell
    aria-live="off"
  >
    <h3 class="attendance-group-effective-policy-panel__title">
      组有效策略汇总 / Group effective policy
    </h3>
    <p class="attendance-group-effective-policy-panel__placeholder">
      该功能尚未启用（W6 备料占位，未授权运行时）。
      This aggregate view is not enabled yet (W6 preparation placeholder).
    </p>
  </section>
</template>

<script setup lang="ts">
// Intentionally empty: shell only. Props, fetching, label mapping, and
// navigation wiring are W6-3 scope and require owner RATIFY of the W6 lock.
</script>

<style scoped>
.attendance-group-effective-policy-panel {
  padding: 12px;
  border: 1px dashed var(--ms-border-color, #d0d0d0);
  border-radius: 8px;
}
.attendance-group-effective-policy-panel__title {
  margin: 0 0 4px;
  font-size: 14px;
}
.attendance-group-effective-policy-panel__placeholder {
  margin: 0;
  font-size: 12px;
  opacity: 0.75;
}
</style>
