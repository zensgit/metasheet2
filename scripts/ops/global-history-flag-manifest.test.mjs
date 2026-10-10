#!/usr/bin/env node
/**
 * Dependency-matrix test for the Global History flag manifest (R12-C).
 *
 * This MUST fail if someone deletes a rule from the manifest: each `test(...)` below asserts a named
 * violation id fires for a specific illegal combination, so removing the corresponding `rules` entry
 * (or its dependsOn/conflictsWith wiring) drops the violation out of `evaluateFlagRules()`'s output and
 * the assertion goes from pass to fail — it does not silently pass either way.
 */

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  GLOBAL_HISTORY_FLAG_BY_KEY,
  GLOBAL_HISTORY_FLAG_KEYS,
  GLOBAL_HISTORY_FLAG_MANIFEST,
  evaluateFlagRules,
  isActivated,
  isMisconfiguredTruthy,
} from './global-history-flag-manifest.mjs'

function violationIds(flags) {
  return evaluateFlagRules(flags).map((v) => v.id)
}

test('watch-challenge manifest provenance names the canonical exported flag', () => {
  const key = 'ELEARNING_WATCH_CHALLENGE_ENABLED'
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY[key]
  assert.ok(spec)
  assert.equal(
    spec.source,
    'packages/core-backend/src/elearning/feature-flags.ts#ELEARNING_WATCH_CHALLENGE_ENABLED',
  )
})

test('online-enrollment manifest provenance names the canonical exported flag', () => {
  const key = 'ELEARNING_ENROLLMENT_ENABLED'
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY[key]
  assert.ok(spec)
  assert.equal(
    spec.source,
    'packages/core-backend/src/elearning/feature-flags.ts#ELEARNING_ENROLLMENT_ENABLED',
  )
  assert.deepEqual(spec.dependsOn, [
    'ELEARNING_ENABLED',
    'ELEARNING_CONTENT_ENABLED',
  ])
})

test('approval CC unread badge switch (test report 2026-10-08): boolean, exact true, sourced from its exported predicate', () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.APPROVAL_CC_UNREAD_BADGE_ENABLED
  assert.ok(spec)
  assert.equal(spec.type, 'boolean')
  assert.equal(spec.activationValue, 'true')
  assert.deepEqual(spec.dependsOn, [])
  assert.equal(
    spec.source,
    'packages/core-backend/src/services/approval-notify-badge-flags.ts#isApprovalCcUnreadBadgeEnabled',
  )
  assert.equal(isActivated(spec, 'true'), true)
  assert.equal(isActivated(spec, 'TRUE'), false)
  assert.equal(isActivated(spec, ' true'), false)
})

test('approval new-outcome badge switch (test report 2026-10-08): boolean, exact true, sourced from its exported predicate', () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.APPROVAL_MINE_OUTCOME_BADGE_ENABLED
  assert.ok(spec)
  assert.equal(spec.type, 'boolean')
  assert.equal(spec.activationValue, 'true')
  assert.deepEqual(spec.dependsOn, [])
  assert.equal(
    spec.source,
    'packages/core-backend/src/services/approval-notify-badge-flags.ts#isApprovalMineOutcomeBadgeEnabled',
  )
  assert.equal(isActivated(spec, 'true'), true)
  assert.equal(isActivated(spec, 'True'), false)
})

// NON-TAUTOLOGICAL completeness: derive the flag set from SOURCE (grep packages/core-backend/src), NOT from
// a hand-copied list. A flag READ in source but MISSING from the manifest fails here — this is exactly how
// the 19th flag (MULTITABLE_SHEET_REVERT_MAX_RECORDS) slipped through the earlier hardcoded-list test, which
// asserted the manifest against a copy of itself and stayed green while missing it (owner REQUEST-CHANGES).
// The denylist below is the ONLY reviewed part: it names the NON-Global-History flag families. A NEW flag
// added to source that matches neither the manifest nor the denylist FAILS this test and forces a human to
// categorize it (→ manifest if it's a recovery/history flag, → denylist with a reason if it's out of scope).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Non-boolean e-learning env reads that belong in the manifest, by exact name. A suffix rule such
// as *_MS would also catch source constants (ELEARNING_MEDIA_FFPROBE_TIMEOUT_MS and friends are
// not env reads). #6175: the audience catalog scan timeout.
const ELEARNING_NON_BOOLEAN_FLAGS = new Set(['ELEARNING_AUDIENCE_SCAN_TIMEOUT_MS'])

