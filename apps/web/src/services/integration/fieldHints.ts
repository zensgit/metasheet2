// Integration field-level hints (IU-6b, design-lock
// docs/development/integration-ux-workbench-redesign-design-lock-20260706.md, #3739).
//
// Scope: a values-free, exact-key lookup from a field-hint KEY (one per highest-confusion field in
// the read-source config panel and the read-source composition authoring panel) to a one-sentence
// {zh, en} tooltip copy. Same shape/discipline as ../errorCodeLabels.ts:
//   - EXACT-KEY ONLY lookup (plain object own-key access, typed key union — no runtime string keys
//     from outside this module's own call sites reach the lookup).
//   - values-free: no real business values (material numbers, BOM numbers, etc.) ever appear in the
//     copy — only descriptive placeholders/field-name examples that are themselves not business data
//     (e.g. a field NAME like "the sort field" is fine; a business VALUE like an actual material
//     number is not, and none appear here).
//   - one sentence per entry, zh + en, non-empty.
//
// Consumed by:
//   - IntegrationReadSourceConfigPanel.vue (readSource.* keys) via el-tooltip on the highest-confusion
//     field labels.
//   - IntegrationReadSourceCompositionAuthoringPanel.vue (composition.* keys) via el-tooltip on the
//     two-hop step-wiring fields.
//   - IntegrationHelpView.vue does NOT consume this module directly (its scope is the error-code
//     table + FAQ, not field hints) — kept separate so IU-2's restructure can re-consume this module
//     without pulling in help-center-specific content.
//
// This module is a pure data + lookup layer: no Vue imports, no DOM, so it stays trivially reusable
// by IU-2's restructured panels without carrying any component dependency.

import type { AppLocale } from '../../composables/useLocale'

export type IntegrationFieldHintKey =
  // --- read-source config panel ---
  | 'readSource.requiredKind'
  | 'readSource.mode'
  | 'readSource.readPath'
  | 'readSource.keyField'
  | 'readSource.keyEncoding'
  | 'readSource.resolverRule'
  | 'readSource.resolverSortField'
  | 'readSource.resolverSortDirection'
  | 'readSource.resolverDiscriminatorField'
  | 'readSource.resolverDiscriminatorValue'
  | 'readSource.containerPaths'
  | 'readSource.headerContainerPaths'
  | 'readSource.lineContainerPaths'
  | 'readSource.fieldMap'
  | 'readSource.boundedSmoke'
  // --- read-source composition authoring panel ---
  | 'composition.step1ConfigId'
  | 'composition.step2ConfigId'
  | 'composition.name'
  | 'composition.sourceTarget'

export type IntegrationFieldHintEntry = { zh: string; en: string }

