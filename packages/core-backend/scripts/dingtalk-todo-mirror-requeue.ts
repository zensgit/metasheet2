#!/usr/bin/env tsx
/**
 * OPERATOR CLI — requeue ONE failed `dingtalk_todo_mirrors` row (design
 * docs/development/takeover-beiliao-20260821/dingtalk-todo-mirror-b-design-20260916.md §2.4
 * "operator 级重投门").
 *
 *   pnpm --filter @metasheet/core-backend exec tsx scripts/dingtalk-todo-mirror-requeue.ts \
 *     --id <mirror-row-uuid> --org <org-id>
 *
 * WHY A CLI AND NOT RAW SQL: the gate is four predicates (org scope, `status = 'failed'`,
 * `redelivery_safe = true`, and — for a row with no DingTalk task id — the approval seat still being
 * live). Hand-written UPDATEs bypass all four, which is exactly how an ambiguous send gets duplicated
 * or a todo gets minted for an approval that is already over. Every decision lives in
 * `runDingTalkTodoMirrorRequeueCli` (src/, type-checked, unit-tested); this file only supplies a pool.
 *
 * Read-then-write on ONE row, no batch mode on purpose. Output is values-free JSON (ids, statuses,
 * outcome word) and the exit code is 0 requeued / 2 refused / 1 usage or failure.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Pool } from 'pg'

import { runDingTalkTodoMirrorRequeueCli } from '../src/services/dingtalk-todo-mirror-worker'

const OPERATION = 'dingtalk_todo_mirror_requeue'

function valuesFreeFailure(code: string): Record<string, unknown> {
  return { operation: OPERATION, version: 1, valuesFree: true, outcome: 'error', code }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 })
  let output: Record<string, unknown>
  let exitCode = 1
  try {
    const result = await runDingTalkTodoMirrorRequeueCli(
      (sql, params) => pool.query(sql, params as unknown[]) as never,
      process.argv.slice(2),
    )
    output = result.report
    exitCode = result.exitCode
  } catch {
    output = valuesFreeFailure('REQUEUE_QUERY_FAILED')
    exitCode = 1
  } finally {
    try {
      await pool.end()
    } catch {
      // a pool that will not close must not change the requeue verdict
    }
  }
  console.log(JSON.stringify(output, null, 2))
  process.exitCode = exitCode
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  void main().catch(() => {
    console.log(JSON.stringify(valuesFreeFailure('REQUEUE_UNEXPECTED_FAILURE')))
    process.exitCode = 1
  })
}