test('audience scan timeout (#6175): numeric, default 5000, sourced from the resolver parser', () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.ELEARNING_AUDIENCE_SCAN_TIMEOUT_MS
  assert.ok(spec)
  assert.equal(spec.type, 'numeric')
  assert.equal(
    spec.source,
    'packages/core-backend/src/services/elearning-audience-resolver.ts#resolveElearningAudienceScanTimeoutMs',
  )
  assert.match(spec.activationValue, /default 5000/)
  assert.match(spec.activationValue, /0 = no scan timeout/)
  assert.deepEqual(spec.dependsOn, ['ELEARNING_ENABLED'])
  assert.equal(isActivated(spec, '5000'), false)
  assert.equal(isMisconfiguredTruthy(spec, 'true'), false)
  const resolver = readFileSync(
    path.join(REPO_ROOT, 'packages/core-backend/src/services/elearning-audience-resolver.ts'),
    'utf8',
  )
  assert.match(resolver, /export function resolveElearningAudienceScanTimeoutMs\(/)
  assert.match(resolver, /ELEARNING_AUDIENCE_SCAN_TIMEOUT_ENV = 'ELEARNING_AUDIENCE_SCAN_TIMEOUT_MS'/)
  assert.match(resolver, /ELEARNING_AUDIENCE_SCAN_TIMEOUT_DEFAULT_MS = 5_000/)
})

