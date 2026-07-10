<template>
  <PageShell width="wide">
    <PageHeader
      :title="bi('备料工作台', 'Stock Preparation')"
      :subtitle="bi(
        '只读优先的备料 MVP:PLM 项目 / BOM 与 ERP·K3 物料只读同步,人工确认映射与单位,再生成备料行。',
        'Readonly-first stock preparation MVP: readonly sync of PLM project/BOM and ERP/K3 material, human-confirmed mapping and units, then prep-line generation.',
      )"
    />

    <p class="stock-prep__boundary" data-testid="stock-prep-boundary">
      {{ bi(
        '本工作台只读:不做 ERP/K3 写入,不触发 K3 Save / Submit / Audit,不自动创建 ERP 物料,不提供原始 SQL 入口。生成/写回仅为 multitable 内部表操作。',
        'This workspace is readonly: no ERP/K3 write, no K3 Save / Submit / Audit, no automatic ERP material creation, no raw SQL entry point. Any generate/write is a multitable-internal table op only.',
      ) }}
    </p>

    <!-- Tabbed container placeholder. Each tab is one of the six MVP views (design §"Frontend MVP");
         they land later in their own DISJOINT files and get mounted here in place of the placeholder. -->
    <nav class="stock-prep__tabs" role="tablist" data-testid="stock-prep-tabs" :aria-label="bi('备料视图', 'Stock preparation views')">
      <button
        v-for="view in views"
        :key="view.key"
        type="button"
        role="tab"
        class="stock-prep__tab"
        :class="{ 'stock-prep__tab--active': view.key === activeKey }"
        :data-testid="`stock-prep-tab-${view.key}`"
        :aria-selected="view.key === activeKey ? 'true' : 'false'"
        @click="activeKey = view.key"
      >
        {{ bi(view.zh, view.en) }}
      </button>
    </nav>

    <section
      v-if="activeView"
      class="stock-prep__panel"
      role="tabpanel"
      data-testid="stock-prep-panel"
      :data-active="activeKey"
    >
      <h2 class="stock-prep__panel-title">{{ bi(activeView.zh, activeView.en) }}</h2>
      <p class="stock-prep__panel-desc" :data-testid="`stock-prep-desc-${activeKey}`">
        {{ bi(activeView.zhDesc, activeView.enDesc) }}
      </p>
      <p class="stock-prep__panel-endpoint" data-testid="stock-prep-panel-endpoint">
        <span class="stock-prep__badge">{{
          activeView.confirmWrites ? bi('只读 + 人工确认', 'readonly + human confirm') : `${bi('只读', 'readonly')} · GET`
        }}</span>
        <code>{{ activeView.endpoint }}</code>
      </p>
      <!-- Views 1-4 are real views; the remaining tabs keep the placeholder. Views 2-4 share the
           shell-owned projectId context selected in view 1 (#4017 pattern). -->
      <StockPreparationProjectWorkspaceView
        v-if="activeKey === 'project-workspace'"
        @select-project="handleProjectSelect"
      />
      <StockPreparationSnapshotDiffView
        v-else-if="activeKey === 'bom-snapshot-diff'"
        :project-id="selectedProjectId"
      />
      <StockPreparationMappingConfirmView
        v-else-if="activeKey === 'material-mapping'"
        :project-id="selectedProjectId"
      />
      <StockPreparationUnitConfirmView
        v-else-if="activeKey === 'unit-conversion'"
        :project-id="selectedProjectId"
      />
      <p v-else class="stock-prep__panel-pending" data-testid="stock-prep-panel-pending">
        {{ bi('该视图将在后续 wave 落地,当前为容器占位。', 'This view lands in a later wave; this is a container placeholder for now.') }}
      </p>
    </section>
  </PageShell>
</template>

<script setup lang="ts">
// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md).
// A routed, tabbed workspace SHELL. It is deliberately a thin container: the six MVP operator views
// (project workspace / BOM snapshot-batch & diff / material-mapping confirm / unit-conversion confirm
// / prep-line / exception queue) each land later in their own DISJOINT files (parallel-lane merge
// safety) and mount into this shell in place of the placeholder panel.
//
// Boundary (mutation-tested gates): READONLY-FIRST — this shell has no write path, calls no service,
// and only renders values-free copy. NAMING — the snapshot surface uses 快照批次 / "snapshot batch"
// to avoid colliding with PLM view-state "snapshot" and k3WiseSetup "mapping" vocabularies.
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLocale } from '../../../composables/useLocale'
import PageShell from '../../layout/PageShell.vue'
import PageHeader from '../../layout/PageHeader.vue'
import StockPreparationProjectWorkspaceView from './StockPreparationProjectWorkspaceView.vue'
import StockPreparationSnapshotDiffView from './StockPreparationSnapshotDiffView.vue'
import StockPreparationMappingConfirmView from './StockPreparationMappingConfirmView.vue'
import StockPreparationUnitConfirmView from './StockPreparationUnitConfirmView.vue'

const { locale } = useLocale()

// Same synchronous locale pattern as the rest of the integration surface (IntegrationHelpView /
// errorCodeLabels): read `locale.value` directly in the template.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

type StockPreparationViewKey =
  | 'project-workspace'
  | 'bom-snapshot-diff'
  | 'material-mapping'
  | 'unit-conversion'
  | 'prep-line'
  | 'exception-queue'

interface StockPreparationViewTab {
  key: StockPreparationViewKey
  zh: string
  en: string
  zhDesc: string
  enDesc: string
  /** The readonly (GET) summary endpoint the view reads. Values-free path only. */
  endpoint: string
  /**
   * True for the two confirmation views whose row actions issue MULTITABLE-INTERNAL human-confirm
   * writes (W3b). Still no external ERP/K3 write — the badge copy reflects the human-confirm nature.
   */
  confirmWrites?: boolean
}

