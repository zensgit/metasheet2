// 备料工作台 browser-verify lane — THE WIRING CONTRACT.
//
// A browser lane can go vacuously green in four ways, and this file exists to close all four:
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
//   4. THE CLASSIFIER STOPS COVERING. This is the failure mode a hand-written `mustTrigger` array
//      cannot see, and it is the one that actually bit: `classifier.run.includes(anchor)` only ever
//      proves 「已列的没被删」, never 「新长出来的依赖进了清单」. A file the lane READS but the
//      classifier does not match produces a `no relevant changes` green on the PR that breaks it and
//      a red on the next, unrelated stock-prep PR — the exact delayed, misattributed failure the
//      no-paths-filter design was chosen to avoid, one layer up from `testMatch`.
//
//      So the two coverage sets below are DERIVED, not typed:
//        * `harnessImportClosure()` walks the real relative-import graph from the harness and the
//          fixtures (through `.ts` and `.vue`, transitively) — everything the browser actually
//          evaluates.
//        * `specReadPaths()` extracts every `join(REPO_ROOT|WEB_ROOT, …)` literal the two specs read
//          off disk — P0-10 / P0-11 / P1-02 / P1-07 assert against FILE CONTENT, so those files are
//          lane inputs exactly as much as an imported module is.
//      Every member of both sets is then fed to the real classifier. Growing a dependency without
//      declaring it is a failing test.
//
//      Known LIMIT, stated rather than implied: the walker follows literal relative specifiers. A
//      dynamic `import(someVariable)` would escape it, so the closure is a lower bound. It is not a
//      lower bound anybody can quietly shrink — the walker starts from the two entry points the
//      config itself names.
//
// Written as a sibling of `approval-browser-ci-wiring.test.mjs`, deliberately in the same shape: two
// lanes with the same failure modes should be defended by two files a reviewer can diff.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
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

/** The two files the playwright config and the harness HTML name as this lane's entry points. */
const CLOSURE_ENTRY_POINTS = [
  join(verificationRoot, 'stock-prep-workbench-harness.ts'),
  join(verificationRoot, 'stock-prep-fixtures.ts'),
]

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

