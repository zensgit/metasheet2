import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function readWorkflow(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('observability metric extraction avoids pipefail-sensitive awk to head pipelines', () => {
  const targets = [
    '.github/workflows/observability-e2e.yml',
    '.github/workflows/observability-strict.yml',
  ]

  for (const target of targets) {
    const raw = readWorkflow(target)
    assert.ok(
      !/awk [^\n]*\| head -1/.test(raw),
      `${target} must not pipe metric extraction awk into head -1`,
    )
  }

  const e2e = readWorkflow('.github/workflows/observability-e2e.yml')
  assert.ok(e2e.includes('rbac_perm_cache_hits_total [0-9]/{print $2; exit}'))
  assert.ok(e2e.includes('rbac_perm_cache_miss_total [0-9]/{print $2; exit}'))
  assert.ok(e2e.includes('rbac_perm_queries_real_total/{print $2; exit}'))
  assert.ok(e2e.includes('rbac_perm_queries_synth_total/{print $2; exit}'))

  const strict = readWorkflow('.github/workflows/observability-strict.yml')
  assert.ok(strict.includes('rbac_perm_queries_real_total/{print $2; exit}'))
  assert.ok(strict.includes('rbac_perm_queries_synth_total/{print $2; exit}'))
  assert.ok(strict.includes('rbac_perm_cache_hits_total\\{[^}]*\\} [0-9]+$/ {print $NF; exit}'))
  assert.ok(strict.includes('rbac_perm_cache_misses_total\\{[^}]*\\} [0-9]+$/ {print $NF; exit}'))
  assert.ok(strict.includes('metasheet_approval_conflict_total\\{[^}]*\\} [0-9]+$/{print $NF; exit}'))
})
