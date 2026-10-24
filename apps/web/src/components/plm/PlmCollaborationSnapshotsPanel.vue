<template>
  <section
    class="plm-collaboration-snapshots"
    data-testid="plm-collaboration-snapshots-panel"
    :data-busy="busy ? 'yes' : 'no'"
    :data-version-choice="versionChoice"
    :data-ruleset="rulesetText"
  >
    <button
      type="button"
      data-testid="plm-collaboration-snapshots-toggle"
      :aria-expanded="open"
      @click="toggle"
    >协作快照</button>
    <div v-if="open">
      <p v-if="refusal" data-testid="refusal">{{ refusal }}</p>
      <p v-if="pendingNotice" data-testid="pending">{{ pendingNotice }}</p>
      <p v-if="message" data-testid="error">{{ message }}</p>
      <button type="button" data-testid="mode-new" @click="chooseNew">新的快照</button>
      <button type="button" data-testid="mode-append" @click="chooseAppend">追加到已有快照</button>
      <button type="button" data-testid="kind-eco" @click="chooseKind('eco')">ECO</button>
      <button type="button" data-testid="kind-readiness" @click="chooseKind('readiness')">Readiness</button>
      <button v-if="hintValue" type="button" data-testid="hint-open" @click="openHint">打开当前表的快照</button>
      <label>数据源 <input data-testid="source" :value="sourceText" @change="onSource"></label>
      <label>物料 <input data-testid="item" :value="itemText" @change="onItem"></label>
      <label>版本 <input data-testid="version-input" :value="versionDraft" @input="onVersionDraft"></label>
      <button type="button" data-testid="version-none" @click="useNoVersion">没有当前版本</button>
      <button type="button" data-testid="version-use" @click="useVersion">使用这个版本</button>
      <button type="button" data-testid="base-list" @click="listBases">列出数据表库</button>
      <button
        v-for="base in bases"
        :key="base.id"
        type="button"
        data-testid="base-option"
        :data-base-id="base.id"
        @click="chooseBase(base.id)"
      >{{ base.name }}</button>
      <p v-if="baseId">已选数据表库 {{ baseId }}</p>
      <label>表名 <input data-testid="name" :value="nameText" :readonly="nameLocked" @change="onName"></label>
      <label v-if="kind === 'eco'">ECO <input data-testid="eco" :value="ecoText" @change="onEco"></label>
      <template v-if="kind === 'readiness'">
        <label>规则集 <input data-testid="ruleset-draft" :value="rulesetDraft" @input="onRulesetDraft"></label>
        <button type="button" data-testid="ruleset-commit" @click="commitRuleset(rulesetDraft)">使用这个规则集</button>
        <button
          v-for="option in rulesetOptions"
          :key="option"
          type="button"
          data-testid="ruleset-option"
          :data-ruleset-id="option"
          @click="commitRuleset(option)"
        >{{ option }}</button>
      </template>
      <label>已有快照 <input data-testid="binding-input" :value="bindingDraft" @input="onBindingDraft"></label>
      <button type="button" data-testid="binding-load" @click="loadBinding(bindingDraft)">打开这个快照</button>
      <button type="button" data-testid="preview" :disabled="!canPreview" @click="preview">预览</button>
      <p v-if="anchorText" data-testid="anchor">{{ anchorText }}</p>
      <p v-if="coverageText" data-testid="coverage">{{ coverageText }}</p>
      <p v-if="destinationText" data-testid="destination">{{ destinationText }}</p>
      <p v-for="entry in sourceEntries" :key="entry.key + entry.value" data-testid="source-text">{{ entry.key }} {{ entry.value }}</p>
      <button type="button" data-testid="confirm" :disabled="!canConfirm" @click="confirm">确认</button>
      <button v-if="retryReady" type="button" data-testid="retry" @click="confirm">重试</button>
      <button v-if="pending || block" type="button" data-testid="abandon" @click="abandon">放弃</button>
      <p v-if="showEmptyRow" data-testid="row-state">没有选中的行 不能刷新</p>
      <button type="button" data-testid="refresh" :disabled="!canRefreshNow" @click="refresh">刷新</button>
      <button type="button" data-testid="disable" :disabled="!canDisable" @click="disable">停用</button>
      <p>停用不会删除快照。</p>
      <button v-if="canOpenSheet" type="button" data-testid="open-sheet" @click="openLoaded">打开表</button>
    </div>
  </section>
</template>

<script lang="ts">
import { computed, defineComponent, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { useRouter } from 'vue-router'
import { AppRouteNames } from '../../router/types'
import type { MetaBase, MetaField, MetaRecord } from '../../multitable/types'
import {
  isManagedEntryActive,
  onAuthSessionSwitch,
  readAuthSessionSignature,
  readStoredToken,
  sha256Hex,
} from '../../composables/authPrincipal'
import { AuthIdentityLockError, withAuthIdentityLock } from '../../composables/authIdentityLock'
import { apiFetch } from '../../utils/api'
import { randomUuid } from '../../utils/uuid'

export const PLM_COLLABORATION_CONFIRM_STORAGE_KEY = 'metasheet_plm_collaboration_confirm_pending'
const BINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIGEST = /^[0-9a-f]{64}$/
const ECO_KEYS = ['id', 'name', 'eco_type', 'product_id', 'source_version_id', 'target_version_id', 'stage_id', 'state', 'kanban_state', 'priority', 'updated_at'] as const
const READINESS_KEYS = ['item_id', 'ruleset_id', 'generated_at', 'coverage_status', 'resources_count', 'ok_resources', 'error_count', 'warning_count', 'resources'] as const
const CONFLICT = '未解决的冲突。不会把这次确认当成成功，也不会自动换一个版本号。'
const UNKNOWN_CONFIRM = '结果未知。同一次确认仍保留，需要明确重试。'
const UNKNOWN_BLOCK = '结果未知。在明确放弃这条本地记录之前，不能提交新的写入。'
const LOCK_FAILED = '无法取得身份锁，因此没有提交。'
const STORAGE_FAILED = '无法记下这次确认，因此没有提交。'
const RECONCILE = '已有一次确认还没有结果。先把表单改回那一次的坐标，或明确放弃。'
const PENDING_READY = '有一次确认的结果未知。不会自动重试。'
const ABANDONED = '这次确认的服务器结果仍然未知。已放弃在本地重试。'

export function readPlmCollaborationSnapshotHint(value: unknown): { bindingId: string; sourceKind: 'eco' | 'readiness' } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || !keys.includes('bindingId') || !keys.includes('sourceKind')) return null
  if (typeof record.bindingId !== 'string' || !BINDING_ID.test(record.bindingId)) return null
  if (record.sourceKind !== 'eco' && record.sourceKind !== 'readiness') return null
  return { bindingId: record.bindingId, sourceKind: record.sourceKind }
}

