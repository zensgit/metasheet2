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

  §6 表第 3 行's "拖拽归组" (drag templates into groups) is implemented here as a per-item
  keyboard-operable `<select>` ("移动到…"), NOT native HTML5 drag-and-drop — same deliberate
  substitution and rationale as the group-order buttons above (equal-or-wider input coverage,
  consistent with this file's one prior precedent, named explicitly here so it does not need to be
  re-derived). Calls the phase-1 link/unlink endpoints (`linkApprovalTemplateToGroup` /
  `unlinkApprovalTemplateFromGroup`, real-DB tested since phase 1's B/B′/B″/H) — NOT the two
  write-face forms, which is I4 and stays deferred (see above). Target-set rules (`moveTargetsFor`
  below), each one closing a distinct correctness trap:
  - Targets are the CURRENTLY RENDERED `group:` sections only (never a live re-fetch mid-select) —
    same acceptable staleness as the reorder permutation above (a target archived by someone else
    between load and click surfaces as the endpoint's own 409 `GROUP_ARCHIVED`, handled identically
    to a failed reorder: non-blocking inline error, row left exactly where it was).
  - "未分组" is offered ONLY from a `group:<id>` section. Offering it from `ungrouped` is a no-op by
    definition; offering it from a `category:<name>` section would silently do nothing useful too —
    unlink's `WHERE … AND group_id IS NOT NULL` matches 0 rows for a template that was NEVER
    linked (I2′), so no link row is created, `NOT EXISTS` stays true, and the row would (correctly)
    stay under its category — but a UI that showed a success state for that would be lying about
    having moved anything.
  - Moving the LAST row out of a `category:<name>` section removes that section from `sections`
    entirely (same "drop when `total` hits 0" invariant `loadAll()` already applies to candidates —
    applied here too so a move cannot leave a stale zero-row candidate section on screen).

  Neither this control nor the group-order buttons above are gated on `canManageTemplates` in this
  component — both rely on the routes' own `approvalTemplateAdminGuard` (I7) to fail closed with a
  403 surfaced the same way as any other request error. This is a deliberate, matched choice for
  BOTH write controls in this file (not a per-control judgment call) — gating one but not the other
  would split a guard across sibling surfaces in the same component. Gating client-side would also
  require this file to depend on `useApprovalPermissions()`, which the isolation note below (and
  `approvalTemplateCenterSections.spec.ts`'s own header comment) currently states this file does
  NOT need; adding it is a legitimate follow-up but changes what every existing test in that spec
  has to mock, so it is out of scope for this addition.

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
    <SessionOrgSwitcher
      v-if="showSessionOrgSwitcher"
      :tr="tr"
      :orgs="orgs"
      :model-value="selectedOrgId"
      :loading="sessionOrgLoading"
      :switching="sessionOrgSwitching"
      :error-message="sessionOrgError"
      @change="onSessionOrgChange"
    />
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
      <div
        v-if="moveError"
        class="template-group-sections__reorder-error"
        data-testid="template-group-sections-move-error"
      >
        {{ moveError }}
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
            <span class="template-group-sections__item-name">{{ item.name }}</span>
            <select
              v-if="moveTargetsFor(section.token).length > 0"
              class="template-group-sections__move-select"
              :data-testid="`template-group-section-move-${item.id}`"
              :aria-label="t.groupItemMoveLabel"
              :disabled="movingItemId === item.id"
              :value="''"
              @click.stop
              @change="onMoveItem(section, item, ($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>{{ t.groupItemMovePlaceholder }}</option>
              <option
                v-for="target in moveTargetsFor(section.token)"
                :key="target.token"
                :value="target.token"
              >{{ target.label }}</option>
            </select>
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
import { computed, inject, onMounted, ref } from 'vue'
import type {
  ApprovalTemplateGroupReorderResultDTO,
  ApprovalTemplateListItemDTO,
  ApprovalTemplateStatus,
} from '../../types/approval'
import {
  ApprovalApiError,
  linkApprovalTemplateToGroup,
  listApprovalTemplateGroups,
  listTemplateCategories,
  listTemplatesBySection,
  reorderApprovalTemplateGroups,
  unlinkApprovalTemplateFromGroup,
} from '../../approvals/api'
import SessionOrgSwitcher, { SessionOrgHostKey } from '../../components/SessionOrgSwitcher.vue'
import { useSessionOrg } from '../../composables/useSessionOrg'
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
// `SessionOrgSwitcher` takes the repo-wide `tr(en, zh)` prop shape (the A-2 panel receives one
// from TemplateCenterView.vue); this file's own label source is the `t` table above, so the
// adapter is derived from the SAME `isZh` rather than threading a second locale prop in.
const tr = (en: string, zh: string): string => (isZh.value ? zh : en)

// D3-1 (gate `impl-gate-A4-on-A2-merge-fix-round1-20260920.md` §6, 2026-09-20) — page-level
// acceptance J (§4). Before this, opening 模板中心 → 分组视图 as a multi-org member who has not
// picked a session organization ran `loadAll()` into a 403 `SESSION_ORG_REQUIRED` whose only
// surface here was the generic `loadError` string: the shared selector existed on the page, but
// only behind 切到分组视图 → 展开「管理分组」, i.e. never on the FIRST hop. The mechanism below is
// lifted whole from `ApprovalTemplateGroupsPanel.vue` (the A-2 half of acceptance J) — same
// reactive-not-proactive rule (`loadSessionOrgs()` runs only after a call has actually come back
// with that code, so a single-org member, whose `authenticatedTenantId` is always minted at login,
// never sees the selector), same single retry slot, same `switchSessionOrg` → replay-the-blocked-
// call wiring. `useSessionOrg.ts` and `views/attendance/AttendanceSessionOrgSwitcher.vue` stay
// untouched (design lock §2, 第 8 轮 P3-b: editing either narrows attendance-web-guard.yml's
// closed-world census).
//
// Scope note, deliberately NOT widened: only `loadAll()` — the mount-time read, i.e. the first hop
// this view makes — recognizes the code. `loadMore`/`moveGroupSection`/`onMoveItem` keep their
// existing non-blocking inline errors, because by the time any of them can run, `loadAll()` has
// already succeeded, which means a session organization is already bound for this session; a 403
// on those paths is `approvalTemplateAdminGuard` (I7), a different condition that the selector
// cannot fix. This is the named D3-1 change, not a narrower sibling of the panel's contract: the
// panel covers load + create because create is ITS first write; this view has no create.
// P1-A (impl-gate-A5-daily-ops-round1-20260920.md) — when this view is mounted inside
// TemplateCenterView, the PAGE owns the one `useSessionOrg()` instance, the one rendered switcher
// and the replay; this view only reports "I am blocked on SESSION_ORG_REQUIRED". Mounted with no
// host (its own spec, or any other future host) `inject` returns `null` and everything below
// behaves exactly as it did before — its own instance, its own switcher, its own retry slot. See
// `SessionOrgSwitcher.vue`'s `SessionOrgHost` doc comment for why a second live instance on one
// page is not a cosmetic duplicate but a state-destroying one.
const sessionOrgHost = inject(SessionOrgHostKey, null)

const {
  orgs,
  // `selectedOrgId` (not the raw `currentOrgId`) — the composable normalizes `null` to `''`, which
  // is what `SessionOrgSwitcher`'s `modelValue: string` prop requires.
  selectedOrgId,
  loading: sessionOrgLoading,
  switching: sessionOrgSwitching,
  errorMessage: sessionOrgError,
  loadSessionOrgs,
  switchSessionOrg,
} = sessionOrgHost?.sessionOrg ?? useSessionOrg()

// "This view's own load is blocked on a session-org choice" — it also suppresses the section list
// (which is empty in that state) regardless of who renders the control.
const sessionOrgBlocked = ref(false)
// Whether THIS view draws the control. Never while hosted: the page draws exactly one.
const showSessionOrgSwitcher = computed(() => sessionOrgBlocked.value && sessionOrgHost === null)
// The one blocked call to replay once the session-org switch resolves. Only `loadAll()` ever
// registers here (see the scope note above), so a single slot
// is enough — no queue needed. Stays empty while hosted: the host replays `loadAll()` itself.
let pendingRetry: (() => Promise<void>) | null = null

function handleSessionOrgRequired(retry: () => Promise<void>): void {
  sessionOrgBlocked.value = true
  if (sessionOrgHost) {
    pendingRetry = null
    sessionOrgHost.notifySessionOrgRequired()
    return
  }
  pendingRetry = retry
  // Fire-and-forget: populates the switcher's `orgs` list. A rejection here only leaves the
  // switcher's own `errorMessage` set; it must never throw back into the caller's catch.
  void loadSessionOrgs()
}

async function onSessionOrgChange(orgId: string): Promise<void> {
  const ok = await switchSessionOrg(orgId)
  if (!ok) return
  sessionOrgBlocked.value = false
  const retry = pendingRetry
  pendingRetry = null
  if (retry) await retry()
}

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
const UNGROUPED_TOKEN = 'ungrouped'

const loadingGroups = ref(false)
const loadError = ref<string | null>(null)
const sections = ref<SectionState[]>([])

// Group-order editing (§3 I3 / §4 acceptance E phase-3 leg) — see header comment. `reorderError`
// is a NON-blocking inline message (the section list stays exactly as it was before the failed
// attempt); `reorderingToken` disables every move button while one reorder request is in flight so
// a second click cannot race the first against the same L0 critical section.
const reorderError = ref<string | null>(null)
const reorderingToken = ref<string | null>(null)

// Item-to-group assignment (§6 表第 3 行 "拖拽归组") — see header comment. Same non-blocking-error /
// single-in-flight-guard convention as the group-order controls above, scoped per ITEM rather than
// per section since a move only ever touches one row.
const moveError = ref<string | null>(null)
const movingItemId = ref<string | null>(null)

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

// Request-algebra guard (impl-gate-A5-daily-ops-round2-20260920.md, additional load-bearing
// scenario (ii)): `loadAll()` is re-invoked on every session-org switch (`TemplateCenterView
// .onPageSessionOrgChange` calls `groupSectionsRef.value?.loadAll()` after each successful
// switch), and it had NO guard against two overlapping calls settling out of order. Two rapid
// switches (A, then B before A's reload has returned) fire two `loadAll()` calls back to back; if
// the org-A call's network round trip happens to finish AFTER the org-B call's, its response was
// a STALE answer for an org the admin has already left, and unconditionally assigning
// `sections.value`/`loadError.value`/`sessionOrgBlocked.value` from it would silently roll the
// screen back to org A's groups while the switcher itself still shows org B selected.
// `loadGeneration` is bumped by every call; each call captures its OWN number and only commits
// its result while that number is still the LATEST one issued — a later call always wins over an
// earlier one, regardless of which settles first. `ApprovalTemplateGroupsPanel.vue`'s sibling
// `loadGroups()` carries the identical guard for the identical reason (same page, same trigger).
let loadGeneration = 0

async function loadAll(): Promise<void> {
  const generation = ++loadGeneration
  const isCurrent = () => generation === loadGeneration
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
    if (!isCurrent()) return // a newer loadAll() has since been issued — this answer is stale.
    sections.value = loaded.filter((s) => s.alwaysShow || s.total > 0)
    sessionOrgBlocked.value = false
  } catch (e: any) {
    if (!isCurrent()) return
    // See the D3-1 block above. The selector replaces the generic error on THIS code only; every
    // other failure keeps the existing top-level error state verbatim.
    if (e instanceof ApprovalApiError && e.code === 'SESSION_ORG_REQUIRED') {
      sections.value = []
      handleSessionOrgRequired(loadAll)
      return
    }
    loadError.value = e?.message ?? t.value.groupSectionsLoadError
    sections.value = []
  } finally {
    if (isCurrent()) loadingGroups.value = false
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

/**
 * Valid move-to-group targets for an item currently in `currentToken` (§6 表第 3 行 "拖拽归组" —
 * see header comment for the full rationale). Every `group:<id>` section OTHER than the item's own
 * is always offered; "未分组" is offered ONLY when `currentToken` is itself a `group:<id>` section
 * (unlinking from `ungrouped`/`category:<name>` is a no-op — see header comment). Drawn from
 * `sections.value`, not a live re-fetch — same acceptable staleness as `groupTokenOrder` above.
 */
function moveTargetsFor(currentToken: string): { token: string; label: string }[] {
  const groupTargets = sections.value
    .filter((s) => isGroupToken(s.token) && s.token !== currentToken)
    .map((s) => ({ token: s.token, label: s.title }))
  if (isGroupToken(currentToken)) {
    return [{ token: UNGROUPED_TOKEN, label: t.value.categoryEmpty }, ...groupTargets]
  }
  return groupTargets
}

/**
 * P2-3 fix (groups-daily-ops-real-browser-acceptance-20260920.md) — re-fetches the pages a section
 * had ALREADY loaded (1..`section.page`), replacing `items`/`total`/`hasMore` from the server's
 * current truth. Used only when a section's loaded set is INCOMPLETE at the moment of a move
 * (`items.length < total`): with page-NUMBER pagination, the exact page a moved row now lands on
 * (or, symmetrically, which row now backfills the freed slot on the source side) is unknowable
 * client-side without a round trip — bumping/decrementing the counter alone leaves `total` and
 * `items.length` disagreeing, and `loadMore`'s next `page = section.page + 1` request can land past
 * the section's new end (empty response, "load more" never resolves — see the header comment on
 * `applyItemMove` below and the acceptance report's scenario P). Best-effort: a failed refresh
 * leaves the section's PRE-refresh state in place (same non-throwing discipline as `loadMore`'s own
 * catch) rather than degrading the whole view to the top-level error state.
 */
async function refreshSectionRange(section: SectionState): Promise<void> {
  try {
    let items: ApprovalTemplateListItemDTO[] = []
    let total = section.total
    for (let page = 1; page <= section.page; page += 1) {
      const res = await fetchPage(section.token, page)
      items = [...items, ...res.data]
      total = res.total
    }
    section.items = items
    section.total = total
    section.hasMore = items.length < total
  } catch {
    // See doc comment above — best-effort, pre-refresh state stands.
  }
}

/**
 * Moves `item` (currently rendered in `section`) to `targetToken` — `unlinkApprovalTemplateFromGroup`
 * for `ungrouped`, `linkApprovalTemplateToGroup` for a `group:<id>` target (the same atomic upsert
 * §2 uses for both first-link and re-link, so this one call covers moving OUT of `ungrouped` /
 * `category:<name>` too). On success the item is removed from `section` locally (no re-fetch —
 * same "position/membership changes, not re-fetched" convention as group-order moves) — UNLESS
 * `section` was already incomplete (`hasMore` true) at the time of the move, in which case its
 * loaded range is refreshed (`refreshSectionRange`, P2-3 fix: a page-number offset shift under
 * concurrent removal cannot be patched by a local counter decrement — see that function's doc
 * comment). The SAME rule applies to the target, mirrored: if the target section already holds its
 * COMPLETE loaded set (the common case — most sections fit on one page), the moved item is
 * inserted directly into `target.items` (zero extra requests, and `total`/`items.length` can never
 * drift apart because both are updated together); if the target was already paginated, its loaded
 * range is refreshed instead of guessing where the new row landed. Either way `total`/`hasMore` end
 * the move in agreement with what is actually rendered — this replaces the PRE-fix behaviour (bump
 * `target.total` only, never touch `target.items`) that produced a permanently-empty "load more"
 * whenever the target had already loaded everything it had (acceptance report P1/P2/P3). A
 * `category:<name>` section emptied by this move is still dropped from `sections` entirely (same
 * 0-total-candidate rule as `loadAll()`). A failed move is a NON-blocking inline error (`moveError`)
 * — the row is left exactly where it was; `refreshSectionRange` never throws into this catch.
 */
async function onMoveItem(
  section: SectionState,
  item: ApprovalTemplateListItemDTO,
  targetToken: string,
): Promise<void> {
  if (!targetToken || targetToken === section.token || movingItemId.value !== null) return
  moveError.value = null
  movingItemId.value = item.id
  try {
    if (targetToken === UNGROUPED_TOKEN) {
      await unlinkApprovalTemplateFromGroup(item.id)
    } else {
      await linkApprovalTemplateToGroup(item.id, targetToken.slice(GROUP_TOKEN_PREFIX.length))
    }
    await applyItemMove(section, item, targetToken)
  } catch (e: any) {
    moveError.value = e?.message ?? t.value.groupItemMoveError
  } finally {
    movingItemId.value = null
  }
}

async function applyItemMove(
  section: SectionState,
  item: ApprovalTemplateListItemDTO,
  targetToken: string,
): Promise<void> {
  const sourceWasComplete = section.items.length >= section.total
  section.items = section.items.filter((i) => i.id !== item.id)
  section.total = Math.max(0, section.total - 1)
  if (sourceWasComplete) {
    // Fewer rows, still the whole set — no request needed.
    section.hasMore = false
  } else {
    await refreshSectionRange(section)
  }
  if (!section.alwaysShow && section.total === 0) {
    sections.value = sections.value.filter((s) => s.token !== section.token)
  }

  const target = sections.value.find((s) => s.token === targetToken)
  if (target) {
    const targetWasComplete = target.items.length >= target.total
    target.total += 1
    if (targetWasComplete) {
      target.items = [...target.items, item]
      target.hasMore = false
    } else {
      await refreshSectionRange(target)
    }
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-2, 8px);
  padding: 6px 4px;
  border-radius: 4px;
}

.template-group-sections__item:hover {
  background: var(--el-fill-color-light, #f5f7fa);
}

.template-group-sections__item-name {
  cursor: pointer;
  flex: 1;
  min-width: 0;
}

.template-group-sections__move-select {
  font-size: 12px;
  color: var(--ms-text-2);
  border: 1px solid var(--el-border-color-lighter, #ebeef5);
  border-radius: 4px;
  background: var(--ms-bg-1, #fff);
  padding: 2px 4px;
  max-width: 140px;
}

.template-group-sections__move-select:disabled {
  cursor: not-allowed;
  opacity: 0.5;
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
