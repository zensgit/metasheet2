import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = process.cwd()
const scriptPath = path.join(repoRoot, 'scripts/ops/attendance-check-branch-protection.sh')

test('REST protection parsing does not require Bash 4 array builtins', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'attendance-branch-protection-'))
  const binDir = path.join(tempRoot, 'bin')
  const ghPath = path.join(binDir, 'gh')
  const bashEnvPath = path.join(tempRoot, 'bash-env.sh')
  const outputPath = path.join(tempRoot, 'policy.json')

  try {
    mkdirSync(binDir)
    writeFileSync(
      ghPath,
      `#!/bin/sh
cat <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["contracts (strict)", "contracts (dashboard)"]
  },
  "enforce_admins": { "enabled": true },
  "required_pull_request_reviews": null
}
JSON
`,
      'utf8',
    )
    chmodSync(ghPath, 0o755)
    writeFileSync(
      bashEnvPath,
      'enable -n mapfile 2>/dev/null || true\nenable -n readarray 2>/dev/null || true\n',
      'utf8',
    )

    const result = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        BASH_ENV: bashEnvPath,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        REPO: 'zensgit/metasheet2',
        BRANCH: 'main',
        REQUIRED_CHECKS_CSV: 'contracts (strict),contracts (dashboard)',
        REQUIRE_STRICT: 'true',
        REQUIRE_ENFORCE_ADMINS: 'true',
        REQUIRE_PR_REVIEWS: 'false',
        MIN_APPROVING_REVIEW_COUNT: '1',
        REQUIRE_CODE_OWNER_REVIEWS: 'false',
        OUTPUT_JSON: outputPath,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, /contexts_current=contracts \(strict\),contracts \(dashboard\)/)
    const output = JSON.parse(readFileSync(outputPath, 'utf8'))
    assert.equal(output.ok, true)
    assert.deepEqual(output.contextsCurrent, ['contracts (strict)', 'contracts (dashboard)'])
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
