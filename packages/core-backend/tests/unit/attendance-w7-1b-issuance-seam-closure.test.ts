/**
 * W7-1b (#4556) — §2.5 THE ONE-SEAM CLOSURE GUARD.
 *
 * Authority: #4556 comments 5293034619 + 5293478713.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE HAD TO EXIST
 * ---------------------------------------------------------------------------
 * Two production files NAME this suite as the mechanism that makes the one-seam
 * doctrine structural rather than conventional — `w7-frozen-context-issuance-seam.ts`
 * and `types/plugin.ts`. Gate finding P2-1: it did not exist. A guard that is
 * cited but absent is worse than an uncited absence, because the citation reads
 * as evidence.
 *
 * Structural one-producer-per-`(org, work_date)` is enforced BY CONSTRUCTION —
 * every producer routes through one seam. "Everyone remembered to call the seam"
 * is not an invariant, so the construction is pinned here:
 *
 *   S1  TS import graph  — only the seam imports op(i), by RESOLVED module path
 *   S2  adapter graph    — zero direct `adapters.buildShadowFrozenContext(` in
 *                          the boundary outside the seam helper
 *   S3  CJS require graph— every `buildW4ShadowFrozenContextV1(` call site is an
 *                          ADJUDICATED exception, each carried with a reason
 *   S4  OD-W7-10         — the refusal must NOT call the seam (calling it would
 *                          mint a context before the refusal that precedes it)
 *   S0  non-vacuity      — every walked domain non-empty, every anchor matched
 *                          exactly once, BEFORE any ban is asserted
 *
 * A CJS-only leg is required because S1 is blind to `require`.
 *
 * ⚠️ PLANTING DISCIPLINE (§10.0). Every planted probe below lives in a TEMP
 * directory OUTSIDE the repository. A real `.ts` file planted under
 * `packages/core-backend/src/attendance/**` reds the W6-R5 preservation guard's
 * Leg 0 in a concurrently-scheduled run — same vitest project, `pool: 'forks'` —
 * and a leg whose mutation reds a NEIGHBOURING suite has measured nothing about
 * itself. W7-1a hit exactly this and relocated its own decoy for the reason.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../../../')
const SEAM = 'packages/core-backend/src/attendance/w7-resolver/w7-frozen-context-issuance-seam.ts'
const OPI = 'packages/core-backend/src/attendance/w7-resolver/w7-group-effective-context-issuance.ts'
const BOUNDARY = 'packages/core-backend/src/attendance/w4c2-live-scheduled-boundary.ts'
const PLUGIN = 'plugins/plugin-attendance/index.cjs'
const CORE_SRC = 'packages/core-backend/src'

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
const SPECIFIER_RE = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g

function walkTs(relDir: string): string[] {
  const out: string[] = []
  const abs = path.join(REPO_ROOT, relDir)
  const stack = [abs]
  while (stack.length) {
    const dir = stack.pop()!
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        stack.push(full)
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'))
      }
    }
  }
  return out.sort()
}

/** Resolve every relative specifier in a file to a repo-relative path. Matching
 *  by RESOLVED PATH, never by specifier text: `'../w7-resolver/x'` and
 *  `'./x'` are the same module and a text match would miss one of them. */
function resolvedTargets(relPath: string, root: string = REPO_ROOT): string[] {
  const abs = path.join(root, relPath)
  const targets: string[] = []
  // Read from `root`, NOT from REPO_ROOT — the planted positive control lives in
  // a temp tree, and reading the repo copy instead would make it pass against
  // the wrong file (or ENOENT, which is how this was caught).
  for (const match of fs.readFileSync(abs, 'utf8').matchAll(SPECIFIER_RE)) {
    const specifier = match[1]
    if (!specifier.startsWith('.')) continue
    const base = path.resolve(path.dirname(abs), specifier)
    for (const candidate of [base, `${base}.ts`, `${base}.cjs`, `${base}.js`, `${base}.mjs`, `${base}.tsx`]) {
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) {
        targets.push(path.relative(root, candidate).split(path.sep).join('/'))
        break
      }
    }
  }
  return targets
}

const stripComments = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')

/**
 * THE ADJUDICATED EXCEPTIONS — every non-comment reference to the legacy V1
 * builder, each with the reason it is allowed to name it.
 *
 * ⚠️ There are FIVE, not three. An earlier PR-body claim said "the three
 * adjudicated exceptions" and was literally false (gate finding P3-6): the two
 * test-export entries were never counted. Enumerated here so the count is
 * DERIVED against source rather than asserted in prose.
 */
