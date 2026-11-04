/**
 * Roadmap §7.7 Sync Performance — OFFLINE benchmark of the directory-sync PULL phase
 * (`fetchAllDepartments` + `fetchAllUsers`, the real sync code path) against a synthetic
 * in-process DingTalk API. Layer 1 only: `globalThis.fetch` is replaced for the duration of the
 * run, so no database, no app, no network and no provider credentials are involved; the transport
 * seam (per-attempt timeout, retry, backoff, flow-control recognition) runs unmodified underneath.
 *
 * WHAT IT MEASURES, per run: pull wall-clock (p50 / p95 over the runs); calls per endpoint as the
 * synthetic server saw them, next to the client-side `external*` counters the run record carries;
 * flow-control rejections served; client retries by reason (through the transport retry observer —
 * the same mechanism that feeds `externalPullRetry*` on the run record); and the peak calls per
 * calendar second the server saw (bucketed by `floor(now / 1000)`, so a sliding-window peak can be
 * somewhat higher). It also prints the approximate bound `served / QPS` so a reader can see
 * whether the injected quota or the code is the bottleneck. Everything is printed for the reader;
 * the only check the script makes is that the full synthetic tenant was pulled (department and
 * user counts), so a partial pull cannot be mistaken for a fast one.
 *
 * WHAT IT DOES NOT: the apply transaction (needs a database) and real provider behaviour — the
 * latency and rate-limit values are INJECTED knobs, not verified provider limits, and a
 * zero-latency run is not meaningful. It is not wired into any workflow or CI check, and it
 * defines no target. Note that on the default tenant membership is spread evenly (about 18 users
 * per department), below the default page size, so the user/list cursor path only runs with a
 * smaller BENCH_PAGE_SIZE (or far fewer departments).
 *
 * Usage (from packages/core-backend):
 *   LOG_LEVEL=error pnpm exec tsx scripts/benchmark-directory-sync-pull.ts
 *
 * Knobs (env, all optional):
 *   BENCH_USERS=2000            synthetic users
 *   BENCH_DEPARTMENTS=120       synthetic departments (a tree under one root)
 *   BENCH_MULTI_DEPT_RATIO=0.1  share of users that belong to a second department
 *   BENCH_PAGE_SIZE=50          user/list page size handed to the pull
 *   BENCH_LATENCY_MS=5          base latency injected per call, ± BENCH_JITTER_MS (default 2)
 *   BENCH_QPS=0                 0 = no rate limit; >0 = per-endpoint limit of QPS calls per sliding
 *                               second (no burst); a rejected call gets HTTP 200 + errcode 90018,
 *                               which the transport retries with its normal backoff. A listsub,
 *                               user/list or user/get call that exhausts its attempts fails the
 *                               whole pull, as a sync run would; a department/get exhaustion is
 *                               tolerated (manager ids left unset), also as in a sync run
 *   BENCH_RUNS=5                runs per report; the app-token cache is reset between runs
 *   BENCH_SEED=1                PRNG seed for the synthetic tenant (same seed ⇒ same tenant)
 *
 * The default profile (5 ms, unlimited) finishes in about a minute on the default tenant. Slower
 * profiles such as BENCH_LATENCY_MS=30 BENCH_QPS=20 take several minutes per run with the current
 * sequential pull and are meant for operator comparison runs, not for a quick check.
 */
import { performance } from 'node:perf_hooks'

import { __resetDingTalkAppAccessTokenCacheForTests } from '../src/integrations/dingtalk/client'
import { observeDingTalkTransportRetries } from '../src/integrations/dingtalk/transport'
import {
  createDirectoryPullRetryCounters,
  fetchAllDepartments,
  fetchAllUsers,
  recordDirectoryPullRetry,
  summarizeDirectoryPullRetries,
} from '../src/directory/directory-sync'
import {
  createDirectorySyncApiCallCounters,
  summarizeDirectorySyncApiCalls,
} from '../src/directory/directory-sync-api-telemetry'

function readNumberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

const USERS = Math.trunc(readNumberEnv('BENCH_USERS', 2000))
const DEPARTMENTS = Math.max(1, Math.trunc(readNumberEnv('BENCH_DEPARTMENTS', 120)))
const MULTI_DEPT_RATIO = readNumberEnv('BENCH_MULTI_DEPT_RATIO', 0.1)
const PAGE_SIZE = Math.max(1, Math.trunc(readNumberEnv('BENCH_PAGE_SIZE', 50)))
const LATENCY_MS = readNumberEnv('BENCH_LATENCY_MS', 5)
const JITTER_MS = readNumberEnv('BENCH_JITTER_MS', 2)
const QPS = readNumberEnv('BENCH_QPS', 0)
const RUNS = Math.max(1, Math.trunc(readNumberEnv('BENCH_RUNS', 5)))
const SEED = Math.trunc(readNumberEnv('BENCH_SEED', 1))
const BASE_URL = 'https://dingtalk.bench.invalid'