type SourceKind = 'eco' | 'readiness'
type VersionChoice = 'unset' | 'none' | 'id'
type Mode = 'new' | 'append'
type Block = 'unreadable' | 'malformed' | 'identity' | null

interface Coordinates {
  dataSourceId: string
  sourceKind: SourceKind
  baseId: string
  itemId: string
  currentVersionId: string | null
  ecoId: string | null
  rulesetId: string | null
  targetBindingId: string | null
  name: string
  mode: Mode
}

interface ConfirmBody {
  previewId: string
  requestId: string
  expectedVersion: number
  targetBindingId?: string
}

interface PendingContext extends Coordinates {
  previewId: string
  expectedVersion: number
}

interface PendingRecord {
  digest: string
  context: PendingContext
  body: ConfirmBody
}

interface Anchor {
  dataSourceId: string
  tenantId: string
  orgId: string
  itemId: string
  currentVersionId: string | null
  ecoId?: string
  rulesetId?: string
}

interface SnapshotRow {
  recordId: string | null
  rowKey: string[] | null
  cells: Record<string, unknown>
}

interface LoadedSnapshot {
  id: string
  status: string
  version: number
  name: string
  baseId: string
  sheetId: string
  viewId: string
  sourceKind: SourceKind
  anchor: Anchor
  canRefresh: boolean
  row: SnapshotRow | null
}

interface PreviewView {
  previewId: string
  anchor: Anchor
  baseId: string
  name: string
  coverage: string | null
  cells: Record<string, unknown>
  kind: SourceKind
}

interface Published {
  bindingId: string
  sheetId: string
  viewId: string
  recordId: string | null
}

interface Stamp {
  signature: string
  generation: number
  serial: number
  parentSource: string
  parentItem: string
  hintKey: string
}

interface Envelope {
  ok: boolean
  status: number
  code: string
  data: unknown
}

function codePointLength(value: string): number {
  let count = 0
  for (let index = 0; index < value.length;) {
    count += 1
    index += (value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1
  }
  return count
}

function finiteText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value !== value.trim() || value.includes('\0')) return null
  if (codePointLength(value) > max) return null
  return value
}

function finiteId(value: unknown): string | null {
  return finiteText(value, 128)
}

function inputValue(event: Event): string {
  const target = event.target
  return target instanceof HTMLInputElement ? target.value : ''
}

function sameCoordinates(left: Coordinates | null, right: Coordinates | null): boolean {
  if (!left || !right) return false
  return left.dataSourceId === right.dataSourceId
    && left.sourceKind === right.sourceKind
    && left.baseId === right.baseId
    && left.itemId === right.itemId
    && left.currentVersionId === right.currentVersionId
    && left.ecoId === right.ecoId
    && left.rulesetId === right.rulesetId
    && left.targetBindingId === right.targetBindingId
    && left.name === right.name
    && left.mode === right.mode
}

function knownEntries(record: unknown, keys: readonly string[]): Array<{ key: string; value: string }> {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return []
  const source = record as Record<string, unknown>
  const entries: Array<{ key: string; value: string }> = []
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] == null) continue
    const value = source[key]
    entries.push({ key, value: typeof value === 'string' ? value : JSON.stringify(value) })
  }
  return entries
}

function loadedSourceEntries(
  cells: unknown,
  fields: readonly MetaField[],
  keys: readonly string[],
): Array<{ key: string; value: string }> {
  if (!cells || typeof cells !== 'object' || Array.isArray(cells)) return []
  const source = cells as Record<string, unknown>
  const allowed = new Set<string>(keys)
  const entries: Array<{ key: string; value: string }> = []
  for (const field of fields) {
    const name = finiteText(field?.name, 200)
    const id = finiteId(field?.id)
    if (!name || !id || !allowed.has(name)) continue
    if (!Object.prototype.hasOwnProperty.call(source, id) || source[id] == null) continue
    const value = source[id]
    entries.push({ key: name, value: typeof value === 'string' ? value : JSON.stringify(value) })
  }
  return entries
}

function parseAnchor(value: unknown, kind: SourceKind): Anchor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const dataSourceId = finiteId(row.dataSourceId)
  const tenantId = finiteId(row.tenantId)
  const orgId = finiteId(row.orgId)
  const itemId = finiteId(row.itemId)
  if (!dataSourceId || !tenantId || !orgId || !itemId) return null
  let currentVersionId: string | null
  if (row.currentVersionId === null) currentVersionId = null
  else {
    const version = finiteId(row.currentVersionId)
    if (!version) return null
    currentVersionId = version
  }
  const anchor: Anchor = { dataSourceId, tenantId, orgId, itemId, currentVersionId }
  if (kind === 'eco') {
    const ecoId = finiteId(row.ecoId)
    if (ecoId) anchor.ecoId = ecoId
  } else {
    const rulesetId = finiteId(row.rulesetId)
    if (rulesetId) anchor.rulesetId = rulesetId
  }
  return anchor
}

function parseRow(value: unknown): SnapshotRow | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const recordId = finiteText(row.recordId, 200)
  const rowKey = Array.isArray(row.rowKey) && row.rowKey.every((part) => typeof part === 'string')
    ? row.rowKey.slice()
    : null
  const cells = row.cells && typeof row.cells === 'object' && !Array.isArray(row.cells)
    ? row.cells as Record<string, unknown>
    : {}
  return { recordId, rowKey, cells }
}

function parseLoaded(value: unknown): LoadedSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !BINDING_ID.test(row.id)) return null
  if (row.sourceKind !== 'eco' && row.sourceKind !== 'readiness') return null
  const name = finiteText(row.name, 200)
  const baseId = finiteId(row.baseId)
  const sheetId = finiteText(row.sheetId, 200)
  const viewId = finiteText(row.viewId, 200)
  const anchor = parseAnchor(row.anchor, row.sourceKind)
  if (!name || !baseId || !sheetId || !viewId || !anchor) return null
  if (typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 0) return null
  return {
    id: row.id,
    status: typeof row.status === 'string' ? row.status : '',
    version: row.version,
    name,
    baseId,
    sheetId,
    viewId,
    sourceKind: row.sourceKind,
    anchor,
    canRefresh: row.canRefresh === true,
    row: parseRow(row.row),
  }
}

