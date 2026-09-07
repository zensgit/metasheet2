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
          <span class="sp-ops__cell-badge" :class="`sp-ops__cell-badge--${sourceView.tone}`">{{ sourceView.badge }}</span>
          <p
            v-if="sourceView.note"
            class="sp-ops__cell-note"
            :class="{ 'sp-ops__cell-note--alert': sourceView.alert }"
            :role="sourceView.alert ? 'alert' : undefined"
            data-testid="stock-prep-ops-cell-source-note"
          >{{ sourceView.note }}</p>
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

        <!-- ② 建表/装包 — auto, admin tier. Catalog first (it names the objectId), then installs and
             readiness about THAT SAME id. deploymentHealth.ts's header carries the plugin-source
             evidence for why the id decides which readiness route may legally answer at all. The
             note line is how a failed readiness read stays VISIBLE while the other two halves still
             render their data — §6.2 P1-5's 「这一格看不了 + 谁能看」 applies per sub-read, not only
             when the whole tile dies. -->
        <li class="sp-ops__cell" data-testid="stock-prep-ops-cell-packs" :data-cell-status="packsCellStatus">
          <span class="sp-ops__cell-label">{{ bi('建表/装包', 'Tables & packs') }}</span>
          <span class="sp-ops__cell-badge" :class="`sp-ops__cell-badge--${packsView.tone}`">{{ packsView.badge }}</span>
          <p
            v-if="packsView.note"
            class="sp-ops__cell-note"
            data-testid="stock-prep-ops-cell-packs-note"
          >{{ packsView.note }}</p>
        </li>

        <!-- ③ 部署自检 — manual, stock-prep:read tier. Feeds ⑤ 四条硬边界 below (same payload). -->
        <li class="sp-ops__cell" data-testid="stock-prep-ops-cell-preflight" :data-cell-status="preflightCell.status">
          <span class="sp-ops__cell-label">{{ bi('部署自检', 'Deployment self-check') }}</span>
          <span class="sp-ops__cell-badge" :class="`sp-ops__cell-badge--${preflightView.tone}`">{{ preflightView.badge }}</span>
          <p
            v-if="preflightView.note"
            class="sp-ops__cell-note"
            :class="{ 'sp-ops__cell-note--alert': preflightView.alert }"
            :role="preflightView.alert ? 'alert' : undefined"
            data-testid="stock-prep-ops-cell-preflight-note"
          >{{ preflightView.note }}</p>
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
          <span class="sp-ops__cell-badge" :class="`sp-ops__cell-badge--${sourcePreflightView.tone}`">{{ sourcePreflightView.badge }}</span>
          <p
            v-if="sourcePreflightView.note"
            class="sp-ops__cell-note"
            :class="{ 'sp-ops__cell-note--alert': sourcePreflightView.alert }"
            :role="sourcePreflightView.alert ? 'alert' : undefined"
            data-testid="stock-prep-ops-cell-source-preflight-note"
          >{{ sourcePreflightView.note }}</p>
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
          <span class="sp-ops__cell-badge" :class="`sp-ops__cell-badge--${fencesView.tone}`">{{ fencesView.badge }}</span>
          <p
            v-if="fencesView.note"
            class="sp-ops__cell-note"
            :class="{ 'sp-ops__cell-note--alert': fencesView.alert }"
            :role="fencesView.alert ? 'alert' : undefined"
            data-testid="stock-prep-ops-cell-fences-note"
          >{{ fencesView.note }}</p>
          <StockPrepTechnicalDetails
            v-if="fenceCounts.known > 0"
            :label="bi('看明细', 'Details')"
            testid="stock-prep-ops-cell-fences-detail"
          >
            <ul class="sp-ops__fence-list">
              <li v-for="fence in fenceRows" :key="fence.id" data-testid="stock-prep-ops-fence-row">
                <span v-if="stockPrepPosturePlain(fence.id)">{{ bi(stockPrepPosturePlain(fence.id)!.zh, stockPrepPosturePlain(fence.id)!.en) }}</span>
                <span v-else><code>{{ fence.id }}</code></span>
                <em>{{ fence.state === null ? bi('这次没读到', 'not returned this time') : fenceStateLabel(fence.state) }}</em>
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
        <!-- §4.3 wants every empty state to be an EmptyState with its own `data-empty-state` enum —
             `not_permitted` included. It is not a "no data" state in the usual sense, but it IS the
             state this section renders instead of results, and giving it the enum is what lets the
             空态矩阵 be checked rather than believed. -->
        <EmptyState
          v-if="auditForbidden"
          class="sp-ops__audit-forbidden"
          data-testid="stock-prep-ops-audit-forbidden"
          data-empty-state="not_permitted"
          :title="bi(STOCK_PREP_AUDIT_FORBIDDEN.zh, STOCK_PREP_AUDIT_FORBIDDEN.en)"
        />
        <p v-else-if="auditFailed" class="sp-ops__audit-error" role="alert" data-testid="stock-prep-ops-audit-error">
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
              :data-self="auditSelfAttribute(entry.who)"
              :data-who="entry.who"
            >
              <span data-testid="stock-prep-ops-audit-row-time">{{ formatAuditTime(entry.createdAt) }}</span>
              <span data-testid="stock-prep-ops-audit-row-action">{{ auditActionLabel(entry.action) }}</span>
              <!-- THREE outcomes, not two. An unreadable current account or an actor-less row must not
                   be rendered as the positive claim 「其他同事」 — see audit.ts's `StockPrepAuditWho`. -->
              <span data-testid="stock-prep-ops-audit-row-who">{{ auditWhoLabel(entry.who) }}</span>
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
        <!-- `<dl>`'s content model admits only dt/dd/div/script/template, so the fallback sentence is
             a SIBLING of the list rather than a `<p>` inside it (a parser hoists that out of the
             `<dl>` anyway, which is how it went unnoticed). -->
        <dl v-if="dataLocationObjectId || dataLocationPack">
          <dt v-if="dataLocationObjectId">{{ bi('表内部编号', 'Table internal id') }}</dt>
          <dd v-if="dataLocationObjectId">
            <code>{{ dataLocationObjectId }}</code>
            <span v-if="dataLocationKind === 'canonical'">{{ bi('(生产主表)', ' (production main table)') }}</span>
            <span v-else-if="dataLocationKind === 'sandbox'">{{ bi('(沙箱表)', ' (sandbox table)') }}</span>
          </dd>
          <dt v-if="dataLocationPack">{{ bi('装了哪个包版本', 'Installed pack version') }}</dt>
          <dd v-if="dataLocationPack"><code>{{ dataLocationPack.packId }}@{{ dataLocationPack.packVersion ?? '—' }}</code></dd>
          <!-- A multi-pack deployment has more than one target table, and the tile above reports on
               the catalog's FIRST pack only. Say so rather than let one table stand in for several. -->
          <dt v-if="dataLocationPackCount > 1">{{ bi('这套部署配了几个客户列包', 'Customer packs configured') }}</dt>
          <dd v-if="dataLocationPackCount > 1">
            {{ bi(`${dataLocationPackCount} 个 —— 上面读的是其中第一个的目标表。`, `${dataLocationPackCount} — the tile above reports on the first one's target table.`) }}
          </dd>
        </dl>
        <p v-else data-testid="stock-prep-ops-data-location-empty">
          {{ bi('还没有读到装包记录 —— 见上面「建表/装包」格。', 'No install record read yet — see the "Tables & packs" tile above.') }}
        </p>
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
// THE FAILURE THIS PANEL IS MOST LIKELY TO COMMIT IS A CONFIDENT SENTENCE BUILT ON A READ THAT DID
// NOT HAPPEN, and three separate places in here used to do exactly that. All three are now typed out
// of existence rather than commented against:
//   - the audit query sent a `workspaceId` that filters on a column NULL on every row it can match,
//     so the search returned nothing forever while the three caveat lines stood ready to explain the
//     emptiness with three reasons that were all false (audit.ts's header);
//   - the 「谁」 column was two-valued, so a failed read of the CALLER's own id rendered every row as
//     「其他同事」 — a positive identification manufactured out of a network error;
//   - the 建表/装包 tile asked the sandbox readiness route about a canonical objectId (a guaranteed
//     422 on every production deployment) and then swallowed the refusal, staying `ready` and simply
//     omitting half a sentence (deploymentHealth.ts's header).
// The pattern in all three: an absent fact rendered as a present one. `CellView`'s `note`, the
// four-valued `StockPrepAuditWho`, and the namespace-routed readiness read exist to make the absent
// case have somewhere to go.
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
  readStockPreparationTargetReadiness,
  type StockPrepCustomerPackCatalog,
  type StockPrepCustomerPackInstallList,
  type StockPrepTargetReadiness,
} from '../../../services/integration/stockPreparation/deploymentHealth'
import {
  listStockPreparationAudit,
  STOCK_PREP_AUDIT_PROJECT_SCOPED_ACTIONS,
  type StockPrepAuditListOutcome,
  type StockPrepAuditWho,
} from '../../../services/integration/stockPreparation/audit'
import {
  STOCK_PREP_AUDIT_ACTOR_OTHER,
  STOCK_PREP_AUDIT_ACTOR_SELF,
  STOCK_PREP_AUDIT_ACTOR_UNKNOWN_ACTOR,
  STOCK_PREP_AUDIT_ACTOR_UNKNOWN_VIEWER,
  STOCK_PREP_AUDIT_CAVEAT_LEGACY,
  STOCK_PREP_AUDIT_CAVEAT_LIMIT,
  STOCK_PREP_AUDIT_CAVEAT_SCOPE,
  STOCK_PREP_AUDIT_EMPTY,
  STOCK_PREP_AUDIT_FORBIDDEN,
  STOCK_PREP_OPS_CELL_LOCKED_PREFIX,
  STOCK_PREP_OPS_CELL_MISCONFIGURED,
  STOCK_PREP_OPS_CELL_UNAVAILABLE,
  STOCK_PREP_OPS_CELL_UNCHECKED,
  STOCK_PREP_OPS_CELL_UNKNOWN_BADGE,
  STOCK_PREP_OPS_NEEDS_ADMIN,
  STOCK_PREP_OPS_NEEDS_INTEGRATION_READ,
  STOCK_PREP_OPS_SCHEDULED_TASK_UNMONITORED,
  STOCK_PREP_OPS_TARGET_CANONICAL_NOT_READY,
  STOCK_PREP_OPS_TARGET_CANONICAL_READY,
  STOCK_PREP_OPS_TARGET_READINESS_UNREADABLE,
  STOCK_PREP_OPS_TARGET_SANDBOX_NOT_READY,
  STOCK_PREP_OPS_TARGET_SANDBOX_READY,
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
// `misconfigured` is a PERMANENT refusal (400/422) held apart from the transient `unavailable`,
// because the sentence each deserves is different and the wrong one is bad advice: "请稍后再试" told
// an admin to wait out a 422 that will still be a 422 next year. The producer this panel actually
// meets is a customer pack whose declared target table is neither the canonical one nor inside the
// sandbox namespace — see deploymentHealth.ts's header.
type CellStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'forbidden' | 'misconfigured'

/**
 * §4.4's badge tokens, kept as four distinct tones rather than one shared "neutral". The table gives
 * 未检查 (`--ms-color-info`), `? 看不到` (`--ms-text-3` + a sentence) and 未接入监控 (`--ms-text-3`)
 * three separate readings, and a reader who cannot tell "nobody asked yet" from "we asked and are not
 * allowed to know" from "nothing here can ever know" is being given one word for three situations.
 * None of them may borrow `success`/`warning` (G4).
 */
type CellTone = 'neutral' | 'unchecked' | 'unknown' | 'success' | 'warning'

/**
 * What one health tile renders. `note` exists so the two halves of §6.2 P1-5's 「这一格看不了 + 谁能
 * 看」 always travel together: the badge is too small for a sentence, so the sentence lives here and
 * is never the thing that gets dropped for space.
 */
interface CellView {
  badge: string
  tone: CellTone
  note: string | null
  /** G3: the user CLICKED for this and it failed, so it is announced rather than shown quietly. */
  alert: boolean
}

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
  const status = statusOfError(error)
  if (status === 403) return { status: 'forbidden', data: null }
  if (status === 400 || status === 422) return { status: 'misconfigured', data: null }
  return { status: 'unavailable', data: null }
}

