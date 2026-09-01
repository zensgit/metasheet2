<template>
  <section id="int-sec-hub-overview" class="integration-workbench__panel" data-testid="hub-overview-section">
    <el-card shadow="never">
      <template #header>
        <div class="integration-workbench__panel-head">
          <div>
            <h2>{{ bi('对接总览', 'Integration Overview') }}</h2>
            <p>{{ bi(
              '一屏回答:当前对接了哪些系统、各用哪个连接、谁在用、状态如何。只读汇总,不在这里改配置——每张卡片都跳回下方“连接管理”编辑。',
              'One screen answering: which systems are connected, which connection each uses, who consumes it, and what state it is in. Read-only — every card jumps down to Connections to edit.',
            ) }}</p>
          </div>
          <div class="hub-overview__head-actions">
            <button
              type="button"
              class="integration-workbench__button"
              data-testid="hub-overview-add-connection"
              @click="emit('open-connections')"
            >{{ bi('新增连接', 'Add connection') }}</button>
            <button
              type="button"
              class="integration-workbench__button"
              data-testid="hub-overview-refresh"
              :disabled="loading"
              @click="refresh"
            >{{ loading ? bi('刷新中…', 'Refreshing…') : bi('刷新', 'Refresh') }}</button>
          </div>
        </div>
      </template>

      <p v-if="errorMessage" class="hub-overview__error" data-testid="hub-overview-error">{{ errorMessage }}</p>

      <div v-if="!loading && !errorMessage && systems.length === 0" class="integration-workbench__empty" data-testid="hub-overview-empty">
        <strong>{{ bi('尚未接入任何系统，右上角新增。', 'No system is connected yet — use “Add connection” at the top right.') }}</strong>
      </div>

      <div v-else-if="systems.length > 0" class="hub-overview__cards" data-testid="hub-overview-cards">
        <article
          v-for="system in systems"
          :key="system.id"
          class="hub-overview__card"
          :data-testid="`hub-overview-card-${system.id}`"
        >
          <header class="hub-overview__card-head">
            <strong :data-testid="`hub-overview-name-${system.id}`">{{ system.name || system.id }}</strong>
            <span class="hub-overview__kind" :data-testid="`hub-overview-kind-${system.id}`">{{ label(system.kindLabel) }}</span>
            <span
              class="hub-overview__status"
              :data-status="system.status || 'unknown'"
              :data-testid="`hub-overview-status-${system.id}`"
            >
              <i class="hub-overview__dot" :data-status="system.status || 'unknown'" aria-hidden="true"></i>
              {{ statusText(system) }}
            </span>
          </header>

          <dl class="hub-overview__facts">
            <div class="hub-overview__fact">
              <dt>{{ bi('连接', 'Connection') }}</dt>
              <dd :data-testid="`hub-overview-connection-${system.id}`">{{ connectionText(system) }}</dd>
            </div>
            <div class="hub-overview__fact">
              <dt>{{ bi('在用', 'Used by') }}</dt>
              <dd :data-testid="`hub-overview-consumers-${system.id}`">{{ consumersText(system) }}</dd>
            </div>
            <div class="hub-overview__fact">
              <dt>{{ bi('写入能力', 'Write capability') }}</dt>
              <dd
                class="hub-overview__write"
                :data-fenced="system.writeCapability.fenced ? 'true' : 'false'"
                :data-testid="`hub-overview-write-${system.id}`"
              >{{ label(system.writeCapability.notice) }}</dd>
            </div>
          </dl>

          <p
            v-if="system.writeCapability.fenced"
            class="hub-overview__fence"
            :data-testid="`hub-overview-fence-${system.id}`"
          >{{ label(system.writeCapability.notice) }}</p>

          <details class="hub-overview__technical" :data-testid="`hub-overview-technical-${system.id}`">
            <summary>{{ bi('技术详情(排障用)', 'Technical details (for troubleshooting)') }}</summary>
            <dl>
              <div v-for="row in technicalRows(system)" :key="row.key" class="hub-overview__technical-row">
                <dt>{{ row.key }}</dt>
                <dd :data-testid="`hub-overview-technical-${system.id}-${row.key}`">{{ row.value }}</dd>
              </div>
            </dl>
          </details>

          <footer class="hub-overview__card-foot">
            <button
              type="button"
              class="integration-workbench__button"
              :data-testid="`hub-overview-edit-${system.id}`"
              @click="emit('open-connection', system.id)"
            >{{ bi('在连接管理中编辑', 'Edit in Connections') }}</button>
          </footer>
        </article>
      </div>
    </el-card>
  </section>
