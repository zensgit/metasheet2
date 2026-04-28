<template>
  <section class="k3-setup" data-testid="k3-wise-setup">
    <header class="k3-setup__header">
      <div>
        <p class="k3-setup__eyebrow">ERP Integration</p>
        <h1>K3 WISE 对接配置</h1>
        <p class="k3-setup__lead">维护 WebAPI、账套、凭据和 SQL Server 通道信息。</p>
      </div>
      <div class="k3-setup__header-actions">
        <button class="k3-setup__btn" type="button" :disabled="loading" @click="loadSystems">
          {{ loading ? '刷新中' : '刷新' }}
        </button>
        <button class="k3-setup__btn k3-setup__btn--primary" type="button" :disabled="saving" @click="saveConfiguration">
          {{ saving ? '保存中' : '保存配置' }}
        </button>
      </div>
    </header>

    <p v-if="statusMessage" class="k3-setup__status" :data-kind="statusKind">{{ statusMessage }}</p>

    <section class="k3-setup__layout">
      <aside class="k3-setup__rail">
        <div class="k3-setup__panel">
          <div class="k3-setup__panel-head">
            <h2>已保存系统</h2>
            <span>{{ webApiSystems.length + sqlSystems.length }}</span>
          </div>
          <div v-if="loading" class="k3-setup__empty">Loading...</div>
          <div v-else-if="webApiSystems.length + sqlSystems.length === 0" class="k3-setup__empty">暂无 K3 WISE 系统。</div>
          <div v-else class="k3-setup__saved-list">
            <button
              v-for="system in savedSystems"
              :key="system.id"
              class="k3-setup__saved"
              type="button"
              @click="loadSystemIntoForm(system)"
            >
              <span>{{ system.name }}</span>
              <small>{{ system.kind }} · {{ system.status }}</small>
              <small v-if="system.lastTestedAt">Last test: {{ formatTimestamp(system.lastTestedAt) }}</small>
              <small v-if="system.lastError" class="k3-setup__saved-error">{{ system.lastError }}</small>
            </button>
          </div>
        </div>

        <div class="k3-setup__panel">
          <div class="k3-setup__panel-head">
            <h2>连接测试</h2>
          </div>
          <button class="k3-setup__btn k3-setup__btn--full" type="button" :disabled="testingWebApi || !form.webApiSystemId" @click="testWebApi">
            {{ testingWebApi ? '测试中' : '测试 WebAPI' }}
          </button>
          <button class="k3-setup__btn k3-setup__btn--full" type="button" :disabled="testingSql || !form.sqlSystemId" @click="testSqlServer">
            {{ testingSql ? '测试中' : '测试 SQL Server' }}
          </button>
          <pre v-if="testResult" class="k3-setup__test-result">{{ testResult }}</pre>
        </div>

        <div class="k3-setup__panel">
          <div class="k3-setup__panel-head">
            <h2>清洗链路</h2>
            <span>draft</span>
          </div>
          <button
            class="k3-setup__btn k3-setup__btn--full"
            type="button"
            :disabled="creatingPipelines || pipelineIssues.length > 0"
            @click="createPipelineTemplates"
          >
            {{ creatingPipelines ? '创建中' : '创建清洗 Pipeline' }}
          </button>
          <ul v-if="pipelineIssues.length" class="k3-setup__issues k3-setup__issues--compact">
            <li v-for="issue in pipelineIssues" :key="`pipeline:${issue.field}:${issue.message}`">
              {{ issue.message }}
            </li>
          </ul>
          <pre v-if="pipelineResult" class="k3-setup__test-result">{{ pipelineResult }}</pre>
        </div>
      </aside>

      <form class="k3-setup__form" @submit.prevent="saveConfiguration">
        <section class="k3-setup__section">
          <div class="k3-setup__section-head">
            <h2>作用域</h2>
            <span>tenant / workspace</span>
          </div>
          <div class="k3-setup__grid">
            <label class="k3-setup__field">
              <span>Tenant ID</span>
              <input v-model.trim="form.tenantId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Workspace ID</span>
              <input v-model.trim="form.workspaceId" autocomplete="off" />
            </label>
          </div>
        </section>

        <section class="k3-setup__section">
          <div class="k3-setup__section-head">
            <h2>K3 WISE WebAPI</h2>
            <span>{{ form.webApiSystemId ? '编辑现有系统' : '新建系统' }}</span>
          </div>
          <div class="k3-setup__grid">
            <label class="k3-setup__field">
              <span>名称</span>
              <input v-model.trim="form.webApiName" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>K3 WISE 版本</span>
              <input v-model.trim="form.version" placeholder="K3 WISE 15.x test" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>环境</span>
              <select v-model="form.environment">
                <option value="test">test</option>
                <option value="uat">uat</option>
                <option value="staging">staging</option>
                <option value="production">production</option>
                <option value="other">other</option>
              </select>
            </label>
            <label class="k3-setup__field k3-setup__field--wide">
              <span>WebAPI Base URL</span>
              <input v-model.trim="form.baseUrl" placeholder="https://k3.example.test/K3API/" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Login Path</span>
              <input v-model.trim="form.loginPath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Health Path</span>
              <input v-model.trim="form.healthPath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>LCID</span>
              <input v-model.trim="form.lcid" inputmode="numeric" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Timeout ms</span>
              <input v-model.trim="form.timeoutMs" inputmode="numeric" autocomplete="off" />
            </label>
          </div>
        </section>

        <section class="k3-setup__section">
          <div class="k3-setup__section-head">
            <h2>WebAPI 凭据</h2>
            <span>{{ form.webApiHasCredentials ? '已有凭据，留空则保留' : '需要填写' }}</span>
          </div>
          <div class="k3-setup__grid">
            <label class="k3-setup__field">
              <span>Acct ID</span>
              <input v-model.trim="form.acctId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>用户名</span>
              <input v-model.trim="form.username" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>密码</span>
              <input v-model="form.password" type="password" autocomplete="new-password" />
            </label>
            <label class="k3-setup__check">
              <input v-model="form.autoSubmit" type="checkbox" />
              <span>Save 后自动 Submit</span>
            </label>
            <label class="k3-setup__check">
              <input v-model="form.autoAudit" type="checkbox" />
              <span>Submit 后自动 Audit</span>
            </label>
          </div>
        </section>

        <section class="k3-setup__section">
          <div class="k3-setup__section-head">
            <h2>物料 / BOM 接口</h2>
            <span>relative paths</span>
          </div>
          <div class="k3-setup__grid">
            <label class="k3-setup__field">
              <span>Material Save</span>
              <input v-model.trim="form.materialSavePath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Material Submit</span>
              <input v-model.trim="form.materialSubmitPath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Material Audit</span>
              <input v-model.trim="form.materialAuditPath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>BOM Save</span>
              <input v-model.trim="form.bomSavePath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>BOM Submit</span>
              <input v-model.trim="form.bomSubmitPath" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>BOM Audit</span>
              <input v-model.trim="form.bomAuditPath" autocomplete="off" />
            </label>
          </div>
        </section>

        <section class="k3-setup__section">
          <div class="k3-setup__section-head">
            <h2>SQL Server 通道</h2>
            <label class="k3-setup__switch">
              <input v-model="form.sqlEnabled" type="checkbox" />
              <span>{{ form.sqlEnabled ? '启用' : '关闭' }}</span>
            </label>
          </div>
          <div v-if="form.sqlEnabled" class="k3-setup__grid">
            <label class="k3-setup__field">
              <span>名称</span>
              <input v-model.trim="form.sqlName" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>模式</span>
              <select v-model="form.sqlMode">
                <option value="readonly">readonly</option>
                <option value="middle-table">middle-table</option>
                <option value="stored-procedure">stored-procedure</option>
              </select>
            </label>
            <label class="k3-setup__field">
              <span>Server</span>
              <input v-model.trim="form.sqlServer" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>Database</span>
              <input v-model.trim="form.sqlDatabase" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>SQL 用户名</span>
              <input v-model.trim="form.sqlUsername" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>SQL 密码</span>
              <input v-model="form.sqlPassword" type="password" autocomplete="new-password" />
            </label>
            <label class="k3-setup__field k3-setup__field--wide">
              <span>允许读取表</span>
              <textarea v-model="form.sqlAllowedTables" rows="4" spellcheck="false" />
            </label>
            <label class="k3-setup__field">
              <span>中间表</span>
              <textarea v-model="form.sqlMiddleTables" rows="4" spellcheck="false" />
            </label>
            <label class="k3-setup__field">
              <span>存储过程</span>
              <textarea v-model="form.sqlStoredProcedures" rows="4" spellcheck="false" />
            </label>
          </div>
        </section>

        <section v-if="validationIssues.length" class="k3-setup__section k3-setup__section--issues">
          <div class="k3-setup__section-head">
            <h2>待补字段</h2>
            <span>{{ validationIssues.length }}</span>
          </div>
          <ul class="k3-setup__issues">
            <li v-for="issue in validationIssues" :key="`${issue.field}:${issue.message}`">
              {{ issue.message }}
            </li>
          </ul>
        </section>

        <section class="k3-setup__section">
          <div class="k3-setup__section-head">
            <h2>PLM → K3 清洗链路</h2>
            <span>multitable staging + pipeline runner</span>
          </div>
          <div class="k3-setup__grid">
            <label class="k3-setup__field">
              <span>Project ID</span>
              <input v-model.trim="form.projectId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>PLM Source System ID</span>
              <input v-model.trim="form.sourceSystemId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>K3 Target System ID</span>
              <input v-model.trim="form.webApiSystemId" autocomplete="off" readonly />
            </label>
            <label class="k3-setup__field">
              <span>物料 Pipeline 名称</span>
              <input v-model.trim="form.materialPipelineName" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>物料 Staging 对象</span>
              <input v-model.trim="form.materialStagingObjectId" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>BOM Pipeline 名称</span>
              <input v-model.trim="form.bomPipelineName" autocomplete="off" />
            </label>
            <label class="k3-setup__field">
              <span>BOM Staging 对象</span>
              <input v-model.trim="form.bomStagingObjectId" autocomplete="off" />
            </label>
          </div>
        </section>
      </form>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  K3_WISE_SQLSERVER_KIND,
  K3_WISE_WEBAPI_KIND,
  applyExternalSystemToForm,
  buildK3WisePipelinePayloads,
  buildK3WiseSetupPayloads,
  createDefaultK3WiseSetupForm,
  listIntegrationSystems,
  testIntegrationSystem,
  upsertIntegrationPipeline,
  upsertIntegrationSystem,
  validateK3WisePipelineTemplateForm,
  validateK3WiseSetupForm,
  type IntegrationExternalSystem,
} from '../services/integration/k3WiseSetup'