function cellFromSettled<T>(result: PromiseSettledResult<T>): CellState<T> {
  if (result.status === 'fulfilled') return { status: 'ready', data: result.value }
  return cellFromError<T>(result.reason)
}

function isFailedStatus(status: CellStatus): boolean {
  return status === 'forbidden' || status === 'unavailable' || status === 'misconfigured'
}

/** 未检查 — G4's third state. Its own tone, never green and never red. */
function uncheckedView(): CellView {
  return {
    badge: bi(STOCK_PREP_OPS_CELL_UNCHECKED.zh, STOCK_PREP_OPS_CELL_UNCHECKED.en),
    tone: 'unchecked',
    note: null,
    alert: false,
  }
}

function loadingView(text: { zh: string; en: string }): CellView {
  return { badge: bi(text.zh, text.en), tone: 'neutral', note: null, alert: false }
}

/** The sentence a failed cell shows — both halves, always. Never a raw status or a server message. */
function failureNote(
  status: CellStatus,
  needs: { zh: string; en: string } = STOCK_PREP_OPS_NEEDS_ADMIN,
): string {
  if (status === 'forbidden') {
    return bi(
      `${STOCK_PREP_OPS_CELL_LOCKED_PREFIX.zh}${needs.zh}。`,
      `${STOCK_PREP_OPS_CELL_LOCKED_PREFIX.en}${needs.en}.`,
    )
  }
  if (status === 'misconfigured') {
    return bi(STOCK_PREP_OPS_CELL_MISCONFIGURED.zh, STOCK_PREP_OPS_CELL_MISCONFIGURED.en)
  }
  return bi(STOCK_PREP_OPS_CELL_UNAVAILABLE.zh, STOCK_PREP_OPS_CELL_UNAVAILABLE.en)
}

