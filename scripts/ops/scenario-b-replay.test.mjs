// ---------------------------------------------------------------------------------------------
// scripts/ops/scenario-b-replay.mjs 的自测 —— 注入假 fetch，不碰网络、不碰数据库。
//
// 证四件事：
//   ① 沙箱门：七种拒绝形状逐个点名，拒绝时**一个业务请求都不发**；放行只在有正向标记时发生。
//   ② 逐步状态码判成败：每一步各自换一个非期望状态码，断言 exitCode=1、stoppedAt 是那一步、
//      并且**后面的请求没有发出去**（不假绿）。
//   ③ 报告 values-free：服务端把夹具件号塞进响应也进不了报告；自检自身也不回显命中的值。
//   ④ 永不设置 autopersist / 永不发 tenantId：请求体键白名单 + 逐请求实测。
//
// 变异自证（内存级）：把**这份脚本自己的源码**读进来，做一处单行锚点替换，用 data: URL 编成一个
// 新模块 —— 磁盘上一个字节都不改（并发反驳者互撞的老坑）。变异体把「生产 Apply 已配置」那一条
// 判据拿掉之后，①里那条断言必须红。
//
// Run: node --test scripts/ops/scenario-b-replay.test.mjs
// ---------------------------------------------------------------------------------------------

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EXIT_CODES,
  GATE_REFUSAL_CODES,
  SANDBOX_OBJECT_ID_NAMESPACE,
  SANDBOX_OBJECT_ID_NAMESPACE_PATTERN,
  UsageError,
  assertRequestBodySafe,
  evaluateSandboxGate,
  isLoopbackBase,
  parseArgs,
  runReplay,
  scanValuesFree,
} from './scenario-b-replay.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = path.join(HERE, 'scenario-b-replay.mjs')
const REPO_ROOT = path.resolve(HERE, '..', '..')
const PROVISIONING_PATH = path.join(
  REPO_ROOT, 'plugins', 'plugin-integration-core', 'lib', 'stock-preparation-target-provisioning.cjs',
)

// ── 合成夹具替身（注入，不读真夹具文件 —— 自测不依赖夹具在不在）────────────────────────────
const FIXTURE = Object.freeze({
  PROJECT_NO: 'SYN-PRJ-B1',
  ROOT_PART_NO: 'SYN-ROOT-0001',
  ROW_COUNT: 54,
  ROW_COUNT_V2: 54,
  V2_ADDED_PART_NO: 'SYN-PRT-06-09',
  V2_ADDED_PATH_KEY: 'SYN-ROOT-0001/SYN-SUB-06/SYN-PRT-06-09',
  V2_REMOVED_PATH_KEY: 'SYN-ROOT-0001/SYN-SUB-04/SYN-PRT-04-08',
  V2_SUBSTITUTED_PATH_KEY: 'SYN-ROOT-0001/SYN-SUB-02/SYN-PRT-02-05',
  V2_SUBSTITUTED_FROM_PART_NO: 'SYN-PRT-02-05',
  V2_SUBSTITUTED_TO_PART_NO: 'SYN-PRT-02-05R',
  V2_EXPECTED_DIFF: Object.freeze({
    changedQuantity: 1, changedComponentCode: 1, added: 1, removed: 1, unchanged: 51, total: 55,
  }),
  readSourceConfig: ({ systemId }) => ({ version: 1, systemId, requiredKind: 'data-source:sql-readonly' }),
})

const SANDBOX_PREFLIGHT = Object.freeze({
  ok: true,
  data: {
    ready: true,
    checks: {
      sandboxWriteAuthorization: {
        modeEnabled: true,
        allowlist: ['plm_stock_preparation_sandbox_replay'],
        allowlistedCount: 1,
        declaredSandboxTargetObjectIds: ['plm_stock_preparation_sandbox_replay'],
        unlistedDeclaredTargetObjectIds: [],
        objectIdNamespacePrefix: SANDBOX_OBJECT_ID_NAMESPACE,
        droppedNonNamespaceEntries: 0,
      },
    },
    posture: { productionApply: { state: 'closed', canonicalObjectId: 'plm_stock_preparation_main' } },
  },
})

