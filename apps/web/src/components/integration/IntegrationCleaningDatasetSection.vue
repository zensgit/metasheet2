<template>
  <section id="int-sec-cleaning-dataset" class="integration-workbench__panel">
    <el-card shadow="never">
      <template #header>
        <div class="integration-workbench__panel-head">
          <div>
            <h2>数据集与多维表清洗</h2>
        <p>数据源和目标系统只负责读写；业务清洗、审核、修正发生在多维表里。未安装清洗表时，可在这里创建 staging 多维表。</p>
      </div>
    </div>
      </template>


    <div class="integration-workbench__dataset-grid" data-testid="dataset-cards">
      <article class="integration-workbench__dataset-card" data-testid="source-dataset-card">
        <div class="integration-workbench__dataset-head">
          <span class="integration-workbench__dataset-kind">数据源</span>
          <strong>{{ sourceDatasetTitle }}</strong>
        </div>
        <p>{{ sourceDatasetDescription }}</p>
        <div class="integration-workbench__metric-row">
          <span>{{ sourceSchema.fields.length }} 个字段</span>
          <span>{{ sourceConnectionLabel }}</span>
        </div>
      </article>

      <article class="integration-workbench__dataset-card" data-testid="staging-dataset-card">
        <div class="integration-workbench__dataset-head">
          <span class="integration-workbench__dataset-kind">多维表清洗区</span>
          <strong>{{ selectedStagingDescriptor?.name || '未绑定 staging 表' }}</strong>
        </div>
        <p>原始区、清洗区和回写区都在多维表中呈现，业务人员不需要直接维护 JSON。</p>
        <div class="integration-workbench__metric-row">
          <span>{{ stagingDescriptors.length }} 张表</span>
          <span>{{ selectedStagingDescriptor ? getStagingAreaLabel(selectedStagingDescriptor.id) : '待选择' }}</span>
        </div>
      </article>

      <article class="integration-workbench__dataset-card" data-testid="target-dataset-card">
        <div class="integration-workbench__dataset-head">
          <span class="integration-workbench__dataset-kind">目标系统</span>
          <strong>{{ targetDatasetTitle }}</strong>
        </div>
        <p>{{ targetDatasetDescription }}</p>
        <div class="integration-workbench__metric-row">
          <span>{{ targetSchema.fields.length }} 个字段</span>
          <span>{{ requiredTargetFieldCount }} 个必填</span>
        </div>
      </article>
    </div>

    <div v-if="stagingDescriptors.length" class="integration-workbench__staging-list" data-testid="staging-dataset-list">
      <article v-for="descriptor in stagingDatasetCards" :key="descriptor.id" class="integration-workbench__staging-card">
        <div>
          <strong>{{ descriptor.name }}</strong>
          <p>{{ descriptor.description }}</p>
          <small>{{ descriptor.id }} · {{ descriptor.fieldCount }} 个字段 · {{ descriptor.area }}</small>
        </div>
        <div class="integration-workbench__actions integration-workbench__actions--inline">
          <a
            v-if="descriptor.openLink"
            class="integration-workbench__button"
            :href="descriptor.openLink"
            target="_blank"
            rel="noopener noreferrer"
            :data-testid="`open-staging-${descriptor.id}`"
          >
            打开多维表（新建记录入口）
          </a>
          <button
            v-else
            type="button"
            class="integration-workbench__button"
            :disabled="installingStaging"
            :data-testid="`refresh-staging-link-${descriptor.id}`"
            @click="installStagingTables"
          >
            {{ installingStaging ? '生成中' : '生成打开链接' }}
          </button>
          <button
            type="button"
            class="integration-workbench__button"
            :disabled="!descriptor.openLink"
            :data-testid="`use-staging-source-${descriptor.id}`"
            @click="useStagingAsSource(descriptor.id)"
          >
            作为 Dry-run 来源
          </button>
          <button
            type="button"
            class="integration-workbench__button"
            :disabled="!descriptor.openLink"
            :data-testid="`use-multitable-target-${descriptor.id}`"
            @click="useStagingAsTarget(descriptor.id)"
          >
            作为目标多维表
          </button>
        </div>
        <small v-if="descriptor.openLink" class="integration-workbench__staging-note">
          使用此 /multitable 链接进入真正的多维表工具栏，再点击 + New Record 验证必填字段 toast。
        </small>
        <small v-else class="integration-workbench__staging-note integration-workbench__staging-note--warning">
          不要手写 /grid 或 /spreadsheets/{{ descriptor.id }}；先生成后端返回的 /multitable sheet/view 打开链接。
        </small>
      </article>
    </div>
    <div v-else class="integration-workbench__empty integration-workbench__empty--actionable" data-testid="staging-empty">
      <strong>暂未加载 staging 契约。</strong>
      <p>点击「创建清洗表」即可生成 staging 多维表；创建完成后可在 staging 卡片上「作为 Dry-run 来源」。</p>
      <div class="integration-workbench__actions">
        <button type="button" class="integration-workbench__button" data-testid="staging-empty-focus-install" @click="focusStagingInstall">创建清洗表</button>
      </div>
    </div>

    <div class="integration-workbench__grid integration-workbench__grid--compact">
      <label>
        <span>Project ID（高级，可选）</span>
        <input
          :value="stagingProjectId"
          data-testid="staging-project-id"
          placeholder="留空自动使用 tenant:integration-core"
          @input="onStagingProjectIdInput"
          @change="onStagingProjectIdInput"
          @blur="onStagingProjectIdInput"
        />
        <small class="integration-workbench__staging-note" data-testid="staging-project-id-scope-status">
          {{ stagingProjectIdScopeStatus }}
        </small>
      </label>
      <label>
        <span>Base ID（可选）</span>
        <input v-model="stagingBaseId" data-testid="staging-base-id" placeholder="留空使用默认 base" />
      </label>
    </div>
    <div v-if="stagingProjectIdScopeWarning" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="staging-project-id-scope-warning">
      {{ stagingProjectIdScopeWarning }}
      <button type="button" class="integration-workbench__button" data-testid="normalize-staging-project-id" @click="normalizeStagingProjectIdToScope">
        规范化为 integration 作用域
      </button>
    </div>
    <div class="integration-workbench__actions">
      <button type="button" class="integration-workbench__button" data-testid="install-staging" :disabled="installingStaging" @click="installStagingTables">
        {{ installingStaging ? '创建中' : '创建清洗表' }}
      </button>
    </div>
    <pre v-if="stagingInstallResultText" data-testid="staging-install-result">{{ stagingInstallResultText }}</pre>
    </el-card>
  </section>
