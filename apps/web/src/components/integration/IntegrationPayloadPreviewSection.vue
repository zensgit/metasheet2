<template>
  <section id="int-sec-preview" class="integration-workbench__panel integration-workbench__preview">
    <el-card shadow="never">
    <div>
      <h2>样例记录</h2>
      <textarea v-model="sampleRecordText" data-testid="sample-record" spellcheck="false"></textarea>
      <h2>目标模板 JSON</h2>
      <textarea
        v-model="payloadTemplateText"
        data-testid="payload-template"
        spellcheck="false"
        placeholder='{ "FNumber": "&lt;code&gt;", "FName": "&lt;name&gt;" }'
      ></textarea>
      <small class="integration-workbench__hint">可选。填写后使用 DF-T1 no-write payloadTemplate 预览；留空则保持 legacy preview。</small>
      <h2>引用映射来源(各 domain 绑定 staging 表)</h2>
      <div v-if="referenceMappingDomains.length > 0" data-testid="reference-mapping-picker">
        <div
          v-for="domain in referenceMappingDomains"
          :key="domain"
          class="integration-workbench__ref-mapping-row"
          :data-testid="`ref-mapping-row-${domain}`"
        >
          <code>{{ domain }}</code>
          <select
            :data-testid="`ref-mapping-system-${domain}`"
            :value="referenceMappingBindings[domain]?.systemId || ''"
            @change="onRefMappingSystemChange(domain, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">— staging 系统 —</option>
            <option v-for="system in stagingSystems" :key="system.id" :value="system.id">{{ system.name }}</option>
          </select>
          <input
            :data-testid="`ref-mapping-object-${domain}`"
            :value="referenceMappingBindings[domain]?.object || ''"
            placeholder="对象/表名"
            @input="onRefMappingObjectChange(domain, ($event.target as HTMLInputElement).value)"
          />
        </div>
      </div>
      <small class="integration-workbench__hint">将 reference 字段授权为「从映射表解析」并选 domain 后,这里按 domain 绑定其 staging 映射表(系统按名称选,对象填表名);预览会实时 bulk-read 解析。sourceCode 列在上方字段规则里填。</small>
      <button
        type="button"
        class="integration-workbench__button"
        data-testid="derive-template-draft"
        :disabled="derivingDraft"
        @click="deriveTemplateDraft"
      >{{ derivingDraft ? '派生中…' : '从模板派生字段规则草案' }}</button>
      <p v-if="deriveError" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="derive-error">{{ deriveError }}</p>
      <MetaIntegrationFieldRuleAuthoring
        v-if="authoredFieldRules.length > 0"
        v-model="authoredFieldRules"
        :gated-fields="authoredGatedFields"
      />
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
      <p
        v-if="sourceReadOnlyBoundaryNotice"
        class="integration-workbench__hint integration-workbench__hint--strong"
        data-testid="source-readonly-boundary-notice"
      >
        {{ sourceReadOnlyBoundaryNotice }}
      </p>
      <pre data-testid="payload-preview">{{ previewText }}</pre>
      <div
        v-if="previewProvenance"
        class="integration-workbench__provenance"
        data-testid="preview-provenance"
      >
        <h3 class="integration-workbench__provenance-title">字段来源</h3>
        <p class="integration-workbench__provenance-stats" data-testid="preview-provenance-stats">
          <span
            v-for="stat in previewProvenance.stats"
            :key="stat.source"
            class="integration-workbench__provenance-badge"
            :data-source="stat.source"
          >{{ provenanceSourceLabel(stat.source) }}: {{ stat.count }}</span>
        </p>
        <ul class="integration-workbench__provenance-list">
          <li v-for="entry in previewProvenance.entries" :key="entry.field" :data-field="entry.field">
            <code>{{ entry.field }}</code>
            <span class="integration-workbench__provenance-badge" :data-source="entry.source">{{ provenanceSourceLabel(entry.source) }}</span>
          </li>
        </ul>
        <p class="integration-workbench__hint">仅显示字段名与来源，不含字段值。</p>
      </div>
    </div>
    </el-card>
  </section>
