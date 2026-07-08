// Bridge Agent config validation + change-suggestion checklist (BA-UI-3, design-lock
// docs/development/bridge-agent-admin-page-design-lock-20260707.md §3 BA-UI-3) + BA-APPLY-1's
// machine-readable implementation-checklist export (design-lock
// docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2 形态 A). Predecessors:
// BA-UI-1 (#3824, observability) + BA-UI-2 (#3840, values-free probe). This slice is READ-ONLY +
// SUGGESTIONS/EXPORT ONLY — no controlled apply, no backend write, no Agent write (lock §3 / BA-APPLY
// lock §1-§2: "由受控后端或运维脚本应用" — the controlled backend or an ops script applies any change,
// never this page).
//
// Pure, framework-free module: no Vue import, no DOM, no `fetch`/apiFetch. Three independent surfaces:
//
//   1. computeBridgeAgentConfigCheck(input) — a fixed 6-item values-free checklist over a bridge-agent
//      system's PUBLIC config (the same `system.config` shape BA-UI-1 already receives on the wire —
//      server-redacted via sanitizeIntegrationPayload, see plugins/plugin-integration-core/lib/
//      external-systems.cjs rowToPublicExternalSystem) plus the already-fetched /objects name list.
//      Every check reads specific KEY NAMES for PRESENCE/SHAPE only; no config VALUE is ever placed
//      into an output field — every item's `labelKey` is a fixed, non-interpolated string looked up in
//      BRIDGE_AGENT_CONFIG_CHECK_LABELS below. (The one exception: `config.baseUrl`/`bridgeUrl`/`url`
//      is parsed internally, via `new URL()`, purely to test whether its HOSTNAME is loopback-shaped —
//      the parsed value itself never escapes that boolean test.)
//
//   2. buildBridgeAgentChangeSuggestion(drafts, locale, targetLabel?) — given OPERATOR-SPECIFIED new
//      object/field-KEY names (never values — the operator is naming things to add, the same trust
//      boundary BA-UI-1 already extends to `system.name`), renders a values-free, copyable "变更建议 /
//      实施清单" string an admin can hand to the controlled backend or the existing
//      scripts/ops/bridge-agent-readonly.ps1 script. Every candidate name is checked against a safe
//      identifier pattern (mirrors bridge-agent-readonly-adapter.cjs's SAFE_OBJECT_NAME_PATTERN) —
//      anything not identifier-shaped (contains `=`, `;`, `:`, `.`, whitespace, etc. — exactly the
//      shapes a secret, connection string, or host would carry) is dropped and only COUNTED, never
//      echoed, so a stray secret-shaped string pasted into a name field can never ride along into the
//      generated text.
//
//   3. buildImplementationChecklist(drafts) — BA-APPLY-1: the SAME safe-identifier gate (shared helper
//      `filterSafeSuggestionDrafts`, used by both #2 and #3) applied to the same OPERATOR-SPECIFIED
//      drafts, rendered as a fixed-schema, machine-readable object (`{ schemaVersion, operations }`)
//      instead of prose — object names, field-key names, and a closed operation enum only, never a
//      value/host/credential/free-form string. This is an EXPORT/render only: apply is a later,
//      unopened rung (BA-APPLY-2+).

import type { AppLocale } from '../../composables/useLocale'

// --- shared helpers ------------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

// #### 1. Config checklist ##########################################################################

export type BridgeAgentConfigCheckStatus = 'pass' | 'warn' | 'fail'

export type BridgeAgentConfigCheckItemId =
  | 'requiredFields'
  | 'limits'
  | 'authMode'
  | 'localhostBoundary'
  | 'rawSqlForbidden'
  | 'objectAllowlist'

export type BridgeAgentConfigCheckLabelKey =
  | 'requiredFields.present'
  | 'requiredFields.missing'
  | 'limits.pass'
  | 'limits.fail'
  | 'authMode.declared'
  | 'authMode.undeclared'
  | 'localhostBoundary.pass'
  | 'localhostBoundary.unknown'
  | 'localhostBoundary.fail'
  | 'rawSqlForbidden.pass'
  | 'rawSqlForbidden.fail'
  | 'objectAllowlist.complete'
  | 'objectAllowlist.partial'
  | 'objectAllowlist.empty'

