# K3 WISE GATE Contract Checker Windows Entrypoint Design - 2026-05-22

## Context

Entity-machine validation of release `multitable-onprem-k3wise-20260522-60f20a186`
found that the documented Windows command returned exit code `0` but created no
template directory:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs --init-template <dir>
```

The same package could generate the handoff packet only through a temporary
wrapper that forced `main()` to run.

## Root Causes

The checker used this direct-run guard:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
```

That happens to work for POSIX absolute paths such as `/repo/script.mjs`, but it
does not match Windows paths such as `C:\metasheet\scripts\ops\script.mjs`.
Node exits successfully after importing the module, but `main()` is never
called, so no output directory is created.

Local package verification also surfaced the same class of issue on POSIX when
the package is executed through a symlinked path. On macOS, `/tmp` resolves to
`/private/tmp`; Node may report the module URL with the real path while
`process.argv[1]` keeps the symlink path. A pure normalized string comparison is
therefore still too weak.

## Change

The checker now resolves `import.meta.url` with `fileURLToPath()` and compares
that filesystem path with `process.argv[1]` after platform-aware normalization:

- POSIX paths are compared exactly after `path.resolve()` / `path.normalize()`.
- Windows paths use `path.win32` normalization and case-insensitive comparison.
- When the compared paths exist on the current platform, `realpathSync.native()`
  is applied before comparison so `/tmp` and `/private/tmp` resolve to the same
  entrypoint.

This keeps the command behavior unchanged on macOS/Linux while making Windows
direct execution invoke `main()` correctly.

## Scope

Changed:

- `scripts/ops/integration-k3wise-gate-contract-check.mjs`
- `scripts/ops/integration-k3wise-gate-contract-check.test.mjs`

Not changed:

- K3 WebAPI runtime
- SQL Bridge Agent runtime
- Data Factory pipelines
- DB schema or migrations
- K3 Save / Submit / Audit

## Compatibility

The script remains an ESM CLI module and keeps the existing public CLI contract:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs --init-template <dir>
node scripts/ops/integration-k3wise-gate-contract-check.mjs --input <packet.json> --out-dir <dir>
```

The helper `isDirectCliRun()` is exported only to make the Windows path behavior
and symlink realpath behavior unit-testable.

## Deployment Impact

No service restart behavior or runtime API changes are introduced. The fix takes
effect when a new on-prem package includes the updated script.

After packaging, the customer/operator should be able to run the documented
Windows command directly without a wrapper copy.