// MAINTAINER NOTE: these are PREFIX families — a future flag that shares one of these prefixes is
// auto-denied (treated as out of scope) WITHOUT failing this test. That is correct today (no recovery/
// history flag lives under AI_/ATTACHMENT_/EMAIL_), but if a Global-History flag is ever named with one
// of these prefixes it would be silently excluded here. If that happens, switch that family to NON_GH_EXACT.
const NON_GH_PREFIXES = [
  'MULTITABLE_AI_', // AI fields / bulk-fill / ledger / tenant caps
  'MULTITABLE_ATTACHMENT_', // attachment storage / cleanup / blob retention
  'MULTITABLE_EMAIL_', // email transport / SMTP / smoke
]
const NON_GH_EXACT = new Set([
  // B3 (#5702): three multitable ERROR CODES (ensureSystemBase's adoption / input refusals and
  // plugin-scope's base-prefix refusal) — not flags, nobody reads them from process.env — but the
  // `MULTITABLE_[A-Z_0-9]+` grep below catches them like any other token, so they are excluded here.
  'MULTITABLE_BASE_ADOPTION_REFUSED',
  'MULTITABLE_BASE_SCOPE_FORBIDDEN',
  'MULTITABLE_SYSTEM_BASE_INPUT_INVALID',
  'MULTITABLE_AGGREGATE_MAX_ROWS', // read-aggregation row cap
  // 自定义模板表名常量(#5617)，不是环境开关：它是 migration 与 custom-template-store 共用的表名字面量，
  // 被这条 `MULTITABLE_[A-Z_0-9]+` grep 当成 flag 抓到。列在这里等于声明「不得要求它出现在
  // GLOBAL_HISTORY_FLAG_MANIFEST 里」，而不是把它注册成 flag。
  'MULTITABLE_CUSTOM_TEMPLATES_TABLE',
  // 「使用模板」去重账本的表名常量(#5861)，不是环境开关：它是
  // db/migrations/zzzz20260919140000_create_multitable_template_install_ledger.ts 导出的表名字面量，
  // 没有任何一处从 process.env 读它（那条去重路径一个 env 开关都没有：窗口、锁等待上限、清理条数
  // 都是源码常量，见 multitable/template-install-dedupe.ts 的 TEMPLATE_INSTALL_* 导出）。
  // 与上面的 MULTITABLE_CUSTOM_TEMPLATES_TABLE 同形，被这条 `MULTITABLE_[A-Z_0-9]+` grep 抓到。
  // 列在这里等于声明「不得要求它出现在 GLOBAL_HISTORY_FLAG_MANIFEST 里」，而不是把它注册成 flag。
  'MULTITABLE_TEMPLATE_INSTALL_LEDGER_TABLE',
  'MULTITABLE_CAPABILITY_KEYS', // capability registry
  'MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE', // cross-base mirror write (separate line)
  'MULTITABLE_ENSURE_FIELDS_OVERWRITE_MODE', // P0-S S3: provisioning destructive-reconcile guard mode (refuse[default]|overwrite|observe|preserve) — not a Global-History/recovery flag
  'MULTITABLE_ENSURE_FIELDS_REFUSED', // P0-S S3 destructive-reconcile refusal error code, not a flag
  'MULTITABLE_PLUGIN_SHEET_SCOPE_MODE', // P0-S S4: plugin sheet-scope enforcement mode (observe|enforce) — not a Global-History/recovery flag
  'MULTITABLE_ENABLE_PERSONAL_VIEWS', // personal views (separate line)
  'MULTITABLE_ENABLE_REQUEST_METADATA_CACHE', // W8-4: per-request multitable metadata memo (perf, default off, 120s hard deadline) — not a Global-History/recovery flag
  // W9: kill-switch for the stock-prep per-chunk batch idempotency-key lookup (perf, default ON; set
  // to `false`/`0`/`off`/`no` to fall back to the per-row lookup). Not a Global-History/recovery
  // flag, which is what this list means: NON_GH_EXACT is the EXCLUSION list for the grep below, so
  // an entry here is a statement that the name must NOT be demanded in GLOBAL_HISTORY_FLAG_MANIFEST
  // — it is not itself a registration. It is listed pre-emptively: the read lives in the PLUGIN
  // (plugins/plugin-integration-core/lib/stock-preparation-apply-writer.cjs) and this grep only
  // covers packages/core-backend/src, so today the entry is inert. It earns its place the day the
  // read moves into core-backend, when it keeps the completeness check from demanding a
  // Global-History entry this flag does not belong in.
  'MULTITABLE_STOCK_PREP_BATCH_KEY_LOOKUP',
  'MULTITABLE_FIELD_INPUT_TYPES', // field-input-type registry
  'MULTITABLE_FIELD_TYPES', // field-type registry
  'MULTITABLE_FIELDS', // e-learning projection field registry suffix, not a flag
  'MULTITABLE_FORMULA_BULK_RECOMPUTE_MAX_ROWS', // formula recompute cap
  'MULTITABLE_METRIC_FIELDS', // e-learning projection metric-field registry suffix, not a flag
  'MULTITABLE_OBJECT_SCOPE_FORBIDDEN', // scope guards
  'MULTITABLE_PROJECT_NAMESPACE_FORBIDDEN',
  // 记录级送审(#5754)的四个常量名，都不是环境开关，没有任何一处从 process.env 读它们；列在这里
  // 等于声明「不得要求它出现在 GLOBAL_HISTORY_FLAG_MANIFEST 里」，而不是把它注册成 flag。
  // 用 EXACT 而不是前缀家族：前缀会把未来同名下的真开关也静默放行（见上方 MAINTAINER NOTE）。
  'MULTITABLE_RECORD_APPROVAL_IN_FLIGHT_STATUSES', // 送审在途状态字面量 ['creating','pending']（迁移的部分唯一索引与 service 共用），不是 flag
  'MULTITABLE_RECORD_APPROVAL_SUBMISSIONS_TABLE', // 送审记录表名字面量（迁移与 service 共用），不是 flag
  'MULTITABLE_SUBMIT_APPROVAL_PERMISSION', // permission code constant（multitable/submit-approval-permission.ts）
  'MULTITABLE_SUBMIT_APPROVAL_PERMISSION_CODE', // 同一权限码在迁移侧的常量名，不是 flag
  'MULTITABLE_SHARE_PERMISSIONS', // share permission registry
  'MULTITABLE_SHEETS_TABLE', // e-learning projection mapping-table name suffix, not a flag
  // Schema-management permission split: these four are CONSTANT NAMES (permission codes and the
  // env-var name itself), not flags. The one real flag, MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA,
  // is registered in the manifest instead.
  'MULTITABLE_LEGACY_MANAGE_SCHEMA_FLAG_ENV', // the env-var NAME constant, not the flag
  'MULTITABLE_MANAGE_SCHEMA_PERMISSION', // permission code constant
  'MULTITABLE_MANAGE_SCHEMA_PERMISSION_CODE', // permission code constant
  'MULTITABLE_WRITE_PERMISSION', // permission code constant
  'MULTITABLE_SHEET_SCOPE_FORBIDDEN',
  // 一个项目一张备料表 S3 (R-37): the plugin-scope wrapper's typed 403 when a plugin asks `ensureObject` for a
  // `systemKind` stamp it may not have (multitable/stock-preparation-overview-contract.ts
  // `StockPreparationOverviewSystemKindError.code`). An ERROR CODE, not a flag: nothing reads it from
  // process.env, and the gate it names has no switch — the stamp is admitted for exactly one (plugin, kind,
  // object) triple, always. Listed here (not registered) for the same reason as the scope codes around it.
  'MULTITABLE_SYSTEM_KIND_FORBIDDEN',
  'MULTITABLE_UNIT_OF_WORK_SCOPE_FORBIDDEN', // plugin-scoped records UOW error code, not a flag
  'MULTITABLE_UNIT_OF_WORK_UNAVAILABLE', // required host-capability error code, not a flag
  // 客户反馈 2026-09-24 #4a (managed-table zh relabel, multitable/object-display-name-relabel.ts): four
  // ERROR CODES of the relabel primitive's typed refusals. Nobody reads them from process.env. The one
  // real flag of that module, MULTITABLE_MANAGED_TABLE_RELABEL_ENABLED, is registered in the manifest.
  'MULTITABLE_RELABEL_INPUT_INVALID', // malformed relabel request (400), not a flag
  'MULTITABLE_RELABEL_SCOPE_FORBIDDEN', // object not bound to the caller's project in the registry (403), not a flag
  'MULTITABLE_RELABEL_APPLY_DISABLED', // write leg refused because the operator switch is off (409), not a flag
  'MULTITABLE_RELABEL_PLAN_CHANGED', // write leg refused because the plan differs from the preview (409), not a flag
  // DingTalk todo-mirror (plan B, #5772/#5768): the CHECK-constraint status vocabulary constant
  // (migration zzzz20260916120000), not an env var — nobody reads it from process.env. The two real
  // flags, DINGTALK_TODO_MIRROR_ENABLED and DINGTALK_TODO_MIRROR_INTERVAL_MS, are registered in the
  // manifest instead.
  'DINGTALK_TODO_MIRROR_STATUSES',
])

