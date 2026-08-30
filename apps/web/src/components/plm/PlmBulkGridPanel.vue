<template>
  <section class="bulk-panel" data-testid="plm-bulk-grid-panel">
    <header class="bulk-panel__head">
      <h3>批量属性维护</h3>
      <small>{{ itemTypeId }}</small>
    </header>

    <p v-if="loading" data-testid="plm-bulk-grid-loading">加载中…</p>

    <template v-else>
      <div class="bulk-panel__controls">
        <label>
          匹配属性
          <select
            :value="grid.matchProperty.value"
            data-testid="plm-bulk-grid-match-property"
            @change="onMatchPropertyChange(($event.target as HTMLSelectElement).value)"
          >
            <!-- N3-A: create-only is the SAFE default and the mandated fallback whenever a
                 match property's uniqueness cannot be established. -->
            <option value="">仅新建（不更新已有对象）</option>
            <option v-for="column in grid.declaredColumns.value" :key="column" :value="column">
              {{ column }}
            </option>
          </select>
        </label>
        <button type="button" data-testid="plm-bulk-grid-add-row" @click="grid.addRow()">新增行</button>
        <button type="button" data-testid="plm-bulk-grid-reload" @click="reload">重新加载</button>
      </div>

      <!-- N3-A warning: the provider's match lookup is a bare .first() with no is_current and
           no state filter, so a duplicated value writes to an ARBITRARY row and a superseded
           generation is an eligible target. Neither raises anything server-side. -->
      <p
        v-if="grid.matchProperty.value && duplicateMatchValues.length > 0"
        class="bulk-panel__warn"
        data-testid="plm-bulk-grid-match-warning"
      >
        匹配属性「{{ grid.matchProperty.value }}」在本表中不唯一（{{ duplicateMatchValues.length }} 个重复值：
        {{ duplicateMatchValues.slice(0, 5).join('、') }}）。PLM 会任意选中其中一条写入，且历史版本同样可能被命中。
        请改为仅新建，或先使该值唯一。
      </p>

      <p
        v-if="grid.needsRefreshBeforeCommit.value"
        class="bulk-panel__warn"
        data-testid="plm-bulk-grid-stale-warning"
      >
        <template v-if="grid.mustReload.value">
          上一次提交未确认或未成功，本地表格已不可信。请重新加载后再整批重交。
        </template>
        <template v-else>
          表格已打开较久，PLM 侧数据可能已变化。提交前请重新加载。
        </template>
      </p>

      <PlmBulkGridTable
        :declared-columns="grid.declaredColumns.value"
        :properties="grid.properties.value"
        :rows="grid.rows.value"
        :errors-for-row="grid.errorsForRow"
        :errors-for-cell="grid.errorsForCell"
        :disabled="grid.submitting.value"
        @update-cell="onUpdateCell"
      />

      <div class="bulk-panel__actions">
        <button
          type="button"
          data-testid="plm-bulk-grid-dry-run"
          :disabled="grid.submitting.value || grid.rows.value.length === 0"
          @click="grid.dryRun()"
        >
          {{ grid.submitting.value ? '校验中…' : '校验' }}
        </button>
        <button
          type="button"
          data-testid="plm-bulk-grid-commit"
          :disabled="!grid.canSubmit.value"
          :title="commitTitle"
          @click="onCommit"
        >
          提交写入
        </button>
      </div>

      <!-- The maker-checker split, stated rather than hidden: an engineer validates, an admin
           commits. The client affordance is a HINT only -- Yuantus's require_admin_user is the
           real gate, so a non-admin who reaches the endpoint still gets a 403. -->
      <p v-if="!grid.commitEnabled.value" class="bulk-panel__hint" data-testid="plm-bulk-grid-commit-disabled">
        本部署未开启批量写入，或当前账号不具备写入权限。校验仍可使用。
      </p>

      <p v-if="grid.errorMessage.value" class="bulk-panel__warn" data-testid="plm-bulk-grid-error">
        {{ grid.errorMessage.value }}
      </p>

      <div v-if="grid.report.value" class="bulk-panel__report" data-testid="plm-bulk-grid-report">
        <p v-if="grid.report.value.ready" data-testid="plm-bulk-grid-ready">
          校验通过。
          <!-- §3.1: these are FILE-level counts. There is no per-row new/updated verdict in the
               report, so the grid must never paint one. -->
          本文件将新建 {{ grid.report.value.would_create ?? 0 }} 条、更新
          {{ grid.report.value.would_update ?? 0 }} 条。
        </p>
        <p v-else data-testid="plm-bulk-grid-rejected">
          共 {{ grid.report.value.row_errors.length }} 处问题，整批不会写入任何数据。
        </p>
        <p
          v-if="grid.report.value.unknown_columns && grid.report.value.unknown_columns.length > 0"
          data-testid="plm-bulk-grid-unknown-columns"
        >
          以下列不属于该对象类型，将被忽略：{{ grid.report.value.unknown_columns.join('、') }}
        </p>
      </div>

      <p class="bulk-panel__hint">
        提交前会自动重新校验一次，但这只是把窗口缩短到一次往返，并不是加锁：
        PLM 不提供并发校验，提交会整体覆盖被匹配对象的属性。
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
/**
 * Bulk item-property maintenance grid — orchestration.
 *
 * Taskbook: docs/development/DEVELOPMENT_TASK_METASHEET_BULK_GRID_CONSUMER_20260829.md
 *
 * §2 — Family I: this panel lives in the MetaSheet MAIN APPLICATION behind a full login, and
 * is NOT an embeddable workbench iframe panel. `/bulk-import/commit` runs `require_admin_user`
 * and an embed-derived credential can never satisfy that — there is no configuration, claim,
 * or exchange that turns an embed token into an admin. Do not add an embed route to this
 * component; the resulting fail-closed error reads like a bug and is not one.
 *
 * §8 — the report is component-local state. It is never written into a sheet cell, a shared
 * store, or any server-side record: MetaSheet is collaborative and one user's row_errors
 * rendered for another is a privilege leak by construction.
 */