export interface BridgeAgentConfigCheckItem {
  id: BridgeAgentConfigCheckItemId
  status: BridgeAgentConfigCheckStatus
  labelKey: BridgeAgentConfigCheckLabelKey
}

export interface BridgeAgentConfigCheckInput {
  // The system's PUBLIC config (already server-redacted; see module header). May be absent/null.
  config?: Record<string, unknown> | null
  // Object NAMES only, from the already-fetched /objects list — never a full object/schema payload.
  objectNames?: string[] | null
}

// Values-free, exact-key label map — same shape/discipline as errorCodeLabels.ts / fieldHints.ts.
// Every entry is a fixed, non-interpolated sentence: no config value, host, or object/field name is
// ever substituted into these strings.
export const BRIDGE_AGENT_CONFIG_CHECK_LABELS: Record<BridgeAgentConfigCheckLabelKey, { zh: string; en: string }> = {
  'requiredFields.present': {
    zh: '必填连接字段已配置（baseUrl / bridgeUrl / url 之一）。',
    en: 'A required connection field is configured (one of baseUrl / bridgeUrl / url).',
  },
  'requiredFields.missing': {
    zh: '缺少必填连接字段：未找到 baseUrl / bridgeUrl / url。',
    en: 'A required connection field is missing: no baseUrl / bridgeUrl / url was found.',
  },
  'limits.pass': {
    zh: 'sampleLimit / maxLimit 未配置或在合理范围内。',
    en: 'sampleLimit / maxLimit are unset or within a sane range.',
  },
  'limits.fail': {
    zh: 'sampleLimit / maxLimit 配置无效，或超出允许范围。',
    en: 'sampleLimit / maxLimit are invalid, or exceed the allowed range.',
  },
  'authMode.declared': {
    zh: '已显式声明 auth mode。',
    en: 'An auth mode is explicitly declared.',
  },
  'authMode.undeclared': {
    zh: '未显式声明 auth mode，将按隐式默认行为处理。',
    en: 'No auth mode is explicitly declared; the implicit default behavior applies.',
  },
  'localhostBoundary.pass': {
    zh: '连接地址的形状是本机回环地址（127.0.0.1 / localhost）。',
    en: 'The connection address is loopback-shaped (127.0.0.1 / localhost).',
  },
  'localhostBoundary.unknown': {
    zh: '缺少连接地址，暂无法核实本机边界。',
    en: 'No connection address is present, so the localhost boundary cannot be verified yet.',
  },
  'localhostBoundary.fail': {
    zh: '连接地址的形状不是本机回环地址。',
    en: 'The connection address is not loopback-shaped.',
  },
  'rawSqlForbidden.pass': {
    zh: '配置中未出现 raw SQL 相关键。',
    en: 'No raw-SQL-shaped key is present in the config.',
  },
  'rawSqlForbidden.fail': {
    zh: '配置中出现了 raw SQL 相关键，应予以移除。',
    en: 'A raw-SQL-shaped key is present in the config and should be removed.',
  },
  'objectAllowlist.complete': {
    zh: '预期的 material / bom / bom_child 风格对象均已出现在 allowlist 中。',
    en: 'The expected material / bom / bom_child-style objects are all present in the allowlist.',
  },
  'objectAllowlist.partial': {
    zh: '部分预期对象尚未出现在 allowlist 中。',
    en: 'Some expected objects are not yet present in the allowlist.',
  },
  'objectAllowlist.empty': {
    zh: 'allowlist 当前为空，暂无法评估完整性。',
    en: 'The allowlist is currently empty, so completeness cannot be assessed yet.',
  },
}

export function bridgeAgentConfigCheckLabel(labelKey: BridgeAgentConfigCheckLabelKey, locale: AppLocale): string {
  const entry = BRIDGE_AGENT_CONFIG_CHECK_LABELS[labelKey]
  return locale === 'zh-CN' ? entry.zh : entry.en
}

