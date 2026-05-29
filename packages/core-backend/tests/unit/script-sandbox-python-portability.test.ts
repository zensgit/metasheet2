import { spawnSync } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { ScriptSandbox, resolvePythonBinary } from '../../src/sandbox/ScriptSandbox'

// Lane C / C3 — Windows python-portability. The sandbox used to hardcode spawn('python3'), which
// does not resolve on native Windows (the interpreter is `python`/`py` there; `python3` is often
// absent or a Store launcher alias). resolvePythonBinary() picks the right command per platform
// with a PYTHON_BIN escape hatch.
describe('resolvePythonBinary (pure)', () => {
  it('defaults to python3 on POSIX', () => {
    expect(resolvePythonBinary('linux', undefined)).toBe('python3')
    expect(resolvePythonBinary('darwin', undefined)).toBe('python3')
  })

  it('defaults to python on native Windows (python3 usually absent there)', () => {
    expect(resolvePythonBinary('win32', undefined)).toBe('python')
  })

  it('honors PYTHON_BIN over the platform default, on any platform', () => {
    expect(resolvePythonBinary('win32', 'C:\\Python311\\python.exe')).toBe('C:\\Python311\\python.exe')
    expect(resolvePythonBinary('linux', '/usr/bin/python3.11')).toBe('/usr/bin/python3.11')
  })

  it('ignores empty / whitespace-only PYTHON_BIN and falls back to the platform default', () => {
    expect(resolvePythonBinary('win32', '')).toBe('python')
    expect(resolvePythonBinary('win32', '   ')).toBe('python')
    expect(resolvePythonBinary('linux', '')).toBe('python3')
  })
})

// Error-path robustness (C3): a missing interpreter — the common native-Windows `python3` case —
// must fail gracefully (no throw), surface the resolved binary to aid PYTHON_BIN diagnosis, and
// NOT leak the temp .py script. Deterministic on every platform (a bogus binary is ENOENT
// everywhere), so it needs no python install and no skip.
describe('ScriptSandbox python error path (C3)', () => {
  const prevPythonBin = process.env.PYTHON_BIN

  afterEach(() => {
    if (prevPythonBin === undefined) delete process.env.PYTHON_BIN
    else process.env.PYTHON_BIN = prevPythonBin
  })

  it('fails gracefully, names the binary, and cleans up the temp script when python is missing', async () => {
    process.env.PYTHON_BIN = '/nonexistent/python-bogus-xyz'
    // Isolated workDir so the leftover-script assertion is not polluted by other sandbox instances.
    const workDir = path.join(os.tmpdir(), `c3-pyerr-${process.pid}-${Date.now()}`)
    const sandbox = new ScriptSandbox({ workDir, timeout: 8000 })
    await sandbox.initialize()
    try {
      const result = await sandbox.execute('result = 1', {}, 'python')
      expect(result.success).toBe(false)
      expect(String(result.error)).toContain('/nonexistent/python-bogus-xyz')

      // Temp-cleanup fix: the spawn 'error' fires without 'close', so the .py must be removed there.
      const leftover = (await fs.readdir(workDir)).filter((f) => f.endsWith('.py'))
      expect(leftover).toEqual([])
    } finally {
      await sandbox.cleanup()
    }
  })
})

// Real-wire execution: spawn the *resolved* interpreter and run python for real. On windows-latest
// this is the actual "Windows native runtime" evidence for the sandbox code layer — it proves the
// resolved binary (`python` on win32) is found and executes.
//
// Skip honestly when no python is resolvable (local dev without python) — BUT the windows-latest CI
// job sets SANDBOX_REQUIRE_PYTHON=1, which converts the skip into a hard failure, so a broken python
// path on Windows can never masquerade as a green run (the "skip-when-unreachable" trap).
//
// NB: this exercises validateScript() (spawn + ast.parse over stdin). The executePython()
// wrapPythonScript path — whose double-indent bug is fixed in this slice — is covered end-to-end by
// the executePython describe below.
const pythonBin = resolvePythonBinary(process.platform, process.env.PYTHON_BIN)
const probe = spawnSync(pythonBin, ['--version'])
const pythonAvailable = !probe.error && probe.status === 0
const requirePython = process.env.SANDBOX_REQUIRE_PYTHON === '1'

describe('ScriptSandbox python real-wire (C3)', () => {
  it.skipIf(!pythonAvailable && !requirePython)(
    'spawns the resolved python binary and validates a script end-to-end',
    async () => {
      // Reached under SANDBOX_REQUIRE_PYTHON with no runnable python → fail loudly, never skip-pass.
      expect(
        pythonAvailable,
        `SANDBOX_REQUIRE_PYTHON=1 but python binary '${pythonBin}' is not runnable ` +
          `(${probe.error?.message ?? `exit ${probe.status}`}). Set PYTHON_BIN to a valid interpreter.`
      ).toBe(true)

      const sandbox = new ScriptSandbox({ timeout: 20000 })
      try {
        const ok = await sandbox.validateScript('x = 1\n', 'python')
        expect(ok.valid).toBe(true)

        const bad = await sandbox.validateScript('def (:\n', 'python')
        expect(bad.valid).toBe(false)
      } finally {
        await sandbox.cleanup()
      }
    }
  )
})

// executePython end-to-end (indent-fix): wrapPythonScript used to double-indent the user script
// (template `    ${...}` + per-line `map('    '+l)` = 8 spaces under a 4-space `result = None`),
// IndentationError-ing EVERY non-empty script on all platforms. These lock the fix: real wrapped
// execution must succeed (single-line, multi-line, context data) and surface runtime errors.
describe('ScriptSandbox executePython end-to-end (indent-fix)', () => {
  it.skipIf(!pythonAvailable && !requirePython)(
    'runs wrapped python (single-line, multi-line, context) and surfaces runtime errors',
    async () => {
      expect(
        pythonAvailable,
        `SANDBOX_REQUIRE_PYTHON=1 but python binary '${pythonBin}' is not runnable ` +
          `(${probe.error?.message ?? `exit ${probe.status}`}).`
      ).toBe(true)

      const sandbox = new ScriptSandbox({ timeout: 20000 })
      await sandbox.initialize()
      try {
        // single-line — the minimal repro of the old double-indent IndentationError
        const single = await sandbox.execute('result = 40 + 2', {}, 'python')
        expect(single.success).toBe(true)
        expect(single.output).toBe(42)

        // multi-line — proves EVERY line (not just the first) is indented consistently
        const multi = await sandbox.execute('a = 40\nb = 2\nresult = a + b', {}, 'python')
        expect(multi.success).toBe(true)
        expect(multi.output).toBe(42)

        // context data is threaded in via json.loads
        const withCtx = await sandbox.execute('result = data["x"] * 2', { data: { x: 21 } }, 'python')
        expect(withCtx.success).toBe(true)
        expect(withCtx.output).toBe(42)

        // runtime error → graceful failure (NOT a thrown/IndentationError), error surfaced
        const failure = await sandbox.execute('result = 1 / 0', {}, 'python')
        expect(failure.success).toBe(false)
        expect(String(failure.error)).toContain('ZeroDivisionError')
      } finally {
        await sandbox.cleanup()
      }
    }
  )
})
