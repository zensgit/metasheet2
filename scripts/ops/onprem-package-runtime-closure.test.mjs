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
  const requiredJob = workflow.split('\n  test:\n')[1].split(/\n  [a-z][\w-]*:/)[0]
  assert.match(requiredJob, /node-version: \[20\.x\]/)
  assert.match(requiredJob, /run: node --test scripts\/ops\/attendance-onprem-package-verify-migrations\.test\.mjs scripts\/ops\/onprem-package-runtime-closure\.test\.mjs/)
})
