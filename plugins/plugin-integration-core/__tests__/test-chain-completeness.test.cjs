/**
 * Chain-completeness guard for `plugin-integration-core`.
 *
 * The CJS suites here are gated by `integration-guard` via ONE mechanism: each file is named
 * explicitly in `package.json`'s `scripts.test` `&&` chain. There is no glob runner. So a test
 * file that is never added to that chain is **never executed by anything** — it passes locally,
 * it looks like coverage in the directory listing, and it protects nothing.
 *
 * That is not hypothetical. Three files sat unreferenced from the day they were committed:
 *   - `k3-df-t1-target-payload-preview.test.cjs`      (#4665, 2026-07-28)
 *   - `k3-save-body-composer.parity.test.cjs`         (#4665, 2026-07-28)
 *   - `k3-wise-material-presets.test.cjs`             (#4761, 2026-08-05)
 * `git log -S` over `package.json` shows they were never referenced at any point. The middle one
 * asserts `preview ≡ adapter Save` — a K3 WRITE-path parity gate that was silently inert.
 *
 * Enumerating "the tests we remember to add" does not converge; the deliverable is therefore this
 * assertion, not the one-time repair. It walks the directory (the exhaustive set) and requires
 * every entry to appear in the chain — so the NEXT unreferenced file is caught mechanically, and
 * omitting one becomes a visible, reviewable edit to this file rather than silence.
 *
 * Deliberate escape hatch, deliberately narrow: a file may be excluded only by naming it in
 * `INTENTIONALLY_UNCHAINED` WITH a reason. That list is itself checked for staleness (an entry
 * naming a file that no longer exists, or one that IS chained, fails) so it cannot rot into a
 * blanket amnesty.
 */
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const TESTS_DIR = __dirname
const PACKAGE_JSON = path.join(__dirname, '..', 'package.json')

/**
 * `{ file: reason }`. Empty on purpose: at the time of writing every suite in this directory is
 * chained. Adding an entry is an explicit, reviewable act — which is the point.
 */
const INTENTIONALLY_UNCHAINED = Object.freeze({})

function listTestFiles() {
  return fs
    .readdirSync(TESTS_DIR)
    .filter((f) => /\.test\.(cjs|mjs)$/.test(f))
    .sort()
}

function chainScript() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'))
  assert.equal(typeof pkg.scripts.test, 'string', 'package.json scripts.test must exist')
  return pkg.scripts.test
}

/** The chain is `cmd && cmd && …`; each segment is one command that either runs or does not. */
function chainSegments(script) {
  return script.split('&&').map((segment) => segment.trim())
}

/**
 * Whether the chain CONTAINS A COMMAND THAT RUNS this file — decided by exact equality against a
 * whole `&&` segment, never by searching the script for a substring.
 *
 * The substring form this replaces was reported green for a suite that does not run (owner review,
 * #4801 P1). It searched for `node __tests__/<file>` anywhere in the script, so prefixing the real
 * command turned execution off while the guard kept counting it:
 *
 *     node __tests__/x.test.cjs       ->  echo node __tests__/x.test.cjs      (prints, runs nothing)
 *                                     ->  xnode __tests__/x.test.cjs          (different binary)
 *
 * Both still contained the searched-for text. Reproduced end to end: with the `echo` prefix and the
 * routine `runtimeFiles.pluginPackageJson` re-pin, `pnpm test` exits 0, the suite never runs, and
 * this guard printed "161 suites, all executed". The digest pin cannot separate that from a
 * legitimate re-pin, so the guard was the only thing standing there — and it was not standing.
 *
 * Segment-exact equality has no such gap: `echo node …` and `xnode …` are simply not equal to
 * `node __tests__/<file>`. Trailing junk (`… || true`, `… ; echo ok`) also fails equality — which
 * is intended, since those change whether a failure stops the chain. Every one of the 161 current
 * segments already has this exact shape, so the tightening excludes nothing that runs today.
 */