// Mirrors bridge-agent-readonly-adapter.cjs's normalizeBaseUrl() input precedence.
function firstBaseUrlLike(config: Record<string, unknown>): string | null {
  if (isNonEmptyString(config.baseUrl)) return config.baseUrl
  if (isNonEmptyString(config.bridgeUrl)) return config.bridgeUrl
  if (isNonEmptyString(config.url)) return config.url
  return null
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

// Returns a boolean ONLY — the parsed URL/hostname is never retained past this call.
function isLoopbackBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function requiredFieldsCheck(config: Record<string, unknown>): BridgeAgentConfigCheckItem {
  return firstBaseUrlLike(config)
    ? { id: 'requiredFields', status: 'pass', labelKey: 'requiredFields.present' }
    : { id: 'requiredFields', status: 'fail', labelKey: 'requiredFields.missing' }
}

// Mirrors bridge-agent-readonly-adapter.cjs's normalizeLimits() defaults/ceiling.
const DEFAULT_SAMPLE_LIMIT = 3
const DEFAULT_MAX_LIMIT = 20
const MAX_ADAPTER_LIMIT = 500

function isConfiguredPositiveInteger(value: unknown): boolean {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric > 0
}

function limitsCheck(config: Record<string, unknown>): BridgeAgentConfigCheckItem {
  const sampleRaw = config.sampleLimit
  const maxRaw = config.maxLimit
  const sampleConfigured = sampleRaw !== undefined && sampleRaw !== null && sampleRaw !== ''
  const maxConfigured = maxRaw !== undefined && maxRaw !== null && maxRaw !== ''

  if (sampleConfigured && !isConfiguredPositiveInteger(sampleRaw)) {
    return { id: 'limits', status: 'fail', labelKey: 'limits.fail' }
  }
  if (maxConfigured && !isConfiguredPositiveInteger(maxRaw)) {
    return { id: 'limits', status: 'fail', labelKey: 'limits.fail' }
  }

  const effectiveSample = sampleConfigured ? Number(sampleRaw) : DEFAULT_SAMPLE_LIMIT
  const effectiveMax = maxConfigured ? Number(maxRaw) : DEFAULT_MAX_LIMIT

  if (effectiveSample > effectiveMax) {
    return { id: 'limits', status: 'fail', labelKey: 'limits.fail' }
  }
  if (effectiveMax > MAX_ADAPTER_LIMIT) {
    return { id: 'limits', status: 'fail', labelKey: 'limits.fail' }
  }
  return { id: 'limits', status: 'pass', labelKey: 'limits.pass' }
}

function authModeCheck(config: Record<string, unknown>): BridgeAgentConfigCheckItem {
  return isNonEmptyString(config.authMode)
    ? { id: 'authMode', status: 'pass', labelKey: 'authMode.declared' }
    : { id: 'authMode', status: 'warn', labelKey: 'authMode.undeclared' }
}

function localhostBoundaryCheck(config: Record<string, unknown>): BridgeAgentConfigCheckItem {
  const raw = firstBaseUrlLike(config)
  if (!raw) return { id: 'localhostBoundary', status: 'warn', labelKey: 'localhostBoundary.unknown' }
  return isLoopbackBaseUrl(raw)
    ? { id: 'localhostBoundary', status: 'pass', labelKey: 'localhostBoundary.pass' }
    : { id: 'localhostBoundary', status: 'fail', labelKey: 'localhostBoundary.fail' }
}

// Mirrors bridge-agent-readonly-adapter.cjs's RAW_SQL_KEYS. This is a config-HYGIENE check (does the
// stored config itself carry a raw-SQL-shaped key an operator may have added) — distinct from, and a
// meaningful complement to, the adapter's `guardrails.read.noRawSql` flag, which is a STRUCTURAL
// property of the `bridge:legacy-sql-readonly` kind (always `true` for every instance of this kind, so
// it carries no per-system signal and is not itself checked here).
const RAW_SQL_KEYS = ['sql', 'rawSql', 'rawSQL', 'queryText', 'statement'] as const

function hasRawSqlKey(container: Record<string, unknown>): boolean {
  return RAW_SQL_KEYS.some((key) => Object.prototype.hasOwnProperty.call(container, key))
}

function rawSqlForbiddenCheck(config: Record<string, unknown>): BridgeAgentConfigCheckItem {
  const nestedOptions = isPlainObject(config.options) ? config.options : null
  const offending = hasRawSqlKey(config) || (nestedOptions !== null && hasRawSqlKey(nestedOptions))
  return offending
    ? { id: 'rawSqlForbidden', status: 'fail', labelKey: 'rawSqlForbidden.fail' }
    : { id: 'rawSqlForbidden', status: 'pass', labelKey: 'rawSqlForbidden.pass' }
}

// Expected object-name TOKENS for a material/BOM-style legacy-SQL bridge (the demand anchor, #3746).
// Matching is case-insensitive substring on a normalized (alphanumeric-only) form of each object name,
// so real-world prefixed names (e.g. "T_BOM_CHILD", "t-bom-child") still match. This is deliberately a
// coarse, advisory heuristic (never a hard gate) — a bridge legitimately exposing only "material" is
// not wrong, it is simply flagged 'partial' so an admin can decide whether to extend it.
const EXPECTED_OBJECT_TOKENS = [
  { id: 'material', token: 'material' },
  { id: 'bom', token: 'bom' },
  { id: 'bomChild', token: 'bomchild' },
] as const

function normalizeObjectNameForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function objectAllowlistCheck(objectNames: string[]): BridgeAgentConfigCheckItem {
  if (objectNames.length === 0) {
    return { id: 'objectAllowlist', status: 'warn', labelKey: 'objectAllowlist.empty' }
  }
  const normalized = objectNames.map(normalizeObjectNameForMatch)
  const allPresent = EXPECTED_OBJECT_TOKENS.every(({ token }) => normalized.some((name) => name.includes(token)))
  return allPresent
    ? { id: 'objectAllowlist', status: 'pass', labelKey: 'objectAllowlist.complete' }
    : { id: 'objectAllowlist', status: 'warn', labelKey: 'objectAllowlist.partial' }
}

/**
 * Fixed 6-item, deterministically-ordered checklist (lock §2.1 / §3): required fields / limits /
 * auth mode declared / localhost boundary / raw-SQL forbidden / object-allowlist completeness. Never
 * throws — an absent/malformed `config` is treated as `{}`, an absent/malformed `objectNames` as `[]`.
 */
export function computeBridgeAgentConfigCheck(input: BridgeAgentConfigCheckInput): BridgeAgentConfigCheckItem[] {
  const config = isPlainObject(input?.config) ? input.config : {}
  const objectNames = Array.isArray(input?.objectNames)
    ? input.objectNames.filter((name): name is string => typeof name === 'string')
    : []
  return [
    requiredFieldsCheck(config),
    limitsCheck(config),
    authModeCheck(config),
    localhostBoundaryCheck(config),
    rawSqlForbiddenCheck(config),
    objectAllowlistCheck(objectNames),
  ]
}

// #### 2. Change-suggestion builder #################################################################

// Mirrors bridge-agent-readonly-adapter.cjs's SAFE_OBJECT_NAME_PATTERN — applied to BOTH object names
// and field-key names here. This is the values-free gate on operator input: a secret, host, connection
// string, or token is essentially guaranteed to contain a character outside `[A-Za-z0-9_]` (`=`, `;`,
// `:`, `.`, whitespace, …), so it fails this pattern and is dropped rather than echoed.
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_IDENTIFIER_LENGTH = 64

function isSafeIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && SAFE_IDENTIFIER_PATTERN.test(value)
}

