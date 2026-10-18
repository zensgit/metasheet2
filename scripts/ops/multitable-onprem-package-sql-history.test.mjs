import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const verify = fileURLToPath(new URL('./multitable-onprem-package-verify.sh', import.meta.url))

test('actual package verifier refuses either missing legacy SQL history input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-package-history-'))
  const folder = path.join(root, 'packages/core-backend/src/db/migrations')
  const names = ['20250925_create_view_tables', '20250926_create_audit_tables']
  fs.mkdirSync(folder, { recursive: true })
  const run = () => spawnSync('bash', ['-c', 'source "$VERIFY"; verify_legacy_sql_history "$PACKAGE_ROOT"'], {
    env: { ...process.env, VERIFY: verify, PACKAGE_ROOT: root }, encoding: 'utf8',
  })
  try {
    for (const name of names) fs.writeFileSync(path.join(folder, `${name}.sql`), 'SELECT 1;\n')
    assert.equal(run().status, 0)
    for (const name of names) {
      fs.unlinkSync(path.join(folder, `${name}.sql`))
      const refused = run()
      assert.notEqual(refused.status, 0)
      assert.ok(refused.stderr.includes(`Missing legacy SQL migration history input: ${name}.sql`))
      fs.writeFileSync(path.join(folder, `${name}.sql`), 'SELECT 1;\n')
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