const form = reactive(createDefaultK3WiseSetupForm())
const webApiSystems = ref<IntegrationExternalSystem[]>([])
const sqlSystems = ref<IntegrationExternalSystem[]>([])
const loading = ref(false)
const saving = ref(false)
const testingWebApi = ref(false)
const testingSql = ref(false)
const creatingPipelines = ref(false)
const statusMessage = ref('')
const statusKind = ref<'info' | 'success' | 'error'>('info')
const testResult = ref('')
const pipelineResult = ref('')

const savedSystems = computed(() => [...webApiSystems.value, ...sqlSystems.value])
const validationIssues = computed(() => validateK3WiseSetupForm(form))
const pipelineIssues = computed(() => validateK3WisePipelineTemplateForm(form))

function setStatus(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  statusMessage.value = message
  statusKind.value = kind
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function loadSystemIntoForm(system: IntegrationExternalSystem): void {
  Object.assign(form, applyExternalSystemToForm(form, system))
  testResult.value = ''
  setStatus(`已载入 ${system.name}`, 'info')
}

async function loadSystems(): Promise<void> {
  loading.value = true
  try {
    const [webApi, sql] = await Promise.all([
      listIntegrationSystems(K3_WISE_WEBAPI_KIND, form),
      listIntegrationSystems(K3_WISE_SQLSERVER_KIND, form),
    ])
    webApiSystems.value = webApi
    sqlSystems.value = sql
    if (!form.webApiSystemId && webApi[0]) loadSystemIntoForm(webApi[0])
    if (!form.sqlSystemId && sql[0]) loadSystemIntoForm(sql[0])
    setStatus('K3 WISE 配置已刷新', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    loading.value = false
  }
}

async function saveConfiguration(): Promise<void> {
  const issues = validateK3WiseSetupForm(form)
  if (issues.length > 0) {
    setStatus(issues[0].message, 'error')
    return
  }
  saving.value = true
  try {
    const payloads = buildK3WiseSetupPayloads(form)
    const webApi = await upsertIntegrationSystem(payloads.webApi)
    form.webApiSystemId = webApi.id
    form.webApiHasCredentials = webApi.hasCredentials === true
    if (payloads.sqlServer) {
      const sql = await upsertIntegrationSystem(payloads.sqlServer)
      form.sqlSystemId = sql.id
      form.sqlHasCredentials = sql.hasCredentials === true
    }
    await loadSystems()
    setStatus('K3 WISE 对接配置已保存', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    saving.value = false
  }
}

async function testWebApi(): Promise<void> {
  if (!form.webApiSystemId) return
  testingWebApi.value = true
  testResult.value = ''
  try {
    const result = await testIntegrationSystem(form.webApiSystemId, { skipHealth: !form.healthPath.trim() })
    testResult.value = JSON.stringify(result, null, 2)
    await loadSystems()
    setStatus('WebAPI 连接测试完成', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    testingWebApi.value = false
  }
}

async function testSqlServer(): Promise<void> {
  if (!form.sqlSystemId) return
  testingSql.value = true
  testResult.value = ''
  try {
    const result = await testIntegrationSystem(form.sqlSystemId)
    testResult.value = JSON.stringify(result, null, 2)
    await loadSystems()
    setStatus('SQL Server 通道测试完成', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    testingSql.value = false
  }
}

async function createPipelineTemplates(): Promise<void> {
  const issues = validateK3WisePipelineTemplateForm(form)
  if (issues.length > 0) {
    setStatus(issues[0].message, 'error')
    return
  }
  creatingPipelines.value = true
  pipelineResult.value = ''
  try {
    const payloads = buildK3WisePipelinePayloads(form)
    const [material, bom] = await Promise.all([
      upsertIntegrationPipeline(payloads.material),
      upsertIntegrationPipeline(payloads.bom),
    ])
    pipelineResult.value = JSON.stringify({
      material: { id: material.id, name: material.name, status: material.status },
      bom: { id: bom.id, name: bom.name, status: bom.status },
    }, null, 2)
    setStatus('PLM → K3 清洗 Pipeline 已创建为 draft', 'success')
  } catch (error) {
    setStatus(formatError(error), 'error')
  } finally {
    creatingPipelines.value = false
  }
}

onMounted(() => {
  void loadSystems()
})
</script>

<style scoped>
.k3-setup {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 100%;
  padding: 24px;
  background: #f6f8fb;
  color: #172033;
}

.k3-setup__header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-start;
  padding-bottom: 16px;
  border-bottom: 1px solid #d9e1ec;
}

.k3-setup__eyebrow {
  margin: 0 0 4px;
  color: #64748b;
  font-size: 12px;
  text-transform: uppercase;
}

.k3-setup__header h1 {
  margin: 0;
  font-size: 28px;
  line-height: 1.2;
  color: #111827;
}

.k3-setup__lead {
  margin: 8px 0 0;
  color: #526072;
}

.k3-setup__header-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.k3-setup__layout {
  display: grid;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.k3-setup__rail,
.k3-setup__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.k3-setup__panel,
.k3-setup__section {
  padding: 16px;
  border: 1px solid #d9e1ec;
  border-radius: 8px;
  background: #fff;
}

.k3-setup__panel-head,
.k3-setup__section-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 14px;
}

.k3-setup__panel-head h2,
.k3-setup__section-head h2 {
  margin: 0;
  font-size: 16px;
  line-height: 1.3;
  color: #111827;
}

.k3-setup__panel-head span,
.k3-setup__section-head span {
  color: #64748b;
  font-size: 12px;
}

.k3-setup__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(180px, 1fr));
  gap: 14px;
}

.k3-setup__field,
.k3-setup__check,
.k3-setup__switch {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.k3-setup__field--wide {
  grid-column: span 2;
}

.k3-setup__field span,
.k3-setup__check span,
.k3-setup__switch span {
  color: #334155;
  font-size: 13px;
  font-weight: 600;
}

.k3-setup__field input,
.k3-setup__field select,
.k3-setup__field textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 9px 10px;
  background: #fff;
  color: #111827;
  font: inherit;
}

.k3-setup__field input[readonly] {
  background: #f8fafc;
  color: #64748b;
}

.k3-setup__field textarea {
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
}

.k3-setup__check,
.k3-setup__switch {
  flex-direction: row;
  align-items: center;
  min-height: 38px;
}

.k3-setup__check input,
.k3-setup__switch input {
  width: 16px;
  height: 16px;
}

.k3-setup__btn {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 9px 12px;
  background: #fff;
  color: #172033;
  font: inherit;
  cursor: pointer;
}

.k3-setup__btn--primary {
  border-color: #0f766e;
  background: #0f766e;
  color: #fff;
}

.k3-setup__btn--full {
  width: 100%;
  margin-top: 8px;
}

.k3-setup__btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.k3-setup__status {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #fff;
}

.k3-setup__status[data-kind="success"] {
  border-color: #99f6e4;
  background: #f0fdfa;
  color: #115e59;
}

.k3-setup__status[data-kind="error"] {
  border-color: #fecaca;
  background: #fff1f2;
  color: #9f1239;
}

.k3-setup__saved-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.k3-setup__saved {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 10px;
  background: #f8fafc;
  color: #172033;
  text-align: left;
  cursor: pointer;
}

.k3-setup__saved small {
  color: #64748b;
}

.k3-setup__saved-error {
  color: #9f1239;
  overflow-wrap: anywhere;
}

.k3-setup__empty {
  color: #64748b;
}

.k3-setup__test-result {
  overflow: auto;
  max-height: 260px;
  margin: 12px 0 0;
  padding: 10px;
  border-radius: 6px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 12px;
}

.k3-setup__section--issues {
  border-color: #fed7aa;
  background: #fff7ed;
}

.k3-setup__issues {
  margin: 0;
  padding-left: 18px;
  color: #9a3412;
}

.k3-setup__issues--compact {
  margin-top: 10px;
  font-size: 13px;
}

@media (max-width: 1100px) {
  .k3-setup__layout {
    grid-template-columns: 1fr;
  }

  .k3-setup__rail {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .k3-setup {
    padding: 16px;
  }

  .k3-setup__header {
    flex-direction: column;
  }

  .k3-setup__header-actions,
  .k3-setup__rail {
    display: flex;
  }

  .k3-setup__grid {
    grid-template-columns: 1fr;
  }

  .k3-setup__field--wide {
    grid-column: auto;
  }
}
</style>
