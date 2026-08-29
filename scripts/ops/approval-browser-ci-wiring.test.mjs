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
const ts = require('typescript')

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const webRoot = join(repoRoot, 'apps', 'web')
const verificationRoot = join(webRoot, 'verification')
const workflowPath = join(repoRoot, '.github', 'workflows', 'approval-browser-verify.yml')
const approvalConfigPath = join(webRoot, 'playwright.approval-verification.config.ts')
const sharedConfigPath = join(webRoot, 'playwright.verification.config.ts')
const approvalTsconfigPath = join(webRoot, 'tsconfig.verification-approval.json')

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
    env: {
      ...process.env,
      CI: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
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

function runClassifier(script, eventName, changedPath) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'approval-browser-classifier-'))
  try {
    git(fixtureRoot, 'init', '--quiet')
    git(fixtureRoot, 'config', 'user.name', 'Approval Browser Contract')
    git(fixtureRoot, 'config', 'user.email', 'approval-browser-contract@example.invalid')
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
const approvalSpecs = allVerificationSpecs
  .filter((path) => basename(path).startsWith('approval-'))
const sharedSpecs = allVerificationSpecs
  .filter((path) => !basename(path).startsWith('approval-'))

test('approval workflow creates a stable PR and merge-queue context with a real classifier', () => {
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

  const job = workflow.jobs['browser-verify']
  assert.equal(job.name, 'Approval browser verify (chromium)')
  const checkout = job.steps.find((step) => step.uses === 'actions/checkout@v4')
  assert.equal(checkout?.with?.['fetch-depth'], 0, 'changed-file classification needs full history')

  const classifier = job.steps.find((step) => step.id === 'changes')
  assert.equal(classifier?.name, 'Detect relevant approval changes')
  assert.equal(typeof classifier?.run, 'string')
  const requiredAnchors = [
    'apps/web/src/approvals/*',
    'apps/web/src/views/approval*',
    'apps/web/src/types/approval.ts',
    'apps/web/src/composables/useAuth.ts',
    'apps/web/src/composables/useMobileViewport.ts',
    'apps/web/src/stores/featureFlags.ts',
    'apps/web/src/router/appRoutes.ts',
    'apps/web/verification/approval-*',
    'apps/web/playwright.approval-verification.config.ts',
    'apps/web/playwright.verification.config.ts',
    'apps/web/tsconfig.verification-approval.json',
    'apps/web/vite.config.ts',
    'apps/web/package.json',
    'package.json',
    'pnpm-lock.yaml',
    'scripts/ops/approval-browser-ci-wiring.test.mjs',
    '.github/workflows/approval-browser-verify.yml',
  ]
  for (const anchor of requiredAnchors) {
    assert.ok(classifier.run.includes(anchor), `classifier must include ${anchor}`)
  }

  assert.equal(runClassifier(classifier.run, 'pull_request', 'docs/unrelated.md'), false)
  for (const path of [
    'apps/web/src/views/approval/ApprovalProbe.vue',
    'apps/web/src/approvals/api.ts',
    'apps/web/src/approvals/permissions.ts',
    ...approvalSpecs.map((spec) => `apps/web/${spec}`),
  ]) {
    assert.equal(
      runClassifier(classifier.run, 'pull_request', path),
      true,
      `${path} must trigger approval browser verification`,
    )
  }
  assert.equal(
    runClassifier(classifier.run, 'merge_group', `apps/web/${approvalSpecs[0]}`),
    true,
    'merge_group must classify an on-disk approval spec as relevant',
  )
  assert.equal(runClassifier(classifier.run, 'workflow_dispatch', 'docs/unrelated.md'), true)

  const report = job.steps.find((step) => step.name === 'Report success for unrelated changes')
  assert.equal(report?.if, "steps.changes.outputs.relevant == 'false'")
  const wiring = job.steps.find((step) => step.name === 'Verify approval browser CI ownership and collection')
  assert.equal(wiring?.run, 'node --test scripts/ops/approval-browser-ci-wiring.test.mjs')
  assert.equal(wiring?.if, "steps.changes.outputs.relevant == 'true'")

  for (const name of [
    'Setup Node.js 20.x',
    'Setup pnpm',
    'Use empty npmrc for pnpm',
    'Get pnpm store directory',
    'Setup pnpm cache',
    'Install dependencies',
    'Install Playwright chromium (+ system deps)',
    'Type-check approval verification harnesses',
    'Run approval browser verification (boots Vite, renders real components)',
  ]) {
    const step = job.steps.find((candidate) => candidate.name === name)
    assert.equal(step?.if, "steps.changes.outputs.relevant == 'true'", `${name} must be classifier-gated`)
  }
})

test('approval and shared Playwright configs own disjoint, exhaustive spec sets', () => {
  const approvalConfig = readFileSync(approvalConfigPath, 'utf8')
  const sharedConfig = readFileSync(sharedConfigPath, 'utf8')
  assert.match(approvalConfig, /testMatch:\s*\[\s*['"]\*\*\/approval-\*\.spec\.ts['"]\s*\]/)
  assert.match(sharedConfig, /testIgnore:\s*\[\s*['"]\*\*\/approval-\*\.spec\.ts['"]\s*\]/)

  assert.deepEqual(
    listPlaywrightSpecs('playwright.approval-verification.config.ts'),
    approvalSpecs,
    'approval lane --list must equal every on-disk approval spec',
  )
  assert.deepEqual(
    listPlaywrightSpecs('playwright.verification.config.ts'),
    sharedSpecs,
    'shared lane must preserve every non-approval spec and collect zero approval specs',
  )
})

test('approval verification tsconfig owns every approval harness and spec', () => {
  const source = readFileSync(approvalTsconfigPath, 'utf8')
  assert.match(source, /"verification\/approval-\*-harness\.ts"/)
  assert.match(source, /"verification\/approval-\*\.spec\.ts"/)

  const readResult = ts.readConfigFile(approvalTsconfigPath, ts.sys.readFile)
  assert.equal(readResult.error, undefined, 'approval verification tsconfig must parse')
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    dirname(approvalTsconfigPath),
    undefined,
    approvalTsconfigPath,
  )
  assert.deepEqual(parsed.errors, [], 'approval verification tsconfig must resolve without diagnostics')

  const expected = walkFiles(verificationRoot)
    .filter((path) => {
      const name = basename(path)
      return /^approval-.*-harness\.ts$/.test(name) || /^approval-.*\.spec\.ts$/.test(name)
    })
    .map(webRelative)
    .sort()
  const actual = parsed.fileNames
    .filter((path) => path.startsWith(`${verificationRoot}${sep}`))
    .map(webRelative)
    .filter((path) => basename(path).startsWith('approval-'))
    .sort()
  assert.deepEqual(actual, expected)
})