function grepFlagTokens(pattern) {
  const srcDir = path.join(REPO_ROOT, 'packages/core-backend/src')
  let out = ''
  try {
    out = execSync(`grep -rhoE '${pattern}' ${srcDir} --include='*.ts'`, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    throw new Error(`could not grep ${pattern} under ${srcDir}: ${err.message}`)
  }
  return [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))]
}

function globalHistoryFlagsInSource() {
  const tokens = grepFlagTokens('MULTITABLE_[A-Z_0-9]+')
    .filter((t) => !t.endsWith('_')) // drop concatenation-prefix artifacts (MULTITABLE_ENABLE_, ..._SMTP_)
    .filter((t) => !NON_GH_PREFIXES.some((p) => t.startsWith(p)))
    .filter((t) => !NON_GH_EXACT.has(t))
  // E-learning V0.1 flags live in this same operator registry (AGENTS.md: every new env flag).
  // Restrict to *_ENABLED so constant names such as ELEARNING_FLAG_NAMES are not treated as flags,
  // plus the exact non-boolean names in ELEARNING_NON_BOOLEAN_FLAGS.
  const elearning = grepFlagTokens('ELEARNING_[A-Z_0-9]+')
    .filter((t) => t.endsWith('_ENABLED') || ELEARNING_NON_BOOLEAN_FLAGS.has(t))
  // DingTalk todo-mirror (plan B, #5772/#5768) flags live in this same operator registry (AGENTS.md:
  // every new env flag). Unlike the elearning family both real flags are needed (ENABLED and the
  // worker's INTERVAL_MS), so this is NOT restricted to *_ENABLED; DINGTALK_TODO_MIRROR_STATUSES (the
  // non-flag status-vocabulary constant) is excluded via NON_GH_EXACT instead.
  const dingtalkTodoMirror = grepFlagTokens('DINGTALK_TODO_MIRROR_[A-Z_0-9]+')
    .filter((t) => !t.endsWith('_'))
    .filter((t) => !NON_GH_EXACT.has(t))
  // Task routes mount only when this flag is the exact string true (AGENTS.md: every new env flag).
  const tasks = grepFlagTokens('TASKS_[A-Z_0-9]+').filter((t) => t.endsWith('_ENABLED'))
  // Approval center read-state badges (test report 2026-10-08): default-OFF exact-'true' switches,
  // one family by name shape so a new badge switch joins the population as soon as source reads it.
  const approvalBadges = grepFlagTokens('APPROVAL_[A-Z_0-9]+_BADGE_ENABLED')
  // 一个项目一张备料表 (ADR adr-stock-prep-project-sheets-20261008 S1, R-35): the FIRST flags in this
  // registry that are read by plugin-integration-core rather than by core-backend (AGENTS.md: every
  // new env flag is registered here; the ADR §8 names this manifest explicitly). One family by name
  // shape, scanned in the plugin's lib — the two keys are the switch and the G1 role list. Every
  // other MULTITABLE_STOCK_PREP_* the plugin reads predates this registry and stays out of scope.
  const stockPrepProjectSheets = grepPluginFlagTokens('MULTITABLE_STOCK_PREP_PROJECT_SHEET[A-Z_0-9]*')
    .filter((t) => !t.endsWith('_'))
  return [...new Set([...tokens, ...elearning, ...dingtalkTodoMirror, ...tasks, ...approvalBadges, ...stockPrepProjectSheets])].sort()
}

function grepPluginFlagTokens(pattern) {
  const libDir = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
  let out = ''
  try {
    out = execSync(`grep -rhoE '${pattern}' ${libDir} --include='*.cjs'`, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    throw new Error(`could not grep ${pattern} under ${libDir}: ${err.message}`)
  }
  return [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))]
}

