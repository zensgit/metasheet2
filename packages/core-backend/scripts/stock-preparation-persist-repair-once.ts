import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { LoadedPlugin } from '../src/core/plugin-loader'
import type { PluginContext } from '../src/types/plugin'

const require = createRequire(import.meta.url)
const {
  repairStockPreparationSyncRunOnce,
} = require('../../../plugins/plugin-integration-core/lib/stock-preparation-sync-run-repair-once.cjs') as {
  repairStockPreparationSyncRunOnce: (input: Record<string, unknown>) => Promise<RepairResult>
}
const {
  createDb,
} = require('../../../plugins/plugin-integration-core/lib/db.cjs') as {
  createDb: (input: Record<string, unknown>) => unknown
}
const {
  createStockPreparationAuditStore,
} = require('../../../plugins/plugin-integration-core/lib/stock-preparation-audit-store.cjs') as {
  createStockPreparationAuditStore: (input: Record<string, unknown>) => unknown
}

export const APPLY_CONFIRMATION = 'APPLY_STOCK_PREPARATION_REPAIR_ONCE'

const VALUES_FREE_FAILURE_CODES = new Set([
  'REPAIR_ARGUMENT_INVALID',
  'REPAIR_INPUT_PATH_REQUIRED',
  'REPAIR_CONFIRMATION_REQUIRED',
  'REPAIR_CONFIRMATION_INVALID',
  'REPAIR_CONFIRMATION_WITHOUT_APPLY',
  'REPAIR_MANIFEST_INVALID',
  'REPAIR_MANIFEST_FORBIDDEN_KEY',
  'REPAIR_TENANT_REQUIRED',
  'REPAIR_ACTOR_REQUIRED',
  'REPAIR_INPUT_READ_FAILED',
  'REPAIR_MANIFEST_JSON_INVALID',
  'REPAIR_MULTITABLE_API_UNAVAILABLE',
  'PERSIST_CONFIG_INVALID',
  'PERSIST_EXISTING_BATCH_INCOMPLETE',
  'PERSIST_EXISTING_BATCH_READ_UNPROVABLE',
  'PERSIST_IDEMPOTENCY_CONFLICT',
  'PERSIST_PERMISSION_DENIED',
  'PERSIST_PLAN_LINE_KEY_AMBIGUOUS',
  'PERSIST_PLAN_TOO_LARGE',
  'PERSIST_PROJECT_POINTER_STALE',
  'PERSIST_PROVISIONING_API_UNAVAILABLE',
  'PERSIST_RECORDS_API_INVALID',
  'PERSIST_REPAIR_AUDIT_UNAVAILABLE',
  'PERSIST_REPAIR_CONFIG_INVALID',
  'PERSIST_REPAIR_REFUSED',
  'PERSIST_TARGET_NOT_PROVISIONED',
  'PERSIST_TARGET_OBJECT_ID_INVALID',
  'PERSIST_UNIT_OF_WORK_UNAVAILABLE',
  'PERSIST_VERSION_NOT_MONOTONIC',
  'SYNC_RUN_PLAN_CONFIG_INVALID',
  'SYNC_RUN_PLAN_FIELD_NOT_GROUNDED',
  'SYNC_RUN_PLAN_PERMISSION_DENIED',
  'SYNC_RUN_PLAN_TEMPLATE_MISSING',
])

const FORBIDDEN_MANIFEST_KEYS = new Set([
  'apply',
  'auditStore',
  'context',
  'lockTenantId',
  'permission',
  'provisioning',
  'recordsApi',
  'targetProjectId',
])

type RepairMode = 'dry_run' | 'apply'

interface RepairCliOptions {
  inputPath: string
  apply: boolean
}

interface RepairManifest extends Record<string, unknown> {
  tenantId: string
  actorId: string
  workspaceId?: string
}

interface RepairResult {
  persisted: boolean
  mode: 'dry_run' | 'repaired' | 'noop'
  repairable: boolean
  applied: boolean
  created: { lines: number; run: number; project: number }
  patched: { project: number }
  evidence: {
    expectedLineCount: number
    existingPrefixLineCount: number
    missing: { lines: number; run: number; project: number }
    staleProjectPointer: boolean
    advancedProjectPointerPreserved: boolean
    externalWrite: false
    valuesFree: true
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code)
  return value.trim()
}

export function parseRepairCliArgs(argv: string[]): RepairCliOptions {
  let inputPath: string | null = null
  let apply = false
  let confirmation: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--input' && inputPath === null) {
      inputPath = requiredString(argv[index + 1], 'REPAIR_INPUT_PATH_REQUIRED')
      index += 1
      continue
    }
    if (arg === '--apply' && !apply) {
      apply = true
      continue
    }
    if (arg === '--confirm' && confirmation === null) {
      confirmation = requiredString(argv[index + 1], 'REPAIR_CONFIRMATION_REQUIRED')
      index += 1
      continue
    }
    throw new Error('REPAIR_ARGUMENT_INVALID')
  }
  if (!inputPath) throw new Error('REPAIR_INPUT_PATH_REQUIRED')
  if (apply && confirmation !== APPLY_CONFIRMATION) throw new Error('REPAIR_CONFIRMATION_INVALID')
  if (!apply && confirmation !== null) throw new Error('REPAIR_CONFIRMATION_WITHOUT_APPLY')
  return { inputPath: path.resolve(inputPath), apply }
}

export function normalizeRepairManifest(value: unknown): RepairManifest {
  if (!isPlainObject(value)) throw new Error('REPAIR_MANIFEST_INVALID')
  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) throw new Error('REPAIR_MANIFEST_FORBIDDEN_KEY')
  }
  return {
    ...value,
    tenantId: requiredString(value.tenantId, 'REPAIR_TENANT_REQUIRED'),
    actorId: requiredString(value.actorId, 'REPAIR_ACTOR_REQUIRED'),
  } as RepairManifest
}

