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
  groups it is given. Href-style entries (deep links into other attendance surfaces, e.g. the
  overview requests/anomalies queues) still render as real `<a href>` anchors (screen readers,
  right-click "open in new tab", ctrl/cmd-click all keep working) but a plain left-click now emits
  `navigate` instead of letting the browser do a full SPA page reload (Navigability audit fix 4,
  2026-08-22). This component still does not hold router state itself — the parent
  (AttendanceView.vue) owns the actual `router.push()` call, same division of responsibility as
  `select-section`. Not part of the admin section selection path.
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
          <div class="attendance__admin-task-copy-title">
            <strong>{{ group.title }}</strong>
            <span
              class="attendance__admin-task-status"
              :class="'attendance__admin-task-status--' + resolveGroupStatus(group.status)"
              :data-admin-task-status="resolveGroupStatus(group.status)"
            >{{ statusLabel(group.status) }}</span>
          </div>
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
            @click="onLinkActionClick(action.href, $event)"
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
import {
  attendanceAdminTaskHomeStatusLabel,
  resolveAttendanceAdminTaskHomeStatus,
  type AttendanceAdminTaskHomeStatus,
} from './attendanceAdminTaskHomeStatus'

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
  status?: AttendanceAdminTaskHomeStatus | string
  linkActions: AttendanceAdminTaskHomeLinkAction[]
  buttonActions: AttendanceAdminTaskHomeSectionAction[]
}

const props = defineProps<{
  tr: TranslateFn
  groups: AttendanceAdminTaskHomeGroup[]
}>()

function resolveGroupStatus(status: AttendanceAdminTaskHomeGroup['status']): AttendanceAdminTaskHomeStatus {
  return resolveAttendanceAdminTaskHomeStatus(status)
}

function statusLabel(status: AttendanceAdminTaskHomeGroup['status']): string {
  return attendanceAdminTaskHomeStatusLabel(resolveGroupStatus(status), props.tr)
}

const emit = defineEmits<{
  'select-section': [id: string]
  navigate: [href: string]
}>()

// Navigability audit fix 4: a plain left-click (no modifier, not a request to open a new tab)
// is intercepted and re-emitted as an in-SPA navigation request instead of letting the browser
// perform a full page reload. Modifier-clicks (ctrl/cmd/shift/middle-button) and any consumer
// that already called `preventDefault()` are left alone, so "open in new tab" / "open in new
// window" keep working exactly like a normal link.
function onLinkActionClick(href: string, event: MouseEvent): void {
  if (event.defaultPrevented) return
  if (event.button !== 0) return
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  emit('navigate', href)
}
</script>

<style scoped>
.attendance__btn {
  padding: 8px 14px;
  border-radius: var(--ms-radius-md);
  border: 1px solid var(--ms-border);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
}

.attendance__btn--primary {
  background: var(--ms-color-primary);
  border-color: var(--ms-color-primary);
  color: #fff;
}

.attendance__btn--inline {
  padding: 5px 12px;
  font-size: 13px;
}

.attendance__admin-task-home {
  display: grid;
  gap: var(--ms-space-4);
  margin-bottom: var(--ms-space-4);
  min-width: 0;
}

.attendance__admin-task-home-header {
  display: flex;
  justify-content: space-between;
  gap: var(--ms-space-4);
  align-items: flex-end;
}

.attendance__admin-task-home-eyebrow {
  display: block;
  margin-bottom: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 12px;
  font-weight: var(--ms-font-weight-title);
}

.attendance__admin-task-home h4 {
  margin: 0;
  color: var(--ms-text-1);
  font-size: var(--ms-font-size-page-title);
  font-weight: var(--ms-font-weight-title);
  letter-spacing: -0.02em;
}

.attendance__admin-task-home-hint {
  max-width: 320px;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
  text-align: right;
}

.attendance__admin-task-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--ms-space-4);
}

.attendance__admin-task-group {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: space-between;
  gap: var(--ms-space-4);
  padding: var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-card);
}

.attendance__admin-task-copy {
  display: grid;
  gap: var(--ms-space-2);
}

.attendance__admin-task-copy-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ms-space-2);
}

.attendance__admin-task-copy strong {
  color: var(--ms-text-1);
  font-size: 15px;
  font-weight: var(--ms-font-weight-title);
}

.attendance__admin-task-status {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  border: 1px solid var(--ms-border-light);
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
}

.attendance__admin-task-status--ok {
  border-color: transparent;
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
}

.attendance__admin-task-status--needs_attention {
  border-color: transparent;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.attendance__admin-task-status--not_configured {
  border-color: transparent;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.attendance__admin-task-status--failed {
  border-color: transparent;
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger-dark-2);
}

.attendance__admin-task-status--unknown {
  border-color: var(--ms-border-light);
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
}

.attendance__admin-task-copy span {
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.attendance__admin-task-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.attendance__admin-task-action {
  text-decoration: none;
}

@media (max-width: 960px) {
  .attendance__admin-task-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .attendance__admin-task-home-header {
    flex-direction: column;
    align-items: flex-start;
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
