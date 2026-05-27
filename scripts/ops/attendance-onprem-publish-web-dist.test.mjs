import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const scriptPath = path.join(repoRoot, 'scripts/ops/attendance-onprem-publish-web-dist.sh')

function makeDist(root, label) {
  const dist = path.join(root, 'apps/web/dist')
  fs.mkdirSync(dist, { recursive: true })
  fs.writeFileSync(path.join(dist, 'index.html'), `<html>${label}</html>`)
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(dist, 'assets/app.js'), `console.log(${JSON.stringify(label)})`)
  return dist
}

function runPublish(env) {
  const result = spawnSync('bash', [scriptPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

test('publishes web dist to explicit WEB_DIST_TARGET', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-web-dist-explicit-'))
  const source = makeDist(path.join(tempRoot, 'release'), 'explicit')
  const target = path.join(tempRoot, 'nginx/apps/web/dist')

  runPublish({
    WEB_DIST_SOURCE: source,
    WEB_DIST_TARGET: target,
  })

  assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), '<html>explicit</html>')
  assert.equal(fs.readFileSync(path.join(target, 'assets/app.js'), 'utf8'), 'console.log("explicit")')
})

test('derives deploy root when package is extracted under packages/package/package', () => {
  const deployRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-web-dist-derived-'))
  const packageRoot = path.join(deployRoot, 'packages/metasheet-attendance-onprem-v2.7.2-run34/metasheet-attendance-onprem-v2.7.2-run34')
  const source = makeDist(packageRoot, 'derived')
  const target = path.join(deployRoot, 'apps/web/dist')

  runPublish({
    ROOT_DIR_OVERRIDE: packageRoot,
    WEB_DIST_SOURCE: source,
  })

  assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), '<html>derived</html>')
  assert.equal(fs.readFileSync(path.join(target, 'assets/app.js'), 'utf8'), 'console.log("derived")')
})

test('derives deploy root when package is extracted directly under packages/package', () => {
  const deployRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-web-dist-direct-'))
  const packageRoot = path.join(deployRoot, 'packages/metasheet-attendance-onprem-v2.7.2-run34')
  const source = makeDist(packageRoot, 'direct')
  const target = path.join(deployRoot, 'apps/web/dist')

  runPublish({
    ROOT_DIR_OVERRIDE: packageRoot,
    WEB_DIST_SOURCE: source,
  })

  assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), '<html>direct</html>')
  assert.equal(fs.readFileSync(path.join(target, 'assets/app.js'), 'utf8'), 'console.log("direct")')
})