const LEGACY_BUILDER_ADJUDICATED_V1 = Object.freeze([
  Object.freeze({ needle: 'async function buildW4ShadowFrozenContextV1(trx, args) {', reason: 'the function DEFINITION itself' }),
  Object.freeze({ needle: '    buildW4ShadowFrozenContextV1,\n', reason: 'test-export surfaces (D2 adapters + the golden harness) — exposure, not a producer call' }),
  Object.freeze({ needle: '            buildW4ShadowFrozenContextV1(pluginTrx, legacyArgs),', reason: "the SEAM's own pre-bound legacy thunk — this IS the seam's legacy arm" }),
  Object.freeze({ needle: '              buildShadowFrozenContext: (trx, args) => buildW4ShadowFrozenContextV1(trx, args),', reason: 'the injected legacy adapter the seam calls through' }),
])

describe('W7-1b §2.5 — the one-seam closure guard', () => {
  // -------------------------------------------------------------------------
  // S0 first. An unhit anchor and a dead ban look identical.
  // -------------------------------------------------------------------------

  it('S0 non-vacuity: every walked domain is non-empty and every anchor file exists', () => {
    const coreFiles = walkTs(CORE_SRC)
    expect(coreFiles.length, 'the TS walk found nothing').toBeGreaterThan(100)
    for (const rel of [SEAM, OPI, BOUNDARY, PLUGIN]) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `missing anchor file: ${rel}`).toBe(true)
    }
    // The walk must actually contain the modules the bans are about.
    expect(coreFiles).toContain(SEAM)
    expect(coreFiles).toContain(OPI)
    // And the resolver really does resolve — otherwise S1 reports zero importers
    // everywhere and passes for the wrong reason.
    expect(resolvedTargets(SEAM), 'the seam must resolve an import to op(i)').toContain(OPI)
  })

  // -------------------------------------------------------------------------
  // S1 — the TS import graph.
  // -------------------------------------------------------------------------

  it('S1: the ONLY production module importing op(i) is the seam (resolved module path)', () => {
    const importers = walkTs(CORE_SRC).filter((rel) => rel !== OPI && resolvedTargets(rel).includes(OPI))
    // The router imports op(i)'s TYPE only; both are reviewed wiring points and
    // both are enumerated rather than carved out, because teaching the walk to
    // ignore type imports would weaken it for every future caller.
    expect(importers.sort()).toEqual(
      [SEAM, 'packages/core-backend/src/attendance/w7-frozen-context-router.ts'].sort(),
    )
  })

  it('S1 POSITIVE CONTROL: a planted importer of op(i) is detected', () => {
    // Planted OUTSIDE the repo (§10.0) so it cannot red the W6-R5 guard.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-1b-seam-s1-'))
    try {
      const nested = path.join(dir, 'packages/core-backend/src/attendance/w7-resolver')
      fs.mkdirSync(nested, { recursive: true })
      fs.writeFileSync(path.join(nested, 'w7-group-effective-context-issuance.ts'), 'export const x = 1\n', 'utf8')
      const probeRel = 'packages/core-backend/src/attendance/zz-probe.ts'
      fs.writeFileSync(
        path.join(dir, probeRel),
        "import { coreIssueGroupEffectiveContextV2 } from './w7-resolver/w7-group-effective-context-issuance'\nexport const probe = coreIssueGroupEffectiveContextV2\n",
        'utf8',
      )
      const targets = resolvedTargets(probeRel, dir)
      expect(targets, 'the probe must resolve to op(i) — otherwise S1 is blind').toContain(OPI)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // S2 — the adapter graph.
  // -------------------------------------------------------------------------

  it('S2: the boundary makes ZERO direct `adapters.buildShadowFrozenContext(` calls', () => {
    const source = stripComments(read(BOUNDARY))
    const calls = source.split('await adapters.buildShadowFrozenContext(').length - 1
    expect(calls, 'every boundary arm must reach the builder THROUGH the seam').toBe(0)
    // The interface declaration and the `typeof` presence check must still
    // exist — removing them would satisfy the ban vacuously.
    expect(source).toContain('buildShadowFrozenContext(')
    expect(source).toContain("typeof adapters.buildShadowFrozenContext !== 'function'")
    // ...and all four arms must go through the ONE helper.
    expect(source.split('await issueThroughW7Seam(pluginTrx, {').length - 1).toBe(4)
  })

  // -------------------------------------------------------------------------
  // S3 — the CJS require/port graph. S1 is blind to `require`.
  // -------------------------------------------------------------------------

  it('S3: every legacy-builder reference in the plugin is an ADJUDICATED exception, and the count is DERIVED', () => {
    const source = stripComments(read(PLUGIN))
    const total = source.split('buildW4ShadowFrozenContextV1').length - 1
    const adjudicated = LEGACY_BUILDER_ADJUDICATED_V1.reduce(
      (sum, entry) => sum + (source.split(entry.needle).length - 1),
      0,
    )
    expect(
      total,
      `the plugin carries ${total} non-comment references to the legacy builder but only ` +
        `${adjudicated} are adjudicated. A NEW producer calling it directly bypasses the seam ` +
        `and can select a different arm for the same (org, work_date).`,
    ).toBe(adjudicated)
    // Every adjudicated entry must actually match — a stale needle would inflate
    // nothing and silently shrink the ban.
    for (const entry of LEGACY_BUILDER_ADJUDICATED_V1) {
      expect(source.split(entry.needle).length - 1, `stale adjudicated needle: ${entry.needle.trim()}`).toBeGreaterThan(0)
      expect(entry.reason.length, 'every exception carries a reason').toBeGreaterThan(20)
    }
    // And the three PRODUCER sites go through the producer entry point.
    expect(source.split('await issueW4FrozenContextForProducerV1(trx, {').length - 1).toBe(3)
    // The mirror goes through the seam directly with `purpose: 'mirror'`.
    expect(source).toContain('issueW4FrozenContextViaW7SeamV1(mirrorTrx, {')
  })

  it('S3 POSITIVE CONTROL: an unadjudicated direct call is detected by the same arithmetic', () => {
    const source = stripComments(read(PLUGIN))
    const planted = `${source}\nasync function zzProbe(trx, args) { return buildW4ShadowFrozenContextV1(trx, args) }\n`
    const total = planted.split('buildW4ShadowFrozenContextV1').length - 1
    const adjudicated = LEGACY_BUILDER_ADJUDICATED_V1.reduce(
      (sum, entry) => sum + (planted.split(entry.needle).length - 1),
      0,
    )
    expect(total, 'the planted direct call must make the counts disagree').toBeGreaterThan(adjudicated)
  })

  // -------------------------------------------------------------------------
  // S4 — OD-W7-10 must NOT call the seam.
  // -------------------------------------------------------------------------

  it('S4: OD-W7-10 answers "which producer" from the POSTURE RESOLVER, never by calling the seam', () => {
    // Calling the seam to answer a yes/no question MINTS A CONTEXT as a side
    // effect — and here it would mint it BEFORE the refusal whose entire purpose
    // is to precede production. This property was un-pinned until now.
    const source = read(PLUGIN)
    const start = source.indexOf('// W7-1b — OD-W7-10(a). RATIFIED')
    expect(start, 'the OD-W7-10 block must exist').toBeGreaterThan(-1)
    const end = source.indexOf('const port = attendanceW4SegmentCalculationPort', start)
    expect(end, 'the OD-W7-10 block must terminate at the port lookup').toBeGreaterThan(start)
    const block = stripComments(source.slice(start, end))
    expect(
      block.includes('resolveAttendanceW7GroupArmSelectionV1'),
      'currentProducer must read the ARM-SELECTION port (the posture resolver)',
    ).toBe(true)
    expect(
      block.includes('issueW4FrozenContextViaW7SeamV1') || block.includes('issueW4FrozenContextForProducerV1'),
      'the refusal must NOT call the seam — that would mint a context before the refusal',
    ).toBe(false)
    // And `priorProducer` must derive from the CALCULATION, not the parent row.
    expect(block).toContain("priorContext.selector === 'group_effective'")
    expect(
      block.includes('record.projection_owner'),
      'priorProducer must not read the parent projection_owner (the silent-allow shortcut)',
    ).toBe(false)
  })

  it('S4 POSITIVE CONTROL: the seam-call ban is a real check, not a tautology', () => {
    // If the block extraction were broken, S4's `false` assertions would pass
    // over an empty string. Assert the extracted block is substantial and really
    // is the refusal.
    const source = read(PLUGIN)
    const start = source.indexOf('// W7-1b — OD-W7-10(a). RATIFIED')
    const end = source.indexOf('const port = attendanceW4SegmentCalculationPort', start)
    const block = source.slice(start, end)
    expect(block.length, 'the extracted OD-W7-10 block is suspiciously small').toBeGreaterThan(800)
    expect(block).toContain('W4C3C_RECOMPUTE_SOURCE_SUPERSEDED')
  })

  // -------------------------------------------------------------------------
  // The citations that made this file mandatory.
  // -------------------------------------------------------------------------

  it('the two production files that NAME this suite still name it (P2-1 closure)', () => {
    const suite = 'attendance-w7-1b-issuance-seam-closure.test.ts'
    expect(read(SEAM), 'the seam cites this guard by name').toContain(suite)
    expect(read('packages/core-backend/src/types/plugin.ts'), 'the port type cites this guard by name').toContain(suite)
    // And the cited file is THIS one.
    expect(fs.existsSync(path.join(REPO_ROOT, `packages/core-backend/tests/unit/${suite}`))).toBe(true)
  })
})
