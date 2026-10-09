<template>
  <div class="sp-home" data-testid="stock-prep-operator-home">
    <!-- G4 诚实态: while the FIRST directory read is still in flight this page knows nothing, so it
         says nothing about the world. Not an empty state — 「这里还没有您的项目」 is a positive claim,
         and making it here would be asserting something that has not been checked. -->
    <p
      v-if="!directorySettled"
      class="sp-home__loading"
      data-testid="stock-prep-operator-home-loading"
      role="status"
    >
      {{ bi('正在读取您的项目清单…', 'Reading your project list…') }}
    </p>

    <!-- 指引位 — the ONE guidance sentence this page ever shows at once (§3 wireframe A ③). Rendered
         only when something LIVE is actually waiting; when nothing is, the `nothing_today` empty state
         below carries that same sentence as its title instead of saying it twice. -->
    <p
      v-else-if="guidance"
      class="sp-home__guidance"
      data-testid="stock-prep-operator-home-guidance"
    >
      {{ guidance }}
    </p>

    <!-- U2 契约 (P0 补项 5) — at most ONE of three sentences, in this order, and ONLY when the
         directory explicitly says so (an older backend, or a directory that has not settled the union
         read yet, shows NONE of them — see `pullBanner`'s own comment for why `undefined` must never
         read as `false`). -->
    <p
      v-if="pullBanner"
      class="sp-home__pull-banner"
      data-testid="stock-prep-operator-home-pull-banner"
      :data-pull-banner="pullBanner.key"
    >
      {{ bi(pullBanner.text.zh, pullBanner.text.en) }}
    </p>

    <!-- 打开备料多维表 (this PR) — the entry the operator asked for, and the reason it is HERE.
         项目备料页 has had this button since it shipped, but that page needs a project number in
         hand: before anything is pulled it 404s, so on the landing page — where an operator
         actually starts — there was no way to reach the sheet they fill at all. The handle comes
         from the directory read this page already makes (`?includePullTargets=1`), so this costs
         no extra request; it renders ONLY when the server issued one, because a button that
         cannot land on the right sheet is what the fallback copy on 项目备料页 is for.
         WHAT IT DOES NOT CLAIM: the handle is not a permission decision. Multitable enforces
         access when the operator lands. -->
    <p
      v-if="fillTarget"
      class="sp-home__fill"
      data-testid="stock-prep-operator-home-fill"
    >
      <button
        type="button"
        class="sp-home__link"
        data-testid="stock-prep-operator-home-open-multitable"
        @click="emit('open-multitable')"
      >
        {{ bi('打开备料多维表', 'Open the stock-preparation table') }}
      </button>
      <span class="sp-home__fill-hint">
        {{ bi(
          '请按项目号在备料表里找到您的项目。',
          'Find your project in the stock-preparation table by its project number.',
        ) }}
      </span>
    </p>

    <!-- 一个项目一张备料表 (S2, R-36) — the projectTarget.list control of the workbench manifest
         (OPERATE). Rendered only when GET …/project-targets answered, i.e. the server's switch is on;
         with it off the page says exactly what it said before. -->
    <div
      v-if="projectTargets"
      class="sp-home__project-sheets"
      data-testid="stock-prep-project-target-list"
      :data-registered-count="projectTargets.count"
    >
      <p class="sp-home__project-sheets-line">
        {{ bi(oneSheetPerProject.zh, oneSheetPerProject.en) }}
        {{ bi(`已经有 ${projectTargets.count} 个项目建了表。`, `${projectTargets.count} project(s) have a sheet so far.`) }}
      </p>
      <!-- 项目总览表 (S3, ADR §5, register R-37). 「刷新项目总览」 is the projectOverview.refresh control
           of the workbench manifest (OPERATE): rendered only for a holder of that capability, and only
           inside this block — i.e. once the list answered (switch on). 「打开项目总览」 is a plain deep
           link to the overview's 「进行中」 view, rendered only when the server issued both handles; the
           sheet is host-level read-only, so opening it grants nothing. -->
      <p
        v-if="canRefreshOverview || overviewOpenTarget"
        class="sp-home__overview"
        data-testid="stock-prep-project-overview"
      >
        <button
          v-if="canRefreshOverview"
          type="button"
          class="sp-home__link"
          data-testid="stock-prep-project-overview-refresh"
          :disabled="overviewBusy"
          @click="onRefreshOverview"
        >
          {{ overviewBusy
            ? bi(overviewPlain('overview_refreshing').zh, overviewPlain('overview_refreshing').en)
            : bi(overviewPlain('overview_refresh_action').zh, overviewPlain('overview_refresh_action').en) }}
        </button>
        <button
          v-if="overviewOpenTarget"
          type="button"
          class="sp-home__link"
          data-testid="stock-prep-project-overview-open"
          @click="emit('open-multitable', overviewOpenTarget)"
        >
          {{ bi(overviewPlain('overview_open_action').zh, overviewPlain('overview_open_action').en) }}
        </button>
      </p>
      <p
        v-if="overviewNotice"
        class="sp-home__overview-result"
        data-testid="stock-prep-project-overview-result"
        :data-result="overviewNotice.kind"
        role="status"
      >
        {{ bi(overviewNoticeText.zh, overviewNoticeText.en) }}
        <span v-if="overviewNoticeText.zhNext">{{ bi(overviewNoticeText.zhNext, overviewNoticeText.enNext ?? '') }}</span>
        <code v-if="overviewNotice.kind === 'refused' && overviewNotice.code" class="sp-home__token">{{ overviewNotice.code }}</code>
      </p>
    </div>

    <EmptyState
      v-if="emptyState"
      class="sp-home__empty"
      :data-testid="'stock-prep-operator-home-empty'"
      :data-empty-state="emptyState"
      :title="emptyStateText.title"
      :hint="emptyStateText.hint"
    >
      <template v-if="emptyState !== 'nothing_today'" #action>
        <button type="button" class="sp-home__link" @click="emit('focus-quick-open')">
          {{ canPull ? bi('拉一个新项目', 'Pull a new project in') : bi('打开一个项目', 'Open a project') }}
        </button>
      </template>
    </EmptyState>

    <!-- 从列表移除 (客户反馈 2026-09-24 #1a / A8): the cards below were previously permanent and
         unlabelled — no way to remove one, and nothing explaining that a card is only a shortcut. One
         static line covers both, and the dynamic confirmation below it is rendered HERE, at the page
         level, so it survives even when the removed card's own DOM node does not (see `onRemoveCard`'s
         own comment for why it may not disappear on this click at all). -->
    <p
      v-if="cards.length > 0"
      class="sp-home__cards-explainer"
      data-testid="stock-prep-operator-home-cards-explainer"
    >
      {{ bi(
        '这些卡片只是快捷入口，移除不会删除任何数据；重新登录后这台电脑记住的列表会清空、隐藏也会失效。',
        'These cards are only shortcuts. Removing one does not delete any data; signing in again clears what this computer remembers, including anything hidden.',
      ) }}
    </p>

    <!-- 全部恢复 (S2, adversarial review 2026-09-26): shown WHENEVER something is hidden, regardless of
         `cards.length` — when every visible card happens to be hidden this is the ONLY thing left on
         screen saying so, which is exactly why `resolveOperatorHomeEmptyState` steps aside for
         `no_projects` in that case (see its own doc) rather than the two contradicting each other. -->
    <p
      v-if="hiddenCount > 0"
      class="sp-home__hidden-banner"
      data-testid="stock-prep-operator-home-hidden-banner"
    >
      {{ bi(`已从列表移除 ${hiddenCount} 个项目 · `, `Removed ${hiddenCount} project(s) from this list · `) }}
      <button
        type="button"
        class="sp-home__link"
        data-testid="stock-prep-operator-home-restore-all"
        @click="onRestoreAll"
      >
        {{ bi('全部恢复', 'Restore all') }}
      </button>
    </p>

    <p
      v-if="removalNoticeText"
      class="sp-home__removed-notice"
      data-testid="stock-prep-operator-home-removed-notice"
      :data-notice-kind="removalNotice?.kind"
      role="status"
    >
      {{ bi(removalNoticeText[0], removalNoticeText[1]) }}
    </p>

    <!-- 一级常驻筛选 — a row of five count buttons (§3 wireframe A ④), never a dropdown. -->
    <div v-if="cards.length > 0" class="sp-home__filters" data-testid="stock-prep-operator-home-filters">
      <button
        v-for="filter in filters"
        :key="filter.key"
        type="button"
        class="sp-home__filter"
        :class="{ 'sp-home__filter--active': activeFilter === filter.key }"
        :data-testid="`stock-prep-operator-home-filter-${filter.key}`"
        :aria-pressed="activeFilter === filter.key ? 'true' : 'false'"
        :title="filter.key === 'ready' ? bi(readyTooltip.zh, readyTooltip.en) : undefined"
        @click="toggleFilter(filter.key)"
      >
        {{ filter.label }} {{ filter.count }}
      </button>
    </div>

    <div v-if="cards.length > 0" class="sp-home__cards" data-testid="stock-prep-operator-home-cards">
      <!-- G2: pressing a chip whose count is 0 is a NEW empty condition, so it gets its own
           `data-empty-state` value and its own words rather than an empty box. -->
      <p
        v-if="visibleCards.length === 0"
        class="sp-home__filter-empty"
        data-testid="stock-prep-operator-home-filter-empty"
        data-empty-state="filter_empty"
      >
        {{ bi('这一类现在一个项目都没有。点上面的「全部」看回全部项目。', 'Nothing is in this group right now. Press 全部 above to see every project again.') }}
      </p>
      <article
        v-for="card in visibleCards"
        :key="card.projectNo"
        class="sp-home__card"
        data-testid="stock-prep-operator-home-card"
        :data-project-no="card.projectNo"
        :data-posture="card.posture.key"
      >
        <header class="sp-home__card-head">
          <span class="sp-home__card-no">{{ card.projectNo }}</span>
          <span v-if="card.projectName" class="sp-home__card-name">{{ card.projectName }}</span>
          <span
            class="sp-home__badge"
            :class="`sp-home__badge--${card.posture.tone}`"
            data-testid="stock-prep-operator-home-card-badge"
          >{{ bi(card.posture.zh, card.posture.en) }}</span>
        </header>
        <p v-if="cardRowsText(card)" class="sp-home__card-note" data-testid="stock-prep-operator-home-card-rows">
          {{ cardRowsText(card) }}
        </p>
        <p v-if="card.postureFromMemory" class="sp-home__card-note">
          {{ bi('这台电脑上次打开时的状态', 'As last known on this computer') }}
        </p>
        <p v-else-if="card.posture.key === 'unknown'" class="sp-home__card-note">
          {{ bi(
            '这台电脑还没打开过这个项目,进度看不到;打开一次就知道了。',
            'This computer has not opened this project yet, so its progress is not visible here — open it once to find out.',
          ) }}
        </p>
        <div class="sp-home__card-actions">
          <button
            type="button"
            class="sp-home__card-action"
            data-testid="stock-prep-operator-home-card-action"
            :disabled="exportingProjectNo === card.projectNo"
            @click="onCardAction(card)"
          >
            {{ cardActionLabel(card) }}
          </button>
          <!-- §3 wireframe A ⑥: the secondary 「打开」, present only where the primary does something
               ELSE. Where the primary already opens the project, a second button by that name would
               be two controls with one meaning. -->
          <button
            v-if="showsOpenButton(card)"
            type="button"
            class="sp-home__card-open"
            data-testid="stock-prep-operator-home-card-open"
            @click="emit('open-project', card.projectNo)"
          >
            {{ bi('打开', 'Open') }}
          </button>
          <!-- 从列表移除 (客户反馈 2026-09-24 #1a / A8): a low-emphasis text button, deliberately not
               styled like either action above it — removing a shortcut is not this card's purpose.
               [S3] Disabled (never merely omitted) while this card has a LIVE pending decision, with
               a tooltip saying why — see `canRemoveCard`'s own comment. -->
          <button
            type="button"
            class="sp-home__card-remove"
            data-testid="stock-prep-operator-home-card-remove"
            :disabled="!canRemoveCard(card)"
            :title="!canRemoveCard(card) ? bi('有等您处理的事，不能移除', 'This card has something waiting on you — it cannot be removed') : undefined"
            @click="onRemoveCard(card)"
          >
            {{ bi('从列表移除', 'Remove from list') }}
          </button>
        </div>
        <p
          v-if="exportNotice && exportNotice.projectNo === card.projectNo"
          class="sp-home__card-notice"
          :class="{ 'sp-home__card-notice--error': exportNotice.tone === 'error' }"
          :data-testid="exportNotice.tone === 'error'
            ? 'stock-prep-operator-home-card-error'
            : 'stock-prep-operator-home-card-export-empty'"
          role="status"
        >
          {{ bi(exportNotice.zh, exportNotice.en) }}
        </p>
      </article>
    </div>

    <!-- 「已归档（N）」 (S3, ADR §5 「首页」): archived projects leave the main list above and wait here,
         collapsed, each with the 「已归档」 tag. Archiving changes no grant, so 「打开」 stays — the
         project's page says what an archived sheet can and cannot do. Absent when N = 0. -->
    <details
      v-if="archivedCards.length > 0"
      class="sp-home__archived"
      data-testid="stock-prep-operator-home-archived"
      :data-archived-count="archivedCards.length"
    >
      <summary class="sp-home__archived-summary" data-testid="stock-prep-operator-home-archived-summary">
        {{ bi(archivedHeading.zh, archivedHeading.en) }}
      </summary>
      <ul class="sp-home__archived-list">
        <li
          v-for="card in archivedCards"
          :key="card.projectNo"
          class="sp-home__archived-item"
          data-testid="stock-prep-operator-home-archived-card"
          :data-project-no="card.projectNo"
        >
          <span class="sp-home__card-no">{{ card.projectNo }}</span>
          <span v-if="card.projectName" class="sp-home__card-name">{{ card.projectName }}</span>
          <span
            class="sp-home__badge sp-home__badge--neutral"
            data-testid="stock-prep-operator-home-archived-tag"
          >{{ bi(overviewPlain('archived_tag').zh, overviewPlain('archived_tag').en) }}</span>
          <button
            type="button"
            class="sp-home__card-open"
            data-testid="stock-prep-operator-home-archived-open"
            @click="emit('open-project', card.projectNo)"
          >
            {{ bi('打开', 'Open') }}
          </button>
        </li>
      </ul>
    </details>

    <!-- 兜底入口 (§3 wireframe A ⑦) — the HEADING AND THE HONEST SENTENCE only. The input itself is
         the workspace's own existing search box, which the parent renders immediately below this
         block instead of this component owning a second one: two boxes with byte-identical labels,
         placeholders and button text — which is what a private copy produced — is precisely the
         "不知道该点哪个" this redesign exists to remove. Its testids are therefore unchanged and the
         three existing specs that open a project through them keep working untouched. -->
    <div class="sp-home__quick-open" data-testid="stock-prep-operator-home-quick-open">
      <h3 class="sp-home__quick-open-title">{{ canPull ? bi('拉一个新项目', 'Pull a new project in') : bi('打开一个项目', 'Open a project') }}</h3>
      <!-- With the switch on (`projectTargets` answered) the old third clause — 「备料表里已经有数据的项目」,
           read off the ONE env table — is no longer true, so the hint says what is: one sheet per
           project. Q8: the `mvp` source is 「平台登记」, never 「归档过」 (「已归档」 is the project-sheet
           lifecycle now). -->
      <p class="sp-home__quick-open-hint" data-testid="stock-prep-operator-home-quick-open-hint">
        <template v-if="projectTargets">{{ bi(oneSheetPerProject.zhNext ?? '', oneSheetPerProject.enNext ?? '') }}</template>
        <template v-else>{{ bi(
          '找不到号码?列表里有这台电脑最近开过的项目、平台登记的项目,以及备料表里已经有数据的项目(不论是谁拉进去的)。直接把号码打进去也一样能打开。',
          'Cannot find the number? The list includes projects this computer recently opened, platform-registered projects, and projects that already have data in the stock-preparation table, whoever pulled them in — typing the number in directly always works too.',
        ) }}</template>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
// 今天要处理 (P0-2) — the operator's task-oriented landing page, mounted by
// StockPreparationProjectBoardView.vue whenever no project number is open yet (§2.3: 寄生 in the
// existing `project-board` tab, ZERO tab-structure change).
//
// DATA SOURCE (D1=A). "目录 + 本机记忆两路并集" — both halves are HANDED to this component by the
// parent (which already loads the directory once and already owns the memory read, so a predread
// failure is absorbed exactly once, not doubled). See `operatorHomeCards.ts` for the per-field merge
// and why a directory row does NOT simply win.
//
// ONE DELIBERATE EXCEPTION (客户反馈 2026-09-24 #1a / A8): 从列表移除's hidden-project list. See the
// `remove-recent-project` emit's own comment for why this component reads/writes that ONE piece of
// storage itself instead of asking the parent.
//
// NO NEW READ ON THIS SCREEN, except the one action that IS a real write-shaped user click: exporting
// a 「可以导出」 card's materials directly from its card (H14 discipline — a button that says
// 导出物料清单 must actually export, not merely navigate to a page that could).
//
// G1 ON THIS SCREEN. §1.2's falsifiable criterion is "任一屏截图里 --ms-color-primary 填充的按钮 ≤ 1",
// while §3 wireframe A draws a ★ on every card. Rather than leave that contradiction for a reviewer
// to re-litigate, the card CTA is an OUTLINED accent button — emphasised, unmistakably the card's
// main action, and not a `--ms-color-primary` fill. The criterion then holds literally on this screen
// too (zero filled primaries), and the one filled primary in the whole tab stays where §3 wireframe C
// ③ puts it: the workspace's 「下一步」 bar.
import { computed, onBeforeUnmount, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import EmptyState from '../../status/EmptyState.vue'
import type { IntegrationScope } from '../../../services/integration/workbench'
import type { StockPreparationOperatorDirectory } from '../../../services/integration/stockPreparation/confirmationQueue'
import { exportStockPreparationPrepLines } from '../../../services/integration/stockPreparation/confirmationQueue'
import {
  clearStockPrepHiddenProjects,
  HIDDEN_MAX_ENTRIES,
  readStockPrepHiddenProjects,
  removeStockPrepRecentProject,
  type StockPrepRecentProjectEntry,
} from '../../../services/integration/stockPreparation/operatorHomeMemory'
import {
  buildOperatorHomeCards,
  countActionableOperatorHomeCards,
  countOperatorHomeCardsByFilter,
  filterOperatorHomeCards,
  partitionOperatorHomeCards,
  resolveOperatorHomeEmptyState,
  sortOperatorHomeCards,
  stockPrepHomeStatusLabel,
  STOCK_PREP_HOME_FILTER_KEYS,
  type StockPrepHomeCard,
  type StockPrepHomeFilterKey,
} from '../../../services/integration/stockPreparation/operatorHomeCards'
import {
  resolveStockPrepPullBanner,
  stockPrepErrorPlain,
  stockPrepExportTenantWallPlain,
  stockPrepHomeArchivedHeading,
  stockPrepProjectOverviewPlain,
  stockPrepProjectOverviewRefreshText,
  stockPrepProjectTargetPlain,
  stockPrepProjectTargetRowCountText,
  STOCK_PREP_TOOLTIP_READY_TO_EXPORT,
  type StockPrepPlainEntry,
} from '../../../services/integration/stockPreparation/plainLanguage'
import {
  createStockPreparationProjectTargetApi,
  refreshStockPreparationProjectOverview,
  stockPrepProjectOverviewOpenTarget,
  type StockPrepProjectOverviewRefreshOutcome,
  type StockPrepProjectOverviewRefreshResult,
  type StockPrepProjectTargetList,
  type StockPreparationProjectTargetApi,
} from '../../../services/integration/stockPreparation/projectTarget'

const props = withDefaults(
  defineProps<{
    scope?: IntegrationScope
    /** Loaded once by the parent (StockPreparationProjectBoardView.vue) — this component fetches nothing. */
    directory?: StockPreparationOperatorDirectory | null
    /** False only while the parent's very first directory read is still in flight. True once it has
     *  settled either way — the two are different facts and this page says different things for them. */
    directoryLoaded?: boolean
    /** This browser's memory of projects it opened before, read ONCE by the parent (D1=A's local half). */
    memory?: readonly StockPrepRecentProjectEntry[]
    /**
     * R-33 (2026-10-08): whether THIS viewer may pull from PLM — the parent passes the same predicate
     * its pull button renders on (`canRunStockPrepProjectSync`). `false` rewrites the three
     * pull-inviting lines on this page (empty-state action, fallback heading, no_projects hint) to
     * 「打开一个项目」 / 「由拉取人员拉取」, so a floor operator is never invited to do a step they
     * cannot. Defaults to `true` so a parent without a principal keeps today's words.
     */
    canPull?: boolean
    /**
     * S2 (R-36): the tenant's project-sheet registry list, loaded by the parent with the directory.
     * `null` = the server's switch is off (404 DISABLED) or the list was unreadable — the page then
     * says exactly what it said before S2.
     */
    projectTargets?: StockPrepProjectTargetList | null
    /**
     * S3 (R-37): whether THIS viewer holds `projectOverview.refresh` — the parent resolves it from the
     * workbench manifest mirror (`grantedStockPrepCapabilities`), the same way it resolves the
     * archive / restore controls. Defaults to `false`: no principal, no button.
     */
    canRefreshOverview?: boolean
    /** Test seam ONLY (S3) — the project-target client for the refresh. Null in production: built from `scope`. */
    targetApi?: StockPreparationProjectTargetApi | null
  }>(),
  {
    scope: () => ({}),
    directory: null,
    directoryLoaded: false,
    memory: () => [],
    canPull: true,
    projectTargets: null,
    canRefreshOverview: false,
    targetApi: null,
  },
)

const emit = defineEmits<{
  /** Open this project's workspace — mirrors the board's own search box. */
  (e: 'open-project', projectNo: string): void
  /** Open the project AND land directly in the confirmation queue, seeded with its number. */
  (e: 'open-project-in-queue', projectNo: string): void
  /** Put the cursor in the fallback input the parent renders into this component's own slot. */
  (e: 'focus-quick-open'): void
  /**
   * 打开备料多维表. NO PAYLOAD, deliberately: the parent already holds the directory this page is
   * rendered from and resolves the handle in ONE place (`openFillTarget`), shared with the board's
   * own button. Sending the target back up would be a second copy of that decision.
   *
   * S3: 「打开项目总览」 is the one caller that DOES send a target — the overview sheet is not the
   * fill sheet, and only this page holds its handles (from the registry list or the refresh it just
   * ran). The parent routes a target as-is and falls back to `openFillTarget` without one.
   */
  (e: 'open-multitable', target?: { sheetId: string; viewId: string }): void
  /** S3: the overview was refreshed — the parent re-reads the registry list (counts, handles). */
  (e: 'overview-refreshed', result: StockPrepProjectOverviewRefreshResult): void
  /**
   * 从列表移除 (客户反馈 2026-09-24 #1a / A8) — informational only. Every OTHER mutation on this page
   * follows the contract at the top of `props`: this component reads nothing from storage and asks the
   * parent to write. This one is the deliberate exception: `StockPreparationProjectBoardView.vue` is a
   * pinned file another concurrent PR (A6) is editing at the time of this change, so this component
   * calls `removeStockPrepRecentProject` / `readStockPrepHiddenProjects` itself (below) rather than
   * adding a parent-side listener, and keeps its own `hiddenProjectNos` state to react immediately.
   * This event still fires so a LATER pass can move the write up to the parent (restoring the usual
   * contract) without this component needing another change — the parent choosing not to listen today
   * changes nothing about what already happened.
   */
  (e: 'remove-recent-project', projectNo: string): void
}>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

/**
 * The deep-link handle the SERVER issued for this tenant, or null. Read defensively: the key is
 * absent on a backend that predates it and on any read that did not opt into the union, and a
 * half-shaped object must render as 「没有」 rather than as a link to nothing.
 */
const fillTarget = computed(() => {
  const target = props.directory?.fillTarget
  if (!target || typeof target.sheetId !== 'string' || typeof target.viewId !== 'string') return null
  return target.sheetId.length > 0 && target.viewId.length > 0 ? target : null
})

const directoryProjects = computed(() => {
  const list = props.directory?.projects
  return Array.isArray(list) ? list : []
})

/**
 * 从列表移除 (客户反馈 2026-09-24 #1a / A8). Read once at setup — the same "no prop watch" posture
 * `recentProjects` takes in the parent — and mutated in place by `onRemoveCard` below rather than
 * re-read from storage on every render, so a removal is reflected the instant it happens with no extra
 * round trip through `props.scope`. See the `remove-recent-project` emit's own doc for why this
 * component owns this one read/write pair instead of the parent. Unhiding on a REOPEN happens inside
 * `recordStockPrepProjectVisit` itself (operatorHomeMemory.ts) — the parent already calls that on every
 * live posture change, so a project this browser hides and then reopens unhides on its own, with no
 * change needed here or in the parent for that half of the contract.
 */
const hiddenProjectNos = ref<Set<string>>(new Set(readStockPrepHiddenProjects(props.scope)))

/** [S2] How many projects this browser is currently choosing not to show — see `resolveOperatorHomeEmptyState`'s own doc for why the empty-state logic needs this, and the persistent banner below for why the UI does too. */
const hiddenCount = computed(() => hiddenProjectNos.value.size)

/**
 * S3 (ADR §5 「首页」): the MAIN list excludes archived projects; they go to the collapsed
 * 「已归档（N）」 section below it. Every count on this page — the five chips, the guidance line, the
 * explainer — is over the main list; only the empty-state decision also counts the archived half, so
 * a tenant whose every project is archived is never told 「这里还没有您的项目」.
 */
const partitionedCards = computed(() => partitionOperatorHomeCards(sortOperatorHomeCards(
  buildOperatorHomeCards(directoryProjects.value, props.memory ?? [], hiddenProjectNos.value),
)))

const cards = computed<StockPrepHomeCard[]>(() => partitionedCards.value.active)
const archivedCards = computed<StockPrepHomeCard[]>(() => partitionedCards.value.archived)
const archivedHeading = computed(() => stockPrepHomeArchivedHeading(archivedCards.value.length))

const actionable = computed(() => countActionableOperatorHomeCards(cards.value))

const directorySettled = computed(() => props.directoryLoaded === true)
const directoryAvailable = computed(() => props.directory !== null)

const emptyState = computed(() => resolveOperatorHomeEmptyState({
  directorySettled: directorySettled.value,
  directoryAvailable: directoryAvailable.value,
  cardCount: cards.value.length + archivedCards.value.length,
  actionableCount: actionable.value.any,
  hiddenCount: hiddenCount.value,
}))

const EMPTY_STATE_TEXT: Record<string, { title: [string, string]; hint: [string, string] }> = {
  no_projects: {
    title: ['这里还没有您的项目', 'There is nothing here for you yet'],
    hint: [
      '备料从"把项目从 PLM 拉进来"开始。知道项目号就可以自己拉。',
      'Stock preparation starts by pulling a project in from PLM — if you know the number you can pull it in yourself.',
    ],
  },
  nothing_today: {
    title: ['今天没有等您的事', 'Nothing is waiting on you today'],
    hint: [
      // N1 (adversarial review 2026-09-26): this used to say 「最近开过的」, which is only true of a
      // MEMORY card — a directory-only card below may be one this browser has never opened at all.
      '下面是您能看到的项目,随时可以打开看看。',
      'Below are the projects you can see — open any of them whenever you like.',
    ],
  },
  directory_unavailable: {
    title: ['项目清单暂时读不到', 'The project list could not be read right now'],
    hint: ['这不影响您用项目号直接打开。', 'That does not stop you from opening a project directly by its number.'],
  },
}

const emptyStateText = computed(() => {
  const state = emptyState.value
  const entry = state ? EMPTY_STATE_TEXT[state] : null
  if (!entry) return { title: '', hint: '' }
  // R-33: a viewer who cannot pull is told who does, not 「可以自己拉」.
  if (state === 'no_projects' && !props.canPull) {
    return {
      title: bi(...entry.title),
      hint: bi(
        '备料从"把项目从 PLM 拉进来"开始,由拉取人员拉取。知道项目号可以直接打开查看。',
        'Stock preparation starts by pulling a project in from PLM — a pull operator (拉取人员) does that. If you know the number you can open it directly.',
      ),
    }
  }
  return { title: bi(...entry.title), hint: bi(...entry.hint) }
})

/**
 * 指引位, worded as §4.1 I-1 words it: the badge phrase becomes a SENTENCE
 * (「有 2 件事等您拿主意」), not a label spliced into one. Driven by the LIVE actionable count only —
 * a remembered conclusion may have been resolved by a colleague on another machine, and 「今天有 N 个
 * 项目在等您」 is an assertion about right now.
 */
const guidance = computed<string | null>(() => {
  if (emptyState.value) return null
  const n = actionable.value.live
  if (n <= 0) return null
  const top = cards.value.find((card) => !card.postureFromMemory
    && (card.posture.key === 'pending_decision' || card.posture.key === 'blocked'))
  if (!top) return null
  const lead = top.posture.key === 'pending_decision'
    ? [
      `有 ${top.pendingDecisionCount ?? 0} 件事等您拿主意。`,
      `${top.pendingDecisionCount ?? 0} thing(s) need your call.`,
    ] as const
    : ['有零件在源系统里找不到,补齐之前写不进去。', 'Parts are missing in the source system; nothing can be written until they are fixed.'] as const
  return bi(
    `今天有 ${n} 个项目在等您。先处理最上面这个:${lead[0]}`,
    `${n} project(s) are waiting on you today. Start with the one on top: ${lead[1]}`,
  )
})

/** I-20: the 可以导出 filter chip's tooltip. */
const readyTooltip = STOCK_PREP_TOOLTIP_READY_TO_EXPORT

// ── 一个项目一张备料表 (S2, R-36) ────────────────────────────────────────────────────────────────

const oneSheetPerProject: StockPrepPlainEntry = stockPrepProjectTargetPlain('home_one_sheet_per_project')
  ?? { zh: '', en: '' }

/**
 * ADR §7 「首页卡片:共 N 行(有效 M 行)」 — from the registry row of THIS card's project, and only
 * when the server counted (the registry's count columns are filled by the overview refresh, S3; until
 * then they are null and the card says nothing rather than 「0 行」).
 */
function cardRowsText(card: StockPrepHomeCard): string {
  const list = props.projectTargets
  if (!list) return ''
  const row = list.items.find((item) => item.projectNo === card.projectNo)
  if (!row || row.status === 'absent') return ''
  const text = stockPrepProjectTargetRowCountText({
    rowCount: row.rowCount,
    activeRowCount: row.activeRowCount,
    rowCountBounded: row.countsBounded,
  })
  return text ? bi(text.zh, text.en) : ''
}

// ── 项目总览表 (S3, ADR §5, register R-37) ──────────────────────────────────────────────────────────

function overviewPlain(id: string): StockPrepPlainEntry {
  return stockPrepProjectOverviewPlain(id) ?? { zh: id, en: id }
}

/** The last refresh's answer on THIS page — it carries the handles before the parent's list re-read lands. */
const refreshedOverview = ref<StockPrepProjectOverviewRefreshResult | null>(null)

/** 「打开项目总览」's target: the freshest pair of handles, never a half link. */
const overviewOpenTarget = computed(() => stockPrepProjectOverviewOpenTarget(refreshedOverview.value)
  ?? stockPrepProjectOverviewOpenTarget(props.projectTargets?.overview ?? null))

const overviewBusy = ref(false)
const overviewNotice = ref<StockPrepProjectOverviewRefreshOutcome | null>(null)

/**
 * 刷新项目总览 — a write-shaped click, so its answer is VISIBLE either way (G3): the one result line,
 * or the refusal's plain sentence and code. The server re-checks the gate (OPERATE) and answers 404
 * DISABLED while the switch is off; this page only renders the button for a holder of the capability.
 */
async function onRefreshOverview(): Promise<void> {
  if (overviewBusy.value || !props.canRefreshOverview) return
  overviewBusy.value = true
  overviewNotice.value = null
  try {
    const outcome = await refreshStockPreparationProjectOverview(props.targetApi ?? createStockPreparationProjectTargetApi(props.scope))
    overviewNotice.value = outcome
    if (outcome.kind === 'done') {
      refreshedOverview.value = outcome.result
      emit('overview-refreshed', outcome.result)
    }
  } finally {
    overviewBusy.value = false
  }
}

const overviewNoticeText = computed<StockPrepPlainEntry>(() => {
  const notice = overviewNotice.value
  if (!notice) return { zh: '', en: '' }
  if (notice.kind === 'done') return stockPrepProjectOverviewRefreshText(notice.result)
  return stockPrepErrorPlain(notice.code ?? '')
})

/**
 * U2 契约 (P0 补项 5)'s three-sentence priority chain — shared with 项目查询 (hardening wave, see
 * `resolveStockPrepPullBanner`'s own comment in plainLanguage.ts for the priority order and why every
 * check is `=== true` / `=== false` rather than a truthiness test, never restated here).
 */
const pullBanner = computed(() => resolveStockPrepPullBanner(props.directory))

const filters = computed(() => STOCK_PREP_HOME_FILTER_KEYS.map((key) => ({
  key,
  label: bi(...stockPrepHomeStatusLabel(key)),
  count: countOperatorHomeCardsByFilter(cards.value, key),
})))

const activeFilter = ref<StockPrepHomeFilterKey>('all')

function toggleFilter(key: StockPrepHomeFilterKey): void {
  activeFilter.value = activeFilter.value === key ? 'all' : key
}

const visibleCards = computed(() => filterOperatorHomeCards(cards.value, activeFilter.value))

function cardActionLabel(card: StockPrepHomeCard): string {
  if (card.posture.key === 'pending_decision') {
    const n = card.pendingDecisionCount
    return n && n > 0
      ? bi(`去处理这 ${n} 件事`, `Handle these ${n} now`)
      : bi('去处理这些事', 'Handle these now')
  }
  if (card.posture.key === 'blocked') return bi('看缺哪些件', 'See which parts are missing')
  if (card.posture.key === 'ready') return bi('导出物料清单(Excel)', 'Export materials (Excel)')
  return bi('打开这个项目', 'Open this project')
}

/** True only where the card's own primary action goes somewhere OTHER than this project's workspace. */
function showsOpenButton(card: StockPrepHomeCard): boolean {
  return card.posture.key === 'pending_decision' || card.posture.key === 'ready'
}

/**
 * [S3, adversarial review 2026-09-26] A card the ledger says is waiting on this operator RIGHT NOW must
 * not even offer 从列表移除 — `buildOperatorHomeCards`'s own guard would keep it visible anyway (belt),
 * but disabling the button here (braces) means the notice below can never claim 已移除 for a card that
 * plainly did not go anywhere, and the operator gets told WHY before clicking rather than after.
 * `pendingDecisionCount` is only ever non-null on a `directory` card carrying a LIVE ledger count (see
 * its own field doc in operatorHomeCards.ts) — a memory-only card's `null` here always allows removal.
 */
function canRemoveCard(card: StockPrepHomeCard): boolean {
  return !(card.pendingDecisionCount !== null && card.pendingDecisionCount > 0)
}

/**
 * 从列表移除 (客户反馈 2026-09-24 #1a / A8). The card may not actually leave the grid on this click —
 * `buildOperatorHomeCards` still shows a directory row with a LIVE `pendingDecisionCount > 0` — so the
 * confirmation line below is rendered at the page level, never inside the card's own DOM node, and
 * survives whether or not that node is still there after this render.
 *
 * [N4] Names the project and auto-clears after a short delay, rather than sitting on screen forever or
 * silently getting replaced by the next unrelated render.
 */
const REMOVAL_NOTICE_DISMISS_MS = 6000

const removalNotice = ref<{ projectNo: string; kind: 'removed' | 'limit_reached' } | null>(null)
let removalNoticeTimer: ReturnType<typeof setTimeout> | null = null

function clearRemovalNoticeTimer(): void {
  if (removalNoticeTimer !== null) {
    clearTimeout(removalNoticeTimer)
    removalNoticeTimer = null
  }
}

function showRemovalNotice(notice: { projectNo: string; kind: 'removed' | 'limit_reached' }): void {
  clearRemovalNoticeTimer()
  removalNotice.value = notice
  removalNoticeTimer = setTimeout(() => {
    removalNotice.value = null
    removalNoticeTimer = null
  }, REMOVAL_NOTICE_DISMISS_MS)
}

onBeforeUnmount(clearRemovalNoticeTimer)

/**
 * [S1] `removeStockPrepRecentProject` REFUSES rather than evicts once the hidden list is full — this
 * only updates `hiddenProjectNos` (so the grid actually changes) and emits `remove-recent-project` on
 * an ACTUAL hide (`'hidden'`), never on `'limit_reached'`: a card that stayed exactly where it was must
 * never be reported upstream as removed.
 */
function onRemoveCard(card: StockPrepHomeCard): void {
  if (!canRemoveCard(card)) return
  const result = removeStockPrepRecentProject(card.projectNo, props.scope)
  if (result === 'limit_reached') {
    showRemovalNotice({ projectNo: card.projectNo, kind: 'limit_reached' })
    return
  }
  hiddenProjectNos.value = new Set(hiddenProjectNos.value).add(card.projectNo)
  showRemovalNotice({ projectNo: card.projectNo, kind: 'removed' })
  emit('remove-recent-project', card.projectNo)
}

/** 全部恢复 (S2) — clears every project this scope hid, on this one browser, right now. */
function onRestoreAll(): void {
  clearStockPrepHiddenProjects(props.scope)
  hiddenProjectNos.value = new Set()
}

/**
 * [N4] Names the removed (or refused) project every time, rather than a generic sentence — the two
 * kinds are worded differently on purpose (S3/S1's own point): one claims a removal happened, the
 * other explicitly says it did not.
 */
const removalNoticeText = computed<readonly [string, string] | null>(() => {
  const notice = removalNotice.value
  if (!notice) return null
  if (notice.kind === 'limit_reached') {
    return [
      `隐藏列表已满(最多 ${HIDDEN_MAX_ENTRIES} 个),项目 ${notice.projectNo} 这次没有被移除。`,
      `The hidden list is full (limit ${HIDDEN_MAX_ENTRIES}) — project ${notice.projectNo} was not removed this time.`,
    ]
  }
  return [
    `已从这台电脑的列表里移除项目 ${notice.projectNo}。数据没有删除，还在备料表里；要再看它，去「项目查询」或在下面输入项目号打开。`,
    `Removed project ${notice.projectNo} from this computer's list. No data was deleted — it is still in the stock-preparation table; to see it again, go to Project Query or open it by number below.`,
  ]
})

function onCardAction(card: StockPrepHomeCard): void {
  if (card.posture.key === 'pending_decision') {
    emit('open-project-in-queue', card.projectNo)
    return
  }
  if (card.posture.key === 'ready') {
    void exportCard(card.projectNo)
    return
  }
  emit('open-project', card.projectNo)
}

const exportingProjectNo = ref<string | null>(null)
const exportNotice = ref<{ projectNo: string; tone: 'error' | 'info'; zh: string; en: string } | null>(null)

/** The same authenticated-Blob download trigger StockPreparationProjectBoardView.vue uses (#5437). */
function triggerExportDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

async function exportCard(projectNo: string): Promise<void> {
  exportNotice.value = null
  exportingProjectNo.value = projectNo
  try {
    const result = await exportStockPreparationPrepLines({ ...props.scope, projectNo })
    triggerExportDownload(result.blob, result.filename)
    // The SAME sentence the workspace's own export uses for an empty result. A file that downloads
    // with nothing but headers, silently, is how somebody sends an empty sheet on to the next person.
    if (result.activeRowCount === 0) {
      exportNotice.value = {
        projectNo,
        tone: 'info',
        zh: '这个项目号下没有有效的物料行,已下载一份仅含表头的空白模板。',
        en: 'This project number has no active material rows — an empty, headers-only template was downloaded.',
      }
    }
  } catch (error) {
    // THE TENANT WALL gets its own words: the bound 备料主表 is not provably this factory's, and
    // 「稍后再点一次」 would send the operator round in circles on a refusal no retry can change.
    const wall = stockPrepExportTenantWallPlain((error as { code?: unknown } | null)?.code)
    if (wall) {
      exportNotice.value = {
        projectNo,
        tone: 'error',
        zh: wall.zhNext ? `${wall.zh}${wall.zhNext}` : wall.zh,
        en: wall.enNext ? `${wall.en} ${wall.enNext}` : wall.en,
      }
      return
    }
    // A generic, values-free failure line — this button is a genuine write-shaped click (G3), so it
    // gets a visible answer, unlike the silent predreads elsewhere on this page.
    exportNotice.value = {
      projectNo,
      tone: 'error',
      zh: '文件没有下载成功,数据没有变化。稍后再点一次;还是不行就找管理员。',
      en: 'The file did not download; nothing changed. Try again shortly, or ask an administrator if it keeps failing.',
    }
  } finally {
    exportingProjectNo.value = null
  }
}
</script>

<style scoped>
.sp-home {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4);
}

.sp-home__loading {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 13px;
}

.sp-home__guidance {
  margin: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font-size: 13px;
  line-height: 1.7;
}

.sp-home__empty {
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

/* U2 契约 (P0 补项 5): a diagnostic, not an alarm — same muted treatment as every other subordinate
   hint on this page (§4's 「不吓人」), never the danger/warning color used for a real blocker. */
.sp-home__pull-banner {
  margin: 0;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
}

/* 从列表移除 (客户反馈 2026-09-24 #1a / A8): a muted, always-on line — not a warning, not a tip that
   only appears once — explaining what the cards below actually are before anyone has to guess. */
.sp-home__cards-explainer {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
}

/* 全部恢复 (S2): visually similar to the pull-banner — a diagnostic line, not an alarm — but its own
   class because its content (count + a live button) differs from every other muted line here. */
.sp-home__hidden-banner {
  margin: 0;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
}

/* The dynamic counterpart above: rendered at the page level (never inside a card's own node) so it
   survives whether or not the card that triggered it is still in `visibleCards` after this render. */
.sp-home__removed-notice {
  margin: 0;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.6;
}

/* 打开备料多维表 — one line, subordinate to the banner above it: it is a way OUT of this page, not
   a thing waiting on the operator, so it never competes with 指引位 for attention. */
.sp-home__fill {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 12px;
}

.sp-home__fill-hint {
  color: var(--ms-color-text-secondary, #6b7280);
  font-size: 12px;
}

/* S3: the overview line sits inside the project-sheets block — links, not buttons, like 打开备料多维表. */
.sp-home__project-sheets-line,
.sp-home__overview,
.sp-home__overview-result {
  margin: 0;
}

.sp-home__overview {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-3);
  margin-top: var(--ms-space-2);
}

.sp-home__overview-result {
  margin-top: var(--ms-space-2);
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.6;
}

.sp-home__token {
  margin: 0 4px;
  font-size: 11px;
  color: var(--ms-text-3);
}

/* S3: 「已归档（N）」 — collapsed, muted, below the main list. */
.sp-home__archived {
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.sp-home__archived-summary {
  cursor: pointer;
  color: var(--ms-text-2);
  font-size: 13px;
}

.sp-home__archived-list {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  margin: var(--ms-space-2) 0 0;
  padding: 0;
  list-style: none;
}

.sp-home__archived-item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
}
.sp-home__link {
  border: none;
  background: none;
  padding: 0;
  color: var(--ms-color-primary, #1677ff);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}

.sp-home__filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.sp-home__filter {
  padding: 6px 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 999px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-home__filter--active {
  border-color: var(--ms-color-primary);
  color: var(--ms-color-primary);
  font-weight: var(--ms-font-weight-title, 600);
}

.sp-home__cards {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-home__filter-empty {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 13px;
}

.sp-home__card {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.sp-home__card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
}

.sp-home__card-no {
  font-weight: var(--ms-font-weight-title, 600);
  color: var(--ms-text-1);
}

.sp-home__card-name {
  color: var(--ms-text-2);
  font-size: 13px;
}

.sp-home__badge {
  margin-left: auto;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: var(--ms-font-weight-title, 600);
}

.sp-home__badge--warning { background: color-mix(in srgb, var(--ms-color-warning) 16%, transparent); color: var(--ms-color-warning); }
.sp-home__badge--danger { background: color-mix(in srgb, var(--ms-color-danger) 16%, transparent); color: var(--ms-color-danger); }
.sp-home__badge--primary { background: color-mix(in srgb, var(--ms-color-primary) 16%, transparent); color: var(--ms-color-primary); }
.sp-home__badge--success { background: color-mix(in srgb, var(--ms-color-success) 16%, transparent); color: var(--ms-color-success); }
.sp-home__badge--info { background: color-mix(in srgb, var(--ms-color-info) 20%, transparent); color: var(--ms-color-info); }
.sp-home__badge--neutral { background: var(--ms-bg-page); color: var(--ms-text-3); }

.sp-home__card-note {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-home__card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

/* G1: an OUTLINED accent button, deliberately NOT a `--ms-color-primary` fill. See the script
   header for why the wireframe's per-card ★ is rendered this way. */
.sp-home__card-action {
  padding: 7px 14px;
  border: 1px solid var(--ms-color-primary);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--ms-color-primary);
  font: inherit;
  font-weight: var(--ms-font-weight-title, 600);
  cursor: pointer;
}

.sp-home__card-action:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.sp-home__card-open {
  padding: 7px 14px;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  color: var(--ms-text-1);
  font: inherit;
  cursor: pointer;
}

/* 从列表移除 — the low-emphasis text button §3's card asks for: no border, no fill, muted colour, so
   it reads as the least important control on the card rather than a third peer of the two above it. */
.sp-home__card-remove {
  align-self: flex-start;
  margin-left: auto;
  border: none;
  background: none;
  padding: 7px 4px;
  color: var(--ms-text-3);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}

/* [S3] disabled, not merely omitted, while the card has a live pending decision — see the button's
   own `:title` in the template for the tooltip this pairs with. */
.sp-home__card-remove:disabled {
  color: var(--ms-text-4, #b3b8c2);
  cursor: not-allowed;
  text-decoration: none;
}

.sp-home__card-notice {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 12px;
}

.sp-home__card-notice--error {
  color: var(--ms-color-danger);
}

/* Open at the bottom on purpose: the parent renders the ONE project-number input directly beneath
   this block (see the template comment), and the two read as a single 「拉一个新项目」 card. */
.sp-home__quick-open {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  padding: var(--ms-space-3) var(--ms-space-3) var(--ms-space-2);
  border: 1px dashed var(--ms-border-light);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
}

.sp-home__quick-open-title {
  margin: 0;
  font-size: 13px;
  font-weight: var(--ms-font-weight-title, 600);
  color: var(--ms-text-1);
}

.sp-home__quick-open-hint {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 12px;
}
</style>
