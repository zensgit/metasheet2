import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const nginxConf = readFileSync(path.join(repoRoot, 'docker/nginx.conf'), 'utf8')

function locationBlock(location) {
  const escapedLocation = location.replaceAll('/', '\\/')
  const match = nginxConf.match(new RegExp(`location = ${escapedLocation} \\{([\\s\\S]*?)\\n  \\}`))
  assert.ok(match, `missing exact nginx location for ${location}`)
  return match[1]
}

for (const route of ['/metrics', '/metrics/prom']) {
  test(`nginx proxies ${route} to the backend metrics endpoint`, () => {
    const block = locationBlock(route)

    assert.match(block, /proxy_pass http:\/\/\$backend_upstream;/)
    assert.match(block, /proxy_http_version 1\.1;/)
    assert.match(block, /proxy_set_header Host \$host;/)
    assert.match(block, /proxy_set_header X-Real-IP \$remote_addr;/)
    assert.match(block, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/)
    assert.match(block, /proxy_set_header X-Forwarded-Proto \$scheme;/)
    assert.match(block, /proxy_set_header Authorization \$http_authorization;/)
    assert.doesNotMatch(block, /try_files/)
  })
}

test('metrics proxy locations are checked before the SPA fallback', () => {
  const metricsIndex = nginxConf.indexOf('location = /metrics')
  const metricsPromIndex = nginxConf.indexOf('location = /metrics/prom')
  const spaFallbackIndex = nginxConf.indexOf('location / {')

  assert.ok(metricsIndex >= 0)
  assert.ok(metricsPromIndex >= 0)
  assert.ok(spaFallbackIndex >= 0)
  assert.ok(metricsIndex < spaFallbackIndex)
  assert.ok(metricsPromIndex < spaFallbackIndex)
})
