<template>
  <el-dialog
    :model-value="visible"
    class="approval-version-workspace-dialog"
    width="min(1480px, calc(100vw - 32px))"
    title="版本与恢复"
    destroy-on-close
    data-testid="approval-version-workspace"
    @update:model-value="emit('update:visible', $event)"
    @closed="closeRestorePreview"
  >
    <div class="approval-version-workspace">
      <aside class="approval-version-workspace__timeline" aria-label="版本时间线">
        <div class="approval-version-workspace__current" data-testid="approval-version-current-draft">
          <strong>当前编辑草稿</strong>
          <span>{{ currentDirty ? '含未保存更改' : '已保存' }}</span>
        </div>
        <el-alert
          v-if="historyError"
          :title="historyError"
          type="warning"
          :closable="false"
          show-icon
        />
        <div v-if="loadingHistory" class="approval-version-workspace__loading">正在加载版本…</div>
        <button
          v-for="summary in history"
          v-else
          :key="summary.id"
          type="button"
          class="approval-version-workspace__version"
          :class="{ 'is-selected': selectedVersionId === summary.id }"
          :aria-pressed="selectedVersionId === summary.id"
          :data-testid="`approval-version-timeline-${summary.version}`"
          @click="selectVersion(summary)"
        >
          <span class="approval-version-workspace__version-heading">
            <strong>v{{ summary.version }}</strong>
            <el-tag size="small" :type="versionTagType(summary.status)">
              {{ versionStatusLabel(summary.status) }}
            </el-tag>
          </span>
          <span>{{ formatDate(summary.updatedAt) }}</span>
          <small>{{ summary.publishNote?.trim() || '未填写发布说明' }}</small>
          <small v-if="summary.restoredFromVersionId">
            由 {{ restoredSourceLabel(summary.restoredFromVersionId) }} 恢复
          </small>
        </button>
        <el-empty v-if="!loadingHistory && !historyError && history.length === 0" description="暂无版本记录" :image-size="52" />
      </aside>

      <main class="approval-version-workspace__main">
        <template v-if="selectedVersion && versionDiff">
          <div class="approval-version-workspace__topbar">
            <div>
              <h3>v{{ selectedVersion.version }} 与当前草稿</h3>
              <p>两张画布使用同一布局算法和同步缩放，可联动滚动；窄屏下纵向排列。</p>
            </div>
            <div class="approval-version-workspace__zoom" aria-label="同步缩放">
              <el-button :icon="ZoomOut" aria-label="同时缩小两个版本画布" @click="changeZoom(-0.1)" />
              <el-button aria-label="重置两个版本画布缩放" @click="zoom = 1">
                {{ Math.round(zoom * 100) }}%
              </el-button>
              <el-button :icon="ZoomIn" aria-label="同时放大两个版本画布" @click="changeZoom(0.1)" />
            </div>
          </div>

          <div class="approval-version-workspace__summary" aria-label="版本变化摘要">
            <span>字段 {{ versionDiff.fieldChanges }}</span>
            <span>节点 {{ versionDiff.nodeChanges }}</span>
            <span>连线 {{ versionDiff.edgeChanges }}</span>
            <strong>共 {{ versionDiff.totalChanges }} 项</strong>
          </div>

          <div class="approval-version-workspace__graphs">
            <ApprovalVersionGraphSnapshot
              ref="historicalGraphRef"
              :title="`历史版本 v${selectedVersion.version}`"
              marker-id="approval-version-history-arrow"
              :graph="selectedVersion.approvalGraph"
              :zoom="zoom"
              :node-changes="historicalNodeChanges"
              :edge-changes="historicalEdgeChanges"
              :selected-node-key="selectedNodeKey"
              @select-node="selectNode"
              @scroll="syncGraphScroll('historical', $event)"
            />
            <ApprovalVersionGraphSnapshot
              ref="currentGraphRef"
              title="当前编辑草稿"
              marker-id="approval-version-current-arrow"
              :graph="currentGraph"
              :zoom="zoom"
              :node-changes="currentNodeChanges"
              :edge-changes="currentEdgeChanges"
              :selected-node-key="selectedNodeKey"
              @select-node="selectNode"
              @scroll="syncGraphScroll('current', $event)"
            />
          </div>

          <div class="approval-version-workspace__details">
            <section class="approval-version-workspace__changes" aria-label="可读变化列表">
              <h4>变化列表</h4>
              <el-empty v-if="versionDiff.totalChanges === 0" description="与当前草稿无结构变化" :image-size="48" />
              <button
                v-for="change in versionDiff.changes"
                v-else
                :key="`${change.entity}-${change.key}-${change.kind}`"
                type="button"
                class="approval-version-workspace__change"
                :class="{ 'is-selected': selectedChangeKey === changeKey(change) }"
                @click="selectChange(change)"
              >
                <el-tag size="small" :type="changeTagType(change.kind)">{{ changeKindLabel(change.kind) }}</el-tag>
                <span>{{ changeEntityLabel(change.entity) }}</span>
                <strong>{{ change.label }}</strong>
              </button>
            </section>
            <section class="approval-version-workspace__inspector" aria-label="变化前后检查器">
              <h4>变化前后</h4>
              <template v-if="selectedEntity">
                <div>
                  <strong>历史版本</strong>
                  <p v-for="line in selectedEntity.before" :key="line">{{ line }}</p>
                </div>
                <div>
                  <strong>当前草稿</strong>
                  <p v-for="line in selectedEntity.after" :key="line">{{ line }}</p>
                </div>
              </template>
              <el-empty v-else description="选择变化或流程节点查看详情" :image-size="48" />
            </section>
          </div>
        </template>

        <div v-else-if="loadingVersion" class="approval-version-workspace__loading">正在加载版本内容…</div>
        <el-alert v-else-if="versionError" :title="versionError" type="warning" :closable="false" show-icon />
        <el-empty v-else description="从左侧选择一个历史版本" />
      </main>
    </div>

    <template #footer>
      <span class="approval-version-workspace__restore-note">恢复只会创建新草稿，不改变已发布版本和运行中的审批。</span>
      <el-button @click="emit('update:visible', false)">关闭</el-button>
      <el-button
        type="warning"
        :disabled="!canRestoreSelectedVersion"
        data-testid="approval-version-open-restore-preview"
        @click="openRestorePreview"
      >
        恢复所选版本
      </el-button>
    </template>
  </el-dialog>

  <el-dialog
    :model-value="restorePreviewVisible"
    width="520px"
    title="确认恢复为新草稿"
    append-to-body
    data-testid="approval-version-restore-preview"
    @update:model-value="restorePreviewVisible = $event"
  >
    <p v-if="selectedVersion">将 v{{ selectedVersion.version }} 的表单和流程复制为一个新的草稿版本。</p>
    <ul class="approval-version-workspace__restore-list">
      <li>当前已发布版本保持不变</li>
      <li>运行中的审批继续使用原先固定的流程版本</li>
      <li v-if="currentDirty">当前未保存更改会被新草稿替换</li>
    </ul>
    <el-alert
      v-if="!effectiveLatestVersionId"
      title="无法确认当前最新版本，恢复已暂停"
      type="warning"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="restoreConflictMessage"
      :title="restoreConflictMessage"
      type="warning"
      :closable="false"
      show-icon
    />
    <el-checkbox v-model="restoreAcknowledged" data-testid="approval-version-restore-acknowledge">
      我已了解恢复会创建新草稿
    </el-checkbox>
    <template #footer>
      <el-button @click="closeRestorePreview">取消</el-button>
      <el-button
        type="warning"
        :loading="restoring"
        :disabled="!restoreAcknowledged || !effectiveLatestVersionId"
        data-testid="approval-version-restore-confirm"
        @click="confirmRestore"
      >
        恢复为新草稿
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import {
  ApprovalApiError,
  getTemplate,
  getTemplateVersion,
  listTemplateVersions,
  restoreTemplateVersion,
} from '../api'
import {
  approvalEdgeDisplayLabel,
  approvalFieldDisplayLabel,
  approvalNodeDisplayLabel,
  approvalNodeTypeLabel,
} from '../approvalVersionPresentation'
import { describeTemplateAuthoringError } from '../templateAuthoringErrors'
import {
  diffApprovalTemplateVersions,
  type TemplateVersionChange,
  type TemplateVersionChangeEntity,
  type TemplateVersionChangeKind,
} from '../templateVersionDiff'
import type {
  ApprovalEdge,
  ApprovalGraph,
  ApprovalNode,
  ApprovalTemplateStatus,
  ApprovalTemplateVersionDetailDTO,
  ApprovalTemplateVersionSummaryDTO,
  FormField,
  FormSchema,
} from '../../types/approval'
import ApprovalVersionGraphSnapshot from './ApprovalVersionGraphSnapshot.vue'