</template>

<script setup lang="ts">
// IU-2b (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage B): extracted verbatim from IntegrationWorkbenchView.vue's `int-sec-cleaning-dataset`
// section (pure template/markup move — no state or service-call logic lives here). The parent
// view owns every ref/computed/service-call; this component only renders them and forwards user
// actions back up via the exact same function references it is handed as props.
//
// `stagingBaseId` is the one field with native `v-model` two-way binding in this section, so it
// uses `defineModel` (the parent binds `v-model:staging-base-id="stagingBaseId"`) instead of a
// plain prop + manual input handler — same net effect as before extraction, idiomatic Vue 3.4+.
import type {
  IntegrationObjectSchema,
  IntegrationStagingDescriptor,
} from '../../services/integration/workbench'
import type { StagingDatasetCard } from './integrationWorkbenchSectionTypes'

defineProps<{
  sourceDatasetTitle: string
  sourceDatasetDescription: string
  sourceSchema: IntegrationObjectSchema
  sourceConnectionLabel: string
  selectedStagingDescriptor: IntegrationStagingDescriptor | null
  stagingDescriptors: IntegrationStagingDescriptor[]
  getStagingAreaLabel: (id: string) => string
  targetDatasetTitle: string
  targetDatasetDescription: string
  targetSchema: IntegrationObjectSchema
  requiredTargetFieldCount: number
  stagingDatasetCards: StagingDatasetCard[]
  installingStaging: boolean
  stagingProjectId: string
  stagingProjectIdScopeStatus: string
  stagingProjectIdScopeWarning: string
  stagingInstallResultText: string
  installStagingTables: () => Promise<void>
  useStagingAsSource: (objectId: string) => Promise<void>
  useStagingAsTarget: (objectId: string) => Promise<void>
  focusStagingInstall: () => void
  onStagingProjectIdInput: (event: Event) => void
  normalizeStagingProjectIdToScope: () => void
}>()

