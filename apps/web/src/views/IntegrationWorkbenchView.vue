<template>
  <section class="integration-workbench">
    <header class="integration-workbench__header">
      <div>
        <p class="integration-workbench__eyebrow">Integration Workbench</p>
        <h1>通用数据集成工作台</h1>
        <p class="integration-workbench__lead">选择来源系统和目标系统，把数据在多维表中清洗后，先预览 payload，再 dry-run 和 Save-only 推送。</p>
      </div>
      <router-link class="integration-workbench__k3-link" to="/integrations/k3-wise">K3 WISE 预设向导</router-link>
    </header>

    <div v-if="statusMessage" class="integration-workbench__status" :data-kind="statusKind">
      {{ statusMessage }}
    </div>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__panel-head">
        <div>
          <h2>连接系统</h2>
          <p>SQL 通道标记为高级能力，适合实施人员配置只读表、视图或中间表。</p>
        </div>
        <button type="button" class="integration-workbench__button" data-testid="refresh-systems" @click="refreshBootstrap">
          刷新连接
        </button>
      </div>

      <div class="integration-workbench__adapter-list">
        <span
          v-for="adapter in visibleAdapters"
          :key="adapter.kind"
          class="integration-workbench__adapter"
          :data-advanced="adapter.advanced ? 'true' : 'false'"
        >
          {{ adapter.label }}
          <small v-if="adapter.advanced">高级</small>
        </span>
      </div>

      <label class="integration-workbench__advanced-toggle">
        <input v-model="showAdvancedConnectors" type="checkbox" data-testid="show-advanced-connectors" />
        <span>显示 SQL / 高级连接（实施人员或管理员使用）</span>
      </label>
      <div v-if="!showAdvancedConnectors && hiddenAdvancedSystemCount > 0" class="integration-workbench__hint" data-testid="advanced-hidden-hint">
        已隐藏 {{ hiddenAdvancedSystemCount }} 个高级连接。SQL 通道默认不进入业务用户连接列表。
      </div>
      <div v-if="showAdvancedConnectors" class="integration-workbench__hint" data-testid="advanced-visible-hint">
        高级连接只用于 allowlist 表/视图读取或中间表写入；不要把核心业务表直写暴露给普通用户。
      </div>

      <div class="integration-workbench__grid">
        <label>
          <span>Tenant ID</span>
          <input v-model="scope.tenantId" data-testid="tenant-id" />
        </label>
        <label>
          <span>Workspace ID</span>
          <input v-model="workspaceInput" data-testid="workspace-id" placeholder="可选" />
        </label>
      </div>
    </section>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__grid integration-workbench__grid--systems">
        <div class="integration-workbench__system-column">
          <h2>来源</h2>
          <label>
            <span>来源系统</span>
            <select v-model="sourceSystemId" data-testid="source-system">
              <option value="">请选择来源系统</option>
              <option v-for="system in sourceSystems" :key="system.id" :value="system.id">
                {{ system.name }} · {{ system.kind }}
              </option>
            </select>
          </label>
          <div class="integration-workbench__connection-row">
            <span class="integration-workbench__badge" :data-status="sourceConnectionStatus">{{ sourceConnectionLabel }}</span>
            <button type="button" class="integration-workbench__button" data-testid="test-source-system" @click="testSystem('source')">
              测试来源连接
            </button>
            <button type="button" class="integration-workbench__button" data-testid="load-source-objects" @click="loadObjects('source')">
              加载来源对象
            </button>
          </div>
          <label>
            <span>来源对象</span>
            <select v-model="sourceObjectName" data-testid="source-object" @change="loadSchema('source')">
              <option value="">请选择来源对象</option>
              <option v-for="object in sourceObjects" :key="object.name" :value="object.name">
                {{ object.label || object.name }}
              </option>
            </select>
          </label>
          <ul class="integration-workbench__schema-list">
            <li v-for="field in sourceSchema.fields" :key="field.name">
              {{ field.label || field.name }} <code>{{ field.name }}</code>
            </li>
          </ul>
        </div>

        <div class="integration-workbench__system-column">
          <h2>目标</h2>
          <label>
            <span>目标系统</span>
            <select v-model="targetSystemId" data-testid="target-system">
              <option value="">请选择目标系统</option>
              <option v-for="system in targetSystems" :key="system.id" :value="system.id">
                {{ system.name }} · {{ system.kind }}
              </option>
            </select>
          </label>
          <div class="integration-workbench__connection-row">
            <span class="integration-workbench__badge" :data-status="targetConnectionStatus">{{ targetConnectionLabel }}</span>
            <button type="button" class="integration-workbench__button" data-testid="test-target-system" @click="testSystem('target')">
              测试目标连接
            </button>
            <button type="button" class="integration-workbench__button" data-testid="load-target-objects" @click="loadObjects('target')">
              加载目标对象
            </button>
          </div>
          <label>
            <span>目标对象 / 模板</span>
            <select v-model="targetObjectName" data-testid="target-object" @change="loadSchema('target')">
              <option value="">请选择目标对象</option>
              <option v-for="object in targetObjects" :key="object.name" :value="object.name">
                {{ object.label || object.name }}
              </option>
            </select>
          </label>
          <ul class="integration-workbench__schema-list">
            <li v-for="field in targetSchema.fields" :key="field.name">
              {{ field.label || field.name }} <code>{{ field.name }}</code>
              <strong v-if="field.required">必填</strong>
            </li>
          </ul>
        </div>
      </div>
      <div v-if="sameSystemNotice" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="same-system-notice">
        {{ sameSystemNotice }}
      </div>
      <div v-if="protocolSplitNotice" class="integration-workbench__hint" data-testid="protocol-split-notice">
        {{ protocolSplitNotice }}
      </div>
    </section>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__panel-head">
        <div>
          <h2>字段映射</h2>
          <p>这里只允许白名单转换函数；复杂逻辑应进入 adapter 或后端模板，而不是用户脚本。</p>
        </div>
        <button type="button" class="integration-workbench__button" data-testid="add-mapping" @click="addMapping">
          新增映射
        </button>
      </div>

      <table class="integration-workbench__mapping-table">
        <thead>
          <tr>
            <th>源字段</th>
            <th>目标字段</th>
            <th>转换</th>
            <th>校验</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(mapping, index) in mappings" :key="mapping.id">
            <td><input v-model="mapping.sourceField" :data-testid="`source-field-${index}`" /></td>
            <td><input v-model="mapping.targetField" :data-testid="`target-field-${index}`" /></td>
            <td>
              <select v-model="mapping.transformFn" :data-testid="`transform-fn-${index}`">
                <option v-for="option in transformOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
              <textarea
                v-if="mapping.transformFn === 'dictMap'"
                v-model="mapping.dictMapText"
                :data-testid="`dict-map-${index}`"
                placeholder="EA=Pcs&#10;KG=Kg"
              ></textarea>
            </td>
            <td>
              <label class="integration-workbench__mapping-check">
                <input v-model="mapping.required" type="checkbox" :data-testid="`required-${index}`" />
                <span>必填</span>
              </label>
              <div class="integration-workbench__mapping-rules">
                <input v-model="mapping.minValueText" :data-testid="`validation-min-${index}`" placeholder="min" />
                <input v-model="mapping.maxValueText" :data-testid="`validation-max-${index}`" placeholder="max" />
              </div>
            </td>
            <td>
              <button type="button" class="integration-workbench__icon-button" @click="removeMapping(index)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__panel-head">
        <div>
          <h2>Pipeline 执行</h2>
          <p>先保存 pipeline，再 dry-run。Save-only 推送必须显式勾选，默认不会 Submit / Audit。</p>
        </div>
        <button type="button" class="integration-workbench__button" data-testid="save-pipeline" :disabled="savingPipeline" @click="savePipeline">
          {{ savingPipeline ? '保存中' : '保存 Pipeline' }}
        </button>
      </div>

      <div class="integration-workbench__grid">
        <label>
          <span>Pipeline 名称</span>
          <input v-model="pipelineName" data-testid="pipeline-name" placeholder="例如 PLM material to K3 material" />
        </label>
        <label>
          <span>Pipeline 模式</span>
          <select v-model="pipelineMode" data-testid="pipeline-mode">
            <option value="manual">manual</option>
            <option value="incremental">incremental</option>
            <option value="full">full</option>
          </select>
        </label>
        <label>
          <span>幂等字段</span>
          <input v-model="idempotencyFieldsText" data-testid="idempotency-fields" placeholder="code 或 sourceId,revision" />
        </label>
        <label>
          <span>清洗 staging 表</span>
          <select v-model="stagingSheetId" data-testid="staging-sheet">
            <option value="">不绑定 staging 表</option>
            <option v-for="descriptor in stagingDescriptors" :key="descriptor.id" :value="descriptor.id">
              {{ descriptor.name }} · {{ descriptor.id }}
            </option>
          </select>
        </label>
        <label>
          <span>已保存 Pipeline ID</span>
          <input v-model="savedPipelineId" data-testid="pipeline-id" placeholder="保存后自动回填，也可粘贴已有 ID" />
        </label>
        <label>
          <span>运行模式</span>
          <select v-model="pipelineRunMode" data-testid="pipeline-run-mode">
            <option value="manual">manual</option>
            <option value="incremental">incremental</option>
            <option value="full">full</option>
          </select>
        </label>
        <label>
          <span>Dry-run 样本数</span>
          <input v-model="pipelineSampleLimit" data-testid="sample-limit" inputmode="numeric" />
        </label>
      </div>

      <label class="integration-workbench__inline-check">
        <input v-model="allowSaveOnlyRun" type="checkbox" data-testid="allow-save-only-run" />
        <span>允许本次 Save-only 推送。保持 Submit / Audit 关闭。</span>
      </label>

      <div class="integration-workbench__actions">
        <button type="button" class="integration-workbench__button" data-testid="run-dry-run" :disabled="runningPipeline !== ''" @click="executePipeline(true)">
          {{ runningPipeline === 'dry-run' ? 'Dry-run 中' : 'Dry-run' }}
        </button>
        <button type="button" class="integration-workbench__button integration-workbench__button--danger" data-testid="run-save-only" :disabled="runningPipeline !== '' || !allowSaveOnlyRun" @click="executePipeline(false)">
          {{ runningPipeline === 'run' ? '推送中' : 'Save-only 推送' }}
        </button>
      </div>

      <pre data-testid="pipeline-result">{{ pipelineResultText }}</pre>
    </section>

    <section class="integration-workbench__panel">
      <div class="integration-workbench__panel-head">
        <div>
          <h2>运行观察</h2>
          <p>{{ observationSummary }}。这里显示最近 5 条 run 和 open dead letters，便于清洗后回看失败原因。</p>
        </div>
        <button type="button" class="integration-workbench__button" data-testid="refresh-observation" :disabled="observingPipeline" @click="refreshPipelineObservation(false)">
          {{ observingPipeline ? '刷新中' : '刷新观察' }}
        </button>
      </div>

      <div class="integration-workbench__observation">
        <div>
          <h3>最近运行</h3>
          <div v-if="pipelineRuns.length === 0" class="integration-workbench__empty">暂无运行记录。</div>
          <ol v-else class="integration-workbench__record-list" data-testid="pipeline-runs">
            <li v-for="run in pipelineRuns" :key="run.id">
              <strong>{{ run.status }}</strong>
              <span>{{ run.mode }}</span>
              <span>read {{ run.rowsRead }} / clean {{ run.rowsCleaned }} / write {{ run.rowsWritten }} / fail {{ run.rowsFailed }}</span>
              <small>{{ run.startedAt || run.createdAt || run.id }}</small>
            </li>
          </ol>
        </div>
        <div>
          <h3>Open Dead Letters</h3>
          <div v-if="deadLetters.length === 0" class="integration-workbench__empty">暂无 open dead letters。</div>
          <ol v-else class="integration-workbench__record-list" data-testid="dead-letters">
            <li v-for="deadLetter in deadLetters" :key="deadLetter.id">
              <strong>{{ deadLetter.errorCode }}</strong>
              <span>{{ deadLetter.errorMessage }}</span>
              <small>{{ deadLetter.status }} · {{ deadLetter.createdAt || deadLetter.id }}</small>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <section class="integration-workbench__panel integration-workbench__preview">
      <div>
        <h2>样例记录</h2>
        <textarea v-model="sampleRecordText" data-testid="sample-record" spellcheck="false"></textarea>
      </div>
      <div>
        <div class="integration-workbench__panel-head">
          <div>
            <h2>Payload 预览</h2>
            <p>预览只做纯计算，不写数据库，也不会调用 ERP/CRM/PLM/SRM。</p>
          </div>
          <button type="button" class="integration-workbench__button" data-testid="preview-payload" @click="previewPayload">
            生成 JSON 预览
          </button>
        </div>
        <pre data-testid="payload-preview">{{ previewText }}</pre>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  canReadFromSystem,
  canWriteToSystem,
  getDefaultIntegrationScope,
  getExternalSystemSchema,
  listIntegrationDeadLetters,
  listIntegrationPipelineRuns,
  listIntegrationStagingDescriptors,
  listExternalSystemObjects,
  listIntegrationAdapters,
  listWorkbenchExternalSystems,
  previewIntegrationTemplate,
  runIntegrationPipeline,
  testExternalSystemConnection,
  upsertIntegrationPipeline,
  type IntegrationAdapterMetadata,
  type IntegrationFieldMapping,
  type IntegrationObjectSchema,
  type IntegrationObjectSchemaField,
  type IntegrationDeadLetter,
  type IntegrationPipelineMode,
  type IntegrationPipelineRun,
  type IntegrationStagingDescriptor,
  type IntegrationSystemObject,
  type WorkbenchExternalSystem,
} from '../services/integration/workbench'