type GraphSnapshotExpose = { setScroll(left: number, top: number): void }
type SelectedEntity = { before: string[]; after: string[] }

const props = defineProps<{
  visible: boolean
  templateId: string
  latestVersionId: string | null
  currentFormSchema: FormSchema
  currentGraph: ApprovalGraph
  currentDirty: boolean
}>()

const emit = defineEmits<{
  (event: 'update:visible', visible: boolean): void
  (event: 'restored', version: ApprovalTemplateVersionDetailDTO): void
}>()

const history = ref<ApprovalTemplateVersionSummaryDTO[]>([])
const historyError = ref('')
const versionError = ref('')
const loadingHistory = ref(false)
const loadingVersion = ref(false)
const selectedVersionId = ref<string | null>(null)
const selectedVersion = ref<ApprovalTemplateVersionDetailDTO | null>(null)
const selectedChangeKey = ref<string | null>(null)
const selectedNodeKey = ref<string | null>(null)
const zoom = ref(1)
const restorePreviewVisible = ref(false)
const restoreAcknowledged = ref(false)
const restoring = ref(false)
const effectiveLatestVersionId = ref<string | null>(props.latestVersionId)
const restoreConflictMessage = ref('')
const versionCache = new Map<string, ApprovalTemplateVersionDetailDTO>()
const historicalGraphRef = ref<GraphSnapshotExpose | null>(null)
const currentGraphRef = ref<GraphSnapshotExpose | null>(null)
let historyLoadSequence = 0
let versionLoadSequence = 0

