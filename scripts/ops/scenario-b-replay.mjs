#!/usr/bin/env node

// ---------------------------------------------------------------------------------------------
// 场景 B 一键复演 —— Q3b
//
// 把 plugins/plugin-integration-core/__tests__/scenario-b-v2-snapshot-diff.test.cjs 里那条**权威
// 调用序列**（源登记 → 第一批次源运行 → staging 落库 → 第二批次源运行 → diff 三条读面）从进程内
// handler 直调抬到**真 HTTP**，对着一个已经起来的后端跑一遍，输出一份 values-free 报告。
//
// 它证的不是 diff 引擎（那是 Q3a 的事，测试已经证完了），而是**这条链在一台真机器上能整条跑通**：
// 路由挂上了、鉴权过得去、状态码逐步对得上、两个批次真的独立落库、四类变更经 HTTP 读得出来。
//
// ── 安全门（本脚本的第一等公民）────────────────────────────────────────────────────────────────
// 脚本**不接受**一个只写着 --base-url 的地址就开跑。第一步是 GET 部署预检
// (/api/integration/stock-preparation/preflight)，拿它的 values-free 回答判定「这是不是一个沙箱/
// 本机落点」。判据全部来自仓库里已经存在的定义，不是本脚本新发明的：
//
//   · 沙箱 objectId 命名空间 = plugins/plugin-integration-core/lib/
//     stock-preparation-target-provisioning.cjs:99 的 SANDBOX_OBJECT_ID_NAMESPACE
//     与 :103 的 SANDBOX_OBJECT_ID_NAMESPACE_PATTERN（本文件下方逐字镜像，并由自测比对）。
//   · D1=B 落点裁决 = docs/development/takeover-beiliao-20260821/222-deploy-window-runbook-20260901.md
//     §0.6：备料线的落地表只能是 plm_stock_preparation_sandbox* 命名空间下的一张沙箱表。
//   · 生产 Apply 姿态 = plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs:299
//     buildPosture() 的 posture.productionApply.state（'closed' / 'configured'）。
//
// 任何一条不满足 -> 退出码 2，打印**原因码**（闭集词表），一个请求都不再发。
//
// ── 这个脚本永远不做的事 ────────────────────────────────────────────────────────────────────
//   · 永不设置 autopersist。MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED 是**服务端** env
//     (http-routes.cjs:1348)，只认精确字面量 'true'；本脚本不写 env、不发任何 autopersist 字段，
//     assertRequestBodySafe() 在每个请求出门前再查一遍请求体键名。
//   · 永不发 tenantId / x-tenant-id。autopersist 打开时 PLM 源运行对**任何载体**上的显式 tenantId
//     都 400 拒绝（http-routes.cjs:1379 assertStockPreparationPlmAutoPersistNoSteering）；而
//     x-tenant-id 请求头本身是已知的跨租户值泄漏面。租户一律由 token 自己带。
//   · 永不连数据库。v1 -> v2 之间那次换表内容是**操作员的动作**：要么给 --reseed-command 让脚本
//     代跑一条命令，要么交互式等一行确认。脚本自己不 import pg、不拼 psql。
//   · 永不把业务值写进报告。报告只有 id、计数、状态码、闭集词表；emit 之前还要过一遍
//     scanValuesFree() 自检（夹具的件号/项目号 + 调用方传进来的项目名/项目号都是哨兵）。
//
// ── 用法 ──────────────────────────────────────────────────────────────────────────────────────
//   node scripts/ops/scenario-b-replay.mjs \
//     --base-url http://127.0.0.1:8900 \
//     --dev-token --tenant tenant_scenario_b \
//     --workspace workspace_scenario_b \
//     --data-source-id syn-bom-postgres-b1 \
//     --mode v1v2 \
//     --reseed-command "psql -d syn_bom_b1 -v ON_ERROR_STOP=1 -f <fixture-dir>/03-seed-v2.sql"
//
// 退出码：0 = 全绿；1 = 某一步失败（报告说明是哪一步、期望什么状态码、拿到什么）；
//        2 = 安全门拒绝（一个业务请求都没发）；3 = 参数错误。
//
// 自测：node --test scripts/ops/scenario-b-replay.test.mjs（注入假 fetch，不碰网络）。
// 设计说明：docs/development/scenario-b-replay-design-20260921.md
// ---------------------------------------------------------------------------------------------

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import crypto from 'node:crypto'

