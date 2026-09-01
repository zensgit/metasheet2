import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(__dirname, '../../../..')
const WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/approval-realdb-departure-transfer.yml')
const DIRECTORY_SYNC_PATH = join(REPO_ROOT, 'packages/core-backend/src/directory/directory-sync.ts')
const DISPATCHER_PATH = join(REPO_ROOT, 'packages/core-backend/src/approvals/approval-departure-transfer-dispatch.ts')

const EXPECTED_PATHS = [
  'packages/core-backend/tests/integration/approval-departure-transfer.db.test.ts',
  'packages/core-backend/tests/integration/directory-sync-orchestration.db.test.ts',
  'packages/core-backend/tests/helpers/approval-schema-bootstrap.ts',
  'packages/core-backend/src/services/ApprovalProductService.ts',
  'packages/core-backend/src/services/ApprovalAssigneeResolver.ts',
  'packages/core-backend/src/services/ApprovalDirectoryOrg.ts',
  'packages/core-backend/src/directory/directory-sync.ts',
  'packages/core-backend/src/approvals/approval-departure-transfer-dispatch.ts',
  'packages/core-backend/src/routes/approvals.ts',
  'packages/core-backend/src/types/approval-product.ts',
  'packages/core-backend/tests/unit/approval-departure-transfer-dispatch.test.ts',
  'packages/core-backend/tests/unit/approval-departure-transfer-ci-wiring.test.ts',
  '.github/workflows/approval-realdb-departure-transfer.yml',
] as const

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

function pathEntries(source: string, event: 'pull_request' | 'push'): string[] {
  const start = source.indexOf(`  ${event}:`)
  const end = event === 'pull_request' ? source.indexOf('  push:', start) : source.indexOf('\npermissions:', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  return Array.from(source.slice(start, end).matchAll(/^\s+- '([^']+)'$/gm), (match) => match[1])
}

describe('Approval departure transfer real-DB CI wiring', () => {
  it('triggers both PR and main-push lanes for every owning caller, dispatcher, test, and workflow path', () => {
    const workflow = withoutComments(readFileSync(WORKFLOW_PATH, 'utf8'))
    const pullRequestPaths = pathEntries(workflow, 'pull_request')
    const pushPaths = pathEntries(workflow, 'push')

    expect(pullRequestPaths).toEqual(EXPECTED_PATHS)
    expect(pushPaths).toEqual(EXPECTED_PATHS)
    expect(pushPaths).toEqual(pullRequestPaths)
  })

  it('pins the post-commit caller, exact-signal dispatcher, and whole-file DB invocation', () => {
    const directorySync = withoutComments(readFileSync(DIRECTORY_SYNC_PATH, 'utf8'))
    const dispatcher = withoutComments(readFileSync(DISPATCHER_PATH, 'utf8'))
    const workflow = withoutComments(readFileSync(WORKFLOW_PATH, 'utf8'))

    const commitBoundary = directorySync.indexOf('directoryApplyCommitted = true')
    const dispatcherImport = directorySync.indexOf("await import(\n          '../approvals/approval-departure-transfer-dispatch'")
    const dispatcherCall = directorySync.indexOf('dispatchApprovalDepartureTransfersForRun({')
    expect(commitBoundary).toBeGreaterThanOrEqual(0)
    expect(dispatcherImport).toBeGreaterThan(commitBoundary)
    expect(dispatcherCall).toBeGreaterThan(dispatcherImport)

    const userChangedPredicate = dispatcher.indexOf("AND effect.effect_type = 'user_changed'")
    const transferCall = dispatcher.indexOf('await approvals.applyApprovalDepartureTransfer')
    expect(userChangedPredicate).toBeGreaterThanOrEqual(0)
    expect(transferCall).toBeGreaterThan(userChangedPredicate)
    expect(workflow).toMatch(/vitest\s+--config vitest\.integration\.config\.ts run\s+tests\/integration\/approval-departure-transfer\.db\.test\.ts\s+tests\/integration\/directory-sync-orchestration\.db\.test\.ts\s+--reporter=verbose/s)
    expect(workflow).toContain("EXPECT_DB: '1'")
  })

  it('does not authenticate comment-only call-chain placeholders', () => {
    const source = withoutComments(`
      // directoryApplyCommitted = true
      /* await import('../approvals/approval-departure-transfer-dispatch') */
      // dispatchApprovalDepartureTransfersForRun({})
    `)

    expect(source).not.toContain('directoryApplyCommitted = true')
    expect(source).not.toContain('approval-departure-transfer-dispatch')
    expect(source).not.toContain('dispatchApprovalDepartureTransfersForRun')
  })
})