function clone(value) { return JSON.parse(JSON.stringify(value)) }

function baseArgs(overrides = {}) {
  return parseArgs([
    'node', 'scenario-b-replay.mjs',
    '--base-url', overrides.baseUrl || 'http://127.0.0.1:8900',
    '--token', 'test-token',
    '--mode', overrides.mode || 'v1v2',
    '--project-id', 'business_project_scenario_b',
    ...(overrides.extra || []),
  ])
}

// ── 假 fetch：按路径分派，逐次记录请求 ──────────────────────────────────────────────────────
function diffRows({ added = 1, removed = 1, quantity = 1, componentCode = 1, unchanged = 51 } = {}) {
  const rows = []
  for (let i = 0; i < added; i += 1) rows.push({ diffType: 'added', changeTypes: ['added'] })
  for (let i = 0; i < removed; i += 1) rows.push({ diffType: 'removed', changeTypes: ['removed'] })
  for (let i = 0; i < quantity; i += 1) rows.push({ diffType: 'changed', changeTypes: ['quantity_changed', 'source_fingerprint_changed'] })
  for (let i = 0; i < componentCode; i += 1) rows.push({ diffType: 'changed', changeTypes: ['component_code_changed', 'source_fingerprint_changed'] })
  for (let i = 0; i < unchanged; i += 1) rows.push({ diffType: 'unchanged', changeTypes: [] })
  return rows
}

/**
 * @param {object} plan  每一步的 {status, body}；不给的用默认绿值。
 */
function makeFetch(plan = {}) {
  const calls = []
  const step = (name, fallback) => plan[name] || fallback
  const impl = async (url, init = {}) => {
    const u = new URL(url)
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url: `${u.pathname}${u.search}`, method, headers: init.headers || {}, body })
    const respond = ({ status, body: payload }) => ({
      status,
      async text() { return payload === undefined ? '' : JSON.stringify(payload) },
    })
    const p = u.pathname
    if (p === '/api/auth/dev-token') return respond(step('DEV_TOKEN', { status: 200, body: { token: 'minted' } }))
    if (p === '/api/integration/stock-preparation/preflight') {
      return respond(step('GATE', { status: 200, body: clone(SANDBOX_PREFLIGHT) }))
    }
    if (p === '/api/integration/external-systems') {
      return respond(step('REGISTER_SYSTEM', { status: 201, body: { ok: true, data: { id: 'syn-bom-source-b1' } } }))
    }
    if (p === '/api/integration/read-source-configs') {
      return respond(step('SAVE_CONFIG', { status: 201, body: { ok: true, data: { id: 'cfg_replay_1' } } }))
    }
    if (/^\/api\/integration\/read-source-configs\/.+\/approve$/.test(p)) {
      return respond(step('APPROVE_CONFIG', { status: 200, body: { ok: true, data: { status: 'approved' } } }))
    }
    if (p === '/api/integration/stock-preparation/mvp/source-runs/plm-bom') {
      const which = body && body.snapshotVersion === 2 ? 'RUN_V2' : 'RUN_V1'
      const lines = which === 'RUN_V1' ? FIXTURE.ROW_COUNT : FIXTURE.ROW_COUNT_V2
      return respond(step(which, { status: 201, body: { ok: true, data: { autoPersist: { mode: 'created', created: { lines } } } } }))
    }
    if (p === '/api/integration/stock-preparation/snapshot-batches') {
      return respond(step('BATCH_LIST', {
        status: 200,
        body: {
          ok: true,
          data: {
            batchCount: 2,
            batches: [
              { snapshotBatchId: lastBatchId(calls, 2), snapshotVersion: 2, lineCount: FIXTURE.ROW_COUNT_V2, incomplete: false },
              { snapshotBatchId: lastBatchId(calls, 1), snapshotVersion: 1, lineCount: FIXTURE.ROW_COUNT, incomplete: false },
            ],
          },
        },
      }))
    }
    if (/\/diff\/rows$/.test(p)) {
      return respond(step('DIFF_ROWS', {
        status: 200,
        body: { ok: true, data: { baseSnapshotBatchId: lastBatchId(calls, 1), rowCount: 55, heldRowCount: 4, rows: diffRows() } },
      }))
    }
    if (/\/diff$/.test(p)) {
      return respond(step('DIFF', {
        status: 200,
        body: {
          ok: true,
          data: {
            snapshotBatchId: lastBatchId(calls, 2),
            baseSnapshotBatchId: lastBatchId(calls, 1),
            changeCounts: { added: 1, removed: 1, quantityChanged: 1, fingerprintChanged: 2 },
            blockingExceptionCount: 0,
          },
        },
      }))
    }
    throw new Error(`unplanned route: ${p}`)
  }
  return { impl, calls }
}