type WorkbenchSide = 'source' | 'target'
type TransformFn = '' | 'trim' | 'upper' | 'lower' | 'toNumber' | 'dictMap'

interface EditableMapping {
  id: string
  sourceField: string
  targetField: string
  transformFn: TransformFn
  dictMapText: string
  required: boolean
  minValueText: string
  maxValueText: string
}

const transformOptions: Array<{ value: TransformFn, label: string }> = [
  { value: '', label: '无转换' },
  { value: 'trim', label: 'trim 去空格' },
  { value: 'upper', label: 'upper 转大写' },
  { value: 'lower', label: 'lower 转小写' },
  { value: 'toNumber', label: 'toNumber 转数字' },
  { value: 'dictMap', label: 'dictMap 字典映射' },
]

const defaultScope = getDefaultIntegrationScope()
const scope = reactive({
  tenantId: defaultScope.tenantId,
  workspaceId: defaultScope.workspaceId,
})
const workspaceInput = computed({
  get: () => scope.workspaceId || '',
  set: (value: string) => {
    scope.workspaceId = value.trim() || null
  },
})

const adapters = ref<IntegrationAdapterMetadata[]>([])
const systems = ref<WorkbenchExternalSystem[]>([])
const showAdvancedConnectors = ref(false)
const sourceSystemId = ref('')
const targetSystemId = ref('')
const sourceObjects = ref<IntegrationSystemObject[]>([])
const targetObjects = ref<IntegrationSystemObject[]>([])
const stagingDescriptors = ref<IntegrationStagingDescriptor[]>([])
const sourceObjectName = ref('')
const targetObjectName = ref('')
const stagingSheetId = ref('')
const sourceSchema = ref<IntegrationObjectSchema>({ object: '', fields: [] })
const targetSchema = ref<IntegrationObjectSchema>({ object: '', fields: [] })
const mappings = ref<EditableMapping[]>([])
const previewText = ref('尚未生成预览')
const pipelineResultText = ref('尚未执行')
const pipelineRuns = ref<IntegrationPipelineRun[]>([])
const deadLetters = ref<IntegrationDeadLetter[]>([])
const statusMessage = ref('')
const statusKind = ref<'idle' | 'success' | 'error'>('idle')
const pipelineName = ref('')
const pipelineMode = ref<IntegrationPipelineMode>('manual')
const pipelineRunMode = ref<IntegrationPipelineMode>('manual')
const idempotencyFieldsText = ref('code')
const pipelineSampleLimit = ref('20')
const savedPipelineId = ref('')
const savingPipeline = ref(false)
const runningPipeline = ref<'dry-run' | 'run' | ''>('')
const observingPipeline = ref(false)
const allowSaveOnlyRun = ref(false)
const sampleRecordText = ref(JSON.stringify({
  code: ' mat-001 ',
  name: ' Bolt ',
  uom: 'EA',
  quantity: '2',
}, null, 2))

