<template>
  <div class="sp-project" data-testid="stock-prep-project-workspace">
    <!-- Loading: values-free spinner copy only. -->
    <p
      v-if="loading"
      class="sp-project__state sp-project__state--muted"
      data-testid="stock-prep-project-loading"
      role="status"
    >
      {{ bi('正在加载项目概览…', 'Loading project overview…') }}
    </p>

    <!-- Error / endpoint-not-ready (GET rejects or 404s): neutral, non-alarming, never the raw body. -->
    <p
      v-else-if="errored"
      class="sp-project__state sp-project__state--muted"
      data-testid="stock-prep-project-error"
      role="status"
    >
      {{ bi('同步后端尚未就绪,稍后再试。', 'Backend read not ready yet — try again later.') }}
    </p>

    <!-- Empty: no projects have been synced yet. -->
    <p
      v-else-if="isEmpty"
      class="sp-project__state sp-project__state--muted"
      data-testid="stock-prep-project-empty"
    >
      {{ bi('尚无已同步项目。', 'No projects synced yet.') }}
    </p>

    <!-- Data: values-free summary + per-project rows. -->
    <div v-else-if="overview" class="sp-project__overview" data-testid="stock-prep-project-overview">
      <header class="sp-project__summary" data-testid="stock-prep-project-summary">
        <span class="sp-project__summary-count">
          {{ bi('已同步项目', 'Synced projects') }}: {{ overview.projectCount }}
        </span>
        <span
          v-for="entry in statusEntries"
          :key="entry.status"
          class="sp-project__summary-chip"
          data-testid="stock-prep-project-status-chip"
        >
          {{ entry.status }}: {{ entry.count }}
        </span>
      </header>

      <div class="sp-project__table-wrap">
        <table class="sp-project__table">
          <thead>
            <tr>
              <th scope="col">{{ bi('项目状态', 'Project status') }}</th>
              <th scope="col">{{ bi('快照批次数', 'Snapshot batches') }}</th>
              <th scope="col">{{ bi('待处理异常', 'Open exceptions') }}</th>
              <th scope="col">{{ bi('就绪备料行', 'Ready lines') }}</th>
              <th scope="col">{{ bi('暂挂备料行', 'Held lines') }}</th>
              <th scope="col">{{ bi('最近同步运行', 'Last sync run') }}</th>
              <th scope="col" class="sp-project__col-action">{{ bi('操作', 'Actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="project in overview.projects"
              :key="project.projectId"
              class="sp-project__row"
              data-testid="stock-prep-project-row"
            >
              <td>
                <span class="sp-project__status" data-testid="stock-prep-project-status">
                  {{ project.projectStatus }}
                </span>
              </td>
              <td class="sp-project__num">{{ project.snapshotBatchCount }}</td>
              <td class="sp-project__num">{{ project.openExceptionCount }}</td>
              <td class="sp-project__num">{{ project.readyLineCount }}</td>
              <td class="sp-project__num">{{ project.heldLineCount }}</td>
              <td>
                <code class="sp-project__handle" data-testid="stock-prep-project-run-handle">{{
                  project.lastSyncRunId ?? '—'
                }}</code>
              </td>
              <td class="sp-project__col-action">
                <!-- Shared project context (view 1 → view 2): emits the internal projectId handle so
                     the shell can open the snapshot-batch view already scoped — no re-select there. -->
                <button
                  type="button"
                  class="sp-project__select"
                  data-testid="stock-prep-project-select"
                  @click="emit('select-project', project.projectId)"
                >
                  {{ bi('查看快照批次', 'View snapshot batches') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md),
// Frontend MVP view 1: PROJECT WORKSPACE, rendered inside the workspace shell's first tab.
//
// READONLY: this view only GETs the values-free per-project overview through the landed service
// stub. It has no write path, issues no method override, and never triggers ERP/K3 writes.
//
// VALUES-FREE: it renders ONLY counts / status enums and an internal MetaSheet navigation handle
// (lastSyncRunId). It deliberately does NOT render projectId as a visible column, nor any customer
// business value — no drawing numbers, material codes, quantities, project names, hosts, tenants,
// or credentials — because the overview shape carries none and the template reads a fixed whitelist.
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  getStockPreparationWorkspaceOverview,
  type StockPreparationWorkspaceOverview,
} from '../../../services/integration/stockPreparation/projectWorkspace'

const props = withDefaults(
  defineProps<{
    /** Optional tenant/workspace scope passed straight through to the readonly GET. */
    scope?: IntegrationScope
  }>(),
  { scope: () => ({}) },
)

const emit = defineEmits<{
  /**
   * Shared project context (view 1 → view 2): fired with the internal MetaSheet projectId handle
   * when the operator picks a project row. The handle is emitted, never rendered (values-free).
   */
  (e: 'select-project', projectId: string): void
}>()

const { locale } = useLocale()

// Same synchronous locale idiom as the shell / the rest of the integration surface.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const loading = ref(true)
const errored = ref(false)
const overview = ref<StockPreparationWorkspaceOverview | null>(null)

const isEmpty = computed(() => overview.value !== null && overview.value.projectCount === 0)

const statusEntries = computed(() =>
  Object.entries(overview.value?.statusCounts ?? {}).map(([status, count]) => ({ status, count })),
)

async function load(): Promise<void> {
  loading.value = true
  errored.value = false
  try {
    overview.value = await getStockPreparationWorkspaceOverview(props.scope)
  } catch {
    // 404-soft: the backend read route may not exist yet. Surface a neutral, non-alarming state
    // and NEVER the raw error body.
    errored.value = true
    overview.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.sp-project {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-project__state {
  margin: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  line-height: 1.6;
}

.sp-project__state--muted {
  color: var(--ms-text-3);
}

.sp-project__summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2);
}

.sp-project__summary-count {
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title);
}

.sp-project__summary-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
}

.sp-project__table-wrap {
  overflow-x: auto;
}

.sp-project__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.sp-project__table th,
.sp-project__table td {
  padding: var(--ms-space-2) var(--ms-space-3);
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
  white-space: nowrap;
}

.sp-project__table th {
  color: var(--ms-text-3);
  font-weight: var(--ms-font-weight-title);
}

.sp-project__num {
  color: var(--ms-text-1);
  font-variant-numeric: tabular-nums;
}

.sp-project__status {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
}

.sp-project__handle {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-project__col-action {
  text-align: right;
}

/* Same light row-action idiom as view 2's diff entry (sp-snap__select). */
.sp-project__select {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 2px 10px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.sp-project__select:hover {
  background: var(--el-fill-color-light);
}
</style>
