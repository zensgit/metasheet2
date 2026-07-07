// Integration error-code humanization (IU-1, design-lock
// docs/development/integration-ux-workbench-redesign-design-lock-20260706.md, #3739).
//
// Scope: a values-free, exact-key lookup from a closed-ish set of integration error CODES to a
// human-readable {zh, en} label (+ optional hint). This module never touches raw backend `errorMessage`
// free text — that channel is NOT safe to render (it can carry secret-shaped values scrubbed only at
// dead-letter write time, see plugin-integration-core/lib/dead-letter.cjs scrubSecretStringValue). Codes,
// by contrast, are drawn from a small registered vocabulary and are safe to show even when unlabeled here
// (the raw code, never the message, may still appear in a secondary/collapsed "expert" slot at call sites).
//
// Lookup is EXACT-KEY ONLY (plain object own-key access) — never a prefix/regex match. An enum-SHAPED
// string that is not itself a registered key (e.g. a future code this module hasn't caught up to yet)
// must resolve to `null` from `integrationErrorCodeLabel`, never a guessed label.
//
// Source of truth for each family (verify current spelling against these files before extending):
//   - Resolver (9) / Probe (11): apps/web/src/services/integration/readSourceConfigs.ts
//     RESOLVER_ERROR_CODES / READ_SOURCE_PROBE_ERROR_CODES (client mirrors of
//     plugins/plugin-integration-core/lib/read-source-probe-contract.cjs).
//   - Composition (8): apps/web/src/services/integration/readSourceCompositions.ts
//     COMPOSITION_PLAN_ERROR_CODES (client mirror of
//     plugins/plugin-integration-core/lib/read-source-composition-planner.cjs
//     READ_SOURCE_COMPOSITION_PLAN_ERROR_CODES).
//   - K3 WISE BOM-list-by-material (8): plugins/plugin-integration-core/lib/
//     read-source-bom-list-by-material-contract.cjs K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES.
//     NOT YET WIRED to any UI display site (no BOM-list-by-material UI exists yet as of IU-1) — labeled
//     here for completeness/future use per design-lock IU-1 scope. Mirrored locally (below) rather than
//     added to readSourceConfigs.ts, since nothing there references it today.
//   - Dead-letter mainline (10): plugins/plugin-integration-core/lib/pipeline-runner.cjs (the mainline
//     pipeline path) plus generic fallbacks used there and in external-write-dry-run.cjs. Dead-letter
//     `errorCode` is fed from multiple origins and is NOT one closed server-exported array, so only the
//     known mainline + generic-fallback codes are labeled; anything else falls back to the generic
//     unknown label via `integrationErrorCodeDisplayLabel`.
//
// Deliberately NOT labeled here: the C6 external-write-specific `SAFE_WRITE_ERROR_CODES` set in
// plugins/plugin-integration-core/lib/external-write-dry-run.cjs (AdapterValidationError,
// DATA_SOURCE_*, DataSource*Error, DUPLICATE_KEY, and the test-injection code). Those belong to the
// still-W1-gated external-write self-service ladder, not the mainline read/monitor flow this slice
// touches — inventing zh/en semantics for a not-yet-shipped write surface would be scope creep.

import type { AppLocale } from '../../composables/useLocale'

export type IntegrationErrorLabel = {
  zh: string
  en: string
  hint?: { zh: string; en: string }
}

// K3 WISE BOM-list-by-material — local mirror of the server's closed vocabulary. Not referenced by
// readSourceConfigs.ts (nothing there consumes it yet); kept here only so this module's coverage is
// complete. See module header for rationale.
export const K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES = [
  'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_CONFIGURED',
  'K3_WISE_BOM_LIST_BY_MATERIAL_KEY_INVALID',
  'K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED',
  'K3_WISE_BOM_LIST_BY_MATERIAL_FAILED',
  'K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH',
  'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_FOUND',
  'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS',
  'K3_WISE_BOM_LIST_BY_MATERIAL_FIELD_MISSING',
] as const

