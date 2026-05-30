import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('remote log snapshot workflow uses deploy-host secrets and uploads artifacts', () => {
  const raw = readRepoFile('.github/workflows/attendance-remote-log-snapshot-prod.yml')

  assert.match(raw, /DEPLOY_HOST:\s+\$\{\{\s*secrets\.DEPLOY_HOST\s*\}\}/)
  assert.match(raw, /DEPLOY_USER:\s+\$\{\{\s*secrets\.DEPLOY_USER\s*\}\}/)
  assert.match(raw, /DEPLOY_SSH_KEY_B64:\s+\$\{\{\s*secrets\.DEPLOY_SSH_KEY_B64\s*\}\}/)
  assert.match(raw, /scripts\/ops\/attendance-collect-remote-logs\.sh/)
  assert.match(raw, /scp \$ssh_opts -r/)
  assert.match(raw, /uses: actions\/upload-artifact@v4/)
})

test('remote log snapshot workflow can comment with a run artifact pointer', () => {
  const raw = readRepoFile('.github/workflows/attendance-remote-log-snapshot-prod.yml')

  assert.match(raw, /issues: write/)
  assert.match(raw, /gh issue comment "\$ISSUE_NUMBER" --body-file "\$body"/)
  assert.match(raw, /gh run download \$\{GITHUB_RUN_ID\}/)
})

test('remote log collector redacts common secret shapes and avoids full inspect env dumps', () => {
  const raw = readRepoFile('scripts/ops/attendance-collect-remote-logs.sh')

  assert.match(raw, /Bearer\[\[:space:\]\]\+/)
  assert.match(raw, /authorization\|cookie\|set-cookie/)
  assert.match(raw, /postgres\(ql\)\?:\/\//)
  assert.match(raw, /access\[_-\]\?token\|refresh\[_-\]\?token\|id\[_-\]\?token\|password\|passwd\|secret\|jwt\|session\|authorityCode/)
  assert.match(raw, /docker inspect --format/)
  assert.doesNotMatch(raw, /\.Config\.Env/)
  assert.doesNotMatch(raw, /docker inspect "\$container" >/)
})
