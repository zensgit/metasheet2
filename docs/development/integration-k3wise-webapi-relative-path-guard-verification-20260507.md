# K3 WISE WebAPI Relative Path Guard Verification

## Commands

```bash
node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs
git diff --check
```

## Local Result

- `node plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs`:
  passed.
- `git diff --check`: passed.

## Covered Cases

The updated adapter test verifies:

- the existing K3 WebAPI login, health, save, submit, and audit flow still works;
- non-HTTP base URLs are still rejected;
- protocol-relative `loginPath` values such as
  `//evil.example.test/K3API/Login` are rejected before any request is made;
- backslash-normalized `loginPath` values such as
  `\\evil.example.test\K3API\Login` are rejected before any request is made;
- `baseUrl` context paths are preserved, so
  `baseUrl=https://k3.example.test/K3API`, `loginPath=/login`, and
  `healthPath=/health` call `/K3API/login` and `/K3API/health`;
- SQL Server channel and K3 WebAPI auto flag coercion coverage in the same test
  file still passes.

## Residual Risk

This is a configuration validation hardening slice. It does not contact a real
K3 WISE WebAPI endpoint. The risk being tested is URL construction, so the unit
test exercises the adapter boundary directly with a mock fetch implementation.
