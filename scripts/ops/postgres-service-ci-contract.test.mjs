import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  extractStepById,
  parseYamlDocument,
  stepHasEnvDatabaseUrl,
} from './ci-realdb-step-contract.mjs'

const serviceUrl = 'postgresql://postgres:postgres@127.0.0.1:${{ job.services.postgres.ports[5432] }}/metasheet_test'
const service = `    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: postgres
        ports:
          - '127.0.0.1::5432'
`

function workflow(url = serviceUrl, serviceYaml = service) {
  return `jobs:
  test:
    runs-on: ubuntu-latest
${serviceYaml}    steps:
      - id: real-db
        env:
          DATABASE_URL: '${url}'
        run: echo fixture
`
}

function accepted(text) {
  return stepHasEnvDatabaseUrl(extractStepById(text, 'real-db'))
}

test('only the same-job isolated service port is admitted as a dynamic URL', () => {
  assert.equal(accepted(workflow()), true)
  assert.equal(accepted(workflow(serviceUrl, '')), false)
  assert.equal(stepHasEnvDatabaseUrl({ env: { DATABASE_URL: serviceUrl } }), false)
  assert.equal(accepted(workflow() + `  other:\n${service}    steps: []\n`), true)
  assert.equal(accepted(workflow(serviceUrl, '') + `  other:\n${service}    steps: []\n`), false)
})

test('arbitrary expressions, empty values and altered service references remain rejected', () => {
  for (const value of [
    '', ' ', '${{ secrets.DATABASE_URL }}', '${{ env.DATABASE_URL }}',
    serviceUrl.replace('postgres.ports', 'other.ports'),
    serviceUrl.replace('[5432]', '[5433]'),
    serviceUrl.replace('127.0.0.1', 'localhost'),
    serviceUrl.replace('postgres:postgres@', 'postgres:${{ secrets.PW }}@'),
    serviceUrl.replace('job.services.postgres.ports[5432]', 'env.PGPORT'),
    serviceUrl.replace('job.services.postgres.ports[5432]', 'job.services.postgres.ports[5432] || 5432'),
  ]) assert.equal(accepted(workflow(value)), false, value)
  for (const changed of [
    service.replace('127.0.0.1::5432', '5432:5432'),
    service.replace('127.0.0.1::5432', '127.0.0.1::5433'),
    service.replace('postgres:14', '${{ vars.PG_IMAGE }}'),
    service.replace('POSTGRES_PASSWORD: postgres', 'POSTGRES_PASSWORD: different'),
    service + '        volumes: [data:/var/lib/postgresql/data]\n',
    service + '    container: node:20\n',
  ]) assert.equal(accepted(workflow(serviceUrl, changed)), false, changed)
  assert.equal(accepted(workflow('postgresql://postgres@localhost:5432/metasheet_test', '')), true)
})

test('plugin test job wires a fail-closed disposable database without changing host Postgres', () => {
  const text = readFileSync(new URL('../../.github/workflows/plugin-tests.yml', import.meta.url), 'utf8')
  const job = parseYamlDocument(text).jobs.test
  assert.deepEqual(job.services.postgres.ports, ['127.0.0.1::5432'])
  assert.equal(job.services.postgres.image, 'postgres:14')
  assert.equal(job.services.postgres.volumes, undefined)
  const start = job.steps.find(step => step.id === 'postgres-connection')
  const create = job.steps.find(step => step.name === 'Create test database')
  assert.ok(start && create)
  assert.equal(start.if, undefined)
  assert.equal(start['continue-on-error'], undefined)
  assert.equal(start.env.PGPORT, '${{ job.services.postgres.ports[5432] }}')
  assert.match(start.run, /\$\{PGPORT:\?/)
  assert.match(start.run, /\[\[ "\$PGPORT" =~ \^\[0-9\]\+\$ \]\]/)
  assert.match(start.run, /pg_isready/)
  assert.ok(job.steps.indexOf(start) < job.steps.indexOf(create))
  assert.match(create.run, /createdb --maintenance-db=postgres metasheet_test/)
  assert.doesNotMatch(create.run, /\|\| true|dropdb/)
  assert.ok(job.steps.every(step => step.uses !== 'ankane/setup-postgres@v1'))
  for (const step of job.steps) {
    if (step.env?.DATABASE_URL != null) {
      assert.equal(step.env.DATABASE_URL, serviceUrl, step.name)
      assert.equal(stepHasEnvDatabaseUrl(step), true, step.name)
    }
    if (step.env?.ATTENDANCE_TEST_DATABASE_URL != null) {
      assert.equal(step.env.ATTENDANCE_TEST_DATABASE_URL, serviceUrl)
    }
  }
})