const adapterMetadataByKind = computed(() => new Map(adapters.value.map((adapter) => [adapter.kind, adapter])))
const visibleAdapters = computed(() => adapters.value.filter((adapter) => showAdvancedConnectors.value || !adapter.advanced))
const hiddenAdvancedSystemCount = computed(() => systems.value.filter((system) => isAdvancedSystem(system)).length)
const visibleSystems = computed(() => systems.value.filter((system) => showAdvancedConnectors.value || !isAdvancedSystem(system)))
const sourceSystems = computed(() => visibleSystems.value.filter(canReadFromSystem))
const targetSystems = computed(() => visibleSystems.value.filter(canWriteToSystem))
const selectedTargetObject = computed(() => targetObjects.value.find((object) => object.name === targetObjectName.value) || null)
const selectedSourceSystem = computed(() => systems.value.find((system) => system.id === sourceSystemId.value) || null)
const selectedTargetSystem = computed(() => systems.value.find((system) => system.id === targetSystemId.value) || null)
const sourceConnectionStatus = computed(() => selectedSourceSystem.value?.status || 'inactive')
const targetConnectionStatus = computed(() => selectedTargetSystem.value?.status || 'inactive')
const sourceConnectionLabel = computed(() => connectionStatusLabel(selectedSourceSystem.value))
const targetConnectionLabel = computed(() => connectionStatusLabel(selectedTargetSystem.value))
const observationSummary = computed(() => `${pipelineRuns.value.length} runs / ${deadLetters.value.length} open dead letters`)
const sameSystemNotice = computed(() => {
  if (!sourceSystemId.value || sourceSystemId.value !== targetSystemId.value) return ''
  if (selectedSourceSystem.value?.role === 'bidirectional') {
    return 'same system, different business object：同一个双向连接可以作为来源和目标，但请选择不同业务对象避免误解为 loopback sync。'
  }
  return '同一连接同时作为来源和目标只支持 role=bidirectional 的外部系统。'
})
const protocolSplitNotice = computed(() => {
  const source = selectedSourceSystem.value
  const target = selectedTargetSystem.value
  if (!source || !target) return ''
  if (isK3WiseSystem(source) && isK3WiseSystem(target) && source.kind !== target.kind) {
    return '同一物理 K3 WISE 使用不同协议时，建议配置两条逻辑连接：SQL read channel 作为来源，WebAPI Save channel 作为目标。'
  }
  if (showAdvancedConnectors.value) {
    return '如果同一物理系统需要不同协议，请使用两条逻辑连接区分读取和写入职责。'
  }
  return ''
})

