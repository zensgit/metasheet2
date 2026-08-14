/**
 * W4C-2 Gate D3 (#4556 / #4844) — STATIC structure legs for the authoritative `scheduled` writer.
 *
 * Everything here is a source-TEXT assertion, and source-text assertions are not behaviour
 * assertions — they are stated as the narrow things they are, and each one names the behavioural leg
 * that actually pins the property:
 *
 *  - the ONE-SEAM property (leg 6d) is a structural invariant with no runtime observable of its own:
 *    "there is exactly one place that can produce a skip, and the guard dominates it". Its
 *    behavioural consequence is pinned by the real-DB retirement legs (6a/6b/4a) — move the guard
 *    after the skip return and those red. This file pins the STRUCTURE so the ordering cannot be
 *    quietly reintroduced somewhere the DB legs happen not to cover.
 *  - the refusal-site legs (leg 16) complement the correspondence guard in
 *    `w4c3a-rollout-control-inventory.test.ts`, which after D3 is a zero-versus-zero identity on
 *    real content; the behavioural pins are the zero-invocation adapter spy and the probe-routing
 *    leg in the D3 real-DB suite.
 *  - the D2 carry-forward presence check (leg 20) is a "verify, do NOT re-do" gate: if a
 *    carry-forward is missing on this base, that is a BASE defect to surface, not something D3
 *    silently re-implements.
 *
 * No-DB: runs in the ungated `src/attendance/__tests__` set.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ATTENDANCE_DIR = path.join(__dirname, '..')
const BOUNDARY = path.join(ATTENDANCE_DIR, 'w4c2-live-scheduled-boundary.ts')
const CORE = path.join(ATTENDANCE_DIR, 'w4c2-authoritative-calculation-core.ts')

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

/** Brace-matched body of a named `function` declaration. Deliberately not a real parser. */
function functionBody(content: string, name: string): string {
  const decl = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(content)
  expect(decl, `function ${name} must exist in the source`).not.toBeNull()
  const parenOpen = content.indexOf('(', (decl as RegExpExecArray).index)
  let parenDepth = 0
  let i = parenOpen
  for (; i < content.length; i += 1) {
    if (content[i] === '(') parenDepth += 1
    else if (content[i] === ')') {
      parenDepth -= 1
      if (parenDepth === 0) break
    }
  }
  const braceStart = content.indexOf('{', i + 1)
  let braceDepth = 0
  for (let j = braceStart; j < content.length; j += 1) {
    if (content[j] === '{') braceDepth += 1
    else if (content[j] === '}') {
      braceDepth -= 1
      if (braceDepth === 0) return content.slice(braceStart, j + 1)
    }
  }
  throw new Error(`unbalanced braces locating ${name}`)
}

