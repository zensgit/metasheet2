import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PYTHON_CANDIDATES, PYTHON_CANDIDATE_LABEL, spawnPythonSync } from './python-interpreter.mjs'

// ---------------------------------------------------------------------------
// `spawnPythonSync` contract (scripts/ops/python-interpreter.mjs)
//
// The whole point of the helper is that it widens WHERE a Python interpreter may be found
// without widening WHEN a guard is allowed to go green. Every case below is driven through the
// injected `spawn` seam with a stub, so nothing here spawns a real process and the assertions
// hold identically on Linux CI and on a Windows checkout.
//
// This file is imported by `t2gate-collision-mechanism-ci-wiring.test.mjs` (which IS wired to a
// `node --test` step in the required no-DB `test` job of .github/workflows/plugin-tests.yml), so
// this coverage runs in CI without adding or modifying a workflow step.
// ---------------------------------------------------------------------------

/** ENOENT exactly as `child_process.spawnSync` reports a missing executable. */
function enoent(command) {
  const error = new Error(`spawnSync ${command} ENOENT`)
  error.code = 'ENOENT'
  error.errno = -4058
  error.syscall = `spawnSync ${command}`
  error.path = command
  return { pid: 0, output: [], stdout: '', stderr: '', status: null, signal: null, error }
}

function exited(status, stdout = '', stderr = '') {
  return { pid: 1234, output: [], stdout, stderr, status, signal: null, error: undefined }
}

/** Records every (command, args) the helper attempted, in order. */
function recordingSpawn(responder) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return responder(command, args, options)
  }
  return { calls, spawn }
}

test('candidate order is python3 → py -3 → python (CI’s python3 stays first)', () => {
  assert.deepEqual(
    PYTHON_CANDIDATES.map((c) => [c.command, ...c.prefixArgs].join(' ')),
    ['python3', 'py -3', 'python'],
  )
  assert.equal(PYTHON_CANDIDATE_LABEL, 'python3, py -3, python')
})

test('python3 present: the first candidate answers and nothing else is attempted (CI behavior unchanged)', () => {
  const { calls, spawn } = recordingSpawn(() => exited(0, '{"ok":true}'))
  const res = spawnPythonSync(['-c', 'PY'], { input: 'x', encoding: 'utf8' }, spawn)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'python3')
  assert.deepEqual(calls[0].args, ['-c', 'PY'])
  assert.deepEqual(calls[0].options, { input: 'x', encoding: 'utf8' })
  assert.equal(res.status, 0)
  assert.equal(res.stdout, '{"ok":true}')
  assert.equal(res.error, undefined)
})

test('python3 ENOENT falls through to `py -3`, and the -3 prefix precedes the caller’s args', () => {
  const { calls, spawn } = recordingSpawn((command) =>
    command === 'python3' ? enoent('python3') : exited(0, '{"parsed":1}'),
  )
  const res = spawnPythonSync(['-c', 'PY'], {}, spawn)

  assert.deepEqual(calls.map((c) => c.command), ['python3', 'py'])
  assert.deepEqual(calls[1].args, ['-3', '-c', 'PY'])
  assert.equal(res.status, 0)
  assert.equal(res.stdout, '{"parsed":1}')
  assert.equal(res.error, undefined)
})

test('python3 and `py` both ENOENT: falls through to bare `python`', () => {
  const { calls, spawn } = recordingSpawn((command) =>
    command === 'python' ? exited(0, '{}') : enoent(command),
  )
  const res = spawnPythonSync(['-c', 'PY'], {}, spawn)

  assert.deepEqual(calls.map((c) => c.command), ['python3', 'py', 'python'])
  assert.deepEqual(calls[2].args, ['-c', 'PY'])
  assert.equal(res.status, 0)
})

test('NO fallback on a non-zero exit status — a YAML parse error (4) is returned from python3 verbatim', () => {
  // The green bypass this rules out: retrying a *failed parse* on another interpreter until one
  // of them likes the input. Only "interpreter not installed" may fall through.
  const { calls, spawn } = recordingSpawn((command) =>
    command === 'python3'
      ? exited(4, '', 'YAML_PARSE_ERROR: ScannerError(...)')
      : exited(0, '{"green":"bypass"}'),
  )
  const res = spawnPythonSync(['-c', 'PY'], {}, spawn)

  assert.deepEqual(calls.map((c) => c.command), ['python3'])
  assert.equal(res.status, 4)
  assert.match(res.stderr, /YAML_PARSE_ERROR/)
  assert.equal(res.stdout, '')
})

test('NO fallback on exit 3 (PyYAML missing) either — the module absence is the answer, not a retry', () => {
  const { calls, spawn } = recordingSpawn((command) =>
    command === 'python3' ? exited(3, '', "PYYAML_MISSING: ModuleNotFoundError('yaml')") : exited(0, '{}'),
  )
  const res = spawnPythonSync(['-c', 'PY'], {}, spawn)

  assert.deepEqual(calls.map((c) => c.command), ['python3'])
  assert.equal(res.status, 3)
})

test('NO fallback on a non-ENOENT spawn error (EACCES) — it is returned as-is so the caller fails CLOSED', () => {
  const eacces = new Error('spawnSync python3 EACCES')
  eacces.code = 'EACCES'
  const { calls, spawn } = recordingSpawn((command) =>
    command === 'python3'
      ? { pid: 0, output: [], stdout: '', stderr: '', status: null, signal: null, error: eacces }
      : exited(0, '{}'),
  )
  const res = spawnPythonSync(['-c', 'PY'], {}, spawn)

  assert.deepEqual(calls.map((c) => c.command), ['python3'])
  assert.equal(res.error, eacces)
})

test('every candidate ENOENT: all three are tried, the LAST result is returned, and it still carries .error', () => {
  const { calls, spawn } = recordingSpawn((command) => enoent(command))
  const res = spawnPythonSync(['-c', 'PY'], {}, spawn)

  assert.deepEqual(calls.map((c) => c.command), ['python3', 'py', 'python'])
  assert.ok(res.error, 'result must still carry .error so callers keep failing CLOSED')
  assert.equal(res.error.code, 'ENOENT')
  assert.match(res.error.message, /python/)
  // The caller's existing `if (res.error) throw` branch is what turns this into a red guard.
  assert.throws(
    () => {
      if (res.error) throw new Error(`failing CLOSED (tried ${PYTHON_CANDIDATE_LABEL}): ${res.error.message}`)
    },
    /failing CLOSED \(tried python3, py -3, python\)/,
  )
})

test('spawnPythonSync never throws on its own — a total ENOENT sweep returns, it does not reject', () => {
  const { spawn } = recordingSpawn((command) => enoent(command))
  assert.doesNotThrow(() => spawnPythonSync(['-c', 'PY'], {}, spawn))
})

test('the same options object is forwarded unchanged to every attempted candidate', () => {
  const options = { input: 'YAML', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }
  const { calls, spawn } = recordingSpawn((command) => (command === 'python' ? exited(0) : enoent(command)))
  spawnPythonSync(['-c', 'PY'], options, spawn)

  assert.equal(calls.length, 3)
  for (const call of calls) assert.equal(call.options, options)
})

test('the caller’s args array is not mutated by the `py -3` prefix', () => {
  const args = ['-c', 'PY']
  const { spawn } = recordingSpawn((command) => (command === 'py' ? exited(0) : enoent(command)))
  spawnPythonSync(args, {}, spawn)
  assert.deepEqual(args, ['-c', 'PY'])
})
