# K3 WISE WebAPI Relative Path Guard Development

## Context

The K3 WISE WebAPI adapter joins configured endpoint paths with
`config.baseUrl` through `new URL(path, baseUrl)`. The existing path guard only
rejected explicit `http://` and `https://` paths.

That left two URL forms that Node normalizes away from the configured K3 host:

- protocol-relative paths, for example `//evil.example.test/K3API/Login`;
- backslash-prefixed paths, for example `\\evil.example.test\K3API\Login`.

Both can resolve to a host outside `config.baseUrl`, which is not acceptable for
K3 login, save, submit, or audit calls.

The same URL construction path also treated endpoint paths as root-relative.
For a customer packet shaped like `baseUrl: https://k3.example.test/K3API` and
`loginPath: /login`, `new URL('/login', baseUrl)` drops the `/K3API` context.

## Change

`assertRelativePath()` now rejects:

- any leading URL scheme such as `http:`, `https:`, or `k3api:`;
- protocol-relative paths beginning with `//`;
- any path containing a backslash.

Normal K3 relative paths are unchanged:

- `/K3API/Login`
- `K3API/Login`
- `/K3API/Foo:Bar`

Request construction now uses a K3 adapter-local join helper that preserves a
context path on `baseUrl` while avoiding duplicate prefixes. That keeps both
forms valid:

- `baseUrl=https://k3.example.test`, `loginPath=/K3API/Login`
- `baseUrl=https://k3.example.test/K3API`, `loginPath=/login`

The test coverage adds adapter-construction assertions for protocol-relative and
backslash-normalized login paths, plus a live mock fetch assertion for baseUrl
context-path preservation. The patch is intentionally stacked on PR #1352
because that PR already owns the K3 WebAPI adapter auth transport changes.

## Scope

Changed files:

- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
- `plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs`

No workflow, database, frontend, REST route, run-log, or external-system
registry code is changed.
