<template>
  <div class="sp-ops" data-testid="stock-prep-ops-panel">
    <!-- =====================================================================
         「这套部署现在好不好」— six honest cells, never a full-page red.
         G3/§6.2 P1-5: each cell that fails to load renders ITS OWN "看不了 + 谁能看" line; nothing
         here throws, and no OTHER cell is affected by one cell's failure (Promise.allSettled, below,
         plus a monotonic `healthSeq` so a stale reload can never overwrite a newer one).
         ===================================================================== -->
    <section class="sp-ops__block" data-testid="stock-prep-ops-health">
      <h3 class="sp-ops__h3">{{ bi('这套部署现在好不好', 'Is this deployment healthy right now') }}</h3>

      <ul class="sp-ops__cells">
        <!-- ① 数据源 — auto, admin tier. -->
        <li class="sp-ops__cell" data-testid="stock-prep-ops-cell-source" :data-cell-status="sourceCell.status">
          <span class="sp-ops__cell-label">{{ bi('数据源', 'Data source') }}</span>
          <span class="sp-ops__cell-badge" :class="`sp-ops__cell-badge--${sourceTone}`">{{ sourceSummary }}</span>
          <button
            type="button"
            class="sp-ops__cell-action"
            data-testid="stock-prep-ops-cell-source-refresh"
            :disabled="sourceCell.status === 'loading'"
            @click="onRefreshSource"
          >
            {{ bi('按需重新体检', 'Re-check') }}
          </button>
        </li>

        <!-- ② 建表/装包 — auto, admin tier. Two independent reads (catalog, installs) plus a THIRD
             read (sandbox readiness) that only fires once the catalog names an objectId — see
             deploymentHealth.ts's header for why that third read cannot run in parallel with the
             other two. -->
        <li class="sp-ops__cell" data-testid="stock-prep-ops-cell-packs" :data-cell-status="packsCellStatus">
          <span class="sp-ops__cell-label">{{ bi('建表/装包', 'Tables & packs') }}</span>
          <span class="sp-ops__cell-badge" :class="`sp-ops__cell-badge--${packsTone}`">{{ packsSummary }}</span>
        </li>

        <!-- ③ 部署自检 — manual, stock-prep:read tier. Feeds ⑤ 四条硬边界 below (same payload). -->
        <li class="sp-ops__cell" data-testid="stock-prep-ops-cell-preflight" :data-cell-status="preflightCell.status">
          <span class="sp-ops__cell-label">{{ bi('部署自检', 'Deployment self-check') }}</span>
          <span class="sp-ops__cell-badge" :class="`sp-ops__cell-badge--${preflightTone}`">{{ preflightSummary }}</span>
          <button
            type="button"
            class="sp-ops__cell-action"
            data-testid="stock-prep-ops-cell-preflight-check"
            :disabled="preflightCell.status === 'loading'"
            @click="onCheckPreflight"
          >
            {{ bi('现在检查', 'Check now') }}
          </button>
        </li>

        <!-- ④ 源就绪预检 — manual, integration-read tier. Reads the CUSTOMER's own system, so it
             never fires on its own (D6). -->
        <li class="sp-ops__cell" data-testid="stock-prep-ops-cell-source-preflight" :data-cell-status="sourcePreflightCell.status">
          <span class="sp-ops__cell-label">{{ bi('源就绪预检', 'Source readiness check') }}</span>
          <span class="sp-ops__cell-badge" :class="`sp-ops__cell-badge--${sourcePreflightTone}`">{{ sourcePreflightSummary }}</span>
          <button
            type="button"
            class="sp-ops__cell-action"
            data-testid="stock-prep-ops-cell-source-preflight-check"
            :disabled="sourcePreflightCell.status === 'loading'"
            @click="onCheckSourcePreflight"
          >
            {{ bi('现在检查', 'Check now') }}
          </button>
          <p class="sp-ops__cell-note">{{ bi('ⓘ 这会去读客户的库,按需跑。', 'ⓘ This reads the customer\'s own database — run it only when you need to.') }}</p>
          <StockPrepTechnicalDetails
            v-if="sourceCheckRows.length > 0"
            :label="bi('看明细', 'Details')"
            testid="stock-prep-ops-cell-source-preflight-detail"
          >
            <ul class="sp-ops__fence-list">
              <li v-for="row in sourceCheckRows" :key="row.id" data-testid="stock-prep-ops-source-check-row">
                <span v-if="sourceCheckPlain(row.id)">{{ bi(sourceCheckPlain(row.id)!.zh, sourceCheckPlain(row.id)!.en) }}</span>
                <span v-else><code>{{ row.id }}</code></span>
                <em>{{ row.unknown ? bi('未评估', 'not checked') : (row.ok ? bi('是', 'yes') : bi('否', 'no')) }}</em>
                <code>{{ row.token }}</code>
              </li>
            </ul>
          </StockPrepTechnicalDetails>
        </li>

        <!-- ⑤ 四条硬边界 — derived from ③'s own payload (`preflight.posture`), never a second call. -->
        <li class="sp-ops__cell" data-testid="stock-prep-ops-cell-fences" :data-cell-status="preflightCell.status">
          <span class="sp-ops__cell-label">{{ bi('四条硬边界', 'The four fences') }}</span>
          <span class="sp-ops__cell-badge" :class="`sp-ops__cell-badge--${fencesTone}`">{{ fencesSummary }}</span>
          <StockPrepTechnicalDetails
            v-if="fenceRows.length > 0"
            :label="bi('看明细', 'Details')"
            testid="stock-prep-ops-cell-fences-detail"
          >
            <ul class="sp-ops__fence-list">
              <li v-for="fence in fenceRows" :key="fence.id" data-testid="stock-prep-ops-fence-row">
                <span v-if="stockPrepPosturePlain(fence.id)">{{ bi(stockPrepPosturePlain(fence.id)!.zh, stockPrepPosturePlain(fence.id)!.en) }}</span>
                <span v-else><code>{{ fence.id }}</code></span>
                <em>{{ fenceStateLabel(fence.state) }}</em>
              </li>
            </ul>
          </StockPrepTechnicalDetails>
        </li>

        <!-- ⑥ 计划任务 — ALWAYS this sentence (D7/G4). No network call; no colour that could lie. -->
        <li class="sp-ops__cell" data-testid="stock-prep-ops-cell-scheduled-task" data-cell-status="not_monitored">
          <span class="sp-ops__cell-label">{{ bi('计划任务', 'Scheduled task') }}</span>
          <span class="sp-ops__cell-badge sp-ops__cell-badge--neutral">{{ bi(scheduledTaskText.zh, scheduledTaskText.en) }}</span>
          <p class="sp-ops__cell-note">ⓘ {{ bi(scheduledTaskText.zhNext || '', scheduledTaskText.enNext || '') }}</p>
        </li>
      </ul>
    </section>

    <!-- =====================================================================
         「谁在什么时候动过这个项目」— admin-tier reverse lookup. Project-number-scoped ON PURPOSE
         (audit.ts's header explains why); the three-line disclaimer is a SIBLING of every branch
         below, never nested inside one, so it renders before a search, during a search, and after
         one — R6.
         ===================================================================== -->
    <section class="sp-ops__block" data-testid="stock-prep-ops-audit">
      <h3 class="sp-ops__h3">{{ bi('谁在什么时候动过这个项目', 'Who touched this project, and when') }}</h3>

      <form class="sp-ops__audit-form" data-testid="stock-prep-ops-audit-form" @submit.prevent="onAuditSearch">
        <label class="sp-ops__field">
          <span>{{ bi('项目号', 'Project number') }}</span>
          <input
            v-model="auditProjectNo"
            type="text"
            data-testid="stock-prep-ops-audit-project-input"
            :placeholder="bi('输入项目号', 'Type a project number')"
          >
        </label>
        <label class="sp-ops__field">
          <span>{{ bi('动作', 'Action') }}</span>
          <select v-model="auditAction" data-testid="stock-prep-ops-audit-action-select">
            <option value="">{{ bi('全部', 'All') }}</option>
            <option v-for="action in STOCK_PREP_AUDIT_PROJECT_SCOPED_ACTIONS" :key="action" :value="action">
              {{ auditActionLabel(action) }}
            </option>
          </select>
        </label>
        <button
          type="submit"
          class="sp-ops__audit-search"
          data-testid="stock-prep-ops-audit-search"
          :disabled="!canSearchAudit"
        >
          {{ bi('查一下', 'Look it up') }}
        </button>
      </form>

      <p v-if="auditLoading" role="status" data-testid="stock-prep-ops-audit-loading">{{ bi('正在查…', 'Looking it up…') }}</p>

      <template v-else-if="auditOutcome">
        <p v-if="auditForbidden" class="sp-ops__audit-forbidden" data-testid="stock-prep-ops-audit-forbidden">
          {{ bi(STOCK_PREP_AUDIT_FORBIDDEN.zh, STOCK_PREP_AUDIT_FORBIDDEN.en) }}
        </p>
        <p v-else-if="auditFailed" class="sp-ops__audit-error" data-testid="stock-prep-ops-audit-error">
          {{ bi(STOCK_PREP_OPS_CELL_UNAVAILABLE.zh, STOCK_PREP_OPS_CELL_UNAVAILABLE.en) }}
          <button type="button" data-testid="stock-prep-ops-audit-retry" @click="onAuditSearch">{{ bi('重试', 'Retry') }}</button>
        </p>
        <template v-else-if="auditSucceeded">
          <EmptyState
            v-if="auditEntries.length === 0"
            data-testid="stock-prep-ops-audit-empty"
            data-empty-state="no_entries"
            :title="bi(STOCK_PREP_AUDIT_EMPTY.zh, STOCK_PREP_AUDIT_EMPTY.en)"
            :hint="bi(STOCK_PREP_AUDIT_EMPTY.zhNext || '', STOCK_PREP_AUDIT_EMPTY.enNext || '')"
          />
          <ul v-else class="sp-ops__audit-list" data-testid="stock-prep-ops-audit-list">
            <li
              v-for="entry in auditEntries"
              :key="entry.id"
              class="sp-ops__audit-row"
              data-testid="stock-prep-ops-audit-row"
              :data-self="entry.isSelf ? 'true' : 'false'"
            >
              <span data-testid="stock-prep-ops-audit-row-time">{{ formatAuditTime(entry.createdAt) }}</span>
              <span data-testid="stock-prep-ops-audit-row-action">{{ auditActionLabel(entry.action) }}</span>
              <span data-testid="stock-prep-ops-audit-row-who">
                {{ entry.isSelf ? bi(STOCK_PREP_AUDIT_ACTOR_SELF.zh, STOCK_PREP_AUDIT_ACTOR_SELF.en) : bi(STOCK_PREP_AUDIT_ACTOR_OTHER.zh, STOCK_PREP_AUDIT_ACTOR_OTHER.en) }}
              </span>
              <!-- `actor`/`subjectId`/`mode`/`detail` live ONLY here, inside the disclosure — never
                   in the three spans above (F11 / G8). -->
              <StockPrepTechnicalDetails :label="bi('详情', 'Details')" testid="stock-prep-ops-audit-row-detail">
                <dl>
                  <dt>{{ bi('动作代码', 'Action code') }}</dt>
                  <dd><code>{{ entry.action }}</code></dd>
                  <!-- 内部操作者标识 (`actor`) IS shown here — verbatim per the design's own rule 2:
                       "actor 原值…一律进技术详情". It is an internal handle (user id, occasionally an
                       email fallback), never a resolved display name — see plainLanguage.ts's X1 note
                       on why a NAME is never derived from it. The guardrail this panel enforces is
                       that the PRIMARY row (the three spans above) never renders it — this disclosure
                       is the one place it may appear. -->
                  <dt v-if="entry.technical.actor">{{ bi('内部操作者标识', 'Internal actor handle') }}</dt>
                  <dd v-if="entry.technical.actor"><code>{{ entry.technical.actor }}</code></dd>
                  <dt v-if="entry.technical.subjectId">{{ bi('对象编号', 'Subject id') }}</dt>
                  <dd v-if="entry.technical.subjectId"><code>{{ entry.technical.subjectId }}</code></dd>
                  <dt v-if="entry.technical.mode">{{ bi('模式', 'Mode') }}</dt>
                  <dd v-if="entry.technical.mode"><code>{{ entry.technical.mode }}</code></dd>
                  <dt v-if="Object.keys(entry.technical.detail).length > 0">{{ bi('明细', 'Detail') }}</dt>
                  <dd v-if="Object.keys(entry.technical.detail).length > 0"><code>{{ JSON.stringify(entry.technical.detail) }}</code></dd>
                </dl>
              </StockPrepTechnicalDetails>
            </li>
          </ul>
        </template>
      </template>

      <!-- THE THREE LINES. Always rendered whenever this section is, in every branch above. -->
      <ul class="sp-ops__audit-caveats" data-testid="stock-prep-ops-audit-caveats">
        <li data-testid="stock-prep-ops-audit-caveat">{{ bi(STOCK_PREP_AUDIT_CAVEAT_SCOPE.zh, STOCK_PREP_AUDIT_CAVEAT_SCOPE.en) }}</li>
        <li data-testid="stock-prep-ops-audit-caveat">{{ bi(STOCK_PREP_AUDIT_CAVEAT_LIMIT.zh, STOCK_PREP_AUDIT_CAVEAT_LIMIT.en) }}</li>
        <li data-testid="stock-prep-ops-audit-caveat">{{ bi(STOCK_PREP_AUDIT_CAVEAT_LEGACY.zh, STOCK_PREP_AUDIT_CAVEAT_LEGACY.en) }}</li>
      </ul>
    </section>

    <!-- =====================================================================
         「数据落在哪」— static orientation, plus whatever the ②建表/装包 cell already read (no
         third fetch of its own).
         ===================================================================== -->
    <section class="sp-ops__block" data-testid="stock-prep-ops-data-location">
      <h3 class="sp-ops__h3">{{ bi('数据落在哪', 'Where the data lands') }}</h3>
      <p data-testid="stock-prep-ops-data-location-summary">
        {{ bi(
          '备料主表 · 人工填的列(拉取与写入从不覆盖这些列)',
          'The 备料 main table · the manually-filled columns (pulls and writes never overwrite these)',
        ) }}
      </p>
      <p class="sp-ops__cell-note">
        {{ bi(
          'ⓘ 打开的是全工厂共用的备料主表,请在表里按项目号找您那一份。',
          'ⓘ This opens the shop-wide shared 备料 table — find your row inside it by project number.',
        ) }}
      </p>
      <StockPrepTechnicalDetails :label="bi('技术详情', 'Technical details')" testid="stock-prep-ops-data-location-tech">
        <dl>
          <dt v-if="dataLocationObjectId">{{ bi('表内部编号', 'Table internal id') }}</dt>
          <dd v-if="dataLocationObjectId"><code>{{ dataLocationObjectId }}</code></dd>
          <dt v-if="dataLocationPack">{{ bi('装了哪个包版本', 'Installed pack version') }}</dt>
          <dd v-if="dataLocationPack"><code>{{ dataLocationPack.packId }}@{{ dataLocationPack.packVersion ?? '—' }}</code></dd>
          <p v-if="!dataLocationObjectId && !dataLocationPack">
            {{ bi('还没有读到装包记录 —— 见上面「建表/装包」格。', 'No install record read yet — see the "Tables & packs" tile above.') }}
          </p>
        </dl>
      </StockPrepTechnicalDetails>
    </section>
  </div>
</template>

<script setup lang="ts">
// 「记录与排查」面板 (P1-4/P1-5, 设计稿 §6.2 + 线框 E) — 暗装 in this wave: the component and its two
// new services are complete and tested, but nothing mounts this file yet (no rail exists — D3 is
// P1-1's job). See the PR body for the wiring plan.
//
// THREE BLOCKS, THREE DIFFERENT HONESTY PROBLEMS:
//   1. 健康六格 — G4's third state (未检查 ≠ 绿/红) and G3's per-cell isolation (`allSettled`, never
//      a page-wide red banner over one failed read).
//   2. 谁在什么时候动过这个项目 — R6: three lines that must render in EVERY state or a reader
//      concludes "no rows" means "nobody touched it", which is false three separate ways.
//   3. 数据落在哪 — reuses ①/②'s already-fetched data; issues no read of its own.
//
// VALUES-FREE THROUGHOUT. Every string on screen is an id, an enum, a count, or a bilingual constant
// authored in plainLanguage.ts. The one caller-supplied string this component ever puts in the DOM
// is the project number the ADMIN TYPED into the audit search box — never a value read back off a
// server response.
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import EmptyState from '../../status/EmptyState.vue'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  readStockPreparationSourceBinding,
  type StockPreparationSourceBindingView,
} from '../../../services/integration/stockPreparation/sourceBinding'
import {
  readStockPreparationPreflight,
  type StockPreparationPreflight,
} from '../../../services/integration/stockPreparation/installPlan'
import {
  readStockPreparationSourcePreflight,
  stockPrepSourceCheckRows,
  type StockPrepSourcePreflight,
} from '../../../services/integration/stockPreparation/sourcePreflight'
import {
  readStockPreparationCustomerPackCatalog,
  readStockPreparationCustomerPackInstalls,
  readStockPreparationSandboxTargetReadiness,
  type StockPrepCustomerPackCatalog,
  type StockPrepCustomerPackInstallList,
  type StockPrepSandboxTargetReadiness,
} from '../../../services/integration/stockPreparation/deploymentHealth'
import {
  listStockPreparationAudit,
  STOCK_PREP_AUDIT_PROJECT_SCOPED_ACTIONS,
  type StockPrepAuditListOutcome,
} from '../../../services/integration/stockPreparation/audit'
import {
  STOCK_PREP_AUDIT_ACTOR_OTHER,
  STOCK_PREP_AUDIT_ACTOR_SELF,
  STOCK_PREP_AUDIT_CAVEAT_LEGACY,
  STOCK_PREP_AUDIT_CAVEAT_LIMIT,
  STOCK_PREP_AUDIT_CAVEAT_SCOPE,
  STOCK_PREP_AUDIT_EMPTY,
  STOCK_PREP_AUDIT_FORBIDDEN,
  STOCK_PREP_OPS_CELL_UNAVAILABLE,
  STOCK_PREP_OPS_CELL_UNCHECKED,
  STOCK_PREP_OPS_NEEDS_ADMIN,
  STOCK_PREP_OPS_NEEDS_INTEGRATION_READ,
  STOCK_PREP_OPS_SCHEDULED_TASK_UNMONITORED,
  stockPrepAuditActionPlain,
  stockPrepPosturePlain,
  stockPrepSourceCheckPlain,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = withDefaults(defineProps<{ scope?: IntegrationScope }>(), { scope: () => ({}) })

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const scope = computed<IntegrationScope>(() => props.scope ?? {})
const scheduledTaskText = STOCK_PREP_OPS_SCHEDULED_TASK_UNMONITORED

// ---------------------------------------------------------------------------
// Generic cell-loading plumbing. `status` is the FETCH lifecycle (what a spec asserts allSettled
// isolation and the 未检查 neutral state against); tone computeds below turn a successfully loaded
// cell's DATA into a colour, which is a separate axis on purpose — a cell can be `status: 'ready'`
// and still be `tone: 'warning'` (e.g. preflight ran and found blockers).
// ---------------------------------------------------------------------------
type CellStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'forbidden'

interface CellState<T> {
  status: CellStatus
  data: T | null
}

function idleCell<T>(): CellState<T> {
  return { status: 'idle', data: null }
}

function loadingCell<T>(previous: T | null = null): CellState<T> {
  return { status: 'loading', data: previous }
}

function statusOfError(error: unknown): number {
  if (error && typeof error === 'object' && 'status' in error) {
    const value = (error as { status?: unknown }).status
    if (typeof value === 'number') return value
  }
  return 0
}

function cellFromError<T>(error: unknown): CellState<T> {
  return { status: statusOfError(error) === 403 ? 'forbidden' : 'unavailable', data: null }
}

function cellFromSettled<T>(result: PromiseSettledResult<T>): CellState<T> {
  if (result.status === 'fulfilled') return { status: 'ready', data: result.value }
  return cellFromError<T>(result.reason)
}

/** The one sentence a failed cell shows, whatever it needs. Never a raw status/message. */
function unavailableText(status: CellStatus, needs: { zh: string; en: string } = STOCK_PREP_OPS_NEEDS_ADMIN): string {
  if (status === 'forbidden') return bi(needs.zh, needs.en)
  return bi(STOCK_PREP_OPS_CELL_UNAVAILABLE.zh, STOCK_PREP_OPS_CELL_UNAVAILABLE.en)
}

// ---------------------------------------------------------------------------
// ① 数据源
// ---------------------------------------------------------------------------
const sourceCell = ref<CellState<StockPreparationSourceBindingView>>(idleCell())

const sourceSummary = computed(() => {
  if (sourceCell.value.status === 'loading') return bi('正在读取…', 'Reading…')
  if (sourceCell.value.status === 'forbidden' || sourceCell.value.status === 'unavailable') {
    return unavailableText(sourceCell.value.status)
  }
  const data = sourceCell.value.data
  if (!data) return bi(STOCK_PREP_OPS_CELL_UNCHECKED.zh, STOCK_PREP_OPS_CELL_UNCHECKED.en)
  if (data.origin === 'unconfigured') return bi('未配置任何数据源', 'No data source configured')
  const candidate = data.eligibleSources.find((source) => source.externalSystemId === data.effectiveExternalSystemId)
  const name = candidate?.name || data.effectiveExternalSystemId || bi('未命名', 'unnamed')
  const verb = data.origin === 'persisted' ? bi('已绑定', 'Bound to') : bi('使用默认源', 'Using the default source')
  return `${verb}「${name}」`
})

const sourceTone = computed(() => {
  if (sourceCell.value.status !== 'ready') return 'neutral'
  const origin = sourceCell.value.data?.origin
  if (origin === 'persisted') return 'success'
  if (origin === 'deploy_default') return 'warning'
  return 'neutral'
})

async function onRefreshSource(): Promise<void> {
  if (sourceCell.value.status === 'loading') return
  sourceCell.value = loadingCell(sourceCell.value.data)
  try {
    const data = await readStockPreparationSourceBinding(scope.value)
    sourceCell.value = { status: 'ready', data }
  } catch (error) {
    sourceCell.value = cellFromError(error)
  }
}

// ---------------------------------------------------------------------------
// ② 建表/装包 — catalog + installs in parallel, sandbox readiness sequential after (see
// deploymentHealth.ts). `packsCellStatus`/`packsTone` fold all three into ONE cell reading, because
// the wireframe draws this as a single row — a per-sub-read status still lives on each ref below for
// the "one piece failed, the rest still renders" test.
// ---------------------------------------------------------------------------
const catalogCell = ref<CellState<StockPrepCustomerPackCatalog>>(idleCell())
const installsCell = ref<CellState<StockPrepCustomerPackInstallList>>(idleCell())
const sandboxCell = ref<CellState<StockPrepSandboxTargetReadiness>>(idleCell())

const packsCellStatus = computed<CellStatus>(() => {
  const statuses = [catalogCell.value.status, installsCell.value.status]
  if (statuses.includes('loading')) return 'loading'
  if (statuses.every((status) => status === 'idle')) return 'idle'
  if (statuses.includes('forbidden')) return 'forbidden'
  if (statuses.includes('unavailable')) return 'unavailable'
  return 'ready'
})

const latestInstall = computed(() => installsCell.value.data?.installs?.[0] ?? null)

const packsSummary = computed(() => {
  if (packsCellStatus.value === 'loading') return bi('正在读取…', 'Reading…')
  if (packsCellStatus.value === 'forbidden' || packsCellStatus.value === 'unavailable') {
    return unavailableText(packsCellStatus.value)
  }
  if (packsCellStatus.value === 'idle') return bi(STOCK_PREP_OPS_CELL_UNCHECKED.zh, STOCK_PREP_OPS_CELL_UNCHECKED.en)
  const parts: string[] = []
  if (sandboxCell.value.status === 'ready' && sandboxCell.value.data) {
    parts.push(sandboxCell.value.data.ready ? bi('沙箱表已就绪', 'Sandbox table ready') : bi('沙箱表还没就绪', 'Sandbox table not ready'))
  } else if (catalogCell.value.data && catalogCell.value.data.packCount === 0) {
    parts.push(bi('还没有配置客户列包', 'No customer pack configured yet'))
  }
  const install = latestInstall.value
  if (install) {
    parts.push(`${install.packId}@${install.packVersion ?? '—'} · ${bi('装于', 'installed')} ${formatAuditTime(install.lastInstallAt)}`)
  } else if (installsCell.value.status === 'ready') {
    parts.push(bi('还没有装包记录', 'No install record yet'))
  }
  return parts.length > 0 ? parts.join(' · ') : bi('没有可显示的信息', 'Nothing to show')
})

const packsTone = computed(() => {
  if (packsCellStatus.value !== 'ready') return 'neutral'
  if (sandboxCell.value.status === 'ready' && sandboxCell.value.data) {
    return sandboxCell.value.data.ready ? 'success' : 'warning'
  }
  return 'neutral'
})

// ---------------------------------------------------------------------------
// ③ 部署自检 + ⑤ 四条硬边界 (same payload — see template comments)
// ---------------------------------------------------------------------------
const preflightCell = ref<CellState<StockPreparationPreflight>>(idleCell())

const preflightSummary = computed(() => {
  if (preflightCell.value.status === 'loading') return bi('正在检查…', 'Checking…')
  if (preflightCell.value.status === 'forbidden' || preflightCell.value.status === 'unavailable') {
    return unavailableText(preflightCell.value.status)
  }
  if (preflightCell.value.status === 'idle') return bi(STOCK_PREP_OPS_CELL_UNCHECKED.zh, STOCK_PREP_OPS_CELL_UNCHECKED.en)
  const data = preflightCell.value.data
  if (!data) return bi(STOCK_PREP_OPS_CELL_UNCHECKED.zh, STOCK_PREP_OPS_CELL_UNCHECKED.en)
  return data.ready
    ? bi('都齐了', 'Everything is in place')
    : bi(`还差 ${data.blockerCount} 项`, `${data.blockerCount} thing(s) still missing`)
})

const preflightTone = computed(() => {
  if (preflightCell.value.status !== 'ready' || !preflightCell.value.data) return 'neutral'
  return preflightCell.value.data.ready ? 'success' : 'warning'
})

async function onCheckPreflight(): Promise<void> {
  if (preflightCell.value.status === 'loading') return
  preflightCell.value = loadingCell(preflightCell.value.data)
  try {
    const data = await readStockPreparationPreflight(scope.value)
    preflightCell.value = { status: 'ready', data }
  } catch (error) {
    preflightCell.value = cellFromError(error)
  }
}

const FENCE_KEYS = ['productionApply', 'k3ExternalWrite', 'b2aTrialRegistry', 'outboundHttpWrite'] as const
const FENCE_SAFE_STATES = new Set(['closed', 'permanently_disabled', 'dormant', 'unset'])

/** Mirrors `fenceStateLabel` in StockPreparationInstallView.vue verbatim — kept local rather than
 *  shared because this panel must stay a zero-touch addition to that file (P0-4/P1 discipline: no
 *  existing panel's markup or exports change just because a new one wants a helper). */
function fenceStateLabel(state: string): string {
  if (state === 'closed') return bi('已关闭', 'closed')
  if (state === 'permanently_disabled') return bi('永久禁用', 'permanently off')
  if (state === 'dormant') return bi('未启用', 'not in use')
  if (state === 'unset') return bi('未配置', 'unset')
  return state
}

const fenceRows = computed(() => {
  const posture = preflightCell.value.data?.posture
  if (!posture) return []
  return FENCE_KEYS
    .filter((id) => posture[id])
    .map((id) => ({ id, state: posture[id]?.state ?? '—' }))
})

const fencesSummary = computed(() => {
  if (preflightCell.value.status === 'loading') return bi('正在检查…', 'Checking…')
  if (preflightCell.value.status === 'forbidden' || preflightCell.value.status === 'unavailable') {
    return unavailableText(preflightCell.value.status)
  }
  if (fenceRows.value.length === 0) return bi(STOCK_PREP_OPS_CELL_UNCHECKED.zh, STOCK_PREP_OPS_CELL_UNCHECKED.en)
  const attention = fenceRows.value.filter((fence) => !FENCE_SAFE_STATES.has(fence.state)).length
  return attention === 0
    ? bi('全部关闭(正常)', 'All closed (normal)')
    : bi(`${attention} 项处于非默认状态`, `${attention} not in its default state`)
})

const fencesTone = computed(() => {
  if (fenceRows.value.length === 0) return 'neutral'
  const attention = fenceRows.value.filter((fence) => !FENCE_SAFE_STATES.has(fence.state)).length
  return attention === 0 ? 'success' : 'warning'
})

// ---------------------------------------------------------------------------
// ④ 源就绪预检 — never auto-fires (D6: it reads the customer's own database).
// ---------------------------------------------------------------------------
const sourcePreflightCell = ref<CellState<StockPrepSourcePreflight>>(idleCell())
const sourceCheckPlain = stockPrepSourceCheckPlain
const sourceCheckRows = computed(() => (
  sourcePreflightCell.value.data ? stockPrepSourceCheckRows(sourcePreflightCell.value.data) : []
))

const sourcePreflightSummary = computed(() => {
  if (sourcePreflightCell.value.status === 'loading') return bi('正在检查…', 'Checking…')
  if (sourcePreflightCell.value.status === 'forbidden' || sourcePreflightCell.value.status === 'unavailable') {
    return unavailableText(sourcePreflightCell.value.status, STOCK_PREP_OPS_NEEDS_INTEGRATION_READ)
  }
  const data = sourcePreflightCell.value.data
  if (!data) return bi(STOCK_PREP_OPS_CELL_UNCHECKED.zh, STOCK_PREP_OPS_CELL_UNCHECKED.en)
  return data.verdict === 'go' ? bi('可以接', 'Ready to connect') : bi('接不了', 'Not ready to connect')
})

const sourcePreflightTone = computed(() => {
  if (sourcePreflightCell.value.status !== 'ready' || !sourcePreflightCell.value.data) return 'neutral'
  return sourcePreflightCell.value.data.verdict === 'go' ? 'success' : 'warning'
})

async function onCheckSourcePreflight(): Promise<void> {
  if (sourcePreflightCell.value.status === 'loading') return
  sourcePreflightCell.value = loadingCell(sourcePreflightCell.value.data)
  try {
    const data = await readStockPreparationSourcePreflight(scope.value)
    sourcePreflightCell.value = { status: 'ready', data }
  } catch (error) {
    sourcePreflightCell.value = cellFromError(error)
  }
}

// ---------------------------------------------------------------------------
// The auto batch — ①②, on mount. `healthSeq` is the monotonic guard: a reload started while an
// earlier one is still in flight bumps it, and the earlier one's `then` becomes a no-op (mirrors
// StockPreparationDashboardView.vue's own load-sequence discipline).
// ---------------------------------------------------------------------------
let healthSeq = 0

async function loadAutoHealth(): Promise<void> {
  const seq = ++healthSeq
  sourceCell.value = loadingCell()
  catalogCell.value = loadingCell()
  installsCell.value = loadingCell()
  sandboxCell.value = idleCell()

  const [sourceResult, catalogResult, installsResult] = await Promise.allSettled([
    readStockPreparationSourceBinding(scope.value),
    readStockPreparationCustomerPackCatalog(scope.value),
    readStockPreparationCustomerPackInstalls(scope.value),
  ])
  if (seq !== healthSeq) return

  sourceCell.value = cellFromSettled(sourceResult)
  catalogCell.value = cellFromSettled(catalogResult)
  installsCell.value = cellFromSettled(installsResult)

  const objectId = catalogCell.value.data?.packs?.[0]?.targetObjectId ?? null
  if (!objectId) return // no configured pack — stays 'idle' (neutral), not a failure
  sandboxCell.value = loadingCell()
  try {
    const readiness = await readStockPreparationSandboxTargetReadiness(scope.value, objectId)
    if (seq !== healthSeq) return
    sandboxCell.value = { status: 'ready', data: readiness }
  } catch (error) {
    if (seq !== healthSeq) return
    sandboxCell.value = cellFromError(error)
  }
}

// ---------------------------------------------------------------------------
// 数据落点 — reuses ②'s already-fetched data, no read of its own.
// ---------------------------------------------------------------------------
const dataLocationObjectId = computed(() => installsCell.value.data?.objectId ?? null)
const dataLocationPack = computed(() => latestInstall.value)

// ---------------------------------------------------------------------------
// 审计反查
// ---------------------------------------------------------------------------
const auditProjectNo = ref('')
const auditAction = ref('')
const auditLoading = ref(false)
const auditOutcome = ref<StockPrepAuditListOutcome | null>(null)
const currentUserId = ref<string | null>(null)

const canSearchAudit = computed(() => auditProjectNo.value.trim().length > 0 && !auditLoading.value)

// Narrowed here, in script, rather than inline in the template — `StockPrepAuditListOutcome` is a
// discriminated union and vue-tsc's template narrowing across `v-if`/`v-else-if`/`v-else` siblings is
// not as reliable as TS's own control-flow analysis in a `computed`, so every branch below reads a
// plain boolean/array instead of re-deriving the discriminant from `auditOutcome.value` itself.
const auditForbidden = computed(() => {
  const outcome = auditOutcome.value
  return outcome !== null && !outcome.ok && outcome.reason === 'forbidden'
})
const auditFailed = computed(() => {
  const outcome = auditOutcome.value
  return outcome !== null && !outcome.ok && outcome.reason !== 'forbidden'
})
const auditSucceeded = computed(() => auditOutcome.value !== null && auditOutcome.value.ok === true)
const auditEntries = computed(() => {
  const outcome = auditOutcome.value
  return outcome !== null && outcome.ok ? outcome.entries : []
})

function auditActionLabel(action: string): string {
  const plain = stockPrepAuditActionPlain(action)
  if (plain) return bi(plain.zh, plain.en)
  return bi(`其他动作(${action})`, `Other action (${action})`)
}

function formatAuditTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US')
}