function isChained(script, file) {
  return chainSegments(script).some((segment) => segment === `node __tests__/${file}` || segment === `node --import tsx __tests__/${file}`)
}

function main() {
  const files = listTestFiles()
  const script = chainScript()

  // Negative control on the walker itself: if the directory scan silently returned nothing (wrong
  // path, changed extension convention), every assertion below would vacuously pass.
  assert.ok(files.length > 100, `expected the suite directory to be populated, saw ${files.length}`)
  assert.ok(
    files.includes('test-chain-completeness.test.cjs'),
    'the walker must see this very file, otherwise it is scanning the wrong directory',
  )

  const unchained = files.filter((f) => !isChained(script, f) && !(f in INTENTIONALLY_UNCHAINED))
  assert.deepEqual(
    unchained,
    [],
    `these suites exist but are never executed by \`pnpm test\` (add them to package.json ` +
      `scripts.test, or list them in INTENTIONALLY_UNCHAINED with a reason): ${unchained.join(', ')}`,
  )

  // The exclusion list must not rot: every entry has to name a file that still exists AND is still
  // genuinely unchained. Without this, a stale entry would keep granting amnesty to a name that
  // has since come back into the chain — or to nothing at all.
  for (const [file, reason] of Object.entries(INTENTIONALLY_UNCHAINED)) {
    assert.ok(files.includes(file), `INTENTIONALLY_UNCHAINED names a file that does not exist: ${file}`)
    assert.ok(
      typeof reason === 'string' && reason.trim().length > 0,
      `INTENTIONALLY_UNCHAINED[${file}] must carry a non-empty reason`,
    )
    assert.ok(
      !isChained(script, file),
      `INTENTIONALLY_UNCHAINED[${file}] is stale — the file IS in the chain; remove the entry`,
    )
  }

  // Positive control for `isChained` itself. A matcher that returned `true` unconditionally would
  // make the whole guard vacuous, and a matcher that returned `false` unconditionally would be
  // caught by the deepEqual above — so pin both directions against known answers.
  assert.equal(isChained(script, 'k3-wise-adapters.test.cjs'), true, 'isChained must find a chained file')
  assert.equal(
    isChained(script, 'definitely-not-a-real-suite.test.cjs'),
    false,
    'isChained must not report an absent file as chained',
  )
  // Both `&&` forms in use must be recognised, or every `--import tsx` suite would be reported as
  // unchained the moment a second one is added.
  assert.equal(isChained(script, 'host-loader-smoke.test.mjs'), true, 'isChained must accept the `--import tsx` form')

  // NEGATIVE CONTROLS FOR THE DISABLING EDITS (#4801 P1). Each is applied to the REAL `scripts.test`,
  // not to a hand-written string: the earlier version of this block tested a literal, and a literal
  // cannot exhibit the failure, which is why the substring matcher shipped with a control in place.
  const VICTIM = 'k3-wise-material-presets.test.cjs'
  const realCommand = `node __tests__/${VICTIM}`
  assert.ok(script.includes(realCommand), `expected the chain to contain ${realCommand} to mutate`)
  for (const disabled of [
    `echo ${realCommand}`, //            prints the command, runs nothing
    `x${realCommand}`, //                a different binary that happens to contain "node …"
    `${realCommand} || true`, //         runs, but a failure no longer stops the chain
    `# ${realCommand}`, //               commented out
  ]) {
    assert.equal(
      isChained(script.replace(realCommand, disabled), VICTIM),
      false,
      `isChained must report NOT-executed for \`${disabled}\` — it still contains the text ` +
        `"${realCommand}", which is exactly how the substring matcher reported a disabled suite as run`,
    )
  }

  console.log(
    `✓ test-chain-completeness: ${files.length} suites, all executed by \`pnpm test\`` +
      ` (${Object.keys(INTENTIONALLY_UNCHAINED).length} intentional exclusions)`,
  )
}

main()