function parsePreview(value: unknown, kind: SourceKind): PreviewView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.previewId !== 'string' || !BINDING_ID.test(row.previewId)) return null
  const anchor = parseAnchor(row.anchor, kind)
  const baseId = finiteId(row.baseId)
  const name = finiteText(row.name, 200)
  if (!anchor || !baseId || !name) return null
  const cellsSource = kind === 'readiness' ? row.readiness : row.eco
  const cells = cellsSource && typeof cellsSource === 'object' && !Array.isArray(cellsSource)
    ? cellsSource as Record<string, unknown>
    : {}
  const coverage = typeof cells.coverage_status === 'string' ? cells.coverage_status : null
  return { previewId: row.previewId, anchor, baseId, name, coverage, cells, kind }
}

function parsePublished(value: unknown): Published | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const sheetId = finiteText(row.sheetId, 200)
  const viewId = finiteText(row.viewId, 200)
  const bindingId = typeof row.bindingId === 'string' && BINDING_ID.test(row.bindingId) ? row.bindingId : ''
  if (!sheetId || !viewId || !bindingId) return null
  return { bindingId, sheetId, viewId, recordId: finiteText(row.recordId, 200) }
}

function coordinatesOf(context: PendingContext): Coordinates {
  return {
    dataSourceId: context.dataSourceId,
    sourceKind: context.sourceKind,
    baseId: context.baseId,
    itemId: context.itemId,
    currentVersionId: context.currentVersionId,
    ecoId: context.ecoId,
    rulesetId: context.rulesetId,
    targetBindingId: context.targetBindingId,
    name: context.name,
    mode: context.mode,
  }
}

function parsePending(raw: string): PendingRecord | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 3 || !('digest' in record) || !('context' in record) || !('body' in record)) return null
  if (typeof record.digest !== 'string' || !DIGEST.test(record.digest)) return null
  const context = parsePendingContext(record.context)
  const body = parseConfirmBody(record.body)
  if (!context || !body) return null
  if (body.previewId !== context.previewId || body.expectedVersion !== context.expectedVersion) return null
  if (context.mode === 'new') {
    if (context.expectedVersion !== 0 || context.targetBindingId !== null || body.targetBindingId !== undefined) return null
  } else if (context.targetBindingId === null || body.targetBindingId !== context.targetBindingId) {
    return null
  }
  return { digest: record.digest, context, body }
}

function parsePendingContext(value: unknown): PendingContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const keys = Object.keys(row)
  const expected = ['dataSourceId', 'sourceKind', 'baseId', 'itemId', 'currentVersionId', 'ecoId', 'rulesetId', 'targetBindingId', 'name', 'mode', 'previewId', 'expectedVersion']
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) return null
  if (row.sourceKind !== 'eco' && row.sourceKind !== 'readiness') return null
  if (row.mode !== 'new' && row.mode !== 'append') return null
  const dataSourceId = finiteId(row.dataSourceId)
  const baseId = finiteId(row.baseId)
  const itemId = finiteId(row.itemId)
  const name = finiteText(row.name, 200)
  const previewId = typeof row.previewId === 'string' && BINDING_ID.test(row.previewId) ? row.previewId : ''
  if (!dataSourceId || !baseId || !itemId || !name || !previewId) return null
  if (typeof row.expectedVersion !== 'number' || !Number.isSafeInteger(row.expectedVersion) || row.expectedVersion < 0) return null
  let currentVersionId: string | null
  if (row.currentVersionId === null) currentVersionId = null
  else {
    const version = finiteId(row.currentVersionId)
    if (!version) return null
    currentVersionId = version
  }
  const ecoId = row.ecoId === null ? null : finiteId(row.ecoId)
  const rulesetId = row.rulesetId === null ? null : finiteId(row.rulesetId)
  const targetBindingId = row.targetBindingId === null ? null : (typeof row.targetBindingId === 'string' && BINDING_ID.test(row.targetBindingId) ? row.targetBindingId : null)
  if (row.ecoId !== null && !ecoId) return null
  if (row.rulesetId !== null && !rulesetId) return null
  if (row.targetBindingId !== null && !targetBindingId) return null
  if (row.sourceKind === 'eco' && (!ecoId || rulesetId)) return null
  if (row.sourceKind === 'readiness' && (!rulesetId || ecoId)) return null
  return {
    dataSourceId, sourceKind: row.sourceKind, baseId, itemId, currentVersionId, ecoId, rulesetId,
    targetBindingId, name, mode: row.mode, previewId, expectedVersion: row.expectedVersion,
  }
}

function parseConfirmBody(value: unknown): ConfirmBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const keys = Object.keys(row)
  if (keys.some((key) => !['previewId', 'requestId', 'expectedVersion', 'targetBindingId'].includes(key))) return null
  if (!keys.includes('previewId') || !keys.includes('requestId') || !keys.includes('expectedVersion')) return null
  if (typeof row.previewId !== 'string' || !BINDING_ID.test(row.previewId)) return null
  if (typeof row.requestId !== 'string' || !BINDING_ID.test(row.requestId)) return null
  if (typeof row.expectedVersion !== 'number' || !Number.isSafeInteger(row.expectedVersion) || row.expectedVersion < 0) return null
  const body: ConfirmBody = { previewId: row.previewId, requestId: row.requestId, expectedVersion: row.expectedVersion }
  if ('targetBindingId' in row) {
    if (typeof row.targetBindingId !== 'string' || !BINDING_ID.test(row.targetBindingId)) return null
    body.targetBindingId = row.targetBindingId
  }
  return body
}

async function readEnvelope(response: Response): Promise<Envelope> {
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  const error = record?.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : null
  const code = typeof error?.code === 'string' ? error.code : 'ECO_RUNTIME_UNAVAILABLE'
  return { ok: response.ok && record?.ok === true, status: response.status, code, data: record?.data }
}

