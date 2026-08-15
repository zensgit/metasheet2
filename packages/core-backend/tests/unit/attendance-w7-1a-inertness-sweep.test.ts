/**
 * W7-1a (#4556) STEP 5 — the structural-inertness sweep.
 *
 * W7-1a's byte-neutrality claim is STRUCTURAL and GREPPABLE, and this suite is
 * what makes it a claim rather than an assertion: the posture resolver, the
 * composite lock helper, the group-effective facts resolver and the core
 * issuance module have ZERO production import sites and ZERO production call
 * sites, so nothing in the production runtime graph reaches them. Combined
 * with the posture table shipping EMPTY and the W7 allowlist env var being
 * unset by default, nothing an org can do exercises this slice.
 *
 * The claim is head-scoped: it is a fact about the tree this suite runs on,
 * not a promise about later ones. That is exactly why it is a test.
 *
 * "PRODUCTION" IS DEFINED MECHANICALLY BELOW, not by eyeball. A sweep whose
 * exclusions are applied by judgement is a sweep that can be talked into any
 * answer. And because a zero-hit grep with a wrong path is indistinguishable
 * from a genuinely clean tree, every leg here carries a NEGATIVE CONTROL that
 * plants a real violation and proves the leg reds.
 *
 * Ratified per #4556 comments 5293034619 (owner-directed disclosed relay) + 5293478713 (owner
 * first-person confirmation).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../../')

const W7_RESOLVER_DIR = 'packages/core-backend/src/attendance/w7-resolver'
const POSTURE_TABLE = 'attendance_calculation_context_source_state'

/** A probe path in PRODUCTION territory (under `src/`, not under the resolver
 *  directory, not a test file) — so an import planted there is a real violation
 *  of the inertness claim, not a staged one. The probe is written into an
 *  ISOLATED MIRROR of this path, never into the real tree: see `withDecoyTree`. */
const PROBE_REL = 'packages/core-backend/src/attendance/w7-inertness-probe.ts'

/**
 * Runs the REAL sweep predicates against an isolated temp tree that mirrors the
 * repo-relative layout, instead of writing a probe into the real `src/` tree.
 *
 * WHY, recorded rather than left to be rediscovered: a real file created under
 * `src/` and then deleted RACES every sibling suite in this package that walks
 * that tree, under `pool: 'forks'` full-suite parallelism. The first version of
 * this suite planted a real probe and turned the sibling W7-R10 walk-the-table
 * guard red, because that guard's `unclaimed` legitimately contained this
 * suite's in-flight probe. The landed W6-R5 import-graph guard already
 * documents and solves exactly this (`withDecoyFile` in
 * `attendance-w6-import-graph-no-calculation-consumer.test.ts`); this is the
 * same remedy.
 *
 * Exactly as discriminating: every predicate below does relative-path
 * arithmetic plus `readFileSync`, so none can tell a mirrored root from the
 * real one. What the mirror cannot show — that `PROBE_REL` is a path the real
 * sweep would classify as production — is asserted separately against the real
 * `isProductionSource`.
 */
