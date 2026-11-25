import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const ops = path.join(repo, 'scripts/ops/stock-preparation-p3')
const sheet = path.join(repo, 'docs/operations/stock-preparation-p3-install-qa-sheet.md.tmpl')

function makePackage(root, migrations) {
  const dist = path.join(root, 'packages/core-backend/dist/src/db')
  const src = path.join(root, 'packages/core-backend/src/db/migrations')
  mkdirSync(path.join(dist, 'migrations'), { recursive: true })
  mkdirSync(src, { recursive: true })
  writeFileSync(path.join(dist, 'migrate.js'), '// fixture')
  for (const name of migrations) {
    writeFileSync(path.join(dist, 'migrations', name + '.js'), '// fixture')
    writeFileSync(path.join(src, name + '.ts'), '// fixture')
  }
}

test('package-mode counts render T-05 and s06 together and reject inserted literals', () => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'p3-counts-'))
  try {
    const baseline = path.join(fixture, 'baseline')
    const candidate = path.join(fixture, 'candidate')
    const qa = path.join(fixture, 'qa.md')
    const sql = path.join(fixture, 's06.sql')
    const bad = path.join(fixture, 'hardcoded.md')
    const before = Array.from({ length: 450 }, (_, index) => `fixture_${String(index).padStart(3, '0')}`)
    makePackage(baseline, before)
    makePackage(candidate, [...before, 'fixture_added'])
    const run = (template, output) => spawnSync(process.execPath, [
      path.join(ops, 'gen-counts.mjs'), '--layout', 'package', '--root', candidate, '--label', 'P3',
      '--baseline-root', baseline, '--baseline-label', 'R85',
      '--fill', template, '--out', output,
      '--fill', path.join(ops, 's06-new-migrations.sql.tmpl'), '--out', sql,
    ], { encoding: 'utf8' })

    const green = run(sheet, qa)
    assert.equal(green.status, 0, green.stdout + green.stderr)
    assert.equal((green.stdout.match(/mode=computed .*hardcoded_lines=0/g) || []).length, 2)
    const qaText = readFileSync(qa, 'utf8')
    const sqlText = readFileSync(sql, 'utf8')
    assert.match(qaText, /MIG_COUNT kysely_migration=450/)
    assert.match(qaText, /MIG_COUNT kysely_migration=451/)
    assert.ok(qaText.includes('- `fixture_added`'))
    assert.match(sqlText, /'fixture_added'/)
    assert.doesNotMatch(qaText + sqlText, /\{\{[A-Z_]+\}\}/)

    const badOutput = path.join(fixture, 'unexpected.md')
    writeFileSync(bad, readFileSync(sheet, 'utf8').replace('{{MIGRATIONS_TOTAL}}', '451'))
    const red = run(bad, badOutput)
    assert.equal(red.status, 3, red.stdout + red.stderr)
    assert.match(red.stdout + red.stderr, /hardcoded_count mode=computed/)
    assert.equal(existsSync(badOutput), false)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