// 假件要和脚本**自己生成的**批次 id 对上，否则 BATCH_LIST/DIFF 的断言会因为 id 不匹配而红。
function lastBatchId(calls, version) {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i]
    if (call.body && call.body.snapshotVersion === version && call.body.snapshotBatchId) return call.body.snapshotBatchId
  }
  return `missing_batch_v${version}`
}

const okReseed = async () => ({ ok: true, reason: 'test_reseed' })

async function replay({ plan = {}, args = baseArgs(), reseed = okReseed } = {}) {
  const { impl, calls } = makeFetch(plan)
  const report = await runReplay({ args, fetchImpl: impl, reseed, fixture: FIXTURE })
  return { report, calls }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ① 沙箱门
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('gate: 仓库里的沙箱命名空间定义与本脚本的镜像逐字一致', () => {
  const source = fs.readFileSync(PROVISIONING_PATH, 'utf8').replace(/\r\n/g, '\n')
  assert.ok(
    source.includes(`const SANDBOX_OBJECT_ID_NAMESPACE = '${SANDBOX_OBJECT_ID_NAMESPACE}'`),
    '镜像的命名空间常量必须在 stock-preparation-target-provisioning.cjs 里逐字存在',
  )
  assert.ok(
    source.includes(`const SANDBOX_OBJECT_ID_NAMESPACE_PATTERN = ${SANDBOX_OBJECT_ID_NAMESPACE_PATTERN.source.replace(/^/, '/')}/`),
    '镜像的命名空间正则必须与源码逐字一致',
  )
})

test('gate: 生产 Apply 已配置 -> 拒绝，退出码 2，一个业务请求都不发', async () => {
  const preflight = clone(SANDBOX_PREFLIGHT)
  preflight.data.posture.productionApply.state = 'configured'
  const { report, calls } = await replay({ plan: { GATE: { status: 200, body: preflight } } })
  assert.equal(report.exitCode, EXIT_CODES.GATE_REFUSED)
  assert.equal(report.gate.reason, GATE_REFUSAL_CODES.PRODUCTION_APPLY_CONFIGURED)
  assert.equal(calls.length, 1, '只发了预检那一个请求')
  assert.equal(calls[0].url, '/api/integration/stock-preparation/preflight')
})

test('gate: 非本机 + 没开沙箱模式 -> 没有正向标记就拒（默认装机空过是最危险的假绿）', async () => {
  const preflight = clone(SANDBOX_PREFLIGHT)
  preflight.data.checks.sandboxWriteAuthorization.modeEnabled = false
  preflight.data.checks.sandboxWriteAuthorization.allowlist = []
  preflight.data.checks.sandboxWriteAuthorization.allowlistedCount = 0
  preflight.data.checks.sandboxWriteAuthorization.declaredSandboxTargetObjectIds = []
  const args = baseArgs({ baseUrl: 'http://stock-prep.example.internal:8900' })
  const { report, calls } = await replay({ args, plan: { GATE: { status: 200, body: preflight } } })
  assert.equal(report.exitCode, EXIT_CODES.GATE_REFUSED)
  assert.equal(report.gate.reason, GATE_REFUSAL_CODES.NO_SANDBOX_MARKER)
  assert.equal(calls.length, 1)
})

test('gate: 本机是正向标记 —— 没开沙箱模式也放行，但生产姿态仍然必过', () => {
  const preflight = clone(SANDBOX_PREFLIGHT)
  preflight.data.checks.sandboxWriteAuthorization.modeEnabled = false
  const allowed = evaluateSandboxGate({ baseUrl: 'http://127.0.0.1:8900', status: 200, body: preflight })
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.markers.loopbackBase, true)
  assert.equal(allowed.markers.sandboxModeEnabled, false)

  preflight.data.posture.productionApply.state = 'configured'
  const refused = evaluateSandboxGate({ baseUrl: 'http://127.0.0.1:8900', status: 200, body: preflight })
  assert.equal(refused.allowed, false, '本机不豁免生产姿态这一条')
  assert.equal(refused.reason, GATE_REFUSAL_CODES.PRODUCTION_APPLY_CONFIGURED)
})