const versionDiff = computed(() => selectedVersion.value
  ? diffApprovalTemplateVersions(
      { formSchema: selectedVersion.value.formSchema, approvalGraph: selectedVersion.value.approvalGraph },
      { formSchema: props.currentFormSchema, approvalGraph: props.currentGraph },
    )
  : null)
const historicalNodeChanges = computed(() => changeMap('node', ['removed', 'changed']))
const currentNodeChanges = computed(() => changeMap('node', ['added', 'changed']))
const historicalEdgeChanges = computed(() => changeMap('edge', ['removed', 'changed']))
const currentEdgeChanges = computed(() => changeMap('edge', ['added', 'changed']))
const selectedEntity = computed<SelectedEntity | null>(() => describeSelectedEntity())
const canRestoreSelectedVersion = computed(() => Boolean(
  selectedVersion.value
  && effectiveLatestVersionId.value
  && selectedVersion.value.id !== effectiveLatestVersionId.value
  && !restoring.value,
))

watch(
  () => [props.visible, props.templateId] as const,
  ([visible]) => {
    if (visible) void loadHistory()
    else resetWorkspace()
  },
  { immediate: true },
)

watch(
  () => props.latestVersionId,
  (latestVersionId) => { effectiveLatestVersionId.value = latestVersionId },
)

watch(
  () => versionDiff.value?.changes.map(changeKey).join('|') ?? '',
  () => {
    const first = versionDiff.value?.changes[0]
    if (first) selectChange(first)
    else {
      selectedChangeKey.value = null
      selectedNodeKey.value = null
    }
  },
)

function resetWorkspace(): void {
  historyLoadSequence += 1
  versionLoadSequence += 1
  history.value = []
  historyError.value = ''
  versionError.value = ''
  selectedVersionId.value = null
  selectedVersion.value = null
  selectedChangeKey.value = null
  selectedNodeKey.value = null
  zoom.value = 1
  effectiveLatestVersionId.value = props.latestVersionId
  restoreConflictMessage.value = ''
  closeRestorePreview()
}

async function loadHistory(): Promise<void> {
  const sequence = ++historyLoadSequence
  loadingHistory.value = true
  historyError.value = ''
  versionError.value = ''
  try {
    const versions = await listTemplateVersions(props.templateId)
    if (sequence !== historyLoadSequence) return
    history.value = versions
    const preferred = versions.find((version) => version.id === selectedVersionId.value) ?? versions[0]
    if (preferred) await selectVersion(preferred)
  } catch (error: unknown) {
    if (sequence === historyLoadSequence) {
      historyError.value = describeTemplateAuthoringError(error, '版本历史加载失败')
    }
  } finally {
    if (sequence === historyLoadSequence) loadingHistory.value = false
  }
}

