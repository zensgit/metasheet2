<template>
  <div class="eco-impact" data-testid="plm-eco-impact">
    <header class="eco-impact__head">
      <div>
        <h2 class="eco-impact__title">ECO 影响分析工作集 · Impact working set</h2>
        <p class="eco-impact__subtitle">
          只读工作集：以你自己的 PLM 身份读取 {{ ecoId }} 的影响分析（受影响装配、影响汇总、BOM/版本/文件差异）。
          决策仍在 Yuantus 的 apply 中完成，本工作集不做 apply、不做逐行处置。
        </p>
      </div>
      <button
        type="button"
        class="eco-impact__refresh"
        data-testid="plm-eco-impact-refresh"
        :disabled="loading"
        @click="reload"
      >
        {{ loading ? '加载中…' : '刷新' }}
      </button>
    </header>

    <!-- Section flags. Toggling re-fetches (the export URL uses the SAME flags, so download == screen). -->
    <div class="eco-impact__flags" data-testid="plm-eco-impact-flags">
      <label><input v-model="flags.includeBomDiff" type="checkbox" @change="reload" /> BOM 差异</label>
      <label><input v-model="flags.includeVersionDiff" type="checkbox" @change="reload" /> 版本差异</label>
      <label><input v-model="flags.includeFiles" type="checkbox" @change="reload" /> 文件</label>
      <label><input v-model="flags.includeChildFields" type="checkbox" @change="reload" /> 子项字段</label>
      <label>
        最大层级
        <input v-model.number="flags.maxLevels" type="number" min="-1" style="width: 72px" @change="reload" />
      </label>
    </div>

    <p v-if="unavailable" class="eco-impact__notice" data-testid="plm-eco-impact-unavailable">
      ECO 影响分析在当前数据源不可用。
    </p>
    <p
      v-else-if="needsCredential"
      class="eco-impact__notice eco-impact__notice--warn"
      data-testid="plm-eco-impact-no-credential"
    >
      需要以你自己的 PLM 身份读取（未检测到已关联的 PLM 登录凭据）。请先关联你的 PLM 账户后再查看，本工作集绝不会用共享服务账户代读。
    </p>
    <!-- §3.1: a missing ECO and one not visible to you are deliberately indistinguishable. -->
    <p
      v-else-if="notFoundOrForbidden"
      class="eco-impact__notice"
      data-testid="plm-eco-impact-not-found"
    >
      未找到该 ECO，或你没有查看它的权限。
    </p>
    <p v-else-if="invalidRequest" class="eco-impact__notice" data-testid="plm-eco-impact-invalid">
      请求参数无效（例如 max_levels 越界）。
    </p>
    <p v-else-if="transient" class="eco-impact__notice" data-testid="plm-eco-impact-transient">
      暂时无法获取影响分析，请稍后刷新。
    </p>

    <template v-if="impact">
      <div class="eco-impact__toolbar">
        <label>
          导出
          <select v-model="exportFormat" data-testid="plm-eco-impact-export-format">
            <option value="csv">CSV</option>
            <option value="xlsx">XLSX</option>
            <option value="pdf">PDF</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <button
          type="button"
          class="eco-impact__download"
          data-testid="plm-eco-impact-download"
          :disabled="downloading"
          @click="download"
        >
          {{ downloading ? '导出中…' : '导出（与当前视图字段一致）' }}
        </button>
        <span v-if="downloadError" class="eco-impact__download-err">{{ downloadError }}</span>
      </div>

      <!-- Overview -->
      <section class="eco-impact__section" data-testid="plm-eco-impact-overview">
        <h3># 概览 Overview</h3>
        <dl class="eco-impact__kv">
          <div><dt>eco_id</dt><dd>{{ impact.eco_id }}</dd></div>
          <div><dt>changed_product_id</dt><dd>{{ impact.changed_product_id ?? '—' }}</dd></div>
          <div><dt>impact_count</dt><dd>{{ impact.impact_count ?? '—' }}</dd></div>
          <div><dt>impact_level</dt><dd>{{ impact.impact_level ?? '—' }}</dd></div>
          <div><dt>impact_score</dt><dd>{{ impact.impact_score ?? '—' }}</dd></div>
          <div><dt>impact_scope</dt><dd>{{ impact.impact_scope ?? '—' }}</dd></div>
        </dl>
      </section>

      <!-- Impact summary -->
      <section v-if="impactSummary" class="eco-impact__section" data-testid="plm-eco-impact-summary">
        <h3># 影响汇总 Impact summary</h3>
        <dl class="eco-impact__kv">
          <div v-for="(v, k) in impactSummary" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></div>
        </dl>
      </section>

      <!-- Impacted assemblies (main grid) -->
      <section class="eco-impact__section" data-testid="plm-eco-impact-assemblies">
        <h3># 受影响装配 Impacted assemblies</h3>
        <div class="eco-impact__grid-controls">
          <input
            v-model.trim="assemblyFilter"
            type="text"
            placeholder="过滤（物料号 / 名称）"
            data-testid="plm-eco-impact-assembly-filter"
          />
        </div>
        <p v-if="sortedAssemblies.length === 0" class="eco-impact__hint">没有受影响装配。</p>
        <table v-else class="eco-impact__table">
          <thead>
            <tr>
              <th class="is-sortable" @click="toggleSort('level')">层级</th>
              <th class="is-sortable" @click="toggleSort('parent_item_number')">父装配物料号</th>
              <th class="is-sortable" @click="toggleSort('parent_name')">父装配名称</th>
              <th>父装配 ID</th>
              <th>关系 ID (relationship.id)</th>
              <th>关系类型</th>
              <th>本地临时批注（不保存）</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in sortedAssemblies"
              :key="row.__key"
              data-testid="plm-eco-impact-assembly-row"
              :data-row-key="row.__key"
            >
              <td>{{ row.level ?? '—' }}</td>
              <td>{{ row.parent_item_number || '—' }}</td>
              <td>{{ row.parent_name || '—' }}</td>
              <td><code class="eco-impact__ref">{{ row.parent_id }}</code></td>
              <td><code class="eco-impact__ref">{{ row.relationship_id }}</code></td>
              <td>{{ row.relationship_item_type_id || '—' }}</td>
              <td>
                <input
                  class="eco-impact__note"
                  type="text"
                  :value="notes[row.__key] || ''"
                  placeholder="仅本地、不保存"
                  data-testid="plm-eco-impact-note"
                  @input="setNote(row.__key, ($event.target as HTMLInputElement).value)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Flag-gated sections: rendered as read-only pre so the grid never shows LESS than the CSV. -->
      <section v-if="impact.bom_diff !== undefined" class="eco-impact__section" data-testid="plm-eco-impact-bomdiff">
        <h3># BOM 差异 BOM diff</h3>
        <pre class="eco-impact__raw">{{ pretty(impact.bom_diff) }}</pre>
      </section>
      <section v-if="impact.version_diff !== undefined" class="eco-impact__section" data-testid="plm-eco-impact-versiondiff">
        <h3># 版本差异 Version diff</h3>
        <pre class="eco-impact__raw">{{ pretty(impact.version_diff) }}</pre>
      </section>
      <section v-if="impact.version_files_diff !== undefined" class="eco-impact__section">
        <h3># 版本文件差异 Version files diff</h3>
        <pre class="eco-impact__raw">{{ pretty(impact.version_files_diff) }}</pre>
      </section>
      <section v-if="impact.files !== undefined" class="eco-impact__section" data-testid="plm-eco-impact-files">
        <h3># 文件 Files</h3>
        <pre class="eco-impact__raw">{{ pretty(impact.files) }}</pre>
      </section>

      <!-- Commentary pointer + honest deferral (see script docstring / report). NO write control. -->
      <section class="eco-impact__section eco-impact__discussion" data-testid="plm-eco-impact-discussion">
        <h3># 评论 Commentary</h3>
        <p>
          针对本 ECO 的评论/讨论请走已上线的讨论通道（讨论以 <strong>ECO</strong> 为目标，不是逐行）。
          本工作集不内建讨论写入按钮：现有讨论写入凭据只能经 <code>bom_multitable</code> 嵌入交换获得，
          两个 taskbook 都对本通道关闭了该交换；从主应用全登录位置直接写讨论目前没有可用路径（详见交付说明的偏差项）。
          逐行处置与 apply 已按 §5.1/§5.2 在本轮排除。
        </p>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  downloadPlmEcoImpactExport,
  getPlmEcoImpact,
  type PlmEcoImpactExportFormat,
  type PlmEcoImpactFlags,
  type PlmEcoImpactResult,
} from '../../services/integration/workbench'

