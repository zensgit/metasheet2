/**
 * Shared, fail-closed Python interpreter resolution for the `scripts/ops` guards.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several required no-DB guards parse `.github/workflows/*.yml` through a `python3 + PyYAML`
 * bridge (see `ci-realdb-step-contract.mjs`'s header for why PyYAML and not `js-yaml`: the
 * guards run BEFORE `pnpm install`, so no npm dependency is importable). On the GitHub
 * `ubuntu-latest` runner the distro interpreter is on PATH as `python3`, so a bare
 * `spawnSync('python3', …)` always resolved there.
 *
 * On a developer Windows checkout there is usually no `python3` on PATH — CPython for Windows
 * installs `python.exe` plus the `py` launcher instead. `spawnSync('python3', …)` then returns
 * `res.error.code === 'ENOENT'`, every one of those guards fails CLOSED, and the whole
 * `*-ci-wiring` family reads red locally for a reason that has nothing to do with the change
 * under test. That is a local-only false red: the same guards are green on CI.
 *
 * WHAT THIS DOES — AND DELIBERATELY DOES NOT DO
 * ---------------------------------------------
 * `spawnPythonSync` walks a fixed candidate list and falls through to the next candidate ONLY
 * when the spawn itself failed with `ENOENT` (that interpreter is not installed). Any other
 * outcome — a non-zero exit status such as the bridge's `3` (PyYAML missing) or `4` (YAML parse
 * error), a spawn error with a different `code` (EACCES, EPERM, ETIMEDOUT, …), or success — is
 * returned VERBATIM from the first candidate that got that far. Falling back on a non-ENOENT
 * result would be a green bypass: a YAML parse error on `python3` must never be retried on
 * `python` until some interpreter happens to like it.
 *
 * When every candidate is ENOENT the LAST result is returned, still carrying `.error` — so every
 * existing caller's fail-closed `if (res.error) throw` branch keeps firing exactly as before.
 * This module never throws and never swallows a failure; it only widens WHERE the interpreter
 * may be found. CI (Linux, `python3` present) takes the first candidate and behaves identically
 * to the pre-existing bare `spawnSync('python3', …)`.
 */

import { spawnSync as nodeSpawnSync } from 'node:child_process'

/**
 * Interpreter candidates, in order. `python3` first so CI's behavior is bit-for-bit what it was.
 * `py -3` next (the Windows launcher, which pins Python 3 even when `python` is a 2.x stub).
 * Bare `python` last (Windows installs, and virtualenvs that only expose `python`).
 *
 * @type {ReadonlyArray<{ command: string, prefixArgs: readonly string[] }>}
 */
export const PYTHON_CANDIDATES = Object.freeze([
  Object.freeze({ command: 'python3', prefixArgs: Object.freeze([]) }),
  Object.freeze({ command: 'py', prefixArgs: Object.freeze(['-3']) }),
  Object.freeze({ command: 'python', prefixArgs: Object.freeze([]) }),
])

/** Human-readable candidate list for fail-closed error messages. */
export const PYTHON_CANDIDATE_LABEL = PYTHON_CANDIDATES.map(
  (candidate) => [candidate.command, ...candidate.prefixArgs].join(' '),
).join(', ')

/**
 * Run Python synchronously, trying each candidate interpreter until one can be spawned.
 *
 * @param {string[]} args             arguments after the interpreter (e.g. `['-c', source]`)
 * @param {import('node:child_process').SpawnSyncOptions} [options]
 * @param {typeof nodeSpawnSync} [spawn] injection seam for tests — never used in production
 * @returns {import('node:child_process').SpawnSyncReturns<string>} the first non-ENOENT result,
 *          or the last (still-ENOENT) result when no candidate exists on this machine
 */
export function spawnPythonSync(args, options = {}, spawn = nodeSpawnSync) {
  let last = null
  for (const candidate of PYTHON_CANDIDATES) {
    const res = spawn(candidate.command, [...candidate.prefixArgs, ...args], options)
    last = res
    // Fall through ONLY for "this interpreter is not installed". Everything else — including a
    // non-zero exit status from the Python program itself — is the answer, and is returned as-is.
    if (res && res.error && res.error.code === 'ENOENT') continue
    return res
  }
  return last
}