async function onAuditSearch(): Promise<void> {
  const projectId = auditProjectNo.value.trim()
  if (!projectId || auditLoading.value) return
  auditLoading.value = true
  try {
    auditOutcome.value = await listStockPreparationAudit(
      scope.value,
      { projectId, action: auditAction.value || undefined },
      currentUserId.value,
    )
  } finally {
    auditLoading.value = false
  }
}

onMounted(async () => {
  try {
    currentUserId.value = await auth.getCurrentUserId()
  } catch {
    currentUserId.value = null
  }
  void loadAutoHealth()
})
</script>

<style scoped>
.sp-ops {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-6);
}

.sp-ops__block {
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  padding: var(--ms-space-4);
}

.sp-ops__h3 {
  margin: 0 0 var(--ms-space-3);
  font-size: 14px;
  font-weight: 600;
  color: var(--ms-text-1);
}

.sp-ops__cells {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--ms-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.sp-ops__cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
}

.sp-ops__cell-label {
  font-size: 12px;
  color: var(--ms-text-3);
}

.sp-ops__cell-badge {
  display: inline-block;
  width: fit-content;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
}

.sp-ops__cell-badge--neutral { background: var(--ms-bg-page); color: var(--ms-text-3); }
.sp-ops__cell-badge--success { background: color-mix(in srgb, var(--ms-color-success) 16%, transparent); color: var(--ms-color-success); }
.sp-ops__cell-badge--warning { background: color-mix(in srgb, var(--ms-color-warning) 16%, transparent); color: var(--ms-color-warning); }

.sp-ops__cell-action {
  align-self: flex-start;
  font-size: 12px;
  cursor: pointer;
}

.sp-ops__cell-note {
  margin: 0;
  font-size: 12px;
  color: var(--ms-text-3);
}

.sp-ops__fence-list {
  margin: 0;
  padding-left: var(--ms-space-4);
  font-size: 12px;
}

.sp-ops__audit-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ms-space-3);
  margin-bottom: var(--ms-space-3);
}

.sp-ops__field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--ms-text-3);
}

.sp-ops__audit-search {
  cursor: pointer;
}

.sp-ops__audit-list {
  margin: 0 0 var(--ms-space-3);
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.sp-ops__audit-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-3);
  font-size: 13px;
}

.sp-ops__audit-caveats {
  margin: var(--ms-space-3) 0 0;
  padding-left: var(--ms-space-4);
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.7;
}
</style>