test('completeness (source-derived, non-tautological): manifest covers every Global-History flag read in packages/core-backend/src', () => {
  const sourceGH = globalHistoryFlagsInSource()
  assert.ok(
    sourceGH.length >= 20,
    `expected >=20 Global-History flags derived from source, got ${sourceGH.length} — the denylist is too broad or grep broke`,
  )
  const manifestKeys = new Set(GLOBAL_HISTORY_FLAG_KEYS)
  const missing = sourceGH.filter((f) => !manifestKeys.has(f))
  assert.deepEqual(
    missing,
    [],
    `source reads Global-History flags MISSING from the manifest — add each to global-history-flag-manifest.mjs (or, if genuinely out of scope, to NON_GH_PREFIXES/NON_GH_EXACT with a reason): ${missing.join(', ')}`,
  )
  const sourceSet = new Set(sourceGH)
  const phantom = GLOBAL_HISTORY_FLAG_KEYS.filter((k) => !sourceSet.has(k))
  assert.deepEqual(
    phantom,
    [],
    `manifest lists flags NOT read anywhere in packages/core-backend/src (stale or typo'd key): ${phantom.join(', ')}`,
  )
  // every spec carries a non-empty source citation — a rule with no citation is not verified
  for (const spec of GLOBAL_HISTORY_FLAG_MANIFEST) {
    assert.ok(spec.source && spec.source.length > 0, `${spec.key} has no source citation`)
  }
})

// ── R1: lossy double-gate ──────────────────────────────────────────────────────────────────────────

test('R1 lossy-without-base: LOSSY on + base off fires the named violation', () => {
  const ids = violationIds({
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'true',
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT: 'false',
  })
  assert.ok(ids.includes('lossy-without-base'), `expected lossy-without-base, got ${ids.join(',')}`)
})

test('R1 lossy-without-base: LOSSY on + base UNSET also fires (unset is not activated)', () => {
  const ids = violationIds({ MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'true' })
  assert.ok(ids.includes('lossy-without-base'))
})

test('R1 positive control: LOSSY on + base on does NOT fire', () => {
  const ids = violationIds({
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'true',
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT: 'true',
  })
  assert.ok(!ids.includes('lossy-without-base'), `unexpected violation: ${ids.join(',')}`)
})

test('R1 positive control: LOSSY off never fires regardless of base', () => {
  assert.equal(
    violationIds({ MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'false', MULTITABLE_ENABLE_FIELD_RETYPE_REVERT: 'false' }).includes(
      'lossy-without-base',
    ),
    false,
  )
})

// ── R2: side-door needs capture ────────────────────────────────────────────────────────────────────

test('R2 side-door-without-capture: SIDE_DOOR on + CAPTURE off fires the named violation', () => {
  const ids = violationIds({
    MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: 'true',
    MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'false',
  })
  assert.ok(ids.includes('side-door-without-capture'), `expected side-door-without-capture, got ${ids.join(',')}`)
})

test('R2 positive control: SIDE_DOOR on + CAPTURE on does NOT fire', () => {
  const ids = violationIds({
    MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: 'true',
    MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'true',
  })
  assert.ok(!ids.includes('side-door-without-capture'), `unexpected violation: ${ids.join(',')}`)
})

test('R2 positive control: SIDE_DOOR off never fires regardless of capture', () => {
  assert.equal(
    violationIds({ MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: 'false', MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'false' }).includes(
      'side-door-without-capture',
    ),
    false,
  )
})

// ── R3: exact-anchor Revert/Reset vs retention STOP-SHIP ───────────────────────────────────────────

test('R3 sheet-revert-intent-with-retention-on: SHEET_REVERT on + retention active (\'1\') fires', () => {
  const ids = violationIds({
    MULTITABLE_ENABLE_SHEET_REVERT: 'true',
    MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
  })
  assert.ok(ids.includes('sheet-revert-intent-with-retention-on'), `expected sheet-revert conflict, got ${ids.join(',')}`)
})

test('R3 pit-reset-intent-with-retention-on: PIT_RESET on + retention active (\'1\') fires', () => {
  const ids = violationIds({
    MULTITABLE_ENABLE_PIT_RESET: 'true',
    MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
  })
  assert.ok(ids.includes('pit-reset-intent-with-retention-on'), `expected pit-reset conflict, got ${ids.join(',')}`)
})

test("R3 footgun regression guard: retention='true' does NOT count as active (exact-match, not the loose heuristic)", () => {
  // This is the exact bug the o2-ladder doc + the old flag-status helper's loose TRUE_VALUES heuristic
  // could produce: 'true' looks truthy but meta-revision-retention.ts:60 requires the EXACT string '1'.
  const ids = violationIds({
    MULTITABLE_ENABLE_PIT_RESET: 'true',
    MULTITABLE_META_REVISION_RETENTION_ENABLED: 'true',
  })
  assert.ok(
    !ids.includes('pit-reset-intent-with-retention-on'),
    `retention='true' must NOT activate retention (needs exact '1'), so no conflict should fire; got ${ids.join(',')}`,
  )
})