</template>

<script setup lang="ts">
// 对接总览 — the FIRST section of the 数据工厂 workbench.
//
// Self-contained (same shape as IntegrationBridgeAgentSection.vue / IntegrationReadSourceConfigPanel
// .vue): the parent hands down only `scope`, and this component owns the ONE read it needs.
//
// WHAT IT IS NOT, deliberately:
//   - Not an editor. There is no upsert/delete/test/run call anywhere in this file. Every action is
//     a NAVIGATION: `open-connection` asks the parent to load that system into the connection draft
//     it already owns and scroll there, and `open-connections` just scrolls. No new editing surface
//     was built, per the brief.
//   - Not a second source of truth. Every plain-word label (kind, write capability, the K3 fence
//     sentence, consumer names) is SERVER-AUTHORED and rendered verbatim; this file maps none of
//     them itself. A drift between what the runtime enforces and what this screen claims is
//     therefore impossible by construction rather than by convention.
//   - Not a place a connection detail can appear. The response type carries no host, port,
//     connection string, credential or error text — see the workbench.ts comment on
//     IntegrationHubOverview — so there is nothing here to leak. `hasLastError` is a boolean and
//     renders as a coarse "上次测试失败" phrase, never as the driver's message.
import { onMounted, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import {
  fetchIntegrationHubOverview,
  type IntegrationHubBilingualLabel,
  type IntegrationHubConsumer,
  type IntegrationHubSystem,
  type IntegrationScope,
} from '../../services/integration/workbench'

const props = defineProps<{ scope: IntegrationScope }>()
const emit = defineEmits<{
  (event: 'open-connection', systemId: string): void
  (event: 'open-connections'): void
}>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

function label(value: IntegrationHubBilingualLabel | undefined): string {
  if (!value) return ''
  return locale.value === 'zh-CN' ? value.zh : value.en
}

const systems = ref<IntegrationHubSystem[]>([])
const loading = ref(false)
const errorMessage = ref('')

// Monotonic request id: the same stale-response guard the rest of this workbench uses. A slow
// first load must not overwrite a fast reload triggered by a scope change.
let requestId = 0

async function refresh(): Promise<void> {
  const ticket = ++requestId
  loading.value = true
  errorMessage.value = ''
  try {
    const overview = await fetchIntegrationHubOverview(props.scope)
    if (ticket !== requestId) return
    systems.value = overview.systems
  } catch (error) {
    if (ticket !== requestId) return
    systems.value = []
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (ticket === requestId) loading.value = false
  }
}

onMounted(() => { void refresh() })
watch(() => [props.scope.tenantId, props.scope.workspaceId], () => { void refresh() })

const STATUS_TEXT: Record<string, IntegrationHubBilingualLabel> = {
  active: { zh: '已启用', en: 'Active' },
  inactive: { zh: '已停用', en: 'Inactive' },
  error: { zh: '异常', en: 'Error' },
}

function statusText(system: IntegrationHubSystem): string {
  const base = STATUS_TEXT[system.status || ''] ?? { zh: '状态未知', en: 'Unknown' }
  const parts = [label(base)]
  if (system.lastTestedAt) {
    parts.push(bi(`上次测试 ${formatTimestamp(system.lastTestedAt)}`, `last tested ${formatTimestamp(system.lastTestedAt)}`))
  } else {
    parts.push(bi('尚未测试', 'never tested'))
  }
  // Coarse only. The failure TEXT never crosses the wire, and this line must not imply it did.
  if (system.hasLastError) parts.push(bi('上次测试有报错', 'last test reported an error'))
  return parts.join(' · ')
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString().slice(0, 16).replace('T', ' ')
}

function connectionText(system: IntegrationHubSystem): string {
  const connection = system.connection
  if (connection.model === 'internal') return bi('本系统内部表(无外部连接)', 'Internal tables (no external connection)')
  if (connection.model === 'self-contained') return bi('自带连接', 'Self-contained connection')
  if (!connection.bound) return bi('未绑定', 'Not bound')
  if (connection.resolved) {
    const name = connection.name || connection.dataSourceId || ''
    return connection.type ? `${name} · ${connection.type}` : name
  }
  if (connection.unresolvedReason === 'directory_unavailable') {
    return bi('已配置(名称不可见)', 'Configured (name unavailable)')
  }
  // data_sources rows are per-user-owned; a connection someone else manages is deliberately
  // unnamed rather than guessed at.
  return bi('已配置(他人管理)', 'Configured (managed by someone else)')
}

function consumerText(consumer: IntegrationHubConsumer): string {
  const base = label(consumer.label)
  if (consumer.name) return `${base}:${consumer.name}`
  if (consumer.count > 1) return `${base} ×${consumer.count}`
  return base
}

function consumersText(system: IntegrationHubSystem): string {
  if (system.consumers.length === 0) return bi('暂无', 'None')
  return system.consumers.map(consumerText).join('、')
}

/**
 * The 技术详情 disclosure carries the raw tokens VERBATIM — an operator quoting them into a bug
 * report must get exactly what the database holds, so nothing here is translated or prettified.
 */
function technicalRows(system: IntegrationHubSystem): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [
    { key: 'systemId', value: system.technical.systemId },
    { key: 'kind', value: system.technical.kind },
    { key: 'role', value: system.technical.role || '-' },
    { key: 'status', value: system.technical.status || '-' },
    { key: 'dataSourceId', value: system.technical.dataSourceId || '-' },
    { key: 'workspaceId', value: system.technical.workspaceId || '-' },
    { key: 'connectionModel', value: system.connection.model },
    { key: 'writes', value: system.writeCapability.writes },
  ]
  if (system.connection.unresolvedReason) {
    rows.push({ key: 'connectionUnresolvedReason', value: system.connection.unresolvedReason })
  }
  for (const consumer of system.consumers) {
    rows.push({ key: `consumer:${consumer.type}`, value: consumer.id || `×${consumer.count}` })
  }
  return rows
}

