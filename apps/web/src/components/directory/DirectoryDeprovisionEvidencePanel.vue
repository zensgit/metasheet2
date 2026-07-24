<template>
  <article class="deprov-evidence" data-testid="deprovision-evidence-panel">
    <div class="deprov-evidence__head">
      <div>
        <h2>离岗证据链（D7）</h2>
        <p class="deprov-evidence__hint">
          预览计划、查看 effect 事件、执行 rehire / admin force 恢复。策略配置 ≠ 已执行。
        </p>
      </div>
      <div class="deprov-evidence__row">
        <button
          class="deprov-evidence__btn deprov-evidence__btn--secondary"
          type="button"
          data-testid="deprovision-evidence-toggle"
          @click="expanded = !expanded"
        >
          {{ expanded ? '收起' : '展开证据链' }}
        </button>
        <button
          v-if="expanded"
          class="deprov-evidence__btn deprov-evidence__btn--secondary"
          type="button"
          :disabled="loadingFlags"
          @click="void refreshAll()"
        >
          {{ loadingFlags ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </div>

    <div v-if="!expanded" class="deprov-evidence__hint" data-testid="deprovision-evidence-collapsed">
      默认收起，避免干扰目录主流程；需要时再展开加载 flags / events。
    </div>

    <template v-if="expanded">
    <div
      class="deprov-evidence__banner"
      :class="flags?.enabled ? 'deprov-evidence__banner--warn' : 'deprov-evidence__banner--ok'"
      data-testid="deprovision-flags-banner"
    >
      <strong>DIRECTORY_DEPROVISION_ENABLED</strong>
      = {{ flags?.enabled ? 'true（writer 可能执行）' : 'false（默认关 · 不建议开启）' }}
      <span v-if="flags"> · MAX_BATCH={{ flags.maxBatch }}</span>
      <div class="deprov-evidence__hint">{{ flags?.policyNote || '策略≠已执行' }}</div>
    </div>

    <p v-if="status" class="deprov-evidence__status" :class="{ 'deprov-evidence__status--error': statusTone === 'error' }">
      {{ status }}
    </p>

    <section class="deprov-evidence__section">
      <h3>计划预览（只读）</h3>
      <div class="deprov-evidence__row">
        <input
          v-model="previewUserId"
          class="deprov-evidence__input"
          type="text"
          placeholder="本地 userId"
          data-testid="deprovision-preview-user-id"
        />
        <button
          class="deprov-evidence__btn"
          type="button"
          :disabled="!previewUserId.trim() || loadingPreview"
          data-testid="deprovision-preview-run"
          @click="void runPreview()"
        >
          {{ loadingPreview ? '预览中…' : '预览 plan' }}
        </button>
      </div>
      <div v-if="preview" class="deprov-evidence__card" data-testid="deprovision-preview-result">
        <div>用户 {{ preview.user.id }} · activation={{ preview.user.activationStatus }} · is_active={{ preview.user.isActive }} · gen={{ preview.user.accessGeneration }}</div>
        <div v-if="preview.plan.skipReason" class="deprov-evidence__hint">
          skipReason: {{ preview.plan.skipReason }}（零 effect）
        </div>
        <ul v-if="preview.plan.effects.length" class="deprov-evidence__list">
          <li v-for="(e, idx) in preview.plan.effects" :key="idx">
            {{ e.type }} · before={{ e.beforeActive }} → after={{ e.afterActive }}
            <span v-if="e.orgId"> · org={{ e.orgId }}</span>
          </li>
        </ul>
        <p v-else class="deprov-evidence__hint">无 planned effects</p>
      </div>
    </section>

    <section class="deprov-evidence__section">
      <h3>事件记录</h3>
      <div class="deprov-evidence__row">
        <input
          v-model="eventsUserFilter"
          class="deprov-evidence__input"
          type="text"
          placeholder="可选：按 userId 过滤"
        />
        <button class="deprov-evidence__btn deprov-evidence__btn--secondary" type="button" :disabled="loadingEvents" @click="void loadEvents()">
          加载事件
        </button>
      </div>
      <table v-if="events.length" class="deprov-evidence__table" data-testid="deprovision-events-table">
        <thead>
          <tr>
            <th>事件</th>
            <th>用户</th>
            <th>gen</th>
            <th>状态</th>
            <th>open effects</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ev in events" :key="ev.id">
            <td class="deprov-evidence__mono">{{ shortId(ev.id) }}</td>
            <td class="deprov-evidence__mono">{{ shortId(ev.local_user_id) }}</td>
            <td>{{ ev.access_generation_at_apply }}</td>
            <td>{{ ev.status }}</td>
            <td>{{ ev.open_effect_count ?? '—' }}</td>
            <td>
              <button class="deprov-evidence__link" type="button" @click="void selectEvent(ev)">详情</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="deprov-evidence__hint">暂无事件（表为空或尚未执行 deprovision writer）</p>
    </section>

    <section v-if="selectedEvent" class="deprov-evidence__section" data-testid="deprovision-restore-panel">
      <h3>恢复 · 事件 {{ shortId(selectedEvent.id) }}</h3>
      <ul v-if="effects.length" class="deprov-evidence__list">
        <li v-for="fx in effects" :key="fx.id">
          {{ fx.effect_type }} · {{ fx.status }} · after={{ fx.after_active }} · gen={{ fx.access_generation_at_apply }}
        </li>
      </ul>

      <div class="deprov-evidence__actions">
        <button
          class="deprov-evidence__btn"
          type="button"
          :disabled="restoring"
          data-testid="deprovision-restore-rehire"
          @click="void restore('rehire')"
        >
          Rehire 恢复（要求目录源仍 active）
        </button>
        <button
          class="deprov-evidence__btn deprov-evidence__btn--danger"
          type="button"
          :disabled="restoring || !forceConfirm"
          data-testid="deprovision-restore-force"
          @click="void restore('admin_force')"
        >
          Admin force 恢复
        </button>
      </div>
      <label class="deprov-evidence__check">
        <input v-model="forceConfirm" type="checkbox" data-testid="deprovision-force-confirm" />
        我确认 admin force（源可 inactive）
      </label>
      <textarea
        v-model="forceNote"
        class="deprov-evidence__textarea"
        rows="2"
        placeholder="force 备注（≥8 字）"
        data-testid="deprovision-force-note"
      />
      <p v-if="restoreConflict" class="deprov-evidence__status deprov-evidence__status--error" data-testid="deprovision-drift-conflict">
        {{ restoreConflict }}
      </p>
    </section>
    </template>
  </article>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { apiFetch } from '../../utils/api'

type DeprovisionFlags = {
  enabled: boolean
  maxBatch: number
  policyNote: string
}

type PlannedEffect = {
  type: string
  orgId?: string | null
  beforeActive: boolean
  afterActive: boolean
}

type PreviewPayload = {
  flags: DeprovisionFlags
  user: {
    id: string
    activationStatus: string
    isActive: boolean
    accessGeneration: number
  }
  plan: {
    skipReason: string | null
    effects: PlannedEffect[]
  }
}

type DeprovisionEvent = {
  id: string
  local_user_id: string
  access_generation_at_apply: number
  status: string
  open_effect_count?: number
  integration_id?: string
}

type DeprovisionEffect = {
  id: string
  effect_type: string
  status: string
  after_active: boolean
  access_generation_at_apply: number
}

const props = defineProps<{
  integrationId?: string | null
}>()

/** Collapsed by default so DirectoryManagementView existing tests / primary flows are not hit with extra API calls. */
const expanded = ref(false)
const flags = ref<DeprovisionFlags | null>(null)
const loadingFlags = ref(false)
const status = ref('')
const statusTone = ref<'ok' | 'error'>('ok')

const previewUserId = ref('')
const loadingPreview = ref(false)
const preview = ref<PreviewPayload | null>(null)

const eventsUserFilter = ref('')
const loadingEvents = ref(false)
const events = ref<DeprovisionEvent[]>([])

const selectedEvent = ref<DeprovisionEvent | null>(null)
const effects = ref<DeprovisionEffect[]>([])
const restoring = ref(false)
const forceConfirm = ref(false)
const forceNote = ref('')
const restoreConflict = ref('')

function shortId(id: string): string {
  if (!id) return ''
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

function setError(message: string) {
  status.value = message
  statusTone.value = 'error'
}

function setOk(message: string) {
  status.value = message
  statusTone.value = 'ok'
}

async function loadFlags() {
  loadingFlags.value = true
  try {
    const response = await apiFetch('/api/admin/directory/deprovision/flags')
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      setError(body?.error?.message || '加载 deprovision flags 失败')
      return
    }
    flags.value = body?.data as DeprovisionFlags
  } catch (error) {
    setError(error instanceof Error ? error.message : '加载 flags 失败')
  } finally {
    loadingFlags.value = false
  }
}

async function runPreview() {
  const userId = previewUserId.value.trim()
  if (!userId) return
  loadingPreview.value = true
  preview.value = null
  try {
    const response = await apiFetch(`/api/admin/directory/deprovision/preview/${encodeURIComponent(userId)}`)
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      setError(body?.error?.message || body?.error?.code || '预览失败')
      return
    }
    preview.value = body?.data as PreviewPayload
    setOk('预览完成（只读，无写）')
  } catch (error) {
    setError(error instanceof Error ? error.message : '预览失败')
  } finally {
    loadingPreview.value = false
  }
}

async function loadEvents() {
  loadingEvents.value = true
  try {
    const params = new URLSearchParams()
    if (props.integrationId) params.set('integrationId', props.integrationId)
    if (eventsUserFilter.value.trim()) params.set('userId', eventsUserFilter.value.trim())
    params.set('limit', '50')
    const response = await apiFetch(`/api/admin/directory/deprovision/events?${params.toString()}`)
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      setError(body?.error?.message || '加载事件失败')
      return
    }
    events.value = (body?.data?.items || []) as DeprovisionEvent[]
    if (body?.data?.flags) flags.value = body.data.flags as DeprovisionFlags
  } catch (error) {
    setError(error instanceof Error ? error.message : '加载事件失败')
  } finally {
    loadingEvents.value = false
  }
}