test('R3 positive control: PIT_RESET on + retention off/unset does NOT fire', () => {
  assert.equal(violationIds({ MULTITABLE_ENABLE_PIT_RESET: 'true' }).includes('pit-reset-intent-with-retention-on'), false)
})

test('R3 positive control: SHEET_REVERT on + retention off/unset does NOT fire', () => {
  assert.equal(violationIds({ MULTITABLE_ENABLE_SHEET_REVERT: 'true' }).includes('sheet-revert-intent-with-retention-on'), false)
})

test('R3 positive control: retention active alone (no Revert/Reset gate) does NOT fire', () => {
  const ids = violationIds({ MULTITABLE_META_REVISION_RETENTION_ENABLED: '1' })
  assert.equal(ids.includes('sheet-revert-intent-with-retention-on'), false)
  assert.equal(ids.includes('pit-reset-intent-with-retention-on'), false)
})

test('R3 PIT_RESET activation is case-insensitive + trimmed (matches univer-meta.ts PIT_RESET_ENABLED)', () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_ENABLE_PIT_RESET
  assert.equal(isActivated(spec, ' TRUE '), true)
  assert.equal(isActivated(spec, 'True'), true)
  const ids = violationIds({ MULTITABLE_ENABLE_PIT_RESET: 'TRUE', MULTITABLE_META_REVISION_RETENTION_ENABLED: '1' })
  assert.ok(ids.includes('pit-reset-intent-with-retention-on'))
})

// ── R4: retention activation string footgun (surfaced as a per-flag advisory, not a strict violation) ─

test("R4 retention requires exact '1'; '1' activates, 'true'/'yes'/'on' do not", () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_META_REVISION_RETENTION_ENABLED
  assert.equal(isActivated(spec, '1'), true)
  assert.equal(isActivated(spec, 'true'), false)
  assert.equal(isActivated(spec, 'yes'), false)
  assert.equal(isActivated(spec, 'on'), false)
  assert.equal(isActivated(spec, ' 1 '), false)
  assert.equal(isActivated(spec, '1 '), false)
})

test('R3 reciprocal manifest metadata keeps Revert/Reset and retention conflictsWith symmetric', () => {
  const revert = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_ENABLE_SHEET_REVERT
  const reset = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_ENABLE_PIT_RESET
  const retention = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_META_REVISION_RETENTION_ENABLED
  assert.ok(revert.conflictsWith.includes(retention.key), 'Revert must declare retention as a conflict')
  assert.ok(retention.conflictsWith.includes(revert.key), 'retention must declare Revert as a conflict')
  assert.ok(reset.conflictsWith.includes(retention.key), 'PIT Reset must declare retention as a conflict')
  assert.ok(retention.conflictsWith.includes(reset.key), 'retention must declare PIT Reset as a conflict')
})

test('R4 isMisconfiguredTruthy flags retention=true (should be 1) and PIT_RESET=1 (should be true)', () => {
  const retentionSpec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_META_REVISION_RETENTION_ENABLED
  assert.equal(isMisconfiguredTruthy(retentionSpec, 'true'), true)
  assert.equal(isMisconfiguredTruthy(retentionSpec, '1'), false) // correctly activated, not misconfigured

  const pitResetSpec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_ENABLE_PIT_RESET
  assert.equal(isMisconfiguredTruthy(pitResetSpec, '1'), true)
  assert.equal(isMisconfiguredTruthy(pitResetSpec, 'true'), false) // correctly activated, not misconfigured
})

test('R4 isMisconfiguredTruthy is false for empty/absent values (nothing to warn about)', () => {
  const retentionSpec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_META_REVISION_RETENTION_ENABLED
  assert.equal(isMisconfiguredTruthy(retentionSpec, ''), false)
  assert.equal(isMisconfiguredTruthy(retentionSpec, undefined), false)
  assert.equal(isMisconfiguredTruthy(retentionSpec, null), false)
  assert.equal(isMisconfiguredTruthy(retentionSpec, 'false'), false)
})

// ── Recovery archive runtime gate ───────────────────────────────────────────────────────────────────

