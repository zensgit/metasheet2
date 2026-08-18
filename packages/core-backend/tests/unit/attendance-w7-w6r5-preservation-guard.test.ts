/**
 * W7-1a (#4556) STEP 4 — the W6-R5 preservation guard (design-lock red line
 * W7-R10).
 *
 * W6's red line W6-R5 ("no calculation writer consumes the W6 aggregate")
 * survives W7: the W7 resolver reads persisted facts under locks, never the
 * W6 HTTP aggregate. This suite is the mechanical check.
 *
 * It lands at W7-1 rather than W7-0 because the non-empty-domain leg would
 * have redded at the W7-0 baseline: root 3 (`.../attendance/w7-resolver/**`)
 * carries `presentAtW7Zero: false` and resolved to zero files until this slice
 * created it. W7-0 recorded the root set; W7-1 is the first head at which
 * every pinned root is real, so this is the first head at which the leg means
 * anything.
 *
 * Ratified per #4556 comments 5293034619 (owner-directed disclosed relay) + 5293478713 (owner
 * first-person confirmation) — ruling 9 (`w7-resolver/` subdirectory layout,
 * with the pre-dedupe nested-root count problem fixed first).
 *
 * FOUR LEGS, plus a dual-red positive control:
 *   Leg 0  — completeness: every walked file is claimed, `unclaimed = 0`.
 *   Leg NE — non-empty domain: each pinned root contributes >= 1 file, counted
 *            PRE-DEDUPE (the nesting-trap fix).
 *   Leg i  — reference ban by RESOLVED module path.
 *   Leg ii — transport ban, both route spellings.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1,
} from '../../src/attendance/w7-w6r5-guard-root-set'
import {
  ATTENDANCE_W7_CALCULATION_PATH_FILES_V1,
  ATTENDANCE_W7_NOT_CALCULATION_PATH_FILES_V1,
} from './w7-w6r5-guard/classification'
import {
  ATTENDANCE_W7_BANNED_W6_MODULES_V1,
  ATTENDANCE_W7_BANNED_W6_ROUTE_LITERALS_V1,
  ATTENDANCE_W7_TRANSPORT_CALL_PATTERNS_V1,
  isScannablePath,
  resolvedRelativeModuleTargets,
  stripGlobSuffix,
  walkAttendanceW7GuardDomain,
} from './w7-w6r5-guard/walk'

const REPO_ROOT = path.resolve(__dirname, '../../../../')

/** Probe path: under BOTH root 2 and root 3, a scannable extension, and
 *  outside every excluded segment — so it genuinely enters the walked domain.
 *  A probe under `__tests__/` or named `*.test.ts` would be a DEAD GATE
 *  (`isScannablePath` drops both), which is why the anchor-hit assertions below
 *  run BEFORE any leg assertion. */
const PROBE_REL = 'packages/core-backend/src/attendance/w7-resolver/w7-guard-probe-helper.ts'

/** The module Leg (i) bans. The decoy tree below must contain a file at this
 *  path for the probe's relative import to RESOLVE — Leg (i) matches resolved
 *  paths, and an unresolvable specifier is silently skipped. */
const BANNED_AGGREGATE_REL = ATTENDANCE_W7_BANNED_W6_MODULES_V1[0]

/**
 * Runs the REAL walk + REAL ban legs against an isolated temp tree that mirrors
 * the repo-relative layout, instead of writing a probe into the real
 * `packages/core-backend/src/` tree.
 *
 * WHY, stated rather than discovered later: a real file momentarily created
 * under `src/` and then deleted RACES every other suite in this package that
 * walks that tree, under `pool: 'forks'` full-suite parallelism. This is not
 * hypothetical — the first version of this suite planted a real probe, and the
 * full no-DB run went red because the sibling W7-1a inertness sweep had its own
 * probe planted under `src/attendance/` at the same moment, so THIS suite's
 * `unclaimed` legitimately contained two files. The landed W6-R5 import-graph
 * guard already documents and solves exactly this
 * (`attendance-w6-import-graph-no-calculation-consumer.test.ts`'s
 * `withDecoyFile`), and this is the same remedy.
 *
 * It is exactly as discriminating: `walkAttendanceW7GuardDomain`,
 * `resolvedRelativeModuleTargets` and both ban legs do only relative-path
 * arithmetic plus `readFileSync`, so they cannot tell a mirrored root from the
 * real one. What the mirror CANNOT prove — that `PROBE_REL` really is a path
 * the real guard would walk — is proven separately, against the real root
 * record and the real `isScannablePath`, in the anchor-hit assertions.
 */