</template>

<script setup lang="ts">
// IU-2c (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage C): extracted verbatim from IntegrationWorkbenchView.vue's `int-sec-preview` section
// (pure template/markup move — no state or service-call logic lives here). The parent view
// owns every ref/computed/service-call; this component only renders them and forwards user
// actions back up via the exact same function references it is handed as props.
//
// Three native two-way binds in this section use `defineModel` (same pattern as IU-2b's
// `stagingBaseId`): `sampleRecordText`/`payloadTemplateText` (plain textareas) and
// `authoredFieldRules` (forwarded as the `v-model` of the nested
// `MetaIntegrationFieldRuleAuthoring` child, unchanged from before extraction).
// `referenceMappingBindings` stays a read-only data prop — the section only ever reads it
// (`referenceMappingBindings[domain]?.systemId`) and mutates it indirectly through the parent's
// `onRefMappingSystemChange`/`onRefMappingObjectChange` action props, exactly as before.
//
// Per the design-lock's own slice ladder, IU-5 (JSON-textarea structuring, gated on IU-2) may
// later restructure `sampleRecordText`/`payloadTemplateText` away from raw textareas — this
// extraction does not anticipate that shape, it only relocates the existing markup verbatim.
import type {
  IntegrationFieldProvenanceSummary,
  IntegrationFieldRule,
  WorkbenchExternalSystem,
} from '../../services/integration/workbench'
import MetaIntegrationFieldRuleAuthoring from './MetaIntegrationFieldRuleAuthoring.vue'

defineProps<{
  referenceMappingDomains: string[]
  referenceMappingBindings: Record<string, { systemId: string; object: string }>
  stagingSystems: WorkbenchExternalSystem[]
  onRefMappingSystemChange: (domain: string, systemId: string) => void
  onRefMappingObjectChange: (domain: string, object: string) => void
  derivingDraft: boolean
  deriveError: string
  deriveTemplateDraft: () => Promise<void>
  authoredGatedFields: string[]
  sourceReadOnlyBoundaryNotice: string
  previewPayload: () => Promise<void>
  previewText: string
  previewProvenance: IntegrationFieldProvenanceSummary | null
  provenanceSourceLabel: (source: string) => string
}>()

const sampleRecordText = defineModel<string>('sampleRecordText', { default: '' })
const payloadTemplateText = defineModel<string>('payloadTemplateText', { default: '' })
const authoredFieldRules = defineModel<IntegrationFieldRule[]>('authoredFieldRules', { default: () => [] })
</script>

<style scoped>
/* Verbatim copies of the rules in IntegrationWorkbenchView.vue's <style scoped> block that
   target markup now rendered by this component — see IntegrationMonitoringSection.vue's style
   block comment for why duplication (not relocation) is the correct approach here. */
.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.integration-workbench h2 {
  margin: 0;
  font-size: 17px;
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

.integration-workbench label {
  display: grid;
  gap: 6px;
  color: var(--ms-text-1);
  font-size: 13px;
  font-weight: 700;
}

.integration-workbench input,
.integration-workbench select,
.integration-workbench textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--ms-text-1);
  font: inherit;
}

.integration-workbench textarea {
  min-height: 260px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.integration-workbench code {
  color: var(--ms-color-primary);
  font-size: 12px;
}

.integration-workbench h3 {
  margin: 0 0 10px;
  font-size: 14px;
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
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-text-1);
  color: var(--el-color-primary-light-9);
  font-size: 12px;
  line-height: 1.5;
}

.integration-workbench__provenance {
  margin-top: 12px;
}
.integration-workbench__provenance-title {
  font-size: 14px;
  margin: 0 0 6px;
}
.integration-workbench__provenance-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 8px;
}
.integration-workbench__provenance-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.integration-workbench__provenance-list li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.integration-workbench__provenance-badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary-dark-2);
}

@media (max-width: 900px) {
  .integration-workbench__panel-head,
  .integration-workbench__preview {
    grid-template-columns: 1fr;
  }

  .integration-workbench__panel-head {
    display: grid;
  }
}
</style>
