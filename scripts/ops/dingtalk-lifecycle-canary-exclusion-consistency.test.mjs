#!/usr/bin/env node
// dingtalk-lifecycle-canary-exclusion-consistency.test.mjs
//
// Required-lane consistency contract for the lifecycle canary's owner-scoped migration gate.
// Holds three things together on every PR:
//   1. the owner exclusion list committed in scripts/ops/attendance-window-runner-pipeline.lib.sh
//      (STAGING_OWNER_EXCLUDED_MIGRATIONS, read through the lib's own function in a subshell);
//   2. the canary accept table scripts/ops/dingtalk-lifecycle-staging-canary-accepted-exclusions.txt
//      (<migration_name> <sha256> per line);
//   3. the migration source files packages/core-backend/src/db/migrations/<name>.ts whose sha256
//      each accepted line is bound to.
// Red when an accepted digest no longer matches its source file, an accepted name is not in the
// lib list (stale acceptance), a lib name is not in the accept table (unaccepted exclusion), a
// name has no source file, or the table is malformed. The lib list and the accept table name the
// same set: adding or removing an exclusion updates both in the same reviewed change.
//
// It also runs the canary's own accept-table reader (remote script sourced in source-only mode)
// against the committed table, so the runtime and this parser agree on it before any dispatch.
//
// Standalone: node:test + fs + crypto + a bash subshell. No deps, no DB, no network. It does not
// execute or import the canary contract suite.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const LIB = join(HERE, 'attendance-window-runner-pipeline.lib.sh')
const ACCEPT_TABLE = join(HERE, 'dingtalk-lifecycle-staging-canary-accepted-exclusions.txt')
const REMOTE_SH = join(HERE, 'dingtalk-lifecycle-staging-canary-remote.sh')
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'core-backend', 'src', 'db', 'migrations')

const NAME_RE = /^[A-Za-z0-9_]+$/
const LINE_RE = /^([A-Za-z0-9_]+)[ \t]+([0-9a-f]{64})[ \t]*$/

export function parseAcceptTable(text) {
  const names = new Map()
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '' || line.startsWith('#')) continue
    const m = line.match(LINE_RE)
    if (!m) throw new Error(`accept table line ${index + 1} is not "<migration_name> <sha256>"`)
    if (names.has(m[1])) throw new Error(`accept table repeats ${m[1]}`)
    names.set(m[1], m[2])
  }
  return names
}

export function readLibExclusionNames(libPath) {
  const r = spawnSync(
    'bash',
    ['-c', 'set -euo pipefail; source "$1"; staging_owner_excluded_names', '_', libPath],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`lib exclusion list unreadable: ${r.stderr}`)
  const names = r.stdout.split('\n').filter(Boolean)
  for (const n of names) if (!NAME_RE.test(n)) throw new Error(`lib exclusion name is not a plain migration basename: ${n}`)
  return names
}