function failureView(
  status: CellStatus,
  needs: { zh: string; en: string } = STOCK_PREP_OPS_NEEDS_ADMIN,
  manual = false,
): CellView {
  return {
    badge: status === 'forbidden'
      ? bi(STOCK_PREP_OPS_CELL_UNKNOWN_BADGE.zh, STOCK_PREP_OPS_CELL_UNKNOWN_BADGE.en)
      : bi('读不到', 'Cannot read'),
    tone: 'unknown',
    note: failureNote(status, needs),
    alert: manual,
  }
}

// ---------------------------------------------------------------------------
// ① 数据源
// ---------------------------------------------------------------------------
const sourceCell = ref<CellState<StockPreparationSourceBindingView>>(idleCell())
const sourceManual = ref(false)

const sourceView = computed<CellView>(() => {
  if (sourceCell.value.status === 'loading') return loadingView({ zh: '正在读取…', en: 'Reading…' })
  if (isFailedStatus(sourceCell.value.status)) {
    return failureView(sourceCell.value.status, STOCK_PREP_OPS_NEEDS_ADMIN, sourceManual.value)
  }
  const data = sourceCell.value.data
  if (!data) return uncheckedView()
  if (data.origin === 'unconfigured') {
    return { badge: bi('未配置任何数据源', 'No data source configured'), tone: 'neutral', note: null, alert: false }
  }
  const candidate = data.eligibleSources.find((source) => source.externalSystemId === data.effectiveExternalSystemId)
  const name = candidate?.name || data.effectiveExternalSystemId || bi('未命名', 'unnamed')
  const verb = data.origin === 'persisted' ? bi('已绑定', 'Bound to') : bi('使用默认源', 'Using the default source')
  return {
    badge: `${verb}「${name}」`,
    tone: data.origin === 'persisted' ? 'success' : 'warning',
    note: null,
    alert: false,
  }
})