export const INTEGRATION_FIELD_HINTS: Record<IntegrationFieldHintKey, IntegrationFieldHintEntry> = {
  'readSource.requiredKind': {
    zh: '由所选外部系统自动带出，决定该读取源允许消费的系统类型；此处只读，不能手填。',
    en: 'Auto-filled from the selected external system; determines which system kind this read source may consume, and is read-only here.',
  },
  'readSource.mode': {
    zh: '四种读取模式各自对应不同的返回形状：单条记录、列表分页、主从明细、或按规则解析定位单条记录。',
    en: 'Each of the four read modes expects a different response shape: a single record, a paged list, a header-with-lines detail, or a rule-resolved single record.',
  },
  'readSource.readPath': {
    zh: '只能是相对路径，不允许绝对地址、百分号编码或路径穿越片段；平台会拼接到已配置的连接基址上。',
    en: 'Must be a relative path only — absolute URLs, percent-encoding, and path-traversal segments are rejected; the platform appends it to the already-configured connection base.',
  },
  'readSource.keyField': {
    zh: '用于按业务键定位单条记录的字段名；仅在单条记录或解析类模式下需要，不是记录的值本身。',
    en: 'The field name used to locate a single record by its business key; needed only for single-record or resolver modes — it names the field, not a record value.',
  },
  'readSource.keyEncoding': {
    zh: '可选：声明业务键在发往目标系统前需要的编码方式；不指定则按原样传递。',
    en: 'Optional: declares how the business key must be encoded before being sent to the target system; unspecified means it is passed through as-is.',
  },
  'readSource.resolverRule': {
    zh: '候选记录多于一条时的取舍策略：唯一命中要求恰好一条、排序取首按字段排序后取第一条、判别字段相等按固定值筛选。',
    en: 'The tie-break strategy when more than one candidate record matches: exactly-one requires a single hit, sorted-first picks the first row after sorting by a field, and field-equals filters by a fixed discriminator value.',
  },
  'readSource.resolverSortField': {
    zh: '排序取首规则使用的排序字段名；决定多条候选记录中哪一条排在最前。',
    en: 'The field name the sorted-first rule sorts by; determines which of several candidate records is treated as first.',
  },
  'readSource.resolverSortDirection': {
    zh: '排序方向：升序取最小值那条，降序取最大值那条。',
    en: 'Sort direction: ascending picks the smallest-value row, descending picks the largest-value row.',
  },
  'readSource.resolverDiscriminatorField': {
    zh: '判别字段相等规则用来比较的字段名，例如标记"当前有效版本"的字段。',
    en: 'The field name the field-equals rule compares, such as a field that flags the currently-effective version.',
  },
  'readSource.resolverDiscriminatorValue': {
    zh: '判别字段需要等于的固定值；一个有界的枚举样 token，不是任意自由文本。',
    en: 'The fixed value the discriminator field must equal; a bounded enum-shaped token, not free-form text.',
  },
  'readSource.containerPaths': {
    zh: '响应体中数据数组所在的点号路径，可填多个候选路径，命中第一个存在的即可。',
    en: 'The dot-notation path to the data array inside the response body; multiple candidate paths may be listed, and the first one that exists is used.',
  },
  'readSource.headerContainerPaths': {
    zh: '主从明细模式下，表头（主记录）所在的容器路径。',
    en: 'In header-with-lines mode, the container path where the header (parent record) lives.',
  },
  'readSource.lineContainerPaths': {
    zh: '主从明细模式下，明细行数组所在的容器路径。',
    en: 'In header-with-lines mode, the container path where the line-item array lives.',
  },
  'readSource.fieldMap': {
    zh: '把响应字段路径映射到清洗后的列名；只保存字段名对应关系，不经过这里读取或展示任何行值。',
    en: 'Maps a response field path to a cleansed column name; only the field-name mapping is stored here — no row value ever passes through this control.',
  },
  'readSource.boundedSmoke': {
    zh: '勾选后探测会额外拉取受平台上限约束的少量样本行，用于验证形状；不勾选只验证容器是否存在。',
    en: 'When checked, the probe also fetches a small, platform-capped sample of rows to verify shape; unchecked, it only verifies that the container exists.',
  },
  'composition.step1ConfigId': {
    zh: '两跳组合的第一跳：必须是已审批的"解析定位"类读取源，其输出将交给第二跳作为业务键。',
    en: 'The first hop of the two-hop composition: must be an approved resolver-lookup read source whose output is handed to the second hop as its business key.',
  },
  'composition.step2ConfigId': {
    zh: '两跳组合的第二跳：同样必须是已审批的"解析定位"类读取源，接收第一跳的输出值。',
    en: 'The second hop of the two-hop composition: also must be an approved resolver-lookup read source, and it receives the first hop\'s output value.',
  },
  'composition.name': {
    zh: '组合的可读标识符，仅用于在列表中区分不同组合，不影响运行逻辑。',
    en: 'A human-readable identifier for the composition, used only to tell compositions apart in lists — it does not affect run behavior.',
  },
  'composition.sourceTarget': {
    zh: '第一跳输出字段名，将作为第二跳读取源的业务键输入；两跳之间的交接完全由平台完成，不经过浏览器。',
    en: "The first hop's output field name, used as the business-key input to the second hop's read source; the handoff between hops happens entirely on the platform, never through the browser.",
  },
}

/**
 * Exact-key lookup (typed key union, own-key access). Every `IntegrationFieldHintKey` is guaranteed
 * present in `INTEGRATION_FIELD_HINTS` at compile time, so this never needs an "unknown key" fallback
 * the way `integrationErrorCodeLabel` does for server-sourced codes.
 */
export function integrationFieldHint(key: IntegrationFieldHintKey, locale: AppLocale): string {
  const entry = INTEGRATION_FIELD_HINTS[key]
  return locale === 'zh-CN' ? entry.zh : entry.en
}
