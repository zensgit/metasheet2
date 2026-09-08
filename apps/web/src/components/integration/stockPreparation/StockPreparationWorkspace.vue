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

    <!-- P1-1 (设计稿 §2.2 / D3=A): the horizontal strip became a GROUPED LEFT RAIL. It is the same
         tablist under the same testids — see StockPreparationRail.vue's header — so what moved is the
         direction and the grouping, not the navigation contract. The FILTERED list is still computed
         here (`visibleViews`), because permission decisions belong beside the predicates and not
         inside a presentational component. -->
    <div class="stock-prep__layout">
      <StockPreparationRail
        :groups="railGroups"
        :active-key="effectiveKey"
        @select="handleRailSelect"
      />

      <div class="stock-prep__content">
    <!--
      D2=A, THE HELD LANDING. For a workbench-admin the landing depends on ONE read — the existing
      read-tier deployment preflight — and that read has not answered yet on first paint. Rendering
      「开始使用」 and then jumping to 「记录与排查」 a round-trip later would move the page under the
      reader's cursor on every single load of an installed deployment, so the panel waits instead and
      says why. The wait is bounded by the request: success, refusal and network failure all settle it
      (see `deploymentReady`), and 「读不到」 settles it to 开始使用, never to 记录与排查.

      NOBODY BELOW THAT TIER EVER WAITS. `landingPending` is false for an operator and for a queue
      watcher — their landing needs no read at all — so this line is not on the floor's path.
    -->
    <p
      v-if="landingPending"
      class="stock-prep__landing-pending"
      data-testid="stock-prep-landing-pending"
      role="status"
    >
      {{ bi(
        '正在确认这套部署装到哪一步,好把您送到该去的地方……',
        'Checking how far this deployment has got, so you land in the right place…',
      ) }}
    </p>
    <section
      v-else-if="activeView"
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
      <!-- 项目备料页 — the operator's single page. It composes the existing panels; the shell keeps
           owning routing and the shared project context, exactly as it does for every other tab. -->
      <!-- 今天要处理 AND 项目备料 ARE ONE BRANCH, ON PURPOSE.
           P0 shipped the task home INSIDE this component, keyed on 「?projectNo= 无值即首页」. P1-1
           gives the home its own rail item WITHOUT reimplementing it: `home` is this same component
           with the number withheld, `project-board` is it with the number passed. One branch rather
           than two means switching between them changes a PROP, not a component — the view is not
           torn down and rebuilt, its directory read is not paid twice, and `?tab=project-board` with
           no number still renders the home page exactly as every existing link and spec expects. -->
      <StockPreparationProjectBoardView
        v-if="effectiveKey === 'home' || effectiveKey === 'project-board'"
        :scope="scope"
        :project-no="effectiveKey === 'home' ? '' : selectedProjectNo"
        @navigate-stage="handleNavigateStage"
        @open-multitable="handleOpenFillTarget"
        @select-project-no="handleProjectNoSelect"
      />
      <!-- 确认队列's two platform-admin controls (建账本 / 重新扫描) emit; the SHELL calls. They
           emitted into nothing until now, so pressing either did nothing and said nothing — the
           purest form of a control that lies about what it does. The shell is the listener because
           the shell already owns every cross-tab service call on this page; the notice BELOW THE
           WHOLE TAB CHAIN is where the answer lands, values-free either way. -->
      <StockPreparationConfirmationQueueView
        v-else-if="effectiveKey === 'confirmation-queue'"
        ref="confirmationQueueEl"
        :scope="scope"
        :project-no="selectedProjectNo"
        @admin-action="handleAdminAction"
        @navigate-stage="handleNavigateStage"
      />
      <!-- §14 (multitable-application-model-20260830.md): the INSTALL page — the app's defaults laid
           out for a customer admin to confirm, the deployment preflight, and a SKIP-aware install run
           that walks the bootstrap script's own step order. Workbench-admin tier; the run control
           inside it is platform-admin because the four routes it drives are. -->
      <!-- 开始使用 — the wizard, now a rail item of its own rather than a passenger on the install
           page's first screen. It is the SAME component as 数据来源与体检 below, switched by `mode`:
           the wizard needs seven derived deployment facts and two run entry points that
           StockPreparationInstallView already owns, and lifting them up here would have been a second
           implementation of the install surface living in the shell. -->
      <StockPreparationInstallView
        v-else-if="effectiveKey === 'getting-started'"
        :scope="scope"
        mode="wizard"
        @navigate-stage="handleNavigateStage"
      />
      <StockPreparationInstallView
        v-else-if="effectiveKey === 'install'"
        :scope="scope"
        mode="review"
        @navigate-stage="handleNavigateStage"
      />
      <!-- 记录与排查 (P1-4/P1-5) — the ops panel. It shipped mounted-but-unreachable while the rail
           it belongs on was still being built; this is the wave that puts it on a rail item. Its
           scope is the shell's, like every other panel here. -->
      <StockPreparationOpsPanel
        v-else-if="effectiveKey === 'ops'"
        :scope="scope"
      />
      <!-- 帮助 — 「怎么用这个页面」(static) plus 「错误码对照」(the existing self-contained drawer).
           Two sections, one rail item: the drawer is a collapsed `<details>` of its own, so giving it
           a separate key would have been a second tab addressing one click. -->
      <div v-else-if="effectiveKey === 'help'" class="stock-prep__help" data-testid="stock-prep-help">
        <StockPreparationHelpCard
          :available-keys="visibleViewKeys"
          @navigate-stage="handleNavigateStage"
        />
        <section class="stock-prep__help-codes" data-testid="stock-prep-help-code-reference">
          <StockPreparationCodeHelpPanel />
        </section>
      </div>
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
      <!-- AFTER the whole v-if / v-else-if chain, deliberately and permanently.
           Vue attaches a `v-else-if` to its immediately preceding sibling branch, so an element
           carrying its OWN `v-if` placed between two branches does not merely render in the middle —
           it SILENTLY SPLITS THE CHAIN IN TWO. The first cut of this notice sat between the queue and
           the install branch and did exactly that: `project-board` and `confirmation-queue` became a
           chain with no `v-else`, so the "container placeholder" paragraph rendered UNDER both of the
           only two tabs an operator ever sees, and the moment a notice appeared it became the head of
           the second chain and every panel below it (install, dashboard and the six legacy tabs)
           stopped rendering. The compiler reports none of this. Keeping the notice outside the chain
           is what makes it a notice rather than a branch. -->
      <p
        v-if="adminActionNotice"
        class="stock-prep__admin-notice"
        data-testid="stock-prep-admin-action-notice"
        role="status"
      >
        {{ bi(adminActionNotice.zh, adminActionNotice.en) }}
        <code v-if="adminActionErrorCode" class="stock-prep__admin-token">{{ adminActionErrorCode }}</code>
      </p>
    </section>
      </div>
    </div>
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
import { computed, ref, watch } from 'vue'
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
import StockPreparationProjectBoardView from './StockPreparationProjectBoardView.vue'
import StockPreparationInstallView from './StockPreparationInstallView.vue'
import StockPreparationOpsPanel from './StockPreparationOpsPanel.vue'
import StockPreparationCodeHelpPanel from './StockPreparationCodeHelpPanel.vue'
import StockPreparationHelpCard from './StockPreparationHelpCard.vue'
import StockPreparationRail from './StockPreparationRail.vue'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import { useAuth } from '../../../composables/useAuth'
import {
  STOCK_PREP_RAIL_GROUPS,
  canOpenStockPrepHelp,
  canOpenStockPrepInstallView,
  canOpenStockPrepProjectBoard,
  canUseLegacyMvpTabs,
  landsOnStockPrepProjectBoard,
  stockPrepLandingKey,
} from '../../../services/integration/stockPreparation/workbenchAccess'
import { readStockPreparationPreflight } from '../../../services/integration/stockPreparation/installPlan'
import { createStockPreparationInstallApi } from '../../../services/integration/stockPreparation/installRun'
import { createStockPreparationProjectSyncApi } from '../../../services/integration/stockPreparation/projectSync'
import {
  stockPrepAdminActionPlain,
  stockPrepErrorPlain,
  type StockPrepPlainText,
} from '../../../services/integration/stockPreparation/plainLanguage'