function setStatus(message: string, kind: 'success' | 'error' | 'idle' = 'idle'): void {
  statusMessage.value = message
  statusKind.value = kind
}

function currentScope() {
  return {
    tenantId: scope.tenantId.trim() || 'default',
    workspaceId: scope.workspaceId || null,
  }
}

function isAdvancedSystem(system: WorkbenchExternalSystem): boolean {
  return adapterMetadataByKind.value.get(system.kind)?.advanced === true
}

function isK3WiseSystem(system: WorkbenchExternalSystem): boolean {
  return system.kind.startsWith('erp:k3-wise')
}

function normalizeSystemSelections(): void {
  if (sourceSystemId.value && !sourceSystems.value.some((system) => system.id === sourceSystemId.value)) {
    sourceSystemId.value = sourceSystems.value[0]?.id || ''
  }
  if (targetSystemId.value && !targetSystems.value.some((system) => system.id === targetSystemId.value)) {
    targetSystemId.value = targetSystems.value[0]?.id || ''
  }
  if (!sourceSystemId.value) sourceSystemId.value = sourceSystems.value[0]?.id || ''
  if (!targetSystemId.value) targetSystemId.value = targetSystems.value[0]?.id || ''
}

async function refreshBootstrap(): Promise<void> {
  try {
    const resolvedScope = currentScope()
    const [adapterList, systemList, descriptorList] = await Promise.all([
      listIntegrationAdapters(),
      listWorkbenchExternalSystems(resolvedScope),
      listIntegrationStagingDescriptors(),
    ])
    adapters.value = adapterList
    systems.value = systemList
    stagingDescriptors.value = descriptorList
    normalizeSystemSelections()
    if (!stagingSheetId.value) stagingSheetId.value = descriptorList.find((descriptor) => descriptor.id === 'standard_materials')?.id || descriptorList[0]?.id || ''
    setStatus(`已加载 ${systemList.length} 个连接、${adapterList.length} 个适配器和 ${descriptorList.length} 个 staging 表`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

function connectionStatusLabel(system: WorkbenchExternalSystem | null): string {
  if (!system) return '未选择'
  if (system.status === 'active') return system.lastTestedAt ? '已连接' : '可用'
  if (system.status === 'error') return system.lastError ? `异常：${system.lastError}` : '异常'
  return '未启用'
}

function replaceSystem(updated: WorkbenchExternalSystem): void {
  const index = systems.value.findIndex((system) => system.id === updated.id)
  if (index >= 0) {
    systems.value.splice(index, 1, updated)
  } else {
    systems.value.push(updated)
  }
}

async function testSystem(side: WorkbenchSide): Promise<void> {
  const systemId = side === 'source' ? sourceSystemId.value : targetSystemId.value
  if (!systemId) {
    setStatus(`${side === 'source' ? '来源' : '目标'}系统未选择`, 'error')
    return
  }
  try {
    const result = await testExternalSystemConnection(systemId, currentScope())
    if (result.system) replaceSystem(result.system)
    const label = side === 'source' ? '来源' : '目标'
    setStatus(result.ok ? `${label}连接测试通过` : `${label}连接测试失败：${result.message || result.code || 'unknown error'}`, result.ok ? 'success' : 'error')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function loadObjects(side: WorkbenchSide): Promise<void> {
  const systemId = side === 'source' ? sourceSystemId.value : targetSystemId.value
  if (!systemId) {
    setStatus(`${side === 'source' ? '来源' : '目标'}系统未选择`, 'error')
    return
  }
  try {
    const objects = await listExternalSystemObjects(systemId, currentScope())
    if (side === 'source') {
      sourceObjects.value = objects
      sourceObjectName.value = objects[0]?.name || ''
    } else {
      targetObjects.value = objects
      targetObjectName.value = objects[0]?.name || ''
    }
    if (objects.length > 0) await loadSchema(side)
    setStatus(`已加载 ${objects.length} 个${side === 'source' ? '来源' : '目标'}对象`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function loadSchema(side: WorkbenchSide): Promise<void> {
  const systemId = side === 'source' ? sourceSystemId.value : targetSystemId.value
  const objectName = side === 'source' ? sourceObjectName.value : targetObjectName.value
  if (!systemId || !objectName) return
  const schema = await getExternalSystemSchema(systemId, {
    ...currentScope(),
    object: objectName,
  })
  if (side === 'source') {
    sourceSchema.value = schema
  } else {
    targetSchema.value = schema
    seedMappingsFromTargetSchema(schema.fields)
  }
}

function guessSourceField(targetField: string): string {
  const known: Record<string, string> = {
    FNumber: 'code',
    FName: 'name',
    FModel: 'spec',
    FBaseUnitID: 'uom',
    FUnitID: 'uom',
    FQty: 'quantity',
    FEntryID: 'sequence',
    FParentItemNumber: 'parentCode',
    FChildItemNumber: 'childCode',
  }
  if (known[targetField]) return known[targetField]
  return targetField.replace(/^F/, '').replace(/Number$/, 'Code')
}

function seedMappingsFromTargetSchema(fields: IntegrationObjectSchemaField[]): void {
  if (mappings.value.length > 0 || fields.length === 0) return
  mappings.value = fields.slice(0, 8).map((field, index) => ({
    id: `mapping_${index}_${field.name}`,
    sourceField: guessSourceField(field.name),
    targetField: field.name,
    transformFn: field.type === 'number' ? 'toNumber' : 'trim',
    dictMapText: '',
    required: field.required === true,
    minValueText: '',
    maxValueText: '',
  }))
}

function addMapping(): void {
  mappings.value.push({
    id: `mapping_${Date.now()}_${mappings.value.length}`,
    sourceField: '',
    targetField: '',
    transformFn: '',
    dictMapText: '',
    required: false,
    minValueText: '',
    maxValueText: '',
  })
}

function removeMapping(index: number): void {
  mappings.value.splice(index, 1)
}

function parseDictionaryMap(text: string): Record<string, string> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('dictMap 字典映射不能为空')
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('dictMap JSON 必须是对象')
    }
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]))
  }
  const entries = trimmed.split(/\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) throw new Error('dictMap 每行必须使用 source=target 格式')
    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (!key || !value) throw new Error('dictMap 每行必须同时包含 source 和 target')
    return [key, value] as const
  })
  return Object.fromEntries(entries)
}

