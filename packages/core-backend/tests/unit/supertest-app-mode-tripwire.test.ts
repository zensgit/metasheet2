/**
 * Zero-tolerance tripwire for supertest app-mode call sites (#4154; wave-2 drained the debt to 0).
 *
 * History: this test originally froze a per-file baseline and enforced drain-only shrinkage, with
 * an UPDATE_SUPERTEST_APP_MODE_BASELINE=1 regeneration channel. Owner P2 (wave-2 review): that
 * channel could regenerate a NON-EMPTY baseline and CI would accept re-inflated debt. The channel
 * is deleted; the test now asserts the baseline file IS exactly {} and the recursive scan finds
 * ZERO app-mode sites anywhere under tests/unit — there is no sanctioned path back.
 *
 * Counting is an AST walk (ts.createSourceFile), not a regex: it resolves the local default-import
 * name of 'supertest' per file and exempts only URL-string literals and `*.url()` transports.
 * The scan is recursive (owner P2): nested test directories cannot bypass the ban.
 */
import fs from 'node:fs'
import os from 'node:os'
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

  it('scanner is recursive: nested app-mode sites are counted (fixture discriminator)', () => {
    // Owner P2: a top-level-only scan would let tests placed in subdirectories bypass the ban.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appmode-scan-fixture-'))
    const nested = path.join(dir, 'nested', 'deep')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'top.test.ts'),
      "import request from 'supertest'\ndeclare const app: unknown\nrequest(app)\n",
    )
    fs.writeFileSync(
      path.join(nested, 'hidden.test.ts'),
      "import request from 'supertest'\ndeclare const app: unknown\nrequest(app)\nrequest(app)\n",
    )
    const scan = scanAppModeSites(dir)
    expect(scan.counts['top.test.ts']).toBe(1)
    expect(scan.counts['nested/deep/hidden.test.ts'], 'nested file must be found by the recursive walk').toBe(2)
    expect(scan.totalSites).toBe(3)
  })

  it('the app-mode debt IS zero and stays zero — no regeneration channel exists', () => {
    // The baseline is the permanent zero anchor: assert its CONTENT, not a process around it.
    // Reintroducing any regeneration path cannot help an offender — a non-empty baseline fails here.
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    expect(baseline, 'supertest-app-mode-baseline.json must remain exactly {}').toEqual({})

    const scan = scanAppModeSites(UNIT_DIR)
    const offenders = Object.entries(scan.counts).map(
      ([file, count]) =>
        `${file}: ${count} app-mode supertest site(s) — use usePinnedServer() + request(pinned.url()) instead (tests/utils/pinned-server.ts)`,
    )
    expect(offenders, offenders.join('\n')).toEqual([])
    expect(scan.totalSites).toBe(0)
  })
})