import { computed, onMounted, onUnmounted, ref, toRef } from 'vue'
import PlmBulkGridTable from './PlmBulkGridTable.vue'
import { usePlmBulkGrid } from '../../composables/usePlmBulkGrid'

const props = defineProps<{
  dataSourceId: string
  itemTypeId: string
  /** The caller's OWN PLM credential (§2). Supplied by the host view; never stored globally. */
  callerPlmToken: string
  seedRows?: Array<Record<string, unknown>>
}>()

const loading = ref(true)

const grid = usePlmBulkGrid({
  dataSourceId: toRef(props, 'dataSourceId'),
  itemTypeId: toRef(props, 'itemTypeId'),
  callerPlmToken: toRef(props, 'callerPlmToken'),
})

/**
 * Local N3-A pre-flight so the operator sees the problem BEFORE submitting. The server runs
 * the same check authoritatively and refuses with 409 match-property-not-unique. This is a
 * scan over rows already in hand — never a per-row existence probe, which §7 forbids.
 */
const duplicateMatchValues = computed<string[]>(() => {
  const column = grid.matchProperty.value
  if (!column) return []
  const counts = new Map<string, number>()
  for (const row of grid.rows.value) {
    const raw = row[column]
    const value = raw === null || raw === undefined ? '' : String(raw).trim()
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value)
})

const commitTitle = computed(() => {
  if (grid.mustReload.value) return '上一次提交未确认，请先重新加载'
  if (grid.isStale.value) return '表格已过期，请先重新加载'
  if (!grid.isReady.value) return '请先校验通过'
  if (!grid.commitEnabled.value) return '本部署未开启批量写入'
  return '提交写入 PLM'
})

async function reload(): Promise<void> {
  loading.value = true
  try {
    await grid.load(props.seedRows)
  } finally {
    loading.value = false
  }
}

function onUpdateCell(payload: { rowIndex: number; column: string; value: string }): void {
  grid.updateCell(payload.rowIndex, payload.column, payload.value)
}

function onMatchPropertyChange(value: string): void {
  grid.matchProperty.value = value
  // Changing the match property changes what the submission MEANS, so the previous verdict no
  // longer describes it and the key must be re-minted (§11).
  grid.markEdited()
}

async function onCommit(): Promise<void> {
  const result = await grid.commit()
  // N2-c: after ANY commit the displayed state must come from PLM, never the local buffer.
  if (result?.ready) await reload()
}

// N2-d: the staleness computed can only re-evaluate when something ticks -- wall-clock time is
// not a reactive dependency. Without this interval the "grid has been open too long" prompt would
// never appear in a live session. commit() re-checks directly as a backstop.
let stalenessTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await reload()
  stalenessTimer = setInterval(() => grid.refreshStaleness(), 30_000)
})

onUnmounted(() => {
  if (stalenessTimer) clearInterval(stalenessTimer)
  stalenessTimer = null
})
</script>

<style scoped>
.bulk-panel__head { display: flex; gap: 8px; align-items: baseline; }
.bulk-panel__controls { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
.bulk-panel__actions { display: flex; gap: 8px; margin-top: 8px; }
.bulk-panel__warn { color: #c0392b; }
.bulk-panel__hint { opacity: 0.75; font-size: 12px; }
.bulk-panel__report { margin-top: 8px; }
</style>
