<template>
  <PageShell width="default">
    <PageHeader
      :title="bi('集成帮助中心', 'Integration Help Center')"
      :subtitle="bi('数据工厂 / 读取源 / 组合链的使用说明与排障参考', 'Usage guidance and troubleshooting reference for Data Factory read sources and compositions')"
      back-to="/integrations/workbench"
      :back-label="bi('返回数据工厂', 'Back to Data Factory')"
    />

    <el-card class="integration-help__section" shadow="never" data-testid="help-section-when-to-use">
      <h2>{{ bi('何时用读取源 vs 组合', 'When to use a read source vs. a composition') }}</h2>
      <p>
        {{ bi(
          '读取源（单跳）：一次调用就能直接取到你需要的记录或列表——例如按业务键取一条记录的详情。',
          'Read source (single hop): one call gets you the record or list you need directly — e.g. fetching a single record\'s detail by its business key.',
        ) }}
      </p>
      <p>
        {{ bi(
          '组合（两跳）：需要先用第一跳的输出作为第二跳的输入才能拿到最终数据——例如先按业务键定位到一个内部标识，再用这个内部标识取到关联记录。两跳之间的交接完全由平台完成，浏览器和使用者都不会看到中间值。',
          'Composition (two hops): the first hop\'s output becomes the second hop\'s input before you get the final data — e.g. resolving a business key to an internal identifier, then using that identifier to fetch a linked record. The handoff between hops happens entirely on the platform; the browser and the end user never see the intermediate value.',
        ) }}
      </p>
      <ul class="integration-help__compare-list" data-testid="help-when-to-use-compare">
        <li>
          <strong>{{ bi('选读取源，当…', 'Choose a read source when…') }}</strong>
          {{ bi('目标数据一次调用就能取到，不需要先定位一个中间标识。', 'the target data can be fetched in one call, with no need to first resolve an intermediate identifier.') }}
        </li>
        <li>
          <strong>{{ bi('选组合，当…', 'Choose a composition when…') }}</strong>
          {{ bi('必须先定位一个中间标识，再用它取最终数据（两跳链）。', 'you must first resolve an intermediate identifier, then use it to fetch the final data (a two-hop chain).') }}
        </li>
      </ul>
    </el-card>

    <el-card class="integration-help__section" shadow="never" data-testid="help-section-error-codes">
      <h2>{{ bi('错误码对照表', 'Error code reference') }}</h2>
      <p>
        {{ bi(
          '机器码只用于排障；正常使用时页面只展示下表右侧的人话说明。本表由错误码标签模块自动生成——新增/调整标签会自动出现在这里，不需要手改本页。',
          'The raw machine code is only for troubleshooting — normal usage only ever shows the human-readable text on the right. This table is generated automatically from the error-code label module — a future label addition/change appears here with no edits to this page.',
        ) }}
      </p>
      <div class="integration-help__table-wrap">
        <table class="integration-help__table" data-testid="help-error-code-table">
          <thead>
            <tr>
              <th>{{ bi('机器码', 'Code') }}</th>
              <th>{{ bi('说明', 'Meaning') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in errorCodeEntries"
              :key="entry.code"
              :data-testid="`help-error-code-row-${entry.code}`"
            >
              <td><code>{{ entry.code }}</code></td>
              <td>
                <div>{{ bi(entry.zh, entry.en) }}</div>
                <small v-if="entry.hint">{{ bi(entry.hint.zh, entry.hint.en) }}</small>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </el-card>

    <el-card class="integration-help__section" shadow="never" data-testid="help-section-faq">
      <h2>{{ bi('常见排障 FAQ', 'Common troubleshooting FAQ') }}</h2>
      <details
        v-for="(item, index) in faqItems"
        :key="index"
        class="integration-help__faq-item"
        :data-testid="`help-faq-${index}`"
      >
        <summary :data-testid="`help-faq-question-${index}`">{{ bi(item.zhQ, item.enQ) }}</summary>
        <p :data-testid="`help-faq-answer-${index}`">{{ bi(item.zhA, item.enA) }}</p>
      </details>
    </el-card>
  </PageShell>
</template>

<script setup lang="ts">
// IU-6c help center (design-lock docs/development/integration-ux-workbench-redesign-design-lock-20260706.md
// #3739): a read-only reference page for the Data Factory / integration surface. Three sections:
//   1. When to use a read source (single hop) vs. a composition (two hop) — values-free explanation.
//   2. Error-code reference table — SINGLE SOURCE: iterates `integrationErrorCodeEntries()` from the
//      IU-1 label module (errorCodeLabels.ts) rather than copying label text into this view, so a
//      future label addition/removal is reflected here automatically (see integrationHelpView.spec.ts
//      "single-source tripwire": rendered row count === the module's registered code count).
//   3. Common troubleshooting FAQ — distilled from docs/development/integration-composition-entity-e2e-
//      runbook-20260705.md and integration-core-external-api-read-self-service-entity-e2e-runbook-
//      20260702.md (values-free; no real material/BOM numbers, only descriptive placeholders).
// Zero behavior change elsewhere: this view has no service calls, no write path, no permission-gated
// action — it only reads the (already-loaded) label module and renders static, values-free copy.
import { computed } from 'vue'
import { useLocale } from '../composables/useLocale'
import { integrationErrorCodeEntries, type IntegrationErrorCodeEntry } from '../services/integration/errorCodeLabels'
import PageShell from '../components/layout/PageShell.vue'
import PageHeader from '../components/layout/PageHeader.vue'

const { locale } = useLocale()

// Same locale pattern as the rest of the integration surface (errorCodeLabels/fieldHints): reads
// `locale.value` synchronously, safe to call directly from the template.
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

// Single-source (IU-6c hard requirement): NEVER hand-copy label text here — always iterate the
// module's own registered entries so additions/removals need zero edits to this view.
const errorCodeEntries = computed<IntegrationErrorCodeEntry[]>(() => integrationErrorCodeEntries())

type FaqItem = { zhQ: string; enQ: string; zhA: string; enA: string }

// Distilled from the composition entity e2e runbook (20260705) and the external-API read
// self-service entity e2e runbook (20260702) — see module header. Values-free: no real material/BOM
// numbers, only descriptive placeholders (field/code names, never business data).
const faqItems: FaqItem[] = [
  {
    zhQ: '探测返回"未找到目标数据容器"（READ_SOURCE_PROBE_CONTAINER_NOT_FOUND / READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND）怎么办？',
    zhA: '说明容器路径（containerPaths）与目标系统实际返回形状不匹配。先重新运行一次"定位容器探测"确认真实返回结构，再核对/修正 containerPaths；同一模式在不同环境上的真实形状也可能不同，不要凭猜测直接改。',
    enQ: 'The probe returns "container not found" (READ_SOURCE_PROBE_CONTAINER_NOT_FOUND / READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND) — what should I do?',
    enA: 'This means the configured container path does not match the target system\'s actual response shape. Re-run "locate container probe" to confirm the real structure, then check/fix containerPaths — the same mode can return a different shape per environment, so do not guess.',
  },
  {
    zhQ: '一个物料存在多个 BOM，返回"存在多个 BOM"（K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS / READ_SOURCE_RESOLVER_AMBIGUOUS）是 bug 吗？',
    zhA: '不是。这是唯一性策略的正确行为——平台从不按状态 / 版本 / 日期自动选择候选记录，多条候选时会如实报告"存在歧义"，避免静默选错。需要收窄筛选条件，或改用能唯一区分候选记录的解析规则。',
    enQ: 'A material has multiple BOMs and the system reports "ambiguous — multiple BOMs exist" — is this a bug?',
    enA: 'No. This is the uniqueness policy working correctly — the platform never auto-picks a candidate by status / version / date; when more than one row matches, it reports ambiguity instead of silently guessing wrong. Narrow the filter, or use a resolver rule that can uniquely tell the candidates apart.',
  },
  {
    zhQ: '凭证（credentials）在哪里配置？',
    zhA: '凭证在后端注册，不在这个页面填写——读取源配置面板从不展示或保存凭证字段。若运行时报"凭证缺失"类错误，需要请管理员确认该外部系统已在部署环境上登记凭证。',
    enQ: 'Where are credentials configured?',
    enA: 'Credentials are registered on the backend — this page never shows or stores a credential field. If a run fails with a "credentials missing" error, ask an admin to confirm the external system has credentials registered on the deployed environment.',
  },
  {
    zhQ: '保存版本时报 500，是我配置写错了吗？',
    zhA: '大概率不是——先确认数据库迁移已执行到位，这是常见的部署缺口而不是配置错误；确认迁移已跑后再排查配置本身。',
    enQ: 'Save-version returns a 500 error — did I misconfigure something?',
    enA: 'Probably not — first confirm the required database migrations have been applied; a save-version 500 on an un-migrated database is a common deployment gap, not a config mistake. Check the configuration itself only after confirming migrations.',
  },
  {
    zhQ: '组合运行报"该步骤尚未执行"（STEP_NOT_RUN）正常吗？',
    zhA: '正常。这是两跳链路的 fail-closed 设计——任意一跳失败后，后续步骤一律标记为"未执行"，绝不会继续用错误的中间结果往下跑。',
    enQ: 'Is it expected for a composition run to report "step not run" (STEP_NOT_RUN)?',
    enA: 'Yes. This is the two-hop chain\'s fail-closed design — once one hop fails, every step after it is clamped to "not run" rather than continuing with a bad intermediate result.',
  },
  {
    zhQ: '组合运行报通用的"该步骤执行失败"（STEP_FAILED），看不出具体原因怎么办？',
    zhA: '这是一个粗粒度兜底码，可能是系统类型不匹配、凭证缺失或网络错误等多种原因之一。请对比该跳读取源配置的 requiredKind 与已注册外部系统的 kind 是否一致，确认凭证已在该环境注册，也可单独重跑该跳自身的读取来定位问题。',
    enQ: 'A composition run reports the generic "step failed" (STEP_FAILED) with no further detail — what should I check?',
    enA: 'This is a coarse fallback code that can mean a system-kind mismatch, missing credentials, or a network error, among others. Compare that hop\'s requiredKind against the registered external system\'s kind, confirm credentials are registered, and try re-running that hop\'s own standalone read to isolate the problem.',
  },
  {
    zhQ: 'keyField 和 containerPaths 具体是做什么的，为什么保存前必须先探测？',
    zhA: 'keyField 是按业务键定位单条记录的字段名，containerPaths 是数据在返回体中的容器路径；两者都强依赖目标系统的真实返回形状，即使是"已验证"的模式在不同环境上也可能不同，所以必须先跑"定位容器探测"确认真实结构，再保存版本。',
    enQ: 'What are keyField and containerPaths for, and why must I probe before saving?',
    enA: 'keyField names the field used to locate a single record by its business key, and containerPaths is where the data lives inside the response body — both depend on the target system\'s real response shape, which can differ by environment even for an already-verified mode. Always probe first to confirm the real structure before saving.',
  },
]
</script>

<style scoped>
.integration-help__section {
  margin-bottom: var(--ms-space-5);
}
.integration-help__section h2 {
  margin: 0 0 var(--ms-space-3);
  font-size: var(--ms-font-size-section-title);
  color: var(--ms-text-1);
}
.integration-help__section p {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  line-height: 1.6;
}
.integration-help__compare-list {
  margin: 0;
  padding-left: var(--ms-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}
.integration-help__compare-list strong {
  margin-right: var(--ms-space-2);
  color: var(--ms-text-1);
}
.integration-help__table-wrap {
  overflow-x: auto;
}
.integration-help__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.integration-help__table th,
.integration-help__table td {
  border-bottom: 1px solid var(--ms-border-light);
  padding: var(--ms-space-2) var(--ms-space-3);
  text-align: left;
  vertical-align: top;
}
.integration-help__table small {
  display: block;
  margin-top: var(--ms-space-1);
  color: var(--ms-text-3);
}
.integration-help__faq-item {
  padding: var(--ms-space-2) 0;
  border-bottom: 1px solid var(--ms-border-light);
}
.integration-help__faq-item:last-child {
  border-bottom: none;
}
.integration-help__faq-item summary {
  cursor: pointer;
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
}
.integration-help__faq-item p {
  margin: var(--ms-space-2) 0 0;
  color: var(--ms-text-2);
  line-height: 1.6;
}
</style>