// 这三个 helper 都不在模块顶层解析 import.meta.url —— 自测的变异探针要把**这份源码**用
// data: URL 就地编成另一个模块对象（内存级、磁盘上一个字节都不动），而 data: URL 下
// fileURLToPath / createRequire 会抛。让它们可降级，探针才跑得起来。
function selfPath() {
  try { return fileURLToPath(import.meta.url) } catch { return '' }
}
function defaultFixtureDir() {
  const here = selfPath()
  if (!here) return ''
  return path.join(path.dirname(here), '..', '..', 'plugins', 'plugin-integration-core', 'fixtures', 'scenario-b-synthetic-bom')
}
function requireFrom(dir) {
  return createRequire(pathToFileURL(path.join(dir, 'noop.cjs')).href)
}

// ── 仓库定义的逐字镜像 ───────────────────────────────────────────────────────────────────────
// 源：plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs:99,103
// 自测把这两个常量与那份源码比对 —— 源码改了而这里没跟，自测红，而不是安全门悄悄放宽。
export const SANDBOX_OBJECT_ID_NAMESPACE = 'plm_stock_preparation_sandbox'
export const SANDBOX_OBJECT_ID_NAMESPACE_PATTERN = /^plm_stock_preparation_sandbox(?:$|[_-])/

export const EXIT_CODES = Object.freeze({ OK: 0, STEP_FAILED: 1, GATE_REFUSED: 2, USAGE: 3 })

// 安全门的拒绝原因 —— 闭集，报告与 stderr 只打这些码，不打服务端回来的自由文本。
export const GATE_REFUSAL_CODES = Object.freeze({
  PREFLIGHT_UNREACHABLE: 'preflight_unreachable',
  PREFLIGHT_SHAPE_UNKNOWN: 'preflight_shape_unknown',
  PRODUCTION_APPLY_CONFIGURED: 'production_apply_configured',
  SANDBOX_NAMESPACE_MISMATCH: 'sandbox_namespace_mismatch',
  ALLOWLIST_POLLUTED: 'allowlist_polluted',
  TARGET_OUTSIDE_SANDBOX_NAMESPACE: 'target_outside_sandbox_namespace',
  NO_SANDBOX_MARKER: 'no_sandbox_marker',
})

// 固定步骤梯 —— 报告里的 step 名只能是这些，失败时「停在哪一级」因此是可比对的枚举而不是散文。
export const REPLAY_STEPS = Object.freeze([
  'GATE', 'REGISTER_SYSTEM', 'SAVE_CONFIG', 'APPROVE_CONFIG',
  'RUN_V1', 'RESEED_V2', 'RUN_V2', 'BATCH_LIST', 'DIFF', 'DIFF_ROWS', 'VERIFY_EXPECTED',
])

const ADAPTER_KIND = 'data-source:sql-readonly'

// 每个 POST 步骤自己的请求体键白名单。出门前逐键核对（多一个键就抛），并且**任何**名字里带
// persist/autopersist/tenant 的键一律拒绝 —— 这是「永不设置 autopersist / 永不发 tenantId」这两条
// 承诺的机械执行点，而不只是注释里的保证。
const SOURCE_RUN_BODY_KEYS = Object.freeze([
  'workspaceId', 'projectId', 'sourceProjectNo', 'projectName',
  'readSourceConfigId', 'syncRunId', 'snapshotBatchId', 'snapshotVersion',
])
const STEP_BODY_KEYS = Object.freeze({
  REGISTER_SYSTEM: Object.freeze(['id', 'name', 'kind', 'role', 'config']),
  SAVE_CONFIG: Object.freeze(['config']),
  APPROVE_CONFIG: Object.freeze([]),
  RUN_V1: SOURCE_RUN_BODY_KEYS,
  RUN_V2: SOURCE_RUN_BODY_KEYS,
})

const FORBIDDEN_BODY_KEY_PATTERN = /persist|tenant/i