function parseTransform(mapping: EditableMapping): unknown {
  if (!mapping.transformFn) return undefined
  if (mapping.transformFn === 'dictMap') {
    return {
      fn: 'dictMap',
      map: parseDictionaryMap(mapping.dictMapText),
    }
  }
  return { fn: mapping.transformFn }
}

function parseOptionalNumber(value: string, label: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) throw new Error(`${label} 必须是数字`)
  return numeric
}

function buildValidationRules(mapping: EditableMapping): Array<Record<string, unknown>> | undefined {
  const validation: Array<Record<string, unknown>> = []
  if (mapping.required) validation.push({ type: 'required' })
  const min = parseOptionalNumber(mapping.minValueText, 'min')
  const max = parseOptionalNumber(mapping.maxValueText, 'max')
  if (min !== undefined) validation.push({ type: 'min', value: min })
  if (max !== undefined) validation.push({ type: 'max', value: max })
  return validation.length > 0 ? validation : undefined
}

function buildMappings(): IntegrationFieldMapping[] {
  return mappings.value
    .filter((mapping) => mapping.sourceField.trim() && mapping.targetField.trim())
    .map((mapping, index) => {
      return {
        sourceField: mapping.sourceField.trim(),
        targetField: mapping.targetField.trim(),
        transform: parseTransform(mapping),
        validation: buildValidationRules(mapping),
        sortOrder: index,
      }
    })
}

