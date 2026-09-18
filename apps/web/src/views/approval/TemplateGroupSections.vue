<!--
  Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), §6 phase 3 (A-4): additive
  "分组视图" (grouped view) for TemplateCenterView.vue. Read-only in THIS increment — see the
  header comment in TemplateCenterView.vue for scope notes (drag reorder and the two write-face
  group selectors are deferred; the reorder endpoint itself already exists and is real-DB tested,
  `reorderApprovalTemplateGroups` in ../../approvals/api.ts is wired to it, just not from any UI
  yet).

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
  simple.  No Element Plus components are used here (plain elements + scoped CSS) — this view has
  no rich interaction yet (no drag, no inline actions), so pulling in the same stub surface
  TemplateCenterView.vue's own spec needs would add test weight for no behavioral benefit.
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
      <section
        v-for="section in sections"
        :key="section.token"
        class="template-group-sections__section"
        :data-testid="`template-group-section-${section.token}`"
      >
        <header class="template-group-sections__section-header">
          <span class="template-group-sections__section-title">{{ section.title }}</span>
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
import type { ApprovalTemplateListItemDTO, ApprovalTemplateStatus } from '../../types/approval'
import { listApprovalTemplateGroups, listTemplateCategories, listTemplatesBySection } from '../../approvals/api'
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

const loadingGroups = ref(false)
const loadError = ref<string | null>(null)
const sections = ref<SectionState[]>([])

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
      ...groups.map((g) => ({ token: `group:${g.id}`, title: g.name, alwaysShow: true })),
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
