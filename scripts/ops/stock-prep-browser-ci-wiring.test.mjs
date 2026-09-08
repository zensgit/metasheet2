// 备料工作台 browser-verify lane — THE WIRING CONTRACT.
//
// A browser lane can go vacuously green in three ways, and this file exists to close all three:
//
//   1. THE JOB NAME DRIFTS. `Stock-prep browser verify (chromium)` is a required-context name; a
//      rename silently turns the required check into one that never reports. Pinned literally.
//   2. THE CLASSIFIER STOPS CLASSIFYING. The workflow has no `pull_request.paths` filter on purpose
//      (a filtered required context blocks merge-queue PRs forever), so the in-job classifier is the
//      only thing that decides. It is EXECUTED here against throwaway git fixtures — not read — so a
//      pattern that no longer matches is a failure rather than a comment.
//   3. THE COLLECTION EMPTIES. `testMatch` is a glob; delete one and the lane runs zero tests and
//      reports success. `playwright test --list` is therefore run for real and its collected spec
//      SET must equal the on-disk `stock-prep-*.spec.ts` set exactly — no more, no fewer.
//
// Written as a sibling of `approval-browser-ci-wiring.test.mjs`, deliberately in the same shape: two
// lanes with the same failure modes should be defended by two files a reviewer can diff.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const webRoot = join(repoRoot, 'apps', 'web')
const verificationRoot = join(webRoot, 'verification')
const workflowPath = join(repoRoot, '.github', 'workflows', 'stock-prep-browser-verify.yml')
const stockPrepConfigPath = join(webRoot, 'playwright.stock-prep-verification.config.ts')
const sharedConfigPath = join(webRoot, 'playwright.verification.config.ts')

const JOB_ID = 'browser-verify'
const JOB_NAME = 'Stock-prep browser verify (chromium)'

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
    // `pnpm` is a `.cmd` shim on Windows, which `spawnSync` cannot exec directly (status `null`).
    // Opt in per call rather than globally: the classifier runs `bash -c "<multi-line script>"`,
    // and putting THAT through a Windows shell would mangle it. CI is Linux, where this is false and
    // the invocation is byte-for-byte the approval lane's.
    shell: Boolean(options.shell) && process.platform === 'win32',
  })
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
  return result.stdout
}

function listPlaywrightSpecs(configName) {
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
  for (const line of output.split('\n')) {
    const match = line.match(/›\s+(.+?\.spec\.ts):\d+:\d+\s+›/)
    if (!match) continue
    const listedPath = match[1].trim()
    const verificationIndex = listedPath.lastIndexOf('verification/')
    files.add(verificationIndex >= 0
      ? listedPath.slice(verificationIndex)
      : `verification/${basename(listedPath)}`)
  }
  assert.ok(files.size > 0, `${configName} --list returned no spec files`)
  return [...files].sort()
}

function git(cwd, ...args) {
  return run('git', args, { cwd }).trim()
}

/** Run the workflow's own classifier script against a one-file change, in a throwaway repo. */
function runClassifier(script, eventName, changedPath) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'stock-prep-browser-classifier-'))
  try {
    git(fixtureRoot, 'init', '--quiet')
    git(fixtureRoot, 'config', 'user.name', 'Stock Prep Browser Contract')
    git(fixtureRoot, 'config', 'user.email', 'stock-prep-browser-contract@example.invalid')
    writeFileSync(join(fixtureRoot, 'README.md'), 'base\n')
    git(fixtureRoot, 'add', 'README.md')
    git(fixtureRoot, 'commit', '--quiet', '-m', 'base')
    const baseSha = git(fixtureRoot, 'rev-parse', 'HEAD')

    const changedFile = join(fixtureRoot, ...changedPath.split('/'))
    mkdirSync(dirname(changedFile), { recursive: true })
    writeFileSync(changedFile, 'changed\n')
    git(fixtureRoot, 'add', changedPath)
    git(fixtureRoot, 'commit', '--quiet', '-m', 'change')
    const headSha = git(fixtureRoot, 'rev-parse', 'HEAD')
    const outputPath = join(fixtureRoot, 'github-output.txt')

    run('bash', ['-c', script], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        EVENT_NAME: eventName,
        BASE_SHA: baseSha,
        HEAD_SHA: headSha,
        GITHUB_OUTPUT: outputPath,
      },
    })

    const output = readFileSync(outputPath, 'utf8')
    const relevant = output.match(/^relevant=(true|false)$/m)?.[1]
    assert.ok(relevant, `classifier wrote no relevant output:\n${output}`)
    return relevant === 'true'
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