test('gate: 允许清单被污染 / 目标出了沙箱命名空间 / 命名空间前缀对不上 -> 各自拒绝', () => {
  const polluted = clone(SANDBOX_PREFLIGHT)
  polluted.data.checks.sandboxWriteAuthorization.droppedNonNamespaceEntries = 1
  assert.equal(
    evaluateSandboxGate({ baseUrl: 'http://127.0.0.1:8900', status: 200, body: polluted }).reason,
    GATE_REFUSAL_CODES.ALLOWLIST_POLLUTED,
  )

  const outside = clone(SANDBOX_PREFLIGHT)
  outside.data.checks.sandboxWriteAuthorization.declaredSandboxTargetObjectIds = ['plm_stock_preparation_main']
  assert.equal(
    evaluateSandboxGate({ baseUrl: 'http://127.0.0.1:8900', status: 200, body: outside }).reason,
    GATE_REFUSAL_CODES.TARGET_OUTSIDE_SANDBOX_NAMESPACE,
  )

  const drifted = clone(SANDBOX_PREFLIGHT)
  drifted.data.checks.sandboxWriteAuthorization.objectIdNamespacePrefix = 'plm_stock_preparation'
  assert.equal(
    evaluateSandboxGate({ baseUrl: 'http://127.0.0.1:8900', status: 200, body: drifted }).reason,
    GATE_REFUSAL_CODES.SANDBOX_NAMESPACE_MISMATCH,
  )
})

test('gate: 预检 401/403/404 或形状不认识 -> 失败关闭', () => {
  for (const status of [401, 403, 404, 500]) {
    const result = evaluateSandboxGate({ baseUrl: 'http://127.0.0.1:8900', status, body: null })
    assert.equal(result.allowed, false)
    assert.equal(result.reason, GATE_REFUSAL_CODES.PREFLIGHT_UNREACHABLE)
  }
  const shapeless = evaluateSandboxGate({ baseUrl: 'http://127.0.0.1:8900', status: 200, body: { ok: true, data: {} } })
  assert.equal(shapeless.reason, GATE_REFUSAL_CODES.PREFLIGHT_SHAPE_UNKNOWN)
})

test('gate: markers 是布尔/计数，从不回显 allowlist 字符串或主机', () => {
  const result = evaluateSandboxGate({ baseUrl: 'http://127.0.0.1:8900', status: 200, body: clone(SANDBOX_PREFLIGHT) })
  const serialized = JSON.stringify(result.markers)
  assert.equal(serialized.includes('plm_stock_preparation_sandbox_replay'), false)
  assert.equal(serialized.includes('127.0.0.1'), false)
  assert.equal(result.markers.allowlistedCount, 1)
})

