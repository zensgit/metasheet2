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
    // Batch identifier (R-65): the install client imports the scheduled-pull client by relative path.
    'scripts/ops/stock-preparation-pull-batch-install.mjs',
    'scripts/ops/stock-preparation-scheduled-pull.mjs',
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
  const requiredJob = workflow.split('\n  test:\n')[1].split(/\n  [a-z][\w-]*:/)[0]
  assert.match(requiredJob, /node-version: \[20\.x\]/)
  assert.match(requiredJob, /run: node --test scripts\/ops\/attendance-onprem-package-verify-migrations\.test\.mjs scripts\/ops\/onprem-package-runtime-closure\.test\.mjs/)
})

test('compiled YiDa bootstrap CLI smoke runs after a core-backend build in the required Node 20 job', () => {
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/plugin-tests.yml'), 'utf8')
  const requiredJob = workflow.split('\n  test:\n')[1].split(/\n  [a-z][\w-]*:/)[0]
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
// verify.sh, so deleting a check there turns its case below red. The decoys are what real output also holds: the same
// strings in comments, in the gate module (its own definitions and a quoted route), in a sibling plugin file, in
// non-JS files under the web dist, and in the packaged verify.sh itself, which quotes every needle. None of them
// proves the feature, so a check that is loosened (quotes dropped) or widened (the plugin lib dir, the core-backend
// dist dir or the package root instead of the one file, any file under dist instead of the JS chunks) matches a decoy
// and its case turns red too.
const manualRowsMarkers = [
  ['plugins/plugin-integration-core/lib/http-routes.cjs', "'/api/integration/stock-preparation/projects/:projectNo/target/manual-rows'", 'http-routes.cjs must register the stock-prep manual-rows switch route'],
  ['packages/core-backend/dist/src/routes/univer-meta.js', "'/sheets/:sheetId/manual-rows'", 'manual-row create route (manual rows B2)'],
  ['packages/core-backend/dist/src/routes/univer-meta.js', 'resolveGenericCreateRefusal', 'generic create on stock-prep project sheets (manual rows B3)'],
  ['apps/web/dist/assets/manual-fields.js', '/manual-fields', 'manual-row edit route (manual rows B3)'],
  ['apps/web/dist/assets/target-manual-rows.js', '/target/manual-rows', 'manual-rows switch route (manual rows B4)'],
]
const manualRowsDecoys = [
  ['plugins/plugin-integration-core/lib/http-routes.cjs', '//   GET  /api/integration/stock-preparation/projects/:projectNo/target/manual-rows   PULL tier'],
  ['plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs', "    path: '/api/integration/stock-preparation/projects/:projectNo/target/manual-rows',"],
  ['packages/core-backend/dist/src/routes/univer-meta.js', '// Three session-only routes: POST /sheets/:sheetId/manual-rows (新增), POST /records/:recordId/manual-copy'],
  ['packages/core-backend/dist/src/multitable/stock-preparation-manual-rows-gate.js', 'async function resolveGenericCreateRefusal(query, sheetId, fields) {'],
  ['packages/core-backend/dist/src/multitable/stock-preparation-manual-rows-gate.js', "// the create route '/sheets/:sheetId/manual-rows' (univer-meta) calls assertManualRowsAllowed"],
  ['scripts/ops/multitable-onprem-package-verify.sh', "search_fixed_string \"'/sheets/:sheetId/manual-rows'\" \"$host_routes\""],
  ['scripts/ops/multitable-onprem-package-verify.sh', "search_fixed_string \"'/api/integration/stock-preparation/projects/:projectNo/target/manual-rows'\" \"$plugin_routes\""],
  ['scripts/ops/multitable-onprem-package-verify.sh', "search_fixed_string 'resolveGenericCreateRefusal' \"$host_routes\""],
  ['apps/web/dist/stray.txt', 'PATCH /manual-fields and GET /target/manual-rows'],
  ['apps/web/dist/assets/index.js.map', '{"sourcesContent":["// GET /target/manual-rows, PATCH /manual-fields"]}'],
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
    const add = (file, line) => {
      if (!contents.has(file)) contents.set(file, ['fixture'])
      contents.get(file).push(line)
    }
    for (const [file, needle] of manualRowsMarkers) if (needle !== omitted) add(file, needle)
    for (const [file, line] of manualRowsDecoys) add(file, line)
    for (const [file, lines] of contents) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), lines.join('\n') + '\n')
    }
    const script = 'set -eu\ndie() { echo "$*" >&2; exit 1; }\nmanual_rows_status=SKIPPED\n' + manualRowsCheck
      + 'verify_stock_preparation_manual_rows_contract "$pkg_root"\necho "manual_rows_status=$manual_rows_status"\n'
    return spawnSync('bash', ['-c', script], { env: { ...process.env, pkg_root: root }, encoding: 'utf8' })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('multitable verifier defines the manual-rows marker check once and runs it before the report', () => {
  // Counted forms: `function name` (with or without `()`) and `name()`, at line start, one-line bodies included, so a
  // later shadowing definition in any of those forms is caught.
  const definitions = multitableVerifier.match(/^[ \t]*(?:function[ \t]+verify_stock_preparation_manual_rows_contract\b|verify_stock_preparation_manual_rows_contract[ \t]*\(\))/gm) || []
  assert.equal(definitions.length, 1, 'exactly one definition')
  const calls = multitableVerifier.split('\nverify_stock_preparation_manual_rows_contract "$pkg_root"\n')
  assert.equal(calls.length, 2, 'exactly one main-flow call')
  assert.ok(calls[1].includes('\nwrite_optional_report\n'), 'the report is written after the check ran')
  assert.match(multitableVerifier, /\nmanual_rows_status="SKIPPED"\n/)
  assert.ok(multitableVerifier.includes('"      \\"status\\": \\"${manual_rows_status}\\""'), 'the JSON report carries the derived status')
})

test('multitable verifier manual-rows markers accept complete contents and report PASS', () => {
  const result = runManualRowsCheck()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'manual_rows_status=PASS')
})

for (const [file, needle, what] of manualRowsMarkers) {
  test(`multitable verifier rejects ${file} without ${needle}, decoys present`, () => {
    const result = runManualRowsCheck(needle)
    assert.notEqual(result.status, 0, `verifier accepted ${file} without ${needle}`)
    assert.ok(result.stderr.includes(what), result.stderr)
    assert.doesNotMatch(result.stdout, /manual_rows_status=PASS/)
  })
}
