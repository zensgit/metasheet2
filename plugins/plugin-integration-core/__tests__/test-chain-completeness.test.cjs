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

/**
 * Matches the way the chain actually invokes a file (`node __tests__/<name>` or
 * `node --import tsx __tests__/<name>`), not a bare substring of the name. A bare `includes(name)`
 * would also be satisfied by the file being mentioned in a comment or in some other script, which
 * would let an unexecuted file count as chained.
 */
function isChained(script, file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`node(?:\\s+--import\\s+tsx)?\\s+__tests__/${escaped}(?:\\s|$|&)`).test(script)
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
  assert.equal(
    isChained('echo __tests__/k3-wise-adapters.test.cjs', 'k3-wise-adapters.test.cjs'),
    false,
    'isChained must require the file to be RUN by node, not merely mentioned',
  )

  console.log(
    `✓ test-chain-completeness: ${files.length} suites, all executed by \`pnpm test\`` +
      ` (${Object.keys(INTENTIONALLY_UNCHAINED).length} intentional exclusions)`,
  )
}

main()