async function selectEvent(ev: DeprovisionEvent) {
  selectedEvent.value = ev
  restoreConflict.value = ''
  forceConfirm.value = false
  forceNote.value = ''
  try {
    const response = await apiFetch(`/api/admin/directory/deprovision/events/${encodeURIComponent(ev.id)}/effects`)
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      setError(body?.error?.message || '加载 effects 失败')
      effects.value = []
      return
    }
    effects.value = (body?.data?.items || []) as DeprovisionEffect[]
  } catch (error) {
    setError(error instanceof Error ? error.message : '加载 effects 失败')
  }
}

async function restore(mode: 'rehire' | 'admin_force') {
  if (!selectedEvent.value) return
  restoring.value = true
  restoreConflict.value = ''
  try {
    const response = await apiFetch(
      `/api/admin/directory/deprovision/events/${encodeURIComponent(selectedEvent.value.id)}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode,
          confirm: mode === 'admin_force' ? forceConfirm.value : undefined,
          note: mode === 'admin_force' ? forceNote.value : undefined,
        }),
      },
    )
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      const code = body?.error?.code || ''
      const message = body?.error?.message || '恢复失败'
      if (code === 'DRIFT_CONFLICT' || code === 'SOURCE_INACTIVE' || code === 'NO_EFFECTS') {
        restoreConflict.value = `${code}: ${message}`
      } else {
        setError(`${code || 'ERROR'}: ${message}`)
      }
      return
    }
    setOk(`恢复成功（${mode}）· effects=${body?.data?.restoredEffectCount ?? 0}`)
    await loadEvents()
    if (selectedEvent.value) await selectEvent(selectedEvent.value)
  } catch (error) {
    setError(error instanceof Error ? error.message : '恢复失败')
  } finally {
    restoring.value = false
  }
}

async function refreshAll() {
  await loadFlags()
  await loadEvents()
}

watch(
  () => props.integrationId,
  () => {
    if (expanded.value) void loadEvents()
  },
)

watch(expanded, (isOpen) => {
  if (isOpen) void refreshAll()
})
</script>

<style scoped>
.deprov-evidence {
  margin-top: 1.5rem;
  padding: 1rem 1.25rem;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  background: #fafbfc;
}
.deprov-evidence__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 0.75rem;
}
.deprov-evidence__head h2 {
  margin: 0 0 0.25rem;
  font-size: 1.1rem;
}
.deprov-evidence__hint {
  color: #57606a;
  font-size: 0.875rem;
  margin: 0.25rem 0;
}
.deprov-evidence__banner {
  padding: 0.75rem 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
  font-size: 0.9rem;
}
.deprov-evidence__banner--ok {
  background: #ddf4ff;
  border: 1px solid #54aeff66;
}
.deprov-evidence__banner--warn {
  background: #fff8c5;
  border: 1px solid #d4a72c66;
}
.deprov-evidence__section {
  margin-top: 1.25rem;
}
.deprov-evidence__section h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.deprov-evidence__row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}
.deprov-evidence__input {
  flex: 1 1 220px;
  min-width: 180px;
  padding: 0.4rem 0.6rem;
  border: 1px solid #d0d7de;
  border-radius: 6px;
}
.deprov-evidence__textarea {
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.5rem;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  font-family: inherit;
}
.deprov-evidence__btn {
  padding: 0.4rem 0.85rem;
  border-radius: 6px;
  border: 1px solid #0969da;
  background: #0969da;
  color: #fff;
  cursor: pointer;
}
.deprov-evidence__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.deprov-evidence__btn--secondary {
  background: #fff;
  color: #24292f;
  border-color: #d0d7de;
}
.deprov-evidence__btn--danger {
  background: #cf222e;
  border-color: #cf222e;
}
.deprov-evidence__card {
  padding: 0.75rem;
  background: #fff;
  border: 1px solid #d0d7de;
  border-radius: 6px;
}
.deprov-evidence__list {
  margin: 0.5rem 0 0;
  padding-left: 1.25rem;
}
.deprov-evidence__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
  background: #fff;
}
.deprov-evidence__table th,
.deprov-evidence__table td {
  border: 1px solid #d0d7de;
  padding: 0.4rem 0.5rem;
  text-align: left;
}
.deprov-evidence__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}
.deprov-evidence__link {
  background: none;
  border: none;
  color: #0969da;
  cursor: pointer;
  text-decoration: underline;
  padding: 0;
}
.deprov-evidence__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.75rem 0 0.5rem;
}
.deprov-evidence__check {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.875rem;
  margin-top: 0.5rem;
}
.deprov-evidence__status {
  margin-top: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  background: #ddf4ff;
}
.deprov-evidence__status--error {
  background: #ffebe9;
  color: #a40e26;
}
</style>
