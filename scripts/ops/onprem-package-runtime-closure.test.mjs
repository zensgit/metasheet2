import { requiredSuiteJobBody } from './plugin-tests-workflow-contract.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const closures = {
  multitable: [
    'packages/core-backend/dist/scripts/bootstrap-yida-initialization-owner.js',
    'packages/core-backend/dist/src/integration/yida-initialization-bootstrap.js',
    'plugins/plugin-integration-core/lib/yida-connection-probe.cjs',
    'packages/core-backend/dist/src/multitable/stock-preparation-manual-rows.js',
    'packages/core-backend/dist/src/multitable/stock-preparation-manual-rows-gate.js',
    'plugins/plugin-integration-core/lib/stock-preparation-manual-rows.cjs',
    'packages/core-backend/src/db/migrations/20250925_create_view_tables.sql',
    'packages/core-backend/src/db/migrations/20250926_create_audit_tables.sql',
    'scripts/ops/attendance-onprem-publish-web-dist.sh',
    'scripts/ops/attendance-onprem-publish-web-dist.ps1',
  ],
  attendance: [
    'packages/mssql-readonly-utils/package.json',
    'packages/mssql-readonly-utils/index.cjs',
  ],
}

for (const [kind, requiredFiles] of Object.entries(closures)) {
  const builder = fs.readFileSync(path.join(repo, `scripts/ops/${kind}-onprem-package-build.sh`), 'utf8')
  const verifier = fs.readFileSync(path.join(repo, `scripts/ops/${kind}-onprem-package-verify.sh`), 'utf8')
  const payload = [...builder.match(/\nREQUIRED_PATHS=\(\n([\s\S]*?)\n\)/)[1].matchAll(/^  "([^"]+)"$/gm)].map(match => match[1])
  // Execute the verifier's real required-file loop, before its unrelated
  // Windows/content contracts. Full archives are exercised in the Mac rehearsal.
  const guard = verifier.match(/\nrequired=\(\n[\s\S]*?\nfor rel in "\$\{required\[@\]\}"; do\n[\s\S]*?\ndone\n/)[0]
  const files = [...guard.matchAll(/^  "([^"]+)"$/gm)].map(match => match[1])

  test(`${kind} builder includes its runtime closure`, () => {
    for (const file of requiredFiles) {
      assert.ok(payload.some(entry => file === entry || file.startsWith(entry + '/')), `builder omits ${file}`)
    }
  })

  function runGuard(omitted) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onprem-runtime-closure-'))
    try {
      for (const file of files) {
        if (file === omitted) continue
        const target = path.join(root, file)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, 'fixture\n')
      }
      return spawnSync('bash', ['-c', 'set -eu\ndie() { echo "$*" >&2; exit 1; }\n' + guard], {
        env: { ...process.env, pkg_root: root }, encoding: 'utf8',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  test(`${kind} verifier required-file guard accepts complete contents`, () => {
    const result = runGuard()
    assert.equal(result.status, 0, result.stderr)
  })

  for (const file of requiredFiles) {
    test(`${kind} verifier rejects missing ${file}`, () => {
      const result = runGuard(file)
      assert.notEqual(result.status, 0, `verifier accepted missing ${file}`)
      assert.ok(result.stderr.includes(`Required package content missing: ${file}`), result.stderr)
    })
  }
}

test('runtime closure regression executes in the required Node 20 job', () => {
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/plugin-tests.yml'), 'utf8')
  const requiredJob = requiredSuiteJobBody(workflow, 'contracts')
  assert.match(requiredJob, /node-version: \[20\.x\]/)
  assert.match(requiredJob, /run: node --test scripts\/ops\/attendance-onprem-package-verify-migrations\.test\.mjs scripts\/ops\/onprem-package-runtime-closure\.test\.mjs/)
})

test('compiled YiDa bootstrap CLI smoke runs after a core-backend build in the required Node 20 job', () => {
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/plugin-tests.yml'), 'utf8')
  const requiredJob = requiredSuiteJobBody(workflow, 'unit')
  const steps = requiredJob.split('\n      - name: ').filter(step => step.includes('scripts/ops/yida-bootstrap-cli-compiled-smoke.test.mjs'))
  assert.equal(steps.length, 1, 'exactly one required step runs the compiled CLI smoke')
  const build = steps[0].indexOf('\n          pnpm --filter @metasheet/core-backend build\n')
  const smoke = steps[0].indexOf('node --test --test-reporter=tap scripts/ops/yida-bootstrap-cli-compiled-smoke.test.mjs')
  assert.ok(build > 0 && smoke > build, 'the smoke must run after the core-backend build in the same step')
  assert.ok(steps[0].indexOf("[ \"$smoke_tests\" = '# tests 1' ]") > smoke, 'the smoke step must require exactly one subtest')
  assert.ok(steps[0].indexOf("grep -Fxq 'ok 1 - compiled YiDa bootstrap CLI refuses an empty invocation as a program'") > smoke, 'the smoke step must require the named test, not just a passing file')
  assert.doesNotMatch(steps[0], /continue-on-error/)
})

// 人工补充行 content markers: files that existed before the feature must carry it. Listed here independently of
// verify.sh, so deleting or loosening a check there turns its case below red.
const manualRowsMarkers = [
  ['plugins/plugin-integration-core/lib/http-routes.cjs', "'/api/integration/stock-preparation/projects/:projectNo/target/manual-rows'", 'http-routes.cjs must register the stock-prep manual-rows switch route'],
  ['packages/core-backend/dist/src/routes/univer-meta.js', "'/sheets/:sheetId/manual-rows'", 'manual-row create route (manual rows B2)'],
  ['packages/core-backend/dist/src/routes/univer-meta.js', 'resolveGenericCreateRefusal', 'generic create on stock-prep project sheets (manual rows B3)'],
  ['apps/web/dist/assets/manual-fields.js', '/manual-fields', 'manual-row edit route (manual rows B3)'],
  ['apps/web/dist/assets/target-manual-rows.js', '/target/manual-rows', 'manual-rows switch route (manual rows B4)'],
]
const multitableVerifier = fs.readFileSync(path.join(repo, 'scripts/ops/multitable-onprem-package-verify.sh'), 'utf8')
const manualRowsCheck = [
  multitableVerifier.match(/\nfunction search_fixed_string\(\) \{\n[\s\S]*?\n\}\n/)[0],
  multitableVerifier.match(/\nfunction verify_stock_preparation_manual_rows_contract\(\) \{\n[\s\S]*?\n\}\n/)[0],
].join('')

function runManualRowsCheck(omitted) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onprem-manual-rows-markers-'))
  try {
    const contents = new Map()
    for (const [file, needle] of manualRowsMarkers) {
      if (!contents.has(file)) contents.set(file, ['fixture'])
      if (needle !== omitted) contents.get(file).push(needle)
    }
    for (const [file, lines] of contents) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), lines.join('\n') + '\n')
    }
    return spawnSync('bash', ['-c', 'set -eu\ndie() { echo "$*" >&2; exit 1; }\n' + manualRowsCheck + 'verify_stock_preparation_manual_rows_contract "$pkg_root"\n'], {
      env: { ...process.env, pkg_root: root }, encoding: 'utf8',
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('multitable verifier runs the manual-rows marker check in its main flow', () => {
  assert.match(multitableVerifier, /\nverify_stock_preparation_manual_rows_contract "\$pkg_root"\n/)
})

test('multitable verifier manual-rows markers accept complete contents', () => {
  const result = runManualRowsCheck()
  assert.equal(result.status, 0, result.stderr)
})

for (const [file, needle, what] of manualRowsMarkers) {
  test(`multitable verifier rejects ${file} without ${needle}`, () => {
    const result = runManualRowsCheck(needle)
    assert.notEqual(result.status, 0, `verifier accepted ${file} without ${needle}`)
    assert.ok(result.stderr.includes(what), result.stderr)
  })
}