// ── 参数 ────────────────────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const args = {
    baseUrl: '',
    token: '',
    devToken: false,
    tenant: '',
    workspace: 'workspace_scenario_b',
    fixtureDir: defaultFixtureDir(),
    mode: 'v1v2',
    dataSourceId: 'syn-bom-postgres-b1',
    systemId: 'syn-bom-source-b1',
    projectId: 'business_project_scenario_b',
    sourceProjectNo: '',
    projectName: '',
    runPrefix: 'scenario_b_replay',
    reseedCommand: '',
    timeoutMs: 20000,
    json: false,
  }
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new UsageError(`${flag} needs a value`)
      i += 1
      return value
    }
    if (flag === '--base-url') args.baseUrl = next()
    else if (flag === '--token') args.token = next()
    else if (flag === '--dev-token') args.devToken = true
    else if (flag === '--tenant') args.tenant = next()
    else if (flag === '--workspace') args.workspace = next()
    else if (flag === '--fixture-dir') args.fixtureDir = next()
    else if (flag === '--mode') args.mode = next()
    else if (flag === '--data-source-id') args.dataSourceId = next()
    else if (flag === '--system-id') args.systemId = next()
    else if (flag === '--project-id') args.projectId = next()
    else if (flag === '--source-project-no') args.sourceProjectNo = next()
    else if (flag === '--project-name') args.projectName = next()
    else if (flag === '--run-prefix') args.runPrefix = next()
    else if (flag === '--reseed-command') args.reseedCommand = next()
    else if (flag === '--timeout-ms') args.timeoutMs = Number(next())
    else if (flag === '--json') args.json = true
    else throw new UsageError(`unknown flag: ${flag}`)
  }
  if (!args.baseUrl) throw new UsageError('--base-url is required')
  if (!args.token && !args.devToken) throw new UsageError('one of --token or --dev-token is required')
  if (args.token && args.devToken) throw new UsageError('--token and --dev-token are mutually exclusive')
  if (args.mode !== 'v1' && args.mode !== 'v1v2') throw new UsageError('--mode must be v1 or v1v2')
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new UsageError('--timeout-ms must be a positive number')
  args.baseUrl = String(args.baseUrl).replace(/\/+$/, '')
  return args
}

export class UsageError extends Error {}

// ── 安全门 ──────────────────────────────────────────────────────────────────────────────────
// 本机（loopback）也是一个合法的沙箱标记 —— Q3b 的落点就是「本机/沙箱」。但 loopback **不豁免**
// 生产 Apply 姿态与命名空间这两条：一个把本机端口转发到生产的人拿不到放行。
export function isLoopbackBase(baseUrl) {
  let host
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return false
  }
  const bare = host.replace(/^\[|\]$/g, '')
  return bare === 'localhost' || bare === '::1' || bare === '0.0.0.0' || /^127\./.test(bare)
}

/**
 * 判定这个 base 是不是一个可以复演的沙箱落点。
 *
 * 入参是**已经拿到的**预检响应（status + body），不发请求 —— 这样自测可以把各种回答直接喂进来。
 * 返回值是 values-free 的：markers 全是布尔/计数，绝不回显 allowlist 里的字符串或任何主机名。
 */
export function evaluateSandboxGate({ baseUrl, status, body }) {
  const loopback = isLoopbackBase(baseUrl)
  const refuse = (reason) => ({ allowed: false, reason, markers: { loopbackBase: loopback } })

  if (status !== 200) return refuse(GATE_REFUSAL_CODES.PREFLIGHT_UNREACHABLE)
  const data = body && typeof body === 'object' ? body.data : null
  const checks = data && typeof data === 'object' ? data.checks : null
  const sandbox = checks && typeof checks === 'object' ? checks.sandboxWriteAuthorization : null
  const posture = data && typeof data === 'object' ? data.posture : null
  const productionApply = posture && typeof posture === 'object' ? posture.productionApply : null
  if (!sandbox || typeof sandbox !== 'object' || !productionApply || typeof productionApply !== 'object') {
    return refuse(GATE_REFUSAL_CODES.PREFLIGHT_SHAPE_UNKNOWN)
  }
  if (productionApply.state !== 'closed') return refuse(GATE_REFUSAL_CODES.PRODUCTION_APPLY_CONFIGURED)
  if (sandbox.objectIdNamespacePrefix !== SANDBOX_OBJECT_ID_NAMESPACE) {
    return refuse(GATE_REFUSAL_CODES.SANDBOX_NAMESPACE_MISMATCH)
  }
  if (Number(sandbox.droppedNonNamespaceEntries || 0) !== 0) return refuse(GATE_REFUSAL_CODES.ALLOWLIST_POLLUTED)

  const allowlist = Array.isArray(sandbox.allowlist) ? sandbox.allowlist : []
  const declared = Array.isArray(sandbox.declaredSandboxTargetObjectIds) ? sandbox.declaredSandboxTargetObjectIds : []
  for (const entry of [...allowlist, ...declared]) {
    if (typeof entry !== 'string' || !SANDBOX_OBJECT_ID_NAMESPACE_PATTERN.test(entry)) {
      return refuse(GATE_REFUSAL_CODES.TARGET_OUTSIDE_SANDBOX_NAMESPACE)
    }
  }

  const sandboxModeEnabled = sandbox.modeEnabled === true
  const markers = {
    loopbackBase: loopback,
    sandboxModeEnabled,
    productionApplyClosed: true,
    allowlistedCount: allowlist.length,
    declaredSandboxTargetCount: declared.length,
  }
  // 正向标记至少要有一个。默认装机（既不是本机、也没开 STOCK_PREP_SANDBOX_MODE）空过这道门是
  // 最危险的假绿 —— 它正是「谁也没说过这是沙箱」的形状，所以这里必须拒。
  if (!loopback && !sandboxModeEnabled) return { allowed: false, reason: GATE_REFUSAL_CODES.NO_SANDBOX_MARKER, markers }
  return { allowed: true, reason: null, markers }
}