async function selectVersion(summary: ApprovalTemplateVersionSummaryDTO): Promise<void> {
  const sequence = ++versionLoadSequence
  selectedVersionId.value = summary.id
  selectedVersion.value = null
  versionError.value = ''
  loadingVersion.value = true
  try {
    const cached = versionCache.get(summary.id)
    const detail = cached ?? await getTemplateVersion(props.templateId, summary.id)
    if (sequence !== versionLoadSequence || selectedVersionId.value !== summary.id) return
    versionCache.set(summary.id, detail)
    selectedVersion.value = detail
  } catch (error: unknown) {
    if (sequence === versionLoadSequence) {
      versionError.value = describeTemplateAuthoringError(error, '版本内容加载失败')
    }
  } finally {
    if (sequence === versionLoadSequence) loadingVersion.value = false
  }
}

function changeMap(
  entity: TemplateVersionChangeEntity,
  allowed: TemplateVersionChangeKind[],
): Partial<Record<string, TemplateVersionChangeKind>> {
  return Object.fromEntries(
    (versionDiff.value?.changes ?? [])
      .filter((change) => change.entity === entity && allowed.includes(change.kind))
      .map((change) => [change.key, change.kind]),
  )
}

function selectChange(change: TemplateVersionChange): void {
  selectedChangeKey.value = changeKey(change)
  selectedNodeKey.value = change.entity === 'node' ? change.key : null
}

function selectNode(nodeKey: string): void {
  selectedNodeKey.value = nodeKey
  const nodeChange = versionDiff.value?.changes.find(
    (change) => change.entity === 'node' && change.key === nodeKey,
  )
  selectedChangeKey.value = nodeChange ? changeKey(nodeChange) : null
}

function changeKey(change: TemplateVersionChange): string {
  return `${change.entity}:${change.key}:${change.kind}`
}

function findField(schema: FormSchema, fieldId: string): FormField | undefined {
  return schema.fields.find((field) => field.id === fieldId)
}

function findNode(graph: ApprovalGraph, nodeKey: string): ApprovalNode | undefined {
  return graph.nodes.find((node) => node.key === nodeKey)
}

function findEdge(graph: ApprovalGraph, edgeKey: string): ApprovalEdge | undefined {
  return graph.edges.find((edge) => edge.key === edgeKey)
}

function describeField(field: FormField | undefined, schema: FormSchema): string[] {
  if (!field) return ['不存在']
  return [
    approvalFieldDisplayLabel(field),
    `类型：${fieldTypeLabel(field.type)}`,
    `必填：${field.required ? '是' : '否'}`,
    `位置：第 ${schema.fields.findIndex((candidate) => candidate.id === field.id) + 1} 项`,
  ]
}

function describeNode(node: ApprovalNode | undefined): string[] {
  if (!node) return ['不存在']
  return [approvalNodeDisplayLabel(node), `类型：${approvalNodeTypeLabel(node.type)}`]
}

function describeEdge(edge: ApprovalEdge | undefined, graph: ApprovalGraph): string[] {
  return edge ? [approvalEdgeDisplayLabel(edge, graph)] : ['不存在']
}

function describeSelectedEntity(): SelectedEntity | null {
  const historical = selectedVersion.value
  if (!historical) return null
  const selectedChange = versionDiff.value?.changes.find(
    (change) => changeKey(change) === selectedChangeKey.value,
  )
  if (selectedChange?.entity === 'field') {
    return {
      before: describeField(findField(historical.formSchema, selectedChange.key), historical.formSchema),
      after: describeField(findField(props.currentFormSchema, selectedChange.key), props.currentFormSchema),
    }
  }
  const nodeKey = selectedNodeKey.value ?? (selectedChange?.entity === 'node' ? selectedChange.key : null)
  if (nodeKey) {
    return {
      before: describeNode(findNode(historical.approvalGraph, nodeKey)),
      after: describeNode(findNode(props.currentGraph, nodeKey)),
    }
  }
  if (selectedChange?.entity === 'edge') {
    return {
      before: describeEdge(findEdge(historical.approvalGraph, selectedChange.key), historical.approvalGraph),
      after: describeEdge(findEdge(props.currentGraph, selectedChange.key), props.currentGraph),
    }
  }
  return null
}