// Tab order follows the MVP business loop (design §"MVP Goal"). Descriptions are values-free — they
// name fields/statuses, never customer drawing numbers, material codes, or quantities.
const views: StockPreparationViewTab[] = [
  {
    key: 'project-workspace',
    zh: '项目工作台',
    en: 'Project Workspace',
    zhDesc: '按项目查看备料概览:快照批次数、待处理异常数、就绪与暂挂的备料行数。',
    enDesc: 'Per-project stock-preparation overview: snapshot-batch count, open exception count, ready vs held prep-line counts.',
    endpoint: '/api/integration/stock-preparation/projects',
  },
  {
    key: 'bom-snapshot-diff',
    zh: 'BOM 快照批次与差异',
    en: 'BOM Snapshot Batch & Diff',
    zhDesc: '每次同步生成不可变的快照批次;旧批次保留,与前一批次按新增/删除/数量/单位/版本等差异对比。',
    enDesc: 'Each sync creates an immutable snapshot batch; older batches are kept and diffed against the predecessor by added/removed/quantity/unit/version change.',
    endpoint: '/api/integration/stock-preparation/snapshot-batches',
  },
  {
    key: 'material-mapping',
    zh: '物料映射确认',
    en: 'Material Mapping Confirm',
    zhDesc: '将 PLM 图号/版本映射到 ERP 物料编码/内部 id;歧义或未匹配的行进入人工确认,不自动创建 ERP 物料。',
    enDesc: 'Map PLM drawing/version to ERP material code/internal id; ambiguous or unmatched rows go to manual confirmation, never auto-create ERP material.',
    endpoint: '/api/integration/stock-preparation/material-mappings/summary',
    confirmWrites: true,
  },
  {
    key: 'unit-conversion',
    zh: '单位换算确认',
    en: 'Unit Conversion Confirm',
    zhDesc: '将设计单位换算为 ERP 领用单位;无唯一有效规则时进入异常队列,不做静默猜测。',
    enDesc: 'Convert the design unit to the ERP issue unit; with no unique active rule the line enters the exception queue rather than a silent guess.',
    endpoint: '/api/integration/stock-preparation/unit-conversions/summary',
    confirmWrites: true,
  },
  {
    key: 'prep-line',
    zh: '备料行',
    en: 'Prep Lines',
    zhDesc: '仅由已确认的快照、映射与单位规则生成备料行;未解决的映射/单位冲突不会产出就绪行。',
    enDesc: 'Prep lines generated only from confirmed snapshots, mappings, and unit rules; unresolved mapping/unit conflicts never produce ready lines.',
    endpoint: '/api/integration/stock-preparation/prep-lines/summary',
  },
  {
    key: 'exception-queue',
    zh: '异常队列',
    en: 'Exception Queue',
    zhDesc: '所有不确定的行都可见、可处理;阻断级异常保持可见并阻止最终确认。',
    enDesc: 'Every uncertain row is visible and actionable; blocking exceptions stay visible and prevent final confirmation.',
    endpoint: '/api/integration/stock-preparation/exceptions/summary',
  },
]

const activeKey = ref<StockPreparationViewKey>(views[0].key)
const activeView = computed(() => views.find((view) => view.key === activeKey.value) ?? null)

// Shared project context (view 1 → view 2). The shell is the single owner of the selected
// projectId: view 1 emits it (row action), view 2 receives it as a prop, and the `?projectId=`
// route query seeds/mirrors it so a reload or shared link keeps the same project scope. The
// projectId is an internal MetaSheet handle — kept in state/URL, never rendered (values-free).
const route = useRoute()
const router = useRouter()

function projectIdFromQuery(): string | undefined {
  const raw = route.query?.projectId
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const selectedProjectId = ref<string | undefined>(projectIdFromQuery())

function handleProjectSelect(projectId: string): void {
  selectedProjectId.value = projectId
  // Jump straight into view 2 already scoped — no re-select there.
  activeKey.value = 'bom-snapshot-diff'
  // Mirror the handle into the query (replace: selecting is not a history step).
  void router.replace({ query: { ...route.query, projectId } })
}
</script>

<style scoped>
.stock-prep__boundary {
  margin: 0 0 var(--ms-space-4);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
  border-bottom: 1px solid var(--ms-border-light);
  margin-bottom: var(--ms-space-4);
}

.stock-prep__tab {
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  padding: var(--ms-space-2) var(--ms-space-3);
  color: var(--ms-text-2);
  font: inherit;
  font-weight: var(--ms-font-weight-title);
  cursor: pointer;
}

.stock-prep__tab:hover {
  color: var(--ms-text-1);
}

.stock-prep__tab--active {
  color: var(--ms-color-primary);
  border-bottom-color: var(--ms-color-primary);
}

.stock-prep__panel {
  padding: var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.stock-prep__panel-title {
  margin: 0 0 var(--ms-space-2);
  font-size: var(--ms-font-size-section-title);
  color: var(--ms-text-1);
}

.stock-prep__panel-desc {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  line-height: 1.6;
}

.stock-prep__panel-endpoint {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
  margin: 0 0 var(--ms-space-3);
  font-size: 12px;
  color: var(--ms-text-3);
}

.stock-prep__panel-endpoint code {
  font-size: 12px;
  color: var(--ms-text-2);
}

.stock-prep__badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-weight: var(--ms-font-weight-title);
}

.stock-prep__panel-pending {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 13px;
}
</style>
