#!/usr/bin/env -S pnpm exec tsx
/**
 * W4C-5 operator transition tool — `plan` (read-only) and `apply` (writes only through the
 * product's own transactional boundary) subcommands.
 *
 * docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md
 * (OD-W4C-61=(a), ratified at 2a2a5eee4f00abceff94ed6360e8c051708e35f7, owner comment
 * 5189421034 on PR 4747). See the runbook at
 * docs/development/attendance-issue-4556-w4c5-operator-runbook-20260809.md for worked examples.
 *
 * This file is deliberately thin: all decision logic lives in
 * `attendance-w4c5-rollout-transition-lib.ts` (pure, unit-tested without a database) and in
 * `packages/core-backend/src/attendance/w4c3a-rollout-control.ts` (the sole rollout-DML boundary
 * and its read-only plan reporter). This file only parses the subcommand, opens one idle
 * PostgreSQL connection, wires the two together, and prints a values-free JSON report.
 *
 * NEVER transitions anything without an explicit `--confirm` token matching exactly, NEVER
 * accepts a wildcard org or a default target, and NEVER writes rollout rows itself — `apply`
 * only ever calls `transitionAttendanceCalculationRolloutV1`.
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import {
  ATTENDANCE_W4C5_EXIT_ARGS_INVALID_V1,
  ATTENDANCE_W4C5_EXIT_PLAN_BLOCKED_V1,
  ATTENDANCE_W4C5_EXIT_SUCCESS_V1,
  AttendanceW4C5ToolError,
  computeAttendanceW4C5PlanDigestV1,
  describeAttendanceW4C5ErrorV1,
  exitCodeForAttendanceW4C5ErrorV1,
  parseAttendanceW4C5ApplyArgsV1,
  parseAttendanceW4C5PlanArgsV1,
  runAttendanceW4C5ApplyOrchestrationV1,
  validateAttendanceW4C5ManifestV1,
} from './attendance-w4c5-rollout-transition-lib'

// Dynamic import + unwrap: see attendance-w4c5-rollout-transition-lib.ts's header comment for
// why a static import of a core-backend value crossing the scripts/ops (type:module) ->
// core-backend (no "type" field) boundary silently collapses named exports onto `.default`.
// This is the SAME shape `attendance-legacy-membership-overlap-audit.ts` already uses.
const connectionPoolNamespace = await import(
  '../../packages/core-backend/src/integration/db/connection-pool'
)
const rolloutControlNamespace = await import(
  '../../packages/core-backend/src/attendance/w4c3a-rollout-control'
)

const connectionPoolModule =
  'poolManager' in connectionPoolNamespace
    ? connectionPoolNamespace
    : (connectionPoolNamespace as unknown as { default: typeof connectionPoolNamespace }).default
const rolloutControlModule =
  'transitionAttendanceCalculationRolloutV1' in rolloutControlNamespace
    ? rolloutControlNamespace
    : (rolloutControlNamespace as unknown as { default: typeof rolloutControlNamespace }).default

const { poolManager } = connectionPoolModule as { poolManager: { get(name?: string): { getInternalPool(): { connect(): Promise<PgClientLike> } }; close(): Promise<void> } }
const { planAttendanceCalculationRolloutTransitionV1, transitionAttendanceCalculationRolloutV1 } =
  rolloutControlModule as {
    planAttendanceCalculationRolloutTransitionV1: (
      client: { query: PgClientLike['query'] },
      input: { orgId: string; targetState: string },
    ) => Promise<AttendanceRolloutTransitionPlan>
    transitionAttendanceCalculationRolloutV1: (
      client: { query: PgClientLike['query'] },
      input: Record<string, unknown>,
    ) => Promise<{ orgId: string; state: string; batchId: string | null }>
  }

interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  release(): void
}

type AttendanceRolloutTransitionPlan = Record<string, unknown> & {
  blocked: boolean
  predicates: readonly unknown[]
}

function clientAdapter(client: PgClientLike): { query: PgClientLike['query'] } {
  return { query: (text, values) => client.query(text, values) }
}

async function readManifest(manifestPath: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    throw new AttendanceW4C5ToolError('W4C5_TOOL_MANIFEST_INVALID')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new AttendanceW4C5ToolError('W4C5_TOOL_MANIFEST_INVALID')
  }
}

async function runPlan(argv: string[]): Promise<number> {
  const args = parseAttendanceW4C5PlanArgsV1(argv)
  const rawClient = await poolManager.get('main').getInternalPool().connect()
  try {
    const plan = await planAttendanceCalculationRolloutTransitionV1(clientAdapter(rawClient), args)
    const planDigest = computeAttendanceW4C5PlanDigestV1(plan as never)
    process.stdout.write(`${JSON.stringify({ ...plan, planDigest }, null, 2)}\n`)
    return plan.blocked ? ATTENDANCE_W4C5_EXIT_PLAN_BLOCKED_V1 : ATTENDANCE_W4C5_EXIT_SUCCESS_V1
  } finally {
    rawClient.release()
  }
}

async function runApply(argv: string[]): Promise<number> {
  const args = parseAttendanceW4C5ApplyArgsV1(argv)
  const manifestRaw = await readManifest(args.manifestPath)
  const validated = validateAttendanceW4C5ManifestV1(
    manifestRaw,
    { orgId: args.orgId, expectedState: args.expectedState, targetState: args.targetState },
    Date.now(),
  )
  const rawClient = await poolManager.get('main').getInternalPool().connect()
  try {
    const outcome = await runAttendanceW4C5ApplyOrchestrationV1(
      {
        plan: (input) => planAttendanceCalculationRolloutTransitionV1(clientAdapter(rawClient), input),
        transition: (input) => transitionAttendanceCalculationRolloutV1(clientAdapter(rawClient), input) as never,
      },
      args,
      validated,
    )
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
    return ATTENDANCE_W4C5_EXIT_SUCCESS_V1
  } finally {
    rawClient.release()
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [subcommand, ...rest] = argv
  try {
    if (subcommand === 'plan') return await runPlan(rest)
    if (subcommand === 'apply') return await runApply(rest)
    process.stderr.write(
      'Usage: attendance-w4c5-rollout-transition.ts plan --org <uuid> --target <state>\n' +
        '       attendance-w4c5-rollout-transition.ts apply --org <uuid> --target <state> ' +
        '--expected-state <state> --expected-version <n> --plan-digest <hex64> ' +
        '--confirm <token> --manifest <path> --actor-id <text> --correlation-id <uuid> ' +
        '--engine-version <text>\n',
    )
    return ATTENDANCE_W4C5_EXIT_ARGS_INVALID_V1
  } catch (error) {
    process.stderr.write(`${describeAttendanceW4C5ErrorV1(error)}\n`)
    return exitCodeForAttendanceW4C5ErrorV1(error)
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) {
  const exitCode = await main()
  await poolManager.close()
  process.exitCode = exitCode
}