export interface BridgeAgentSuggestionObjectDraft {
  objectName: string
  fieldKeys: string[]
}

export interface BridgeAgentSuggestionEntryResult {
  // Present only when the object name itself was identifier-safe (an invalid object name drops the
  // whole entry — see `invalidObjectCount` below — so every entry in `entries` has a valid name).
  objectName: string
  // Only the VALID field keys (identifier-safe ones); invalid ones are dropped and merely counted.
  fieldKeys: string[]
}

export interface BridgeAgentChangeSuggestionResult {
  entries: BridgeAgentSuggestionEntryResult[]
  invalidObjectCount: number
  invalidFieldKeyCount: number
  // The full copyable values-free suggestion text (zh or en per `locale`) — this is a SUGGESTION only;
  // nothing here is applied by this page (lock §3: applied by the controlled backend or ops script).
  text: string
}

interface FilteredSuggestionDrafts {
  entries: BridgeAgentSuggestionEntryResult[]
  invalidObjectCount: number
  invalidFieldKeyCount: number
}

// Single shared gate: BOTH `buildBridgeAgentChangeSuggestion` (below) and `buildImplementationChecklist`
// (BA-APPLY-1, further below) filter OPERATOR-SPECIFIED drafts through this one function, so there is
// exactly one place that decides which object/field-key names are safe to echo anywhere. Anything not
// identifier-shaped is dropped and only counted — never returned in `entries`.
function filterSafeSuggestionDrafts(drafts: BridgeAgentSuggestionObjectDraft[]): FilteredSuggestionDrafts {
  const safeDrafts = Array.isArray(drafts) ? drafts : []

  let invalidObjectCount = 0
  let invalidFieldKeyCount = 0
  const entries: BridgeAgentSuggestionEntryResult[] = []

  for (const draft of safeDrafts) {
    const rawObjectName = typeof draft?.objectName === 'string' ? draft.objectName.trim() : ''
    if (!rawObjectName) continue
    if (!isSafeIdentifier(rawObjectName)) {
      invalidObjectCount += 1
      continue
    }
    const rawFieldKeys = Array.isArray(draft?.fieldKeys) ? draft.fieldKeys : []
    const fieldKeys: string[] = []
    for (const key of rawFieldKeys) {
      const trimmed = typeof key === 'string' ? key.trim() : ''
      if (!trimmed) continue
      if (isSafeIdentifier(trimmed)) fieldKeys.push(trimmed)
      else invalidFieldKeyCount += 1
    }
    entries.push({ objectName: rawObjectName, fieldKeys })
  }

  return { entries, invalidObjectCount, invalidFieldKeyCount }
}