test('gate: loopback 判定', () => {
  for (const url of ['http://127.0.0.1:8900', 'http://localhost:8900', 'http://[::1]:8900', 'http://127.5.5.5']) {
    assert.equal(isLoopbackBase(url), true, url)
  }
  for (const url of ['http://10.0.0.5:8900', 'https://prod.example.com', 'not a url']) {
    assert.equal(isLoopbackBase(url), false, url)
  }
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ② 逐步状态码判成败
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('happy path v1v2：全绿、退出码 0、四类变更逐类对上夹具期望', async () => {
  const { report, calls } = await replay()
  assert.equal(report.exitCode, EXIT_CODES.OK, JSON.stringify(report.steps))
  assert.equal(report.ok, true)
  assert.equal(report.stoppedAt, 'VERIFY_EXPECTED')
  assert.deepEqual(report.steps.map((s) => s.step), [
    'GATE', 'REGISTER_SYSTEM', 'SAVE_CONFIG', 'APPROVE_CONFIG', 'RUN_V1',
    'RESEED_V2', 'RUN_V2', 'BATCH_LIST', 'DIFF', 'DIFF_ROWS', 'VERIFY_EXPECTED',
  ])
  assert.equal(report.steps.every((s) => s.ok), true)
  assert.deepEqual(report.diff.byDiffType, { added: 1, removed: 1, changed: 2, unchanged: 51 })
  assert.equal(report.diff.byChangeType.quantity_changed, 1)
  assert.equal(report.diff.byChangeType.component_code_changed, 1)
  assert.equal(report.diff.rowCount, FIXTURE.V2_EXPECTED_DIFF.total)
  assert.equal(report.diff.heldRowCount, 4)
  assert.equal(report.batches.v1.createdLines, FIXTURE.ROW_COUNT)
  assert.equal(report.batches.v2.createdLines, FIXTURE.ROW_COUNT_V2)
  assert.equal(report.valuesFree.clean, true)
  // 两次源运行用的是**不同**的批次 id（不可变批次的前提）。
  const runs = calls.filter((c) => c.url.endsWith('/source-runs/plm-bom'))
  assert.equal(runs.length, 2)
  assert.notEqual(runs[0].body.snapshotBatchId, runs[1].body.snapshotBatchId)
})

test('每一步的状态码失败即停：停在那一步，后面的请求没有发出去', async () => {
  const cases = [
    // 第三列 = 到这一步为止**总共**该发出去的请求数（GATE 的预检是第 1 个）。
    ['REGISTER_SYSTEM', { status: 403, body: { ok: false, error: { code: 'FORBIDDEN' } } }, 2],
    ['SAVE_CONFIG', { status: 400, body: { ok: false, error: { code: 'READ_SOURCE_CONFIG_INVALID' } } }, 3],
    ['APPROVE_CONFIG', { status: 409, body: { ok: false, error: { code: 'ALREADY_APPROVED' } } }, 4],
    ['RUN_V1', { status: 200, body: { ok: true, data: { autoPersist: { mode: 'skipped' } } } }, 5],
    ['RUN_V2', { status: 409, body: { ok: false, error: { code: 'PERSIST_IDEMPOTENCY_CONFLICT' } } }, 6],
    ['BATCH_LIST', { status: 500, body: { ok: false } }, 7],
    ['DIFF', { status: 404, body: { ok: false } }, 8],
    ['DIFF_ROWS', { status: 422, body: { ok: false } }, 9],
  ]
  for (const [step, response, expectedCallCount] of cases) {
    const { report, calls } = await replay({ plan: { [step]: response } })
    assert.equal(report.exitCode, EXIT_CODES.STEP_FAILED, `${step} 应判失败`)
    assert.equal(report.ok, false, step)
    assert.equal(report.stoppedAt, step, `停在 ${step}`)
    assert.equal(calls.length, expectedCallCount, `${step} 之后不再发请求（实际 ${calls.length}）`)
    const last = report.steps[report.steps.length - 1]
    assert.equal(last.step, step)
    assert.equal(last.ok, false)
    assert.equal(last.status, response.status, '报告记的是服务端真给的状态码')
  }
})

test('RUN_V1 拿到 200 而不是 201 也算失败（幂等 noop 不是一次复演）', async () => {
  const { report } = await replay({ plan: { RUN_V1: { status: 200, body: { ok: true, data: { autoPersist: { mode: 'skipped_existing' } } } } } })
  assert.equal(report.stoppedAt, 'RUN_V1')
  assert.equal(report.exitCode, EXIT_CODES.STEP_FAILED)
})

test('服务端状态码全绿但行数/分布对不上 -> VERIFY_EXPECTED 红', async () => {
  const { report } = await replay({
    plan: {
      DIFF_ROWS: {
        status: 200,
        body: { ok: true, data: { rowCount: 54, heldRowCount: 3, rows: diffRows({ removed: 0, unchanged: 52 }) } },
      },
    },
  })
  assert.equal(report.stoppedAt, 'VERIFY_EXPECTED')
  assert.equal(report.exitCode, EXIT_CODES.STEP_FAILED)
  assert.equal(report.diff.byDiffType.removed, undefined, '一条 removed 都没读出来')
})

test('mode=v1：只落一个批次，不发 diff 那两条读面', async () => {
  const args = baseArgs({ mode: 'v1' })
  const { report, calls } = await replay({ args })
  assert.equal(report.exitCode, EXIT_CODES.OK, JSON.stringify(report.steps))
  assert.deepEqual(report.steps.map((s) => s.step), [
    'GATE', 'REGISTER_SYSTEM', 'SAVE_CONFIG', 'APPROVE_CONFIG', 'RUN_V1', 'BATCH_LIST', 'VERIFY_EXPECTED',
  ])
  assert.equal(calls.some((c) => /\/diff/.test(c.url)), false)
  assert.equal(report.diff, null)
})

test('换表那一步拿不到（既没有 --reseed-command 又不是 TTY）-> 停在 RESEED_V2，不发第二次源运行', async () => {
  const { report, calls } = await replay({ reseed: async () => ({ ok: false, reason: 'reseed_step_unavailable' }) })
  assert.equal(report.stoppedAt, 'RESEED_V2')
  assert.equal(report.exitCode, EXIT_CODES.STEP_FAILED)
  assert.equal(calls.filter((c) => c.url.endsWith('/source-runs/plm-bom')).length, 1)
  assert.equal(report.steps[report.steps.length - 1].reason, 'reseed_step_unavailable')
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ③ 报告 values-free
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('服务端把夹具件号塞进每一个响应，报告里依旧一个业务值都没有', async () => {
  const leaky = (payload) => ({ ...payload, leakedPartNo: FIXTURE.V2_SUBSTITUTED_TO_PART_NO })
  const { report } = await replay({
    plan: {
      REGISTER_SYSTEM: { status: 201, body: { ok: true, data: leaky({ id: 'syn-bom-source-b1' }) } },
      SAVE_CONFIG: { status: 201, body: { ok: true, data: leaky({ id: 'cfg_replay_1' }) } },
      DIFF: {
        status: 200,
        body: {
          ok: true,
          data: {
            baseSnapshotBatchId: null,
            changeCounts: { added: 1, removed: 1, [FIXTURE.V2_ADDED_PART_NO]: 9 },
            blockingExceptionCount: 0,
            leakedProjectNo: FIXTURE.PROJECT_NO,
          },
        },
      },
    },
  })
  // DIFF 的 base 判定会先红（baseSnapshotBatchId 不是 v1），这正好证明：即使在**失败**的报告上，
  // 也没有任何响应文本被原样抄进来。
  const serialized = JSON.stringify(report)
  for (const sentinel of [FIXTURE.PROJECT_NO, FIXTURE.V2_SUBSTITUTED_TO_PART_NO, FIXTURE.V2_ADDED_PART_NO, 'SYN-']) {
    assert.equal(serialized.includes(sentinel), false, `报告不得含 ${sentinel}`)
  }
})

test('changeCounts 逐键过滤：非字母键与非数字值都进不了报告', async () => {
  const { report } = await replay({
    plan: {
      DIFF: {
        status: 200,
        body: {
          ok: true,
          data: {
            baseSnapshotBatchId: '__WILL_BE_PATCHED__',
            changeCounts: { added: FIXTURE.V2_ADDED_PART_NO, removed: 1, 'SYN-PRT-02-05R': 3 },
            blockingExceptionCount: 0,
          },
        },
      },
    },
  })
  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes('SYN-'), false)
})

test('scanValuesFree：命中时报的是类别，不回显命中的值本身', () => {
  const dirty = scanValuesFree({ leaked: `prefix ${FIXTURE.V2_ADDED_PART_NO} suffix` }, [FIXTURE.V2_ADDED_PART_NO, 'SYN-'])
  assert.equal(dirty.clean, false)
  assert.deepEqual(dirty.hitClasses, ['fixture_part_identifier', 'fixture_part_identifier'])
  assert.equal(JSON.stringify(dirty).includes(FIXTURE.V2_ADDED_PART_NO), false)

  const caller = scanValuesFree({ leaked: 'PRJ-2026-0007' }, ['PRJ-2026-0007'])
  assert.deepEqual(caller.hitClasses, ['caller_supplied_business_value'])

  assert.equal(scanValuesFree({ rowCount: 55 }, [FIXTURE.PROJECT_NO, '']).clean, true)
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ④ 永不设置 autopersist / 永不发 tenantId
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('整条复演一次 tenantId / x-tenant-id / autopersist 都没发出去', async () => {
  const { calls } = await replay()
  for (const call of calls) {
    for (const key of Object.keys(call.headers || {})) {
      assert.notEqual(key.toLowerCase(), 'x-tenant-id', '永不发 x-tenant-id 请求头')
    }
    for (const key of Object.keys(call.body || {})) {
      assert.equal(/tenant|persist/i.test(key), false, `请求体不得带 ${key}`)
    }
    assert.equal(/tenantId|autopersist|autoPersist/i.test(call.url), false, `查询串不得带租户/落库开关：${call.url}`)
  }
  // 源运行请求体就是测试里那份 sourceRunBody 的键集（少了 tenantId —— 那是刻意的）。
  const run = calls.find((c) => c.url.endsWith('/source-runs/plm-bom'))
  assert.deepEqual(Object.keys(run.body).sort(), [
    'projectId', 'readSourceConfigId', 'snapshotBatchId', 'snapshotVersion', 'sourceProjectNo', 'syncRunId', 'workspaceId',
  ])
})

test('assertRequestBodySafe：多一个键、或任何 tenant/persist 类的键，出门前就抛', () => {
  assert.equal(assertRequestBodySafe('SAVE_CONFIG', { config: {} }), true)
  assert.throws(() => assertRequestBodySafe('SAVE_CONFIG', { config: {}, tenantId: 't1' }), /forbidden key class/)
  assert.throws(() => assertRequestBodySafe('RUN_V1', { workspaceId: 'w', autoPersist: true }), /forbidden key class/)
  assert.throws(() => assertRequestBodySafe('RUN_V1', { workspaceId: 'w', inputs: {} }), /unexpected key/)
  assert.throws(() => assertRequestBodySafe('NOT_A_STEP', {}), /no request-body allowlist/)
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 参数
// ══════════════════════════════════════════════════════════════════════════════════════════════

test('parseArgs：必填、互斥与闭集', () => {
  assert.throws(() => parseArgs(['node', 's']), UsageError)
  assert.throws(() => parseArgs(['node', 's', '--base-url', 'http://127.0.0.1:8900']), UsageError)
  assert.throws(() => parseArgs(['node', 's', '--base-url', 'http://x', '--token', 't', '--dev-token']), UsageError)
  assert.throws(() => parseArgs(['node', 's', '--base-url', 'http://x', '--token', 't', '--mode', 'v3']), UsageError)
  assert.throws(() => parseArgs(['node', 's', '--base-url', 'http://x', '--token', 't', '--nope']), UsageError)
  assert.throws(() => parseArgs(['node', 's', '--base-url']), UsageError)
  const args = parseArgs(['node', 's', '--base-url', 'http://127.0.0.1:8900///', '--dev-token', '--mode', 'v1'])
  assert.equal(args.baseUrl, 'http://127.0.0.1:8900', '末尾斜杠被削掉')
  assert.equal(args.mode, 'v1')
  assert.equal(args.devToken, true)
})

test('--dev-token：dev-token 拿不到就当门没过（生产上这条路由是 404）', async () => {
  const args = parseArgs(['node', 's', '--base-url', 'http://127.0.0.1:8900', '--dev-token'])
  const { impl, calls } = makeFetch({ DEV_TOKEN: { status: 404, body: { success: false } } })
  const report = await runReplay({ args, fetchImpl: impl, reseed: okReseed, fixture: FIXTURE })
  assert.equal(report.exitCode, EXIT_CODES.GATE_REFUSED)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.startsWith('/api/auth/dev-token'), true)
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// 变异自证（内存级 —— data: URL 编译，磁盘不动）
// ══════════════════════════════════════════════════════════════════════════════════════════════

async function importMutated(find, replaceWith) {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8').replace(/\r\n/g, '\n')
  const occurrences = source.split(find).length - 1
  assert.equal(occurrences, 1, `变异锚点必须恰好命中一次：${find.slice(0, 70)}`)
  const mutated = source.split(find).join(replaceWith)
  const url = `data:text/javascript;base64,${Buffer.from(mutated, 'utf8').toString('base64')}`
  return await import(url)
}

test('变异①：拿掉「生产 Apply 必须 closed」这一条 -> 门会放行一个生产落点（那条断言因此是真的）', async () => {
  const mutant = await importMutated(
    "  if (productionApply.state !== 'closed') return refuse(GATE_REFUSAL_CODES.PRODUCTION_APPLY_CONFIGURED)",
    '  /* MUTANT: production posture no longer checked */',
  )
  const production = clone(SANDBOX_PREFLIGHT)
  production.data.posture.productionApply.state = 'configured'
  assert.equal(
    mutant.evaluateSandboxGate({ baseUrl: 'http://127.0.0.1:8900', status: 200, body: production }).allowed,
    true,
    '变异体放行了生产落点',
  )
  // 真脚本在同一份输入上照旧拒绝 —— 变异是真的把能力拿掉了，不是输入本身就无害。
  assert.equal(
    evaluateSandboxGate({ baseUrl: 'http://127.0.0.1:8900', status: 200, body: production }).allowed,
    false,
  )
})

test('变异②：把「至少要有一个正向沙箱标记」改成无条件放行 -> 默认装机空过（那条断言因此是真的）', async () => {
  const mutant = await importMutated(
    "  if (!loopback && !sandboxModeEnabled) return { allowed: false, reason: GATE_REFUSAL_CODES.NO_SANDBOX_MARKER, markers }",
    '  /* MUTANT: no positive sandbox marker required */',
  )
  const bare = clone(SANDBOX_PREFLIGHT)
  bare.data.checks.sandboxWriteAuthorization.modeEnabled = false
  bare.data.checks.sandboxWriteAuthorization.allowlist = []
  bare.data.checks.sandboxWriteAuthorization.declaredSandboxTargetObjectIds = []
  const remote = 'https://stock-prep.example.internal'
  assert.equal(mutant.evaluateSandboxGate({ baseUrl: remote, status: 200, body: bare }).allowed, true)
  assert.equal(evaluateSandboxGate({ baseUrl: remote, status: 200, body: bare }).allowed, false)
})

test('变异③：把逐步状态码判定改成「只要连上就算过」-> 403 会被报成绿（那条断言因此是真的）', async () => {
  const mutant = await importMutated(
    '    return { status: response.status, body: parsed, ok: accept.includes(response.status) }',
    '    return { status: response.status, body: parsed, ok: true } /* MUTANT: any reachable response passes */',
  )
  const { impl } = makeFetch({ REGISTER_SYSTEM: { status: 403, body: { ok: false, error: { code: 'FORBIDDEN' } } } })
  const report = await mutant.runReplay({ args: baseArgs(), fetchImpl: impl, reseed: okReseed, fixture: FIXTURE })
  const registerStep = report.steps.find((s) => s.step === 'REGISTER_SYSTEM')
  assert.equal(registerStep.status, 403)
  assert.equal(registerStep.ok, true, '变异体把 403 记成了 PASS')
  // 真脚本在同一份假件上停在 REGISTER_SYSTEM。
  const { report: real } = await replay({ plan: { REGISTER_SYSTEM: { status: 403, body: { ok: false } } } })
  assert.equal(real.stoppedAt, 'REGISTER_SYSTEM')
  assert.equal(real.exitCode, EXIT_CODES.STEP_FAILED)
})