// ── 请求体守卫 ──────────────────────────────────────────────────────────────────────────────
export function assertRequestBodySafe(step, body) {
  const allowed = STEP_BODY_KEYS[step]
  if (!allowed) throw new Error(`no request-body allowlist declared for step ${step}`)
  for (const key of Object.keys(body || {})) {
    if (FORBIDDEN_BODY_KEY_PATTERN.test(key)) {
      throw new Error(`step ${step} request body carries a forbidden key class: ${key}`)
    }
    if (!allowed.includes(key)) throw new Error(`step ${step} request body carries an unexpected key: ${key}`)
  }
  return true
}

// ── values-free 自检 ────────────────────────────────────────────────────────────────────────
export function scanValuesFree(report, sentinels) {
  const serialized = JSON.stringify(report)
  const hits = []
  for (const sentinel of sentinels) {
    if (typeof sentinel !== 'string' || sentinel.length === 0) continue
    if (serialized.includes(sentinel)) hits.push(sentinelClass(sentinel))
  }
  return { clean: hits.length === 0, hitClasses: hits }
}

// 命中的哨兵本身**不回显** —— 只说命中的是哪一类，否则自检报告自己就成了泄漏面。
function sentinelClass(sentinel) {
  if (sentinel.startsWith('SYN-')) return 'fixture_part_identifier'
  return 'caller_supplied_business_value'
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────
async function requestJson(ctx, { method = 'GET', pathname, body, accept, step }) {
  if (body !== undefined) assertRequestBodySafe(step, body)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs)
  const headers = { Accept: 'application/json' }
  if (ctx.token) headers.Authorization = `Bearer ${ctx.token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const response = await ctx.fetchImpl(`${ctx.baseUrl}${pathname}`, {
      method,
      headers,
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    return { status: response.status, body: parsed, ok: accept.includes(response.status) }
  } catch (error) {
    // 连不上 / 超时也是一次「非预期状态码」，用 0 表示，不把 error.message（可能含主机名）带出去。
    return { status: 0, body: null, ok: false, transportFailed: true, errorName: error && error.name ? String(error.name) : 'Error' }
  } finally {
    clearTimeout(timer)
  }
}

async function mintDevToken(ctx, tenant) {
  const params = new URLSearchParams({ userId: 'scenario-b-replay', roles: 'admin', perms: '*:*' })
  if (tenant) params.set('tenantId', tenant)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs)
  try {
    const response = await ctx.fetchImpl(`${ctx.baseUrl}/api/auth/dev-token?${params}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    const token = parsed && typeof parsed.token === 'string' ? parsed.token : ''
    return { status: response.status, token }
  } catch {
    return { status: 0, token: '' }
  } finally {
    clearTimeout(timer)
  }
}