/** mulberry32 — a small seeded PRNG so the tenant (and the latency jitter) replay across runs. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface SyntheticTenant {
  rootId: number
  /** dept id → parent id (root's parent is null) */
  parents: Map<number, number | null>
  /** dept id → user ids in that department, in user-id order (what user/list pages over) */
  members: Map<number, number[]>
  /** user id → dept_id_list in user/get order (primary first) */
  userDepartments: Map<number, number[]>
}

function buildTenant(random: () => number): SyntheticTenant {
  const rootId = 1
  const parents = new Map<number, number | null>([[rootId, null]])
  const deptIds = [rootId]
  for (let i = 1; i < DEPARTMENTS; i++) {
    const id = rootId + i
    parents.set(id, deptIds[Math.floor(random() * deptIds.length)])
    deptIds.push(id)
  }
  const members = new Map<number, number[]>(deptIds.map((id) => [id, []]))
  const userDepartments = new Map<number, number[]>()
  for (let userId = 1; userId <= USERS; userId++) {
    const primary = deptIds[Math.floor(random() * deptIds.length)]
    const depts = [primary]
    if (random() < MULTI_DEPT_RATIO && deptIds.length > 1) {
      let second = primary
      while (second === primary) second = deptIds[Math.floor(random() * deptIds.length)]
      depts.push(second)
    }
    userDepartments.set(userId, depts)
    for (const dept of depts) members.get(dept)!.push(userId)
  }
  return { rootId, parents, members, userDepartments }
}

type EndpointName = 'gettoken' | 'department/listsub' | 'department/get' | 'user/list' | 'user/get'
const ENDPOINTS: EndpointName[] = ['gettoken', 'department/listsub', 'department/get', 'user/list', 'user/get']

interface ServerStats {
  arrived: Record<EndpointName, number>
  served: Record<EndpointName, number>
  rejected: Record<EndpointName, number>
  /** second bucket (floor(ms / 1000)) → calls served in it, over all endpoints */
  servedPerSecond: Map<number, number>
  arrivedPerSecond: Map<number, number>
  /** the same per endpoint — the limit is per endpoint, so this is what it bounds */
  servedPerSecondByEndpoint: Record<EndpointName, Map<number, number>>
}

function zeroByEndpoint(): Record<EndpointName, number> {
  return { 'gettoken': 0, 'department/listsub': 0, 'department/get': 0, 'user/list': 0, 'user/get': 0 }
}

function createServerStats(): ServerStats {
  return {
    arrived: zeroByEndpoint(),
    served: zeroByEndpoint(),
    rejected: zeroByEndpoint(),
    servedPerSecond: new Map(),
    arrivedPerSecond: new Map(),
    servedPerSecondByEndpoint: {
      'gettoken': new Map(),
      'department/listsub': new Map(),
      'department/get': new Map(),
      'user/list': new Map(),
      'user/get': new Map(),
    },
  }
}

/**
 * Per-endpoint limit: at most `QPS` calls served in any sliding one-second window. A call that
 * arrives while the window is full is rejected (no burst allowance), so the served count in any
 * sliding second never exceeds the limit; the per-calendar-second peak the report prints for the
 * reader is a coarser view of the same thing (not asserted).
 */
class EndpointWindow {
  private readonly servedAtMs: number[] = []

