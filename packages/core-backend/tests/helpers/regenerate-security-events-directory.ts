import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { regenerateDirectoryFixture, sourcesAt, type DirectoryFixture } from './security-events-directory-closure'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const file = new URL('../fixtures/security-events/directory-closure.json', import.meta.url)
const previous = readFileSync(file, 'utf8')
const before: DirectoryFixture = JSON.parse(previous)
const fixture = regenerateDirectoryFixture(sourcesAt(root), before)
const next = JSON.stringify(fixture, null, 2) + '\n'
if (process.argv.slice(2).length !== 1 || !['--check', '--write'].includes(process.argv[2])) throw new Error('EXPECTED_CHECK_OR_WRITE')
for (const key of ['edges', 'closure', 'population'] as const) {
  const oldItems = before[key].map(item => JSON.stringify(item))
  const newItems = fixture[key].map(item => JSON.stringify(item))
  const remaining = [...newItems]
  for (const item of oldItems) {
    const index = remaining.indexOf(item)
    if (index < 0) console.info(JSON.stringify({ section: key, removed: JSON.parse(item) }))
    else remaining.splice(index, 1)
  }
  for (const item of remaining) console.info(JSON.stringify({ section: key, added: JSON.parse(item) }))
}
if (process.argv[2] === '--check') {
  if (next !== previous) throw new Error('EVENT_DIRECTORY_REGISTRATION_STALE')
} else writeFileSync(file, next)
console.info(JSON.stringify({ entries: fixture.population.length, pending: fixture.population.filter(item => item.coverage.startsWith('pending_')).length }))