const props = withDefaults(defineProps<{
  dataSourceId: string
  ecoId: string
  /** The viewing user's own PLM bearer. Empty -> relay degrades to no-plm-credential (no service account). */
  plmUserToken?: string
}>(), {
  plmUserToken: '',
})

const loading = ref(false)
const result = ref<PlmEcoImpactResult | null>(null)
const flags = reactive<PlmEcoImpactFlags>({
  includeBomDiff: false,
  includeVersionDiff: false,
  includeFiles: false,
  includeChildFields: false,
  // Do NOT default to -1 (unlimited explosion is not free — §4.3). Leave undefined => provider 10.
  maxLevels: undefined,
})
const assemblyFilter = ref('')
const sortKey = ref<string>('')
const sortDir = ref<'asc' | 'desc'>('asc')
const exportFormat = ref<PlmEcoImpactExportFormat>('csv')
const downloading = ref(false)
const downloadError = ref('')

// Ephemeral, per-viewer, NEVER persisted or sent anywhere: keeps commentary out of a second
// source of truth for PLM state (§5.2). Lost on reload by design.
const notes = reactive<Record<string, string>>({})
function setNote(key: string, value: string): void { notes[key] = value }

const impact = computed<Record<string, unknown> | null>(() =>
  result.value?.available === true ? result.value.impact : null,
)
const reason = computed<string | undefined>(() =>
  result.value?.available === true ? result.value.reason : (result.value?.reason))