describe('W4C-2 Gate D3 — authoritative scheduled seam structure', () => {
  it('leg 6d — exactly ONE `kind: \'skip\'` construction site exists in the boundary, and it is lexically inside resolveAuthoritativeScheduledParentV1', () => {
    const content = read(BOUNDARY)
    // A CONSTRUCTION site, not a mention: the union type's own `{ readonly kind: 'skip' }` member
    // must not count, or the leg would be pinning a type declaration rather than a code path.
    const construction = /return\s*\{\s*kind:\s*'skip'/g
    expect([...content.matchAll(construction)].length).toBe(1)
    const seam = functionBody(content, 'resolveAuthoritativeScheduledParentV1')
    expect([...seam.matchAll(construction)].length).toBe(1)
    // And the union declares the variant exactly once, so "one construction site" cannot be true
    // merely because a second variant spelling was introduced elsewhere.
    expect([...content.matchAll(/kind:\s*'skip'/g)].length).toBe(2)
    // Positive control on the extractor: it really extracted a bounded body, not the whole file.
    expect(seam.length).toBeGreaterThan(200)
    expect(seam.length).toBeLessThan(content.length / 2)
  })

  it('leg 6d — the retirement guard is called on EVERY return path of the seam: it precedes both returns, and no return precedes it', () => {
    const seam = functionBody(read(BOUNDARY), 'resolveAuthoritativeScheduledParentV1')
    const guardIndex = seam.indexOf('assertParentNotRetiredForAuthoritativePunchV1(')
    expect(guardIndex).toBeGreaterThan(-1)
    // Exactly one guard call — two would invite one of them being deleted while the leg stays green.
    expect(seam.split('assertParentNotRetiredForAuthoritativePunchV1(').length - 1).toBe(1)
    const returns = [...seam.matchAll(/\breturn\b/g)].map((m) => m.index as number)
    // Both `{kind:'write'}` and `{kind:'skip'}` returns exist...
    expect(returns.length).toBe(2)
    expect(seam).toContain("kind: 'write'")
    expect(seam).toContain("kind: 'skip'")
    // ...and BOTH sit after the guard call. This is the ordering defect the design review caught:
    // a skip placed before the guard would seal `{inserted:false, completed}` over an
    // operator_retirement / import_rollback parent.
    for (const index of returns) expect(index).toBeGreaterThan(guardIndex)
  })

  it('leg 16 — ZERO `not delivered` refusal call sites remain in the boundary, and the core file still never spells that code as a boundaryFail call', () => {
    // Assembled at runtime so this test file cannot match its own source in the repo-wide scan the
    // inventory suite runs.
    const codeName = ['W4C2', 'AUTHORITATIVE_MODE_NOT_DELIVERED'].join('_')
    const boundary = read(BOUNDARY)
    // Any quoted spelling, any status — wider than the strict call form, so a reintroduced site
    // written differently still fails this.
    const quoted = new RegExp(`(['"])${codeName}\\1`, 'g')
    expect([...boundary.matchAll(quoted)].length).toBe(0)
    // Positive control on the scanner: it does find a planted occurrence.
    expect([...`const x = '${codeName}'`.matchAll(new RegExp(`(['"])${codeName}\\1`, 'g'))].length).toBe(1)
    // Non-vacuity: the file really was read and really is the boundary.
    expect(boundary).toContain('executeScheduledRunInternal')
    expect(boundary).toContain('resolveAuthoritativeScheduledParentV1')
    // The core has never owned this code and must not start.
    const core = read(CORE)
    expect(new RegExp(`boundaryFail\\(\\s*['"]${codeName}['"]`).test(core)).toBe(false)
    expect([...core.matchAll(quoted)].length).toBe(0)
  })

  it('leg 16 — the boundary savepoint reuses the core\'s own spelling (SAVEPOINT / ROLLBACK TO / RELEASE), and the contained path issues all three', () => {
    const boundary = read(BOUNDARY)
    const branch = functionBody(boundary, 'executeScheduledRunInternal')
    expect(branch).toContain('SAVEPOINT ${authoritativeSavepoint}')
    expect(branch).toContain('ROLLBACK TO SAVEPOINT ${authoritativeSavepoint}')
    // Two releases: the success path's and the contained path's (after the rollback).
    expect(branch.split('RELEASE SAVEPOINT ${authoritativeSavepoint}').length - 1).toBe(3)
    // The claim MUST be disposed before the outcome insert on the contained path — the deferred
    // commit guard makes committing a still-claimed operation illegal. Order is asserted, not
    // assumed (the behavioural pin is leg 4e, whose mutation reds AT COMMIT).
    const cancelIndex = branch.indexOf('cancelAttendanceResultOperationV1(trx, identity)')
    const failedOutcomeIndex = branch.indexOf("terminalOutcome: 'failed'")
    expect(cancelIndex).toBeGreaterThan(-1)
    expect(failedOutcomeIndex).toBeGreaterThan(cancelIndex)
  })

  it('leg 20 — D2/D1 carry-forwards are PRESENT on this base (verify, do NOT re-do): projected_status pre-check, RELEASE SAVEPOINT in the F1 catch path, and the widened locked read', () => {
    const core = read(CORE)
    // (1) The projected_status product-code pre-check, symmetric with F2's minutes check.
    expect(core).toContain('AUTHORITATIVE_PROJECTED_STATUSES_V1')
    expect(core).toMatch(/if \(!AUTHORITATIVE_PROJECTED_STATUSES_V1\.has\(projection\.status\)\)/)
    // ...and it is spelled independently of ATTENDANCE_DAILY_STATUSES_V1, whose eighth member 'off'
    // the DB CHECK does not admit.
    expect(core).not.toMatch(/AUTHORITATIVE_PROJECTED_STATUSES_V1[^\n]*ATTENDANCE_DAILY_STATUSES_V1/)
    // (2) RELEASE SAVEPOINT after ROLLBACK TO in the F1 (uq_arc_operation) catch path.
    const writer = functionBody(core, 'writeAuthoritativeSegmentCalculationV1')
    const rollbackIndex = writer.indexOf('ROLLBACK TO SAVEPOINT ${savepoint}')
    expect(rollbackIndex).toBeGreaterThan(-1)
    expect(writer.indexOf('RELEASE SAVEPOINT ${savepoint}', rollbackIndex)).toBeGreaterThan(rollbackIndex)
    // (3) The widened locked read D2 added for ALL callers — D3 consumes it and must not add a
    // second read.
    const boundary = read(BOUNDARY)
    const lockedRead = functionBody(boundary, 'lockShadowParentRecord')
    for (const column of [
      'projection_owner',
      'current_calculation_id',
      'visibility_state',
      'visibility_reason',
    ]) {
      expect(lockedRead).toContain(column)
    }
    expect(lockedRead.split('FOR UPDATE').length - 1).toBe(1)
  })
})