test('recovery archive flag is exact-case-sensitive, fence-dependent, and has no retention conflict', () => {
  const archive = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
  assert.deepEqual(
    {
      key: archive.key,
      type: archive.type,
      activationValue: archive.activationValue,
      caseInsensitive: archive.caseInsensitive,
      dependsOn: archive.dependsOn,
      conflictsWith: archive.conflictsWith,
      danger: archive.danger,
      source: archive.source,
    },
    {
      key: 'MULTITABLE_RECOVERY_ARCHIVE_ENABLED',
      type: 'boolean',
      activationValue: 'true',
      caseInsensitive: undefined,
      dependsOn: ['MULTITABLE_ENABLE_WRITER_FENCE'],
      conflictsWith: [],
      danger: 'medium',
      source: 'packages/core-backend/src/multitable/recovery-archive-contract.ts#isMultitableRecoveryArchiveEnabled',
    },
  )
  assert.equal(isActivated(archive, 'true'), true)
  for (const value of [undefined, 'false', 'TRUE', ' true ', 'true ', ' true']) {
    assert.equal(isActivated(archive, value), false, `archive flag must remain OFF for ${String(value)}`)
  }
  assert.match(archive.purpose, /dedicated local launcher/i)
  assert.match(archive.purpose, /ordinary server startup without an injected archive composition refuses ON/i)
  assert.match(archive.purpose, /no retention conflict/i)
})

test('recovery archive requires the exact writer-fence literal used by its worker', () => {
  const fence = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_ENABLE_WRITER_FENCE
  assert.equal(isActivated(fence, 'TRUE'), true)
  for (const value of [undefined, 'false', 'TRUE', ' true ']) {
    const violations = evaluateFlagRules({
      MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
      MULTITABLE_ENABLE_WRITER_FENCE: value,
    })
    assert.deepEqual(violations.map(({ id, flag, missing }) => ({ id, flag, missing })), [{
      id: 'archive-without-exact-writer-fence',
      flag: 'MULTITABLE_RECOVERY_ARCHIVE_ENABLED',
      missing: ['MULTITABLE_ENABLE_WRITER_FENCE'],
    }], String(value))
  }
  assert.deepEqual(evaluateFlagRules({
    MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
    MULTITABLE_ENABLE_WRITER_FENCE: 'true',
  }), [])
  assert.deepEqual(evaluateFlagRules({ MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'false' }), [])
})

// ── Combined ladder rung ───────────────────────────────────────────────────────────────────────────

test('positive control: a full valid L1->L3.5 ladder rung (exact activation values) has zero violations', () => {
  const flags = {
    MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'true', // L1
    MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND: 'true', // L2
    MULTITABLE_ENABLE_SHEET_REVERT: 'true', // undelete rides on the revert master gate — both go together
    MULTITABLE_ENABLE_PIT_UNDELETE: 'true', // L3
    MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: 'true', // L3.5 (D-2), capture already on above
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT: 'true',
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'true',
    // retention and PIT_RESET both deliberately left OFF at this rung (L4/L5 are separate, independent decisions)
  }
  const violations = evaluateFlagRules(flags)
  assert.deepEqual(violations, [], `expected zero violations, got ${JSON.stringify(violations)}`)
})

test('positive control: retention-only rung (L4, no PIT_RESET) has zero violations', () => {
  const violations = evaluateFlagRules({
    MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'true',
    MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
    MULTITABLE_META_REVISION_RETENTION_DAYS: '90',
  })
  assert.deepEqual(violations, [])
})

// ── undelete rides on the SHEET_REVERT master gate (#4261 follow-up: flag-contract parity) ──────────
test('undelete-without-revert-gate: PIT_UNDELETE on + SHEET_REVERT off fires the named violation (STOP)', () => {
  const ids = violationIds({ MULTITABLE_ENABLE_PIT_UNDELETE: 'true', MULTITABLE_ENABLE_SHEET_REVERT: 'false' })
  assert.ok(ids.includes('undelete-without-revert-gate'), `expected undelete-without-revert-gate, got ${ids.join(',')}`)
})

test('undelete-without-revert-gate: PIT_UNDELETE on + SHEET_REVERT UNSET also fires (unset is not activated)', () => {
  const ids = violationIds({ MULTITABLE_ENABLE_PIT_UNDELETE: 'true' })
  assert.ok(ids.includes('undelete-without-revert-gate'))
})

test('undelete positive control: PIT_UNDELETE on + SHEET_REVERT on does NOT fire (both gates → PASS)', () => {
  const ids = violationIds({ MULTITABLE_ENABLE_PIT_UNDELETE: 'true', MULTITABLE_ENABLE_SHEET_REVERT: 'true' })
  assert.ok(!ids.includes('undelete-without-revert-gate'), `unexpected violation: ${ids.join(',')}`)
})

test('undelete positive control: PIT_UNDELETE off never fires regardless of SHEET_REVERT', () => {
  assert.equal(
    violationIds({ MULTITABLE_ENABLE_PIT_UNDELETE: 'false', MULTITABLE_ENABLE_SHEET_REVERT: 'false' }).includes('undelete-without-revert-gate'),
    false,
  )
})

