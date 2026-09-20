<template>
  <PageShell width="default">
    <PageHeader class="template-center__header" :title="t.title">
      <template #actions>
        <div class="template-center__toolbar">
          <el-select
            v-model="categoryFilter"
            :placeholder="t.categoryFilterPlaceholder"
            clearable
            data-testid="template-center-category-filter"
            class="ms-w-160 ms-mr-12"
            @change="handleCategoryChange"
          >
            <el-option
              v-for="category in categories"
              :key="category"
              :label="category"
              :value="category"
            />
          </el-select>
          <el-input
            v-model="searchText"
            :placeholder="t.searchPlaceholder"
            clearable
            class="ms-w-240"
            @clear="handleSearch"
            @keyup.enter="handleSearch"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <el-button
            v-if="canManageTemplates"
            type="primary"
            class="ms-ml-12"
            data-testid="template-center-new-button"
            @click="createTemplate"
          >
            {{ t.newTemplateButton }}
          </el-button>
          <el-button
            v-if="canManageTemplates"
            class="ms-ml-8"
            data-testid="template-center-delegations-link"
            @click="$router.push('/approval-delegations')"
          >
            {{ t.delegationsButton }}
          </el-button>
          <!-- Approval form grouping lock v2.13 §6 phase 3 (A-4) — additive view-mode toggle.
               Default 'flat' keeps every existing spec's mount behavior byte-identical; the
               grouped branch below is a SIBLING template, not a wrapper around the existing
               table/gallery markup, so this never touches their structure. -->
          <el-button
            :type="viewMode === 'flat' ? 'primary' : 'default'"
            size="small"
            class="ms-ml-12"
            data-testid="template-center-view-mode-flat"
            @click="viewMode = 'flat'"
          >
            {{ t.viewModeFlat }}
          </el-button>
          <el-button
            :type="viewMode === 'grouped' ? 'primary' : 'default'"
            size="small"
            data-testid="template-center-view-mode-grouped"
            @click="viewMode = 'grouped'"
          >
            {{ t.viewModeGrouped }}
          </el-button>
        </div>
      </template>
    </PageHeader>

    <!-- B1-08: 最近使用 — 发起热路径从「进模板全表找行」降到 1 击。localStorage per-user，
         点击已删除/已归档模板时由填单页的加载错误 + 返回兜底。 -->
    <div
      v-if="canWrite && recentTemplates.length > 0"
      class="template-center__recent"
      data-testid="template-center-recent"
    >
      <span class="template-center__recent-label">{{ t.recentLabel }}</span>
      <el-tag
        v-for="entry in recentTemplates"
        :key="entry.templateId"
        class="template-center__recent-chip"
        effect="plain"
        :data-testid="`template-center-recent-${entry.templateId}`"
        @click="startApproval(entry.templateId)"
      >
        {{ entry.name }}
      </el-tag>
    </div>

    <el-alert
      v-if="store.error"
      :title="store.error"
      type="error"
      show-icon
      :closable="true"
      class="template-center__error"
      @close="store.error = null"
    >
      <template #default>
        <el-button type="primary" link @click="loadData">{{ t.reload }}</el-button>
      </template>
    </el-alert>

    <el-tabs v-model="statusTab" class="template-center__tabs" @tab-change="handleTabChange">
      <el-tab-pane :label="t.tabAll" name="all" />
      <el-tab-pane :label="t.tabPublished" name="published" />
      <el-tab-pane :label="t.tabDraft" name="draft" />
      <el-tab-pane :label="t.tabArchived" name="archived" />
    </el-tabs>

    <!-- Approval form grouping lock v2.13 §6 phase 3 (A-4) — `viewMode` gate wraps the ENTIRE
         pre-existing flat table/gallery block as a sibling of the new grouped view, rather than
         being merged into the table's own `v-if`/`v-else` pair (which would make the gallery
         `v-else` fire in grouped+non-manager mode too). Default 'flat' keeps this block's own
         `v-if`/`v-else` behaving exactly as before for every spec that never touches viewMode. -->
    <template v-if="viewMode === 'flat'">
    <!-- G-B2-17: admin path unchanged — the management table stays exactly as before. -->
    <!-- `visibleTemplates`, not `store.templates`: the shared approval-template store is app-wide
         and holds whatever organization/principal it was last loaded for. See the
         "organization context lifecycle" block in the script — while this page knows the rows it
         holds belong to a context we have LEFT, the flat surfaces render empty rather than
         passing the previous organization's templates off as this one's answer. -->
    <el-table
      v-if="canManageTemplates"
      v-loading="store.loading"
      :data="visibleTemplates"
      class="ms-w-100pct"
      max-height="560"
      stripe
      highlight-current-row
      @row-click="handleRowClick"
    >
      <el-table-column prop="name" :label="t.colName" min-width="200" />
      <el-table-column prop="description" :label="t.colDescription" min-width="180">
        <template #default="{ row }">
          {{ row.description ?? '-' }}
        </template>
      </el-table-column>
      <el-table-column :label="t.colCategory" width="120">
        <template #default="{ row }">
          <el-tag
            v-if="row.category"
            size="small"
            type="info"
            effect="plain"
            data-testid="template-center-row-category"
          >
            {{ row.category }}
          </el-tag>
          <span v-else class="template-center__category-empty">{{ t.categoryEmpty }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t.colVisibility" width="160">
        <template #default="{ row }">
          <el-tag size="small" effect="plain" data-testid="template-center-row-visibility">
            {{ visibilityScopeLabel(row.visibilityScope) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t.colStatus" width="100">
        <template #default="{ row }">
          <StatusTag domain="approvalTemplate" :status="row.status" size="sm" />
        </template>
      </el-table-column>
      <el-table-column :label="t.colUpdated" width="180">
        <template #default="{ row }">
          {{ formatDate(row.updatedAt) }}
        </template>
      </el-table-column>
      <el-table-column :label="t.colCreated" width="180">
        <template #default="{ row }">
          {{ formatDate(row.createdAt) }}
        </template>
      </el-table-column>
      <el-table-column :label="t.colActions" width="280" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'published' && canWrite"
            type="primary"
            size="small"
            @click.stop="startApproval(row.id)"
          >
            {{ t.startApproval }}
          </el-button>
          <el-button
            v-if="canManageTemplates"
            size="small"
            :loading="cloningId === row.id"
            data-testid="template-center-clone-button"
            @click.stop="handleClone(row)"
          >
            {{ t.clone }}
          </el-button>
          <el-button
            v-if="canManageTemplates && row.status === 'published'"
            size="small"
            :loading="archivingId === row.id"
            data-testid="template-center-archive-button"
            @click.stop="handleArchive(row)"
          >
            {{ t.archive }}
          </el-button>
          <el-button
            v-if="canManageTemplates && row.status === 'archived'"
            size="small"
            :loading="archivingId === row.id"
            data-testid="template-center-unarchive-button"
            @click.stop="handleUnarchive(row)"
          >
            {{ t.unarchive }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty
          :description="searchText ? t.emptyTableSearch : t.emptyTableDefault"
          :image-size="100"
        />
      </template>
    </el-table>

    <!-- G-B2-17: requester (!canManageTemplates) card gallery. 普通员工's only real intent
         here is "find a template → start a request" — the admin table's columns (visibility
         scope, created/updated timestamps, clone) are management chrome they never act on, so
         the gallery surfaces just name / description / category / the one primary action. -->
    <div
      v-else
      v-loading="store.loading"
      class="template-center__gallery-wrap"
      data-testid="template-center-gallery"
    >
      <div v-if="visibleGalleryTemplates.length > 0" class="template-center__gallery">
        <el-card
          v-for="tpl in visibleGalleryTemplates"
          :key="tpl.id"
          class="template-center__gallery-card"
          shadow="hover"
          data-testid="template-center-gallery-card"
        >
          <div class="template-center__gallery-card-head">
            <span class="template-center__gallery-card-name">{{ tpl.name }}</span>
            <StatusTag domain="approvalTemplate" :status="tpl.status" size="sm" />
          </div>
          <p class="template-center__gallery-card-desc">
            {{ tpl.description || t.noDescription }}
          </p>
          <div class="template-center__gallery-card-footer">
            <el-tag
              v-if="tpl.category"
              size="small"
              type="info"
              effect="plain"
              data-testid="template-center-gallery-category"
            >
              {{ tpl.category }}
            </el-tag>
            <span v-else class="template-center__category-empty">{{ t.categoryEmpty }}</span>
            <el-button
              v-if="tpl.status === 'published' && canWrite"
              type="primary"
              size="small"
              data-testid="template-center-gallery-start-button"
              @click="startApproval(tpl.id)"
            >
              {{ t.galleryStart }}
            </el-button>
          </div>
        </el-card>
      </div>
      <EmptyState
        v-else
        data-testid="template-center-gallery-empty"
        :title="searchText || categoryFilter ? t.emptyTableSearch : t.emptyGalleryDefault"
      />
    </div>
    </template>
    <template v-else>
      <!-- A-2 x A-4 merge convergence (2026-09-20) — master/subordinate for the two grouping
           surfaces this page grew, one per lane. A-4's TemplateGroupSections is the PRIMARY
           grouping surface: it owns the rendered group order and every section's rows, and it is
           the only thing that loads groups on entering the grouped view. A-2's
           ApprovalTemplateGroupsPanel is the MANAGEMENT ENTRY: admin-only, disclosure-gated
           (collapsed by default), and it mounts — and therefore calls
           `listApprovalTemplateGroups()` — only once an admin explicitly opens it, so no default
           render path fetches the group list twice. On a successful mutation the panel emits
           `changed` and this view re-runs the sections' own `loadAll()`, closing the state
           desync (creating a group in the manager used to leave the section list stale).

           The panel is NOT mounted in the flat view at all. That is what keeps A-4's I6
           invariant ("the flat table's category tag never triggers a group-linkage lookup",
           asserted in approvalTemplateCenterCategory.spec.ts) literally true after the merge
           rather than rewritten: the assertion is unchanged from A-4's head. See the phase-3
           design MD's "A-2 x A-4 合流" section.

           P2-5 (groups-daily-ops-real-browser-acceptance-20260920.md) + P1-A
           (impl-gate-A5-daily-ops-round1-20260920.md, round 2) — the page's ONE session-org
           entry, present for as long as the CURRENT identity is eligible for it rather than
           reactive-to-403 like the panel's and the sections view's own used to be (D3-1).
           Rounds 1-2 wrote "persistent for the lifetime of the grouped view"; round 2b disproved
           that wording (P2-D) and round 3 replaced the mechanism behind it: the entry now follows
           the principal, so it disappears when the identity holding the session is no longer
           eligible (signed out, or down to one organization) and comes back when a new eligible
           identity takes over, without a reload. See the "organization context lifecycle" blocks
           in the script below. Lock §2 "首期必须……提供
           session-org 选择入口" is satisfied by a reactive instance only up to the FIRST successful
           load; once `authenticatedTenantId` is bound that code never returns, so a multi-org admin
           who wants to switch to a DIFFERENT org had no in-module path (finding P2-5) and had to
           leave for the attendance page's always-visible switcher.

           Round 1 of this slice shipped this as a THIRD, INDEPENDENT `useSessionOrg()` instance
           beside the panel's and the sections view's. A real browser measured what that costs: on
           the first grouped hop as an unbound multi-org admin BOTH this one and the sections
           view's rendered — two indistinguishable controls — and switching through the sections
           view's one left the page with ZERO switchers, because `useSessionOrg`'s
           `onAuthPrincipalChange` empties `orgs` on every OTHER instance and only the switching
           instance restores itself. This view now owns the single instance for the whole page and
           hands it down through `provide(SessionOrgHostKey)`; the panel and the sections view
           consume it and render no switcher of their own while hosted (they keep their standalone
           behaviour verbatim when mounted with no host). See `SessionOrgSwitcher.vue`'s
           `SessionOrgHost` doc comment for why one instance per page is the only available fix
           (`useSessionOrg.ts` is not editable — design lock §2).

           Visibility is `hasMultipleOrgs || sessionOrgRequiredSeen`, not attendance's
           UNconditional render. First disjunct: a single-org member's session-orgs call returns
           exactly one org, so this stays invisible for them, preserving acceptance J's "single-org
           member never sees a selector" positive control for this surface (attendance itself has
           no such guard; a one-conjunct, documented divergence — see the design MD's lock-coverage
           matrix). Second disjunct: it reproduces the pre-existing REACTIVE rule verbatim rather
           than widening it — before this round a child that took a 403 `SESSION_ORG_REQUIRED`
           rendered `<SessionOrgSwitcher>` itself, whose own `v-if="loading || orgs.length > 0 ||
           errorMessage"` decided whether anything appeared; now the child reports the code up and
           this instance renders under exactly that same component-level gate. J's control does not
           rest on this `v-if` — it rests on a single-org member never RECEIVING the code. -->
      <SessionOrgSwitcher
        v-if="showPageSessionOrgSwitcher"
        :tr="tr"
        :orgs="pageSessionOrgs"
        :model-value="pageSessionOrgSelectedId"
        :loading="pageSessionOrgLoading"
        :switching="pageSessionOrgSwitching"
        :error-message="pageSessionOrgError"
        @change="onPageSessionOrgChange"
      />
      <!-- Boundary ④ — a FAILED organization-list lookup is recoverable, not a latch. Rendered
           on the failure itself rather than only alongside the switcher: when the lookup fails
           there IS no switcher (the list is empty, so `hasMultipleOrgs` is false) and a silent
           disappearance would be byte-identical to "you are a single-org member", i.e. the empty
           state could not answer "not eligible, or not looked up?". A single-org member whose
           lookup SUCCEEDS still sees nothing at all — acceptance J's positive control is about
           that case and is unchanged. -->
      <button
        v-if="pageSessionOrgsFailed"
        type="button"
        class="template-center__session-orgs-retry"
        data-testid="template-center-session-orgs-retry"
        :disabled="pageSessionOrgLoading"
        @click="retryPageSessionOrgs"
      >
        {{ t.sessionOrgsRetry }}
      </button>
      <div v-if="canManageTemplates" class="template-center__group-manager">
        <el-button
          size="small"
          data-testid="template-center-group-manager-toggle"
          :aria-expanded="showGroupManager ? 'true' : 'false'"
          @click="showGroupManager = !showGroupManager"
        >
          {{ showGroupManager ? t.groupManagerHide : t.groupManagerShow }}
        </el-button>
        <ApprovalTemplateGroupsPanel
          v-if="showGroupManager"
          ref="groupsPanelRef"
          :tr="tr"
          @changed="handleGroupsChanged"
        />
      </div>
      <TemplateGroupSections
        ref="groupSectionsRef"
        :status="statusTab === 'all' ? undefined : statusTab"
        :search="searchText || undefined"
        @select="handleSectionItemSelect"
      />
    </template>

    <el-pagination
      v-if="viewMode === 'flat' && !flatListStale && store.total > pageSize"
      class="template-center__pagination"
      background
      layout="total, prev, pager, next"
      :total="store.total"
      :current-page="currentPage"
      :page-size="pageSize"
      @update:current-page="handlePageChange"
    />
  </PageShell>
</template>

<script setup lang="ts">
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import StatusTag from '../../components/status/StatusTag.vue'
import EmptyState from '../../components/status/EmptyState.vue'
import ApprovalTemplateGroupsPanel from './ApprovalTemplateGroupsPanel.vue'
import TemplateGroupSections from './TemplateGroupSections.vue'
import SessionOrgSwitcher, { SessionOrgHostKey } from '../../components/SessionOrgSwitcher.vue'
import { useSessionOrg } from '../../composables/useSessionOrg'
import {
  getAuthPrincipalKey,
  onAuthSessionSwitch,
  readStoredToken,
} from '../../composables/authPrincipal'
import { ref, computed, nextTick, onMounted, onScopeDispose, provide, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ApprovalTemplateListItemDTO, ApprovalTemplateStatus } from '../../types/approval'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { useApprovalPermissions } from '../../approvals/permissions'
import {
  cloneTemplate,
  listTemplateCategories,
  getTemplateUsage,
  archiveTemplate,
  unarchiveTemplate,
} from '../../approvals/api'
import { listRecentTemplates, type RecentTemplateEntry } from '../../approvals/recentTemplates'
import { useAuth } from '../../composables/useAuth'
import { filterGalleryTemplates } from '../../approvals/templateGalleryFilter'
import { templateArchiveConfirmMessage, templateUnarchiveConfirmMessage } from '../../approvals/templateArchiveConfirm'
import { useLocale } from '../../composables/useLocale'
import { ZH, EN } from './templateCenterLabels'

const router = useRouter()
const store = useApprovalTemplateStore()
const { canWrite, canManageTemplates } = useApprovalPermissions()
const recentTemplates = ref<RecentTemplateEntry[]>([])

// Report item O-8 (approval UI locale consistency) — this page previously never called
// useLocale() at all; every string below was an unconditional Chinese literal regardless of the
// app shell's locale. `t` follows the same shared useLocale() singleton App.vue reads, mirroring
// the ZH/EN + computed convention ApprovalBatchTransferView.vue established in this directory.
const { isZh } = useLocale()
const t = computed(() => (isZh.value ? ZH : EN))
// A-2 scope item 2 — the shared `SessionOrgSwitcher`/`ApprovalTemplateGroupsPanel` take a plain
// `tr(en, zh)` function (same shape `AttendanceView.vue:10468` uses), not the whole-object `t`
// convention this file otherwise uses.
const tr = (en: string, zh: string): string => (isZh.value ? zh : en)

const statusTab = ref<'all' | ApprovalTemplateStatus>('all')
const searchText = ref('')
// Wave 2 WP4 slice 1 — category filter state. `''` = no filter.
const categoryFilter = ref<string>('')
const categories = ref<string[]>([])
const cloningId = ref<string | null>(null)
// B3-08 — 停用/启用 in-flight row id.
const archivingId = ref<string | null>(null)
const currentPage = ref(1)
const pageSize = ref(10)
// Approval form grouping lock v2.13 §6 phase 3 (A-4) — additive view-mode toggle, default 'flat'.
const viewMode = ref<'flat' | 'grouped'>('flat')

// ── Organization context lifecycle, part 1: the FLAT surfaces ───────────────────────────────
// P3-E (impl-gate-A5-daily-ops-round2b-20260921.md) + boundary ② of the round-3 acceptance
// ("切组织后平铺画廊也必须重读；请求期间不能把旧组织数据显示为新组织结果").
//
// The admin table, the requester gallery and the pagination all read the SHARED approval-template
// store. That store is app-wide: it holds whatever list was last fetched, for whatever
// organization and whatever principal was current at the time, and nothing in it notices that
// this page has since switched organizations or that the account changed. Before this slice the
// page had no in-page way to change organizations at all, so the flat list could not go stale
// this way; the new entry created that inconsistency and has to close it.
//
// `flatListStale` is this page's own "the rows the store is holding belong to a context we have
// left". It is raised at the moment the context changes and lowered only by a `loadData()` that
// (a) is still the LATEST one issued and (b) actually succeeded — a failed re-read must not
// re-expose the previous organization's rows as though they were this one's. While it is up the
// flat surfaces render their empty state, which is what ② permits ("请求期间显示 loading/空态"),
// instead of the previous organization's templates.
const flatListStale = ref(false)
let flatListGeneration = 0
const visibleTemplates = computed(() => (flatListStale.value ? [] : store.templates))

// G-B2-17 — the requester gallery re-filters the current page's templates instantly as
// categoryFilter/searchText change (no need to wait for handleSearch's Enter/blur), on top of
// whatever the backend already returned. The admin table below does NOT consume this: it keeps
// rendering `store.templates` directly, unchanged.
const visibleGalleryTemplates = computed(() =>
  filterGalleryTemplates(visibleTemplates.value, {
    category: categoryFilter.value,
    search: searchText.value,
  }),
)

function visibilityScopeLabel(scope: ApprovalTemplateListItemDTO['visibilityScope']) {
  if (!scope || scope.type === 'all') return t.value.visibilityAll
  const count = scope.ids?.length ?? 0
  const map: Record<string, string> = {
    dept: t.value.visibilityDept,
    role: t.value.visibilityRole,
    user: t.value.visibilityUser,
  }
  return `${map[scope.type] ?? scope.type} ${count}`
}

function formatDate(dateStr: string) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString(isZh.value ? 'zh-CN' : 'en-US')
}

function loadData() {
  // Request algebra for the flat list (see the `flatListStale` block above): every call takes the
  // next generation, and only the latest one is allowed to declare the rendered rows current
  // again. A slow read issued for an organization the admin has already left therefore cannot
  // un-blank the table on behalf of the organization it never fetched.
  const generation = ++flatListGeneration
  const settle = () => {
    if (generation !== flatListGeneration) return
    if (!store.error) flatListStale.value = false
  }
  void Promise.resolve(
    store.loadTemplates({
      status: statusTab.value === 'all' ? undefined : statusTab.value,
      search: searchText.value || undefined,
      // Wave 2 WP4 slice 1 — only pass `category` when it's a non-empty
      // selection so the backend filter stays inert for "全部分类".
      category: categoryFilter.value || undefined,
      page: currentPage.value,
      pageSize: pageSize.value,
    }),
  ).then(settle, settle)
}

// Same request algebra as `loadData`: the category list is org-scoped chrome, so an answer for an
// organization the admin has left must not repopulate the dropdown behind a newer read.
let categoriesGeneration = 0

async function loadCategories() {
  const generation = ++categoriesGeneration
  try {
    const next = await listTemplateCategories()
    if (generation !== categoriesGeneration) return
    categories.value = next
  } catch (e: any) {
    // Non-fatal: dropdown just stays empty. The rest of the page continues
    // to work without the filter.
    if (generation !== categoriesGeneration) return
    categories.value = []
  }
}

function handleTabChange() {
  currentPage.value = 1
  loadData()
}

function handleSearch() {
  currentPage.value = 1
  loadData()
}

function handleCategoryChange() {
  currentPage.value = 1
  loadData()
}

function handlePageChange(page: number) {
  currentPage.value = page
  loadData()
}

function handleRowClick(row: ApprovalTemplateListItemDTO) {
  router.push({ path: `/approval-templates/${row.id}` })
}

// Approval form grouping lock v2.13 §6 phase 3 (A-4) — TemplateGroupSections emits a bare
// template id (it has no dependency on vue-router itself, unlike handleRowClick's row object).
function handleSectionItemSelect(templateId: string) {
  router.push({ path: `/approval-templates/${templateId}` })
}

// A-2 x A-4 merge convergence — the group MANAGER (A-2's panel) is collapsed by default and
// lives inside the grouped view only; see the template comment on `template-center__group-manager`
// for why (I6 in the flat view, single group fetch on the default grouped render).
const showGroupManager = ref(false)
const groupSectionsRef = ref<InstanceType<typeof TemplateGroupSections> | null>(null)
const groupsPanelRef = ref<InstanceType<typeof ApprovalTemplateGroupsPanel> | null>(null)

// The manager mutated the org's groups (create). The sections view owns the rendered group order,
// so it — not the panel — is the surface that must re-read; `loadAll` is the same entry point the
// sections view runs on mount (it already `defineExpose`s it).
function handleGroupsChanged() {
  void groupSectionsRef.value?.loadAll()
}

// P2-5 (groups-daily-ops-real-browser-acceptance-20260920.md) + P1-A
// (impl-gate-A5-daily-ops-round1-20260920.md) — THE page's session-org state. Exactly one
// `useSessionOrg()` instance exists for this page and it lives here; the panel and the sections
// view inject it (`provide(SessionOrgHostKey)` below) instead of constructing their own.
//
// Round 1 of this slice followed the phase-3 design MD §8.4 convention ("没有把分组列表上提到父组件
// 共享一份 state") and gave this surface its own third instance. That convention is about the GROUP
// LIST — per-surface copies of a list are independent and each surface's spec pins its own fetch
// count. Session-org identity is not list data: `switchSessionOrg` remints the auth token, and
// `useSessionOrg`'s `onAuthPrincipalChange` handler then clears `orgs`/`currentOrgId` on every
// instance, with only the switching one restoring itself. Copies of that state are therefore not
// independent — they actively destroy each other (measured in a real browser: switching through
// the sections view's instance left the page with zero switchers until a full reload). §8.4 was
// never a faithful precedent for it.
const pageSessionOrg = useSessionOrg()
const {
  orgs: pageSessionOrgs,
  selectedOrgId: pageSessionOrgSelectedId,
  hasMultipleOrgs: pageSessionOrgHasMultiple,
  loading: pageSessionOrgLoading,
  switching: pageSessionOrgSwitching,
  errorMessage: pageSessionOrgError,
  loadSessionOrgs: loadPageSessionOrgs,
  switchSessionOrg: switchPageSessionOrg,
} = pageSessionOrg

// Set when a hosted child reports a 403 `SESSION_ORG_REQUIRED`. See the template comment: this is
// the pre-existing reactive visibility rule relocated from the children, not a widening of it.
const sessionOrgRequiredSeen = ref(false)
const showPageSessionOrgSwitcher = computed(
  () => pageSessionOrgHasMultiple.value || sessionOrgRequiredSeen.value,
)

// ── Organization context lifecycle, part 2: the session-org REQUEST ─────────────────────────
// Fetched on FIRST entry into the grouped view (not on every toggle back into it, and not in
// the flat view at all — `loadSessionOrgs()` is a no-op for a caller with no stored token, so this
// is inert wherever nothing is logged in, same as the reactive instances' own fire-and-forget call
// used to be). NIT-2 of the round-1 gate, registered rather than left implicit: this one call IS
// proactive, unlike the "reactive-not-proactive" rule `approvalTemplateCenterSections.spec.ts`
// pins for the SECTIONS view (that rule is about not looking up session orgs on a NON-J failure,
// and it still holds — the sections view makes no session-org call at all now). The page-level
// entry cannot be reactive: its whole purpose is to exist when nothing has failed.
//
// P2-D (impl-gate-A5-daily-ops-round2b-20260921.md) — rounds 1 and 2 spelled "once" as a bare
// `let requested = false`, which is not "once per context" but "once, ever, for the lifetime of
// this component instance". Two different things then latched the entry OFF permanently:
//   • any principal change from OUTSIDE this page (another tab switching organizations, the
//     session bootstrap's 401 branch clearing the token with no navigation, an invite/DingTalk/
//     forced-password `setToken`) — `useSessionOrg`'s own `onAuthPrincipalChange` empties `orgs`,
//     `hasMultipleOrgs` goes false, and nothing ever re-asked;
//   • a FAILED lookup — the flag was set BEFORE the request, so one 500 removed the entry until
//     a full page reload.
// The flag is now a CLAIM: which principal the one outstanding request was made for. It follows
// the principal (boundary ①) and it is dropped on failure (boundary ④), so the entry is
// "always reachable" for every identity that is still ELIGIBLE for it, and reachable AGAIN after
// a transient failure, rather than for the lifetime of one mounted component.
//
// The claim is KEYED, not merely reset by the listener, because the two mechanisms cover
// different populations and `authPrincipal.ts` says so in as many words ("NOT A REPLACEMENT FOR
// KEYING"): the listener catches every transition this process performs, and the key catches a
// swap this process was never told about (another tab writing the shared `localStorage` without
// the explicit-session marker that `useAuth`'s storage listener gates its notification on).
type PageSessionOrgsClaim = { principal: string | null }
let pageSessionOrgsClaim: PageSessionOrgsClaim | null = null
// "The current identity's organization-list lookup failed." Rendered as a retry affordance, and
// distinct from `pageSessionOrgError` (which `useSessionOrg` also sets for a refused SWITCH).
// A silent disappearance on failure would make "you are not eligible" and "we could not find out"
// byte-identical on screen; this keeps them distinguishable and recoverable.
const pageSessionOrgsFailed = ref(false)

function ensurePageSessionOrgsLoaded(): void {
  const principal = getAuthPrincipalKey()
  if (pageSessionOrgsClaim && pageSessionOrgsClaim.principal === principal) return
  const claim: PageSessionOrgsClaim = { principal }
  pageSessionOrgsClaim = claim
  pageSessionOrgsFailed.value = false
  const settle = () => {
    // A superseded request takes NO recovery action of any kind — it neither re-asks nor reopens
    // the claim its successor is holding (boundary ④, second half). Defensive: `useSessionOrg`'s
    // own generation guard already suppresses a stale answer's error write, so no input has been
    // found that makes this line observable on its own; it is registered as defence in depth in
    // the verification MD rather than claimed as a load-bearing guard.
    if (pageSessionOrgsClaim !== claim) return
    if (pageSessionOrgError.value) {
      // Retryable, NOT latched: drop the claim so the next trigger (re-entering the grouped view,
      // a hosted child reporting a 403, or the retry control) asks again for this same identity.
      pageSessionOrgsClaim = null
      pageSessionOrgsFailed.value = true
      return
    }
    pageSessionOrgsFailed.value = false
  }
  void loadPageSessionOrgs().then(settle, settle)
}

// Boundary ④'s explicit affordance. The claim is already `null` after a failure, so this is just
// "ask again now" rather than a second code path.
function retryPageSessionOrgs(): void {
  ensurePageSessionOrgsLoaded()
}

watch(viewMode, (mode) => {
  if (mode === 'grouped') ensurePageSessionOrgsLoaded()
})

// A hosted child (panel / sections view) took a 403 `SESSION_ORG_REQUIRED`. The host owns the
// fetch, the rendered control and the replay; the child only reports that it is blocked.
function notifySessionOrgRequired(): void {
  sessionOrgRequiredSeen.value = true
  ensurePageSessionOrgsLoaded()
}

provide(SessionOrgHostKey, { sessionOrg: pageSessionOrg, notifySessionOrgRequired })

// ── Organization context lifecycle, part 3: the state machine ───────────────────────────────
// principal change → CLEAR everything derived from the old context → RE-DETERMINE eligibility →
// re-fetch for the identity that holds the session now, or stay gone if it holds none.
//
// `true` for exactly the window in which THIS page's switcher is driving the transition. The
// distinction matters because the two transitions need different handling and are otherwise
// indistinguishable at the listener: `useSessionOrg.switchSessionOrg` captures the membership
// list before it remints the token and restores it immediately afterwards — synchronously, in the
// same run as the notification — so the page's own switch needs no organization re-read, only
// data re-reads. A change from anywhere else leaves the list empty and must be re-asked.
let pageOwnedSwitchInFlight = false

// Every org-scoped read this page owns, re-issued for whoever holds the session NOW.
function reloadOrgScopedSurfaces(): void {
  void groupSectionsRef.value?.loadAll()
  void groupsPanelRef.value?.loadGroups()
  loadData()
  void loadCategories()
  loadRecentTemplates()
}

const stopPrincipalLifecycle = onAuthSessionSwitch(() => {
  // (1) CLEAR — synchronous, so not one frame renders the previous identity's or organization's
  // data. `useSessionOrg` clears `orgs`/`currentOrgId`/`errorMessage` in its own listener and the
  // two grouped children clear theirs in theirs; this covers what the PAGE owns.
  const ownSwitch = pageOwnedSwitchInFlight
  sessionOrgRequiredSeen.value = false
  pageSessionOrgsFailed.value = false
  flatListStale.value = true
  flatListGeneration++
  categoriesGeneration++
  categories.value = []
  recentTemplatesGeneration++
  recentTemplates.value = []
  // (2) RE-KEY the claim. The page's own switch is the same person with the same memberships, so
  // the restored list is already the right answer for the new key; anything else must re-ask.
  pageSessionOrgsClaim = ownSwitch ? { principal: getAuthPrincipalKey() } : null

  // (3) RE-DETERMINE ELIGIBILITY and (4) RE-READ, deferred one tick. Subscribers are notified in
  // subscription order and this host subscribes BEFORE its own children do; a re-read issued here
  // synchronously would be invalidated by the child's own reset (which bumps the child's request
  // generation) and would never land. One tick puts every subscriber's clear ahead of every read.
  void nextTick(() => {
    // The page's own switch has its own replay in `onPageSessionOrgChange`, which knows whether
    // the switch was actually accepted; re-reading here too would double every request.
    if (ownSwitch) return
    // Signed out: no token, so every one of these reads would be a no-op or a 401. The surfaces
    // stay cleared and the entry stays gone — with no error banner, which is the correct
    // rendering of "this identity is not eligible", not a failure to be retried.
    if (!readStoredToken()) return
    if (viewMode.value === 'grouped') ensurePageSessionOrgsLoaded()
    reloadOrgScopedSurfaces()
  })
})
onScopeDispose(stopPrincipalLifecycle)

async function onPageSessionOrgChange(orgId: string): Promise<void> {
  pageOwnedSwitchInFlight = true
  let ok = false
  try {
    ok = await switchPageSessionOrg(orgId)
  } finally {
    pageOwnedSwitchInFlight = false
  }
  // A REFUSED switch fires no principal change at all, so nothing was cleared and nothing needs
  // re-reading: the admin is still in the organization they were in.
  if (!ok) return
  // Re-read every surface that reads this org's data — same "tell the parent to re-read" rule
  // `handleGroupsChanged` already follows. This is also the replay for whatever a hosted child was
  // blocked on: both children's blocked entry point is their own load (`loadAll` / `loadGroups`),
  // and both clear their "blocked on session org" flag when that load succeeds. The panel's other
  // blockable actions (create / rename / archive / unarchive) are deliberately NOT auto-replayed
  // into a freshly-switched organization — re-running a write against a different org without the
  // admin asking again is a hazard, not a convenience; the admin re-submits.
  //
  // P3-E / boundary ② — the FLAT surfaces are re-read here too. They read the app-wide template
  // store, which nothing else re-reads on an organization change, so before this they kept
  // rendering the organization the admin had just left until a filter change or a reload. Their
  // rows are already blanked (the principal-change listener above raised `flatListStale` during
  // the switch), so the window between the switch and the new answer shows an empty state rather
  // than the old organization's templates.
  reloadOrgScopedSurfaces()
}

function startApproval(templateId: string) {
  router.push({ path: `/approvals/new/${templateId}` })
}

function createTemplate() {
  if (!canManageTemplates.value) return
  router.push({ path: '/approval-templates/new' })
}

async function handleClone(row: ApprovalTemplateListItemDTO) {
  if (!canManageTemplates.value) return
  if (cloningId.value) return
  cloningId.value = row.id
  try {
    const cloned = await cloneTemplate(row.id)
    ElMessage.success(`${t.value.clonedPrefix}${cloned.name}`)
    // Refresh categories in the background; navigation should not wait on it.
    void loadCategories()
    router.push({ path: `/approval-templates/${cloned.id}` })
  } catch (e: any) {
    ElMessage.error(e?.message ?? t.value.cloneError)
  } finally {
    cloningId.value = null
  }
}

// B3-08 (模板治理 — 停用): fetch the usage/blast-radius indicator first (best-effort — a failed
// usage read still shows the confirm, just without the instance-count line), same flow as
// TemplateDetailView's handleArchive. Refreshes the row in place from the response rather than
// reloading the whole page.
async function handleArchive(row: ApprovalTemplateListItemDTO) {
  if (!canManageTemplates.value || archivingId.value) return
  let usage
  try {
    usage = await getTemplateUsage(row.id)
  } catch {
    usage = undefined
  }
  try {
    await ElMessageBox.confirm(
      templateArchiveConfirmMessage(row.name, usage),
      t.value.archiveDialogTitle,
      { confirmButtonText: t.value.archive, cancelButtonText: t.value.cancel, type: 'warning' },
    )
  } catch {
    return
  }
  archivingId.value = row.id
  try {
    const updated = await archiveTemplate(row.id)
    row.status = updated.status
    ElMessage.success(t.value.archiveSuccess)
  } catch (e: any) {
    ElMessage.error(e?.message ?? t.value.archiveError)
  } finally {
    archivingId.value = null
  }
}

async function handleUnarchive(row: ApprovalTemplateListItemDTO) {
  if (!canManageTemplates.value || archivingId.value) return
  try {
    await ElMessageBox.confirm(
      templateUnarchiveConfirmMessage(row.name),
      t.value.unarchiveDialogTitle,
      { confirmButtonText: t.value.unarchive, cancelButtonText: t.value.cancel, type: 'info' },
    )
  } catch {
    return
  }
  archivingId.value = row.id
  try {
    const updated = await unarchiveTemplate(row.id)
    row.status = updated.status
    ElMessage.success(t.value.unarchiveSuccess)
  } catch (e: any) {
    ElMessage.error(e?.message ?? t.value.unarchiveError)
  } finally {
    archivingId.value = null
  }
}

// B1-08: best-effort — a missing session just means no shortcut row. The recent list is keyed by
// USER id, so it is per-principal data like everything else in the lifecycle block: the previous
// account's shortcuts must not survive into the next account's page, and the answer to a lookup
// issued for the previous account must not land on top of the new one's.
let recentTemplatesGeneration = 0
function loadRecentTemplates(): void {
  const generation = ++recentTemplatesGeneration
  void useAuth()
    .getCurrentUserId()
    .then((uid) => {
      if (generation !== recentTemplatesGeneration) return
      recentTemplates.value = listRecentTemplates(uid)
    })
    .catch(() => {})
}

onMounted(() => {
  loadData()
  loadCategories()
  loadRecentTemplates()
})
</script>

<style scoped>
.template-center__toolbar {
  display: flex;
  align-items: center;
}

.template-center__error {
  margin-bottom: 16px;
}

.template-center__tabs {
  margin-bottom: 16px;
}

.template-center__pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

.template-center__session-orgs-retry {
  margin-bottom: 12px;
}

.template-center__category-empty {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.template-center__recent {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.template-center__recent-label {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.template-center__recent-chip {
  cursor: pointer;
}

/* G-B2-17: requester card gallery. */
.template-center__gallery-wrap {
  min-height: 160px;
}

.template-center__gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--ms-space-4);
}

.template-center__gallery-card :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.template-center__gallery-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ms-space-2);
}

.template-center__gallery-card-name {
  font-size: var(--ms-font-size-section-title);
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
  line-height: 1.4;
}

.template-center__gallery-card-desc {
  margin: 0;
  min-height: 40px;
  font-size: 13px;
  color: var(--ms-text-2);
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.template-center__gallery-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-2);
}
</style>