// ── 统计 ────────────────────────────────────────────────────────────────────────────────────
function countBy(rows, pick) {
  const out = {}
  for (const row of rows || []) {
    for (const key of pick(row)) out[key] = (out[key] || 0) + 1
  }
  return out
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────────────────
/**
 * @param {object} options
 * @param {object} options.args               parseArgs() 的结果
 * @param {Function} options.fetchImpl        注入点（自测喂假件）
 * @param {Function} [options.reseed]         v1 -> v2 之间换表内容的动作；返回 {ok, reason}
 * @param {object} [options.fixture]          注入点（自测不想读真夹具时）
 */
export async function runReplay({ args, fetchImpl, reseed, fixture: injectedFixture } = {}) {
  const fixture = injectedFixture
    || requireFrom(args.fixtureDir)(path.join(args.fixtureDir, 'scenario-b-synthetic-bom.cjs'))
  const salt = crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  const ids = {
    runV1: `${args.runPrefix}_run_v1_${salt}`,
    runV2: `${args.runPrefix}_run_v2_${salt}`,
    batchV1: `${args.runPrefix}_batch_v1_${salt}`,
    batchV2: `${args.runPrefix}_batch_v2_${salt}`,
    configId: '',
  }
  const ctx = { baseUrl: args.baseUrl, token: args.token, timeoutMs: args.timeoutMs, fetchImpl }
  const steps = []
  const report = {
    mode: args.mode,
    ok: false,
    exitCode: EXIT_CODES.STEP_FAILED,
    stoppedAt: 'GATE',
    gate: { decision: 'not_run', reason: null, markers: {}, preflightStatus: 0 },
    steps,
    batches: {},
    diff: null,
    expected: null,
    valuesFree: null,
  }
  const record = (step, result, extra = {}) => {
    steps.push({
      step,
      status: result.status,
      ok: result.ok === true,
      ...(result.transportFailed ? { transportFailed: true, errorName: result.errorName } : {}),
      ...extra,
    })
    report.stoppedAt = step
    return result.ok === true
  }
  const fail = (exitCode = EXIT_CODES.STEP_FAILED) => {
    report.ok = false
    report.exitCode = exitCode
    return report
  }

  // ── 0. token ────────────────────────────────────────────────────────────────────────────
  if (args.devToken) {
    const minted = await mintDevToken(ctx, args.tenant)
    // dev-token 在 NODE_ENV=production 上是 404（packages/core-backend/src/routes/auth.ts:64），
    // 所以这条路径失败本身也是一条弱沙箱信号 —— 但门的判定不靠它，靠下面的预检。
    if (minted.status !== 200 || !minted.token) {
      record('GATE', { status: minted.status, ok: false }, { note: 'dev_token_unavailable' })
      report.gate = { decision: 'refused', reason: GATE_REFUSAL_CODES.PREFLIGHT_UNREACHABLE, markers: { loopbackBase: isLoopbackBase(args.baseUrl) }, preflightStatus: 0 }
      return fail(EXIT_CODES.GATE_REFUSED)
    }
    ctx.token = minted.token
  }

  // ── 1. 安全门 ───────────────────────────────────────────────────────────────────────────
  const preflight = await requestJson(ctx, {
    step: 'GATE',
    pathname: '/api/integration/stock-preparation/preflight',
    accept: [200],
  })
  const gate = evaluateSandboxGate({ baseUrl: args.baseUrl, status: preflight.status, body: preflight.body })
  report.gate = {
    decision: gate.allowed ? 'allowed' : 'refused',
    reason: gate.reason,
    markers: gate.markers,
    preflightStatus: preflight.status,
  }
  record('GATE', { status: preflight.status, ok: gate.allowed, ...(preflight.transportFailed ? { transportFailed: true, errorName: preflight.errorName } : {}) })
  if (!gate.allowed) return fail(EXIT_CODES.GATE_REFUSED)

  // ── 2. 源登记（测试里被替身顶掉的那两个注入点，在真机上是这三条路由）────────────────────
  const registerSystem = await requestJson(ctx, {
    step: 'REGISTER_SYSTEM',
    method: 'POST',
    pathname: '/api/integration/external-systems',
    body: {
      id: args.systemId,
      name: 'scenario-b-synthetic-bom',
      kind: ADAPTER_KIND,
      role: 'source',
      config: { dataSourceId: args.dataSourceId },
    },
    accept: [200, 201],
  })
  if (!record('REGISTER_SYSTEM', registerSystem)) return fail()

  const saveConfig = await requestJson(ctx, {
    step: 'SAVE_CONFIG',
    method: 'POST',
    pathname: '/api/integration/read-source-configs',
    body: { config: fixture.readSourceConfig({ systemId: args.systemId }) },
    accept: [200, 201],
  })
  ids.configId = saveConfig.body && saveConfig.body.data && typeof saveConfig.body.data.id === 'string'
    ? saveConfig.body.data.id
    : ''
  if (!record('SAVE_CONFIG', { ...saveConfig, ok: saveConfig.ok && Boolean(ids.configId) }, { configIdPresent: Boolean(ids.configId) })) return fail()

  const approve = await requestJson(ctx, {
    step: 'APPROVE_CONFIG',
    method: 'POST',
    pathname: `/api/integration/read-source-configs/${encodeURIComponent(ids.configId)}/approve`,
    body: {},
    accept: [200],
  })
  if (!record('APPROVE_CONFIG', approve)) return fail()

  // ── 3. 第一批次源运行 -> staging 落库 ──────────────────────────────────────────────────────
  const runBody = (overrides) => ({
    workspaceId: args.workspace,
    projectId: args.projectId,
    ...(args.sourceProjectNo ? { sourceProjectNo: args.sourceProjectNo } : { sourceProjectNo: fixture.PROJECT_NO }),
    ...(args.projectName ? { projectName: args.projectName } : {}),
    readSourceConfigId: ids.configId,
    ...overrides,
  })

  const runV1 = await requestJson(ctx, {
    step: 'RUN_V1',
    method: 'POST',
    pathname: '/api/integration/stock-preparation/mvp/source-runs/plm-bom',
    body: runBody({ syncRunId: ids.runV1, snapshotBatchId: ids.batchV1, snapshotVersion: 1 }),
    accept: [201],
  })
  const v1Created = linesCreated(runV1.body)
  if (!record('RUN_V1', runV1, { createdLines: v1Created, snapshotBatchId: ids.batchV1 })) return fail()
  report.batches.v1 = { snapshotBatchId: ids.batchV1, createdLines: v1Created }

  if (args.mode === 'v1') {
    const list = await requestJson(ctx, {
      step: 'BATCH_LIST',
      pathname: `/api/integration/stock-preparation/snapshot-batches?projectId=${encodeURIComponent(args.projectId)}`,
      accept: [200],
    })
    const listed = findBatch(list.body, ids.batchV1)
    const listOk = list.ok && Boolean(listed) && listed.incomplete === false
    if (!record('BATCH_LIST', { ...list, ok: listOk }, { batchCount: batchCount(list.body), v1Incomplete: listed ? listed.incomplete : null })) return fail()
    report.batches.v1.lineCount = listed ? listed.lineCount : null
    report.expected = { rowCountV1: fixture.ROW_COUNT }
    const v1Ok = v1Created === fixture.ROW_COUNT && (listed ? listed.lineCount : null) === fixture.ROW_COUNT
    if (!record('VERIFY_EXPECTED', { status: 200, ok: v1Ok })) return fail()
    return finish(report, args, fixture)
  }

  // ── 4. 换表内容（操作员动作 —— 脚本自己不连库）─────────────────────────────────────────────
  const reseedResult = await (reseed ? reseed({ args, fixture }) : defaultReseed({ args }))
  if (!record('RESEED_V2', { status: reseedResult.ok ? 200 : 0, ok: reseedResult.ok === true }, { reason: reseedResult.reason })) return fail()

  // ── 5. 第二批次源运行 ────────────────────────────────────────────────────────────────────
  const runV2 = await requestJson(ctx, {
    step: 'RUN_V2',
    method: 'POST',
    pathname: '/api/integration/stock-preparation/mvp/source-runs/plm-bom',
    body: runBody({ syncRunId: ids.runV2, snapshotBatchId: ids.batchV2, snapshotVersion: 2 }),
    accept: [201],
  })
  const v2Created = linesCreated(runV2.body)
  if (!record('RUN_V2', runV2, { createdLines: v2Created, snapshotBatchId: ids.batchV2 })) return fail()
  report.batches.v2 = { snapshotBatchId: ids.batchV2, createdLines: v2Created }

  // ── 6. 三条只读读面 ─────────────────────────────────────────────────────────────────────
  const list = await requestJson(ctx, {
    step: 'BATCH_LIST',
    pathname: `/api/integration/stock-preparation/snapshot-batches?projectId=${encodeURIComponent(args.projectId)}`,
    accept: [200],
  })
  const listedV1 = findBatch(list.body, ids.batchV1)
  const listedV2 = findBatch(list.body, ids.batchV2)
  const listOk = list.ok && Boolean(listedV1) && Boolean(listedV2)
    && listedV1.incomplete === false && listedV2.incomplete === false
  if (!record('BATCH_LIST', { ...list, ok: listOk }, {
    batchCount: batchCount(list.body),
    v1Incomplete: listedV1 ? listedV1.incomplete : null,
    v2Incomplete: listedV2 ? listedV2.incomplete : null,
  })) return fail()
  report.batches.v1.lineCount = listedV1.lineCount
  report.batches.v2.lineCount = listedV2.lineCount

  const diff = await requestJson(ctx, {
    step: 'DIFF',
    pathname: `/api/integration/stock-preparation/snapshot-batches/${encodeURIComponent(ids.batchV2)}/diff`,
    accept: [200],
  })
  const diffData = diff.body && diff.body.data ? diff.body.data : null
  const diffOk = diff.ok && Boolean(diffData) && diffData.baseSnapshotBatchId === ids.batchV1
  if (!record('DIFF', { ...diff, ok: diffOk }, { basePickedIsV1: Boolean(diffData) && diffData.baseSnapshotBatchId === ids.batchV1 })) return fail()

  const rows = await requestJson(ctx, {
    step: 'DIFF_ROWS',
    pathname: `/api/integration/stock-preparation/snapshot-batches/${encodeURIComponent(ids.batchV2)}/diff/rows`,
    accept: [200],
  })
  const rowsData = rows.body && rows.body.data ? rows.body.data : null
  const rowsOk = rows.ok && Boolean(rowsData) && Array.isArray(rowsData.rows)
  if (!record('DIFF_ROWS', { ...rows, ok: rowsOk }, { rowCount: rowsData ? rowsData.rowCount : null })) return fail()

  report.diff = {
    baseSnapshotBatchId: ids.batchV1,
    currentSnapshotBatchId: ids.batchV2,
    rowCount: rowsData.rowCount,
    heldRowCount: rowsData.heldRowCount,
    byDiffType: countBy(rowsData.rows, (row) => (row && row.diffType ? [row.diffType] : [])),
    byChangeType: countBy(rowsData.rows, (row) => (row && Array.isArray(row.changeTypes) ? row.changeTypes : [])),
    changeCounts: projectCounts(diffData.changeCounts),
    blockingExceptionCount: numberOrNull(diffData.blockingExceptionCount),
  }

  // ── 7. 与夹具的期望逐类比对 ─────────────────────────────────────────────────────────────
  const expected = fixture.V2_EXPECTED_DIFF
  report.expected = {
    rowCountV1: fixture.ROW_COUNT,
    rowCountV2: fixture.ROW_COUNT_V2,
    diffTotal: expected.total,
    added: expected.added,
    removed: expected.removed,
    changedQuantity: expected.changedQuantity,
    changedComponentCode: expected.changedComponentCode,
    unchanged: expected.unchanged,
  }
  const d = report.diff
  const verified =
    report.batches.v1.createdLines === fixture.ROW_COUNT &&
    report.batches.v2.createdLines === fixture.ROW_COUNT_V2 &&
    report.batches.v1.lineCount === fixture.ROW_COUNT &&
    report.batches.v2.lineCount === fixture.ROW_COUNT_V2 &&
    d.rowCount === expected.total &&
    d.heldRowCount === expected.added + expected.removed + expected.changedQuantity + expected.changedComponentCode &&
    (d.byDiffType.added || 0) === expected.added &&
    (d.byDiffType.removed || 0) === expected.removed &&
    (d.byDiffType.changed || 0) === expected.changedQuantity + expected.changedComponentCode &&
    (d.byDiffType.unchanged || 0) === expected.unchanged &&
    (d.byChangeType.quantity_changed || 0) === expected.changedQuantity &&
    (d.byChangeType.component_code_changed || 0) === expected.changedComponentCode
  if (!record('VERIFY_EXPECTED', { status: 200, ok: verified })) return fail()

  return finish(report, args, fixture)
}

function finish(report, args, fixture) {
  // 哨兵 = 夹具的业务值 + 调用方在命令行上传进来的业务值。两类都不许出现在报告里。
  const sentinels = [
    fixture.PROJECT_NO, fixture.ROOT_PART_NO, 'SYN-',
    fixture.V2_ADDED_PART_NO, fixture.V2_SUBSTITUTED_FROM_PART_NO, fixture.V2_SUBSTITUTED_TO_PART_NO,
    fixture.V2_ADDED_PATH_KEY, fixture.V2_REMOVED_PATH_KEY, fixture.V2_SUBSTITUTED_PATH_KEY,
    args.sourceProjectNo, args.projectName,
  ].filter(Boolean)
  const scan = scanValuesFree(report, sentinels)
  report.valuesFree = scan
  if (!scan.clean) {
    report.ok = false
    report.exitCode = EXIT_CODES.STEP_FAILED
    report.stoppedAt = 'VERIFY_EXPECTED'
    return report
  }
  report.ok = true
  report.exitCode = EXIT_CODES.OK
  return report
}

function linesCreated(body) {
  const auto = body && body.data && body.data.autoPersist ? body.data.autoPersist : null
  const created = auto && auto.created ? auto.created : null
  return created && typeof created.lines === 'number' ? created.lines : null
}

function batchCount(body) {
  const data = body && body.data ? body.data : null
  return data && typeof data.batchCount === 'number' ? data.batchCount : null
}

function findBatch(body, snapshotBatchId) {
  const data = body && body.data ? body.data : null
  const batches = data && Array.isArray(data.batches) ? data.batches : []
  return batches.find((batch) => batch && batch.snapshotBatchId === snapshotBatchId) || null
}

// changeCounts 逐键过 Number() —— 服务端即使把业务值塞进某个计数键的值里，也到不了报告。
function projectCounts(counts) {
  const out = {}
  for (const [key, value] of Object.entries(counts || {})) {
    if (!/^[a-zA-Z]+$/.test(key)) continue
    out[key] = Number.isFinite(Number(value)) ? Number(value) : null
  }
  return out
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null
}

// v1 -> v2 之间换表内容。脚本自己**不连库**：要么代跑操作员给的那条命令，要么交互式等确认。
async function defaultReseed({ args }) {
  if (args.reseedCommand) {
    const { spawn } = await import('node:child_process')
    return await new Promise((resolve) => {
      const child = spawn(args.reseedCommand, { shell: true, stdio: 'inherit' })
      child.on('exit', (code) => resolve(code === 0 ? { ok: true, reason: 'reseed_command_ok' } : { ok: false, reason: 'reseed_command_failed' }))
      child.on('error', () => resolve({ ok: false, reason: 'reseed_command_failed' }))
    })
  }
  if (!process.stdin.isTTY) return { ok: false, reason: 'reseed_step_unavailable' }
  process.stderr.write(
    `\n[scenario-b-replay] 现在把 v2 内容灌进合成表，然后回车继续：\n`
    + `    psql -d <your synthetic db> -v ON_ERROR_STOP=1 -f ${path.join(args.fixtureDir, '03-seed-v2.sql')}\n`
    + `(脚本自己不连数据库。给 --reseed-command 可以让它代跑这一步。)\n> `,
  )
  return await new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.once('data', () => { process.stdin.pause(); resolve({ ok: true, reason: 'operator_confirmed' }) })
  })
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────
export async function main(argv = process.argv, { fetchImpl = fetch, out = process.stdout, err = process.stderr } = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      err.write(`[scenario-b-replay] usage: ${error.message}\n`)
      return EXIT_CODES.USAGE
    }
    throw error
  }
  const report = await runReplay({ args, fetchImpl })
  if (args.json) out.write(`${JSON.stringify(report, null, 2)}\n`)
  else out.write(`${renderReport(report)}\n`)
  if (report.exitCode === EXIT_CODES.GATE_REFUSED) {
    err.write(`[scenario-b-replay] SANDBOX GATE REFUSED: ${report.gate.reason}\n`)
  }
  return report.exitCode
}