async function onRefreshSource(): Promise<void> {
  if (sourceCell.value.status === 'loading') return
  sourceManual.value = true
  sourceCell.value = loadingCell(sourceCell.value.data)
  try {
    const data = await readStockPreparationSourceBinding(scope.value)
    sourceCell.value = { status: 'ready', data }
  } catch (error) {
    sourceCell.value = cellFromError(error)
  }
}

// ---------------------------------------------------------------------------
// ② 建表/装包 — three reads about ONE table.
//
// The catalog goes first because its `pack.targetObjectId` is the id the other two must agree on:
// the install ledger is filtered by object_id, and WHICH readiness route may legally answer is
// decided by that same id (deploymentHealth.ts's header carries the plugin-source evidence). Reading
// installs with the route's default while reading readiness with the pack's own id is what produced
// a tile that said 「沙箱表已就绪」 and 「还没有装包记录」 in one breath, about two different tables.
//
// `packsCoreStatus` folds the two reads WITHOUT which the tile can say nothing at all; `targetCell`
// is folded separately, because when catalog+installs succeed and only readiness fails the tile still
// holds real information and should show it — with an explicit sentence naming the half it is
// missing, never by quietly rendering one clause short. `packsCellStatus` (the DOM attribute) is the
// worst of all three, so a failed sub-read is machine-visible even when the tile still renders data.
// ---------------------------------------------------------------------------
const catalogCell = ref<CellState<StockPrepCustomerPackCatalog>>(idleCell())
const installsCell = ref<CellState<StockPrepCustomerPackInstallList>>(idleCell())
const targetCell = ref<CellState<StockPrepTargetReadiness>>(idleCell())