function parseList(value: string): string[] {
  return Array.from(new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)))
}

function parseOptionalPositiveInteger(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const numeric = Number(trimmed)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error('Dry-run 样本数必须是正整数')
  }
  return numeric
}

function defaultPipelineName(): string {
  const sourceName = selectedSourceSystem.value?.name || sourceSystemId.value || 'source'
  const targetName = selectedTargetSystem.value?.name || targetSystemId.value || 'target'
  return `${sourceName}:${sourceObjectName.value || 'object'} -> ${targetName}:${targetObjectName.value || 'object'}`
}

function selectedTemplateMeta(): Record<string, unknown> {
  const template = selectedTargetObject.value?.template || targetSchema.value.template || {}
  return {
    id: typeof template.id === 'string' ? template.id : undefined,
    version: typeof template.version === 'string' ? template.version : undefined,
    documentType: targetObjectName.value,
    bodyKey: typeof template.bodyKey === 'string' ? template.bodyKey : 'Data',
    endpointPath: typeof template.endpointPath === 'string' ? template.endpointPath : undefined,
  }
}

function buildPipelinePayload() {
  const resolvedScope = currentScope()
  const fieldMappings = buildMappings()
  const idempotencyKeyFields = parseList(idempotencyFieldsText.value)
  if (!sourceSystemId.value) throw new Error('请选择来源系统')
  if (!targetSystemId.value) throw new Error('请选择目标系统')
  if (!sourceObjectName.value) throw new Error('请选择来源对象')
  if (!targetObjectName.value) throw new Error('请选择目标对象')
  if (fieldMappings.length === 0) throw new Error('请至少配置一条字段映射')
  if (idempotencyKeyFields.length === 0) throw new Error('请至少配置一个幂等字段')

  const templateMeta = selectedTemplateMeta()
  const hasTemplate = typeof templateMeta.id === 'string' || typeof templateMeta.endpointPath === 'string'
  return {
    ...(savedPipelineId.value.trim() ? { id: savedPipelineId.value.trim() } : {}),
    ...resolvedScope,
    name: pipelineName.value.trim() || defaultPipelineName(),
    description: 'Generic integration workbench pipeline. Business data is cleansed in MetaSheet tables; this pipeline stores mapping and execution policy only.',
    sourceSystemId: sourceSystemId.value,
    sourceObject: sourceObjectName.value,
    targetSystemId: targetSystemId.value,
    targetObject: targetObjectName.value,
    stagingSheetId: stagingSheetId.value.trim() || null,
    mode: pipelineMode.value,
    status: 'active' as const,
    idempotencyKeyFields,
    options: {
      target: {
        autoSubmit: false,
        autoAudit: false,
      },
      workbench: {
        source: 'generic-integration-workbench',
        version: 'v1',
      },
      ...(hasTemplate ? { k3Template: templateMeta } : {}),
    },
    fieldMappings,
  }
}