const allVerificationSpecs = walkFiles(verificationRoot)
  .filter((path) => path.endsWith('.spec.ts'))
  .map(webRelative)
  .sort()
const stockPrepSpecs = allVerificationSpecs.filter((path) => basename(path).startsWith('stock-prep-'))

test('stock-prep workflow creates a stable PR and merge-queue context with a real classifier', () => {
  const source = readFileSync(workflowPath, 'utf8')
  const workflow = yaml.load(source)
  const triggers = workflow.on
  assert.ok(Object.hasOwn(triggers, 'pull_request'), 'workflow must run for every pull request')
  assert.ok(Object.hasOwn(triggers, 'merge_group'), 'workflow must run for merge groups')
  assert.ok(Object.hasOwn(triggers, 'workflow_dispatch'), 'workflow must retain manual verification')
  assert.equal(
    Object.hasOwn(triggers.pull_request ?? {}, 'paths'),
    false,
    'pull_request must not use a top-level paths filter',
  )

  const job = workflow.jobs[JOB_ID]
  assert.equal(job.name, JOB_NAME)
  const checkout = job.steps.find((step) => step.uses === 'actions/checkout@v4')
  assert.equal(checkout?.with?.['fetch-depth'], 0, 'changed-file classification needs full history')

  const classifier = job.steps.find((step) => step.id === 'changes')
  assert.equal(classifier?.name, 'Detect relevant stock-prep changes')
  assert.equal(typeof classifier?.run, 'string')

  const requiredAnchors = [
    'apps/web/src/components/integration/stockPreparation/*',
    'apps/web/src/services/integration/stockPreparation/*',
    'apps/web/src/composables/useAuth.ts',
    'apps/web/src/composables/useLocale.ts',
    'apps/web/src/composables/useMobileViewport.ts',
    'apps/web/src/styles/tokens.css',
    'apps/web/src/utils/api.ts',
    'apps/web/verification/stock-prep-*',
    'apps/web/playwright.stock-prep-verification.config.ts',
    'apps/web/playwright.verification.config.ts',
    'apps/web/vite.config.ts',
    'apps/web/package.json',
    'package.json',
    'pnpm-lock.yaml',
    'plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs',
    'scripts/ops/stock-prep-browser-ci-wiring.test.mjs',
    '.github/workflows/stock-prep-browser-verify.yml',
  ]
  for (const anchor of requiredAnchors) {
    assert.ok(classifier.run.includes(anchor), `classifier must include ${anchor}`)
  }

  // Unrelated changes stay a no-op green — that is what keeps this a stable required context.
  assert.equal(runClassifier(classifier.run, 'pull_request', 'docs/unrelated.md'), false)
  assert.equal(runClassifier(classifier.run, 'pull_request', 'apps/web/src/views/LoginView.vue'), false)

  // ...and every file this lane actually depends on triggers it. The spec/harness/fixture list is
  // read OFF DISK rather than typed, so a file added to this lane cannot be left unguarded.
  const mustTrigger = [
    'apps/web/src/components/integration/stockPreparation/StockPreparationWorkspace.vue',
    'apps/web/src/components/integration/stockPreparation/StockPreparationRail.vue',
    'apps/web/src/services/integration/stockPreparation/workbenchAccess.ts',
    'apps/web/playwright.stock-prep-verification.config.ts',
    'apps/web/playwright.verification.config.ts',
    'plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs',
    'scripts/ops/stock-prep-browser-ci-wiring.test.mjs',
    '.github/workflows/stock-prep-browser-verify.yml',
    'apps/web/verification/stock-prep-workbench-harness.ts',
    'apps/web/verification/stock-prep-workbench-harness.html',
    'apps/web/verification/stock-prep-fixtures.ts',
    ...stockPrepSpecs.map((spec) => `apps/web/${spec}`),
  ]
  for (const path of mustTrigger) {
    assert.equal(
      runClassifier(classifier.run, 'pull_request', path),
      true,
      `${path} must trigger stock-prep browser verification`,
    )
  }
  assert.equal(
    runClassifier(classifier.run, 'merge_group', `apps/web/${stockPrepSpecs[0]}`),
    true,
    'merge_group must classify an on-disk stock-prep spec as relevant',
  )
  assert.equal(runClassifier(classifier.run, 'workflow_dispatch', 'docs/unrelated.md'), true)

  const report = job.steps.find((step) => step.name === 'Report success for unrelated changes')
  assert.equal(report?.if, "steps.changes.outputs.relevant == 'false'")
  const wiring = job.steps.find((step) => step.name === 'Verify stock-prep browser CI ownership and collection')
  assert.equal(wiring?.run, 'node --test scripts/ops/stock-prep-browser-ci-wiring.test.mjs')
  assert.equal(wiring?.if, "steps.changes.outputs.relevant == 'true'")

  for (const name of [
    'Setup Node.js 20.x',
    'Setup pnpm',
    'Use empty npmrc for pnpm',
    'Get pnpm store directory',
    'Setup pnpm cache',
    'Install dependencies',
    'Install Playwright chromium (+ system deps)',
    'Run stock-prep browser verification (boots Vite, renders the real workbench)',
  ]) {
    const step = job.steps.find((candidate) => candidate.name === name)
    assert.equal(step?.if, "steps.changes.outputs.relevant == 'true'", `${name} must be classifier-gated`)
  }
})