defineExpose({ refresh })
</script>

<style scoped>
.hub-overview__head-actions {
  display: flex;
  gap: 8px;
}

.hub-overview__error {
  margin: 0 0 12px;
  color: #b42318;
  font-size: 13px;
}

.hub-overview__cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}

.hub-overview__card {
  border: 1px solid var(--ms-border-color, #e4e7ed);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--ms-bg-color, #fff);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hub-overview__card-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.hub-overview__kind {
  font-size: 12px;
  color: var(--ms-text-color-secondary, #606266);
  background: var(--ms-fill-color-light, #f5f7fa);
  border-radius: 10px;
  padding: 1px 8px;
}

.hub-overview__status {
  margin-left: auto;
  font-size: 12px;
  color: var(--ms-text-color-secondary, #606266);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.hub-overview__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #909399;
  display: inline-block;
}

.hub-overview__dot[data-status='active'] { background: #67c23a; }
.hub-overview__dot[data-status='inactive'] { background: #909399; }
.hub-overview__dot[data-status='error'] { background: #f56c6c; }

.hub-overview__facts {
  margin: 0;
  display: grid;
  gap: 4px;
}

.hub-overview__fact {
  display: flex;
  gap: 8px;
  font-size: 13px;
}

.hub-overview__fact dt {
  flex: 0 0 68px;
  color: var(--ms-text-color-secondary, #606266);
}

.hub-overview__fact dd {
  margin: 0;
  flex: 1 1 auto;
  word-break: break-word;
}

.hub-overview__write[data-fenced='true'] {
  color: #b42318;
  font-weight: 600;
}

.hub-overview__fence {
  margin: 0;
  font-size: 12px;
  color: #b42318;
  background: #fef3f2;
  border-radius: 6px;
  padding: 6px 8px;
}

.hub-overview__technical {
  font-size: 12px;
  color: var(--ms-text-color-secondary, #606266);
}

.hub-overview__technical summary {
  cursor: pointer;
}

.hub-overview__technical dl {
  margin: 6px 0 0;
  display: grid;
  gap: 2px;
}

.hub-overview__technical-row {
  display: flex;
  gap: 8px;
}

.hub-overview__technical-row dt {
  flex: 0 0 168px;
  font-family: var(--ms-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.hub-overview__technical-row dd {
  margin: 0;
  word-break: break-all;
  font-family: var(--ms-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.hub-overview__card-foot {
  display: flex;
  gap: 8px;
}
</style>