// Dead-letter "known mainline" codes — not a single server-exported array (dead-letter `errorCode` is
// fed from multiple pipeline stages), so this is a hand-curated list of the known mainline + generic
// fallback codes only. See module header.
export const DEAD_LETTER_MAINLINE_ERROR_CODES = [
  'INVALID_SOURCE_RECORD',
  'TRANSFORM_FAILED',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_FAILED',
  'TARGET_PREVIEW_FAILED',
  'TARGET_WRITE_FAILED',
  'TARGET_WRITE_UNMATCHED_ERROR',
  'TARGET_WRITE_AGGREGATE_FAILED',
  'WRITE_FAILED',
  'UNKNOWN_ERROR',
] as const

export type IntegrationErrorCode =
  // Resolver (9)
  | 'READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND'
  | 'READ_SOURCE_RESOLVER_SHAPE_MISMATCH'
  | 'READ_SOURCE_RESOLVER_NO_MATCH'
  | 'READ_SOURCE_RESOLVER_AMBIGUOUS'
  | 'READ_SOURCE_RESOLVER_CAP_REACHED'
  | 'READ_SOURCE_RESOLVER_RULE_NOT_SUPPORTED'
  | 'READ_SOURCE_RESOLVER_RULE_INVALID'
  | 'READ_SOURCE_RESOLVER_FIELD_MISSING'
  | 'READ_SOURCE_RESOLVER_FAILED'
  // Probe (11 own; union with resolver = 20)
  | 'READ_SOURCE_PROBE_CONTRACT_INVALID'
  | 'READ_SOURCE_PROBE_FAILED'
  | 'READ_SOURCE_PROBE_AUTH_FAILED'
  | 'READ_SOURCE_PROBE_CAP_REACHED'
  | 'READ_SOURCE_PROBE_CONFIG_INVALID'
  | 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND'
  | 'READ_SOURCE_PROBE_NETWORK_FAILED'
  | 'READ_SOURCE_PROBE_REJECTED'
  | 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED'
  | 'READ_SOURCE_PROBE_SHAPE_MISMATCH'
  | 'READ_SOURCE_PROBE_TIMEOUT'
  // Composition (8)
  | 'READ_SOURCE_COMPOSITION_PLAN_INVALID'
  | 'READ_SOURCE_COMPOSITION_STEP_ORDINAL_INVALID'
  | 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING'
  | 'READ_SOURCE_COMPOSITION_HANDOFF_TARGET_MISMATCH'
  | 'READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID'
  | 'READ_SOURCE_COMPOSITION_STEP_FAILED'
  | 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN'
  | 'READ_SOURCE_COMPOSITION_STEP_OUTPUT_NOT_SCALAR'
  // K3 WISE BOM-list-by-material (8) — see K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES above
  | (typeof K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES)[number]
  // Dead-letter known mainline (10) — see DEAD_LETTER_MAINLINE_ERROR_CODES above
  | (typeof DEAD_LETTER_MAINLINE_ERROR_CODES)[number]

