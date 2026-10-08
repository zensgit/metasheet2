import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Lock-10 (S2) R4.4 mitigation — `approval-comment-service.ts` DELIBERATELY re-implements
 * `CommentService.ts`'s private mention grammar (option B of the reuse study: extracting a shared
 * pure module would edit a shipped multitable service inside an authorization slice and force a
 * re-run of the multitable comment suites — unacceptable blast radius here). This pins the EXACT
 * regex literal in BOTH files so a future divergence reds instead of silently forking the grammar.
 *
 * Positive control first: assert the anchor is actually FOUND in each file before trusting a
 * `toContain` against it — a `toContain` against a file this test failed to read would be a
 * vacuous green (`feedback_empty_read_is_not_absence`).
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8')
}

const GRAMMAR = String.raw`/@\[([^\]]+)\]\(([^)]+)\)/g`

describe('approval-comment mention grammar — pinned agreement with CommentService.ts', () => {
  const multitable = read('packages/core-backend/src/services/CommentService.ts')
  const approval = read('packages/core-backend/src/services/approval-comment-service.ts')

  it('positive control: both files were actually read (non-empty)', () => {
    expect(multitable.length).toBeGreaterThan(1000)
    expect(approval.length).toBeGreaterThan(1000)
  })

  it('CommentService.ts still carries the canonical grammar literal', () => {
    expect(multitable).toContain(GRAMMAR)
  })

  it('approval-comment-service.ts carries the SAME grammar literal', () => {
    expect(approval).toContain(GRAMMAR)
  })
})