/**
 * Builds a values-free "变更建议 / 实施清单" from OPERATOR-SPECIFIED new object/field-key names (never
 * values). Every name is validated against `SAFE_IDENTIFIER_PATTERN`; anything that fails is dropped
 * from the rendered text and only counted (`invalidObjectCount` / `invalidFieldKeyCount`), so a
 * secret/host/connection-string-shaped string pasted into a name field can never appear in `text`.
 * `targetLabel` (optional) is a plain system NAME for a documentation header line — the same trust
 * boundary BA-UI-1 already extends to `system.name` elsewhere in this section (never a config value).
 */
export function buildBridgeAgentChangeSuggestion(
  drafts: BridgeAgentSuggestionObjectDraft[],
  locale: AppLocale,
  targetLabel?: string | null,
): BridgeAgentChangeSuggestionResult {
  const isZh = locale === 'zh-CN'
  const { entries, invalidObjectCount, invalidFieldKeyCount } = filterSafeSuggestionDrafts(drafts)

  const lines: string[] = []
  lines.push(isZh
    ? '变更建议 / 实施清单（供受控后端或运维脚本应用；本页不会据此做任何直接修改）'
    : 'Change suggestion / implementation checklist (for the controlled backend or ops script to apply; this page makes no direct change from it)')
  if (isNonEmptyString(targetLabel)) {
    lines.push(isZh ? `目标实例：${targetLabel}` : `Target instance: ${targetLabel}`)
  }

  if (entries.length === 0) {
    lines.push(isZh
      ? '没有可生成的变更建议（尚未提供有效的对象/字段名）。'
      : 'No change suggestion to generate yet (no valid object/field names were provided).')
  } else {
    entries.forEach((entry, index) => {
      lines.push(isZh ? `${index + 1}. 对象：${entry.objectName}` : `${index + 1}. Object: ${entry.objectName}`)
      lines.push(entry.fieldKeys.length > 0
        ? (isZh ? `   新增字段映射：${entry.fieldKeys.join(', ')}` : `   New field mappings: ${entry.fieldKeys.join(', ')}`)
        : (isZh ? '   （仅新增对象，无字段映射）' : '   (object only, no field mappings)'))
    })
  }

  if (invalidObjectCount > 0) {
    lines.push(isZh
      ? `（已忽略 ${invalidObjectCount} 个不符合标识符格式的对象名）`
      : `(${invalidObjectCount} object name(s) were ignored because they were not identifier-shaped)`)
  }
  if (invalidFieldKeyCount > 0) {
    lines.push(isZh
      ? `（已忽略 ${invalidFieldKeyCount} 个不符合标识符格式的字段名）`
      : `(${invalidFieldKeyCount} field name(s) were ignored because they were not identifier-shaped)`)
  }

  return { entries, invalidObjectCount, invalidFieldKeyCount, text: lines.join('\n') }
}