// Exported (IU-6c, design-lock §2 IU-6c): the help-center error-code table renders straight off this
// map so a future label addition/removal shows up there automatically — SINGLE SOURCE, no copy-paste.
export const INTEGRATION_ERROR_CODE_LABELS: Record<IntegrationErrorCode, IntegrationErrorLabel> = {
  // --- Resolver (9) ---
  READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND: {
    zh: '未找到用于解析的数据容器',
    en: 'The data container used for resolving could not be found.',
  },
  READ_SOURCE_RESOLVER_SHAPE_MISMATCH: {
    zh: '数据形状与解析规则不匹配',
    en: 'The data shape does not match the resolver rule.',
  },
  READ_SOURCE_RESOLVER_NO_MATCH: {
    zh: '未匹配到符合条件的记录',
    en: 'No record matched the resolver rule.',
    hint: { zh: '请检查筛选条件是否过窄', en: 'Check whether the filter is too narrow.' },
  },
  READ_SOURCE_RESOLVER_AMBIGUOUS: {
    zh: '匹配到多条记录，无法唯一确定',
    en: 'Multiple records matched; the result is ambiguous.',
    hint: {
      zh: '请收窄筛选条件或改用唯一性字段',
      en: 'Narrow the filter or use a field that uniquely identifies the record.',
    },
  },
  READ_SOURCE_RESOLVER_CAP_REACHED: {
    zh: '候选记录数超过处理上限',
    en: 'The number of candidate records exceeded the processing cap.',
    hint: { zh: '请收窄筛选范围', en: 'Narrow the filter scope.' },
  },
  READ_SOURCE_RESOLVER_RULE_NOT_SUPPORTED: {
    zh: '该解析规则暂不支持',
    en: 'This resolver rule is not supported.',
  },
  READ_SOURCE_RESOLVER_RULE_INVALID: {
    zh: '解析规则配置无效',
    en: 'The resolver rule configuration is invalid.',
  },
  READ_SOURCE_RESOLVER_FIELD_MISSING: {
    zh: '解析规则所需字段缺失',
    en: 'A field required by the resolver rule is missing.',
  },
  READ_SOURCE_RESOLVER_FAILED: {
    zh: '解析执行失败',
    en: 'Resolver execution failed.',
  },

  // --- Probe (11) ---
  READ_SOURCE_PROBE_CONTRACT_INVALID: {
    zh: '读取源配置不符合契约要求',
    en: 'The read-source configuration does not satisfy the contract.',
  },
  READ_SOURCE_PROBE_FAILED: {
    zh: '探测执行失败',
    en: 'The probe run failed.',
  },
  READ_SOURCE_PROBE_AUTH_FAILED: {
    zh: '连接鉴权失败',
    en: 'Authentication to the source failed.',
    hint: { zh: '请检查连接凭据是否有效', en: 'Check whether the connection credentials are still valid.' },
  },
  READ_SOURCE_PROBE_CAP_REACHED: {
    zh: '探测数据量超过上限',
    en: 'The probed data volume exceeded the cap.',
  },
  READ_SOURCE_PROBE_CONFIG_INVALID: {
    zh: '读取源配置无效',
    en: 'The read-source configuration is invalid.',
  },
  READ_SOURCE_PROBE_CONTAINER_NOT_FOUND: {
    zh: '未找到目标数据容器',
    en: 'The target data container could not be found.',
    hint: { zh: '请检查容器/表名是否正确', en: 'Check that the container or table name is correct.' },
  },
  READ_SOURCE_PROBE_NETWORK_FAILED: {
    zh: '网络连接失败',
    en: 'The network connection failed.',
    hint: {
      zh: '请检查网络与目标地址是否可达',
      en: 'Check network connectivity and that the target address is reachable.',
    },
  },
  READ_SOURCE_PROBE_REJECTED: {
    zh: '目标系统拒绝了本次探测请求',
    en: 'The target system rejected the probe request.',
  },
  READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED: {
    zh: '目标系统返回的数据格式无法识别',
    en: 'The response returned by the target system was not recognized.',
  },
  READ_SOURCE_PROBE_SHAPE_MISMATCH: {
    zh: '返回数据的形状与预期不符',
    en: 'The returned data shape did not match what was expected.',
  },
  READ_SOURCE_PROBE_TIMEOUT: {
    zh: '探测请求超时',
    en: 'The probe request timed out.',
    hint: { zh: '可稍后重试或缩小探测范围', en: 'Retry later or narrow the probe scope.' },
  },

  // --- Composition (8) ---
  READ_SOURCE_COMPOSITION_PLAN_INVALID: {
    zh: '组合链配置无效',
    en: 'The composition chain configuration is invalid.',
  },
  READ_SOURCE_COMPOSITION_STEP_ORDINAL_INVALID: {
    zh: '组合链步骤顺序无效',
    en: 'The composition step ordering is invalid.',
  },
  READ_SOURCE_COMPOSITION_HANDOFF_VALUE_MISSING: {
    zh: '上一步输出值缺失，无法传递到下一步',
    en: "The previous step's output value is missing, so it cannot be passed to the next step.",
  },
  READ_SOURCE_COMPOSITION_HANDOFF_TARGET_MISMATCH: {
    zh: '上一步输出与下一步输入字段不匹配',
    en: "The previous step's output does not match the next step's expected input field.",
  },
  READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID: {
    zh: '传递到下一步的值格式无效',
    en: 'The value passed to the next step has an invalid format.',
  },
  READ_SOURCE_COMPOSITION_STEP_FAILED: {
    zh: '组合链某一步执行失败',
    en: 'A step in the composition chain failed.',
  },
  READ_SOURCE_COMPOSITION_STEP_NOT_RUN: {
    zh: '该步骤尚未执行',
    en: 'This step has not been run yet.',
  },
  READ_SOURCE_COMPOSITION_STEP_OUTPUT_NOT_SCALAR: {
    zh: '该步骤输出不是单一值，无法用于下一步',
    en: "This step's output is not a single scalar value, so it cannot feed the next step.",
  },

  // --- K3 WISE BOM-list-by-material (8) — NOT yet wired to any UI display site ---
  K3_WISE_BOM_LIST_BY_MATERIAL_NOT_CONFIGURED: {
    zh: '该能力尚未配置',
    en: 'This capability has not been configured.',
  },
  K3_WISE_BOM_LIST_BY_MATERIAL_KEY_INVALID: {
    zh: '物料内码必须是纯数字',
    en: 'The material internal code must be a numeric string.',
  },
  K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED: {
    zh: '目标系统拒绝了本次请求',
    en: 'The target system rejected the request.',
  },
  K3_WISE_BOM_LIST_BY_MATERIAL_FAILED: {
    zh: '查询执行失败',
    en: 'The query failed to execute.',
  },
  K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH: {
    zh: '返回数据的形状与预期不符',
    en: 'The returned data shape did not match what was expected.',
  },
  K3_WISE_BOM_LIST_BY_MATERIAL_NOT_FOUND: {
    zh: '未找到该物料的 BOM',
    en: 'No BOM was found for this material.',
  },
  K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS: {
    zh: '该物料存在多个 BOM，按唯一性策略未自动选择',
    en: 'Multiple BOMs exist for this material; the uniqueness policy did not auto-select one.',
    hint: {
      zh: '可提供单一 BOM 的样例，或增加版本等筛选条件',
      en: 'Provide a sample with a single BOM, or add a version filter to narrow the match.',
    },
  },
  K3_WISE_BOM_LIST_BY_MATERIAL_FIELD_MISSING: {
    zh: '所需字段缺失',
    en: 'A required field is missing.',
  },

  // --- Dead-letter known mainline (10) ---
  INVALID_SOURCE_RECORD: {
    zh: '源记录格式不符合要求',
    en: 'The source record does not meet the required format.',
  },
  TRANSFORM_FAILED: {
    zh: '数据转换失败',
    en: 'Data transformation failed.',
  },
  VALIDATION_FAILED: {
    zh: '数据校验未通过',
    en: 'Data validation failed.',
  },
  IDEMPOTENCY_FAILED: {
    zh: '幂等键处理失败',
    en: 'Idempotency-key handling failed.',
  },
  TARGET_PREVIEW_FAILED: {
    zh: '目标预览生成失败',
    en: 'Generating the target preview failed.',
  },
  TARGET_WRITE_FAILED: {
    zh: '写入目标系统失败',
    en: 'Writing to the target system failed.',
  },
  TARGET_WRITE_UNMATCHED_ERROR: {
    zh: '写入失败，且无法归属到具体记录',
    en: 'The write failed and could not be attributed to a specific record.',
  },
  TARGET_WRITE_AGGREGATE_FAILED: {
    zh: '批量写入中有记录未逐条归因失败原因',
    en: 'Some records in the batch write failed without a per-record reason.',
  },
  WRITE_FAILED: {
    zh: '写入失败',
    en: 'The write failed.',
  },
  UNKNOWN_ERROR: {
    zh: '发生未知错误',
    en: 'An unknown error occurred.',
  },
}