function withDecoyTree(files: Record<string, string>, run: (decoyRoot: string) => void): void {
  const decoyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'w7r10-decoy-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(decoyRoot, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content, 'utf8')
    }
    run(decoyRoot)
  } finally {
    fs.rmSync(decoyRoot, { recursive: true, force: true })
  }
}

/** Anchor-hit check, run against the REAL root record and the REAL scannable
 *  filter before any decoy leg: an unhit probe and a dead gate look identical,
 *  and a probe path that the real guard would never walk proves nothing. */
function assertProbePathIsInTheRealDomain(): void {
  expect(isScannablePath(PROBE_REL), 'probe path is not scannable — dead gate').toBe(true)
  const covering = ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1.filter((entry) =>
    PROBE_REL.startsWith(`${stripGlobSuffix(entry.root)}/`),
  )
  // It must be covered by root 2 AND root 3 — that is what makes it a probe of
  // the nested region rather than of some arbitrary directory.
  expect(covering.map((entry) => entry.root).sort()).toEqual(
    [
      'packages/core-backend/src/attendance/**',
      'packages/core-backend/src/attendance/w7-resolver/**',
    ].sort(),
  )
}

function classifiedCalculationPath(): Set<string> {
  return new Set(ATTENDANCE_W7_CALCULATION_PATH_FILES_V1)
}

/** Leg (i) over an explicit partition — parameterised so the positive control
 *  can run the same code against a mutated partition. */
function referenceBanViolations(
  union: readonly string[],
  calcPath: ReadonlySet<string>,
  root: string = REPO_ROOT,
): string[] {
  const out: string[] = []
  for (const rel of union) {
    if (!calcPath.has(rel)) continue
    const targets = resolvedRelativeModuleTargets(root, rel)
    if (targets.some((target) => ATTENDANCE_W7_BANNED_W6_MODULES_V1.includes(target))) out.push(rel)
  }
  return out.sort()
}

/** Leg (ii) over an explicit partition. A file violates only when it BOTH
 *  names the route (either spelling, exactly as the repo writes it) AND
 *  contains an HTTP transport call — naming the route in a comment is not a
 *  consumption, and a `fetch` to something else is not this route. */
function transportBanViolations(
  union: readonly string[],
  calcPath: ReadonlySet<string>,
  root: string = REPO_ROOT,
): string[] {
  const out: string[] = []
  for (const rel of union) {
    if (!calcPath.has(rel)) continue
    const text = fs.readFileSync(path.join(root, rel), 'utf8')
    const namesRoute = ATTENDANCE_W7_BANNED_W6_ROUTE_LITERALS_V1.some((literal) => text.includes(literal))
    if (!namesRoute) continue
    const callsOut = ATTENDANCE_W7_TRANSPORT_CALL_PATTERNS_V1.some((pattern) => pattern.test(text))
    if (callsOut) out.push(rel)
  }
  return out.sort()
}

