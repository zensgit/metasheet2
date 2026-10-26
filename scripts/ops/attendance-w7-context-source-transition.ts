#!/usr/bin/env tsx
/**
 * W7-3 (#4556) operator context-source transition CLI — `plan` / `apply`.
 *
 * SHIPPING THIS TOOL IS NOT RUNNING IT. The slice that adds this file does not
 * authorize execution against ANY environment. Running it, creating or naming an
 * org, and setting `ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED` are each separate
 * owner rulings.
 *
 * This file is deliberately THIN: every decision lives either in
 * `./attendance-w7-context-source-transition-lib` (pure, unit-tested) or in the
 * core-backend boundary (`w7-context-source-transition.ts`, the ONE writer).
 * This module only wires them together and maps errors to exit codes. It never
 * touches context-source DML directly and never re-classifies a refusal the
 * boundary already named.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { AttendanceOwningSessionV1 } from '../../packages/core-backend/src/attendance/attendance-owning-session'

import {
  ATTENDANCE_W7_EXIT_ARGS_INVALID_V1,
  ATTENDANCE_W7_EXIT_SUCCESS_V1,
  describeAttendanceW7ErrorV1,
  exitCodeForAttendanceW7ErrorV1,
  computeAttendanceW7PlanDigestV1,
  parseAttendanceW7ApplyArgsV1,
  parseAttendanceW7PlanArgsV1,
  runAttendanceW7ApplyOrchestrationV1,
  validateAttendanceW7ManifestV1,
} from './attendance-w7-context-source-transition-lib'

type PgClientLike = { release(error?: Error): void }

// Use one CJS loader graph for the pool, issuer and owning boundary. Mixing
// tsx ESM/CJS instances duplicates their private capability registries even
// when a checkout's public shape matches; never bridge that with a trust stamp.
const requireAttendanceRuntime = createRequire(import.meta.url)
const connectionPoolModule = requireAttendanceRuntime(
  '../../packages/core-backend/src/integration/db/connection-pool',
) as typeof import('../../packages/core-backend/src/integration/db/connection-pool')
const contextSourceModule = requireAttendanceRuntime(
  '../../packages/core-backend/src/attendance/w7-context-source-transition',
) as typeof import('../../packages/core-backend/src/attendance/w7-context-source-transition')
const { attendanceOwningSessionForClientV1 } = requireAttendanceRuntime(
  '../../packages/core-backend/src/attendance/attendance-owning-session',
) as typeof import('../../packages/core-backend/src/attendance/attendance-owning-session')

const { poolManager } = connectionPoolModule as {
  poolManager: {
    get(name?: string): { getInternalPool(): { connect(): Promise<PgClientLike> } }
    close(): Promise<void>
  }
}
const { planAttendanceW7ContextSourceTransitionV1, transitionAttendanceW7ContextSourceV1 } =
  contextSourceModule as {
    planAttendanceW7ContextSourceTransitionV1: (
      connection: AttendanceOwningSessionV1,
      input: unknown,
    ) => Promise<never>
    transitionAttendanceW7ContextSourceV1: (connection: AttendanceOwningSessionV1, input: unknown) => Promise<never>
  }

function asOwningSession(client: PgClientLike): AttendanceOwningSessionV1 {
  return attendanceOwningSessionForClientV1(client)
}

async function withRawClient<T>(run: (client: PgClientLike) => Promise<T>): Promise<T> {
  const client = await poolManager.get().getInternalPool().connect()
  try {
    return await run(client)
  } finally {
    client.release()
  }
}

async function runPlan(argv: readonly string[]): Promise<number> {
  const args = parseAttendanceW7PlanArgsV1(argv)
  const plan = await withRawClient(async (client) =>
    planAttendanceW7ContextSourceTransitionV1(asOwningSession(client), {
      orgId: args.orgId,
      targetState: args.targetState,
    }),
  )
  // The digest is emitted alongside the plan so `apply --plan-digest` is a
  // copy of THIS invocation's output, never a value the operator composes.
  process.stdout.write(
    `${JSON.stringify({ plan, planDigest: computeAttendanceW7PlanDigestV1(plan) }, null, 2)}\n`,
  )
  return ATTENDANCE_W7_EXIT_SUCCESS_V1
}

async function runApply(argv: readonly string[]): Promise<number> {
  const args = parseAttendanceW7ApplyArgsV1(argv)
  const manifestRaw: unknown = JSON.parse(await readFile(args.manifestPath, 'utf8'))
  // `nowMs` is read HERE, once, and injected — the lib never reads a clock, so
  // its freshness behaviour is deterministic under test.
  const validated = validateAttendanceW7ManifestV1(
    manifestRaw,
    {
      orgId: args.orgId,
      expectedState: args.expectedState,
      targetState: args.targetState,
    },
    Date.now(),
  )
  const outcome = await withRawClient(async (client) =>
    runAttendanceW7ApplyOrchestrationV1(
      {
        plan: async (input) =>
          planAttendanceW7ContextSourceTransitionV1(asOwningSession(client), input) as never,
        transition: async (input) =>
          transitionAttendanceW7ContextSourceV1(asOwningSession(client), input) as never,
      },
      args,
      validated,
    ),
  )
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`)
  return ATTENDANCE_W7_EXIT_SUCCESS_V1
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [subcommand, ...rest] = argv
  try {
    if (subcommand === 'plan') return await runPlan(rest)
    if (subcommand === 'apply') return await runApply(rest)
    process.stderr.write(
      'Usage: attendance-w7-context-source-transition.ts plan --org <uuid> --target <state>\n' +
        '       attendance-w7-context-source-transition.ts apply --org <uuid> --target <state> ' +
        '--expected-state <state> --expected-version <n> --plan-digest <hex64> ' +
        '--confirm <token> --manifest <path> --actor-id <text> --correlation-id <uuid> ' +
        '--engine-version <text>\n',
    )
    return ATTENDANCE_W7_EXIT_ARGS_INVALID_V1
  } catch (error) {
    // The boundary's code is printed VERBATIM. No local rewording, no second
    // classification of a refusal the boundary already named precisely.
    process.stderr.write(`${describeAttendanceW7ErrorV1(error)}\n`)
    return exitCodeForAttendanceW7ErrorV1(error)
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) {
  const exitCode = await main()
  await poolManager.close()
  process.exit(exitCode)
}
