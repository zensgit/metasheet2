#!/usr/bin/env node

/**
 * Hermetic self-test for the recovery-authority trigger enable/disable CLI.
 *
 * It injects a fake connection, so it asserts the properties that a real-DB rehearsal cannot
 * re-prove on every PR: the target set is the containment census itself (never a second copy),
 * every ALTER lives inside exactly one transaction that only commits after verification, and no
 * DATABASE_URL / raw database error ever reaches the output.
 *
 * Run: node --test scripts/ops/multitable-recovery-authority-triggers.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { EXPECTED_AUTHORITY_TRIGGERS } from './multitable-recovery-schema-containment.mjs'
import {
  EXPECTED_TRIGGER_COUNT,
  alterStatement,
  applyAuthorityTriggerVerb,
  quoteIdent,
  resolveTargets,
  runAuthorityTriggerCli,
} from './multitable-recovery-authority-triggers.mjs'

const SECRET_URL = 'postgresql://ops:hunter2@db.internal:5432/metasheet'

function postureRows(enabled, overrides = {}) {
  return EXPECTED_AUTHORITY_TRIGGERS.map((trigger) => ({
    schema_name: trigger.schemaName,
    table_name: trigger.tableName,
    trigger_name: trigger.triggerName,
    enabled: overrides[trigger.triggerName] ?? enabled,
  }))
}

/**
 * @param {{ postures?: object[][], failOn?: RegExp, failWith?: Error }} options
 */
function fakeConnect({ postures = [], failOn, failWith } = {}) {
  const statements = []
  let postureIndex = 0
  const connect = async () => ({
    client: {
      async query(text) {
        const sql = String(text).trim()
        statements.push(sql)
        if (failOn?.test(sql)) {
          throw failWith ?? Object.assign(new Error('boom'), { code: '42704' })
        }
        if (/^SELECT/i.test(sql)) {
          const rows = postures[postureIndex] ?? []
          postureIndex += 1
          return { rows }
        }
        return { rows: [] }
      },
    },
    close: async () => {},
  })
  return { connect, statements }
}

const alters = (statements) =>
  statements.filter((sql) => sql.startsWith('ALTER TABLE'))

test('targets come from the containment census — no second, drift-prone copy', () => {
  const targets = resolveTargets()
  assert.equal(targets.length, EXPECTED_TRIGGER_COUNT)
  assert.equal(targets.length, EXPECTED_AUTHORITY_TRIGGERS.length)
  assert.deepEqual(
    targets.map((target) => target.key).sort(),
    EXPECTED_AUTHORITY_TRIGGERS.map(
      (trigger) =>
        `${trigger.schemaName}.${trigger.tableName}.${trigger.triggerName}`,
    ).sort(),
  )
})

test('a census that is not exactly nine well-formed unique triggers fails loudly', () => {
  const census = EXPECTED_AUTHORITY_TRIGGERS.map((trigger) => ({ ...trigger }))
  assert.throws(() => resolveTargets(census.slice(0, 8)), /expected exactly 9/)
  assert.throws(
    () => resolveTargets([...census, census[0]]),
    /expected exactly 9/,
  )
  const duplicated = census.slice(0, 8).concat([{ ...census[0] }])
  assert.throws(() => resolveTargets(duplicated), /twice/)
  const malformed = census.map((trigger, index) =>
    index === 0
      ? { ...trigger, tableName: 'users; DROP TABLE users' }
      : trigger,
  )
  assert.throws(() => resolveTargets(malformed), /malformed tableName/)
})

test('identifiers are quoted, and an embedded quote is escaped rather than closing the ident', () => {
  assert.equal(quoteIdent('user_roles'), '"user_roles"')
  assert.equal(quoteIdent('we"ird'), '"we""ird"')
  assert.equal(
    alterStatement(
      { schemaName: 'public', tableName: 'users', triggerName: 'trg_x' },
      'DISABLE',
    ),
    'ALTER TABLE "public"."users" DISABLE TRIGGER "trg_x"',
  )
})

