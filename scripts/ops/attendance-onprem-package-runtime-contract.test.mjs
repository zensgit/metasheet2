import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

function workflowJob(workflow, jobId) {
  const marker = `  ${jobId}:\n`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `workflow job ${jobId} must exist`)
  const bodyStart = start + marker.length
  const nextJob = workflow.slice(bodyStart).search(/\n  [a-zA-Z0-9_-]+:\n/)
  return workflow.slice(start, nextJob === -1 ? undefined : bodyStart + nextJob)
}

test('attendance package includes the core backend workspace runtime dependency', () => {
  const buildScript = read('scripts/ops/attendance-onprem-package-build.sh')

  assert.deepEqual(
    [...buildScript.matchAll(/"(packages\/mssql-readonly-utils\/[^"/]+)"/g)].map(
      (match) => match[1]
    ),
    [
      'packages/mssql-readonly-utils/package.json',
      'packages/mssql-readonly-utils/index.cjs',
      'packages/mssql-readonly-utils/index.d.ts',
    ],
    'the final archive must include the complete helper package contract without copying its tests or node_modules'
  )
})

test('attendance package workflow starts the uploaded archive and probes backend health', () => {
  const workflow = read('.github/workflows/attendance-onprem-package-build.yml')
  const runtimeJob = workflowJob(workflow, 'verify-package-runtime')
  const windowsJob = workflowJob(workflow, 'verify-package-windows-install')
  const releaseJob = workflowJob(workflow, 'publish-release')

  assert.match(runtimeJob, /needs: build-package/)
  assert.match(runtimeJob, /actions\/download-artifact@v4/)
  assert.match(runtimeJob, /pnpm install --frozen-lockfile/)
  assert.match(runtimeJob, /dist\/src\/db\/migrate\.js/)
  assert.match(runtimeJob, /dist\/src\/index\.js/)
  assert.match(runtimeJob, /127\.0\.0\.1:8900\/health/)
  assert.match(runtimeJob, /health\.ok !== true/)
  assert.match(runtimeJob, /health\.pluginsSummary\?\.failed !== 0/)

  assert.match(windowsJob, /needs: build-package/)
  assert.match(windowsJob, /runs-on: windows-latest/)
  assert.match(windowsJob, /actions\/download-artifact@v4/)
  assert.match(windowsJob, /Expand-Archive/)
  assert.match(windowsJob, /pnpm install --frozen-lockfile/)
  assert.match(windowsJob, /require\.resolve\('@metasheet\/mssql-readonly-utils'/)
  assert.match(
    releaseJob,
    /needs:\s*\n\s*- build-package\s*\n\s*- verify-package-runtime\s*\n\s*- verify-package-windows-install/,
    'release publication must depend on Linux runtime and Windows install proof'
  )
})
