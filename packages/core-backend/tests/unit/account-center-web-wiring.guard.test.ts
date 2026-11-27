import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { allVitestTokens } from '../../../../scripts/ops/required-web-lane-exec-block.mjs'

const ROOT = path.resolve(__dirname, '../../../..')
const WORKFLOW = '.github/workflows/account-center-web-guard.yml'
const JOB = 'account-center-web-guard'
const NAME = 'Account Center Web Guard'

// Immutable workflow baseline: e380c48d478866f0c95a506f194635e1790f3391.
const TEMPLATE = `name: Notification Preferences Web Guard

# Whole spec paths prevent an empty name filter from passing without running tests.
# Path-filtered PR and push runs deliberately have no merge_group trigger.
on:
  workflow_dispatch:
  pull_request:
    paths:
      - 'apps/web/src/notifications/**'
      - 'apps/web/src/views/NotificationPreferencesView.vue'
      - 'apps/web/src/views/SessionCenterView.vue'
      - 'apps/web/src/router/appRoutes.ts'
      - 'apps/web/src/composables/useLocale.ts'
      - 'apps/web/src/utils/api.ts'
      - 'apps/web/tests/notificationApi.spec.ts'
      - 'apps/web/tests/notificationLabels.spec.ts'
      - 'apps/web/tests/notificationPreferences.spec.ts'
      - 'apps/web/scripts/run-required-web-tests.sh'
      - 'apps/web/scripts/run-required-web-tests.tokens'
      - 'apps/web/vite.config.ts'
      - 'apps/web/package.json'
      - 'packages/core-backend/src/routes/me-notification-*.ts'
      - 'packages/core-backend/src/notifications/**'
      - 'package.json'
      - 'pnpm-lock.yaml'
      - '.github/workflows/notification-preferences-web-guard.yml'
  push:
    branches: [main]
    paths:
      - 'apps/web/src/notifications/**'
      - 'apps/web/src/views/NotificationPreferencesView.vue'
      - 'apps/web/src/views/SessionCenterView.vue'
      - 'apps/web/src/router/appRoutes.ts'
      - 'apps/web/src/composables/useLocale.ts'
      - 'apps/web/src/utils/api.ts'
      - 'apps/web/tests/notificationApi.spec.ts'
      - 'apps/web/tests/notificationLabels.spec.ts'
      - 'apps/web/tests/notificationPreferences.spec.ts'
      - 'apps/web/scripts/run-required-web-tests.sh'
      - 'apps/web/scripts/run-required-web-tests.tokens'
      - 'apps/web/vite.config.ts'
      - 'apps/web/package.json'
      - 'packages/core-backend/src/routes/me-notification-*.ts'
      - 'packages/core-backend/src/notifications/**'
      - 'package.json'
      - 'pnpm-lock.yaml'
      - '.github/workflows/notification-preferences-web-guard.yml'

permissions:
  contents: read

jobs:
  notification-preferences-web-guard:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20.x
      - uses: pnpm/action-setup@v4
        with:
          version: 10.16.1
          run_install: false
      - name: Use empty npmrc for pnpm
        run: |
          echo "" > /tmp/empty-npmrc
          echo "NPM_CONFIG_USERCONFIG=/tmp/empty-npmrc" >> "$GITHUB_ENV"
      - name: Get pnpm store directory
        id: pnpm-cache
        shell: bash
        run: echo "STORE_PATH=$(pnpm store path)" >> "$GITHUB_OUTPUT"
      - name: Setup pnpm cache
        uses: actions/cache@v4
        with:
          path: \${{ steps.pnpm-cache.outputs.STORE_PATH }}
          key: \${{ runner.os }}-pnpm-store-\${{ hashFiles('**/pnpm-lock.yaml') }}
          restore-keys: |
            \${{ runner.os }}-pnpm-store-
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Run notification preference specs
        working-directory: apps/web
        env:
          DATABASE_URL: postgres://127.0.0.1:1/none
        run: pnpm exec vitest run tests/notificationPreferences.spec.ts tests/notificationApi.spec.ts tests/notificationLabels.spec.ts
      - name: Type-check the web app
        working-directory: apps/web
        run: node --max-old-space-size=4096 node_modules/vue-tsc/bin/vue-tsc.js -b
`