const stagingBaseId = defineModel<string>('stagingBaseId', { default: '' })
</script>

<style scoped>
/* Verbatim copies of the rules in IntegrationWorkbenchView.vue's <style scoped> block that
   target markup now rendered by this component — see IntegrationMonitoringSection.vue's style
   block comment for why duplication (not relocation) is the correct approach here. */
.integration-workbench label {
  display: grid;
  gap: 6px;
  color: var(--ms-text-1);
  font-size: 13px;
  font-weight: 700;
}

.integration-workbench input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--ms-text-1);
  font: inherit;
}

.integration-workbench pre {
  min-height: 260px;
  max-height: 420px;
  overflow: auto;
  margin: 12px 0 0;
  padding: 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-text-1);
  color: var(--el-color-primary-light-9);
  font-size: 12px;
  line-height: 1.5;
}

.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.integration-workbench__dataset-card,
.integration-workbench__staging-card {
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.integration-workbench__panel p {
  margin: 8px 0 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.integration-workbench__button {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-weight: 700;
  text-decoration: none;
  padding: 8px 12px;
}

.integration-workbench__button:hover {
  border-color: var(--ms-color-primary);
}

.integration-workbench__button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.integration-workbench__panel {
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.integration-workbench__hint {
  margin-top: 10px;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__hint--strong {
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.integration-workbench__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.integration-workbench__grid--compact {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.integration-workbench__dataset-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.integration-workbench__dataset-card {
  display: grid;
  gap: 10px;
  padding: 14px;
}

.integration-workbench__dataset-head {
  display: grid;
  gap: 4px;
}

.integration-workbench__dataset-kind {
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: 700;
}

.integration-workbench__dataset-card strong,
.integration-workbench__staging-card strong {
  color: var(--ms-text-1);
}

.integration-workbench__dataset-card p,
.integration-workbench__staging-card p {
  margin: 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.integration-workbench__metric-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.integration-workbench__metric-row span,
.integration-workbench__staging-card small {
  display: inline-flex;
  color: var(--ms-text-2);
  font-size: 12px;
}

.integration-workbench__staging-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}

.integration-workbench__staging-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
}

.integration-workbench__staging-note {
  grid-column: 1 / -1;
  display: block;
  color: var(--ms-text-2);
  line-height: 1.45;
}

.integration-workbench__staging-note--warning {
  color: var(--el-color-warning-dark-2);
}

.integration-workbench__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.integration-workbench__actions--inline {
  justify-content: flex-end;
  margin-top: 0;
}

.integration-workbench__empty {
  padding: 12px;
  border: 1px dashed var(--ms-border);
  border-radius: 6px;
  color: var(--ms-text-2);
}

.integration-workbench__empty--actionable {
  margin-top: 10px;
}

.integration-workbench__empty strong {
  color: var(--ms-text-1);
}

.integration-workbench__empty p {
  margin: 6px 0 0;
}

@media (max-width: 900px) {
  .integration-workbench__panel-head,
  .integration-workbench__dataset-grid,
  .integration-workbench__staging-list,
  .integration-workbench__grid {
    grid-template-columns: 1fr;
  }

  .integration-workbench__panel-head {
    display: grid;
  }
}
</style>