function buildObservationQuery(status?: string) {
  const pipelineId = savedPipelineId.value.trim()
  if (!pipelineId) throw new Error('请先保存 Pipeline，或粘贴已有 Pipeline ID')
  return {
    ...currentScope(),
    pipelineId,
    ...(status ? { status } : {}),
    limit: 5,
  }
}

async function refreshPipelineObservation(silent = false): Promise<void> {
  observingPipeline.value = true
  try {
    const [runs, openDeadLetters] = await Promise.all([
      listIntegrationPipelineRuns(buildObservationQuery()),
      listIntegrationDeadLetters(buildObservationQuery('open')),
    ])
    pipelineRuns.value = runs
    deadLetters.value = openDeadLetters
    if (!silent) setStatus('Pipeline 运行记录已刷新', 'success')
  } catch (error) {
    if (!silent) setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    observingPipeline.value = false
  }
}

async function savePipeline(): Promise<void> {
  savingPipeline.value = true
  try {
    const pipeline = await upsertIntegrationPipeline(buildPipelinePayload())
    savedPipelineId.value = pipeline.id
    pipelineName.value = pipeline.name
    pipelineResultText.value = JSON.stringify({ action: 'save-pipeline', pipeline }, null, 2)
    setStatus(`Pipeline 已保存：${pipeline.id}`, 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    savingPipeline.value = false
  }
}

async function executePipeline(dryRun: boolean): Promise<void> {
  const pipelineId = savedPipelineId.value.trim()
  if (!pipelineId) {
    setStatus('请先保存 Pipeline，或粘贴已有 Pipeline ID', 'error')
    return
  }
  if (!dryRun && !allowSaveOnlyRun.value) {
    setStatus('Save-only 推送前必须显式勾选允许本次推送', 'error')
    return
  }
  runningPipeline.value = dryRun ? 'dry-run' : 'run'
  try {
    const payload = {
      ...currentScope(),
      mode: pipelineRunMode.value,
      sampleLimit: parseOptionalPositiveInteger(pipelineSampleLimit.value),
    }
    const result = await runIntegrationPipeline(pipelineId, payload, dryRun)
    pipelineResultText.value = JSON.stringify({
      action: dryRun ? 'dry-run' : 'save-only-run',
      pipelineId,
      payload,
      result,
    }, null, 2)
    await refreshPipelineObservation(true)
    setStatus(dryRun ? 'Dry-run 已提交' : 'Save-only 推送已提交', 'success')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    runningPipeline.value = ''
  }
}

async function previewPayload(): Promise<void> {
  try {
    const sourceRecord = JSON.parse(sampleRecordText.value) as Record<string, unknown>
    const template = selectedTemplateMeta()
    const result = await previewIntegrationTemplate({
      sourceRecord,
      fieldMappings: buildMappings(),
      template: {
        id: typeof template.id === 'string' ? template.id : targetObjectName.value,
        version: typeof template.version === 'string' ? template.version : undefined,
        documentType: typeof template.documentType === 'string' ? template.documentType : targetObjectName.value,
        bodyKey: typeof template.bodyKey === 'string' ? template.bodyKey : 'Data',
        endpointPath: typeof template.endpointPath === 'string' ? template.endpointPath : undefined,
        schema: targetSchema.value.fields,
      },
    })
    previewText.value = JSON.stringify(result, null, 2)
    setStatus(result.valid ? 'Payload 预览通过' : `Payload 预览发现 ${result.errors.length} 个问题`, result.valid ? 'success' : 'error')
  } catch (error) {
    previewText.value = '预览失败'
    setStatus(error instanceof Error ? error.message : String(error), 'error')
  }
}

onMounted(() => {
  void refreshBootstrap()
})

watch(showAdvancedConnectors, () => {
  normalizeSystemSelections()
})
</script>

<style scoped>
.integration-workbench {
  max-width: 1280px;
  margin: 0 auto;
  padding: 24px;
  color: #17202a;
}

.integration-workbench__header,
.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.integration-workbench__header {
  margin-bottom: 18px;
}

.integration-workbench__eyebrow {
  margin: 0 0 6px;
  color: #54637a;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
}

.integration-workbench h1,
.integration-workbench h2 {
  margin: 0;
}

.integration-workbench h1 {
  font-size: 28px;
}

.integration-workbench h2 {
  font-size: 17px;
}

.integration-workbench__lead,
.integration-workbench__panel p {
  margin: 8px 0 0;
  color: #5c6878;
  line-height: 1.5;
}

.integration-workbench__k3-link,
.integration-workbench__button,
.integration-workbench__icon-button {
  border: 1px solid #bfccd9;
  border-radius: 6px;
  background: #ffffff;
  color: #233246;
  cursor: pointer;
  font-weight: 700;
  text-decoration: none;
}

.integration-workbench__k3-link,
.integration-workbench__button {
  padding: 8px 12px;
}

.integration-workbench__icon-button {
  padding: 6px 8px;
}

.integration-workbench__button:hover,
.integration-workbench__icon-button:hover,
.integration-workbench__k3-link:hover {
  border-color: #357abd;
}

.integration-workbench__button--danger {
  border-color: #c77777;
  color: #8f1d1d;
}

.integration-workbench__status {
  margin-bottom: 14px;
  padding: 10px 12px;
  border-radius: 6px;
  background: #eef4fb;
  color: #24476b;
}

.integration-workbench__status[data-kind="error"] {
  background: #fff0f0;
  color: #9b1c1c;
}

.integration-workbench__status[data-kind="success"] {
  background: #edf7ef;
  color: #17622f;
}

.integration-workbench__panel {
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid #d8e0e8;
  border-radius: 8px;
  background: #ffffff;
}

.integration-workbench__adapter-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.integration-workbench__adapter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid #d8e0e8;
  border-radius: 999px;
  color: #35465c;
  font-size: 13px;
}

