<template>
  <section id="int-sec-bridge-agent" class="integration-workbench__panel" data-testid="bridge-agent-section">
    <el-card shadow="never">
      <template #header>
        <div class="integration-workbench__panel-head">
          <div>
            <h2>{{ bi('Bridge Agent 观测', 'Bridge Agent Observability') }}</h2>
            <p>{{ bi(
              '只读可观测：查看已注册 Bridge Agent 实例的连通状态、暴露对象与 schema 形状。本区没有写入路径、没有本机 config 编辑入口，也不会触发计划任务的启停。',
              'Read-only observability: check the reachability, exposed objects, and schema shape of registered Bridge Agent instances. This section has no write path, no local-config editing, and never starts or stops a scheduled task.',
            ) }}</p>
          </div>
          <button
            v-if="bridgeSystems.length > 0"
            type="button"
            class="integration-workbench__button"
            data-testid="bridge-agent-check-all"
            :disabled="checkingAll"
            @click="checkAll"
          >
            <el-icon><Refresh /></el-icon>
            {{ checkingAll ? bi('检查中…', 'Checking…') : bi('全部检查', 'Check all') }}
          </button>
        </div>
      </template>

      <div v-if="bridgeSystems.length === 0" class="integration-workbench__empty" data-testid="bridge-agent-empty-state">
        <strong data-testid="bridge-agent-empty-what">{{ bi(
          '这里展示已注册的 Bridge Agent 实例（kind = bridge:legacy-sql-readonly）的在线状态、暴露对象与 schema 预览。',
          'This shows the online status, exposed objects, and schema preview of registered Bridge Agent instances (kind = bridge:legacy-sql-readonly).',
        ) }}</strong>
        <p data-testid="bridge-agent-empty-first-step">{{ bi(
          '第一步：在上方“连接管理”区新增一个连接，类型选择只读 Bridge Agent；本机 Agent 通常由实施人员按 runbook 部署后再在此注册。',
          'First step: add a connection in the “Connections” area above and choose the read-only Bridge Agent type — the local agent is usually deployed per the runbook by an implementer before it is registered here.',
        ) }}</p>
      </div>

      <template v-else>
        <div class="bridge-agent__cards" data-testid="bridge-agent-cards">
          <div
            v-for="system in bridgeSystems"
            :key="system.id"
            class="bridge-agent__card"
            :data-testid="`bridge-agent-card-${system.id}`"
          >
            <div class="bridge-agent__card-head">
              <el-icon class="bridge-agent__card-icon"><Connection /></el-icon>
              <strong :data-testid="`bridge-agent-card-name-${system.id}`">{{ system.name }}</strong>
              <span class="bridge-agent__badge bridge-agent__badge--readonly" :data-testid="`bridge-agent-card-readonly-${system.id}`">
                <el-icon><Lock /></el-icon>{{ bi('只读', 'Read-only') }}
              </span>
            </div>
            <div class="bridge-agent__card-body">
              <span
                class="bridge-agent__badge"
                :class="statusBadgeClass(system.id)"
                :data-status="statusDataAttr(system.id)"
                :data-testid="`bridge-agent-card-status-${system.id}`"
              >{{ statusLabel(system.id) }}</span>
              <span class="bridge-agent__meta" :data-testid="`bridge-agent-card-checked-at-${system.id}`">
                {{ bi('最近检查：', 'Last checked: ') }}{{ formatCheckedAt(system.id) }}
              </span>
            </div>
            <p v-if="statusErrorLabel(system.id)" class="bridge-agent__error" :data-testid="`bridge-agent-card-error-${system.id}`">
              {{ statusErrorLabel(system.id) }}
            </p>
            <button
              type="button"
              class="integration-workbench__button"
              :data-testid="`bridge-agent-card-check-${system.id}`"
              :disabled="isChecking(system.id)"
              @click="checkSystem(system)"
            >
              <el-icon><Refresh /></el-icon>
              {{ isChecking(system.id) ? bi('检查中…', 'Checking…') : bi('检查连接', 'Check connection') }}
            </button>
            <button
              type="button"
              class="integration-workbench__button"
              :data-testid="`bridge-agent-probe-${system.id}`"
              :disabled="isProbing(system.id)"
              @click="runProbe(system)"
            >
              <el-icon><Refresh /></el-icon>
              {{ isProbing(system.id) ? bi('探测中…', 'Probing…') : bi('一键探测', 'One-click probe') }}
            </button>

            <div
              v-if="probeResultFor(system.id)"
              class="bridge-agent__probe-evidence"
              :data-testid="`bridge-agent-probe-evidence-${system.id}`"
            >
              <h4>{{ bi('探测证据（values-free）', 'Probe evidence (values-free)') }}</h4>
              <p
                class="bridge-agent__probe-overall"
                :data-result="probeResultFor(system.id)!.overallPass ? 'pass' : 'fail'"
                :data-testid="`bridge-agent-probe-overall-${system.id}`"
              >{{ overallLabel(probeResultFor(system.id)!) }}</p>
              <ul>
                <li
                  v-for="step in probeResultFor(system.id)!.steps"
                  :key="step.step"
                  :data-testid="`bridge-agent-probe-step-${step.step}-${system.id}`"
                  :data-ok="step.ok ? 'true' : 'false'"
                >
                  <strong>{{ probeStepLabel(step.step) }}</strong>
                  <span> — ok: {{ step.ok ? 'true' : 'false' }}</span>
                  <span v-if="step.durationBucket"> · durationBucket: {{ step.durationBucket }}</span>
                  <span v-if="step.objectCount !== undefined"> · objectCount: {{ step.objectCount }}</span>
                  <span v-if="step.fieldCount !== undefined"> · fieldCount: {{ step.fieldCount }}</span>
                  <span v-if="step.skipped" :data-testid="`bridge-agent-probe-step-skipped-${system.id}`">
                    · {{ bi('未采样对象（对象列表为空）', 'no object sampled (empty object list)') }}
                  </span>
                  <template v-if="!step.ok">
                    <p
                      class="bridge-agent__error"
                      :data-testid="`bridge-agent-probe-step-error-${step.step}-${system.id}`"
                    >{{ probeStepErrorLabel(step) }}</p>
                    <p
                      class="bridge-agent__probe-guidance"
                      :data-testid="`bridge-agent-probe-step-guidance-${step.step}-${system.id}`"
                    >{{ probeStepGuidance(step.step, step.code) }}</p>
                  </template>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div class="bridge-agent__instances">
          <h3>{{ bi('实例列表', 'Instances') }}</h3>
          <table class="bridge-agent__table" data-testid="bridge-agent-instance-list">
            <thead>
              <tr>
                <th>{{ bi('名称', 'Name') }}</th>
                <th>
                  <el-tooltip :content="fieldHint('bridgeAgent.instancePicker')" placement="top">
                    <span>{{ bi('用途', 'Role') }}</span>
                  </el-tooltip>
                </th>
                <th>{{ bi('状态', 'Status') }}</th>
                <th>
                  <el-tooltip :content="fieldHint('bridgeAgent.credentialStatus')" placement="top">
                    <span>{{ bi('凭据', 'Credentials') }}</span>
                  </el-tooltip>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="system in bridgeSystems" :key="system.id" :data-testid="`bridge-agent-instance-row-${system.id}`">
                <td :data-testid="`bridge-agent-instance-name-${system.id}`">{{ system.name }}</td>
                <td>{{ roleLabel(system) }}</td>
                <td :data-testid="`bridge-agent-instance-status-${system.id}`">{{ coarseStatusLabel(system) }}</td>
                <td :data-testid="`bridge-agent-instance-credential-${system.id}`">{{ credentialLabel(system) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="bridge-agent__objects">
          <div class="bridge-agent__objects-head">
            <h3>{{ bi('对象列表', 'Objects') }}</h3>
            <label class="bridge-agent__instance-picker">
              <span>{{ bi('实例', 'Instance') }}</span>
              <select v-model="selectedSystemId" data-testid="bridge-agent-instance-picker">
                <option v-for="system in bridgeSystems" :key="system.id" :value="system.id">{{ system.name }}</option>
              </select>
            </label>
            <button
              type="button"
              class="integration-workbench__button"
              data-testid="bridge-agent-objects-refresh"
              :disabled="objectsLoading"
              @click="loadObjects"
            >
              <el-icon><Refresh /></el-icon>
              {{ objectsLoading ? bi('加载中…', 'Loading…') : bi('刷新对象列表', 'Reload objects') }}
            </button>
          </div>

          <p v-if="objectsErrored" class="bridge-agent__error" data-testid="bridge-agent-objects-error">
            {{ bi('对象列表加载失败，请检查连接状态后重试。', 'Failed to load the object list; check the connection status and retry.') }}
          </p>

          <div v-if="objectsLoading" class="integration-workbench__hint" data-testid="bridge-agent-objects-loading">
            {{ bi('加载中…', 'Loading…') }}
          </div>

          <div
            v-else-if="objectsLoaded && objects.length === 0 && !objectsErrored"
            class="integration-workbench__empty"
            data-testid="bridge-agent-objects-empty"
          >
            <strong data-testid="bridge-agent-objects-empty-what">{{ bi(
              '该实例当前没有可读对象（本机 allowlist 为空）。',
              'This instance currently has no readable objects (the local allowlist is empty).',
            ) }}</strong>
            <p data-testid="bridge-agent-objects-empty-first-step">{{ bi(
              '第一步：在本机 Bridge Agent 配置中为该 endpoint 添加至少一个 allowlist 对象，再点击“刷新对象列表”。',
              'First step: add at least one allowlisted object to this endpoint in the local Bridge Agent config, then click “Reload objects”.',
            ) }}</p>
          </div>

          <table v-else-if="objects.length > 0" class="bridge-agent__table" data-testid="bridge-agent-objects-list">
            <thead>
              <tr>
                <th>{{ bi('对象', 'Object') }}</th>
                <th>Label</th>
                <th>
                  <el-tooltip :content="fieldHint('bridgeAgent.objectAllowlist')" placement="top">
                    <span>{{ bi('字段数', 'Fields') }}</span>
                  </el-tooltip>
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="object in objects" :key="object.name">
                <tr :data-testid="`bridge-agent-object-row-${object.name}`">
                  <td>{{ object.name }}</td>
                  <td>{{ object.label || object.name }}</td>
                  <td :data-testid="`bridge-agent-object-field-count-${object.name}`">{{ formatFieldCount(object) }}</td>
                  <td>
                    <button
                      type="button"
                      class="integration-workbench__link-button"
                      :data-testid="`bridge-agent-object-schema-toggle-${object.name}`"
                      @click="toggleSchema(object.name)"
                    >{{ expandedObject === object.name ? bi('收起 schema', 'Hide schema') : bi('查看 schema', 'View schema') }}</button>
                  </td>
                </tr>
                <tr v-if="expandedObject === object.name" :data-testid="`bridge-agent-schema-row-${object.name}`">
                  <td colspan="4">
                    <div
                      v-if="schemaLoading[object.name]"
                      class="integration-workbench__hint"
                      :data-testid="`bridge-agent-schema-loading-${object.name}`"
                    >{{ bi('Schema 加载中…', 'Loading schema…') }}</div>
                    <p
                      v-else-if="schemaErrored[object.name]"
                      class="bridge-agent__error"
                      :data-testid="`bridge-agent-schema-error-${object.name}`"
                    >{{ bi('Schema 加载失败，请重试。', 'Failed to load the schema; retry.') }}</p>
                    <table
                      v-else-if="schemaByObject[object.name]"
                      class="bridge-agent__table"
                      :data-testid="`bridge-agent-schema-${object.name}`"
                    >
                      <thead>
                        <tr>
                          <th>{{ bi('字段', 'Field') }}</th>
                          <th>{{ bi('类型', 'Type') }}</th>
                          <th>
                            <el-tooltip :content="fieldHint('bridgeAgent.schemaPreview')" placement="top">
                              <span>{{ bi('必填', 'Required') }}</span>
                            </el-tooltip>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="field in schemaByObject[object.name]"
                          :key="field.name"
                          :data-testid="`bridge-agent-schema-field-${object.name}-${field.name}`"
                        >
                          <td>{{ field.name }}</td>
                          <td>{{ field.type || bi('未提供', 'N/A') }}</td>
                          <td>{{ field.required ? bi('是', 'Yes') : bi('否', 'No') }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </template>
    </el-card>
  </section>
</template>

<script setup lang="ts">
// BA-UI-1 (docs/development/bridge-agent-admin-page-design-lock-20260707.md): Bridge Agent read-only
// observability section. Self-contained (same shape as IntegrationReadSourceConfigPanel.vue) — the
// parent view hands down the already-fetched `systems` list + `scope`; this component owns its own
// local state/service calls for the three READ-ONLY generic routes it consumes: POST
// /external-systems/:id/test, GET /external-systems/:id/objects, GET /external-systems/:id/schema.
// ZERO new backend routes (see the BA-UI-1 verification MD's scout findings) and ZERO write path —
// this file never references an upsert/delete/pipeline/dead-letter/staging service function, and
// `POST /query/:object` (the data-plane read) is never called here either (design-lock §4).
//
// Security bounds (lock §2.1, binding):
//   - No credential/host/connection-string/config is ever rendered — only the coarse
//     `system.hasCredentials` boolean ("已配置/未配置"), never `system.config`/`system.credentials`.
//   - No raw error text is ever rendered. Every failure surface routes through the IU-1
//     `integrationErrorCodeDisplayLabel` helper (label-only). Unlike the closed, backend-owned code
//     families IU-1 already labels, a Bridge Agent HTTP error body can carry an operator-supplied
//     `error.code` (see errorCodeLabels.ts's BRIDGE_AGENT_* comment) — so even the registered CODE
//     STRING itself is never interpolated into the DOM here, only its mapped display label (an
//     unregistered/dynamic code safely degrades to the generic "unknown error" label). Object/schema
//     load failures carry no code at all (the shared `parseIntegrationResponse` helper does not
//     preserve one), so those use a fixed, values-free bilingual string.
import { computed, reactive, ref, watch } from 'vue'
import { Connection, Lock, Refresh } from '@element-plus/icons-vue'
import { useLocale } from '../../composables/useLocale'
import { integrationErrorCodeDisplayLabel, integrationErrorCodeHint } from '../../services/integration/errorCodeLabels'
import { integrationFieldHint, type IntegrationFieldHintKey } from '../../services/integration/fieldHints'
import {
  getExternalSystemSchema,
  listExternalSystemObjects,
  testExternalSystemConnection,
  type IntegrationObjectSchemaField,
  type IntegrationScope,
  type IntegrationSystemObject,
  type WorkbenchExternalSystem,
} from '../../services/integration/workbench'

// The one external-system kind this section observes — mirrors
// plugins/plugin-integration-core/index.cjs's `.registerAdapter('bridge:legacy-sql-readonly', ...)`.
const BRIDGE_AGENT_KIND = 'bridge:legacy-sql-readonly'

const props = defineProps<{
  systems: WorkbenchExternalSystem[]
  scope: IntegrationScope
}>()

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}
function fieldHint(key: IntegrationFieldHintKey): string {
  return integrationFieldHint(key, locale.value)
}

const bridgeSystems = computed(() => props.systems.filter((system) => system.kind === BRIDGE_AGENT_KIND))

// --- Agent status cards (testConnection) -------------------------------------------------------

interface CheckState {
  checking: boolean
  hasChecked: boolean
  ok: boolean
  code: string | null
  checkedAt: string | null
}

// Read-only default for render-time lookups: the template helpers below must NEVER create/mutate
// reactive entries during render (that would schedule a redundant re-render pass); only
// checkSystem writes into checkStates.
const UNCHECKED_STATE: Readonly<CheckState> = Object.freeze({
  checking: false,
  hasChecked: false,
  ok: false,
  code: null,
  checkedAt: null,
})

const checkStates = reactive<Record<string, CheckState>>({})
const checkingAll = ref(false)

function stateFor(systemId: string): Readonly<CheckState> {
  return checkStates[systemId] || UNCHECKED_STATE
}

function isChecking(systemId: string): boolean {
  return stateFor(systemId).checking
}

async function checkSystem(system: WorkbenchExternalSystem): Promise<void> {
  checkStates[system.id] = { ...stateFor(system.id), checking: true }
  let ok = false
  let code: string | null = null
  try {
    const result = await testExternalSystemConnection(system.id, props.scope)
    ok = result.ok === true
    code = typeof result.code === 'string' ? result.code : null
  } catch {
    ok = false
    code = null
  }
  checkStates[system.id] = {
    checking: false,
    hasChecked: true,
    ok,
    code,
    // Client-side "most recent check" timestamp — the platform's clock, not a value read off the wire.
    checkedAt: new Date().toISOString(),
  }
}

async function checkAll(): Promise<void> {
  checkingAll.value = true
  try {
    for (const system of bridgeSystems.value) {
      // Sequential, one instance at a time: a gentle probe cadence rather than a concurrent burst
      // against what is typically a single localhost Bridge Agent process per instance.
      // eslint-disable-next-line no-await-in-loop
      await checkSystem(system)
    }
  } finally {
    checkingAll.value = false
  }
}

function statusLabel(systemId: string): string {
  const state = stateFor(systemId)
  if (state.checking) return bi('检查中…', 'Checking…')
  if (!state.hasChecked) return bi('尚未检查', 'Not checked yet')
  return state.ok ? bi('在线', 'Online') : bi('离线', 'Offline')
}

function statusDataAttr(systemId: string): 'unknown' | 'online' | 'offline' {
  const state = stateFor(systemId)
  if (!state.hasChecked) return 'unknown'
  return state.ok ? 'online' : 'offline'
}

function statusBadgeClass(systemId: string): string {
  const attr = statusDataAttr(systemId)
  if (attr === 'online') return 'bridge-agent__badge--online'
  if (attr === 'offline') return 'bridge-agent__badge--offline'
  return ''
}

// Label-only — see the script-block security-bounds note: neither the raw code nor the raw message
// is ever interpolated into the template, only this mapped, closed-vocabulary display string.
function statusErrorLabel(systemId: string): string | null {
  const state = stateFor(systemId)
  if (!state.hasChecked || state.ok) return null
  return integrationErrorCodeDisplayLabel(state.code, locale.value)
}

function formatCheckedAt(systemId: string): string {
  const iso = stateFor(systemId).checkedAt
  if (!iso) return bi('从未', 'Never')
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US')
}

// --- Instance list (values-free: name / role / coarse status / credential boolean only) --------

function roleLabel(system: WorkbenchExternalSystem): string {
  if (system.role === 'target') return bi('目标', 'Target')
  if (system.role === 'bidirectional') return bi('双向', 'Bidirectional')
  return bi('数据源', 'Source')
}

function coarseStatusLabel(system: WorkbenchExternalSystem): string {
  if (system.status === 'active') return bi('启用', 'Active')
  if (system.status === 'inactive') return bi('停用', 'Inactive')
  return bi('异常', 'Error')
}

// Lock §2.1: "凭据状态最多'已配置/未配置'布尔" — never anything more specific than this boolean
// (never system.config, never system.credentials, never system.lastError).
function credentialLabel(system: WorkbenchExternalSystem): string {
  return system.hasCredentials ? bi('已配置', 'Configured') : bi('未配置', 'Not configured')
}

// --- Selected instance -> objects ---------------------------------------------------------------

const selectedSystemId = ref('')

const objects = ref<IntegrationSystemObject[]>([])
const objectsLoading = ref(false)
const objectsLoaded = ref(false)
const objectsErrored = ref(false)

async function loadObjects(): Promise<void> {
  const systemId = selectedSystemId.value
  if (!systemId) {
    objects.value = []
    objectsLoaded.value = false
    return
  }
  objectsLoading.value = true
  objectsErrored.value = false
  try {
    objects.value = await listExternalSystemObjects(systemId, props.scope)
  } catch {
    // Fixed, values-free copy only — never the thrown error's message (see security-bounds note).
    objects.value = []
    objectsErrored.value = true
  } finally {
    objectsLoading.value = false
    objectsLoaded.value = true
  }
}

// keyField is not currently part of the /objects wire shape (see the BA-UI-1 verification MD's
// backend-scout finding) — render fieldCount when present, an explicit N/A otherwise, never a guess.
function formatFieldCount(object: IntegrationSystemObject): string {
  return typeof object.fieldCount === 'number' ? String(object.fieldCount) : bi('未提供', 'N/A')
}

// --- Per-object schema preview (fetched on demand, cached per object name) ----------------------

const expandedObject = ref('')
const schemaLoading = reactive<Record<string, boolean>>({})
const schemaErrored = ref<Record<string, boolean>>({})
const schemaByObject = ref<Record<string, IntegrationObjectSchemaField[]>>({})

async function toggleSchema(objectName: string): Promise<void> {
  if (expandedObject.value === objectName) {
    expandedObject.value = ''
    return
  }
  expandedObject.value = objectName
  if (schemaByObject.value[objectName] || !selectedSystemId.value) return
  schemaLoading[objectName] = true
  schemaErrored.value = { ...schemaErrored.value, [objectName]: false }
  try {
    const schema = await getExternalSystemSchema(selectedSystemId.value, { ...props.scope, object: objectName })
    // Explicit field mapping (name/type/required) only — never a spread of unknown keys, so an
    // unexpected extra key on the wire response can never ride along into the DOM.
    schemaByObject.value = {
      ...schemaByObject.value,
      [objectName]: schema.fields.map((field) => ({ name: field.name, type: field.type, required: field.required })),
    }
  } catch {
    schemaErrored.value = { ...schemaErrored.value, [objectName]: true }
  } finally {
    schemaLoading[objectName] = false
  }
}

// --- BA-UI-2 (docs/development/bridge-agent-admin-page-design-lock-20260707.md §3 BA-UI-2): values-
// free one-click probe. Sequential health -> objects -> schema, early-stopping at the first step that
// fails (a later step is simply never called — no partial/best-effort continuation). Reuses the exact
// same three read-only generic service calls the rest of this section already consumes above
// (testExternalSystemConnection / listExternalSystemObjects / getExternalSystemSchema) — ZERO new
// backend routes, zero new credential path. Evidence is ephemeral component state only (no
// persistence/backend storage; BA-UI-3's change-suggestion flow is a later, unopened slice).
//
// Evidence vocabulary (values-free, per lock §3): ok (boolean) / durationBucket (coarse bucket, never
// a raw millisecond count that could fingerprint infra) / objectCount (objects step) / fieldCount of a
// single SAMPLED object (schema step, never the object's name or any field value) / a humanized error
// label + guidance line on failure, both routed through the IU-1 `errorCodeLabels` module (never a raw
// code string, never a raw error message — see the script-block security-bounds note above, which this
// slice does not relax).

type ProbeStepKey = 'health' | 'objects' | 'schema'
type DurationBucket = '<1s' | '1-5s' | '>5s'

interface ProbeStepResult {
  step: ProbeStepKey
  ok: boolean
  // Absent only for the schema step when it is SKIPPED (objects step returned zero objects — nothing
  // to sample; this is not a failure, so no fetch/timing happened for this step).
  durationBucket?: DurationBucket
  objectCount?: number // objects step only
  fieldCount?: number // schema step only — field count of the single sampled object
  skipped?: boolean // schema step only
  // Real registered code for a health failure (its response carries `.code`); ALWAYS null for
  // objects/schema failures — their thrown Error carries no machine-readable code (BA-UI-1 scout
  // finding: workbench.ts's parseIntegrationResponse only preserves `.message`). Routing a `null` code
  // through the same IU-1 label helper still yields a coarse, values-free "unknown error" label — it is
  // deliberately NOT a special-cased string here.
  code: string | null
}

interface ProbeRunResult {
  overallPass: boolean
  failedStep: ProbeStepKey | null
  steps: ProbeStepResult[]
}

const probing = reactive<Record<string, boolean>>({})
const probeResults = reactive<Record<string, ProbeRunResult>>({})

function isProbing(systemId: string): boolean {
  return Boolean(probing[systemId])
}

function probeResultFor(systemId: string): ProbeRunResult | null {
  return probeResults[systemId] || null
}

function bucketFor(durationMs: number): DurationBucket {
  if (durationMs < 1000) return '<1s'
  if (durationMs < 5000) return '1-5s'
  return '>5s'
}

// Times a step and normalizes both the success and throw paths into one shape — `Date.now()` (not
// `performance.now()`) so tests can pin exact deltas via `vi.spyOn(Date, 'now')` without needing fake
// timers to cooperate with real microtask scheduling.
async function measureStep<T>(
  fn: () => Promise<T>,
): Promise<{ durationBucket: DurationBucket; value: T | null; threw: boolean }> {
  const start = Date.now()
  try {
    const value = await fn()
    return { durationBucket: bucketFor(Date.now() - start), value, threw: false }
  } catch {
    return { durationBucket: bucketFor(Date.now() - start), value: null, threw: true }
  }
}

function probeStepLabel(step: ProbeStepKey): string {
  if (step === 'health') return bi('健康检查', 'Health check')
  if (step === 'objects') return bi('对象列表', 'Objects')
  return bi('Schema 预览', 'Schema preview')
}

// Always routed through the IU-1 module — see the `code` field comment on ProbeStepResult above for
// why a `null` code (objects/schema) is expected and still renders a humanized, values-free label.
function probeStepErrorLabel(step: ProbeStepResult): string {
  return integrationErrorCodeDisplayLabel(step.code, locale.value)
}

const PROBE_STEP_FALLBACK_GUIDANCE: Record<ProbeStepKey, { zh: string; en: string }> = {
  health: {
    zh: '本机 Bridge Agent 可能未启动或不可达，请检查其计划任务/进程后重新探测。',
    en: 'The local Bridge Agent may not be running or reachable; check its scheduled task or process, then re-probe.',
  },
  objects: {
    zh: '请检查连接状态后重试对象列表探测。',
    en: 'Check the connection status, then retry the objects probe.',
  },
  schema: {
    zh: '请检查所采样对象是否仍在本机 allowlist 中后重试。',
    en: 'Check whether the sampled object is still allowlisted locally, then retry.',
  },
}

// A registered code's own hint (IU-6 hint style — e.g. BRIDGE_AGENT_UNREACHABLE/TIMEOUT already carry
// one) takes precedence when present; otherwise this fixed, values-free per-step fallback guarantees a
// guidance line always renders on failure, even for the codeless objects/schema routes.
function probeStepGuidance(step: ProbeStepKey, code: string | null): string {
  const hint = integrationErrorCodeHint(code, locale.value)
  if (hint) return hint
  return locale.value === 'zh-CN' ? PROBE_STEP_FALLBACK_GUIDANCE[step].zh : PROBE_STEP_FALLBACK_GUIDANCE[step].en
}

function overallLabel(result: ProbeRunResult): string {
  if (result.overallPass) return 'PASS'
  return `FAIL: ${probeStepLabel(result.failedStep as ProbeStepKey)}`
}

async function runProbe(system: WorkbenchExternalSystem): Promise<void> {
  const systemId = system.id
  probing[systemId] = true
  const steps: ProbeStepResult[] = []
  let failedStep: ProbeStepKey | null = null
  try {
    // Step 1/3: health — the SAME generic test route the status card above uses.
    const health = await measureStep(() => testExternalSystemConnection(systemId, props.scope))
    const healthOk = !health.threw && health.value?.ok === true
    const healthCode = !healthOk && !health.threw && typeof health.value?.code === 'string' ? health.value.code : null
    steps.push({ step: 'health', ok: healthOk, durationBucket: health.durationBucket, code: healthCode })
    if (!healthOk) {
      failedStep = 'health'
      return
    }

    // Step 2/3: objects — early-stop here means schema (step 3) is NEVER called.
    const objects = await measureStep(() => listExternalSystemObjects(systemId, props.scope))
    const objectsOk = !objects.threw
    steps.push({
      step: 'objects',
      ok: objectsOk,
      durationBucket: objects.durationBucket,
      objectCount: objectsOk ? (objects.value?.length ?? 0) : undefined,
      code: null,
    })
    if (!objectsOk) {
      failedStep = 'objects'
      return
    }

    // Step 3/3: schema of a single sampled object (the first object returned). An empty allowlist
    // (objectCount === 0) is NOT a failure — there is simply nothing to sample, so this step is marked
    // skipped rather than run.
    const sample = objects.value && objects.value.length > 0 ? objects.value[0] : null
    if (!sample) {
      steps.push({ step: 'schema', ok: true, skipped: true, code: null })
      return
    }
    const schema = await measureStep(() => getExternalSystemSchema(systemId, { ...props.scope, object: sample.name }))
    const schemaOk = !schema.threw
    steps.push({
      step: 'schema',
      ok: schemaOk,
      durationBucket: schema.durationBucket,
      fieldCount: schemaOk ? (schema.value?.fields.length ?? 0) : undefined,
      code: null,
    })
    if (!schemaOk) failedStep = 'schema'
  } finally {
    probeResults[systemId] = { overallPass: failedStep === null, failedStep, steps }
    probing[systemId] = false
  }
}

watch(
  bridgeSystems,
  (list) => {
    if (list.length === 0) {
      selectedSystemId.value = ''
      return
    }
    if (!list.some((system) => system.id === selectedSystemId.value)) {
      selectedSystemId.value = list[0].id
    }
  },
  { immediate: true },
)

watch(
  selectedSystemId,
  () => {
    expandedObject.value = ''
    schemaByObject.value = {}
    schemaErrored.value = {}
    void loadObjects()
  },
  { immediate: true },
)
</script>

<style scoped>
/* Verbatim copies of the base rules from IntegrationWorkbenchView.vue's <style scoped> block that
   this new section's markup also needs — see IntegrationMonitoringSection.vue's style block comment
   for why duplication (not relocation) is correct: Vue's scoped CSS only reaches elements rendered by
   the SAME SFC that declared the rule. */
.integration-workbench h2 {
  margin: 0;
  font-size: 17px;
}

.integration-workbench h3 {
  margin: 0 0 10px;
  font-size: 14px;
}

.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.integration-workbench__panel p {
  margin: 8px 0 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.integration-workbench__panel {
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.integration-workbench__button,
.integration-workbench__link-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.integration-workbench__button {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-weight: 700;
  padding: 8px 12px;
}

.integration-workbench__button:hover {
  border-color: var(--ms-color-primary);
}

.integration-workbench__button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.integration-workbench__link-button {
  border: none;
  background: none;
  padding: 0;
  color: var(--ms-color-primary);
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}

.integration-workbench__hint {
  margin-top: 10px;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__empty {
  padding: 12px;
  border: 1px dashed var(--ms-border);
  border-radius: 6px;
  color: var(--ms-text-2);
}

.integration-workbench__empty strong {
  color: var(--ms-text-1);
}

.integration-workbench__empty p {
  margin: 6px 0 0;
}

/* BA-UI-1 own classes below (fresh prefix — not extracted from the parent view). */

.bridge-agent__cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.bridge-agent__card {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.bridge-agent__card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ms-text-1);
}

.bridge-agent__card-icon {
  color: var(--ms-text-3);
}

.bridge-agent__card-head strong {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bridge-agent__card-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.bridge-agent__badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: 700;
}

.bridge-agent__badge--readonly {
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
}

.bridge-agent__badge--online {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
}

.bridge-agent__badge--offline {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.bridge-agent__meta {
  color: var(--ms-text-3);
}

.bridge-agent__error {
  margin: 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
  font-size: 12px;
}

.bridge-agent__probe-evidence {
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px dashed var(--ms-border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.bridge-agent__probe-evidence h4 {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--ms-text-1);
}

.bridge-agent__probe-evidence ul {
  margin: 0;
  padding-left: 16px;
  display: grid;
  gap: 6px;
}

.bridge-agent__probe-overall {
  margin: 0 0 6px;
  font-weight: 700;
  color: var(--ms-text-1);
}

.bridge-agent__probe-overall[data-result='fail'] {
  color: var(--el-color-danger);
}

.bridge-agent__probe-overall[data-result='pass'] {
  color: var(--el-color-success-dark-2);
}

.bridge-agent__probe-guidance {
  margin: 2px 0 0;
  color: var(--ms-text-3);
}

.bridge-agent__instances,
.bridge-agent__objects {
  margin-top: 20px;
}

.bridge-agent__objects-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.bridge-agent__instance-picker {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--ms-text-2);
}

.bridge-agent__instance-picker select {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 6px 8px;
  color: var(--ms-text-1);
  font: inherit;
}

.bridge-agent__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.bridge-agent__table th,
.bridge-agent__table td {
  border-bottom: 1px solid var(--el-border-color-lighter);
  padding: 6px 8px;
  text-align: left;
  color: var(--ms-text-1);
}

.bridge-agent__table th {
  color: var(--ms-text-2);
  font-weight: 600;
}

@media (max-width: 900px) {
  .integration-workbench__panel-head {
    display: grid;
  }

  .bridge-agent__objects-head {
    display: grid;
  }
}
</style>