/**
 * Exact-key lookup ONLY (own-key access on a plain object — no prefix/regex matching). Returns `null`
 * for anything not an exact registered key, including enum-SHAPED strings this module hasn't caught up
 * to (e.g. a new server-side code not yet mirrored here).
 */
export function integrationErrorCodeLabel(
  code: string | undefined | null,
  locale: AppLocale,
): IntegrationErrorLabel | null {
  if (!code) return null
  if (!Object.prototype.hasOwnProperty.call(INTEGRATION_ERROR_CODE_LABELS, code)) return null
  const entry = INTEGRATION_ERROR_CODE_LABELS[code as IntegrationErrorCode]
  // The returned label always carries BOTH zh/en text — locale selection happens in the
  // display-string helper below (`integrationErrorCodeDisplayLabel`), so this raw lookup stays
  // locale-agnostic. `locale` is accepted here only to keep the call sites consistent (and to leave
  // room for locale-specific label variants later without a signature change).
  void locale
  return {
    zh: entry.zh,
    en: entry.en,
    ...(entry.hint ? { hint: entry.hint } : {}),
  }
}

// Generic-unknown "prominent slot" copy — never the raw code, never a raw message.
const INTEGRATION_UNKNOWN_ERROR_CODE_LABEL: { zh: string; en: string } = {
  zh: '未知错误',
  en: 'Unknown error',
}