function foldStatus(statuses: CellStatus[]): CellStatus {
  if (statuses.includes('loading')) return 'loading'
  if (statuses.every((status) => status === 'idle')) return 'idle'
  if (statuses.includes('forbidden')) return 'forbidden'
  if (statuses.includes('misconfigured')) return 'misconfigured'
  if (statuses.includes('unavailable')) return 'unavailable'
  return 'ready'
}

const packsCoreStatus = computed<CellStatus>(() => foldStatus([catalogCell.value.status, installsCell.value.status]))

const packsCellStatus = computed<CellStatus>(() => foldStatus([
  catalogCell.value.status,
  installsCell.value.status,
  targetCell.value.status,
]))

const latestInstall = computed(() => installsCell.value.data?.installs?.[0] ?? null)

/** Which table was inspected, said out loud. 「已就绪」 alone cannot distinguish two tables. */
function targetReadyLabel(readiness: StockPrepTargetReadiness): string {
  if (readiness.kind === 'canonical') {
    return readiness.ready
      ? bi(STOCK_PREP_OPS_TARGET_CANONICAL_READY.zh, STOCK_PREP_OPS_TARGET_CANONICAL_READY.en)
      : bi(STOCK_PREP_OPS_TARGET_CANONICAL_NOT_READY.zh, STOCK_PREP_OPS_TARGET_CANONICAL_NOT_READY.en)
  }
  return readiness.ready
    ? bi(STOCK_PREP_OPS_TARGET_SANDBOX_READY.zh, STOCK_PREP_OPS_TARGET_SANDBOX_READY.en)
    : bi(STOCK_PREP_OPS_TARGET_SANDBOX_NOT_READY.zh, STOCK_PREP_OPS_TARGET_SANDBOX_NOT_READY.en)
}

const packsView = computed<CellView>(() => {
  const core = packsCoreStatus.value
  if (core === 'loading') return loadingView({ zh: '正在读取…', en: 'Reading…' })
  if (core === 'idle') return uncheckedView()
  if (isFailedStatus(core)) return failureView(core)

  const readiness = targetCell.value
  const parts: string[] = []
  if (readiness.status === 'ready' && readiness.data) {
    parts.push(targetReadyLabel(readiness.data))
  } else if (catalogCell.value.data && catalogCell.value.data.packCount === 0) {
    parts.push(bi('还没有配置客户列包', 'No customer pack configured yet'))
  }
  const install = latestInstall.value
  if (install) {
    parts.push(`${install.packId}@${install.packVersion ?? '—'} · ${bi('装于', 'installed')} ${formatAuditTime(install.lastInstallAt)}`)
  } else if (installsCell.value.status === 'ready') {
    parts.push(bi('还没有装包记录', 'No install record yet'))
  }

  // The readiness half failed while the other two succeeded — say which half, and why.
  const note = isFailedStatus(readiness.status)
    ? `${bi(STOCK_PREP_OPS_TARGET_READINESS_UNREADABLE.zh, STOCK_PREP_OPS_TARGET_READINESS_UNREADABLE.en)}—— ${failureNote(readiness.status)}`
    : null

  let tone: CellTone = 'neutral'
  if (readiness.status === 'ready' && readiness.data) tone = readiness.data.ready ? 'success' : 'warning'
  else if (isFailedStatus(readiness.status)) tone = 'unknown'

  return {
    badge: parts.length > 0 ? parts.join(' · ') : bi('没有可显示的信息', 'Nothing to show'),
    tone,
    note,
    alert: false,
  }
})