const { locale } = useLocale()
const auth = useAuth()
const scope = getDefaultIntegrationScope()

// Same synchronous locale pattern as the rest of the integration surface (IntegrationHelpView /
// errorCodeLabels): read `locale.value` directly in the template.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

type StockPreparationViewKey =
  // P1-1's four new keys. NO OLD KEY WAS REMOVED — `project-board`, `install` and the seven legacy
  // keys all still resolve, so every existing deep link, every `navigate-stage` caller and every
  // spec that names one keeps working.
  | 'home'
  | 'getting-started'
  | 'ops'
  | 'help'
  | 'project-board'
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
  /**
   * 项目备料页. True for the project board alone. Gated on the OPERATOR tier (`stock-prep:operate` ∧
   * `stock-prep:read`) — the same tier its own board read is gated on server-side — rather than on
   * platform admin, because that is the tier every control on it is answerable to. A `stock-prep:read`
   * holder does not see it: the board carries project numbers and names, and the read tier is the
   * values-free queue-watcher tier.
   */
  operatorBoard?: boolean
  /**
   * 【帮助】. Gated on reachability alone (`canOpenStockPrepHelp` — the route's own read code):
   * the view is static copy plus the error-code dictionary, it issues no request and it names no
   * value, so there is nothing behind it that can 403.
   */
  helpOnly?: boolean
}