describe('W7-R10: W6-R5 preservation guard — derived domain', () => {
  it('emits a regenerated classification body when EMIT_W7_CLASSIFICATION=1', () => {
    // Regeneration recipe, so the next author who adds a file under a pinned
    // root is not hand-editing 72 strings. Deliberately a no-op unless the env
    // var is set: the emit itself must never be the thing that makes Leg 0
    // pass. Mirrors `EMIT_ATTENDANCE_CORPUS` in
    // `scripts/ops/attendance-w4c2-ci-wiring.test.mjs`.
    if (process.env.EMIT_W7_CLASSIFICATION !== '1') return
    const { union } = walkAttendanceW7GuardDomain(REPO_ROOT)
    // eslint-disable-next-line no-console
    console.log(`\n${union.map((rel) => `  '${rel}',`).join('\n')}\n`)
  })

  it('Leg 0 (completeness): every walked file is claimed exactly once; unclaimed = 0', () => {
    const { union } = walkAttendanceW7GuardDomain(REPO_ROOT)
    const claimed = new Set<string>([
      ...ATTENDANCE_W7_CALCULATION_PATH_FILES_V1,
      ...ATTENDANCE_W7_NOT_CALCULATION_PATH_FILES_V1.map((entry) => entry.relPath),
    ])

    const unclaimed = union.filter((rel) => !claimed.has(rel)).sort()
    expect(
      unclaimed,
      'hard zero-bypass requires unclaimed=0: a file appeared under a pinned root that neither ' +
        'classification list mentions. This is expected and fine when a file is ADDED — it is ' +
        'announced rather than silently absorbed. To resolve: re-run ' +
        '`EMIT_W7_CLASSIFICATION=1 pnpm --filter @metasheet/core-backend exec vitest run ' +
        'tests/unit/attendance-w7-w6r5-preservation-guard.test.ts` and paste the printed body into ' +
        'ATTENDANCE_W7_CALCULATION_PATH_FILES_V1 in tests/unit/w7-w6r5-guard/classification.ts — ' +
        'unless the file genuinely cannot reach the frozen-context build path, in which case add it ' +
        'to ATTENDANCE_W7_NOT_CALCULATION_PATH_FILES_V1 WITH A REASON and expect that reason to be ' +
        'reviewed (it makes both ban legs inapplicable to that file). Same discipline as the ' +
        'attendance CI corpus pin and the s6a hash pin.',
    ).toEqual([])

    // The claim side is bidirectional: a claim naming a file that is no longer
    // in the domain is just as much a drift signal as an unclaimed file, and
    // silently tolerating it would let the claim list rot into fiction.
    const domain = new Set(union)
    const staleClaims = [...claimed].filter((rel) => !domain.has(rel)).sort()
    expect(staleClaims, 'a classification entry names a file no longer in the walked domain').toEqual([])

    // No file may be claimed by BOTH partitions.
    const bothPartitions = ATTENDANCE_W7_NOT_CALCULATION_PATH_FILES_V1.map((e) => e.relPath).filter(
      (rel) => ATTENDANCE_W7_CALCULATION_PATH_FILES_V1.includes(rel),
    )
    expect(bothPartitions).toEqual([])
  })

  it('every not_calculation_path carve-out carries a non-trivial reason', () => {
    // Vacuously true while the carve-out list is empty (see classification.ts
    // header). Asserted anyway so the FIRST entry anyone adds is forced to
    // carry a reason rather than inheriting silence.
    for (const entry of ATTENDANCE_W7_NOT_CALCULATION_PATH_FILES_V1) {
      expect(entry.reason.length, `${entry.relPath} carve-out reason is too short to review`).toBeGreaterThan(40)
    }
  })

  it('Leg NE (non-empty domain): every pinned root contributes >= 1 file, counted PRE-DEDUPE', () => {
    const { perRootScannableCounts } = walkAttendanceW7GuardDomain(REPO_ROOT)

    // Non-vacuity of the leg itself: the root record must actually have roots.
    expect(ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1.length).toBe(3)

    for (const entry of ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1) {
      const dir = stripGlobSuffix(entry.root)
      expect(fs.existsSync(path.join(REPO_ROOT, dir)), `pinned root does not exist: ${entry.root}`).toBe(true)
      expect(
        perRootScannableCounts.get(entry.root) ?? 0,
        `pinned root contributes zero files (an empty read is not an absence): ${entry.root}`,
      ).toBeGreaterThan(0)
    }
  })

  it('Leg NE nesting regression control: root 3 is non-zero even though root 2 contains it', () => {
    const { perRootScannableCounts, union } = walkAttendanceW7GuardDomain(REPO_ROOT)
    const root2 = 'packages/core-backend/src/attendance/**'
    const root3 = 'packages/core-backend/src/attendance/w7-resolver/**'

    // The trap is real, not hypothetical: root 3 is nested inside root 2, and
    // root 2 comes FIRST in the recorded order. A P16-faithful shared-`seen`
    // port would attribute every w7-resolver file to root 2 and report root 3
    // as zero — permanently, and precisely when this leg is meant to be
    // proving root 3 became real. These assertions pin the nesting so the
    // regression control cannot silently stop discriminating.
    const idx2 = ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1.findIndex((e) => e.root === root2)
    const idx3 = ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1.findIndex((e) => e.root === root3)
    expect(idx2).toBeGreaterThanOrEqual(0)
    expect(idx3).toBeGreaterThan(idx2)
    expect(stripGlobSuffix(root3).startsWith(stripGlobSuffix(root2) + '/')).toBe(true)

    const root3Count = perRootScannableCounts.get(root3) ?? 0
    expect(root3Count, 'root 3 counted zero — the shared-`seen` nesting trap is back').toBeGreaterThan(0)

    // The pre-dedupe count must be a real superset relationship with the
    // deduped union, otherwise "pre-dedupe" would be an unproven label.
    const unionRoot3 = union.filter((rel) => rel.startsWith(stripGlobSuffix(root3) + '/'))
    expect(unionRoot3.length).toBe(root3Count)
    const root2Count = perRootScannableCounts.get(root2) ?? 0
    const unionRoot2 = union.filter((rel) => rel.startsWith(stripGlobSuffix(root2) + '/'))
    // Root 2's PRE-dedupe count includes root 3's files; the union counts them once.
    expect(root2Count).toBe(unionRoot2.length)
    expect(root2Count).toBeGreaterThan(root3Count)
  })

  it('Leg (i) reference ban: no calculation_path file resolves an import to the W6 aggregate', () => {
    const { union } = walkAttendanceW7GuardDomain(REPO_ROOT)
    expect(referenceBanViolations(union, classifiedCalculationPath())).toEqual([])
  })

  it('Leg (ii) transport ban: no calculation_path file calls the W6 aggregate route', () => {
    const { union } = walkAttendanceW7GuardDomain(REPO_ROOT)
    expect(transportBanViolations(union, classifiedCalculationPath())).toEqual([])
  })

  it('the banned-module set is non-vacuous and resolves to a file that exists', () => {
    expect(ATTENDANCE_W7_BANNED_W6_MODULES_V1.length).toBeGreaterThan(0)
    for (const rel of ATTENDANCE_W7_BANNED_W6_MODULES_V1) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `banned module path is stale: ${rel}`).toBe(true)
    }
    // Both route spellings must be the ones the repo actually writes — pinned
    // against their real sources so a rename reds here rather than silently
    // making the transport ban match nothing. No home-grown normalizer is
    // involved: the literals are compared to repo text verbatim.
    const expressSource = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/core-backend/src/routes/attendance-admin.ts'),
      'utf8',
    )
    const openapiSource = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/openapi/drafts/attendance-w6-group-effective-policy.draft.yml'),
      'utf8',
    )
    expect(expressSource).toContain('/api/attendance/groups/:groupId/effective-policy')
    expect(openapiSource).toContain('/api/attendance/groups/{groupId}/effective-policy')
    expect([...ATTENDANCE_W7_BANNED_W6_ROUTE_LITERALS_V1].sort()).toEqual(
      [
        '/api/attendance/groups/:groupId/effective-policy',
        '/api/attendance/groups/{groupId}/effective-policy',
      ].sort(),
    )
  })
})

