# HTTP Adapter Relative Path Guard - Development - 2026-05-07

## Context

The generic HTTP adapter is the main plugin-local connector shape for
third-party PLM/ERP APIs. Object paths, schema paths, and health paths are meant
to be relative to `config.baseUrl`.

The previous path guard rejected `http://` and `https://`, but protocol-relative
paths such as `//evil.example.test/api` can still be resolved by `new URL()` as
an external host. Backslash and control-character paths are also unsafe input
for connector configuration.

## Change

- Hardened `assertRelativePath()` in
  `plugins/plugin-integration-core/lib/adapters/http-adapter.cjs`.
- Rejects:
  - scheme-bearing paths such as `https://...`, `file://...`, `javascript:...`
  - protocol-relative paths such as `//host/path`
  - control characters
  - backslashes
- Existing normal relative paths keep their previous behavior.

## Behavioral Contract

HTTP adapter paths must remain inside the configured `baseUrl` authority. A
connector config cannot redirect reads, writes, schema discovery, or health
checks to a different host via path syntax.