function withDecoyTree(files: Record<string, string>, run: (decoyRoot: string) => void): void {
  const decoyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-inert-decoy-'))
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

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs'])

/**
 * Mechanical exclusion rules. Anything NOT excluded is production.
 *
 *  - test material: `/__tests__/`, `/tests/`, `/test/`, `*.test.*`, `*.spec.*`
 *  - type-only declarations: `*.d.ts`
 *  - build output / vendored: `node_modules`, `dist`, `build`, `coverage`,
 *    `.turbo`
 *  - the W7 resolver directory ITSELF: its four modules import each other, and
 *    counting those intra-module edges would make the claim unsatisfiable by
 *    construction rather than false. The claim is "nothing OUTSIDE reaches
 *    in", and that is what is measured.
 */
const EXCLUDED_SEGMENTS = ['node_modules', 'dist', 'build', 'coverage', '.turbo', '.git', '__tests__', 'tests', 'test']
const EXCLUDED_MARKERS = ['.test.', '.spec.', '.d.ts']

function isProductionSource(relPath: string): boolean {
  if (relPath.startsWith(`${W7_RESOLVER_DIR}/`)) return false
  const parts = relPath.split('/')
  if (parts.some((segment) => EXCLUDED_SEGMENTS.includes(segment))) return false
  const base = parts[parts.length - 1]
  if (EXCLUDED_MARKERS.some((marker) => base.includes(marker))) return false
  return SOURCE_EXTENSIONS.has(path.extname(base))
}

function trackedFiles(): string[] {
  const raw = execFileSync('git', ['ls-files', '-z', '--cached'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  })
  return raw.toString('utf8').split('\0').filter((entry) => entry.length > 0)
}

/** The production files the real sweep inspects. */
function productionFiles(): string[] {
  return trackedFiles().filter(isProductionSource).sort()
}

const SPECIFIER_RE = /(?:\bimport\s*\(|\brequire\s*\(|\bfrom\s+)\s*['"]([^'"]+)['"]/g

/** Resolved relative import/require/dynamic-import targets — judged on what a
 *  file LOADS, not on how the specifier is spelled. */
function resolvedTargets(relPath: string, root: string = REPO_ROOT): string[] {
  const abs = path.join(root, relPath)
  const text = fs.readFileSync(abs, 'utf8')
  const targets: string[] = []
  for (const match of text.matchAll(SPECIFIER_RE)) {
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

/**
 * Code text with block and line comments removed.
 *
 * WHY THIS IS NEEDED, stated rather than hidden: two legs below ask "does any
 * production file NAME this table / this env var". A raw `includes()` answers
 * a text question, not a behavioural one, and it reds on prose — the landed
 * W7-0 contract module names the posture table in its header to say what shape
 * the future row has, and the W7 posture resolver names the W4 env var in its
 * header precisely to record that it does NOT reuse it. Both are documentation
 * of a decision, not a read of a table or an environment variable. Matching
 * over code-with-comments-stripped asks the question actually intended.
 *
 * This is a deliberately small stripper, not a parser: it removes block and
 * line comments and is blind to comment-like text inside string literals. That
 * is safe in the only direction that matters here — a string literal
 * containing `//` would be under-stripped, i.e. the sweep stays STRICTER, never
 * looser. The negative controls below plant real code and prove the legs still
 * red through it.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

function productionImportersOfResolver(
  files: readonly string[] = productionFiles(),
  root: string = REPO_ROOT,
): string[] {
  return files
    .filter((rel) => resolvedTargets(rel, root).some((target) => target.startsWith(`${W7_RESOLVER_DIR}/`)))
    .sort()
}

/** The exported runtime entry points. A production file naming any of these is
 *  a call site even if it somehow obtained the symbol without a relative
 *  import (re-export chain, barrel file, string-built specifier). */
const W7_RUNTIME_SYMBOLS = [
  'resolveAttendanceW7ContextSourcePostureV1',
  'acquireAttendanceW7CompositeFactsLocksV1',
  'resolveW7GroupEffectiveFactsInTransactionV1',
  'coreIssueGroupEffectiveContextV2',
  'coreRehydrateGroupEffectiveContextV2',
  'isAttendanceW7ContextSourceOrgAllowlistedV1',
] as const

function productionCallSites(
  files: readonly string[] = productionFiles(),
  root: string = REPO_ROOT,
): Array<{ file: string; symbol: string }> {
  const hits: Array<{ file: string; symbol: string }> = []
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8')
    for (const symbol of W7_RUNTIME_SYMBOLS) {
      if (text.includes(symbol)) hits.push({ file: rel, symbol })
    }
  }
  return hits
}

/** Production files whose CODE (comments stripped) names the posture table,
 *  excluding the migration that creates it. */
function postureTableCodeReferences(
  files: readonly string[] = productionFiles(),
  root: string = REPO_ROOT,
): string[] {
  return files
    .filter((rel) => !rel.includes('/db/migrations/'))
    .filter((rel) => stripComments(fs.readFileSync(path.join(root, rel), 'utf8')).includes(POSTURE_TABLE))
    .sort()
}

describe('W7-1a structural inertness: the sweep itself is non-vacuous', () => {
  it('the production file set is large and really contains known production modules', () => {
    const files = productionFiles()
    expect(files.length).toBeGreaterThan(300)
    expect(files).toContain('packages/core-backend/src/attendance/w4c0-identity.ts')
    expect(files).toContain('plugins/plugin-attendance/index.cjs')
    // ...and really EXCLUDES test material, so the exclusions are not silently
    // swallowing the whole tree.
    expect(files).not.toContain('packages/core-backend/tests/unit/attendance-w7-1a-inertness-sweep.test.ts')
    expect(isProductionSource('packages/core-backend/tests/unit/anything.test.ts')).toBe(false)
    expect(files.some((f) => f.startsWith(`${W7_RESOLVER_DIR}/`))).toBe(false)
  })

  it('the four W7-1a modules exist at the paths this sweep is pointed at', () => {
    // Guards the "wrong path, zero hits, looks clean" failure: if these paths
    // were stale, every leg below would pass over nothing.
    for (const file of [
      'w7-composite-lock-order.ts',
      'w7-context-source-posture-resolver.ts',
      'w7-group-effective-context-issuance.ts',
      'w7-group-effective-facts-resolver.ts',
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, W7_RESOLVER_DIR, file)), `missing: ${file}`).toBe(true)
    }
  })

  it('the resolver modules DO import each other — proving the resolver-path matcher works', () => {
    // Positive control for `resolvedTargets` + the `startsWith` matcher: if the
    // matcher were broken, it would report zero importers everywhere, and the
    // inertness legs would pass for the wrong reason.
    const issuance = `${W7_RESOLVER_DIR}/w7-group-effective-context-issuance.ts`
    expect(resolvedTargets(issuance)).toContain(`${W7_RESOLVER_DIR}/w7-group-effective-facts-resolver.ts`)
  })
})

/**
 * W7-3 (#4556) AMENDMENT to the three legs below.
 *
 * WHY THESE LEGS CHANGE, and why the change is a NARROWING rather than a
 * weakening. At W7-1a's head the honest measurement was "zero". W7-3 ships the
 * transition WRITER, and the writer is REQUIRED — by the resolver's own doc
 * comment (`w7-resolver/w7-context-source-posture-resolver.ts:95-101`, "The
 * future W7 transition writer must gate on
 * `isAttendanceW7ContextSourceOrgAllowlistedV1` below ... NOT a second copied
 * allowlist mechanism") — to import the resolver module and name that symbol,
 * and it is by definition the module that writes the posture table. So each of
 * these three legs necessarily acquires exactly one new member.
 *
 * The alternative was to place the writer under `w7-resolver/`, which
 * `isProductionSource` excludes, and let all three legs stay `[]` untouched.
 * That was rejected deliberately: it would keep the guard green by HIDING the
 * new file in an excluded directory rather than by the property still holding —
 * green-by-exclusion, which is the failure mode this whole suite exists to
 * prevent. Ruling 9 fixes `w7-resolver/` for the RESOLVER; the writer is the
 * write side and sits beside `w4c3a-rollout-control.ts`, the boundary it clones.
 *
 * WHAT KEEPS THE LEGS DISCRIMINATING: each stays an EXACT-SET equality, not a
 * relaxation to "contains" or a filter that drops the writer. Any OTHER
 * production file acquiring an importer, a call site or a table reference still
 * reds, and the negative controls below are unchanged. The inertness CLAIM is
 * unchanged and is re-asserted one level up by
 * `W7_TRANSITION_WRITER_ENTRY_POINTS` immediately after: the writer itself has
 * zero production importers and zero production call sites, so nothing in the
 * runtime graph can reach the posture table through it.
 */
const W7_TRANSITION_WRITER = 'packages/core-backend/src/attendance/w7-context-source-transition.ts'

/** The W7-3 writer's exported runtime entry points. A production file naming any
 *  of these is a call site even without a relative import. */
const W7_TRANSITION_WRITER_ENTRY_POINTS = [
  'transitionAttendanceW7ContextSourceV1',
  'planAttendanceW7ContextSourceTransitionV1',
] as const

describe('W7-1a structural inertness: zero production importers and call sites', () => {
  it('the ONLY production importer of w7-resolver/ is the W7-3 transition writer', () => {
    expect(productionImportersOfResolver()).toEqual([W7_TRANSITION_WRITER])
  })

  it('the ONLY production naming of a W7-1a runtime entry point is the writer using the ONE allowlist predicate', () => {
    // Exactly one hit, and specifically the allowlist predicate: the writer must
    // gate on the landed predicate rather than hold a second copy of the
    // allowlist parsing rules. A hit on any OTHER W7 runtime symbol — e.g. the
    // writer starting to call the READ resolver — would red here.
    expect(productionCallSites()).toEqual([
      { file: W7_TRANSITION_WRITER, symbol: 'isAttendanceW7ContextSourceOrgAllowlistedV1' },
    ])
  })

  /**
   * The separately-gated operator tool. It is the ONE thing allowed to reach the
   * writer, exactly as `scripts/ops/attendance-w4c5-rollout-transition{,-lib}.ts`
   * is the one thing allowed to reach the W4 transition boundary.
   *
   * SHIPPING THE TOOL IS NOT RUNNING IT: a `scripts/ops` CLI is invoked by an
   * operator under its own owner ruling, never by the server process. That is
   * why the leg below splits into TWO assertions instead of one relaxed list —
   * the load-bearing claim is not "nothing names the writer", it is "no module
   * in the SERVER RUNTIME GRAPH names the writer", and that stays exactly zero.
   */
  const W7_TRANSITION_OPERATOR_TOOL = [
    'scripts/ops/attendance-w7-context-source-transition-lib.ts',
    'scripts/ops/attendance-w7-context-source-transition.ts',
  ]

  it('the W7-3 transition writer is reachable ONLY from the separately-gated operator tool', () => {
    const files = productionFiles()

    // Anchor-hit check FIRST: an unhit sweep and a dead gate look identical.
    expect(files, 'the writer is not in the swept set — dead sweep').toContain(W7_TRANSITION_WRITER)
    for (const tool of W7_TRANSITION_OPERATOR_TOOL) {
      expect(files, `the operator tool is not in the swept set: ${tool}`).toContain(tool)
    }

    const importers = files
      .filter((rel) => rel !== W7_TRANSITION_WRITER)
      .filter((rel) => resolvedTargets(rel).includes(W7_TRANSITION_WRITER))
      .sort()
    expect(importers, 'an unexpected module imports the W7 transition writer').toEqual(
      [...W7_TRANSITION_OPERATOR_TOOL].sort(),
    )

    const namers: Array<{ file: string; symbol: string }> = []
    for (const rel of files) {
      if (rel === W7_TRANSITION_WRITER) continue
      const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
      for (const symbol of W7_TRANSITION_WRITER_ENTRY_POINTS) {
        if (code.includes(symbol)) namers.push({ file: rel, symbol })
      }
    }
    // ONLY THE CLI names a runtime entry point. The lib half imports the writer
    // TYPE-ONLY (erased at compile time, zero runtime dependency — that is its
    // documented design, and the reason it can be unit-tested with no database
    // and no CJS/ESM interop dance), so it must appear as an importer above and
    // NOT as a namer here. Asserting the exact set is what keeps that property
    // pinned: a lib that started calling the writer would red.
    expect(new Set(namers.map((hit) => hit.file))).toEqual(
      new Set(['scripts/ops/attendance-w7-context-source-transition.ts']),
    )
  })

  it('ZERO module in the SERVER RUNTIME GRAPH reaches the W7-3 writer — the load-bearing claim', () => {
    // `packages/**` and `plugins/**` are what the server process loads. The
    // operator tool lives under `scripts/` and is never imported by either, so
    // the runtime graph cannot reach the writer even transitively through it.
    const runtimeFiles = productionFiles().filter(
      (rel) =>
        (rel.startsWith('packages/') || rel.startsWith('plugins/')) &&
        rel !== W7_TRANSITION_WRITER,
    )

    // NON-VACUITY: the runtime graph is large and really contains known modules.
    expect(runtimeFiles.length).toBeGreaterThan(300)
    expect(runtimeFiles).toContain('packages/core-backend/src/attendance/w4c0-identity.ts')
    expect(runtimeFiles).toContain('plugins/plugin-attendance/index.cjs')

    const reachers: string[] = []
    for (const rel of runtimeFiles) {
      if (resolvedTargets(rel).includes(W7_TRANSITION_WRITER)) {
        reachers.push(rel)
        continue
      }
      const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
      if (W7_TRANSITION_WRITER_ENTRY_POINTS.some((symbol) => code.includes(symbol))) {
        reachers.push(rel)
      }
    }
    expect(reachers, 'a server-runtime module reaches the W7 transition writer').toEqual([])

    // ...and nothing in the runtime graph imports the operator tool either, so
    // the tool cannot become a runtime path by being pulled in indirectly.
    const toolImporters = runtimeFiles
      .filter((rel) => resolvedTargets(rel).some((t) => W7_TRANSITION_OPERATOR_TOOL.includes(t)))
      .sort()
    expect(toolImporters, 'a server-runtime module imports the W7 operator tool').toEqual([])
  })

  it('NEGATIVE CONTROL on the writer-reachability leg: a planted caller is really detected', () => {
    // Without this, the leg above could be passing because `stripComments` ate
    // everything or the entry-point list is misspelled.
    withDecoyTree(
      {
        [PROBE_REL]: [
          "import { transitionAttendanceW7ContextSourceV1 } from './w7-context-source-transition'",
          'export const probe = transitionAttendanceW7ContextSourceV1',
          '',
        ].join('\n'),
        [W7_TRANSITION_WRITER]: 'export const transitionAttendanceW7ContextSourceV1 = 1\n',
      },
      (decoyRoot) => {
        expect(resolvedTargets(PROBE_REL, decoyRoot)).toContain(W7_TRANSITION_WRITER)
        const code = stripComments(fs.readFileSync(path.join(decoyRoot, PROBE_REL), 'utf8'))
        expect(code).toContain('transitionAttendanceW7ContextSourceV1')
      },
    )
  })

  it('NEGATIVE CONTROL: planting a production importer reds both legs', () => {
    // Anchor-hit check FIRST, against the REAL classifier: an unseen probe and
    // a dead sweep look identical.
    expect(isProductionSource(PROBE_REL), 'probe path is not production — dead sweep').toBe(true)

    withDecoyTree(
      {
        [PROBE_REL]: [
          "import { resolveAttendanceW7ContextSourcePostureV1 } from './w7-resolver/w7-context-source-posture-resolver'",
          '',
          'export const probe = resolveAttendanceW7ContextSourcePostureV1',
          '',
        ].join('\n'),
        // Present so the specifier RESOLVES — the importer leg matches resolved
        // paths, and an unresolvable specifier is silently skipped.
        [`${W7_RESOLVER_DIR}/w7-context-source-posture-resolver.ts`]:
          'export const resolveAttendanceW7ContextSourcePostureV1 = 1\n',
      },
      (decoyRoot) => {
        expect(productionImportersOfResolver([PROBE_REL], decoyRoot)).toEqual([PROBE_REL])
        expect(productionCallSites([PROBE_REL], decoyRoot)).toEqual([
          { file: PROBE_REL, symbol: 'resolveAttendanceW7ContextSourcePostureV1' },
        ])
      },
    )
  })

  it('NEGATIVE CONTROL: a dynamic `await import()` is caught too, not only static imports', () => {
    withDecoyTree(
      {
        [PROBE_REL]: [
          'export async function probe(): Promise<unknown> {',
          "  return import('./w7-resolver/w7-group-effective-facts-resolver')",
          '}',
          '',
        ].join('\n'),
        [`${W7_RESOLVER_DIR}/w7-group-effective-facts-resolver.ts`]: 'export const x = 1\n',
      },
      (decoyRoot) => {
        expect(productionImportersOfResolver([PROBE_REL], decoyRoot)).toEqual([PROBE_REL])
      },
    )
  })

  it('NEGATIVE CONTROL on the matcher: an import of a DIFFERENT module leaves both legs green', () => {
    // Without this, "the leg fired" could mean "the file contains the word
    // import" rather than "it resolves into w7-resolver/".
    withDecoyTree(
      {
        [PROBE_REL]: [
          "import { helper } from './w4c0-identity'",
          'export const probe = helper',
          '',
        ].join('\n'),
        'packages/core-backend/src/attendance/w4c0-identity.ts': 'export const helper = 1\n',
        [`${W7_RESOLVER_DIR}/w7-context-source-posture-resolver.ts`]: 'export const x = 1\n',
      },
      (decoyRoot) => {
        expect(productionImportersOfResolver([PROBE_REL], decoyRoot)).toEqual([])
        expect(productionCallSites([PROBE_REL], decoyRoot)).toEqual([])
      },
    )
  })
})

describe('W7-1a structural inertness: the posture table has no production reader or writer', () => {
  it('the ONLY production CODE outside the migration touching the posture table is the single writer (+ its DML classification)', () => {
    // The resolver itself is excluded from `productionFiles()` (it lives under
    // w7-resolver/), which is the point: nothing production-side reaches it.
    //
    // W7-3 amendment — an EXACT set, so any THIRD file naming the table still
    // reds. Two members, each for a different reason:
    //
    //  - the transition writer: this is the whole point of W7-R4's "one writer".
    //    That it is the SOLE DML path is proven mechanically by the collector
    //    census, not by this leg; this leg proves no OTHER module has started
    //    naming the table.
    //  - the DML inventory's table-classification map: names the table as a
    //    BUCKET KEY (`attendance_calculation_context_source_state: 'w4_canonical'`),
    //    which is a classification datum, not a read or a write. Adding it there
    //    is mandatory — an unclassified table is a hard CI failure by design —
    //    and the `stripComments` matcher cannot tell a bucket key from a query,
    //    so it is recorded here explicitly rather than papered over by widening
    //    the matcher.
    expect(postureTableCodeReferences()).toEqual([
      W7_TRANSITION_WRITER,
      'scripts/attendance/w4c0-dml-inventory/table-classification.cjs',
    ])
  })

  it('the only remaining mention of the posture table is PROSE in the W7-0 contract header', () => {
    // Recorded explicitly rather than silently stripped: the landed W7-0
    // contract module does name the table, in a doc comment, to say what shape
    // the row will have. Pinning that here means the comment-stripping above
    // cannot quietly hide a future CODE reference in the same file.
    const contract = 'packages/core-backend/src/attendance/w7-context-source-posture-contract.ts'
    const raw = fs.readFileSync(path.join(REPO_ROOT, contract), 'utf8')
    expect(raw).toContain(POSTURE_TABLE)
    expect(stripComments(raw)).not.toContain(POSTURE_TABLE)
  })

  it('the migration that creates the table exists, ships it EMPTY, and inserts nothing', () => {
    const migration = path.join(
      REPO_ROOT,
      'packages/core-backend/src/db/migrations/zzzz20260814120000_w7_attendance_context_source_posture_state.ts',
    )
    expect(fs.existsSync(migration)).toBe(true)
    const text = fs.readFileSync(migration, 'utf8')
    expect(text).toContain(`CREATE TABLE IF NOT EXISTS ${POSTURE_TABLE}`)
    // No seeding of any kind: an empty table is one of the three legs the
    // inertness claim stands on, so a stray INSERT would silently remove it.
    expect(text).not.toMatch(/INSERT\s+INTO/i)
  })

  it('NEGATIVE CONTROL: a production file naming the posture table reds the leg', () => {
    expect(isProductionSource(PROBE_REL), 'probe path is not production — dead sweep').toBe(true)
    withDecoyTree(
      { [PROBE_REL]: `export const PROBE_SQL = 'SELECT state FROM ${POSTURE_TABLE}'\n` },
      (decoyRoot) => {
        expect(postureTableCodeReferences([PROBE_REL], decoyRoot)).toEqual([PROBE_REL])
      },
    )
  })

  it('NEGATIVE CONTROL on the comment stripper: the SAME table name in a comment does NOT red', () => {
    withDecoyTree(
      { [PROBE_REL]: `/* mentions ${POSTURE_TABLE} in prose */\nexport const X = 1\n` },
      (decoyRoot) => {
        expect(postureTableCodeReferences([PROBE_REL], decoyRoot)).toEqual([])
      },
    )
  })
})

describe('W7-1a structural inertness: the W7 env var is new, unset by default, and not the W4 one', () => {
  it('the W7 allowlist env var is a NEW name, distinct from the W4 segment-calculation one', () => {
    const resolver = fs.readFileSync(
      path.join(REPO_ROOT, W7_RESOLVER_DIR, 'w7-context-source-posture-resolver.ts'),
      'utf8',
    )
    expect(resolver).toContain("'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'")
    // Ruling 7: it must NOT READ the W4 variable. Asked of CODE, not of text:
    // the module's header names the W4 variable deliberately, to record that it
    // is not reused. A raw text ban would red on that sentence and would push
    // the next author to delete the explanation rather than keep the property.
    const code = stripComments(resolver)
    expect(code).toContain("'ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED'")
    expect(code).not.toContain('ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED')
    // ...and the header really does still carry the explanation, so this leg
    // is proven to be stripping prose rather than passing because the prose
    // was removed.
    expect(resolver).toContain('ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED')

    // POSITIVE CONTROL on the stripper itself: it must not eat real code.
    expect(stripComments("const a = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED' // note")).toContain(
      'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED',
    )
    expect(stripComments('/* ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED */')).not.toContain(
      'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED',
    )
  })

  it('nothing in the repo sets the W7 var by default (no CI/env/compose default entry)', () => {
    const setters = trackedFiles()
      .filter((rel) => /\.(ya?ml|env|sh|json|ts|cjs|mjs|js)$/.test(rel))
      .filter((rel) => !rel.includes('/tests/') && !rel.includes('__tests__'))
      .filter((rel) => !rel.startsWith(`${W7_RESOLVER_DIR}/`))
      .filter((rel) => {
        const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')
        return /ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED\s*[:=]/.test(text)
      })
      .sort()
    expect(setters).toEqual([])
  })
})