.integration-workbench__adapter small {
  color: #8a4d00;
  font-weight: 700;
}

.integration-workbench__advanced-toggle {
  display: flex;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.integration-workbench__advanced-toggle input {
  width: auto;
}

.integration-workbench__hint {
  margin-top: 10px;
  color: #5c6878;
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__hint--strong {
  padding: 10px 12px;
  border-radius: 6px;
  background: #fff8e8;
  color: #744600;
}

.integration-workbench__connection-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.integration-workbench__badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 5px 8px;
  border-radius: 999px;
  background: #eef2f7;
  color: #3c4b60;
  font-size: 12px;
  font-weight: 700;
}

.integration-workbench__badge[data-status="active"] {
  background: #edf7ef;
  color: #17622f;
}

.integration-workbench__badge[data-status="error"] {
  background: #fff0f0;
  color: #9b1c1c;
}

.integration-workbench__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.integration-workbench__grid--systems {
  align-items: start;
}

.integration-workbench__system-column {
  display: grid;
  gap: 12px;
}

.integration-workbench label {
  display: grid;
  gap: 6px;
  color: #35465c;
  font-size: 13px;
  font-weight: 700;
}

.integration-workbench input,
.integration-workbench select,
.integration-workbench textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #bfccd9;
  border-radius: 6px;
  padding: 8px 10px;
  color: #17202a;
  font: inherit;
}

.integration-workbench textarea {
  min-height: 260px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.integration-workbench__schema-list {
  min-height: 84px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid #e4ebf2;
  border-radius: 6px;
  background: #f8fafc;
  list-style: none;
}

.integration-workbench__schema-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  color: #42536a;
}

.integration-workbench code {
  color: #1f5f99;
  font-size: 12px;
}

.integration-workbench__schema-list strong {
  color: #9b1c1c;
  font-size: 12px;
}

.integration-workbench__mapping-table {
  width: 100%;
  margin-top: 14px;
  border-collapse: collapse;
}

.integration-workbench__mapping-table th,
.integration-workbench__mapping-table td {
  padding: 8px;
  border-bottom: 1px solid #e4ebf2;
  text-align: left;
}

.integration-workbench__mapping-table th {
  color: #5c6878;
  font-size: 12px;
}

.integration-workbench__mapping-table input[type="checkbox"] {
  width: auto;
}

.integration-workbench__mapping-table textarea {
  min-height: 68px;
  margin-top: 6px;
}

.integration-workbench__mapping-check {
  display: flex;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 6px;
}

.integration-workbench__mapping-rules {
  display: grid;
  grid-template-columns: repeat(2, minmax(72px, 1fr));
  gap: 6px;
  margin-top: 6px;
}

.integration-workbench__inline-check {
  display: flex;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.integration-workbench__inline-check input {
  width: auto;
}

.integration-workbench__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.integration-workbench__observation {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 14px;
}

.integration-workbench h3 {
  margin: 0 0 10px;
  font-size: 14px;
}

.integration-workbench__empty {
  padding: 12px;
  border: 1px dashed #cbd5e1;
  border-radius: 6px;
  color: #5c6878;
}

.integration-workbench__record-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.integration-workbench__record-list li {
  display: grid;
  gap: 4px;
  padding: 10px;
  border: 1px solid #e4ebf2;
  border-radius: 6px;
  background: #f8fafc;
}

.integration-workbench__record-list small {
  color: #5c6878;
}

.integration-workbench__preview {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  gap: 16px;
}

.integration-workbench pre {
  min-height: 260px;
  max-height: 420px;
  overflow: auto;
  margin: 12px 0 0;
  padding: 12px;
  border: 1px solid #d8e0e8;
  border-radius: 6px;
  background: #111827;
  color: #e5edf7;
  font-size: 12px;
  line-height: 1.5;
}

@media (max-width: 900px) {
  .integration-workbench__header,
  .integration-workbench__panel-head,
  .integration-workbench__preview,
  .integration-workbench__observation,
  .integration-workbench__grid {
    grid-template-columns: 1fr;
  }

  .integration-workbench__header,
  .integration-workbench__panel-head {
    display: grid;
  }
}
</style>