const F_SPECS = [
  'tests/authorizationAuditFeed.spec.ts',
  'tests/adminAuditView.spec.ts',
  'tests/public-multitable-form.spec.ts',
]
const M_SPECS = [...F_SPECS, 'tests/accountCenterRead.spec.ts']
const A_SPECS = [
  ...M_SPECS,
  'tests/accountCenterView.spec.ts',
  'tests/accountCenterParser.spec.ts',
  'tests/accountCenterLabels.spec.ts',
  'tests/sessionCenterView.spec.ts',
]
const F_PATHS = [
  'apps/web/src/components/AuthorizationAuditFeed.vue',
  'apps/web/src/views/AdminAuditView.vue',
]
const M_PATHS = [
  ...F_PATHS,
  'apps/web/src/account/accountCenterContract.ts',
  'apps/web/src/account/useAccountCenterRead.ts',
]
const A_PATHS = [
  ...M_PATHS,
  'apps/web/src/views/AccountCenterView.vue',
  'apps/web/src/account/accountCenterParser.ts',
  'apps/web/src/account/accountCenterLabels.ts',
  'apps/web/src/views/SessionCenterView.vue',
  'apps/web/src/router/appRoutes.ts',
]
const STAGES = {
  F: { specs: F_SPECS, paths: F_PATHS },
  M: { specs: M_SPECS, paths: M_PATHS },
  A: { specs: A_SPECS, paths: A_PATHS },
}
const CURRENT_STAGE: keyof typeof STAGES = 'M'
const STAGE = STAGES[CURRENT_STAGE]
const APPROVED_GLOBS = ['apps/web/src/account/**']
const COMMON_PATHS = [
  WORKFLOW,
  'apps/web/scripts/run-required-web-tests.sh',
  'apps/web/scripts/run-required-web-tests.tokens',
  'apps/web/vite.config.ts',
  'apps/web/package.json',
  'package.json',
  'pnpm-lock.yaml',
]

type Step = {
  name?: string
  uses?: string
  with?: Record<string, unknown>
  run?: string
  env?: Record<string, string>
}
type Job = { name?: string; 'runs-on': string; steps: Step[] }
type Workflow = {
  name: string
  on: { workflow_dispatch: null; pull_request: { paths: string[] }; push: { branches: string[]; paths: string[] } }
  permissions: Record<string, string>
  jobs: Record<string, Job>
}
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')
const workflow = () => yaml.load(read(WORKFLOW)) as Workflow
const baseline = yaml.load(TEMPLATE) as Workflow
const templateSteps = baseline.jobs['notification-preferences-web-guard'].steps
const testStep = () => workflow().jobs[JOB].steps[7]
const wholeSpecs = /^pnpm exec vitest run( tests\/[A-Za-z0-9._-]+\.spec\.ts)+$/

// Collapse only the two variable-length paths lists; all other bytes retain their positions.
function fixedShape(source: string): string {
  const blocks = /^    paths:\n(?:      - '[^'\r\n]+'\n)+/gm
  expect([...source.matchAll(blocks)]).toHaveLength(2)
  return source.replace(blocks, '    paths:\n')
}