const unavailable = computed(() => result.value != null && result.value.available === false)
const needsCredential = computed(() => result.value?.available === true && reason.value === 'no-plm-credential')
const notFoundOrForbidden = computed(() => result.value?.available === true && reason.value === 'not-found-or-forbidden')
const invalidRequest = computed(() => result.value?.available === true && reason.value === 'invalid-request')
const transient = computed(() => result.value?.available === true && reason.value === 'unavailable')

const impactSummary = computed<Record<string, unknown> | null>(() => {
  const s = impact.value?.impact_summary
  return s && typeof s === 'object' ? s as Record<string, unknown> : null
})

interface AssemblyRow {
  __key: string
  level: number | null
  parent_id: string
  parent_item_number: string
  parent_name: string
  relationship_id: string
  relationship_item_type_id: string
}

const assemblies = computed<AssemblyRow[]>(() => {
  const raw = impact.value?.impacted_assemblies
  if (!Array.isArray(raw)) return []
  return raw.map((entry) => {
    const e = entry as Record<string, unknown>
    const parent = (e.parent || {}) as Record<string, unknown>
    const rel = (e.relationship || {}) as Record<string, unknown>
    const parentId = String(parent.id ?? '')
    const relId = String(rel.id ?? '')
    return {
      // Stable row key: relationship.id scoped by parent.id (§4.1) — NEVER the array index.
      __key: `${parentId}::${relId}`,
      level: typeof e.level === 'number' ? e.level : null,
      parent_id: parentId,
      parent_item_number: String(parent.item_number ?? ''),
      parent_name: String(parent.name ?? ''),
      relationship_id: relId,
      relationship_item_type_id: String(rel.item_type_id ?? ''),
    }
  })
})