export default defineComponent({
  name: 'PlmCollaborationSnapshotsPanel',
  props: {
    dataSourceId: { type: String, default: '' },
    itemId: { type: String, default: '' },
    hint: { type: Object as PropType<{ bindingId: string; sourceKind: 'eco' | 'readiness' } | null>, default: null },
    visibleRows: { type: Array as PropType<MetaRecord[]>, default: () => [] },
    visibleFields: { type: Array as PropType<MetaField[]>, default: () => [] },
    client: {
      type: Object as PropType<{ listBases: (opts?: { force?: boolean }) => Promise<{ bases: MetaBase[] }> } | null>,
      default: null,
    },
  },
  setup(props) {
    const router = useRouter()
    const open = ref(false)
    const busy = ref(false)
    const authEpoch = ref(0)
    const message = ref('')
    const kind = ref<SourceKind | ''>('')
    const mode = ref<Mode>('new')
    const sourceText = ref(props.dataSourceId)
    const itemText = ref(props.itemId)
    const versionChoice = ref<VersionChoice>('unset')
    const versionDraft = ref('')
    const versionId = ref('')
    const bases = ref<MetaBase[]>([])
    const baseId = ref('')
    const nameText = ref('')
    const ecoText = ref('')
    const rulesetDraft = ref('')
    const rulesetText = ref('')
    const bindingDraft = ref('')
    const bindingId = ref('')
    const previewState = ref<PreviewView | null>(null)
    const previewCoordinates = ref<Coordinates | null>(null)
    const loaded = ref<LoadedSnapshot | null>(null)
    const pending = ref<PendingRecord | null>(null)
    const block = ref<Block>(null)
    let generation = 0
    let requestSerial = 0
    let confirmBusy = false
    let mounted = true
    let sessionSignature = readAuthSessionSignature()

    function bump(): void {
      generation += 1
      previewState.value = null
      previewCoordinates.value = null
    }

    function parentSource(): string {
      return finiteId(props.dataSourceId) ?? ''
    }

    function parentItem(): string {
      return finiteId(props.itemId) ?? ''
    }

    /** A nonempty outer prop constrains the anchor. An absent prop does not invent a Source, Item, or version. */
    function outerAnchorAllowed(anchor: Anchor): boolean {
      const source = parentSource()
      const item = parentItem()
      if (source && anchor.dataSourceId !== source) return false
      if (item && anchor.itemId !== item) return false
      return true
    }

    function currentHintKey(): string {
      const hint = readPlmCollaborationSnapshotHint(props.hint)
      return hint ? `${hint.bindingId}:${hint.sourceKind}` : ''
    }

    function capture(): Stamp {
      requestSerial += 1
      busy.value = true
      return {
        signature: readAuthSessionSignature(),
        generation,
        serial: requestSerial,
        parentSource: parentSource(),
        parentItem: parentItem(),
        hintKey: currentHintKey(),
      }
    }

    function fresh(stamp: Stamp): boolean {
      return mounted
        && stamp.generation === generation
        && stamp.signature === readAuthSessionSignature()
        && stamp.parentSource === parentSource()
        && stamp.parentItem === parentItem()
        && stamp.hintKey === currentHintKey()
    }

    function finish(stamp: Stamp): void {
      if (stamp.serial === requestSerial) busy.value = false
    }

    const refusal = computed(() => {
      authEpoch.value
      if (isManagedEntryActive()) return '当前是托管入口。协作快照只使用普通 Meta 登录，不会改用托管 cookie。'
      if (!readStoredToken()) return '需要已保存的普通 Meta 登录。'
      return ''
    })
    const hintValue = computed(() => readPlmCollaborationSnapshotHint(props.hint))
    const nameLocked = computed(() => mode.value === 'append' && !!loaded.value)
    const rulesetOptions = computed(() => {
      const fieldIds = props.visibleFields.filter((field) => field.name === 'ruleset_id').map((field) => field.id)
      const seen = new Set<string>()
      const options: string[] = []
      for (const row of props.visibleRows) {
        for (const fieldId of fieldIds) {
          const value = finiteId(row?.data?.[fieldId])
          if (!value || seen.has(value)) continue
          seen.add(value)
          options.push(value)
        }
      }
      return options
    })

    function liveCoordinates(): Coordinates | null {
      if (kind.value !== 'eco' && kind.value !== 'readiness') return null
      const dataSourceId = finiteId(sourceText.value)
      const itemId = finiteId(itemText.value)
      const selectedBase = finiteId(baseId.value)
      const name = finiteText(nameText.value, 200)
      if (!dataSourceId || !itemId || !selectedBase || !name) return null
      if (versionChoice.value === 'unset') return null
      const currentVersionId = versionChoice.value === 'none' ? null : finiteId(versionId.value)
      if (versionChoice.value === 'id' && !currentVersionId) return null
      const ecoId = kind.value === 'eco' ? finiteId(ecoText.value) : null
      const rulesetId = kind.value === 'readiness' ? finiteId(rulesetText.value) : null
      if (kind.value === 'eco' && !ecoId) return null
      if (kind.value === 'readiness' && !rulesetId) return null
      const targetBindingId = mode.value === 'append' && BINDING_ID.test(bindingId.value) ? bindingId.value : null
      if (mode.value === 'append' && !targetBindingId) return null
      return {
        dataSourceId, sourceKind: kind.value, baseId: selectedBase, itemId, currentVersionId,
        ecoId, rulesetId, targetBindingId, name, mode: mode.value,
      }
    }

    function coordinatesMatch(record: PendingRecord | null): boolean {
      if (!record) return false
      return sameCoordinates(liveCoordinates(), coordinatesOf(record.context))
    }

    const retryReady = computed(() => !!pending.value && !block.value && coordinatesMatch(pending.value))
    const pendingNotice = computed(() => {
      if (block.value) return UNKNOWN_BLOCK
      if (!pending.value) return ''
      return coordinatesMatch(pending.value) ? PENDING_READY : RECONCILE
    })
    const canPreview = computed(() => !refusal.value && !block.value && !pending.value && !!liveCoordinates())
    const canConfirm = computed(() => {
      if (refusal.value || block.value) return false
      if (pending.value) return coordinatesMatch(pending.value)
      return !!previewState.value && sameCoordinates(liveCoordinates(), previewCoordinates.value)
    })
    function actionableLoaded(): LoadedSnapshot | null {
      const current = loaded.value
      if (!current) return null
      if (!outerAnchorAllowed(current.anchor)) return null
      if ((finiteId(sourceText.value) ?? '') !== current.anchor.dataSourceId) return null
      if ((finiteId(itemText.value) ?? '') !== current.anchor.itemId) return null
      if (!finiteId(current.baseId) || !finiteText(current.name, 200)) return null
      if (current.sourceKind !== 'eco' && current.sourceKind !== 'readiness') return null
      return current
    }

    const canRefreshNow = computed(() => {
      const current = actionableLoaded()
      const rowKey = current?.row?.rowKey
      return !refusal.value && !block.value && !pending.value
        && current?.canRefresh === true
        && Array.isArray(rowKey)
        && rowKey.length > 0
        && typeof current?.version === 'number'
        && current.version > 0
    })
    const canDisable = computed(() => {
      const current = actionableLoaded()
      return !refusal.value && !block.value && !pending.value && !!current && current.version > 0
    })
    const canOpenSheet = computed(() => {
      const current = actionableLoaded()
      return !!current?.sheetId && !!current?.viewId && !!current?.baseId
    })
    const showEmptyRow = computed(() => {
      const current = actionableLoaded()
      return !!current && current.row == null
    })
    const anchorText = computed(() => {
      const anchor = previewState.value?.anchor
      if (anchor) {
        const version = anchor.currentVersionId === null ? 'null' : anchor.currentVersionId
        return [anchor.dataSourceId, anchor.tenantId, anchor.orgId, anchor.itemId, version, anchor.ecoId ?? anchor.rulesetId ?? ''].join(' ')
      }
      if (!pending.value) return ''
      const context = pending.value.context
      const version = context.currentVersionId === null ? 'null' : context.currentVersionId
      return [context.dataSourceId, context.itemId, version, context.ecoId ?? context.rulesetId ?? ''].join(' ')
    })
    const coverageText = computed(() => previewState.value?.coverage ?? '')
    const destinationText = computed(() => {
      if (previewState.value && previewCoordinates.value) {
        const target = previewCoordinates.value.targetBindingId ?? ''
        return [previewState.value.baseId, previewState.value.name, previewCoordinates.value.mode, target].filter(Boolean).join(' ')
      }
      if (!pending.value) return ''
      const context = pending.value.context
      return [context.baseId, context.name, context.mode, context.targetBindingId ?? ''].filter(Boolean).join(' ')
    })
    const sourceEntries = computed(() => {
      const previewEntries = previewState.value
        ? knownEntries(previewState.value.cells, previewState.value.kind === 'readiness' ? READINESS_KEYS : ECO_KEYS)
        : []
      const loadedEntries = loaded.value
        ? loadedSourceEntries(
          loaded.value.row?.cells,
          props.visibleFields,
          loaded.value.sourceKind === 'readiness' ? READINESS_KEYS : ECO_KEYS,
        )
        : []
      return [...previewEntries, ...loadedEntries]
    })

    function toggle(): void {
      open.value = !open.value
    }

    function chooseKind(next: SourceKind): void {
      if (kind.value === next) return
      kind.value = next
      bump()
    }

    function chooseNew(): void {
      mode.value = 'new'
      loaded.value = null
      bindingId.value = ''
      versionChoice.value = 'unset'
      versionId.value = ''
      bump()
    }

    function chooseAppend(): void {
      if (mode.value === 'append') return
      mode.value = 'append'
      bump()
    }

    function commitText(current: { value: string }, next: string): void {
      if (current.value === next) return
      current.value = next
      bump()
    }

    function onSource(event: Event): void {
      commitText(sourceText, inputValue(event))
    }
    function onItem(event: Event): void {
      commitText(itemText, inputValue(event))
    }
    function onName(event: Event): void {
      if (nameLocked.value) return
      commitText(nameText, inputValue(event))
    }
    function onEco(event: Event): void {
      commitText(ecoText, inputValue(event))
    }
    function onVersionDraft(event: Event): void {
      versionDraft.value = inputValue(event)
    }
    function onRulesetDraft(event: Event): void {
      rulesetDraft.value = inputValue(event)
    }
    function onBindingDraft(event: Event): void {
      bindingDraft.value = inputValue(event)
    }
    function useNoVersion(): void {
      versionChoice.value = 'none'
      versionId.value = ''
      bump()
    }
    function useVersion(): void {
      const id = finiteId(versionDraft.value)
      if (!id) return
      versionChoice.value = 'id'
      versionId.value = id
      bump()
    }
    function chooseBase(id: string): void {
      const next = finiteId(id)
      if (!next || baseId.value === next) return
      baseId.value = next
      bump()
    }

    function ordinaryRefusal(): boolean {
      if (!refusal.value) return false
      message.value = refusal.value
      return true
    }

    function writesBlocked(): boolean {
      return !!block.value || !!pending.value
    }

    async function ensureStorageAllowsMutation(stamp: Stamp): Promise<boolean> {
      const slot = await inspectStorage(stamp.signature)
      if (!fresh(stamp)) return false
      if (slot.kind === 'empty') return !block.value && !pending.value
      if (slot.kind === 'pending') {
        pending.value = slot.record
        return false
      }
      pending.value = null
      block.value = slot.kind
      message.value = UNKNOWN_BLOCK
      return false
    }

    function readExactPendingRaw(): { ok: true; raw: string | null } | { ok: false } {
      try {
        return { ok: true, raw: sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY) }
      } catch {
        return { ok: false }
      }
    }

    async function postJson(path: string, body: unknown, stamp: Stamp): Promise<Envelope | null>
    async function postJson(path: string, body: unknown, stamp: Stamp, frozenRaw: string): Promise<Envelope | null | 'slot-changed'>
    async function postJson(path: string, body: unknown, stamp: Stamp, frozenRaw?: string): Promise<Envelope | null | 'slot-changed'> {
      return await withAuthIdentityLock(async () => {
        if (!fresh(stamp)) return null
        if (frozenRaw !== undefined) {
          const current = readExactPendingRaw()
          if (!current.ok || current.raw !== frozenRaw) return 'slot-changed'
        }
        const response = await apiFetch(path, {
          method: 'POST',
          body: JSON.stringify(body),
          suppressUnauthorizedRedirect: true,
        })
        const envelope = await readEnvelope(response)
        if (!fresh(stamp)) return null
        return envelope
      }, { failClosed: true })
    }

    async function preview(): Promise<void> {
      if (ordinaryRefusal() || writesBlocked() || !canPreview.value) return
      const coordinates = liveCoordinates()
      if (!coordinates) return
      const stamp = capture()
      const body: Record<string, unknown> = {
        sourceKind: coordinates.sourceKind,
        dataSourceId: coordinates.dataSourceId,
        baseId: coordinates.baseId,
        itemId: coordinates.itemId,
        currentVersionId: coordinates.currentVersionId,
        name: coordinates.name,
      }
      if (coordinates.sourceKind === 'eco') body.ecoId = coordinates.ecoId
      else body.rulesetId = coordinates.rulesetId
      try {
        if (!await ensureStorageAllowsMutation(stamp) || !fresh(stamp)) return
        const envelope = await postJson('/api/plm-collaboration-snapshots/preview', body, stamp)
        if (!envelope || !fresh(stamp)) return
        if (!envelope.ok) {
          message.value = envelope.status === 409 ? CONFLICT : envelope.code
          return
        }
        const parsed = parsePreview(envelope.data, coordinates.sourceKind)
        if (!parsed || !fresh(stamp)) {
          if (fresh(stamp)) message.value = 'ECO_REQUEST_INVALID'
          return
        }
        previewState.value = parsed
        previewCoordinates.value = coordinates
        message.value = ''
      } catch (error) {
        if (!fresh(stamp)) return
        message.value = error instanceof AuthIdentityLockError ? LOCK_FAILED : '结果未知。'
      } finally {
        finish(stamp)
      }
    }

    async function inspectStorage(signature: string): Promise<{ kind: 'empty' } | { kind: Exclude<Block, null> } | { kind: 'pending'; record: PendingRecord; raw: string }> {
      let raw: string | null
      try {
        raw = sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)
      } catch {
        return { kind: 'unreadable' }
      }
      if (!raw) return { kind: 'empty' }
      const parsed = parsePending(raw)
      if (!parsed) return { kind: 'malformed' }
      try {
        const digest = await sha256Hex(signature)
        if (digest !== parsed.digest) return { kind: 'identity' }
      } catch {
        return { kind: 'unreadable' }
      }
      return { kind: 'pending', record: parsed, raw }
    }

    function hydrate(context: PendingContext): void {
      kind.value = context.sourceKind
      mode.value = context.mode
      sourceText.value = context.dataSourceId
      itemText.value = context.itemId
      baseId.value = context.baseId
      nameText.value = context.name
      ecoText.value = context.ecoId ?? ''
      rulesetText.value = context.rulesetId ?? ''
      bindingId.value = context.targetBindingId ?? ''
      bindingDraft.value = context.targetBindingId ?? ''
      if (context.currentVersionId === null) {
        versionChoice.value = 'none'
        versionId.value = ''
      } else {
        versionChoice.value = 'id'
        versionId.value = context.currentVersionId
      }
    }

    function pendingFitsParent(record: PendingRecord, source: string, item: string): boolean {
      return record.context.dataSourceId === source && record.context.itemId === item
    }

    async function restorePending(): Promise<void> {
      if (confirmBusy || !mounted) return
      const signature = readAuthSessionSignature()
      const generationAtStart = generation
      const sourceAtStart = parentSource()
      const itemAtStart = parentItem()
      const hintAtStart = currentHintKey()
      const slot = await inspectStorage(signature)
      if (!mounted || confirmBusy) return
      if (signature !== readAuthSessionSignature() || generationAtStart !== generation) return
      if (parentSource() !== sourceAtStart || parentItem() !== itemAtStart || currentHintKey() !== hintAtStart) return
      if (slot.kind === 'empty') {
        pending.value = null
        block.value = null
        return
      }
      if (slot.kind === 'pending') {
        block.value = null
        pending.value = slot.record
        if (!pendingFitsParent(slot.record, sourceAtStart, itemAtStart)) {
          message.value = RECONCILE
          return
        }
        hydrate(slot.record.context)
        return
      }
      pending.value = null
      block.value = slot.kind
      message.value = UNKNOWN_BLOCK
    }

    async function buildPending(signature: string): Promise<PendingRecord | null> {
      const coordinates = liveCoordinates()
      const shown = previewState.value
      const shownCoordinates = previewCoordinates.value
      if (!coordinates || !shown || !sameCoordinates(coordinates, shownCoordinates)) return null
      const requestId = randomUuid()
      if (!BINDING_ID.test(requestId)) return null
      let expectedVersion = 0
      let targetBindingId: string | null = null
      const loadedVersion = loaded.value?.version
      if (coordinates.mode === 'append') {
        if (loadedVersion == null || !Number.isSafeInteger(loadedVersion) || loadedVersion <= 0 || !coordinates.targetBindingId) return null
        expectedVersion = loadedVersion
        targetBindingId = coordinates.targetBindingId
      }
      const body: ConfirmBody = { previewId: shown.previewId, requestId, expectedVersion }
      if (targetBindingId) body.targetBindingId = targetBindingId
      const context: PendingContext = { ...coordinates, previewId: shown.previewId, expectedVersion }
      const digest = await sha256Hex(signature)
      return { digest, context, body }
    }

    async function navigatePublished(published: Published, selectedBase: string): Promise<void> {
      const sheetId = finiteText(published.sheetId, 200)
      const viewId = finiteText(published.viewId, 200)
      const destinationBase = finiteId(selectedBase)
      if (!sheetId || !viewId || !destinationBase) return
      const query: Record<string, string> = { baseId: destinationBase }
      if (published.recordId) query.recordId = published.recordId
      try {
        await router.push({ name: AppRouteNames.MULTITABLE, params: { sheetId, viewId }, query })
      } catch {
        // The server acknowledgement stands when navigation itself fails.
      }
    }

    async function reread(id: string): Promise<void> {
      if (!BINDING_ID.test(id) || !mounted) return
      const stamp = capture()
      try {
        const response = await apiFetch(`/api/plm-collaboration-snapshots/${id}`, { suppressUnauthorizedRedirect: true })
        const envelope = await readEnvelope(response)
        if (!fresh(stamp) || !envelope.ok) return
        const parsed = parseLoaded(envelope.data)
        if (!parsed || !fresh(stamp)) return
        applyLoaded(parsed)
      } catch {
        // A failed reread does not undo an acknowledgement.
      } finally {
        finish(stamp)
      }
    }

    async function confirm(): Promise<void> {
      if (ordinaryRefusal() || confirmBusy) return
      confirmBusy = true
      const stamp = capture()
      try {
        const slot = await inspectStorage(stamp.signature)
        if (!fresh(stamp)) return
        if (slot.kind === 'unreadable' || slot.kind === 'malformed' || slot.kind === 'identity') {
          pending.value = null
          block.value = slot.kind
          message.value = UNKNOWN_BLOCK
          return
        }
        // Same-origin sessionStorage can change while this confirm is awaiting.
        // A newer unknown record with the same identity and context is preserved.
        // This operation does not replay, delete, or retarget it. This is not a
        // cross-process lock.
        const keepReplacement = async (): Promise<void> => {
          if (!fresh(stamp)) return
          const seen = readExactPendingRaw()
          if (!seen.ok) {
            pending.value = null
            block.value = 'unreadable'
            message.value = UNKNOWN_BLOCK
            return
          }
          if (seen.raw == null) {
            pending.value = null
            block.value = null
            return
          }
          const parsed = parsePending(seen.raw)
          if (!parsed) {
            pending.value = null
            block.value = 'malformed'
            message.value = UNKNOWN_BLOCK
            return
          }
          let digest: string
          try {
            digest = await sha256Hex(stamp.signature)
          } catch {
            if (!fresh(stamp)) return
            pending.value = null
            block.value = 'unreadable'
            message.value = UNKNOWN_BLOCK
            return
          }
          if (!fresh(stamp)) return
          const latest = readExactPendingRaw()
          if (!latest.ok) {
            pending.value = null
            block.value = 'unreadable'
            message.value = UNKNOWN_BLOCK
            return
          }
          const raw = latest.raw
          const current = raw == null ? null : (raw === seen.raw ? parsed : parsePending(raw))
          if (raw == null) {
            pending.value = null
            block.value = null
            return
          }
          if (!current) {
            pending.value = null
            block.value = 'malformed'
            message.value = UNKNOWN_BLOCK
            return
          }
          if (current.digest !== digest) {
            pending.value = null
            block.value = 'identity'
            message.value = UNKNOWN_BLOCK
            return
          }
          block.value = null
          pending.value = current
          message.value = coordinatesMatch(current) ? PENDING_READY : RECONCILE
        }
        let record = slot.kind === 'pending' ? slot.record : null
        let frozenRaw = slot.kind === 'pending' ? slot.raw : null
        if (record && frozenRaw != null) {
          const current = readExactPendingRaw()
          if (!current.ok || current.raw !== frozenRaw) {
            await keepReplacement()
            return
          }
          if (!coordinatesMatch(record)) {
            pending.value = record
            message.value = RECONCILE
            return
          }
        }
        if (!record) {
          if (block.value || pending.value) return
          const built = await buildPending(stamp.signature)
          if (!fresh(stamp)) return
          if (!built) {
            message.value = '还有必填项没有明确选择。'
            return
          }
          if (!fresh(stamp)) return
          const openSlot = readExactPendingRaw()
          if (!openSlot.ok) {
            message.value = STORAGE_FAILED
            return
          }
          if (openSlot.raw !== null) {
            await keepReplacement()
            return
          }
          const serialized = JSON.stringify(built)
          try {
            sessionStorage.setItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY, serialized)
          } catch {
            message.value = STORAGE_FAILED
            return
          }
          const written = readExactPendingRaw()
          if (!written.ok || written.raw !== serialized) {
            await keepReplacement()
            return
          }
          if (!fresh(stamp)) return
          record = built
          frozenRaw = serialized
          pending.value = built
        }
        if (!fresh(stamp) || frozenRaw == null || !record) return
        const envelope = await postJson('/api/plm-collaboration-snapshots/confirm', record.body, stamp, frozenRaw)
        if (envelope === 'slot-changed') {
          await keepReplacement()
          return
        }
        if (!envelope || !fresh(stamp)) return
        if (envelope.status === 409) {
          message.value = CONFLICT
          return
        }
        if (!envelope.ok) {
          message.value = envelope.code
          return
        }
        const published = parsePublished(envelope.data)
        if (!published || !fresh(stamp)) {
          if (fresh(stamp)) message.value = UNKNOWN_CONFIRM
          return
        }
        const acknowledged = readExactPendingRaw()
        if (!acknowledged.ok || acknowledged.raw !== frozenRaw) {
          await keepReplacement()
          return
        }
        try {
          sessionStorage.removeItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)
          pending.value = null
          block.value = null
        } catch {
          message.value = '确认已完成，但本地记录没有清掉。在放弃这条本地记录之前，不会开始新的写入。'
        }
        if (!message.value) message.value = ''
        await navigatePublished(published, record.context.baseId)
        void reread(published.bindingId)
      } catch (error) {
        if (!fresh(stamp)) return
        message.value = error instanceof AuthIdentityLockError ? LOCK_FAILED : UNKNOWN_CONFIRM
      } finally {
        const identityChanged = stamp.signature !== readAuthSessionSignature()
        finish(stamp)
        confirmBusy = false
        if (identityChanged && mounted) void restorePending()
      }
    }

    function abandon(): void {
      try {
        sessionStorage.removeItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)
      } catch {
        message.value = '本地记录没有清掉，因此不能开始新的写入。'
        return
      }
      pending.value = null
      block.value = null
      message.value = ABANDONED
    }

    function applyLoaded(snapshot: LoadedSnapshot): boolean {
      if (!outerAnchorAllowed(snapshot.anchor)) return false
      loaded.value = snapshot
      kind.value = snapshot.sourceKind
      sourceText.value = snapshot.anchor.dataSourceId
      itemText.value = snapshot.anchor.itemId
      baseId.value = snapshot.baseId
      nameText.value = snapshot.name
      mode.value = 'append'
      bindingId.value = snapshot.id
      if (snapshot.anchor.currentVersionId === null) {
        versionChoice.value = 'none'
        versionId.value = ''
      } else {
        versionChoice.value = 'id'
        versionId.value = snapshot.anchor.currentVersionId
      }
      return true
    }

    async function loadBinding(id: string): Promise<void> {
      if (ordinaryRefusal() || writesBlocked()) return
      if (!BINDING_ID.test(id)) return
      bindingDraft.value = id
      bindingId.value = ''
      loaded.value = null
      mode.value = 'append'
      bump()
      const stamp = capture()
      try {
        const response = await apiFetch(`/api/plm-collaboration-snapshots/${id}`, { suppressUnauthorizedRedirect: true })
        const envelope = await readEnvelope(response)
        if (!fresh(stamp)) return
        if (!envelope.ok) {
          message.value = envelope.code
          return
        }
        const parsed = parseLoaded(envelope.data)
        if (!parsed || !fresh(stamp) || !applyLoaded(parsed)) {
          if (fresh(stamp)) message.value = 'ECO_REQUEST_INVALID'
          return
        }
        message.value = ''
      } catch (error) {
        if (!fresh(stamp)) return
        message.value = error instanceof AuthIdentityLockError ? LOCK_FAILED : '结果未知。'
      } finally {
        finish(stamp)
      }
    }

    async function openHint(): Promise<void> {
      const hint = hintValue.value
      if (!hint) return
      await loadBinding(hint.bindingId)
    }

    async function commitRuleset(value: string): Promise<void> {
      const next = finiteId(value)
      if (!next || rulesetText.value === next) return
      rulesetText.value = next
      bump()
      const current = actionableLoaded()
      if (!current || current.sourceKind !== 'readiness') return
      loaded.value = { ...current, row: null, canRefresh: false }
      const anchor = current.anchor
      if (!finiteId(anchor.dataSourceId) || !finiteId(anchor.tenantId) || !finiteId(anchor.orgId) || !finiteId(anchor.itemId)) return
      const key = [anchor.dataSourceId, anchor.tenantId, anchor.orgId, anchor.itemId, next]
      const params = new URLSearchParams()
      params.set('rowKey', JSON.stringify(key))
      const stamp = capture()
      try {
        const response = await apiFetch(`/api/plm-collaboration-snapshots/${current.id}?${params.toString()}`, {
          suppressUnauthorizedRedirect: true,
        })
        const envelope = await readEnvelope(response)
        if (!fresh(stamp) || !envelope.ok) return
        const parsed = parseLoaded(envelope.data)
        if (!parsed || !fresh(stamp) || !applyLoaded(parsed)) return
        rulesetText.value = next
      } catch {
        if (!fresh(stamp)) return
      } finally {
        finish(stamp)
      }
    }

    async function listBases(): Promise<void> {
      if (ordinaryRefusal()) return
      const stamp = capture()
      try {
        const client = props.client ?? new (await import('../../multitable/api/client')).MultitableApiClient()
        const data = await client.listBases({ force: true })
        if (!fresh(stamp)) return
        bases.value = Array.isArray(data?.bases)
          ? data.bases.filter((base) => !!finiteId(base?.id) && typeof base?.name === 'string')
          : []
      } catch (error) {
        if (!fresh(stamp)) return
        message.value = error instanceof AuthIdentityLockError ? LOCK_FAILED : '结果未知。'
      } finally {
        finish(stamp)
      }
    }

    async function refresh(): Promise<void> {
      const current = actionableLoaded()
      const rowKey = current?.row?.rowKey
      if (ordinaryRefusal() || writesBlocked() || !current || !canRefreshNow.value || !Array.isArray(rowKey) || rowKey.length === 0) return
      const frozen = {
        id: current.id,
        version: current.version,
        baseId: current.baseId,
        rowKey: rowKey.slice(),
      }
      const stamp = capture()
      try {
        if (!await ensureStorageAllowsMutation(stamp) || !fresh(stamp)) return
        const still = actionableLoaded()
        if (!still || still.id !== frozen.id || still.version !== frozen.version) return
        const envelope = await postJson(
          `/api/plm-collaboration-snapshots/${frozen.id}/refresh`,
          { expectedVersion: frozen.version, rowKey: frozen.rowKey },
          stamp,
        )
        if (!envelope || !fresh(stamp)) return
        if (envelope.status === 409) {
          message.value = CONFLICT
          return
        }
        if (!envelope.ok) {
          message.value = envelope.code
          return
        }
        const published = parsePublished(envelope.data)
        if (!published || !fresh(stamp)) return
        message.value = ''
        await navigatePublished(published, frozen.baseId)
      } catch (error) {
        if (!fresh(stamp)) return
        message.value = error instanceof AuthIdentityLockError ? LOCK_FAILED : '结果未知。'
      } finally {
        finish(stamp)
      }
    }

    async function disable(): Promise<void> {
      const current = actionableLoaded()
      if (ordinaryRefusal() || writesBlocked() || !current || !canDisable.value) return
      const frozen = { id: current.id, version: current.version }
      const stamp = capture()
      try {
        if (!await ensureStorageAllowsMutation(stamp) || !fresh(stamp)) return
        const still = actionableLoaded()
        if (!still || still.id !== frozen.id || still.version !== frozen.version) return
        const envelope = await postJson(
          `/api/plm-collaboration-snapshots/${frozen.id}/disable`,
          { expectedVersion: frozen.version },
          stamp,
        )
        if (!envelope || !fresh(stamp)) return
        if (envelope.status === 409) {
          message.value = CONFLICT
          return
        }
        if (!envelope.ok) {
          message.value = envelope.code
          return
        }
        if (fresh(stamp) && loaded.value?.id === frozen.id) {
          loaded.value = { ...loaded.value, status: 'disabled', canRefresh: false }
          message.value = ''
        }
      } catch (error) {
        if (!fresh(stamp)) return
        message.value = error instanceof AuthIdentityLockError ? LOCK_FAILED : '结果未知。'
      } finally {
        finish(stamp)
      }
    }

    async function openLoaded(): Promise<void> {
      const current = actionableLoaded()
      if (!current) return
      await navigatePublished({
        bindingId: current.id,
        sheetId: current.sheetId,
        viewId: current.viewId,
        recordId: current.row?.recordId ?? null,
      }, current.baseId)
    }

    function onSession(): void {
      const next = readAuthSessionSignature()
      if (next === sessionSignature) return
      sessionSignature = next
      authEpoch.value += 1
      bump()
      loaded.value = null
      pending.value = null
      block.value = null
      bases.value = []
      message.value = ''
      void restorePending()
    }

    function onStorage(): void {
      const next = readAuthSessionSignature()
      if (next !== sessionSignature) {
        onSession()
        return
      }
      void restorePending()
    }

    watch(() => props.dataSourceId, (next, previous) => {
      if (next === previous) return
      sourceText.value = next
      loaded.value = null
      bump()
    })
    watch(() => props.itemId, (next, previous) => {
      if (next === previous) return
      itemText.value = next
      loaded.value = null
      bump()
    })
    watch(currentHintKey, (next, previous) => {
      if (next === previous) return
      loaded.value = null
      bump()
    })

    const unsubscribe = onAuthSessionSwitch(onSession)
    onMounted(() => {
      window.addEventListener('storage', onStorage)
      void restorePending()
    })
    onBeforeUnmount(() => {
      mounted = false
      bump()
      unsubscribe()
      window.removeEventListener('storage', onStorage)
    })

    return {
      open, busy, message, refusal, pendingNotice, kind, mode, sourceText, itemText, versionChoice, versionDraft,
      bases, baseId, nameText, nameLocked, ecoText, rulesetDraft, rulesetText, rulesetOptions, bindingDraft,
      hintValue, canPreview, canConfirm, canRefreshNow, canDisable, canOpenSheet, showEmptyRow, retryReady,
      pending, block, anchorText, coverageText, destinationText, sourceEntries, toggle, chooseKind, chooseNew,
      chooseAppend, onSource, onItem, onName, onEco, onVersionDraft, onRulesetDraft, onBindingDraft, useNoVersion,
      useVersion, chooseBase, listBases, preview, confirm, abandon, openHint, loadBinding, commitRuleset, refresh,
      disable, openLoaded,
    }
  },
})
</script>

<style scoped>
.plm-collaboration-snapshots { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
</style>