test('disable: nine ALTERs + verification live in ONE transaction that commits last', async () => {
  const { connect, statements } = fakeConnect({
    postures: [postureRows('D'), postureRows('D')],
  })
  const result = await applyAuthorityTriggerVerb({
    databaseUrl: SECRET_URL,
    verbName: 'disable',
    connect,
  })

  assert.equal(result.exitCode, 0)
  assert.match(
    result.output,
    /^VERDICT: PASS - disable applied in one transaction; 9\/9 recovery-authority triggers are disabled$/,
  )
  assert.equal(statements[0], 'BEGIN')
  assert.equal(statements.filter((sql) => sql === 'BEGIN').length, 1)
  assert.equal(statements.filter((sql) => sql === 'COMMIT').length, 1)
  assert.equal(statements.filter((sql) => sql === 'ROLLBACK').length, 0)

  const applied = alters(statements)
  assert.equal(applied.length, EXPECTED_TRIGGER_COUNT)
  assert.deepEqual(
    applied,
    resolveTargets().map((target) => alterStatement(target, 'DISABLE')),
  )

  // Every ALTER, and the pre-commit verification SELECT, precede the single COMMIT.
  const commitIndex = statements.indexOf('COMMIT')
  const lastAlterIndex = statements.findLastIndex((sql) =>
    sql.startsWith('ALTER TABLE'),
  )
  const firstSelectIndex = statements.findIndex((sql) =>
    sql.startsWith('SELECT'),
  )
  assert.ok(lastAlterIndex < commitIndex)
  assert.ok(firstSelectIndex > lastAlterIndex)
  assert.ok(firstSelectIndex < commitIndex)
})

test('enable emits ENABLE for the same nine targets', async () => {
  const { connect, statements } = fakeConnect({
    postures: [postureRows('O'), postureRows('O')],
  })
  const result = await applyAuthorityTriggerVerb({
    databaseUrl: SECRET_URL,
    verbName: 'enable',
    connect,
  })
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /9\/9 recovery-authority triggers are enabled/)
  assert.deepEqual(
    alters(statements),
    resolveTargets().map((target) => alterStatement(target, 'ENABLE')),
  )
})

test("'A' and 'R' count as armed; only 'D' counts as disabled", async () => {
  const armedVariants = fakeConnect({
    postures: [
      postureRows('O', {
        trg_user_roles_recovery_authority_lock: 'A',
        trg_users_recovery_authority_lock_update: 'R',
      }),
      postureRows('O', {
        trg_user_roles_recovery_authority_lock: 'A',
        trg_users_recovery_authority_lock_update: 'R',
      }),
    ],
  })
  const armed = await applyAuthorityTriggerVerb({
    databaseUrl: SECRET_URL,
    verbName: 'enable',
    connect: armedVariants.connect,
  })
  assert.equal(armed.exitCode, 0)

  const stillArmed = fakeConnect({
    postures: [postureRows('D', { trg_user_roles_recovery_authority_lock: 'O' })],
  })
  const rolledBack = await applyAuthorityTriggerVerb({
    databaseUrl: SECRET_URL,
    verbName: 'disable',
    connect: stillArmed.connect,
  })
  assert.equal(rolledBack.exitCode, 1)
})

test('a posture shortfall ROLLS BACK instead of committing a partial application', async () => {
  const { connect, statements } = fakeConnect({
    // Pre-commit verification sees one trigger still armed.
    postures: [postureRows('D', { trg_user_roles_recovery_authority_lock: 'O' })],
  })
  const result = await applyAuthorityTriggerVerb({
    databaseUrl: SECRET_URL,
    verbName: 'disable',
    connect,
  })

  assert.equal(result.exitCode, 1)
  assert.match(result.output, /rolled back: only 8\/9/)
  assert.match(
    result.output,
    /public\.user_roles\.trg_user_roles_recovery_authority_lock \(tgenabled='O'\)/,
  )
  assert.equal(statements.filter((sql) => sql === 'COMMIT').length, 0)
  assert.equal(statements.filter((sql) => sql === 'ROLLBACK').length, 1)
})

