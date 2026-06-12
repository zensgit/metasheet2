import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dockerfilePath = path.join(repoRoot, 'Dockerfile.backend')

function backendDockerfile() {
  return readFileSync(dockerfilePath, 'utf8')
}

function stage(text, name) {
  const marker = `FROM node:20-slim AS ${name}`
  const start = text.indexOf(marker)
  assert.notEqual(start, -1, `missing ${name} stage`)
  const next = text.indexOf('\nFROM ', start + marker.length)
  return text.slice(start, next === -1 ? text.length : next)
}

test('backend runner image keeps ops scripts used by staging smoke runbooks', () => {
  const text = backendDockerfile()
  const builder = stage(text, 'builder')
  const runner = stage(text, 'runner')

  assert.match(builder, /^COPY scripts \.\/scripts$/m)
  assert.match(runner, /^COPY --from=builder \/app\/scripts \.\/scripts$/m)
  assert.match(runner, /CMD \["node", "packages\/core-backend\/dist\/src\/index\.js"\]/)
  assert.equal(
    runner.indexOf('COPY --from=builder /app/scripts ./scripts') < runner.indexOf('CMD ["node"'),
    true,
    'scripts must be copied before the runner CMD',
  )
})