function syncGraphScroll(
  source: 'historical' | 'current',
  position: { left: number; top: number },
): void {
  const target = source === 'historical' ? currentGraphRef.value : historicalGraphRef.value
  target?.setScroll(position.left, position.top)
}

function changeZoom(delta: number): void {
  zoom.value = Math.min(1.5, Math.max(0.5, Number((zoom.value + delta).toFixed(1))))
}

function openRestorePreview(): void {
  if (!canRestoreSelectedVersion.value) return
  restoreAcknowledged.value = false
  restoreConflictMessage.value = ''
  restorePreviewVisible.value = true
}

function closeRestorePreview(): void {
  restorePreviewVisible.value = false
  restoreAcknowledged.value = false
}

async function confirmRestore(): Promise<void> {
  const version = selectedVersion.value
  const latestVersionId = effectiveLatestVersionId.value
  if (!version || !latestVersionId || !restoreAcknowledged.value || restoring.value) return
  restoring.value = true
  try {
    const restored = await restoreTemplateVersion(props.templateId, version.id, {
      expectedLatestVersionId: latestVersionId,
    })
    ElMessage.success(`已从 v${version.version} 创建新草稿`)
    emit('restored', restored)
    closeRestorePreview()
    emit('update:visible', false)
  } catch (error: unknown) {
    if (error instanceof ApprovalApiError && error.code === 'APPROVAL_TEMPLATE_VERSION_STALE') {
      restoreAcknowledged.value = false
      try {
        const currentTemplate = await getTemplate(props.templateId)
        effectiveLatestVersionId.value = currentTemplate.latestVersionId
        await loadHistory()
        restoreConflictMessage.value = '版本已由其他人更新，列表已刷新。请重新核对后再次确认。'
        ElMessage.warning(restoreConflictMessage.value)
      } catch {
        restoreConflictMessage.value = '版本已更新，请刷新页面后重试。'
        ElMessage.warning(restoreConflictMessage.value)
      }
      return
    }
    ElMessage.error(describeTemplateAuthoringError(error, '恢复版本失败'))
  } finally {
    restoring.value = false
  }
}

