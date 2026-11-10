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
    assert.match(block, /proxy_set_header Host \$http_host;/)
    assert.match(block, /proxy_set_header X-Real-IP \$remote_addr;/)
    assert.match(block, /proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/)
    assert.match(block, /proxy_set_header X-Forwarded-Proto \$metasheet_forwarded_proto;/)
    assert.match(block, /proxy_set_header X-Forwarded-Host \$metasheet_forwarded_host;/)
    assert.match(block, /proxy_set_header Authorization \$http_authorization;/)
    assert.doesNotMatch(block, /try_files/)
  })
}

const PROXY_LOCATIONS = [
  'location = /metrics',
  'location = /metrics/prom',
  'location /api/attendance/import/upload',
  'location = /api',
  'location ^~ /api/',
  'location /socket.io/',
]

function proxyBlock(header) {
  const start = nginxConf.indexOf(header)
  assert.ok(start >= 0, `missing nginx location ${header}`)
  const open = nginxConf.indexOf('{', start)
  let depth = 0
  for (let i = open; i < nginxConf.length; i++) {
    if (nginxConf[i] === '{') depth++
    else if (nginxConf[i] === '}') {
      depth--
      if (depth === 0) return nginxConf.slice(open + 1, i)
    }
  }
  assert.fail(`unclosed nginx location ${header}`)
}

test('web nginx keeps the public host and the upstream forwarded proto on every backend hop', () => {
  assert.match(
    nginxConf,
    /map \$http_x_forwarded_proto \$metasheet_forwarded_proto \{\s*""\s+\$scheme;\s*default \$http_x_forwarded_proto;\s*\}/,
  )
  assert.match(
    nginxConf,
    /map \$http_x_forwarded_host \$metasheet_forwarded_host \{\s*""\s+\$http_host;\s*default \$http_x_forwarded_host;\s*\}/,
  )
  assert.doesNotMatch(nginxConf, /proxy_set_header Host \$host;/)
  assert.doesNotMatch(nginxConf, /proxy_set_header X-Forwarded-Proto \$scheme;/)

  for (const header of PROXY_LOCATIONS) {
    const block = proxyBlock(header)
    assert.match(block, /proxy_pass http:\/\/\$backend_upstream;/, header)
    assert.match(block, /proxy_set_header Host \$http_host;/, header)
    assert.match(block, /proxy_set_header X-Forwarded-Proto \$metasheet_forwarded_proto;/, header)
    assert.match(block, /proxy_set_header X-Forwarded-Host \$metasheet_forwarded_host;/, header)
  }
})

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