describe('W7-R10 positive control: ONE probe reds BOTH ban legs', () => {
  const CONSUMER_PROBE = [
    "import { buildAttendanceGroupEffectivePolicyAggregateV1 } from '../w6-group-effective-policy-aggregate'",
    '',
    'export async function probeGroupPolicy(): Promise<unknown> {',
    '  void buildAttendanceGroupEffectivePolicyAggregateV1',
    "  const res = await fetch('/api/attendance/groups/:groupId/effective-policy')",
    '  return res',
    '}',
    '',
  ].join('\n')

  it('plants an unclassified consumer, proves the anchor was hit, then reds Leg 0, Leg (ii) and Leg (i)', () => {
    // The probe is the bypass this criterion exists to catch: a helper that
    // imports the W6 aggregate AND calls its route over HTTP.
    //
    // ANCHOR-HIT CHECK FIRST, against the REAL root record and the REAL
    // scannable filter. An unhit probe and a dead gate look identical.
    assertProbePathIsInTheRealDomain()

    withDecoyTree(
      {
        [PROBE_REL]: CONSUMER_PROBE,
        // Present so the probe's relative import RESOLVES; Leg (i) matches
        // resolved paths, and an unresolvable specifier is silently skipped —
        // which would make this control pass while proving nothing.
        [BANNED_AGGREGATE_REL]: 'export const buildAttendanceGroupEffectivePolicyAggregateV1 = 1\n',
      },
      (decoyRoot) => {
        const { union, perRootScannableCounts } = walkAttendanceW7GuardDomain(decoyRoot)

        // Second half of the anchor-hit check: the REAL walk really does pick
        // this path up, and it lands inside root 3's own pre-dedupe walk.
        expect(union, 'probe never entered the walked domain — dead gate, not a passing guard').toContain(
          PROBE_REL,
        )
        expect(
          perRootScannableCounts.get('packages/core-backend/src/attendance/w7-resolver/**') ?? 0,
        ).toBeGreaterThan(0)

        // ---- Leg 0 reds while the probe is UNCLASSIFIED. ----
        const claimed = new Set<string>([
          ...ATTENDANCE_W7_CALCULATION_PATH_FILES_V1,
          ...ATTENDANCE_W7_NOT_CALCULATION_PATH_FILES_V1.map((entry) => entry.relPath),
        ])
        expect(union.filter((rel) => !claimed.has(rel))).toContain(PROBE_REL)

        // ---- Both ban legs red once the SAME probe is classified. ----
        const withProbe = new Set([...ATTENDANCE_W7_CALCULATION_PATH_FILES_V1, PROBE_REL])
        expect(transportBanViolations(union, withProbe, decoyRoot)).toContain(PROBE_REL)
        expect(referenceBanViolations(union, withProbe, decoyRoot)).toContain(PROBE_REL)

        // ...and while it is UNCLASSIFIED, neither ban leg looks at it at all —
        // which is the property that makes a `not_calculation_path`
        // misclassification a real blind spot rather than a theoretical one.
        const withoutProbe = new Set(ATTENDANCE_W7_CALCULATION_PATH_FILES_V1)
        expect(transportBanViolations(union, withoutProbe, decoyRoot)).not.toContain(PROBE_REL)
        expect(referenceBanViolations(union, withoutProbe, decoyRoot)).not.toContain(PROBE_REL)
      },
    )
  })

  it('the OpenAPI route spelling is caught too, not only the express one', () => {
    // Leg (ii) must match BOTH spellings. A probe carrying only the `{groupId}`
    // form proves the second literal is load-bearing rather than decorative.
    assertProbePathIsInTheRealDomain()
    withDecoyTree(
      {
        [PROBE_REL]: [
          'export async function probeOpenApiSpelling(): Promise<unknown> {',
          "  return fetch('/api/attendance/groups/{groupId}/effective-policy')",
          '}',
          '',
        ].join('\n'),
      },
      (decoyRoot) => {
        const { union } = walkAttendanceW7GuardDomain(decoyRoot)
        expect(union).toContain(PROBE_REL)
        const withProbe = new Set([...ATTENDANCE_W7_CALCULATION_PATH_FILES_V1, PROBE_REL])
        expect(transportBanViolations(union, withProbe, decoyRoot)).toContain(PROBE_REL)
        // ...and it must NOT trip the reference leg, so the two legs are proven
        // independent rather than one leg firing for both probes.
        expect(referenceBanViolations(union, withProbe, decoyRoot)).not.toContain(PROBE_REL)
      },
    )
  })

  it('naming the route WITHOUT an HTTP call does not red Leg (ii) (the legs are not text tripwires)', () => {
    assertProbePathIsInTheRealDomain()
    withDecoyTree(
      {
        [PROBE_REL]: [
          '// Documentation reference to /api/attendance/groups/:groupId/effective-policy',
          'export const PROBE_DOC_ONLY = 1',
          '',
        ].join('\n'),
      },
      (decoyRoot) => {
        const { union } = walkAttendanceW7GuardDomain(decoyRoot)
        expect(union).toContain(PROBE_REL)
        const withProbe = new Set([...ATTENDANCE_W7_CALCULATION_PATH_FILES_V1, PROBE_REL])
        expect(transportBanViolations(union, withProbe, decoyRoot)).not.toContain(PROBE_REL)
      },
    )
  })

  it('an import that does NOT resolve to the banned module leaves Leg (i) green', () => {
    // Negative control on Leg (i)'s resolution step: same import SHAPE, a
    // different target. Without this, "Leg (i) fires" could just mean "the file
    // contains the word import".
    assertProbePathIsInTheRealDomain()
    withDecoyTree(
      {
        [PROBE_REL]: [
          "import { something } from './w7-composite-lock-order'",
          'export const probe = something',
          '',
        ].join('\n'),
        'packages/core-backend/src/attendance/w7-resolver/w7-composite-lock-order.ts':
          'export const something = 1\n',
        [BANNED_AGGREGATE_REL]: 'export const buildAttendanceGroupEffectivePolicyAggregateV1 = 1\n',
      },
      (decoyRoot) => {
        const { union } = walkAttendanceW7GuardDomain(decoyRoot)
        expect(union).toContain(PROBE_REL)
        const withProbe = new Set([...ATTENDANCE_W7_CALCULATION_PATH_FILES_V1, PROBE_REL])
        expect(referenceBanViolations(union, withProbe, decoyRoot)).not.toContain(PROBE_REL)
      },
    )
  })
})