  take(): boolean {
    if (QPS <= 0) return true
    const now = performance.now()
    while (this.servedAtMs.length > 0 && now - this.servedAtMs[0] >= 1000) this.servedAtMs.shift()
    if (this.servedAtMs.length >= QPS) return false
    this.servedAtMs.push(now)
    return true
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function toNumberId(value: unknown): number {
  return typeof value === 'number' ? value : Number(String(value))
}

function bump(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

/**
 * The synthetic oapi: the five endpoints the pull uses, each with injected latency and the
 * per-endpoint limit. The response shapes mirror what `client.ts` parses (envelope `errcode`,
 * nested `result`, `dept_id_list`, `has_more` + `next_cursor`).
 */
function createSyntheticFetch(tenant: SyntheticTenant, stats: ServerStats, random: () => number): typeof fetch {
  const windows = new Map<EndpointName, EndpointWindow>(ENDPOINTS.map((name) => [name, new EndpointWindow()]))
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const endpoint = url.pathname.replace(/^\/topapi\/v2\//, '').replace(/^\//, '') as EndpointName
    if (!ENDPOINTS.includes(endpoint)) {
      return jsonResponse({ errcode: 404, errmsg: `unknown endpoint ${url.pathname}` })
    }
    stats.arrived[endpoint] += 1
    bump(stats.arrivedPerSecond, Math.floor(Date.now() / 1000))
    await sleep(Math.max(0, LATENCY_MS + (random() * 2 - 1) * JITTER_MS))
    if (!windows.get(endpoint)!.take()) {
      stats.rejected[endpoint] += 1
      return jsonResponse({ errcode: 90018, errmsg: 'synthetic flow control' })
    }
    stats.served[endpoint] += 1
    const servedSecond = Math.floor(Date.now() / 1000)
    bump(stats.servedPerSecond, servedSecond)
    bump(stats.servedPerSecondByEndpoint[endpoint], servedSecond)

    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    switch (endpoint) {
      case 'gettoken':
        return jsonResponse({ errcode: 0, errmsg: 'ok', access_token: 'bench-token', expires_in: 7200 })
      case 'department/listsub': {
        const parent = toNumberId(body.dept_id)
        const children = Array.from(tenant.parents.entries())
          .filter(([, parentId]) => parentId === parent)
          .map(([id]) => ({ dept_id: id, parent_id: parent, name: `Dept ${id}`, order: id }))
        return jsonResponse({ errcode: 0, errmsg: 'ok', result: children })
      }
      case 'department/get': {
        const id = toNumberId(body.dept_id)
        return jsonResponse({ errcode: 0, errmsg: 'ok', result: { dept_id: id, name: `Dept ${id}`, dept_manager_userid_list: '' } })
      }
      case 'user/list': {
        const id = toNumberId(body.dept_id)
        const cursor = toNumberId(body.cursor ?? 0)
        const size = toNumberId(body.size ?? PAGE_SIZE)
        const all = tenant.members.get(id) ?? []
        const page = all.slice(cursor, cursor + size)
        const hasMore = cursor + size < all.length
        return jsonResponse({
          errcode: 0,
          errmsg: 'ok',
          result: {
            has_more: hasMore,
            next_cursor: hasMore ? cursor + size : undefined,
            list: page.map((userId) => ({
              userid: `u${userId}`,
              name: `User ${userId}`,
              dept_id_list: tenant.userDepartments.get(userId),
            })),
          },
        })
      }
      case 'user/get': {
        const userId = Number(String(body.userid).replace(/^u/, ''))
        const depts = tenant.userDepartments.get(userId)
        if (!depts) return jsonResponse({ errcode: 60121, errmsg: 'user not found' })
        return jsonResponse({
          errcode: 0,
          errmsg: 'ok',
          result: {
            userid: `u${userId}`,
            name: `User ${userId}`,
            unionid: `un${userId}`,
            dept_id_list: depts,
            dept_order_list: depts.map((deptId, index) => ({ dept_id: deptId, order: index })),
            leader_in_dept: depts.map((deptId) => ({ dept_id: deptId, leader: false })),
          },
        })
      }
    }
  }) as typeof fetch
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function peak(map: Map<number, number>): number {
  let max = 0
  for (const value of map.values()) max = Math.max(max, value)
  return max
}

async function runOnce(tenant: SyntheticTenant, runIndex: number) {
  const serverStats = createServerStats()
  const originalFetch = globalThis.fetch
  globalThis.fetch = createSyntheticFetch(tenant, serverStats, seededRandom(SEED * 1000 + runIndex))
  __resetDingTalkAppAccessTokenCacheForTests()
  const apiCalls = createDirectorySyncApiCallCounters()
  const retries = createDirectoryPullRetryCounters()
  // Only the fields the pull helpers read (appKey/appSecret/baseUrl/rootDepartmentId/pageSize).
  const config = {
    appKey: 'bench-app',
    appSecret: 'bench-secret',
    rootDepartmentId: String(tenant.rootId),
    baseUrl: BASE_URL,
    pageSize: PAGE_SIZE,
  } as unknown as Parameters<typeof fetchAllDepartments>[0]

  const startedAt = performance.now()
  let departmentsSeen = 0
  let usersSeen = 0
  try {
    await observeDingTalkTransportRetries(
      (event) => recordDirectoryPullRetry(retries, event),
      async () => {
        const departments = await fetchAllDepartments(config, 'Bench', apiCalls)
        departmentsSeen = departments.size
        const users = await fetchAllUsers(config, departments, apiCalls)
        usersSeen = users.size
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  const wallClockMs = performance.now() - startedAt
  if (departmentsSeen !== DEPARTMENTS || usersSeen !== USERS) {
    throw new Error(`pull returned ${departmentsSeen} departments / ${usersSeen} users; expected ${DEPARTMENTS} / ${USERS}`)
  }
  return { wallClockMs, serverStats, apiCalls, retries }
}

async function main(): Promise<void> {
  const tenant = buildTenant(seededRandom(SEED))
  const multiDeptUsers = Array.from(tenant.userDepartments.values()).filter((depts) => depts.length > 1).length
  console.log('directory-sync pull benchmark (offline, synthetic DingTalk API, layer 1)')
  console.log(
    `tenant: users=${USERS} departments=${DEPARTMENTS} multiDeptUsers=${multiDeptUsers} pageSize=${PAGE_SIZE} seed=${SEED}`,
  )
  console.log(`injected: latencyMs=${LATENCY_MS}±${JITTER_MS} qps=${QPS === 0 ? 'unlimited' : QPS} (per endpoint) runs=${RUNS}`)

  const results: Array<Awaited<ReturnType<typeof runOnce>>> = []
  for (let i = 0; i < RUNS; i++) {
    const result = await runOnce(tenant, i)
    results.push(result)
    const retried = summarizeDirectoryPullRetries(result.retries)
    console.log(
      `run ${i + 1}/${RUNS}: ${result.wallClockMs.toFixed(0)} ms, served=${Object.values(result.serverStats.served).reduce((a, b) => a + b, 0)}`
      + ` rejected90018=${Object.values(result.serverStats.rejected).reduce((a, b) => a + b, 0)}`
      + ` clientRetries=${retried.externalPullRetryCount} peakServedPerSecond=${peak(result.serverStats.servedPerSecond)}`,
    )
  }

  const sorted = results.map((r) => r.wallClockMs).sort((a, b) => a - b)
  const last = results[results.length - 1]
  const pullCalls = summarizeDirectorySyncApiCalls(last.apiCalls)
  const retried = summarizeDirectoryPullRetries(last.retries)
  const totalArrived = Object.values(last.serverStats.arrived).reduce((a, b) => a + b, 0)
  console.log('')
  console.log(`pull wall-clock over ${RUNS} runs: p50=${percentile(sorted, 50).toFixed(0)} ms p95=${percentile(sorted, 95).toFixed(0)} ms`
    + ` min=${sorted[0].toFixed(0)} ms max=${sorted[sorted.length - 1].toFixed(0)} ms`)
  console.log('per-endpoint calls (last run), server side: arrived / served / rejected with errcode 90018')
  for (const name of ENDPOINTS) {
    console.log(`  ${name.padEnd(20)} ${last.serverStats.arrived[name]} / ${last.serverStats.served[name]} / ${last.serverStats.rejected[name]}`)
  }
  console.log('client-side run-record counters (last run):', { ...pullCalls, ...retried })
  console.log(
    `peak calls per calendar second seen by the server (last run, all endpoints): arrived=${peak(last.serverStats.arrivedPerSecond)} served=${peak(last.serverStats.servedPerSecond)}`,
  )
  console.log(
    `peak served per calendar second per endpoint (last run${QPS > 0 ? `; limit ${QPS} each` : ''}): `
    + ENDPOINTS.map((name) => `${name}=${peak(last.serverStats.servedPerSecondByEndpoint[name])}`).join(' '),
  )
  if (QPS > 0) {
    // Approximate bound for a pull that keeps every call: each endpoint's calls cannot be served
    // much faster than its own limit (the first window is unthrottled, so a run can finish a little
    // under this), so the slowest endpoint's queue is what the whole pull is compared against.
    const boundMs = Math.max(...ENDPOINTS.map((name) => (last.serverStats.served[name] / QPS) * 1000))
    console.log(`approximate bound at this limit (max over endpoints of served / qps): ${boundMs.toFixed(0)} ms`)
  }
  console.log(`serial latency floor (arrived calls × base latency): ${(totalArrived * LATENCY_MS).toFixed(0)} ms`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