export function renderReport(report) {
  const lines = []
  lines.push('── scenario-b replay ─────────────────────────────────────────')
  lines.push(`mode=${report.mode} ok=${report.ok} exitCode=${report.exitCode} stoppedAt=${report.stoppedAt}`)
  lines.push(`gate: ${report.gate.decision}${report.gate.reason ? ` (${report.gate.reason})` : ''} markers=${JSON.stringify(report.gate.markers)}`)
  for (const step of report.steps) {
    lines.push(`  ${step.ok ? 'PASS' : 'FAIL'} ${step.step.padEnd(16)} http=${step.status}`)
  }
  if (report.batches.v1) lines.push(`batch v1: created=${report.batches.v1.createdLines} listed=${report.batches.v1.lineCount ?? '-'}`)
  if (report.batches.v2) lines.push(`batch v2: created=${report.batches.v2.createdLines} listed=${report.batches.v2.lineCount ?? '-'}`)
  if (report.diff) {
    lines.push(`diff rows=${report.diff.rowCount} held=${report.diff.heldRowCount}`)
    lines.push(`  byDiffType   ${JSON.stringify(report.diff.byDiffType)}`)
    lines.push(`  byChangeType ${JSON.stringify(report.diff.byChangeType)}`)
  }
  if (report.expected) lines.push(`expected     ${JSON.stringify(report.expected)}`)
  if (report.valuesFree) lines.push(`values-free self-check: ${report.valuesFree.clean ? 'clean' : `HIT ${JSON.stringify(report.valuesFree.hitClasses)}`}`)
  return lines.join('\n')
}

const here = selfPath()
const invokedDirectly = Boolean(here) && Boolean(process.argv[1]) && here === path.resolve(process.argv[1])
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`[scenario-b-replay] fatal: ${error && error.name ? error.name : 'Error'}\n`)
    process.exitCode = EXIT_CODES.STEP_FAILED
  })
}