export function buildRepairInvocation(
  manifest: RepairManifest,
  dependencies: { recordsApi: unknown; provisioning: unknown; auditStore: unknown },
  apply: boolean,
): Record<string, unknown> {
  const { tenantId, actorId, workspaceId, ...planInput } = manifest
  return {
    ...planInput,
    permission: 'admin',
    recordsApi: dependencies.recordsApi,
    provisioning: dependencies.provisioning,
    auditStore: dependencies.auditStore,
    lockTenantId: tenantId,
    targetProjectId: `${tenantId}:integration-core`,
    auditActor: actorId,
    auditWorkspaceId: workspaceId,
    apply,
  }
}

export function buildValuesFreeCliSummary(mode: RepairMode, result: RepairResult) {
  return {
    status: 'PASS',
    operation: 'stock_preparation_persist_repair_once',
    mode,
    result: {
      persisted: result.persisted,
      outcome: result.mode,
      repairable: result.repairable,
      applied: result.applied,
      created: { ...result.created },
      patched: { ...result.patched },
      evidence: {
        expectedLineCount: result.evidence.expectedLineCount,
        existingPrefixLineCount: result.evidence.existingPrefixLineCount,
        missing: { ...result.evidence.missing },
        staleProjectPointer: result.evidence.staleProjectPointer,
        advancedProjectPointerPreserved: result.evidence.advancedProjectPointerPreserved,
        externalWrite: false,
        valuesFree: true,
      },
    },
  }
}

export function buildValuesFreeCliFailure(mode: RepairMode, error: unknown) {
  const candidate = isPlainObject(error) ? error : {}
  const candidateCode = typeof candidate.code === 'string'
    ? candidate.code
    : (error instanceof Error ? error.message : null)
  const code = candidateCode && VALUES_FREE_FAILURE_CODES.has(candidateCode)
    ? candidateCode
    : 'REPAIR_FAILED'
  const status = Number.isInteger(candidate.status) ? candidate.status : 1
  return {
    status: 'FAIL',
    operation: 'stock_preparation_persist_repair_once',
    mode,
    code,
    failureStatus: status,
    externalWrite: false,
    valuesFree: true,
  }
}

async function createProductionPluginContext(): Promise<{
  context: PluginContext
  server: { stop: (signal?: string) => Promise<void> }
}> {
  const { MetaSheetServer } = await import('../src/index')
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'repair-once' },
    plugin: { activate: async () => {} },
    path: 'ops://stock-preparation-persist-repair-once',
    loadedAt: new Date(),
  }
  const context = (server as unknown as {
    createPluginContext: (plugin: LoadedPlugin) => PluginContext
  }).createPluginContext(loaded)
  return { context, server }
}

async function loadManifest(inputPath: string): Promise<RepairManifest> {
  let raw: string
  try {
    raw = await fs.readFile(inputPath, 'utf8')
  } catch {
    throw new Error('REPAIR_INPUT_READ_FAILED')
  }
  try {
    return normalizeRepairManifest(JSON.parse(raw))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('REPAIR_MANIFEST_JSON_INVALID')
    throw error
  }
}

export async function runRepairCli(argv: string[]): Promise<number> {
  let mode: RepairMode = argv.includes('--apply') ? 'apply' : 'dry_run'
  let poolWasInitialized = false
  let server: { stop: (signal?: string) => Promise<void> } | null = null
  let exitCode = 1
  let summary: ReturnType<typeof buildValuesFreeCliSummary> | ReturnType<typeof buildValuesFreeCliFailure>
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    const options = parseRepairCliArgs(argv)
    mode = options.apply ? 'apply' : 'dry_run'
    const manifest = await loadManifest(options.inputPath)
    const runtime = await createProductionPluginContext()
    const context = runtime.context
    server = runtime.server
    poolWasInitialized = true
    const multitable = context.api.multitable
    if (!multitable) throw new Error('REPAIR_MULTITABLE_API_UNAVAILABLE')
    const db = createDb({ database: context.api.database })
    const auditStore = createStockPreparationAuditStore({ db })
    const result = await repairStockPreparationSyncRunOnce(buildRepairInvocation(
      manifest,
      {
        recordsApi: multitable.records,
        provisioning: multitable.provisioning,
        auditStore,
      },
      options.apply,
    ))
    summary = buildValuesFreeCliSummary(mode, result)
    exitCode = 0
  } catch (error) {
    summary = buildValuesFreeCliFailure(mode, error)
  } finally {
    if (server) {
      try {
        await server.stop('REPAIR_ONCE_COMPLETE')
      } catch {
        // Best-effort teardown; pool cleanup below remains independent.
      }
    }
    if (poolWasInitialized) {
      try {
        const { poolManager } = await import('../src/integration/db/connection-pool')
        const pool = poolManager.get() as unknown as { end?: () => Promise<void> }
        await pool.end?.()
      } catch {
        // Initialization may fail before the pool exists; the values-free result above remains authoritative.
      }
    }
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
  }
  await new Promise<void>((resolve) => {
    stdoutWrite(`${JSON.stringify(summary)}\n`, resolve)
  })
  return exitCode
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entryPath === import.meta.url) {
  void runRepairCli(process.argv.slice(2)).then((code) => {
    // The production context constructor owns ambient host handles that are irrelevant to this
    // bounded one-shot process. All server/pool cleanup and stdout flushing above has completed, so
    // terminate the CLI explicitly instead of waiting indefinitely for unrelated constructor handles.
    process.exit(code)
  })
}