test('an absent trigger is reported as absent, not silently counted', async () => {
  const rows = postureRows('D').filter(
    (row) => row.trigger_name !== 'trg_user_roles_recovery_authority_lock',
  )
  const { connect, statements } = fakeConnect({ postures: [rows] })
  const result = await applyAuthorityTriggerVerb({
    databaseUrl: SECRET_URL,
    verbName: 'disable',
    connect,
  })
  assert.equal(result.exitCode, 1)
  // Must be caught by the PRE-commit verification: 8 of the 9 seen, one missing entirely.
  assert.match(result.output, /rolled back: only 8\/9/)
  assert.match(
    result.output,
    /public\.user_roles\.trg_user_roles_recovery_authority_lock \(absent\)/,
  )
  assert.equal(statements.filter((sql) => sql === 'COMMIT').length, 0)
  assert.equal(statements.filter((sql) => sql === 'ROLLBACK').length, 1)
})

test('a failing ALTER rolls the whole transaction back and never commits', async () => {
  const { connect, statements } = fakeConnect({
    failOn: /ALTER TABLE "public"\."users"/,
  })
  const result = await applyAuthorityTriggerVerb({
    databaseUrl: SECRET_URL,
    verbName: 'enable',
    connect,
  })

  assert.equal(result.exitCode, 2)
  assert.match(
    result.output,
    /enable not applied, transaction rolled back: a target trigger does not exist \(SQLSTATE 42704\)/,
  )
  assert.equal(statements.filter((sql) => sql === 'COMMIT').length, 0)
  assert.equal(statements.filter((sql) => sql === 'ROLLBACK').length, 1)
})

test('raw database errors and DATABASE_URL never reach the output', async () => {
  const leaky = Object.assign(
    new Error(`could not connect to ${SECRET_URL} as role "ops"`),
    { code: '28P01' },
  )
  const { connect } = fakeConnect({ failOn: /^BEGIN$/, failWith: leaky })
  const result = await applyAuthorityTriggerVerb({
    databaseUrl: SECRET_URL,
    verbName: 'disable',
    connect,
  })

  assert.equal(result.exitCode, 2)
  assert.match(result.output, /authentication failed \(SQLSTATE 28P01\)/)
  assert.doesNotMatch(result.output, /hunter2|db\.internal|postgresql:\/\//)
  assert.doesNotMatch(result.output, /could not connect/)
})

test('an unreachable database is generic and non-zero', async () => {
  const result = await applyAuthorityTriggerVerb({
    databaseUrl: SECRET_URL,
    verbName: 'disable',
    connect: async () => {
      throw Object.assign(new Error(`ECONNREFUSED ${SECRET_URL}`), {
        code: 'ECONNREFUSED',
      })
    },
  })
  assert.equal(result.exitCode, 2)
  assert.match(result.output, /database unreachable/)
  assert.doesNotMatch(result.output, /hunter2|db\.internal|postgresql:\/\//)
})

test('CLI: a missing DATABASE_URL fails closed without echoing the environment', async () => {
  const result = await runAuthorityTriggerCli({
    argv: ['disable'],
    env: { DATABASE_URL: '  ', SOME_OTHER_SECRET: 'hunter2' },
  })
  assert.equal(result.exitCode, 2)
  assert.match(result.output, /DATABASE_URL missing/)
  assert.doesNotMatch(result.output, /hunter2/)
})

test('CLI: only the two verbs are accepted; anything else prints usage and exits 2', async () => {
  for (const argv of [[], ['drop'], ['DISABLE'], ['disable', 'enable'], ['--help']]) {
    const result = await runAuthorityTriggerCli({
      argv,
      env: { DATABASE_URL: SECRET_URL },
    })
    assert.equal(result.exitCode, 2, `argv=${JSON.stringify(argv)}`)
    assert.match(result.output, /^usage: /)
  }
})
