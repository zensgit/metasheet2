// Tasks acceptance-walk browser lane — THE WIRING CONTRACT.
//
// The walk (apps/web/verification/tasks-acceptance-walk*, playwright.tasks-verification.config.ts)
// runs inside tasks-web-guard.yml. A browser lane can go green without having walked anything, and
// each of the ways it can is pinned here:
//
//   1. THE COLLECTION MOVES. `testMatch` is a glob; change it and the lane runs other specs, or none.
//      `playwright test --list` is run for real, and its spec set must equal the on-disk
//      `verification/tasks-*.spec.ts` set exactly, while the shared lane collects none of them.
//   2. A RETRY HIDES A FLAKE. The walk counts only if every test passes on its first try, so the
//      config's `retries` is pinned to the literal 0.
//   3. A STEP IS DROPPED. The type-check of tsconfig.verification-tasks.json, the walk run (with no
//      file argument, so it takes every spec the config collects), the check step that fails unless
//      exactly `EXPECTED` tests ran and passed, and the screenshot upload are each pinned. `EXPECTED`
//      must equal the number of tests `--list` reports, so a test added or removed without updating
//      it is a red here rather than a red the check step only shows after a full walk.
//   4. THE LANE STOPS RUNNING. tasks-web-guard.yml has `paths` filters; both lists must name this
//      file and the lane's own inputs.
//
// Written as a sibling of stock-prep-browser-ci-wiring.test.mjs, in the same shape, minus what does
// not apply: this lane is path-filtered, not a required context with an in-job classifier, so there
// is no classifier to execute.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const webRoot = join(repoRoot, 'apps', 'web')
const verificationRoot = join(webRoot, 'verification')
const workflowPath = join(repoRoot, '.github', 'workflows', 'tasks-web-guard.yml')
const tasksConfigName = 'playwright.tasks-verification.config.ts'
const tasksConfigPath = join(webRoot, tasksConfigName)
const sharedConfigPath = join(webRoot, 'playwright.verification.config.ts')

const JOB_ID = 'tasks-web-guard'
const WIRING_RUN = 'node --test scripts/ops/tasks-browser-ci-wiring.test.mjs'
const TYPE_CHECK_RUN = 'pnpm --filter @metasheet/web exec vue-tsc --noEmit -p tsconfig.verification-tasks.json'
const WALK_RUN = `pnpm --filter @metasheet/web exec playwright test --config ${tasksConfigName} --reporter=list,json`
const REPORT_PATH = 'apps/web/verification-output/tasks-walk-report.json'

function walkFiles(root) {
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function webRelative(path) {
  return relative(webRoot, path).split(sep).join('/')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    // `pnpm` is a `.cmd` shim on Windows, which `spawnSync` cannot exec directly. CI is Linux, where
    // this is false.
    shell: Boolean(options.shell) && process.platform === 'win32',
  })
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  return result.stdout
}

const LISTED_TEST = /›\s+(.+?\.spec\.ts):\d+:\d+\s+›/

const listings = new Map()

/** `playwright test --list` for one config: the spec files it collects and the number of tests. Run
 *  once per config and reused. */
function listPlaywright(configName) {
  if (!listings.has(configName)) listings.set(configName, readPlaywrightListing(configName))
  return listings.get(configName)
}

function readPlaywrightListing(configName) {
  const output = run('pnpm', [
    '--filter',
    '@metasheet/web',
    'exec',
    'playwright',
    'test',
    '--config',
    configName,
    '--list',
  ], {
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
    shell: true,
  })

  const files = new Set()
  let tests = 0
  for (const line of output.split('\n')) {
    const match = line.match(LISTED_TEST)
    if (!match) continue
    tests += 1
    const listedPath = match[1].trim()
    const verificationIndex = listedPath.lastIndexOf('verification/')
    files.add(verificationIndex >= 0
      ? listedPath.slice(verificationIndex)
      : `verification/${basename(listedPath)}`)
  }
  assert.ok(files.size > 0, `${configName} --list returned no spec files`)
  // Playwright's own summary line, as a second count of the same thing.
  const total = /^Total: (\d+) tests?\b/m.exec(output)
  assert.ok(total, `${configName} --list printed no "Total:" line:\n${output}`)
  assert.equal(Number(total[1]), tests, `${configName} --list: the "Total:" line disagrees with the listed tests`)
  return { files: [...files].sort(), tests }
}

const allVerificationSpecs = walkFiles(verificationRoot)
  .filter((path) => path.endsWith('.spec.ts'))
  .map(webRelative)
  .sort()