// Tab order follows the MVP business loop (design §"MVP Goal"). Descriptions are values-free — they
// name fields/statuses, never customer drawing numbers, material codes, or quantities.
const views: StockPreparationViewTab[] = [
  // 项目备料页 — THE PAGE THAT STRINGS THE FOUR STEPS TOGETHER, and the operator's landing view.
  //
  // Listed FIRST because it is what a floor operator came for: every PART of their flow already
  // shipped and no page put them in the order the job runs. A platform admin does NOT land here —
  // `landsOnStockPrepProjectBoard` keeps their landing on the confirmation queue, because their job
  // on this page is the queue and the install/health surfaces and moving it is a change nobody asked
  // for. That is why the landing tab is computed rather than left to "the first visible one".
  // 今天要处理 — P1-1's own rail item for the task home P0 shipped inside 项目备料. Same
  // `operatorBoard` flag as the board below, and that is not shorthand: it IS the same component,
  // the same directory read and the same tier, addressed with no project open.
  {
    key: 'home',
    operatorBoard: true,
    zh: '今天要处理',
    en: 'Today',
    zhDesc: '今天有哪些项目在等您,按「该干什么」排好。点一张卡片就进那个项目;下面还有一个按号码直接打开的入口。',
    enDesc: 'The projects waiting for you today, grouped by what they need. Click a card to open that project; there is also a box below for opening one by its number.',
    endpoint: '/api/integration/stock-preparation/operator/projects',
  },
  {
    key: 'project-board',
    operatorBoard: true,
    zh: '项目备料',
    en: 'Project Board',
    zhDesc: '一个项目,一页做完:从 PLM 把 BOM 拉过来、到多维表里填采购和仓库的进度、填完通知下一步、需要给别人时导出成 Excel。',
    enDesc: 'One project, one page: pull the BOM in from PLM, fill in purchasing and warehouse progress in the multitable, tell the next person when you are done, and export to Excel when someone needs a copy.',
    endpoint: '/api/integration/stock-preparation/projects/:projectNo/board',
    confirmWrites: true,
  },
  // O1' §附 (owner, 2026-08-29): `/stock-prep` is adopted as THE CONFIRMATION-QUEUE WORKBENCH — the
  // operator entry into the human confirmation loop. It stays the PLATFORM ADMIN's landing view (see
  // `landingKey` below) and it stays exactly as it was; everything below it is a legacy MVP surface
  // the same ruling declined to revive.
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
  // 开始使用 — the onboarding wizard, promoted out of the install page's first screen onto its own
  // rail item (设计稿 §2.2). Same tier and same component as 数据来源与体检 below.
  {
    key: 'getting-started',
    workbenchAdminOnly: true,
    zh: '开始使用',
    en: 'Getting Started',
    zhDesc: '第一次接入,按顺序走完这六步,一线就能开始用了。任何一步都能点开看 —— 这是一张地图,不是一道闸机。',
    enDesc: 'Setting up for the first time: six steps, in order, and the floor can start using it. Every step opens — this is a map, not a turnstile.',
    endpoint: '/api/platform/apps/stock-preparation',
    provisioning: true,
  },
  {
    // THE LABEL STAYS 「安装 / 体检」. 设计稿 §2.2 calls this item 「数据来源与体检」, and renaming it
    // is a copy change rather than a layout one: two other components point a reader at this tab BY
    // NAME (the board's 「请管理员在『安装 / 体检』里把表建出来」 and the wizard's paste-able TODO),
    // and one of those strings is something an admin copies into a chat window. Renaming the tab
    // without them would leave instructions naming a tab that no longer exists — see the PR body's
    // 「没做/偏离」.
    key: 'install',
    workbenchAdminOnly: true,
    zh: '安装 / 体检',
    en: 'Install / Health',
    zhDesc: '把这套部署会装的东西摆出来给您确认,然后看看还缺什么、建该建的表、再检查一次。跳过的步骤是还需要人来做的事,不是装失败了。',
    enDesc: 'Lays out what this deployment installs for you to confirm, then checks what is missing, creates what needs creating, and checks again. A skipped step is work still waiting for a person, not a failed install.',
    endpoint: '/api/platform/apps/stock-preparation',
    provisioning: true,
  },
  // 记录与排查 (设计稿 线框 E / §6.2 P1-4+P1-5). Six honest health cells plus the project-scoped
  // audit lookup. `noEndpointBadge` for the same reason the dashboard carries it: the panel
  // aggregates several existing GETs client-side and has no single endpoint to badge.
  {
    key: 'ops',
    workbenchAdminOnly: true,
    zh: '记录与排查',
    en: 'Records & Diagnostics',
    zhDesc: '上面是这套部署现在好不好 —— 没检查过的项会明说「未检查」,不涂绿也不涂红;下面按项目号查谁在什么时候动过它,那份记录涵盖哪几类动作,面板上写着。',
    enDesc: 'The top half says whether this deployment is healthy right now — anything never checked says so rather than being painted green or red. The bottom half looks up who touched a project and when, and states which kinds of action that record covers.',
    endpoint: '',
    noEndpointBadge: true,
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
  // 【帮助】— 怎么用这个页面 + 错误码对照. LAST in this array on purpose: `landingKey` falls back to
  // `visible[0]` only when no landing candidate is visible at all, and a help page is the one view
  // nobody should ever be dropped onto by default.
  {
    key: 'help',
    helpOnly: true,
    zh: '怎么用这个页面',
    en: 'How to use this page',
    zhDesc: '三段大白话:平常怎么用、第一次怎么装、出问题了去哪查。下面还有一张错误码对照表,遇到大写英文码可以直接搜。',
    enDesc: 'Three short answers in plain words: how this page is used day to day, how a deployment is set up the first time, and where to look when something goes wrong — plus a searchable reference for the all-caps error codes.',
    endpoint: '',
    noEndpointBadge: true,
  },
]

interface StockPreparationRailItemView {
  key: string
  zh: string
  en: string
}

interface StockPreparationRailGroupView {
  group: string
  zh: string
  en: string
  items: StockPreparationRailItemView[]
  advanced: StockPreparationRailItemView[]
}

/**
 * The three GROUP HEADINGS (设计稿 §2.2). They live here rather than in the manifest for the same
 * reason the tab labels do: the manifest is the values-free structure both sides mirror, and a
 * bilingual UI string is neither structural nor something the server has an opinion about.
 */
const RAIL_GROUP_LABELS: Record<string, { zh: string; en: string }> = {
  work: { zh: '工作', en: 'Work' },
  deploy: { zh: '部署与接入', en: 'Deployment' },
  help: { zh: '帮助', en: 'Help' },
}

// O2 / R-11 — the tab strip IS a control surface, so it obeys the same rule as every other control:
// a tab whose panel would 403 on every action is not rendered. The six legacy MVP tabs are still
// platform-admin gated end to end, so only a platform admin sees them; a customer operator holding
// stock-prep:read sees exactly the confirmation queue this page was adopted for.
const visibleViews = computed(() => {
  const probe = (permission: string): boolean => auth.hasPermission(permission)
  return views.filter((view) => {
    if (view.legacyMvp) return canUseLegacyMvpTabs(probe)
    if (view.workbenchAdminOnly) return canOpenStockPrepInstallView(probe)
    if (view.operatorBoard) return canOpenStockPrepProjectBoard(probe)
    if (view.helpOnly) return canOpenStockPrepHelp(probe)
    return true
  })
})

/** The visible keys as plain strings — what the help card checks its links against. */
const visibleViewKeys = computed<string[]>(() => visibleViews.value.map((view) => view.key))

/**
 * THE RAIL, ASSEMBLED. Membership and order come from `STOCK_PREP_RAIL_GROUPS` (the manifest the
 * plugin module mirrors); the labels come from `views` above; the filtering is `visibleViews`, which
 * is the one place a permission is consulted. A key present in the manifest but absent from `views`
 * simply does not render — the manifest cannot conjure a tab, only place one — and the alignment of
 * the two lists is asserted in StockPreparationRail.spec.ts rather than defended at runtime.
 */
const railGroups = computed<StockPreparationRailGroupView[]>(() => {
  const visible = visibleViews.value
  const byKey = new Map(visible.map((view) => [view.key as string, view]))
  const label = (key: string): StockPreparationRailItemView | null => {
    const view = byKey.get(key)
    return view ? { key: view.key, zh: view.zh, en: view.en } : null
  }
  const isItem = (item: StockPreparationRailItemView | null): item is StockPreparationRailItemView => item !== null
  return STOCK_PREP_RAIL_GROUPS
    .map((group) => {
      const heading = RAIL_GROUP_LABELS[group.group]
      return {
        group: group.group,
        zh: heading?.zh ?? group.group,
        en: heading?.en ?? group.group,
        items: group.items.map((item) => label(item.key)).filter(isItem),
        advanced: (group.advanced ?? []).map((key) => label(key)).filter(isItem),
      }
    })
    .filter((group) => group.items.length > 0 || group.advanced.length > 0)
})

/**
 * `?projectNo=` HAS ALREADY ANSWERED "which view", for anyone whose rail carries 项目备料.
 *
 * Declared beside the landing rather than inside it because TWO things read it: the landing itself,
 * and the D2 hold below — an admin arriving on a shared project link has nothing to wait for, so
 * making them read 「正在确认这套部署装到哪一步…」 first would be a spinner in front of an answer we
 * already have.
 *
 * (`selectedProjectNo` is declared further down. A computed body runs on first ACCESS — during
 * render — by which time every ref in this setup has been initialised.)
 */
const deepLinkedProjectBoard = computed<boolean>(() => (
  selectedProjectNo.value.length > 0
  && visibleViews.value.some((view) => view.key === 'project-board')
))

/**
 * THE LANDING TAB. It used to be "the first VISIBLE one", which was the same thing for everybody
 * because there was only one tab an operator could see. 项目备料页 makes the two audiences differ:
 * an operator lands on the board they came for, a platform admin keeps today's landing (确认队列),
 * because moving an admin's landing is a change nobody asked for.
 *
 * Computed rather than captured at setup so it survives permissions arriving after the first render,
 * and folded through `visibleViews` so it can never name a tab this principal cannot see.
 */
const landingKey = computed<StockPreparationViewKey>(() => {
  const visible = visibleViews.value
  if (visible.length === 0) return views[0].key
  const probe = (permission: string): boolean => auth.hasPermission(permission)
  // A PROJECT IN THE URL OUTRANKS EVERY LANDING RULE, D2 included.
  //
  // §2.3 makes `?projectNo=` the 首页 ⇄ 工作区 state bit and says in so many words that a reload, a
  // shared link and the back button all reopen the same project. P1-1's first cut broke that in the
  // one place it is used most: a floor operator's landing became `home`, and the `home` branch below
  // deliberately passes an EMPTY project number — so `/stock-prep?projectNo=…` painted the task list
  // and dropped the number off the screen while leaving it in the address bar, the exact
  // URL-disagrees-with-page state `handleProjectNoSelect` warns about a hundred lines down.
  //
  // Read here rather than in `stockPrepLandingKey`: the ruling that predicate mirrors is about who
  // the principal IS, and this is about what the link asked for. Folded through `visible` like every
  // other branch, so it can never name a tab this principal cannot open — a `stock-prep:read` queue
  // watcher with a number in their URL still lands on the queue, because 项目备料 is not theirs.
  //
  if (deepLinkedProjectBoard.value) return 'project-board'
  // D2=A. The whole decision is one call into workbenchAccess.ts, which is what lets the ruling be
  // asserted against the predicate and against the DOM without either restating the other.
  const preferred = stockPrepLandingKey(probe, deploymentReady.value)
  if (visible.some((view) => view.key === preferred)) return preferred as StockPreparationViewKey
  // FOLDED THROUGH `visibleViews`, always. A landing the principal cannot see would render an empty
  // page; the fallbacks below are the pre-P1 order, unchanged.
  if (landsOnStockPrepProjectBoard(probe) && visible.some((view) => view.key === 'project-board')) {
    return 'project-board'
  }
  const queue = visible.find((view) => view.key === 'confirmation-queue')
  return queue ? queue.key : visible[0].key
})

// ---------------------------------------------------------------------------
// D2=A — 「装完没有」, read ONCE, from the route that already answers it
// ---------------------------------------------------------------------------
//
// THE SOURCE IS THE EXISTING READ-TIER PREFLIGHT. `GET .../deployment/preflight` already answers
// `ready` and `blockerCount`, the install page already reads it, and D2's condition is written in
// exactly those two fields. No new endpoint, no new gate, no new shape — the shell just asks the
// same question one screen earlier so it can decide where to put the reader.
//
// THREE VALUES, AND THE THIRD IS THE POINT:
//   true   installed        -> 记录与排查
//   false  not installed    -> 开始使用
//   null   could not read   -> 开始使用
// A refusal, a 500 and an offline browser all land on `null`, and `null` goes to the wizard.
// 「看不到」 must never be rendered as 「装完了」: sending an admin to a health page for a deployment
// nobody could read would be telling them a story we do not have.
const deploymentReady = ref<boolean | null>(null)
/** True only while the ONE read is in flight, and only for a principal whose landing depends on it. */
const deploymentPending = ref(false)

/**
 * Hold the panel — not the rail — until the landing is decided. Rendering 开始使用 and jumping to
 * 记录与排查 one round-trip later would move the page under the reader on every load of an installed
 * deployment. The rail is up the whole time, so the wait costs navigation nothing; and it is bounded
 * by a request that always settles, in a `finally`.
 *
 * `activeKey` short-circuits it: the moment the reader picks a tab themselves, there is nothing left
 * to decide and the panel renders immediately even if the read is still out.
 */
const landingPending = computed<boolean>(() => (
  activeKey.value === null && deploymentPending.value && !deepLinkedProjectBoard.value
))

async function readDeploymentPosture(): Promise<void> {
  // NOTHING LEFT TO DECIDE, NOTHING READ. A `?tab=` deep link has already fixed the panel, so the
  // landing this read exists to choose is never consulted — and the two panels it would send an
  // admin to (开始使用 / 数据来源与体检) read the same preflight for themselves anyway.
  if (activeKey.value !== null) return
  const probe = (permission: string): boolean => auth.hasPermission(permission)
  // Only the tier whose landing depends on it pays for it. An operator's landing (今天要处理) and a
  // queue watcher's (确认队列) are decided from permissions alone, so they issue nothing.
  if (!canOpenStockPrepInstallView(probe)) return
  deploymentPending.value = true
  try {
    const preflight = await readStockPreparationPreflight(scope)
    deploymentReady.value = preflight.ready === true && preflight.blockerCount === 0
  } catch {
    // Values-free and SILENT (G3): this is a preload nobody asked for, so its failure degrades the
    // landing rather than producing a banner. `null` is already the honest answer.
    deploymentReady.value = null
  } finally {
    deploymentPending.value = false
  }
}

// `null` means "the operator has not chosen a tab yet", which is what lets the landing above stay
// reactive; once they click, activeKey holds their choice. It can never name a hidden tab: without
// this fold an operator arriving on a stale/deep-linked legacy key would render a panel of controls
// that all 403 — the exact "visible but not actionable" failure, reintroduced through the back door.
const activeKey = ref<StockPreparationViewKey | null>(null)
const activeView = computed(() => {
  const visible = visibleViews.value
  if (visible.length === 0) return null
  const chosen = activeKey.value
  if (chosen) {
    const hit = visible.find((view) => view.key === chosen)
    if (hit) return hit
  }
  return visible.find((view) => view.key === landingKey.value) ?? visible[0]
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

/**
 * `?tab=` — the deep link into one rail item.
 *
 * SEEDED SYNCHRONOUSLY, during setup, so a shared link paints its destination on the FIRST frame
 * rather than painting the landing and then swapping. It is read through `views` (not through a
 * literal list), so EVERY key is accepted — the four new ones and every old one, `project-board` and
 * the seven legacy keys included. An unknown value is ignored rather than treated as an error: a
 * stale link should land somewhere sensible, and `activeView` folds any key this principal cannot
 * see back to their landing anyway.
 *
 * IT IS NOT MIRRORED BACK. Switching tabs does not write `?tab=` into the URL, deliberately: the
 * shell's `router.replace` calls are part of its contract with the project-number specs (which read
 * `replace.mock.calls[0]`), and a landing-time replace would insert a call ahead of every one of
 * them. Deep links in, no URL churn out — see the PR body's 「没做/偏离」.
 */
function tabFromQuery(): StockPreparationViewKey | null {
  const raw = route.query?.tab
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || value.length === 0) return null
  const hit = views.find((view) => view.key === value)
  return hit ? hit.key : null
}

function projectIdFromQuery(): string | undefined {
  const raw = route.query?.projectId
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const selectedProjectId = ref<string | undefined>(projectIdFromQuery())

/**
 * 项目备料页's shared context. Deliberately a SECOND ref rather than a reuse of `selectedProjectId`:
 * that one holds the internal MetaSheet handle the values-free surfaces trade in, this one holds the
 * customer's own PROJECT NUMBER, and conflating a handle with a business value is exactly the
 * confusion the values-free posture exists to prevent. The number is mirrored into `?projectNo=` so a
 * reload or a shared link reopens the same project.
 */
function projectNoFromQuery(): string {
  const raw = route.query?.projectNo
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : ''
}

const selectedProjectNo = ref<string>(projectNoFromQuery())

// The `?tab=` seed, applied now that `route` exists. Synchronous — before the first render — so a
// deep link never paints the landing first.
activeKey.value = tabFromQuery()

// D2's one read, fired during setup for the same reason: the landing hold is shortest when the
// request starts before the first paint rather than in `onMounted` after it.
void readDeploymentPosture()

/**
 * P0-8's handle onto the mounted queue instance — the shell's only way to tell it "reload now" after
 * a successful admin action, since the shell (not the queue) owns the reconcile call. `null` whenever
 * the confirmation-queue tab is not the active panel; a v-else-if branch that has never rendered, or
 * has since unmounted, leaves this null and `handleAdminAction` below already guards on that.
 */
const confirmationQueueEl = ref<InstanceType<typeof StockPreparationConfirmationQueueView> | null>(null)

/** A rail click. The rail decides nothing — it names a key and this is what acts on it. */
function handleRailSelect(key: string): void {
  activeKey.value = key as StockPreparationViewKey
  // 今天要处理 MEANS 「没有项目打开」, so picking it clears the state bit that says otherwise.
  // Without this the URL keeps `?projectNo=` while the panel shows the task list, and the next
  // reload (which now honours the number — see `deepLinkedProjectBoard`) would reopen the project
  // the reader just navigated away from. The board's own 「返回今天要处理」 already goes through
  // `handleProjectNoSelect('')`; this puts the rail on the same path rather than a second one.
  if (key === 'home' && selectedProjectNo.value.length > 0) handleProjectNoSelect('')
}

function handleProjectNoSelect(projectNo: string): void {
  selectedProjectNo.value = projectNo
  // 今天要处理 ⇄ 项目备料 FOLLOW THE NUMBER. The two rail items are one component switched by a prop
  // (see the panel branch), so opening a project from the home page has to move the RAIL as well —
  // otherwise the reader presses 「打开」 and the rail still highlights 今天要处理 while the panel
  // shows a project. Compared against `effectiveKey` rather than `activeKey` because a reader who has
  // not clicked anything yet is on their LANDING, which is exactly the case this fires in most often.
  //
  // Only these two keys move. Every other caller (the queue's closure button, the dashboard, the
  // wizard) names its own destination through `handleNavigateStage` and is untouched by this.
  if (projectNo && effectiveKey.value === 'home') activeKey.value = 'project-board'
  else if (!projectNo && effectiveKey.value === 'project-board') activeKey.value = 'home'
  // Replace, not push: opening a project is not a history step.
  //
  // AN EMPTY NUMBER REMOVES THE KEY rather than writing `?projectNo=`. This is the 返回今天要处理
  // path (§2.3 makes `?projectNo=` the 首页 ⇄ 工作区 state bit), and a query that still carries an
  // empty value is not the same URL as one that carries none — reloading or sharing it would land
  // on a page whose own reading of "is a project open" disagreed with the shell's.
  const query = { ...route.query }
  if (projectNo) query.projectNo = projectNo
  else delete query.projectNo
  void router.replace({ query })
}

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
//
// P0-9: `projectNo` is a NEW, OPTIONAL third argument — every existing caller (the board's own
// stepper, the install wizard, the dashboard, the getting-started completion card) still calls this
// with one argument and is unaffected. Only the confirmation queue's `nothing_pending` closure button
// passes a number, so the destination tab reopens the SAME project rather than whatever the shell last
// had selected (§2.3's `?projectNo=` state bit) — routed through the same `handleProjectNoSelect` the
// board's own row-open path uses, so the query mirroring stays the one implementation.
function handleNavigateStage(viewKey: string, projectNo?: string): void {
  activeKey.value = viewKey as StockPreparationViewKey
  if (typeof projectNo === 'string' && projectNo.trim().length > 0) {
    handleProjectNoSelect(projectNo.trim())
  }
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

/**
 * 项目备料页's 「到多维表填写这个项目」. Unlike `handleOpenMultitable` above, this one HAS a handle to
 * route from: the board read returns `{ sheetId, viewId }`, and only when the server has proved that
 * sheet exists.
 *
 * WHAT THIS LINK DOES NOT CLAIM. It is not permission-checked here and cannot be: the plugin has no
 * user-aware multitable ACL seam, so it can say the sheet exists and nothing about who may open it.
 * MULTITABLE ENFORCES ACCESS ON LANDING. An operator without access lands on multitable's own
 * refusal, which is the right place for that answer to come from.
 *
 * No `?filter=` is composed. A transient per-project filter would need a non-persisting overlay in
 * the multitable view model that does not exist today — see the PR body — and inventing a query
 * param the workbench ignores would be a link that quietly lies about what it does.
 *
 * NO HANDLE STILL GOES SOMEWHERE. `null` (or a malformed handle) falls back to the plain multitable
 * route — the exact destination `handleOpenMultitable` above uses for the legacy tab. The board's
 * composed sync panel renders its own 「到多维表看数据」 off the run verdict, which knows nothing
 * about deep-link handles, so without this fallback that button was a silent no-op on this tab.
 */
function handleOpenFillTarget(target: { sheetId: string; viewId: string } | null): void {
  if (!target || !target.sheetId || !target.viewId) {
    void router.push({ path: '/multitable' })
    return
  }
  void router.push({
    path: `/multitable/${encodeURIComponent(target.sheetId)}/${encodeURIComponent(target.viewId)}`,
  })
}

// ---------------------------------------------------------------------------
// 确认队列's two platform-admin buttons — THE WIRING
// ---------------------------------------------------------------------------
//
// WHAT WAS BROKEN. `StockPreparationConfirmationQueueView` renders 建立确认账本 and 重新扫描待确认的事
// behind the PLATFORM_ADMIN_GATE and emitted `admin-action` for both. This shell — the component's
// only mount point — declared no listener, so both clicks were swallowed: no request, no error, no
// notice. A control that is visible, enabled and inert is worse than an absent one, because the
// admin who presses it believes the ensure ran.
//
// WHAT THIS DOES NOT CHANGE. The buttons' VISIBILITY is untouched: it stays on
// `STOCK_PREP_WORKBENCH_CAPABILITIES`' PLATFORM_ADMIN_GATE, evaluated inside the queue component, so
// an operator still never sees either. This adds the calls behind them and nothing else.
//
// WHICH CLIENTS. Both already existed and neither is re-implemented here:
//   * ensure    -> `createStockPreparationInstallApi(scope).ensureConfirmationLedger()`, the same
//                  idempotent POST the install tab's run drives (body strictly empty: the staging
//                  project is auth-derived, and a request projectId would be a steering vector).
//   * reconcile -> `createStockPreparationProjectSyncApi(scope).reconcile(projectNo)`, the same call
//                  step 2 of 从PLM拉取 makes, on the same frozen pull-bom action id.
//
// VALUES-FREE. The notice is one of three fixed sentences (plainLanguage's admin-action table) or the
// error table's sentence for a clamped code; a returned count, a project number or a part number
// never reaches it. The raw code is rendered beside the sentence, in the same shape the queue's own
// error line uses, because that token is what a person quotes when they ask for help.
//
// WHICH FAILURES CARRY A CODE, stated exactly rather than generously: the reconcile client throws an
// error that carries the server's `code`, so a refusal renders its own sentence plus that token. The
// INSTALL client's error type (`StockPreparationInstallCallError`) carries a status and nothing else
// by design, so an ensure failure renders the error table's generic sentence with NO token beside it.
// That is the honest rendering of what the client actually knows — not a gap to paper over here.
const adminActionNotice = ref<StockPrepPlainText | null>(null)
/** Non-null ONLY on a failure — it is the code shown beside the sentence, never a success marker. */
const adminActionErrorCode = ref<string | null>(null)
/** Guards a double-press from queueing a second identical run while the first is still in flight. */
const adminActionBusy = ref(false)

/** Identifier-shaped codes only: a server message must never reach the screen through this field. */
const ADMIN_ACTION_ERROR_CODE = /^[A-Z0-9_]{1,80}$/

function adminActionCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && ADMIN_ACTION_ERROR_CODE.test(code) ? code : null
}

async function handleAdminAction(action: 'ensure' | 'reconcile', projectNo: string): Promise<void> {
  if (adminActionBusy.value) return
  const trimmed = typeof projectNo === 'string' ? projectNo.trim() : ''
  // reconcile is scoped to ONE project server-side. Saying so here beats sending a request that can
  // only come back as a shapeless 400.
  if (action === 'reconcile' && trimmed.length === 0) {
    adminActionErrorCode.value = null
    adminActionNotice.value = stockPrepAdminActionPlain('PROJECT_NO_REQUIRED')
    return
  }
  adminActionBusy.value = true
  adminActionNotice.value = null
  adminActionErrorCode.value = null
  try {
    if (action === 'ensure') {
      await createStockPreparationInstallApi(scope).ensureConfirmationLedger()
      adminActionNotice.value = stockPrepAdminActionPlain('ENSURE_OK')
      // P0-8's other half. The one fact this changes on the queue's screen is `ledgerReady`, and that
      // arrives in the DIRECTORY payload — so the DIRECTORY is what has to be re-read. Reloading the
      // queue instead would change nothing: the `ledger_missing` empty state (and its 去装 button)
      // would stay put until a manual refresh, which is the dead end this wave exists to close, back
      // one action later. The queue list itself is deliberately NOT re-read here — 建账本 needs no
      // project number, and firing a queue read without one is a request that can only 400.
      void confirmationQueueEl.value?.loadDirectory?.()
    } else {
      await createStockPreparationProjectSyncApi(scope).reconcile(trimmed)
      adminActionNotice.value = stockPrepAdminActionPlain('RECONCILE_OK')
      // P0-8: action → result → AUTO-RELOAD. A successful reconcile rescans the confirmation ledger
      // server-side, so the queue this admin is looking at is now stale the instant this resolves —
      // reload it on their behalf rather than leaving a "these numbers may be old" gap the old copy
      // used to paper over with "click refresh again". `?.` because the queue tab may have been
      // navigated away from while this request was in flight; a reload aimed at an unmounted instance
      // is simply skipped, never an error.
      void confirmationQueueEl.value?.loadQueue?.()
    }
  } catch (error) {
    const code = adminActionCodeOf(error)
    adminActionErrorCode.value = code
    // `stockPrepErrorPlain` falls back to its own generic for an unknown/absent code, so there is no
    // state in which the notice renders empty after a failure.
    adminActionNotice.value = stockPrepErrorPlain(code ?? '')
  } finally {
    adminActionBusy.value = false
  }
}

// The notice answers ONE press on ONE tab, so it dies with that tab. Without this it survives every
// later navigation: an admin who pressed 建账本 would carry "确认账本已经就位" onto the install page,
// the dashboard and every legacy tab until the page was reloaded — a stale sentence about a screen
// the reader is no longer on.
watch(effectiveKey, () => {
  adminActionNotice.value = null
  adminActionErrorCode.value = null
})

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

/* 左栏 + 右侧内容。窄屏(<900px)折成上下两段 —— DOM 不变,rail 仍是同一个 tablist。
   容器无条件渲染:R11 记的是 ApprovalCenterView 那次把分栏容器做成有条件的 no-op div 的事故。 */
.stock-prep__layout {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: var(--ms-space-4);
  align-items: start;
}

@media (max-width: 899px) {
  .stock-prep__layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

.stock-prep__content {
  min-width: 0;
}

.stock-prep__landing-pending {
  margin: 0;
  padding: var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
  color: var(--ms-text-3);
  font-size: 13px;
}

.stock-prep__help {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4);
}

.stock-prep__help-codes {
  padding-top: var(--ms-space-2);
  border-top: 1px solid var(--ms-border-light);
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

.stock-prep__admin-notice {
  margin: var(--ms-space-3) 0 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep__admin-token {
  margin-left: var(--ms-space-2);
  font-size: 12px;
  color: var(--ms-text-3);
}
</style>