export function migrationSourceDigest(migrationsDir, name) {
  const file = join(migrationsDir, `${name}.ts`)
  if (!existsSync(file)) throw new Error(`no migration source file for ${name}`)
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// Runs the canary's own runtime reader (read_canary_accept_table, remote script sourced in
// source-only mode) against a table path. Returns { status, names }.
export function runtimeAcceptTableNames(tablePath) {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-accept-reader-'))
  try {
    const r = spawnSync(
      'bash',
      ['-o', 'pipefail', '-c', 'source "$1"; TABLE="$2"; canary_accept_table_path() { printf "%s" "$TABLE"; }; read_canary_accept_table', 'bash', REMOTE_SH, tablePath],
      {
        encoding: 'utf8',
        env: { ...process.env, ACTION: 'status', OUTPUT_DIR: dir, RUN_STAMP: 'consistency', LIFECYCLE_CANARY_SOURCE_ONLY: 'true' },
      },
    )
    return { status: r.status, stderr: r.stderr, names: r.stdout.split('\n').filter(Boolean) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The consistency rule. Throws on any disagreement; returns the accepted names that are in the
// lib list (the set the canary would tolerate on this ref). Both directions are checked: every
// lib name must be accepted and every accepted name must be in the lib list.
export function assertConsistent({ libNames, accept, digestOf }) {
  for (const name of libNames) {
    assert.ok(accept.has(name), `lib owner exclusion ${name} is not in the canary accept table (unaccepted exclusion; add it with its reviewed source digest in the same change)`)
  }
  const tolerated = []
  for (const [name, digest] of accept) {
    assert.ok(libNames.includes(name), `accepted exclusion ${name} is not in the lib owner exclusion list (stale acceptance; remove it in the same reviewed change)`)
    assert.equal(digestOf(name), digest, `accepted digest for ${name} does not match its migration source file (re-review the migration, then update the accept table)`)
    tolerated.push(name)
  }
  return tolerated
}

test('accept table parses: one <migration_name> <sha256> per non-comment line, no repeats (an empty table is valid)', () => {
  const accept = parseAcceptTable(readFileSync(ACCEPT_TABLE, 'utf8'))
  for (const [name, digest] of accept) {
    assert.match(name, NAME_RE)
    assert.match(digest, /^[0-9a-f]{64}$/)
  }
})

test('the committed accept table parses identically with the canary runtime reader', () => {
  const accept = parseAcceptTable(readFileSync(ACCEPT_TABLE, 'utf8'))
  const runtime = runtimeAcceptTableNames(ACCEPT_TABLE)
  assert.equal(runtime.status, 0, `runtime reader rejected the committed accept table: ${runtime.stderr}`)
  assert.deepEqual(runtime.names, [...accept.keys()])
})

test('lib owner exclusion list is readable through its own function and every name is a plain basename', () => {
  const names = readLibExclusionNames(LIB)
  assert.ok(Array.isArray(names))
  for (const n of names) assert.match(n, NAME_RE)
})

test('REQUIRED: lib exclusion list, canary accept table and migration source digests agree', () => {
  const libNames = readLibExclusionNames(LIB)
  const accept = parseAcceptTable(readFileSync(ACCEPT_TABLE, 'utf8'))
  // Consistency is the contract, not non-emptiness: when the owner applies the last excluded
  // migration and removes it from the lib list and from the accept table in the same change,
  // both are empty, this stays green and the canary falls back to the strict whole-ledger rule.
  const tolerated = assertConsistent({ libNames, accept, digestOf: (name) => migrationSourceDigest(MIGRATIONS_DIR, name) })
  for (const name of tolerated) assert.ok(existsSync(join(MIGRATIONS_DIR, `${name}.ts`)))
  // The two lists name exactly the same set.
  assert.deepEqual([...tolerated].sort(), [...libNames].sort())
  assert.deepEqual([...accept.keys()].sort(), [...libNames].sort())
})

test('the canary reads the accept table by this basename and binds the lib by basename (shipped side by side)', () => {
  const source = readFileSync(REMOTE_SH, 'utf8')
  assert.match(source, /^CANARY_ACCEPT_TABLE_BASENAME="dingtalk-lifecycle-staging-canary-accepted-exclusions\.txt"$/m)
  assert.match(source, /^OWNER_EXCLUSION_LIB_BASENAME="attendance-window-runner-pipeline\.lib\.sh"$/m)
  // The runtime reader accepts exactly the line shape this test parses.
  assert.match(source, /\^\(\[A-Za-z0-9_\]\+\)\[\[:space:\]\]\+\(\[0-9a-f\]\{64\}\)\[\[:space:\]\]\*\$/)
})

test('MUTATION: a desynced digest, a stale name, an unaccepted lib name, a missing source, a malformed or repeated line are each rejected', () => {
  const libNames = ['syn_a', 'syn_b']
  const digests = { syn_a: 'a'.repeat(64), syn_b: 'b'.repeat(64) }
  const digestOf = (name) => {
    if (!(name in digests)) throw new Error(`no migration source file for ${name}`)
    return digests[name]
  }
  const good = parseAcceptTable(`# c\nsyn_a ${digests.syn_a}\n`)
  assert.deepEqual(assertConsistent({ libNames: ['syn_a'], accept: good, digestOf }), ['syn_a'])
  // a lib name the accept table does not list (the lib grew, the table did not follow)
  assert.throws(() => assertConsistent({ libNames: ['syn_a', 'syn_c'], accept: good, digestOf }), /unaccepted exclusion/)
  // desynced digest
  assert.throws(() => assertConsistent({ libNames: ['syn_a'], accept: parseAcceptTable(`syn_a ${'c'.repeat(64)}\n`), digestOf }), /does not match/)
  // stale acceptance (name no longer in the lib list)
  assert.throws(() => assertConsistent({ libNames: [], accept: good, digestOf }), /stale acceptance/)
  // both directions at once: the lib names syn_b, the table still names syn_a
  assert.throws(() => assertConsistent({ libNames: ['syn_b'], accept: good, digestOf }), /unaccepted exclusion|stale acceptance/)
  // accepted name without a source file
  assert.throws(() => assertConsistent({ libNames: ['syn_z'], accept: parseAcceptTable(`syn_z ${'d'.repeat(64)}\n`), digestOf }), /no migration source file/)
  // malformed / repeated lines
  for (const bad of ['syn_a nothash\n', 'syn_a\n', `syn-a ${digests.syn_a}\n`, `syn_a ${digests.syn_a}\nsyn_a ${digests.syn_a}\n`, `syn_a ${digests.syn_a} extra\n`, `syn_a ${digests.syn_a.toUpperCase()}\n`]) {
    assert.throws(() => parseAcceptTable(bad), bad)
  }
  // an empty table (comments only) is consistent only with an empty lib list
  assert.deepEqual(assertConsistent({ libNames: [], accept: parseAcceptTable('# none\n'), digestOf }), [])
  assert.throws(() => assertConsistent({ libNames, accept: parseAcceptTable('# none\n'), digestOf }), /unaccepted exclusion/)
  // the full two-name agreement passes
  assert.deepEqual(assertConsistent({ libNames, accept: parseAcceptTable(`syn_a ${digests.syn_a}\nsyn_b ${digests.syn_b}\n`), digestOf }), ['syn_a', 'syn_b'])
})

test('MUTATION: the runtime reader rejects every shape this parser rejects, and accepts what it accepts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-accept-shapes-'))
  try {
    const table = join(dir, 'table.txt')
    const d = 'a'.repeat(64)
    for (const bad of ['syn_a nothash\n', 'syn_a\n', `syn-a ${d}\n`, `syn_a ${d}\nsyn_a ${d}\n`, `syn_a ${d} extra\n`, `syn_a ${d.toUpperCase()}\n`]) {
      assert.throws(() => parseAcceptTable(bad), bad)
      writeFileSync(table, bad)
      const r = runtimeAcceptTableNames(table)
      assert.notEqual(r.status, 0, `runtime reader must reject: ${JSON.stringify(bad)}`)
      assert.deepEqual(r.names, [], `runtime reader prints nothing on reject: ${JSON.stringify(bad)}`)
    }
    for (const good of ['# none\n', '', `# c\n\nsyn_a ${d}\nsyn_b ${'b'.repeat(64)}\n`, `syn_a ${d}`]) {
      writeFileSync(table, good)
      const r = runtimeAcceptTableNames(table)
      assert.equal(r.status, 0, JSON.stringify(good))
      assert.deepEqual(r.names, [...parseAcceptTable(good).keys()], JSON.stringify(good))
    }
    const missing = runtimeAcceptTableNames(join(dir, 'absent.txt'))
    assert.notEqual(missing.status, 0, 'a missing table is unreadable, never empty')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