test('the stock-prep lane collects exactly the on-disk stock-prep specs, and the shared lane collects none of them', () => {
  const stockPrepConfig = readFileSync(stockPrepConfigPath, 'utf8')
  const sharedConfig = readFileSync(sharedConfigPath, 'utf8')
  assert.match(stockPrepConfig, /testMatch:\s*\[\s*['"]\*\*\/stock-prep-\*\.spec\.ts['"]\s*\]/)
  assert.match(sharedConfig, /testIgnore:\s*\[[^\]]*['"]\*\*\/stock-prep-\*\.spec\.ts['"][^\]]*\]/)

  // A lane owning zero specs is the vacuous green this whole file exists to prevent.
  assert.ok(stockPrepSpecs.length >= 2, `expected both acceptance specs on disk, found ${stockPrepSpecs.length}`)
  assert.deepEqual(
    listPlaywrightSpecs('playwright.stock-prep-verification.config.ts'),
    stockPrepSpecs,
    'stock-prep lane --list must equal every on-disk stock-prep spec',
  )
  assert.deepEqual(
    listPlaywrightSpecs('playwright.verification.config.ts').filter((path) => basename(path).startsWith('stock-prep-')),
    [],
    'the shared lane must collect zero stock-prep specs',
  )
})

test('the stock-prep lane owns its own port and its own harness entry point', () => {
  const stockPrepConfig = readFileSync(stockPrepConfigPath, 'utf8')
  const sharedConfig = readFileSync(sharedConfigPath, 'utf8')
  const approvalConfig = readFileSync(join(webRoot, 'playwright.approval-verification.config.ts'), 'utf8')

  const portOf = (source) => Number(/const PORT = (\d+)/.exec(source)?.[1])
  const stockPrepPort = portOf(stockPrepConfig)
  assert.ok(Number.isInteger(stockPrepPort), 'stock-prep config must declare a literal PORT')
  // 「自己的服务器,不是捡来的」: three lanes, three ports, `--strictPort` so a collision fails loudly
  // instead of silently sharing somebody else's dev server.
  assert.notEqual(stockPrepPort, portOf(sharedConfig))
  assert.notEqual(stockPrepPort, portOf(approvalConfig))
  assert.match(stockPrepConfig, /--strictPort/)
  assert.match(stockPrepConfig, /verification\/stock-prep-workbench-harness\.html/)

  // The harness the webServer waits on has to be the one the specs open.
  const harness = readFileSync(join(verificationRoot, 'stock-prep-workbench-harness.html'), 'utf8')
  assert.match(harness, /stock-prep-workbench-harness\.ts/)
})

test('the fixtures refuse an unmocked route instead of falling through to the dev-server proxy', () => {
  const fixtures = readFileSync(join(verificationRoot, 'stock-prep-fixtures.ts'), 'utf8')
  assert.match(fixtures, /VERIFY_UNMOCKED_ROUTE/)
  assert.match(fixtures, /page\.route\('\*\*\/api\/\*\*'/)
  // values-free: the fixture vocabulary is synthetic, and every spec asserts against THESE strings.
  assert.match(fixtures, /SYN_PROJECT_A = 'SYN-PROJ-0001'/)

  // Both specs must actually consult `unmocked` — a log nobody reads is not a tripwire.
  for (const spec of stockPrepSpecs) {
    const source = readFileSync(join(webRoot, spec), 'utf8')
    assert.ok(
      source.includes('expectNoUnmockedRoutes'),
      `${spec} must assert that no route went unmocked`,
    )
  }
})