test('a rung that stacks every compatible retention conflict fires all four named violations', () => {
  const ids = violationIds({
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'true',
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT: 'false',
    MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: 'true',
    MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'false',
    MULTITABLE_ENABLE_PIT_RESET: 'true',
    MULTITABLE_ENABLE_SHEET_REVERT: 'true',
    MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
    // SHEET_REVERT is on here to exercise its retention conflict. That makes the undelete-without-revert
    // violation mutually exclusive; it is covered by its own targeted test above.
  })
  assert.deepEqual(
    [...ids].sort(),
    ['lossy-without-base', 'pit-reset-intent-with-retention-on', 'sheet-revert-intent-with-retention-on', 'side-door-without-capture'].sort(),
  )
})

// ── Mutation-resistance: deleting a rule from the manifest must break these ───────────────────────

// ── field retype CONVERT (ADR docs/development/multitable-field-retype-first-batch-adr-20260926.md §5) ──────────
test('field retype convert: exact-literal activation, no dependsOn, conflicts with the legacy manage-schema switch', () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT
  assert.ok(spec, 'MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT must be registered')
  assert.equal(spec.type, 'boolean')
  assert.equal(spec.activationValue, 'true')
  assert.equal(spec.caseInsensitive, undefined)
  assert.equal(spec.danger, 'high')
  assert.deepEqual(spec.dependsOn, [])
  assert.deepEqual(spec.conflictsWith, ['MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA'])
  assert.equal(isActivated(spec, 'true'), true)
  for (const v of ['TRUE', ' true', 'true ', '1', 'yes']) assert.equal(isActivated(spec, v), false, v)
})

test('field-retype-convert-with-legacy-manage-schema: convert on + legacy switch on fires (STOP)', () => {
  const ids = violationIds({ MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT: 'true', MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA: 'true' })
  assert.ok(ids.includes('field-retype-convert-with-legacy-manage-schema'), `expected the conflict, got ${ids.join(',')}`)
})

test('field retype convert positive control: convert on alone (the read-only preview rung) has zero violations', () => {
  assert.deepEqual(evaluateFlagRules({ MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT: 'true' }), [])
  assert.deepEqual(evaluateFlagRules({ MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT: 'true', MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA: 'false' }), [])
  assert.deepEqual(evaluateFlagRules({ MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT: 'false', MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA: 'true' }), [])
})

test('mutation guard: every FlagSpec.rules[] entry is reachable by evaluateFlagRules on a targeted fixture', () => {
  // Enumerates rules directly from the manifest (not hardcoded ids) so a NEW rule added later is
  // automatically covered, and a DELETED rule shrinks the iteration (making this test vacuous for that
  // rule) which is caught by the explicit per-rule tests above still expecting the id.
  const allRuleIds = GLOBAL_HISTORY_FLAG_MANIFEST.flatMap((spec) => (spec.rules || []).map((r) => r.id))
  assert.deepEqual(
    [...allRuleIds].sort(),
    ['archive-without-exact-writer-fence', 'field-retype-convert-with-legacy-manage-schema', 'lossy-without-base', 'pit-reset-intent-with-retention-on', 'sheet-revert-intent-with-retention-on', 'side-door-without-capture', 'undelete-without-revert-gate'].sort(),
    'manifest rule set changed — update this test deliberately if a rule was intentionally added/removed',
  )
})

test('stock-prep project-sheets switch (ADR adr-stock-prep-project-sheets-20261008 S1, R-35): boolean, exact true, danger high, sourced from its exported predicate', () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED
  assert.ok(spec)
  assert.equal(spec.type, 'boolean')
  assert.equal(spec.activationValue, 'true')
  assert.equal(spec.danger, 'high')
  assert.deepEqual(spec.dependsOn, [])
  assert.deepEqual(spec.conflictsWith, [])
  assert.equal(
    spec.source,
    'plugins/plugin-integration-core/lib/stock-preparation-project-targets.cjs#stockPreparationProjectSheetsEnabled',
  )
  // The predicate the manifest names is the one the plugin reads, and it is the EXACT literal.
  assert.equal(isActivated(spec, 'true'), true)
  assert.equal(isActivated(spec, 'TRUE'), false)
  assert.equal(isActivated(spec, ' true'), false)
  assert.equal(isActivated(spec, '1'), false)
  assert.equal(isActivated(spec, undefined), false)
})

test('stock-prep project-sheet G1 grant role list (R-35): a list, danger high, sourced from its exported parser, not a dependsOn of the switch', () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_IDS
  assert.ok(spec)
  assert.equal(spec.type, 'list')
  assert.equal(spec.danger, 'high')
  assert.deepEqual(spec.dependsOn, [])
  assert.equal(
    spec.source,
    'plugins/plugin-integration-core/lib/stock-preparation-project-targets.cjs#resolveProjectSheetGrantRoleIds',
  )
})