// ---------------------------------------------------------------------------
// ③ 部署自检 + ⑤ 四条硬边界 (same payload — see template comments)
// ---------------------------------------------------------------------------
const preflightCell = ref<CellState<StockPreparationPreflight>>(idleCell())
const preflightManual = ref(false)

const preflightView = computed<CellView>(() => {
  if (preflightCell.value.status === 'loading') return loadingView({ zh: '正在检查…', en: 'Checking…' })
  if (isFailedStatus(preflightCell.value.status)) {
    return failureView(preflightCell.value.status, STOCK_PREP_OPS_NEEDS_ADMIN, preflightManual.value)
  }
  const data = preflightCell.value.data
  if (preflightCell.value.status === 'idle' || !data) return uncheckedView()
  return {
    badge: data.ready
      ? bi('都齐了', 'Everything is in place')
      : bi(`还差 ${data.blockerCount} 项`, `${data.blockerCount} thing(s) still missing`),
    tone: data.ready ? 'success' : 'warning',
    note: null,
    alert: false,
  }
})

async function onCheckPreflight(): Promise<void> {
  if (preflightCell.value.status === 'loading') return
  preflightManual.value = true
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

/**
 * All four keys, ALWAYS — a key the payload did not carry becomes `state: null` rather than being
 * dropped. Dropping it silently let the tile keep the title 「四条硬边界」 while concluding
 * 「全部关闭(正常)」 from however many it happened to receive, which is a claim about four fences
 * made from three readings. Today `buildPosture` returns all four unconditionally; this is the guard
 * for the day it does not, and these four are G8's 「产品对客户的承诺」.
 */
const fenceRows = computed(() => FENCE_KEYS.map((id) => ({
  id,
  state: preflightCell.value.data?.posture?.[id]?.state ?? null,
})))

const fenceCounts = computed(() => {
  const known = fenceRows.value.filter((fence) => fence.state !== null)
  return {
    known: known.length,
    missing: fenceRows.value.length - known.length,
    attention: known.filter((fence) => !FENCE_SAFE_STATES.has(fence.state as string)).length,
  }
})

const fencesView = computed<CellView>(() => {
  if (preflightCell.value.status === 'loading') return loadingView({ zh: '正在检查…', en: 'Checking…' })
  if (isFailedStatus(preflightCell.value.status)) {
    return failureView(preflightCell.value.status, STOCK_PREP_OPS_NEEDS_ADMIN, preflightManual.value)
  }
  if (preflightCell.value.status !== 'ready') return uncheckedView()

  const { known, missing, attention } = fenceCounts.value
  // The read SUCCEEDED and carried nothing — that is not 未检查, and saying 未检查 here would be a
  // second, quieter lie: it invites a re-check that will return the same empty payload.
  if (known === 0) {
    return {
      badge: bi('这次自检没带回边界状态', 'The self-check returned no fence states'),
      tone: 'unknown',
      note: bi(
        '自检读成功了,但载荷里没有这四条的状态 —— 这不是「没检查过」。请平台管理员看服务端版本。',
        'The self-check succeeded but its payload carried none of the four fence states — this is not "not checked yet". A platform administrator should check the server version.',
      ),
      alert: preflightManual.value,
    }
  }
  const head = attention === 0
    ? bi('全部关闭(正常)', 'All closed (normal)')
    : bi(`${attention} 项处于非默认状态`, `${attention} not in its default state`)
  const tail = missing > 0 ? bi(` · ${missing} 项这次没读到`, ` · ${missing} not returned this time`) : ''
  return {
    badge: `${head}${tail}`,
    tone: attention === 0 && missing === 0 ? 'success' : 'warning',
    note: null,
    alert: false,
  }
})

// ---------------------------------------------------------------------------
// ④ 源就绪预检 — never auto-fires (D6: it reads the customer's own database).
// ---------------------------------------------------------------------------
const sourcePreflightCell = ref<CellState<StockPrepSourcePreflight>>(idleCell())
const sourcePreflightManual = ref(false)
const sourceCheckPlain = stockPrepSourceCheckPlain
const sourceCheckRows = computed(() => (
  sourcePreflightCell.value.data ? stockPrepSourceCheckRows(sourcePreflightCell.value.data) : []
))

const sourcePreflightView = computed<CellView>(() => {
  if (sourcePreflightCell.value.status === 'loading') return loadingView({ zh: '正在检查…', en: 'Checking…' })
  if (isFailedStatus(sourcePreflightCell.value.status)) {
    return failureView(sourcePreflightCell.value.status, STOCK_PREP_OPS_NEEDS_INTEGRATION_READ, sourcePreflightManual.value)
  }
  const data = sourcePreflightCell.value.data
  if (!data) return uncheckedView()
  return {
    badge: data.verdict === 'go' ? bi('可以接', 'Ready to connect') : bi('接不了', 'Not ready to connect'),
    tone: data.verdict === 'go' ? 'success' : 'warning',
    note: null,
    alert: false,
  }
})

async function onCheckSourcePreflight(): Promise<void> {
  if (sourcePreflightCell.value.status === 'loading') return
  sourcePreflightManual.value = true
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
  sourceManual.value = false
  sourceCell.value = loadingCell()
  catalogCell.value = loadingCell()
  installsCell.value = loadingCell()
  targetCell.value = loadingCell()

  // Wave 1: the two reads that need no id. `allSettled`, so the source tile is untouched by a pack
  // catalog failure and vice versa.
  const [sourceResult, catalogResult] = await Promise.allSettled([
    readStockPreparationSourceBinding(scope.value),
    readStockPreparationCustomerPackCatalog(scope.value),
  ])
  if (seq !== healthSeq) return
  sourceCell.value = cellFromSettled(sourceResult)
  catalogCell.value = cellFromSettled(catalogResult)

  // Wave 2: ONE objectId, both reads. `packs[0]` is the catalog's own first entry — the catalog is
  // built by sorting pack ids (`stock-preparation-customer-pack-catalog.cjs`), so on a multi-pack
  // deployment this is "the alphabetically first pack", which the 数据落在哪 disclosure names
  // explicitly rather than passing off as "the" table. Single-pack is the shipped shape.
  const objectId = catalogCell.value.data?.packs?.[0]?.targetObjectId ?? null
  targetCell.value = objectId ? loadingCell() : idleCell()
  const [installsResult, targetResult] = await Promise.allSettled([
    // No configured pack → no id → the route's own canonical default, which is also what a
    // pack-less deployment installs onto.
    readStockPreparationCustomerPackInstalls(scope.value, objectId ?? undefined),
    // ...but readiness is NOT asked speculatively: with no pack there is no declared target, and a
    // guess would be a request this panel cannot honestly attribute. The tile stays 未检查 for that
    // half and says 「还没有配置客户列包」.
    objectId ? readStockPreparationTargetReadiness(scope.value, objectId) : Promise.resolve(null),
  ])
  if (seq !== healthSeq) return
  installsCell.value = cellFromSettled(installsResult)
  if (targetResult.status === 'rejected') {
    targetCell.value = cellFromError(targetResult.reason)
  } else {
    targetCell.value = targetResult.value === null ? idleCell() : { status: 'ready', data: targetResult.value }
  }
}

// ---------------------------------------------------------------------------
// 数据落点 — reuses ②'s already-fetched data, no read of its own. `installsCell.data.objectId` is
// the server's echo of the id THIS panel asked about (the pack's own target, or the route default
// when no pack is configured), so the id printed here and the table the readiness half reported on
// are now the same table rather than two.
// ---------------------------------------------------------------------------
const dataLocationObjectId = computed(() => installsCell.value.data?.objectId ?? null)
const dataLocationKind = computed(() => targetCell.value.data?.kind ?? null)
const dataLocationPack = computed(() => latestInstall.value)
const dataLocationPackCount = computed(() => catalogCell.value.data?.packCount ?? 0)

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

/**
 * Three outcomes on screen, not two. `getCurrentUserId()` is a network read that can fail and the
 * store's own append allows a null actor; a two-way 「您 / 其他同事」 rendered both of those absences
 * as a positive claim that a COLLEAGUE did it — on the one page built to answer "who". See audit.ts's
 * `StockPrepAuditWho`.
 */
function auditWhoLabel(who: StockPrepAuditWho): string {
  if (who === 'self') return bi(STOCK_PREP_AUDIT_ACTOR_SELF.zh, STOCK_PREP_AUDIT_ACTOR_SELF.en)
  if (who === 'other') return bi(STOCK_PREP_AUDIT_ACTOR_OTHER.zh, STOCK_PREP_AUDIT_ACTOR_OTHER.en)
  if (who === 'unknown_actor') {
    return bi(STOCK_PREP_AUDIT_ACTOR_UNKNOWN_ACTOR.zh, STOCK_PREP_AUDIT_ACTOR_UNKNOWN_ACTOR.en)
  }
  return bi(STOCK_PREP_AUDIT_ACTOR_UNKNOWN_VIEWER.zh, STOCK_PREP_AUDIT_ACTOR_UNKNOWN_VIEWER.en)
}

/** `true` / `false` / `unknown` — kept three-valued for the same reason the sentence is. */
function auditSelfAttribute(who: StockPrepAuditWho): string {
  if (who === 'self') return 'true'
  if (who === 'other') return 'false'
  return 'unknown'
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

/* §4.4's three NON-verdict tokens, kept visually distinct: 未检查 is `--ms-color-info` ("nobody has
   asked yet"), `? 看不到` / 读不到 is `--ms-text-3` ("we asked and cannot know"), and 未接入监控 is
   `--ms-text-3` ("nothing in this application can know"). None of the three borrows success/danger
   (G4), and 未检查 is the one with its own hue so a grid of tiles shows at a glance which cells are
   simply waiting for a click. */
.sp-ops__cell-badge--neutral { background: var(--ms-bg-page); color: var(--ms-text-3); }
.sp-ops__cell-badge--unchecked { background: color-mix(in srgb, var(--ms-color-info) 12%, transparent); color: var(--ms-color-info); }
.sp-ops__cell-badge--unknown { background: var(--ms-bg-page); color: var(--ms-text-3); border: 1px dashed var(--ms-border-light); }
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

/* G3's other half: a failure the user ASKED for by clicking is announced, not murmured. A background
   pre-read that fails keeps the quiet grey line above (§6.2 P1-5: 不整页红). */
.sp-ops__cell-note--alert {
  color: var(--ms-color-warning);
  font-weight: 600;
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

/* 线框 E marks 「查一下」 ★ — the ONE primary action on this screen. G1 caps a screen at one
   `--ms-color-primary` button; this is it, and the two 「现在检查」 tile buttons stay plain so the
   hierarchy between "the thing this page is for" and "a tile-level probe" is visible rather than
   merely intended. */
.sp-ops__audit-search {
  cursor: pointer;
  padding: 4px 14px;
  border: 1px solid var(--ms-color-primary);
  border-radius: 4px;
  background: color-mix(in srgb, var(--ms-color-primary) 10%, transparent);
  color: var(--ms-color-primary);
  font-size: 13px;
  font-weight: 600;
}

.sp-ops__audit-search:disabled {
  cursor: not-allowed;
  border-color: var(--ms-border-light);
  background: var(--ms-bg-page);
  color: var(--ms-text-3);
}

.sp-ops__audit-error {
  color: var(--ms-color-warning);
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