function restoredSourceLabel(versionId: string): string {
  const source = history.value.find((version) => version.id === versionId)
  return source ? `v${source.version}` : '历史版本'
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '时间不可用'
    : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function versionStatusLabel(status: ApprovalTemplateStatus): string {
  return ({ draft: '草稿', published: '已发布', archived: '已停用' } as const)[status]
}

function versionTagType(status: ApprovalTemplateStatus): 'primary' | 'info' | 'warning' {
  if (status === 'published') return 'primary'
  if (status === 'archived') return 'warning'
  return 'info'
}

function changeKindLabel(kind: TemplateVersionChangeKind): string {
  return ({ added: '新增', removed: '删除', changed: '修改', moved: '移动' } as const)[kind]
}

function changeEntityLabel(entity: TemplateVersionChangeEntity): string {
  return ({ field: '字段', node: '节点', edge: '连线' } as const)[entity]
}

function changeTagType(kind: TemplateVersionChangeKind): 'success' | 'danger' | 'warning' | 'info' {
  if (kind === 'added') return 'success'
  if (kind === 'removed') return 'danger'
  if (kind === 'moved') return 'info'
  return 'warning'
}

function fieldTypeLabel(type: FormField['type']): string {
  return ({
    text: '单行文本',
    textarea: '多行文本',
    number: '数字',
    date: '日期',
    datetime: '日期时间',
    select: '单选',
    multiselect: '多选',
    user: '人员',
    department: '部门',
    attachment: '附件',
    'record-link': '记录关联',
  } as Partial<Record<FormField['type'], string>>)[type] ?? '表单字段'
}
</script>

<style scoped>
.approval-version-workspace {
  display: grid;
  grid-template-columns: minmax(220px, 260px) minmax(0, 1fr);
  gap: 16px;
  min-height: 620px;
}
.approval-version-workspace__timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  max-height: 72vh;
  overflow: auto;
  padding-right: 4px;
  border-right: 1px solid var(--el-border-color-lighter);
}
.approval-version-workspace__current,
.approval-version-workspace__version {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
  text-align: left;
}
.approval-version-workspace__current {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}
.approval-version-workspace__current span,
.approval-version-workspace__version span,
.approval-version-workspace__version small,
.approval-version-workspace__topbar p {
  color: var(--el-text-color-secondary);
}
.approval-version-workspace__version {
  width: 100%;
  cursor: pointer;
}
.approval-version-workspace__version:hover,
.approval-version-workspace__version:focus-visible,
.approval-version-workspace__version.is-selected {
  border-color: var(--el-color-primary);
  outline: none;
}
.approval-version-workspace__version-heading,
.approval-version-workspace__topbar,
.approval-version-workspace__summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.approval-version-workspace__main {
  min-width: 0;
}
.approval-version-workspace__topbar h3,
.approval-version-workspace__topbar p,
.approval-version-workspace__changes h4,
.approval-version-workspace__inspector h4 {
  margin: 0;
}
.approval-version-workspace__zoom {
  display: flex;
  flex: 0 0 auto;
}
.approval-version-workspace__summary {
  justify-content: flex-start;
  flex-wrap: wrap;
  margin: 14px 0;
}
.approval-version-workspace__summary span,
.approval-version-workspace__summary strong {
  padding: 5px 9px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
}
.approval-version-workspace__graphs,
.approval-version-workspace__details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.approval-version-workspace__details {
  margin-top: 14px;
}
.approval-version-workspace__changes,
.approval-version-workspace__inspector {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
}
.approval-version-workspace__changes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 260px;
  overflow: auto;
}
.approval-version-workspace__change {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--el-text-color-primary);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.approval-version-workspace__change:hover,
.approval-version-workspace__change:focus-visible,
.approval-version-workspace__change.is-selected {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
  outline: none;
}
.approval-version-workspace__inspector > div {
  margin-top: 10px;
  padding: 10px;
  border-left: 3px solid var(--el-border-color);
  background: var(--el-fill-color-lighter);
}
.approval-version-workspace__inspector p {
  margin: 4px 0 0;
}
.approval-version-workspace__loading {
  display: grid;
  min-height: 180px;
  place-items: center;
  color: var(--el-text-color-secondary);
}
.approval-version-workspace__restore-note {
  margin-right: 12px;
  color: var(--el-text-color-secondary);
}
.approval-version-workspace__restore-list {
  padding-left: 20px;
  line-height: 1.8;
}
@media (max-width: 900px) {
  :global(.approval-version-workspace-dialog.el-dialog) {
    display: flex;
    flex-direction: column;
    width: 100% !important;
    height: 100dvh;
    margin: 0 !important;
    border-radius: 0;
  }
  :global(.approval-version-workspace-dialog .el-dialog__body) {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 12px;
  }
  :global(.approval-version-workspace-dialog .el-dialog__footer) {
    flex: 0 0 auto;
    padding: 10px 12px;
    border-top: 1px solid var(--el-border-color-lighter);
  }
  :global(.approval-version-workspace-dialog .el-dialog__headerbtn) {
    width: 44px;
    height: 44px;
  }
  .approval-version-workspace {
    grid-template-columns: 1fr;
    min-height: 0;
  }
  .approval-version-workspace__timeline {
    flex-direction: row;
    max-height: none;
    overflow-x: auto;
    padding: 0 0 8px;
    border-right: 0;
    border-bottom: 1px solid var(--el-border-color-lighter);
  }
  .approval-version-workspace__current,
  .approval-version-workspace__version {
    flex: 0 0 min(240px, calc(100vw - 48px));
  }
  .approval-version-workspace__version > span,
  .approval-version-workspace__version > small {
    overflow-wrap: anywhere;
    white-space: normal;
  }
  .approval-version-workspace__graphs,
  .approval-version-workspace__details {
    grid-template-columns: 1fr;
  }
  .approval-version-workspace__topbar {
    align-items: flex-start;
    flex-direction: column;
  }
  .approval-version-workspace__restore-note {
    display: block;
    margin: 0 0 8px;
    text-align: left;
  }
}

@media (max-width: 560px) {
  .approval-version-workspace__timeline {
    flex-direction: column;
    overflow-x: visible;
  }
  .approval-version-workspace__current,
  .approval-version-workspace__version {
    flex: 0 0 auto;
    width: 100%;
  }
}
</style>