describe('account center web workflow invariants', () => {
  it('G1 preserves the fixed template outside the named editable fields', () => {
    const lines = read(WORKFLOW).split('\n')
    const templateLines = TEMPLATE.split('\n')
    expect(lines[0]).toBe(`name: ${NAME}`)
    lines[0] = templateLines[0]
    for (const index of [2, 3]) {
      expect(lines[index]).toMatch(/^# /)
      expect(lines[index]).not.toContain('${{')
      lines[index] = templateLines[index]
    }
    const source = lines.join('\n')
    expect(source).toContain(`  ${JOB}:\n`)
    expect(source).toContain('      - name: Run account center web specs\n')
    const commands = source.match(/^        run: pnpm exec vitest run.*$/gm)
    expect(commands).toHaveLength(1)
    expect(commands![0]).toMatch(/^        run: pnpm exec vitest run( tests\/[A-Za-z0-9._-]+\.spec\.ts)+$/)
    const normalized = source
      .replace(`  ${JOB}:\n`, '  notification-preferences-web-guard:\n')
      .replace('      - name: Run account center web specs\n', '      - name: Run notification preference specs\n')
      .replace(commands![0], `        run: ${templateSteps[7].run}`)
    expect(fixedShape(normalized)).toBe(fixedShape(TEMPLATE))
  })

  it('G2 keeps identical PR and main-push paths with an input-free manual trigger', () => {
    const triggers = workflow().on
    expect(Object.keys(triggers).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(triggers.workflow_dispatch).toBeNull()
    expect(Object.keys(triggers.pull_request)).toEqual(['paths'])
    expect(Object.keys(triggers.push).sort()).toEqual(['branches', 'paths'])
    expect(triggers.push.branches).toEqual(['main'])
    expect(triggers.pull_request.paths).toEqual(triggers.push.paths)
  })

  it('G3 grants only workflow-level contents read permission', () => {
    const doc = workflow()
    expect(doc.permissions).toEqual({ contents: 'read' })
    for (const job of Object.values(doc.jobs)) expect(job).not.toHaveProperty('permissions')
  })

  it('G4 has exactly one hosted job with only a runner and steps', () => {
    const jobs = workflow().jobs
    expect(Object.keys(jobs)).toEqual([JOB])
    expect(Object.keys(jobs[JOB]).sort()).toEqual(['runs-on', 'steps'])
    expect(jobs[JOB]['runs-on']).toBe('ubuntu-24.04')
  })

  it('G5 retains all nine steps and the fixed action positions and inputs', () => {
    const steps = workflow().jobs[JOB].steps
    expect(steps).toHaveLength(9)
    expect(steps.map((step) => step.uses)).toEqual(templateSteps.map((step) => step.uses))
    expect(steps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
      'actions/checkout@v4', 'actions/setup-node@v4', 'pnpm/action-setup@v4', 'actions/cache@v4',
    ])
    expect(steps.map((step) => step.with)).toEqual(templateSteps.map((step) => step.with))
    expect(read(WORKFLOW)).not.toContain('continue-on-error')
  })

  it('G6 runs whole specs without expressions or extra command arguments', () => {
    const steps = workflow().jobs[JOB].steps
    for (const [index, step] of steps.entries()) {
      if (step.run !== undefined) expect(step.run).not.toContain('${{')
      if (index === 7) expect(step.run).toMatch(wholeSpecs)
      else expect(step.run).toBe(templateSteps[index].run)
    }
  })

  it('G7 keeps the no-database environment and excludes external context values', () => {
    expect(testStep().env).toEqual({ DATABASE_URL: 'postgres://127.0.0.1:1/none' })
    for (const value of ['secrets.', 'vars.', 'github.event']) expect(read(WORKFLOW)).not.toContain(value)
  })

  it('G8 runs every current-stage spec exactly once and only existing files', () => {
    const run = testStep().run!
    expect(run).toMatch(wholeSpecs)
    const specs = run.slice('pnpm exec vitest run '.length).split(' ')
    expect(specs.length).toBe(new Set(specs).size)
    expect([...specs].sort()).toEqual([...STAGE.specs].sort())
    for (const spec of specs) expect(statSync(path.join(ROOT, 'apps/web', spec)).isFile()).toBe(true)
  })

  it('G9 covers current-stage sources, hosts, specs and configuration with valid paths', () => {
    const paths = workflow().on.pull_request.paths
    expect(new Set(paths).size).toBe(paths.length)
    for (const entry of paths) {
      if (/[*?\[\]{}!]/.test(entry)) expect(APPROVED_GLOBS).toContain(entry)
      else expect(statSync(path.join(ROOT, entry)).isFile()).toBe(true)
    }
    for (const required of [...COMMON_PATHS, ...STAGE.paths, ...STAGE.specs.map((spec) => `apps/web/${spec}`)]) {
      const covered = paths.includes(required) || APPROVED_GLOBS.some((glob) =>
        paths.includes(glob) && required.startsWith(glob.slice(0, -2)),
      )
      expect(covered, required).toBe(true)
    }
  })

  it('G10 registers each stage spec in both the manifest and executable test calls', () => {
    const manifest = new Set(read('apps/web/scripts/run-required-web-tests.tokens').trim().split(/\r?\n/))
    const script: Set<string> = allVitestTokens(read('apps/web/scripts/run-required-web-tests.sh'))
    for (const spec of STAGE.specs) {
      // Accept whole paths, bare filenames and existing extensionless basename tokens.
      const filename = path.basename(spec)
      const forms = [spec, filename, filename.replace(/\.spec\.ts$/, '')]
      expect(forms.some((token) => manifest.has(token)), `manifest: ${spec}`).toBe(true)
      expect(forms.some((token) => script.has(token)), `script: ${spec}`).toBe(true)
    }
  })

  it('G11 keeps the workflow and effective check names unique across all workflows', () => {
    const docs = readdirSync(path.join(ROOT, '.github/workflows'))
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => ({ file, doc: yaml.load(read(`.github/workflows/${file}`)) as Workflow }))
    expect(docs.filter(({ doc }) => doc.name === NAME)).toHaveLength(1)
    const checks = docs.flatMap(({ file, doc }) => Object.entries(doc.jobs).map(([id, job]) => ({
      file, id, name: job.name ?? id,
    })))
    expect(checks.filter((check) => check.name === JOB)).toHaveLength(1)
    const templateChecks = checks.filter((check) =>
      check.id === 'notification-preferences-web-guard' || check.name === 'notification-preferences-web-guard',
    )
    expect(templateChecks.map((check) => check.file)).toEqual(['notification-preferences-web-guard.yml'])
  })

  it('G12 requires the workflow file without conditional test registration', () => {
    expect(existsSync(path.join(ROOT, WORKFLOW))).toBe(true)
    expect(() => read(WORKFLOW)).not.toThrow()
  })
})
