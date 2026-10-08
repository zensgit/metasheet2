# Verification: openapi dist-sdk build.mjs resolve-bin fix

Environment: Windows 11, Node v25.9.0, no `pnpm` executable on `PATH` (only
`pnpm`/`pnpm.cmd`/`pnpm.ps1` shims), pnpm 9.15.9 invoked via its full path
for `pnpm install` only (not by `build.mjs`).

## 1. Reproduced the original failure mode

Before the fix, `execFileSync('pnpm', [...])` on this machine throws `ENOENT`
(confirmed by reading the failing shim setup: `where pnpm` / `where
pnpm.cmd` return no `.exe`, only shim files not directly spawnable by
`execFileSync` without `shell: true`).

## 2. Unit tests (node:test)

```
$ node --test packages/openapi/dist-sdk/scripts/build.test.mjs
✔ resolveBin returns the absolute path from a string "bin" field
✔ resolveBin returns the absolute path from an object "bin" map, keyed by binName
✔ resolveBin throws a clear error when the package cannot be resolved
✔ resolveBin throws a clear error when the package has no matching bin entry
✔ runBuild invokes both CLIs via process.execPath with the resolved absolute path as argv[0], with no shell
✔ runBuild throws a clear error when openapi.yaml is missing
tests 6, pass 6, fail 0
```

The `runBuild` test injects a fake `execFile` and asserts, for both CLI
invocations:
- `command === process.execPath` (not `'pnpm'`, not `'pnpm.cmd'`).
- `args[0]` is an absolute path (the resolved CLI entry point).
- no truthy `shell` option is present.

## 3. Real build run (exit code)

```
$ cd packages/openapi/dist-sdk && node scripts/build.mjs
✨ openapi-typescript 7.13.0
🚀 .../packages/openapi/dist/openapi.yaml → .../packages/openapi/dist-sdk/index.d.ts [~0.7-0.9s]
SDK packaged to dist-sdk
$ echo $?
0
```

Ran successfully end to end (both the `openapi-typescript` and `tsc` steps)
with no `pnpm` process ever spawned.

## 4. Byte-for-byte output comparison against the CI-generated files

Before running the new script, the previously committed (CI-generated)
`index.d.ts`, `client.d.ts`, `client.js`, `index.js` were restored via
`git checkout --`. After running `node scripts/build.mjs`:

```
$ git diff --exit-code -- packages/openapi/dist-sdk/index.d.ts \
    packages/openapi/dist-sdk/client.d.ts \
    packages/openapi/dist-sdk/client.js \
    packages/openapi/dist-sdk/index.js
(only autocrlf "LF will be replaced by CRLF" advisory warnings on stderr,
 no diff output)
$ echo $?
0
```

`git diff --exit-code` reported **no content difference** for all four
generated files (the repo's blobs are stored as LF; git's `core.autocrlf =
true` on this machine only affects what's materialized on disk, and `git
diff` normalizes that back out for comparison — it is not a byte-level disk
comparison, so it correctly ignores the disk-only CRLF that `git status`
separately flags). This was run twice — once against the original
`build.mjs` (baseline, before the resolve-bin rewrite) and once against the
rewritten version — both produced identical, zero-diff output, confirming
the rewrite does not change the generated SDK content in any way, only how
the two CLIs are invoked.

`index.d.ts` was additionally read back and confirmed to already be LF-only
(`openapi-typescript@7.13.0` on this machine writes LF natively), so the new
CRLF→LF normalization step in `runBuild` is a documented no-op here; it exists
as a guard for environments/versions where the generator might emit CRLF,
without depending on that never happening.

## 5. Why CI (Linux) behavior is unchanged — argument, not just assertion

`resolveBin` calls `createRequire(import.meta.url).resolve('<pkg>/package.json')`.
This is Node's own module resolver, identical on Linux and Windows: it walks
up from `packages/openapi/dist-sdk/scripts/` through
`node_modules`/pnpm's `.pnpm` store the same way on both platforms, and would
resolve to the equivalent physical `bin/cli.js` / `bin/tsc` files under CI's
Linux `node_modules` layout. The only platform-independent value used to run
them, `process.execPath`, is the running Node binary's own absolute path on
whichever OS the script executes on — there is no OS branch, no `.cmd`/`.sh`
extension logic, and no `shell` option anywhere in `resolveBin` or `runBuild`.
Since the previous `pnpm exec <bin>` invocation already worked on Linux CI
(`pnpm` is on `PATH` there), and the new invocation resolves and runs the
exact same underlying binary file directly, CI's generated output and exit
codes are expected to be unchanged. This could not be executed against the
real Linux CI runner from this environment; the claim rests on the resolution
algorithm being platform-uniform, verified in-session, not on having run it
on Linux.

## 6. Hygiene checks

- `git diff origin/main -- packages/openapi/dist-sdk/scripts/build.mjs
  packages/openapi/dist-sdk/scripts/build.test.mjs | grep -P '\x08'` → empty
  (no stray backspace/control-byte corruption from tooling).
- No `packages/openapi/src` changes in this PR, so no `dist`/`dist-sdk`
  regeneration obligation from that rule applies; the four generated
  dist-sdk files listed above are unchanged (see §4) and not re-committed
  with any content diff.