function repoRelative(path) {
  return relative(repoRoot, path).split(sep).join('/')
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

/**
 * One throwaway git repo, reused for MANY classifier questions.
 *
 * The classifier is executed, never read — but executing it once per path used to mean a fresh
 * `git init` + two commits per path, and the derived coverage sets below ask ~70 questions. So the
 * repo is created once and each question appends ONE commit; `BASE_SHA` is the previous commit, so
 * `git diff --name-only BASE HEAD` still names exactly the one file under test. Nothing about the
 * script's own semantics changes — it is the same `bash -c` invocation, on the same shape of diff.
 */
function openClassifierSession(script) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'stock-prep-browser-classifier-'))
  git(fixtureRoot, 'init', '--quiet')
  git(fixtureRoot, 'config', 'user.name', 'Stock Prep Browser Contract')
  git(fixtureRoot, 'config', 'user.email', 'stock-prep-browser-contract@example.invalid')
  writeFileSync(join(fixtureRoot, 'README.md'), 'base\n')
  git(fixtureRoot, 'add', 'README.md')
  git(fixtureRoot, 'commit', '--quiet', '-m', 'base')
  let baseSha = git(fixtureRoot, 'rev-parse', 'HEAD')
  const outputPath = join(fixtureRoot, 'github-output.txt')
  let revision = 0

  return {
    /** Run the workflow's own classifier script against a one-file change. */
    relevant(eventName, changedPath) {
      revision += 1
      const changedFile = join(fixtureRoot, ...changedPath.split('/'))
      mkdirSync(dirname(changedFile), { recursive: true })
      writeFileSync(changedFile, `changed ${revision}\n`)
      git(fixtureRoot, 'add', '--', changedPath)
      git(fixtureRoot, 'commit', '--quiet', '-m', `change ${revision}`)
      const headSha = git(fixtureRoot, 'rev-parse', 'HEAD')

      rmSync(outputPath, { force: true })
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
      baseSha = headSha

      const output = readFileSync(outputPath, 'utf8')
      const relevant = output.match(/^relevant=(true|false)$/m)?.[1]
      assert.ok(relevant, `classifier wrote no relevant output:\n${output}`)
      return relevant === 'true'
    },
    close() {
      rmSync(fixtureRoot, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// The two DERIVED coverage sets
// ---------------------------------------------------------------------------

const CLOSURE_EXTENSIONS = ['', '.ts', '.tsx', '.vue', '.js', '.mjs', '.json', '.css', '/index.ts', '/index.js']
const IMPORT_SPECIFIER = /(?:import|export)\s[^'"()]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g

function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(fromFile), specifier)
  for (const extension of CLOSURE_EXTENSIONS) {
    const candidate = base + extension
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/**
 * Every file the harness and the fixtures reach through literal relative imports, transitively.
 *
 * This is the set of production sources whose behaviour the lane's assertions depend on. A `.css`
 * file is a leaf (the harness imports `tokens.css`, whose resolved values two P1 assertions read).
 * A specifier that cannot be resolved is a hard failure, not a skip: silently dropping one would
 * silently shrink the closure, which is the same drift this whole test is about.
 */
function harnessImportClosure() {
  const seen = new Set()
  const queue = [...CLOSURE_ENTRY_POINTS]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    if (file.endsWith('.css') || file.endsWith('.json')) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3]
      if (!specifier || !specifier.startsWith('.')) continue
      const resolved = resolveRelativeImport(file, specifier)
      assert.ok(resolved, `${repoRelative(file)} imports '${specifier}', which resolves to nothing`)
      queue.push(resolved)
    }
  }
  return [...seen].map(repoRelative).sort()
}

const SPEC_DISK_READ = /join\(\s*(REPO_ROOT|WEB_ROOT)\s*,\s*((?:'[^']*'\s*,\s*)*'[^']*')\s*\)/g

/**
 * Every path the two specs read off disk with `join(REPO_ROOT|WEB_ROOT, …)`.
 *
 * P0-10 and P1-07 assert against the CONTENT of two jsdom suites; P0-11 scans the whole 备料
 * component directory; P1-02 reads the web gate and its plugin-side mirror. Those files are lane
 * inputs in the strongest possible sense — an assertion quotes them — so the classifier owes them
 * the same coverage it owes an imported module. A directory gets a probe file appended, because the
 * classifier answers questions about files.
 */
function specReadPaths(specFiles) {
  const paths = new Set()
  for (const spec of specFiles) {
    const source = readFileSync(join(webRoot, spec), 'utf8')
    for (const match of source.matchAll(SPEC_DISK_READ)) {
      const root = match[1] === 'REPO_ROOT' ? repoRoot : webRoot
      const segments = match[2].split(',').map((part) => part.trim().replace(/^'|'$/g, ''))
      const absolute = join(root, ...segments)
      const isDirectory = existsSync(absolute) && statSync(absolute).isDirectory()
      paths.add(repoRelative(isDirectory ? join(absolute, 'AnyNewFile.vue') : absolute))
    }
  }
  return [...paths].sort()
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
  // A merge-queue run that another run can cancel is a required check that never reports.
  assert.equal(
    String(workflow.concurrency?.['cancel-in-progress'] ?? ''),
    "${{ github.event_name == 'pull_request' }}",
    'only pull_request runs may be superseded',
  )

  const job = workflow.jobs[JOB_ID]
  assert.equal(job.name, JOB_NAME)
  const checkout = job.steps.find((step) => step.uses === 'actions/checkout@v4')
  assert.equal(checkout?.with?.['fetch-depth'], 0, 'changed-file classification needs full history')

  const classifier = job.steps.find((step) => step.id === 'changes')
  assert.equal(classifier?.name, 'Detect relevant stock-prep changes')
  assert.equal(typeof classifier?.run, 'string')

  const session = openClassifierSession(classifier.run)
  try {
    // Unrelated changes stay a no-op green — that is what keeps this a stable required context.
    assert.equal(session.relevant('pull_request', 'docs/unrelated.md'), false)
    assert.equal(session.relevant('pull_request', 'apps/web/src/views/LoginView.vue'), false)

    // ---- COVERAGE, DERIVED. Both sets are computed from the lane's own files (see the header), so
    //      the only way to keep this green is to declare a new dependency in the classifier.
    const closure = harnessImportClosure()
    assert.ok(
      closure.length >= 60,
      `the harness import closure collapsed to ${closure.length} files — the walker or an entry point moved`,
    )
    for (const entry of CLOSURE_ENTRY_POINTS) {
      assert.ok(closure.includes(repoRelative(entry)), `${repoRelative(entry)} must be in its own closure`)
    }
    // Spot-check that the walk really reaches production code through the dynamic imports the
    // harness uses, rather than stopping at the two entry files.
    for (const anchor of [
      'apps/web/src/components/integration/stockPreparation/StockPreparationWorkspace.vue',
      'apps/web/src/services/integration/stockPreparation/workbenchAccess.ts',
      'apps/web/src/styles/tokens.css',
    ]) {
      assert.ok(closure.includes(anchor), `import closure must reach ${anchor}`)
    }

    const readPaths = specReadPaths(stockPrepSpecs)
    assert.ok(readPaths.length >= 4, `expected the specs' on-disk reads, found ${readPaths.length}`)

    const derived = [...new Set([...closure, ...readPaths])].sort()
    const uncovered = derived.filter((path) => !session.relevant('pull_request', path))
    assert.deepEqual(
      uncovered,
      [],
      'these files are read or imported by the lane but do not trigger it — add them to the '
        + `workflow's case list:\n${uncovered.join('\n')}`,
    )

    // ...plus the wiring that no import graph can name: the workflow, this guard, the configs, the
    // plugin-side mirror, and the harness HTML.
    const mustTrigger = [
      'apps/web/playwright.stock-prep-verification.config.ts',
      'apps/web/playwright.verification.config.ts',
      'apps/web/vite.config.ts',
      'apps/web/package.json',
      'apps/web/tsconfig.verification-stock-prep.json',
      'package.json',
      'pnpm-lock.yaml',
      'plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs',
      'scripts/ops/stock-prep-browser-ci-wiring.test.mjs',
      '.github/workflows/stock-prep-browser-verify.yml',
      'apps/web/verification/stock-prep-workbench-harness.html',
      ...stockPrepSpecs.map((spec) => `apps/web/${spec}`),
    ]
    for (const path of mustTrigger) {
      assert.equal(
        session.relevant('pull_request', path),
        true,
        `${path} must trigger stock-prep browser verification`,
      )
    }
    assert.equal(
      session.relevant('merge_group', `apps/web/${stockPrepSpecs[0]}`),
      true,
      'merge_group must classify an on-disk stock-prep spec as relevant',
    )
    assert.equal(session.relevant('workflow_dispatch', 'docs/unrelated.md'), true)
  } finally {
    session.close()
  }

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
    'Cache Playwright browsers',
    'Install Playwright chromium (+ system deps)',
    'Type-check the stock-prep verification sources',
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

test('the verification sources this lane owns are inside a type-check project', () => {
  // verification/ is outside tsconfig.app.json's `include` (`src/**`), so `vue-tsc -b` cannot see
  // it. Without this project the harness could drift out of the production signatures it calls with
  // zero compile-time signal — the approval lane's FAIL-1 rot class, verbatim.
  const tsconfig = readFileSync(join(webRoot, 'tsconfig.verification-stock-prep.json'), 'utf8')
  for (const pattern of [
    'verification/stock-prep-workbench-harness.ts',
    'verification/stock-prep-fixtures.ts',
    'verification/stock-prep-*.spec.ts',
  ]) {
    assert.ok(tsconfig.includes(pattern), `tsconfig.verification-stock-prep.json must include ${pattern}`)
  }

  // ...and it has to be RUN. Chained into `type-check` so the required web job enforces it even on a
  // PR this lane classifies as irrelevant.
  const pkg = JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8'))
  assert.equal(
    pkg.scripts['type-check:verification-stock-prep'],
    'vue-tsc --noEmit -p tsconfig.verification-stock-prep.json',
  )
  assert.ok(
    pkg.scripts['type-check'].includes('type-check:verification-stock-prep'),
    'the web type-check gate must run the stock-prep verification project',
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

test('every fixture world and every fixture actor is opened by at least one spec', () => {
  // Dead fixture code is a coverage claim nobody can cash: `readerOnly` and the `reader` actor were
  // built for D2's fourth landing branch and the only-`stock-prep:read` queue watcher, and for a
  // while neither was ever opened. A world nobody enters proves nothing about the world.
  const fixtures = readFileSync(join(verificationRoot, 'stock-prep-fixtures.ts'), 'utf8')
  const scenarios = /export type StockPrepScenario = ([^\n]+)/.exec(fixtures)?.[1] ?? ''
  const actors = /export type StockPrepActor = ([^\n]+)/.exec(fixtures)?.[1] ?? ''
  const literals = (declaration) => [...declaration.matchAll(/'([^']+)'/g)].map((match) => match[1])

  const scenarioNames = literals(scenarios)
  const actorNames = literals(actors)
  assert.ok(scenarioNames.length >= 5, `expected the fixture worlds, found ${scenarioNames.join()}`)
  assert.ok(actorNames.length >= 4, `expected the §7 principals, found ${actorNames.join()}`)

  const specSources = stockPrepSpecs.map((spec) => readFileSync(join(webRoot, spec), 'utf8')).join('\n')
  for (const scenario of scenarioNames) {
    assert.ok(
      specSources.includes(`scenario: '${scenario}'`),
      `fixture world '${scenario}' is never opened by a spec`,
    )
  }
  for (const actor of actorNames) {
    assert.ok(
      specSources.includes(`actor: '${actor}'`),
      `fixture principal '${actor}' is never opened by a spec`,
    )
  }
})
