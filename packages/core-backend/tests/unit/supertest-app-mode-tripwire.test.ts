/**
 * Anti-regression tripwire for supertest app-mode call sites (#4154 slice, owner round-1).
 *
 * Freezes the current inventory of `request(<app>)` sites (per file) in
 * tests/utils/supertest-app-mode-baseline.json. The batch migration drains this baseline to
 * zero; until then this test guarantees the debt only shrinks:
 *   - a NEW file with app-mode sites fails;
 *   - an INCREASED count in an existing file fails;
 *   - decreases pass (regenerate the baseline in the same PR to lock them in).
 *
 * Regenerate after a migration wave:
 *   UPDATE_SUPERTEST_APP_MODE_BASELINE=1 npx vitest run tests/unit/supertest-app-mode-tripwire.test.ts
 *
 * Counting is an AST walk (ts.createSourceFile), not a regex: it resolves the local default-import
 * name of 'supertest' per file and exempts only URL-string literals and `*.url()` transports.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { countAppModeSites, scanAppModeSites } from '../utils/supertest-app-mode-scan'

const UNIT_DIR = path.resolve(__dirname)
const BASELINE_PATH = path.resolve(__dirname, '../utils/supertest-app-mode-baseline.json')

describe('supertest app-mode tripwire', () => {
  it('scanner classifies app-mode vs URL-mode correctly (self-test)', () => {
    const sample = [
      "import request from 'supertest'",
      'declare const app: unknown',
      'declare const pinned: { url(): string }',
      'declare function buildApp(): unknown',
      'request(app)', // app-mode
      'request(buildApp())', // app-mode
      "request('http://127.0.0.1:1')", // URL literal — safe
      'request(`http://127.0.0.1:${1}`)', // template — safe
      'request(pinned.url())', // pinned transport — safe
    ].join('\n')
    expect(countAppModeSites('sample.test.ts', sample)).toBe(2)
    expect(countAppModeSites('no-supertest.test.ts', 'const request = (x: unknown) => x\nrequest({})')).toBe(0)
  })

  it('app-mode sites never grow beyond the frozen baseline (drain-only)', () => {
    const scan = scanAppModeSites(UNIT_DIR)

    if (process.env.UPDATE_SUPERTEST_APP_MODE_BASELINE === '1') {
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(scan.counts, null, 2)}\n`)
      throw new Error(
        `baseline regenerated (${Object.keys(scan.counts).length} files / ${scan.totalSites} sites) — commit it and re-run without UPDATE_SUPERTEST_APP_MODE_BASELINE`,
      )
    }

    const baseline: Record<string, number> = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    const violations: string[] = []
    for (const [file, count] of Object.entries(scan.counts)) {
      const allowed = baseline[file]
      if (allowed === undefined) {
        violations.push(`${file}: ${count} app-mode supertest site(s) in a file not in the baseline — use usePinnedServer() + request(pinned.url()) instead (tests/utils/pinned-server.ts)`)
      } else if (count > allowed) {
        violations.push(`${file}: app-mode sites grew ${allowed} -> ${count} — new sites must use the pinned-server transport`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])

    // Migrated suites must stay fully drained.
    for (const migrated of [
      'dashboard-routes-wiring.test.ts',
      'approval-rbac-boundary.test.ts',
      'multitable-ai-suggest-formula-routes.test.ts',
      'pinned-server.test.ts',
    ]) {
      expect(scan.counts[migrated], `${migrated} must remain app-mode-free`).toBeUndefined()
    }
  })
})
