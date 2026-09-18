<!--
  Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 3 (A-4): additive
  "分组视图" (grouped view) for TemplateCenterView.vue. See the header comment in
  TemplateCenterView.vue for scope notes — the two write-face group selectors (I4) are deferred
  (needs the session-org entry point extended to those two surfaces plus a defined create-then-
  link failure contract; owner 勘误 candidate, not implemented here).

  Group ORDER is editable here (§3 I3 / §4 acceptance E phase-3 leg / §6 表第 3 行): each
  `group:<id>` section header carries move-up/move-down buttons (keyboard-operable — no native
  HTML5 drag-and-drop, same convention as `TemplateAuthoringView.vue`'s step reordering
  "上移"/"下移" buttons) that call `reorderApprovalTemplateGroups` with the org's full active-group
  permutation reordered by one position; template ITEMS are never reordered (I3: "模板在分组内首期
  无排序") and only `group:` sections carry these controls (`ungrouped`/`category:<name>` are not
  ordered rows).

  Kept as its OWN component (not folded into TemplateCenterView.vue) so the existing flat-table /
  gallery paths and their specs (`approvalTemplateCenterCategory.spec.ts`, `templateCenterI18n.spec.ts`)
  are untouched — this file is mounted only when the parent's `viewMode` is 'grouped' (default
  'flat'), so nothing here can affect any test that never toggles that ref.

  Bucket set: every ACTIVE group (§4 row C's `group:<id>`, sorted by `sortOrder`) plus `ungrouped`
  (§4 row C's `group_id IS NULL` ∪ never-linked-with-empty-category bucket) plus one `category:<name>`
  section per name `listTemplateCategories()` returns. That list is GLOBAL and org-agnostic (no
  link-row awareness, §Q5 undecided, deliberately untouched by this slice) — it is a name
  CANDIDATE list, not itself a bucket enumeration, so each candidate is resolved against this org's
  actual `category:<name>` bucket (server-side: never-linked + that literal category) and DROPPED
  from `sections` when its own `total` is 0 (unlike `group:`/`ungrouped`, which always render, empty
  state included — a category name with zero matching rows in this org is not a real section, it is
  a name that happens to exist somewhere in the global template table).

  Each section paginates independently (§4 row C: "每个 section 独立 page/pageSize"; the response's
  own `total` is this bucket's count, per-section, not a client-reconstructed one) via a manual
  "load more" rather than an `el-pagination` control, to keep N independent section page cursors
  simple. No Element Plus components are used here (plain elements + scoped CSS) — the move-up/
  move-down buttons above are its only interaction beyond click-to-select/load-more, so pulling in
  the same stub surface TemplateCenterView.vue's own spec needs would add test weight for no
  behavioral benefit.
-->
<template>
  <div class="template-group-sections" data-testid="template-group-sections">
    <div
      v-if="loadError"
      class="template-group-sections__error"
      data-testid="template-group-sections-error"
    >
      {{ loadError }}
    </div>
    <div
      v-else-if="loadingGroups"
      class="template-group-sections__loading"
      data-testid="template-group-sections-loading"
    >
      {{ t.groupSectionsLoading }}
    </div>
    <template v-else>
      <div
        v-if="reorderError"
        class="template-group-sections__reorder-error"
        data-testid="template-group-sections-reorder-error"
      >
        {{ reorderError }}
      </div>
      <section
        v-for="section in sections"
        :key="section.token"
        class="template-group-sections__section"
        :data-testid="`template-group-section-${section.token}`"
      >
        <header class="template-group-sections__section-header">
          <span class="template-group-sections__section-title-group">
            <span class="template-group-sections__section-title">{{ section.title }}</span>
            <span
              v-if="isGroupToken(section.token)"
              class="template-group-sections__reorder"
            >
              <button
                type="button"
                class="template-group-sections__reorder-btn"
                :disabled="!canMoveGroupUp(section.token) || reorderingToken !== null"
                :aria-label="t.groupSectionMoveUp"
                :title="t.groupSectionMoveUp"
                :data-testid="`template-group-section-move-up-${section.token}`"
                @click="moveGroupSection(section.token, -1)"
              >▲</button>
              <button
                type="button"
                class="template-group-sections__reorder-btn"
                :disabled="!canMoveGroupDown(section.token) || reorderingToken !== null"
                :aria-label="t.groupSectionMoveDown"
                :title="t.groupSectionMoveDown"
                :data-testid="`template-group-section-move-down-${section.token}`"
                @click="moveGroupSection(section.token, 1)"
              >▼</button>
            </span>
          </span>
          <span
            class="template-group-sections__section-count"
            data-testid="template-group-section-count"
          >{{ section.total }}</span>
        </header>
        <ul v-if="section.items.length > 0" class="template-group-sections__list">
          <li
            v-for="item in section.items"
            :key="item.id"
            class="template-group-sections__item"
            :data-testid="`template-group-section-item-${item.id}`"
            @click="emit('select', item.id)"
          >
            {{ item.name }}
          </li>
        </ul>
        <p v-else class="template-group-sections__empty">{{ t.groupSectionEmpty }}</p>
        <button
          v-if="section.hasMore"
          type="button"
          class="template-group-sections__more"
          :data-testid="`template-group-section-more-${section.token}`"
          @click="loadMore(section)"
        >
          {{ t.groupSectionLoadMore }}
        </button>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type {
  ApprovalTemplateGroupReorderResultDTO,
  ApprovalTemplateListItemDTO,
  ApprovalTemplateStatus,
} from '../../types/approval'
import {
  listApprovalTemplateGroups,
  listTemplateCategories,
  listTemplatesBySection,
  reorderApprovalTemplateGroups,
} from '../../approvals/api'
import { useLocale } from '../../composables/useLocale'
import { ZH, EN } from './templateCenterLabels'

const props = defineProps<{
  status?: ApprovalTemplateStatus
  search?: string
}>()

const emit = defineEmits<{ select: [templateId: string] }>()

const { isZh } = useLocale()
// Same `computed` + template-auto-unwrap convention as TemplateCenterView.vue's own `t` — section
// TITLES are still captured once per load (they come from `listApprovalTemplateGroups()`'s group
// names / the `t.value.categoryEmpty` fallback baked in at fetch time), a live locale flip only
// re-renders the loading/error/empty/"load more" CHROME strings immediately.
const t = computed(() => (isZh.value ? ZH : EN))

interface SectionState {
  token: string
  title: string
  items: ApprovalTemplateListItemDTO[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  // `group:`/`ungrouped` always render (empty state included); a `category:<name>` candidate is
  // dropped from `sections` when its own `total` is 0 — see the header comment / `loadAll` below.
  // Not read by the template.
  alwaysShow: boolean
}

const PAGE_SIZE = 10
const GROUP_TOKEN_PREFIX = 'group:'

const loadingGroups = ref(false)
const loadError = ref<string | null>(null)
const sections = ref<SectionState[]>([])

// Group-order editing (§3 I3 / §4 acceptance E phase-3 leg) — see header comment. `reorderError`
// is a NON-blocking inline message (the section list stays exactly as it was before the failed
// attempt); `reorderingToken` disables every move button while one reorder request is in flight so
// a second click cannot race the first against the same L0 critical section.
const reorderError = ref<string | null>(null)
const reorderingToken = ref<string | null>(null)

function isGroupToken(token: string): boolean {
  return token.startsWith(GROUP_TOKEN_PREFIX)
}

// The `group:` sections in their CURRENT render order — this is the org's active-group order as
// last known to this component (initial load order, or the previous reorder's result), not a
// re-fetch. A move button computes the permutation off this list, not off `sections.value`
// directly, so `ungrouped`/`category:<name>` entries interleaved after it never leak into the
// permutation sent to the server (that would trip `GROUP_REORDER_SET_MISMATCH`).
const groupTokenOrder = computed(() => sections.value.map((s) => s.token).filter(isGroupToken))

function canMoveGroupUp(token: string): boolean {
  return groupTokenOrder.value.indexOf(token) > 0
}

function canMoveGroupDown(token: string): boolean {
  const idx = groupTokenOrder.value.indexOf(token)
  return idx >= 0 && idx < groupTokenOrder.value.length - 1
}

async function fetchPage(token: string, page: number): Promise<{ data: ApprovalTemplateListItemDTO[]; total: number }> {
  return listTemplatesBySection({
    section: token,
    status: props.status,
    search: props.search,
    page,
    pageSize: PAGE_SIZE,
  })
}

async function loadAll(): Promise<void> {
  loadingGroups.value = true
  loadError.value = null
  try {
    const [groupRows, categoryNames] = await Promise.all([
      listApprovalTemplateGroups(),
      listTemplateCategories(),
    ])
    const groups = groupRows
      .filter((g) => g.archivedAt === null)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    const buckets = [
      ...groups.map((g) => ({ token: `${GROUP_TOKEN_PREFIX}${g.id}`, title: g.name, alwaysShow: true })),
      { token: 'ungrouped', title: t.value.categoryEmpty, alwaysShow: true },
      // Candidates only — `listTemplateCategories()` is global/org-agnostic (§Q5 undecided), so a
      // name here may resolve to zero rows in THIS org's `category:<name>` bucket; those are
      // dropped below rather than rendered as an empty section (see header comment).
      ...categoryNames.map((name) => ({ token: `category:${name}`, title: name, alwaysShow: false })),
    ]
    const loaded = await Promise.all(
      buckets.map(async ({ token, title, alwaysShow }) => {
        const res = await fetchPage(token, 1)
        return {
          token,
          title,
          alwaysShow,
          items: res.data,
          total: res.total,
          page: 1,
          pageSize: PAGE_SIZE,
          // Real remaining-count check, NOT `page * pageSize < total` — a mocked (or genuinely
          // short) page can return fewer than `pageSize` rows while more remain server-side, and
          // the reverse (a full page that happens to be the last one) must not show a dead button.
          hasMore: res.data.length < res.total,
        } satisfies SectionState
      }),
    )
    sections.value = loaded.filter((s) => s.alwaysShow || s.total > 0)
  } catch (e: any) {
    loadError.value = e?.message ?? t.value.groupSectionsLoadError
    sections.value = []
  } finally {
    loadingGroups.value = false
  }
}

async function loadMore(section: SectionState): Promise<void> {
  try {
    const res = await fetchPage(section.token, section.page + 1)
    section.items = [...section.items, ...res.data]
    section.page += 1
    section.total = res.total
    section.hasMore = section.items.length < res.total
  } catch {
    // Best-effort: leave the section as-is on a failed "load more" — the section's own rows
    // stay visible rather than the whole view degrading to the top-level error state.
  }
}

/**
 * Swaps `token` with its neighbour in `direction` (-1 = up, +1 = down) among the CURRENT
 * `group:` sections, then sends the org's full active-group id permutation to
 * `reorderApprovalTemplateGroups` (§3 I3: full re-rank, not a delta — every active group's id must
 * be present, exactly once, or the server rejects the whole request with
 * `GROUP_REORDER_SET_MISMATCH`). A no-op at either boundary (already first/last) or while another
 * reorder is in flight (`reorderingToken` guards both the buttons' `:disabled` and this function).
 */
async function moveGroupSection(token: string, direction: -1 | 1): Promise<void> {
  if (reorderingToken.value !== null) return
  const order = groupTokenOrder.value
  const idx = order.indexOf(token)
  const swapIdx = idx + direction
  if (idx < 0 || swapIdx < 0 || swapIdx >= order.length) return

  const nextOrder = [...order]
  ;[nextOrder[idx], nextOrder[swapIdx]] = [nextOrder[swapIdx], nextOrder[idx]]
  const groupIds = nextOrder.map((t) => t.slice(GROUP_TOKEN_PREFIX.length))

  reorderError.value = null
  reorderingToken.value = token
  try {
    const results = await reorderApprovalTemplateGroups(groupIds)
    applyGroupOrder(results)
  } catch (e: any) {
    reorderError.value = e?.message ?? t.value.groupReorderError
  } finally {
    reorderingToken.value = null
  }
}

/**
 * Re-sorts `sections.value`'s `group:` entries by the server's returned `sortOrder` (1..n),
 * preserving each section's already-loaded `items`/`total`/`page` state (no re-fetch — reordering
 * changes position, not membership or content) and leaving every non-`group:` section's relative
 * order untouched. `results` is `{id, sortOrder}[]` ONLY (`ApprovalTemplateGroupReorderResultDTO`
 * — see api.ts) — deliberately not read for `name`/`archivedAt`, which this response never carries.
 */
function applyGroupOrder(results: ApprovalTemplateGroupReorderResultDTO[]): void {
  const sortOrderByToken = new Map(results.map((r) => [`${GROUP_TOKEN_PREFIX}${r.id}`, r.sortOrder]))
  const groupSections = sections.value
    .filter((s) => sortOrderByToken.has(s.token))
    .sort((a, b) => (sortOrderByToken.get(a.token) ?? 0) - (sortOrderByToken.get(b.token) ?? 0))
  const otherSections = sections.value.filter((s) => !sortOrderByToken.has(s.token))
  sections.value = [...groupSections, ...otherSections]
}

defineExpose({ loadAll })

onMounted(loadAll)
</script>

<style scoped>
.template-group-sections__error {
  color: var(--el-color-danger, #f56c6c);
  padding: var(--ms-space-4, 16px) 0;
}

.template-group-sections__loading {
  color: var(--ms-text-2);
  padding: var(--ms-space-4, 16px) 0;
}

.template-group-sections__reorder-error {
  color: var(--el-color-danger, #f56c6c);
  padding: var(--ms-space-2, 8px) 0;
  font-size: 13px;
}

.template-group-sections__section-title-group {
  display: inline-flex;
  align-items: center;
}

.template-group-sections__reorder {
  display: inline-flex;
  gap: 2px;
  margin-left: var(--ms-space-2, 8px);
}

.template-group-sections__reorder-btn {
  background: none;
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 4px;
  color: var(--ms-text-2);
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
  padding: 3px 5px;
}

.template-group-sections__reorder-btn:hover:not(:disabled) {
  background: var(--el-fill-color-light, #f5f7fa);
  color: var(--ms-text-1);
}

.template-group-sections__reorder-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.template-group-sections__section {
  margin-bottom: var(--ms-space-4, 16px);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 6px;
  padding: var(--ms-space-3, 12px);
}

.template-group-sections__section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: var(--ms-font-weight-title, 600);
  color: var(--ms-text-1);
  margin-bottom: var(--ms-space-2, 8px);
}

.template-group-sections__section-count {
  color: var(--ms-text-2);
  font-weight: normal;
  font-size: 12px;
}

.template-group-sections__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.template-group-sections__item {
  padding: 6px 4px;
  cursor: pointer;
  border-radius: 4px;
}

.template-group-sections__item:hover {
  background: var(--el-fill-color-light, #f5f7fa);
}

.template-group-sections__empty {
  color: var(--ms-text-2);
  font-size: 13px;
  margin: 0;
}

.template-group-sections__more {
  margin-top: var(--ms-space-2, 8px);
  background: none;
  border: none;
  color: var(--el-color-primary, #409eff);
  cursor: pointer;
  padding: 0;
  font-size: 13px;
}
</style>