const filteredAssemblies = computed<AssemblyRow[]>(() => {
  const f = assemblyFilter.value.toLowerCase()
  if (!f) return assemblies.value
  return assemblies.value.filter((r) =>
    r.parent_item_number.toLowerCase().includes(f) || r.parent_name.toLowerCase().includes(f),
  )
})

const sortedAssemblies = computed<AssemblyRow[]>(() => {
  const key = sortKey.value
  if (!key) return filteredAssemblies.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  return [...filteredAssemblies.value].sort((a, b) => {
    const av = (a as Record<string, unknown>)[key]
    const bv = (b as Record<string, unknown>)[key]
    if (av === bv) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return av < bv ? -dir : dir
  })
})

function toggleSort(key: string): void {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortKey.value = key; sortDir.value = 'asc' }
}

function pretty(value: unknown): string {
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

async function reload(): Promise<void> {
  if (!props.dataSourceId || !props.ecoId) return
  loading.value = true
  try {
    result.value = await getPlmEcoImpact(props.dataSourceId, props.plmUserToken, props.ecoId, { ...flags })
  } finally {
    loading.value = false
  }
}

async function download(): Promise<void> {
  downloadError.value = ''
  downloading.value = true
  try {
    // Same flags as the grid -> the file matches the screen (§6.1). URL built by the shared serializer.
    const res = await downloadPlmEcoImpactExport(props.dataSourceId, props.ecoId, exportFormat.value, props.plmUserToken, { ...flags })
    if (!res.ok) { downloadError.value = '导出失败或不可用'; return }
    const url = URL.createObjectURL(res.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = res.filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch {
    downloadError.value = '导出失败'
  } finally {
    downloading.value = false
  }
}

watch(() => [props.dataSourceId, props.ecoId, props.plmUserToken], reload)
onMounted(reload)
</script>

<style scoped>
.eco-impact { display: flex; flex-direction: column; gap: 14px; }
.eco-impact__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.eco-impact__title { margin: 0; font-size: 16px; }
.eco-impact__subtitle { margin: 4px 0 0; font-size: 12px; color: #6b7280; }
.eco-impact__refresh, .eco-impact__download { padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; cursor: pointer; }
.eco-impact__refresh:disabled, .eco-impact__download:disabled { opacity: 0.6; cursor: default; }
.eco-impact__flags, .eco-impact__toolbar { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; font-size: 12px; color: #374151; }
.eco-impact__flags label, .eco-impact__toolbar label { display: inline-flex; align-items: center; gap: 6px; }
.eco-impact__notice { padding: 8px 12px; border-radius: 6px; background: #f3f4f6; font-size: 13px; color: #374151; }
.eco-impact__notice--warn { background: #fef3c7; color: #92400e; }
.eco-impact__section { border-top: 1px solid #e5e7eb; padding-top: 10px; }
.eco-impact__section h3 { margin: 0 0 8px; font-size: 13px; color: #111827; }
.eco-impact__kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 16px; margin: 0; }
.eco-impact__kv div { display: flex; gap: 8px; font-size: 12px; }
.eco-impact__kv dt { color: #6b7280; min-width: 120px; }
.eco-impact__kv dd { margin: 0; color: #111827; }
.eco-impact__grid-controls { margin-bottom: 6px; }
.eco-impact__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.eco-impact__table th, .eco-impact__table td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; vertical-align: top; }
.eco-impact__table th.is-sortable { cursor: pointer; user-select: none; }
.eco-impact__ref { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #6b7280; word-break: break-all; }
.eco-impact__note { width: 100%; box-sizing: border-box; font-size: 12px; }
.eco-impact__raw { max-height: 280px; overflow: auto; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; font-size: 12px; }
.eco-impact__discussion { color: #374151; font-size: 12px; }
.eco-impact__download-err { color: #b91c1c; font-size: 12px; }
.eco-impact__hint { font-size: 12px; color: #6b7280; }
</style>