const tasksSpecs = allVerificationSpecs.filter((path) => basename(path).startsWith('tasks-'))

function loadJob() {
  const workflow = yaml.load(readFileSync(workflowPath, 'utf8'))
  const job = workflow.jobs?.[JOB_ID]
  assert.ok(job, `tasks-web-guard.yml must have the job ${JOB_ID}`)
  return { workflow, job, steps: job.steps ?? [] }
}

function stepNamed(steps, name) {
  const step = steps.find((candidate) => candidate.name === name)
  assert.ok(step, `tasks-web-guard.yml must have the step "${name}"`)
  return step
}

test('the tasks lane collects exactly the on-disk tasks specs, and the shared lane collects none of them', () => {
  const tasksConfig = readFileSync(tasksConfigPath, 'utf8')
  const sharedConfig = readFileSync(sharedConfigPath, 'utf8')
  assert.match(tasksConfig, /testDir:\s*['"]\.\/verification['"]/)
  assert.match(tasksConfig, /testMatch:\s*\[\s*['"]\*\*\/tasks-\*\.spec\.ts['"]\s*\]/)
  assert.doesNotMatch(tasksConfig, /testIgnore:/, 'the tasks lane must not narrow its own collection')
  assert.match(sharedConfig, /testIgnore:\s*\[[^\]]*['"]\*\*\/tasks-\*\.spec\.ts['"][^\]]*\]/)

  // A lane owning zero specs is a green that walked nothing.
  assert.ok(tasksSpecs.length >= 1, 'expected the acceptance walk spec on disk')
  assert.deepEqual(
    listPlaywright(tasksConfigName).files,
    tasksSpecs,
    'tasks lane --list must equal every on-disk verification/tasks-*.spec.ts',
  )
  assert.deepEqual(
    listPlaywright('playwright.verification.config.ts').files.filter((path) => basename(path).startsWith('tasks-')),
    [],
    'the shared lane must collect zero tasks specs',
  )
})

test('the tasks lane has no retries, its own port and its own harness', () => {
  const tasksConfig = readFileSync(tasksConfigPath, 'utf8')
  const retries = [...tasksConfig.matchAll(/^\s*retries:\s*(.+?),?\s*$/gm)].map((match) => match[1])
  assert.deepEqual(retries, ['0'], 'the tasks lane must declare `retries: 0`, as a literal, exactly once')

  const port = Number(/const PORT = (\d+)/.exec(tasksConfig)?.[1])
  assert.ok(Number.isInteger(port), 'the tasks config must declare a literal PORT')
  assert.notEqual(port, Number(/const PORT = (\d+)/.exec(readFileSync(sharedConfigPath, 'utf8'))?.[1]))
  assert.match(tasksConfig, /--strictPort/)
  assert.match(tasksConfig, /url: `http:\/\/127\.0\.0\.1:\$\{PORT\}\/verification\/tasks-acceptance-walk-harness\.html`/)
  assert.match(
    readFileSync(join(verificationRoot, 'tasks-acceptance-walk-harness.html'), 'utf8'),
    /tasks-acceptance-walk-harness\.ts/,
  )
})

test('the harness overlay breakpoint is the workbench one', () => {
  // The harness copies MultitableWorkbench's narrow-screen breakpoint (not exported); a change on the
  // workbench side would otherwise leave the harness laying the drawer out by an old rule.
  const workbench = readFileSync(join(webRoot, 'src', 'multitable', 'views', 'MultitableWorkbench.vue'), 'utf8')
  const harness = readFileSync(join(verificationRoot, 'tasks-acceptance-walk-harness.ts'), 'utf8')
  const workbenchValue = /const RAIL_NARROW_BREAKPOINT = (\d+)/.exec(workbench)?.[1]
  const harnessValue = /const NARROW_BREAKPOINT = (\d+)/.exec(harness)?.[1]
  assert.ok(workbenchValue, 'MultitableWorkbench.vue must declare RAIL_NARROW_BREAKPOINT as a literal')
  assert.equal(harnessValue, workbenchValue)
  assert.match(workbench, /window\.innerWidth <= RAIL_NARROW_BREAKPOINT/)
  assert.match(harness, /window\.innerWidth <= NARROW_BREAKPOINT/)
})

test('tasks-web-guard.yml type-checks, walks every collected test, checks the count and uploads the screenshots', () => {
  const { steps } = loadJob()
  const names = steps.map((step) => step.name)

  const install = names.indexOf('Install Playwright chromium (+ system deps)')
  assert.ok(install >= 0, 'the Playwright chromium install step must exist')
  const wiring = stepNamed(steps, 'Verify the tasks walk\'s CI wiring')
  assert.equal(steps.indexOf(wiring), install + 1, 'this test must run right after the chromium install')
  assert.equal(wiring.run, WIRING_RUN)

  const typeCheck = stepNamed(steps, 'Type-check the tasks verification harnesses')
  assert.equal(typeCheck.run, TYPE_CHECK_RUN)
  const tsconfig = readFileSync(join(webRoot, 'tsconfig.verification-tasks.json'), 'utf8')
  for (const pattern of [
    'verification/tasks-*-harness.ts',
    'verification/tasks-*-fixtures.ts',
    'verification/tasks-*.spec.ts',
  ]) {
    assert.ok(tsconfig.includes(pattern), `tsconfig.verification-tasks.json must include ${pattern}`)
  }

  const walk = steps.find((step) => step.id === 'walk')
  assert.ok(walk, 'the walk step must keep `id: walk` (the upload conditions read its outcome)')
  // Exactly this command: no file argument, so the run takes every spec the config collects.
  assert.equal(walk.run, WALK_RUN)
  assert.doesNotMatch(walk.run, /\.spec\.ts|\s-g\s|--grep|--last-failed|--only-changed/)
  assert.equal(walk.env?.PLAYWRIGHT_JSON_OUTPUT_NAME, `\${{ github.workspace }}/${REPORT_PATH}`)

  const check = stepNamed(steps, 'Check the acceptance walk ran every test and all passed')
  assert.equal(steps.indexOf(check), steps.indexOf(walk) + 1, 'the check step must follow the walk')
  assert.equal(typeof check.run, 'string')
  assert.ok(check.run.includes(`fs.readFileSync('${REPORT_PATH}', 'utf8')`), 'the check step must read the walk\'s report')
  const expected = /const EXPECTED = (\d+)\n/.exec(check.run)?.[1]
  assert.ok(expected, 'the check step must declare `const EXPECTED = <number>`')
  assert.equal(
    Number(expected),
    listPlaywright(tasksConfigName).tests,
    'EXPECTED in the check step must equal the number of tests the tasks lane collects',
  )

  for (const step of [wiring, typeCheck, walk, check]) {
    assert.equal(Object.hasOwn(step, 'if'), false, `${step.name} must run unconditionally`)
    assert.equal(Object.hasOwn(step, 'continue-on-error'), false, `${step.name} must not carry continue-on-error`)
  }
  assert.ok(steps.indexOf(typeCheck) < steps.indexOf(walk), 'the type-check must run before the walk')

  const upload = stepNamed(steps, 'Upload the acceptance walk screenshots')
  assert.equal(upload.uses, 'actions/upload-artifact@v4')
  assert.equal(upload.if, "always() && steps.walk.outcome != 'skipped'")
  assert.equal(upload.with?.name, 'tasks-walk-screenshots')
  assert.equal(upload.with?.path, 'apps/web/verification-output/tu-*.png')
  assert.equal(upload.with?.['if-no-files-found'], "${{ steps.walk.outcome == 'success' && 'error' || 'warn' }}")
})

test('both paths lists of tasks-web-guard.yml name the walk\'s inputs and this file', () => {
  const { workflow } = loadJob()
  const pullRequestPaths = workflow.on?.pull_request?.paths
  const pushPaths = workflow.on?.push?.paths
  assert.ok(Array.isArray(pullRequestPaths) && Array.isArray(pushPaths), 'both triggers must keep a paths list')
  assert.deepEqual(pushPaths, pullRequestPaths, 'the push and pull_request paths lists must be the same')
  for (const path of [
    'apps/web/verification/tasks-*',
    'apps/web/playwright.tasks-verification.config.ts',
    'apps/web/playwright.verification.config.ts',
    'apps/web/tsconfig.verification-tasks.json',
    'scripts/ops/tasks-browser-ci-wiring.test.mjs',
    '.github/workflows/tasks-web-guard.yml',
    'apps/web/src/multitable/components/MetaRecordTaskDispatchDialog.vue',
    'apps/web/src/multitable/components/MetaRecordInspector.vue',
    'apps/web/src/multitable/views/MultitableWorkbench.vue',
    'apps/web/src/multitable/ui/**',
    'apps/web/src/stores/featureFlags.ts',
    'apps/web/src/composables/useAuth.ts',
    'apps/web/src/composables/useLocale.ts',
    'apps/web/src/utils/api.ts',
  ]) {
    assert.ok(pullRequestPaths.includes(path), `tasks-web-guard.yml paths must include ${path}`)
  }
})
