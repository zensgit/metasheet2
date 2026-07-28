<!--
  Attendance vNext charter §6.2 (Wave 3 / issue #4353): first extraction of the
  admin center's task-first home screen — reclaimed business intent from the
  stacked draft PR #4414 (docs/development/
  attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md §7
  "Wave 3：管理中心 task home").

  This component owns LAYOUT and DISPLAY of the four task groups and re-emits
  a real parent action (`select-section`) for button-style entries — it does
  not fetch anything, hold route/admin state, or decide which sections a role
  may see. `groups` arrives pre-filtered by the parent (charter §6.2 "暂留父层:
  section 权限过滤、active id、数据加载"); this component renders exactly the
  groups it is given. Href-style entries (deep links into other attendance
  surfaces, e.g. the overview requests/anomalies queues) render as plain
  anchors and are not part of the admin section selection path.
-->
<template>
  <div
    class="attendance__admin-task-home"
    data-admin-task-home="true"
    role="region"
    aria-labelledby="attendance-admin-task-home-title"
  >
    <div class="attendance__admin-task-home-header">
      <div>
        <span class="attendance__admin-task-home-eyebrow">
          {{ tr('Attendance management', '考勤管理') }}
        </span>
        <h4 id="attendance-admin-task-home-title" tabindex="-1">
          {{ tr('Operations and configuration', '运营与配置') }}
        </h4>
      </div>
      <span class="attendance__admin-task-home-hint">
        {{ tr('Daily work, people, policies, reporting, and payroll', '日常工作、人员、策略、报表与计薪') }}
      </span>
    </div>
    <div class="attendance__admin-task-grid">
      <section
        v-for="group in groups"
        :key="group.key"
        class="attendance__admin-task-group"
        :data-admin-task-group="group.key"
      >
        <div class="attendance__admin-task-copy">
          <strong>{{ group.title }}</strong>
          <span>{{ group.detail }}</span>
        </div>
        <div class="attendance__admin-task-actions">
          <a
            v-for="action in group.linkActions"
            :key="action.key"
            class="attendance__btn attendance__btn--inline attendance__admin-task-action"
            :class="{ 'attendance__btn--primary': action.primary }"
            :data-admin-task-action="action.key"
            :href="action.href"
          >
            {{ action.label }}
          </a>
          <button
            v-for="action in group.buttonActions"
            :key="action.key"
            class="attendance__btn attendance__btn--inline attendance__admin-task-action"
            :class="{ 'attendance__btn--primary': action.primary }"
            :data-admin-task-action="action.key"
            type="button"
            @click="emit('select-section', action.sectionId)"
          >
            {{ action.label }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
type TranslateFn = (en: string, zh: string) => string

type AttendanceAdminTaskHomeLinkAction = {
  key: string
  label: string
  href: string
  primary?: boolean
}

type AttendanceAdminTaskHomeSectionAction = {
  key: string
  label: string
  sectionId: string
  primary?: boolean
}

/** Shape matches AttendanceView.vue's local `AttendanceAdminTaskHomeGroup` —
 * kept local (not imported) since the parent does not export its types; must
 * be extended in both places together (same convention as
 * AttendanceEmployeeWorkspace.vue). */
type AttendanceAdminTaskHomeGroup = {
  key: string
  title: string
  detail: string
  linkActions: AttendanceAdminTaskHomeLinkAction[]
  buttonActions: AttendanceAdminTaskHomeSectionAction[]
}

defineProps<{
  tr: TranslateFn
  groups: AttendanceAdminTaskHomeGroup[]
}>()

const emit = defineEmits<{
  'select-section': [id: string]
}>()
</script>

<style scoped>
.attendance__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.attendance__btn--primary {
  background: #1976d2;
  border-color: #1976d2;
  color: #fff;
}

.attendance__btn--inline {
  padding: 5px 10px;
  font-size: 12px;
}

.attendance__admin-task-home {
  display: grid;
  gap: 14px;
  margin-bottom: 16px;
  padding: 14px 0 16px;
  border-top: 1px solid #e2e8f0;
  border-bottom: 1px solid #e2e8f0;
}

.attendance__admin-task-home-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}

.attendance__admin-task-home-eyebrow {
  display: block;
  margin-bottom: 4px;
  color: #64748b;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.attendance__admin-task-home h4 {
  margin: 0;
  color: #0f172a;
  font-size: 16px;
}

.attendance__admin-task-home-hint {
  max-width: 300px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.45;
  text-align: right;
}

.attendance__admin-task-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.attendance__admin-task-group {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

.attendance__admin-task-copy {
  display: grid;
  gap: 5px;
}

.attendance__admin-task-copy strong {
  color: #1f2937;
  font-size: 13px;
}

.attendance__admin-task-copy span {
  color: #64748b;
  font-size: 12px;
  line-height: 1.45;
}

.attendance__admin-task-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attendance__admin-task-action {
  text-decoration: none;
}

@media (max-width: 768px) {
  .attendance__admin-task-home-header {
    flex-direction: column;
  }

  .attendance__admin-task-home-hint {
    max-width: none;
    text-align: left;
  }

  .attendance__admin-task-grid {
    grid-template-columns: 1fr;
  }
}
</style>
