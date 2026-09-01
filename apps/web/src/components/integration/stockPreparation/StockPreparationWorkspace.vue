<template>
  <PageShell width="wide">
    <PageHeader
      :title="bi('备料工作台', 'Stock Preparation')"
      :subtitle="bi(
        '从 PLM 读项目和 BOM、从 ERP·K3 读物料,拿不准的地方交给人确认,再生成备料明细。全程不改动这两个系统里的数据。',
        'Reads projects and BOMs from PLM and materials from ERP/K3, brings anything uncertain to a person, then builds the prep lines. It changes nothing inside either of those systems.',
      )"
    />

    <!-- THE FENCE SENTENCE. It keeps every promise the old one made; what changed is that it makes
         them to the customer admin who has to trust them rather than to the reviewer who wrote them.
         The API-shaped original is one click away, unedited, because "no K3 Save / Submit / Audit"
         is the phrasing an implementer matches against the K3 documentation. -->
    <div class="stock-prep__boundary" data-testid="stock-prep-boundary">
      <p class="stock-prep__boundary-text">
        {{ bi(
          '本工作台只读:不会改动您 ERP/K3 里的任何数据,不会自动去 ERP 新建物料,也没有直接执行 SQL 的入口。这里生成或写回的内容,只落在本系统自己的表里。',
          'This workspace only reads: it changes nothing inside your ERP/K3, never creates a material there on its own, and offers no direct SQL entry point. Anything it generates or writes lands only in this system\'s own tables.',
        ) }}
      </p>
      <StockPrepTechnicalDetails testid="stock-prep-boundary-tech">
        {{ bi(
          '本工作台只读:不做 ERP/K3 写入,不触发 K3 Save / Submit / Audit,不自动创建 ERP 物料,不提供原始 SQL 入口。生成/写回仅为 multitable 内部表操作。',
          'This workspace is readonly: no ERP/K3 write, no K3 Save / Submit / Audit, no automatic ERP material creation, no raw SQL entry point. Any generate/write is a multitable-internal table op only.',
        ) }}
      </StockPrepTechnicalDetails>
    </div>

    <!-- Tabbed container placeholder. Each tab is one of the six MVP views (design §"Frontend MVP");
         they land later in their own DISJOINT files and get mounted here in place of the placeholder. -->
    <nav class="stock-prep__tabs" role="tablist" data-testid="stock-prep-tabs" :aria-label="bi('备料视图', 'Stock preparation views')">
      <button
        v-for="view in visibleViews"
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
      :data-active="effectiveKey"
    >
      <h2 class="stock-prep__panel-title">{{ bi(activeView.zh, activeView.en) }}</h2>
      <p class="stock-prep__panel-desc" :data-testid="`stock-prep-desc-${effectiveKey}`">
        {{ bi(activeView.zhDesc, activeView.enDesc) }}
      </p>
      <!-- The dashboard tab aggregates MULTIPLE existing readonly endpoints client-side (H1/H2) — it
           has no single endpoint to badge, so this line is skipped for it only.

           What this line says first is now WHAT THIS TAB CAN CHANGE — the only part of it a customer
           admin has a use for. The shape badge and the route path are what an implementer greps, so
           they stay, one click down. -->
      <div v-if="!activeView.noEndpointBadge" class="stock-prep__panel-endpoint" data-testid="stock-prep-panel-endpoint">
        <p class="stock-prep__panel-effect">{{ effectLabel(activeView) }}</p>
        <StockPrepTechnicalDetails testid="stock-prep-panel-endpoint-tech">
          <span class="stock-prep__badge">{{ badgeLabel(activeView) }}</span>
          <code>{{ activeView.endpoint }}</code>
        </StockPrepTechnicalDetails>
      </div>
      <!-- H1/H2 (UI humanization, H0 plane-boundary design-lock PR #4202): the dashboard tab is the
           new default landing view — "operator enters the system and immediately sees current
           project / current stage / blocking count / recommended next step". Its own picker updates
           selectedProjectId WITHOUT switching tabs (handleDashboardProjectSelect), and its stepper /
           recommend-action navigates by reusing this SAME activeKey (handleNavigateStage) — a
           satellite of the one tab-nav surface, never a second one. -->
      <!-- O1' §附: the confirmation queue is what this page WAS ADOPTED FOR — the human confirmation
           loop's operator entry. It is the only tab a customer operator (stock-prep:read) sees; the
           six MVP tabs below were explicitly not revived by that ruling and stay platform-admin. -->
      <StockPreparationConfirmationQueueView
        v-if="effectiveKey === 'confirmation-queue'"
        :scope="scope"
      />
      <!-- §14 (multitable-application-model-20260830.md): the INSTALL page — the app's defaults laid
           out for a customer admin to confirm, the deployment preflight, and a SKIP-aware install run
           that walks the bootstrap script's own step order. Workbench-admin tier; the run control
           inside it is platform-admin because the four routes it drives are. -->
      <StockPreparationInstallView
        v-else-if="effectiveKey === 'install'"
        :scope="scope"
      />
      <StockPreparationDashboardView
        v-else-if="effectiveKey === 'dashboard'"
        :project-id="selectedProjectId"
        :scope="scope"
        @select-project="handleDashboardProjectSelect"
        @navigate-stage="handleNavigateStage"
      />
      <!-- Views 1-6 are all real views now (the placeholder branch remains only as a guard for any
           future tab). Views 2-6 share the shell-owned projectId context selected in view 1
           (#4017 pattern). -->
      <StockPreparationProjectWorkspaceView
        v-else-if="effectiveKey === 'project-workspace'"
        :scope="scope"
        @select-project="handleProjectSelect"
        @navigate-stage="handleNavigateStage"
        @open-multitable="handleOpenMultitable"
      />
      <StockPreparationSnapshotDiffView
        v-else-if="effectiveKey === 'bom-snapshot-diff'"
        :project-id="selectedProjectId"
        :scope="scope"
      />
      <StockPreparationMappingConfirmView
        v-else-if="effectiveKey === 'material-mapping'"
        :project-id="selectedProjectId"
        :scope="scope"
      />
      <StockPreparationUnitConfirmView
        v-else-if="effectiveKey === 'unit-conversion'"
        :project-id="selectedProjectId"
        :scope="scope"
      />
      <StockPreparationPrepLineView
        v-else-if="effectiveKey === 'prep-line'"
        :project-id="selectedProjectId"
        :scope="scope"
      />
      <StockPreparationExceptionQueueView
        v-else-if="effectiveKey === 'exception-queue'"
        :project-id="selectedProjectId"
        :scope="scope"
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
import { getDefaultIntegrationScope } from '../../../services/integration/workbench'
import PageShell from '../../layout/PageShell.vue'
import PageHeader from '../../layout/PageHeader.vue'
import StockPreparationDashboardView from './StockPreparationDashboardView.vue'
import StockPreparationProjectWorkspaceView from './StockPreparationProjectWorkspaceView.vue'
import StockPreparationSnapshotDiffView from './StockPreparationSnapshotDiffView.vue'
import StockPreparationMappingConfirmView from './StockPreparationMappingConfirmView.vue'
import StockPreparationUnitConfirmView from './StockPreparationUnitConfirmView.vue'
import StockPreparationPrepLineView from './StockPreparationPrepLineView.vue'
import StockPreparationExceptionQueueView from './StockPreparationExceptionQueueView.vue'
import StockPreparationConfirmationQueueView from './StockPreparationConfirmationQueueView.vue'
import StockPreparationInstallView from './StockPreparationInstallView.vue'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import { useAuth } from '../../../composables/useAuth'
import {
  canOpenStockPrepInstallView,
  canUseLegacyMvpTabs,
} from '../../../services/integration/stockPreparation/workbenchAccess'

const { locale } = useLocale()
const auth = useAuth()
const scope = getDefaultIntegrationScope()

// Same synchronous locale pattern as the rest of the integration surface (IntegrationHelpView /
// errorCodeLabels): read `locale.value` directly in the template.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

type StockPreparationViewKey =
  | 'confirmation-queue'
  | 'install'
  | 'dashboard'
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
   * True for the views whose actions issue MULTITABLE-INTERNAL writes: the two confirmation views
   * (W3b human confirms), the prep-line view (W4a generation run), and the exception queue (W4a
   * resolutions). Still no external ERP/K3 write — the badge copy reflects the human-confirm nature.
   */
  confirmWrites?: boolean
  /**
   * True for the install tab alone. Its badge must not claim "readonly · GET": the panel reads the
   * manifest and the preflight, and its admin-only run calls the EXISTING idempotent ensure /
   * customer-pack routes. Still no external write and still no new authority — the badge just says
   * what it is instead of what the two older shapes are.
   */
  provisioning?: boolean
  /** True only for the dashboard tab — it aggregates multiple existing GETs client-side (H1/H2), so
   *  it has no single endpoint to badge (see the panel-endpoint paragraph's v-if). */
  noEndpointBadge?: boolean
  /**
   * O2 / R-11. True for the six MVP tabs, whose every route is still PLATFORM-ADMIN gated and which
   * the O1' ruling explicitly did not revive when it narrowed this page to the confirmation queue.
   * They render only for a platform admin: showing them to a stock-prep operator would put six tabs
   * of controls on screen that 403 on click — the "visible but not actionable" half of R-11.
   */
  legacyMvp?: boolean
  /**
   * §14 install tab. Gated on `stock-prep:admin` — the workbench-scoped ceiling — rather than on
   * platform admin, because everything the PANEL itself reads (the app-catalog manifest and the
   * read-tier preflight) is answerable to that holder. The one control inside it that needs more
   * (the install run, which drives four platform-admin routes) does its own R-11 gating there, so a
   * workbench admin never sees a button that would 403.
   */
  workbenchAdminOnly?: boolean
}

// Tab order follows the MVP business loop (design §"MVP Goal"). Descriptions are values-free — they
// name fields/statuses, never customer drawing numbers, material codes, or quantities.
const views: StockPreparationViewTab[] = [
  // O1' §附 (owner, 2026-08-29): `/stock-prep` is adopted as THE CONFIRMATION-QUEUE WORKBENCH — the
  // operator entry into the human confirmation loop. It is listed FIRST so it is the landing view
  // (the shell's "default tab is the first VISIBLE tab" pattern), and it is the ONLY tab a customer
  // operator sees: everything below it is a legacy MVP surface the same ruling declined to revive.
  {
    key: 'confirmation-queue',
    zh: '确认队列',
    en: 'Confirmation Queue',
    zhDesc: '系统拿不准的地方会停下来问您:同一样东西出现了好几条,或者前后两份数据对不上。您在这里逐条拿主意,系统按您的决定继续往下走。',
    enDesc: 'Wherever the system is not sure — the same thing appearing several times, or two records that disagree — it stops and asks you here. You decide each one, and it carries on from your decision.',
    endpoint: '/api/integration/stock-preparation/confirmation-decisions',
    confirmWrites: true,
  },
  // §14 (docs/development/platform-overall-design/multitable-application-model-20260830.md):
  // "安装页展示默认配置,由客户确认". Listed SECOND so the confirmation queue stays the landing view
  // for the operator this page was adopted for, while the customer admin who has to install the app
  // finds it one click away rather than in a separate console.
  {
    key: 'install',
    workbenchAdminOnly: true,
    zh: '安装 / 体检',
    en: 'Install / Health',
    zhDesc: '把这套部署会装的东西摆出来给您确认,然后看看还缺什么、建该建的表、再检查一次。跳过的步骤是还需要人来做的事,不是装失败了。',
    enDesc: 'Lays out what this deployment installs for you to confirm, then checks what is missing, creates what needs creating, and checks again. A skipped step is work still waiting for a person, not a failed install.',
    endpoint: '/api/platform/apps/stock-preparation',
    provisioning: true,
  },
  // H1/H2 (UI humanization, H0 plane-boundary design-lock PR #4202 — PLANE A, values-free): the
  // task-oriented entry for the legacy MVP surface.
  {
    key: 'dashboard',
    legacyMvp: true,
    zh: '仪表盘',
    en: 'Dashboard',
    zhDesc: '一眼看清:这个项目做到哪一步了、有几件事卡着、接下来该做什么。上面的数字都是从下面各页汇总来的。',
    enDesc: 'At a glance: how far this project has got, how many things are stuck, and what to do next. Every number is summed up from the pages below.',
    endpoint: '',
    noEndpointBadge: true,
  },
  {
    key: 'project-workspace',
    legacyMvp: true,
    zh: '项目工作台',
    en: 'Project Workspace',
    zhDesc: '按项目看备料进度:同步过几批、有几件事待处理、有多少行可以用、多少行卡着。',
    enDesc: 'Progress per project: how many syncs have run, how many things are waiting to be handled, how many lines are usable and how many are stuck.',
    endpoint: '/api/integration/stock-preparation/projects',
  },
  {
    key: 'bom-snapshot-diff',
    legacyMvp: true,
    zh: 'BOM 快照批次与差异',
    en: 'BOM Snapshot Batch & Diff',
    zhDesc: '每次从 PLM 同步都会存下当时的样子,旧的一份都不会被覆盖。这里可以拿最新一份和上一份比,看这次到底改了什么。',
    enDesc: 'Every sync from PLM keeps a copy of what it saw, and older copies are never overwritten. Compare the latest with the one before it to see exactly what changed.',
    endpoint: '/api/integration/stock-preparation/snapshot-batches',
  },
  {
    key: 'material-mapping',
    legacyMvp: true,
    zh: '物料映射确认',
    en: 'Material Mapping Confirm',
    zhDesc: '把 PLM 的图号对到 ERP 里的物料。对不上、或者对上了好几个的,都交给您来定 —— 系统绝不会自己去 ERP 建物料。',
    enDesc: 'Match a PLM drawing to a material in ERP. Anything that does not match, or matches several, comes to you to decide — the system never creates a material in ERP by itself.',
    endpoint: '/api/integration/stock-preparation/material-mappings/summary',
    confirmWrites: true,
  },
  {
    key: 'unit-conversion',
    legacyMvp: true,
    zh: '单位换算确认',
    en: 'Unit Conversion Confirm',
    zhDesc: '把图纸上的设计单位换算成实际领用的单位。没有唯一一条规则可用时,这一行会进待处理清单 —— 系统不会替您猜。',
    enDesc: 'Convert the unit on the drawing into the unit things are actually issued in. Where no single rule applies, the row goes to the problem list rather than being guessed at.',
    endpoint: '/api/integration/stock-preparation/unit-conversions/summary',
    confirmWrites: true,
  },
  {
    key: 'prep-line',
    legacyMvp: true,
    zh: '备料行',
    en: 'Prep Lines',
    zhDesc: '只有确认过的数据才会生成备料明细。物料对应关系或单位还没定下来的,不会产出可以用的行。',
    enDesc: 'Prep lines are built only from data you have confirmed. While a material match or a unit is still unresolved, no usable line is produced.',
    endpoint: '/api/integration/stock-preparation/prep-lines',
    // View 5's generation run is a MULTITABLE-INTERNAL table op (W4a) — badge drops the GET-only claim.
    confirmWrites: true,
  },
  {
    key: 'exception-queue',
    legacyMvp: true,
    zh: '异常队列',
    en: 'Exception Queue',
    zhDesc: '所有拿不准的行都在这里,可以逐条处理。拦路的问题会一直显示着,不处理就出不了最终结果。',
    enDesc: 'Everything the system is unsure about is here and can be worked through. Blocking problems stay visible and hold up the final result until they are handled.',
    endpoint: '/api/integration/stock-preparation/exceptions',
    confirmWrites: true,
  },
]

// O2 / R-11 — the tab strip IS a control surface, so it obeys the same rule as every other control:
// a tab whose panel would 403 on every action is not rendered. The six legacy MVP tabs are still
// platform-admin gated end to end, so only a platform admin sees them; a customer operator holding
// stock-prep:read sees exactly the confirmation queue this page was adopted for.
const visibleViews = computed(() => {
  const probe = (permission: string): boolean => auth.hasPermission(permission)
  return views.filter((view) => {
    if (view.legacyMvp) return canUseLegacyMvpTabs(probe)
    if (view.workbenchAdminOnly) return canOpenStockPrepInstallView(probe)
    return true
  })
})
// The landing tab is the first VISIBLE one, and activeKey can never name a hidden tab: without this
// fold an operator arriving on a stale/deep-linked legacy key would render a panel of controls that
// all 403 — the exact "visible but not actionable" failure, reintroduced through the back door.
const activeKey = ref<StockPreparationViewKey>(views[0].key)
const activeView = computed(() => {
  const visible = visibleViews.value
  if (visible.length === 0) return null
  return visible.find((view) => view.key === activeKey.value) ?? visible[0]
})
// The key the PANEL actually renders. Every panel branch below keys off this, never off the raw
// activeKey ref — otherwise a hidden legacy key would title the panel "Confirmation Queue" while
// mounting the admin-only dashboard beneath it.
const effectiveKey = computed<StockPreparationViewKey | null>(() => activeView.value?.key ?? null)

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

// H1: the dashboard's OWN picker updates the shared handle WITHOUT switching tabs — the operator
// stays on the dashboard to read the stage overview for the project they just picked (unlike view 1's
// row action above, which jumps straight to view 2).
function handleDashboardProjectSelect(projectId: string): void {
  selectedProjectId.value = projectId
  void router.replace({ query: { ...route.query, projectId } })
}

// H2: the stepper / recommend-action navigates by reusing this SAME activeKey ref — a satellite of
// the one tab-nav surface, never a second one. viewKey is a plain string at the stageOverview.ts
// boundary (STOCK_PREPARATION_STAGE_VIEW_KEY) to avoid a circular type import; every value it can
// hold is one of this file's own StockPreparationViewKey literals.
function handleNavigateStage(viewKey: string): void {
  activeKey.value = viewKey as StockPreparationViewKey
}

/**
 * 项目接入's 「到多维表看数据」. The shell owns routing, and it routes to the multitable HOME rather
 * than to the sheet the import just wrote: the sheetId is a physical handle the values-free read
 * surfaces deliberately never hand to the browser, so there is nothing here to compose a deep link
 * from — and inventing one is how a link ends up pointing at another customer's table.
 */
function handleOpenMultitable(): void {
  void router.push({ path: '/multitable' })
}

/** What the panel's endpoint badge claims. One expression, so no tab can claim the wrong shape. */
function badgeLabel(view: StockPreparationViewTab): string {
  if (view.provisioning) return bi('读清单 + 幂等建表(管理员)', 'manifest read + idempotent ensure (admin)')
  if (view.confirmWrites) return bi('只读 + 人工确认', 'readonly + human confirm')
  return `${bi('只读', 'readonly')} · GET`
}

/**
 * THE SAME FACT AS `badgeLabel`, said to the person who has to trust it rather than to the reviewer
 * who has to audit it. It is derived from the identical two flags, so the two can never disagree —
 * and the badge itself is still one click away in the disclosure beside this line, because "readonly
 * · GET" is what an implementer matches against the route table.
 */
function effectLabel(view: StockPreparationViewTab): string {
  if (view.provisioning) {
    return bi(
      '这一页会读取安装清单;建表由平台管理员执行,重复运行不会重复建。',
      'This tab reads the install manifest. Creating tables is a platform administrator\'s action, and running it again creates nothing twice.',
    )
  }
  if (view.confirmWrites) {
    return bi(
      '这一页可以由您做确认。确认的结果只写进本系统自己的表,不会写到 ERP/K3。',
      'You can confirm things on this tab. What you confirm is written only into this system\'s own tables, never into ERP/K3.',
    )
  }
  return bi('这一页只看不改:不会改动任何数据。', 'This tab only looks: it changes no data.')
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

.stock-prep__boundary-text {
  margin: 0;
}

.stock-prep__panel-endpoint {
  margin: 0 0 var(--ms-space-3);
  font-size: 12px;
  color: var(--ms-text-3);
}

.stock-prep__panel-effect {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
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
