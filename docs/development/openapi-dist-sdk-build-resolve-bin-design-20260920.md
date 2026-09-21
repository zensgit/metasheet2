# openapi dist-sdk build.mjs: resolve CLI bins directly (fix Windows ENOENT)

## Problem

`packages/openapi/dist-sdk/scripts/build.mjs` ran `openapi-typescript` and
`tsc` via `execFileSync('pnpm', ['exec', 'openapi-typescript', ...])` and
`execFileSync('pnpm', ['exec', 'tsc', ...])`.

On this Windows machine there is no `pnpm` executable on `PATH` — only the
npm-created shims `pnpm`, `pnpm.cmd`, `pnpm.ps1` (no `.exe`). `execFileSync`
does not go through a shell by default, so:

- `execFileSync('pnpm', ...)` → `ENOENT` (Windows CreateProcess needs an
  executable extension or `shell: true`; a bare `.cmd`/`.ps1` name is not
  directly spawnable).
- `execFileSync('pnpm.cmd', ...)` → `EINVAL` under some Node versions (a
  partial mitigation landed in Node ≥20.12/21.x for `.bat`/`.cmd` via an
  internal `shell: true` fallback, but it does not apply uniformly and is
  not something to depend on).

Two options were rejected:

- `shell: true` — Node 24+ emits `DEP0190` for array-argument + `shell: true`
  combinations, and Windows shell quoting of an argument array is unreliable
  (breaks on paths containing spaces).
- `execFileSync('pnpm.cmd', ...)` — works today on some Node versions but is
  exactly the fragile case above; not a fix, just a different failure mode.

## Fix

Never shell out to `pnpm` at all. `pnpm exec <bin>` only ever does two things
for a locally-installed dependency: resolve `<bin>`'s executable file from
`node_modules`, then run it with Node. We can do both ourselves:

1. **Resolve** — `resolveBin(pkgName, binName)` builds a `require` from this
   module's own URL (`createRequire(import.meta.url)`), resolves
   `<pkgName>/package.json` (which correctly walks up through
   `node_modules`/pnpm's content-addressable store from this file's
   location, exactly like real `require` resolution), reads the package's
   `bin` field from that JSON, and joins it with the package's directory to
   get an absolute path to the binary's `.js` entry point.

   This deliberately does **not** use
   `require.resolve('<pkgName>/<binPath>')` directly: some packages'
   `exports` maps forbid or rewrite that exact subpath. For example
   `openapi-typescript`'s `package.json` has:

   ```json
   "exports": { "./*.js": "./*.mjs", "./*": "./*" }
   ```

   which rewrites a request for `openapi-typescript/bin/cli.js` to
   `./bin/cli.mjs` — a file that does not exist (the real file is
   `bin/cli.js`) — so that direct resolution throws `MODULE_NOT_FOUND` even
   though the CLI is installed and its `bin` field correctly points at
   `bin/cli.js`. Resolving `package.json` (unaffected by `exports`, since
   Node still resolves a bare `<pkg>/package.json` from CJS `require`) and
   reading `bin` ourselves side-steps this entirely, and works uniformly for
   packages with or without an `exports` map (`typescript`'s package has no
   `exports` map and resolves the same way).

2. **Run** — `execFileSync(process.execPath, [resolvedBinPath, ...args], { cwd, stdio: 'inherit' })`.
   `process.execPath` is the absolute path to the Node binary already
   running this script, so invoking `<node> <resolvedBinPath.js> <args>` is
   exactly what happens when a `bin` shim runs, minus the shim. No shell is
   involved (no `shell: true`, no `.cmd`/`.bat` indirection), so there is no
   Windows-vs-POSIX split, no quoting/escaping, and no `DEP0190` deprecation
   warning.

`build.mjs` was also refactored (behavior-preserving) so `resolveBin` and the
core build steps (`runBuild`) are exported functions taking injectable
`requireFn` / `execFile` / `resolveBinFn` parameters, defaulting to the real
implementations. This makes both pure-logic paths (bin resolution, and "which
commands get run with which argv[0]") unit-testable with `node:test` without
actually invoking `openapi-typescript`/`tsc` or touching the filesystem
outside a temp directory. The script's own top-level `if (isMain)` guard
(`import.meta.url === pathToFileURL(process.argv[1]).href`) only runs
`runBuild()` for real when the file is executed directly (`node
scripts/build.mjs`), not when imported by the test file.

One additional hardening: `openapi-typescript`'s CRLF/LF handling is not
guaranteed identical across the platforms it might run on. After it writes
`index.d.ts`, `build.mjs` now reads the file back and normalizes `\r\n` → `\n`
before leaving it in place, so the generated file's line endings always match
what is committed to git (this repo stores `index.d.ts` as LF; a Windows
checkout only ever sees CRLF via git's own `core.autocrlf` conversion on
checkout/diff, never from the generator itself). In practice, on this
machine, `openapi-typescript@7.13.0` already writes LF, so this normalization
is a no-op here — see the verification doc for the actual byte-for-byte
comparison against the previously CI-generated file.

## Why CI (Linux) is unaffected

The new `resolveBin`/`runBuild` logic contains no Windows-specific branches
and no OS detection. On Linux CI, `createRequire(import.meta.url).resolve('openapi-typescript/package.json')`
and `.resolve('typescript/package.json')` walk the exact same
`node_modules`/pnpm-store resolution algorithm Node uses everywhere,
resolving to the same physical `bin/cli.js` and `bin/tsc` files that `pnpm
exec` would have found and run — the only change is *how* those files get
invoked (`execFileSync(process.execPath, [file, ...args])` instead of
`execFileSync('pnpm', ['exec', name, ...args])`), and `process.execPath`
naming the currently-running Node binary is exactly as valid on Linux as on
Windows. No shell is introduced, so no `DEP0190` risk, and no `.cmd`/`.sh`
extension logic is involved at all on either platform. This was also
exercised directly (not just argued): `node --test
packages/openapi/dist-sdk/scripts/build.test.mjs` and a real
`node packages/openapi/dist-sdk/scripts/build.mjs` run both passed in this
Windows dev environment (see the verification doc); the resolution logic
itself has no OS-conditional code path for CI's Linux runners to diverge on.

## Files changed

- `packages/openapi/dist-sdk/scripts/build.mjs` — rewritten to resolve and
  invoke `openapi-typescript` and `tsc` directly via
  `execFileSync(process.execPath, ...)`, no `pnpm`/shell involved; core logic
  factored into exported, test-injectable `resolveBin`/`runBuild` functions.
- `packages/openapi/dist-sdk/scripts/build.test.mjs` — new `node:test` suite
  covering `resolveBin` (string `bin`, object `bin` map, missing package,
  missing `bin` entry) and `runBuild` (both CLI calls use `process.execPath`
  with an absolute `argv[0]`, no `shell` option, correct error when
  `openapi.yaml` is missing).

## Scope note

This fix only replaces *how* `build.mjs` invokes the two CLIs already
declared as `packages/openapi`/`packages/openapi/dist-sdk` dependencies. It
does not touch `packages/openapi/src`, the OpenAPI spec itself, or any
generated SDK output content — see the verification doc for byte-for-byte
proof that `index.d.ts`/`client.d.ts`/`client.js`/`index.js` are unchanged.