// #### 3. Implementation-checklist builder (BA-APPLY-1) #############################################
//
// docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2 形态 A ("运维脚本
// handoff, 风险最低, 建议 v1"): BA-UI-3's change suggestion above is prose for a human to read; this
// builder renders the SAME already-identifier-gated drafts as a machine-readable, values-free
// "implementation checklist" — a fixed-schema object whose ONLY content is object names, field-key
// names, and a closed operation enum. It is an EXPORT/render only: nothing in this module (or its
// caller) writes local config, calls a backend endpoint, or touches the Agent — apply is a LATER,
// unopened rung (BA-APPLY-2+), done by a human handing this checklist to the controlled backend or the
// existing scripts/ops/bridge-agent-readonly.ps1 script.

// Exact-registered, closed operation enum (design-lock §4 hard lock — "只读不变式": the checklist can
// only ever describe EXPANDING readonly exposure, never a write/delete/make-writable operation). Adding
// a third literal to this union — or any write/delete/make-writable-shaped op — is NOT authorized by
// this slice; it would require its own owner-ratified design-lock rung.
export type BridgeAgentChecklistOperationKind = 'add_readonly_object' | 'add_readonly_field'

export interface BridgeAgentChecklistOperation {
  op: BridgeAgentChecklistOperationKind
  objectName: string
  fieldKeys: string[]
}

// The serialized/exported artifact shape — copy/download output is exactly this object (no counts, no
// targetLabel/system name, no free-form text): `{ schemaVersion, operations }`.
export interface BridgeAgentImplementationChecklist {
  schemaVersion: 1
  operations: BridgeAgentChecklistOperation[]
}

export interface BridgeAgentImplementationChecklistResult {
  checklist: BridgeAgentImplementationChecklist
  invalidObjectCount: number
  invalidFieldKeyCount: number
}

const CHECKLIST_SCHEMA_VERSION = 1 as const

/**
 * Builds a machine-readable, values-free implementation checklist from OPERATOR-SPECIFIED new
 * object/field-key names (never values) — form A of the BA-APPLY line. Independently re-applies
 * `filterSafeSuggestionDrafts` (the same gate `buildBridgeAgentChangeSuggestion` uses): this function
 * does not trust its caller to have already filtered `drafts`, so a non-conforming name is dropped and
 * only counted, never emitted into `checklist.operations`.
 *
 * One operation per valid draft row (never per field key) — `op` is DERIVED, never read off caller
 * input (there is no `op` field on `BridgeAgentSuggestionObjectDraft`), so a caller can never smuggle a
 * write/delete/make-writable op string through: a row with zero valid field keys yields
 * `add_readonly_object`; a row with >=1 valid field keys yields `add_readonly_field` (its `fieldKeys`
 * carries every valid key from that row).
 */
export function buildImplementationChecklist(
  drafts: BridgeAgentSuggestionObjectDraft[],
): BridgeAgentImplementationChecklistResult {
  const { entries, invalidObjectCount, invalidFieldKeyCount } = filterSafeSuggestionDrafts(drafts)

  const operations: BridgeAgentChecklistOperation[] = entries.map((entry) => ({
    op: entry.fieldKeys.length > 0 ? 'add_readonly_field' : 'add_readonly_object',
    objectName: entry.objectName,
    fieldKeys: entry.fieldKeys,
  }))

  return {
    checklist: { schemaVersion: CHECKLIST_SCHEMA_VERSION, operations },
    invalidObjectCount,
    invalidFieldKeyCount,
  }
}