/**
 * The single string to render in the PROMINENT position: the registered label's zh/en text for a known
 * code, or the generic unknown-error text for anything not registered (never the raw code, never the
 * raw message).
 */
export function integrationErrorCodeDisplayLabel(
  code: string | undefined | null,
  locale: AppLocale,
): string {
  const label = integrationErrorCodeLabel(code, locale)
  const isZh = locale === 'zh-CN'
  if (!label) return isZh ? INTEGRATION_UNKNOWN_ERROR_CODE_LABEL.zh : INTEGRATION_UNKNOWN_ERROR_CODE_LABEL.en
  return isZh ? label.zh : label.en
}

/** The hint text (if any) for a registered code, in the given locale — `null` when absent/unregistered. */
export function integrationErrorCodeHint(
  code: string | undefined | null,
  locale: AppLocale,
): string | null {
  const label = integrationErrorCodeLabel(code, locale)
  if (!label?.hint) return null
  return locale === 'zh-CN' ? label.hint.zh : label.hint.en
}

export type IntegrationErrorCodeEntry = { code: IntegrationErrorCode } & IntegrationErrorLabel

/**
 * All registered codes as a flat, display-ready array — the single-source feed for the IU-6c help
 * center's error-code table. Iterates `INTEGRATION_ERROR_CODE_LABELS`'s own keys ONLY (no server call,
 * no duplication of the label text), so any future addition/removal to that map is reflected here with
 * zero further edits. Order matches declaration order in the map (grouped by family, per the module
 * header's family list).
 */
export function integrationErrorCodeEntries(): IntegrationErrorCodeEntry[] {
  return (Object.keys(INTEGRATION_ERROR_CODE_LABELS) as IntegrationErrorCode[]).map((code) => ({
    code,
    ...INTEGRATION_ERROR_CODE_LABELS[code],
  }))
}
